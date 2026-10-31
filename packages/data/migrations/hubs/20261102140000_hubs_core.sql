-- HUB-001 hubs core (slice C2 `hubs_core` of docs/data/migration-plan.md; docs/engine/hubs.md, docs/engine/hub-administration.md,
-- docs/engine/hub-console/data-model.md; ADR 010 decisions 16 and 21, ADR 012 decisions 26 to 31, ADR 014 decision 2).
--
-- Extends the DATA-003 hub anchor (trustwork.hub, trustwork.hub_territory) without editing it: a profile per hub (node,
-- name, languages, time zone, currency, brand), immutable configuration versions per domain with a current pointer,
-- the launch gates and the lifecycle guard, legal document versions with counsel approvals and acceptances, provider
-- credential references (never secret values) and the retention policy derived from the privacy domain.
--
-- Authority model (DATA-002, packages/data/migrations/admin): every mutation is a SECURITY DEFINER command that resolves
-- the caller's permission at the hub (a hub assignment covers that hub only, a node or platform assignment every hub),
-- requires a live elevation of the caller, and writes an admin_audit_event in the same transaction. Sensitive
-- configuration domains, legal document activation, non-fake provider credentials and the transitions to soft_launch
-- and public consume a second-person approval (admin_consume_approval) bound to the exact digest of what is executed;
-- the requester executes, the approver is always another person. Sensitive configuration versions are additionally
-- activated by someone other than their drafter.
--
-- Guard rails enforced for every writer, the owner and maintenance sessions included:
-- * a hub moves to soft_launch or public only with every required launch gate passed and its precondition still true,
--   and only with a second-person approval of that transition consumed in the same transaction;
-- * a restricted place (the synced kernel list, or a place the hub itself added through its jurisdiction domain) is
--   never a territory and never appears in a configuration payload; hub-added places are add only;
-- * a configuration payload never names a key that would widen data access or set a ranking (no hub setting widens
--   data access: no policy or access function of the engine reads this module's tables);
-- * a payload that states a location contradicting the current deployment-location attestation (SANC-009) is refused;
-- * versions, approvals, acceptances and counsel records are immutable; configuration only changes by a new version.

-- 0. Vocabularies (immutable functions, tested against packages/contracts/src/hub.ts and hub-core.ts) ---------------
CREATE FUNCTION trustwork.hubs_config_domains() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['identity', 'modes', 'legal', 'residency', 'country', 'sources', 'verification', 'screening', 'editorial', 'events', 'learning', 'matching',
    'commerce', 'tax', 'payments', 'agents', 'agent_extensions', 'jurisdiction', 'communications', 'privacy', 'federation', 'providers', 'routing',
    'egress', 'budgets']::text[]
$$;
-- SENSITIVE_CONFIG_DOMAINS: activation always needs a second person.
CREATE FUNCTION trustwork.hubs_sensitive_domains() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['legal', 'residency', 'providers', 'egress', 'federation', 'agents', 'agent_extensions', 'jurisdiction', 'payments', 'privacy']::text[]
$$;
-- CONFIG_DOMAIN_SECOND_PERSON_ACTIONS: the console vocabulary action each sensitive domain's activation consumes.
CREATE FUNCTION trustwork.hubs_domain_action(p_domain text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_domain
    WHEN 'legal' THEN 'legal.activate_document_version'
    WHEN 'residency' THEN 'hub.change_residency'
    WHEN 'providers' THEN 'providers.enable_non_fake'
    WHEN 'egress' THEN 'egress.allow_private_class'
    WHEN 'federation' THEN 'federation.raise_peering_level'
    WHEN 'agents' THEN 'agents.enable_commitment_module'
    WHEN 'agent_extensions' THEN 'agents.activate_extension'
    WHEN 'jurisdiction' THEN 'jurisdiction.activate_settings'
    WHEN 'payments' THEN 'payments.change_settings'
    WHEN 'privacy' THEN 'privacy.execute_erasure'
    END
$$;
-- CONFIG_DOMAIN_PERMISSIONS: who drafts a version of a domain (and activates a non-sensitive one). admin.config.edit is
-- the general configuration permission and works for every domain.
CREATE FUNCTION trustwork.hubs_domain_permissions(p_domain text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY[CASE p_domain
    WHEN 'identity' THEN 'admin.hub.identity.edit'
    WHEN 'modes' THEN 'admin.hub.modes.edit'
    WHEN 'legal' THEN 'admin.hub.legal.edit'
    WHEN 'residency' THEN 'admin.hub.residency.edit'
    WHEN 'country' THEN 'admin.hub.country.edit'
    WHEN 'sources' THEN 'admin.sources.manage'
    WHEN 'verification' THEN 'admin.claims.policy.edit'
    WHEN 'screening' THEN 'admin.hub.jurisdiction.edit'
    WHEN 'editorial' THEN 'admin.editorial.calendar.edit'
    WHEN 'events' THEN 'admin.events.policy.edit'
    WHEN 'learning' THEN 'admin.learning.review'
    WHEN 'matching' THEN 'admin.matching.policy.edit'
    WHEN 'commerce' THEN 'admin.commerce.offer.edit'
    WHEN 'tax' THEN 'admin.currency.edit'
    WHEN 'payments' THEN 'admin.hub.payments.edit'
    WHEN 'agents' THEN 'admin.agents.policy.edit'
    WHEN 'agent_extensions' THEN 'admin.agents.extensions.edit'
    WHEN 'jurisdiction' THEN 'admin.hub.jurisdiction.edit'
    WHEN 'communications' THEN 'admin.notifications.template.edit'
    WHEN 'privacy' THEN 'admin.privacy.retention.edit'
    WHEN 'federation' THEN 'admin.federation.peer.edit'
    WHEN 'providers' THEN 'admin.providers.connection.edit'
    WHEN 'routing' THEN 'admin.models.route.edit'
    WHEN 'egress' THEN 'admin.providers.egress.edit'
    WHEN 'budgets' THEN 'admin.providers.budget.edit'
    END, 'admin.config.edit']::text[]
$$;
CREATE FUNCTION trustwork.hubs_launch_gates() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['operator_recorded_and_screened', 'legal_documents_counsel_approved', 'data_residency_configured', 'two_staff_with_second_factor',
    'editorial_team_and_policy', 'community_rules_all_languages', 'information_source_registered', 'verification_recipe_enabled',
    'sanctions_screening_configured', 'i18n_complete', 'backup_restore_exercised', 'brand_accessibility_checked',
    'demo_data_purged', 'ai_egress_policy_reviewed']::text[]
$$;
-- SOFT_LAUNCH_GATES: required before invited participants arrive; public requires every gate.
CREATE FUNCTION trustwork.hubs_required_gates(p_target text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT CASE p_target
    WHEN 'public' THEN trustwork.hubs_launch_gates()
    WHEN 'soft_launch' THEN ARRAY['operator_recorded_and_screened', 'legal_documents_counsel_approved', 'data_residency_configured', 'two_staff_with_second_factor',
      'demo_data_purged', 'ai_egress_policy_reviewed']::text[]
    ELSE ARRAY[]::text[] END
$$;
-- The gates a newly activated version of a domain re-opens (a passed gate becomes `invalidated` until checked again).
CREATE FUNCTION trustwork.hubs_domain_gates(p_domain text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_domain
    WHEN 'legal' THEN ARRAY['operator_recorded_and_screened']
    WHEN 'residency' THEN ARRAY['data_residency_configured']
    WHEN 'screening' THEN ARRAY['sanctions_screening_configured']
    WHEN 'sources' THEN ARRAY['information_source_registered']
    WHEN 'verification' THEN ARRAY['verification_recipe_enabled']
    WHEN 'editorial' THEN ARRAY['editorial_team_and_policy']
    WHEN 'egress' THEN ARRAY['ai_egress_policy_reviewed']
    ELSE ARRAY[]::text[] END
$$;
-- HUB_LIFECYCLE transitions (hubTransitionAllowed in packages/contracts/src/hub.ts).
CREATE FUNCTION trustwork.hubs_transition_allowed(p_from text, p_to text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_from
    WHEN 'draft' THEN p_to IN ('preparing', 'closed')
    WHEN 'preparing' THEN p_to IN ('draft', 'soft_launch', 'closed')
    WHEN 'soft_launch' THEN p_to IN ('preparing', 'public', 'suspended', 'closing')
    WHEN 'public' THEN p_to IN ('suspended', 'closing')
    WHEN 'suspended' THEN p_to IN ('soft_launch', 'public', 'closing')
    WHEN 'closing' THEN p_to = 'closed'
    ELSE false END
$$;
CREATE FUNCTION trustwork.hubs_legal_kinds() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['terms', 'privacy_notice', 'sanctions_section', 'cookie_notice', 'community_rules', 'organizer_terms', 'author_terms', 'notice_at_collection',
    'do_not_sell_notice']::text[]
$$;
CREATE FUNCTION trustwork.hubs_retention_classes() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['ephemeral', 'session', 'operational', 'account', 'published', 'commercial', 'accounting', 'evidence', 'verification', 'consent_proof', 'case',
    'audit_long', 'audit_standard', 'conversation', 'derived', 'tombstone', 'config']::text[]
$$;
-- Every permission that lets a person read a hub's configuration records (the console's hub screens).
CREATE FUNCTION trustwork.hubs_reader_permissions() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT ARRAY(SELECT DISTINCT p FROM unnest(ARRAY['admin.hub.read', 'admin.hub.launch.check', 'admin.hub.lifecycle.request', 'admin.hub.legal.activate',
    'admin.providers.secret.write', 'admin.providers.toggle', 'admin.audit.read', 'admin.node.hubs.manage']
    || (SELECT array_agg(x) FROM unnest(trustwork.hubs_config_domains()) d CROSS JOIN LATERAL unnest(trustwork.hubs_domain_permissions(d)) x)) p ORDER BY p)
$$;

-- Grammars shared with the contracts.
CREATE FUNCTION trustwork.hubs_locale_ok(p_tag text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_tag IS NOT NULL AND p_tag ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$'
$$;
CREATE FUNCTION trustwork.hubs_place_code_ok(p_code text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_code IS NOT NULL AND p_code ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?(:[a-z0-9][a-z0-9-]{0,62})?$'
$$;
-- A localized name: an object whose values are 1..200 characters, with a value for every hub locale.
CREATE FUNCTION trustwork.hubs_name_ok(p_name jsonb, p_locales text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_typeof(p_name) = 'object' AND p_name <> '{}'::jsonb
    AND NOT EXISTS (SELECT 1 FROM jsonb_each(p_name) e WHERE NOT trustwork.hubs_locale_ok(e.key) OR jsonb_typeof(e.value) <> 'string'
      OR length(e.value #>> '{}') NOT BETWEEN 1 AND 200)
    AND NOT EXISTS (SELECT 1 FROM unnest(p_locales) l WHERE NOT (p_name ? l))
$$;
-- ISO 8601 durations the retention policy accepts (P7Y, P90D, P1Y6M); PostgreSQL reads them as intervals.
CREATE FUNCTION trustwork.hubs_duration_ok(p_value text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_value IS NOT NULL AND p_value ~ '^P(?=[0-9])([0-9]{1,4}Y)?([0-9]{1,4}M)?([0-9]{1,5}D)?$'
$$;

-- 1. Hub profile ------------------------------------------------------------------------------------------------------
-- One row per hub created through hubs_create: the node it lives on and the HubSchema fields the anchor does not carry.
CREATE TABLE trustwork.hub_profile (
  hub_id uuid PRIMARY KEY REFERENCES trustwork.hub (id),
  node_id uuid NOT NULL REFERENCES trustwork.admin_node (id),
  name jsonb NOT NULL,
  default_locale text NOT NULL CHECK (trustwork.hubs_locale_ok(default_locale)),
  locales text[] NOT NULL CHECK (cardinality(locales) BETWEEN 1 AND 12 AND trustwork.admin_distinct(locales)
    AND trustwork.admin_all_match(locales, '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$')),
  time_zone text NOT NULL CHECK (time_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$'),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  brand_overlay text NULL CHECK (brand_overlay ~ '^[a-z0-9][a-z0-9-]{0,40}$'),
  created_by uuid NOT NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hub_profile_default_locale CHECK (default_locale = ANY (locales)),
  CONSTRAINT hub_profile_name CHECK (trustwork.hubs_name_ok(name, locales))
);
CREATE TRIGGER hub_profile_touch BEFORE UPDATE ON trustwork.hub_profile FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
CREATE FUNCTION trustwork.hubs_profile_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'hub profiles are never deleted; close the hub' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.hub_id <> OLD.hub_id OR NEW.node_id <> OLD.node_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at) THEN
    RAISE EXCEPTION 'a hub keeps its node and creator' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.time_zone) THEN
    RAISE EXCEPTION 'unknown time zone %', NEW.time_zone USING ERRCODE = 'check_violation', HINT = 'hubs.time_zone_unknown';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hub_profile_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.hub_profile FOR EACH ROW EXECUTE FUNCTION trustwork.hubs_profile_guard();

-- 2. Configuration versions and the current pointer -------------------------------------------------------------------
-- draft -> active | cancelled; active -> superseded. Never edited, never deleted. One active version per (hub, domain).
CREATE TABLE trustwork.hub_config_version (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  domain text NOT NULL CHECK (domain = ANY (trustwork.hubs_config_domains())),
  version integer NOT NULL CHECK (version >= 1),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 65536),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'superseded', 'cancelled')),
  source text NOT NULL DEFAULT 'console' CHECK (source IN ('console', 'deployment_import')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  drafted_by uuid NOT NULL REFERENCES trustwork.person (id),
  drafted_at timestamptz NOT NULL DEFAULT now(),
  activated_by uuid NULL REFERENCES trustwork.person (id),
  activated_at timestamptz NULL,
  effective_from timestamptz NULL,
  approval_id uuid NULL UNIQUE REFERENCES trustwork.second_person_approval (id),
  superseded_at timestamptz NULL,
  cancelled_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hub_config_version_number UNIQUE (hub_id, domain, version),
  CONSTRAINT hub_config_version_activation_shape CHECK ((status IN ('active', 'superseded')) = (activated_by IS NOT NULL)
    AND (activated_by IS NULL) = (activated_at IS NULL) AND (activated_at IS NULL) = (effective_from IS NULL)),
  CONSTRAINT hub_config_version_no_backdating CHECK (effective_from IS NULL OR effective_from >= activated_at),
  CONSTRAINT hub_config_version_sensitive CHECK (NOT (domain = ANY (trustwork.hubs_sensitive_domains())) OR activated_by IS NULL
    OR (approval_id IS NOT NULL AND activated_by <> drafted_by)),
  CONSTRAINT hub_config_version_end_shape CHECK ((status = 'superseded') = (superseded_at IS NOT NULL) AND (status = 'cancelled') = (cancelled_at IS NOT NULL))
);
CREATE UNIQUE INDEX hub_config_version_one_active ON trustwork.hub_config_version (hub_id, domain) WHERE status = 'active';
CREATE INDEX hub_config_version_hub_idx ON trustwork.hub_config_version (hub_id, domain, version DESC);
CREATE TRIGGER hub_config_version_touch BEFORE UPDATE ON trustwork.hub_config_version FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- The digest a second person approves for a configuration activation (configActivationDigest in hub-core.ts).
CREATE FUNCTION trustwork.hubs_config_digest(p_id uuid, p_hub uuid, p_domain text, p_version integer, p_payload_digest text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.admin_digest(jsonb_build_object('action', trustwork.hubs_domain_action(p_domain), 'object', 'hub_config_version', 'hubId', p_hub::text,
    'domain', p_domain, 'versionId', p_id::text, 'version', p_version, 'payloadDigest', p_payload_digest))
$$;

CREATE FUNCTION trustwork.hubs_config_version_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_approval trustwork.second_person_approval%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'configuration versions are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.activated_by IS NOT NULL OR NEW.approval_id IS NOT NULL THEN
      RAISE EXCEPTION 'a configuration version is born a draft' USING ERRCODE = 'check_violation', HINT = 'hubs.invalid_transition';
    END IF;
    -- The database computes the digest of what it stores; a caller cannot bind another payload.
    NEW.payload_digest := trustwork.admin_digest(NEW.payload);
    NEW.drafted_at := now();
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.hub_id <> OLD.hub_id OR NEW.domain <> OLD.domain OR NEW.version <> OLD.version OR NEW.payload <> OLD.payload
     OR NEW.payload_digest <> OLD.payload_digest OR NEW.source <> OLD.source OR NEW.reason <> OLD.reason OR NEW.drafted_by <> OLD.drafted_by
     OR NEW.drafted_at <> OLD.drafted_at THEN
    RAISE EXCEPTION 'a configuration version is immutable; draft a new one' USING ERRCODE = 'integrity_constraint_violation', HINT = 'hubs.version_immutable';
  END IF;
  IF NEW.status = OLD.status THEN
    IF ROW(NEW.activated_by, NEW.activated_at, NEW.effective_from, NEW.approval_id, NEW.superseded_at, NEW.cancelled_at)
       IS DISTINCT FROM ROW(OLD.activated_by, OLD.activated_at, OLD.effective_from, OLD.approval_id, OLD.superseded_at, OLD.cancelled_at) THEN
      RAISE EXCEPTION 'decision columns change only with the status' USING ERRCODE = 'integrity_constraint_violation', HINT = 'hubs.version_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status = 'draft' AND NEW.status IN ('active', 'cancelled')) OR (OLD.status = 'active' AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'configuration version % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'hubs.invalid_transition';
  END IF;
  IF NEW.status = 'active' THEN
    NEW.activated_at := now();
    NEW.effective_from := greatest(coalesce(NEW.effective_from, now()), now());
    IF NEW.domain = ANY (trustwork.hubs_sensitive_domains()) THEN
      -- Every writer: the approval was consumed for exactly this version, of this hub, by its activator, approved by
      -- someone else, for the domain's action and the digest of this version.
      SELECT * INTO v_approval FROM trustwork.second_person_approval WHERE id = NEW.approval_id;
      IF NOT FOUND OR v_approval.status <> 'consumed' OR v_approval.consumed_ref IS DISTINCT FROM NEW.id OR v_approval.scope_kind <> 'hub'
         OR v_approval.hub_id IS DISTINCT FROM NEW.hub_id OR v_approval.requested_by IS DISTINCT FROM NEW.activated_by OR v_approval.approved_by = NEW.activated_by
         OR v_approval.action IS DISTINCT FROM trustwork.hubs_domain_action(NEW.domain)
         OR v_approval.action_digest IS DISTINCT FROM trustwork.hubs_config_digest(NEW.id, NEW.hub_id, NEW.domain, NEW.version, NEW.payload_digest) THEN
        RAISE EXCEPTION 'a sensitive domain is activated only under a consumed second-person approval of this version' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_required';
      END IF;
    END IF;
  ELSIF NEW.status = 'superseded' THEN
    NEW.superseded_at := now();
  ELSE
    NEW.cancelled_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hub_config_version_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.hub_config_version FOR EACH ROW EXECUTE FUNCTION trustwork.hubs_config_version_guard();

-- The current pointer: the active version of each (hub, domain). Moved only together with the activation.
CREATE TABLE trustwork.hub_config_current (
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  domain text NOT NULL CHECK (domain = ANY (trustwork.hubs_config_domains())),
  version_id uuid NOT NULL UNIQUE REFERENCES trustwork.hub_config_version (id),
  version integer NOT NULL CHECK (version >= 1),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hub_id, domain)
);
CREATE TRIGGER hub_config_current_touch BEFORE UPDATE ON trustwork.hub_config_current FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
CREATE FUNCTION trustwork.hubs_config_current_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'the current pointer only moves forward' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.hub_id <> OLD.hub_id OR NEW.domain <> OLD.domain OR NEW.version <= OLD.version) THEN
    RAISE EXCEPTION 'the current pointer only moves forward' USING ERRCODE = 'integrity_constraint_violation', HINT = 'hubs.config_stale';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trustwork.hub_config_version v WHERE v.id = NEW.version_id AND v.hub_id = NEW.hub_id AND v.domain = NEW.domain
                 AND v.version = NEW.version AND v.status = 'active') THEN
    RAISE EXCEPTION 'the current pointer names the active version of its hub and domain' USING ERRCODE = 'check_violation', HINT = 'hubs.invalid_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hub_config_current_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.hub_config_current FOR EACH ROW EXECUTE FUNCTION trustwork.hubs_config_current_guard();

-- The active payload of a domain, or NULL.
CREATE FUNCTION trustwork.hubs_active_payload(p_hub uuid, p_domain text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT v.payload FROM trustwork.hub_config_current c JOIN trustwork.hub_config_version v ON v.id = c.version_id WHERE c.hub_id = p_hub AND c.domain = p_domain
$$;

-- 3. Restricted places: the kernel list plus the places a hub added (add only) ----------------------------------------
-- The places a jurisdiction payload adds: `addedRestrictedPlaces: [{ code, legalBasis: { citation, url? } }]`.
CREATE FUNCTION trustwork.hubs_payload_added_places(p_payload jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(array_agg(DISTINCT e.value ->> 'code' ORDER BY e.value ->> 'code'), ARRAY[]::text[])
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_payload -> 'addedRestrictedPlaces') = 'array' THEN p_payload -> 'addedRestrictedPlaces' ELSE '[]'::jsonb END) e
  WHERE e.value ->> 'code' IS NOT NULL
$$;
CREATE FUNCTION trustwork.hubs_added_places(p_hub uuid) RETURNS text[]
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.hubs_payload_added_places(coalesce(trustwork.hubs_active_payload(p_hub, 'jurisdiction'), '{}'::jsonb))
$$;
-- Restricted for this hub: restricted by the engine (fail closed while the list is not synced), or inside a place the
-- hub's active jurisdiction configuration (or the extra list given, for a version being checked) added.
CREATE FUNCTION trustwork.hubs_place_restricted(p_hub uuid, p_code text, p_extra text[] DEFAULT ARRAY[]::text[]) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.kernel_place_restricted(p_code)
    OR EXISTS (SELECT 1 FROM unnest(trustwork.hubs_added_places(p_hub) || coalesce(p_extra, ARRAY[]::text[])) a
               WHERE a IN (upper(left(p_code, 2)), split_part(p_code, ':', 1), p_code))
$$;
-- Every string value and object key of a payload shaped like a place code (ISO 3166-1, ISO 3166-2 or a place key),
-- outside the `addedRestrictedPlaces` list (which names restricted places on purpose).
CREATE FUNCTION trustwork.hubs_payload_codes(p_payload jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  WITH RECURSIVE walk(v) AS (
    SELECT p_payload
    UNION ALL
    SELECT c.v FROM walk w CROSS JOIN LATERAL (
      SELECT e.value AS v FROM jsonb_each(CASE WHEN jsonb_typeof(w.v) = 'object' THEN w.v ELSE '{}'::jsonb END) e WHERE e.key <> 'addedRestrictedPlaces'
      UNION ALL
      SELECT to_jsonb(e.key) FROM jsonb_each(CASE WHEN jsonb_typeof(w.v) = 'object' THEN w.v ELSE '{}'::jsonb END) e WHERE e.key <> 'addedRestrictedPlaces'
      UNION ALL
      SELECT a.value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.v) = 'array' THEN w.v ELSE '[]'::jsonb END) a
    ) c
  )
  SELECT coalesce(array_agg(DISTINCT w.v #>> '{}' ORDER BY w.v #>> '{}'), ARRAY[]::text[])
  FROM walk w WHERE jsonb_typeof(w.v) = 'string' AND trustwork.hubs_place_code_ok(w.v #>> '{}')
$$;
-- Every object key of a payload (at any depth) that would widen data access or set a ranking. No hub setting can read
-- private data, grant a role, bypass a policy, or change a score, a rank, a position, a badge or a weight.
CREATE FUNCTION trustwork.hubs_payload_forbidden_keys(p_payload jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  WITH RECURSIVE walk(v, k) AS (
    SELECT p_payload, NULL::text
    UNION ALL
    SELECT c.v, c.k FROM walk w CROSS JOIN LATERAL (
      SELECT e.value AS v, e.key AS k FROM jsonb_each(CASE WHEN jsonb_typeof(w.v) = 'object' THEN w.v ELSE '{}'::jsonb END) e
      UNION ALL
      SELECT a.value, NULL::text FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.v) = 'array' THEN w.v ELSE '[]'::jsonb END) a
    ) c
  )
  SELECT coalesce(array_agg(DISTINCT w.k ORDER BY w.k), ARRAY[]::text[]) FROM walk w
  WHERE w.k ~* '(score|(?<!re)rank|position|badge|weight|boost|promot|priorit|bypass|impersonat|permission|grant|role|visib|audience|case_?access|share_?with|expose|unrestrict|superuser|row_?level|(^|_)rls|private_?(read|access|data_?access)|read_?private|staff_?(read|access)|access_?(widen|level|override))'
$$;

-- The checks every configuration payload passes when it is drafted and again when it is activated. Raises the first
-- refusal with a hint and the refused items in DETAIL (comma separated).
CREATE FUNCTION trustwork.hubs_check_payload(p_hub uuid, p_domain text, p_payload jsonb) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_items text[];
  v_new_added text[] := ARRAY[]::text[];
  v_current jsonb;
  v_att record;
  v_entry jsonb;
  v_classes text[] := ARRAY[]::text[];
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'a configuration payload is an object' USING ERRCODE = 'invalid_parameter_value', HINT = 'hubs.payload_invalid';
  END IF;
  v_items := trustwork.hubs_payload_forbidden_keys(p_payload);
  IF cardinality(v_items) > 0 THEN
    RAISE EXCEPTION 'no hub setting widens data access or sets a ranking' USING ERRCODE = 'check_violation', HINT = 'hubs.access_widening', DETAIL = array_to_string(v_items, ',');
  END IF;

  IF p_domain = 'jurisdiction' THEN
    -- Hub-added restricted places: each names a place code and a cited legal basis; the list only grows.
    IF p_payload ? 'addedRestrictedPlaces' AND jsonb_typeof(p_payload -> 'addedRestrictedPlaces') <> 'array' THEN
      RAISE EXCEPTION 'addedRestrictedPlaces is a list' USING ERRCODE = 'check_violation', HINT = 'hubs.added_place_invalid';
    END IF;
    FOR v_entry IN SELECT value FROM jsonb_array_elements(coalesce(p_payload -> 'addedRestrictedPlaces', '[]'::jsonb)) LOOP
      IF jsonb_typeof(v_entry) <> 'object' OR NOT trustwork.hubs_place_code_ok(v_entry ->> 'code') OR jsonb_typeof(v_entry -> 'legalBasis') <> 'object'
         OR length(coalesce(v_entry -> 'legalBasis' ->> 'citation', '')) NOT BETWEEN 3 AND 500 THEN
        RAISE EXCEPTION 'a hub-added restricted place names its code and a cited legal basis' USING ERRCODE = 'check_violation', HINT = 'hubs.added_place_invalid',
          DETAIL = coalesce(v_entry ->> 'code', '?');
      END IF;
    END LOOP;
    v_new_added := trustwork.hubs_payload_added_places(p_payload);
    v_current := trustwork.hubs_active_payload(p_hub, 'jurisdiction');
    SELECT coalesce(array_agg(a ORDER BY a), ARRAY[]::text[]) INTO v_items
      FROM unnest(trustwork.hubs_payload_added_places(coalesce(v_current, '{}'::jsonb))) a WHERE NOT (a = ANY (v_new_added));
    IF cardinality(v_items) > 0 THEN
      RAISE EXCEPTION 'a hub may add restricted places, never remove one' USING ERRCODE = 'check_violation', HINT = 'hubs.restricted_place_removed', DETAIL = array_to_string(v_items, ',');
    END IF;
    SELECT coalesce(array_agg(t.code ORDER BY t.code), ARRAY[]::text[]) INTO v_items
      FROM trustwork.hub_territory t WHERE t.hub_id = p_hub AND trustwork.hubs_place_restricted(p_hub, t.code, v_new_added);
    IF cardinality(v_items) > 0 THEN
      RAISE EXCEPTION 'remove the territories inside a place before restricting it' USING ERRCODE = 'check_violation', HINT = 'hubs.territory_restricted', DETAIL = array_to_string(v_items, ',');
    END IF;
  END IF;

  SELECT coalesce(array_agg(c ORDER BY c), ARRAY[]::text[]) INTO v_items
    FROM unnest(trustwork.hubs_payload_codes(p_payload)) c WHERE trustwork.hubs_place_restricted(p_hub, c, v_new_added);
  IF cardinality(v_items) > 0 THEN
    RAISE EXCEPTION 'a configuration never names a restricted place' USING ERRCODE = 'check_violation', HINT = 'hubs.restricted_place', DETAIL = array_to_string(v_items, ',');
  END IF;

  -- A location stated here must agree with the current deployment-location attestation (SANC-009).
  SELECT a.operator_entity_country, a.operator_entity_region, a.hosting_country, a.hosting_region INTO v_att
    FROM trustwork.deployment_location_attestation a WHERE a.id = trustwork.attestation_head(trustwork.jurisdiction_node());
  IF FOUND THEN
    v_items := ARRAY[]::text[];
    IF p_payload ? 'operatorEntityCountry' AND (p_payload ->> 'operatorEntityCountry') IS DISTINCT FROM v_att.operator_entity_country THEN v_items := v_items || 'operatorEntityCountry'::text; END IF;
    IF p_payload ? 'operatorEntityRegion' AND (p_payload ->> 'operatorEntityRegion') IS DISTINCT FROM v_att.operator_entity_region THEN v_items := v_items || 'operatorEntityRegion'::text; END IF;
    IF p_payload ? 'hostingCountry' AND (p_payload ->> 'hostingCountry') IS DISTINCT FROM v_att.hosting_country THEN v_items := v_items || 'hostingCountry'::text; END IF;
    IF p_payload ? 'hostingRegion' AND (p_payload ->> 'hostingRegion') IS DISTINCT FROM v_att.hosting_region THEN v_items := v_items || 'hostingRegion'::text; END IF;
    IF cardinality(v_items) > 0 THEN
      RAISE EXCEPTION 'the configuration contradicts the deployment-location attestation; attest the new location first' USING ERRCODE = 'check_violation',
        HINT = 'hubs.attestation_contradicted', DETAIL = array_to_string(v_items, ',');
    END IF;
  END IF;

  IF p_domain = 'privacy' THEN
    -- Retention classes: known class, ISO 8601 durations, min <= max, each class once.
    IF p_payload ? 'retention' AND jsonb_typeof(p_payload -> 'retention') <> 'array' THEN
      RAISE EXCEPTION 'retention is a list' USING ERRCODE = 'check_violation', HINT = 'hubs.retention_invalid';
    END IF;
    FOR v_entry IN SELECT value FROM jsonb_array_elements(coalesce(p_payload -> 'retention', '[]'::jsonb)) LOOP
      IF jsonb_typeof(v_entry) <> 'object' OR NOT ((v_entry ->> 'class') = ANY (trustwork.hubs_retention_classes())) OR (v_entry ->> 'class') = ANY (v_classes)
         OR (v_entry ->> 'minPeriod' IS NOT NULL AND NOT trustwork.hubs_duration_ok(v_entry ->> 'minPeriod'))
         OR (v_entry ->> 'maxPeriod' IS NOT NULL AND NOT trustwork.hubs_duration_ok(v_entry ->> 'maxPeriod'))
         OR (v_entry ->> 'minPeriod' IS NOT NULL AND v_entry ->> 'maxPeriod' IS NOT NULL AND (v_entry ->> 'minPeriod')::interval > (v_entry ->> 'maxPeriod')::interval)
         OR (v_entry ->> 'disclosureTextKey' IS NOT NULL AND (v_entry ->> 'disclosureTextKey') !~ '^[a-z][A-Za-z0-9_.-]{1,120}$')
         OR coalesce(jsonb_typeof(v_entry -> 'packFactRef'), 'null') NOT IN ('null', 'object') THEN
        RAISE EXCEPTION 'a retention class is known, once, with ISO 8601 bounds in order' USING ERRCODE = 'check_violation', HINT = 'hubs.retention_invalid',
          DETAIL = coalesce(v_entry ->> 'class', '?');
      END IF;
      v_classes := v_classes || (v_entry ->> 'class');
    END LOOP;
  END IF;
END $$;

-- 4. Launch gates ---------------------------------------------------------------------------------------------------
-- No waiver state: open, passed with evidence, or invalidated by a later change (blocks like open).
CREATE TABLE trustwork.launch_gate (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  gate text NOT NULL CHECK (gate = ANY (trustwork.hubs_launch_gates())),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'passed', 'invalidated')),
  evidence_ref uuid NULL,
  checked_by uuid NULL REFERENCES trustwork.person (id),
  checked_at timestamptz NULL,
  invalidated_at timestamptz NULL,
  invalidation_reason text NULL CHECK (length(invalidation_reason) BETWEEN 1 AND 500),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT launch_gate_unique UNIQUE (hub_id, gate),
  CONSTRAINT launch_gate_passed_shape CHECK (state = 'open' OR (evidence_ref IS NOT NULL AND checked_by IS NOT NULL AND checked_at IS NOT NULL)),
  CONSTRAINT launch_gate_invalidated_shape CHECK ((state = 'invalidated') = (invalidated_at IS NOT NULL AND invalidation_reason IS NOT NULL))
);
CREATE TRIGGER launch_gate_touch BEFORE UPDATE ON trustwork.launch_gate FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
CREATE FUNCTION trustwork.hubs_launch_gate_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'launch gates are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'open' THEN
      RAISE EXCEPTION 'a launch gate is born open' USING ERRCODE = 'check_violation', HINT = 'hubs.invalid_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.hub_id <> OLD.hub_id OR NEW.gate <> OLD.gate THEN
    RAISE EXCEPTION 'a launch gate keeps its hub and gate' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  IF NEW.state = 'open' AND OLD.state <> 'open' THEN
    RAISE EXCEPTION 'a checked gate is invalidated, never reopened without a reason' USING ERRCODE = 'check_violation', HINT = 'hubs.invalid_transition';
  END IF;
  IF NEW.state = 'invalidated' AND OLD.state <> 'passed' THEN
    RAISE EXCEPTION 'only a passed gate is invalidated' USING ERRCODE = 'check_violation', HINT = 'hubs.invalid_transition';
  END IF;
  IF NEW.state = 'passed' AND (OLD.state <> 'passed' OR NEW.evidence_ref IS DISTINCT FROM OLD.evidence_ref) THEN
    NEW.checked_at := now();
  END IF;
  IF NEW.state = 'invalidated' AND OLD.state = 'passed' THEN
    NEW.invalidated_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER launch_gate_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.launch_gate FOR EACH ROW EXECUTE FUNCTION trustwork.hubs_launch_gate_guard();

-- 5. Legal documents, counsel approvals and acceptances ---------------------------------------------------------------
CREATE TABLE trustwork.counsel_approval (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  document_version_ids uuid[] NOT NULL CHECK (cardinality(document_version_ids) BETWEEN 1 AND 100 AND trustwork.admin_distinct(document_version_ids)),
  counsel_name text NOT NULL CHECK (length(counsel_name) BETWEEN 1 AND 200),
  firm text NOT NULL CHECK (length(firm) BETWEEN 1 AND 200),
  approved_on date NOT NULL,
  scope_note text NOT NULL CHECK (length(scope_note) BETWEEN 1 AND 1000),
  recorded_by uuid NOT NULL REFERENCES trustwork.person (id),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX counsel_approval_hub_idx ON trustwork.counsel_approval (hub_id, recorded_at);
CREATE TRIGGER counsel_approval_append_only BEFORE UPDATE OR DELETE ON trustwork.counsel_approval FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

CREATE TABLE trustwork.legal_document_version (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  kind text NOT NULL CHECK (kind = ANY (trustwork.hubs_legal_kinds())),
  locale text NOT NULL CHECK (trustwork.hubs_locale_ok(locale)),
  version integer NOT NULL CHECK (version >= 1),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 200000),
  body_digest text NOT NULL CHECK (body_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'superseded', 'cancelled')),
  counsel_approval_id uuid NULL REFERENCES trustwork.counsel_approval (id),
  drafted_by uuid NOT NULL REFERENCES trustwork.person (id),
  drafted_at timestamptz NOT NULL DEFAULT now(),
  activated_by uuid NULL REFERENCES trustwork.person (id),
  activated_at timestamptz NULL,
  approval_id uuid NULL UNIQUE REFERENCES trustwork.second_person_approval (id),
  superseded_at timestamptz NULL,
  cancelled_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT legal_document_version_number UNIQUE (hub_id, kind, locale, version),
  CONSTRAINT legal_document_version_activation_shape CHECK ((status IN ('active', 'superseded')) = (activated_by IS NOT NULL)
    AND (activated_by IS NULL) = (activated_at IS NULL) AND (activated_by IS NULL OR (approval_id IS NOT NULL AND counsel_approval_id IS NOT NULL))),
  CONSTRAINT legal_document_version_end_shape CHECK ((status = 'superseded') = (superseded_at IS NOT NULL) AND (status = 'cancelled') = (cancelled_at IS NOT NULL))
);
CREATE UNIQUE INDEX legal_document_version_one_active ON trustwork.legal_document_version (hub_id, kind, locale) WHERE status = 'active';
CREATE TRIGGER legal_document_version_touch BEFORE UPDATE ON trustwork.legal_document_version FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- legalActivationDigest in hub-core.ts.
CREATE FUNCTION trustwork.hubs_legal_digest(p_id uuid, p_hub uuid, p_kind text, p_locale text, p_version integer, p_body_digest text, p_counsel uuid) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.admin_digest(jsonb_build_object('action', 'legal.activate_document_version', 'object', 'legal_document_version', 'hubId', p_hub::text,
    'documentVersionId', p_id::text, 'kind', p_kind, 'locale', p_locale, 'version', p_version, 'bodyDigest', p_body_digest, 'counselApprovalId', p_counsel::text))
$$;

CREATE FUNCTION trustwork.hubs_legal_document_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_approval trustwork.second_person_approval%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'legal document versions are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.activated_by IS NOT NULL OR NEW.counsel_approval_id IS NOT NULL THEN
      RAISE EXCEPTION 'a legal document version is born a draft' USING ERRCODE = 'check_violation', HINT = 'hubs.invalid_transition';
    END IF;
    NEW.body_digest := encode(sha256(convert_to(NEW.body, 'UTF8')), 'hex');
    NEW.drafted_at := now();
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.hub_id <> OLD.hub_id OR NEW.kind <> OLD.kind OR NEW.locale <> OLD.locale OR NEW.version <> OLD.version OR NEW.body <> OLD.body
     OR NEW.body_digest <> OLD.body_digest OR NEW.drafted_by <> OLD.drafted_by OR NEW.drafted_at <> OLD.drafted_at THEN
    RAISE EXCEPTION 'a legal document version is immutable; draft a new one' USING ERRCODE = 'integrity_constraint_violation', HINT = 'hubs.version_immutable';
  END IF;
  IF NEW.status = OLD.status THEN
    IF ROW(NEW.counsel_approval_id, NEW.activated_by, NEW.activated_at, NEW.approval_id, NEW.superseded_at, NEW.cancelled_at)
       IS DISTINCT FROM ROW(OLD.counsel_approval_id, OLD.activated_by, OLD.activated_at, OLD.approval_id, OLD.superseded_at, OLD.cancelled_at) THEN
      RAISE EXCEPTION 'decision columns change only with the status' USING ERRCODE = 'integrity_constraint_violation', HINT = 'hubs.version_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status = 'draft' AND NEW.status IN ('active', 'cancelled')) OR (OLD.status = 'active' AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'legal document version % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'hubs.invalid_transition';
  END IF;
  IF NEW.status = 'active' THEN
    NEW.activated_at := now();
    IF NOT EXISTS (SELECT 1 FROM trustwork.counsel_approval c WHERE c.id = NEW.counsel_approval_id AND c.hub_id = NEW.hub_id AND NEW.id = ANY (c.document_version_ids)) THEN
      RAISE EXCEPTION 'a legal document is activated only with a counsel approval of this version' USING ERRCODE = 'check_violation', HINT = 'hubs.counsel_approval_required';
    END IF;
    SELECT * INTO v_approval FROM trustwork.second_person_approval WHERE id = NEW.approval_id;
    IF NOT FOUND OR v_approval.status <> 'consumed' OR v_approval.consumed_ref IS DISTINCT FROM NEW.id OR v_approval.hub_id IS DISTINCT FROM NEW.hub_id
       OR v_approval.requested_by IS DISTINCT FROM NEW.activated_by OR v_approval.approved_by = NEW.activated_by OR v_approval.action <> 'legal.activate_document_version'
       OR v_approval.action_digest IS DISTINCT FROM trustwork.hubs_legal_digest(NEW.id, NEW.hub_id, NEW.kind, NEW.locale, NEW.version, NEW.body_digest, NEW.counsel_approval_id) THEN
      RAISE EXCEPTION 'a legal document is activated only under a consumed second-person approval of this version' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_required';
    END IF;
  ELSIF NEW.status = 'superseded' THEN
    NEW.superseded_at := now();
  ELSE
    NEW.cancelled_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER legal_document_version_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.legal_document_version FOR EACH ROW EXECUTE FUNCTION trustwork.hubs_legal_document_guard();

CREATE FUNCTION trustwork.hubs_counsel_approval_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  NEW.recorded_at := now();
  IF NEW.approved_on > current_date THEN
    RAISE EXCEPTION 'counsel approval cannot be dated in the future' USING ERRCODE = 'check_violation', HINT = 'hubs.counsel_date';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(NEW.document_version_ids) d WHERE NOT EXISTS (
       SELECT 1 FROM trustwork.legal_document_version v WHERE v.id = d AND v.hub_id = NEW.hub_id AND v.status IN ('draft', 'active'))) THEN
    RAISE EXCEPTION 'counsel approves draft or active documents of this hub' USING ERRCODE = 'check_violation', HINT = 'hubs.counsel_documents';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER counsel_approval_guard BEFORE INSERT ON trustwork.counsel_approval FOR EACH ROW EXECUTE FUNCTION trustwork.hubs_counsel_approval_guard();

-- Proof of which exact text a person accepted (consent_proof retention).
CREATE TABLE trustwork.legal_acceptance (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  legal_document_version_id uuid NOT NULL REFERENCES trustwork.legal_document_version (id),
  context text NOT NULL CHECK (context IN ('signup', 'checkout', 'hosting', 'authoring', 'peering')),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT legal_acceptance_once UNIQUE (person_id, legal_document_version_id, context)
);
CREATE TRIGGER legal_acceptance_append_only BEFORE UPDATE OR DELETE ON trustwork.legal_acceptance FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 6. Provider credential references (never secret values) -------------------------------------------------------------
CREATE TABLE trustwork.provider_credential_ref (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,40}$'),
  adapter text NOT NULL CHECK (adapter ~ '^[a-z][a-z0-9_]{1,40}$'),
  mode text NOT NULL CHECK (mode IN ('fake', 'manual', 'live')),
  secret_store text NOT NULL CHECK (secret_store IN ('envelope_db', 'env', 'file', 'external_kms', 'external_vault')),
  -- A reference that names a secret in the store; values shaped like known credential formats are refused.
  secret_ref text NOT NULL CHECK (secret_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$'
    AND secret_ref !~ '^(sk-|sk_|rk_|pk_live|whsec_|xox[abpr]-|ghp_|gho_|ghs_|github_pat_|glpat-|AKIA|ASIA|AIza|ya29\.|hf_|r8_|SG\.|key-)'
    AND secret_ref !~ '[A-Za-z0-9+/=_-]{40,}'),
  status text NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'active', 'retired')),
  registered_by uuid NOT NULL REFERENCES trustwork.person (id),
  registered_at timestamptz NOT NULL DEFAULT now(),
  activated_by uuid NULL REFERENCES trustwork.person (id),
  activated_at timestamptz NULL,
  approval_id uuid NULL UNIQUE REFERENCES trustwork.second_person_approval (id),
  retired_by uuid NULL REFERENCES trustwork.person (id),
  retired_at timestamptz NULL,
  rotated_from_id uuid NULL REFERENCES trustwork.provider_credential_ref (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_credential_ref_activation CHECK ((activated_by IS NULL) = (activated_at IS NULL) AND (status = 'registered') = (activated_by IS NULL AND retired_at IS NULL)
    AND (mode = 'fake' OR activated_by IS NULL OR approval_id IS NOT NULL)),
  CONSTRAINT provider_credential_ref_retired CHECK ((status = 'retired') = (retired_at IS NOT NULL) AND (retired_at IS NULL) = (retired_by IS NULL))
);
CREATE UNIQUE INDEX provider_credential_ref_one_active ON trustwork.provider_credential_ref (hub_id, provider) WHERE status = 'active';
CREATE TRIGGER provider_credential_ref_touch BEFORE UPDATE ON trustwork.provider_credential_ref FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- credentialActivationDigest in hub-core.ts (providers.enable_non_fake).
CREATE FUNCTION trustwork.hubs_credential_digest(p_id uuid, p_hub uuid, p_provider text, p_adapter text, p_mode text, p_store text, p_ref text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.admin_digest(jsonb_build_object('action', 'providers.enable_non_fake', 'object', 'provider_credential_ref', 'hubId', p_hub::text,
    'credentialId', p_id::text, 'provider', p_provider, 'adapter', p_adapter, 'mode', p_mode, 'secretStore', p_store, 'secretRef', p_ref))
$$;

CREATE FUNCTION trustwork.hubs_credential_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_approval trustwork.second_person_approval%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'credential references are retired, never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'registered' OR NEW.activated_by IS NOT NULL THEN
      RAISE EXCEPTION 'a credential reference is born registered' USING ERRCODE = 'check_violation', HINT = 'hubs.invalid_transition';
    END IF;
    NEW.registered_at := now();
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.hub_id <> OLD.hub_id OR NEW.provider <> OLD.provider OR NEW.adapter <> OLD.adapter OR NEW.mode <> OLD.mode OR NEW.secret_store <> OLD.secret_store
     OR NEW.secret_ref <> OLD.secret_ref OR NEW.registered_by <> OLD.registered_by OR NEW.registered_at <> OLD.registered_at THEN
    RAISE EXCEPTION 'a credential reference is immutable; register a new one' USING ERRCODE = 'integrity_constraint_violation', HINT = 'hubs.version_immutable';
  END IF;
  IF NOT ((OLD.status = 'registered' AND NEW.status IN ('active', 'retired')) OR (OLD.status = 'active' AND NEW.status = 'retired') OR OLD.status = NEW.status) THEN
    RAISE EXCEPTION 'credential reference % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'hubs.invalid_transition';
  END IF;
  IF NEW.status = 'active' AND OLD.status = 'registered' THEN
    NEW.activated_at := now();
    IF NEW.mode <> 'fake' THEN
      SELECT * INTO v_approval FROM trustwork.second_person_approval WHERE id = NEW.approval_id;
      IF NOT FOUND OR v_approval.status <> 'consumed' OR v_approval.consumed_ref IS DISTINCT FROM NEW.id OR v_approval.hub_id IS DISTINCT FROM NEW.hub_id
         OR v_approval.requested_by IS DISTINCT FROM NEW.activated_by OR v_approval.approved_by = NEW.activated_by OR v_approval.action <> 'providers.enable_non_fake'
         OR v_approval.action_digest IS DISTINCT FROM trustwork.hubs_credential_digest(NEW.id, NEW.hub_id, NEW.provider, NEW.adapter, NEW.mode, NEW.secret_store, NEW.secret_ref) THEN
        RAISE EXCEPTION 'a non-fake provider is enabled only under a consumed second-person approval' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_required';
      END IF;
    END IF;
  ELSIF NEW.status = OLD.status AND ROW(NEW.activated_by, NEW.activated_at, NEW.approval_id, NEW.retired_by, NEW.retired_at, NEW.rotated_from_id)
        IS DISTINCT FROM ROW(OLD.activated_by, OLD.activated_at, OLD.approval_id, OLD.retired_by, OLD.retired_at, OLD.rotated_from_id) THEN
    RAISE EXCEPTION 'decision columns change only with the status' USING ERRCODE = 'integrity_constraint_violation', HINT = 'hubs.version_immutable';
  END IF;
  IF NEW.status = 'retired' AND OLD.status <> 'retired' THEN
    NEW.retired_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER provider_credential_ref_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.provider_credential_ref FOR EACH ROW EXECUTE FUNCTION trustwork.hubs_credential_guard();

-- 7. Retention policy (derived from the active privacy version) -------------------------------------------------------
CREATE TABLE trustwork.retention_policy (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  config_version_id uuid NOT NULL REFERENCES trustwork.hub_config_version (id),
  class text NOT NULL CHECK (class = ANY (trustwork.hubs_retention_classes())),
  min_period text NULL CHECK (min_period IS NULL OR trustwork.hubs_duration_ok(min_period)),
  max_period text NULL CHECK (max_period IS NULL OR trustwork.hubs_duration_ok(max_period)),
  pack_fact_ref jsonb NULL CHECK (pack_fact_ref IS NULL OR jsonb_typeof(pack_fact_ref) = 'object'),
  disclosure_text_key text NULL CHECK (disclosure_text_key ~ '^[a-z][A-Za-z0-9_.-]{1,120}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retention_policy_once UNIQUE (config_version_id, class),
  CONSTRAINT retention_policy_order CHECK (min_period IS NULL OR max_period IS NULL OR min_period::interval <= max_period::interval)
);
CREATE TRIGGER retention_policy_append_only BEFORE UPDATE OR DELETE ON trustwork.retention_policy FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE FUNCTION trustwork.hubs_retention_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM trustwork.hub_config_version v WHERE v.id = NEW.config_version_id AND v.hub_id = NEW.hub_id AND v.domain = 'privacy' AND v.status = 'active') THEN
    RAISE EXCEPTION 'retention rows are derived from the active privacy version of their hub' USING ERRCODE = 'check_violation', HINT = 'hubs.retention_invalid';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER retention_policy_guard BEFORE INSERT ON trustwork.retention_policy FOR EACH ROW EXECUTE FUNCTION trustwork.hubs_retention_guard();

-- 8. Launch gate preconditions and the lifecycle guard on the anchor ---------------------------------------------------
-- What the engine can verify about a gate now (a person still records evidence for every gate). Gates without a
-- machine-checkable precondition (i18n, backup and restore, brand accessibility) rest on the recorded evidence.
CREATE FUNCTION trustwork.hubs_gate_precondition(p_hub uuid, p_gate text) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_locales text[] := coalesce((SELECT locales FROM trustwork.hub_profile WHERE hub_id = p_hub), ARRAY[]::text[]);
  v_modes jsonb;
BEGIN
  CASE p_gate
    WHEN 'operator_recorded_and_screened' THEN RETURN trustwork.hubs_active_payload(p_hub, 'legal') IS NOT NULL;
    WHEN 'legal_documents_counsel_approved' THEN
      RETURN cardinality(v_locales) > 0 AND NOT EXISTS (
        SELECT 1 FROM unnest(ARRAY['terms', 'privacy_notice', 'sanctions_section']) k CROSS JOIN unnest(v_locales) l
        WHERE NOT EXISTS (SELECT 1 FROM trustwork.legal_document_version d WHERE d.hub_id = p_hub AND d.kind = k AND d.locale = l AND d.status = 'active' AND d.counsel_approval_id IS NOT NULL));
    WHEN 'community_rules_all_languages' THEN
      RETURN cardinality(v_locales) > 0 AND NOT EXISTS (
        SELECT 1 FROM unnest(v_locales) l WHERE NOT EXISTS (
          SELECT 1 FROM trustwork.legal_document_version d WHERE d.hub_id = p_hub AND d.kind = 'community_rules' AND d.locale = l AND d.status = 'active'));
    WHEN 'data_residency_configured' THEN RETURN trustwork.hubs_active_payload(p_hub, 'residency') IS NOT NULL;
    WHEN 'two_staff_with_second_factor' THEN
      RETURN (SELECT count(DISTINCT a.person_id) >= 2 AND count(DISTINCT a.role) >= 2
        FROM trustwork.staff_role_assignment a
        WHERE a.revoked_at IS NULL AND NOT a.breakglass AND a.valid_from <= now() AND (a.valid_until IS NULL OR a.valid_until > now())
          AND (a.scope_kind IN ('platform', 'node') OR a.hub_id = p_hub)
          AND EXISTS (SELECT 1 FROM trustwork.second_factor f WHERE f.person_id = a.person_id AND f.state = 'active'));
    WHEN 'editorial_team_and_policy' THEN RETURN trustwork.hubs_active_payload(p_hub, 'editorial') IS NOT NULL;
    WHEN 'information_source_registered' THEN RETURN trustwork.hubs_active_payload(p_hub, 'sources') IS NOT NULL;
    WHEN 'verification_recipe_enabled' THEN RETURN trustwork.hubs_active_payload(p_hub, 'verification') IS NOT NULL;
    WHEN 'sanctions_screening_configured' THEN
      RETURN trustwork.hubs_active_payload(p_hub, 'screening') IS NOT NULL AND trustwork.attestation_in_force(now());
    WHEN 'demo_data_purged' THEN
      v_modes := trustwork.hubs_active_payload(p_hub, 'modes');
      RETURN v_modes IS NOT NULL AND v_modes ->> 'dataMode' = 'live';
    WHEN 'ai_egress_policy_reviewed' THEN RETURN trustwork.hubs_active_payload(p_hub, 'egress') IS NOT NULL;
    ELSE RETURN p_gate = ANY (trustwork.hubs_launch_gates());
  END CASE;
END $$;

-- The gates (and mode or territory problems) that block a hub from `p_target` now: a required gate that is not
-- passed, or whose precondition no longer holds; the modes that contradict the target (demo data never leaves
-- preparation); a hub without a territory. Empty: the transition may be requested (it still needs a second person).
CREATE FUNCTION trustwork.hubs_blockers(p_hub uuid, p_target text) RETURNS text[]
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_out text[] := ARRAY[]::text[];
  v_gate text;
  v_modes jsonb := trustwork.hubs_active_payload(p_hub, 'modes');
BEGIN
  FOREACH v_gate IN ARRAY trustwork.hubs_required_gates(p_target) LOOP
    IF NOT EXISTS (SELECT 1 FROM trustwork.launch_gate g WHERE g.hub_id = p_hub AND g.gate = v_gate AND g.state = 'passed')
       OR NOT trustwork.hubs_gate_precondition(p_hub, v_gate) THEN
      v_out := v_out || ('gate:' || v_gate);
    END IF;
  END LOOP;
  IF p_target IN ('soft_launch', 'public') THEN
    IF v_modes IS NULL OR v_modes ->> 'dataMode' IS DISTINCT FROM 'live' THEN v_out := v_out || 'modes:demo_data_only_before_soft_launch'::text; END IF;
    IF v_modes IS NOT NULL AND v_modes ->> 'registration' = 'open' AND p_target <> 'public' THEN v_out := v_out || 'modes:open_registration_only_when_public'::text; END IF;
    IF NOT EXISTS (SELECT 1 FROM trustwork.hub_territory t WHERE t.hub_id = p_hub) THEN v_out := v_out || 'territory:none'::text; END IF;
    IF NOT EXISTS (SELECT 1 FROM trustwork.hub_profile p WHERE p.hub_id = p_hub) THEN v_out := v_out || 'profile:none'::text; END IF;
  END IF;
  RETURN v_out;
END $$;

-- lifecycleTransitionDigest in hub-core.ts.
CREATE FUNCTION trustwork.hubs_transition_digest(p_hub uuid, p_from text, p_to text, p_revision integer) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.admin_digest(jsonb_build_object('action', CASE p_to WHEN 'public' THEN 'hub.transition_public' ELSE 'hub.transition_soft_launch' END,
    'object', 'hub', 'hubId', p_hub::text, 'from', p_from, 'to', p_to, 'revision', p_revision))
$$;

-- Every writer, the owner and maintenance included: transitions follow the lifecycle graph; soft_launch and public need
-- every required gate and a second-person approval of exactly this transition consumed in this transaction.
CREATE FUNCTION trustwork.hubs_lifecycle_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_blockers text[];
BEGIN
  IF NEW.lifecycle IS NOT DISTINCT FROM OLD.lifecycle THEN
    RETURN NEW;
  END IF;
  IF NOT trustwork.hubs_transition_allowed(OLD.lifecycle, NEW.lifecycle) THEN
    RAISE EXCEPTION 'hub % -> % is not allowed', OLD.lifecycle, NEW.lifecycle USING ERRCODE = 'check_violation', HINT = 'hubs.transition_not_allowed';
  END IF;
  IF NEW.lifecycle IN ('soft_launch', 'public') THEN
    v_blockers := trustwork.hubs_blockers(NEW.id, NEW.lifecycle);
    IF cardinality(v_blockers) > 0 THEN
      RAISE EXCEPTION 'the hub cannot go % with open launch gates', NEW.lifecycle USING ERRCODE = 'check_violation', HINT = 'hubs.launch_gate_open', DETAIL = array_to_string(v_blockers, ',');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM trustwork.second_person_approval a
                   WHERE a.hub_id = NEW.id AND a.scope_kind = 'hub' AND a.status = 'consumed' AND a.consumed_ref = NEW.id AND a.consumed_at = now()
                     AND a.action = CASE NEW.lifecycle WHEN 'public' THEN 'hub.transition_public' ELSE 'hub.transition_soft_launch' END
                     AND a.action_digest = trustwork.hubs_transition_digest(NEW.id, OLD.lifecycle, NEW.lifecycle, OLD.revision)) THEN
      RAISE EXCEPTION 'going % needs a second person''s approval of this transition', NEW.lifecycle USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_required';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hub_lifecycle_guard BEFORE UPDATE OF lifecycle ON trustwork.hub FOR EACH ROW EXECUTE FUNCTION trustwork.hubs_lifecycle_guard();

-- 9. Commands (SECURITY DEFINER, allowlisted for the runtime role) ------------------------------------------------------
-- Every command: caller + live elevation + permission at the hub (admin_authorize), the change, and one audit row in the
-- same transaction. p_ctx is DATA-002's command context ({elevationId, requestId, reasonCode, reasonText}).

CREATE FUNCTION trustwork.hubs_node() RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_node uuid := (SELECT id FROM trustwork.admin_node LIMIT 1);
BEGIN
  IF v_node IS NULL THEN
    RAISE EXCEPTION 'the node is not set up yet' USING ERRCODE = 'object_not_in_prerequisite_state', HINT = 'hubs.no_node';
  END IF;
  RETURN v_node;
END $$;

CREATE FUNCTION trustwork.hubs_require_hub(p_hub uuid, p_lock boolean DEFAULT false) RETURNS trustwork.hub
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_hub trustwork.hub%ROWTYPE;
BEGIN
  IF p_lock THEN
    SELECT * INTO v_hub FROM trustwork.hub WHERE id = p_hub FOR UPDATE;
  ELSE
    SELECT * INTO v_hub FROM trustwork.hub WHERE id = p_hub;
  END IF;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM trustwork.hub_profile p WHERE p.hub_id = p_hub) THEN
    RAISE EXCEPTION 'no such hub' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  RETURN v_hub;
END $$;

-- Inserts one territory after the hub-level restriction check (the kernel guard then checks the engine list, the
-- jurisdiction's existence and selectability again).
CREATE FUNCTION trustwork.hubs_insert_territory(p_hub uuid, p_level text, p_code text) RETURNS trustwork.hub_territory
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_row trustwork.hub_territory%ROWTYPE;
BEGIN
  IF p_level NOT IN ('country', 'region', 'place') OR NOT trustwork.hubs_place_code_ok(p_code) THEN
    RAISE EXCEPTION 'a territory is a country, a region or a place code' USING ERRCODE = 'invalid_parameter_value', HINT = 'hubs.territory_invalid';
  END IF;
  PERFORM trustwork.kernel_lock_restrictions_shared();
  IF trustwork.hubs_place_restricted(p_hub, p_code) THEN
    RAISE EXCEPTION 'restricted place % cannot be a hub territory', p_code USING ERRCODE = 'check_violation', HINT = 'kernel.restricted_place', DETAIL = p_code;
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.hub_territory t WHERE t.hub_id = p_hub AND t.code = p_code) THEN
    RAISE EXCEPTION 'the hub already covers %', p_code USING ERRCODE = 'unique_violation', HINT = 'hubs.territory_exists';
  END IF;
  INSERT INTO trustwork.hub_territory (hub_id, level, code, place_key)
  VALUES (p_hub, p_level, p_code, CASE WHEN p_level = 'place' THEN split_part(p_code, ':', 2) END) RETURNING * INTO v_row;
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.hubs_create(p_ctx jsonb, p_slug text, p_name jsonb, p_default_locale text, p_locales text[], p_time_zone text, p_currency text,
  p_pack_code text, p_pack_version text, p_territories jsonb) RETURNS trustwork.hub_profile
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_node uuid := trustwork.hubs_node();
  v_actor trustwork.admin_actor;
  v_hub trustwork.hub%ROWTYPE;
  v_profile trustwork.hub_profile%ROWTYPE;
  v_t jsonb;
BEGIN
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.node.hubs.manage'], v_node, NULL);
  IF p_territories IS NULL OR jsonb_typeof(p_territories) <> 'array' OR jsonb_array_length(p_territories) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'a hub declares one to 200 territories' USING ERRCODE = 'invalid_parameter_value', HINT = 'hubs.territory_required';
  END IF;
  INSERT INTO trustwork.hub (slug, lifecycle, pack_code, pack_version) VALUES (p_slug, 'draft', p_pack_code, p_pack_version) RETURNING * INTO v_hub;
  INSERT INTO trustwork.hub_profile (hub_id, node_id, name, default_locale, locales, time_zone, currency, created_by)
  VALUES (v_hub.id, v_node, p_name, p_default_locale, p_locales, p_time_zone, p_currency, v_actor.person_id) RETURNING * INTO v_profile;
  FOR v_t IN SELECT value FROM jsonb_array_elements(p_territories) LOOP
    PERFORM trustwork.hubs_insert_territory(v_hub.id, v_t ->> 'level', v_t ->> 'code');
  END LOOP;
  INSERT INTO trustwork.launch_gate (hub_id, gate) SELECT v_hub.id, g FROM unnest(trustwork.hubs_launch_gates()) g;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_node, NULL, 'hub.created', 'hub', v_hub.id, NULL,
    to_jsonb(v_profile) || jsonb_build_object('slug', v_hub.slug, 'lifecycle', v_hub.lifecycle, 'territories', p_territories));
  RETURN v_profile;
END $$;

CREATE FUNCTION trustwork.hubs_update_profile(p_ctx jsonb, p_hub uuid, p_expected_revision integer, p_name jsonb, p_default_locale text, p_locales text[],
  p_time_zone text, p_currency text, p_brand_overlay text) RETURNS trustwork.hub_profile
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_before trustwork.hub_profile%ROWTYPE;
  v_row trustwork.hub_profile%ROWTYPE;
BEGIN
  PERFORM trustwork.hubs_require_hub(p_hub);
  v_actor := trustwork.admin_authorize(p_ctx, trustwork.hubs_domain_permissions('identity'), NULL, p_hub);
  SELECT * INTO v_before FROM trustwork.hub_profile WHERE hub_id = p_hub FOR UPDATE;
  IF v_before.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'the profile changed; reload' USING ERRCODE = 'serialization_failure', HINT = 'hubs.revision_conflict';
  END IF;
  UPDATE trustwork.hub_profile SET name = p_name, default_locale = p_default_locale, locales = p_locales, time_zone = p_time_zone, currency = p_currency,
    brand_overlay = p_brand_overlay WHERE hub_id = p_hub RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'hub.profile_updated', 'hub', p_hub, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.hubs_add_territory(p_ctx jsonb, p_hub uuid, p_level text, p_code text) RETURNS trustwork.hub_territory
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_row trustwork.hub_territory%ROWTYPE;
BEGIN
  PERFORM trustwork.hubs_require_hub(p_hub, true);
  v_actor := trustwork.admin_authorize(p_ctx, trustwork.hubs_domain_permissions('identity'), NULL, p_hub);
  IF (SELECT count(*) FROM trustwork.hub_territory WHERE hub_id = p_hub) >= 200 THEN
    RAISE EXCEPTION 'a hub declares at most 200 territories' USING ERRCODE = 'check_violation', HINT = 'hubs.territory_limit';
  END IF;
  v_row := trustwork.hubs_insert_territory(p_hub, p_level, p_code);
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'hub.territory_added', 'hub_territory', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.hubs_remove_territory(p_ctx jsonb, p_hub uuid, p_territory uuid) RETURNS trustwork.hub_territory
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_row trustwork.hub_territory%ROWTYPE;
BEGIN
  PERFORM trustwork.hubs_require_hub(p_hub, true);
  v_actor := trustwork.admin_authorize(p_ctx, trustwork.hubs_domain_permissions('identity'), NULL, p_hub);
  SELECT * INTO v_row FROM trustwork.hub_territory WHERE id = p_territory AND hub_id = p_hub;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such territory' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF (SELECT count(*) FROM trustwork.hub_territory WHERE hub_id = p_hub) <= 1 THEN
    RAISE EXCEPTION 'a hub keeps at least one territory' USING ERRCODE = 'check_violation', HINT = 'hubs.territory_required';
  END IF;
  DELETE FROM trustwork.hub_territory WHERE id = p_territory;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'hub.territory_removed', 'hub_territory', v_row.id, to_jsonb(v_row), NULL);
  RETURN v_row;
END $$;

-- Serializes version numbering and activation per (hub, domain).
CREATE FUNCTION trustwork.hubs_lock_domain(p_hub uuid, p_domain text) RETURNS void
LANGUAGE sql VOLATILE AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('trustwork.hub_config:' || p_hub::text || ':' || p_domain, 0))
$$;

CREATE FUNCTION trustwork.hubs_draft_config(p_ctx jsonb, p_hub uuid, p_domain text, p_payload jsonb, p_source text DEFAULT 'console') RETURNS trustwork.hub_config_version
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_hub trustwork.hub%ROWTYPE := trustwork.hubs_require_hub(p_hub);
  v_row trustwork.hub_config_version%ROWTYPE;
BEGIN
  IF NOT (p_domain = ANY (trustwork.hubs_config_domains())) THEN
    RAISE EXCEPTION 'unknown configuration domain %', p_domain USING ERRCODE = 'invalid_parameter_value', HINT = 'hubs.domain_unknown';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, trustwork.hubs_domain_permissions(p_domain), NULL, p_hub);
  IF v_hub.lifecycle = 'closed' THEN
    RAISE EXCEPTION 'a closed hub is not configured' USING ERRCODE = 'check_violation', HINT = 'hubs.hub_closed';
  END IF;
  PERFORM trustwork.hubs_lock_domain(p_hub, p_domain);
  PERFORM trustwork.hubs_check_payload(p_hub, p_domain, p_payload);
  INSERT INTO trustwork.hub_config_version (hub_id, domain, version, payload, payload_digest, source, reason, drafted_by)
  VALUES (p_hub, p_domain, coalesce((SELECT max(version) FROM trustwork.hub_config_version WHERE hub_id = p_hub AND domain = p_domain), 0) + 1,
    p_payload, repeat('0', 64), coalesce(p_source, 'console'), p_ctx ->> 'reasonText', v_actor.person_id)
  RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'hub.config_drafted', 'hub_config_version', v_row.id, NULL,
    jsonb_build_object('id', v_row.id, 'domain', v_row.domain, 'version', v_row.version, 'payloadDigest', v_row.payload_digest, 'revision', v_row.revision));
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.hubs_cancel_config(p_ctx jsonb, p_version uuid) RETURNS trustwork.hub_config_version
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_before trustwork.hub_config_version%ROWTYPE;
  v_row trustwork.hub_config_version%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_before FROM trustwork.hub_config_version WHERE id = p_version FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such configuration version' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, trustwork.hubs_domain_permissions(v_before.domain), NULL, v_before.hub_id);
  IF v_before.status <> 'draft' THEN
    RAISE EXCEPTION 'only a draft is cancelled' USING ERRCODE = 'check_violation', HINT = 'hubs.invalid_transition';
  END IF;
  UPDATE trustwork.hub_config_version SET status = 'cancelled' WHERE id = p_version RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'hub.config_cancelled', 'hub_config_version', v_row.id,
    jsonb_build_object('status', v_before.status, 'revision', v_before.revision), jsonb_build_object('status', v_row.status, 'revision', v_row.revision));
  RETURN v_row;
END $$;

-- Activates a draft. Sensitive domains: the caller holds the domain's second-person action permission, is not the
-- drafter, and consumes an approval (requested by the caller, approved by someone else) of this version's digest.
CREATE FUNCTION trustwork.hubs_activate_config(p_ctx jsonb, p_version uuid, p_expected_revision integer, p_approval_id uuid) RETURNS trustwork.hub_config_version
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_before trustwork.hub_config_version%ROWTYPE;
  v_row trustwork.hub_config_version%ROWTYPE;
  v_action text;
  v_current integer;
  v_entry jsonb;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_before FROM trustwork.hub_config_version WHERE id = p_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such configuration version' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_action := trustwork.hubs_domain_action(v_before.domain);
  v_actor := trustwork.admin_authorize(p_ctx, CASE WHEN v_action IS NULL THEN trustwork.hubs_domain_permissions(v_before.domain) ELSE trustwork.admin_action_permissions(v_action) END,
    NULL, v_before.hub_id);
  PERFORM trustwork.hubs_lock_domain(v_before.hub_id, v_before.domain);
  SELECT * INTO v_before FROM trustwork.hub_config_version WHERE id = p_version FOR UPDATE;
  IF v_before.status <> 'draft' THEN
    RAISE EXCEPTION 'the version is %', v_before.status USING ERRCODE = 'check_violation', HINT = 'hubs.invalid_transition';
  END IF;
  IF p_expected_revision IS NOT NULL AND v_before.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'the version changed; reload' USING ERRCODE = 'serialization_failure', HINT = 'hubs.revision_conflict';
  END IF;
  SELECT version INTO v_current FROM trustwork.hub_config_current WHERE hub_id = v_before.hub_id AND domain = v_before.domain;
  IF v_current IS NOT NULL AND v_current >= v_before.version THEN
    RAISE EXCEPTION 'a newer version (%) is already active', v_current USING ERRCODE = 'check_violation', HINT = 'hubs.config_stale';
  END IF;
  IF (SELECT lifecycle FROM trustwork.hub WHERE id = v_before.hub_id) = 'closed' THEN
    RAISE EXCEPTION 'a closed hub is not configured' USING ERRCODE = 'check_violation', HINT = 'hubs.hub_closed';
  END IF;
  -- The world may have changed since the draft (restricted list, hub-added places, attestation): check again.
  PERFORM trustwork.hubs_check_payload(v_before.hub_id, v_before.domain, v_before.payload);
  IF v_action IS NOT NULL THEN
    IF v_actor.person_id = v_before.drafted_by THEN
      RAISE EXCEPTION 'a sensitive version is activated by someone other than its drafter' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.self_approval';
    END IF;
    IF p_approval_id IS NULL THEN
      RAISE EXCEPTION 'activating % needs a second person''s approval', v_before.domain USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_required';
    END IF;
    PERFORM trustwork.admin_consume_approval(p_approval_id, v_action, 'hub', NULL, v_before.hub_id,
      trustwork.hubs_config_digest(v_before.id, v_before.hub_id, v_before.domain, v_before.version, v_before.payload_digest), v_before.id);
  END IF;
  UPDATE trustwork.hub_config_version SET status = 'superseded' WHERE hub_id = v_before.hub_id AND domain = v_before.domain AND status = 'active';
  UPDATE trustwork.hub_config_version SET status = 'active', activated_by = v_actor.person_id, activated_at = now(), effective_from = now(),
    approval_id = CASE WHEN v_action IS NULL THEN NULL ELSE p_approval_id END
   WHERE id = p_version RETURNING * INTO v_row;
  INSERT INTO trustwork.hub_config_current (hub_id, domain, version_id, version) VALUES (v_row.hub_id, v_row.domain, v_row.id, v_row.version)
  ON CONFLICT (hub_id, domain) DO UPDATE SET version_id = EXCLUDED.version_id, version = EXCLUDED.version;
  IF v_row.domain = 'privacy' THEN
    FOR v_entry IN SELECT value FROM jsonb_array_elements(coalesce(v_row.payload -> 'retention', '[]'::jsonb)) LOOP
      INSERT INTO trustwork.retention_policy (hub_id, config_version_id, class, min_period, max_period, pack_fact_ref, disclosure_text_key)
      VALUES (v_row.hub_id, v_row.id, v_entry ->> 'class', v_entry ->> 'minPeriod', v_entry ->> 'maxPeriod', NULLIF(v_entry -> 'packFactRef', 'null'::jsonb), v_entry ->> 'disclosureTextKey');
    END LOOP;
  END IF;
  -- A change re-opens the gates that rest on it; demo data re-opens the purge gate.
  UPDATE trustwork.launch_gate SET state = 'invalidated', invalidation_reason = 'configuration version ' || v_row.version || ' of ' || v_row.domain || ' activated'
   WHERE hub_id = v_row.hub_id AND state = 'passed'
     AND (gate = ANY (trustwork.hubs_domain_gates(v_row.domain)) OR (v_row.domain = 'modes' AND gate = 'demo_data_purged' AND v_row.payload ->> 'dataMode' IS DISTINCT FROM 'live'));
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'hub.config_activated', 'hub_config_version', v_row.id,
    jsonb_build_object('status', v_before.status, 'revision', v_before.revision),
    jsonb_build_object('id', v_row.id, 'domain', v_row.domain, 'version', v_row.version, 'payloadDigest', v_row.payload_digest, 'status', v_row.status, 'revision', v_row.revision),
    NULL, CASE WHEN v_action IS NULL THEN NULL ELSE p_approval_id END);
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.hubs_check_gate(p_ctx jsonb, p_hub uuid, p_gate text, p_evidence uuid) RETURNS trustwork.launch_gate
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_before trustwork.launch_gate%ROWTYPE;
  v_row trustwork.launch_gate%ROWTYPE;
BEGIN
  PERFORM trustwork.hubs_require_hub(p_hub);
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.hub.launch.check'], NULL, p_hub);
  SELECT * INTO v_before FROM trustwork.launch_gate WHERE hub_id = p_hub AND gate = p_gate FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown launch gate %', p_gate USING ERRCODE = 'invalid_parameter_value', HINT = 'hubs.gate_unknown';
  END IF;
  IF p_evidence IS NULL THEN
    RAISE EXCEPTION 'a passed gate records its evidence' USING ERRCODE = 'invalid_parameter_value', HINT = 'hubs.gate_evidence_required';
  END IF;
  IF NOT trustwork.hubs_gate_precondition(p_hub, p_gate) THEN
    RAISE EXCEPTION 'the engine cannot confirm gate % yet', p_gate USING ERRCODE = 'check_violation', HINT = 'hubs.gate_precondition', DETAIL = p_gate;
  END IF;
  UPDATE trustwork.launch_gate SET state = 'passed', evidence_ref = p_evidence, checked_by = v_actor.person_id, checked_at = now(),
    invalidated_at = NULL, invalidation_reason = NULL WHERE id = v_before.id RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'hub.launch_gate_passed', 'launch_gate', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.hubs_invalidate_gate(p_ctx jsonb, p_hub uuid, p_gate text) RETURNS trustwork.launch_gate
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_before trustwork.launch_gate%ROWTYPE;
  v_row trustwork.launch_gate%ROWTYPE;
BEGIN
  PERFORM trustwork.hubs_require_hub(p_hub);
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.hub.launch.check'], NULL, p_hub);
  SELECT * INTO v_before FROM trustwork.launch_gate WHERE hub_id = p_hub AND gate = p_gate FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown launch gate %', p_gate USING ERRCODE = 'invalid_parameter_value', HINT = 'hubs.gate_unknown';
  END IF;
  IF v_before.state <> 'passed' THEN
    RAISE EXCEPTION 'only a passed gate is invalidated' USING ERRCODE = 'check_violation', HINT = 'hubs.invalid_transition';
  END IF;
  UPDATE trustwork.launch_gate SET state = 'invalidated', invalidation_reason = p_ctx ->> 'reasonText' WHERE id = v_before.id RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'hub.launch_gate_invalidated', 'launch_gate', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Lifecycle transition. soft_launch and public: blockers refused first, then the approval of exactly this transition
-- (hubs_transition_digest over the hub revision the request was made at) is consumed; the anchor's guard checks both
-- again. Other transitions need admin.hub.lifecycle.request at the hub.
CREATE FUNCTION trustwork.hubs_transition(p_ctx jsonb, p_hub uuid, p_to text, p_expected_revision integer, p_approval_id uuid) RETURNS trustwork.hub
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_before trustwork.hub%ROWTYPE;
  v_row trustwork.hub%ROWTYPE;
  v_action text := CASE p_to WHEN 'public' THEN 'hub.transition_public' WHEN 'soft_launch' THEN 'hub.transition_soft_launch' END;
  v_blockers text[];
BEGIN
  PERFORM trustwork.admin_require_caller();
  v_before := trustwork.hubs_require_hub(p_hub);
  v_actor := trustwork.admin_authorize(p_ctx, CASE WHEN v_action IS NULL THEN ARRAY['admin.hub.lifecycle.request'] ELSE trustwork.admin_action_permissions(v_action) END, NULL, p_hub);
  v_before := trustwork.hubs_require_hub(p_hub, true);
  IF v_before.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'the hub changed; reload' USING ERRCODE = 'serialization_failure', HINT = 'hubs.revision_conflict';
  END IF;
  IF NOT trustwork.hubs_transition_allowed(v_before.lifecycle, p_to) THEN
    RAISE EXCEPTION 'hub % -> % is not allowed', v_before.lifecycle, p_to USING ERRCODE = 'check_violation', HINT = 'hubs.transition_not_allowed';
  END IF;
  IF v_action IS NOT NULL THEN
    v_blockers := trustwork.hubs_blockers(p_hub, p_to);
    IF cardinality(v_blockers) > 0 THEN
      RAISE EXCEPTION 'the hub cannot go % with open launch gates', p_to USING ERRCODE = 'check_violation', HINT = 'hubs.launch_gate_open', DETAIL = array_to_string(v_blockers, ',');
    END IF;
    IF p_approval_id IS NULL THEN
      RAISE EXCEPTION 'going % needs a second person''s approval', p_to USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_required';
    END IF;
    PERFORM trustwork.admin_consume_approval(p_approval_id, v_action, 'hub', NULL, p_hub, trustwork.hubs_transition_digest(p_hub, v_before.lifecycle, p_to, v_before.revision), p_hub);
  END IF;
  UPDATE trustwork.hub SET lifecycle = p_to WHERE id = p_hub RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'hub.lifecycle_changed', 'hub', p_hub,
    jsonb_build_object('lifecycle', v_before.lifecycle, 'revision', v_before.revision), jsonb_build_object('lifecycle', v_row.lifecycle, 'revision', v_row.revision),
    NULL, CASE WHEN v_action IS NULL THEN NULL ELSE p_approval_id END);
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.hubs_draft_legal_document(p_ctx jsonb, p_hub uuid, p_kind text, p_locale text, p_body text) RETURNS trustwork.legal_document_version
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_row trustwork.legal_document_version%ROWTYPE;
BEGIN
  PERFORM trustwork.hubs_require_hub(p_hub);
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.hub.legal.edit'], NULL, p_hub);
  IF NOT EXISTS (SELECT 1 FROM trustwork.hub_profile WHERE hub_id = p_hub AND p_locale = ANY (locales)) THEN
    RAISE EXCEPTION 'the hub does not publish in %', p_locale USING ERRCODE = 'check_violation', HINT = 'hubs.locale_not_in_hub';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('trustwork.legal:' || p_hub::text || ':' || coalesce(p_kind, '') || ':' || p_locale, 0));
  INSERT INTO trustwork.legal_document_version (hub_id, kind, locale, version, body, body_digest, drafted_by)
  VALUES (p_hub, p_kind, p_locale, coalesce((SELECT max(version) FROM trustwork.legal_document_version WHERE hub_id = p_hub AND kind = p_kind AND locale = p_locale), 0) + 1,
    p_body, repeat('0', 64), v_actor.person_id) RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'legal.document_drafted', 'legal_document_version', v_row.id, NULL,
    jsonb_build_object('id', v_row.id, 'kind', v_row.kind, 'locale', v_row.locale, 'version', v_row.version, 'bodyDigest', v_row.body_digest, 'revision', v_row.revision));
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.hubs_record_counsel_approval(p_ctx jsonb, p_hub uuid, p_document_ids uuid[], p_counsel_name text, p_firm text, p_approved_on date,
  p_scope_note text) RETURNS trustwork.counsel_approval
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_row trustwork.counsel_approval%ROWTYPE;
BEGIN
  PERFORM trustwork.hubs_require_hub(p_hub);
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.hub.legal.edit'], NULL, p_hub);
  INSERT INTO trustwork.counsel_approval (hub_id, document_version_ids, counsel_name, firm, approved_on, scope_note, recorded_by)
  VALUES (p_hub, p_document_ids, p_counsel_name, p_firm, p_approved_on, p_scope_note, v_actor.person_id) RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'legal.counsel_approval_recorded', 'counsel_approval', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Activates a legal document version: a counsel approval of this version is required, and a second person's approval
-- of this version's digest (legal.activate_document_version) is consumed by the activator.
CREATE FUNCTION trustwork.hubs_activate_legal_document(p_ctx jsonb, p_document uuid, p_expected_revision integer, p_approval_id uuid) RETURNS trustwork.legal_document_version
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_before trustwork.legal_document_version%ROWTYPE;
  v_row trustwork.legal_document_version%ROWTYPE;
  v_counsel uuid;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_before FROM trustwork.legal_document_version WHERE id = p_document;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such legal document version' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, trustwork.admin_action_permissions('legal.activate_document_version'), NULL, v_before.hub_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('trustwork.legal:' || v_before.hub_id::text || ':' || v_before.kind || ':' || v_before.locale, 0));
  SELECT * INTO v_before FROM trustwork.legal_document_version WHERE id = p_document FOR UPDATE;
  IF v_before.status <> 'draft' THEN
    RAISE EXCEPTION 'the document version is %', v_before.status USING ERRCODE = 'check_violation', HINT = 'hubs.invalid_transition';
  END IF;
  IF p_expected_revision IS NOT NULL AND v_before.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'the document version changed; reload' USING ERRCODE = 'serialization_failure', HINT = 'hubs.revision_conflict';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.legal_document_version d WHERE d.hub_id = v_before.hub_id AND d.kind = v_before.kind AND d.locale = v_before.locale
             AND d.status = 'active' AND d.version > v_before.version) THEN
    RAISE EXCEPTION 'a newer version is already active' USING ERRCODE = 'check_violation', HINT = 'hubs.config_stale';
  END IF;
  SELECT c.id INTO v_counsel FROM trustwork.counsel_approval c WHERE c.hub_id = v_before.hub_id AND p_document = ANY (c.document_version_ids)
   ORDER BY c.recorded_at DESC, c.id LIMIT 1;
  IF v_counsel IS NULL THEN
    RAISE EXCEPTION 'record the counsel approval of this version first' USING ERRCODE = 'check_violation', HINT = 'hubs.counsel_approval_required';
  END IF;
  IF p_approval_id IS NULL THEN
    RAISE EXCEPTION 'activating a legal document needs a second person''s approval' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_required';
  END IF;
  PERFORM trustwork.admin_consume_approval(p_approval_id, 'legal.activate_document_version', 'hub', NULL, v_before.hub_id,
    trustwork.hubs_legal_digest(v_before.id, v_before.hub_id, v_before.kind, v_before.locale, v_before.version, v_before.body_digest, v_counsel), v_before.id);
  UPDATE trustwork.legal_document_version SET status = 'superseded'
   WHERE hub_id = v_before.hub_id AND kind = v_before.kind AND locale = v_before.locale AND status = 'active';
  UPDATE trustwork.legal_document_version SET status = 'active', activated_by = v_actor.person_id, activated_at = now(), approval_id = p_approval_id, counsel_approval_id = v_counsel
   WHERE id = p_document RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'legal.document_activated', 'legal_document_version', v_row.id,
    jsonb_build_object('status', v_before.status, 'revision', v_before.revision),
    jsonb_build_object('id', v_row.id, 'kind', v_row.kind, 'locale', v_row.locale, 'version', v_row.version, 'bodyDigest', v_row.body_digest, 'status', v_row.status,
      'counselApprovalId', v_row.counsel_approval_id, 'revision', v_row.revision), NULL, p_approval_id);
  RETURN v_row;
END $$;

-- A participant records that they accepted an active legal document version (the exact text by its digest).
CREATE FUNCTION trustwork.hubs_accept_legal_document(p_document uuid, p_context text) RETURNS trustwork.legal_acceptance
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.admin_require_caller();
  v_row trustwork.legal_acceptance%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM trustwork.legal_document_version d JOIN trustwork.hub h ON h.id = d.hub_id
                 WHERE d.id = p_document AND d.status = 'active' AND h.lifecycle NOT IN ('draft', 'preparing', 'closed')) THEN
    RAISE EXCEPTION 'no such active document' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  INSERT INTO trustwork.legal_acceptance (person_id, legal_document_version_id, context) VALUES (v_person, p_document, p_context)
  ON CONFLICT (person_id, legal_document_version_id, context) DO NOTHING RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN
    SELECT * INTO v_row FROM trustwork.legal_acceptance WHERE person_id = v_person AND legal_document_version_id = p_document AND context = p_context;
  END IF;
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.hubs_register_credential(p_ctx jsonb, p_hub uuid, p_provider text, p_adapter text, p_mode text, p_store text, p_ref text) RETURNS trustwork.provider_credential_ref
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_row trustwork.provider_credential_ref%ROWTYPE;
BEGIN
  PERFORM trustwork.hubs_require_hub(p_hub);
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.providers.secret.write'], NULL, p_hub);
  INSERT INTO trustwork.provider_credential_ref (hub_id, provider, adapter, mode, secret_store, secret_ref, registered_by)
  VALUES (p_hub, p_provider, p_adapter, p_mode, p_store, p_ref, v_actor.person_id) RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'providers.credential_registered', 'provider_credential_ref', v_row.id, NULL,
    jsonb_build_object('id', v_row.id, 'provider', v_row.provider, 'adapter', v_row.adapter, 'mode', v_row.mode, 'secretStore', v_row.secret_store, 'revision', v_row.revision));
  RETURN v_row;
END $$;

-- Activates a reference; a non-fake one consumes a providers.enable_non_fake approval. The previous active reference
-- of the same provider is retired (rotation).
CREATE FUNCTION trustwork.hubs_activate_credential(p_ctx jsonb, p_credential uuid, p_approval_id uuid) RETURNS trustwork.provider_credential_ref
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_before trustwork.provider_credential_ref%ROWTYPE;
  v_row trustwork.provider_credential_ref%ROWTYPE;
  v_previous uuid;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_before FROM trustwork.provider_credential_ref WHERE id = p_credential;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such credential reference' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.providers.toggle'], NULL, v_before.hub_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('trustwork.credential:' || v_before.hub_id::text || ':' || v_before.provider, 0));
  SELECT * INTO v_before FROM trustwork.provider_credential_ref WHERE id = p_credential FOR UPDATE;
  IF v_before.status <> 'registered' THEN
    RAISE EXCEPTION 'the reference is %', v_before.status USING ERRCODE = 'check_violation', HINT = 'hubs.invalid_transition';
  END IF;
  IF v_before.mode <> 'fake' THEN
    IF p_approval_id IS NULL THEN
      RAISE EXCEPTION 'enabling a non-fake provider needs a second person''s approval' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_required';
    END IF;
    PERFORM trustwork.admin_consume_approval(p_approval_id, 'providers.enable_non_fake', 'hub', NULL, v_before.hub_id,
      trustwork.hubs_credential_digest(v_before.id, v_before.hub_id, v_before.provider, v_before.adapter, v_before.mode, v_before.secret_store, v_before.secret_ref), v_before.id);
  END IF;
  UPDATE trustwork.provider_credential_ref SET status = 'retired', retired_by = v_actor.person_id
   WHERE hub_id = v_before.hub_id AND provider = v_before.provider AND status = 'active' RETURNING id INTO v_previous;
  UPDATE trustwork.provider_credential_ref SET status = 'active', activated_by = v_actor.person_id, activated_at = now(),
    approval_id = CASE WHEN v_before.mode = 'fake' THEN NULL ELSE p_approval_id END, rotated_from_id = v_previous
   WHERE id = p_credential RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'providers.credential_activated', 'provider_credential_ref', v_row.id,
    jsonb_build_object('status', v_before.status, 'revision', v_before.revision),
    jsonb_build_object('status', v_row.status, 'mode', v_row.mode, 'rotatedFromId', v_row.rotated_from_id, 'revision', v_row.revision),
    NULL, CASE WHEN v_before.mode = 'fake' THEN NULL ELSE p_approval_id END);
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.hubs_retire_credential(p_ctx jsonb, p_credential uuid) RETURNS trustwork.provider_credential_ref
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_before trustwork.provider_credential_ref%ROWTYPE;
  v_row trustwork.provider_credential_ref%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_before FROM trustwork.provider_credential_ref WHERE id = p_credential FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such credential reference' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.providers.toggle'], NULL, v_before.hub_id);
  IF v_before.status = 'retired' THEN
    RAISE EXCEPTION 'the reference is already retired' USING ERRCODE = 'check_violation', HINT = 'hubs.invalid_transition';
  END IF;
  UPDATE trustwork.provider_credential_ref SET status = 'retired', retired_by = v_actor.person_id WHERE id = p_credential RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'providers.credential_retired', 'provider_credential_ref', v_row.id,
    jsonb_build_object('status', v_before.status, 'revision', v_before.revision), jsonb_build_object('status', v_row.status, 'revision', v_row.revision));
  RETURN v_row;
END $$;

-- 10. Readers -----------------------------------------------------------------------------------------------------------
-- Row-level security: may the caller read this hub's configuration records (staff holding a hub console permission at
-- a scope that covers the hub)?
CREATE FUNCTION trustwork.hubs_staff_reader(p_hub uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND p_hub IS NOT NULL
    AND (SELECT r.role FROM trustwork.admin_resolve_any(trustwork.current_person_id(), trustwork.hubs_reader_permissions(), NULL, p_hub) r) IS NOT NULL
$$;
-- The blockers of a transition, for the console to explain a refusal before asking a second person. Staff readers only.
CREATE FUNCTION trustwork.hubs_transition_blockers(p_hub uuid, p_target text) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF NOT trustwork.hubs_staff_reader(p_hub) THEN
    RAISE EXCEPTION 'no such hub' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  RETURN trustwork.hubs_blockers(p_hub, p_target);
END $$;
-- The engine's own view of each gate's precondition, for the checklist (staff readers only).
CREATE FUNCTION trustwork.hubs_gate_preconditions(p_hub uuid) RETURNS TABLE (gate text, precondition boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF NOT trustwork.hubs_staff_reader(p_hub) THEN
    RAISE EXCEPTION 'no such hub' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  RETURN QUERY SELECT g, trustwork.hubs_gate_precondition(p_hub, g) FROM unnest(trustwork.hubs_launch_gates()) g;
END $$;
-- The active presentation settings a runtime loader reads without a principal (CFG-001's identity and country, and the
-- modes): public facts of the deployment, never a sensitive domain.
CREATE FUNCTION trustwork.hubs_public_config(p_hub uuid, p_domain text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF p_domain NOT IN ('identity', 'country', 'modes') THEN
    RAISE EXCEPTION 'only presentation domains are public' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.forbidden';
  END IF;
  RETURN trustwork.hubs_active_payload(p_hub, p_domain);
END $$;

-- Is this version the current one of its hub and domain (the public disclosure of retention periods)?
CREATE FUNCTION trustwork.hubs_version_current(p_version uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT EXISTS (SELECT 1 FROM trustwork.hub_config_current c WHERE c.version_id = p_version)
$$;

-- 11. Row-level security and grants -----------------------------------------------------------------------------------
ALTER TABLE trustwork.hub_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.hub_profile FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.hub_config_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.hub_config_version FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.hub_config_current ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.hub_config_current FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.launch_gate ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.launch_gate FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.counsel_approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.counsel_approval FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.legal_document_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.legal_document_version FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.legal_acceptance ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.legal_acceptance FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.provider_credential_ref ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.provider_credential_ref FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.retention_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.retention_policy FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.hub_profile AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.hub_config_version AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.hub_config_current AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.launch_gate AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.counsel_approval AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.legal_document_version AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.legal_acceptance AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.provider_credential_ref AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.retention_policy AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

-- Staff of a hub see it before soft launch too (the kernel shows hubs to everyone only from soft launch).
CREATE POLICY hub_staff_read ON trustwork.hub FOR SELECT TO trustwork_app USING (trustwork.hubs_staff_reader(id));
-- Profiles follow the hub's visibility (public from soft launch, staff always).
CREATE POLICY hub_profile_read ON trustwork.hub_profile FOR SELECT TO trustwork_app USING (EXISTS (SELECT 1 FROM trustwork.hub h WHERE h.id = hub_id));
-- Configuration, gates, counsel records and credential references: staff of the hub only.
CREATE POLICY hub_config_version_read ON trustwork.hub_config_version FOR SELECT TO trustwork_app USING (trustwork.hubs_staff_reader(hub_id));
CREATE POLICY hub_config_current_read ON trustwork.hub_config_current FOR SELECT TO trustwork_app USING (trustwork.hubs_staff_reader(hub_id));
CREATE POLICY launch_gate_read ON trustwork.launch_gate FOR SELECT TO trustwork_app USING (trustwork.hubs_staff_reader(hub_id));
CREATE POLICY counsel_approval_read ON trustwork.counsel_approval FOR SELECT TO trustwork_app USING (trustwork.hubs_staff_reader(hub_id));
CREATE POLICY provider_credential_ref_read ON trustwork.provider_credential_ref FOR SELECT TO trustwork_app USING (trustwork.hubs_staff_reader(hub_id));
-- Active legal texts and the disclosed retention periods are public where the hub is; drafts are staff only.
CREATE POLICY legal_document_version_read ON trustwork.legal_document_version FOR SELECT TO trustwork_app
  USING (trustwork.hubs_staff_reader(hub_id) OR (status = 'active' AND EXISTS (SELECT 1 FROM trustwork.hub h WHERE h.id = hub_id)));
CREATE POLICY retention_policy_read ON trustwork.retention_policy FOR SELECT TO trustwork_app
  USING (trustwork.hubs_staff_reader(hub_id) OR (trustwork.hubs_version_current(config_version_id)
    AND EXISTS (SELECT 1 FROM trustwork.hub h WHERE h.id = hub_id AND h.lifecycle NOT IN ('draft', 'preparing'))));
-- A person sees their own acceptances.
CREATE POLICY legal_acceptance_read ON trustwork.legal_acceptance FOR SELECT TO trustwork_app USING (person_id = trustwork.current_person_id());

GRANT SELECT ON trustwork.hub_profile, trustwork.hub_config_version, trustwork.hub_config_current, trustwork.launch_gate, trustwork.counsel_approval,
  trustwork.legal_document_version, trustwork.legal_acceptance, trustwork.provider_credential_ref, trustwork.retention_policy TO trustwork_app;
GRANT EXECUTE ON FUNCTION
  trustwork.hubs_create(jsonb, text, jsonb, text, text[], text, text, text, text, jsonb),
  trustwork.hubs_update_profile(jsonb, uuid, integer, jsonb, text, text[], text, text, text),
  trustwork.hubs_add_territory(jsonb, uuid, text, text), trustwork.hubs_remove_territory(jsonb, uuid, uuid),
  trustwork.hubs_draft_config(jsonb, uuid, text, jsonb, text), trustwork.hubs_cancel_config(jsonb, uuid), trustwork.hubs_activate_config(jsonb, uuid, integer, uuid),
  trustwork.hubs_check_gate(jsonb, uuid, text, uuid), trustwork.hubs_invalidate_gate(jsonb, uuid, text), trustwork.hubs_transition(jsonb, uuid, text, integer, uuid),
  trustwork.hubs_draft_legal_document(jsonb, uuid, text, text, text), trustwork.hubs_record_counsel_approval(jsonb, uuid, uuid[], text, text, date, text),
  trustwork.hubs_activate_legal_document(jsonb, uuid, integer, uuid), trustwork.hubs_accept_legal_document(uuid, text),
  trustwork.hubs_register_credential(jsonb, uuid, text, text, text, text, text), trustwork.hubs_activate_credential(jsonb, uuid, uuid), trustwork.hubs_retire_credential(jsonb, uuid),
  trustwork.hubs_staff_reader(uuid), trustwork.hubs_version_current(uuid), trustwork.hubs_transition_blockers(uuid, text), trustwork.hubs_gate_preconditions(uuid), trustwork.hubs_public_config(uuid, text),
  -- Invoker helpers: vocabularies and the digests a console shows a second person (pure functions of their inputs).
  trustwork.hubs_config_domains(), trustwork.hubs_sensitive_domains(), trustwork.hubs_domain_action(text), trustwork.hubs_domain_permissions(text), trustwork.hubs_launch_gates(),
  trustwork.hubs_required_gates(text), trustwork.hubs_transition_allowed(text, text), trustwork.hubs_config_digest(uuid, uuid, text, integer, text),
  trustwork.hubs_transition_digest(uuid, text, text, integer), trustwork.hubs_legal_digest(uuid, uuid, text, text, integer, text, uuid),
  trustwork.hubs_credential_digest(uuid, uuid, text, text, text, text, text)
TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
