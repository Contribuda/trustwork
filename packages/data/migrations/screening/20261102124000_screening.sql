-- SANC-003: the screening engine. Subject states, append-only results, matches with guarded review states, append-only
-- decisions with separation of duties, report drafts for the operator, and the name-change events that start a
-- screening (ADR 014 decisions 11 to 17; data model section 24a).
--
-- * Persons are screened against individual entries and companies against entity entries by the matcher in
--   packages/compliance/src/matching, run by the worker (apps/worker/src/screening). The worker records results only
--   through screening_record_result, which rechecks every match against the entry it names and refuses a `clear`
--   that is not against the active baseline versions while the baseline is fresh. No score ever clears.
-- * money_held (screening_subject_state) is true unless the latest result is `clear`, or every possible match was
--   decided `not_same_person`; it is recomputed in the transaction of every result and decision. The effective state
--   (screening_state, for the gates) adds the list facts read at that moment: a stale or missing baseline, or a result
--   older than the active baseline versions, also holds money.
-- * Decisions: `confirm` by one compliance officer of the node (the safe direction; the subject is suspended, their
--   agent stopped and a report draft prepared); "not the same person" and the reversal of a confirmation need a second
--   person through second_person_approval (actions screening.clear_match and screening.reverse_confirmation, registered
--   below with the data integrator's agreement); an appeal is decided by someone other than the one who confirmed.
--   The decider is never the subject, a member of the subject company or a person with a declared conflict: the
--   commands check it and a trigger on screening_decision checks it again for every writer.
-- * A decided entry is not flagged again for the same subject unless the entry's normalized names change (the
--   entry_keys_digest of the match).
-- * Every row is a sanctions record (retention class sanctions_record, US ten years, 31 CFR 501.601): results and
--   decisions are append-only, matches change only their review state, nothing is deleted. No row stores a network
--   address. Nothing here reaches a public, counterparty, search, federation or agent projection.
--
-- Entry points (SECURITY DEFINER, pinned search_path):
--   worker (trustwork_worker): screening_subject_names, screening_should_screen, screening_lists_now,
--     screening_candidates, screening_record_result, screening_sweep_due
--   runtime (trustwork_app): screening_state, screening_own_status, screening_caller_suspended,
--     screening_session_suspended, screening_file_appeal, screening_confirm_match, screening_propose_not_same_person,
--     screening_decide_proposal, screening_decide_appeal
-- The runtime role reads the tables only as a compliance officer or auditor of the node (jurisdiction_staff_reader);
-- the subject reads status words through screening_own_status; the worker has no table grant.

-- 0. Second-person actions (data integrator agreement, SANC-003) ------------------------------------------------------
-- The frozen console vocabulary (CONSOLE_SECOND_PERSON_ACTIONS, HUBC-000) plus the two screening actions, which only
-- the screening commands below request, approve and consume. admin_action_permissions() names no permission for them,
-- so the generic approval commands refuse them (admin.forbidden) and nobody approves one without the screening guards.
CREATE OR REPLACE FUNCTION trustwork.admin_second_person_actions() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['staff.assign_sensitive_role', 'commerce.activate_price_version', 'privacy.execute_erasure', 'moderation.apply_sanction_l4', 'providers.enable_non_fake', 'staff.switch_sod_mode',
    'hub.transition_soft_launch', 'hub.transition_public', 'hub.change_residency', 'legal.activate_document_version', 'federation.raise_peering_level',
    'models.activate_private_route', 'egress.allow_private_class', 'pipelines.activate_personal_data_dataset', 'datasets.activate_court_or_debt',
    'automation.raise_to_supervised_autonomous', 'agents.enable_commitment_module', 'agents.activate_extension', 'jurisdiction.activate_settings',
    'billing.activate_fee_version', 'billing.release_payout_batch', 'payments.change_settings', 'sponsored.enable', 'staff.grant_breakglass',
    'support.reset_second_factor', 'support.rebind_recovery_email', 'ops.execute_restore', 'ops.apply_production_migration', 'ops.rotate_node_key',
    'kill_switch.release', 'screening.clear_match', 'screening.reverse_confirmation']::text[]
$$;
REVOKE EXECUTE ON FUNCTION trustwork.admin_second_person_actions() FROM PUBLIC;

-- 1. Subject state ------------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.screening_subject_state (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  subject_person_id uuid NULL REFERENCES trustwork.person (id),
  subject_company_id uuid NULL REFERENCES trustwork.company (id),
  -- Digest of the subject's raw names when they were last screened (screening_names_digest); the sweep compares it.
  names_digest text NOT NULL CHECK (names_digest ~ '^[0-9a-f]{64}$'),
  last_result_id uuid NULL,
  last_outcome text NULL CHECK (last_outcome IN ('clear', 'possible_match', 'insufficient_name', 'not_screened')),
  last_screened_at timestamptz NULL,
  screened_versions uuid[] NOT NULL DEFAULT '{}',
  money_held boolean NOT NULL DEFAULT true,
  suspended boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT screening_subject_state_xor CHECK ((subject_person_id IS NULL) <> (subject_company_id IS NULL)),
  CONSTRAINT screening_subject_state_suspended_holds CHECK (NOT suspended OR money_held)
);
CREATE UNIQUE INDEX screening_subject_state_person ON trustwork.screening_subject_state (subject_person_id) WHERE subject_person_id IS NOT NULL;
CREATE UNIQUE INDEX screening_subject_state_company ON trustwork.screening_subject_state (subject_company_id) WHERE subject_company_id IS NOT NULL;
CREATE FUNCTION trustwork.screening_subject_state_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'screening states are sanctions records and are never deleted' USING ERRCODE = '23514', HINT = 'screening.record_permanent';
  END IF;
  IF NEW.id <> OLD.id OR NEW.subject_person_id IS DISTINCT FROM OLD.subject_person_id OR NEW.subject_company_id IS DISTINCT FROM OLD.subject_company_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a screening state keeps its subject' USING ERRCODE = '23514', HINT = 'screening.record_immutable';
  END IF;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER screening_subject_state_guard BEFORE UPDATE OR DELETE ON trustwork.screening_subject_state FOR EACH ROW EXECUTE FUNCTION trustwork.screening_subject_state_guard();
CREATE TRIGGER screening_subject_state_no_truncate BEFORE TRUNCATE ON trustwork.screening_subject_state FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

-- 2. Results (append-only) ----------------------------------------------------------------------------------------------
CREATE TABLE trustwork.screening_result (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  subject_person_id uuid NULL REFERENCES trustwork.person (id),
  subject_company_id uuid NULL REFERENCES trustwork.company (id),
  trigger text NOT NULL CHECK (trigger IN ('registration', 'sign_in', 'name_change', 'company_change', 'claim', 'seller', 'counterparty', 'payee', 'organizer', 'peer', 'operator', 'list_update', 'scheduled')),
  list_version_ids uuid[] NOT NULL DEFAULT '{}',
  outcome text NOT NULL CHECK (outcome IN ('clear', 'possible_match', 'insufficient_name', 'not_screened')),
  matcher_version text NOT NULL CHECK (matcher_version ~ '^[a-z0-9][a-z0-9.+_-]{0,99}$'),
  fuzzy_threshold numeric(3,2) NULL CHECK (fuzzy_threshold BETWEEN 0.85 AND 0.99),
  screened_names_digest text NOT NULL CHECK (screened_names_digest ~ '^[0-9a-f]{64}$'),
  names_digest text NOT NULL CHECK (names_digest ~ '^[0-9a-f]{64}$'),
  match_count integer NOT NULL DEFAULT 0 CHECK (match_count >= 0),
  screened_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT screening_result_xor CHECK ((subject_person_id IS NULL) <> (subject_company_id IS NULL)),
  CONSTRAINT screening_result_matches_shape CHECK ((outcome = 'possible_match') = (match_count > 0) OR (outcome = 'clear' AND match_count > 0)),
  CONSTRAINT screening_result_screened_against_lists CHECK (outcome IN ('not_screened', 'insufficient_name') OR cardinality(list_version_ids) >= 1)
);
CREATE INDEX screening_result_person_idx ON trustwork.screening_result (subject_person_id, screened_at) WHERE subject_person_id IS NOT NULL;
CREATE INDEX screening_result_company_idx ON trustwork.screening_result (subject_company_id, screened_at) WHERE subject_company_id IS NOT NULL;
ALTER TABLE trustwork.screening_subject_state ADD CONSTRAINT screening_subject_state_last_result FOREIGN KEY (last_result_id) REFERENCES trustwork.screening_result (id);

-- `clear` only against every active baseline version, while the baseline is fresh (ADR 014 decision 13).
CREATE FUNCTION trustwork.screening_result_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF NEW.outcome = 'clear' THEN
    IF NOT trustwork.screening_available() THEN
      RAISE EXCEPTION 'no clear while the baseline lists are missing or stale' USING ERRCODE = '23514', HINT = 'screening.unavailable';
    END IF;
    IF NOT (trustwork.screening_active_baseline_versions() <@ NEW.list_version_ids) THEN
      RAISE EXCEPTION 'a clear names every active baseline version' USING ERRCODE = '23514', HINT = 'screening.stale_versions';
    END IF;
  END IF;
  NEW.screened_at := now();
  RETURN NEW;
END $$;

-- 3. Matches ------------------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.screening_match (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  result_id uuid NOT NULL REFERENCES trustwork.screening_result (id),
  last_result_id uuid NOT NULL REFERENCES trustwork.screening_result (id),
  subject_person_id uuid NULL REFERENCES trustwork.person (id),
  subject_company_id uuid NULL REFERENCES trustwork.company (id),
  list_code text NOT NULL CHECK (list_code ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  list_version_id uuid NOT NULL REFERENCES trustwork.screening_list_version (id),
  entry_uid text NOT NULL CHECK (entry_uid ~ '^[A-Za-z0-9._:-]{1,64}$'),
  entry_type text NOT NULL CHECK (entry_type IN ('individual', 'entity', 'vessel', 'aircraft')),
  entry_digest text NOT NULL CHECK (entry_digest ~ '^[0-9a-f]{64}$'),
  -- Digest of the entry's normalized names (sorted name keys): a decided entry re-opens only when it changes.
  entry_keys_digest text NOT NULL CHECK (entry_keys_digest ~ '^[0-9a-f]{64}$'),
  entry_name text NOT NULL CHECK (length(btrim(entry_name)) BETWEEN 1 AND 1000),
  programs text[] NOT NULL DEFAULT '{}',
  matched_key text NOT NULL CHECK (length(matched_key) BETWEEN 1 AND 1000),
  screened_name text NOT NULL CHECK (length(btrim(screened_name)) BETWEEN 1 AND 1000),
  rule text NOT NULL CHECK (rule IN ('engine', 'fuzzy')),
  score numeric(4,3) NULL CHECK (score BETWEEN 0 AND 1),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'pending_second', 'not_same_person', 'confirmed', 'appeal', 'pending_reversal')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT screening_match_xor CHECK ((subject_person_id IS NULL) <> (subject_company_id IS NULL)),
  CONSTRAINT screening_match_score_shape CHECK ((rule = 'fuzzy') = (score IS NOT NULL))
);
CREATE UNIQUE INDEX screening_match_person_entry ON trustwork.screening_match (subject_person_id, list_code, entry_uid) WHERE subject_person_id IS NOT NULL;
CREATE UNIQUE INDEX screening_match_company_entry ON trustwork.screening_match (subject_company_id, list_code, entry_uid) WHERE subject_company_id IS NOT NULL;
CREATE INDEX screening_match_queue_idx ON trustwork.screening_match (state, opened_at) WHERE state IN ('open', 'pending_second', 'appeal', 'pending_reversal');

-- The review states move only along the decision graph (handbook "Deciding a possible match"); the identity of the pair
-- never changes and nothing is deleted.
CREATE FUNCTION trustwork.screening_match_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'screening matches are sanctions records and are never deleted' USING ERRCODE = '23514', HINT = 'screening.record_permanent';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'open' OR NEW.decided_at IS NOT NULL THEN
      RAISE EXCEPTION 'a match opens open' USING ERRCODE = '23514', HINT = 'screening.match_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.result_id <> OLD.result_id OR NEW.subject_person_id IS DISTINCT FROM OLD.subject_person_id OR NEW.subject_company_id IS DISTINCT FROM OLD.subject_company_id
     OR NEW.list_code <> OLD.list_code OR NEW.entry_uid <> OLD.entry_uid OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a match keeps its subject and entry' USING ERRCODE = '23514', HINT = 'screening.record_immutable';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'open' AND NEW.state IN ('pending_second', 'confirmed'))
    OR (OLD.state = 'pending_second' AND NEW.state IN ('not_same_person', 'open'))
    OR (OLD.state = 'confirmed' AND NEW.state = 'appeal')
    OR (OLD.state = 'appeal' AND NEW.state IN ('confirmed', 'pending_reversal'))
    OR (OLD.state = 'pending_reversal' AND NEW.state IN ('not_same_person', 'confirmed'))
    OR (OLD.state = 'not_same_person' AND NEW.state = 'open')) THEN
    RAISE EXCEPTION 'a match cannot move from % to %', OLD.state, NEW.state USING ERRCODE = '23514', HINT = 'screening.match_transition';
  END IF;
  -- The entry facts change only when an entry is seen again in an open state or re-opens.
  IF (NEW.entry_digest <> OLD.entry_digest OR NEW.entry_keys_digest <> OLD.entry_keys_digest OR NEW.entry_name <> OLD.entry_name OR NEW.programs <> OLD.programs
      OR NEW.matched_key <> OLD.matched_key OR NEW.screened_name <> OLD.screened_name OR NEW.rule <> OLD.rule OR NEW.score IS DISTINCT FROM OLD.score)
     AND NOT (NEW.state = 'open' AND OLD.state IN ('open', 'not_same_person')) THEN
    RAISE EXCEPTION 'a decided match keeps the entry it was decided on' USING ERRCODE = '23514', HINT = 'screening.record_immutable';
  END IF;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER screening_match_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.screening_match FOR EACH ROW EXECUTE FUNCTION trustwork.screening_match_guard();
CREATE TRIGGER screening_match_no_truncate BEFORE TRUNCATE ON trustwork.screening_match FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

-- 4. Decisions (append-only) --------------------------------------------------------------------------------------------
CREATE TABLE trustwork.screening_decision (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  match_id uuid NOT NULL REFERENCES trustwork.screening_match (id),
  kind text NOT NULL CHECK (kind IN ('confirm', 'propose_not_same_person', 'approve', 'reject', 'appeal', 'uphold', 'propose_reversal')),
  decided_by uuid NOT NULL REFERENCES trustwork.person (id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  evidence_category text NULL CHECK (evidence_category IN ('identity_document', 'date_of_birth', 'nationality', 'address', 'registration_identifier', 'other')),
  second_person_approval_id uuid NULL REFERENCES trustwork.second_person_approval (id),
  -- The digest the second person restates (proposals only).
  approval_digest text NULL CHECK (approval_digest ~ '^[0-9a-f]{64}$'),
  case_id uuid NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT screening_decision_evidence CHECK ((kind IN ('confirm', 'propose_not_same_person', 'uphold', 'propose_reversal')) = (evidence_category IS NOT NULL)),
  CONSTRAINT screening_decision_second_person CHECK ((kind IN ('propose_not_same_person', 'propose_reversal', 'approve', 'reject')) = (second_person_approval_id IS NOT NULL)),
  CONSTRAINT screening_decision_digest CHECK ((kind IN ('propose_not_same_person', 'propose_reversal')) = (approval_digest IS NOT NULL))
);
CREATE INDEX screening_decision_match_idx ON trustwork.screening_decision (match_id, seq);

-- Separation of duties for every writer (the commands check the same first, with clearer refusals).
CREATE FUNCTION trustwork.screening_decision_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  m trustwork.screening_match%ROWTYPE;
  v_other uuid;
BEGIN
  SELECT * INTO m FROM trustwork.screening_match WHERE id = NEW.match_id;
  IF NEW.kind = 'appeal' THEN
    IF NOT (NEW.decided_by = m.subject_person_id OR (m.subject_company_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM trustwork.membership x WHERE x.person_id = NEW.decided_by AND x.company_id = m.subject_company_id AND x.status = 'active' AND x.role = 'administrator'))) THEN
      RAISE EXCEPTION 'only the subject appeals' USING ERRCODE = '42501', HINT = 'screening.not_subject';
    END IF;
  ELSE
    IF NEW.decided_by = m.subject_person_id THEN
      RAISE EXCEPTION 'nobody decides about themselves' USING ERRCODE = '42501', HINT = 'screening.self_decision';
    END IF;
    IF m.subject_company_id IS NOT NULL AND EXISTS (SELECT 1 FROM trustwork.membership x WHERE x.person_id = NEW.decided_by AND x.company_id = m.subject_company_id AND x.status = 'active') THEN
      RAISE EXCEPTION 'a member of the subject company does not decide' USING ERRCODE = '42501', HINT = 'screening.subject_member';
    END IF;
    IF trustwork.admin_conflicted(NEW.decided_by, m.subject_person_id, m.subject_company_id) THEN
      RAISE EXCEPTION 'the reviewer declared a conflict of interest with the subject' USING ERRCODE = '42501', HINT = 'admin.conflict_of_interest';
    END IF;
  END IF;
  IF NEW.kind IN ('approve', 'reject') THEN
    SELECT d.decided_by INTO v_other FROM trustwork.screening_decision d WHERE d.match_id = NEW.match_id AND d.kind IN ('propose_not_same_person', 'propose_reversal') ORDER BY d.seq DESC LIMIT 1;
    IF v_other IS NULL OR v_other = NEW.decided_by THEN
      RAISE EXCEPTION 'the second person is not the proposer' USING ERRCODE = '42501', HINT = 'screening.second_person_required';
    END IF;
  ELSIF NEW.kind IN ('uphold', 'propose_reversal') THEN
    SELECT d.decided_by INTO v_other FROM trustwork.screening_decision d WHERE d.match_id = NEW.match_id AND d.kind IN ('confirm', 'uphold') ORDER BY d.seq DESC LIMIT 1;
    IF v_other = NEW.decided_by THEN
      RAISE EXCEPTION 'an appeal is decided by another reviewer' USING ERRCODE = '42501', HINT = 'screening.same_reviewer';
    END IF;
  END IF;
  NEW.decided_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER screening_decision_guard BEFORE INSERT ON trustwork.screening_decision FOR EACH ROW EXECUTE FUNCTION trustwork.screening_decision_guard();
CREATE TRIGGER screening_decision_append_only BEFORE UPDATE OR DELETE ON trustwork.screening_decision FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER screening_decision_no_truncate BEFORE TRUNCATE ON trustwork.screening_decision FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

-- 5. Report drafts for the operator -------------------------------------------------------------------------------------
-- A confirmed match prepares the operator's blocked-property or rejected-transaction report (US: 31 CFR 501.603 and
-- 501.604, ten business days). Filing stays the operator's; the console (SANC-006) records it.
CREATE TABLE trustwork.screening_report_draft (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  match_id uuid NOT NULL UNIQUE REFERENCES trustwork.screening_match (id),
  subject_person_id uuid NULL REFERENCES trustwork.person (id),
  subject_company_id uuid NULL REFERENCES trustwork.company (id),
  list_code text NOT NULL,
  entry_uid text NOT NULL,
  programs text[] NOT NULL DEFAULT '{}',
  prepared_at timestamptz NOT NULL DEFAULT now(),
  due_on date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft')),
  CONSTRAINT screening_report_draft_xor CHECK ((subject_person_id IS NULL) <> (subject_company_id IS NULL))
);
CREATE TRIGGER screening_report_draft_append_only BEFORE UPDATE OR DELETE ON trustwork.screening_report_draft FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER screening_report_draft_no_truncate BEFORE TRUNCATE ON trustwork.screening_report_draft FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER screening_result_guard BEFORE INSERT ON trustwork.screening_result FOR EACH ROW EXECUTE FUNCTION trustwork.screening_result_guard();
CREATE TRIGGER screening_result_append_only BEFORE UPDATE OR DELETE ON trustwork.screening_result FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER screening_result_no_truncate BEFORE TRUNCATE ON trustwork.screening_result FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

-- 6. Name-change events -------------------------------------------------------------------------------------------------
-- Whatever path changes a person's or a company's display name (identity, profiles, directory, claims, imports), the
-- database appends the event that screens the new name in the same transaction. Identifiers only, never the name.
CREATE FUNCTION trustwork.screening_person_renamed() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
  VALUES ('person', NEW.id::text, NEW.revision, 'identity.name_changed', jsonb_build_object('personId', NEW.id));
  RETURN NULL;
END $$;
CREATE TRIGGER person_name_changed AFTER UPDATE OF display_name ON trustwork.person FOR EACH ROW
  WHEN (OLD.display_name IS DISTINCT FROM NEW.display_name) EXECUTE FUNCTION trustwork.screening_person_renamed();
CREATE FUNCTION trustwork.screening_company_renamed() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
  VALUES ('company', NEW.id::text, NEW.revision, 'company.renamed', jsonb_build_object('companyId', NEW.id));
  RETURN NULL;
END $$;
CREATE TRIGGER company_renamed AFTER UPDATE OF display_name ON trustwork.company FOR EACH ROW
  WHEN (OLD.display_name IS DISTINCT FROM NEW.display_name) EXECUTE FUNCTION trustwork.screening_company_renamed();

-- 7. Internal helpers (not executable by any login role) -----------------------------------------------------------------
CREATE FUNCTION trustwork.screening_active_baseline_versions() RETURNS uuid[]
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT coalesce(array_agg(v.id ORDER BY v.id), '{}') FROM trustwork.screening_list l JOIN trustwork.screening_list_version v ON v.list_id = l.id AND v.state = 'active' WHERE l.baseline
$$;
CREATE FUNCTION trustwork.screening_active_versions() RETURNS uuid[]
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT coalesce(array_agg(v.id ORDER BY v.id), '{}') FROM trustwork.screening_list l JOIN trustwork.screening_list_version v ON v.list_id = l.id AND v.state = 'active' WHERE l.status = 'active'
$$;
-- The names screened for a subject (today the display name; legal names join when they exist).
CREATE FUNCTION trustwork.screening_names_of(p_person uuid, p_company uuid) RETURNS text[]
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT CASE WHEN p_person IS NOT NULL THEN (SELECT ARRAY[p.display_name] FROM trustwork.person p WHERE p.id = p_person)
              ELSE (SELECT ARRAY[c.display_name] FROM trustwork.company c WHERE c.id = p_company) END
$$;
CREATE FUNCTION trustwork.screening_names_digest(p_names text[]) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT encode(sha256(convert_to(coalesce(array_to_string(p_names, E'\n'), ''), 'UTF8')), 'hex')
$$;
CREATE FUNCTION trustwork.screening_keys_digest(p_keys text[]) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT encode(sha256(convert_to(coalesce((SELECT string_agg(k, E'\n' ORDER BY k COLLATE "C") FROM (SELECT DISTINCT unnest(p_keys) AS k) d), ''), 'UTF8')), 'hex')
$$;
CREATE FUNCTION trustwork.screening_add_business_days(p_from date, p_days integer) RETURNS date
LANGUAGE plpgsql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  d date := p_from;
  n integer := 0;
BEGIN
  WHILE n < p_days LOOP
    d := d + 1;
    IF extract(isodow FROM d) < 6 THEN n := n + 1; END IF;
  END LOOP;
  RETURN d;
END $$;
-- Resolves a subject reference to (person, company); raises when it names nothing.
CREATE FUNCTION trustwork.screening_subject(p_kind text, p_id uuid, OUT person_id uuid, OUT company_id uuid)
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF p_kind = 'person' AND EXISTS (SELECT 1 FROM trustwork.person WHERE id = p_id) THEN
    person_id := p_id;
  ELSIF p_kind = 'company' AND EXISTS (SELECT 1 FROM trustwork.company WHERE id = p_id) THEN
    company_id := p_id;
  ELSE
    RAISE EXCEPTION 'no such screening subject' USING ERRCODE = 'no_data_found', HINT = 'screening.subject_not_found';
  END IF;
END $$;
CREATE FUNCTION trustwork.screening_state_row(p_person uuid, p_company uuid) RETURNS trustwork.screening_subject_state
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT s.* FROM trustwork.screening_subject_state s
  WHERE (p_person IS NOT NULL AND s.subject_person_id = p_person) OR (p_company IS NOT NULL AND s.subject_company_id = p_company)
$$;

-- Recomputes the stored part of the state from the latest outcome and the matches; announces a change of standing.
CREATE FUNCTION trustwork.screening_recompute(p_state uuid) RETURNS trustwork.screening_subject_state
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  s trustwork.screening_subject_state%ROWTYPE;
  v_unresolved boolean;
  v_suspended boolean;
  v_held boolean;
BEGIN
  SELECT * INTO s FROM trustwork.screening_subject_state WHERE id = p_state FOR UPDATE;
  SELECT EXISTS (SELECT 1 FROM trustwork.screening_match m WHERE (m.subject_person_id = s.subject_person_id OR m.subject_company_id = s.subject_company_id)
                   AND m.state IN ('open', 'pending_second', 'confirmed', 'appeal', 'pending_reversal')),
         EXISTS (SELECT 1 FROM trustwork.screening_match m WHERE (m.subject_person_id = s.subject_person_id OR m.subject_company_id = s.subject_company_id)
                   AND m.state IN ('confirmed', 'appeal', 'pending_reversal'))
    INTO v_unresolved, v_suspended;
  v_held := v_unresolved OR s.last_outcome IS NULL OR s.last_outcome IN ('insufficient_name', 'not_screened');
  IF v_held IS DISTINCT FROM s.money_held OR v_suspended IS DISTINCT FROM s.suspended THEN
    UPDATE trustwork.screening_subject_state SET money_held = v_held, suspended = v_suspended WHERE id = p_state RETURNING * INTO s;
    INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
    VALUES ('screening_subject', s.id::text, s.revision, 'screening.subject_status_changed', jsonb_build_object(
      'subject', CASE WHEN s.subject_person_id IS NOT NULL THEN jsonb_build_object('kind', 'person', 'id', s.subject_person_id) ELSE jsonb_build_object('kind', 'company', 'id', s.subject_company_id) END,
      'moneyHeld', s.money_held, 'suspended', s.suspended));
  END IF;
  RETURN s;
END $$;

-- The compliance staff notification: names nobody (the queue item only) and carries no switch to mute it.
CREATE FUNCTION trustwork.screening_notify_review(p_state uuid) RETURNS void
LANGUAGE sql SET search_path = trustwork, pg_temp AS $$
  INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
  VALUES ('screening_case', p_state::text, 1, 'screening.review_requested', jsonb_build_object('queueItemId', p_state, 'mutable', false))
$$;
CREATE FUNCTION trustwork.screening_queued_count(p_person uuid, p_company uuid) RETURNS integer
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT count(*)::integer FROM trustwork.screening_match m
  WHERE ((p_person IS NOT NULL AND m.subject_person_id = p_person) OR (p_company IS NOT NULL AND m.subject_company_id = p_company))
    AND m.state IN ('open', 'pending_second', 'appeal', 'pending_reversal')
$$;

-- Suspension of a confirmed subject through the existing standing paths: a person's live sessions end and every
-- mandate the person gave stops (pending agent actions revoked); a company's mandates (its people's agents acting for
-- it and its standing representative) stop. Mandates come back only through a new first-party confirmation.
CREATE FUNCTION trustwork.screening_apply_suspension(p_person uuid, p_company uuid) RETURNS void
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_person IS NOT NULL THEN
    UPDATE trustwork.session SET revoked_at = now(), revoked_reason = 'admin' WHERE person_id = p_person AND revoked_at IS NULL;
    FOR v_id IN SELECT id FROM trustwork.mandate WHERE principal_person_id = p_person AND status = 'active' ORDER BY id LOOP
      PERFORM trustwork.assistant_apply_narrowing(v_id, 'suspended', 'compliance_suspension', NULL, 'system');
    END LOOP;
    PERFORM trustwork.assistant_revoke_pending(NULL, NULL, p_person, 'compliance_suspension');
  ELSE
    FOR v_id IN SELECT id FROM trustwork.mandate WHERE (on_behalf_company_id = p_company OR grantee_company_id = p_company) AND status = 'active' ORDER BY id LOOP
      PERFORM trustwork.assistant_apply_narrowing(v_id, 'suspended', 'compliance_suspension', NULL, 'system');
    END LOOP;
  END IF;
END $$;

-- The effective state the gates read: the stored part plus the list facts of this moment.
CREATE FUNCTION trustwork.screening_effective(p_person uuid, p_company uuid,
  OUT money_held boolean, OUT suspended boolean, OUT reasons text[], OUT last_outcome text, OUT last_screened_at timestamptz, OUT appealable boolean)
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  s trustwork.screening_subject_state%ROWTYPE;
BEGIN
  reasons := '{}';
  s := trustwork.screening_state_row(p_person, p_company);
  IF s.id IS NULL THEN
    reasons := ARRAY['not_screened'];
  ELSE
    last_outcome := s.last_outcome;
    last_screened_at := s.last_screened_at;
    IF s.last_outcome IS NULL OR s.last_outcome = 'not_screened' THEN reasons := array_append(reasons, 'not_screened'); END IF;
    IF s.last_outcome = 'insufficient_name' THEN reasons := array_append(reasons, 'insufficient_name'); END IF;
    IF EXISTS (SELECT 1 FROM trustwork.screening_match m WHERE (m.subject_person_id = p_person OR m.subject_company_id = p_company) AND m.state IN ('open', 'pending_second')) THEN
      reasons := array_append(reasons, 'review_pending');
    END IF;
    IF EXISTS (SELECT 1 FROM trustwork.screening_match m WHERE (m.subject_person_id = p_person OR m.subject_company_id = p_company) AND m.state IN ('confirmed', 'appeal', 'pending_reversal')) THEN
      reasons := array_append(reasons, 'confirmed');
    END IF;
    IF NOT (trustwork.screening_active_baseline_versions() <@ s.screened_versions) THEN reasons := array_append(reasons, 'rescreen_due'); END IF;
  END IF;
  IF NOT trustwork.screening_available() THEN reasons := array_append(reasons, 'lists_unavailable'); END IF;
  money_held := cardinality(reasons) > 0;
  suspended := 'confirmed' = ANY (reasons);
  appealable := EXISTS (SELECT 1 FROM trustwork.screening_match m WHERE (m.subject_person_id = p_person OR m.subject_company_id = p_company) AND m.state = 'confirmed');
END $$;

-- 8. Worker entry points -------------------------------------------------------------------------------------------------
-- The subject's current names and their digest (for the matcher; never logged).
CREATE FUNCTION trustwork.screening_subject_names(p_kind text, p_id uuid, OUT names text[], OUT names_digest text)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v record;
BEGIN
  SELECT * INTO v FROM trustwork.screening_subject(p_kind, p_id);
  names := trustwork.screening_names_of(v.person_id, v.company_id);
  names_digest := trustwork.screening_names_digest(names);
END $$;

-- Should a trigger screen this subject now? Not while a screening job of the subject waits or runs; with p_force false
-- (sign-in) only when the names changed or newer list versions are active than the last screening saw.
CREATE FUNCTION trustwork.screening_should_screen(p_kind text, p_id uuid, p_force boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v record;
  s trustwork.screening_subject_state%ROWTYPE;
BEGIN
  SELECT * INTO v FROM trustwork.screening_subject(p_kind, p_id);
  IF EXISTS (SELECT 1 FROM trustwork.job j WHERE j.kind = 'screening.screen_subject' AND j.state IN ('queued', 'leased')
             AND j.payload -> 'subject' ->> 'kind' = p_kind AND j.payload -> 'subject' ->> 'id' = p_id::text) THEN
    RETURN false;
  END IF;
  IF p_force THEN
    RETURN true;
  END IF;
  s := trustwork.screening_state_row(v.person_id, v.company_id);
  RETURN s.id IS NULL OR s.last_outcome IS NULL OR s.last_outcome = 'not_screened'
    OR s.names_digest <> trustwork.screening_names_digest(trustwork.screening_names_of(v.person_id, v.company_id))
    OR NOT (trustwork.screening_active_versions() <@ s.screened_versions);
END $$;

-- The active versions of every active list, and whether screening is available (baseline fresh).
CREATE FUNCTION trustwork.screening_lists_now()
RETURNS TABLE (list_code text, baseline boolean, version_id uuid, available boolean)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT l.code, l.baseline, v.id, trustwork.screening_available()
  FROM trustwork.screening_list l JOIN trustwork.screening_list_version v ON v.list_id = l.id AND v.state = 'active'
  WHERE l.status = 'active' ORDER BY l.baseline DESC, l.code
$$;

-- Candidate entries of the active versions: entries of the given types sharing a name-key token with the subject (all
-- engine-rule matches share one), or, for the fuzzy layer, a token initial.
CREATE FUNCTION trustwork.screening_candidates(p_entry_types text[], p_tokens text[], p_initials text[])
RETURNS TABLE (list_code text, list_version_id uuid, entry_uid text, entry_type text, primary_name text, programs text[], name_keys text[], entry_digest text)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT l.code, e.list_version_id, e.entry_uid, e.entry_type, e.primary_name, e.programs, e.name_keys, e.entry_digest
  FROM trustwork.screening_list l
  JOIN trustwork.screening_list_version v ON v.list_id = l.id AND v.state = 'active'
  JOIN trustwork.screening_list_entry e ON e.list_version_id = v.id
  WHERE l.status = 'active' AND e.entry_type = ANY (p_entry_types)
    AND EXISTS (SELECT 1 FROM unnest(e.name_keys) k CROSS JOIN LATERAL unnest(string_to_array(k, ' ')) t
                WHERE t = ANY (coalesce(p_tokens, '{}')) OR left(t, 1) = ANY (coalesce(p_initials, '{}')))
  ORDER BY l.code, e.entry_uid
$$;

-- Records one screening (the worker's job transaction). Every match is checked against the entry it names; a decided
-- entry is not flagged again unless its normalized names changed; the state, the queue notification and the subject's
-- standing follow in the same transaction. Answers {resultId, outcome, opened, stateId, moneyHeld}.
CREATE FUNCTION trustwork.screening_record_result(p_kind text, p_id uuid, p_trigger text, p_names_digest text, p_list_version_ids uuid[], p_outcome text,
  p_matcher_version text, p_fuzzy_threshold numeric, p_screened_names_digest text, p_matches jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v record;
  s trustwork.screening_subject_state%ROWTYPE;
  m jsonb;
  e trustwork.screening_list_entry%ROWTYPE;
  v_code text;
  existing trustwork.screening_match%ROWTYPE;
  v_keys text;
  v_outcome text := p_outcome;
  v_count integer;
  v_flagged integer := 0;
  v_opened integer := 0;
  v_queued_before integer;
  v_result uuid := trustwork.new_uuid();
BEGIN
  SELECT * INTO v FROM trustwork.screening_subject(p_kind, p_id);
  IF p_outcome NOT IN ('clear', 'possible_match', 'insufficient_name', 'not_screened') THEN
    RAISE EXCEPTION 'unknown outcome' USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.invalid_result';
  END IF;
  IF jsonb_typeof(p_matches) <> 'array' THEN
    RAISE EXCEPTION 'matches come as an array' USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.invalid_result';
  END IF;
  v_count := jsonb_array_length(p_matches);
  IF (p_outcome = 'possible_match') <> (v_count > 0) THEN
    RAISE EXCEPTION 'possible matches exactly when the outcome says so' USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.invalid_result';
  END IF;
  IF p_list_version_ids IS NULL OR EXISTS (SELECT 1 FROM unnest(p_list_version_ids) x WHERE NOT EXISTS (SELECT 1 FROM trustwork.screening_list_version lv WHERE lv.id = x AND lv.state IN ('active', 'superseded'))) THEN
    RAISE EXCEPTION 'unknown list version' USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.invalid_result';
  END IF;
  -- One screening of a subject at a time: the state row is the lock.
  INSERT INTO trustwork.screening_subject_state (subject_person_id, subject_company_id, names_digest) VALUES (v.person_id, v.company_id, p_names_digest)
  ON CONFLICT DO NOTHING;
  SELECT * INTO s FROM trustwork.screening_subject_state WHERE id = (trustwork.screening_state_row(v.person_id, v.company_id)).id FOR UPDATE;
  v_queued_before := trustwork.screening_queued_count(v.person_id, v.company_id);
  -- First pass: validate every match and find whether anything is new, re-opened or still unresolved.
  FOR m IN SELECT * FROM jsonb_array_elements(p_matches) LOOP
    SELECT * INTO e FROM trustwork.screening_list_entry WHERE list_version_id = (m ->> 'listVersionId')::uuid AND entry_uid = m ->> 'entryUid';
    SELECT l.code INTO v_code FROM trustwork.screening_list l JOIN trustwork.screening_list_version lv ON lv.list_id = l.id WHERE lv.id = (m ->> 'listVersionId')::uuid;
    IF e.entry_uid IS NULL OR v_code IS DISTINCT FROM (m ->> 'listCode') OR NOT ((m ->> 'listVersionId')::uuid = ANY (p_list_version_ids))
       OR NOT coalesce((m ->> 'matchedKey') = ANY (e.name_keys), false) OR coalesce(length(btrim(m ->> 'screenedName')), 0) NOT BETWEEN 1 AND 1000
       OR coalesce(m ->> 'rule', '') NOT IN ('engine', 'fuzzy') OR ((m ->> 'rule') = 'fuzzy') <> coalesce(jsonb_typeof(m -> 'score') = 'number', false)
       OR ((m ->> 'rule') = 'fuzzy' AND p_fuzzy_threshold IS NULL)
       OR e.entry_type <> ALL (CASE WHEN v.person_id IS NOT NULL THEN ARRAY['individual'] ELSE ARRAY['entity', 'vessel', 'aircraft'] END) THEN
      RAISE EXCEPTION 'a match does not fit the entry it names' USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.invalid_match';
    END IF;
    SELECT * INTO existing FROM trustwork.screening_match x
     WHERE ((v.person_id IS NOT NULL AND x.subject_person_id = v.person_id) OR (v.company_id IS NOT NULL AND x.subject_company_id = v.company_id))
       AND x.list_code = v_code AND x.entry_uid = e.entry_uid;
    IF existing.id IS NULL OR existing.state <> 'not_same_person' OR existing.entry_keys_digest <> trustwork.screening_keys_digest(e.name_keys) THEN
      v_flagged := v_flagged + 1;
    END IF;
    existing := NULL;
  END LOOP;
  -- Every possible match was already decided "not the same person" for an unchanged entry: the result is clear.
  IF p_outcome = 'possible_match' AND v_flagged = 0 THEN
    v_outcome := 'clear';
  END IF;
  INSERT INTO trustwork.screening_result (id, subject_person_id, subject_company_id, trigger, list_version_ids, outcome, matcher_version, fuzzy_threshold, screened_names_digest, names_digest, match_count)
  VALUES (v_result, v.person_id, v.company_id, p_trigger, p_list_version_ids, v_outcome, p_matcher_version, p_fuzzy_threshold, p_screened_names_digest, p_names_digest, v_count);
  -- Second pass: open, re-open or touch the matches.
  FOR m IN SELECT * FROM jsonb_array_elements(p_matches) LOOP
    SELECT * INTO e FROM trustwork.screening_list_entry WHERE list_version_id = (m ->> 'listVersionId')::uuid AND entry_uid = m ->> 'entryUid';
    v_code := m ->> 'listCode';
    v_keys := trustwork.screening_keys_digest(e.name_keys);
    SELECT * INTO existing FROM trustwork.screening_match x
     WHERE ((v.person_id IS NOT NULL AND x.subject_person_id = v.person_id) OR (v.company_id IS NOT NULL AND x.subject_company_id = v.company_id))
       AND x.list_code = v_code AND x.entry_uid = e.entry_uid FOR UPDATE;
    IF existing.id IS NULL THEN
      INSERT INTO trustwork.screening_match (result_id, last_result_id, subject_person_id, subject_company_id, list_code, list_version_id, entry_uid, entry_type, entry_digest, entry_keys_digest,
        entry_name, programs, matched_key, screened_name, rule, score)
      VALUES (v_result, v_result, v.person_id, v.company_id, v_code, e.list_version_id, e.entry_uid, e.entry_type, e.entry_digest, v_keys, e.primary_name, e.programs,
        m ->> 'matchedKey', btrim(m ->> 'screenedName'), m ->> 'rule', CASE WHEN m ->> 'rule' = 'fuzzy' THEN (m ->> 'score')::numeric(4,3) END);
      v_opened := v_opened + 1;
    ELSIF existing.state IN ('open', 'not_same_person') AND (existing.state = 'open' OR existing.entry_keys_digest <> v_keys) THEN
      UPDATE trustwork.screening_match SET state = 'open', last_result_id = v_result, list_version_id = e.list_version_id, entry_digest = e.entry_digest, entry_keys_digest = v_keys,
        entry_name = e.primary_name, programs = e.programs, matched_key = m ->> 'matchedKey', screened_name = btrim(m ->> 'screenedName'), rule = m ->> 'rule',
        score = CASE WHEN m ->> 'rule' = 'fuzzy' THEN (m ->> 'score')::numeric(4,3) END,
        opened_at = CASE WHEN existing.state = 'not_same_person' THEN now() ELSE existing.opened_at END,
        decided_at = CASE WHEN existing.state = 'not_same_person' THEN NULL ELSE existing.decided_at END
      WHERE id = existing.id;
      IF existing.state = 'not_same_person' THEN v_opened := v_opened + 1; END IF;
    ELSE
      UPDATE trustwork.screening_match SET last_result_id = v_result, list_version_id = e.list_version_id WHERE id = existing.id;
    END IF;
    existing := NULL;
  END LOOP;
  UPDATE trustwork.screening_subject_state SET names_digest = p_names_digest, last_result_id = v_result, last_outcome = v_outcome, last_screened_at = now(), screened_versions = p_list_version_ids
   WHERE id = s.id;
  s := trustwork.screening_recompute(s.id);
  IF v_opened > 0 AND v_queued_before = 0 THEN
    PERFORM trustwork.screening_notify_review(s.id);
  END IF;
  RETURN jsonb_build_object('resultId', v_result, 'outcome', v_outcome, 'opened', v_opened, 'stateId', s.id, 'moneyHeld', s.money_held);
END $$;

-- The nightly safety net: subjects never screened, whose names changed since their last screening, or whose last
-- screening could not run (not_screened), without a screening job waiting.
CREATE FUNCTION trustwork.screening_sweep_due(p_limit integer)
RETURNS TABLE (kind text, id uuid)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  WITH due AS (
    SELECT 'person'::text AS kind, p.id FROM trustwork.person p LEFT JOIN trustwork.screening_subject_state s ON s.subject_person_id = p.id
    WHERE s.id IS NULL OR s.last_outcome = 'not_screened' OR s.names_digest <> trustwork.screening_names_digest(ARRAY[p.display_name])
    UNION ALL
    SELECT 'company', c.id FROM trustwork.company c LEFT JOIN trustwork.screening_subject_state s ON s.subject_company_id = c.id
    WHERE s.id IS NULL OR s.last_outcome = 'not_screened' OR s.names_digest <> trustwork.screening_names_digest(ARRAY[c.display_name])
  )
  SELECT d.kind, d.id FROM due d
  WHERE NOT EXISTS (SELECT 1 FROM trustwork.job j WHERE j.kind = 'screening.screen_subject' AND j.state IN ('queued', 'leased')
                    AND j.payload -> 'subject' ->> 'kind' = d.kind AND j.payload -> 'subject' ->> 'id' = d.id::text)
  ORDER BY d.kind, d.id
  LIMIT least(greatest(coalesce(p_limit, 1), 1), 1000)
$$;

-- 9. Runtime entry points ------------------------------------------------------------------------------------------------
-- The internal screeningState(subject) port for the gates (SANC-004). Answers the effective state; never names a list,
-- an entry or a reviewer. A gate that cannot read it refuses.
CREATE FUNCTION trustwork.screening_state(p_kind text, p_id uuid)
RETURNS TABLE (money_held boolean, suspended boolean, reasons text[], last_outcome text, last_screened_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v record;
  x record;
BEGIN
  SELECT * INTO v FROM trustwork.screening_subject(p_kind, p_id);
  SELECT * INTO x FROM trustwork.screening_effective(v.person_id, v.company_id);
  RETURN QUERY SELECT x.money_held, x.suspended, x.reasons, x.last_outcome, x.last_screened_at;
END $$;

-- The caller's own status (core.compliance_status): their account, or a company they administer.
CREATE FUNCTION trustwork.screening_own_status(p_company uuid)
RETURNS TABLE (subject_kind text, subject_id uuid, money_held boolean, suspended boolean, reasons text[], last_outcome text, last_screened_at timestamptz, appealable boolean)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  x record;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'a verified identity is required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  IF p_company IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trustwork.membership m WHERE m.person_id = v_person AND m.company_id = p_company AND m.status = 'active' AND m.role = 'administrator') THEN
    RAISE EXCEPTION 'only an administrator of the company reads its compliance status' USING ERRCODE = '42501', HINT = 'access.not_found';
  END IF;
  SELECT * INTO x FROM trustwork.screening_effective(CASE WHEN p_company IS NULL THEN v_person END, p_company);
  RETURN QUERY SELECT CASE WHEN p_company IS NULL THEN 'person' ELSE 'company' END, coalesce(p_company, v_person), x.money_held, x.suspended, x.reasons, x.last_outcome, x.last_screened_at, x.appealable;
END $$;

-- Sign-in (inside the principal transaction) and every request: is the caller (the session's person) suspended by a
-- confirmed match? A possible match never answers true: it does not block sign-in.
CREATE FUNCTION trustwork.screening_caller_suspended() RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND EXISTS (
    SELECT 1 FROM trustwork.screening_subject_state s WHERE s.subject_person_id = trustwork.current_person_id() AND s.suspended)
$$;
CREATE FUNCTION trustwork.screening_session_suspended(p_token_hash bytea) RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT EXISTS (SELECT 1 FROM trustwork.screening_subject_state s WHERE s.suspended AND s.subject_person_id = trustwork.jurisdiction_session_person(p_token_hash))
$$;

-- The subject appeals the confirmed decision (core.appeal_compliance_decision; the API requires a fresh step-up).
-- Every confirmed match of the subject moves to `appeal`; a reviewer other than the decider answers.
CREATE FUNCTION trustwork.screening_file_appeal(p_company uuid, p_reason text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_subject_person uuid;
  v_id uuid;
  v_count integer := 0;
  s trustwork.screening_subject_state%ROWTYPE;
  v_queued_before integer;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'a verified identity is required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'a reason is required' USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.reason_required';
  END IF;
  IF p_company IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trustwork.membership m WHERE m.person_id = v_person AND m.company_id = p_company AND m.status = 'active' AND m.role = 'administrator') THEN
    RAISE EXCEPTION 'only an administrator of the company appeals for it' USING ERRCODE = '42501', HINT = 'access.not_found';
  END IF;
  v_subject_person := CASE WHEN p_company IS NULL THEN v_person END;
  SELECT * INTO s FROM trustwork.screening_subject_state x WHERE x.id = (trustwork.screening_state_row(v_subject_person, p_company)).id FOR UPDATE;
  v_queued_before := trustwork.screening_queued_count(v_subject_person, p_company);
  FOR v_id IN SELECT m.id FROM trustwork.screening_match m
    WHERE ((v_subject_person IS NOT NULL AND m.subject_person_id = v_subject_person) OR (p_company IS NOT NULL AND m.subject_company_id = p_company)) AND m.state = 'confirmed'
    ORDER BY m.id FOR UPDATE LOOP
    INSERT INTO trustwork.screening_decision (match_id, kind, decided_by, reason) VALUES (v_id, 'appeal', v_person, btrim(p_reason));
    UPDATE trustwork.screening_match SET state = 'appeal' WHERE id = v_id;
    v_count := v_count + 1;
  END LOOP;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'there is no decision to appeal' USING ERRCODE = '23514', HINT = 'screening.nothing_to_appeal';
  END IF;
  PERFORM trustwork.screening_recompute(s.id);
  IF v_queued_before = 0 THEN PERFORM trustwork.screening_notify_review(s.id); END IF;
  RETURN v_count;
END $$;

-- Staff decisions: a compliance officer of the node under an elevation (screening_staff_actor, SANC-002), never the
-- subject, a member of the subject company or a reviewer with a declared conflict; the match row lock serialises
-- concurrent reviewers so exactly one decision applies. Each writes the decision, the admin audit row and the
-- recomputed state in one transaction.
-- Locks in the order every writer uses (the subject state, then the match), so a decision and a concurrent screening
-- of the same subject queue instead of deadlocking.
CREATE FUNCTION trustwork.screening_lock_match_for(p_match uuid, p_person uuid) RETURNS trustwork.screening_match
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  m trustwork.screening_match%ROWTYPE;
BEGIN
  SELECT * INTO m FROM trustwork.screening_match WHERE id = p_match;
  IF FOUND THEN
    PERFORM 1 FROM trustwork.screening_subject_state s
     WHERE (m.subject_person_id IS NOT NULL AND s.subject_person_id = m.subject_person_id) OR (m.subject_company_id IS NOT NULL AND s.subject_company_id = m.subject_company_id)
     FOR UPDATE;
    SELECT * INTO m FROM trustwork.screening_match WHERE id = p_match FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such match' USING ERRCODE = 'no_data_found', HINT = 'screening.match_not_found';
  END IF;
  IF p_person = m.subject_person_id THEN
    RAISE EXCEPTION 'nobody decides about themselves' USING ERRCODE = '42501', HINT = 'screening.self_decision';
  END IF;
  IF m.subject_company_id IS NOT NULL AND EXISTS (SELECT 1 FROM trustwork.membership x WHERE x.person_id = p_person AND x.company_id = m.subject_company_id AND x.status = 'active') THEN
    RAISE EXCEPTION 'a member of the subject company does not decide' USING ERRCODE = '42501', HINT = 'screening.subject_member';
  END IF;
  IF trustwork.admin_conflicted(p_person, m.subject_person_id, m.subject_company_id) THEN
    RAISE EXCEPTION 'the reviewer declared a conflict of interest with the subject' USING ERRCODE = '42501', HINT = 'admin.conflict_of_interest';
  END IF;
  RETURN m;
END $$;
CREATE FUNCTION trustwork.screening_check_reason(p_reason text, p_evidence text) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'a reason is required' USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.reason_required';
  END IF;
  IF p_evidence IS NOT NULL AND p_evidence NOT IN ('identity_document', 'date_of_birth', 'nationality', 'address', 'registration_identifier', 'other') THEN
    RAISE EXCEPTION 'unknown evidence category' USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.evidence_required';
  END IF;
END $$;
-- Digest inputs carry integers only: the fuzzy score is recorded as text.
CREATE FUNCTION trustwork.screening_match_image(m trustwork.screening_match) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT to_jsonb(m) || jsonb_build_object('score', m.score::text)
$$;
CREATE FUNCTION trustwork.screening_approval_digest(p_action text, p_match trustwork.screening_match, p_proposer uuid) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.admin_digest(jsonb_build_object('action', p_action, 'matchId', p_match.id::text, 'listCode', p_match.list_code, 'entryUid', p_match.entry_uid,
    'entryKeysDigest', p_match.entry_keys_digest, 'proposedBy', p_proposer::text))
$$;

-- Confirm a possible match (one reviewer, the safe direction): the subject is suspended, their agent stopped, and a
-- report draft is prepared for the operator.
CREATE FUNCTION trustwork.screening_confirm_match(p_ctx jsonb, p_match uuid, p_reason text, p_evidence text) RETURNS trustwork.screening_match
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.screening_staff_actor(p_ctx, 'admin.screening.matches.decide');
  v_before trustwork.screening_match%ROWTYPE;
  v_after trustwork.screening_match%ROWTYPE;
  s trustwork.screening_subject_state%ROWTYPE;
BEGIN
  PERFORM trustwork.screening_check_reason(p_reason, coalesce(p_evidence, 'missing'));
  v_before := trustwork.screening_lock_match_for(p_match, v_actor.person_id);
  IF v_before.state <> 'open' THEN
    RAISE EXCEPTION 'only an open match is confirmed' USING ERRCODE = '23514', HINT = 'screening.match_state';
  END IF;
  INSERT INTO trustwork.screening_decision (match_id, kind, decided_by, reason, evidence_category) VALUES (p_match, 'confirm', v_actor.person_id, btrim(p_reason), p_evidence);
  UPDATE trustwork.screening_match SET state = 'confirmed', decided_at = now() WHERE id = p_match RETURNING * INTO v_after;
  PERFORM trustwork.screening_apply_suspension(v_after.subject_person_id, v_after.subject_company_id);
  INSERT INTO trustwork.screening_report_draft (match_id, subject_person_id, subject_company_id, list_code, entry_uid, programs, due_on)
  VALUES (p_match, v_after.subject_person_id, v_after.subject_company_id, v_after.list_code, v_after.entry_uid, v_after.programs,
    trustwork.screening_add_business_days((now() AT TIME ZONE 'UTC')::date, 10))
  ON CONFLICT (match_id) DO NOTHING;
  INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
  VALUES ('screening_match', p_match::text, v_after.revision, 'screening.report_draft_prepared', jsonb_build_object('matchId', p_match));
  SELECT * INTO s FROM trustwork.screening_subject_state x WHERE x.id = (trustwork.screening_state_row(v_after.subject_person_id, v_after.subject_company_id)).id;
  PERFORM trustwork.screening_recompute(s.id);
  PERFORM trustwork.admin_record(v_actor, p_ctx, trustwork.jurisdiction_node(), NULL, 'screening.match_confirmed', 'screening_match', p_match,
    trustwork.screening_match_image(v_before), trustwork.screening_match_image(v_after));
  RETURN v_after;
END $$;

-- Propose "not the same person": the match waits for a second person (screening.clear_match).
CREATE FUNCTION trustwork.screening_propose_not_same_person(p_ctx jsonb, p_match uuid, p_reason text, p_evidence text) RETURNS trustwork.screening_match
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.screening_staff_actor(p_ctx, 'admin.screening.matches.decide');
  v_before trustwork.screening_match%ROWTYPE;
  v_after trustwork.screening_match%ROWTYPE;
  v_digest text;
  v_approval trustwork.second_person_approval%ROWTYPE;
BEGIN
  PERFORM trustwork.screening_check_reason(p_reason, coalesce(p_evidence, 'missing'));
  v_before := trustwork.screening_lock_match_for(p_match, v_actor.person_id);
  IF v_before.state <> 'open' THEN
    RAISE EXCEPTION 'only an open match can be proposed as not the same person' USING ERRCODE = '23514', HINT = 'screening.match_state';
  END IF;
  v_digest := trustwork.screening_approval_digest('screening.clear_match', v_before, v_actor.person_id);
  INSERT INTO trustwork.second_person_approval (action, scope_kind, node_id, hub_id, action_digest, reason, requested_by)
  VALUES ('screening.clear_match', 'node', trustwork.jurisdiction_node(), NULL, v_digest, 'Screening review: not the same person', v_actor.person_id) RETURNING * INTO v_approval;
  INSERT INTO trustwork.screening_decision (match_id, kind, decided_by, reason, evidence_category, second_person_approval_id, approval_digest)
  VALUES (p_match, 'propose_not_same_person', v_actor.person_id, btrim(p_reason), p_evidence, v_approval.id, v_digest);
  UPDATE trustwork.screening_match SET state = 'pending_second' WHERE id = p_match RETURNING * INTO v_after;
  PERFORM trustwork.admin_record(v_actor, p_ctx, trustwork.jurisdiction_node(), NULL, 'screening.not_same_person_proposed', 'screening_match', p_match,
    trustwork.screening_match_image(v_before), trustwork.screening_match_image(v_after));
  RETURN v_after;
END $$;

-- The second person decides a proposal (not the same person, or the reversal of a confirmation): never the proposer,
-- restating the digest they reviewed. Approve applies the proposal and consumes the approval; reject sends the match
-- back (open, or confirmed for a reversal). A withdrawn or expired request can still be rejected, never approved.
CREATE FUNCTION trustwork.screening_decide_proposal(p_ctx jsonb, p_match uuid, p_decision text, p_digest text, p_reason text) RETURNS trustwork.screening_match
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.screening_staff_actor(p_ctx, 'admin.screening.matches.approve');
  v_before trustwork.screening_match%ROWTYPE;
  v_after trustwork.screening_match%ROWTYPE;
  v_proposal trustwork.screening_decision%ROWTYPE;
  v_approval trustwork.second_person_approval%ROWTYPE;
  v_decision uuid := trustwork.new_uuid();
  s trustwork.screening_subject_state%ROWTYPE;
BEGIN
  PERFORM trustwork.screening_check_reason(p_reason, NULL);
  IF p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'decision is approve or reject' USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.invalid_decision';
  END IF;
  v_before := trustwork.screening_lock_match_for(p_match, v_actor.person_id);
  IF v_before.state NOT IN ('pending_second', 'pending_reversal') THEN
    RAISE EXCEPTION 'no proposal waits on this match' USING ERRCODE = '23514', HINT = 'screening.match_state';
  END IF;
  SELECT * INTO v_proposal FROM trustwork.screening_decision d WHERE d.match_id = p_match AND d.kind IN ('propose_not_same_person', 'propose_reversal') ORDER BY d.seq DESC LIMIT 1;
  IF v_proposal.decided_by = v_actor.person_id THEN
    RAISE EXCEPTION 'the proposer cannot be the second person' USING ERRCODE = '42501', HINT = 'screening.second_person_required';
  END IF;
  SELECT * INTO v_approval FROM trustwork.second_person_approval WHERE id = v_proposal.second_person_approval_id FOR UPDATE;
  IF p_decision = 'approve' THEN
    IF v_approval.status <> 'pending' THEN
      RAISE EXCEPTION 'the request is %', v_approval.status USING ERRCODE = '23514', HINT = 'admin.approval_not_pending';
    END IF;
    IF v_approval.request_expires_at <= now() THEN
      RAISE EXCEPTION 'the request expired; propose again' USING ERRCODE = '23514', HINT = 'admin.approval_expired';
    END IF;
    IF p_digest IS DISTINCT FROM v_approval.action_digest THEN
      RAISE EXCEPTION 'the reviewed digest differs from the proposal' USING ERRCODE = '23514', HINT = 'access.approval_digest_mismatch';
    END IF;
    UPDATE trustwork.second_person_approval SET status = 'approved', approved_by = v_actor.person_id, approved_at = now(), expires_at = now() + interval '1 hour' WHERE id = v_approval.id;
    UPDATE trustwork.second_person_approval SET status = 'consumed', consumed_ref = v_decision WHERE id = v_approval.id;
    INSERT INTO trustwork.screening_decision (id, match_id, kind, decided_by, reason, second_person_approval_id) VALUES (v_decision, p_match, 'approve', v_actor.person_id, btrim(p_reason), v_approval.id);
    UPDATE trustwork.screening_match SET state = 'not_same_person', decided_at = now() WHERE id = p_match RETURNING * INTO v_after;
  ELSE
    IF v_approval.status = 'pending' AND v_approval.request_expires_at > now() THEN
      UPDATE trustwork.second_person_approval SET status = 'declined', declined_by = v_actor.person_id, decline_reason = btrim(p_reason) WHERE id = v_approval.id;
    END IF;
    INSERT INTO trustwork.screening_decision (id, match_id, kind, decided_by, reason, second_person_approval_id) VALUES (v_decision, p_match, 'reject', v_actor.person_id, btrim(p_reason), v_approval.id);
    UPDATE trustwork.screening_match SET state = CASE WHEN v_before.state = 'pending_second' THEN 'open' ELSE 'confirmed' END WHERE id = p_match RETURNING * INTO v_after;
  END IF;
  SELECT * INTO s FROM trustwork.screening_subject_state x WHERE x.id = (trustwork.screening_state_row(v_after.subject_person_id, v_after.subject_company_id)).id;
  PERFORM trustwork.screening_recompute(s.id);
  PERFORM trustwork.admin_record(v_actor, p_ctx, trustwork.jurisdiction_node(), NULL,
    CASE WHEN p_decision = 'approve' AND v_before.state = 'pending_second' THEN 'screening.not_same_person_approved'
         WHEN p_decision = 'approve' THEN 'screening.reversal_approved'
         WHEN v_before.state = 'pending_second' THEN 'screening.not_same_person_rejected'
         ELSE 'screening.reversal_rejected' END,
    'screening_match', p_match, trustwork.screening_match_image(v_before), trustwork.screening_match_image(v_after));
  RETURN v_after;
END $$;

-- Decide an appeal: a reviewer other than the one who confirmed. Uphold keeps the confirmation; a proposed reversal
-- waits for a second person (screening.reverse_confirmation).
CREATE FUNCTION trustwork.screening_decide_appeal(p_ctx jsonb, p_match uuid, p_decision text, p_reason text, p_evidence text) RETURNS trustwork.screening_match
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.screening_staff_actor(p_ctx, 'admin.screening.appeals.decide');
  v_before trustwork.screening_match%ROWTYPE;
  v_after trustwork.screening_match%ROWTYPE;
  v_decider uuid;
  v_digest text;
  v_approval trustwork.second_person_approval%ROWTYPE;
  s trustwork.screening_subject_state%ROWTYPE;
BEGIN
  PERFORM trustwork.screening_check_reason(p_reason, coalesce(p_evidence, 'missing'));
  IF p_decision NOT IN ('uphold', 'propose_reversal') THEN
    RAISE EXCEPTION 'decision is uphold or propose_reversal' USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.invalid_decision';
  END IF;
  v_before := trustwork.screening_lock_match_for(p_match, v_actor.person_id);
  IF v_before.state <> 'appeal' THEN
    RAISE EXCEPTION 'no appeal waits on this match' USING ERRCODE = '23514', HINT = 'screening.match_state';
  END IF;
  SELECT d.decided_by INTO v_decider FROM trustwork.screening_decision d WHERE d.match_id = p_match AND d.kind IN ('confirm', 'uphold') ORDER BY d.seq DESC LIMIT 1;
  IF v_decider = v_actor.person_id THEN
    RAISE EXCEPTION 'an appeal is decided by another reviewer' USING ERRCODE = '42501', HINT = 'screening.same_reviewer';
  END IF;
  IF p_decision = 'uphold' THEN
    INSERT INTO trustwork.screening_decision (match_id, kind, decided_by, reason, evidence_category) VALUES (p_match, 'uphold', v_actor.person_id, btrim(p_reason), p_evidence);
    UPDATE trustwork.screening_match SET state = 'confirmed', decided_at = now() WHERE id = p_match RETURNING * INTO v_after;
  ELSE
    v_digest := trustwork.screening_approval_digest('screening.reverse_confirmation', v_before, v_actor.person_id);
    INSERT INTO trustwork.second_person_approval (action, scope_kind, node_id, hub_id, action_digest, reason, requested_by)
    VALUES ('screening.reverse_confirmation', 'node', trustwork.jurisdiction_node(), NULL, v_digest, 'Screening review: reverse a confirmation on appeal', v_actor.person_id) RETURNING * INTO v_approval;
    INSERT INTO trustwork.screening_decision (match_id, kind, decided_by, reason, evidence_category, second_person_approval_id, approval_digest)
    VALUES (p_match, 'propose_reversal', v_actor.person_id, btrim(p_reason), p_evidence, v_approval.id, v_digest);
    UPDATE trustwork.screening_match SET state = 'pending_reversal' WHERE id = p_match RETURNING * INTO v_after;
  END IF;
  SELECT * INTO s FROM trustwork.screening_subject_state x WHERE x.id = (trustwork.screening_state_row(v_after.subject_person_id, v_after.subject_company_id)).id;
  PERFORM trustwork.screening_recompute(s.id);
  PERFORM trustwork.admin_record(v_actor, p_ctx, trustwork.jurisdiction_node(), NULL, CASE WHEN p_decision = 'uphold' THEN 'screening.appeal_upheld' ELSE 'screening.reversal_proposed' END,
    'screening_match', p_match, trustwork.screening_match_image(v_before), trustwork.screening_match_image(v_after));
  RETURN v_after;
END $$;

-- 10. Row-level security and grants ---------------------------------------------------------------------------------------
ALTER TABLE trustwork.screening_subject_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.screening_subject_state FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.screening_result ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.screening_result FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.screening_match ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.screening_match FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.screening_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.screening_decision FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.screening_report_draft ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.screening_report_draft FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.screening_subject_state AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.screening_result AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.screening_match AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.screening_decision AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.screening_report_draft AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
-- Compliance officers and auditors of the node read screening records (the reader of SANC-001 and SANC-002); the
-- subject, counterparties and every other staff role read nothing.
CREATE POLICY screening_subject_state_staff_read ON trustwork.screening_subject_state FOR SELECT TO trustwork_app USING (trustwork.jurisdiction_staff_reader());
CREATE POLICY screening_result_staff_read ON trustwork.screening_result FOR SELECT TO trustwork_app USING (trustwork.jurisdiction_staff_reader());
CREATE POLICY screening_match_staff_read ON trustwork.screening_match FOR SELECT TO trustwork_app USING (trustwork.jurisdiction_staff_reader());
CREATE POLICY screening_decision_staff_read ON trustwork.screening_decision FOR SELECT TO trustwork_app USING (trustwork.jurisdiction_staff_reader());
CREATE POLICY screening_report_draft_staff_read ON trustwork.screening_report_draft FOR SELECT TO trustwork_app USING (trustwork.jurisdiction_staff_reader());

GRANT SELECT ON trustwork.screening_subject_state, trustwork.screening_result, trustwork.screening_match, trustwork.screening_decision, trustwork.screening_report_draft TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.screening_state(text, uuid), trustwork.screening_own_status(uuid), trustwork.screening_caller_suspended(), trustwork.screening_session_suspended(bytea),
  trustwork.screening_file_appeal(uuid, text), trustwork.screening_confirm_match(jsonb, uuid, text, text), trustwork.screening_propose_not_same_person(jsonb, uuid, text, text),
  trustwork.screening_decide_proposal(jsonb, uuid, text, text, text), trustwork.screening_decide_appeal(jsonb, uuid, text, text, text) TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.screening_subject_names(text, uuid), trustwork.screening_should_screen(text, uuid, boolean), trustwork.screening_lists_now(),
  trustwork.screening_candidates(text[], text[], text[]), trustwork.screening_record_result(text, uuid, text, text, uuid[], text, text, numeric, text, jsonb),
  trustwork.screening_sweep_due(integer) TO trustwork_worker;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
