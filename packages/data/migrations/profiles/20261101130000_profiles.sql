-- PPL-001 profiles, consent records, portraits and experience (ADR 010 decision 18; data model section 4). Mirrors
-- packages/contracts/src/profiles.ts (CONSENT_PURPOSES, CONSENT_TARGET_BY_PURPOSE, PROFILE_PUBLIC_FIELDS, statuses).
--
-- Rules carried by the database, whatever the application does:
--   * every table is under FORCE RLS and readable and writable only by the person it belongs to: no employer,
--     colleague, other person or anonymous caller reads a profile row, a consent, a bookmark, a follow or reading
--     progress; public reads go only through the owner-run allowlisted functions in section 9;
--   * no consent, no public link: a profile is public only with a live profile_public consent (the person trigger in
--     section 8 refuses the switch otherwise), a portrait is shown only with a live portrait_display consent and a live
--     media licence on the same file, a company lists a member and a publication links a mention only with a live
--     consent naming that company or publication;
--   * withdrawing a consent (or revoking a licence) unpublishes the dependent projections in the same transaction and
--     writes a tombstone plus an identifiers-only outbox event, so search, retrieval, federation and caches drop them;
--   * consent records change once (withdrawal) and are never rewritten; tombstones are append-only;
--   * experience entries belong to the person: no membership change touches them, and a company confirmation is a
--     separate label that the runtime role cannot set.

-- 0. Helpers (invoker) ------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.profiles_codes_ok(p_codes text[], p_pattern text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT array_position(p_codes, NULL) IS NULL
    AND coalesce((SELECT bool_and(c ~ p_pattern) FROM unnest(p_codes) AS c), true)
    AND cardinality(p_codes) = (SELECT count(DISTINCT c) FROM unnest(p_codes) AS c)
$$;

-- The target kind a consent purpose names (CONSENT_TARGET_BY_PURPOSE); NULL: the person's own presentation.
CREATE FUNCTION trustwork.profiles_consent_target_kind(p_purpose text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT CASE p_purpose
    WHEN 'mentioned_in_publication' THEN 'publication'
    WHEN 'listed_by_company' THEN 'company'
    WHEN 'speaker_profile_link' THEN 'event'
    WHEN 'public_participant' THEN 'project'
    WHEN 'cross_hub_syndication' THEN 'hub'
    WHEN 'data_sharing_with_organizer' THEN 'organizer'
    WHEN 'project_knowledge_share' THEN 'project'
    WHEN 'portfolio_display' THEN 'project'
    ELSE NULL END
$$;

-- The projection a purpose's withdrawal unpublishes (PROJECTION_BY_PURPOSE).
CREATE FUNCTION trustwork.profiles_projection_for(p_purpose text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT CASE p_purpose
    WHEN 'profile_public' THEN 'profile'
    WHEN 'portrait_display' THEN 'portrait'
    WHEN 'listed_by_company' THEN 'company_listing'
    WHEN 'mentioned_in_publication' THEN 'publication_mention'
    WHEN 'speaker_profile_link' THEN 'speaker_link'
    WHEN 'public_participant' THEN 'project_participant'
    ELSE 'consented_use' END
$$;

-- A maintenance session: a login that is a member of trustwork_owner with the maintenance flag (BE-002); the flag alone
-- proves nothing because the runtime role may set it. Invoker copy of trustwork.maintenance_session() for these guards.
CREATE FUNCTION trustwork.profiles_maintenance() RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT current_setting('trustwork.maintenance', true) = 'on' AND pg_has_role(session_user, 'trustwork_owner', 'MEMBER')
$$;

-- Runtime writes are the subject's own; a maintenance session (seeding, erasure, repair) may act for anyone.
CREATE FUNCTION trustwork.profiles_is_subject(p_person_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.profiles_maintenance() OR (trustwork.current_person_id() IS NOT NULL AND p_person_id = trustwork.current_person_id())
$$;

-- 1. Profile ----------------------------------------------------------------------------------------------------------
-- Optional public parts; the display name, headline and expertise stay on trustwork.person (identity module).
CREATE TABLE trustwork.person_profile (
  person_id uuid PRIMARY KEY REFERENCES trustwork.person (id),
  role_line text NULL CHECK (length(btrim(role_line)) BETWEEN 1 AND 200),
  region_code text NULL CHECK (region_code ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?(:[a-z0-9][a-z0-9-]{0,62})?$'),
  show_employer boolean NOT NULL DEFAULT false,
  topics text[] NOT NULL DEFAULT '{}' CHECK (cardinality(topics) <= 20 AND trustwork.profiles_codes_ok(topics, '^[a-z][a-z0-9_]{1,40}$')),
  languages text[] NOT NULL DEFAULT '{}' CHECK (cardinality(languages) <= 10 AND trustwork.profiles_codes_ok(languages, '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$')),
  public_fields text[] NOT NULL DEFAULT '{}' CHECK (
    public_fields <@ ARRAY['roleLine', 'region', 'topics', 'languages', 'experience', 'employer', 'portrait']::text[]
    AND trustwork.profiles_codes_ok(public_fields, '^[a-zA-Z]+$')
  ),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER person_profile_touch BEFORE UPDATE ON trustwork.person_profile FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- 2. Preferences (owner-private; confer no rights) ----------------------------------------------------------------------
CREATE TABLE trustwork.person_preference (
  person_id uuid PRIMARY KEY REFERENCES trustwork.person (id),
  intents text[] NOT NULL DEFAULT '{}' CHECK (intents <@ ARRAY['read', 'publish', 'buy', 'sell', 'find_work', 'host_events']::text[] AND trustwork.profiles_codes_ok(intents, '^[a-z_]+$')),
  topics text[] NOT NULL DEFAULT '{}' CHECK (cardinality(topics) <= 20 AND trustwork.profiles_codes_ok(topics, '^[a-z][a-z0-9_]{1,40}$')),
  regions text[] NOT NULL DEFAULT '{}' CHECK (cardinality(regions) <= 20 AND trustwork.profiles_codes_ok(regions, '^[A-Z]{2}(-[A-Z0-9]{1,3})?(:[a-z0-9][a-z0-9-]{0,62})?$')),
  onboarding_completed_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER person_preference_touch BEFORE UPDATE ON trustwork.person_preference FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- Shared guard of the two per-person rows: the subject only, person immutable, no restricted place.
CREATE FUNCTION trustwork.profiles_person_row_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_place text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT trustwork.profiles_maintenance() THEN
      RAISE EXCEPTION '% rows are removed only by the erasure executor', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege', HINT = 'profiles.not_authorised';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.person_id <> OLD.person_id THEN
    RAISE EXCEPTION 'a profile row belongs to its person' USING ERRCODE = 'integrity_constraint_violation', HINT = 'profiles.immutable';
  END IF;
  IF NOT trustwork.profiles_is_subject(NEW.person_id) THEN
    RAISE EXCEPTION 'only the person edits their profile' USING ERRCODE = 'insufficient_privilege', HINT = 'profiles.not_authorised';
  END IF;
  IF TG_TABLE_NAME = 'person_profile' THEN
    IF NEW.region_code IS NOT NULL AND trustwork.kernel_place_restricted(NEW.region_code) THEN
      RAISE EXCEPTION 'restricted place' USING ERRCODE = 'check_violation', HINT = 'profiles.restricted_place';
    END IF;
  ELSE
    FOREACH v_place IN ARRAY NEW.regions LOOP
      IF trustwork.kernel_place_restricted(v_place) THEN
        RAISE EXCEPTION 'restricted place' USING ERRCODE = 'check_violation', HINT = 'profiles.restricted_place';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER person_profile_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.person_profile FOR EACH ROW EXECUTE FUNCTION trustwork.profiles_person_row_guard();
CREATE TRIGGER person_preference_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.person_preference FOR EACH ROW EXECUTE FUNCTION trustwork.profiles_person_row_guard();

-- 3. Consent records ----------------------------------------------------------------------------------------------------
-- Explicit (first-party form evidence), versioned (notice_version belongs to the purpose), revocable (withdrawn_at, the
-- only column that ever changes, once). One live record per (subject, purpose, target).
CREATE TABLE trustwork.consent_record (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  subject_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  purpose text NOT NULL CHECK (purpose IN (
    'profile_public', 'mentioned_in_publication', 'listed_by_company', 'portrait_display', 'speaker_profile_link', 'public_participant', 'marketing',
    'research_participation', 'cross_hub_syndication', 'data_sharing_with_organizer', 'sale_or_share_opt_in', 'project_knowledge_share', 'portfolio_display',
    'mentoring_listing', 'passport_publication')),
  target_kind text NULL CHECK (target_kind IN ('company', 'publication', 'event', 'project', 'hub', 'organizer')),
  target_id uuid NULL,
  notice_version text NOT NULL CHECK (notice_version ~ '^[a-z_]+\.v[1-9][0-9]{0,3}$'),
  granted_at timestamptz NOT NULL DEFAULT now(),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object' AND evidence ->> 'method' = 'first_party_form' AND length(evidence ->> 'requestId') BETWEEN 1 AND 128),
  withdrawn_at timestamptz NULL,
  withdrawn_reason text NULL CHECK (length(btrim(withdrawn_reason)) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consent_record_target_pair CHECK ((target_kind IS NULL) = (target_id IS NULL)),
  CONSTRAINT consent_record_target_by_purpose CHECK (target_kind IS NOT DISTINCT FROM trustwork.profiles_consent_target_kind(purpose)),
  CONSTRAINT consent_record_notice_purpose CHECK (left(notice_version, length(purpose) + 2) = purpose || '.v' AND notice_version ~ ('^' || purpose || '\.v[0-9]+$')),
  CONSTRAINT consent_record_withdrawal CHECK ((withdrawn_at IS NULL) = (withdrawn_reason IS NULL) AND (withdrawn_at IS NULL OR withdrawn_at >= granted_at))
);
CREATE UNIQUE INDEX consent_record_one_live ON trustwork.consent_record (subject_person_id, purpose, coalesce(target_kind, ''), coalesce(target_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE withdrawn_at IS NULL;
CREATE INDEX consent_record_target_idx ON trustwork.consent_record (purpose, target_kind, target_id) WHERE withdrawn_at IS NULL AND target_id IS NOT NULL;

CREATE FUNCTION trustwork.profiles_consent_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- consent_proof retention: removed only after the limitation period, by the owner-run sweeper or erasure executor.
    IF NOT trustwork.profiles_maintenance() THEN
      RAISE EXCEPTION 'consent records are kept as proof' USING ERRCODE = 'insufficient_privilege', HINT = 'profiles.consent_immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT trustwork.profiles_is_subject(NEW.subject_person_id) THEN
      RAISE EXCEPTION 'only the person consents for themselves' USING ERRCODE = 'insufficient_privilege', HINT = 'profiles.not_authorised';
    END IF;
    IF NEW.withdrawn_at IS NOT NULL THEN
      RAISE EXCEPTION 'a consent starts live' USING ERRCODE = 'check_violation', HINT = 'profiles.consent_immutable';
    END IF;
    IF NOT trustwork.profiles_maintenance() THEN
      NEW.granted_at := now();
      NEW.created_at := now();
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.subject_person_id <> OLD.subject_person_id OR NEW.purpose <> OLD.purpose OR NEW.target_kind IS DISTINCT FROM OLD.target_kind
     OR NEW.target_id IS DISTINCT FROM OLD.target_id OR NEW.notice_version <> OLD.notice_version OR NEW.granted_at <> OLD.granted_at
     OR NEW.evidence <> OLD.evidence OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a consent record is never rewritten; withdraw it and consent again' USING ERRCODE = 'integrity_constraint_violation', HINT = 'profiles.consent_immutable';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'withdrawal is final' USING ERRCODE = 'integrity_constraint_violation', HINT = 'profiles.consent_immutable';
  END IF;
  IF NEW.withdrawn_at IS NULL THEN
    RAISE EXCEPTION 'the only change to a consent is its withdrawal' USING ERRCODE = 'integrity_constraint_violation', HINT = 'profiles.consent_immutable';
  END IF;
  IF NOT trustwork.profiles_is_subject(OLD.subject_person_id) THEN
    RAISE EXCEPTION 'only the person withdraws their consent' USING ERRCODE = 'insufficient_privilege', HINT = 'profiles.not_authorised';
  END IF;
  IF NOT trustwork.profiles_maintenance() THEN
    NEW.withdrawn_at := greatest(now(), OLD.granted_at);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consent_record_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.consent_record FOR EACH ROW EXECUTE FUNCTION trustwork.profiles_consent_guard();

-- 4. Media licences and portraits ---------------------------------------------------------------------------------------
-- asset_id references trustwork.evidence_artifact by value, not by foreign key: deleting a file (FILE-001 worker) must
-- never be blocked by a licence record, and every public read joins the live artifact, so a deleted file shows nothing.
CREATE TABLE trustwork.media_licence (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  asset_id uuid NOT NULL,
  owner_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  licensor text NOT NULL CHECK (length(btrim(licensor)) BETWEEN 1 AND 200),
  licence_kind text NOT NULL CHECK (licence_kind IN ('own_work', 'licensed', 'cc_by', 'cc_by_sa', 'public_domain')),
  scope text NOT NULL CHECK (length(btrim(scope)) BETWEEN 1 AND 500),
  valid_until timestamptz NULL,
  recorded_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  revoked_at timestamptz NULL,
  revoked_by_person_id uuid NULL REFERENCES trustwork.person (id),
  revoked_reason text NULL CHECK (length(btrim(revoked_reason)) BETWEEN 1 AND 500),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_licence_validity CHECK (valid_until IS NULL OR valid_until > created_at),
  CONSTRAINT media_licence_revocation CHECK ((revoked_at IS NULL) = (revoked_by_person_id IS NULL) AND (revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX media_licence_asset_idx ON trustwork.media_licence (asset_id);
CREATE INDEX media_licence_owner_idx ON trustwork.media_licence (owner_person_id);
CREATE TRIGGER media_licence_touch BEFORE UPDATE ON trustwork.media_licence FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

CREATE FUNCTION trustwork.profiles_licence_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'licence records are kept as evidence' USING ERRCODE = 'integrity_constraint_violation', HINT = 'profiles.licence_immutable';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT trustwork.profiles_maintenance() THEN
      IF NEW.owner_person_id IS DISTINCT FROM trustwork.current_person_id() OR NEW.recorded_by_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
        RAISE EXCEPTION 'a person records licences for their own files' USING ERRCODE = 'insufficient_privilege', HINT = 'profiles.not_authorised';
      END IF;
      NEW.created_at := now();
    END IF;
    IF NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'a licence starts unrevoked' USING ERRCODE = 'check_violation', HINT = 'profiles.licence_immutable';
    END IF;
    -- The file is the person's own (read under the caller's visibility; a deleted file is hidden).
    IF NOT EXISTS (SELECT 1 FROM trustwork.evidence_artifact a WHERE a.id = NEW.asset_id AND a.owner_person_id = NEW.owner_person_id) THEN
      RAISE EXCEPTION 'the licensed file is not the person''s own' USING ERRCODE = 'check_violation', HINT = 'profiles.asset_not_owned';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.asset_id <> OLD.asset_id OR NEW.owner_person_id <> OLD.owner_person_id OR NEW.licensor <> OLD.licensor
     OR NEW.licence_kind <> OLD.licence_kind OR NEW.scope <> OLD.scope OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
     OR NEW.recorded_by_person_id <> OLD.recorded_by_person_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'licence terms are immutable; revoke and record a new licence' USING ERRCODE = 'integrity_constraint_violation', HINT = 'profiles.licence_immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'the only change to a licence is its revocation, once' USING ERRCODE = 'integrity_constraint_violation', HINT = 'profiles.licence_immutable';
  END IF;
  IF NOT trustwork.profiles_maintenance() THEN
    IF OLD.owner_person_id IS DISTINCT FROM trustwork.current_person_id() OR NEW.revoked_by_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
      RAISE EXCEPTION 'only the person revokes their licence records' USING ERRCODE = 'insufficient_privilege', HINT = 'profiles.not_authorised';
    END IF;
    NEW.revoked_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER media_licence_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.media_licence FOR EACH ROW EXECUTE FUNCTION trustwork.profiles_licence_guard();

CREATE TABLE trustwork.portrait (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  asset_id uuid NOT NULL,
  media_licence_id uuid NOT NULL REFERENCES trustwork.media_licence (id),
  consent_record_id uuid NULL REFERENCES trustwork.consent_record (id),
  status text NOT NULL CHECK (status IN ('pending', 'shown', 'withdrawn')),
  withdrawn_at timestamptz NULL,
  withdrawn_reason text NULL CHECK (withdrawn_reason IN ('consent_withdrawn', 'licence_revoked', 'replaced', 'removed')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portrait_shown_consent CHECK (status <> 'shown' OR consent_record_id IS NOT NULL),
  CONSTRAINT portrait_withdrawal CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL) AND (withdrawn_at IS NULL) = (withdrawn_reason IS NULL))
);
CREATE UNIQUE INDEX portrait_one_shown ON trustwork.portrait (person_id) WHERE status = 'shown';
CREATE INDEX portrait_consent_idx ON trustwork.portrait (consent_record_id) WHERE status <> 'withdrawn';
CREATE INDEX portrait_licence_idx ON trustwork.portrait (media_licence_id) WHERE status <> 'withdrawn';
CREATE TRIGGER portrait_touch BEFORE UPDATE ON trustwork.portrait FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- A portrait is shown only with BOTH a live portrait_display consent of the person and a live licence on the same file,
-- and only for the person's own public file attached to their person page.
CREATE FUNCTION trustwork.profiles_portrait_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'portrait records are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'profiles.portrait_immutable';
  END IF;
  IF NOT trustwork.profiles_is_subject(NEW.person_id) THEN
    RAISE EXCEPTION 'only the person chooses their portrait' USING ERRCODE = 'insufficient_privilege', HINT = 'profiles.not_authorised';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id OR NEW.person_id <> OLD.person_id OR NEW.asset_id <> OLD.asset_id OR NEW.media_licence_id <> OLD.media_licence_id OR NEW.created_at <> OLD.created_at
       OR (NEW.consent_record_id IS DISTINCT FROM OLD.consent_record_id AND OLD.status <> 'pending') THEN
      RAISE EXCEPTION 'a portrait keeps its file, licence and consent' USING ERRCODE = 'integrity_constraint_violation', HINT = 'profiles.portrait_immutable';
    END IF;
    IF OLD.status = 'withdrawn' OR (OLD.status = 'shown' AND NEW.status = 'pending') THEN
      RAISE EXCEPTION 'portrait % -> % is not a transition', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation', HINT = 'profiles.portrait_immutable';
    END IF;
    IF NEW.status = 'withdrawn' AND OLD.status <> 'withdrawn' AND NOT trustwork.profiles_maintenance() THEN
      NEW.withdrawn_at := now();
    END IF;
  ELSIF NEW.status = 'withdrawn' THEN
    RAISE EXCEPTION 'a portrait starts pending or shown' USING ERRCODE = 'check_violation', HINT = 'profiles.portrait_immutable';
  END IF;
  IF NEW.status = 'shown' AND (TG_OP = 'INSERT' OR OLD.status <> 'shown') THEN
    IF NOT EXISTS (
      SELECT 1 FROM trustwork.media_licence l
      WHERE l.id = NEW.media_licence_id AND l.asset_id = NEW.asset_id AND l.owner_person_id = NEW.person_id
        AND l.revoked_at IS NULL AND (l.valid_until IS NULL OR l.valid_until > now())
    ) THEN
      RAISE EXCEPTION 'a portrait needs a live licence record for this file' USING ERRCODE = 'check_violation', HINT = 'profiles.licence_missing';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM trustwork.consent_record c
      WHERE c.id = NEW.consent_record_id AND c.subject_person_id = NEW.person_id AND c.purpose = 'portrait_display' AND c.withdrawn_at IS NULL
    ) THEN
      RAISE EXCEPTION 'a portrait needs the person''s live portrait consent' USING ERRCODE = 'check_violation', HINT = 'profiles.consent_required';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM trustwork.evidence_artifact a
      WHERE a.id = NEW.asset_id AND a.owner_person_id = NEW.person_id AND a.classification = 'public' AND a.parent_kind = 'person' AND a.parent_id = NEW.person_id
        AND a.media_type IN ('image/jpeg', 'image/png', 'image/webp')
    ) THEN
      RAISE EXCEPTION 'a portrait is the person''s own public image on their page' USING ERRCODE = 'check_violation', HINT = 'profiles.asset_not_owned';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER portrait_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.portrait FOR EACH ROW EXECUTE FUNCTION trustwork.profiles_portrait_guard();

-- 5. Experience ---------------------------------------------------------------------------------------------------------
-- Belongs to the person and survives every membership change (no reference to membership). organisation_company_id
-- links a platform company when there is one; the name is the person's own words. A company confirmation is a
-- separate label set only by an owner-run confirmation path (REP-001), never by the runtime role, and an edit of the
-- confirmed facts clears it (the confirmation covered what was confirmed, not the new text).
CREATE TABLE trustwork.experience_entry (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  organisation_company_id uuid NULL REFERENCES trustwork.company (id),
  organisation_name text NOT NULL CHECK (length(btrim(organisation_name)) BETWEEN 1 AND 200),
  role text NOT NULL CHECK (length(btrim(role)) BETWEEN 1 AND 200),
  summary text NULL CHECK (length(summary) <= 2000),
  from_date date NOT NULL,
  to_date date NULL,
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  confirmed_by_company_at timestamptz NULL,
  confirmed_by_person_id uuid NULL REFERENCES trustwork.person (id),
  archived_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT experience_entry_dates CHECK (to_date IS NULL OR from_date <= to_date),
  CONSTRAINT experience_entry_confirmation CHECK ((confirmed_by_company_at IS NULL) = (confirmed_by_person_id IS NULL)
    AND (confirmed_by_company_at IS NULL OR organisation_company_id IS NOT NULL))
);
CREATE INDEX experience_entry_person_idx ON trustwork.experience_entry (person_id, from_date DESC) WHERE archived_at IS NULL;
CREATE TRIGGER experience_entry_touch BEFORE UPDATE ON trustwork.experience_entry FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

CREATE FUNCTION trustwork.profiles_experience_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT trustwork.profiles_maintenance() THEN
      RAISE EXCEPTION 'experience entries are archived, not deleted' USING ERRCODE = 'insufficient_privilege', HINT = 'profiles.not_authorised';
    END IF;
    RETURN OLD;
  END IF;
  IF NOT trustwork.profiles_is_subject(NEW.person_id) THEN
    RAISE EXCEPTION 'experience belongs to the person' USING ERRCODE = 'insufficient_privilege', HINT = 'profiles.not_authorised';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT trustwork.profiles_maintenance() AND (NEW.confirmed_by_company_at IS NOT NULL OR NEW.archived_at IS NOT NULL) THEN
      RAISE EXCEPTION 'a new entry is self-declared and live' USING ERRCODE = 'insufficient_privilege', HINT = 'profiles.not_authorised';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.person_id <> OLD.person_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'an experience entry keeps its person' USING ERRCODE = 'integrity_constraint_violation', HINT = 'profiles.immutable';
  END IF;
  IF OLD.archived_at IS NOT NULL AND NOT trustwork.profiles_maintenance() THEN
    RAISE EXCEPTION 'an archived entry is final' USING ERRCODE = 'integrity_constraint_violation', HINT = 'profiles.immutable';
  END IF;
  IF NOT trustwork.profiles_maintenance() THEN
    IF NEW.archived_at IS NOT NULL THEN
      NEW.archived_at := now();
    END IF;
    IF NEW.organisation_company_id IS DISTINCT FROM OLD.organisation_company_id OR NEW.organisation_name <> OLD.organisation_name OR NEW.role <> OLD.role
       OR NEW.from_date <> OLD.from_date OR NEW.to_date IS DISTINCT FROM OLD.to_date THEN
      NEW.confirmed_by_company_at := NULL;
      NEW.confirmed_by_person_id := NULL;
    ELSIF NEW.confirmed_by_company_at IS DISTINCT FROM OLD.confirmed_by_company_at OR NEW.confirmed_by_person_id IS DISTINCT FROM OLD.confirmed_by_person_id THEN
      RAISE EXCEPTION 'a person cannot confirm their own experience' USING ERRCODE = 'insufficient_privilege', HINT = 'profiles.not_authorised';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER experience_entry_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.experience_entry FOR EACH ROW EXECUTE FUNCTION trustwork.profiles_experience_guard();

-- 6. Follows, bookmarks, reading progress (owner-private) ----------------------------------------------------------------
CREATE TABLE trustwork.follow (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  follower_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  target_kind text NOT NULL CHECK (target_kind IN ('person', 'company', 'topic', 'region', 'hub', 'event_series')),
  target_id uuid NULL,
  target_code text NULL CHECK (target_code ~ '^([a-z][a-z0-9_]{1,40}|[A-Z]{2}(-[A-Z0-9]{1,3})?(:[a-z0-9][a-z0-9-]{0,62})?)$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz NULL,
  CONSTRAINT follow_target_shape CHECK ((target_kind IN ('topic', 'region')) = (target_code IS NOT NULL) AND (target_id IS NULL) <> (target_code IS NULL)),
  CONSTRAINT follow_not_self CHECK (NOT (target_kind = 'person' AND target_id = follower_person_id))
);
CREATE UNIQUE INDEX follow_one_live ON trustwork.follow (follower_person_id, target_kind, coalesce(target_id::text, target_code)) WHERE ended_at IS NULL;

CREATE TABLE trustwork.bookmark (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  target_kind text NOT NULL CHECK (target_kind IN ('publication', 'event', 'course', 'project', 'person', 'company', 'offering', 'need')),
  target_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz NULL
);
CREATE UNIQUE INDEX bookmark_one_live ON trustwork.bookmark (person_id, target_kind, target_id) WHERE removed_at IS NULL;

-- publication_version_id references the content module's versions by value (they are not migrated yet).
CREATE TABLE trustwork.reading_progress (
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  publication_version_id uuid NOT NULL,
  progress text NOT NULL CHECK (progress ~ '^(0(\.[0-9]{1,3})?|1(\.0{1,3})?)$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, publication_version_id)
);
CREATE TRIGGER reading_progress_touch BEFORE UPDATE ON trustwork.reading_progress FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- Owner-private rows: the subject only; identity columns immutable; follows end and bookmarks are removed once.
CREATE FUNCTION trustwork.profiles_private_row_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
  v_owner uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT trustwork.profiles_maintenance() THEN
      RAISE EXCEPTION '% rows are removed only by the erasure executor', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege', HINT = 'profiles.not_authorised';
    END IF;
    RETURN OLD;
  END IF;
  v_new := to_jsonb(NEW);
  v_owner := coalesce(v_new ->> 'person_id', v_new ->> 'follower_person_id')::uuid;
  IF NOT trustwork.profiles_is_subject(v_owner) THEN
    RAISE EXCEPTION 'these records belong to their person only' USING ERRCODE = 'insufficient_privilege', HINT = 'profiles.not_authorised';
  END IF;
  IF TG_TABLE_NAME = 'follow' AND v_new ->> 'target_kind' = 'region' AND trustwork.kernel_place_restricted(v_new ->> 'target_code') THEN
    RAISE EXCEPTION 'restricted place' USING ERRCODE = 'check_violation', HINT = 'profiles.restricted_place';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF coalesce(v_new ->> 'ended_at', v_new ->> 'removed_at') IS NOT NULL THEN
      RAISE EXCEPTION 'a new record is live' USING ERRCODE = 'check_violation', HINT = 'profiles.immutable';
    END IF;
    RETURN NEW;
  END IF;
  v_old := to_jsonb(OLD);
  IF TG_TABLE_NAME = 'reading_progress' THEN
    IF (v_new - ARRAY['progress', 'revision', 'updated_at']) <> (v_old - ARRAY['progress', 'revision', 'updated_at']) THEN
      RAISE EXCEPTION 'only the progress changes' USING ERRCODE = 'integrity_constraint_violation', HINT = 'profiles.immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF (v_new - ARRAY['ended_at', 'removed_at']) <> (v_old - ARRAY['ended_at', 'removed_at'])
     OR coalesce(v_old ->> 'ended_at', v_old ->> 'removed_at') IS NOT NULL
     OR coalesce(v_new ->> 'ended_at', v_new ->> 'removed_at') IS NULL THEN
    RAISE EXCEPTION 'a follow ends and a bookmark is removed once; nothing else changes' USING ERRCODE = 'integrity_constraint_violation', HINT = 'profiles.immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER follow_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.follow FOR EACH ROW EXECUTE FUNCTION trustwork.profiles_private_row_guard();
CREATE TRIGGER bookmark_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.bookmark FOR EACH ROW EXECUTE FUNCTION trustwork.profiles_private_row_guard();
CREATE TRIGGER reading_progress_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.reading_progress FOR EACH ROW EXECUTE FUNCTION trustwork.profiles_private_row_guard();

-- 7. Tombstones -------------------------------------------------------------------------------------------------------
-- What must stay gone (retention class `tombstone`): minimal metadata, no content, append-only for every role. No
-- foreign keys: a tombstone outlives the erasure of the person, the consent proof and the portrait it names.
CREATE TABLE trustwork.profile_tombstone (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  subject_person_id uuid NOT NULL,
  projection text NOT NULL CHECK (projection IN ('profile', 'portrait', 'company_listing', 'publication_mention', 'speaker_link', 'project_participant', 'consented_use')),
  target_kind text NULL CHECK (target_kind ~ '^[a-z_]{1,40}$'),
  target_id uuid NULL,
  consent_record_id uuid NULL,
  portrait_id uuid NULL,
  reason text NOT NULL CHECK (reason IN ('consent_withdrawn', 'licence_revoked', 'portrait_replaced', 'portrait_removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profile_tombstone_target_pair CHECK ((target_kind IS NULL) = (target_id IS NULL))
);
CREATE INDEX profile_tombstone_subject_idx ON trustwork.profile_tombstone (subject_person_id, created_at);
CREATE TRIGGER profile_tombstone_append_only BEFORE UPDATE OR DELETE ON trustwork.profile_tombstone FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- Writes the tombstone and its identifiers-only outbox event (PROFILE_EVENT_PAYLOAD_KEYS) in the caller's transaction.
CREATE FUNCTION trustwork.profiles_tombstone(
  p_subject uuid, p_projection text, p_target_kind text, p_target_id uuid, p_consent_id uuid, p_portrait_id uuid, p_reason text
) RETURNS uuid
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO trustwork.profile_tombstone (subject_person_id, projection, target_kind, target_id, consent_record_id, portrait_id, reason)
  VALUES (p_subject, p_projection, p_target_kind, p_target_id, p_consent_id, p_portrait_id, p_reason)
  RETURNING id INTO v_id;
  INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
  VALUES ('person', p_subject::text, 1, 'profile.projection_withdrawn', jsonb_build_object(
    'tombstoneId', v_id, 'personId', p_subject, 'projection', p_projection, 'targetKind', p_target_kind, 'targetId', p_target_id,
    'consentId', p_consent_id, 'portraitId', p_portrait_id, 'reason', p_reason));
  RETURN v_id;
END $$;

-- 8. Unpublication in the same transaction -------------------------------------------------------------------------------
-- Withdrawal of a consent: the dependent projection goes private at once and a tombstone records it.
CREATE FUNCTION trustwork.profiles_consent_withdrawn() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_portrait record;
BEGIN
  IF OLD.withdrawn_at IS NOT NULL OR NEW.withdrawn_at IS NULL THEN
    RETURN NULL;
  END IF;
  IF NEW.purpose = 'profile_public' THEN
    UPDATE trustwork.person SET profile_visibility = 'private' WHERE id = NEW.subject_person_id AND profile_visibility = 'public';
    PERFORM trustwork.profiles_tombstone(NEW.subject_person_id, 'profile', NULL, NULL, NEW.id, NULL, 'consent_withdrawn');
  ELSIF NEW.purpose = 'portrait_display' THEN
    FOR v_portrait IN
      UPDATE trustwork.portrait SET status = 'withdrawn', withdrawn_at = now(), withdrawn_reason = 'consent_withdrawn'
      WHERE consent_record_id = NEW.id AND status <> 'withdrawn' RETURNING id
    LOOP
      PERFORM trustwork.profiles_tombstone(NEW.subject_person_id, 'portrait', 'portrait', v_portrait.id, NEW.id, v_portrait.id, 'consent_withdrawn');
    END LOOP;
  ELSE
    PERFORM trustwork.profiles_tombstone(NEW.subject_person_id, trustwork.profiles_projection_for(NEW.purpose), NEW.target_kind, NEW.target_id, NEW.id, NULL, 'consent_withdrawn');
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER consent_record_withdrawn AFTER UPDATE OF withdrawn_at ON trustwork.consent_record FOR EACH ROW EXECUTE FUNCTION trustwork.profiles_consent_withdrawn();

-- Revocation of a licence: every portrait relying on it is withdrawn with a tombstone.
CREATE FUNCTION trustwork.profiles_licence_revoked() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_portrait record;
BEGIN
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RETURN NULL;
  END IF;
  FOR v_portrait IN
    UPDATE trustwork.portrait SET status = 'withdrawn', withdrawn_at = now(), withdrawn_reason = 'licence_revoked'
    WHERE media_licence_id = NEW.id AND status <> 'withdrawn' RETURNING id, person_id, consent_record_id
  LOOP
    PERFORM trustwork.profiles_tombstone(v_portrait.person_id, 'portrait', 'portrait', v_portrait.id, v_portrait.consent_record_id, v_portrait.id, 'licence_revoked');
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER media_licence_revoked AFTER UPDATE OF revoked_at ON trustwork.media_licence FOR EACH ROW EXECUTE FUNCTION trustwork.profiles_licence_revoked();

-- A portrait that leaves `shown` for another reason (replaced, removed) also leaves a tombstone.
CREATE FUNCTION trustwork.profiles_portrait_left() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF OLD.status = 'shown' AND NEW.status = 'withdrawn' AND NEW.withdrawn_reason IN ('replaced', 'removed') THEN
    PERFORM trustwork.profiles_tombstone(NEW.person_id, 'portrait', 'portrait', NEW.id, NEW.consent_record_id, NEW.id,
      CASE NEW.withdrawn_reason WHEN 'replaced' THEN 'portrait_replaced' ELSE 'portrait_removed' END);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER portrait_left AFTER UPDATE OF status ON trustwork.portrait FOR EACH ROW EXECUTE FUNCTION trustwork.profiles_portrait_left();

-- No consent, no public profile: the runtime role cannot switch a profile to public without a live profile_public
-- consent of that person (a maintenance session seeds synthetic fixtures). Hiding needs no consent.
CREATE FUNCTION trustwork.profiles_person_visibility_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF NEW.profile_visibility = 'public' AND OLD.profile_visibility <> 'public' AND NOT trustwork.profiles_maintenance()
     AND NOT EXISTS (
       SELECT 1 FROM trustwork.consent_record c
       WHERE c.subject_person_id = NEW.id AND c.purpose = 'profile_public' AND c.withdrawn_at IS NULL
     ) THEN
    RAISE EXCEPTION 'a public profile needs the person''s live profile_public consent' USING ERRCODE = 'check_violation', HINT = 'profiles.consent_required';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER profiles_visibility_consent BEFORE UPDATE OF profile_visibility ON trustwork.person FOR EACH ROW EXECUTE FUNCTION trustwork.profiles_person_visibility_guard();

-- 9. Public reads (owner-run, allowlisted columns only) ------------------------------------------------------------------
-- The public profile of one person: NULL unless the profile is public AND its profile_public consent is live. Optional
-- parts appear only when listed in public_fields: the employer only with an active membership, the portrait only when
-- shown with a live consent and a live licence on a clean, public, not deleted image of the person, experience only
-- public and not archived entries. Identical for every caller.
CREATE FUNCTION trustwork.profiles_public_profile(p_person_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT jsonb_build_object(
    'id', p.id,
    'handle', (SELECT h.handle FROM trustwork.directory_handle h WHERE h.kind = 'person' AND h.subject_id = p.id AND h.retired_at IS NULL),
    'displayName', p.display_name,
    'headline', p.public_headline,
    'expertise', to_jsonb(p.public_expertise),
    'roleLine', CASE WHEN 'roleLine' = ANY (pp.public_fields) THEN pp.role_line END,
    'regionCode', CASE WHEN 'region' = ANY (pp.public_fields) THEN pp.region_code END,
    'topics', CASE WHEN 'topics' = ANY (pp.public_fields) THEN to_jsonb(pp.topics) ELSE '[]'::jsonb END,
    'languages', CASE WHEN 'languages' = ANY (pp.public_fields) THEN to_jsonb(pp.languages) ELSE '[]'::jsonb END,
    'publicFields', to_jsonb(coalesce(pp.public_fields, '{}'::text[])),
    'employer', CASE WHEN pp.show_employer AND 'employer' = ANY (pp.public_fields) THEN (
      SELECT jsonb_build_object('companyId', c.id, 'name', c.display_name)
      FROM trustwork.membership m JOIN trustwork.company c ON c.id = m.company_id
      WHERE m.person_id = p.id AND m.status = 'active' AND (m.valid_from IS NULL OR m.valid_from <= now())
    ) END,
    'portrait', CASE WHEN 'portrait' = ANY (pp.public_fields) THEN (
      SELECT jsonb_build_object('portraitId', po.id, 'assetId', po.asset_id)
      FROM trustwork.portrait po
      JOIN trustwork.consent_record cr ON cr.id = po.consent_record_id AND cr.subject_person_id = p.id AND cr.purpose = 'portrait_display' AND cr.withdrawn_at IS NULL
      JOIN trustwork.media_licence ml ON ml.id = po.media_licence_id AND ml.asset_id = po.asset_id AND ml.revoked_at IS NULL AND (ml.valid_until IS NULL OR ml.valid_until > now())
      JOIN trustwork.evidence_artifact a ON a.id = po.asset_id AND a.owner_person_id = p.id AND a.classification = 'public' AND a.scan_state = 'clean'
        AND a.parent_kind = 'person' AND a.parent_id = p.id
      WHERE po.person_id = p.id AND po.status = 'shown'
        AND NOT EXISTS (SELECT 1 FROM trustwork.file_artifact_state s WHERE s.artifact_id = a.id AND s.deletion_requested_at IS NOT NULL)
    ) END,
    'experience', CASE WHEN 'experience' = ANY (pp.public_fields) THEN coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', e.id, 'organisation', jsonb_build_object('companyId', e.organisation_company_id, 'name', e.organisation_name), 'role', e.role, 'summary', e.summary,
        'from', to_char(e.from_date, 'YYYY-MM-DD'), 'to', to_char(e.to_date, 'YYYY-MM-DD'),
        'confirmation', CASE WHEN e.confirmed_by_company_at IS NULL THEN 'self_declared' ELSE 'company_confirmed' END
      ) ORDER BY e.from_date DESC, e.id)
      FROM trustwork.experience_entry e WHERE e.person_id = p.id AND e.visibility = 'public' AND e.archived_at IS NULL
    ), '[]'::jsonb) ELSE '[]'::jsonb END
  )
  FROM trustwork.person p
  LEFT JOIN trustwork.person_profile pp ON pp.person_id = p.id
  WHERE p.id = p_person_id AND p.profile_visibility = 'public'
    AND EXISTS (SELECT 1 FROM trustwork.consent_record c WHERE c.subject_person_id = p.id AND c.purpose = 'profile_public' AND c.withdrawn_at IS NULL)
$$;

-- People a company lists on its page: active members with a public, consented profile AND a live listed_by_company
-- consent naming this company. Nobody else, whatever the company's permissions.
CREATE FUNCTION trustwork.profiles_company_people(p_company_id uuid)
RETURNS TABLE (id uuid, display_name text, public_headline text, handle text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT p.id, p.display_name, p.public_headline,
    (SELECT h.handle FROM trustwork.directory_handle h WHERE h.kind = 'person' AND h.subject_id = p.id AND h.retired_at IS NULL)
  FROM trustwork.membership m
  JOIN trustwork.person p ON p.id = m.person_id
  WHERE m.company_id = p_company_id AND m.status = 'active' AND (m.valid_from IS NULL OR m.valid_from <= now())
    AND p.profile_visibility = 'public'
    AND EXISTS (SELECT 1 FROM trustwork.consent_record c WHERE c.subject_person_id = p.id AND c.purpose = 'profile_public' AND c.withdrawn_at IS NULL)
    AND EXISTS (SELECT 1 FROM trustwork.consent_record c WHERE c.subject_person_id = p.id AND c.purpose = 'listed_by_company'
                AND c.target_kind = 'company' AND c.target_id = p_company_id AND c.withdrawn_at IS NULL)
  ORDER BY p.created_at, p.id
$$;

-- Of the people a publication names, those who may appear as a link: a public, consented profile and a live
-- mentioned_in_publication consent naming that publication (the content module asks; nobody else is linked).
CREATE FUNCTION trustwork.profiles_consented_mentions(p_publication_id uuid, p_person_ids uuid[]) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT p.id FROM trustwork.person p
  WHERE p.id = ANY (p_person_ids) AND p.profile_visibility = 'public'
    AND EXISTS (SELECT 1 FROM trustwork.consent_record c WHERE c.subject_person_id = p.id AND c.purpose = 'profile_public' AND c.withdrawn_at IS NULL)
    AND EXISTS (SELECT 1 FROM trustwork.consent_record c WHERE c.subject_person_id = p.id AND c.purpose = 'mentioned_in_publication'
                AND c.target_kind = 'publication' AND c.target_id = p_publication_id AND c.withdrawn_at IS NULL)
  ORDER BY p.id
$$;

-- 10. Row-level security: the person's own rows only -------------------------------------------------------------------
ALTER TABLE trustwork.person_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.person_profile FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.person_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.person_preference FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.consent_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.consent_record FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.media_licence ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.media_licence FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.portrait ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.portrait FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.experience_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.experience_entry FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.follow ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.follow FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.bookmark ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.bookmark FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.reading_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.reading_progress FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.profile_tombstone ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.profile_tombstone FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.person_profile AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.person_preference AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.consent_record AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.media_licence AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.portrait AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.experience_entry AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.follow AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.bookmark AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.reading_progress AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.profile_tombstone AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

CREATE POLICY person_profile_own ON trustwork.person_profile FOR ALL TO trustwork_app
  USING (person_id = trustwork.current_person_id()) WITH CHECK (person_id = trustwork.current_person_id());
CREATE POLICY person_preference_own ON trustwork.person_preference FOR ALL TO trustwork_app
  USING (person_id = trustwork.current_person_id()) WITH CHECK (person_id = trustwork.current_person_id());
CREATE POLICY consent_record_own ON trustwork.consent_record FOR ALL TO trustwork_app
  USING (subject_person_id = trustwork.current_person_id()) WITH CHECK (subject_person_id = trustwork.current_person_id());
CREATE POLICY media_licence_own ON trustwork.media_licence FOR ALL TO trustwork_app
  USING (owner_person_id = trustwork.current_person_id()) WITH CHECK (owner_person_id = trustwork.current_person_id());
CREATE POLICY portrait_own ON trustwork.portrait FOR ALL TO trustwork_app
  USING (person_id = trustwork.current_person_id()) WITH CHECK (person_id = trustwork.current_person_id());
CREATE POLICY experience_entry_own ON trustwork.experience_entry FOR ALL TO trustwork_app
  USING (person_id = trustwork.current_person_id()) WITH CHECK (person_id = trustwork.current_person_id());
CREATE POLICY follow_own ON trustwork.follow FOR ALL TO trustwork_app
  USING (follower_person_id = trustwork.current_person_id()) WITH CHECK (follower_person_id = trustwork.current_person_id());
CREATE POLICY bookmark_own ON trustwork.bookmark FOR ALL TO trustwork_app
  USING (person_id = trustwork.current_person_id()) WITH CHECK (person_id = trustwork.current_person_id());
CREATE POLICY reading_progress_own ON trustwork.reading_progress FOR ALL TO trustwork_app
  USING (person_id = trustwork.current_person_id()) WITH CHECK (person_id = trustwork.current_person_id());
CREATE POLICY profile_tombstone_own ON trustwork.profile_tombstone FOR ALL TO trustwork_app
  USING (subject_person_id = trustwork.current_person_id()) WITH CHECK (subject_person_id = trustwork.current_person_id());

-- 11. Grants ---------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT ON trustwork.person_profile, trustwork.person_preference, trustwork.consent_record, trustwork.media_licence, trustwork.portrait,
  trustwork.experience_entry, trustwork.follow, trustwork.bookmark, trustwork.reading_progress, trustwork.profile_tombstone TO trustwork_app;
GRANT UPDATE (role_line, region_code, show_employer, topics, languages, public_fields) ON trustwork.person_profile TO trustwork_app;
GRANT UPDATE (intents, topics, regions, onboarding_completed_at) ON trustwork.person_preference TO trustwork_app;
GRANT UPDATE (withdrawn_at, withdrawn_reason) ON trustwork.consent_record TO trustwork_app;
GRANT UPDATE (revoked_at, revoked_by_person_id, revoked_reason) ON trustwork.media_licence TO trustwork_app;
GRANT UPDATE (status, consent_record_id, withdrawn_at, withdrawn_reason) ON trustwork.portrait TO trustwork_app;
GRANT UPDATE (organisation_company_id, organisation_name, role, summary, from_date, to_date, visibility, archived_at) ON trustwork.experience_entry TO trustwork_app;
GRANT UPDATE (ended_at) ON trustwork.follow TO trustwork_app;
GRANT UPDATE (removed_at) ON trustwork.bookmark TO trustwork_app;
GRANT UPDATE (progress) ON trustwork.reading_progress TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.profiles_maintenance(), trustwork.profiles_codes_ok(text[], text), trustwork.profiles_consent_target_kind(text), trustwork.profiles_projection_for(text),
  trustwork.profiles_is_subject(uuid), trustwork.profiles_tombstone(uuid, text, text, uuid, uuid, uuid, text),
  trustwork.profiles_public_profile(uuid), trustwork.profiles_company_people(uuid), trustwork.profiles_consented_mentions(uuid, uuid[]) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
