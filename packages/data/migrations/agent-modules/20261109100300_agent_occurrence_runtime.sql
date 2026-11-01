-- AGT-003 / AST-001 / AGT-001: typed local occurrences, leased runs and the existing private goal report.
-- No provider transport, worker impersonation, arbitrary command or historical replay.
-- Existing schedule slots before this installation, or before a new confirmation, are never caught up.
ALTER TABLE trustwork.agent_job_schedule ADD COLUMN execution_not_before timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE TABLE trustwork.agent_job_occurrence (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  job_subscription_id uuid NOT NULL REFERENCES trustwork.job_subscription(id),
  subscription_revision integer NOT NULL CHECK (subscription_revision > 0),
  job_request_id uuid NOT NULL REFERENCES trustwork.agent_mandate_usage(job_request_id),
  principal_person_id uuid NOT NULL REFERENCES trustwork.person(id),
  hub_id uuid NOT NULL REFERENCES trustwork.hub(id),
  source_kind text NOT NULL CHECK (source_kind IN ('schedule','request','event','goal','deadline')),
  source_key text NOT NULL CHECK (length(source_key) BETWEEN 1 AND 300),
  source jsonb NOT NULL CHECK (jsonb_typeof(source) = 'object'),
  goal_id uuid NOT NULL REFERENCES trustwork.goal(id),
  goal_revision integer NOT NULL CHECK (goal_revision > 0),
  template_version integer NOT NULL CHECK (template_version = 1),
  mandate_id uuid NOT NULL REFERENCES trustwork.mandate(id),
  mandate_revision integer NOT NULL,
  mandate_digest text NOT NULL CHECK (mandate_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','succeeded','refused','cancelled')),
  reason text,
  run_id uuid UNIQUE REFERENCES trustwork.run(id),
  report_id uuid UNIQUE REFERENCES trustwork.agent_report(id),
  worker_job_id uuid REFERENCES trustwork.job(id),
  fencing_token bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  UNIQUE (job_subscription_id, source_key),
  CHECK ((state IN ('succeeded','refused','cancelled')) = (finished_at IS NOT NULL)),
  CHECK (state <> 'succeeded' OR (report_id IS NOT NULL AND run_id IS NOT NULL))
);
ALTER TABLE trustwork.agent_job_occurrence ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_job_occurrence FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.agent_job_occurrence TO trustwork_owner
  USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY occurrence_owner ON trustwork.agent_job_occurrence FOR SELECT TO trustwork_app
  USING (principal_person_id = trustwork.current_person_id());
GRANT SELECT ON trustwork.agent_job_occurrence TO trustwork_app;
CREATE FUNCTION trustwork.agent_modules_occurrence_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.state IN ('succeeded','refused','cancelled')
    OR ROW(NEW.id, NEW.job_subscription_id, NEW.subscription_revision, NEW.job_request_id, NEW.principal_person_id,
      NEW.hub_id, NEW.source_kind, NEW.source_key, NEW.source, NEW.goal_id, NEW.goal_revision, NEW.template_version,
      NEW.mandate_id, NEW.mandate_revision, NEW.mandate_digest, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.job_subscription_id, OLD.subscription_revision, OLD.job_request_id, OLD.principal_person_id,
      OLD.hub_id, OLD.source_kind, OLD.source_key, OLD.source, OLD.goal_id, OLD.goal_revision, OLD.template_version,
      OLD.mandate_id, OLD.mandate_revision, OLD.mandate_digest, OLD.created_at)
    OR (OLD.run_id IS NOT NULL AND NEW.run_id IS DISTINCT FROM OLD.run_id) THEN
    RAISE EXCEPTION 'occurrence authority and terminal results are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_job_occurrence_guard BEFORE UPDATE OR DELETE ON trustwork.agent_job_occurrence
  FOR EACH ROW EXECUTE FUNCTION trustwork.agent_modules_occurrence_guard();

-- The source module's existing private report projection, bounded exactly like goalProgress.list (500 records).
-- Internal: the worker calls this only after deriving the principal and exact goal from a leased occurrence.
CREATE FUNCTION trustwork.agents_goal_report_sections(p_goal uuid, p_person uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE sections jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM trustwork.goal WHERE id = p_goal AND principal_person_id = p_person) THEN
    RAISE EXCEPTION 'goal not found' USING ERRCODE = '42501', HINT = 'access.not_found';
  END IF;
  WITH progress AS (SELECT * FROM trustwork.goal_progress WHERE goal_id = p_goal ORDER BY at, id LIMIT 500),
  kinds AS (SELECT event_kind, count(*) AS n FROM progress GROUP BY event_kind)
  SELECT jsonb_build_array(jsonb_build_object('moduleKey','core','headingKey','agents.report.goalProgress','items',
    coalesce(jsonb_agg(jsonb_build_object('labelKey','agents.report.event.' || k.event_kind,
      'value',jsonb_build_object('kind','count','count',k.n), 'evidenceRefs',
      (SELECT coalesce(jsonb_agg(ref.id), '[]'::jsonb) FROM (SELECT e ->> 'id' AS id FROM progress p,
        jsonb_array_elements(p.evidence_refs) e WHERE p.event_kind = k.event_kind ORDER BY p.at,p.id LIMIT 20) ref))
      ORDER BY k.event_kind), '[]'::jsonb))) INTO sections FROM kinds k;
  RETURN sections;
END $$;
CREATE FUNCTION trustwork.agents_own_goal_report_sections(p_goal uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  RETURN trustwork.agents_goal_report_sections(p_goal, trustwork.current_person_id());
END $$;

-- The one initial engine implementation is core/goal_progress_report@1. Unsupported templates cannot execute.
-- Lock order: node/hub/company/person epochs; membership, subscription, mandate,
-- goal; occurrence; run. Policy and serving registration revokers bump the locked hub epoch;
-- their rows are read after the epoch wait, without reversing their writer lock order. All local effects and the worker's fenced completion share the same transaction.
CREATE FUNCTION trustwork.agent_modules_occurrence_refusal(p_subscription uuid, p_goal uuid, p_subscription_revision integer,
  p_goal_revision integer, p_mandate_revision integer, p_digest text) RETURNS text
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  s trustwork.job_subscription%ROWTYPE; m trustwork.mandate%ROWTYPE; g trustwork.goal%ROWTYPE;
  r trustwork.agent_job_request%ROWTYPE; u trustwork.agent_mandate_usage%ROWTYPE;
  v_policy jsonb; v_template jsonb; v_kind text; v_refusal text;
BEGIN
  SELECT * INTO s FROM trustwork.job_subscription WHERE id = p_subscription;
  SELECT * INTO r FROM trustwork.agent_job_request WHERE job_subscription_id = s.id;
  SELECT * INTO u FROM trustwork.agent_mandate_usage WHERE job_request_id = r.id;
  IF u.job_request_id IS NULL THEN RETURN 'hub_provenance_unavailable'; END IF;
  PERFORM trustwork.agent_modules_lock_epochs(u.hub_id, s.on_behalf_company_id, s.principal_person_id, NULL);
  SELECT document INTO v_policy FROM trustwork.agent_policy_current WHERE hub_id = u.hub_id;
  PERFORM b.id FROM trustwork.agent_serving_hub b JOIN trustwork.agent_job_provenance p ON p.serving_binding_id = b.id
    WHERE p.job_request_id = r.id AND b.active AND b.hub_id = u.hub_id;
  IF NOT FOUND THEN RETURN 'hub_provenance_unavailable'; END IF;
  PERFORM id FROM trustwork.person WHERE id = s.principal_person_id;
  IF NOT FOUND THEN RETURN 'principal_unavailable'; END IF;
  IF s.on_behalf_company_id IS NOT NULL THEN
    PERFORM id FROM trustwork.membership WHERE person_id = s.principal_person_id AND company_id = s.on_behalf_company_id FOR SHARE;
    IF NOT trustwork.agents_member_authority(s.principal_person_id, s.on_behalf_company_id) THEN RETURN 'authority_basis_lost'; END IF;
  END IF;
  SELECT * INTO s FROM trustwork.job_subscription WHERE id = p_subscription FOR SHARE;
  SELECT * INTO m FROM trustwork.mandate WHERE id = s.mandate_id FOR SHARE;
  SELECT * INTO g FROM trustwork.goal WHERE id = p_goal FOR SHARE;
  IF s.status <> 'active' OR s.revision IS DISTINCT FROM p_subscription_revision THEN RETURN 'subscription_changed'; END IF;
  IF r.status <> 'active' OR r.hub_id IS DISTINCT FROM u.hub_id OR m.id IS DISTINCT FROM u.mandate_id
    OR m.revision IS DISTINCT FROM u.mandate_revision OR m.revision IS DISTINCT FROM p_mandate_revision
    OR m.digest IS DISTINCT FROM p_digest OR m.digest IS DISTINCT FROM u.mandate_digest
    OR m.principal_person_id IS DISTINCT FROM s.principal_person_id OR m.grantee_kind <> 'own_agent'
    OR m.on_behalf_company_id IS DISTINCT FROM s.on_behalf_company_id THEN RETURN 'mandate_changed'; END IF;
  IF g.id IS NULL OR g.principal_person_id <> s.principal_person_id OR g.on_behalf_company_id IS DISTINCT FROM s.on_behalf_company_id
    OR g.status <> 'active' OR g.confirmed_at IS NULL OR g.revision IS DISTINCT FROM p_goal_revision THEN RETURN 'goal_changed'; END IF;
  IF s.module_key <> 'core' OR s.job_template_key <> 'goal_progress_report' THEN RETURN 'template_unavailable'; END IF;
  SELECT t INTO v_template FROM jsonb_array_elements(v_policy -> 'jobTemplates') t
    WHERE t ->> 'moduleKey' = s.module_key AND t ->> 'templateKey' = s.job_template_key;
  IF v_template IS NULL OR v_template -> 'actions' <> '["prepare"]'::jsonb
    OR NOT trustwork.agent_modules_template_offered(u.hub_id, s.module_key, s.job_template_key) THEN RETURN 'template_withdrawn'; END IF;
  IF NOT EXISTS (SELECT 1 FROM trustwork.mandate_context WHERE mandate_id = m.id AND context_kind = 'goal' AND context_id = g.id::text)
    OR trustwork.agents_mandate_covers(m, 'prepare', ARRAY['core'], 'goal', g.id::text) <> 'allow'
    OR m.snapshot #> '{limits,perWindow}' IS DISTINCT FROM 'null'::jsonb THEN RETURN 'mandate_authority_missing'; END IF;
  v_kind := trustwork.agent_modules_mandate_kind(m.grantee_kind,m.on_behalf_company_id);
  v_refusal := trustwork.agent_modules_policy_refusal(u.hub_id,'core.generate_goal_report',v_kind,
    EXISTS (SELECT 1 FROM trustwork.company WHERE id = s.on_behalf_company_id AND claim_status = 'verified'),'free');
  IF v_refusal IS NOT NULL THEN RETURN v_refusal; END IF;
  IF trustwork.agent_modules_dispatch_refusal(u.hub_id,'core','core.generate_goal_report','prepare',s.principal_person_id,NULL,NULL) IS NOT NULL THEN RETURN 'kill_switch'; END IF;
  -- Reuse the real owning hold serialization. A local private draft is not a money/commitment operation.
  IF EXISTS (SELECT 1 FROM trustwork.screening_gate_check(ARRAY['person'],ARRAY[s.principal_person_id]) h WHERE h.place_hold OR h.suspended) THEN RETURN 'principal_held'; END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION trustwork.agent_modules_create_occurrence(p_subscription uuid, p_kind text, p_key text, p_source jsonb, p_goal uuid)
RETURNS uuid LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE s trustwork.job_subscription%ROWTYPE; u trustwork.agent_mandate_usage%ROWTYPE; g trustwork.goal%ROWTYPE; v_id uuid; v_reason text;
BEGIN
  SELECT id INTO v_id FROM trustwork.agent_job_occurrence WHERE job_subscription_id = p_subscription AND source_key = p_key;
  IF FOUND THEN RETURN v_id; END IF;
  SELECT * INTO s FROM trustwork.job_subscription WHERE id = p_subscription;
  SELECT u0.* INTO u FROM trustwork.agent_mandate_usage u0 JOIN trustwork.agent_job_request r ON r.id = u0.job_request_id WHERE r.job_subscription_id = s.id;
  SELECT * INTO g FROM trustwork.goal WHERE id = p_goal;
  IF u.job_request_id IS NULL OR g.id IS NULL OR g.principal_person_id <> s.principal_person_id THEN RETURN NULL; END IF;
  v_reason := trustwork.agent_modules_occurrence_refusal(s.id,g.id,s.revision,g.revision,u.mandate_revision,u.mandate_digest);
  INSERT INTO trustwork.agent_job_occurrence(job_subscription_id,subscription_revision,job_request_id,principal_person_id,hub_id,
    source_kind,source_key,source,goal_id,goal_revision,template_version,mandate_id,mandate_revision,mandate_digest,state,reason,finished_at)
    VALUES(s.id,s.revision,u.job_request_id,s.principal_person_id,u.hub_id,p_kind,p_key,p_source,g.id,g.revision,1,
      u.mandate_id,u.mandate_revision,u.mandate_digest,CASE WHEN v_reason IS NULL THEN 'queued' ELSE 'refused' END,v_reason,
      CASE WHEN v_reason IS NOT NULL THEN clock_timestamp() END)
    ON CONFLICT (job_subscription_id,source_key) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM trustwork.agent_job_occurrence WHERE job_subscription_id = p_subscription AND source_key = p_key;
  ELSIF v_reason IS NULL THEN
    INSERT INTO trustwork.job(kind,payload) VALUES('agents.start_occurrence',jsonb_build_object('occurrenceId',v_id));
  END IF;
  RETURN v_id;
END $$;

CREATE FUNCTION trustwork.agent_modules_start_occurrence(p_occurrence uuid, p_job uuid, p_fence bigint)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE j trustwork.job%ROWTYPE; o trustwork.agent_job_occurrence%ROWTYPE; v_reason text; v_run uuid;
BEGIN
  SELECT * INTO j FROM trustwork.job WHERE id = p_job FOR UPDATE;
  IF j.id IS NULL OR j.kind <> 'agents.start_occurrence' OR j.state <> 'leased' OR j.leased_until <= clock_timestamp()
    OR j.fencing_token IS DISTINCT FROM p_fence OR j.payload IS DISTINCT FROM jsonb_build_object('occurrenceId',p_occurrence) THEN
    RAISE EXCEPTION 'occurrence lease lost' USING ERRCODE = '55P03', HINT = 'assistant.fenced_out';
  END IF;
  SELECT * INTO o FROM trustwork.agent_job_occurrence WHERE id = p_occurrence;
  IF o.id IS NULL THEN RAISE EXCEPTION 'unknown occurrence' USING ERRCODE = '42501'; END IF;
  v_reason := trustwork.agent_modules_occurrence_refusal(o.job_subscription_id,o.goal_id,o.subscription_revision,o.goal_revision,o.mandate_revision,o.mandate_digest);
  SELECT * INTO o FROM trustwork.agent_job_occurrence WHERE id = p_occurrence FOR UPDATE;
  IF o.state <> 'queued' THEN RETURN jsonb_build_object('state',o.state,'runId',o.run_id); END IF;
  IF v_reason IS NOT NULL THEN
    UPDATE trustwork.agent_job_occurrence SET state = 'refused',reason = v_reason,finished_at = clock_timestamp(),worker_job_id = j.id,fencing_token = p_fence WHERE id = o.id;
    RETURN jsonb_build_object('state','refused','reason',v_reason);
  END IF;
  INSERT INTO trustwork.run(principal_person_id,mandate_id,goal_id,kind,state,checkpoint)
    VALUES(o.principal_person_id,o.mandate_id,o.goal_id,'goal_report','queued',jsonb_build_object('occurrenceId',o.id,'hubId',o.hub_id,'templateVersion',o.template_version)) RETURNING id INTO v_run;
  INSERT INTO trustwork.run_step(run_id,kind,tool,state,output_ref) VALUES(v_run,'checkpoint','core.generate_goal_report','recorded',jsonb_build_object('occurrenceId',o.id));
  UPDATE trustwork.agent_job_occurrence SET run_id = v_run,state = 'running',worker_job_id = j.id,fencing_token = p_fence WHERE id = o.id;
  INSERT INTO trustwork.job(kind,payload) VALUES('agents.execute_occurrence',jsonb_build_object('occurrenceId',o.id));
  INSERT INTO trustwork.audit_event(actor_person_id,action,object_kind,object_id,basis)
    VALUES(o.principal_person_id,'agents.subscription_run_started','run',v_run::text,jsonb_build_object('occurrenceId',o.id,'workerJobId',j.id));
  RETURN jsonb_build_object('state','running','runId',v_run);
END $$;

CREATE FUNCTION trustwork.agent_modules_execute_occurrence(p_occurrence uuid,p_job uuid,p_fence bigint)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE j trustwork.job%ROWTYPE; o trustwork.agent_job_occurrence%ROWTYPE; r trustwork.run%ROWTYPE; g trustwork.goal%ROWTYPE;
  v_reason text; v_report uuid; v_sections jsonb;
BEGIN
  SELECT * INTO j FROM trustwork.job WHERE id = p_job FOR UPDATE;
  IF j.id IS NULL OR j.kind <> 'agents.execute_occurrence' OR j.state <> 'leased' OR j.leased_until <= clock_timestamp()
    OR j.fencing_token IS DISTINCT FROM p_fence OR j.payload IS DISTINCT FROM jsonb_build_object('occurrenceId',p_occurrence) THEN
    RAISE EXCEPTION 'occurrence lease lost' USING ERRCODE = '55P03', HINT = 'assistant.fenced_out';
  END IF;
  SELECT * INTO o FROM trustwork.agent_job_occurrence WHERE id = p_occurrence;
  IF o.id IS NULL THEN RAISE EXCEPTION 'unknown occurrence' USING ERRCODE = '42501'; END IF;
  v_reason := trustwork.agent_modules_occurrence_refusal(o.job_subscription_id,o.goal_id,o.subscription_revision,o.goal_revision,o.mandate_revision,o.mandate_digest);
  SELECT * INTO o FROM trustwork.agent_job_occurrence WHERE id = p_occurrence FOR UPDATE;
  IF o.state <> 'running' THEN RETURN jsonb_build_object('state',o.state,'runId',o.run_id); END IF;
  SELECT * INTO r FROM trustwork.run WHERE id = o.run_id FOR UPDATE;
  IF r.state IN ('completed','failed','cancelled') THEN v_reason := 'run_' || r.state; END IF;
  IF o.source_kind = 'deadline' AND NOT EXISTS (SELECT 1 FROM trustwork.agent_policy_current
    WHERE hub_id = o.hub_id AND config_version_id::text = o.source ->> 'calendarVersionId') THEN v_reason := 'calendar_changed'; END IF;
  IF v_reason IS NOT NULL THEN
    UPDATE trustwork.agent_job_occurrence SET state = CASE WHEN r.state = 'cancelled' THEN 'cancelled' ELSE 'refused' END,
      reason = v_reason,finished_at = clock_timestamp(),worker_job_id = j.id,fencing_token = p_fence WHERE id = o.id;
    IF r.state NOT IN ('completed','failed','cancelled') THEN
      UPDATE trustwork.run SET state = 'failed',ended_at = clock_timestamp(),ended_reason = v_reason WHERE id = r.id;
    END IF;
    INSERT INTO trustwork.run_step(run_id,kind,tool,state,output_ref) VALUES(r.id,'decision','core.generate_goal_report','denied',jsonb_build_object('reason',v_reason));
    RETURN jsonb_build_object('state','refused','reason',v_reason);
  END IF;
  SELECT * INTO g FROM trustwork.goal WHERE id = o.goal_id;
  v_sections := trustwork.agents_goal_report_sections(g.id,o.principal_person_id);
  INSERT INTO trustwork.agent_report(author_person_id,principal_company_id,goal_id,run_id,period_from,period_to,sections)
    VALUES(o.principal_person_id,NULL,g.id,r.id,least(g.created_at,clock_timestamp()-interval '1 second'),clock_timestamp(),v_sections) RETURNING id INTO v_report;
  INSERT INTO trustwork.goal_progress(goal_id,event_kind,evidence_refs,recorded_by_person_id)
    VALUES(g.id,'report',jsonb_build_array(jsonb_build_object('kind','agent_report','id',v_report)),o.principal_person_id);
  INSERT INTO trustwork.run_step(run_id,kind,tool,state,output_ref,finished_at)
    VALUES(r.id,'tool_call','core.generate_goal_report','succeeded',jsonb_build_object('reportId',v_report),clock_timestamp());
  UPDATE trustwork.run SET state = 'completed',ended_at = clock_timestamp() WHERE id = r.id;
  UPDATE trustwork.agent_job_occurrence SET state = 'succeeded',report_id = v_report,finished_at = clock_timestamp(),worker_job_id = j.id,fencing_token = p_fence WHERE id = o.id;
  RETURN jsonb_build_object('state','succeeded','runId',r.id,'reportId',v_report);
END $$;
REVOKE ALL ON FUNCTION trustwork.agent_modules_occurrence_guard(),trustwork.agents_goal_report_sections(uuid,uuid),
  trustwork.agents_own_goal_report_sections(uuid),trustwork.agent_modules_occurrence_refusal(uuid,uuid,integer,integer,integer,text),
  trustwork.agent_modules_create_occurrence(uuid,text,text,jsonb,uuid),trustwork.agent_modules_start_occurrence(uuid,uuid,bigint),
  trustwork.agent_modules_execute_occurrence(uuid,uuid,bigint) FROM PUBLIC,trustwork_app,trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.agents_own_goal_report_sections(uuid) TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.agent_modules_start_occurrence(uuid,uuid,bigint),trustwork.agent_modules_execute_occurrence(uuid,uuid,bigint) TO trustwork_worker;

-- Only new, owning-table inserts create source signals. Existing readiness rows are never replayed.
CREATE TABLE trustwork.agent_occurrence_signal (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  kind text NOT NULL CHECK (kind IN ('schedule','progress')),
  source_id uuid NOT NULL,
  subscription_revision integer,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(kind, source_id)
);
ALTER TABLE trustwork.agent_occurrence_signal ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_occurrence_signal FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.agent_occurrence_signal TO trustwork_owner
  USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE FUNCTION trustwork.agent_modules_source_signal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_id uuid; v_kind text; v_revision integer;
BEGIN
  IF TG_TABLE_NAME = 'agent_job_fire' THEN
    IF NEW.cause <> 'schedule' OR NEW.outcome <> 'due' THEN RETURN NULL; END IF;
    v_kind := 'schedule';
    SELECT revision INTO v_revision FROM trustwork.job_subscription WHERE id = NEW.job_subscription_id;
  ELSE
    IF NEW.event_kind <> 'evidence' THEN RETURN NULL; END IF;
    v_kind := 'progress';
  END IF;
  INSERT INTO trustwork.agent_occurrence_signal(kind,source_id,subscription_revision) VALUES(v_kind,NEW.id,v_revision) RETURNING id INTO v_id;
  IF v_kind = 'progress' THEN
    INSERT INTO trustwork.outbox_event(aggregate_kind,aggregate_id,revision,type,payload)
      VALUES('agent_occurrence_signal',v_id::text,1,'agents.occurrence_source',jsonb_build_object('signalId',v_id));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER agent_modules_schedule_signal AFTER INSERT ON trustwork.agent_job_fire
  FOR EACH ROW EXECUTE FUNCTION trustwork.agent_modules_source_signal();
CREATE TRIGGER agent_modules_progress_signal AFTER INSERT ON trustwork.goal_progress
  FOR EACH ROW EXECUTE FUNCTION trustwork.agent_modules_source_signal();

CREATE FUNCTION trustwork.agent_modules_consume_signal(p_signal uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE sig trustwork.agent_occurrence_signal%ROWTYPE; f trustwork.agent_job_fire%ROWTYPE;
  p trustwork.goal_progress%ROWTYPE; s trustwork.job_subscription%ROWTYPE; g trustwork.goal%ROWTYPE;
  v_count integer := 0; v_kind text; v_key text; v_source jsonb;
BEGIN
  SELECT * INTO sig FROM trustwork.agent_occurrence_signal WHERE id = p_signal;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown source signal' USING ERRCODE = '42501'; END IF;
  IF sig.kind = 'schedule' THEN
    SELECT * INTO f FROM trustwork.agent_job_fire WHERE id = sig.source_id;
    SELECT * INTO s FROM trustwork.job_subscription WHERE id = f.job_subscription_id;
    IF f.cause <> 'schedule' OR f.outcome <> 'due' OR s.trigger ->> 'kind' <> 'schedule'
      OR s.revision <> sig.subscription_revision OR f.due_at > clock_timestamp()
      OR NOT EXISTS (SELECT 1 FROM trustwork.agent_job_schedule WHERE job_subscription_id = s.id AND execution_not_before <= f.due_at) THEN RETURN 0; END IF;
    v_kind := 'schedule';
    v_key := 'schedule:' || s.revision || ':' || extract(epoch FROM f.due_at)::text;
    v_source := jsonb_build_object('kind',v_kind,'subscriptionRevision',s.revision,'scheduledAt',f.due_at);
    -- This engine template has one explicit goal context. No inferred company-wide scope.
    FOR g IN SELECT goal.* FROM trustwork.goal goal JOIN trustwork.mandate_context c
      ON c.context_kind = 'goal' AND c.context_id = goal.id::text AND c.mandate_id = s.mandate_id
      WHERE goal.principal_person_id = s.principal_person_id ORDER BY goal.id LOOP
      IF trustwork.agent_modules_create_occurrence(s.id,v_kind,v_key || ':' || g.id,v_source,g.id) IS NOT NULL THEN v_count := v_count + 1; END IF;
    END LOOP;
  ELSE
    SELECT * INTO p FROM trustwork.goal_progress WHERE id = sig.source_id;
    SELECT * INTO g FROM trustwork.goal WHERE id = p.goal_id;
    IF p.event_kind <> 'evidence' OR g.id IS NULL OR g.horizon <= clock_timestamp() THEN RETURN 0; END IF;
    FOR s IN SELECT sub.* FROM trustwork.job_subscription sub
      WHERE sub.principal_person_id = g.principal_person_id AND sub.on_behalf_company_id IS NOT DISTINCT FROM g.on_behalf_company_id
        AND sub.status = 'active' AND sub.created_at <= p.at
        AND ((sub.trigger ->> 'kind' = 'goal' AND sub.trigger ->> 'goalId' = g.id::text)
          OR (sub.trigger ->> 'kind' = 'event' AND sub.trigger ->> 'eventType' = 'agents.goal_progress'))
        AND EXISTS (SELECT 1 FROM trustwork.mandate_context c WHERE c.mandate_id = sub.mandate_id AND c.context_kind = 'goal' AND c.context_id = g.id::text)
      ORDER BY sub.id LOOP
      v_kind := s.trigger ->> 'kind';
      v_key := v_kind || ':' || CASE WHEN v_kind = 'goal' THEN p.id ELSE sig.id END;
      v_source := CASE WHEN v_kind = 'goal' THEN jsonb_build_object('kind','goal','progressId',p.id)
        ELSE jsonb_build_object('kind','event','eventId',sig.id) END;
      IF trustwork.agent_modules_create_occurrence(s.id,v_kind,v_key,v_source,g.id) IS NOT NULL THEN v_count := v_count + 1; END IF;
    END LOOP;
  END IF;
  RETURN v_count;
END $$;

-- The operation identifier is supplied only from the existing first-party idempotency completion context.
CREATE FUNCTION trustwork.agent_modules_request_occurrence(p_subscription uuid,p_binding uuid,p_operation uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE s trustwork.job_subscription%ROWTYPE; p trustwork.agent_job_provenance%ROWTYPE; v_goal uuid; v_count integer;
BEGIN
  SELECT * INTO s FROM trustwork.job_subscription WHERE id = p_subscription AND principal_person_id = trustwork.current_person_id();
  SELECT prov.* INTO p FROM trustwork.agent_job_provenance prov JOIN trustwork.agent_job_request r ON r.id = prov.job_request_id WHERE r.job_subscription_id = s.id;
  IF s.id IS NULL OR p.serving_binding_id IS DISTINCT FROM p_binding OR NOT EXISTS (
    SELECT 1 FROM trustwork.idempotency_record WHERE id = p_operation AND principal_id = s.principal_person_id::text
      AND action = 'agent_modules.job_run_now' AND state = 'in_progress') THEN
    RAISE EXCEPTION 'request authority missing' USING ERRCODE = '42501', HINT = 'access.not_found';
  END IF;
  SELECT count(*),min(context_id)::uuid INTO v_count,v_goal FROM trustwork.mandate_context
    WHERE mandate_id = s.mandate_id AND context_kind = 'goal';
  IF v_count <> 1 THEN RAISE EXCEPTION 'one explicit goal is required' USING ERRCODE = '42501', HINT = 'agents.goal_context_required'; END IF;
  RETURN trustwork.agent_modules_create_occurrence(s.id,'request','request:' || p_operation,
    jsonb_build_object('kind','request','operationId',p_operation),v_goal);
END $$;

CREATE FUNCTION trustwork.agent_modules_deadline_tick(p_limit integer) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE s record; d trustwork.agent_job_deadline%ROWTYPE; v_count integer := 0;
BEGIN
  FOR s IN SELECT sub.id FROM trustwork.job_subscription sub JOIN trustwork.agent_job_request r ON r.job_subscription_id = sub.id
    JOIN trustwork.agent_mandate_usage u ON u.job_request_id = r.id
    WHERE sub.status = 'active' AND sub.trigger ->> 'kind' = 'deadline' ORDER BY sub.id
  LOOP
    PERFORM trustwork.agent_modules_sync_goal_deadlines(s.id);
  END LOOP;
  FOR d IN SELECT * FROM trustwork.agent_job_deadline WHERE state = 'pending' AND due_at <= clock_timestamp()
    ORDER BY due_at,id LIMIT greatest(1,least(coalesce(p_limit,100),1000)) 
  LOOP
    IF NOT EXISTS (SELECT 1 FROM trustwork.agent_policy_current WHERE hub_id = d.hub_id AND config_version_id = d.calendar_version_id)
      OR NOT EXISTS (SELECT 1 FROM trustwork.goal WHERE id = d.goal_id AND revision = d.source_revision AND status = 'active')
      OR NOT EXISTS (SELECT 1 FROM trustwork.job_subscription WHERE id = d.job_subscription_id AND revision = d.subscription_revision AND status = 'active') THEN
      UPDATE trustwork.agent_job_deadline SET state = 'invalidated' WHERE id = d.id;
      CONTINUE;
    END IF;
    IF trustwork.agent_modules_create_occurrence(d.job_subscription_id,'deadline','deadline:' || d.id,
      jsonb_build_object('kind','deadline','contextKind','goal','contextId',d.goal_id,'deadlineKey','horizon',
        'deadlineRevision',d.source_revision,'calendarVersionId',d.calendar_version_id,'offsetDays',d.offset_days),d.goal_id) IS NOT NULL THEN
      UPDATE trustwork.agent_job_deadline SET state = 'fired' WHERE id = d.id;
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION trustwork.agent_modules_source_signal(),trustwork.agent_modules_consume_signal(uuid),
  trustwork.agent_modules_request_occurrence(uuid,uuid,uuid),trustwork.agent_modules_deadline_tick(integer) FROM PUBLIC,trustwork_app,trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.agent_modules_consume_signal(uuid),trustwork.agent_modules_deadline_tick(integer) TO trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.agent_modules_request_occurrence(uuid,uuid,uuid) TO trustwork_app;

-- Consume only the persisted readiness event and the signal created by its owning fire insert.
CREATE FUNCTION trustwork.agent_modules_consume_schedule(p_event bigint) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE e record; v_signal uuid;
BEGIN
  SELECT * INTO e FROM trustwork.outbox_event WHERE id = p_event;
  IF NOT FOUND OR e.type <> 'agents.job_due' OR e.aggregate_kind <> 'job_subscription'
    OR e.payload ->> 'cause' <> 'schedule' THEN RETURN 0; END IF;
  SELECT sig.id INTO v_signal FROM trustwork.agent_job_fire f JOIN trustwork.agent_occurrence_signal sig
    ON sig.kind = 'schedule' AND sig.source_id = f.id
    WHERE f.job_subscription_id::text = e.aggregate_id AND e.payload ->> 'jobSubscriptionId' = e.aggregate_id
      AND f.cause = 'schedule' AND f.outcome = 'due' AND sig.subscription_revision = e.revision
      AND to_char(f.due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = e.payload ->> 'dueAt';
  IF v_signal IS NULL THEN RETURN 0; END IF;
  RETURN trustwork.agent_modules_consume_signal(v_signal);
END $$;
REVOKE ALL ON FUNCTION trustwork.agent_modules_consume_schedule(bigint) FROM PUBLIC,trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.agent_modules_consume_schedule(bigint) TO trustwork_worker;
