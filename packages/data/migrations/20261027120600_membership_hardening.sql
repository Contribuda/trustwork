-- DATA-001 second review round (PR #13): membership activation/invitation authority, ownership transfer through a
-- definer, company verification columns and parked job states reserved for maintenance/reconciliation.

-- Membership permission of the current principal in the active employer (the setter already derived the company).
CREATE FUNCTION trustwork.current_membership_has(p_permission text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND trustwork.current_company_id() IS NOT NULL AND EXISTS (
    SELECT 1 FROM trustwork.membership m
    WHERE m.person_id = trustwork.current_person_id() AND m.company_id = trustwork.current_company_id()
      AND m.status = 'active' AND m.valid_from <= now() AND p_permission = ANY (m.permissions)
  )
$$;
GRANT EXECUTE ON FUNCTION trustwork.current_membership_has(text) TO trustwork_app;

-- P1-R2: the employer branch never targets oneself and requires company.members.manage.
DROP POLICY membership_insert ON trustwork.membership;
CREATE POLICY membership_insert ON trustwork.membership FOR INSERT TO trustwork_app
  WITH CHECK (
    (person_id = trustwork.current_person_id() AND status = 'invited' AND role = 'member' AND permissions = '{}'::text[] AND invited_by IS NULL)
    OR (
      company_id = trustwork.current_company_id()
      AND invited_by = trustwork.current_person_id()
      AND person_id <> trustwork.current_person_id()
      AND status = 'invited'
      AND trustwork.current_membership_has('company.members.manage')
    )
  );

-- P1-R1: activation authority. An invitation is accepted by the invitee; a self-request is approved by a colleague
-- holding company.members.manage. Role/permission changes also require that permission.
CREATE OR REPLACE FUNCTION trustwork.membership_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.person_id <> OLD.person_id OR NEW.company_id <> OLD.company_id OR NEW.invited_by IS DISTINCT FROM OLD.invited_by THEN
    RAISE EXCEPTION 'membership % cannot be reassigned to another person, company or inviter', OLD.id
      USING ERRCODE = 'integrity_constraint_violation', HINT = 'membership.immutable_parties';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT (
      (OLD.status = 'invited' AND NEW.status IN ('active', 'declined', 'expired', 'withdrawn'))
      OR (OLD.status = 'active' AND NEW.status = 'ended')
    ) THEN
      RAISE EXCEPTION 'membership transition % -> % is not allowed', OLD.status, NEW.status
        USING ERRCODE = 'integrity_constraint_violation', HINT = 'membership.invalid_transition';
    END IF;
  END IF;
  IF OLD.status = 'invited' AND NEW.status = 'active' AND NOT trustwork.in_maintenance()
     AND NOT coalesce(
       (OLD.invited_by IS NOT NULL AND OLD.person_id = trustwork.current_person_id())
       OR (OLD.invited_by IS NULL AND OLD.company_id = trustwork.current_company_id() AND OLD.person_id <> trustwork.current_person_id()
           AND trustwork.current_membership_has('company.members.manage')),
       false) THEN
    RAISE EXCEPTION 'membership % activation is not authorised for the current principal', OLD.id
      USING ERRCODE = 'integrity_constraint_violation', HINT = 'membership.activation_not_authorised';
  END IF;
  IF (NEW.role <> OLD.role OR NEW.permissions <> OLD.permissions)
     AND NOT trustwork.in_maintenance()
     AND NOT coalesce(OLD.company_id = trustwork.current_company_id() AND OLD.person_id <> trustwork.current_person_id()
                      AND trustwork.current_membership_has('company.members.manage'), false) THEN
    RAISE EXCEPTION 'membership % role or permissions may only be changed by a member manager of the company', OLD.id
      USING ERRCODE = 'integrity_constraint_violation', HINT = 'membership.self_promotion';
  END IF;
  RETURN NEW;
END $$;

-- P2-R1b: verification status and verified domains are set only by maintenance/administration (DATA-002/ADM).
REVOKE UPDATE (claim_status, verified_domains) ON trustwork.company FROM trustwork_app;

-- P2-R4: ownership changes only through an accepted transfer applied by the current owner.
REVOKE UPDATE (owner_person_id, owner_company_id) ON trustwork.project FROM trustwork_app;

ALTER TABLE trustwork.ownership_transfer ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.ownership_transfer FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.ownership_transfer AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
-- Both parties of a transfer (and managers of the project) see it; only the current owner proposes it.
CREATE POLICY ownership_transfer_read ON trustwork.ownership_transfer FOR SELECT TO trustwork_app
  USING (
    from_person_id = trustwork.current_person_id() OR from_company_id = trustwork.current_company_id()
    OR to_person_id = trustwork.current_person_id() OR to_company_id = trustwork.current_company_id()
    OR trustwork.can_manage_resource('project', project_id)
  );
CREATE POLICY ownership_transfer_insert ON trustwork.ownership_transfer FOR INSERT TO trustwork_app
  WITH CHECK (
    proposed_by = trustwork.current_person_id()
    AND trustwork.owns_resource('project', project_id)
    AND (from_person_id = trustwork.current_person_id() OR from_company_id = trustwork.current_company_id())
  );
CREATE POLICY ownership_transfer_update ON trustwork.ownership_transfer FOR UPDATE TO trustwork_app
  USING (
    from_person_id = trustwork.current_person_id() OR from_company_id = trustwork.current_company_id()
    OR to_person_id = trustwork.current_person_id() OR to_company_id = trustwork.current_company_id()
  )
  WITH CHECK (true);
-- Who may drive which transition: the recipient consents or rejects, the proposer withdraws, maintenance expires,
-- and `effective` happens only inside apply_ownership_transfer (maintenance context).
CREATE OR REPLACE FUNCTION trustwork.ownership_transfer_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_is_recipient boolean := coalesce(OLD.to_person_id = trustwork.current_person_id() OR OLD.to_company_id = trustwork.current_company_id(), false);
  v_is_proposer boolean := coalesce(OLD.from_person_id = trustwork.current_person_id() OR OLD.from_company_id = trustwork.current_company_id(), false);
BEGIN
  IF NEW.project_id <> OLD.project_id OR NEW.from_person_id IS DISTINCT FROM OLD.from_person_id OR NEW.from_company_id IS DISTINCT FROM OLD.from_company_id
     OR NEW.to_person_id IS DISTINCT FROM OLD.to_person_id OR NEW.to_company_id IS DISTINCT FROM OLD.to_company_id OR NEW.proposed_by <> OLD.proposed_by THEN
    RAISE EXCEPTION 'ownership transfer % parties are immutable', OLD.id USING ERRCODE = 'integrity_constraint_violation', HINT = 'projects.transfer_immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'proposed' AND NEW.status IN ('accepted_by_recipient', 'rejected', 'expired', 'withdrawn'))
    OR (OLD.status = 'accepted_by_recipient' AND NEW.status IN ('effective', 'expired', 'withdrawn'))
  ) THEN
    RAISE EXCEPTION 'ownership transfer transition % -> % is not allowed', OLD.status, NEW.status
      USING ERRCODE = 'integrity_constraint_violation', HINT = 'projects.invalid_transfer_transition';
  END IF;
  IF NEW.status <> OLD.status AND NOT trustwork.in_maintenance() THEN
    IF NEW.status IN ('accepted_by_recipient', 'rejected') AND NOT v_is_recipient THEN
      RAISE EXCEPTION 'only the recipient may consent to or reject transfer %', OLD.id USING ERRCODE = 'integrity_constraint_violation', HINT = 'projects.transfer_consent_not_recipient';
    END IF;
    IF NEW.status = 'withdrawn' AND NOT v_is_proposer THEN
      RAISE EXCEPTION 'only the proposer may withdraw transfer %', OLD.id USING ERRCODE = 'integrity_constraint_violation', HINT = 'projects.transfer_withdraw_not_proposer';
    END IF;
    IF NEW.status IN ('effective', 'expired') THEN
      RAISE EXCEPTION 'transfer % becomes % only through apply_ownership_transfer or maintenance', OLD.id, NEW.status
        USING ERRCODE = 'integrity_constraint_violation', HINT = 'projects.transfer_apply_required';
    END IF;
  END IF;
  IF NEW.status = 'accepted_by_recipient' AND NEW.recipient_consent_at IS NULL THEN
    NEW.recipient_consent_at := now();
  END IF;
  RETURN NEW;
END $$;

-- Applies an accepted, unexpired transfer when the caller currently owns the project: moves ownership (XOR) and
-- marks the transfer effective in the same statement context. Raises 23000 otherwise.
CREATE FUNCTION trustwork.apply_ownership_transfer(p_transfer_id uuid) RETURNS trustwork.project
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_transfer trustwork.ownership_transfer;
  v_project trustwork.project;
BEGIN
  SELECT * INTO v_transfer FROM trustwork.ownership_transfer WHERE id = p_transfer_id FOR UPDATE;
  IF v_transfer.id IS NULL OR NOT trustwork.owns_resource('project', v_transfer.project_id) THEN
    RAISE EXCEPTION 'transfer % is not applicable by the current principal', p_transfer_id
      USING ERRCODE = 'integrity_constraint_violation', HINT = 'projects.transfer_not_authorised';
  END IF;
  IF v_transfer.status <> 'accepted_by_recipient' OR v_transfer.recipient_consent_at IS NULL THEN
    RAISE EXCEPTION 'transfer % has no recipient consent (status %)', p_transfer_id, v_transfer.status
      USING ERRCODE = 'integrity_constraint_violation', HINT = 'projects.transfer_consent_required';
  END IF;
  IF v_transfer.expires_at <= now() THEN
    UPDATE trustwork.ownership_transfer SET status = 'expired' WHERE id = p_transfer_id;
    RAISE EXCEPTION 'transfer % expired', p_transfer_id USING ERRCODE = 'integrity_constraint_violation', HINT = 'projects.transfer_expired';
  END IF;
  UPDATE trustwork.project
  SET owner_person_id = v_transfer.to_person_id, owner_company_id = v_transfer.to_company_id
  WHERE id = v_transfer.project_id
  RETURNING * INTO v_project;
  UPDATE trustwork.ownership_transfer SET status = 'effective', effective_at = now() WHERE id = p_transfer_id;
  RETURN v_project;
END $$;
GRANT EXECUTE ON FUNCTION trustwork.apply_ownership_transfer(uuid) TO trustwork_app;

-- P3: parked or terminal jobs leave their state only through reconciliation (or maintenance).
CREATE FUNCTION trustwork.job_state_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('outcome_unknown', 'succeeded', 'dead') AND NEW.state <> OLD.state AND NOT trustwork.in_maintenance() THEN
    RAISE EXCEPTION 'job % in state % requires reconciliation', OLD.id, OLD.state
      USING ERRCODE = 'integrity_constraint_violation', HINT = 'job.reconciliation_required';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER job_state_guard BEFORE UPDATE ON trustwork.job FOR EACH ROW EXECUTE FUNCTION trustwork.job_state_guard();

-- Reconciliation port: a parked job is resolved with final evidence (a Reconciliation record reference).
CREATE FUNCTION trustwork.reconcile_job(p_job_id uuid, p_outcome text, p_reconciliation_ref text) RETURNS trustwork.job
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_job trustwork.job;
BEGIN
  IF p_reconciliation_ref IS NULL OR length(p_reconciliation_ref) = 0 THEN
    RAISE EXCEPTION 'reconciliation requires a reference' USING ERRCODE = 'integrity_constraint_violation', HINT = 'job.reconciliation_reference_required';
  END IF;
  IF p_outcome NOT IN ('succeeded', 'failed', 'queued') THEN
    RAISE EXCEPTION 'unknown reconciliation outcome %', p_outcome USING ERRCODE = 'integrity_constraint_violation', HINT = 'job.reconciliation_outcome';
  END IF;
  UPDATE trustwork.job
  SET state = CASE p_outcome WHEN 'succeeded' THEN 'succeeded' WHEN 'failed' THEN 'dead' ELSE 'queued' END,
      next_at = CASE WHEN p_outcome = 'queued' THEN now() ELSE next_at END,
      last_error = 'reconciled: ' || p_reconciliation_ref,
      updated_at = clock_timestamp()
  WHERE id = p_job_id AND state = 'outcome_unknown'
  RETURNING * INTO v_job;
  IF v_job.id IS NULL THEN
    RAISE EXCEPTION 'job % is not awaiting reconciliation', p_job_id USING ERRCODE = 'integrity_constraint_violation', HINT = 'job.not_parked';
  END IF;
  RETURN v_job;
END $$;
GRANT EXECUTE ON FUNCTION trustwork.reconcile_job(uuid, text, text) TO trustwork_app;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
