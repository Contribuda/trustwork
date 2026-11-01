-- SRC-001 hub source registry (docs/engine/publishing.md "Hub sources" and "Manufacturer and supplier sources",
-- docs/engine/hub-console/autonomous-editorial.md sections 1 and 2, docs/data/model.md section 24; ADR 010 decision 19,
-- ADR 012 decision 3). Contracts: packages/contracts/src/sources.ts on top of the console contract hub.ts.
--
-- A hub registers information sources with the console's licence flags (AllowedUsesSchema: display headline and link,
-- display summary, store full text, index, send to model providers, translate, rewrite with attribution, reuse images,
-- syndicate to peers), a legal basis, robots.txt and terms-of-use checks with digests and an RSL 1.0 reading. Imported
-- items arrive in staged batches; a second person activates a batch; only a person turns an item into a publication
-- draft (CNT-001 still reviews it before anything is published) or discards it.
--
-- Authority model (DATA-002): every mutation is a SECURITY DEFINER command that resolves the caller's permission at the
-- hub, requires a live elevation of the caller and writes an admin_audit_event in the same transaction. The runtime role
-- reads under row-level security and writes nothing directly. Rules enforced for every writer (the owner and
-- maintenance sessions included) by constraints and triggers:
-- * licence flags: a source without a licence (all rights reserved, unknown) holds only headline, link, summary and
--   indexing; rewriting needs the stored text; flags never exceed a recorded RSL ceiling unless a publisher agreement is
--   on record; an unreadable or unmatched RSL document is the most restrictive ceiling;
-- * a crawled source (sitemap, web page) is active only with a recorded robots.txt check that allows it and a terms
--   check, recorded by a person, that permits automated access; a source holding personal data names a legal basis;
-- * separation of duties: the person who last set a source's terms never activates it; the person who staged a batch
--   never activates it and never decides its items; the person who proposed a link never decides it;
-- * an item is drafted or discarded only by a person, only from an activated batch; nothing here publishes;
-- * an item's summary and full text exist only when its licence snapshot allows them; egress to a model provider or a
--   peer uses the stricter of the snapshot and the source's current flags (sources_effective_uses);
-- * takedown deactivates the source, its items and sourced record fields, redacts stored text, and writes retrieval and
--   federation tombstones with identifiers-only outbox events, all in one transaction, with the reason audited;
-- * sponsored content is off by default per hub; switching it on needs a second person (sponsored.enable); sponsored
--   items are labelled and never returned by sources_recommendable_items (the input for ranking, matching and plan
--   recommendations).

-- 0. Vocabularies and pure helpers (immutable, tested against packages/contracts/src/sources.ts) ---------------------
CREATE FUNCTION trustwork.sources_kinds() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['rss', 'atom', 'sitemap', 'api', 'web_page', 'file_drop', 'register_open_data', 'register_api', 'procurement_portal', 'standards_body',
    'statistics', 'press_inbox', 'peer_feed', 'manual']::text[]
$$;
CREATE FUNCTION trustwork.sources_crawling_kinds() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['sitemap', 'web_page']::text[]
$$;
CREATE FUNCTION trustwork.sources_use_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['displayHeadlineAndLink', 'displaySummary', 'storeFullText', 'indexForSearch', 'sendToModelProviders', 'translate', 'rewriteWithAttribution',
    'reuseImages', 'syndicateToPeers']::text[]
$$;
CREATE FUNCTION trustwork.sources_no_licence_forbidden() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['storeFullText', 'sendToModelProviders', 'rewriteWithAttribution', 'syndicateToPeers', 'reuseImages', 'translate']::text[]
$$;
CREATE FUNCTION trustwork.sources_most_restrictive() RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_object_agg(k, false) FROM unnest(trustwork.sources_use_keys()) k
$$;
-- An object holding exactly the nine flags, each a boolean.
CREATE FUNCTION trustwork.sources_uses_ok(p_uses jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT p_uses IS NOT NULL AND jsonb_typeof(p_uses) = 'object'
    AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_uses) k) = (SELECT array_agg(k ORDER BY k) FROM unnest(trustwork.sources_use_keys()) k)
    AND NOT EXISTS (SELECT 1 FROM jsonb_each(p_uses) e WHERE jsonb_typeof(e.value) <> 'boolean')
$$;
CREATE FUNCTION trustwork.sources_use(p_uses jsonb, p_key text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce((p_uses ->> p_key)::boolean, false)
$$;
-- Per-flag AND: the stricter of two readings.
CREATE FUNCTION trustwork.sources_uses_and(p_a jsonb, p_b jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_object_agg(k, trustwork.sources_use(p_a, k) AND trustwork.sources_use(p_b, k)) FROM unnest(trustwork.sources_use_keys()) k
$$;
-- Flags p_uses holds that p_ceiling does not allow.
CREATE FUNCTION trustwork.sources_uses_above(p_uses jsonb, p_ceiling jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT coalesce(array_agg(k ORDER BY k), ARRAY[]::text[]) FROM unnest(trustwork.sources_use_keys()) k
   WHERE trustwork.sources_use(p_uses, k) AND NOT trustwork.sources_use(p_ceiling, k)
$$;
-- allowedUsesProblems in packages/contracts/src/sources.ts.
CREATE FUNCTION trustwork.sources_uses_problems(p_licence_kind text, p_agreement uuid, p_uses jsonb, p_ceiling jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT array_remove(ARRAY[
    CASE WHEN p_licence_kind IN ('all_rights_reserved', 'unknown')
          AND EXISTS (SELECT 1 FROM unnest(trustwork.sources_no_licence_forbidden()) k WHERE trustwork.sources_use(p_uses, k)) THEN 'licence_restricts_use' END,
    CASE WHEN trustwork.sources_use(p_uses, 'rewriteWithAttribution') AND NOT trustwork.sources_use(p_uses, 'storeFullText') THEN 'rewrite_needs_full_text' END,
    CASE WHEN p_ceiling IS NOT NULL AND NOT (p_licence_kind = 'publisher_agreement' AND p_agreement IS NOT NULL)
          AND cardinality(trustwork.sources_uses_above(p_uses, p_ceiling)) > 0 THEN 'rsl_forbids_use' END
  ], NULL)
$$;
CREATE FUNCTION trustwork.sources_distinct(p_values text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT cardinality(p_values) = (SELECT count(DISTINCT v) FROM unnest(p_values) v)
$$;

-- 1. Sources -----------------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.source (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  kind text NOT NULL CHECK (kind = ANY (trustwork.sources_kinds())),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  url text NULL CHECK (url IS NULL OR (url ~ '^https?://[^\s]+$' AND length(url) <= 2000)),
  reader_kind text NOT NULL CHECK (reader_kind IN ('industry_media', 'press_release', 'official_register', 'procurement_notice', 'standards_body', 'statistics', 'company_statement', 'other')),
  purposes text[] NOT NULL CHECK (cardinality(purposes) BETWEEN 1 AND 7 AND trustwork.sources_distinct(purposes)
    AND purposes <@ ARRAY['news_desk', 'company_directory', 'people_directory', 'knowledge_base', 'opportunities', 'events_calendar', 'verification_evidence']::text[]),
  licence_kind text NOT NULL CHECK (licence_kind IN ('open_licence', 'public_domain', 'statutory_public', 'publisher_agreement', 'press_release', 'all_rights_reserved', 'unknown')),
  licence_name text NULL CHECK (licence_name IS NULL OR length(licence_name) BETWEEN 1 AND 200),
  licence_url text NULL CHECK (licence_url IS NULL OR (licence_url ~ '^https?://[^\s]+$' AND length(licence_url) <= 2000)),
  agreement_ref uuid NULL,
  allowed_uses jsonb NOT NULL CHECK (trustwork.sources_uses_ok(allowed_uses)),
  attribution_template text NOT NULL CHECK (length(attribution_template) BETWEEN 1 AND 500),
  takedown_contact text NOT NULL CHECK (length(takedown_contact) BETWEEN 1 AND 500),
  owner_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  personal_data boolean NOT NULL DEFAULT false,
  legal_basis text NULL CHECK (legal_basis IN ('statutory_public_register', 'open_licence', 'contract', 'consent', 'legitimate_interest_assessed', 'public_professional_data')),
  terms_checked_at timestamptz NULL,
  terms_url text NULL CHECK (terms_url IS NULL OR (terms_url ~ '^https?://[^\s]+$' AND length(terms_url) <= 2000)),
  terms_digest text NULL CHECK (terms_digest ~ '^[a-f0-9]{64}$'),
  terms_automated_access text NULL CHECK (terms_automated_access IN ('permitted', 'forbidden', 'unclear', 'not_applicable')),
  terms_reviewed_by uuid NULL REFERENCES trustwork.person (id),
  terms_notes text NOT NULL DEFAULT '' CHECK (length(terms_notes) <= 2000),
  rsl_status text NOT NULL DEFAULT 'absent' CHECK (rsl_status IN ('absent', 'parsed', 'failed', 'no_matching_content')),
  rsl_digest text NULL CHECK (rsl_digest ~ '^[a-f0-9]{64}$'),
  rsl_checked_at timestamptz NULL,
  rsl_ceiling jsonb NULL CHECK (rsl_ceiling IS NULL OR trustwork.sources_uses_ok(rsl_ceiling)),
  rsl_suggested jsonb NULL CHECK (rsl_suggested IS NULL OR trustwork.sources_uses_ok(rsl_suggested)),
  proposed_by_kind text NOT NULL DEFAULT 'person' CHECK (proposed_by_kind IN ('person', 'pipeline')),
  proposed_by_person uuid NULL REFERENCES trustwork.person (id),
  proposed_by_pipeline text NULL CHECK (proposed_by_pipeline ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  proposed_by_run text NULL CHECK (proposed_by_run ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  edited_by uuid NOT NULL REFERENCES trustwork.person (id),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'active', 'paused', 'rejected', 'retired', 'taken_down')),
  activated_by uuid NULL REFERENCES trustwork.person (id),
  activated_at timestamptz NULL,
  pause_reason text NULL CHECK (pause_reason IN ('robots_changed', 'terms_changed', 'licence_ended', 'error_streak', 'budget', 'manual', 'takedown')),
  paused_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_proposer CHECK ((proposed_by_kind = 'person') = (proposed_by_person IS NOT NULL)
    AND (proposed_by_kind = 'pipeline') = (proposed_by_pipeline IS NOT NULL AND proposed_by_run IS NOT NULL)),
  CONSTRAINT source_crawl_url CHECK (kind <> ALL (trustwork.sources_crawling_kinds()) OR url IS NOT NULL),
  CONSTRAINT source_uses CHECK (cardinality(trustwork.sources_uses_problems(licence_kind, agreement_ref, allowed_uses, rsl_ceiling)) = 0),
  CONSTRAINT source_personal_data_basis CHECK (NOT personal_data OR legal_basis IS NOT NULL),
  CONSTRAINT source_terms CHECK ((terms_checked_at IS NULL) = (terms_automated_access IS NULL) AND (terms_url IS NULL) = (terms_digest IS NULL)
    AND (terms_automated_access IS NULL OR terms_reviewed_by IS NOT NULL)),
  CONSTRAINT source_rsl CHECK ((rsl_status = 'absent') = (rsl_ceiling IS NULL) AND (rsl_ceiling IS NULL) = (rsl_suggested IS NULL) AND (rsl_ceiling IS NULL) = (rsl_checked_at IS NULL)
    AND (rsl_status NOT IN ('failed', 'no_matching_content') OR (rsl_ceiling = trustwork.sources_most_restrictive() AND rsl_suggested = trustwork.sources_most_restrictive()))
    AND (rsl_suggested IS NULL OR cardinality(trustwork.sources_uses_above(rsl_suggested, rsl_ceiling)) = 0)),
  CONSTRAINT source_activation CHECK (status NOT IN ('active', 'paused') OR (activated_by IS NOT NULL AND activated_at IS NOT NULL)),
  CONSTRAINT source_pause CHECK ((status IN ('paused', 'taken_down')) = (pause_reason IS NOT NULL) AND (status = 'taken_down') = (pause_reason IS NOT DISTINCT FROM 'takedown')
    AND (pause_reason IS NULL) = (paused_at IS NULL))
);
CREATE INDEX source_hub_idx ON trustwork.source (hub_id, status, created_at);

-- 2. Crawl policies: one row per robots.txt check (history); the latest row of a source is its current policy --------
CREATE TABLE trustwork.crawl_policy (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  source_id uuid NOT NULL REFERENCES trustwork.source (id),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  domain text NOT NULL CHECK (domain ~ '^[a-z0-9.-]{1,253}(:[0-9]{1,5})?$'),
  robots_url text NOT NULL CHECK (robots_url ~ '^https?://[^\s]+/robots\.txt$' AND length(robots_url) <= 2000),
  user_agent text NOT NULL CHECK (length(user_agent) BETWEEN 1 AND 200),
  robots_digest text NOT NULL CHECK (robots_digest ~ '^[a-f0-9]{64}$'),
  allowed boolean NOT NULL,
  status text NOT NULL CHECK (status IN ('allowed', 'restricted', 'forbidden')),
  crawl_delay_s integer NULL CHECK (crawl_delay_s BETWEEN 0 AND 86400),
  allowed_paths text[] NOT NULL DEFAULT '{}' CHECK (cardinality(allowed_paths) <= 200),
  disallowed_paths text[] NOT NULL DEFAULT '{}' CHECK (cardinality(disallowed_paths) <= 200),
  licence_urls text[] NOT NULL DEFAULT '{}' CHECK (cardinality(licence_urls) <= 20),
  recorded_by uuid NOT NULL REFERENCES trustwork.person (id),
  fetched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT crawl_policy_status CHECK (allowed = (status <> 'forbidden'))
);
CREATE INDEX crawl_policy_source_idx ON trustwork.crawl_policy (source_id, fetched_at DESC, id DESC);
CREATE TRIGGER crawl_policy_append_only BEFORE UPDATE OR DELETE ON trustwork.crawl_policy FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

CREATE FUNCTION trustwork.sources_current_policy(p_source uuid) RETURNS trustwork.crawl_policy
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT * FROM trustwork.crawl_policy WHERE source_id = p_source ORDER BY fetched_at DESC, id DESC LIMIT 1
$$;

-- Lifecycle, immutable identity, separation of duties and the crawling preconditions, for every writer.
CREATE FUNCTION trustwork.sources_source_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_policy trustwork.crawl_policy%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id OR NEW.hub_id <> OLD.hub_id OR NEW.kind <> OLD.kind OR NEW.proposed_by_kind <> OLD.proposed_by_kind
       OR NEW.proposed_by_person IS DISTINCT FROM OLD.proposed_by_person OR NEW.proposed_by_pipeline IS DISTINCT FROM OLD.proposed_by_pipeline
       OR NEW.proposed_by_run IS DISTINCT FROM OLD.proposed_by_run OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'a source keeps its hub, kind and proposer' USING ERRCODE = 'check_violation', HINT = 'sources.immutable';
    END IF;
    IF OLD.status = 'taken_down' THEN
      RAISE EXCEPTION 'a taken-down source stays down' USING ERRCODE = 'check_violation', HINT = 'sources.taken_down';
    END IF;
    IF NEW.status <> OLD.status AND NOT (CASE OLD.status
         WHEN 'proposed' THEN NEW.status IN ('active', 'rejected', 'retired', 'taken_down')
         WHEN 'active' THEN NEW.status IN ('paused', 'proposed', 'retired', 'taken_down')
         WHEN 'paused' THEN NEW.status IN ('active', 'proposed', 'retired', 'taken_down')
         WHEN 'rejected' THEN NEW.status = 'taken_down'
         WHEN 'retired' THEN NEW.status = 'taken_down'
         ELSE false END) THEN
      RAISE EXCEPTION 'a source cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'sources.invalid_transition';
    END IF;
    IF OLD.status IN ('rejected', 'retired') AND NEW.status = OLD.status THEN
      RAISE EXCEPTION 'a % source is closed', OLD.status USING ERRCODE = 'check_violation', HINT = 'sources.source_closed';
    END IF;
    NEW.revision := OLD.revision + 1;
    NEW.updated_at := clock_timestamp();
  END IF;
  IF NEW.status = 'active' AND (TG_OP = 'INSERT' OR OLD.status <> 'active') THEN
    IF NEW.activated_by IS NULL OR NEW.activated_by = NEW.edited_by THEN
      RAISE EXCEPTION 'a source is activated by a person other than the one who set its terms' USING ERRCODE = 'insufficient_privilege', HINT = 'sources.self_activation';
    END IF;
    IF NEW.kind = ANY (trustwork.sources_crawling_kinds()) THEN
      v_policy := trustwork.sources_current_policy(NEW.id);
      IF v_policy.id IS NULL OR NOT v_policy.allowed THEN
        RAISE EXCEPTION 'a crawled source needs a robots.txt check that allows it' USING ERRCODE = 'check_violation', HINT = 'sources.robots_not_allowed';
      END IF;
      IF NEW.terms_automated_access IS DISTINCT FROM 'permitted' OR NEW.terms_reviewed_by IS NULL THEN
        RAISE EXCEPTION 'a crawled source needs terms, reviewed by a person, that permit automated access' USING ERRCODE = 'check_violation', HINT = 'sources.terms_not_permitted';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_guard BEFORE INSERT OR UPDATE ON trustwork.source FOR EACH ROW EXECUTE FUNCTION trustwork.sources_source_guard();
CREATE TRIGGER source_no_delete BEFORE DELETE ON trustwork.source FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 3. Sponsored content policy per hub: append-only versions; no row means off (ADR 012 decision 3) -----------------------
CREATE TABLE trustwork.sponsored_content_policy (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  version integer NOT NULL CHECK (version >= 1),
  allowed boolean NOT NULL,
  max_slots_per_page integer NOT NULL CHECK (max_slots_per_page BETWEEN 0 AND 3),
  require_verified_sponsor boolean NOT NULL,
  set_by uuid NOT NULL REFERENCES trustwork.person (id),
  approval_id uuid NULL REFERENCES trustwork.second_person_approval (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sponsored_content_policy_version UNIQUE (hub_id, version),
  CONSTRAINT sponsored_content_policy_slots CHECK (allowed OR max_slots_per_page = 0),
  CONSTRAINT sponsored_content_policy_second_person CHECK (NOT allowed OR approval_id IS NOT NULL)
);
CREATE TRIGGER sponsored_content_policy_append_only BEFORE UPDATE OR DELETE ON trustwork.sponsored_content_policy FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

CREATE FUNCTION trustwork.sources_sponsored_current(p_hub uuid) RETURNS trustwork.sponsored_content_policy
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT * FROM trustwork.sponsored_content_policy WHERE hub_id = p_hub ORDER BY version DESC LIMIT 1
$$;
-- sponsoredPolicyDigestInput in packages/contracts/src/sources.ts: what the second person approves.
CREATE FUNCTION trustwork.sources_sponsored_digest(p_hub uuid, p_version integer, p_allowed boolean, p_max integer, p_verified boolean) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.admin_digest(jsonb_build_object('action', 'sponsored.enable', 'object', 'sponsored_content_policy', 'hubId', p_hub::text, 'version', p_version,
    'allowed', p_allowed, 'maxSlotsPerPage', p_max, 'requireVerifiedSponsor', p_verified))
$$;

-- 4. Import batches ----------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.import_batch (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  source_id uuid NOT NULL REFERENCES trustwork.source (id),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  pipeline_run_id text NULL CHECK (pipeline_run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  staged_by uuid NOT NULL REFERENCES trustwork.person (id),
  counts jsonb NOT NULL CHECK (jsonb_typeof(counts) = 'object'),
  licence_snapshot jsonb NOT NULL CHECK (jsonb_typeof(licence_snapshot) = 'object' AND trustwork.sources_uses_ok(licence_snapshot -> 'allowedUses')),
  status text NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'activated', 'rejected', 'taken_down')),
  decided_by uuid NULL REFERENCES trustwork.person (id),
  decided_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_batch_decision CHECK ((status IN ('activated', 'rejected')) = (decided_by IS NOT NULL) AND (decided_by IS NULL) = (decided_at IS NULL)),
  CONSTRAINT import_batch_four_eyes CHECK (decided_by IS NULL OR decided_by <> staged_by)
);
CREATE INDEX import_batch_hub_idx ON trustwork.import_batch (hub_id, status, created_at);
CREATE FUNCTION trustwork.sources_batch_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.source_id <> OLD.source_id OR NEW.hub_id <> OLD.hub_id OR NEW.staged_by <> OLD.staged_by OR NEW.counts <> OLD.counts
     OR NEW.licence_snapshot <> OLD.licence_snapshot OR NEW.pipeline_run_id IS DISTINCT FROM OLD.pipeline_run_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a staged batch is immutable' USING ERRCODE = 'check_violation', HINT = 'sources.immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'staged' AND NEW.status IN ('activated', 'rejected', 'taken_down')) THEN
    RAISE EXCEPTION 'a batch is decided once' USING ERRCODE = 'check_violation', HINT = 'sources.batch_decided';
  END IF;
  IF NEW.status = OLD.status AND (NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decided_at IS DISTINCT FROM OLD.decided_at) THEN
    RAISE EXCEPTION 'a batch is decided once' USING ERRCODE = 'check_violation', HINT = 'sources.batch_decided';
  END IF;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER import_batch_guard BEFORE UPDATE ON trustwork.import_batch FOR EACH ROW EXECUTE FUNCTION trustwork.sources_batch_guard();
CREATE TRIGGER import_batch_no_delete BEFORE DELETE ON trustwork.import_batch FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 5. Source items: the review queue ------------------------------------------------------------------------------------
CREATE TABLE trustwork.source_item (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  source_id uuid NOT NULL REFERENCES trustwork.source (id),
  import_batch_id uuid NOT NULL REFERENCES trustwork.import_batch (id),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  url text NOT NULL CHECK (url ~ '^https?://[^\s]+$' AND length(url) <= 2000),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  summary text NULL CHECK (length(summary) BETWEEN 1 AND 2000),
  full_text text NULL CHECK (length(full_text) BETWEEN 1 AND 100000),
  source_time timestamptz NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  content_digest text NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  licence_snapshot jsonb NOT NULL CHECK (jsonb_typeof(licence_snapshot) = 'object' AND trustwork.sources_uses_ok(licence_snapshot -> 'allowedUses')),
  sponsored boolean NOT NULL DEFAULT false,
  sponsor_name text NULL CHECK (length(btrim(sponsor_name)) BETWEEN 1 AND 200),
  assisted_summary text NULL CHECK (length(assisted_summary) BETWEEN 1 AND 2000),
  assisted_language text NULL CHECK (assisted_language ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$'),
  assisted_at timestamptz NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'drafted', 'discarded', 'taken_down')),
  decided_by uuid NULL REFERENCES trustwork.person (id),
  decided_at timestamptz NULL,
  publication_id uuid NULL REFERENCES trustwork.publication (id),
  takedown_id uuid NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_item_external UNIQUE (source_id, external_id),
  -- Stored text only where the licence snapshot allows it.
  CONSTRAINT source_item_summary_licence CHECK (summary IS NULL OR trustwork.sources_use(licence_snapshot -> 'allowedUses', 'displaySummary')),
  CONSTRAINT source_item_full_text_licence CHECK (full_text IS NULL OR trustwork.sources_use(licence_snapshot -> 'allowedUses', 'storeFullText')),
  CONSTRAINT source_item_assisted CHECK ((assisted_summary IS NULL) = (assisted_language IS NULL) AND (assisted_summary IS NULL) = (assisted_at IS NULL)
    AND (assisted_summary IS NULL OR trustwork.sources_use(licence_snapshot -> 'allowedUses', 'sendToModelProviders'))),
  CONSTRAINT source_item_sponsor CHECK (sponsored = (sponsor_name IS NOT NULL)),
  -- A person decides: drafted items name the publication draft; nothing here publishes.
  CONSTRAINT source_item_decision CHECK ((status IN ('drafted', 'discarded')) <= (decided_by IS NOT NULL AND decided_at IS NOT NULL)
    AND (status = 'queued') <= (decided_by IS NULL AND publication_id IS NULL)
    AND (status = 'drafted') <= (publication_id IS NOT NULL)),
  CONSTRAINT source_item_takedown CHECK ((status = 'taken_down') = (takedown_id IS NOT NULL)
    AND (status <> 'taken_down' OR (summary IS NULL AND full_text IS NULL AND assisted_summary IS NULL)))
);
CREATE INDEX source_item_queue_idx ON trustwork.source_item (hub_id, status, observed_at, id);
CREATE INDEX source_item_batch_idx ON trustwork.source_item (import_batch_id);
CREATE FUNCTION trustwork.sources_item_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.hub_id <> OLD.hub_id OR NEW.source_id <> OLD.source_id OR NEW.import_batch_id <> OLD.import_batch_id OR NEW.external_id <> OLD.external_id
     OR NEW.url <> OLD.url OR NEW.title <> OLD.title OR NEW.source_time IS DISTINCT FROM OLD.source_time OR NEW.observed_at <> OLD.observed_at
     OR NEW.content_digest <> OLD.content_digest OR NEW.licence_snapshot <> OLD.licence_snapshot OR NEW.sponsored <> OLD.sponsored
     OR NEW.sponsor_name IS DISTINCT FROM OLD.sponsor_name OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'an imported item is immutable' USING ERRCODE = 'check_violation', HINT = 'sources.immutable';
  END IF;
  -- Stored text only ever disappears (takedown), never changes.
  IF (NEW.summary IS DISTINCT FROM OLD.summary AND NEW.summary IS NOT NULL) OR (NEW.full_text IS DISTINCT FROM OLD.full_text AND NEW.full_text IS NOT NULL) THEN
    RAISE EXCEPTION 'an imported item is immutable' USING ERRCODE = 'check_violation', HINT = 'sources.immutable';
  END IF;
  IF OLD.status = 'taken_down' THEN
    RAISE EXCEPTION 'a taken-down item stays down' USING ERRCODE = 'check_violation', HINT = 'sources.taken_down';
  END IF;
  IF NEW.status <> OLD.status AND NOT (CASE OLD.status
       WHEN 'queued' THEN NEW.status IN ('drafted', 'discarded', 'taken_down')
       WHEN 'drafted' THEN NEW.status = 'taken_down'
       WHEN 'discarded' THEN NEW.status = 'taken_down'
       ELSE false END) THEN
    RAISE EXCEPTION 'an item is decided once' USING ERRCODE = 'check_violation', HINT = 'sources.item_decided';
  END IF;
  IF OLD.status <> 'queued' AND NEW.status <> 'taken_down' AND (NEW.assisted_summary IS DISTINCT FROM OLD.assisted_summary) THEN
    RAISE EXCEPTION 'an item is decided once' USING ERRCODE = 'check_violation', HINT = 'sources.item_decided';
  END IF;
  IF OLD.decided_by IS NOT NULL AND (NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NEW.publication_id IS DISTINCT FROM OLD.publication_id) THEN
    RAISE EXCEPTION 'an item is decided once' USING ERRCODE = 'check_violation', HINT = 'sources.item_decided';
  END IF;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER source_item_guard BEFORE UPDATE ON trustwork.source_item FOR EACH ROW EXECUTE FUNCTION trustwork.sources_item_guard();
CREATE TRIGGER source_item_no_delete BEFORE DELETE ON trustwork.source_item FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- The stricter of an item's licence snapshot and its source's current flags; nothing once either is taken down.
CREATE FUNCTION trustwork.sources_effective_uses(p_item trustwork.source_item) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT CASE WHEN p_item.status = 'taken_down' OR s.status = 'taken_down' THEN trustwork.sources_most_restrictive()
    ELSE trustwork.sources_uses_and(p_item.licence_snapshot -> 'allowedUses', s.allowed_uses) END
  FROM trustwork.source s WHERE s.id = p_item.source_id
$$;

-- 6. Sourced record fields: field-level provenance of "from sources" records --------------------------------------------
CREATE TABLE trustwork.sourced_record_field (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  record_kind text NOT NULL CHECK (record_kind IN ('company', 'company_identifier', 'company_registration', 'professional_credential', 'product_entry', 'learning_resource', 'event')),
  record_id uuid NOT NULL,
  field text NOT NULL CHECK (field ~ '^[a-z][a-zA-Z0-9_]{0,60}$' AND field !~* '(score|(^|[^e])rank|position|badge|weight|boost|promot|priorit)'),
  value text NOT NULL CHECK (length(value) BETWEEN 1 AND 2000),
  source_id uuid NOT NULL REFERENCES trustwork.source (id),
  import_batch_id uuid NOT NULL REFERENCES trustwork.import_batch (id),
  source_item_id uuid NULL REFERENCES trustwork.source_item (id),
  observed_at timestamptz NOT NULL DEFAULT now(),
  active boolean NOT NULL DEFAULT true,
  deactivated_at timestamptz NULL,
  takedown_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sourced_record_field_active CHECK (active = (deactivated_at IS NULL) AND (takedown_id IS NULL OR NOT active))
);
CREATE INDEX sourced_record_field_record_idx ON trustwork.sourced_record_field (record_kind, record_id, field);
CREATE INDEX sourced_record_field_source_idx ON trustwork.sourced_record_field (source_id);
CREATE FUNCTION trustwork.sources_field_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.hub_id <> OLD.hub_id OR NEW.record_kind <> OLD.record_kind OR NEW.record_id <> OLD.record_id OR NEW.field <> OLD.field OR NEW.value <> OLD.value
     OR NEW.source_id <> OLD.source_id OR NEW.import_batch_id <> OLD.import_batch_id OR NEW.source_item_id IS DISTINCT FROM OLD.source_item_id
     OR NEW.observed_at <> OLD.observed_at OR NEW.created_at <> OLD.created_at OR (NEW.active AND NOT OLD.active) THEN
    RAISE EXCEPTION 'a sourced field only ever deactivates' USING ERRCODE = 'check_violation', HINT = 'sources.immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sourced_record_field_guard BEFORE UPDATE ON trustwork.sourced_record_field FOR EACH ROW EXECUTE FUNCTION trustwork.sources_field_guard();
CREATE TRIGGER sourced_record_field_no_delete BEFORE DELETE ON trustwork.sourced_record_field FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 7. Record link proposals: links, never merges; decided by a person other than the proposer ---------------------------
CREATE TABLE trustwork.record_link_proposal (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  left_kind text NOT NULL CHECK (left_kind IN ('company', 'person', 'sourced_record')),
  left_id uuid NOT NULL,
  right_local_id uuid NULL,
  right_global_id text NULL CHECK (right_global_id ~ '^trustwork://[^\s]+$' AND length(right_global_id) <= 400),
  evidence text NOT NULL CHECK (evidence IN ('identifier_match', 'signed_statement', 'person_confirmed')),
  proposed_by text NOT NULL CHECK (proposed_by IN ('import', 'peer', 'person')),
  proposed_by_person uuid NOT NULL REFERENCES trustwork.person (id),
  import_batch_id uuid NULL REFERENCES trustwork.import_batch (id),
  state text NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed', 'accepted', 'rejected', 'withdrawn')),
  decided_by uuid NULL REFERENCES trustwork.person (id),
  decided_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT record_link_proposal_right CHECK ((right_local_id IS NULL) <> (right_global_id IS NULL) AND right_local_id IS DISTINCT FROM left_id),
  CONSTRAINT record_link_proposal_import CHECK ((proposed_by = 'import') = (import_batch_id IS NOT NULL)),
  CONSTRAINT record_link_proposal_decision CHECK ((state IN ('accepted', 'rejected')) = (decided_by IS NOT NULL) AND (decided_by IS NULL) = (decided_at IS NULL)),
  CONSTRAINT record_link_proposal_four_eyes CHECK (decided_by IS NULL OR decided_by <> proposed_by_person),
  -- A person is linked only with their own confirmation or a signed statement.
  CONSTRAINT record_link_proposal_person CHECK (state <> 'accepted' OR left_kind <> 'person' OR evidence IN ('person_confirmed', 'signed_statement'))
);
CREATE INDEX record_link_proposal_hub_idx ON trustwork.record_link_proposal (hub_id, state, created_at);
CREATE FUNCTION trustwork.sources_link_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.hub_id <> OLD.hub_id OR NEW.left_kind <> OLD.left_kind OR NEW.left_id <> OLD.left_id OR NEW.right_local_id IS DISTINCT FROM OLD.right_local_id
     OR NEW.right_global_id IS DISTINCT FROM OLD.right_global_id OR NEW.evidence <> OLD.evidence OR NEW.proposed_by <> OLD.proposed_by
     OR NEW.proposed_by_person <> OLD.proposed_by_person OR NEW.import_batch_id IS DISTINCT FROM OLD.import_batch_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a link proposal is immutable' USING ERRCODE = 'check_violation', HINT = 'sources.immutable';
  END IF;
  IF OLD.state <> 'proposed' THEN
    RAISE EXCEPTION 'a link proposal is decided once' USING ERRCODE = 'check_violation', HINT = 'sources.link_decided';
  END IF;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER record_link_proposal_guard BEFORE UPDATE ON trustwork.record_link_proposal FOR EACH ROW EXECUTE FUNCTION trustwork.sources_link_guard();
CREATE TRIGGER record_link_proposal_no_delete BEFORE DELETE ON trustwork.record_link_proposal FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 8. Takedowns and tombstones (append-only; tombstones carry identifiers only and outlive the records) ------------------
CREATE TABLE trustwork.source_takedown (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  target_kind text NOT NULL CHECK (target_kind IN ('source', 'source_item')),
  source_id uuid NOT NULL REFERENCES trustwork.source (id),
  source_item_id uuid NULL REFERENCES trustwork.source_item (id),
  reason_category text NOT NULL CHECK (reason_category IN ('legal_demand', 'licence_ended', 'rights_holder_request', 'court_order', 'privacy_request')),
  note text NOT NULL CHECK (length(note) BETWEEN 1 AND 500),
  items_taken_down integer NOT NULL CHECK (items_taken_down >= 0),
  fields_deactivated integer NOT NULL CHECK (fields_deactivated >= 0),
  publication_ids uuid[] NOT NULL DEFAULT '{}',
  executed_by uuid NOT NULL REFERENCES trustwork.person (id),
  executed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_takedown_target CHECK ((target_kind = 'source_item') = (source_item_id IS NOT NULL))
);
CREATE TRIGGER source_takedown_append_only BEFORE UPDATE OR DELETE ON trustwork.source_takedown FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TABLE trustwork.source_tombstone (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL,
  takedown_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('retrieval', 'federation')),
  target_kind text NOT NULL CHECK (target_kind IN ('source', 'source_item', 'sourced_record')),
  target_id uuid NOT NULL,
  record_kind text NULL CHECK (record_kind IN ('company', 'company_identifier', 'company_registration', 'professional_credential', 'product_entry', 'learning_resource', 'event')),
  reason text NOT NULL CHECK (reason IN ('takedown', 'licence_ended')),
  issued_at timestamptz NOT NULL DEFAULT now(),
  apply_by timestamptz NULL,
  CONSTRAINT source_tombstone_record CHECK ((target_kind = 'sourced_record') = (record_kind IS NOT NULL)),
  CONSTRAINT source_tombstone_apply_by CHECK ((channel = 'federation') = (apply_by IS NOT NULL) AND (apply_by IS NULL OR (apply_by > issued_at AND apply_by <= issued_at + interval '72 hours')))
);
CREATE INDEX source_tombstone_takedown_idx ON trustwork.source_tombstone (takedown_id);
CREATE TRIGGER source_tombstone_append_only BEFORE UPDATE OR DELETE ON trustwork.source_tombstone FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 9. Commands (SECURITY DEFINER, allowlisted for the runtime role) ------------------------------------------------------
-- Every command takes DATA-002's command context p_ctx ({elevationId, requestId, reasonCode, reasonText}).

CREATE FUNCTION trustwork.sources_require_hub(p_hub uuid) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF p_hub IS NULL OR NOT EXISTS (SELECT 1 FROM trustwork.hub WHERE id = p_hub) THEN
    RAISE EXCEPTION 'no such hub' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
END $$;
CREATE FUNCTION trustwork.sources_lock_source(p_source uuid) RETURNS trustwork.source
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_row trustwork.source%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM trustwork.source WHERE id = p_source FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such source' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  RETURN v_row;
END $$;
CREATE FUNCTION trustwork.sources_check_revision(p_actual integer, p_expected integer) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_expected IS NULL OR p_actual <> p_expected THEN
    RAISE EXCEPTION 'the record changed; reload' USING ERRCODE = 'serialization_failure', HINT = 'sources.revision_conflict';
  END IF;
END $$;
-- Shape and licence checks of a source's terms (the contract refines the same; the constraints hold them again).
CREATE FUNCTION trustwork.sources_check_terms(p_terms jsonb, p_ceiling jsonb) RETURNS void
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_problems text[];
BEGIN
  IF p_terms IS NULL OR jsonb_typeof(p_terms) <> 'object' OR jsonb_typeof(p_terms -> 'licence') <> 'object' OR NOT trustwork.sources_uses_ok(p_terms -> 'allowedUses')
     OR jsonb_typeof(p_terms -> 'purposes') <> 'array' THEN
    RAISE EXCEPTION 'source terms need a licence, allowed uses and purposes' USING ERRCODE = 'invalid_parameter_value', HINT = 'sources.invalid_terms';
  END IF;
  v_problems := trustwork.sources_uses_problems(p_terms #>> '{licence,kind}', NULLIF(p_terms #>> '{licence,agreementRef}', '')::uuid, p_terms -> 'allowedUses', p_ceiling);
  IF cardinality(v_problems) > 0 THEN
    RAISE EXCEPTION 'the licence does not allow these uses: %', array_to_string(v_problems, ', ') USING ERRCODE = 'check_violation', HINT = 'sources.' || v_problems[1];
  END IF;
  IF coalesce((p_terms ->> 'personalData')::boolean, false) AND p_terms ->> 'legalBasis' IS NULL THEN
    RAISE EXCEPTION 'personal data needs a recorded legal basis' USING ERRCODE = 'check_violation', HINT = 'sources.legal_basis_required';
  END IF;
END $$;
-- Caller, elevation and one of the permissions at an existing hub.
CREATE FUNCTION trustwork.sources_staff(p_ctx jsonb, p_permissions text[], p_hub uuid) RETURNS trustwork.admin_actor
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
BEGIN
  PERFORM trustwork.sources_require_hub(p_hub);
  RETURN trustwork.admin_authorize(p_ctx, p_permissions, NULL, p_hub);
END $$;

CREATE FUNCTION trustwork.sources_register(p_ctx jsonb, p_hub uuid, p_input jsonb) RETURNS trustwork.source
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.sources_staff(p_ctx, ARRAY['admin.sources.manage'], p_hub);
  v_row trustwork.source%ROWTYPE;
BEGIN
  PERFORM trustwork.sources_check_terms(p_input, NULL);
  INSERT INTO trustwork.source (hub_id, kind, name, url, reader_kind, purposes, licence_kind, licence_name, licence_url, agreement_ref, allowed_uses, attribution_template,
    takedown_contact, owner_person_id, personal_data, legal_basis, proposed_by_kind, proposed_by_person, edited_by)
  VALUES (p_hub, p_input ->> 'kind', p_input ->> 'name', p_input ->> 'url', p_input ->> 'readerKind', ARRAY(SELECT jsonb_array_elements_text(p_input -> 'purposes')),
    p_input #>> '{licence,kind}', p_input #>> '{licence,name}', p_input #>> '{licence,url}', NULLIF(p_input #>> '{licence,agreementRef}', '')::uuid, p_input -> 'allowedUses',
    p_input ->> 'attributionTemplate', p_input ->> 'takedownContact', (p_input ->> 'ownerPersonId')::uuid, coalesce((p_input ->> 'personalData')::boolean, false),
    p_input ->> 'legalBasis', 'person', v_actor.person_id, v_actor.person_id)
  RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'source.registered', 'source', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Sets the licence, allowed uses and the other editorial terms. Widening any flag of an active or paused source sends
-- it back to `proposed`: a person other than this editor activates it again. Narrowing keeps it running.
CREATE FUNCTION trustwork.sources_set_terms(p_ctx jsonb, p_source uuid, p_expected_revision integer, p_input jsonb) RETURNS trustwork.source
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_before trustwork.source%ROWTYPE;
  v_row trustwork.source%ROWTYPE;
  v_widened boolean;
BEGIN
  PERFORM trustwork.admin_require_caller();
  v_before := trustwork.sources_lock_source(p_source);
  v_actor := trustwork.sources_staff(p_ctx, ARRAY['admin.sources.manage'], v_before.hub_id);
  PERFORM trustwork.sources_check_revision(v_before.revision, p_expected_revision);
  IF v_before.status IN ('rejected', 'retired', 'taken_down') THEN
    RAISE EXCEPTION 'a % source is closed', v_before.status USING ERRCODE = 'check_violation', HINT = 'sources.source_closed';
  END IF;
  PERFORM trustwork.sources_check_terms(p_input, v_before.rsl_ceiling);
  v_widened := cardinality(trustwork.sources_uses_above(p_input -> 'allowedUses', v_before.allowed_uses)) > 0
    OR (p_input #>> '{licence,kind}') IS DISTINCT FROM v_before.licence_kind;
  UPDATE trustwork.source SET reader_kind = p_input ->> 'readerKind', purposes = ARRAY(SELECT jsonb_array_elements_text(p_input -> 'purposes')),
    licence_kind = p_input #>> '{licence,kind}', licence_name = p_input #>> '{licence,name}', licence_url = p_input #>> '{licence,url}',
    agreement_ref = NULLIF(p_input #>> '{licence,agreementRef}', '')::uuid, allowed_uses = p_input -> 'allowedUses', attribution_template = p_input ->> 'attributionTemplate',
    takedown_contact = p_input ->> 'takedownContact', personal_data = coalesce((p_input ->> 'personalData')::boolean, false), legal_basis = p_input ->> 'legalBasis',
    edited_by = v_actor.person_id,
    status = CASE WHEN v_widened AND v_before.status IN ('active', 'paused') THEN 'proposed' ELSE v_before.status END,
    activated_by = CASE WHEN v_widened AND v_before.status IN ('active', 'paused') THEN NULL ELSE v_before.activated_by END,
    activated_at = CASE WHEN v_widened AND v_before.status IN ('active', 'paused') THEN NULL ELSE v_before.activated_at END,
    pause_reason = CASE WHEN v_widened AND v_before.status IN ('active', 'paused') THEN NULL ELSE v_before.pause_reason END,
    paused_at = CASE WHEN v_widened AND v_before.status IN ('active', 'paused') THEN NULL ELSE v_before.paused_at END
  WHERE id = p_source RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'source.terms_set', 'source', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Records a person's terms-of-use check. A changed terms digest, or terms that no longer permit automated access for a
-- crawled source, pause an active source until someone checks again and resumes it.
CREATE FUNCTION trustwork.sources_record_terms(p_ctx jsonb, p_source uuid, p_expected_revision integer, p_url text, p_digest text, p_access text, p_notes text) RETURNS trustwork.source
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_before trustwork.source%ROWTYPE;
  v_row trustwork.source%ROWTYPE;
  v_pause boolean;
BEGIN
  PERFORM trustwork.admin_require_caller();
  v_before := trustwork.sources_lock_source(p_source);
  v_actor := trustwork.sources_staff(p_ctx, ARRAY['admin.sources.manage'], v_before.hub_id);
  PERFORM trustwork.sources_check_revision(v_before.revision, p_expected_revision);
  IF v_before.status IN ('rejected', 'retired', 'taken_down') THEN
    RAISE EXCEPTION 'a % source is closed', v_before.status USING ERRCODE = 'check_violation', HINT = 'sources.source_closed';
  END IF;
  v_pause := v_before.status = 'active' AND ((v_before.terms_digest IS NOT NULL AND p_digest IS DISTINCT FROM v_before.terms_digest)
    OR (v_before.kind = ANY (trustwork.sources_crawling_kinds()) AND p_access IS DISTINCT FROM 'permitted'));
  UPDATE trustwork.source SET terms_checked_at = clock_timestamp(), terms_url = p_url, terms_digest = p_digest, terms_automated_access = p_access,
    terms_reviewed_by = v_actor.person_id, terms_notes = coalesce(p_notes, ''), edited_by = v_actor.person_id,
    status = CASE WHEN v_pause THEN 'paused' ELSE status END, pause_reason = CASE WHEN v_pause THEN 'terms_changed' ELSE pause_reason END,
    paused_at = CASE WHEN v_pause THEN clock_timestamp() ELSE paused_at END
  WHERE id = p_source RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, CASE WHEN v_pause THEN 'source.paused_terms_changed' ELSE 'source.terms_recorded' END,
    'source', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Records a robots.txt check (fetched by the API through its adapter port). A changed digest pauses an active source;
-- a crawled source that robots.txt no longer allows is paused too.
CREATE FUNCTION trustwork.sources_record_robots(p_ctx jsonb, p_source uuid, p_input jsonb) RETURNS trustwork.crawl_policy
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_before trustwork.source%ROWTYPE;
  v_previous trustwork.crawl_policy%ROWTYPE;
  v_row trustwork.crawl_policy%ROWTYPE;
  v_pause boolean;
BEGIN
  PERFORM trustwork.admin_require_caller();
  v_before := trustwork.sources_lock_source(p_source);
  v_actor := trustwork.sources_staff(p_ctx, ARRAY['admin.sources.manage'], v_before.hub_id);
  IF v_before.status IN ('rejected', 'retired', 'taken_down') THEN
    RAISE EXCEPTION 'a % source is closed', v_before.status USING ERRCODE = 'check_violation', HINT = 'sources.source_closed';
  END IF;
  IF v_before.url IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object' THEN
    RAISE EXCEPTION 'a robots.txt check needs a source URL' USING ERRCODE = 'invalid_parameter_value', HINT = 'sources.url_required';
  END IF;
  v_previous := trustwork.sources_current_policy(p_source);
  INSERT INTO trustwork.crawl_policy (source_id, hub_id, domain, robots_url, user_agent, robots_digest, allowed, status, crawl_delay_s, allowed_paths, disallowed_paths, licence_urls, recorded_by)
  VALUES (p_source, v_before.hub_id, p_input ->> 'domain', p_input ->> 'robotsUrl', p_input ->> 'userAgent', p_input ->> 'robotsDigest', (p_input ->> 'allowed')::boolean,
    p_input ->> 'status', (p_input ->> 'crawlDelaySeconds')::integer, ARRAY(SELECT jsonb_array_elements_text(coalesce(p_input -> 'allowedPaths', '[]'::jsonb))),
    ARRAY(SELECT jsonb_array_elements_text(coalesce(p_input -> 'disallowedPaths', '[]'::jsonb))), ARRAY(SELECT jsonb_array_elements_text(coalesce(p_input -> 'licenceUrls', '[]'::jsonb))),
    v_actor.person_id)
  RETURNING * INTO v_row;
  IF lower(split_part(split_part(v_before.url, '://', 2), '/', 1)) <> v_row.domain THEN
    RAISE EXCEPTION 'the robots.txt check is for another domain' USING ERRCODE = 'check_violation', HINT = 'sources.robots_domain';
  END IF;
  v_pause := v_before.status = 'active' AND ((v_previous.id IS NOT NULL AND v_previous.robots_digest <> v_row.robots_digest)
    OR (v_before.kind = ANY (trustwork.sources_crawling_kinds()) AND NOT v_row.allowed));
  IF v_pause THEN
    UPDATE trustwork.source SET status = 'paused', pause_reason = 'robots_changed', paused_at = clock_timestamp() WHERE id = p_source;
  END IF;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, CASE WHEN v_pause THEN 'source.paused_robots_changed' ELSE 'source.robots_recorded' END,
    'crawl_policy', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Records an RSL reading (parsed by the API with the contract's parseRsl). The reading is a suggestion: flags are never
-- widened by it. Flags above the new ceiling are narrowed at once (unless a publisher agreement is on record).
CREATE FUNCTION trustwork.sources_record_rsl(p_ctx jsonb, p_source uuid, p_expected_revision integer, p_status text, p_digest text, p_ceiling jsonb, p_suggested jsonb) RETURNS trustwork.source
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_before trustwork.source%ROWTYPE;
  v_row trustwork.source%ROWTYPE;
  v_agreement boolean;
BEGIN
  PERFORM trustwork.admin_require_caller();
  v_before := trustwork.sources_lock_source(p_source);
  v_actor := trustwork.sources_staff(p_ctx, ARRAY['admin.sources.manage'], v_before.hub_id);
  PERFORM trustwork.sources_check_revision(v_before.revision, p_expected_revision);
  IF v_before.status IN ('rejected', 'retired', 'taken_down') THEN
    RAISE EXCEPTION 'a % source is closed', v_before.status USING ERRCODE = 'check_violation', HINT = 'sources.source_closed';
  END IF;
  IF p_status NOT IN ('absent', 'parsed', 'failed', 'no_matching_content') THEN
    RAISE EXCEPTION 'unknown RSL status' USING ERRCODE = 'invalid_parameter_value', HINT = 'sources.invalid_rsl';
  END IF;
  v_agreement := v_before.licence_kind = 'publisher_agreement' AND v_before.agreement_ref IS NOT NULL;
  UPDATE trustwork.source SET rsl_status = p_status, rsl_digest = CASE WHEN p_status = 'absent' THEN NULL ELSE p_digest END,
    rsl_checked_at = CASE WHEN p_status = 'absent' THEN NULL ELSE clock_timestamp() END,
    rsl_ceiling = CASE WHEN p_status = 'absent' THEN NULL WHEN p_status = 'parsed' THEN p_ceiling ELSE trustwork.sources_most_restrictive() END,
    rsl_suggested = CASE WHEN p_status = 'absent' THEN NULL WHEN p_status = 'parsed' THEN p_suggested ELSE trustwork.sources_most_restrictive() END,
    allowed_uses = CASE WHEN p_status = 'absent' OR v_agreement THEN allowed_uses
      ELSE trustwork.sources_uses_and(allowed_uses, CASE WHEN p_status = 'parsed' THEN p_ceiling ELSE trustwork.sources_most_restrictive() END) END
  WHERE id = p_source RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'source.rsl_recorded', 'source', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Activate (a person other than the last editor of the terms; crawled sources with permitting checks), pause, resume
-- (after a fresher check when paused for a robots or terms change), reject or retire.
CREATE FUNCTION trustwork.sources_set_status(p_ctx jsonb, p_source uuid, p_expected_revision integer, p_to text) RETURNS trustwork.source
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_before trustwork.source%ROWTYPE;
  v_row trustwork.source%ROWTYPE;
  v_policy trustwork.crawl_policy%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  v_before := trustwork.sources_lock_source(p_source);
  v_actor := trustwork.sources_staff(p_ctx, ARRAY['admin.sources.manage'], v_before.hub_id);
  PERFORM trustwork.sources_check_revision(v_before.revision, p_expected_revision);
  IF p_to NOT IN ('active', 'paused', 'rejected', 'retired') THEN
    RAISE EXCEPTION 'unknown source transition' USING ERRCODE = 'invalid_parameter_value', HINT = 'sources.invalid_transition';
  END IF;
  IF p_to = v_before.status THEN
    RAISE EXCEPTION 'the source is already %', p_to USING ERRCODE = 'check_violation', HINT = 'sources.invalid_transition';
  END IF;
  IF p_to = 'active' AND v_before.status = 'paused' THEN
    v_policy := trustwork.sources_current_policy(p_source);
    IF (v_before.pause_reason = 'robots_changed' AND (v_policy.id IS NULL OR v_policy.fetched_at <= v_before.paused_at))
       OR (v_before.pause_reason = 'terms_changed' AND (v_before.terms_checked_at IS NULL OR v_before.terms_checked_at <= v_before.paused_at)) THEN
      RAISE EXCEPTION 'resume after a fresh check' USING ERRCODE = 'check_violation', HINT = 'sources.fresh_check_required';
    END IF;
  END IF;
  UPDATE trustwork.source SET status = p_to,
    activated_by = CASE WHEN p_to = 'active' THEN v_actor.person_id ELSE activated_by END,
    activated_at = CASE WHEN p_to = 'active' THEN clock_timestamp() ELSE activated_at END,
    pause_reason = CASE WHEN p_to = 'paused' THEN 'manual' ELSE NULL END,
    paused_at = CASE WHEN p_to = 'paused' THEN clock_timestamp() ELSE NULL END
  WHERE id = p_source RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'source.' || CASE p_to WHEN 'active' THEN 'activated' ELSE p_to END, 'source', v_row.id,
    to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Writes the tombstones of a takedown and their identifiers-only outbox events.
CREATE FUNCTION trustwork.sources_emit_tombstones(p_takedown trustwork.source_takedown, p_items uuid[], p_records jsonb, p_reason text) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  INSERT INTO trustwork.source_tombstone (hub_id, takedown_id, channel, target_kind, target_id, record_kind, reason, issued_at, apply_by)
  SELECT p_takedown.hub_id, p_takedown.id, c.channel, t.target_kind, t.target_id, t.record_kind, p_reason, v_now,
         CASE WHEN c.channel = 'federation' THEN v_now + interval '72 hours' END
  FROM (
    SELECT 'source'::text AS target_kind, p_takedown.source_id AS target_id, NULL::text AS record_kind WHERE p_takedown.target_kind = 'source'
    UNION ALL SELECT 'source_item', i, NULL FROM unnest(p_items) i
    UNION ALL SELECT 'sourced_record', (r ->> 'id')::uuid, r ->> 'kind' FROM jsonb_array_elements(p_records) r
  ) t CROSS JOIN (VALUES ('retrieval'), ('federation')) c(channel)
  WHERE c.channel = 'retrieval' OR t.target_kind <> 'source';
  INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
  SELECT 'source_tombstone', t.id::text, 1, 'sources.' || t.channel || '_tombstone', jsonb_build_object('tombstoneId', t.id, 'hubId', t.hub_id, 'targetKind', t.target_kind,
    'targetId', t.target_id, 'recordKind', t.record_kind, 'reason', t.reason, 'applyBy', t.apply_by)
  FROM trustwork.source_tombstone t WHERE t.takedown_id = p_takedown.id ORDER BY t.channel, t.target_kind, t.target_id;
END $$;

-- Takedown of a whole source or one item: deactivate, redact stored text, withdraw open batches and link proposals,
-- write tombstones and audit the reason, in one transaction. Publications made from the items are named for the
-- editor-in-chief's retraction (CNT-001); this command never edits a publication.
CREATE FUNCTION trustwork.sources_takedown(p_ctx jsonb, p_source uuid, p_item uuid, p_category text, p_note text) RETURNS trustwork.source_takedown
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_source trustwork.source%ROWTYPE;
  v_item trustwork.source_item%ROWTYPE;
  v_row trustwork.source_takedown%ROWTYPE;
  v_items uuid[];
  v_pubs uuid[];
  v_records jsonb;
  v_fields integer;
BEGIN
  PERFORM trustwork.admin_require_caller();
  IF p_item IS NOT NULL THEN
    SELECT * INTO v_item FROM trustwork.source_item WHERE id = p_item;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no such item' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
    END IF;
    p_source := v_item.source_id;
  END IF;
  v_source := trustwork.sources_lock_source(p_source);
  v_actor := trustwork.sources_staff(p_ctx, ARRAY['admin.sources.takedown'], v_source.hub_id);
  IF p_category NOT IN ('legal_demand', 'licence_ended', 'rights_holder_request', 'court_order', 'privacy_request') OR length(coalesce(p_note, '')) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'a takedown names its reason' USING ERRCODE = 'invalid_parameter_value', HINT = 'sources.takedown_reason_required';
  END IF;
  IF v_source.status = 'taken_down' THEN
    RAISE EXCEPTION 'the source is already taken down' USING ERRCODE = 'check_violation', HINT = 'sources.taken_down';
  END IF;
  IF p_item IS NOT NULL THEN
    SELECT * INTO v_item FROM trustwork.source_item WHERE id = p_item FOR UPDATE;
    IF v_item.status = 'taken_down' THEN
      RAISE EXCEPTION 'the item is already taken down' USING ERRCODE = 'check_violation', HINT = 'sources.taken_down';
    END IF;
  END IF;
  SELECT coalesce(array_agg(id ORDER BY id), '{}'), coalesce(array_agg(DISTINCT publication_id) FILTER (WHERE publication_id IS NOT NULL), '{}')
    INTO v_items, v_pubs
    FROM trustwork.source_item WHERE source_id = p_source AND status <> 'taken_down' AND (p_item IS NULL OR id = p_item);
  SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('kind', record_kind, 'id', record_id)), '[]'::jsonb), count(*)::int
    INTO v_records, v_fields
    FROM trustwork.sourced_record_field WHERE source_id = p_source AND active AND (p_item IS NULL OR source_item_id = p_item);
  INSERT INTO trustwork.source_takedown (hub_id, target_kind, source_id, source_item_id, reason_category, note, items_taken_down, fields_deactivated, publication_ids, executed_by)
  VALUES (v_source.hub_id, CASE WHEN p_item IS NULL THEN 'source' ELSE 'source_item' END, p_source, p_item, p_category, p_note, cardinality(v_items), v_fields, v_pubs, v_actor.person_id)
  RETURNING * INTO v_row;
  UPDATE trustwork.source_item SET status = 'taken_down', summary = NULL, full_text = NULL, assisted_summary = NULL, assisted_language = NULL, assisted_at = NULL, takedown_id = v_row.id
   WHERE id = ANY (v_items);
  UPDATE trustwork.sourced_record_field SET active = false, deactivated_at = clock_timestamp(), takedown_id = v_row.id
   WHERE source_id = p_source AND active AND (p_item IS NULL OR source_item_id = p_item);
  IF p_item IS NULL THEN
    UPDATE trustwork.import_batch SET status = 'taken_down' WHERE source_id = p_source AND status = 'staged';
    UPDATE trustwork.record_link_proposal SET state = 'withdrawn'
     WHERE state = 'proposed' AND import_batch_id IN (SELECT id FROM trustwork.import_batch WHERE source_id = p_source);
    UPDATE trustwork.source SET status = 'taken_down', pause_reason = 'takedown', paused_at = clock_timestamp() WHERE id = p_source;
  END IF;
  PERFORM trustwork.sources_emit_tombstones(v_row, v_items, v_records, CASE WHEN p_category = 'licence_ended' THEN 'licence_ended' ELSE 'takedown' END);
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, CASE WHEN p_item IS NULL THEN 'source.taken_down' ELSE 'source_item.taken_down' END,
    CASE WHEN p_item IS NULL THEN 'source' ELSE 'source_item' END, coalesce(p_item, p_source), NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Stages a batch of imported items, sourced fields and link proposals from an active source, with the source's licence
-- snapshot. Items repeat no external id of the source (repeats are counted as duplicates). Stored text only where the
-- licence allows it; sponsored items only where the hub's policy allows them.
CREATE FUNCTION trustwork.sources_stage_batch(p_ctx jsonb, p_source uuid, p_items jsonb, p_fields jsonb, p_links jsonb) RETURNS trustwork.import_batch
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_source trustwork.source%ROWTYPE;
  v_policy trustwork.sponsored_content_policy%ROWTYPE;
  v_row trustwork.import_batch%ROWTYPE;
  v_snapshot jsonb;
  v_uses jsonb;
  v_i jsonb;
  v_f jsonb;
  v_l jsonb;
  v_item uuid;
  v_ids jsonb := '{}'::jsonb;
  v_dup integer := 0;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_source FROM trustwork.source WHERE id = p_source FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such source' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.sources_staff(p_ctx, ARRAY['admin.sources.manage'], v_source.hub_id);
  IF v_source.status <> 'active' THEN
    RAISE EXCEPTION 'only an active source imports' USING ERRCODE = 'check_violation', HINT = 'sources.source_not_active';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 200 OR jsonb_typeof(p_fields) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_fields) > 500 OR jsonb_typeof(p_links) IS DISTINCT FROM 'array' OR jsonb_array_length(p_links) > 200 THEN
    RAISE EXCEPTION 'a batch has 1 to 200 items, at most 500 fields and 200 links' USING ERRCODE = 'invalid_parameter_value', HINT = 'sources.invalid_batch';
  END IF;
  v_uses := v_source.allowed_uses;
  v_snapshot := jsonb_build_object('licenceKind', v_source.licence_kind, 'licenceName', v_source.licence_name, 'allowedUses', v_uses);
  v_policy := trustwork.sources_sponsored_current(v_source.hub_id);
  -- First pass: licence and sponsorship checks, and the repeats of earlier imports (counted, not stored again).
  FOR v_i IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF v_i ->> 'summary' IS NOT NULL AND NOT trustwork.sources_use(v_uses, 'displaySummary') THEN
      RAISE EXCEPTION 'the licence does not allow storing a summary' USING ERRCODE = 'check_violation', HINT = 'sources.licence_forbids_summary';
    END IF;
    IF v_i ->> 'fullText' IS NOT NULL AND NOT trustwork.sources_use(v_uses, 'storeFullText') THEN
      RAISE EXCEPTION 'the licence does not allow storing the full text' USING ERRCODE = 'check_violation', HINT = 'sources.licence_forbids_full_text';
    END IF;
    IF jsonb_typeof(v_i -> 'sponsored') = 'object' THEN
      IF v_policy.id IS NULL OR NOT v_policy.allowed THEN
        RAISE EXCEPTION 'sponsored content is off in this hub' USING ERRCODE = 'check_violation', HINT = 'sources.sponsored_off';
      END IF;
      IF v_policy.require_verified_sponsor THEN
        RAISE EXCEPTION 'the hub requires verified sponsors, and sponsor verification is not available yet' USING ERRCODE = 'check_violation', HINT = 'sources.sponsor_unverified';
      END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM trustwork.source_item WHERE source_id = p_source AND external_id = v_i ->> 'externalId') THEN
      v_dup := v_dup + 1;
    END IF;
  END LOOP;
  INSERT INTO trustwork.import_batch (source_id, hub_id, staged_by, counts, licence_snapshot)
  VALUES (p_source, v_source.hub_id, v_actor.person_id,
    jsonb_build_object('items', jsonb_array_length(p_items) - v_dup, 'duplicates', v_dup, 'fields', jsonb_array_length(p_fields), 'links', jsonb_array_length(p_links)), v_snapshot)
  RETURNING * INTO v_row;
  FOR v_i IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM trustwork.source_item WHERE source_id = p_source AND external_id = v_i ->> 'externalId');
    INSERT INTO trustwork.source_item (hub_id, source_id, import_batch_id, external_id, url, title, summary, full_text, source_time, content_digest, licence_snapshot, sponsored, sponsor_name)
    VALUES (v_source.hub_id, p_source, v_row.id, v_i ->> 'externalId', v_i ->> 'url', v_i ->> 'title', v_i ->> 'summary', v_i ->> 'fullText', (v_i ->> 'sourceTime')::timestamptz,
      trustwork.admin_digest(jsonb_build_object('url', v_i ->> 'url', 'title', v_i ->> 'title', 'summary', coalesce(v_i -> 'summary', 'null'::jsonb), 'fullText', coalesce(v_i -> 'fullText', 'null'::jsonb))),
      v_snapshot, jsonb_typeof(v_i -> 'sponsored') = 'object', v_i #>> '{sponsored,sponsorName}')
    RETURNING id INTO v_item;
    v_ids := v_ids || jsonb_build_object(v_i ->> 'externalId', v_item);
  END LOOP;
  FOR v_f IN SELECT value FROM jsonb_array_elements(p_fields) LOOP
    INSERT INTO trustwork.sourced_record_field (hub_id, record_kind, record_id, field, value, source_id, import_batch_id, source_item_id)
    VALUES (v_source.hub_id, v_f ->> 'recordKind', (v_f ->> 'recordId')::uuid, v_f ->> 'field', v_f ->> 'value', p_source, v_row.id,
      CASE WHEN v_f ->> 'itemExternalId' IS NULL THEN NULL
           ELSE coalesce((v_ids ->> (v_f ->> 'itemExternalId'))::uuid,
                         (SELECT id FROM trustwork.source_item WHERE source_id = p_source AND external_id = v_f ->> 'itemExternalId')) END);
  END LOOP;
  FOR v_l IN SELECT value FROM jsonb_array_elements(p_links) LOOP
    INSERT INTO trustwork.record_link_proposal (hub_id, left_kind, left_id, right_local_id, right_global_id, evidence, proposed_by, proposed_by_person, import_batch_id)
    VALUES (v_source.hub_id, v_l #>> '{left,kind}', (v_l #>> '{left,id}')::uuid, (v_l ->> 'rightLocalId')::uuid, v_l ->> 'rightGlobalId', v_l ->> 'evidence', 'import',
      v_actor.person_id, v_row.id);
  END LOOP;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'import_batch.staged', 'import_batch', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- A second person activates (items enter the review queue, sourced fields become visible with their provenance) or
-- rejects a staged batch.
CREATE FUNCTION trustwork.sources_decide_batch(p_ctx jsonb, p_batch uuid, p_expected_revision integer, p_decision text) RETURNS trustwork.import_batch
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_before trustwork.import_batch%ROWTYPE;
  v_row trustwork.import_batch%ROWTYPE;
  v_source_status text;
BEGIN
  PERFORM trustwork.admin_require_caller();
  -- Lock order everywhere: the source first, then its batches and items (takedown takes the same order).
  SELECT * INTO v_before FROM trustwork.import_batch WHERE id = p_batch;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such batch' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  SELECT status INTO v_source_status FROM trustwork.source WHERE id = v_before.source_id FOR SHARE;
  SELECT * INTO v_before FROM trustwork.import_batch WHERE id = p_batch FOR UPDATE;
  v_actor := trustwork.sources_staff(p_ctx, ARRAY['admin.sources.import.activate'], v_before.hub_id);
  PERFORM trustwork.sources_check_revision(v_before.revision, p_expected_revision);
  IF p_decision NOT IN ('activate', 'reject') THEN
    RAISE EXCEPTION 'activate or reject' USING ERRCODE = 'invalid_parameter_value', HINT = 'sources.invalid_decision';
  END IF;
  IF v_before.status <> 'staged' THEN
    RAISE EXCEPTION 'a batch is decided once' USING ERRCODE = 'check_violation', HINT = 'sources.batch_decided';
  END IF;
  IF v_before.staged_by = v_actor.person_id THEN
    RAISE EXCEPTION 'the person who staged a batch does not activate it' USING ERRCODE = 'insufficient_privilege', HINT = 'sources.self_activation';
  END IF;
  IF p_decision = 'activate' AND v_source_status <> 'active' THEN
    RAISE EXCEPTION 'only batches of an active source are activated' USING ERRCODE = 'check_violation', HINT = 'sources.source_not_active';
  END IF;
  UPDATE trustwork.import_batch SET status = CASE p_decision WHEN 'activate' THEN 'activated' ELSE 'rejected' END, decided_by = v_actor.person_id, decided_at = clock_timestamp()
   WHERE id = p_batch RETURNING * INTO v_row;
  IF p_decision = 'reject' THEN
    UPDATE trustwork.record_link_proposal SET state = 'withdrawn' WHERE import_batch_id = p_batch AND state = 'proposed';
  END IF;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'import_batch.' || v_row.status, 'import_batch', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- The licence-checked payload of an item for a model provider or a peer (staff of the hub only). Refuses when the
-- item's effective uses do not allow the channel. Every egress path of this module goes through it.
CREATE FUNCTION trustwork.sources_item_egress(p_item uuid, p_channel text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_item trustwork.source_item%ROWTYPE;
  v_source trustwork.source%ROWTYPE;
  v_uses jsonb;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_item FROM trustwork.source_item WHERE id = p_item;
  IF NOT FOUND OR NOT trustwork.admin_has_any_permission(ARRAY['admin.sources.manage', 'admin.publications.review'], NULL, v_item.hub_id) THEN
    RAISE EXCEPTION 'no such item' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF p_channel NOT IN ('model_provider', 'peer') THEN
    RAISE EXCEPTION 'unknown egress channel' USING ERRCODE = 'invalid_parameter_value', HINT = 'sources.invalid_channel';
  END IF;
  SELECT * INTO v_source FROM trustwork.source WHERE id = v_item.source_id;
  v_uses := trustwork.sources_effective_uses(v_item);
  IF v_item.status = 'taken_down' OR v_source.status = 'taken_down' THEN
    RAISE EXCEPTION 'the item was taken down' USING ERRCODE = 'check_violation', HINT = 'sources.taken_down';
  END IF;
  IF p_channel = 'model_provider' AND NOT trustwork.sources_use(v_uses, 'sendToModelProviders') THEN
    RAISE EXCEPTION 'the licence does not allow sending this item to a model provider' USING ERRCODE = 'check_violation', HINT = 'sources.licence_forbids_model_use';
  END IF;
  IF p_channel = 'peer' AND NOT trustwork.sources_use(v_uses, 'syndicateToPeers') THEN
    RAISE EXCEPTION 'the licence does not allow syndicating this item' USING ERRCODE = 'check_violation', HINT = 'sources.licence_forbids_syndication';
  END IF;
  RETURN jsonb_build_object('itemId', v_item.id, 'url', v_item.url, 'title', v_item.title, 'summary', v_item.summary,
    'fullText', CASE WHEN trustwork.sources_use(v_uses, 'storeFullText') THEN v_item.full_text END, 'attribution', v_source.attribution_template, 'sourceName', v_source.name);
END $$;

-- Stores a machine-assisted summary suggestion (labelled) for a queued item whose licence allows model use.
CREATE FUNCTION trustwork.sources_record_assist(p_ctx jsonb, p_item uuid, p_expected_revision integer, p_summary text, p_language text) RETURNS trustwork.source_item
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_before trustwork.source_item%ROWTYPE;
  v_row trustwork.source_item%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_before FROM trustwork.source_item WHERE id = p_item;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such item' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  PERFORM 1 FROM trustwork.source WHERE id = v_before.source_id FOR SHARE;
  SELECT * INTO v_before FROM trustwork.source_item WHERE id = p_item FOR UPDATE;
  v_actor := trustwork.sources_staff(p_ctx, ARRAY['admin.publications.review'], v_before.hub_id);
  PERFORM trustwork.sources_check_revision(v_before.revision, p_expected_revision);
  PERFORM trustwork.sources_item_egress(p_item, 'model_provider');
  IF v_before.status <> 'queued' THEN
    RAISE EXCEPTION 'an item is decided once' USING ERRCODE = 'check_violation', HINT = 'sources.item_decided';
  END IF;
  UPDATE trustwork.source_item SET assisted_summary = p_summary, assisted_language = p_language, assisted_at = clock_timestamp() WHERE id = p_item RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'source_item.assisted', 'source_item', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- A person's decision on an item from an activated batch: discard it, or record the publication draft they just
-- created from it (CNT-001 editorial draft in this transaction, by the same person, citing the item with flags no
-- wider than its effective uses). The decider never staged the batch. Nothing here publishes.
CREATE FUNCTION trustwork.sources_decide_item(p_ctx jsonb, p_item uuid, p_expected_revision integer, p_decision text, p_publication uuid) RETURNS trustwork.source_item
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_before trustwork.source_item%ROWTYPE;
  v_row trustwork.source_item%ROWTYPE;
  v_batch trustwork.import_batch%ROWTYPE;
  v_source trustwork.source%ROWTYPE;
  v_uses jsonb;
  v_ref jsonb;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_before FROM trustwork.source_item WHERE id = p_item;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such item' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  SELECT * INTO v_source FROM trustwork.source WHERE id = v_before.source_id FOR SHARE;
  SELECT * INTO v_before FROM trustwork.source_item WHERE id = p_item FOR UPDATE;
  v_actor := trustwork.sources_staff(p_ctx, ARRAY['admin.publications.review'], v_before.hub_id);
  PERFORM trustwork.sources_check_revision(v_before.revision, p_expected_revision);
  IF p_decision NOT IN ('draft', 'discard') OR (p_decision = 'draft') <> (p_publication IS NOT NULL) THEN
    RAISE EXCEPTION 'draft with a publication, or discard' USING ERRCODE = 'invalid_parameter_value', HINT = 'sources.invalid_decision';
  END IF;
  IF v_before.status = 'taken_down' OR v_source.status = 'taken_down' THEN
    RAISE EXCEPTION 'the item was taken down' USING ERRCODE = 'check_violation', HINT = 'sources.taken_down';
  END IF;
  IF v_before.status <> 'queued' THEN
    RAISE EXCEPTION 'an item is decided once' USING ERRCODE = 'check_violation', HINT = 'sources.item_decided';
  END IF;
  SELECT * INTO v_batch FROM trustwork.import_batch WHERE id = v_before.import_batch_id;
  IF v_batch.status <> 'activated' THEN
    RAISE EXCEPTION 'items are decided only after their batch is activated' USING ERRCODE = 'check_violation', HINT = 'sources.batch_not_activated';
  END IF;
  IF v_batch.staged_by = v_actor.person_id THEN
    RAISE EXCEPTION 'the person who staged a batch does not decide its items' USING ERRCODE = 'insufficient_privilege', HINT = 'sources.self_review';
  END IF;
  IF p_decision = 'draft' THEN
    v_uses := trustwork.sources_effective_uses(v_before);
    SELECT s.value INTO v_ref
      FROM trustwork.publication p
      JOIN trustwork.publication_version v ON v.publication_id = p.id AND v.status = 'draft'
      CROSS JOIN LATERAL jsonb_array_elements(v.source_refs) s
     WHERE p.id = p_publication AND p.hub_id = v_before.hub_id AND p.status = 'draft' AND p.owner_kind = 'editorial' AND p.created_by = v_actor.person_id
       AND s.value ->> 'uri' = v_before.url
     LIMIT 1;
    IF v_ref IS NULL THEN
      RAISE EXCEPTION 'the publication draft must be the decider''s editorial draft citing the item' USING ERRCODE = 'check_violation', HINT = 'sources.publication_mismatch';
    END IF;
    IF NOT trustwork.sources_uses_ok(v_ref -> 'allowedUses') OR cardinality(trustwork.sources_uses_above(v_ref -> 'allowedUses', v_uses)) > 0 THEN
      RAISE EXCEPTION 'the cited licence flags exceed the item''s' USING ERRCODE = 'check_violation', HINT = 'sources.source_ref_exceeds_licence';
    END IF;
  END IF;
  UPDATE trustwork.source_item SET status = CASE p_decision WHEN 'draft' THEN 'drafted' ELSE 'discarded' END, decided_by = v_actor.person_id, decided_at = clock_timestamp(),
    publication_id = p_publication
   WHERE id = p_item RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'source_item.' || v_row.status, 'source_item', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.sources_propose_link(p_ctx jsonb, p_hub uuid, p_left_kind text, p_left uuid, p_right_local uuid, p_right_global text, p_evidence text) RETURNS trustwork.record_link_proposal
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.sources_staff(p_ctx, ARRAY['admin.links.decide', 'admin.sources.dedupe.decide'], p_hub);
  v_row trustwork.record_link_proposal%ROWTYPE;
BEGIN
  INSERT INTO trustwork.record_link_proposal (hub_id, left_kind, left_id, right_local_id, right_global_id, evidence, proposed_by, proposed_by_person)
  VALUES (p_hub, p_left_kind, p_left, p_right_local, p_right_global, p_evidence, 'person', v_actor.person_id) RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'record_link.proposed', 'record_link_proposal', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.sources_decide_link(p_ctx jsonb, p_link uuid, p_expected_revision integer, p_decision text) RETURNS trustwork.record_link_proposal
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_before trustwork.record_link_proposal%ROWTYPE;
  v_row trustwork.record_link_proposal%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_before FROM trustwork.record_link_proposal WHERE id = p_link FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such link proposal' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.sources_staff(p_ctx, ARRAY['admin.links.decide', 'admin.sources.dedupe.decide'], v_before.hub_id);
  PERFORM trustwork.sources_check_revision(v_before.revision, p_expected_revision);
  IF p_decision NOT IN ('accept', 'reject') THEN
    RAISE EXCEPTION 'accept or reject' USING ERRCODE = 'invalid_parameter_value', HINT = 'sources.invalid_decision';
  END IF;
  IF v_before.state <> 'proposed' THEN
    RAISE EXCEPTION 'a link proposal is decided once' USING ERRCODE = 'check_violation', HINT = 'sources.link_decided';
  END IF;
  IF v_before.proposed_by_person = v_actor.person_id THEN
    RAISE EXCEPTION 'the proposer does not decide the link' USING ERRCODE = 'insufficient_privilege', HINT = 'sources.self_review';
  END IF;
  IF p_decision = 'accept' AND v_before.left_kind = 'person' AND v_before.evidence NOT IN ('person_confirmed', 'signed_statement') THEN
    RAISE EXCEPTION 'a person is linked only with their own confirmation' USING ERRCODE = 'check_violation', HINT = 'sources.person_confirmation_required';
  END IF;
  UPDATE trustwork.record_link_proposal SET state = CASE p_decision WHEN 'accept' THEN 'accepted' ELSE 'rejected' END, decided_by = v_actor.person_id, decided_at = clock_timestamp()
   WHERE id = p_link RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'record_link.' || v_row.state, 'record_link_proposal', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- A new version of the hub's sponsored content policy. Switching sponsored content on consumes a second person's
-- approval of exactly this version (sponsored.enable); switching it off needs none.
CREATE FUNCTION trustwork.sources_set_sponsored_policy(p_ctx jsonb, p_hub uuid, p_allowed boolean, p_max integer, p_verified boolean, p_approval uuid) RETURNS trustwork.sponsored_content_policy
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.sources_staff(p_ctx, ARRAY['admin.sponsored.policy.edit'], p_hub);
  v_version integer;
  v_row trustwork.sponsored_content_policy%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('trustwork.sponsored_policy:' || p_hub::text, 0));
  v_version := coalesce((SELECT max(version) FROM trustwork.sponsored_content_policy WHERE hub_id = p_hub), 0) + 1;
  IF p_allowed THEN
    IF p_approval IS NULL THEN
      RAISE EXCEPTION 'switching sponsored content on needs a second person' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_required';
    END IF;
    PERFORM trustwork.admin_consume_approval(p_approval, 'sponsored.enable', 'hub', NULL, p_hub, trustwork.sources_sponsored_digest(p_hub, v_version, true, p_max, p_verified), p_hub);
  ELSIF p_approval IS NOT NULL THEN
    RAISE EXCEPTION 'switching sponsored content off needs no approval' USING ERRCODE = 'invalid_parameter_value', HINT = 'sources.invalid_policy';
  END IF;
  INSERT INTO trustwork.sponsored_content_policy (hub_id, version, allowed, max_slots_per_page, require_verified_sponsor, set_by, approval_id)
  VALUES (p_hub, v_version, p_allowed, p_max, p_verified, v_actor.person_id, p_approval) RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'sponsored_policy.set', 'sponsored_content_policy', v_row.id, NULL, to_jsonb(v_row), NULL, p_approval);
  RETURN v_row;
END $$;

-- 10. Readers -----------------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.sources_reader_permissions() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['admin.sources.read', 'admin.sources.manage', 'admin.sources.takedown', 'admin.sources.import.activate', 'admin.sources.dedupe.decide', 'admin.links.decide',
    'admin.publications.review', 'admin.sponsored.policy.edit']::text[]
$$;
-- Row-level security: staff holding a registry permission at the hub.
CREATE FUNCTION trustwork.sources_staff_reader(p_hub uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND p_hub IS NOT NULL
    AND trustwork.admin_has_any_permission(trustwork.sources_reader_permissions(), NULL, p_hub)
$$;
-- The effective uses of an item for its readers (staff of the hub).
CREATE FUNCTION trustwork.sources_item_effective_uses(p_item uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_item trustwork.source_item%ROWTYPE;
BEGIN
  SELECT * INTO v_item FROM trustwork.source_item WHERE id = p_item;
  IF NOT FOUND OR NOT trustwork.sources_staff_reader(v_item.hub_id) THEN
    RAISE EXCEPTION 'no such item' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  RETURN trustwork.sources_effective_uses(v_item);
END $$;
-- Public provenance of a sourced record: active fields of activated batches whose source allows display, labelled
-- "from sources" (the label stays until the company claims the record, CLM-001). Identical for every caller.
CREATE FUNCTION trustwork.sources_public_provenance(p_hub uuid, p_kind text, p_record uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT jsonb_build_object('recordKind', p_kind, 'recordId', p_record, 'label', 'sourced', 'fields', coalesce(jsonb_agg(jsonb_build_object(
      'field', f.field, 'value', f.value, 'observedAt', to_char(f.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'source', jsonb_build_object('name', s.name, 'attribution', s.attribution_template, 'url', s.url)) ORDER BY f.field, f.observed_at, f.id), '[]'::jsonb))
  FROM trustwork.sourced_record_field f
  JOIN trustwork.import_batch b ON b.id = f.import_batch_id AND b.status = 'activated'
  JOIN trustwork.source s ON s.id = f.source_id AND s.status IN ('active', 'paused', 'retired') AND trustwork.sources_use(s.allowed_uses, 'displayHeadlineAndLink')
  JOIN trustwork.hub h ON h.id = f.hub_id AND h.lifecycle IN ('soft_launch', 'public')
  WHERE f.hub_id = p_hub AND f.record_kind = p_kind AND f.record_id = p_record AND f.active
$$;
-- The labelled sponsored slot: sponsored items a person drafted from active sources, only while the hub's policy allows
-- sponsored content, at most its slot count. Never part of any ranked list.
CREATE FUNCTION trustwork.sources_sponsored_slot(p_hub uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  WITH policy AS (SELECT * FROM trustwork.sources_sponsored_current(p_hub) p WHERE p.id IS NOT NULL AND p.allowed)
  SELECT jsonb_build_object('label', 'sponsored', 'items', coalesce((SELECT jsonb_agg(x.item ORDER BY x.observed_at DESC, x.id) FROM (
      SELECT jsonb_build_object('itemId', i.id, 'title', i.title, 'url', i.url, 'sponsorName', i.sponsor_name, 'sourceName', s.name) AS item, i.observed_at, i.id
      FROM trustwork.source_item i JOIN trustwork.source s ON s.id = i.source_id AND s.status = 'active'
      JOIN trustwork.hub h ON h.id = i.hub_id AND h.lifecycle IN ('soft_launch', 'public')
      WHERE i.hub_id = p_hub AND i.sponsored AND i.status = 'drafted' AND EXISTS (SELECT 1 FROM policy)
      ORDER BY i.observed_at DESC, i.id LIMIT (SELECT coalesce(max(max_slots_per_page), 0) FROM policy)) x), '[]'::jsonb))
$$;
-- Worker input for ranking, matching and plan recommendations (REC-001): items a person drafted from active sources,
-- never sponsored, newest first by observation time. Sponsored items are excluded by construction.
CREATE FUNCTION trustwork.sources_recommendable_items(p_hub uuid, p_limit integer) RETURNS TABLE (item_id uuid, source_id uuid, title text, url text, observed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT i.id, i.source_id, i.title, i.url, i.observed_at
  FROM trustwork.source_item i JOIN trustwork.source s ON s.id = i.source_id AND s.status = 'active'
  WHERE i.hub_id = p_hub AND i.status = 'drafted' AND NOT i.sponsored
  ORDER BY i.observed_at DESC, i.id
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 500)
$$;
-- Worker export for federation: items whose effective uses allow syndication (a display-only source never appears).
CREATE FUNCTION trustwork.sources_peer_export(p_hub uuid, p_limit integer) RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT jsonb_build_object('itemId', i.id, 'url', i.url, 'title', i.title, 'summary', i.summary, 'sourceName', s.name, 'attribution', s.attribution_template,
    'observedAt', to_char(i.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM trustwork.source_item i JOIN trustwork.source s ON s.id = i.source_id AND s.status = 'active'
  WHERE i.hub_id = p_hub AND i.status = 'drafted' AND NOT i.sponsored
    AND trustwork.sources_use(trustwork.sources_effective_uses(i), 'syndicateToPeers')
  ORDER BY i.observed_at DESC, i.id
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 500)
$$;

-- 11. Row-level security and grants -------------------------------------------------------------------------------------
ALTER TABLE trustwork.source ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.source FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.crawl_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.crawl_policy FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.sponsored_content_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.sponsored_content_policy FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.import_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.import_batch FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.source_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.source_item FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.sourced_record_field ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.sourced_record_field FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.record_link_proposal ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.record_link_proposal FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.source_takedown ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.source_takedown FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.source_tombstone ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.source_tombstone FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.source AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.crawl_policy AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.sponsored_content_policy AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.import_batch AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.source_item AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.sourced_record_field AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.record_link_proposal AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.source_takedown AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.source_tombstone AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

-- Everything in the registry is staff-only (SC); the public sees only sources_public_provenance and the sponsored slot.
CREATE POLICY source_read ON trustwork.source FOR SELECT TO trustwork_app USING (trustwork.sources_staff_reader(hub_id));
CREATE POLICY crawl_policy_read ON trustwork.crawl_policy FOR SELECT TO trustwork_app USING (trustwork.sources_staff_reader(hub_id));
CREATE POLICY sponsored_content_policy_read ON trustwork.sponsored_content_policy FOR SELECT TO trustwork_app USING (trustwork.sources_staff_reader(hub_id));
CREATE POLICY import_batch_read ON trustwork.import_batch FOR SELECT TO trustwork_app USING (trustwork.sources_staff_reader(hub_id));
CREATE POLICY source_item_read ON trustwork.source_item FOR SELECT TO trustwork_app USING (trustwork.sources_staff_reader(hub_id));
CREATE POLICY sourced_record_field_read ON trustwork.sourced_record_field FOR SELECT TO trustwork_app USING (trustwork.sources_staff_reader(hub_id));
CREATE POLICY record_link_proposal_read ON trustwork.record_link_proposal FOR SELECT TO trustwork_app USING (trustwork.sources_staff_reader(hub_id));
CREATE POLICY source_takedown_read ON trustwork.source_takedown FOR SELECT TO trustwork_app USING (trustwork.sources_staff_reader(hub_id));
CREATE POLICY source_tombstone_read ON trustwork.source_tombstone FOR SELECT TO trustwork_app USING (trustwork.sources_staff_reader(hub_id));

GRANT SELECT ON trustwork.source, trustwork.crawl_policy, trustwork.sponsored_content_policy, trustwork.import_batch, trustwork.source_item, trustwork.sourced_record_field,
  trustwork.record_link_proposal, trustwork.source_takedown, trustwork.source_tombstone TO trustwork_app;
GRANT EXECUTE ON FUNCTION
  trustwork.sources_register(jsonb, uuid, jsonb), trustwork.sources_set_terms(jsonb, uuid, integer, jsonb),
  trustwork.sources_record_terms(jsonb, uuid, integer, text, text, text, text), trustwork.sources_record_robots(jsonb, uuid, jsonb),
  trustwork.sources_record_rsl(jsonb, uuid, integer, text, text, jsonb, jsonb), trustwork.sources_set_status(jsonb, uuid, integer, text),
  trustwork.sources_takedown(jsonb, uuid, uuid, text, text), trustwork.sources_stage_batch(jsonb, uuid, jsonb, jsonb, jsonb),
  trustwork.sources_decide_batch(jsonb, uuid, integer, text), trustwork.sources_item_egress(uuid, text), trustwork.sources_record_assist(jsonb, uuid, integer, text, text),
  trustwork.sources_decide_item(jsonb, uuid, integer, text, uuid), trustwork.sources_propose_link(jsonb, uuid, text, uuid, uuid, text, text),
  trustwork.sources_decide_link(jsonb, uuid, integer, text), trustwork.sources_set_sponsored_policy(jsonb, uuid, boolean, integer, boolean, uuid),
  trustwork.sources_staff_reader(uuid), trustwork.sources_item_effective_uses(uuid), trustwork.sources_public_provenance(uuid, text, uuid), trustwork.sources_sponsored_slot(uuid),
  -- Invoker helpers: vocabularies, the licence rules and the digest a console shows a second person (pure functions).
  trustwork.sources_kinds(), trustwork.sources_crawling_kinds(), trustwork.sources_use_keys(), trustwork.sources_no_licence_forbidden(), trustwork.sources_most_restrictive(),
  trustwork.sources_uses_ok(jsonb), trustwork.sources_use(jsonb, text), trustwork.sources_uses_and(jsonb, jsonb), trustwork.sources_uses_above(jsonb, jsonb),
  trustwork.sources_uses_problems(text, uuid, jsonb, jsonb), trustwork.sources_distinct(text[]), trustwork.sources_reader_permissions(),
  trustwork.sources_sponsored_digest(uuid, integer, boolean, integer, boolean)
TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.sources_recommendable_items(uuid, integer), trustwork.sources_peer_export(uuid, integer) TO trustwork_worker;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
