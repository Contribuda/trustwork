-- DATA-002 administration persistence, part 3: moderation reports and cases, sanctions, appeals, feature flags,
-- maintenance windows and kill switches (docs/data/model.md section 27, docs/engine/hub-administration.md "Editorial and
-- community", docs/engine/hub-console/operations.md, KillSwitchSchema in packages/contracts/src/hub.ts).
--
-- Rules carried here for every writer: the reporter's identity is never shown to the reported party; sanctions stay
-- within engine bounds and level 4 needs a second person; an appeal is decided by someone other than the original
-- decider, one appeal path per decision; a feature flag can never touch authorization, projections, egress or ranking;
-- engaging a kill switch is immediate and needs one person, releasing it needs a second-person approval and an incident
-- note. Company claims are not here (CLM-001).

-- 1. Moderation reports ------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.moderation_report (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  reporter_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  target_kind text NOT NULL CHECK (target_kind ~ '^[a-z][a-z0-9_]{1,40}$'),
  target_id uuid NOT NULL,
  clause_code text NOT NULL CHECK (clause_code ~ '^[a-z][a-z0-9_.]{1,80}$'),
  text text NULL CHECK (length(text) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX moderation_report_target_idx ON trustwork.moderation_report (hub_id, target_kind, target_id);
-- Reports never change; only the owner-run erasure executor (a maintenance session) removes one.
CREATE FUNCTION trustwork.admin_report_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND trustwork.maintenance_session() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'reports are immutable' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
END $$;
CREATE TRIGGER moderation_report_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.moderation_report FOR EACH ROW EXECUTE FUNCTION trustwork.admin_report_guard();

-- 2. Moderation cases ---------------------------------------------------------------------------------------------------
-- open -> in_review -> decided -> appealed -> appeal_decided -> closed (decided -> closed when nobody appeals);
-- emergency_hold may be set while open or in review. subject_* names the target's owner party (for conflicts,
-- sanctions and the owner's view of the reasons).
CREATE TABLE trustwork.moderation_case (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  target_kind text NOT NULL CHECK (target_kind ~ '^[a-z][a-z0-9_]{1,40}$'),
  target_id uuid NOT NULL,
  subject_person_id uuid NULL REFERENCES trustwork.person (id),
  subject_company_id uuid NULL REFERENCES trustwork.company (id),
  report_ids uuid[] NOT NULL DEFAULT '{}' CHECK (array_position(report_ids, NULL) IS NULL AND trustwork.admin_distinct(report_ids)),
  clause_codes text[] NOT NULL CHECK (cardinality(clause_codes) >= 1 AND trustwork.admin_all_match(clause_codes, '^[a-z][a-z0-9_.]{1,80}$')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_review', 'decided', 'appealed', 'appeal_decided', 'closed')),
  assigned_to uuid NULL REFERENCES trustwork.person (id),
  emergency_hold boolean NOT NULL DEFAULT false,
  decision text NULL CHECK (decision IN ('no_action', 'warning', 'content_removed', 'content_restored', 'sanction')),
  decision_reason text NULL CHECK (length(decision_reason) BETWEEN 1 AND 500),
  decided_by uuid NULL REFERENCES trustwork.person (id),
  decided_at timestamptz NULL,
  opened_by uuid NOT NULL REFERENCES trustwork.person (id),
  opened_at timestamptz NOT NULL DEFAULT now(),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT moderation_case_subject_at_most_one CHECK (subject_person_id IS NULL OR subject_company_id IS NULL),
  CONSTRAINT moderation_case_decision_shape CHECK ((decision IS NULL) = (decided_by IS NULL) AND (decided_by IS NULL) = (decided_at IS NULL)
    AND (decision IS NULL) = (status IN ('open', 'in_review')) AND (decision IS NULL OR decision_reason IS NOT NULL)),
  CONSTRAINT moderation_case_hold_only_open CHECK (NOT emergency_hold OR status IN ('open', 'in_review'))
);
CREATE INDEX moderation_case_hub_status_idx ON trustwork.moderation_case (hub_id, status);
CREATE TRIGGER moderation_case_touch BEFORE UPDATE ON trustwork.moderation_case FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

CREATE FUNCTION trustwork.admin_moderation_case_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'moderation cases are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.decision IS NOT NULL THEN
      RAISE EXCEPTION 'a moderation case opens as open' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(NEW.report_ids) r WHERE NOT EXISTS (SELECT 1 FROM trustwork.moderation_report m WHERE m.id = r AND m.hub_id = NEW.hub_id
               AND m.target_kind = NEW.target_kind AND m.target_id = NEW.target_id)) THEN
      RAISE EXCEPTION 'every linked report is about this target in this hub' USING ERRCODE = 'check_violation', HINT = 'admin.report_mismatch';
    END IF;
    NEW.opened_at := now();
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.hub_id <> OLD.hub_id OR NEW.target_kind <> OLD.target_kind OR NEW.target_id <> OLD.target_id OR NEW.opened_by <> OLD.opened_by
     OR NEW.opened_at <> OLD.opened_at OR NEW.subject_person_id IS DISTINCT FROM OLD.subject_person_id OR NEW.subject_company_id IS DISTINCT FROM OLD.subject_company_id
     OR NOT (NEW.report_ids @> OLD.report_ids) OR NOT (NEW.clause_codes @> OLD.clause_codes) THEN
    RAISE EXCEPTION 'case identity is immutable; reports and clauses are only added' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'closed cases are final' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  IF NEW.status <> OLD.status AND (OLD.status, NEW.status) NOT IN (('open', 'in_review'), ('open', 'decided'), ('in_review', 'decided'), ('decided', 'appealed'),
       ('appealed', 'appeal_decided'), ('decided', 'closed'), ('appeal_decided', 'closed')) THEN
    RAISE EXCEPTION 'moderation case % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  IF OLD.decision IS NOT NULL AND (NEW.decision IS DISTINCT FROM OLD.decision OR NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
     OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason) THEN
    RAISE EXCEPTION 'a decision is final; appeals append' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  IF OLD.decision IS NULL AND NEW.decision IS NOT NULL THEN
    NEW.decided_at := now();
    NEW.emergency_hold := false;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER moderation_case_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.moderation_case FOR EACH ROW EXECUTE FUNCTION trustwork.admin_moderation_case_guard();

-- 3. Sanctions ---------------------------------------------------------------------------------------------------------
-- Engine bounds (Proposed, hub ladders choose durations inside them): level 1 at most 7 days, level 2 at most 30 days,
-- level 3 at most 365 days, level 4 may be open-ended and needs a consumed second-person approval
-- (moderation.apply_sanction_l4) of exactly this sanction. A sanction is lifted, never edited or deleted.
CREATE TABLE trustwork.sanction (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  subject_person_id uuid NULL REFERENCES trustwork.person (id),
  subject_company_id uuid NULL REFERENCES trustwork.company (id),
  level integer NOT NULL CHECK (level BETWEEN 1 AND 4),
  feature_scope text NOT NULL CHECK (feature_scope ~ '^[a-z][a-z0-9_]{1,40}$'),
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz NULL,
  moderation_case_id uuid NOT NULL REFERENCES trustwork.moderation_case (id),
  decided_by uuid NOT NULL REFERENCES trustwork.person (id),
  second_approval_id uuid NULL UNIQUE REFERENCES trustwork.second_person_approval (id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  lifted_at timestamptz NULL,
  lifted_by uuid NULL REFERENCES trustwork.person (id),
  lift_reason text NULL CHECK (length(lift_reason) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sanction_subject_xor CHECK ((subject_person_id IS NULL) <> (subject_company_id IS NULL)),
  CONSTRAINT sanction_bounds CHECK (CASE level
    WHEN 1 THEN ends_at IS NOT NULL AND ends_at <= starts_at + interval '7 days'
    WHEN 2 THEN ends_at IS NOT NULL AND ends_at <= starts_at + interval '30 days'
    WHEN 3 THEN ends_at IS NOT NULL AND ends_at <= starts_at + interval '365 days'
    ELSE second_approval_id IS NOT NULL END),
  CONSTRAINT sanction_ends_after_start CHECK (ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT sanction_lift_shape CHECK ((lifted_at IS NULL) = (lifted_by IS NULL) AND (lifted_at IS NULL) = (lift_reason IS NULL))
);
CREATE INDEX sanction_subject_person_idx ON trustwork.sanction (subject_person_id) WHERE subject_person_id IS NOT NULL;
CREATE INDEX sanction_subject_company_idx ON trustwork.sanction (subject_company_id) WHERE subject_company_id IS NOT NULL;

CREATE FUNCTION trustwork.admin_sanction_digest(p_case uuid, p_subject_person uuid, p_subject_company uuid, p_level integer, p_feature_scope text, p_duration_seconds bigint) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.admin_digest(jsonb_build_object('action', 'moderation.apply_sanction_l4', 'moderationCaseId', p_case::text,
    'subject', CASE WHEN p_subject_person IS NOT NULL THEN jsonb_build_object('kind', 'person', 'id', p_subject_person::text) ELSE jsonb_build_object('kind', 'company', 'id', p_subject_company::text) END,
    'level', p_level, 'featureScope', p_feature_scope, 'durationSeconds', p_duration_seconds))
$$;

CREATE FUNCTION trustwork.admin_sanction_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_case trustwork.moderation_case%ROWTYPE;
  v_approval trustwork.second_person_approval%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sanctions are never deleted; lift them' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.hub_id, NEW.subject_person_id, NEW.subject_company_id, NEW.level, NEW.feature_scope, NEW.starts_at, NEW.ends_at, NEW.moderation_case_id, NEW.decided_by,
           NEW.second_approval_id, NEW.reason, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.hub_id, OLD.subject_person_id, OLD.subject_company_id, OLD.level, OLD.feature_scope, OLD.starts_at, OLD.ends_at, OLD.moderation_case_id, OLD.decided_by,
           OLD.second_approval_id, OLD.reason, OLD.created_at)
       OR OLD.lifted_at IS NOT NULL OR NEW.lifted_at IS NULL THEN
      RAISE EXCEPTION 'a sanction only changes by lifting it, once' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
    END IF;
    NEW.lifted_at := now();
    RETURN NEW;
  END IF;
  NEW.created_at := now();
  IF NEW.starts_at < now() THEN
    NEW.ends_at := NEW.ends_at + (now() - NEW.starts_at);
    NEW.starts_at := now();
  END IF;
  SELECT * INTO v_case FROM trustwork.moderation_case WHERE id = NEW.moderation_case_id;
  IF NOT FOUND OR v_case.hub_id <> NEW.hub_id OR v_case.decision IS DISTINCT FROM 'sanction'
     OR v_case.subject_person_id IS DISTINCT FROM NEW.subject_person_id OR v_case.subject_company_id IS DISTINCT FROM NEW.subject_company_id THEN
    RAISE EXCEPTION 'a sanction follows a sanction decision on its subject''s moderation case' USING ERRCODE = 'check_violation', HINT = 'admin.case_mismatch';
  END IF;
  IF NEW.level = 4 THEN
    SELECT * INTO v_approval FROM trustwork.second_person_approval WHERE id = NEW.second_approval_id;
    IF NOT FOUND OR v_approval.action <> 'moderation.apply_sanction_l4' OR v_approval.status <> 'consumed' OR v_approval.consumed_ref IS DISTINCT FROM NEW.id
       OR v_approval.requested_by <> NEW.decided_by OR v_approval.scope_kind <> 'hub' OR v_approval.hub_id <> NEW.hub_id
       OR v_approval.action_digest <> trustwork.admin_sanction_digest(NEW.moderation_case_id, NEW.subject_person_id, NEW.subject_company_id, NEW.level, NEW.feature_scope,
            CASE WHEN NEW.ends_at IS NULL THEN NULL ELSE round(extract(epoch FROM NEW.ends_at - NEW.starts_at))::bigint END) THEN
      RAISE EXCEPTION 'level 4 needs the consumed second-person approval of exactly this sanction' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_mismatch';
    END IF;
  ELSIF NEW.second_approval_id IS NOT NULL THEN
    RAISE EXCEPTION 'only level 4 carries an approval' USING ERRCODE = 'check_violation', HINT = 'admin.approval_mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sanction_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.sanction FOR EACH ROW EXECUTE FUNCTION trustwork.admin_sanction_guard();

-- 4. Appeals -------------------------------------------------------------------------------------------------------------
-- One appeal path per decision (one live appeal per subject); decided by a different person than the original decider.
-- Appeals on sanctions and moderation cases are filed by their subject here; the other kinds are filed by their owning
-- modules (owner-run) because only they know the subject and its decider.
CREATE TABLE trustwork.appeal (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  subject_kind text NOT NULL CHECK (subject_kind IN ('sanction', 'moderation_case', 'verification_check', 'review', 'screening_result', 'confirmation_response',
    'timeliness_observation', 'performance_observation', 'passport_credential', 'recommendation')),
  subject_id uuid NOT NULL,
  appellant_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  appellant_company_id uuid NULL REFERENCES trustwork.company (id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 4000),
  original_decided_by uuid NOT NULL REFERENCES trustwork.person (id),
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'in_review', 'upheld', 'overturned', 'partially_overturned', 'withdrawn')),
  decided_by uuid NULL REFERENCES trustwork.person (id),
  decided_at timestamptz NULL,
  decision_reason text NULL CHECK (length(decision_reason) BETWEEN 1 AND 500),
  filed_at timestamptz NOT NULL DEFAULT now(),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appeal_different_decider CHECK (decided_by IS DISTINCT FROM original_decided_by AND decided_by IS DISTINCT FROM appellant_person_id),
  CONSTRAINT appeal_decision_shape CHECK ((decided_by IS NULL) = (decided_at IS NULL) AND (decided_by IS NULL) = (status IN ('submitted', 'in_review', 'withdrawn'))
    AND (decided_by IS NULL OR decision_reason IS NOT NULL))
);
CREATE UNIQUE INDEX appeal_one_path ON trustwork.appeal (subject_kind, subject_id) WHERE status <> 'withdrawn';
CREATE TRIGGER appeal_touch BEFORE UPDATE ON trustwork.appeal FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
CREATE FUNCTION trustwork.admin_appeal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'appeals are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'submitted' OR NEW.decided_by IS NOT NULL THEN
      RAISE EXCEPTION 'an appeal is born submitted' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
    END IF;
    NEW.filed_at := now();
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.hub_id, NEW.subject_kind, NEW.subject_id, NEW.appellant_person_id, NEW.appellant_company_id, NEW.reason, NEW.original_decided_by, NEW.filed_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.hub_id, OLD.subject_kind, OLD.subject_id, OLD.appellant_person_id, OLD.appellant_company_id, OLD.reason, OLD.original_decided_by, OLD.filed_at) THEN
    RAISE EXCEPTION 'the appeal is immutable' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'submitted' AND NEW.status IN ('in_review', 'withdrawn', 'upheld', 'overturned', 'partially_overturned'))
       OR (OLD.status = 'in_review' AND NEW.status IN ('withdrawn', 'upheld', 'overturned', 'partially_overturned'))) THEN
    RAISE EXCEPTION 'appeal % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  IF OLD.decided_by IS NULL AND NEW.decided_by IS NOT NULL THEN
    NEW.decided_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER appeal_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.appeal FOR EACH ROW EXECUTE FUNCTION trustwork.admin_appeal_guard();

-- 5. Feature flags ------------------------------------------------------------------------------------------------------
-- Experimental UI or behaviour per node or hub, with an owner, a description and an expiry. A flag can never widen
-- access: its declared effect has no authorization, projection, egress or ranking value, and its key cannot name one.
CREATE TABLE trustwork.feature_flag (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_.]{2,80}$'
    AND key !~* '(score|(?<!re)rank|position|badge|weight|boost|promot|priorit|auth|access|permission|grant|role|privac|visib|projection|egress|consent|mandate)'),
  scope_kind text NOT NULL CHECK (scope_kind IN ('node', 'hub')),
  node_id uuid NULL REFERENCES trustwork.admin_node (id),
  hub_id uuid NULL REFERENCES trustwork.hub (id),
  value jsonb NOT NULL,
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
  declared_effect text NOT NULL CHECK (declared_effect IN ('ui', 'behaviour', 'content', 'operations')),
  owner_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  expires_at timestamptz NOT NULL,
  changed_by uuid NOT NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feature_flag_scope_shape CHECK ((scope_kind = 'node' AND node_id IS NOT NULL AND hub_id IS NULL) OR (scope_kind = 'hub' AND hub_id IS NOT NULL AND node_id IS NULL)),
  CONSTRAINT feature_flag_expiry CHECK (expires_at > created_at AND expires_at <= created_at + interval '400 days')
);
CREATE UNIQUE INDEX feature_flag_node_key ON trustwork.feature_flag (key, node_id) WHERE node_id IS NOT NULL;
CREATE UNIQUE INDEX feature_flag_hub_key ON trustwork.feature_flag (key, hub_id) WHERE hub_id IS NOT NULL;
CREATE TRIGGER feature_flag_touch BEFORE UPDATE ON trustwork.feature_flag FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
CREATE FUNCTION trustwork.admin_flag_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'flags are not deleted; let them expire or set them off' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
  ELSIF NEW.key <> OLD.key OR NEW.scope_kind <> OLD.scope_kind OR NEW.node_id IS DISTINCT FROM OLD.node_id OR NEW.hub_id IS DISTINCT FROM OLD.hub_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a flag keeps its key and scope' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER feature_flag_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.feature_flag FOR EACH ROW EXECUTE FUNCTION trustwork.admin_flag_guard();

-- 6. Maintenance windows -------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.maintenance_window (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  scope_kind text NOT NULL CHECK (scope_kind IN ('node', 'hub')),
  node_id uuid NULL REFERENCES trustwork.admin_node (id),
  hub_id uuid NULL REFERENCES trustwork.hub (id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  read_only boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES trustwork.person (id),
  cancelled_at timestamptz NULL,
  cancelled_by uuid NULL REFERENCES trustwork.person (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maintenance_window_scope_shape CHECK ((scope_kind = 'node' AND node_id IS NOT NULL AND hub_id IS NULL) OR (scope_kind = 'hub' AND hub_id IS NOT NULL AND node_id IS NULL)),
  CONSTRAINT maintenance_window_order CHECK (ends_at > starts_at AND ends_at <= starts_at + interval '7 days'),
  CONSTRAINT maintenance_window_cancel_shape CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL))
);
CREATE INDEX maintenance_window_time_idx ON trustwork.maintenance_window (starts_at, ends_at) WHERE cancelled_at IS NULL;
CREATE FUNCTION trustwork.admin_maintenance_window_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'windows are cancelled, not deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    NEW.cancelled_at := NULL;
    NEW.cancelled_by := NULL;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.scope_kind, NEW.node_id, NEW.hub_id, NEW.starts_at, NEW.ends_at, NEW.reason, NEW.read_only, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.scope_kind, OLD.node_id, OLD.hub_id, OLD.starts_at, OLD.ends_at, OLD.reason, OLD.read_only, OLD.created_by, OLD.created_at)
     OR OLD.cancelled_at IS NOT NULL OR NEW.cancelled_at IS NULL THEN
    RAISE EXCEPTION 'a window only changes by cancellation, once' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  NEW.cancelled_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER maintenance_window_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.maintenance_window FOR EACH ROW EXECUTE FUNCTION trustwork.admin_maintenance_window_guard();

-- 7. Kill switches --------------------------------------------------------------------------------------------------------
-- KillSwitchScopeSchema: one engaged switch per target. Engaging is immediate (one person); releasing consumes a
-- second-person approval (kill_switch.release) of exactly this release and records an incident note.
CREATE TABLE trustwork.kill_switch (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  scope_kind text NOT NULL CHECK (scope_kind IN ('node', 'hub_agent_dispatch', 'agent_module', 'agent_action', 'agent_extension', 'external_agent_api',
    'provider_connection', 'model_job', 'pipeline', 'outbound_messages')),
  node_id uuid NULL REFERENCES trustwork.admin_node (id),
  hub_id uuid NULL REFERENCES trustwork.hub (id),
  module_key text NULL CHECK (module_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  action text NULL CHECK (action ~ '^[a-z][a-z0-9_.]{1,80}$'),
  extension_id uuid NULL,
  connection_id uuid NULL,
  job text NULL CHECK (job ~ '^[a-z][a-z0-9_]{1,40}$'),
  pipeline_id uuid NULL,
  state text NOT NULL DEFAULT 'engaged' CHECK (state IN ('engaged', 'released')),
  engaged_by uuid NOT NULL REFERENCES trustwork.person (id),
  engaged_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  incident_id uuid NULL REFERENCES trustwork.incident (id),
  released_by uuid NULL REFERENCES trustwork.person (id),
  released_at timestamptz NULL,
  release_approval_id uuid NULL UNIQUE REFERENCES trustwork.second_person_approval (id),
  incident_note text NULL CHECK (length(incident_note) BETWEEN 1 AND 500),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kill_switch_scope_shape CHECK (CASE scope_kind
    WHEN 'node' THEN node_id IS NOT NULL AND hub_id IS NULL AND module_key IS NULL AND action IS NULL AND extension_id IS NULL AND connection_id IS NULL AND job IS NULL AND pipeline_id IS NULL
    WHEN 'agent_module' THEN hub_id IS NOT NULL AND node_id IS NULL AND module_key IS NOT NULL AND action IS NULL AND extension_id IS NULL AND connection_id IS NULL AND job IS NULL AND pipeline_id IS NULL
    WHEN 'agent_action' THEN hub_id IS NOT NULL AND node_id IS NULL AND action IS NOT NULL AND module_key IS NULL AND extension_id IS NULL AND connection_id IS NULL AND job IS NULL AND pipeline_id IS NULL
    WHEN 'agent_extension' THEN hub_id IS NOT NULL AND node_id IS NULL AND extension_id IS NOT NULL AND module_key IS NULL AND action IS NULL AND connection_id IS NULL AND job IS NULL AND pipeline_id IS NULL
    WHEN 'model_job' THEN hub_id IS NOT NULL AND node_id IS NULL AND job IS NOT NULL AND module_key IS NULL AND action IS NULL AND extension_id IS NULL AND connection_id IS NULL AND pipeline_id IS NULL
    WHEN 'provider_connection' THEN connection_id IS NOT NULL AND (node_id IS NULL) <> (hub_id IS NULL) AND module_key IS NULL AND action IS NULL AND extension_id IS NULL AND job IS NULL AND pipeline_id IS NULL
    WHEN 'pipeline' THEN pipeline_id IS NOT NULL AND hub_id IS NOT NULL AND node_id IS NULL AND module_key IS NULL AND action IS NULL AND extension_id IS NULL AND connection_id IS NULL AND job IS NULL
    ELSE hub_id IS NOT NULL AND node_id IS NULL AND module_key IS NULL AND action IS NULL AND extension_id IS NULL AND connection_id IS NULL AND job IS NULL AND pipeline_id IS NULL END),
  CONSTRAINT kill_switch_release_shape CHECK ((state = 'released') = (released_at IS NOT NULL)
    AND (state = 'engaged' OR (released_by IS NOT NULL AND release_approval_id IS NOT NULL AND incident_note IS NOT NULL))
    AND (state = 'released' OR (released_by IS NULL AND release_approval_id IS NULL)))
);
CREATE UNIQUE INDEX kill_switch_one_engaged ON trustwork.kill_switch (scope_kind, coalesce(node_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(hub_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(module_key, ''), coalesce(action, ''), coalesce(extension_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(connection_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(job, ''), coalesce(pipeline_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE state = 'engaged';
CREATE TRIGGER kill_switch_touch BEFORE UPDATE ON trustwork.kill_switch FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

CREATE FUNCTION trustwork.admin_kill_switch_release_digest(p_kill_switch uuid, p_incident_note text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.admin_digest(jsonb_build_object('action', 'kill_switch.release', 'killSwitchId', p_kill_switch::text, 'incidentNote', p_incident_note))
$$;
-- Which permissions engage or release a switch of this kind.
CREATE FUNCTION trustwork.admin_kill_switch_permissions(p_scope_kind text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN p_scope_kind IN ('hub_agent_dispatch', 'agent_module', 'agent_action', 'agent_extension', 'external_agent_api') THEN ARRAY['admin.agents.kill']
    WHEN p_scope_kind = 'pipeline' THEN ARRAY['admin.pipelines.pause', 'admin.providers.kill']
    ELSE ARRAY['admin.providers.kill'] END::text[]
$$;

CREATE FUNCTION trustwork.admin_kill_switch_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_approval trustwork.second_person_approval%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'kill switches are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'engaged' OR NEW.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'a kill switch is born engaged' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
    END IF;
    NEW.engaged_at := now();
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.scope_kind, NEW.node_id, NEW.hub_id, NEW.module_key, NEW.action, NEW.extension_id, NEW.connection_id, NEW.job, NEW.pipeline_id, NEW.engaged_by, NEW.engaged_at, NEW.reason)
     IS DISTINCT FROM ROW(OLD.id, OLD.scope_kind, OLD.node_id, OLD.hub_id, OLD.module_key, OLD.action, OLD.extension_id, OLD.connection_id, OLD.job, OLD.pipeline_id, OLD.engaged_by, OLD.engaged_at, OLD.reason)
     OR (OLD.incident_id IS NOT NULL AND NEW.incident_id IS DISTINCT FROM OLD.incident_id) THEN
    RAISE EXCEPTION 'a kill switch keeps its target' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  IF OLD.state = 'released' THEN
    RAISE EXCEPTION 'a released switch is final; engage a new one' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  IF NEW.state = 'released' THEN
    SELECT * INTO v_approval FROM trustwork.second_person_approval WHERE id = NEW.release_approval_id;
    IF NOT FOUND OR v_approval.action <> 'kill_switch.release' OR v_approval.status <> 'consumed' OR v_approval.consumed_ref IS DISTINCT FROM NEW.id
       OR v_approval.requested_by IS DISTINCT FROM NEW.released_by OR v_approval.action_digest <> trustwork.admin_kill_switch_release_digest(NEW.id, NEW.incident_note) THEN
      RAISE EXCEPTION 'releasing needs the consumed second-person approval of exactly this release' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_mismatch';
    END IF;
    NEW.released_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER kill_switch_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.kill_switch FOR EACH ROW EXECUTE FUNCTION trustwork.admin_kill_switch_guard();

-- 8. Commands (SECURITY DEFINER, allowlisted) ----------------------------------------------------------------------------
-- Any identified person reports content (participant path, no elevation).
CREATE FUNCTION trustwork.admin_report_content(p_hub uuid, p_target_kind text, p_target_id uuid, p_clause_code text, p_text text) RETURNS trustwork.moderation_report
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.moderation_report%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM trustwork.hub h WHERE h.id = p_hub AND h.lifecycle NOT IN ('draft', 'preparing', 'closed')) THEN
    RAISE EXCEPTION 'no such hub' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  INSERT INTO trustwork.moderation_report (hub_id, reporter_person_id, target_kind, target_id, clause_code, text)
  VALUES (p_hub, trustwork.admin_require_caller(), p_target_kind, p_target_id, p_clause_code, p_text) RETURNING * INTO v_row;
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.admin_open_moderation_case(p_ctx jsonb, p_hub uuid, p_target_kind text, p_target_id uuid, p_subject_person uuid, p_subject_company uuid,
  p_report_ids uuid[], p_clause_codes text[], p_emergency_hold boolean DEFAULT false) RETURNS trustwork.moderation_case
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.admin_authorize(p_ctx, CASE WHEN p_emergency_hold THEN ARRAY['admin.moderation.emergency.hold'] ELSE ARRAY['admin.moderation.case.open'] END, NULL, p_hub);
  v_row trustwork.moderation_case%ROWTYPE;
BEGIN
  IF trustwork.admin_conflicted(v_actor.person_id, p_subject_person, p_subject_company) THEN
    RAISE EXCEPTION 'staff never moderate their own content, employer or declared parties' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.conflict_of_interest';
  END IF;
  INSERT INTO trustwork.moderation_case (hub_id, target_kind, target_id, subject_person_id, subject_company_id, report_ids, clause_codes, emergency_hold, opened_by)
  VALUES (p_hub, p_target_kind, p_target_id, p_subject_person, p_subject_company, coalesce(p_report_ids, '{}'), p_clause_codes, p_emergency_hold, v_actor.person_id) RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'moderation.case_open', 'moderation_case', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Decide (admin.moderation.decide) without a conflict; the reporter's identity never enters the case row.
CREATE FUNCTION trustwork.admin_decide_moderation_case(p_ctx jsonb, p_case_id uuid, p_decision text) RETURNS trustwork.moderation_case
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.moderation_case%ROWTYPE;
  v_row trustwork.moderation_case%ROWTYPE;
  v_actor trustwork.admin_actor;
BEGIN
  SELECT * INTO v_before FROM trustwork.moderation_case WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such case' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.moderation.decide'], NULL, v_before.hub_id);
  IF trustwork.admin_conflicted(v_actor.person_id, v_before.subject_person_id, v_before.subject_company_id) THEN
    RAISE EXCEPTION 'staff never moderate their own content, employer or declared parties' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.conflict_of_interest';
  END IF;
  IF v_before.status NOT IN ('open', 'in_review') THEN
    RAISE EXCEPTION 'the case is already %', v_before.status USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  IF p_decision = 'sanction' AND v_before.subject_person_id IS NULL AND v_before.subject_company_id IS NULL THEN
    RAISE EXCEPTION 'a sanction decision names the subject' USING ERRCODE = 'check_violation', HINT = 'admin.case_mismatch';
  END IF;
  UPDATE trustwork.moderation_case SET status = 'decided', decision = p_decision, decision_reason = p_ctx ->> 'reasonText', decided_by = v_actor.person_id, decided_at = now()
   WHERE id = p_case_id RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'moderation.decide', 'moderation_case', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Apply a sanction after a sanction decision. Levels 3 and 4 need admin.moderation.decide through a role other than
-- moderator (moderators: levels 1-2); level 4 consumes the approval of exactly this sanction (admin_sanction_digest).
CREATE FUNCTION trustwork.admin_apply_sanction(p_ctx jsonb, p_case_id uuid, p_level integer, p_feature_scope text, p_duration interval, p_approval_id uuid DEFAULT NULL)
RETURNS trustwork.sanction
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_case trustwork.moderation_case%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_id uuid := trustwork.new_uuid();
  v_seconds bigint := CASE WHEN p_duration IS NULL THEN NULL ELSE round(extract(epoch FROM p_duration))::bigint END;
  v_approval trustwork.second_person_approval%ROWTYPE;
  v_row trustwork.sanction%ROWTYPE;
BEGIN
  SELECT * INTO v_case FROM trustwork.moderation_case WHERE id = p_case_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such case' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.moderation.decide'], NULL, v_case.hub_id);
  IF trustwork.admin_conflicted(v_actor.person_id, v_case.subject_person_id, v_case.subject_company_id) THEN
    RAISE EXCEPTION 'staff never sanction themselves, their employer or declared parties' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.conflict_of_interest';
  END IF;
  IF p_level >= 3 AND NOT EXISTS (
    SELECT 1 FROM trustwork.staff_role_assignment a JOIN trustwork.staff_role_definition_version d ON d.role = a.role AND d.version = a.definition_version
    WHERE a.person_id = v_actor.person_id AND a.role <> 'moderator' AND a.revoked_at IS NULL AND a.valid_from <= now() AND (a.valid_until IS NULL OR a.valid_until > now())
      AND 'admin.moderation.decide' = ANY (d.permissions) AND a.scope_kind = ANY (d.scopes)
      AND CASE a.scope_kind WHEN 'platform' THEN true WHEN 'node' THEN true ELSE a.hub_id = v_case.hub_id END) THEN
    RAISE EXCEPTION 'moderators apply levels 1 and 2 only' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.sanction_level_not_allowed';
  END IF;
  IF p_level = 4 THEN
    IF p_approval_id IS NULL THEN
      RAISE EXCEPTION 'level 4 needs a second person' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_required';
    END IF;
    v_approval := trustwork.admin_consume_approval(p_approval_id, 'moderation.apply_sanction_l4', 'hub', NULL, v_case.hub_id,
      trustwork.admin_sanction_digest(p_case_id, v_case.subject_person_id, v_case.subject_company_id, p_level, p_feature_scope, v_seconds), v_id);
  END IF;
  INSERT INTO trustwork.sanction (id, hub_id, subject_person_id, subject_company_id, level, feature_scope, starts_at, ends_at, moderation_case_id, decided_by, second_approval_id, reason)
  VALUES (v_id, v_case.hub_id, v_case.subject_person_id, v_case.subject_company_id, p_level, p_feature_scope, now(),
    CASE WHEN v_seconds IS NULL THEN NULL ELSE now() + make_interval(secs => v_seconds) END, p_case_id, v_actor.person_id, v_approval.id, p_ctx ->> 'reasonText')
  RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_case.hub_id, CASE WHEN p_level = 4 THEN 'moderation.apply_sanction_l4' ELSE 'moderation.apply_sanction' END,
    'sanction', v_row.id, NULL, to_jsonb(v_row), NULL, v_approval.id);
  RETURN v_row;
END $$;

-- The subject appeals a sanction or a moderation decision about them (or their employer, with company.members.manage).
CREATE FUNCTION trustwork.admin_file_appeal(p_subject_kind text, p_subject_id uuid, p_reason text) RETURNS trustwork.appeal
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.admin_require_caller();
  v_company uuid := trustwork.current_company_id();
  v_hub uuid;
  v_subject_person uuid;
  v_subject_company uuid;
  v_decider uuid;
  v_case uuid;
  v_row trustwork.appeal%ROWTYPE;
BEGIN
  IF p_subject_kind = 'sanction' THEN
    SELECT s.hub_id, s.subject_person_id, s.subject_company_id, s.decided_by, s.moderation_case_id INTO v_hub, v_subject_person, v_subject_company, v_decider, v_case
      FROM trustwork.sanction s WHERE s.id = p_subject_id AND s.lifted_at IS NULL;
  ELSIF p_subject_kind = 'moderation_case' THEN
    SELECT c.hub_id, c.subject_person_id, c.subject_company_id, c.decided_by, c.id INTO v_hub, v_subject_person, v_subject_company, v_decider, v_case
      FROM trustwork.moderation_case c WHERE c.id = p_subject_id AND c.status = 'decided';
  ELSE
    RAISE EXCEPTION 'appeals on % are filed by their owning module', p_subject_kind USING ERRCODE = 'feature_not_supported', HINT = 'admin.appeal_kind_not_supported';
  END IF;
  IF v_hub IS NULL OR NOT ((v_subject_person = v_person) OR (v_subject_company IS NOT NULL AND v_subject_company = v_company AND trustwork.current_membership_has('company.members.manage'))) THEN
    RAISE EXCEPTION 'no such decision about the caller' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  INSERT INTO trustwork.appeal (hub_id, subject_kind, subject_id, appellant_person_id, appellant_company_id, reason, original_decided_by)
  VALUES (v_hub, p_subject_kind, p_subject_id, v_person, v_subject_company, p_reason, v_decider) RETURNING * INTO v_row;
  UPDATE trustwork.moderation_case SET status = 'appealed' WHERE id = v_case AND status = 'decided';
  RETURN v_row;
END $$;

-- Decide an appeal: a different person than the original decider (and than the appellant), without a conflict.
-- Overturning a sanction lifts it.
CREATE FUNCTION trustwork.admin_decide_appeal(p_ctx jsonb, p_appeal_id uuid, p_decision text) RETURNS trustwork.appeal
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.appeal%ROWTYPE;
  v_row trustwork.appeal%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_case uuid;
BEGIN
  SELECT * INTO v_before FROM trustwork.appeal WHERE id = p_appeal_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such appeal' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, CASE WHEN v_before.subject_kind IN ('sanction', 'moderation_case') THEN ARRAY['admin.moderation.appeal.decide']
    ELSE ARRAY['admin.trust.appeals.decide'] END, NULL, v_before.hub_id);
  IF v_actor.person_id = v_before.original_decided_by THEN
    RAISE EXCEPTION 'an appeal is decided by someone other than the original decider' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.same_decider';
  END IF;
  IF trustwork.admin_conflicted(v_actor.person_id, v_before.appellant_person_id, v_before.appellant_company_id) THEN
    RAISE EXCEPTION 'staff never decide their own, their employer''s or declared parties'' appeals' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.conflict_of_interest';
  END IF;
  IF v_before.status NOT IN ('submitted', 'in_review') THEN
    RAISE EXCEPTION 'the appeal is already %', v_before.status USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  IF p_decision NOT IN ('upheld', 'overturned', 'partially_overturned') THEN
    RAISE EXCEPTION 'decision is upheld, overturned or partially_overturned' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.context_invalid';
  END IF;
  UPDATE trustwork.appeal SET status = p_decision, decided_by = v_actor.person_id, decided_at = now(), decision_reason = p_ctx ->> 'reasonText'
   WHERE id = p_appeal_id RETURNING * INTO v_row;
  IF v_row.subject_kind = 'sanction' THEN
    IF p_decision = 'overturned' THEN
      UPDATE trustwork.sanction SET lifted_at = now(), lifted_by = v_actor.person_id, lift_reason = 'appeal overturned' WHERE id = v_row.subject_id AND lifted_at IS NULL;
    END IF;
    SELECT moderation_case_id INTO v_case FROM trustwork.sanction WHERE id = v_row.subject_id;
  ELSIF v_row.subject_kind = 'moderation_case' THEN
    v_case := v_row.subject_id;
  END IF;
  UPDATE trustwork.moderation_case SET status = 'appeal_decided' WHERE id = v_case AND status = 'appealed';
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'appeal.decide', 'appeal', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Lift a sanction outside an appeal (admin.moderation.appeal.decide), never by its original decider.
CREATE FUNCTION trustwork.admin_lift_sanction(p_ctx jsonb, p_sanction_id uuid) RETURNS trustwork.sanction
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.sanction%ROWTYPE;
  v_row trustwork.sanction%ROWTYPE;
  v_actor trustwork.admin_actor;
BEGIN
  SELECT * INTO v_before FROM trustwork.sanction WHERE id = p_sanction_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such sanction' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.moderation.appeal.decide'], NULL, v_before.hub_id);
  IF v_actor.person_id = v_before.decided_by THEN
    RAISE EXCEPTION 'the original decider does not lift their own sanction' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.same_decider';
  END IF;
  UPDATE trustwork.sanction SET lifted_at = now(), lifted_by = v_actor.person_id, lift_reason = p_ctx ->> 'reasonText' WHERE id = p_sanction_id RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'moderation.lift_sanction', 'sanction', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Feature flags (admin.flags.edit at the node or hub): create or change value, description, effect and expiry.
CREATE FUNCTION trustwork.admin_set_feature_flag(p_ctx jsonb, p_node uuid, p_hub uuid, p_key text, p_value jsonb, p_description text, p_declared_effect text, p_expires_at timestamptz)
RETURNS trustwork.feature_flag
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_node uuid := CASE WHEN p_hub IS NULL THEN p_node END;
  v_actor trustwork.admin_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.flags.edit'], v_node, p_hub);
  v_before trustwork.feature_flag%ROWTYPE;
  v_row trustwork.feature_flag%ROWTYPE;
BEGIN
  SELECT * INTO v_before FROM trustwork.feature_flag f WHERE f.key = p_key AND f.node_id IS NOT DISTINCT FROM v_node AND f.hub_id IS NOT DISTINCT FROM p_hub FOR UPDATE;
  IF FOUND THEN
    UPDATE trustwork.feature_flag SET value = p_value, description = p_description, declared_effect = p_declared_effect, expires_at = p_expires_at, changed_by = v_actor.person_id
     WHERE id = v_before.id RETURNING * INTO v_row;
  ELSE
    INSERT INTO trustwork.feature_flag (key, scope_kind, node_id, hub_id, value, description, declared_effect, owner_person_id, expires_at, changed_by)
    VALUES (p_key, CASE WHEN p_hub IS NULL THEN 'node' ELSE 'hub' END, v_node, p_hub, p_value, p_description, p_declared_effect, v_actor.person_id, p_expires_at, v_actor.person_id)
    RETURNING * INTO v_row;
  END IF;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_node, p_hub, 'flags.set', 'feature_flag', v_row.id, CASE WHEN v_before.id IS NULL THEN NULL ELSE to_jsonb(v_before) END, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Maintenance windows (admin.config.maintenance).
CREATE FUNCTION trustwork.admin_schedule_maintenance(p_ctx jsonb, p_node uuid, p_hub uuid, p_starts_at timestamptz, p_ends_at timestamptz, p_read_only boolean DEFAULT true)
RETURNS trustwork.maintenance_window
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_node uuid := CASE WHEN p_hub IS NULL THEN p_node END;
  v_actor trustwork.admin_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.config.maintenance'], v_node, p_hub);
  v_row trustwork.maintenance_window%ROWTYPE;
BEGIN
  INSERT INTO trustwork.maintenance_window (scope_kind, node_id, hub_id, starts_at, ends_at, reason, read_only, created_by)
  VALUES (CASE WHEN p_hub IS NULL THEN 'node' ELSE 'hub' END, v_node, p_hub, p_starts_at, p_ends_at, p_ctx ->> 'reasonText', p_read_only, v_actor.person_id) RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_node, p_hub, 'maintenance.schedule', 'maintenance_window', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;
CREATE FUNCTION trustwork.admin_cancel_maintenance(p_ctx jsonb, p_window_id uuid) RETURNS trustwork.maintenance_window
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.maintenance_window%ROWTYPE;
  v_row trustwork.maintenance_window%ROWTYPE;
  v_actor trustwork.admin_actor;
BEGIN
  SELECT * INTO v_before FROM trustwork.maintenance_window WHERE id = p_window_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such window' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.config.maintenance'], v_before.node_id, v_before.hub_id);
  UPDATE trustwork.maintenance_window SET cancelled_at = now(), cancelled_by = v_actor.person_id WHERE id = p_window_id RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_row.node_id, v_row.hub_id, 'maintenance.cancel', 'maintenance_window', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Engage a kill switch: immediate, one person. p_target: {"moduleKey","action","extensionId","connectionId","job","pipelineId"} as the kind needs.
CREATE FUNCTION trustwork.admin_engage_kill_switch(p_ctx jsonb, p_scope_kind text, p_node uuid, p_hub uuid, p_target jsonb, p_incident uuid DEFAULT NULL)
RETURNS trustwork.kill_switch
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_node uuid := CASE WHEN p_hub IS NULL THEN p_node END;
  v_actor trustwork.admin_actor := trustwork.admin_authorize(p_ctx, trustwork.admin_kill_switch_permissions(p_scope_kind), v_node, p_hub);
  v_row trustwork.kill_switch%ROWTYPE;
BEGIN
  INSERT INTO trustwork.kill_switch (scope_kind, node_id, hub_id, module_key, action, extension_id, connection_id, job, pipeline_id, engaged_by, reason, incident_id)
  VALUES (p_scope_kind, v_node, p_hub, p_target ->> 'moduleKey', p_target ->> 'action', (p_target ->> 'extensionId')::uuid, (p_target ->> 'connectionId')::uuid,
    p_target ->> 'job', (p_target ->> 'pipelineId')::uuid, v_actor.person_id, p_ctx ->> 'reasonText', p_incident) RETURNING * INTO v_row;
  IF p_incident IS NOT NULL THEN
    UPDATE trustwork.incident SET linked_actions = linked_actions || jsonb_build_array(jsonb_build_object('kind', 'kill_switch', 'killSwitchId', v_row.id::text)) WHERE id = p_incident;
  END IF;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_node, p_hub, 'kill_switch.engage', 'kill_switch', v_row.id, NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;
-- Release: the releaser asked for the approval (kill_switch.release with admin_kill_switch_release_digest) and a
-- different person approved it.
CREATE FUNCTION trustwork.admin_release_kill_switch(p_ctx jsonb, p_kill_switch_id uuid, p_approval_id uuid, p_incident_note text) RETURNS trustwork.kill_switch
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.kill_switch%ROWTYPE;
  v_row trustwork.kill_switch%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_approval trustwork.second_person_approval%ROWTYPE;
BEGIN
  SELECT * INTO v_before FROM trustwork.kill_switch WHERE id = p_kill_switch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such kill switch' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, trustwork.admin_kill_switch_permissions(v_before.scope_kind), v_before.node_id, v_before.hub_id);
  IF v_before.state <> 'engaged' THEN
    RAISE EXCEPTION 'already released' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  v_approval := trustwork.admin_consume_approval(p_approval_id, 'kill_switch.release', trustwork.admin_scope_kind(v_before.node_id, v_before.hub_id), v_before.node_id, v_before.hub_id,
    trustwork.admin_kill_switch_release_digest(p_kill_switch_id, p_incident_note), p_kill_switch_id);
  UPDATE trustwork.kill_switch SET state = 'released', released_by = v_actor.person_id, release_approval_id = v_approval.id, incident_note = p_incident_note
   WHERE id = p_kill_switch_id RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_row.node_id, v_row.hub_id, 'kill_switch.release', 'kill_switch', v_row.id, to_jsonb(v_before), to_jsonb(v_row), NULL, v_approval.id);
  RETURN v_row;
END $$;

-- 9. Row-level security and grants -------------------------------------------------------------------------------------
ALTER TABLE trustwork.moderation_report ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.moderation_report FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.moderation_case ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.moderation_case FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.sanction ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.sanction FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.appeal ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.appeal FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.feature_flag ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.feature_flag FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.maintenance_window ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.maintenance_window FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.kill_switch ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.kill_switch FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.moderation_report AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.moderation_case AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.sanction AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.appeal AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.feature_flag AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.maintenance_window AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.kill_switch AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

-- Reporters see their reports; staff with admin.moderation.read see the hub's. The reported party never sees a report.
CREATE POLICY moderation_report_read ON trustwork.moderation_report FOR SELECT TO trustwork_app
  USING (reporter_person_id = trustwork.current_person_id() OR trustwork.admin_has_permission('admin.moderation.read', NULL, hub_id));
-- The subject sees the case and its reasons (report ids carry no reporter identity).
CREATE POLICY moderation_case_read ON trustwork.moderation_case FOR SELECT TO trustwork_app
  USING (subject_person_id = trustwork.current_person_id() OR (subject_company_id IS NOT NULL AND subject_company_id = trustwork.current_company_id())
         OR trustwork.admin_has_permission('admin.moderation.read', NULL, hub_id));
CREATE POLICY sanction_read ON trustwork.sanction FOR SELECT TO trustwork_app
  USING (subject_person_id = trustwork.current_person_id() OR (subject_company_id IS NOT NULL AND subject_company_id = trustwork.current_company_id())
         OR trustwork.admin_has_permission('admin.moderation.read', NULL, hub_id));
CREATE POLICY appeal_read ON trustwork.appeal FOR SELECT TO trustwork_app
  USING (appellant_person_id = trustwork.current_person_id() OR (appellant_company_id IS NOT NULL AND appellant_company_id = trustwork.current_company_id())
         OR trustwork.admin_has_any_permission(ARRAY['admin.moderation.read', 'admin.moderation.appeal.decide', 'admin.trust.appeals.decide'], NULL, hub_id));
-- Banner and enforcement state: flags, windows and switches carry no personal or private data; every runtime reads them.
CREATE POLICY feature_flag_read ON trustwork.feature_flag FOR SELECT TO trustwork_app USING (true);
CREATE POLICY maintenance_window_read ON trustwork.maintenance_window FOR SELECT TO trustwork_app USING (true);
CREATE POLICY kill_switch_read ON trustwork.kill_switch FOR SELECT TO trustwork_app USING (true);
-- Workers honour kill switches, windows and flags (pipelines pause, outbound messages stop).
CREATE POLICY feature_flag_worker_read ON trustwork.feature_flag FOR SELECT TO trustwork_worker USING (true);
CREATE POLICY maintenance_window_worker_read ON trustwork.maintenance_window FOR SELECT TO trustwork_worker USING (true);
CREATE POLICY kill_switch_worker_read ON trustwork.kill_switch FOR SELECT TO trustwork_worker USING (true);

GRANT SELECT ON trustwork.moderation_report, trustwork.moderation_case, trustwork.sanction, trustwork.appeal, trustwork.feature_flag, trustwork.maintenance_window,
  trustwork.kill_switch TO trustwork_app;
GRANT SELECT ON trustwork.feature_flag, trustwork.maintenance_window, trustwork.kill_switch TO trustwork_worker;

GRANT EXECUTE ON FUNCTION trustwork.admin_sanction_digest(uuid, uuid, uuid, integer, text, bigint), trustwork.admin_kill_switch_release_digest(uuid, text),
  trustwork.admin_kill_switch_permissions(text),
  trustwork.admin_report_content(uuid, text, uuid, text, text), trustwork.admin_open_moderation_case(jsonb, uuid, text, uuid, uuid, uuid, uuid[], text[], boolean),
  trustwork.admin_decide_moderation_case(jsonb, uuid, text), trustwork.admin_apply_sanction(jsonb, uuid, integer, text, interval, uuid),
  trustwork.admin_file_appeal(text, uuid, text), trustwork.admin_decide_appeal(jsonb, uuid, text), trustwork.admin_lift_sanction(jsonb, uuid),
  trustwork.admin_set_feature_flag(jsonb, uuid, uuid, text, jsonb, text, text, timestamptz),
  trustwork.admin_schedule_maintenance(jsonb, uuid, uuid, timestamptz, timestamptz, boolean), trustwork.admin_cancel_maintenance(jsonb, uuid),
  trustwork.admin_engage_kill_switch(jsonb, text, uuid, uuid, jsonb, uuid), trustwork.admin_release_kill_switch(jsonb, uuid, uuid, text)
  TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
