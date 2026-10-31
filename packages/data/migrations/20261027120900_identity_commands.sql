-- BE-001 identity commands that must run atomically as the owner because the runtime role cannot touch other
-- people's rows under FORCE RLS: membership end with its revocation sequence, ownership transfer completion with
-- owner-row re-materialisation, Google verified-e-mail claim of an unverified binding, lockout helpers, and the
-- membership invitation token kind.

-- Invitation tokens reuse auth_token (hash at rest, single use through auth_consume_token).
ALTER TABLE trustwork.auth_token DROP CONSTRAINT auth_token_kind_check;
ALTER TABLE trustwork.auth_token ADD CONSTRAINT auth_token_kind_check CHECK (kind IN ('verify_email', 'email_change', 'recovery', 'membership_invitation'));

-- Failure count inside a window without recording a new failure (pre-check before verifying a password).
CREATE FUNCTION trustwork.auth_login_failure_count(p_subject_hash bytea, p_window interval) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT count(*)::integer FROM trustwork.login_failure WHERE subject_hash = p_subject_hash AND occurred_at >= now() - p_window
$$;

-- H03 hard lockout: disables the password credential bound to an e-mail until recovery sets a new password.
CREATE FUNCTION trustwork.auth_disable_password(p_email_normalized text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE trustwork.credential c SET disabled_at = now()
  FROM trustwork.email_binding b
  WHERE b.email_normalized = p_email_normalized AND c.person_id = b.person_id AND c.kind = 'password' AND c.disabled_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END $$;

-- H06: a Google identity with email_verified = true may claim an address that only has an UNVERIFIED binding.
-- A new person is created for the subject; the unverified person's binding, outstanding tokens, sessions and
-- password login are invalidated (pre-hijack defence T02). Returns NULL when the address is verified, unbound or
-- the subject is already linked (the caller then follows the ordinary rules).
CREATE FUNCTION trustwork.auth_claim_unverified_binding(p_display_name text, p_email_normalized text, p_provider text, p_provider_subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_binding trustwork.email_binding;
  v_person uuid;
BEGIN
  SELECT * INTO v_binding FROM trustwork.email_binding WHERE email_normalized = p_email_normalized FOR UPDATE;
  IF v_binding.id IS NULL OR v_binding.verified_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.credential WHERE provider = p_provider AND provider_subject = p_provider_subject) THEN
    RETURN NULL;
  END IF;
  DELETE FROM trustwork.email_binding WHERE id = v_binding.id;
  UPDATE trustwork.credential SET disabled_at = now() WHERE person_id = v_binding.person_id AND disabled_at IS NULL;
  UPDATE trustwork.auth_token SET consumed_at = now() WHERE person_id = v_binding.person_id AND consumed_at IS NULL;
  UPDATE trustwork.session SET revoked_at = now(), revoked_reason = 'suspicious' WHERE person_id = v_binding.person_id AND revoked_at IS NULL;
  INSERT INTO trustwork.person (display_name) VALUES (p_display_name) RETURNING id INTO v_person;
  INSERT INTO trustwork.email_binding (person_id, email_normalized, is_primary, verified_at) VALUES (v_person, p_email_normalized, true, now());
  INSERT INTO trustwork.credential (person_id, kind, provider, provider_subject) VALUES (v_person, p_provider, p_provider, p_provider_subject);
  RETURN v_person;
EXCEPTION WHEN unique_violation THEN
  RETURN NULL;
END $$;

-- Membership end with the revocation sequence of the access policy (section 6) in one statement context:
-- the row is ended with actor and reason (epochs bump through the existing trigger), the person's company-derived
-- participations and company-scoped permission grants are revoked and the person's admission scope is revoked.
-- Authority: the member themself, or a colleague of the active employer holding company.members.manage; the last
-- active administrator of a company cannot be ended.
CREATE FUNCTION trustwork.end_membership(p_membership_id uuid, p_reason text)
RETURNS TABLE (membership_id uuid, person_id uuid, company_id uuid, revision integer, revoked_participations integer, revoked_grants integer, admission_epoch bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor uuid := trustwork.current_person_id();
  v_m trustwork.membership;
  v_self boolean;
  v_manager boolean;
  v_participations integer;
  v_grants integer;
  v_epoch bigint;
  v_revision integer;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'membership end requires a verified identity' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  SELECT * INTO v_m FROM trustwork.membership m WHERE m.id = p_membership_id FOR UPDATE;
  IF v_m.id IS NULL OR v_m.status <> 'active' THEN
    RAISE EXCEPTION 'membership % is not active', p_membership_id USING ERRCODE = 'integrity_constraint_violation', HINT = 'membership.ended';
  END IF;
  v_self := v_m.person_id = v_actor;
  v_manager := NOT v_self AND v_m.company_id = trustwork.current_company_id() AND trustwork.current_membership_has('company.members.manage');
  IF NOT (v_self OR v_manager) THEN
    RAISE EXCEPTION 'membership % may be ended by the member or a member manager only', p_membership_id USING ERRCODE = 'integrity_constraint_violation', HINT = 'membership.permission_missing';
  END IF;
  IF v_m.role = 'administrator' AND NOT EXISTS (
    SELECT 1 FROM trustwork.membership o WHERE o.company_id = v_m.company_id AND o.id <> v_m.id AND o.status = 'active' AND o.role = 'administrator'
  ) THEN
    RAISE EXCEPTION 'membership % is the last administrator of the company', p_membership_id USING ERRCODE = 'integrity_constraint_violation', HINT = 'membership.last_administrator';
  END IF;
  UPDATE trustwork.membership SET status = 'ended', ended_at = now(), ended_by = v_actor, ended_reason = p_reason
  WHERE id = v_m.id RETURNING trustwork.membership.revision INTO v_revision;
  UPDATE trustwork.object_participation SET revoked_at = now(), revoked_reason = 'membership ended'
  WHERE party_person_id = v_m.person_id AND on_behalf_of_company_id = v_m.company_id AND revoked_at IS NULL;
  GET DIAGNOSTICS v_participations = ROW_COUNT;
  UPDATE trustwork.permission_grant SET revoked_at = now(), revoked_reason = 'membership ended'
  WHERE principal_person_id = v_m.person_id AND (scope ->> 'companyId') = v_m.company_id::text AND revoked_at IS NULL;
  GET DIAGNOSTICS v_grants = ROW_COUNT;
  v_epoch := trustwork.admission_revoke('person:' || v_m.person_id::text, 'membership ended');
  RETURN QUERY SELECT v_m.id, v_m.person_id, v_m.company_id, v_revision, v_participations, v_grants, v_epoch;
END $$;

-- Ownership transfer completion: applies the accepted transfer (owner check, consent and expiry inside
-- apply_ownership_transfer), revokes the previous owner row and materialises the new owner's row.
CREATE FUNCTION trustwork.finalize_ownership_transfer(p_transfer_id uuid) RETURNS trustwork.project
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor uuid := trustwork.current_person_id();
  v_project trustwork.project;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'transfer completion requires a verified identity' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  v_project := trustwork.apply_ownership_transfer(p_transfer_id);
  UPDATE trustwork.object_participation SET revoked_at = now(), revoked_reason = 'ownership transferred'
  WHERE resource_kind = 'project' AND resource_id = v_project.id AND side = 'owner' AND revoked_at IS NULL;
  INSERT INTO trustwork.object_participation (resource_kind, resource_id, party_person_id, party_company_id, side, capabilities, audience, granted_by_person_id)
  VALUES ('project', v_project.id, v_project.owner_person_id, v_project.owner_company_id, 'owner',
    ARRAY['read.shared', 'read.party_private', 'read.owner_private', 'write.draft', 'publish', 'invite', 'negotiate', 'accept', 'commit_order', 'manage_participants', 'transfer_ownership', 'lead', 'export']::text[],
    'owner_private', v_actor);
  RETURN v_project;
END $$;

GRANT EXECUTE ON FUNCTION
  trustwork.auth_login_failure_count(bytea, interval),
  trustwork.auth_disable_password(text),
  trustwork.auth_claim_unverified_binding(text, text, text, text),
  trustwork.end_membership(uuid, text),
  trustwork.finalize_ownership_transfer(uuid)
TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
