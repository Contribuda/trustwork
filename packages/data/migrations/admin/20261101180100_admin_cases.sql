-- DATA-002 administration persistence, part 2: support cases, case notes, case access grants and the access log
-- (docs/data/lifecycles.md "Support cases and case grants", docs/engine/hub-console/support.md, CaseAccessGrantSchema
-- and AccessLogEntrySchema in packages/contracts/src/admin.ts).
--
-- A case access grant is the only staff path to a customer's private objects (ADR 010, ADR 012): named objects of one
-- type (at most 100), a projection class, a purpose and an expiry of at most 72 hours after approval, requested inside
-- an open support case and approved by a different person who restates the request digest. negotiation_private,
-- credentials and payment_refs are always excluded. Every read under a grant is an access_log_entry (append-only,
-- gap-free sequence). Closing the case revokes its grants. There is no impersonation.
--
-- Restricted evidence files (evidence_artifact.classification = 'restricted', DATA-003) are served to staff only by
-- admin_case_evidence(), under an active grant of the `evidence` projection class that names the file or its parent.

-- 1. Support cases ----------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.support_case (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  requester_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  opened_by uuid NOT NULL REFERENCES trustwork.person (id),
  subject_person_id uuid NULL REFERENCES trustwork.person (id),
  subject_company_id uuid NULL REFERENCES trustwork.company (id),
  category text NOT NULL CHECK (category ~ '^[a-z][a-z0-9_]{1,40}$'),
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'triaged', 'waiting_on_requester', 'grant_requested', 'in_progress', 'resolved', 'closed')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  assigned_to uuid NULL REFERENCES trustwork.person (id),
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz NULL,
  closed_at timestamptz NULL,
  closed_by uuid NULL REFERENCES trustwork.person (id),
  resolution_code text NULL CHECK (resolution_code ~ '^[a-z][a-z0-9_]{1,40}$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_case_subject_xor CHECK ((subject_person_id IS NULL) <> (subject_company_id IS NULL)),
  CONSTRAINT support_case_closed_shape CHECK ((status = 'closed') = (closed_at IS NOT NULL) AND (closed_at IS NULL) = (closed_by IS NULL))
);
CREATE INDEX support_case_hub_status_idx ON trustwork.support_case (hub_id, status);
CREATE INDEX support_case_requester_idx ON trustwork.support_case (requester_person_id);
CREATE TRIGGER support_case_touch BEFORE UPDATE ON trustwork.support_case FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

CREATE FUNCTION trustwork.admin_support_transition_allowed(p_from text, p_to text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT (p_from, p_to) IN (('open', 'triaged'), ('open', 'closed'), ('triaged', 'waiting_on_requester'), ('waiting_on_requester', 'triaged'),
    ('triaged', 'grant_requested'), ('grant_requested', 'in_progress'), ('grant_requested', 'triaged'), ('triaged', 'in_progress'),
    ('in_progress', 'resolved'), ('resolved', 'closed'), ('resolved', 'open'))
$$;

CREATE FUNCTION trustwork.admin_support_case_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'support cases are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.closed_at IS NOT NULL OR NEW.resolved_at IS NOT NULL THEN
      RAISE EXCEPTION 'a support case opens as open' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
    END IF;
    NEW.opened_at := now();
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.hub_id <> OLD.hub_id OR NEW.number <> OLD.number OR NEW.requester_person_id <> OLD.requester_person_id OR NEW.opened_by <> OLD.opened_by
     OR NEW.subject_person_id IS DISTINCT FROM OLD.subject_person_id OR NEW.subject_company_id IS DISTINCT FROM OLD.subject_company_id OR NEW.opened_at <> OLD.opened_at THEN
    RAISE EXCEPTION 'support case identity is immutable' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'closed cases are final' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT trustwork.admin_support_transition_allowed(OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'support case % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
    END IF;
    IF NEW.status = 'resolved' THEN
      NEW.resolved_at := now();
    ELSIF NEW.status = 'open' THEN
      NEW.resolved_at := NULL;
    ELSIF NEW.status = 'closed' THEN
      NEW.closed_at := now();
    END IF;
  ELSIF NEW.closed_at IS DISTINCT FROM OLD.closed_at OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at THEN
    RAISE EXCEPTION 'lifecycle times follow the status' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER support_case_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.support_case FOR EACH ROW EXECUTE FUNCTION trustwork.admin_support_case_guard();

-- 2. Case notes (A) -----------------------------------------------------------------------------------------------------
-- Internal notes never contain private payloads; `requester` notes are visible to the requester.
CREATE TABLE trustwork.support_case_note (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  support_case_id uuid NOT NULL REFERENCES trustwork.support_case (id),
  author_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  visibility text NOT NULL CHECK (visibility IN ('internal', 'requester')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_case_note_case_idx ON trustwork.support_case_note (support_case_id, created_at);
CREATE TRIGGER support_case_note_append_only BEFORE UPDATE OR DELETE ON trustwork.support_case_note FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 3. Case access grants ----------------------------------------------------------------------------------------------
-- requested -> approved -> (expired by time) | revoked; requested -> denied | revoked.
CREATE TABLE trustwork.case_access_grant (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  support_case_id uuid NOT NULL REFERENCES trustwork.support_case (id),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  requested_by uuid NOT NULL REFERENCES trustwork.person (id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  object_type text NOT NULL CHECK (object_type ~ '^[a-z][a-z0-9_]{1,63}$'),
  object_ids uuid[] NOT NULL CHECK (cardinality(object_ids) BETWEEN 1 AND 100 AND array_position(object_ids, NULL) IS NULL AND trustwork.admin_distinct(object_ids)),
  projection_class text NOT NULL CHECK (projection_class IN ('diagnostic', 'support_private_limited', 'evidence')),
  excluded_field_classes text[] NOT NULL DEFAULT ARRAY['credentials', 'negotiation_private', 'payment_refs']
    CHECK (excluded_field_classes @> ARRAY['credentials', 'negotiation_private', 'payment_refs'] AND excluded_field_classes <@ ARRAY['credentials', 'negotiation_private', 'payment_refs']),
  purpose text NOT NULL CHECK (length(purpose) BETWEEN 1 AND 500),
  expires_in interval NOT NULL CHECK (expires_in > interval '0' AND expires_in <= interval '72 hours'),
  legal_exception_ref text NULL CHECK (legal_exception_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'denied', 'revoked')),
  approved_by uuid NULL REFERENCES trustwork.person (id),
  approved_at timestamptz NULL,
  expires_at timestamptz NULL,
  denied_by uuid NULL REFERENCES trustwork.person (id),
  revoked_at timestamptz NULL,
  revoked_by uuid NULL REFERENCES trustwork.person (id),
  revoke_reason text NULL CHECK (revoke_reason IN ('requester_done', 'staff_revoked', 'case_closed', 'role_revoked')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_access_grant_distinct_people CHECK (approved_by IS DISTINCT FROM requested_by AND denied_by IS DISTINCT FROM requested_by),
  CONSTRAINT case_access_grant_approved_shape CHECK ((approved_by IS NOT NULL) = (approved_at IS NOT NULL) AND (approved_at IS NOT NULL) = (expires_at IS NOT NULL)
    AND (approved_at IS NULL OR (expires_at = approved_at + expires_in AND expires_at <= approved_at + interval '72 hours'))),
  CONSTRAINT case_access_grant_status_shape CHECK (CASE status
    WHEN 'requested' THEN approved_by IS NULL AND denied_by IS NULL AND revoked_at IS NULL
    WHEN 'approved' THEN approved_by IS NOT NULL AND revoked_at IS NULL
    WHEN 'denied' THEN denied_by IS NOT NULL AND approved_by IS NULL AND revoked_at IS NULL
    ELSE revoked_at IS NOT NULL END),
  CONSTRAINT case_access_grant_revocation_shape CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX case_access_grant_case_idx ON trustwork.case_access_grant (support_case_id, status);
CREATE INDEX case_access_grant_requester_idx ON trustwork.case_access_grant (requested_by, status) WHERE status = 'approved';
CREATE TRIGGER case_access_grant_touch BEFORE UPDATE ON trustwork.case_access_grant FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- The digest an approver restates (trustwork-digest-1 of the request; ids and excluded classes sorted).
CREATE FUNCTION trustwork.admin_case_grant_digest(p_case uuid, p_object_type text, p_object_ids uuid[], p_projection_class text, p_excluded text[],
  p_purpose text, p_expires_in_seconds bigint, p_legal_exception_ref text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.admin_digest(jsonb_build_object(
    'supportCaseId', p_case::text,
    'objectSelector', jsonb_build_object('type', p_object_type, 'ids', (SELECT jsonb_agg(i ORDER BY i COLLATE "C") FROM (SELECT DISTINCT x::text AS i FROM unnest(p_object_ids) x) s)),
    'projectionClass', p_projection_class,
    'excludedFieldClasses', (SELECT jsonb_agg(c ORDER BY c COLLATE "C") FROM unnest(p_excluded) c),
    'purpose', p_purpose, 'expiresInSeconds', p_expires_in_seconds, 'legalExceptionRef', p_legal_exception_ref))
$$;

CREATE FUNCTION trustwork.admin_case_grant_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_case trustwork.support_case%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'case grants are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO v_case FROM trustwork.support_case WHERE id = NEW.support_case_id;
    IF NOT FOUND OR v_case.status = 'closed' THEN
      RAISE EXCEPTION 'grants are requested inside an open support case' USING ERRCODE = 'check_violation', HINT = 'admin.case_closed';
    END IF;
    IF NEW.status <> 'requested' OR NEW.approved_by IS NOT NULL OR NEW.denied_by IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'a grant is born requested' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
    END IF;
    NEW.hub_id := v_case.hub_id;
    NEW.requested_at := now();
    NEW.request_digest := trustwork.admin_case_grant_digest(NEW.support_case_id, NEW.object_type, NEW.object_ids, NEW.projection_class, NEW.excluded_field_classes,
      NEW.purpose, round(extract(epoch FROM NEW.expires_in))::bigint, NEW.legal_exception_ref);
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.support_case_id, NEW.hub_id, NEW.requested_by, NEW.requested_at, NEW.object_type, NEW.object_ids, NEW.projection_class, NEW.excluded_field_classes,
         NEW.purpose, NEW.expires_in, NEW.legal_exception_ref, NEW.request_digest)
     IS DISTINCT FROM ROW(OLD.id, OLD.support_case_id, OLD.hub_id, OLD.requested_by, OLD.requested_at, OLD.object_type, OLD.object_ids, OLD.projection_class, OLD.excluded_field_classes,
         OLD.purpose, OLD.expires_in, OLD.legal_exception_ref, OLD.request_digest) THEN
    RAISE EXCEPTION 'the requested grant is immutable; request again' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  IF NEW.status = OLD.status THEN
    IF ROW(NEW.approved_by, NEW.approved_at, NEW.expires_at, NEW.denied_by, NEW.revoked_at, NEW.revoked_by, NEW.revoke_reason)
       IS DISTINCT FROM ROW(OLD.approved_by, OLD.approved_at, OLD.expires_at, OLD.denied_by, OLD.revoked_at, OLD.revoked_by, OLD.revoke_reason) THEN
      RAISE EXCEPTION 'decision columns change only with the status' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status = 'requested' AND NEW.status IN ('approved', 'denied', 'revoked')) OR (OLD.status = 'approved' AND NEW.status = 'revoked')) THEN
    RAISE EXCEPTION 'grant % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  IF NEW.status = 'approved' THEN
    NEW.approved_at := now();
    NEW.expires_at := now() + OLD.expires_in;
  ELSIF NEW.status = 'revoked' THEN
    NEW.revoked_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER case_access_grant_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.case_access_grant FOR EACH ROW EXECUTE FUNCTION trustwork.admin_case_grant_guard();

-- Closing a case revokes every grant that is still requested or approved, in the same transaction.
CREATE FUNCTION trustwork.admin_support_case_closed() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF NEW.status = 'closed' AND OLD.status <> 'closed' THEN
    UPDATE trustwork.case_access_grant SET status = 'revoked', revoked_by = NEW.closed_by, revoke_reason = 'case_closed'
     WHERE support_case_id = NEW.id AND status IN ('requested', 'approved');
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER support_case_closed AFTER UPDATE ON trustwork.support_case FOR EACH ROW EXECUTE FUNCTION trustwork.admin_support_case_closed();

-- Is the grant usable right now by p_person for this object? Approved, unrevoked, unexpired, the person is its
-- requester, the case is open, and the object is named (or, for evidence files, the file's parent is named).
CREATE FUNCTION trustwork.admin_grant_usable(p_person uuid, p_grant uuid, p_object_type text, p_object_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM trustwork.case_access_grant g JOIN trustwork.support_case c ON c.id = g.support_case_id
    WHERE g.id = p_grant AND p_person IS NOT NULL AND g.requested_by = p_person AND g.status = 'approved' AND g.revoked_at IS NULL
      AND g.approved_at <= now() AND g.expires_at > now() AND c.status <> 'closed'
      AND g.object_type = p_object_type AND p_object_id = ANY (g.object_ids)
  )
$$;

-- 4. Access log (A) ---------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.access_log_entry (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  sequence bigint NOT NULL UNIQUE CHECK (sequence >= 1),
  read_at timestamptz NOT NULL DEFAULT now(),
  actor_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  grant_id uuid NOT NULL REFERENCES trustwork.case_access_grant (id),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  case_kind text NOT NULL DEFAULT 'support_case' CHECK (case_kind IN ('support_case', 'dispute_case')),
  case_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('case_read', 'dispute_evidence_read', 'audit_read', 'evidence_view')),
  object_type text NOT NULL CHECK (length(object_type) BETWEEN 1 AND 64),
  object_id uuid NOT NULL,
  fields_hash text NOT NULL CHECK (fields_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX access_log_entry_object_idx ON trustwork.access_log_entry (object_type, object_id);
CREATE INDEX access_log_entry_grant_idx ON trustwork.access_log_entry (grant_id);

CREATE FUNCTION trustwork.admin_access_log_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_grant trustwork.case_access_grant%ROWTYPE;
BEGIN
  SELECT * INTO v_grant FROM trustwork.case_access_grant WHERE id = NEW.grant_id;
  IF NOT FOUND OR NEW.case_kind <> 'support_case' OR NEW.case_id IS DISTINCT FROM v_grant.support_case_id OR NEW.actor_person_id <> v_grant.requested_by THEN
    RAISE EXCEPTION 'the access log names the grant''s case and grantee' USING ERRCODE = 'check_violation', HINT = 'admin.grant_mismatch';
  END IF;
  NEW.hub_id := v_grant.hub_id;
  NEW.read_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER access_log_entry_guard BEFORE INSERT ON trustwork.access_log_entry FOR EACH ROW EXECUTE FUNCTION trustwork.admin_access_log_guard();
CREATE TRIGGER access_log_entry_sequence BEFORE INSERT ON trustwork.access_log_entry FOR EACH ROW EXECUTE FUNCTION trustwork.admin_next_sequence();
CREATE TRIGGER access_log_entry_append_only BEFORE UPDATE OR DELETE ON trustwork.access_log_entry FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER access_log_entry_no_truncate BEFORE TRUNCATE ON trustwork.access_log_entry FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

-- 5. Commands (SECURITY DEFINER, allowlisted) --------------------------------------------------------------------------
CREATE FUNCTION trustwork.admin_support_permissions() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['admin.support.case.create', 'admin.support.case.close', 'admin.support.diagnose', 'admin.support.grant.request', 'admin.support.grant.approve',
    'admin.support.notifications', 'admin.support.recovery.approve', 'admin.support.account.read', 'admin.support.explain']::text[]
$$;

-- A person opens a case about themselves or, with company.members.manage, about their active employer. No elevation:
-- this is the participant path.
CREATE FUNCTION trustwork.admin_open_own_support_case(p_hub uuid, p_for_company boolean, p_category text, p_summary text) RETURNS trustwork.support_case
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.admin_require_caller();
  v_company uuid := trustwork.current_company_id();
  v_row trustwork.support_case%ROWTYPE;
BEGIN
  IF p_for_company AND (v_company IS NULL OR NOT trustwork.current_membership_has('company.members.manage')) THEN
    RAISE EXCEPTION 'a company case needs company.members.manage at the active employer' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.forbidden';
  END IF;
  INSERT INTO trustwork.support_case (hub_id, requester_person_id, opened_by, subject_person_id, subject_company_id, category, summary)
  VALUES (p_hub, v_person, v_person, CASE WHEN p_for_company THEN NULL ELSE v_person END, CASE WHEN p_for_company THEN v_company END, p_category, p_summary)
  RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- Staff open a case on someone's behalf (admin.support.case.create), never about themselves or their employer.
CREATE FUNCTION trustwork.admin_open_support_case(p_ctx jsonb, p_hub uuid, p_requester uuid, p_subject_person uuid, p_subject_company uuid, p_category text,
  p_summary text, p_priority text DEFAULT 'normal') RETURNS trustwork.support_case
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.support.case.create'], NULL, p_hub);
  v_row trustwork.support_case%ROWTYPE;
BEGIN
  IF p_requester = v_actor.person_id OR trustwork.admin_conflicted(v_actor.person_id, p_subject_person, p_subject_company) THEN
    RAISE EXCEPTION 'staff never handle their own account, employer or declared parties' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.conflict_of_interest';
  END IF;
  INSERT INTO trustwork.support_case (hub_id, requester_person_id, opened_by, subject_person_id, subject_company_id, category, summary, priority)
  VALUES (p_hub, p_requester, v_actor.person_id, p_subject_person, p_subject_company, p_category, p_summary, p_priority) RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'support.case_open', 'support_case', v_row.id, NULL, to_jsonb(v_row), v_row.id);
  RETURN v_row;
END $$;

-- Staff move a case along its lifecycle, assign it or change its priority; closing needs admin.support.case.close.
CREATE FUNCTION trustwork.admin_update_support_case(p_ctx jsonb, p_case_id uuid, p_status text, p_assigned_to uuid DEFAULT NULL, p_priority text DEFAULT NULL,
  p_resolution_code text DEFAULT NULL) RETURNS trustwork.support_case
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.support_case%ROWTYPE;
  v_row trustwork.support_case%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_status text;
BEGIN
  SELECT * INTO v_before FROM trustwork.support_case WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such case' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_status := coalesce(p_status, v_before.status);
  v_actor := trustwork.admin_authorize(p_ctx, CASE WHEN v_status = 'closed' THEN ARRAY['admin.support.case.close'] ELSE trustwork.admin_support_permissions() END, NULL, v_before.hub_id);
  IF trustwork.admin_conflicted(v_actor.person_id, v_before.subject_person_id, v_before.subject_company_id) OR v_before.requester_person_id = v_actor.person_id THEN
    RAISE EXCEPTION 'staff never handle their own account, employer or declared parties' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.conflict_of_interest';
  END IF;
  IF p_assigned_to IS NOT NULL AND (trustwork.admin_conflicted(p_assigned_to, v_before.subject_person_id, v_before.subject_company_id)
     OR (SELECT r.role FROM trustwork.admin_resolve_any(p_assigned_to, trustwork.admin_support_permissions(), NULL, v_before.hub_id) r) IS NULL) THEN
    RAISE EXCEPTION 'the assignee is support staff of the hub without a conflict' USING ERRCODE = 'check_violation', HINT = 'admin.assignee_invalid';
  END IF;
  UPDATE trustwork.support_case SET status = v_status, assigned_to = coalesce(p_assigned_to, assigned_to), priority = coalesce(p_priority, priority),
         resolution_code = coalesce(p_resolution_code, resolution_code), closed_by = CASE WHEN v_status = 'closed' AND v_before.status <> 'closed' THEN v_actor.person_id ELSE closed_by END
   WHERE id = p_case_id RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'support.case_update', 'support_case', v_row.id, to_jsonb(v_before), to_jsonb(v_row), v_row.id);
  RETURN v_row;
END $$;

-- The requester answers (waiting_on_requester -> triaged), reopens (resolved -> open) or confirms (resolved -> closed).
CREATE FUNCTION trustwork.admin_requester_update_case(p_case_id uuid, p_status text) RETURNS trustwork.support_case
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.admin_require_caller();
  v_before trustwork.support_case%ROWTYPE;
  v_row trustwork.support_case%ROWTYPE;
BEGIN
  SELECT * INTO v_before FROM trustwork.support_case WHERE id = p_case_id AND requester_person_id = v_person FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such case' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF (v_before.status, p_status) NOT IN (('waiting_on_requester', 'triaged'), ('resolved', 'open'), ('resolved', 'closed')) THEN
    RAISE EXCEPTION 'the requester cannot move % -> %', v_before.status, p_status USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  UPDATE trustwork.support_case SET status = p_status, closed_by = CASE WHEN p_status = 'closed' THEN v_person END WHERE id = p_case_id RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- Notes: staff (any support permission at the hub, recorded) or the requester (visible to the requester).
CREATE FUNCTION trustwork.admin_add_case_note(p_ctx jsonb, p_case_id uuid, p_body text, p_visibility text) RETURNS trustwork.support_case_note
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_case trustwork.support_case%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.support_case_note%ROWTYPE;
BEGIN
  SELECT * INTO v_case FROM trustwork.support_case WHERE id = p_case_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such case' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, trustwork.admin_support_permissions(), NULL, v_case.hub_id);
  IF v_case.status = 'closed' THEN
    RAISE EXCEPTION 'closed cases are final' USING ERRCODE = 'check_violation', HINT = 'admin.case_closed';
  END IF;
  INSERT INTO trustwork.support_case_note (support_case_id, author_person_id, body, visibility) VALUES (p_case_id, v_actor.person_id, p_body, p_visibility) RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_case.hub_id, 'support.case_note', 'support_case_note', v_row.id, NULL, to_jsonb(v_row), p_case_id);
  RETURN v_row;
END $$;
CREATE FUNCTION trustwork.admin_add_requester_note(p_case_id uuid, p_body text) RETURNS trustwork.support_case_note
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.admin_require_caller();
  v_row trustwork.support_case_note%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM trustwork.support_case c WHERE c.id = p_case_id AND c.requester_person_id = v_person AND c.status <> 'closed') THEN
    RAISE EXCEPTION 'no such open case of the caller' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  INSERT INTO trustwork.support_case_note (support_case_id, author_person_id, body, visibility) VALUES (p_case_id, v_person, p_body, 'requester') RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- Request a grant (admin.support.grant.request at the case's hub), within the role's grant cap and 72 hours.
CREATE FUNCTION trustwork.admin_request_case_grant(p_ctx jsonb, p_case_id uuid, p_object_type text, p_object_ids uuid[], p_projection_class text, p_purpose text,
  p_expires_in interval, p_legal_exception_ref text DEFAULT NULL) RETURNS trustwork.case_access_grant
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_case trustwork.support_case%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_cap integer;
  v_row trustwork.case_access_grant%ROWTYPE;
BEGIN
  SELECT * INTO v_case FROM trustwork.support_case WHERE id = p_case_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such case' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.support.grant.request'], NULL, v_case.hub_id);
  IF trustwork.admin_conflicted(v_actor.person_id, v_case.subject_person_id, v_case.subject_company_id) OR v_case.requester_person_id = v_actor.person_id THEN
    RAISE EXCEPTION 'staff never handle their own account, employer or declared parties' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.conflict_of_interest';
  END IF;
  SELECT max(d.grant_max_hours) INTO v_cap FROM trustwork.staff_role_assignment a JOIN trustwork.staff_role_definition_version d ON d.role = a.role AND d.version = a.definition_version
   WHERE a.person_id = v_actor.person_id AND a.role = v_actor.role AND a.revoked_at IS NULL AND (a.valid_until IS NULL OR a.valid_until > now());
  IF p_expires_in IS NULL OR p_expires_in <= interval '0' OR p_expires_in > interval '72 hours' OR p_expires_in > make_interval(hours => coalesce(v_cap, 0)) THEN
    RAISE EXCEPTION 'a grant lasts at most 72 hours and the role''s cap' USING ERRCODE = 'check_violation', HINT = 'admin.grant_too_long';
  END IF;
  INSERT INTO trustwork.case_access_grant (support_case_id, hub_id, requested_by, object_type, object_ids, projection_class, purpose, expires_in, legal_exception_ref, request_digest)
  VALUES (p_case_id, v_case.hub_id, v_actor.person_id, p_object_type, p_object_ids, p_projection_class, p_purpose, p_expires_in, p_legal_exception_ref, repeat('0', 64))
  RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_case.hub_id, 'support.grant_request', 'case_access_grant', v_row.id, NULL, to_jsonb(v_row), p_case_id);
  RETURN v_row;
END $$;

-- Decide as a different person (admin.support.grant.approve), restating the request digest; races are serialized by
-- the row lock, so two approvers never both decide.
CREATE FUNCTION trustwork.admin_decide_case_grant(p_ctx jsonb, p_grant_id uuid, p_decision text, p_request_digest text) RETURNS trustwork.case_access_grant
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.admin_require_caller();
  v_before trustwork.case_access_grant%ROWTYPE;
  v_case trustwork.support_case%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.case_access_grant%ROWTYPE;
BEGIN
  SELECT * INTO v_before FROM trustwork.case_access_grant WHERE id = p_grant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such grant' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF v_before.requested_by = v_person THEN
    RAISE EXCEPTION 'nobody approves their own grant request' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.self_approval';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.support.grant.approve'], NULL, v_before.hub_id);
  SELECT * INTO v_case FROM trustwork.support_case WHERE id = v_before.support_case_id;
  IF trustwork.admin_conflicted(v_person, v_case.subject_person_id, v_case.subject_company_id) OR v_case.requester_person_id = v_person THEN
    RAISE EXCEPTION 'staff never handle their own account, employer or declared parties' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.conflict_of_interest';
  END IF;
  IF v_before.status <> 'requested' THEN
    RAISE EXCEPTION 'the grant is already %', v_before.status USING ERRCODE = 'check_violation', HINT = 'admin.grant_not_requested';
  END IF;
  IF p_decision = 'approve' THEN
    IF p_request_digest IS DISTINCT FROM v_before.request_digest THEN
      RAISE EXCEPTION 'the reviewed digest differs from the request' USING ERRCODE = 'check_violation', HINT = 'access.approval_digest_mismatch';
    END IF;
    UPDATE trustwork.case_access_grant SET status = 'approved', approved_by = v_person, approved_at = now(), expires_at = now() + expires_in WHERE id = p_grant_id RETURNING * INTO v_row;
  ELSIF p_decision = 'deny' THEN
    UPDATE trustwork.case_access_grant SET status = 'denied', denied_by = v_person WHERE id = p_grant_id RETURNING * INTO v_row;
  ELSE
    RAISE EXCEPTION 'decision is approve or deny' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.context_invalid';
  END IF;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'support.grant_' || p_decision, 'case_access_grant', v_row.id, to_jsonb(v_before), to_jsonb(v_row), v_row.support_case_id);
  RETURN v_row;
END $$;

-- The grantee ends their own grant, or a grant approver revokes it.
CREATE FUNCTION trustwork.admin_revoke_case_grant(p_ctx jsonb, p_grant_id uuid) RETURNS trustwork.case_access_grant
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.admin_require_caller();
  v_before trustwork.case_access_grant%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.case_access_grant%ROWTYPE;
BEGIN
  SELECT * INTO v_before FROM trustwork.case_access_grant WHERE id = p_grant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such grant' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, CASE WHEN v_before.requested_by = v_person THEN ARRAY['admin.support.grant.request', 'admin.support.grant.approve'] ELSE ARRAY['admin.support.grant.approve'] END,
    NULL, v_before.hub_id);
  IF v_before.status NOT IN ('requested', 'approved') THEN
    RAISE EXCEPTION 'the grant is already %', v_before.status USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
  END IF;
  UPDATE trustwork.case_access_grant SET status = 'revoked', revoked_by = v_person,
         revoke_reason = CASE WHEN v_before.requested_by = v_person THEN 'requester_done' ELSE 'staff_revoked' END
   WHERE id = p_grant_id RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'support.grant_revoke', 'case_access_grant', v_row.id, to_jsonb(v_before), to_jsonb(v_row), v_row.support_case_id);
  RETURN v_row;
END $$;

-- For other modules' row-level policies (staff_case projection): does the caller hold a usable grant naming this object?
CREATE FUNCTION trustwork.admin_case_grant_covers(p_object_type text, p_object_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT EXISTS (
    SELECT 1 FROM trustwork.case_access_grant g
    WHERE g.requested_by = trustwork.current_person_id() AND g.status = 'approved' AND g.object_type = p_object_type AND p_object_id = ANY (g.object_ids)
      AND trustwork.admin_grant_usable(g.requested_by, g.id, p_object_type, p_object_id)
  )
$$;
-- Used by the access-log insert policy.
CREATE FUNCTION trustwork.admin_may_log_access(p_grant uuid, p_object_type text, p_object_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.admin_grant_usable(trustwork.current_person_id(), p_grant, p_object_type, p_object_id)
$$;

-- The staff path to evidence files, including `restricted` ones: an active grant of the caller names the file
-- (object type evidence_artifact) or its parent; `restricted` files need the `evidence` projection class and the
-- `diagnostic` class never opens a file; only clean scans are served. Every call writes an access_log_entry.
-- Anything else answers "not found".
CREATE FUNCTION trustwork.admin_case_evidence(p_grant_id uuid, p_artifact_id uuid, p_fields_hash text)
RETURNS TABLE (id uuid, owner_person_id uuid, owner_company_id uuid, parent_kind text, parent_id uuid, classification text, storage_key text, sha256 text, bytes bigint, media_type text)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.admin_require_caller();
  v_grant trustwork.case_access_grant%ROWTYPE;
  v_file trustwork.evidence_artifact%ROWTYPE;
  v_object_type text;
  v_object_id uuid;
BEGIN
  SELECT * INTO v_grant FROM trustwork.case_access_grant g WHERE g.id = p_grant_id;
  SELECT * INTO v_file FROM trustwork.evidence_artifact a WHERE a.id = p_artifact_id;
  IF v_grant.id IS NULL OR v_file.id IS NULL THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF v_grant.object_type = 'evidence_artifact' THEN
    v_object_type := 'evidence_artifact';
    v_object_id := v_file.id;
  ELSE
    v_object_type := v_file.parent_kind;
    v_object_id := v_file.parent_id;
  END IF;
  IF NOT trustwork.admin_grant_usable(v_person, p_grant_id, v_object_type, v_object_id) OR v_grant.projection_class = 'diagnostic'
     OR (v_file.classification = 'restricted' AND v_grant.projection_class <> 'evidence') OR v_file.scan_state <> 'clean' THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  INSERT INTO trustwork.access_log_entry (actor_person_id, grant_id, hub_id, case_id, kind, object_type, object_id, fields_hash)
  VALUES (v_person, p_grant_id, v_grant.hub_id, v_grant.support_case_id, 'evidence_view', 'evidence_artifact', v_file.id, p_fields_hash);
  RETURN QUERY SELECT v_file.id, v_file.owner_person_id, v_file.owner_company_id, v_file.parent_kind, v_file.parent_id, v_file.classification, v_file.storage_key,
    v_file.sha256, v_file.bytes, v_file.media_type;
END $$;

-- 6. Row-level security and grants ------------------------------------------------------------------------------------
ALTER TABLE trustwork.support_case ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.support_case FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.support_case_note ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.support_case_note FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.case_access_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.case_access_grant FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.access_log_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.access_log_entry FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.support_case AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.support_case_note AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.case_access_grant AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.access_log_entry AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

CREATE POLICY support_case_read ON trustwork.support_case FOR SELECT TO trustwork_app
  USING (requester_person_id = trustwork.current_person_id() OR trustwork.admin_has_any_permission(trustwork.admin_support_permissions(), NULL, hub_id));
CREATE POLICY support_case_note_read ON trustwork.support_case_note FOR SELECT TO trustwork_app
  USING (EXISTS (SELECT 1 FROM trustwork.support_case c WHERE c.id = support_case_id
                 AND ((visibility = 'requester' AND c.requester_person_id = trustwork.current_person_id())
                      OR trustwork.admin_has_any_permission(trustwork.admin_support_permissions(), NULL, c.hub_id))));
CREATE POLICY case_access_grant_read ON trustwork.case_access_grant FOR SELECT TO trustwork_app
  USING (requested_by = trustwork.current_person_id() OR approved_by = trustwork.current_person_id()
         OR trustwork.admin_has_any_permission(ARRAY['admin.support.grant.approve', 'admin.audit.read'], NULL, hub_id));
CREATE POLICY access_log_entry_read ON trustwork.access_log_entry FOR SELECT TO trustwork_app
  USING (actor_person_id = trustwork.current_person_id() OR trustwork.admin_has_permission('admin.audit.read', NULL, hub_id));
-- Insert-only: the grantee logs a read under their own usable grant (the definer reads log themselves).
CREATE POLICY access_log_entry_insert ON trustwork.access_log_entry FOR INSERT TO trustwork_app
  WITH CHECK (actor_person_id = trustwork.current_person_id() AND trustwork.admin_may_log_access(grant_id, object_type, object_id));

GRANT SELECT ON trustwork.support_case, trustwork.support_case_note, trustwork.case_access_grant, trustwork.access_log_entry TO trustwork_app;
GRANT INSERT (actor_person_id, grant_id, hub_id, case_kind, case_id, kind, object_type, object_id, fields_hash) ON trustwork.access_log_entry TO trustwork_app;

GRANT EXECUTE ON FUNCTION trustwork.admin_support_transition_allowed(text, text), trustwork.admin_support_permissions(),
  trustwork.admin_case_grant_digest(uuid, text, uuid[], text, text[], text, bigint, text),
  trustwork.admin_open_own_support_case(uuid, boolean, text, text), trustwork.admin_open_support_case(jsonb, uuid, uuid, uuid, uuid, text, text, text),
  trustwork.admin_update_support_case(jsonb, uuid, text, uuid, text, text), trustwork.admin_requester_update_case(uuid, text),
  trustwork.admin_add_case_note(jsonb, uuid, text, text), trustwork.admin_add_requester_note(uuid, text),
  trustwork.admin_request_case_grant(jsonb, uuid, text, uuid[], text, text, interval, text), trustwork.admin_decide_case_grant(jsonb, uuid, text, text),
  trustwork.admin_revoke_case_grant(jsonb, uuid), trustwork.admin_case_grant_covers(text, uuid), trustwork.admin_may_log_access(uuid, text, uuid),
  trustwork.admin_case_evidence(uuid, uuid, text)
  TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
