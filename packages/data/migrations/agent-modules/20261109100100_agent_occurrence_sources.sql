-- AGT-003 / AGT-001: durable source references, not run authority. No historical evidence is replayed.
-- Goal content remains in its owning tables. This event contains one immutable source identifier only.
CREATE FUNCTION trustwork.agent_modules_goal_progress_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF NEW.event_kind = 'evidence' THEN
    INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
    VALUES ('goal_progress', NEW.id::text, 1, 'agents.goal_progress', jsonb_build_object('progressId', NEW.id));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER agent_modules_goal_progress_event AFTER INSERT ON trustwork.goal_progress
  FOR EACH ROW EXECUTE FUNCTION trustwork.agent_modules_goal_progress_event();

-- One persisted row per resource revision and offset. Past offsets are retained as elapsed, never caught up.
CREATE TABLE trustwork.agent_job_deadline (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  job_subscription_id uuid NOT NULL REFERENCES trustwork.job_subscription(id),
  subscription_revision integer NOT NULL CHECK (subscription_revision > 0),
  principal_person_id uuid NOT NULL REFERENCES trustwork.person(id),
  hub_id uuid NOT NULL REFERENCES trustwork.hub(id),
  goal_id uuid NOT NULL REFERENCES trustwork.goal(id),
  source_revision integer NOT NULL CHECK (source_revision > 0),
  calendar_version_id uuid NOT NULL REFERENCES trustwork.hub_config_version(id),
  offset_days integer NOT NULL CHECK (offset_days BETWEEN 0 AND 365),
  due_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'elapsed', 'invalidated', 'fired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_subscription_id, subscription_revision, goal_id, source_revision, calendar_version_id, offset_days)
);
CREATE INDEX agent_job_deadline_pending ON trustwork.agent_job_deadline (due_at, id) WHERE state = 'pending';
ALTER TABLE trustwork.agent_job_deadline ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agent_job_deadline FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.agent_job_deadline TO trustwork_owner
  USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY agent_job_deadline_principal ON trustwork.agent_job_deadline FOR SELECT TO trustwork_app
  USING (principal_person_id = trustwork.current_person_id());
GRANT SELECT ON trustwork.agent_job_deadline TO trustwork_app;

-- Owning commands invalidate discovered work in their own transaction, not on a later scheduler tick.
CREATE FUNCTION trustwork.agent_modules_invalidate_deadlines() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF TG_TABLE_NAME = 'goal' THEN
    UPDATE trustwork.agent_job_deadline SET state = 'invalidated'
      WHERE goal_id = NEW.id AND state = 'pending' AND (source_revision <> NEW.revision OR NEW.status <> 'active');
  ELSIF TG_TABLE_NAME = 'job_subscription' THEN
    UPDATE trustwork.agent_job_deadline SET state = 'invalidated'
      WHERE job_subscription_id = NEW.id AND state = 'pending' AND (subscription_revision <> NEW.revision OR NEW.status <> 'active');
  ELSIF TG_TABLE_NAME = 'agent_policy_current' THEN
    UPDATE trustwork.agent_job_deadline SET state = 'invalidated'
      WHERE hub_id = NEW.hub_id AND state = 'pending' AND calendar_version_id <> NEW.config_version_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER agent_modules_goal_deadlines AFTER UPDATE ON trustwork.goal
  FOR EACH ROW EXECUTE FUNCTION trustwork.agent_modules_invalidate_deadlines();
CREATE TRIGGER agent_modules_subscription_deadlines AFTER UPDATE ON trustwork.job_subscription
  FOR EACH ROW EXECUTE FUNCTION trustwork.agent_modules_invalidate_deadlines();
CREATE TRIGGER agent_modules_calendar_deadlines AFTER UPDATE ON trustwork.agent_policy_current
  FOR EACH ROW EXECUTE FUNCTION trustwork.agent_modules_invalidate_deadlines();

-- A narrow worker discovery operation: subscription -> its already confirmed goal contexts. No person, hub,
-- deadline value or arbitrary query can be supplied. This does not create a run, delegate a session or authorize effects.
CREATE FUNCTION trustwork.agent_modules_sync_goal_deadlines(p_subscription uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  s trustwork.job_subscription%ROWTYPE;
  m trustwork.mandate%ROWTYPE;
  r trustwork.agent_job_request%ROWTYPE;
  g trustwork.goal%ROWTYPE;
  v_tz text;
  v_calendar uuid;
  v_due timestamptz;
  v_offset integer;
  v_count integer := 0;
  v_added integer;
BEGIN
  -- Sharing these rows with their owning commands prevents discovery from committing a stale snapshot.
  SELECT * INTO s FROM trustwork.job_subscription WHERE id = p_subscription FOR SHARE;
  IF NOT FOUND THEN RETURN 0; END IF;
  SELECT * INTO r FROM trustwork.agent_job_request WHERE job_subscription_id = s.id AND status = 'active';
  SELECT * INTO m FROM trustwork.mandate WHERE id = s.mandate_id FOR SHARE;
  IF r.id IS NULL OR r.hub_id IS NULL OR s.status <> 'active' OR s.trigger ->> 'kind' <> 'deadline'
    OR s.trigger ->> 'contextKind' <> 'goal' OR m.id IS NULL OR m.status <> 'active' OR m.valid_until <= clock_timestamp()
    OR m.principal_person_id <> s.principal_person_id OR m.grantee_kind <> 'own_agent'
    OR m.on_behalf_company_id IS DISTINCT FROM s.on_behalf_company_id
    OR NOT (s.module_key = ANY(m.module_keys))
    OR (s.on_behalf_company_id IS NOT NULL AND NOT trustwork.agents_member_authority(s.principal_person_id, s.on_behalf_company_id)) THEN
    UPDATE trustwork.agent_job_deadline SET state = 'invalidated' WHERE job_subscription_id = s.id AND state = 'pending';
    RETURN 0;
  END IF;
  SELECT document -> 'calendar' ->> 'timeZone', config_version_id INTO v_tz, v_calendar FROM trustwork.agent_policy_current WHERE hub_id = r.hub_id FOR SHARE;
  IF v_tz IS NULL OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = v_tz) THEN
    UPDATE trustwork.agent_job_deadline SET state = 'invalidated' WHERE job_subscription_id = s.id AND state = 'pending';
    RETURN 0;
  END IF;
  -- Lock every scoped source before evaluating invalidation. Locking only active rows after that UPDATE would allow
  -- a concurrent pause to leave pending rows behind when discovery waited for the source writer to commit.
  PERFORM goal.id FROM trustwork.goal goal
    WHERE goal.principal_person_id = s.principal_person_id
      AND goal.on_behalf_company_id IS NOT DISTINCT FROM s.on_behalf_company_id
      AND EXISTS (SELECT 1 FROM trustwork.mandate_context c WHERE c.mandate_id = m.id AND c.context_kind = 'goal' AND c.context_id = goal.id::text)
    ORDER BY goal.id FOR SHARE;
  UPDATE trustwork.agent_job_deadline d SET state = 'invalidated'
  WHERE d.job_subscription_id = s.id AND d.state = 'pending' AND (
    d.subscription_revision <> s.revision OR d.calendar_version_id <> v_calendar OR NOT EXISTS (
      SELECT 1 FROM trustwork.goal goal JOIN trustwork.mandate_context c ON c.mandate_id = m.id AND c.context_kind = 'goal' AND c.context_id = goal.id::text
      WHERE goal.id = d.goal_id AND goal.revision = d.source_revision AND goal.status = 'active' AND goal.confirmed_at IS NOT NULL
        AND goal.principal_person_id = s.principal_person_id AND goal.on_behalf_company_id IS NOT DISTINCT FROM s.on_behalf_company_id));
  FOR g IN SELECT goal.* FROM trustwork.goal goal
    WHERE goal.status = 'active' AND goal.confirmed_at IS NOT NULL AND goal.principal_person_id = s.principal_person_id
      AND goal.on_behalf_company_id IS NOT DISTINCT FROM s.on_behalf_company_id
      AND EXISTS (SELECT 1 FROM trustwork.mandate_context c WHERE c.mandate_id = m.id AND c.context_kind = 'goal' AND c.context_id = goal.id::text)
    ORDER BY goal.id FOR SHARE
  LOOP
    FOR v_offset IN SELECT DISTINCT value::integer FROM jsonb_array_elements_text(s.trigger -> 'offsetsDays') LOOP
      -- Existing deadlineOccurrences semantics: local deadline date minus offset, at local 09:00, including DST.
      v_due := (((g.horizon AT TIME ZONE v_tz)::date - v_offset) + time '09:00') AT TIME ZONE v_tz;
      INSERT INTO trustwork.agent_job_deadline (job_subscription_id, subscription_revision, principal_person_id, hub_id, goal_id, source_revision, calendar_version_id, offset_days, due_at, state)
      VALUES (s.id, s.revision, s.principal_person_id, r.hub_id, g.id, g.revision, v_calendar, v_offset, v_due,
        CASE WHEN v_due < clock_timestamp() THEN 'elapsed' ELSE 'pending' END)
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS v_added = ROW_COUNT;
      v_count := v_count + v_added;
    END LOOP;
  END LOOP;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION trustwork.agent_modules_goal_progress_event(), trustwork.agent_modules_invalidate_deadlines(), trustwork.agent_modules_sync_goal_deadlines(uuid) FROM PUBLIC, trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.agent_modules_sync_goal_deadlines(uuid) TO trustwork_worker;
