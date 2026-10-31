-- CNT-001: publications, corrections and curated issues (docs/engine/publishing.md, docs/engine/magazine.md,
-- docs/data/model.md sections 10 and 11). Mirrors packages/contracts/src/content.ts (PublicationSchema,
-- PublicationVersionSchema, AuthorshipSchema, CorrectionSchema, IssueSchema and the two transition tables).
--
-- One store for everything published. A publication is hub-scoped and owned by exactly one actor: a person, a company
-- (members holding company.publish act for it) or the hub's editorial office (staff holding admin.publications.* at
-- the hub, through an elevated session; every staff write records an admin_audit_event in the same transaction).
-- Authorship credit (publication_authorship) and editing rights (publication_editor) are separate records: being
-- credited never lets anyone edit, and editing never adds a credit.
--
-- Immutability: a publication version is frozen once it leaves `draft` (reject_update_when_frozen, every role,
-- maintenance included); a correction is a new published version with correction_of and a reader-visible note plus an
-- append-only `correction` row; a released issue revision and its items never change, and a correction of an issue is
-- a new revision (edition) that pins the corrected versions. Nothing here is ever deleted by the runtime role, which
-- holds SELECT only: every write goes through the SECURITY DEFINER commands below.
--
-- Public projection: only through the content_public_* functions, identical for every caller. A publication is public
-- when it has been published (published, corrected or retracted) and no moderation hold or removal applies; a held
-- item keeps its slot in a released issue but shows no content. A retraction keeps an explanatory record visible and
-- withholds the body. A person named in a publication is linked only with a live mentioned_in_publication consent
-- (profiles_consented_mentions, PPL-001).
--
-- Sources: news names at least one source and the event time; every cited source carries a licence label and the
-- hub-console AllowedUses flags (packages/contracts/src/hub.ts). Publishing refuses a version whose treatment or
-- assistant use the licences forbid; a magazine digest shows the full text only for cc_by publications whose sources
-- all allow syndication, otherwise headline and link.
--
-- No readership, traffic, price or paywall column exists anywhere in this slice (R18: the personal journal is open
-- and has no schema; the earlier "one free issue, then paywall" idea was rejected).

-- 1. Vocabularies -------------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.content_publication_transition_ok(p_from text, p_to text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT (p_from, p_to) IN (('draft', 'in_review'), ('draft', 'scheduled'), ('draft', 'published'), ('in_review', 'draft'), ('in_review', 'scheduled'),
    ('in_review', 'published'), ('scheduled', 'draft'), ('scheduled', 'published'), ('published', 'corrected'), ('published', 'retracted'),
    ('corrected', 'corrected'), ('corrected', 'retracted'))
$$;
CREATE FUNCTION trustwork.content_issue_transition_ok(p_from text, p_to text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT (p_from, p_to) IN (('draft', 'curated'), ('curated', 'review'), ('curated', 'draft'), ('review', 'released'), ('review', 'curated'),
    ('released', 'corrected'), ('corrected', 'corrected'))
$$;
CREATE FUNCTION trustwork.content_iso(p_at timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN p_at IS NULL THEN NULL ELSE to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
$$;

-- 2. Publications -------------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.publication (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  format text NOT NULL CHECK (format IN ('news', 'article', 'magazine_piece', 'company_post', 'personal_post')),
  article_format text NULL CHECK (article_format IN ('analysis', 'practice', 'overview', 'experience', 'interview', 'project_story')),
  owner_kind text NOT NULL CHECK (owner_kind IN ('person', 'company', 'editorial')),
  owner_person_id uuid NULL REFERENCES trustwork.person (id),
  owner_company_id uuid NULL REFERENCES trustwork.company (id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_review', 'scheduled', 'published', 'corrected', 'retracted')),
  original_language text NOT NULL CHECK (original_language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$'),
  licence text NOT NULL DEFAULT 'all_rights' CHECK (licence IN ('all_rights', 'cc_by')),
  requires_review boolean NOT NULL,
  current_version integer NULL CHECK (current_version >= 1),
  current_version_id uuid NULL,
  scheduled_for timestamptz NULL,
  first_published_at timestamptz NULL,
  moderation_state text NOT NULL DEFAULT 'none' CHECK (moderation_state IN ('none', 'held', 'removed')),
  held_by_case_id uuid NULL REFERENCES trustwork.moderation_case (id),
  retraction_note text NULL CHECK (length(retraction_note) BETWEEN 1 AND 500),
  retracted_at timestamptz NULL,
  retracted_by uuid NULL REFERENCES trustwork.person (id),
  created_by uuid NOT NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT publication_owner_shape CHECK ((owner_kind = 'person') = (owner_person_id IS NOT NULL) AND (owner_kind = 'company') = (owner_company_id IS NOT NULL)),
  CONSTRAINT publication_format_owner CHECK ((format <> 'personal_post' OR owner_kind = 'person') AND (format <> 'company_post' OR owner_kind = 'company')
    AND (format <> 'magazine_piece' OR owner_kind = 'editorial')),
  CONSTRAINT publication_article_format CHECK (article_format IS NULL OR format IN ('article', 'magazine_piece')),
  CONSTRAINT publication_editorial_review CHECK (owner_kind <> 'editorial' OR requires_review),
  CONSTRAINT publication_current CHECK ((current_version IS NULL) = (current_version_id IS NULL)),
  CONSTRAINT publication_published_has_version CHECK (status IN ('draft', 'in_review', 'scheduled') OR current_version IS NOT NULL),
  CONSTRAINT publication_scheduled CHECK ((status = 'scheduled') = (scheduled_for IS NOT NULL)),
  CONSTRAINT publication_retraction CHECK ((status = 'retracted') = (retraction_note IS NOT NULL) AND (retraction_note IS NULL) = (retracted_at IS NULL)
    AND (retracted_at IS NULL) = (retracted_by IS NULL)),
  CONSTRAINT publication_moderation CHECK ((moderation_state = 'none') = (held_by_case_id IS NULL))
);
CREATE INDEX publication_hub_feed_idx ON trustwork.publication (hub_id, status, first_published_at DESC);
CREATE INDEX publication_owner_person_idx ON trustwork.publication (owner_person_id) WHERE owner_person_id IS NOT NULL;
CREATE INDEX publication_owner_company_idx ON trustwork.publication (owner_company_id) WHERE owner_company_id IS NOT NULL;
CREATE TRIGGER publication_touch BEFORE UPDATE ON trustwork.publication FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- Identity never changes; the status follows the contract table; the current version only moves forward.
CREATE FUNCTION trustwork.content_publication_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'publications are retained; retract them' USING ERRCODE = 'integrity_constraint_violation', HINT = 'content.retained';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.current_version IS NOT NULL OR NEW.moderation_state <> 'none' THEN
      RAISE EXCEPTION 'a publication starts as an unheld draft' USING ERRCODE = 'check_violation', HINT = 'content.invalid_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.hub_id <> OLD.hub_id OR NEW.format <> OLD.format OR NEW.owner_kind <> OLD.owner_kind OR NEW.owner_person_id IS DISTINCT FROM OLD.owner_person_id
     OR NEW.owner_company_id IS DISTINCT FROM OLD.owner_company_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
     OR NEW.original_language <> OLD.original_language OR (NEW.requires_review IS DISTINCT FROM OLD.requires_review)
     OR (OLD.first_published_at IS NOT NULL AND NEW.first_published_at IS DISTINCT FROM OLD.first_published_at)
     OR (OLD.first_published_at IS NOT NULL AND (NEW.licence <> OLD.licence OR NEW.article_format IS DISTINCT FROM OLD.article_format)) THEN
    RAISE EXCEPTION 'publication identity is immutable' USING ERRCODE = 'integrity_constraint_violation', HINT = 'content.immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT trustwork.content_publication_transition_ok(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'publication % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'content.invalid_transition';
  END IF;
  IF OLD.current_version IS NOT NULL AND (NEW.current_version IS NULL OR NEW.current_version < OLD.current_version) THEN
    RAISE EXCEPTION 'the current version only moves forward' USING ERRCODE = 'check_violation', HINT = 'content.immutable';
  END IF;
  IF OLD.status = 'retracted' AND (NEW.retraction_note IS DISTINCT FROM OLD.retraction_note OR NEW.retracted_at IS DISTINCT FROM OLD.retracted_at
     OR NEW.current_version IS DISTINCT FROM OLD.current_version) THEN
    RAISE EXCEPTION 'a retraction is final' USING ERRCODE = 'integrity_constraint_violation', HINT = 'content.immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER publication_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.publication FOR EACH ROW EXECUTE FUNCTION trustwork.content_publication_guard();

-- Versions. source_refs: [{uri, name, kind, sourceTime, observedAt, license, allowedUses}] (validated by the API
-- contract and again at publication). content_digest = trustwork-digest-1 over
-- { title, body, sourceRefs: [{uri, sourceTime, observedAt, license}], eventTime, correctionOf, correctionNote, language },
-- computed here when the version is published.
CREATE TABLE trustwork.publication_version (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  publication_id uuid NOT NULL REFERENCES trustwork.publication (id),
  version integer NOT NULL CHECK (version >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(body) <= 20000),
  language text NOT NULL CHECK (language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$'),
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(source_refs) = 'array' AND jsonb_array_length(source_refs) <= 50),
  treatment text NOT NULL DEFAULT 'original_reporting' CHECK (treatment IN ('headline_link', 'summary', 'rewrite', 'translation', 'original_reporting')),
  event_time timestamptz NULL,
  assistant_assisted boolean NOT NULL DEFAULT false,
  correction_of integer NULL CHECK (correction_of >= 1),
  correction_note text NULL CHECK (length(correction_note) BETWEEN 1 AND 500),
  content_digest text NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  drafted_by uuid NOT NULL REFERENCES trustwork.person (id),
  published_at timestamptz NULL,
  published_by uuid NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT publication_version_number UNIQUE (publication_id, version),
  CONSTRAINT publication_version_pair UNIQUE (id, publication_id),
  CONSTRAINT publication_version_correction CHECK ((correction_of IS NULL) = (correction_note IS NULL) AND (correction_of IS NULL OR correction_of < version)),
  CONSTRAINT publication_version_published CHECK ((status = 'published') = (published_at IS NOT NULL) AND (published_at IS NULL) = (published_by IS NULL)
    AND (published_at IS NULL) = (content_digest IS NULL))
);
CREATE UNIQUE INDEX publication_version_one_draft ON trustwork.publication_version (publication_id) WHERE status = 'draft';
CREATE TRIGGER publication_version_touch BEFORE UPDATE ON trustwork.publication_version FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
CREATE TRIGGER publication_version_frozen BEFORE UPDATE ON trustwork.publication_version FOR EACH ROW
  EXECUTE FUNCTION trustwork.reject_update_when_frozen('status', 'draft', 'publication_id', 'version', 'title', 'body', 'language', 'source_refs', 'treatment', 'event_time',
    'assistant_assisted', 'correction_of', 'correction_note', 'content_digest', 'drafted_by', 'published_at', 'published_by');
CREATE TRIGGER publication_version_no_delete BEFORE DELETE ON trustwork.publication_version FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
ALTER TABLE trustwork.publication ADD CONSTRAINT publication_current_version FOREIGN KEY (current_version_id, id) REFERENCES trustwork.publication_version (id, publication_id);

-- Authorship credit: independent of editing rights; replaced only before the first publication, then frozen.
CREATE TABLE trustwork.publication_authorship (
  publication_id uuid NOT NULL REFERENCES trustwork.publication (id),
  position integer NOT NULL CHECK (position BETWEEN 1 AND 20),
  author_kind text NOT NULL CHECK (author_kind IN ('person', 'company', 'editorial')),
  author_person_id uuid NULL REFERENCES trustwork.person (id),
  author_company_id uuid NULL REFERENCES trustwork.company (id),
  credit text NOT NULL CHECK (length(credit) BETWEEN 1 AND 500),
  assistant_assisted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (publication_id, position),
  CONSTRAINT publication_authorship_shape CHECK ((author_kind = 'person') = (author_person_id IS NOT NULL) AND (author_kind = 'company') = (author_company_id IS NOT NULL))
);
CREATE FUNCTION trustwork.content_authorship_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_pub uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.publication_id ELSE NEW.publication_id END;
BEGIN
  IF TG_OP = 'UPDATE' OR EXISTS (SELECT 1 FROM trustwork.publication p WHERE p.id = v_pub AND p.first_published_at IS NOT NULL) THEN
    RAISE EXCEPTION 'authorship is frozen once published; a change is a correction' USING ERRCODE = 'integrity_constraint_violation', HINT = 'content.authorship_frozen';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER publication_authorship_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.publication_authorship FOR EACH ROW EXECUTE FUNCTION trustwork.content_authorship_guard();

-- Editing rights for person and company publications (the editorial office edits through staff permissions).
-- `edit` drafts; `publish` also publishes, corrects and retracts. Granted by the owner, revoked by the owner or the
-- editor; rows are revoked, never deleted.
CREATE TABLE trustwork.publication_editor (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  publication_id uuid NOT NULL REFERENCES trustwork.publication (id),
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  rights text NOT NULL CHECK (rights IN ('edit', 'publish')),
  granted_by uuid NOT NULL REFERENCES trustwork.person (id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz NULL,
  revoked_by uuid NULL REFERENCES trustwork.person (id),
  CONSTRAINT publication_editor_revocation CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CONSTRAINT publication_editor_not_self CHECK (person_id <> granted_by)
);
CREATE UNIQUE INDEX publication_editor_live ON trustwork.publication_editor (publication_id, person_id) WHERE revoked_at IS NULL;
CREATE INDEX publication_editor_person_idx ON trustwork.publication_editor (person_id) WHERE revoked_at IS NULL;
CREATE FUNCTION trustwork.content_editor_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND (OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
     OR ROW(NEW.id, NEW.publication_id, NEW.person_id, NEW.rights, NEW.granted_by, NEW.granted_at) IS DISTINCT FROM ROW(OLD.id, OLD.publication_id, OLD.person_id, OLD.rights, OLD.granted_by, OLD.granted_at))) THEN
    RAISE EXCEPTION 'an editing right only changes by revocation, once' USING ERRCODE = 'integrity_constraint_violation', HINT = 'content.immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER publication_editor_guard BEFORE UPDATE OR DELETE ON trustwork.publication_editor FOR EACH ROW EXECUTE FUNCTION trustwork.content_editor_guard();

-- Corrections (A): every wall and issue that points to the subject shows the notice. Publications: from/to version;
-- issues: from/to edition.
CREATE TABLE trustwork.correction (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  subject_kind text NOT NULL CHECK (subject_kind IN ('publication', 'issue')),
  publication_id uuid NULL REFERENCES trustwork.publication (id),
  issue_id uuid NULL,
  from_version integer NOT NULL CHECK (from_version >= 1),
  to_version integer NOT NULL CHECK (to_version >= 2),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  corrected_by uuid NOT NULL REFERENCES trustwork.person (id),
  corrected_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT correction_subject CHECK ((subject_kind = 'publication') = (publication_id IS NOT NULL) AND (subject_kind = 'issue') = (issue_id IS NOT NULL)),
  CONSTRAINT correction_forward CHECK (to_version > from_version)
);
CREATE INDEX correction_publication_idx ON trustwork.correction (publication_id) WHERE publication_id IS NOT NULL;
CREATE INDEX correction_issue_idx ON trustwork.correction (issue_id) WHERE issue_id IS NOT NULL;
CREATE TRIGGER correction_append_only BEFORE UPDATE OR DELETE ON trustwork.correction FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- Topics from the hub taxonomy (scheme `topic`, released, engine or this hub) and entity links; removed, never deleted.
CREATE TABLE trustwork.publication_topic (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  publication_id uuid NOT NULL REFERENCES trustwork.publication (id),
  term_id uuid NOT NULL REFERENCES trustwork.taxonomy_term (id),
  added_by uuid NOT NULL REFERENCES trustwork.person (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz NULL,
  removed_by uuid NULL REFERENCES trustwork.person (id),
  CONSTRAINT publication_topic_removal CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
CREATE UNIQUE INDEX publication_topic_live ON trustwork.publication_topic (publication_id, term_id) WHERE removed_at IS NULL;
CREATE FUNCTION trustwork.content_topic_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_term trustwork.taxonomy_term%ROWTYPE;
  v_hub uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO v_term FROM trustwork.taxonomy_term WHERE id = NEW.term_id;
    SELECT hub_id INTO v_hub FROM trustwork.publication WHERE id = NEW.publication_id;
    IF v_term.scheme <> 'topic' OR v_term.status <> 'released' OR (v_term.hub_id IS NOT NULL AND v_term.hub_id IS DISTINCT FROM v_hub) THEN
      RAISE EXCEPTION 'topics are released topic terms of the engine or this hub' USING ERRCODE = 'check_violation', HINT = 'content.unknown_topic';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' OR OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL OR NEW.term_id <> OLD.term_id OR NEW.publication_id <> OLD.publication_id THEN
    RAISE EXCEPTION 'a topic link is only removed, once' USING ERRCODE = 'integrity_constraint_violation', HINT = 'content.immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER publication_topic_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.publication_topic FOR EACH ROW EXECUTE FUNCTION trustwork.content_topic_guard();

-- Party links (contract entityLinks). A person link is projected only with that person's live consent.
CREATE TABLE trustwork.entity_link (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  publication_id uuid NOT NULL REFERENCES trustwork.publication (id),
  target_person_id uuid NULL REFERENCES trustwork.person (id),
  target_company_id uuid NULL REFERENCES trustwork.company (id),
  relation text NOT NULL CHECK (relation ~ '^[a-z][a-z0-9_]{0,39}$'),
  added_by uuid NOT NULL REFERENCES trustwork.person (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz NULL,
  removed_by uuid NULL REFERENCES trustwork.person (id),
  CONSTRAINT entity_link_target_xor CHECK ((target_person_id IS NULL) <> (target_company_id IS NULL)),
  CONSTRAINT entity_link_removal CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
CREATE UNIQUE INDEX entity_link_live ON trustwork.entity_link (publication_id, coalesce(target_person_id, target_company_id), relation) WHERE removed_at IS NULL;
CREATE FUNCTION trustwork.content_link_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL OR NEW.publication_id <> OLD.publication_id
     OR NEW.target_person_id IS DISTINCT FROM OLD.target_person_id OR NEW.target_company_id IS DISTINCT FROM OLD.target_company_id OR NEW.relation <> OLD.relation THEN
    RAISE EXCEPTION 'an entity link is only removed, once' USING ERRCODE = 'integrity_constraint_violation', HINT = 'content.immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER entity_link_guard BEFORE UPDATE OR DELETE ON trustwork.entity_link FOR EACH ROW EXECUTE FUNCTION trustwork.content_link_guard();

-- Linked editions: a translation is its own publication with its own versions; machine assistance stays labelled
-- until a person other than the translator reviews it.
CREATE TABLE trustwork.edition_link (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  original_publication_id uuid NOT NULL REFERENCES trustwork.publication (id),
  translation_publication_id uuid NOT NULL UNIQUE REFERENCES trustwork.publication (id),
  language text NOT NULL CHECK (language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$'),
  translator_person_id uuid NULL REFERENCES trustwork.person (id),
  machine_assisted boolean NOT NULL,
  reviewed_by uuid NULL REFERENCES trustwork.person (id),
  reviewed_at timestamptz NULL,
  created_by uuid NOT NULL REFERENCES trustwork.person (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT edition_link_distinct CHECK (original_publication_id <> translation_publication_id),
  CONSTRAINT edition_link_review CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL) AND (reviewed_by IS NULL OR reviewed_by IS DISTINCT FROM translator_person_id))
);
CREATE UNIQUE INDEX edition_link_language ON trustwork.edition_link (original_publication_id, language);
CREATE FUNCTION trustwork.content_edition_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.reviewed_by IS NOT NULL OR NEW.reviewed_by IS NULL
     OR ROW(NEW.id, NEW.original_publication_id, NEW.translation_publication_id, NEW.language, NEW.translator_person_id, NEW.machine_assisted, NEW.created_by, NEW.created_at)
        IS DISTINCT FROM ROW(OLD.id, OLD.original_publication_id, OLD.translation_publication_id, OLD.language, OLD.translator_person_id, OLD.machine_assisted, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'an edition link only records its review, once' USING ERRCODE = 'integrity_constraint_violation', HINT = 'content.immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER edition_link_guard BEFORE UPDATE OR DELETE ON trustwork.edition_link FOR EACH ROW EXECUTE FUNCTION trustwork.content_edition_guard();

-- Walls reference, never copy. publication_version_id NULL follows the current version.
CREATE TABLE trustwork.wall_reference (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  wall_kind text NOT NULL CHECK (wall_kind IN ('person', 'company')),
  wall_person_id uuid NULL REFERENCES trustwork.person (id),
  wall_company_id uuid NULL REFERENCES trustwork.company (id),
  publication_id uuid NOT NULL REFERENCES trustwork.publication (id),
  publication_version_id uuid NULL,
  position integer NOT NULL CHECK (position >= 1),
  pinned boolean NOT NULL DEFAULT false,
  added_by uuid NOT NULL REFERENCES trustwork.person (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz NULL,
  removed_by uuid NULL REFERENCES trustwork.person (id),
  CONSTRAINT wall_reference_owner CHECK ((wall_kind = 'person') = (wall_person_id IS NOT NULL) AND (wall_kind = 'company') = (wall_company_id IS NOT NULL)),
  CONSTRAINT wall_reference_version FOREIGN KEY (publication_version_id, publication_id) REFERENCES trustwork.publication_version (id, publication_id),
  CONSTRAINT wall_reference_removal CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
CREATE UNIQUE INDEX wall_reference_live ON trustwork.wall_reference (coalesce(wall_person_id, wall_company_id), publication_id) WHERE removed_at IS NULL;
CREATE FUNCTION trustwork.content_wall_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL
     OR ROW(NEW.wall_kind, NEW.wall_person_id, NEW.wall_company_id, NEW.publication_id, NEW.publication_version_id, NEW.position, NEW.pinned)
        IS DISTINCT FROM ROW(OLD.wall_kind, OLD.wall_person_id, OLD.wall_company_id, OLD.publication_id, OLD.publication_version_id, OLD.position, OLD.pinned) THEN
    RAISE EXCEPTION 'a wall reference is only removed, once' USING ERRCODE = 'integrity_constraint_violation', HINT = 'content.immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wall_reference_guard BEFORE UPDATE OR DELETE ON trustwork.wall_reference FOR EACH ROW EXECUTE FUNCTION trustwork.content_wall_guard();

-- Comments: signed-in people only, under the hub's community rules (the API keeps them off unless the hub enables
-- them); held and removed only through moderation cases.
CREATE TABLE trustwork.publication_comment (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  publication_id uuid NOT NULL REFERENCES trustwork.publication (id),
  author_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  parent_id uuid NULL REFERENCES trustwork.publication_comment (id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  status text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'held', 'removed')),
  moderation_case_id uuid NULL REFERENCES trustwork.moderation_case (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT publication_comment_moderation CHECK ((status = 'visible') OR moderation_case_id IS NOT NULL)
);
CREATE INDEX publication_comment_publication_idx ON trustwork.publication_comment (publication_id, created_at);
CREATE TRIGGER publication_comment_touch BEFORE UPDATE ON trustwork.publication_comment FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
CREATE FUNCTION trustwork.content_comment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.body <> OLD.body OR NEW.author_person_id <> OLD.author_person_id OR NEW.publication_id <> OLD.publication_id
     OR NEW.parent_id IS DISTINCT FROM OLD.parent_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'comments are retained as written; moderation changes their status' USING ERRCODE = 'integrity_constraint_violation', HINT = 'content.immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER publication_comment_guard BEFORE UPDATE OR DELETE ON trustwork.publication_comment FOR EACH ROW EXECUTE FUNCTION trustwork.content_comment_guard();

-- 3. Magazine -------------------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.issue (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  number integer NOT NULL CHECK (number >= 1),
  issue_date date NOT NULL,
  theme text NULL CHECK (length(theme) BETWEEN 1 AND 200),
  cover_asset_id uuid NULL REFERENCES trustwork.evidence_artifact (id),
  editor_letter_publication_id uuid NULL REFERENCES trustwork.publication (id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'curated', 'review', 'released', 'corrected')),
  current_edition integer NULL CHECK (current_edition >= 1),
  created_by uuid NOT NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT issue_number_per_hub UNIQUE (hub_id, number),
  CONSTRAINT issue_released_edition CHECK ((status IN ('released', 'corrected')) = (current_edition IS NOT NULL))
);
ALTER TABLE trustwork.correction ADD CONSTRAINT correction_issue FOREIGN KEY (issue_id) REFERENCES trustwork.issue (id);
CREATE TRIGGER issue_touch BEFORE UPDATE ON trustwork.issue FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
CREATE FUNCTION trustwork.content_issue_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'issues are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'content.retained';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.current_edition IS NOT NULL THEN
      RAISE EXCEPTION 'an issue starts as a draft' USING ERRCODE = 'check_violation', HINT = 'content.invalid_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.hub_id <> OLD.hub_id OR NEW.number <> OLD.number OR NEW.created_by <> OLD.created_by
     OR (OLD.current_edition IS NOT NULL AND (NEW.issue_date <> OLD.issue_date OR NEW.theme IS DISTINCT FROM OLD.theme OR NEW.cover_asset_id IS DISTINCT FROM OLD.cover_asset_id
         OR NEW.editor_letter_publication_id IS DISTINCT FROM OLD.editor_letter_publication_id OR NEW.current_edition < OLD.current_edition)) THEN
    RAISE EXCEPTION 'a released issue keeps its identity, date and cover; corrections are new editions' USING ERRCODE = 'integrity_constraint_violation', HINT = 'content.issue_frozen';
  END IF;
  IF NEW.status <> OLD.status AND NOT trustwork.content_issue_transition_ok(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'issue % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'content.invalid_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER issue_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.issue FOR EACH ROW EXECUTE FUNCTION trustwork.content_issue_guard();

-- Revisions (V): edition 1 is the first release; every correction is a new edition with a note. digest =
-- trustwork-digest-1 over { issueNumber, date, items: [{ position, publicationId, publicationVersion, section }] }.
CREATE TABLE trustwork.issue_revision (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  issue_id uuid NOT NULL REFERENCES trustwork.issue (id),
  edition integer NOT NULL CHECK (edition >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'released')),
  digest text NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  correction_note text NULL CHECK (length(correction_note) BETWEEN 1 AND 500),
  released_at timestamptz NULL,
  released_by uuid NULL REFERENCES trustwork.person (id),
  created_by uuid NOT NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT issue_revision_edition UNIQUE (issue_id, edition),
  CONSTRAINT issue_revision_note CHECK ((edition = 1) = (correction_note IS NULL)),
  CONSTRAINT issue_revision_released CHECK ((status = 'released') = (released_at IS NOT NULL) AND (released_at IS NULL) = (released_by IS NULL) AND (released_at IS NULL) = (digest IS NULL))
);
CREATE UNIQUE INDEX issue_revision_one_draft ON trustwork.issue_revision (issue_id) WHERE status = 'draft';
CREATE TRIGGER issue_revision_touch BEFORE UPDATE ON trustwork.issue_revision FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
CREATE TRIGGER issue_revision_frozen BEFORE UPDATE ON trustwork.issue_revision FOR EACH ROW
  EXECUTE FUNCTION trustwork.reject_update_when_frozen('status', 'draft', 'issue_id', 'edition', 'digest', 'correction_note', 'released_at', 'released_by', 'created_by');
CREATE TRIGGER issue_revision_no_delete BEFORE DELETE ON trustwork.issue_revision FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- Items pin exact publication versions; they change only while their revision is a draft (every role).
CREATE TABLE trustwork.issue_item (
  issue_revision_id uuid NOT NULL REFERENCES trustwork.issue_revision (id),
  position integer NOT NULL CHECK (position BETWEEN 1 AND 500),
  section text NOT NULL CHECK (length(section) BETWEEN 1 AND 500),
  publication_id uuid NOT NULL REFERENCES trustwork.publication (id),
  publication_version_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issue_revision_id, position),
  CONSTRAINT issue_item_version FOREIGN KEY (publication_version_id, publication_id) REFERENCES trustwork.publication_version (id, publication_id)
);
CREATE UNIQUE INDEX issue_item_once ON trustwork.issue_item (issue_revision_id, publication_id);
CREATE FUNCTION trustwork.content_issue_item_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_revision uuid := CASE WHEN TG_OP = 'INSERT' THEN NEW.issue_revision_id ELSE OLD.issue_revision_id END;
  v_status text;
  v_issue_hub uuid;
  v_pub trustwork.publication%ROWTYPE;
BEGIN
  SELECT r.status, i.hub_id INTO v_status, v_issue_hub FROM trustwork.issue_revision r JOIN trustwork.issue i ON i.id = r.issue_id WHERE r.id = v_revision;
  IF v_status IS DISTINCT FROM 'draft' OR (TG_OP = 'UPDATE' AND NEW.issue_revision_id <> OLD.issue_revision_id) THEN
    RAISE EXCEPTION 'items of a released issue revision are frozen' USING ERRCODE = 'integrity_constraint_violation', HINT = 'content.issue_frozen';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  SELECT * INTO v_pub FROM trustwork.publication WHERE id = NEW.publication_id;
  IF v_pub.hub_id <> v_issue_hub THEN
    RAISE EXCEPTION 'an issue pins publications of its own hub' USING ERRCODE = 'check_violation', HINT = 'content.other_hub';
  END IF;
  IF v_pub.status = 'retracted' THEN
    RAISE EXCEPTION 'a retracted publication is not pinned into a new revision' USING ERRCODE = 'check_violation', HINT = 'content.retracted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trustwork.publication_version v WHERE v.id = NEW.publication_version_id AND v.status = 'published') THEN
    RAISE EXCEPTION 'an issue pins published versions only' USING ERRCODE = 'check_violation', HINT = 'content.version_not_published';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER issue_item_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.issue_item FOR EACH ROW EXECUTE FUNCTION trustwork.content_issue_item_guard();

-- Render artifacts: a separate artifact per released revision and format, recording what it renders. queued ->
-- rendered | failed; a rendered artifact never changes; re-rendering after a correction is a new row for the new edition.
CREATE TABLE trustwork.render_artifact (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  issue_revision_id uuid NOT NULL REFERENCES trustwork.issue_revision (id),
  format text NOT NULL CHECK (format IN ('web', 'pdf')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'rendered', 'failed')),
  artifact_id uuid NULL REFERENCES trustwork.evidence_artifact (id),
  sha256 text NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  renderer_version text NULL CHECK (length(renderer_version) BETWEEN 1 AND 60),
  failure_reason text NULL CHECK (length(failure_reason) BETWEEN 1 AND 500),
  requested_by uuid NOT NULL REFERENCES trustwork.person (id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT render_artifact_rendered CHECK ((status = 'rendered') = (sha256 IS NOT NULL) AND (status = 'rendered') = (renderer_version IS NOT NULL)
    AND (status = 'failed') = (failure_reason IS NOT NULL) AND (status = 'queued') = (completed_at IS NULL))
);
CREATE INDEX render_artifact_revision_idx ON trustwork.render_artifact (issue_revision_id);
CREATE TRIGGER render_artifact_touch BEFORE UPDATE ON trustwork.render_artifact FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
CREATE FUNCTION trustwork.content_render_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'render records are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'content.retained';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'queued' OR NOT EXISTS (SELECT 1 FROM trustwork.issue_revision r WHERE r.id = NEW.issue_revision_id AND r.status = 'released') THEN
      RAISE EXCEPTION 'renders start queued, for a released revision' USING ERRCODE = 'check_violation', HINT = 'content.render_not_allowed';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'queued' OR NEW.status = 'queued' OR NEW.issue_revision_id <> OLD.issue_revision_id OR NEW.format <> OLD.format OR NEW.requested_by <> OLD.requested_by
     OR NEW.requested_at <> OLD.requested_at THEN
    RAISE EXCEPTION 'a render completes once and never changes' USING ERRCODE = 'integrity_constraint_violation', HINT = 'content.immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER render_artifact_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.render_artifact FOR EACH ROW EXECUTE FUNCTION trustwork.content_render_guard();

-- Magazine digests reference items by home node, global id, version and licence; the licence decides full text or
-- headline and link. Items of this node are pinned to the local version as well. Released digests never change.
CREATE TABLE trustwork.magazine_digest (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  period text NOT NULL CHECK (period ~ '^[0-9]{4}(-[0-9]{2}){0,2}$|^[0-9]{4}-W[0-9]{2}$'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'released')),
  released_at timestamptz NULL,
  released_by uuid NULL REFERENCES trustwork.person (id),
  created_by uuid NOT NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT magazine_digest_released CHECK ((status = 'released') = (released_at IS NOT NULL) AND (released_at IS NULL) = (released_by IS NULL))
);
CREATE TRIGGER magazine_digest_touch BEFORE UPDATE ON trustwork.magazine_digest FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
CREATE TRIGGER magazine_digest_frozen BEFORE UPDATE ON trustwork.magazine_digest FOR EACH ROW
  EXECUTE FUNCTION trustwork.reject_update_when_frozen('status', 'draft', 'hub_id', 'title', 'period', 'released_at', 'released_by', 'created_by');
CREATE TRIGGER magazine_digest_no_delete BEFORE DELETE ON trustwork.magazine_digest FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

CREATE TABLE trustwork.magazine_digest_item (
  digest_id uuid NOT NULL REFERENCES trustwork.magazine_digest (id),
  position integer NOT NULL CHECK (position BETWEEN 1 AND 200),
  home_node text NOT NULL CHECK (home_node ~ '^[a-z0-9][a-z0-9.:-]{0,127}$'),
  global_id text NOT NULL CHECK (global_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  version integer NOT NULL CHECK (version >= 1),
  licence text NOT NULL CHECK (licence IN ('all_rights', 'cc_by')),
  display text NOT NULL CHECK (display IN ('full', 'headline_link')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  local_publication_id uuid NULL,
  local_version_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (digest_id, position),
  CONSTRAINT magazine_digest_item_local FOREIGN KEY (local_version_id, local_publication_id) REFERENCES trustwork.publication_version (id, publication_id),
  CONSTRAINT magazine_digest_item_local_pair CHECK ((local_publication_id IS NULL) = (local_version_id IS NULL)),
  CONSTRAINT magazine_digest_item_licence CHECK (display = 'headline_link' OR licence = 'cc_by')
);
CREATE FUNCTION trustwork.content_digest_item_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_digest uuid := CASE WHEN TG_OP = 'INSERT' THEN NEW.digest_id ELSE OLD.digest_id END;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM trustwork.magazine_digest d WHERE d.id = v_digest AND d.status = 'draft') OR (TG_OP = 'UPDATE' AND NEW.digest_id <> OLD.digest_id) THEN
    RAISE EXCEPTION 'items of a released digest are frozen' USING ERRCODE = 'integrity_constraint_violation', HINT = 'content.digest_frozen';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER magazine_digest_item_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.magazine_digest_item FOR EACH ROW EXECUTE FUNCTION trustwork.content_digest_item_guard();

-- 4. Authority helpers (invoker; called inside the SECURITY DEFINER commands, which run as the owner) ---------------
-- Does the caller act for the owner party (the person, or a member of the company holding company.publish)?
CREATE FUNCTION trustwork.content_acts_for(p_person uuid, p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.current_person_id() IS NOT NULL
    AND (coalesce(p_person = trustwork.current_person_id(), false)
         OR (p_company IS NOT NULL AND coalesce(p_company = trustwork.current_company_id(), false) AND trustwork.current_membership_has('company.publish')))
$$;
-- The caller's participant right on a person or company publication: 'owner', 'publish', 'edit' or NULL.
CREATE FUNCTION trustwork.content_right(p_pub trustwork.publication) RETURNS text
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT CASE
    WHEN p_pub.owner_kind = 'editorial' THEN NULL
    WHEN trustwork.content_acts_for(p_pub.owner_person_id, p_pub.owner_company_id) THEN 'owner'
    ELSE (SELECT e.rights FROM trustwork.publication_editor e WHERE e.publication_id = p_pub.id AND e.person_id = trustwork.current_person_id() AND e.revoked_at IS NULL) END
$$;
-- Participant authority for an action; raises when missing. p_need: 'edit' (edit or publish rights), 'publish'
-- (publish rights) or 'owner'.
CREATE FUNCTION trustwork.content_require_right(p_pub trustwork.publication, p_need text) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_right text := trustwork.content_right(p_pub);
BEGIN
  PERFORM trustwork.admin_require_caller();
  IF v_right IS NULL OR (p_need = 'owner' AND v_right <> 'owner') OR (p_need = 'publish' AND v_right NOT IN ('owner', 'publish')) THEN
    RAISE EXCEPTION 'the caller holds no % right on this publication', p_need USING ERRCODE = 'insufficient_privilege', HINT = 'content.not_authorised';
  END IF;
END $$;
-- Locks the publication of this hub (or refuses as not found) and checks the optimistic revision.
CREATE FUNCTION trustwork.content_lock(p_pub uuid, p_expected_revision integer) RETURNS trustwork.publication
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_row trustwork.publication%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM trustwork.publication WHERE id = p_pub FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'publication not found' USING ERRCODE = 'no_data_found', HINT = 'content.not_found';
  END IF;
  IF p_expected_revision IS NOT NULL AND v_row.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'the publication changed' USING ERRCODE = 'serialization_failure', HINT = 'content.revision_conflict';
  END IF;
  RETURN v_row;
END $$;
-- Editorial publications: an elevated staff member holding one of the permissions at the hub (records the actor);
-- other publications: NULL (participant rights apply).
CREATE FUNCTION trustwork.content_staff(p_ctx jsonb, p_permissions text[], p_hub uuid) RETURNS trustwork.admin_actor
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF p_ctx IS NULL THEN
    RAISE EXCEPTION 'editorial actions need an elevated staff session and a reason' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.elevation_required';
  END IF;
  RETURN trustwork.admin_authorize(p_ctx, p_permissions, NULL, p_hub);
END $$;

-- Licence and sourcing checks of a version about to be published; returns the blockers (empty = publishable).
CREATE FUNCTION trustwork.content_publication_blockers(p_pub trustwork.publication, p_version trustwork.publication_version) RETURNS text[]
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_out text[] := '{}';
  v_src jsonb;
  v_uses jsonb;
  v_assisted boolean := p_version.assistant_assisted OR EXISTS (SELECT 1 FROM trustwork.publication_authorship a WHERE a.publication_id = p_pub.id AND a.assistant_assisted);
BEGIN
  IF p_pub.format = 'news' AND jsonb_array_length(p_version.source_refs) = 0 THEN
    v_out := array_append(v_out, 'news_needs_source');
  END IF;
  IF p_pub.format = 'news' AND p_version.event_time IS NULL THEN
    v_out := array_append(v_out, 'news_needs_event_time');
  END IF;
  IF p_version.treatment = 'translation' AND p_version.language = p_pub.original_language AND NOT EXISTS (SELECT 1 FROM trustwork.edition_link l WHERE l.translation_publication_id = p_pub.id) THEN
    v_out := array_append(v_out, 'translation_needs_original');
  END IF;
  FOR v_src IN SELECT value FROM jsonb_array_elements(p_version.source_refs) LOOP
    IF jsonb_typeof(v_src) <> 'object' OR coalesce(v_src ->> 'uri', '') = '' OR coalesce(v_src ->> 'name', '') = '' OR coalesce(v_src ->> 'observedAt', '') = '' THEN
      v_out := array_append(v_out, 'source_incomplete');
      CONTINUE;
    END IF;
    CONTINUE WHEN v_src ->> 'kind' = 'own_reporting';
    v_uses := v_src -> 'allowedUses';
    IF coalesce(v_src ->> 'license', '') = '' OR jsonb_typeof(v_uses) IS DISTINCT FROM 'object' THEN
      v_out := array_append(v_out, 'source_licence_missing');
      CONTINUE;
    END IF;
    IF NOT coalesce((v_uses ->> 'displayHeadlineAndLink')::boolean, false) THEN v_out := array_append(v_out, 'licence_forbids_display'); END IF;
    IF p_version.treatment = 'summary' AND NOT coalesce((v_uses ->> 'displaySummary')::boolean, false) THEN v_out := array_append(v_out, 'licence_forbids_summary'); END IF;
    IF p_version.treatment = 'rewrite' AND NOT coalesce((v_uses ->> 'rewriteWithAttribution')::boolean, false) THEN v_out := array_append(v_out, 'licence_forbids_rewrite'); END IF;
    IF p_version.treatment = 'translation' AND NOT coalesce((v_uses ->> 'translate')::boolean, false) THEN v_out := array_append(v_out, 'licence_forbids_translation'); END IF;
    IF v_assisted AND NOT coalesce((v_uses ->> 'sendToModelProviders')::boolean, false) THEN v_out := array_append(v_out, 'licence_forbids_model_use'); END IF;
  END LOOP;
  RETURN ARRAY(SELECT DISTINCT b FROM unnest(v_out) b ORDER BY b);
END $$;

CREATE FUNCTION trustwork.content_version_digest(p_version trustwork.publication_version) RETURNS text
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.admin_digest(jsonb_build_object(
    'title', p_version.title, 'body', p_version.body, 'language', p_version.language,
    'sourceRefs', coalesce((SELECT jsonb_agg(jsonb_build_object('uri', s ->> 'uri', 'sourceTime', s -> 'sourceTime', 'observedAt', s ->> 'observedAt', 'license', s -> 'license') ORDER BY o)
                            FROM jsonb_array_elements(p_version.source_refs) WITH ORDINALITY x(s, o)), '[]'::jsonb),
    'eventTime', trustwork.content_iso(p_version.event_time), 'correctionOf', p_version.correction_of, 'correctionNote', p_version.correction_note))
$$;

-- Publishes the draft version now: blockers, digest, the version frozen, the publication pointer moved.
CREATE FUNCTION trustwork.content_release_version(p_pub trustwork.publication, p_version_id uuid, p_actor uuid, p_status text) RETURNS trustwork.publication
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_version trustwork.publication_version%ROWTYPE;
  v_blockers text[];
  v_row trustwork.publication%ROWTYPE;
BEGIN
  SELECT * INTO v_version FROM trustwork.publication_version WHERE id = p_version_id AND publication_id = p_pub.id AND status = 'draft' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no draft version to publish' USING ERRCODE = 'check_violation', HINT = 'content.no_draft';
  END IF;
  v_blockers := trustwork.content_publication_blockers(p_pub, v_version);
  IF cardinality(v_blockers) > 0 THEN
    RAISE EXCEPTION 'publication blocked: %', array_to_string(v_blockers, ', ') USING ERRCODE = 'check_violation', HINT = 'content.' || v_blockers[1];
  END IF;
  UPDATE trustwork.publication_version SET status = 'published', published_at = now(), published_by = p_actor, content_digest = trustwork.content_version_digest(v_version)
   WHERE id = v_version.id;
  UPDATE trustwork.publication SET status = p_status, current_version = v_version.version, current_version_id = v_version.id, scheduled_for = NULL,
         first_published_at = coalesce(first_published_at, now())
   WHERE id = p_pub.id RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- Writes a draft into the publication's single draft version (creating version current+1 when none exists).
CREATE FUNCTION trustwork.content_write_draft(p_pub trustwork.publication, p_draft jsonb, p_correction_of integer, p_correction_note text) RETURNS trustwork.publication_version
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_row trustwork.publication_version%ROWTYPE;
  v_next integer;
BEGIN
  IF p_draft IS NULL OR jsonb_typeof(p_draft) <> 'object' OR jsonb_typeof(p_draft -> 'sourceRefs') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'a draft needs title, body, language, sourceRefs, treatment' USING ERRCODE = 'invalid_parameter_value', HINT = 'content.invalid_draft';
  END IF;
  SELECT * INTO v_row FROM trustwork.publication_version WHERE publication_id = p_pub.id AND status = 'draft' FOR UPDATE;
  IF FOUND THEN
    UPDATE trustwork.publication_version SET title = p_draft ->> 'title', body = p_draft ->> 'body', language = p_draft ->> 'language', source_refs = p_draft -> 'sourceRefs',
           treatment = coalesce(p_draft ->> 'treatment', 'original_reporting'), event_time = (p_draft ->> 'eventTime')::timestamptz,
           assistant_assisted = coalesce((p_draft ->> 'assistantAssisted')::boolean, false), correction_of = p_correction_of, correction_note = p_correction_note,
           drafted_by = trustwork.current_person_id()
     WHERE id = v_row.id RETURNING * INTO v_row;
    RETURN v_row;
  END IF;
  SELECT coalesce(max(version), 0) + 1 INTO v_next FROM trustwork.publication_version WHERE publication_id = p_pub.id;
  INSERT INTO trustwork.publication_version (publication_id, version, title, body, language, source_refs, treatment, event_time, assistant_assisted, correction_of, correction_note, drafted_by)
  VALUES (p_pub.id, v_next, p_draft ->> 'title', p_draft ->> 'body', p_draft ->> 'language', p_draft -> 'sourceRefs', coalesce(p_draft ->> 'treatment', 'original_reporting'),
          (p_draft ->> 'eventTime')::timestamptz, coalesce((p_draft ->> 'assistantAssisted')::boolean, false), p_correction_of, p_correction_note, trustwork.current_person_id())
  RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- Replaces the authorship of a never-published publication. p_authorship: [{kind, id?, credit, assistantAssisted}].
CREATE FUNCTION trustwork.content_write_authorship(p_pub trustwork.publication, p_authorship jsonb) RETURNS void
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_a jsonb;
  v_pos integer := 0;
BEGIN
  IF p_authorship IS NULL OR jsonb_typeof(p_authorship) <> 'array' OR jsonb_array_length(p_authorship) NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'one to twenty authorship credits' USING ERRCODE = 'invalid_parameter_value', HINT = 'content.invalid_authorship';
  END IF;
  DELETE FROM trustwork.publication_authorship WHERE publication_id = p_pub.id;
  FOR v_a IN SELECT value FROM jsonb_array_elements(p_authorship) LOOP
    v_pos := v_pos + 1;
    IF v_a ->> 'kind' = 'editorial' AND p_pub.owner_kind <> 'editorial' THEN
      RAISE EXCEPTION 'only the editorial office credits itself' USING ERRCODE = 'check_violation', HINT = 'content.invalid_authorship';
    END IF;
    INSERT INTO trustwork.publication_authorship (publication_id, position, author_kind, author_person_id, author_company_id, credit, assistant_assisted)
    VALUES (p_pub.id, v_pos, v_a ->> 'kind', CASE WHEN v_a ->> 'kind' = 'person' THEN (v_a ->> 'id')::uuid END, CASE WHEN v_a ->> 'kind' = 'company' THEN (v_a ->> 'id')::uuid END,
            v_a ->> 'credit', coalesce((v_a ->> 'assistantAssisted')::boolean, false));
  END LOOP;
END $$;

-- 5. Commands (SECURITY DEFINER, executable by the runtime role) -------------------------------------------------------
-- Read helper for the row-level policies: the owner party, a live editor, or staff reading publications at the hub.
CREATE FUNCTION trustwork.content_can_view(p_pub uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND EXISTS (
    SELECT 1 FROM trustwork.publication p WHERE p.id = p_pub
      AND (trustwork.content_right(p) IS NOT NULL OR trustwork.admin_has_any_permission(ARRAY['admin.publications.read', 'admin.publications.review', 'admin.publications.publish'], NULL, p.hub_id)))
$$;

CREATE FUNCTION trustwork.content_create(p_ctx jsonb, p_hub uuid, p_owner_kind text, p_owner_company uuid, p_format text, p_article_format text, p_language text, p_licence text,
  p_requires_review boolean, p_draft jsonb, p_authorship jsonb) RETURNS trustwork.publication
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_me uuid := trustwork.admin_require_caller();
  v_actor trustwork.admin_actor;
  v_row trustwork.publication%ROWTYPE;
  v_version trustwork.publication_version%ROWTYPE;
BEGIN
  IF p_owner_kind = 'editorial' THEN
    v_actor := trustwork.content_staff(p_ctx, ARRAY['admin.publications.publish', 'admin.publications.review'], p_hub);
  ELSIF p_owner_kind = 'company' THEN
    IF p_owner_company IS NULL OR NOT trustwork.content_acts_for(NULL, p_owner_company) THEN
      RAISE EXCEPTION 'company publications are written by members holding company.publish' USING ERRCODE = 'insufficient_privilege', HINT = 'content.not_authorised';
    END IF;
  ELSIF p_owner_kind <> 'person' THEN
    RAISE EXCEPTION 'unknown owner kind' USING ERRCODE = 'invalid_parameter_value', HINT = 'content.invalid_owner';
  END IF;
  INSERT INTO trustwork.publication (hub_id, format, article_format, owner_kind, owner_person_id, owner_company_id, original_language, licence, requires_review, created_by)
  VALUES (p_hub, p_format, p_article_format, p_owner_kind, CASE WHEN p_owner_kind = 'person' THEN v_me END, CASE WHEN p_owner_kind = 'company' THEN p_owner_company END,
          p_language, coalesce(p_licence, 'all_rights'), p_owner_kind = 'editorial' OR coalesce(p_requires_review, false), v_me)
  RETURNING * INTO v_row;
  v_version := trustwork.content_write_draft(v_row, p_draft, NULL, NULL);
  PERFORM trustwork.content_write_authorship(v_row, p_authorship);
  IF v_actor.person_id IS NOT NULL THEN
    PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'publication.create', 'publication', v_row.id, NULL, to_jsonb(v_row));
  END IF;
  RETURN v_row;
END $$;

-- Saves the draft of a publication that is still a draft (after publication every change is a correction).
CREATE FUNCTION trustwork.content_save_draft(p_ctx jsonb, p_pub uuid, p_expected_revision integer, p_draft jsonb, p_authorship jsonb) RETURNS trustwork.publication
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.publication%ROWTYPE := trustwork.content_lock(p_pub, p_expected_revision);
  v_actor trustwork.admin_actor;
  v_before jsonb := to_jsonb(v_row);
BEGIN
  IF v_row.owner_kind = 'editorial' THEN
    v_actor := trustwork.content_staff(p_ctx, ARRAY['admin.publications.publish', 'admin.publications.review'], v_row.hub_id);
  ELSE
    PERFORM trustwork.content_require_right(v_row, 'edit');
  END IF;
  IF v_row.status <> 'draft' THEN
    RAISE EXCEPTION 'only drafts are edited; a published text is corrected' USING ERRCODE = 'check_violation', HINT = CASE WHEN v_row.first_published_at IS NULL THEN 'content.not_draft' ELSE 'content.use_correction' END;
  END IF;
  IF p_draft IS NOT NULL THEN
    PERFORM trustwork.content_write_draft(v_row, p_draft, NULL, NULL);
  END IF;
  IF p_authorship IS NOT NULL THEN
    PERFORM trustwork.content_write_authorship(v_row, p_authorship);
  END IF;
  UPDATE trustwork.publication SET updated_at = now() WHERE id = v_row.id RETURNING * INTO v_row;
  IF v_actor.person_id IS NOT NULL THEN
    PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'publication.draft_saved', 'publication', v_row.id, v_before, to_jsonb(v_row));
  END IF;
  RETURN v_row;
END $$;

-- draft -> in_review (submit), in_review | scheduled -> draft (return or withdraw).
CREATE FUNCTION trustwork.content_transition(p_ctx jsonb, p_pub uuid, p_expected_revision integer, p_to text) RETURNS trustwork.publication
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.publication%ROWTYPE := trustwork.content_lock(p_pub, p_expected_revision);
  v_actor trustwork.admin_actor;
  v_before jsonb := to_jsonb(v_row);
BEGIN
  IF NOT ((v_row.status = 'draft' AND p_to = 'in_review') OR (v_row.status IN ('in_review', 'scheduled') AND p_to = 'draft')) THEN
    RAISE EXCEPTION 'publication % -> % is not a submit or return', v_row.status, p_to USING ERRCODE = 'check_violation', HINT = 'content.invalid_transition';
  END IF;
  IF v_row.owner_kind = 'editorial' THEN
    v_actor := trustwork.content_staff(p_ctx, CASE WHEN v_row.status = 'scheduled' THEN ARRAY['admin.publications.publish'] ELSE ARRAY['admin.publications.review', 'admin.publications.publish'] END, v_row.hub_id);
  ELSIF v_row.status = 'in_review' AND p_ctx IS NOT NULL AND trustwork.content_right(v_row) IS NULL THEN
    -- A reviewer returns a submitted personal or company publication for revision.
    v_actor := trustwork.content_staff(p_ctx, ARRAY['admin.publications.review'], v_row.hub_id);
  ELSE
    PERFORM trustwork.content_require_right(v_row, CASE WHEN v_row.status = 'scheduled' THEN 'publish' ELSE 'edit' END);
  END IF;
  UPDATE trustwork.publication SET status = p_to, scheduled_for = NULL WHERE id = v_row.id RETURNING * INTO v_row;
  IF v_actor.person_id IS NOT NULL THEN
    PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, CASE WHEN p_to = 'in_review' THEN 'publication.submitted' ELSE 'publication.returned' END, 'publication', v_row.id, v_before, to_jsonb(v_row));
  END IF;
  RETURN v_row;
END $$;

-- Publish now, or schedule (embargo) for p_scheduled_for. A publication that requires review is published from
-- review by a staff reviewer who did not draft the version (four eyes).
CREATE FUNCTION trustwork.content_publish(p_ctx jsonb, p_pub uuid, p_expected_revision integer, p_scheduled_for timestamptz) RETURNS trustwork.publication
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_me uuid := trustwork.admin_require_caller();
  v_row trustwork.publication%ROWTYPE := trustwork.content_lock(p_pub, p_expected_revision);
  v_actor trustwork.admin_actor;
  v_before jsonb := to_jsonb(v_row);
  v_draft trustwork.publication_version%ROWTYPE;
BEGIN
  IF v_row.status NOT IN ('draft', 'in_review', 'scheduled') THEN
    RAISE EXCEPTION 'already published; corrections are new versions' USING ERRCODE = 'check_violation', HINT = 'content.use_correction';
  END IF;
  SELECT * INTO v_draft FROM trustwork.publication_version WHERE publication_id = v_row.id AND status = 'draft';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no draft version to publish' USING ERRCODE = 'check_violation', HINT = 'content.no_draft';
  END IF;
  IF v_row.requires_review AND v_row.status = 'draft' THEN
    RAISE EXCEPTION 'this publication is published after review' USING ERRCODE = 'check_violation', HINT = 'content.review_required';
  END IF;
  IF v_row.requires_review AND v_row.status = 'in_review' THEN
    v_actor := trustwork.content_staff(p_ctx, CASE WHEN v_row.owner_kind = 'editorial' THEN ARRAY['admin.publications.publish'] ELSE ARRAY['admin.publications.review', 'admin.publications.publish'] END, v_row.hub_id);
    IF v_draft.drafted_by = v_me THEN
      RAISE EXCEPTION 'a reviewer never approves a version they drafted' USING ERRCODE = 'insufficient_privilege', HINT = 'content.self_review';
    END IF;
  ELSIF v_row.owner_kind = 'editorial' THEN
    v_actor := trustwork.content_staff(p_ctx, ARRAY['admin.publications.publish'], v_row.hub_id);
  ELSE
    PERFORM trustwork.content_require_right(v_row, 'publish');
  END IF;
  IF p_scheduled_for IS NOT NULL AND p_scheduled_for > now() THEN
    IF cardinality(trustwork.content_publication_blockers(v_row, v_draft)) > 0 THEN
      RAISE EXCEPTION 'publication blocked: %', array_to_string(trustwork.content_publication_blockers(v_row, v_draft), ', ') USING ERRCODE = 'check_violation',
        HINT = 'content.' || (trustwork.content_publication_blockers(v_row, v_draft))[1];
    END IF;
    UPDATE trustwork.publication SET status = 'scheduled', scheduled_for = p_scheduled_for WHERE id = v_row.id RETURNING * INTO v_row;
  ELSE
    v_row := trustwork.content_release_version(v_row, v_draft.id, v_me, 'published');
  END IF;
  IF v_actor.person_id IS NOT NULL THEN
    PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, CASE WHEN v_row.status = 'scheduled' THEN 'publication.scheduled' ELSE 'publication.published' END, 'publication', v_row.id, v_before, to_jsonb(v_row));
  END IF;
  RETURN v_row;
END $$;

-- A correction: a new published version marked correction_of the current one, with a reader-visible note, and an
-- append-only correction row. The previous version stays readable.
CREATE FUNCTION trustwork.content_correct(p_ctx jsonb, p_pub uuid, p_expected_revision integer, p_draft jsonb, p_note text, p_reason text) RETURNS trustwork.publication
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_me uuid := trustwork.admin_require_caller();
  v_row trustwork.publication%ROWTYPE := trustwork.content_lock(p_pub, p_expected_revision);
  v_actor trustwork.admin_actor;
  v_before jsonb := to_jsonb(v_row);
  v_from integer := v_row.current_version;
  v_version trustwork.publication_version%ROWTYPE;
BEGIN
  IF v_row.owner_kind = 'editorial' THEN
    v_actor := trustwork.content_staff(p_ctx, ARRAY['admin.publications.correct'], v_row.hub_id);
  ELSE
    PERFORM trustwork.content_require_right(v_row, 'publish');
  END IF;
  IF v_row.status NOT IN ('published', 'corrected') THEN
    RAISE EXCEPTION 'only a published publication is corrected' USING ERRCODE = 'check_violation', HINT = CASE WHEN v_row.status = 'retracted' THEN 'content.retracted' ELSE 'content.not_published' END;
  END IF;
  IF length(coalesce(p_note, '')) NOT BETWEEN 1 AND 500 OR length(coalesce(p_reason, '')) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'a correction carries a reader-visible note and a reason' USING ERRCODE = 'invalid_parameter_value', HINT = 'content.correction_note_required';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.publication_version WHERE publication_id = v_row.id AND status = 'draft') THEN
    RAISE EXCEPTION 'an unpublished draft is pending' USING ERRCODE = 'check_violation', HINT = 'content.draft_pending';
  END IF;
  v_version := trustwork.content_write_draft(v_row, p_draft, v_from, p_note);
  v_row := trustwork.content_release_version(v_row, v_version.id, v_me, 'corrected');
  INSERT INTO trustwork.correction (hub_id, subject_kind, publication_id, from_version, to_version, reason, corrected_by)
  VALUES (v_row.hub_id, 'publication', v_row.id, v_from, v_version.version, p_reason, v_me);
  IF v_actor.person_id IS NOT NULL THEN
    PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'publication.corrected', 'publication', v_row.id, v_before, to_jsonb(v_row));
  END IF;
  RETURN v_row;
END $$;

-- A retraction keeps an explanatory record visible and withholds the body; legal erasure is a separate privacy process.
CREATE FUNCTION trustwork.content_retract(p_ctx jsonb, p_pub uuid, p_expected_revision integer, p_note text) RETURNS trustwork.publication
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_me uuid := trustwork.admin_require_caller();
  v_row trustwork.publication%ROWTYPE := trustwork.content_lock(p_pub, p_expected_revision);
  v_actor trustwork.admin_actor;
  v_before jsonb := to_jsonb(v_row);
BEGIN
  IF v_row.owner_kind = 'editorial' THEN
    v_actor := trustwork.content_staff(p_ctx, ARRAY['admin.publications.retract'], v_row.hub_id);
  ELSE
    PERFORM trustwork.content_require_right(v_row, 'publish');
  END IF;
  IF v_row.status NOT IN ('published', 'corrected') THEN
    RAISE EXCEPTION 'only a published publication is retracted' USING ERRCODE = 'check_violation', HINT = CASE WHEN v_row.status = 'retracted' THEN 'content.retracted' ELSE 'content.not_published' END;
  END IF;
  UPDATE trustwork.publication SET status = 'retracted', retraction_note = p_note, retracted_at = now(), retracted_by = v_me WHERE id = v_row.id RETURNING * INTO v_row;
  IF v_actor.person_id IS NOT NULL THEN
    PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'publication.retracted', 'publication', v_row.id, v_before, to_jsonb(v_row));
  END IF;
  RETURN v_row;
END $$;

-- Topics and entity links, without touching the body: participants with edit rights, or staff holding
-- admin.publications.links.edit at the hub. The given sets replace the live ones.
CREATE FUNCTION trustwork.content_set_links(p_ctx jsonb, p_pub uuid, p_expected_revision integer, p_topics text[], p_links jsonb) RETURNS trustwork.publication
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_me uuid := trustwork.admin_require_caller();
  v_row trustwork.publication%ROWTYPE := trustwork.content_lock(p_pub, p_expected_revision);
  v_actor trustwork.admin_actor;
  v_before jsonb := to_jsonb(v_row);
  v_code text;
  v_term uuid;
  v_link jsonb;
BEGIN
  IF v_row.owner_kind = 'editorial' OR (p_ctx IS NOT NULL AND trustwork.content_right(v_row) IS NULL) THEN
    v_actor := trustwork.content_staff(p_ctx, CASE WHEN v_row.owner_kind = 'editorial' THEN ARRAY['admin.publications.links.edit', 'admin.publications.publish'] ELSE ARRAY['admin.publications.links.edit'] END, v_row.hub_id);
  ELSE
    PERFORM trustwork.content_require_right(v_row, 'edit');
  END IF;
  IF p_topics IS NOT NULL THEN
    UPDATE trustwork.publication_topic t SET removed_at = now(), removed_by = v_me
     WHERE t.publication_id = v_row.id AND t.removed_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM trustwork.taxonomy_term x WHERE x.id = t.term_id AND x.code = ANY (p_topics));
    FOREACH v_code IN ARRAY p_topics LOOP
      SELECT id INTO v_term FROM trustwork.taxonomy_term WHERE code = v_code AND scheme = 'topic' AND status = 'released' AND (hub_id IS NULL OR hub_id = v_row.hub_id)
       ORDER BY hub_id NULLS FIRST LIMIT 1;
      IF v_term IS NULL THEN
        RAISE EXCEPTION 'unknown topic %', v_code USING ERRCODE = 'check_violation', HINT = 'content.unknown_topic';
      END IF;
      INSERT INTO trustwork.publication_topic (publication_id, term_id, added_by) VALUES (v_row.id, v_term, v_me) ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;
  IF p_links IS NOT NULL THEN
    IF jsonb_typeof(p_links) <> 'array' THEN
      RAISE EXCEPTION 'links are an array' USING ERRCODE = 'invalid_parameter_value', HINT = 'content.invalid_links';
    END IF;
    UPDATE trustwork.entity_link l SET removed_at = now(), removed_by = v_me
     WHERE l.publication_id = v_row.id AND l.removed_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_links) x
                       WHERE x.value ->> 'relation' = l.relation AND (x.value ->> 'id')::uuid = coalesce(l.target_person_id, l.target_company_id)
                         AND x.value ->> 'kind' = CASE WHEN l.target_person_id IS NOT NULL THEN 'person' ELSE 'company' END);
    FOR v_link IN SELECT value FROM jsonb_array_elements(p_links) LOOP
      INSERT INTO trustwork.entity_link (publication_id, target_person_id, target_company_id, relation, added_by)
      VALUES (v_row.id, CASE WHEN v_link ->> 'kind' = 'person' THEN (v_link ->> 'id')::uuid END, CASE WHEN v_link ->> 'kind' = 'company' THEN (v_link ->> 'id')::uuid END,
              v_link ->> 'relation', v_me)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;
  UPDATE trustwork.publication SET updated_at = now() WHERE id = v_row.id RETURNING * INTO v_row;
  IF v_actor.person_id IS NOT NULL THEN
    PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'publication.links_edited', 'publication', v_row.id, v_before, to_jsonb(v_row));
  END IF;
  RETURN v_row;
END $$;

-- Editing rights: granted by the owner party (never to oneself), revoked by the owner party or the editor.
CREATE FUNCTION trustwork.content_grant_editor(p_pub uuid, p_person uuid, p_rights text) RETURNS trustwork.publication_editor
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_me uuid := trustwork.admin_require_caller();
  v_pub trustwork.publication%ROWTYPE := trustwork.content_lock(p_pub, NULL);
  v_row trustwork.publication_editor%ROWTYPE;
BEGIN
  IF v_pub.owner_kind = 'editorial' THEN
    RAISE EXCEPTION 'the editorial office edits through staff roles' USING ERRCODE = 'check_violation', HINT = 'content.editorial_staff_only';
  END IF;
  PERFORM trustwork.content_require_right(v_pub, 'owner');
  IF p_person = v_me THEN
    RAISE EXCEPTION 'nobody grants a right to themselves' USING ERRCODE = 'insufficient_privilege', HINT = 'content.self_grant';
  END IF;
  UPDATE trustwork.publication_editor SET revoked_at = now(), revoked_by = v_me WHERE publication_id = p_pub AND person_id = p_person AND revoked_at IS NULL;
  INSERT INTO trustwork.publication_editor (publication_id, person_id, rights, granted_by) VALUES (p_pub, p_person, p_rights, v_me) RETURNING * INTO v_row;
  UPDATE trustwork.publication SET updated_at = now() WHERE id = p_pub;
  RETURN v_row;
END $$;
CREATE FUNCTION trustwork.content_revoke_editor(p_pub uuid, p_person uuid) RETURNS trustwork.publication_editor
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_me uuid := trustwork.admin_require_caller();
  v_pub trustwork.publication%ROWTYPE := trustwork.content_lock(p_pub, NULL);
  v_row trustwork.publication_editor%ROWTYPE;
BEGIN
  IF p_person <> v_me THEN
    PERFORM trustwork.content_require_right(v_pub, 'owner');
  END IF;
  UPDATE trustwork.publication_editor SET revoked_at = now(), revoked_by = v_me WHERE publication_id = p_pub AND person_id = p_person AND revoked_at IS NULL RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no live editing right' USING ERRCODE = 'no_data_found', HINT = 'content.not_found';
  END IF;
  UPDATE trustwork.publication SET updated_at = now() WHERE id = p_pub;
  RETURN v_row;
END $$;

-- Linked editions: the caller edits both publications (or is editorial staff for editorial ones).
CREATE FUNCTION trustwork.content_link_edition(p_ctx jsonb, p_original uuid, p_translation uuid, p_machine_assisted boolean) RETURNS trustwork.edition_link
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_me uuid := trustwork.admin_require_caller();
  v_original trustwork.publication%ROWTYPE := trustwork.content_lock(p_original, NULL);
  v_translation trustwork.publication%ROWTYPE := trustwork.content_lock(p_translation, NULL);
  v_actor trustwork.admin_actor;
  v_row trustwork.edition_link%ROWTYPE;
BEGIN
  IF v_original.owner_kind = 'editorial' OR v_translation.owner_kind = 'editorial' THEN
    v_actor := trustwork.content_staff(p_ctx, ARRAY['admin.publications.publish', 'admin.publications.review'], v_original.hub_id);
  END IF;
  IF v_original.owner_kind <> 'editorial' THEN PERFORM trustwork.content_require_right(v_original, 'edit'); END IF;
  IF v_translation.owner_kind <> 'editorial' THEN PERFORM trustwork.content_require_right(v_translation, 'edit'); END IF;
  IF v_original.hub_id <> v_translation.hub_id OR v_original.original_language = v_translation.original_language THEN
    RAISE EXCEPTION 'a translation is a publication of the same hub in another language' USING ERRCODE = 'check_violation', HINT = 'content.invalid_edition';
  END IF;
  INSERT INTO trustwork.edition_link (original_publication_id, translation_publication_id, language, translator_person_id, machine_assisted, created_by)
  VALUES (p_original, p_translation, v_translation.original_language, v_me, p_machine_assisted, v_me) RETURNING * INTO v_row;
  IF v_actor.person_id IS NOT NULL THEN
    PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_original.hub_id, 'publication.edition_linked', 'edition_link', v_row.id, NULL, to_jsonb(v_row));
  END IF;
  RETURN v_row;
END $$;
CREATE FUNCTION trustwork.content_review_edition(p_ctx jsonb, p_link uuid) RETURNS trustwork.edition_link
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_me uuid := trustwork.admin_require_caller();
  v_row trustwork.edition_link%ROWTYPE;
  v_translation trustwork.publication%ROWTYPE;
  v_actor trustwork.admin_actor;
BEGIN
  SELECT * INTO v_row FROM trustwork.edition_link WHERE id = p_link FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'edition link not found' USING ERRCODE = 'no_data_found', HINT = 'content.not_found';
  END IF;
  SELECT * INTO v_translation FROM trustwork.publication WHERE id = v_row.translation_publication_id;
  IF v_translation.owner_kind = 'editorial' THEN
    v_actor := trustwork.content_staff(p_ctx, ARRAY['admin.publications.review', 'admin.publications.publish'], v_translation.hub_id);
  ELSE
    PERFORM trustwork.content_require_right(v_translation, 'edit');
  END IF;
  IF v_row.translator_person_id = v_me THEN
    RAISE EXCEPTION 'a translation is reviewed by someone other than its translator' USING ERRCODE = 'insufficient_privilege', HINT = 'content.self_review';
  END IF;
  UPDATE trustwork.edition_link SET reviewed_by = v_me, reviewed_at = now() WHERE id = p_link RETURNING * INTO v_row;
  IF v_actor.person_id IS NOT NULL THEN
    PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_translation.hub_id, 'publication.edition_reviewed', 'edition_link', v_row.id, NULL, to_jsonb(v_row));
  END IF;
  RETURN v_row;
END $$;

-- Is the publication readable by the public right now (published once, and no hold or removal applies)? A hold whose
-- case was decided without removal no longer hides the publication.
CREATE FUNCTION trustwork.content_public_ok(p_pub trustwork.publication) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT p_pub.status IN ('published', 'corrected', 'retracted') AND p_pub.current_version IS NOT NULL
    AND (p_pub.moderation_state = 'none'
         OR (p_pub.moderation_state = 'held' AND NOT EXISTS (SELECT 1 FROM trustwork.moderation_case c WHERE c.id = p_pub.held_by_case_id
                                                              AND (c.emergency_hold OR c.decision = 'content_removed'))))
$$;

-- Walls: the wall's owner (the person, or a member of the company holding company.publish) references public items.
CREATE FUNCTION trustwork.content_wall_add(p_wall_kind text, p_company uuid, p_pub uuid, p_version uuid, p_pinned boolean) RETURNS trustwork.wall_reference
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_me uuid := trustwork.admin_require_caller();
  v_pub trustwork.publication%ROWTYPE;
  v_row trustwork.wall_reference%ROWTYPE;
  v_position integer;
BEGIN
  IF p_wall_kind = 'company' AND (p_company IS NULL OR NOT trustwork.content_acts_for(NULL, p_company)) THEN
    RAISE EXCEPTION 'a company wall is curated by members holding company.publish' USING ERRCODE = 'insufficient_privilege', HINT = 'content.not_authorised';
  END IF;
  SELECT * INTO v_pub FROM trustwork.publication WHERE id = p_pub;
  IF NOT FOUND OR NOT trustwork.content_public_ok(v_pub) THEN
    RAISE EXCEPTION 'walls reference public publications' USING ERRCODE = 'no_data_found', HINT = 'content.not_found';
  END IF;
  IF p_version IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trustwork.publication_version v WHERE v.id = p_version AND v.publication_id = p_pub AND v.status = 'published') THEN
    RAISE EXCEPTION 'walls pin published versions' USING ERRCODE = 'check_violation', HINT = 'content.version_not_published';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('trustwork.wall'), hashtext(coalesce(p_company, v_me)::text));
  SELECT coalesce(max(position), 0) + 1 INTO v_position FROM trustwork.wall_reference WHERE coalesce(wall_person_id, wall_company_id) = coalesce(p_company, v_me) AND removed_at IS NULL;
  INSERT INTO trustwork.wall_reference (wall_kind, wall_person_id, wall_company_id, publication_id, publication_version_id, position, pinned, added_by)
  VALUES (p_wall_kind, CASE WHEN p_wall_kind = 'person' THEN v_me END, CASE WHEN p_wall_kind = 'company' THEN p_company END, p_pub, p_version, v_position, coalesce(p_pinned, false), v_me)
  RETURNING * INTO v_row;
  RETURN v_row;
END $$;
CREATE FUNCTION trustwork.content_wall_remove(p_ref uuid) RETURNS trustwork.wall_reference
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_me uuid := trustwork.admin_require_caller();
  v_row trustwork.wall_reference%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM trustwork.wall_reference WHERE id = p_ref AND removed_at IS NULL FOR UPDATE;
  IF NOT FOUND OR NOT trustwork.content_acts_for(v_row.wall_person_id, v_row.wall_company_id) THEN
    RAISE EXCEPTION 'wall reference not found' USING ERRCODE = 'no_data_found', HINT = 'content.not_found';
  END IF;
  UPDATE trustwork.wall_reference SET removed_at = now(), removed_by = v_me WHERE id = p_ref RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- Comments on public, unretracted publications by signed-in people.
CREATE FUNCTION trustwork.content_comment(p_pub uuid, p_parent uuid, p_body text) RETURNS trustwork.publication_comment
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_me uuid := trustwork.admin_require_caller();
  v_pub trustwork.publication%ROWTYPE;
  v_row trustwork.publication_comment%ROWTYPE;
BEGIN
  SELECT * INTO v_pub FROM trustwork.publication WHERE id = p_pub;
  IF NOT FOUND OR NOT trustwork.content_public_ok(v_pub) OR v_pub.status = 'retracted' THEN
    RAISE EXCEPTION 'comments are written on public publications' USING ERRCODE = 'no_data_found', HINT = 'content.not_found';
  END IF;
  IF p_parent IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trustwork.publication_comment c WHERE c.id = p_parent AND c.publication_id = p_pub AND c.status = 'visible') THEN
    RAISE EXCEPTION 'the parent comment is not visible here' USING ERRCODE = 'no_data_found', HINT = 'content.not_found';
  END IF;
  INSERT INTO trustwork.publication_comment (publication_id, author_person_id, parent_id, body) VALUES (p_pub, v_me, p_parent, p_body) RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- The moderation port (ADM-001 ModerationTargetPort): applies a staff decision to a publication or a comment, inside
-- the staff command's transaction. The case itself proves the decision: a hold needs an open case with an emergency
-- hold, a removal a content_removed decision, a restoration a content_restored decision or an overturning appeal. An
-- unknown target is a no-op (nothing of this module to hide).
CREATE FUNCTION trustwork.content_apply_moderation(p_case uuid, p_effect text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_case trustwork.moderation_case%ROWTYPE;
  v_ok boolean;
  v_pub trustwork.publication%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_case FROM trustwork.moderation_case WHERE id = p_case;
  IF NOT FOUND OR NOT trustwork.admin_has_any_permission(ARRAY['admin.moderation.decide', 'admin.moderation.emergency.hold', 'admin.moderation.appeal.decide', 'admin.trust.appeals.decide'], NULL, v_case.hub_id) THEN
    RAISE EXCEPTION 'moderation effects follow a staff decision' USING ERRCODE = 'insufficient_privilege', HINT = 'content.not_authorised';
  END IF;
  v_ok := CASE p_effect
    WHEN 'hold' THEN v_case.emergency_hold AND v_case.status IN ('open', 'in_review')
    WHEN 'remove' THEN v_case.decision = 'content_removed'
    WHEN 'restore' THEN v_case.decision = 'content_restored'
      OR EXISTS (SELECT 1 FROM trustwork.appeal a WHERE a.subject_kind = 'moderation_case' AND a.subject_id = v_case.id AND a.status = 'overturned')
    WHEN 'none' THEN true
    ELSE false END;
  IF NOT coalesce(v_ok, false) THEN
    RAISE EXCEPTION 'the case does not support %', p_effect USING ERRCODE = 'check_violation', HINT = 'content.moderation_mismatch';
  END IF;
  IF p_effect = 'none' THEN
    RETURN 'none';
  END IF;
  IF v_case.target_kind = 'publication' THEN
    SELECT * INTO v_pub FROM trustwork.publication WHERE id = v_case.target_id AND hub_id = v_case.hub_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN 'unknown_target';
    END IF;
    UPDATE trustwork.publication SET moderation_state = CASE p_effect WHEN 'hold' THEN 'held' WHEN 'remove' THEN 'removed' ELSE 'none' END,
           held_by_case_id = CASE WHEN p_effect = 'restore' THEN NULL ELSE v_case.id END
     WHERE id = v_pub.id;
    RETURN 'applied';
  ELSIF v_case.target_kind = 'publication_comment' THEN
    UPDATE trustwork.publication_comment c SET status = CASE p_effect WHEN 'hold' THEN 'held' WHEN 'remove' THEN 'removed' ELSE 'visible' END,
           moderation_case_id = v_case.id
     WHERE c.id = v_case.target_id AND EXISTS (SELECT 1 FROM trustwork.publication p WHERE p.id = c.publication_id AND p.hub_id = v_case.hub_id);
    RETURN CASE WHEN FOUND THEN 'applied' ELSE 'unknown_target' END;
  END IF;
  RETURN 'not_content';
END $$;

-- 6. Issues ----------------------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.content_issue_lock(p_issue uuid, p_expected_revision integer) RETURNS trustwork.issue
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_row trustwork.issue%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM trustwork.issue WHERE id = p_issue FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'issue not found' USING ERRCODE = 'no_data_found', HINT = 'content.not_found';
  END IF;
  IF p_expected_revision IS NOT NULL AND v_row.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'the issue changed' USING ERRCODE = 'serialization_failure', HINT = 'content.revision_conflict';
  END IF;
  RETURN v_row;
END $$;

-- Replaces the items of a draft revision. p_items: [{position, section, publicationId, publicationVersionId}].
CREATE FUNCTION trustwork.content_issue_write_items(p_revision uuid, p_items jsonb) RETURNS void
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_item jsonb;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'items are an array' USING ERRCODE = 'invalid_parameter_value', HINT = 'content.invalid_items';
  END IF;
  DELETE FROM trustwork.issue_item WHERE issue_revision_id = p_revision;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO trustwork.issue_item (issue_revision_id, position, section, publication_id, publication_version_id)
    VALUES (p_revision, (v_item ->> 'position')::integer, v_item ->> 'section', (v_item ->> 'publicationId')::uuid, (v_item ->> 'publicationVersionId')::uuid);
  END LOOP;
END $$;

CREATE FUNCTION trustwork.content_issue_create(p_ctx jsonb, p_hub uuid, p_number integer, p_date date, p_theme text, p_cover uuid, p_letter uuid) RETURNS trustwork.issue
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.content_staff(p_ctx, ARRAY['admin.issues.curate'], p_hub);
  v_row trustwork.issue%ROWTYPE;
BEGIN
  IF p_letter IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trustwork.publication p WHERE p.id = p_letter AND p.hub_id = p_hub) THEN
    RAISE EXCEPTION 'the editor''s letter is a publication of this hub' USING ERRCODE = 'check_violation', HINT = 'content.other_hub';
  END IF;
  INSERT INTO trustwork.issue (hub_id, number, issue_date, theme, cover_asset_id, editor_letter_publication_id, created_by)
  VALUES (p_hub, p_number, p_date, p_theme, p_cover, p_letter, v_actor.person_id) RETURNING * INTO v_row;
  INSERT INTO trustwork.issue_revision (issue_id, edition, created_by) VALUES (v_row.id, 1, v_actor.person_id);
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'issue.create', 'issue', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Curates the working (draft) revision: items, and while unreleased the theme, cover and editor's letter.
CREATE FUNCTION trustwork.content_issue_curate(p_ctx jsonb, p_issue uuid, p_expected_revision integer, p_items jsonb, p_theme text, p_cover uuid, p_letter uuid) RETURNS trustwork.issue
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.issue%ROWTYPE := trustwork.content_issue_lock(p_issue, p_expected_revision);
  v_actor trustwork.admin_actor := trustwork.content_staff(p_ctx, ARRAY['admin.issues.curate', 'admin.issues.correct'], v_row.hub_id);
  v_before jsonb := to_jsonb(v_row);
  v_revision uuid;
BEGIN
  SELECT id INTO v_revision FROM trustwork.issue_revision WHERE issue_id = v_row.id AND status = 'draft';
  IF v_revision IS NULL OR v_row.status = 'review' THEN
    RAISE EXCEPTION 'only a draft revision outside review is curated' USING ERRCODE = 'check_violation', HINT = 'content.issue_frozen';
  END IF;
  IF p_items IS NOT NULL THEN
    PERFORM trustwork.content_issue_write_items(v_revision, p_items);
  END IF;
  IF v_row.current_edition IS NULL THEN
    IF p_letter IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trustwork.publication p WHERE p.id = p_letter AND p.hub_id = v_row.hub_id) THEN
      RAISE EXCEPTION 'the editor''s letter is a publication of this hub' USING ERRCODE = 'check_violation', HINT = 'content.other_hub';
    END IF;
    UPDATE trustwork.issue SET theme = coalesce(p_theme, theme), cover_asset_id = coalesce(p_cover, cover_asset_id), editor_letter_publication_id = coalesce(p_letter, editor_letter_publication_id)
     WHERE id = v_row.id RETURNING * INTO v_row;
  ELSE
    UPDATE trustwork.issue SET updated_at = now() WHERE id = v_row.id RETURNING * INTO v_row;
  END IF;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'issue.curate', 'issue', v_row.id, v_before, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- draft <-> curated <-> review before the first release.
CREATE FUNCTION trustwork.content_issue_transition(p_ctx jsonb, p_issue uuid, p_expected_revision integer, p_to text) RETURNS trustwork.issue
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.issue%ROWTYPE := trustwork.content_issue_lock(p_issue, p_expected_revision);
  v_actor trustwork.admin_actor := trustwork.content_staff(p_ctx, ARRAY['admin.issues.curate'], v_row.hub_id);
  v_before jsonb := to_jsonb(v_row);
BEGIN
  IF p_to NOT IN ('draft', 'curated', 'review') THEN
    RAISE EXCEPTION 'release and correction have their own commands' USING ERRCODE = 'check_violation', HINT = 'content.invalid_transition';
  END IF;
  UPDATE trustwork.issue SET status = p_to WHERE id = v_row.id RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'issue.status', 'issue', v_row.id, v_before, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Releases the draft revision: edition 1 from review, a correction edition while released or corrected. The digest
-- binds the number, date and items; a correction edition writes the correction row.
CREATE FUNCTION trustwork.content_issue_release(p_ctx jsonb, p_issue uuid, p_expected_revision integer) RETURNS trustwork.issue
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.issue%ROWTYPE := trustwork.content_issue_lock(p_issue, p_expected_revision);
  v_actor trustwork.admin_actor := trustwork.content_staff(p_ctx, ARRAY['admin.issues.release'], v_row.hub_id);
  v_before jsonb := to_jsonb(v_row);
  v_revision trustwork.issue_revision%ROWTYPE;
  v_items jsonb;
BEGIN
  SELECT * INTO v_revision FROM trustwork.issue_revision WHERE issue_id = v_row.id AND status = 'draft' FOR UPDATE;
  IF NOT FOUND OR (v_revision.edition = 1 AND v_row.status <> 'review') THEN
    RAISE EXCEPTION 'nothing to release (the first edition is released from review)' USING ERRCODE = 'check_violation', HINT = 'content.invalid_transition';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('position', i.position, 'publicationId', i.publication_id::text, 'publicationVersion', v.version, 'section', i.section) ORDER BY i.position), '[]'::jsonb)
    INTO v_items FROM trustwork.issue_item i JOIN trustwork.publication_version v ON v.id = i.publication_version_id WHERE i.issue_revision_id = v_revision.id;
  IF jsonb_array_length(v_items) = 0 THEN
    RAISE EXCEPTION 'an issue releases with at least one item' USING ERRCODE = 'check_violation', HINT = 'content.issue_empty';
  END IF;
  UPDATE trustwork.issue_revision SET status = 'released', released_at = now(), released_by = v_actor.person_id,
         digest = trustwork.admin_digest(jsonb_build_object('issueNumber', v_row.number, 'date', to_char(v_row.issue_date, 'YYYY-MM-DD'), 'items', v_items))
   WHERE id = v_revision.id;
  UPDATE trustwork.issue SET status = CASE WHEN v_revision.edition = 1 THEN 'released' ELSE 'corrected' END, current_edition = v_revision.edition
   WHERE id = v_row.id RETURNING * INTO v_row;
  IF v_revision.edition > 1 THEN
    INSERT INTO trustwork.correction (hub_id, subject_kind, issue_id, from_version, to_version, reason, corrected_by)
    VALUES (v_row.hub_id, 'issue', v_row.id, v_revision.edition - 1, v_revision.edition, v_revision.correction_note, v_actor.person_id);
  END IF;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, CASE WHEN v_revision.edition = 1 THEN 'issue.release' ELSE 'issue.correction_release' END, 'issue', v_row.id, v_before, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Opens a correction edition: a draft copy of the current edition with a reader-visible note, every item repinned to
-- its publication's current published version (the curator may still adjust the items before release).
CREATE FUNCTION trustwork.content_issue_correct(p_ctx jsonb, p_issue uuid, p_expected_revision integer, p_note text) RETURNS trustwork.issue
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.issue%ROWTYPE := trustwork.content_issue_lock(p_issue, p_expected_revision);
  v_actor trustwork.admin_actor := trustwork.content_staff(p_ctx, ARRAY['admin.issues.correct'], v_row.hub_id);
  v_before jsonb := to_jsonb(v_row);
  v_current uuid;
  v_new uuid;
BEGIN
  IF v_row.status NOT IN ('released', 'corrected') OR EXISTS (SELECT 1 FROM trustwork.issue_revision WHERE issue_id = v_row.id AND status = 'draft') THEN
    RAISE EXCEPTION 'a correction edition follows a release, one at a time' USING ERRCODE = 'check_violation', HINT = 'content.invalid_transition';
  END IF;
  IF length(coalesce(p_note, '')) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'a correction edition carries a note' USING ERRCODE = 'invalid_parameter_value', HINT = 'content.correction_note_required';
  END IF;
  SELECT id INTO v_current FROM trustwork.issue_revision WHERE issue_id = v_row.id AND edition = v_row.current_edition;
  INSERT INTO trustwork.issue_revision (issue_id, edition, correction_note, created_by) VALUES (v_row.id, v_row.current_edition + 1, p_note, v_actor.person_id) RETURNING id INTO v_new;
  INSERT INTO trustwork.issue_item (issue_revision_id, position, section, publication_id, publication_version_id)
  SELECT v_new, i.position, i.section, i.publication_id, coalesce(p.current_version_id, i.publication_version_id)
    FROM trustwork.issue_item i JOIN trustwork.publication p ON p.id = i.publication_id
   WHERE i.issue_revision_id = v_current AND p.status <> 'retracted';
  UPDATE trustwork.issue SET updated_at = now() WHERE id = v_row.id RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'issue.correction_open', 'issue', v_row.id, v_before, to_jsonb(v_row));
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.content_render_request(p_ctx jsonb, p_issue uuid, p_edition integer, p_format text) RETURNS trustwork.render_artifact
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_issue trustwork.issue%ROWTYPE := trustwork.content_issue_lock(p_issue, NULL);
  v_actor trustwork.admin_actor := trustwork.content_staff(p_ctx, ARRAY['admin.issues.render'], v_issue.hub_id);
  v_revision uuid;
  v_row trustwork.render_artifact%ROWTYPE;
BEGIN
  SELECT id INTO v_revision FROM trustwork.issue_revision WHERE issue_id = p_issue AND edition = p_edition;
  IF v_revision IS NULL THEN
    RAISE EXCEPTION 'edition not found' USING ERRCODE = 'no_data_found', HINT = 'content.not_found';
  END IF;
  INSERT INTO trustwork.render_artifact (issue_revision_id, format, requested_by) VALUES (v_revision, p_format, v_actor.person_id) RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_issue.hub_id, 'issue.render_requested', 'render_artifact', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;
CREATE FUNCTION trustwork.content_render_record(p_ctx jsonb, p_render uuid, p_status text, p_artifact uuid, p_sha256 text, p_renderer text, p_failure text) RETURNS trustwork.render_artifact
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.render_artifact%ROWTYPE;
  v_hub uuid;
  v_actor trustwork.admin_actor;
  v_before jsonb;
BEGIN
  SELECT r.* INTO v_row FROM trustwork.render_artifact r WHERE r.id = p_render FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'render not found' USING ERRCODE = 'no_data_found', HINT = 'content.not_found';
  END IF;
  SELECT i.hub_id INTO v_hub FROM trustwork.issue_revision r JOIN trustwork.issue i ON i.id = r.issue_id WHERE r.id = v_row.issue_revision_id;
  v_actor := trustwork.content_staff(p_ctx, ARRAY['admin.issues.render'], v_hub);
  IF p_artifact IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trustwork.evidence_artifact a WHERE a.id = p_artifact AND a.sha256 = p_sha256) THEN
    RAISE EXCEPTION 'the artifact does not carry this hash' USING ERRCODE = 'check_violation', HINT = 'content.artifact_mismatch';
  END IF;
  v_before := to_jsonb(v_row);
  UPDATE trustwork.render_artifact SET status = p_status, artifact_id = p_artifact, sha256 = CASE WHEN p_status = 'rendered' THEN p_sha256 END,
         renderer_version = CASE WHEN p_status = 'rendered' THEN p_renderer END, failure_reason = CASE WHEN p_status = 'failed' THEN p_failure END, completed_at = now()
   WHERE id = p_render RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_hub, 'issue.render_recorded', 'render_artifact', v_row.id, v_before, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Digests of local publications (the cross-hub mesh is Proposed): each item pins the current published version;
-- full text only when the publication is cc_by and every source allows syndication.
CREATE FUNCTION trustwork.content_digest_create(p_ctx jsonb, p_hub uuid, p_title text, p_period text, p_publications uuid[]) RETURNS trustwork.magazine_digest
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.content_staff(p_ctx, ARRAY['admin.issues.curate'], p_hub);
  v_row trustwork.magazine_digest%ROWTYPE;
  v_pub trustwork.publication%ROWTYPE;
  v_version trustwork.publication_version%ROWTYPE;
  v_id uuid;
  v_pos integer := 0;
  v_full boolean;
BEGIN
  INSERT INTO trustwork.magazine_digest (hub_id, title, period, created_by) VALUES (p_hub, p_title, p_period, v_actor.person_id) RETURNING * INTO v_row;
  FOREACH v_id IN ARRAY coalesce(p_publications, '{}') LOOP
    SELECT * INTO v_pub FROM trustwork.publication WHERE id = v_id AND hub_id = p_hub;
    IF NOT FOUND OR NOT trustwork.content_public_ok(v_pub) OR v_pub.status = 'retracted' THEN
      RAISE EXCEPTION 'digests reference public publications of this hub' USING ERRCODE = 'check_violation', HINT = 'content.not_public';
    END IF;
    SELECT * INTO v_version FROM trustwork.publication_version WHERE id = v_pub.current_version_id;
    v_full := v_pub.licence = 'cc_by' AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_version.source_refs) s
                                                       WHERE s ->> 'kind' <> 'own_reporting' AND NOT coalesce((s -> 'allowedUses' ->> 'syndicateToPeers')::boolean, false));
    v_pos := v_pos + 1;
    INSERT INTO trustwork.magazine_digest_item (digest_id, position, home_node, global_id, version, licence, display, title, local_publication_id, local_version_id)
    VALUES (v_row.id, v_pos, 'local', v_pub.id::text, v_version.version, v_pub.licence, CASE WHEN v_full THEN 'full' ELSE 'headline_link' END, v_version.title, v_pub.id, v_version.id);
  END LOOP;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'digest.create', 'magazine_digest', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;
CREATE FUNCTION trustwork.content_digest_release(p_ctx jsonb, p_digest uuid, p_expected_revision integer) RETURNS trustwork.magazine_digest
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.magazine_digest%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_before jsonb;
BEGIN
  SELECT * INTO v_row FROM trustwork.magazine_digest WHERE id = p_digest FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'digest not found' USING ERRCODE = 'no_data_found', HINT = 'content.not_found';
  END IF;
  v_actor := trustwork.content_staff(p_ctx, ARRAY['admin.issues.release'], v_row.hub_id);
  IF p_expected_revision IS NOT NULL AND v_row.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'the digest changed' USING ERRCODE = 'serialization_failure', HINT = 'content.revision_conflict';
  END IF;
  IF v_row.status <> 'draft' OR NOT EXISTS (SELECT 1 FROM trustwork.magazine_digest_item WHERE digest_id = v_row.id) THEN
    RAISE EXCEPTION 'a digest is released once, with items' USING ERRCODE = 'check_violation', HINT = 'content.invalid_transition';
  END IF;
  v_before := to_jsonb(v_row);
  UPDATE trustwork.magazine_digest SET status = 'released', released_at = now(), released_by = v_actor.person_id WHERE id = v_row.id RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'digest.release', 'magazine_digest', v_row.id, v_before, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Worker entry point: publishes scheduled publications whose time has come (the blockers are checked again).
CREATE FUNCTION trustwork.content_publish_due(p_limit integer) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_pub trustwork.publication%ROWTYPE;
  v_draft uuid;
  v_count integer := 0;
BEGIN
  FOR v_pub IN SELECT * FROM trustwork.publication WHERE status = 'scheduled' AND scheduled_for <= now() ORDER BY scheduled_for, id LIMIT greatest(1, least(coalesce(p_limit, 50), 500))
               FOR UPDATE SKIP LOCKED LOOP
    SELECT id INTO v_draft FROM trustwork.publication_version WHERE publication_id = v_pub.id AND status = 'draft';
    PERFORM trustwork.content_release_version(v_pub, v_draft, (SELECT drafted_by FROM trustwork.publication_version WHERE id = v_draft), 'published');
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

-- 7. Public projections (SECURITY DEFINER; identical for every caller, signed in or not) --------------------------------
-- Person links: only people with a public, consented profile and a live mentioned_in_publication consent.
CREATE FUNCTION trustwork.content_public_links(p_pub uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('party', jsonb_build_object('kind', CASE WHEN l.target_person_id IS NULL THEN 'company' ELSE 'person' END,
                                               'id', coalesce(l.target_person_id, l.target_company_id)::text), 'relation', l.relation) ORDER BY l.created_at, l.id), '[]'::jsonb)
  FROM trustwork.entity_link l
  WHERE l.publication_id = p_pub AND l.removed_at IS NULL
    AND (l.target_company_id IS NOT NULL
         OR l.target_person_id IN (SELECT trustwork.profiles_consented_mentions(p_pub, ARRAY(SELECT x.target_person_id FROM trustwork.entity_link x
                                                                                            WHERE x.publication_id = p_pub AND x.removed_at IS NULL AND x.target_person_id IS NOT NULL))))
$$;
CREATE FUNCTION trustwork.content_version_json(p_version trustwork.publication_version, p_with_body boolean) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_build_object('version', p_version.version, 'title', p_version.title, 'body', CASE WHEN p_with_body THEN p_version.body END, 'language', p_version.language,
    'sourceRefs', p_version.source_refs, 'treatment', p_version.treatment, 'eventTime', trustwork.content_iso(p_version.event_time),
    'publishedAt', trustwork.content_iso(p_version.published_at), 'correctionOf', p_version.correction_of, 'correctionNote', p_version.correction_note,
    'contentDigest', p_version.content_digest, 'assistantAssisted', p_version.assistant_assisted)
$$;
CREATE FUNCTION trustwork.content_publication_json(p_pub trustwork.publication) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', p_pub.id::text, 'format', p_pub.format, 'articleFormat', p_pub.article_format, 'status', p_pub.status, 'originalLanguage', p_pub.original_language, 'licence', p_pub.licence,
    'firstPublishedAt', trustwork.content_iso(p_pub.first_published_at),
    'owner', jsonb_build_object('kind', p_pub.owner_kind, 'id', coalesce(p_pub.owner_person_id, p_pub.owner_company_id)::text),
    -- A credited person other than the owner is identified only with their consent to be named in this publication.
    'authorship', (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', a.author_kind, 'credit', a.credit,
                                                                'id', CASE WHEN a.author_person_id IS NULL OR a.author_person_id = p_pub.owner_person_id
                                                                             OR EXISTS (SELECT 1 FROM trustwork.profiles_consented_mentions(p_pub.id, ARRAY[a.author_person_id]))
                                                                           THEN coalesce(a.author_person_id, a.author_company_id)::text END,
                                                                'assistantAssisted', a.assistant_assisted) ORDER BY a.position), '[]'::jsonb)
                   FROM trustwork.publication_authorship a WHERE a.publication_id = p_pub.id),
    'topics', (SELECT coalesce(jsonb_agg(t.code ORDER BY t.code), '[]'::jsonb) FROM trustwork.publication_topic pt JOIN trustwork.taxonomy_term t ON t.id = pt.term_id
               WHERE pt.publication_id = p_pub.id AND pt.removed_at IS NULL),
    'entityLinks', trustwork.content_public_links(p_pub.id),
    'current', (SELECT trustwork.content_version_json(v, p_pub.status <> 'retracted') FROM trustwork.publication_version v WHERE v.id = p_pub.current_version_id),
    'versions', (SELECT coalesce(jsonb_agg(jsonb_build_object('version', v.version, 'publishedAt', trustwork.content_iso(v.published_at), 'correctionOf', v.correction_of,
                                                              'correctionNote', v.correction_note) ORDER BY v.version), '[]'::jsonb)
                 FROM trustwork.publication_version v WHERE v.publication_id = p_pub.id AND v.status = 'published'),
    'corrections', (SELECT coalesce(jsonb_agg(jsonb_build_object('fromVersion', c.from_version, 'toVersion', c.to_version, 'reason', c.reason,
                                                                 'correctedAt', trustwork.content_iso(c.corrected_at)) ORDER BY c.corrected_at), '[]'::jsonb)
                    FROM trustwork.correction c WHERE c.publication_id = p_pub.id),
    'retraction', CASE WHEN p_pub.status = 'retracted' THEN jsonb_build_object('note', p_pub.retraction_note, 'retractedAt', trustwork.content_iso(p_pub.retracted_at)) END,
    'editions', (SELECT coalesce(jsonb_agg(jsonb_build_object('publicationId', CASE WHEN l.original_publication_id = p_pub.id THEN l.translation_publication_id ELSE l.original_publication_id END::text,
                                                              'language', CASE WHEN l.original_publication_id = p_pub.id THEN l.language ELSE o.original_language END,
                                                              'role', CASE WHEN l.original_publication_id = p_pub.id THEN 'translation' ELSE 'original' END,
                                                              'machineAssisted', l.machine_assisted, 'reviewed', l.reviewed_by IS NOT NULL) ORDER BY l.created_at), '[]'::jsonb)
                 FROM trustwork.edition_link l JOIN trustwork.publication o ON o.id = l.original_publication_id JOIN trustwork.publication tr ON tr.id = l.translation_publication_id
                 WHERE (l.original_publication_id = p_pub.id OR l.translation_publication_id = p_pub.id) AND trustwork.content_public_ok(o) AND trustwork.content_public_ok(tr)))
$$;

CREATE FUNCTION trustwork.content_public_publication(p_hub uuid, p_pub uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.content_publication_json(p) FROM trustwork.publication p WHERE p.id = p_pub AND p.hub_id = p_hub AND trustwork.content_public_ok(p)
$$;
-- A published version by number (the previous text stays readable after a correction; withheld after retraction).
CREATE FUNCTION trustwork.content_public_version(p_hub uuid, p_pub uuid, p_version integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.content_version_json(v, p.status <> 'retracted')
  FROM trustwork.publication p JOIN trustwork.publication_version v ON v.publication_id = p.id AND v.version = p_version AND v.status = 'published'
  WHERE p.id = p_pub AND p.hub_id = p_hub AND trustwork.content_public_ok(p)
$$;
-- Newest first by first publication, keyset on (first_published_at, id); never ordered by anything a payment could buy.
CREATE FUNCTION trustwork.content_public_feed(p_hub uuid, p_format text, p_topic text, p_before timestamptz, p_before_id uuid, p_limit integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT coalesce(jsonb_agg(x.j ORDER BY x.at DESC, x.id DESC), '[]'::jsonb) FROM (
    SELECT jsonb_build_object('id', p.id::text, 'format', p.format, 'articleFormat', p.article_format, 'status', p.status, 'firstPublishedAt', trustwork.content_iso(p.first_published_at),
             'title', v.title, 'eventTime', trustwork.content_iso(v.event_time), 'currentVersion', v.version, 'corrected', p.status = 'corrected', 'retracted', p.status = 'retracted',
             'sources', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', s ->> 'name', 'kind', s ->> 'kind', 'uri', s ->> 'uri')), '[]'::jsonb) FROM jsonb_array_elements(v.source_refs) s),
             'topics', (SELECT coalesce(jsonb_agg(t.code ORDER BY t.code), '[]'::jsonb) FROM trustwork.publication_topic pt JOIN trustwork.taxonomy_term t ON t.id = pt.term_id
                        WHERE pt.publication_id = p.id AND pt.removed_at IS NULL),
             'credits', (SELECT coalesce(jsonb_agg(a.credit ORDER BY a.position), '[]'::jsonb) FROM trustwork.publication_authorship a WHERE a.publication_id = p.id)) AS j,
           p.first_published_at AS at, p.id
    FROM trustwork.publication p JOIN trustwork.publication_version v ON v.id = p.current_version_id
    WHERE p.hub_id = p_hub AND trustwork.content_public_ok(p) AND (p_format IS NULL OR p.format = p_format)
      AND (p_topic IS NULL OR EXISTS (SELECT 1 FROM trustwork.publication_topic pt JOIN trustwork.taxonomy_term t ON t.id = pt.term_id WHERE pt.publication_id = p.id AND pt.removed_at IS NULL AND t.code = p_topic))
      AND (p_before IS NULL OR (p.first_published_at, p.id) < (p_before, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
    ORDER BY p.first_published_at DESC, p.id DESC
    LIMIT greatest(1, least(coalesce(p_limit, 20), 100))) x
$$;

CREATE FUNCTION trustwork.content_issue_json(p_issue trustwork.issue, p_revision trustwork.issue_revision) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', p_issue.id::text, 'revision', p_issue.revision, 'number', p_issue.number, 'date', to_char(p_issue.issue_date, 'YYYY-MM-DD'), 'theme', p_issue.theme, 'status', p_issue.status,
    'coverAssetId', p_issue.cover_asset_id::text, 'editorLetterPublicationId', p_issue.editor_letter_publication_id::text,
    'edition', p_revision.edition, 'currentEdition', p_issue.current_edition, 'digest', p_revision.digest, 'releasedAt', trustwork.content_iso(p_revision.released_at),
    'correctionNote', p_revision.correction_note,
    'items', (SELECT coalesce(jsonb_agg(CASE WHEN trustwork.content_public_ok(p) THEN
                jsonb_build_object('position', i.position, 'section', i.section, 'publicationId', i.publication_id::text, 'publicationVersion', v.version, 'withheld', false,
                                   'title', v.title, 'format', p.format, 'articleFormat', p.article_format, 'currentVersion', p.current_version,
                                   'corrected', p.current_version > v.version, 'retracted', p.status = 'retracted')
              ELSE jsonb_build_object('position', i.position, 'section', i.section, 'publicationId', i.publication_id::text, 'publicationVersion', v.version, 'withheld', true) END
              ORDER BY i.position), '[]'::jsonb)
              FROM trustwork.issue_item i JOIN trustwork.publication p ON p.id = i.publication_id JOIN trustwork.publication_version v ON v.id = i.publication_version_id
              WHERE i.issue_revision_id = p_revision.id),
    'renderArtifacts', (SELECT coalesce(jsonb_agg(jsonb_build_object('format', r.format, 'hash', r.sha256, 'sourceEdition', p_revision.edition, 'rendererVersion', r.renderer_version)
                                                  ORDER BY r.requested_at), '[]'::jsonb)
                        FROM trustwork.render_artifact r WHERE r.issue_revision_id = p_revision.id AND r.status = 'rendered'),
    'corrections', (SELECT coalesce(jsonb_agg(jsonb_build_object('fromEdition', c.from_version, 'toEdition', c.to_version, 'reason', c.reason, 'correctedAt', trustwork.content_iso(c.corrected_at))
                                              ORDER BY c.corrected_at), '[]'::jsonb)
                    FROM trustwork.correction c WHERE c.issue_id = p_issue.id))
$$;
-- A released edition (default: the current one). Held or removed items keep their slot without content.
CREATE FUNCTION trustwork.content_public_issue(p_hub uuid, p_number integer, p_edition integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.content_issue_json(i, r)
  FROM trustwork.issue i JOIN trustwork.issue_revision r ON r.issue_id = i.id AND r.status = 'released' AND r.edition = coalesce(p_edition, i.current_edition)
  WHERE i.hub_id = p_hub AND i.number = p_number AND i.current_edition IS NOT NULL
$$;
-- The archive: released issues by date, newest first, with their edition identity.
CREATE FUNCTION trustwork.content_public_archive(p_hub uuid, p_year integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', i.id::text, 'number', i.number, 'date', to_char(i.issue_date, 'YYYY-MM-DD'), 'theme', i.theme, 'status', i.status,
                                               'currentEdition', i.current_edition, 'coverAssetId', i.cover_asset_id::text,
                                               'items', (SELECT count(*) FROM trustwork.issue_item it JOIN trustwork.issue_revision r ON r.id = it.issue_revision_id
                                                         WHERE r.issue_id = i.id AND r.edition = i.current_edition))
                            ORDER BY i.issue_date DESC, i.number DESC), '[]'::jsonb)
  FROM trustwork.issue i WHERE i.hub_id = p_hub AND i.current_edition IS NOT NULL AND (p_year IS NULL OR extract(year FROM i.issue_date) = p_year)
$$;
-- A wall: references in position order (pinned first); a held or unpublished item is left out; each shows whether
-- its publication was corrected or retracted since.
CREATE FUNCTION trustwork.content_public_wall(p_kind text, p_owner uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', w.id::text, 'publicationId', p.id::text, 'pinned', w.pinned, 'position', w.position,
                                               'version', coalesce(v.version, p.current_version), 'followsCurrent', w.publication_version_id IS NULL,
                                               'title', coalesce(v.title, c.title), 'format', p.format, 'currentVersion', p.current_version,
                                               'corrected', p.status = 'corrected', 'retracted', p.status = 'retracted',
                                               'correctionNote', (SELECT x.correction_note FROM trustwork.publication_version x WHERE x.id = p.current_version_id))
                            ORDER BY w.pinned DESC, w.position), '[]'::jsonb)
  FROM trustwork.wall_reference w JOIN trustwork.publication p ON p.id = w.publication_id
  JOIN trustwork.publication_version c ON c.id = p.current_version_id
  LEFT JOIN trustwork.publication_version v ON v.id = w.publication_version_id
  WHERE w.removed_at IS NULL AND w.wall_kind = p_kind AND coalesce(w.wall_person_id, w.wall_company_id) = p_owner AND trustwork.content_public_ok(p)
$$;
CREATE FUNCTION trustwork.content_public_comments(p_hub uuid, p_pub uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', c.id::text, 'parentId', c.parent_id::text, 'authorId', c.author_person_id::text, 'body', c.body,
                                               'createdAt', trustwork.content_iso(c.created_at)) ORDER BY c.created_at, c.id), '[]'::jsonb)
  FROM trustwork.publication_comment c JOIN trustwork.publication p ON p.id = c.publication_id
  WHERE c.publication_id = p_pub AND p.hub_id = p_hub AND c.status = 'visible' AND trustwork.content_public_ok(p)
$$;
CREATE FUNCTION trustwork.content_public_digest(p_hub uuid, p_digest uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT jsonb_build_object('id', d.id::text, 'title', d.title, 'period', d.period, 'releasedAt', trustwork.content_iso(d.released_at),
    'items', (SELECT coalesce(jsonb_agg(CASE WHEN p.id IS NULL OR trustwork.content_public_ok(p) THEN
                jsonb_build_object('position', i.position, 'homeNode', i.home_node, 'globalId', i.global_id, 'version', i.version, 'licence', i.licence, 'display', i.display,
                                   'title', i.title, 'body', CASE WHEN i.display = 'full' AND p.status <> 'retracted' THEN v.body END, 'withheld', false)
              ELSE jsonb_build_object('position', i.position, 'homeNode', i.home_node, 'globalId', i.global_id, 'version', i.version, 'withheld', true) END ORDER BY i.position), '[]'::jsonb)
              FROM trustwork.magazine_digest_item i LEFT JOIN trustwork.publication p ON p.id = i.local_publication_id LEFT JOIN trustwork.publication_version v ON v.id = i.local_version_id
              WHERE i.digest_id = d.id))
  FROM trustwork.magazine_digest d WHERE d.id = p_digest AND d.hub_id = p_hub AND d.status = 'released'
$$;

-- 8. Row-level security: the runtime role reads its own working set; it writes nothing directly ----------------------
ALTER TABLE trustwork.publication ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.publication FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.publication_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.publication_version FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.publication_authorship ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.publication_authorship FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.publication_editor ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.publication_editor FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.correction ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.correction FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.publication_topic ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.publication_topic FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.entity_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.entity_link FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.edition_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.edition_link FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.wall_reference ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.wall_reference FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.publication_comment ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.publication_comment FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.issue ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.issue FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.issue_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.issue_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.issue_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.issue_item FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.render_artifact ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.render_artifact FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.magazine_digest ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.magazine_digest FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.magazine_digest_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.magazine_digest_item FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.publication AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.publication_version AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.publication_authorship AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.publication_editor AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.correction AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.publication_topic AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.entity_link AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.edition_link AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.wall_reference AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.publication_comment AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.issue AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.issue_revision AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.issue_item AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.render_artifact AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.magazine_digest AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.magazine_digest_item AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

CREATE POLICY publication_read ON trustwork.publication FOR SELECT TO trustwork_app USING (trustwork.content_can_view(id));
CREATE POLICY publication_version_read ON trustwork.publication_version FOR SELECT TO trustwork_app USING (trustwork.content_can_view(publication_id));
CREATE POLICY publication_authorship_read ON trustwork.publication_authorship FOR SELECT TO trustwork_app USING (trustwork.content_can_view(publication_id));
CREATE POLICY publication_editor_read ON trustwork.publication_editor FOR SELECT TO trustwork_app
  USING (person_id = trustwork.current_person_id() OR trustwork.content_can_view(publication_id));
CREATE POLICY correction_read ON trustwork.correction FOR SELECT TO trustwork_app
  USING ((publication_id IS NOT NULL AND trustwork.content_can_view(publication_id))
         OR (issue_id IS NOT NULL AND trustwork.admin_has_any_permission(ARRAY['admin.issues.read', 'admin.issues.curate'], NULL, hub_id)));
CREATE POLICY publication_topic_read ON trustwork.publication_topic FOR SELECT TO trustwork_app USING (trustwork.content_can_view(publication_id));
CREATE POLICY entity_link_read ON trustwork.entity_link FOR SELECT TO trustwork_app USING (trustwork.content_can_view(publication_id));
CREATE POLICY edition_link_read ON trustwork.edition_link FOR SELECT TO trustwork_app
  USING (trustwork.content_can_view(original_publication_id) OR trustwork.content_can_view(translation_publication_id));
CREATE POLICY wall_reference_read ON trustwork.wall_reference FOR SELECT TO trustwork_app
  USING (wall_person_id = trustwork.current_person_id() OR (wall_company_id IS NOT NULL AND wall_company_id = trustwork.current_company_id()));
CREATE POLICY publication_comment_read ON trustwork.publication_comment FOR SELECT TO trustwork_app
  USING (author_person_id = trustwork.current_person_id() OR trustwork.content_can_view(publication_id));
CREATE POLICY issue_read ON trustwork.issue FOR SELECT TO trustwork_app
  USING (trustwork.admin_has_any_permission(ARRAY['admin.issues.read', 'admin.issues.curate', 'admin.issues.release'], NULL, hub_id));
CREATE POLICY issue_revision_read ON trustwork.issue_revision FOR SELECT TO trustwork_app
  USING (EXISTS (SELECT 1 FROM trustwork.issue i WHERE i.id = issue_id));
CREATE POLICY issue_item_read ON trustwork.issue_item FOR SELECT TO trustwork_app
  USING (EXISTS (SELECT 1 FROM trustwork.issue_revision r WHERE r.id = issue_revision_id));
CREATE POLICY render_artifact_read ON trustwork.render_artifact FOR SELECT TO trustwork_app
  USING (EXISTS (SELECT 1 FROM trustwork.issue_revision r WHERE r.id = issue_revision_id));
CREATE POLICY magazine_digest_read ON trustwork.magazine_digest FOR SELECT TO trustwork_app
  USING (trustwork.admin_has_any_permission(ARRAY['admin.issues.read', 'admin.issues.curate', 'admin.issues.release'], NULL, hub_id));
CREATE POLICY magazine_digest_item_read ON trustwork.magazine_digest_item FOR SELECT TO trustwork_app
  USING (EXISTS (SELECT 1 FROM trustwork.magazine_digest d WHERE d.id = digest_id));

-- 9. Grants: SELECT only (no INSERT, UPDATE or DELETE on any content table); the commands are the write path ---------
GRANT SELECT ON trustwork.publication, trustwork.publication_version, trustwork.publication_authorship, trustwork.publication_editor, trustwork.correction,
  trustwork.publication_topic, trustwork.entity_link, trustwork.edition_link, trustwork.wall_reference, trustwork.publication_comment, trustwork.issue,
  trustwork.issue_revision, trustwork.issue_item, trustwork.render_artifact, trustwork.magazine_digest, trustwork.magazine_digest_item TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.content_can_view(uuid), trustwork.content_create(jsonb, uuid, text, uuid, text, text, text, text, boolean, jsonb, jsonb),
  trustwork.content_save_draft(jsonb, uuid, integer, jsonb, jsonb), trustwork.content_transition(jsonb, uuid, integer, text), trustwork.content_publish(jsonb, uuid, integer, timestamptz),
  trustwork.content_correct(jsonb, uuid, integer, jsonb, text, text), trustwork.content_retract(jsonb, uuid, integer, text), trustwork.content_set_links(jsonb, uuid, integer, text[], jsonb),
  trustwork.content_grant_editor(uuid, uuid, text), trustwork.content_revoke_editor(uuid, uuid), trustwork.content_link_edition(jsonb, uuid, uuid, boolean),
  trustwork.content_review_edition(jsonb, uuid), trustwork.content_wall_add(text, uuid, uuid, uuid, boolean), trustwork.content_wall_remove(uuid),
  trustwork.content_comment(uuid, uuid, text), trustwork.content_apply_moderation(uuid, text),
  trustwork.content_issue_create(jsonb, uuid, integer, date, text, uuid, uuid), trustwork.content_issue_curate(jsonb, uuid, integer, jsonb, text, uuid, uuid),
  trustwork.content_issue_transition(jsonb, uuid, integer, text), trustwork.content_issue_release(jsonb, uuid, integer), trustwork.content_issue_correct(jsonb, uuid, integer, text),
  trustwork.content_render_request(jsonb, uuid, integer, text), trustwork.content_render_record(jsonb, uuid, text, uuid, text, text, text),
  trustwork.content_digest_create(jsonb, uuid, text, text, uuid[]), trustwork.content_digest_release(jsonb, uuid, integer),
  trustwork.content_public_publication(uuid, uuid), trustwork.content_public_version(uuid, uuid, integer), trustwork.content_public_feed(uuid, text, text, timestamptz, uuid, integer),
  trustwork.content_public_issue(uuid, integer, integer), trustwork.content_public_archive(uuid, integer), trustwork.content_public_wall(text, uuid),
  trustwork.content_public_comments(uuid, uuid), trustwork.content_public_digest(uuid, uuid) TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.content_publish_due(integer) TO trustwork_worker;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
