-- AGT-003 / AST-001: explicit serving registrations and immutable usage provenance.
-- No legacy hub value is promoted to trusted provenance and no signed mandate is rewritten.
CREATE TABLE trustwork.agent_serving_hub (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  origin text NOT NULL UNIQUE CHECK (origin ~ '^https?://[^/?#@]+$' AND length(origin) <= 300),
  hub_id uuid NOT NULL REFERENCES trustwork.hub(id),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE trustwork.agent_serving_hub ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_serving_hub FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.agent_serving_hub TO trustwork_owner
  USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY serving_registration_read ON trustwork.agent_serving_hub FOR SELECT TO trustwork_app
  USING (trustwork.current_person_id() IS NOT NULL);
GRANT SELECT ON trustwork.agent_serving_hub TO trustwork_app;

CREATE FUNCTION trustwork.agent_modules_serving_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR ROW(NEW.id, NEW.origin, NEW.hub_id, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.origin, OLD.hub_id, OLD.created_at) THEN
    RAISE EXCEPTION 'serving registrations keep their routing identity' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  PERFORM trustwork.agent_modules_bump('hub', NEW.hub_id);
  RETURN NEW;
END $$;
CREATE TRIGGER agent_serving_hub_guard BEFORE UPDATE OR DELETE ON trustwork.agent_serving_hub
  FOR EACH ROW EXECUTE FUNCTION trustwork.agent_modules_serving_guard();

CREATE TABLE trustwork.agent_job_provenance (
  job_request_id uuid PRIMARY KEY REFERENCES trustwork.agent_job_request(id),
  principal_person_id uuid NOT NULL REFERENCES trustwork.person(id),
  serving_binding_id uuid NOT NULL REFERENCES trustwork.agent_serving_hub(id),
  hub_id uuid NOT NULL REFERENCES trustwork.hub(id),
  session_id uuid NOT NULL REFERENCES trustwork.session(id),
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE trustwork.agent_job_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_job_provenance FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.agent_job_provenance TO trustwork_owner
  USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY provenance_owner ON trustwork.agent_job_provenance FOR SELECT TO trustwork_app
  USING (principal_person_id = trustwork.current_person_id());
GRANT SELECT ON trustwork.agent_job_provenance TO trustwork_app;
CREATE TRIGGER agent_job_provenance_append_only BEFORE UPDATE OR DELETE ON trustwork.agent_job_provenance
  FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

CREATE FUNCTION trustwork.agent_modules_bind_request(p_request uuid, p_binding uuid, p_session uuid, p_operation uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  r trustwork.agent_job_request%ROWTYPE;
  b trustwork.agent_serving_hub%ROWTYPE;
BEGIN
  SELECT * INTO r FROM trustwork.agent_job_request WHERE id = p_request;
  SELECT * INTO b FROM trustwork.agent_serving_hub WHERE id = p_binding AND active FOR SHARE;
  IF r.id IS NULL OR b.id IS NULL OR r.principal_person_id IS DISTINCT FROM trustwork.current_person_id()
    OR r.status <> 'pending' OR r.hub_id IS DISTINCT FROM b.hub_id OR p_operation IS NULL
    OR NOT EXISTS (SELECT 1 FROM trustwork.idempotency_record i WHERE i.id = p_operation
      AND i.principal_id = r.principal_person_id::text AND i.action = 'agent_modules.job_turn_on' AND i.state = 'in_progress')
    OR NOT EXISTS (SELECT 1 FROM trustwork.session s WHERE s.id = p_session AND s.person_id = r.principal_person_id
      AND s.revoked_at IS NULL AND s.idle_expires_at > clock_timestamp() AND s.absolute_expires_at > clock_timestamp()) THEN
    RAISE EXCEPTION 'request provenance unavailable' USING ERRCODE = 'insufficient_privilege', HINT = 'agents.hub_mismatch';
  END IF;
  INSERT INTO trustwork.agent_job_provenance(job_request_id, principal_person_id, serving_binding_id, hub_id, session_id, operation_id)
    VALUES (r.id, r.principal_person_id, b.id, b.hub_id, p_session, p_operation);
END $$;
REVOKE ALL ON FUNCTION trustwork.agent_modules_serving_guard(), trustwork.agent_modules_bind_request(uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.agent_modules_bind_request(uuid, uuid, uuid, uuid) TO trustwork_app;

CREATE TABLE trustwork.agent_mandate_usage (
  job_request_id uuid PRIMARY KEY REFERENCES trustwork.agent_job_provenance(job_request_id),
  principal_person_id uuid NOT NULL REFERENCES trustwork.person(id),
  hub_id uuid NOT NULL REFERENCES trustwork.hub(id),
  mandate_id uuid NOT NULL REFERENCES trustwork.mandate(id),
  mandate_revision integer NOT NULL CHECK (mandate_revision > 0),
  mandate_digest text NOT NULL CHECK (mandate_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE trustwork.agent_mandate_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_mandate_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.agent_mandate_usage TO trustwork_owner
  USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY usage_owner ON trustwork.agent_mandate_usage FOR SELECT TO trustwork_app
  USING (principal_person_id = trustwork.current_person_id());
GRANT SELECT ON trustwork.agent_mandate_usage TO trustwork_app;
CREATE TRIGGER agent_mandate_usage_append_only BEFORE UPDATE OR DELETE ON trustwork.agent_mandate_usage
  FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

CREATE FUNCTION trustwork.agent_modules_record_usage() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  INSERT INTO trustwork.agent_mandate_usage(job_request_id, principal_person_id, hub_id, mandate_id, mandate_revision, mandate_digest)
    SELECT r.id, r.principal_person_id, p.hub_id, m.id, m.revision, m.digest
    FROM trustwork.agent_job_request r
    JOIN trustwork.agent_job_provenance p ON p.job_request_id = r.id
    JOIN trustwork.agent_serving_hub b ON b.id = p.serving_binding_id AND b.active AND b.hub_id = p.hub_id
    JOIN trustwork.job_subscription s ON s.id = r.job_subscription_id
    JOIN trustwork.mandate m ON m.id = s.mandate_id AND m.principal_person_id = p.principal_person_id
    WHERE r.proposal_id = NEW.id AND r.status = 'active';
  RETURN NULL;
END $$;
-- PostgreSQL orders same-kind triggers by name: the existing jobs trigger creates the confirmed subscription first.
CREATE TRIGGER mandate_proposal_agent_usage AFTER UPDATE OF status ON trustwork.mandate_proposal FOR EACH ROW
  WHEN (OLD.status = 'pending' AND NEW.status = 'confirmed' AND NEW.origin_kind = 'module_template')
  EXECUTE FUNCTION trustwork.agent_modules_record_usage();
REVOKE ALL ON FUNCTION trustwork.agent_modules_record_usage() FROM PUBLIC, trustwork_app, trustwork_worker;
