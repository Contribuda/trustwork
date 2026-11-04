-- PRV-001 audit fix: an invitation names a person by address (staff_invitation.email_normalized), and a subject export
-- left it out. staff_invitations_of_self gives the signed-in person the invitations they answered and the unanswered ones
-- addressed to a verified address of theirs, so the export can include them under the person's own authority. An
-- invitation someone else answered stays that person's, even if the address has since passed on. The staff member's
-- free-text reason and who invited are staff records and are not part of it.
--
-- What this does not do: remove the address after erasure. staff_invitation_guard keeps the address immutable and no row
-- is ever deleted, and this release has no subject-erasure executor to run such a change under a reviewed plan
-- (docs/data/privacy-operations.md). That redaction belongs to the executor's owning-module adapter.

CREATE FUNCTION trustwork.staff_invitations_of_self()
RETURNS TABLE (id uuid, email_normalized text, role text, scope_kind text, node_id uuid, hub_id uuid, status text, expires_at timestamptz, responded_at timestamptz, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT i.id, i.email_normalized, i.role, i.scope_kind, i.node_id, i.hub_id, i.status, i.expires_at, i.responded_at, i.created_at
    FROM trustwork.staff_invitation i
   WHERE i.person_id = trustwork.current_person_id()
      OR (i.person_id IS NULL AND EXISTS (SELECT 1 FROM trustwork.email_binding b WHERE b.person_id = trustwork.current_person_id() AND b.email_normalized = i.email_normalized AND b.verified_at IS NOT NULL))
   ORDER BY i.created_at, i.id
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.staff_invitations_of_self() TO trustwork_app;
