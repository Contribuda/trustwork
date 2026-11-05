-- HUBC-007: `verification_recipe_enabled` asked for an active `verification` configuration version, with any payload, and so
-- said nothing about verification: an activated recipe left it open and an empty version closed it. It now reads the recipes
-- themselves, through the verification module's own reader. Only that branch changes.
CREATE OR REPLACE FUNCTION trustwork.hubs_gate_precondition(p_hub uuid, p_gate text) RETURNS boolean
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
    WHEN 'verification_recipe_enabled' THEN
      RETURN trustwork.verification_has_active_recipe(p_hub);
    WHEN 'sanctions_screening_configured' THEN
      RETURN trustwork.hubs_active_payload(p_hub, 'screening') IS NOT NULL AND trustwork.attestation_in_force(now());
    WHEN 'demo_data_purged' THEN
      v_modes := trustwork.hubs_active_payload(p_hub, 'modes');
      RETURN v_modes IS NOT NULL AND v_modes ->> 'dataMode' = 'live';
    WHEN 'ai_egress_policy_reviewed' THEN RETURN trustwork.hubs_active_payload(p_hub, 'egress') IS NOT NULL;
    ELSE RETURN p_gate = ANY (trustwork.hubs_launch_gates());
  END CASE;
END $$;

-- The gates live here, so another module asks this one to re-open a gate. It runs inside that module's command, which has
-- authorized the actor and writes the audit row; it is not granted to any role.
CREATE FUNCTION trustwork.hubs_reopen_gate(p_hub uuid, p_gate text, p_reason text) RETURNS void
LANGUAGE sql SET search_path = trustwork, pg_temp AS $$
  UPDATE trustwork.launch_gate SET state = 'invalidated', invalidation_reason = p_reason WHERE hub_id = p_hub AND gate = p_gate AND state = 'passed';
$$;
REVOKE EXECUTE ON FUNCTION trustwork.hubs_reopen_gate(uuid, text, text) FROM PUBLIC;
