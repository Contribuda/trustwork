-- SUP-001: the support workspace without impersonation (docs/engine/hub-console/support.md; contracts
-- SupportAccountSummarySchema, AccountServiceActionSchema, ACCOUNT_SERVICE_ACTIONS and COOLING_OFF_ACTIONS in hub.ts).
-- Builds on DATA-002 (support cases, case access grants, second-person approvals, the staff audit) and BE-004 (the
-- support reset of a second factor).
--
-- 1. support_access_record: every support read that needs no case grant (lookup, account card, access explainer) is
--    recorded with the case it serves. Append-only. The subject sees that support looked, when and why, never who.
-- 2. account_service_action: servicing actions on a person's account, always inside an open support case, never on the
--    staff member's own account, employer or a declared party. Actions that change how someone signs in
--    (rebind_recovery_email, reset_second_factor) carry evidence, a second-person approval bound to the exact request
--    digest (second_person_approval, actions support.rebind_recovery_email and support.reset_second_factor) and a
--    cooling-off of at least 72 hours on the database clock, during which the subject, the requester or the approver
--    may cancel. The other actions apply at once. No action issues a session or acts as the subject.
-- 3. support_diagnostic_snapshot: diagnostics a requester shares from their own session into their own case: page id,
--    versions, feature flags, error codes, request ids and only the objects they select (references, never content).
--
-- Every staff command is a SECURITY DEFINER function that checks the caller's live elevation and the permission at the
-- case's hub (DATA-002 admin_authorize) and writes the admin_audit_event row in the same transaction.

-- 0. Vocabulary ------------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.support_service_actions() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['resend_verification', 'unlock_after_lockout', 'revoke_all_sessions', 'require_password_reset', 'rebind_recovery_email', 'reset_second_factor',
    'start_data_export', 'open_deletion_request', 'send_guided_task']::text[]
$$;
CREATE FUNCTION trustwork.support_cooling_off_actions() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['rebind_recovery_email', 'reset_second_factor']::text[]
$$;
-- The permission that requests (and, for the cooling-off actions, approves and executes) each servicing action.
CREATE FUNCTION trustwork.support_action_permission(p_action text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_action
    WHEN 'resend_verification' THEN 'admin.support.notifications'
    WHEN 'unlock_after_lockout' THEN 'admin.support.diagnose'
    WHEN 'revoke_all_sessions' THEN 'admin.support.sessions.revoke'
    WHEN 'require_password_reset' THEN 'admin.support.sessions.revoke'
    WHEN 'rebind_recovery_email' THEN 'admin.support.recovery.rebind'
    WHEN 'reset_second_factor' THEN 'admin.support.second_factor.reset'
    WHEN 'start_data_export' THEN 'admin.support.case.create'
    WHEN 'open_deletion_request' THEN 'admin.support.case.create'
    WHEN 'send_guided_task' THEN 'admin.support.notifications'
    END
$$;
-- Every permission that makes someone support staff of a hub for the reads below.
CREATE FUNCTION trustwork.support_staff_permissions() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT trustwork.admin_support_permissions() || ARRAY['admin.support.sessions.revoke', 'admin.support.second_factor.reset', 'admin.support.recovery.rebind']::text[]
$$;
-- sy***@example.org: at most two leading characters of the local part, then a fixed mask.
CREATE FUNCTION trustwork.support_mask_email(p_email text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN p_email IS NULL OR position('@' IN p_email) < 2 THEN NULL
    ELSE left(split_part(p_email, '@', 1), CASE WHEN length(split_part(p_email, '@', 1)) <= 2 THEN 1 ELSE 2 END) || '***@' || split_part(p_email, '@', 2) END
$$;

-- 1. Support access records (A) --------------------------------------------------------------------------------------
CREATE TABLE trustwork.support_access_record (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  at timestamptz NOT NULL DEFAULT now(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  actor_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  support_case_id uuid NULL REFERENCES trustwork.support_case (id),
  kind text NOT NULL CHECK (kind IN ('lookup', 'account_card', 'access_explainer')),
  subject_person_id uuid NULL REFERENCES trustwork.person (id) ON DELETE SET NULL,
  query_digest text NULL CHECK (query_digest ~ '^[a-f0-9]{64}$'),
  result_count integer NOT NULL DEFAULT 0 CHECK (result_count >= 0),
  CONSTRAINT support_access_record_case CHECK (kind = 'lookup' OR support_case_id IS NOT NULL)
);
CREATE INDEX support_access_record_subject_idx ON trustwork.support_access_record (subject_person_id, at) WHERE subject_person_id IS NOT NULL;
CREATE INDEX support_access_record_case_idx ON trustwork.support_access_record (support_case_id) WHERE support_case_id IS NOT NULL;
CREATE TRIGGER support_access_record_append_only BEFORE UPDATE OR DELETE ON trustwork.support_access_record FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 2. Account servicing actions ---------------------------------------------------------------------------------------
CREATE TABLE trustwork.account_service_action (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  support_case_id uuid NOT NULL REFERENCES trustwork.support_case (id),
  subject_person_id uuid NOT NULL REFERENCES trustwork.person (id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action = ANY (trustwork.support_service_actions())),
  requested_by uuid NOT NULL REFERENCES trustwork.person (id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  evidence_refs uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(evidence_refs) <= 10 AND array_position(evidence_refs, NULL) IS NULL AND trustwork.admin_distinct(evidence_refs)),
  request_digest text NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  approval_id uuid NULL UNIQUE REFERENCES trustwork.second_person_approval (id),
  approved_by uuid NULL REFERENCES trustwork.person (id),
  approved_at timestamptz NULL,
  effective_at timestamptz NOT NULL,
  subject_notified boolean NOT NULL DEFAULT true CHECK (subject_notified),
  state text NOT NULL CHECK (state IN ('pending', 'cooling_off', 'done', 'cancelled')),
  -- Rebind only: the address the subject will prove; never selectable by the runtime role (masked by the views below).
  new_email_normalized text NULL CHECK (new_email_normalized = lower(new_email_normalized) AND length(new_email_normalized) BETWEEN 3 AND 254 AND position('@' IN new_email_normalized) > 1),
  guided_task text NULL CHECK (guided_task ~ '^[a-z][a-z0-9_]{1,60}$'),
  second_factor_reset_id uuid NULL UNIQUE REFERENCES trustwork.second_factor_reset (id) ON DELETE SET NULL,
  cancelled_by uuid NULL REFERENCES trustwork.person (id),
  cancelled_at timestamptz NULL,
  executed_by uuid NULL REFERENCES trustwork.person (id),
  executed_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_service_action_not_own_account CHECK (requested_by <> subject_person_id),
  CONSTRAINT account_service_action_second_person CHECK (approved_by IS NULL OR (approved_by <> requested_by AND approved_by <> subject_person_id)),
  CONSTRAINT account_service_action_approval_shape CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CONSTRAINT account_service_action_cooling_off CHECK (CASE WHEN action = ANY (trustwork.support_cooling_off_actions()) THEN
      cardinality(evidence_refs) >= 1 AND request_digest IS NOT NULL AND approval_id IS NOT NULL
      AND effective_at >= requested_at + interval '72 hours'
      AND (approved_at IS NULL OR effective_at >= approved_at + interval '72 hours')
      AND (state IN ('pending', 'cancelled') OR approved_by IS NOT NULL)
      AND (state <> 'pending' OR approved_by IS NULL)
    ELSE approval_id IS NULL AND approved_by IS NULL AND request_digest IS NULL AND state <> 'cooling_off' END),
  CONSTRAINT account_service_action_rebind_address CHECK ((action = 'rebind_recovery_email') = (new_email_normalized IS NOT NULL)),
  CONSTRAINT account_service_action_guided_task CHECK ((action = 'send_guided_task') = (guided_task IS NOT NULL)),
  CONSTRAINT account_service_action_done_shape CHECK ((state = 'done') = (executed_at IS NOT NULL) AND (executed_at IS NULL) = (executed_by IS NULL)
    AND (executed_at IS NULL OR executed_at >= effective_at)),
  CONSTRAINT account_service_action_cancel_shape CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL) AND (cancelled_at IS NULL) = (cancelled_by IS NULL))
);
CREATE INDEX account_service_action_case_idx ON trustwork.account_service_action (support_case_id, requested_at);
CREATE INDEX account_service_action_subject_idx ON trustwork.account_service_action (subject_person_id, requested_at);
-- One open sign-in factor change of each kind per person.
CREATE UNIQUE INDEX account_service_action_one_open ON trustwork.account_service_action (subject_person_id, action)
  WHERE state IN ('pending', 'cooling_off') AND action IN ('rebind_recovery_email', 'reset_second_factor');
CREATE TRIGGER account_service_action_touch BEFORE UPDATE ON trustwork.account_service_action FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

CREATE FUNCTION trustwork.support_action_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'servicing actions are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.requested_at := now();
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.hub_id, NEW.support_case_id, NEW.subject_person_id, NEW.action, NEW.requested_by, NEW.requested_at, NEW.reason, NEW.evidence_refs, NEW.request_digest,
         NEW.approval_id, NEW.new_email_normalized, NEW.guided_task)
     IS DISTINCT FROM ROW(OLD.id, OLD.hub_id, OLD.support_case_id, OLD.subject_person_id, OLD.action, OLD.requested_by, OLD.requested_at, OLD.reason, OLD.evidence_refs,
         OLD.request_digest, OLD.approval_id, OLD.new_email_normalized, OLD.guided_task) THEN
    RAISE EXCEPTION 'the requested action is immutable; request again' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  IF NEW.state = OLD.state THEN
    IF ROW(NEW.approved_by, NEW.approved_at, NEW.effective_at, NEW.cancelled_by, NEW.cancelled_at, NEW.executed_by, NEW.executed_at)
       IS DISTINCT FROM ROW(OLD.approved_by, OLD.approved_at, OLD.effective_at, OLD.cancelled_by, OLD.cancelled_at, OLD.executed_by, OLD.executed_at)
       OR (NEW.second_factor_reset_id IS NOT NULL AND NEW.second_factor_reset_id IS DISTINCT FROM OLD.second_factor_reset_id
           AND (OLD.second_factor_reset_id IS NOT NULL OR OLD.action <> 'reset_second_factor' OR OLD.state <> 'cooling_off')) THEN
      RAISE EXCEPTION 'decision columns change only with the state' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD.state = 'pending' AND NEW.state IN ('cooling_off', 'done', 'cancelled')) OR (OLD.state = 'cooling_off' AND NEW.state IN ('done', 'cancelled'))) THEN
    RAISE EXCEPTION 'servicing action % -> % is not allowed', OLD.state, NEW.state USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  IF NEW.state = 'cooling_off' THEN
    NEW.approved_at := now();
    NEW.effective_at := greatest(now(), OLD.requested_at) + interval '72 hours';
  ELSIF NEW.state = 'done' THEN
    NEW.executed_at := now();
    IF NOT (OLD.action = ANY (trustwork.support_cooling_off_actions())) THEN
      NEW.effective_at := now();
    ELSIF OLD.effective_at > now() THEN
      RAISE EXCEPTION 'the cooling-off period has not ended' USING ERRCODE = 'insufficient_privilege', HINT = 'support.cooling_off';
    END IF;
  ELSIF NEW.state = 'cancelled' THEN
    NEW.cancelled_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_service_action_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.account_service_action FOR EACH ROW EXECUTE FUNCTION trustwork.support_action_guard();

-- A BE-004 reset cancelled or executed through its own routes (the subject's security settings, the BE-004 staff
-- routes) ends the servicing action that created it, in the same transaction.
CREATE FUNCTION trustwork.support_reset_follow() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF NEW.state = 'cancelled' AND OLD.state <> 'cancelled' THEN
    UPDATE trustwork.account_service_action SET state = 'cancelled', cancelled_by = NEW.cancelled_by
     WHERE second_factor_reset_id = NEW.id AND state IN ('pending', 'cooling_off');
  ELSIF NEW.state = 'done' AND OLD.state <> 'done' THEN
    UPDATE trustwork.account_service_action SET state = 'done', executed_by = NEW.executed_by
     WHERE second_factor_reset_id = NEW.id AND state = 'cooling_off';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER second_factor_reset_support_follow AFTER UPDATE ON trustwork.second_factor_reset FOR EACH ROW EXECUTE FUNCTION trustwork.support_reset_follow();

-- 3. Diagnostic snapshots (A) ----------------------------------------------------------------------------------------
CREATE TABLE trustwork.support_diagnostic_snapshot (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  support_case_id uuid NOT NULL REFERENCES trustwork.support_case (id),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  shared_by uuid NOT NULL REFERENCES trustwork.person (id),
  page_id text NOT NULL CHECK (page_id ~ '^[a-z0-9][a-z0-9_./:-]{0,127}$'),
  app_version text NOT NULL CHECK (app_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'),
  locale text NULL CHECK (locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$'),
  feature_flags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(feature_flags) <= 50 AND trustwork.admin_all_match(feature_flags, '^[a-z][a-z0-9_.]{0,79}$')),
  error_codes text[] NOT NULL DEFAULT '{}' CHECK (cardinality(error_codes) <= 50 AND trustwork.admin_all_match(error_codes, '^[a-z][a-z0-9_.]{0,79}$')),
  request_ids text[] NOT NULL DEFAULT '{}' CHECK (cardinality(request_ids) <= 50 AND trustwork.admin_all_match(request_ids, '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')),
  objects jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(objects) = 'array' AND jsonb_array_length(objects) <= 20),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_diagnostic_snapshot_case_idx ON trustwork.support_diagnostic_snapshot (support_case_id, created_at);
CREATE TRIGGER support_diagnostic_snapshot_append_only BEFORE UPDATE OR DELETE ON trustwork.support_diagnostic_snapshot FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 4. Plumbing (invoker helpers, no grant) ----------------------------------------------------------------------------
-- The case a staff command serves: it exists, is open and belongs to the hub; the subject is the case's subject person
-- or its requester; the actor never handles their own account, employer or a declared party, nor a case they requested.
CREATE FUNCTION trustwork.support_staff_case(p_actor uuid, p_case uuid, p_subject uuid) RETURNS trustwork.support_case
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_case trustwork.support_case%ROWTYPE;
BEGIN
  SELECT * INTO v_case FROM trustwork.support_case WHERE id = p_case;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such case' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF v_case.status = 'closed' THEN
    RAISE EXCEPTION 'closed cases are final' USING ERRCODE = 'check_violation', HINT = 'admin.case_closed';
  END IF;
  IF p_subject IS NOT NULL AND p_subject IS DISTINCT FROM v_case.subject_person_id AND p_subject <> v_case.requester_person_id THEN
    RAISE EXCEPTION 'the person is not a party of this case' USING ERRCODE = 'check_violation', HINT = 'admin.case_mismatch';
  END IF;
  IF v_case.requester_person_id = p_actor OR p_subject = p_actor OR trustwork.admin_conflicted(p_actor, v_case.subject_person_id, v_case.subject_company_id)
     OR (p_subject IS NOT NULL AND trustwork.admin_conflicted(p_actor, p_subject, NULL)) THEN
    RAISE EXCEPTION 'staff never handle their own account, employer or declared parties' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.conflict_of_interest';
  END IF;
  RETURN v_case;
END $$;

-- The request digest a second person restates (trustwork-digest-1; evidence sorted; the new address only as a hash).
CREATE FUNCTION trustwork.support_action_digest(p_id uuid, p_case uuid, p_subject uuid, p_action text, p_evidence uuid[], p_new_email text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.admin_digest(jsonb_build_object(
    'action', 'support.' || p_action, 'serviceActionId', p_id::text, 'supportCaseId', p_case::text, 'subjectPersonId', p_subject::text,
    'evidenceRefs', coalesce((SELECT jsonb_agg(e ORDER BY e COLLATE "C") FROM (SELECT x::text AS e FROM unnest(p_evidence) x) s), '[]'::jsonb),
    'newEmailSha256', CASE WHEN p_new_email IS NULL THEN NULL ELSE encode(sha256(convert_to(p_new_email, 'UTF8')), 'hex') END))
$$;

CREATE FUNCTION trustwork.support_record_access(p_hub uuid, p_actor uuid, p_case uuid, p_kind text, p_subject uuid, p_query text, p_count integer) RETURNS void
LANGUAGE sql VOLATILE SET search_path = trustwork, pg_temp AS $$
  INSERT INTO trustwork.support_access_record (hub_id, actor_person_id, support_case_id, kind, subject_person_id, query_digest, result_count)
  VALUES (p_hub, p_actor, p_case, p_kind, p_subject, CASE WHEN p_query IS NULL THEN NULL ELSE encode(sha256(convert_to(p_query, 'UTF8')), 'hex') END, coalesce(p_count, 0))
$$;

-- Revokes every session and elevation of a person (servicing actions; the sessions table keeps reason 'admin').
CREATE FUNCTION trustwork.support_end_sessions(p_person uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE trustwork.session_elevation SET revoked_at = now(), revoked_reason = 'session_ended' WHERE person_id = p_person AND revoked_at IS NULL;
  UPDATE trustwork.session SET revoked_at = now(), revoked_reason = 'admin' WHERE person_id = p_person AND revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- 5. Commands and reads (SECURITY DEFINER, allowlisted) --------------------------------------------------------------
-- Lookup (admin.support.account.read at the hub): exact e-mail, person or company id, legal identifier, or a name prefix
-- (names only inside a case). At most 20 results; recorded with the case and a hash of the query, never the query.
CREATE FUNCTION trustwork.support_lookup(p_ctx jsonb, p_hub uuid, p_case uuid, p_kind text, p_value text)
RETURNS TABLE (kind text, id uuid, display_name text)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.support.account.read'], NULL, p_hub);
  v_case trustwork.support_case%ROWTYPE;
  v_value text := btrim(coalesce(p_value, ''));
  v_pattern text;
  v_found jsonb;
BEGIN
  IF length(v_value) NOT BETWEEN 1 AND 254 THEN
    RAISE EXCEPTION 'a lookup needs a value' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.context_invalid';
  END IF;
  IF p_case IS NOT NULL THEN
    v_case := trustwork.support_staff_case(v_actor.person_id, p_case, NULL);
    IF v_case.hub_id <> p_hub THEN
      RAISE EXCEPTION 'no such case' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
    END IF;
  ELSIF p_kind IN ('name', 'company_name') THEN
    RAISE EXCEPTION 'a name search serves a support case' USING ERRCODE = 'check_violation', HINT = 'support.case_required';
  END IF;
  v_pattern := replace(replace(replace(v_value, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  IF p_kind = 'email' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('kind', 'person', 'id', p.id, 'name', p.display_name)), '[]') INTO v_found
      FROM trustwork.email_binding b JOIN trustwork.person p ON p.id = b.person_id WHERE b.email_normalized = lower(v_value);
  ELSIF p_kind = 'person_id' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('kind', 'person', 'id', p.id, 'name', p.display_name)), '[]') INTO v_found
      FROM trustwork.person p WHERE v_value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND p.id::text = v_value;
  ELSIF p_kind = 'company_id' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('kind', 'company', 'id', c.id, 'name', c.display_name)), '[]') INTO v_found
      FROM trustwork.company c WHERE v_value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND c.id::text = v_value;
  ELSIF p_kind = 'legal_identifier' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('kind', 'company', 'id', s.id, 'name', s.display_name)), '[]') INTO v_found FROM (
      SELECT c.id, c.display_name FROM trustwork.company c WHERE c.legal_identifiers @> jsonb_build_array(jsonb_build_object('value', v_value)) ORDER BY c.display_name, c.id LIMIT 20) s;
  ELSIF p_kind = 'name' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('kind', 'person', 'id', s.id, 'name', s.display_name)), '[]') INTO v_found FROM (
      SELECT p.id, p.display_name FROM trustwork.person p WHERE p.display_name ILIKE v_pattern ORDER BY p.display_name, p.id LIMIT 20) s;
  ELSIF p_kind = 'company_name' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('kind', 'company', 'id', s.id, 'name', s.display_name)), '[]') INTO v_found FROM (
      SELECT c.id, c.display_name FROM trustwork.company c WHERE c.display_name ILIKE v_pattern ORDER BY c.display_name, c.id LIMIT 20) s;
  ELSE
    RAISE EXCEPTION 'unknown lookup kind' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.context_invalid';
  END IF;
  PERFORM trustwork.support_record_access(p_hub, v_actor.person_id, p_case, 'lookup', NULL, p_kind || ':' || lower(v_value), jsonb_array_length(v_found));
  RETURN QUERY SELECT e ->> 'kind', (e ->> 'id')::uuid, e ->> 'name' FROM jsonb_array_elements(v_found) e;
END $$;

-- The diagnostic account card (admin.support.account.read): the allowlist of SupportAccountSummarySchema, built here so
-- no address, token, IP, device, secret or private object ever leaves the database (entitlements come from billing). Lockout facts come from the API
-- configuration (threshold and window). Recorded with the case.
CREATE FUNCTION trustwork.support_account_card(p_ctx jsonb, p_case uuid, p_person uuid, p_lock_threshold integer, p_lock_window interval) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.admin_require_caller();
  v_hub uuid := (SELECT c.hub_id FROM trustwork.support_case c WHERE c.id = p_case);
  v_actor trustwork.admin_actor;
  v_case trustwork.support_case%ROWTYPE;
  v_subject trustwork.person%ROWTYPE;
  v_email text;
  v_verified boolean;
  v_state text;
  v_failures integer;
  v_recovery text;
BEGIN
  IF v_hub IS NULL THEN
    RAISE EXCEPTION 'no such case' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.support.account.read'], NULL, v_hub);
  v_case := trustwork.support_staff_case(v_person, p_case, p_person);
  SELECT * INTO v_subject FROM trustwork.person WHERE id = p_person;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such person' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  SELECT b.email_normalized INTO v_email FROM trustwork.email_binding b WHERE b.person_id = p_person ORDER BY b.is_primary DESC, b.verified_at IS NULL, b.created_at LIMIT 1;
  v_verified := EXISTS (SELECT 1 FROM trustwork.email_binding b WHERE b.person_id = p_person AND b.email_normalized = v_email AND b.verified_at IS NOT NULL);
  SELECT count(*)::integer INTO v_failures FROM trustwork.login_failure f JOIN trustwork.email_binding b ON f.subject_hash = sha256(convert_to('account:' || b.email_normalized, 'UTF8'))
   WHERE b.person_id = p_person AND f.occurred_at >= now() - p_lock_window;
  v_state := CASE
    WHEN EXISTS (SELECT 1 FROM trustwork.sanction s WHERE s.subject_person_id = p_person AND s.level >= 3 AND s.lifted_at IS NULL AND s.starts_at <= now() AND (s.ends_at IS NULL OR s.ends_at > now())) THEN 'suspended'
    WHEN v_failures >= p_lock_threshold THEN 'locked'
    WHEN NOT EXISTS (SELECT 1 FROM trustwork.email_binding b WHERE b.person_id = p_person AND b.verified_at IS NOT NULL) THEN 'pending_verification'
    ELSE 'active' END;
  v_recovery := CASE
    WHEN EXISTS (SELECT 1 FROM trustwork.account_service_action a WHERE a.subject_person_id = p_person AND a.state = 'cooling_off')
      OR EXISTS (SELECT 1 FROM trustwork.second_factor_reset r WHERE r.subject_person_id = p_person AND r.state = 'cooling_off') THEN 'cooling_off'
    WHEN EXISTS (SELECT 1 FROM trustwork.account_service_action a WHERE a.subject_person_id = p_person AND a.state = 'pending' AND a.action = ANY (trustwork.support_cooling_off_actions()))
      OR EXISTS (SELECT 1 FROM trustwork.second_factor_reset r WHERE r.subject_person_id = p_person AND r.state = 'pending') THEN 'held_for_review'
    WHEN EXISTS (SELECT 1 FROM trustwork.auth_token t WHERE t.person_id = p_person AND t.kind = 'recovery' AND t.consumed_at IS NULL AND t.expires_at > now()) THEN 'requested'
    ELSE 'none' END;
  PERFORM trustwork.support_record_access(v_hub, v_person, p_case, 'account_card', p_person, NULL, 1);
  RETURN jsonb_build_object(
    'personId', v_subject.id,
    'displayName', v_subject.display_name,
    'maskedEmail', trustwork.support_mask_email(v_email),
    'emailVerified', coalesce(v_verified, false),
    'accountState', v_state,
    'secondFactor', (SELECT jsonb_build_object('enrolled', count(*) > 0, 'methods', least(count(*), 10)::integer) FROM trustwork.second_factor f WHERE f.person_id = p_person AND f.state = 'active'),
    'activeSessions', (SELECT count(*)::integer FROM trustwork.session s WHERE s.person_id = p_person AND s.revoked_at IS NULL AND s.idle_expires_at > now() AND s.absolute_expires_at > now()),
    'recovery', v_recovery,
    'employer', (SELECT jsonb_build_object('companyId', c.id, 'companyName', c.display_name, 'role', m.role) FROM trustwork.membership m JOIN trustwork.company c ON c.id = m.company_id
                  WHERE m.person_id = p_person AND m.status = 'active' ORDER BY m.valid_from DESC LIMIT 1),
    -- Entitlements are economic rights owned by billing; no module outside billing reads its tables (payment neutrality).
    -- The API adds them through the billing port of the support module.
    'entitlements', '[]'::jsonb,
    'openCases', (SELECT count(*)::integer FROM trustwork.support_case c WHERE (c.subject_person_id = p_person OR c.requester_person_id = p_person) AND c.status <> 'closed'),
    'consents', coalesce((SELECT jsonb_agg(jsonb_build_object('kind', r.purpose, 'version', r.notice_version, 'state', CASE WHEN r.withdrawn_at IS NULL THEN 'given' ELSE 'withdrawn' END,
                  'at', coalesce(r.withdrawn_at, r.granted_at)) ORDER BY r.granted_at, r.id) FROM trustwork.consent_record r WHERE r.subject_person_id = p_person), '[]'::jsonb));
END $$;

-- Inputs for the access explainer (admin.support.explain): the subject's own policy facts on one resource (membership,
-- ended memberships, the owner party and the subject's participation rows). The API evaluates the policy and answers
-- reason codes only; nothing here leaves the API. Recorded with the case.
CREATE FUNCTION trustwork.support_explain_inputs(p_ctx jsonb, p_case uuid, p_person uuid, p_kind text, p_resource uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.admin_require_caller();
  v_hub uuid := (SELECT c.hub_id FROM trustwork.support_case c WHERE c.id = p_case);
  v_actor trustwork.admin_actor;
  v_case trustwork.support_case%ROWTYPE;
  v_subject trustwork.person%ROWTYPE;
  v_membership jsonb;
  v_ended uuid[];
BEGIN
  IF v_hub IS NULL THEN
    RAISE EXCEPTION 'no such case' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.support.explain'], NULL, v_hub);
  v_case := trustwork.support_staff_case(v_person, p_case, p_person);
  SELECT * INTO v_subject FROM trustwork.person WHERE id = p_person;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such person' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  SELECT jsonb_build_object('companyId', m.company_id, 'membershipId', m.id, 'role', m.role, 'permissions', to_jsonb(m.permissions), 'companyAuthzEpoch', c.authz_epoch)
    INTO v_membership FROM trustwork.membership m JOIN trustwork.company c ON c.id = m.company_id WHERE m.person_id = p_person AND m.status = 'active' ORDER BY m.valid_from DESC LIMIT 1;
  SELECT coalesce(array_agg(DISTINCT m.company_id), '{}') INTO v_ended FROM trustwork.membership m WHERE m.person_id = p_person AND m.status = 'ended'
    AND NOT EXISTS (SELECT 1 FROM trustwork.membership a WHERE a.person_id = p_person AND a.company_id = m.company_id AND a.status = 'active');
  PERFORM trustwork.support_record_access(v_hub, v_person, p_case, 'access_explainer', p_person, p_kind || ':' || p_resource::text, 1);
  RETURN jsonb_build_object(
    'emailVerified', EXISTS (SELECT 1 FROM trustwork.email_binding b WHERE b.person_id = p_person AND b.is_primary AND b.verified_at IS NOT NULL),
    'authzEpoch', v_subject.authz_epoch,
    'membership', v_membership,
    'endedCompanies', to_jsonb(v_ended),
    'owner', (SELECT jsonb_build_object('kind', CASE WHEN o.party_person_id IS NOT NULL THEN 'person' ELSE 'company' END, 'id', coalesce(o.party_person_id, o.party_company_id))
              FROM trustwork.object_participation o WHERE o.resource_kind = p_kind AND o.resource_id = p_resource AND o.side = 'owner' AND o.revoked_at IS NULL ORDER BY o.valid_from DESC LIMIT 1),
    'rows', coalesce((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.created_at) FROM trustwork.object_participation o
              WHERE o.resource_kind = p_kind AND o.resource_id = p_resource AND o.side <> 'staff'
                AND (o.party_person_id = p_person OR o.party_company_id = (v_membership ->> 'companyId')::uuid OR o.party_company_id = ANY (v_ended))), '[]'::jsonb));
END $$;

-- Request a servicing action inside an open case. Immediate actions apply here; the sign-in factor changes are born
-- pending with evidence and a second-person approval request bound to their digest. p_params: rebind
-- {"newEmail": "..."}; guided task {"taskCode": "..."}; resend {"tokenHash": hex, "expiresInSeconds": n}.
CREATE FUNCTION trustwork.support_request_action(p_ctx jsonb, p_case uuid, p_subject uuid, p_action text, p_evidence uuid[], p_params jsonb)
RETURNS trustwork.account_service_action
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.admin_require_caller();
  v_hub uuid := (SELECT c.hub_id FROM trustwork.support_case c WHERE c.id = p_case);
  v_actor trustwork.admin_actor;
  v_case trustwork.support_case%ROWTYPE;
  v_id uuid := trustwork.new_uuid();
  v_cooling boolean := p_action = ANY (trustwork.support_cooling_off_actions());
  v_email text;
  v_digest text;
  v_approval trustwork.second_person_approval%ROWTYPE;
  v_target text;
  v_row trustwork.account_service_action%ROWTYPE;
BEGIN
  IF v_hub IS NULL THEN
    RAISE EXCEPTION 'no such case' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF p_action IS NULL OR NOT (p_action = ANY (trustwork.support_service_actions())) THEN
    RAISE EXCEPTION 'unknown servicing action' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.unknown_action';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY[trustwork.support_action_permission(p_action)], NULL, v_hub);
  v_case := trustwork.support_staff_case(v_person, p_case, p_subject);
  IF NOT EXISTS (SELECT 1 FROM trustwork.person WHERE id = p_subject) THEN
    RAISE EXCEPTION 'no such person' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF v_cooling AND (p_evidence IS NULL OR cardinality(p_evidence) NOT BETWEEN 1 AND 10) THEN
    RAISE EXCEPTION 'changing a sign-in factor needs recorded evidence' USING ERRCODE = 'check_violation', HINT = 'support.evidence_required';
  END IF;
  IF p_action = 'reset_second_factor' AND length(p_ctx ->> 'reasonText') < 10 THEN
    RAISE EXCEPTION 'a second-factor reset needs a reason of at least ten characters' USING ERRCODE = 'check_violation', HINT = 'admin.context_invalid';
  END IF;

  IF p_action = 'rebind_recovery_email' THEN
    v_email := lower(btrim(coalesce(p_params ->> 'newEmail', '')));
    IF v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' OR length(v_email) > 254 THEN
      RAISE EXCEPTION 'a new address is required' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.context_invalid';
    END IF;
    IF EXISTS (SELECT 1 FROM trustwork.email_binding b WHERE b.email_normalized = v_email AND b.verified_at IS NOT NULL) THEN
      RAISE EXCEPTION 'the address cannot be bound' USING ERRCODE = 'check_violation', HINT = 'support.address_unavailable';
    END IF;
  END IF;

  IF v_cooling THEN
    v_digest := trustwork.support_action_digest(v_id, p_case, p_subject, p_action, p_evidence, v_email);
    v_approval := trustwork.admin_request_approval(p_ctx, 'support.' || p_action, 'hub', NULL, v_hub, v_digest);
    INSERT INTO trustwork.account_service_action (id, hub_id, support_case_id, subject_person_id, action, requested_by, reason, evidence_refs, request_digest, approval_id,
      effective_at, state, new_email_normalized)
    VALUES (v_id, v_hub, p_case, p_subject, p_action, v_person, p_ctx ->> 'reasonText', p_evidence, v_digest, v_approval.id, now() + interval '72 hours', 'pending', v_email)
    RETURNING * INTO v_row;
  ELSE
    INSERT INTO trustwork.account_service_action (id, hub_id, support_case_id, subject_person_id, action, requested_by, reason, evidence_refs, effective_at, state, guided_task)
    VALUES (v_id, v_hub, p_case, p_subject, p_action, v_person, p_ctx ->> 'reasonText', coalesce(p_evidence, '{}'), now(), 'pending',
      CASE WHEN p_action = 'send_guided_task' THEN p_params ->> 'taskCode' END)
    RETURNING * INTO v_row;
    IF p_action = 'resend_verification' THEN
      IF EXISTS (SELECT 1 FROM trustwork.account_service_action a WHERE a.subject_person_id = p_subject AND a.action = 'resend_verification' AND a.id <> v_id
                 AND a.requested_at > now() - interval '15 minutes') THEN
        RAISE EXCEPTION 'a verification mail was resent recently' USING ERRCODE = 'check_violation', HINT = 'support.rate_limited';
      END IF;
      SELECT b.email_normalized INTO v_target FROM trustwork.email_binding b WHERE b.person_id = p_subject AND b.verified_at IS NULL ORDER BY b.is_primary DESC, b.created_at LIMIT 1;
      IF v_target IS NULL THEN
        RAISE EXCEPTION 'every address on file is verified' USING ERRCODE = 'check_violation', HINT = 'support.nothing_to_verify';
      END IF;
      IF coalesce(p_params ->> 'tokenHash', '') !~ '^[a-f0-9]{64}$' OR coalesce((p_params ->> 'expiresInSeconds')::integer, 0) NOT BETWEEN 60 AND 604800 THEN
        RAISE EXCEPTION 'a verification token hash is required' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.context_invalid';
      END IF;
      UPDATE trustwork.auth_token SET consumed_at = now() WHERE person_id = p_subject AND kind = 'verify_email' AND consumed_at IS NULL;
      INSERT INTO trustwork.auth_token (token_hash, kind, person_id, email_normalized, expires_at)
      VALUES (decode(p_params ->> 'tokenHash', 'hex'), 'verify_email', p_subject, v_target, now() + make_interval(secs => (p_params ->> 'expiresInSeconds')::integer));
    ELSIF p_action = 'unlock_after_lockout' THEN
      DELETE FROM trustwork.login_failure f USING trustwork.email_binding b
       WHERE b.person_id = p_subject AND f.subject_hash = sha256(convert_to('account:' || b.email_normalized, 'UTF8'));
      DELETE FROM trustwork.login_failure f WHERE f.subject_hash = sha256(convert_to('second_factor:' || p_subject::text, 'UTF8'));
    ELSIF p_action = 'revoke_all_sessions' THEN
      PERFORM trustwork.support_end_sessions(p_subject);
    ELSIF p_action = 'require_password_reset' THEN
      UPDATE trustwork.credential SET disabled_at = now() WHERE person_id = p_subject AND kind = 'password' AND disabled_at IS NULL;
      UPDATE trustwork.auth_token SET consumed_at = now() WHERE person_id = p_subject AND kind = 'recovery' AND consumed_at IS NULL;
      PERFORM trustwork.support_end_sessions(p_subject);
    END IF;
    -- Data export and deletion requests wait for the privacy officer; everything else is done now.
    IF p_action NOT IN ('start_data_export', 'open_deletion_request') THEN
      UPDATE trustwork.account_service_action SET state = 'done', executed_by = v_person WHERE id = v_id RETURNING * INTO v_row;
    END IF;
  END IF;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_hub, 'support.action_' || p_action, 'account_service_action', v_row.id, NULL, to_jsonb(v_row) - 'new_email_normalized', p_case);
  RETURN v_row;
END $$;

-- The requester starts the cooling-off once a different person approved the exact request: the approval is consumed,
-- the approver must not be the subject or conflicted, and the change takes effect no sooner than 72 hours from now.
-- A second-factor reset also opens the BE-004 reset in its cooling-off state (the subject sees it in their settings).
CREATE FUNCTION trustwork.support_activate_action(p_ctx jsonb, p_action_id uuid) RETURNS trustwork.account_service_action
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.admin_require_caller();
  v_before trustwork.account_service_action%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_approval trustwork.second_person_approval%ROWTYPE;
  v_reset uuid;
  v_row trustwork.account_service_action%ROWTYPE;
BEGIN
  SELECT * INTO v_before FROM trustwork.account_service_action WHERE id = p_action_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such action' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY[trustwork.support_action_permission(v_before.action)], NULL, v_before.hub_id);
  IF v_before.requested_by <> v_person THEN
    RAISE EXCEPTION 'only the requester starts the cooling-off' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.not_requester';
  END IF;
  PERFORM trustwork.support_staff_case(v_person, v_before.support_case_id, v_before.subject_person_id);
  IF v_before.state <> 'pending' OR v_before.approval_id IS NULL THEN
    RAISE EXCEPTION 'the action is %', v_before.state USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  SELECT * INTO v_approval FROM trustwork.second_person_approval WHERE id = v_before.approval_id;
  IF v_approval.approved_by IS NOT NULL AND (v_approval.approved_by = v_before.subject_person_id OR trustwork.admin_conflicted(v_approval.approved_by, v_before.subject_person_id, NULL)) THEN
    RAISE EXCEPTION 'the approver may not handle this person' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.conflict_of_interest';
  END IF;
  v_approval := trustwork.admin_consume_approval(v_before.approval_id, 'support.' || v_before.action, 'hub', NULL, v_before.hub_id,
    trustwork.support_action_digest(v_before.id, v_before.support_case_id, v_before.subject_person_id, v_before.action, v_before.evidence_refs, v_before.new_email_normalized), v_before.id);
  UPDATE trustwork.account_service_action SET state = 'cooling_off', approved_by = v_approval.approved_by WHERE id = p_action_id RETURNING * INTO v_row;
  IF v_row.action = 'reset_second_factor' THEN
    BEGIN
      INSERT INTO trustwork.second_factor_reset (subject_person_id, support_case_id, evidence_refs, reason, requested_by, requested_at, approved_by, approved_at, effective_at, state)
      VALUES (v_row.subject_person_id, v_row.support_case_id, v_row.evidence_refs, v_row.reason, v_row.requested_by, v_row.requested_at, v_row.approved_by, v_row.approved_at,
        v_row.effective_at, 'cooling_off')
      RETURNING id INTO v_reset;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'a reset of this person is already open' USING ERRCODE = 'check_violation', HINT = 'support.reset_open';
    END;
    UPDATE trustwork.account_service_action SET second_factor_reset_id = v_reset WHERE id = p_action_id RETURNING * INTO v_row;
  END IF;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'support.' || v_row.action, 'account_service_action', v_row.id, to_jsonb(v_before) - 'new_email_normalized',
    to_jsonb(v_row) - 'new_email_normalized', v_row.support_case_id, v_approval.id);
  RETURN v_row;
END $$;

-- After the cooling-off, the requester or the approver executes: a second-factor reset ends every factor, recovery code,
-- challenge, elevation and session of the subject (BE-004); a rebind issues an e-mail change proof to the new address
-- (the subject completes it from that mailbox; p_token_hash is the SHA-256 of the one-time token the API mails).
CREATE FUNCTION trustwork.support_execute_action(p_ctx jsonb, p_action_id uuid, p_token_hash text, p_token_valid_for interval) RETURNS trustwork.account_service_action
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.admin_require_caller();
  v_before trustwork.account_service_action%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.account_service_action%ROWTYPE;
BEGIN
  SELECT * INTO v_before FROM trustwork.account_service_action WHERE id = p_action_id FOR UPDATE;
  IF NOT FOUND OR v_person NOT IN (v_before.requested_by, coalesce(v_before.approved_by, v_before.requested_by)) THEN
    RAISE EXCEPTION 'no such action' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY[trustwork.support_action_permission(v_before.action)], NULL, v_before.hub_id);
  IF v_before.state <> 'cooling_off' THEN
    RAISE EXCEPTION 'the action is %', v_before.state USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  IF v_before.effective_at > now() THEN
    RAISE EXCEPTION 'the cooling-off period has not ended' USING ERRCODE = 'insufficient_privilege', HINT = 'support.cooling_off';
  END IF;
  PERFORM trustwork.support_staff_case(v_person, v_before.support_case_id, v_before.subject_person_id);
  IF v_before.action = 'reset_second_factor' THEN
    IF v_before.second_factor_reset_id IS NULL THEN
      RAISE EXCEPTION 'the reset no longer exists' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
    END IF;
    -- BE-004 executes as the same person and moves this action to done through support_reset_follow.
    PERFORM trustwork.second_factor_reset_execute(v_before.second_factor_reset_id);
    SELECT * INTO v_row FROM trustwork.account_service_action WHERE id = p_action_id;
  ELSE
    IF coalesce(p_token_hash, '') !~ '^[a-f0-9]{64}$' OR p_token_valid_for IS NULL OR p_token_valid_for <= interval '0' OR p_token_valid_for > interval '7 days' THEN
      RAISE EXCEPTION 'a proof token hash is required' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.context_invalid';
    END IF;
    IF EXISTS (SELECT 1 FROM trustwork.email_binding b WHERE b.email_normalized = v_before.new_email_normalized AND b.verified_at IS NOT NULL AND b.person_id <> v_before.subject_person_id) THEN
      RAISE EXCEPTION 'the address cannot be bound' USING ERRCODE = 'check_violation', HINT = 'support.address_unavailable';
    END IF;
    UPDATE trustwork.auth_token SET consumed_at = now() WHERE person_id = v_before.subject_person_id AND kind = 'email_change' AND consumed_at IS NULL;
    INSERT INTO trustwork.auth_token (token_hash, kind, person_id, email_normalized, expires_at)
    VALUES (decode(p_token_hash, 'hex'), 'email_change', v_before.subject_person_id, v_before.new_email_normalized, now() + p_token_valid_for);
    UPDATE trustwork.account_service_action SET state = 'done', executed_by = v_person WHERE id = p_action_id RETURNING * INTO v_row;
  END IF;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'support.action_execute', 'account_service_action', v_row.id, to_jsonb(v_before) - 'new_email_normalized',
    to_jsonb(v_row) - 'new_email_normalized', v_row.support_case_id);
  RETURN v_row;
END $$;

-- Staff cancel (the requester or the approver) before the action takes effect. An open approval request goes with it;
-- an open BE-004 reset is cancelled too.
CREATE FUNCTION trustwork.support_cancel_action(p_ctx jsonb, p_action_id uuid) RETURNS trustwork.account_service_action
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.admin_require_caller();
  v_before trustwork.account_service_action%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.account_service_action%ROWTYPE;
BEGIN
  SELECT * INTO v_before FROM trustwork.account_service_action WHERE id = p_action_id FOR UPDATE;
  IF NOT FOUND OR v_person NOT IN (v_before.requested_by, coalesce(v_before.approved_by, v_before.requested_by)) THEN
    RAISE EXCEPTION 'no such action' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY[trustwork.support_action_permission(v_before.action)], NULL, v_before.hub_id);
  IF v_before.state NOT IN ('pending', 'cooling_off') THEN
    RAISE EXCEPTION 'the action is %', v_before.state USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  UPDATE trustwork.account_service_action SET state = 'cancelled', cancelled_by = v_person WHERE id = p_action_id RETURNING * INTO v_row;
  UPDATE trustwork.second_person_approval SET status = 'revoked', revoked_by = v_person WHERE id = v_row.approval_id AND status IN ('pending', 'approved');
  IF v_row.second_factor_reset_id IS NOT NULL AND EXISTS (SELECT 1 FROM trustwork.second_factor_reset r WHERE r.id = v_row.second_factor_reset_id AND r.state IN ('pending', 'cooling_off')) THEN
    PERFORM trustwork.second_factor_reset_cancel(v_row.second_factor_reset_id);
  END IF;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'support.action_cancel', 'account_service_action', v_row.id, to_jsonb(v_before) - 'new_email_normalized',
    to_jsonb(v_row) - 'new_email_normalized', v_row.support_case_id);
  RETURN v_row;
END $$;

-- The subject cancels a sign-in factor change of their own account from their own session (no staff authority).
CREATE FUNCTION trustwork.support_cancel_own_action(p_action_id uuid) RETURNS trustwork.account_service_action
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.admin_require_caller();
  v_before trustwork.account_service_action%ROWTYPE;
  v_row trustwork.account_service_action%ROWTYPE;
BEGIN
  SELECT * INTO v_before FROM trustwork.account_service_action WHERE id = p_action_id AND subject_person_id = v_person FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such action' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF v_before.state NOT IN ('pending', 'cooling_off') OR NOT (v_before.action = ANY (trustwork.support_cooling_off_actions())) THEN
    RAISE EXCEPTION 'the action is %', v_before.state USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  UPDATE trustwork.account_service_action SET state = 'cancelled', cancelled_by = v_person WHERE id = p_action_id RETURNING * INTO v_row;
  UPDATE trustwork.second_person_approval SET status = 'revoked', revoked_by = v_person WHERE id = v_row.approval_id AND status IN ('pending', 'approved');
  IF v_row.second_factor_reset_id IS NOT NULL AND EXISTS (SELECT 1 FROM trustwork.second_factor_reset r WHERE r.id = v_row.second_factor_reset_id AND r.state IN ('pending', 'cooling_off')) THEN
    PERFORM trustwork.second_factor_reset_cancel(v_row.second_factor_reset_id);
  END IF;
  RETURN v_row;
END $$;

-- Verified addresses of an action's subject for the notices (every verified channel), or the address a proof goes to:
-- 'verified', 'verification' (the unverified address a resend targets) or 'new_email' (a rebind). Only the subject, the
-- requester and the approver of the action may ask.
CREATE FUNCTION trustwork.support_action_addresses(p_action_id uuid, p_purpose text) RETURNS SETOF text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.admin_require_caller();
  v_action trustwork.account_service_action%ROWTYPE;
BEGIN
  SELECT * INTO v_action FROM trustwork.account_service_action a WHERE a.id = p_action_id AND v_person IN (a.subject_person_id, a.requested_by, a.approved_by);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such action' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF p_purpose = 'verified' THEN
    RETURN QUERY SELECT b.email_normalized FROM trustwork.email_binding b WHERE b.person_id = v_action.subject_person_id AND b.verified_at IS NOT NULL ORDER BY b.created_at;
  ELSIF p_purpose = 'verification' THEN
    RETURN QUERY SELECT t.email_normalized FROM trustwork.auth_token t WHERE t.person_id = v_action.subject_person_id AND t.kind = 'verify_email' AND t.consumed_at IS NULL
      AND t.created_at >= v_action.requested_at ORDER BY t.created_at DESC LIMIT 1;
  ELSIF p_purpose = 'new_email' THEN
    RETURN QUERY SELECT v_action.new_email_normalized WHERE v_action.new_email_normalized IS NOT NULL;
  ELSE
    RAISE EXCEPTION 'unknown purpose' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.context_invalid';
  END IF;
END $$;

-- The masked new address of a rebind, for the parties of the action and support staff of the hub.
CREATE FUNCTION trustwork.support_action_masked_email(p_action_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.support_mask_email(a.new_email_normalized) FROM trustwork.account_service_action a
  WHERE a.id = p_action_id AND (trustwork.current_person_id() IN (a.subject_person_id, a.requested_by, a.approved_by)
    OR trustwork.admin_has_any_permission(trustwork.support_staff_permissions(), NULL, a.hub_id))
$$;

-- The person sees that support looked at their account: when, which kind of read and for which case; never who.
CREATE FUNCTION trustwork.support_own_access_records() RETURNS TABLE (id uuid, at timestamptz, kind text, support_case_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT r.id, r.at, r.kind, r.support_case_id FROM trustwork.support_access_record r
  WHERE r.subject_person_id = trustwork.current_person_id() AND trustwork.current_person_id() IS NOT NULL ORDER BY r.at DESC LIMIT 200
$$;

-- The requester shares diagnostics into their own open case from their own session; each selected object must be one
-- the requester (or their active employer) participates in. Only references are stored, never content.
CREATE FUNCTION trustwork.support_share_diagnostics(p_case uuid, p_page_id text, p_app_version text, p_locale text, p_flags text[], p_errors text[], p_request_ids text[], p_objects jsonb)
RETURNS trustwork.support_diagnostic_snapshot
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.admin_require_caller();
  v_company uuid := trustwork.current_company_id();
  v_case trustwork.support_case%ROWTYPE;
  v_object jsonb;
  v_row trustwork.support_diagnostic_snapshot%ROWTYPE;
BEGIN
  SELECT * INTO v_case FROM trustwork.support_case c WHERE c.id = p_case AND c.requester_person_id = v_person AND c.status <> 'closed';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such open case of the caller' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF p_objects IS NULL OR jsonb_typeof(p_objects) <> 'array' OR jsonb_array_length(p_objects) > 20 THEN
    RAISE EXCEPTION 'objects is a list of at most 20 references' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.context_invalid';
  END IF;
  FOR v_object IN SELECT value FROM jsonb_array_elements(p_objects) LOOP
    IF jsonb_typeof(v_object) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(v_object)) <> 2
       OR coalesce(v_object ->> 'type', '') NOT IN ('project', 'rfq', 'quote', 'agreement', 'order', 'thread', 'publication')
       OR coalesce(v_object ->> 'id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'an object reference is {type, id}' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.context_invalid';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM trustwork.object_participation o WHERE o.resource_kind = v_object ->> 'type' AND o.resource_id = (v_object ->> 'id')::uuid
                   AND o.side <> 'staff' AND o.revoked_at IS NULL AND o.valid_from <= now() AND (o.valid_until IS NULL OR o.valid_until > now())
                   AND (o.party_person_id = v_person OR (v_company IS NOT NULL AND o.party_company_id = v_company))) THEN
      RAISE EXCEPTION 'only objects the person takes part in can be shared' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
    END IF;
  END LOOP;
  INSERT INTO trustwork.support_diagnostic_snapshot (support_case_id, hub_id, shared_by, page_id, app_version, locale, feature_flags, error_codes, request_ids, objects)
  VALUES (p_case, v_case.hub_id, v_person, p_page_id, p_app_version, p_locale, coalesce(p_flags, '{}'), coalesce(p_errors, '{}'), coalesce(p_request_ids, '{}'), p_objects)
  RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- 6. Row-level security and grants ----------------------------------------------------------------------------------
ALTER TABLE trustwork.support_access_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.support_access_record FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.account_service_action ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.account_service_action FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.support_diagnostic_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.support_diagnostic_snapshot FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.support_access_record AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.account_service_action AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.support_diagnostic_snapshot AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

-- Access records: the reader themselves or an auditor of the hub (subjects read theirs through support_own_access_records).
CREATE POLICY support_access_record_read ON trustwork.support_access_record FOR SELECT TO trustwork_app
  USING (actor_person_id = trustwork.current_person_id() OR trustwork.admin_has_permission('admin.audit.read', NULL, hub_id));
-- Actions: the subject, the requester and the approver, and support staff of the hub.
CREATE POLICY account_service_action_read ON trustwork.account_service_action FOR SELECT TO trustwork_app
  USING (trustwork.current_person_id() IN (subject_person_id, requested_by, approved_by) OR trustwork.admin_has_any_permission(trustwork.support_staff_permissions(), NULL, hub_id));
-- Snapshots: the person who shared it and support staff of the hub.
CREATE POLICY support_diagnostic_snapshot_read ON trustwork.support_diagnostic_snapshot FOR SELECT TO trustwork_app
  USING (shared_by = trustwork.current_person_id() OR trustwork.admin_has_any_permission(trustwork.support_staff_permissions(), NULL, hub_id));

GRANT SELECT ON trustwork.support_access_record, trustwork.support_diagnostic_snapshot TO trustwork_app;
-- The new address of a rebind is not selectable by the runtime role.
GRANT SELECT (id, hub_id, support_case_id, subject_person_id, action, requested_by, requested_at, reason, evidence_refs, request_digest, approval_id, approved_by, approved_at,
  effective_at, subject_notified, state, guided_task, second_factor_reset_id, cancelled_by, cancelled_at, executed_by, executed_at, revision, updated_at)
  ON trustwork.account_service_action TO trustwork_app;

GRANT EXECUTE ON FUNCTION trustwork.support_service_actions(), trustwork.support_cooling_off_actions(), trustwork.support_action_permission(text),
  trustwork.support_staff_permissions(), trustwork.support_mask_email(text),
  trustwork.support_lookup(jsonb, uuid, uuid, text, text), trustwork.support_account_card(jsonb, uuid, uuid, integer, interval),
  trustwork.support_explain_inputs(jsonb, uuid, uuid, text, uuid), trustwork.support_request_action(jsonb, uuid, uuid, text, uuid[], jsonb),
  trustwork.support_activate_action(jsonb, uuid), trustwork.support_execute_action(jsonb, uuid, text, interval), trustwork.support_cancel_action(jsonb, uuid),
  trustwork.support_cancel_own_action(uuid), trustwork.support_action_addresses(uuid, text), trustwork.support_action_masked_email(uuid),
  trustwork.support_own_access_records(), trustwork.support_share_diagnostics(uuid, text, text, text, text[], text[], text[], jsonb)
  TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
