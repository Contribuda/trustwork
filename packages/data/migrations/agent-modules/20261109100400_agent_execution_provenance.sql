-- AGT-003 / AST-001: immutable serving provenance for conversational runs and their exact mandate uses.
-- No existing run, intent or signed mandate is backfilled from a process default.
CREATE TABLE trustwork.agent_run_provenance (
  run_id uuid PRIMARY KEY REFERENCES trustwork.run(id),
  principal_person_id uuid NOT NULL REFERENCES trustwork.person(id),
  hub_id uuid NOT NULL REFERENCES trustwork.hub(id),
  serving_binding_id uuid REFERENCES trustwork.agent_serving_hub(id),
  session_id uuid REFERENCES trustwork.session(id),
  occurrence_id uuid UNIQUE REFERENCES trustwork.agent_job_occurrence(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((serving_binding_id IS NOT NULL AND session_id IS NOT NULL AND occurrence_id IS NULL)
    OR (serving_binding_id IS NULL AND session_id IS NULL AND occurrence_id IS NOT NULL))
);
CREATE TABLE trustwork.agent_intent_provenance (
  action_intent_id uuid PRIMARY KEY REFERENCES trustwork.action_intent(id),
  run_id uuid NOT NULL REFERENCES trustwork.agent_run_provenance(run_id),
  principal_person_id uuid NOT NULL REFERENCES trustwork.person(id),
  hub_id uuid NOT NULL REFERENCES trustwork.hub(id),
  mandate_id uuid NOT NULL REFERENCES trustwork.mandate(id),
  mandate_revision integer NOT NULL CHECK (mandate_revision > 0),
  mandate_digest text NOT NULL CHECK (mandate_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE trustwork.agent_run_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_run_provenance FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_intent_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_intent_provenance FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.agent_run_provenance TO trustwork_owner
  USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.agent_intent_provenance TO trustwork_owner
  USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY run_provenance_owner ON trustwork.agent_run_provenance FOR SELECT TO trustwork_app
  USING (principal_person_id = trustwork.current_person_id());
CREATE POLICY intent_provenance_owner ON trustwork.agent_intent_provenance FOR SELECT TO trustwork_app
  USING (principal_person_id = trustwork.current_person_id());
GRANT SELECT ON trustwork.agent_run_provenance,trustwork.agent_intent_provenance TO trustwork_app;
CREATE TRIGGER run_provenance_append_only BEFORE UPDATE OR DELETE ON trustwork.agent_run_provenance
  FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER intent_provenance_append_only BEFORE UPDATE OR DELETE ON trustwork.agent_intent_provenance
  FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

CREATE FUNCTION trustwork.agent_modules_bind_run(p_run uuid,p_binding uuid,p_session uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE r trustwork.run%ROWTYPE; b trustwork.agent_serving_hub%ROWTYPE;
BEGIN
  SELECT * INTO r FROM trustwork.run WHERE id = p_run;
  SELECT * INTO b FROM trustwork.agent_serving_hub WHERE id = p_binding AND active;
  IF r.id IS NULL OR b.id IS NULL OR r.principal_person_id IS DISTINCT FROM trustwork.current_person_id()
    OR r.created_at < transaction_timestamp() OR r.state NOT IN ('queued','running')
    OR EXISTS (SELECT 1 FROM trustwork.action_intent WHERE run_id = r.id)
    OR NOT EXISTS (SELECT 1 FROM trustwork.session WHERE id = p_session AND person_id = r.principal_person_id
      AND revoked_at IS NULL AND idle_expires_at > clock_timestamp() AND absolute_expires_at > clock_timestamp()) THEN
    RAISE EXCEPTION 'new run serving provenance unavailable' USING ERRCODE = '42501', HINT = 'agents.hub_provenance_unavailable';
  END IF;
  PERFORM trustwork.agent_modules_lock_epochs(b.hub_id,NULL,r.principal_person_id,NULL);
  IF NOT EXISTS (SELECT 1 FROM trustwork.agent_serving_hub WHERE id = b.id AND active) THEN
    RAISE EXCEPTION 'serving binding withdrawn' USING ERRCODE = '42501', HINT = 'agents.hub_provenance_unavailable';
  END IF;
  INSERT INTO trustwork.agent_run_provenance(run_id,principal_person_id,hub_id,serving_binding_id,session_id)
    VALUES(r.id,r.principal_person_id,b.hub_id,b.id,p_session);
  RETURN b.hub_id;
END $$;

CREATE FUNCTION trustwork.agent_modules_occurrence_run_provenance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF OLD.run_id IS NULL AND NEW.run_id IS NOT NULL THEN
    INSERT INTO trustwork.agent_run_provenance(run_id,principal_person_id,hub_id,occurrence_id)
      VALUES(NEW.run_id,NEW.principal_person_id,NEW.hub_id,NEW.id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER agent_occurrence_run_provenance AFTER UPDATE OF run_id ON trustwork.agent_job_occurrence
  FOR EACH ROW EXECUTE FUNCTION trustwork.agent_modules_occurrence_run_provenance();

CREATE FUNCTION trustwork.agent_modules_intent_provenance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  INSERT INTO trustwork.agent_intent_provenance(action_intent_id,run_id,principal_person_id,hub_id,mandate_id,mandate_revision,mandate_digest)
    SELECT NEW.id,p.run_id,p.principal_person_id,p.hub_id,m.id,m.revision,m.digest
    FROM trustwork.agent_run_provenance p JOIN trustwork.mandate m ON m.id = NEW.mandate_id
    WHERE p.run_id = NEW.run_id AND p.principal_person_id = NEW.principal_person_id
      AND m.principal_person_id = NEW.principal_person_id AND m.revision = NEW.mandate_revision AND m.digest IS NOT NULL;
  RETURN NULL;
END $$;
CREATE TRIGGER agent_intent_provenance AFTER INSERT ON trustwork.action_intent
  FOR EACH ROW EXECUTE FUNCTION trustwork.agent_modules_intent_provenance();
REVOKE ALL ON FUNCTION trustwork.agent_modules_bind_run(uuid,uuid,uuid),trustwork.agent_modules_occurrence_run_provenance(),
  trustwork.agent_modules_intent_provenance() FROM PUBLIC,trustwork_app,trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.agent_modules_bind_run(uuid,uuid,uuid) TO trustwork_app;

-- Preserve the accepted attempt/accounting implementation behind a narrow provenance boundary.
-- Reconciliation/receipt functions are unchanged: old unknown operations retain their original identity and holds.
ALTER FUNCTION trustwork.assistant_begin_attempt(uuid,uuid,uuid) RENAME TO agent_modules_begin_proven_attempt;
REVOKE ALL ON FUNCTION trustwork.agent_modules_begin_proven_attempt(uuid,uuid,uuid) FROM PUBLIC,trustwork_app,trustwork_worker;
CREATE FUNCTION trustwork.assistant_begin_attempt(p_intent_id uuid,p_job_id uuid,p_hub_id uuid,p_fencing_token bigint) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE p trustwork.agent_intent_provenance%ROWTYPE; i trustwork.action_intent%ROWTYPE; j trustwork.job%ROWTYPE;
BEGIN
  SELECT * INTO j FROM trustwork.job WHERE id = p_job_id FOR UPDATE;
  IF j.id IS NULL OR j.kind <> 'assistant.dispatch' OR j.state <> 'leased' OR j.leased_until <= clock_timestamp()
    OR j.fencing_token IS DISTINCT FROM p_fencing_token OR j.payload ->> 'intentId' IS DISTINCT FROM p_intent_id::text THEN
    RAISE EXCEPTION 'dispatch lease unavailable' USING ERRCODE = '55P03', HINT = 'assistant.fenced_out';
  END IF;
  SELECT * INTO p FROM trustwork.agent_intent_provenance WHERE action_intent_id = p_intent_id;
  IF p.action_intent_id IS NOT NULL THEN
    PERFORM trustwork.agent_modules_lock_epochs(p.hub_id,NULL,p.principal_person_id,NULL);
  END IF;
  IF p.action_intent_id IS NULL OR (p_hub_id IS NOT NULL AND p_hub_id IS DISTINCT FROM p.hub_id)
    OR NOT EXISTS (SELECT 1 FROM trustwork.agent_run_provenance r JOIN trustwork.agent_serving_hub b ON b.id = r.serving_binding_id
      WHERE r.run_id = p.run_id AND b.active AND b.hub_id = p.hub_id) THEN
    SELECT * INTO i FROM trustwork.action_intent WHERE id = p_intent_id FOR UPDATE;
    -- Never cancel or release an uncertain original operation while deciding whether fresh dispatch is allowed.
    IF i.state = 'queued' THEN
      PERFORM trustwork.assistant_finish_intent(i.id,'revoked','recheck: hub_provenance_unavailable','recheck:hub_provenance_unavailable');
      RETURN jsonb_build_object('status','refused','reason','hub_provenance_unavailable');
    END IF;
    RETURN jsonb_build_object('status','skip','state',coalesce(i.state,'missing'));
  END IF;
  RETURN trustwork.agent_modules_begin_proven_attempt(p_intent_id,p_job_id,p.hub_id);
END $$;
REVOKE ALL ON FUNCTION trustwork.assistant_begin_attempt(uuid,uuid,uuid,bigint) FROM PUBLIC,trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.assistant_begin_attempt(uuid,uuid,uuid,bigint) TO trustwork_worker;

-- Proven hub A intents cannot be fenced by hub B. Legacy unknowns retain conservative fencing.
CREATE OR REPLACE FUNCTION trustwork.agent_modules_on_kill_switch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_intents uuid[];
BEGIN
  IF NEW.scope_kind NOT IN ('node','hub_agent_dispatch','agent_module','agent_capability','agent_action','external_agent_api','outbound_messages') THEN RETURN NULL; END IF;
  IF NEW.scope_kind = 'node' THEN PERFORM trustwork.agent_modules_bump('node',NEW.node_id);
  ELSE PERFORM trustwork.agent_modules_bump('hub',NEW.hub_id); END IF;
  IF TG_OP = 'INSERT' AND NEW.state = 'engaged' THEN
    SELECT coalesce(array_agg(i.id),ARRAY[]::uuid[]) INTO v_intents FROM trustwork.action_intent i
      LEFT JOIN trustwork.agent_intent_provenance p ON p.action_intent_id = i.id
      WHERE i.state IN ('executing','pending') AND (NEW.scope_kind = 'node' OR p.hub_id = NEW.hub_id OR p.hub_id IS NULL)
      AND CASE NEW.scope_kind
        WHEN 'node' THEN true WHEN 'hub_agent_dispatch' THEN true
        WHEN 'agent_module' THEN i.module_key = NEW.module_key WHEN 'agent_capability' THEN i.capability_id = NEW.capability_id
        WHEN 'agent_action' THEN i.action = NEW.action
        WHEN 'external_agent_api' THEN EXISTS (SELECT 1 FROM trustwork.connection_call c WHERE c.action_intent_id = i.id)
        ELSE i.action IN ('communicate','send_quote','negotiate','introduce','schedule') END;
    PERFORM trustwork.agent_modules_fence(v_intents);
  END IF;
  RETURN NULL;
END $$;

-- A participant/staff SQL caller cannot use the shared gate as another person's private stop-status oracle.
ALTER FUNCTION trustwork.agent_modules_dispatch_refusal(uuid,text,text,text,uuid,uuid,uuid) RENAME TO agent_modules_dispatch_refusal_internal;
REVOKE ALL ON FUNCTION trustwork.agent_modules_dispatch_refusal_internal(uuid,text,text,text,uuid,uuid,uuid) FROM PUBLIC,trustwork_app,trustwork_worker;
CREATE FUNCTION trustwork.agent_modules_dispatch_refusal(p_hub uuid,p_module_key text,p_capability_id text,p_action text,p_person uuid,p_connection uuid,p_representative_of uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF pg_has_role(session_user,'trustwork_app','member') AND p_person IS DISTINCT FROM trustwork.current_person_id() THEN
    RAISE EXCEPTION 'another principal is not a gate input' USING ERRCODE = '42501', HINT = 'access.not_found';
  END IF;
  RETURN trustwork.agent_modules_dispatch_refusal_internal(p_hub,p_module_key,p_capability_id,p_action,p_person,p_connection,p_representative_of);
END $$;
REVOKE ALL ON FUNCTION trustwork.agent_modules_dispatch_refusal(uuid,text,text,text,uuid,uuid,uuid) FROM PUBLIC,trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.agent_modules_dispatch_refusal(uuid,text,text,text,uuid,uuid,uuid) TO trustwork_app;
