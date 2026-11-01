-- SANC-002 / SANC-006: maintenance-installed pack facts and two-person file-list configuration.
-- No operational source is seeded. The maintenance synchronizer reads validated installed packs and real adapters.
CREATE TABLE trustwork.screening_list_source (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  pack_code text NOT NULL CHECK (pack_code ~ '^[A-Z]{2}$'),
  pack_version text NOT NULL,
  fact_id text NOT NULL,
  code text NOT NULL CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  name text NOT NULL, authority text NOT NULL,
  source_url text NOT NULL CHECK (source_url ~ '^https://[^\s]+$'),
  adapter text NOT NULL,
  source_digest text NOT NULL UNIQUE CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  snapshot jsonb NOT NULL,
  current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX screening_list_source_current ON trustwork.screening_list_source(pack_code, fact_id) WHERE current;
CREATE FUNCTION trustwork.screening_list_source_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (to_jsonb(NEW) - 'current') IS DISTINCT FROM (to_jsonb(OLD) - 'current') THEN
    RAISE EXCEPTION 'source snapshots are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER screening_list_source_guard BEFORE UPDATE OR DELETE ON trustwork.screening_list_source FOR EACH ROW EXECUTE FUNCTION trustwork.screening_list_source_guard();
CREATE TRIGGER screening_list_source_no_truncate BEFORE TRUNCATE ON trustwork.screening_list_source FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();
ALTER TABLE trustwork.screening_list ADD COLUMN source_id uuid REFERENCES trustwork.screening_list_source(id);
ALTER TABLE trustwork.screening_list ADD CONSTRAINT screening_list_baseline_source CHECK (NOT baseline OR source_id IS NULL);

CREATE TABLE trustwork.screening_list_proposal (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub(id),
  source_id uuid NOT NULL REFERENCES trustwork.screening_list_source(id),
  requested_by uuid NOT NULL REFERENCES trustwork.person(id),
  cadence_seconds integer NOT NULL CHECK (cadence_seconds BETWEEN 60 AND 604800),
  warn_after_seconds integer NOT NULL CHECK (warn_after_seconds BETWEEN 120 AND 1209599),
  stale_after_seconds integer NOT NULL CHECK (stale_after_seconds BETWEEN 180 AND 1209600),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  evidence text NOT NULL CHECK (evidence IN ('official_export', 'source_review')),
  before_digest text NOT NULL,
  action_digest text NOT NULL CHECK (action_digest ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '72 hours',
  decided_by uuid REFERENCES trustwork.person(id),
  decided_at timestamptz, decision_reason text,
  CHECK (cadence_seconds <= warn_after_seconds AND warn_after_seconds < stale_after_seconds),
  CHECK (decided_by IS DISTINCT FROM requested_by),
  CHECK ((state = 'pending' AND decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL)
    OR (state <> 'pending' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND length(btrim(decision_reason)) BETWEEN 1 AND 500))
);
CREATE FUNCTION trustwork.screening_list_proposal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.state <> 'pending' OR NEW.state = 'pending'
    OR (to_jsonb(NEW) - ARRAY['state','decided_by','decided_at','decision_reason']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['state','decided_by','decided_at','decision_reason']) THEN
    RAISE EXCEPTION 'list proposal history is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER screening_list_proposal_guard BEFORE UPDATE OR DELETE ON trustwork.screening_list_proposal FOR EACH ROW EXECUTE FUNCTION trustwork.screening_list_proposal_guard();
CREATE TRIGGER screening_list_proposal_no_truncate BEFORE TRUNCATE ON trustwork.screening_list_proposal FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

-- Only configuration enters this fingerprint: worker freshness updates cannot invalidate a reviewed proposal.
CREATE FUNCTION trustwork.screening_list_configuration_digest(p_hub uuid, p_code text) RETURNS text
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
 SELECT trustwork.admin_digest(coalesce((SELECT jsonb_build_object('id', id, 'sourceId', source_id, 'mode', mode,
   'cadence', cadence::text, 'warning', warn_after::text, 'stale', stale_after::text, 'status', status,
   'maxDropShare', max_drop_share::text, 'minEntries', min_entries) FROM trustwork.screening_list WHERE hub_id = p_hub AND code = p_code), 'null'::jsonb))
$$;

CREATE FUNCTION trustwork.screening_list_propose(p_ctx jsonb, p_input jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
 a trustwork.admin_actor := trustwork.screening_staff_actor(p_ctx, 'admin.screening.lists.manage');
 s trustwork.screening_list_source%ROWTYPE;
 h uuid := (p_input->>'hubId')::uuid;
 i uuid := trustwork.new_uuid(); b text; d text;
BEGIN
 IF p_input - ARRAY['hubId','sourceId','cadenceSeconds','warnAfterSeconds','staleAfterSeconds','reason','evidence'] <> '{}'::jsonb THEN
   RAISE EXCEPTION 'unknown configuration field' USING ERRCODE = '22023', HINT = 'screening.invalid_configuration';
 END IF;
 PERFORM 1 FROM trustwork.hub_profile WHERE hub_id = h AND node_id = trustwork.jurisdiction_node() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'hub unavailable' USING ERRCODE = 'P0002', HINT = 'access.not_found'; END IF;
 SELECT * INTO s FROM trustwork.screening_list_source WHERE id = (p_input->>'sourceId')::uuid AND current FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'source unavailable' USING ERRCODE = 'P0002', HINT = 'access.not_found'; END IF;
 b := trustwork.screening_list_configuration_digest(h, s.code);
 d := trustwork.admin_digest(jsonb_build_object('action','screening.configure_file_list','proposalId',i,'input',p_input,'sourceDigest',s.source_digest,'beforeDigest',b,'requestedBy',a.person_id));
 INSERT INTO trustwork.screening_list_proposal(id, hub_id, source_id, requested_by, cadence_seconds, warn_after_seconds, stale_after_seconds, reason, evidence, before_digest, action_digest)
 VALUES (i,h,s.id,a.person_id,(p_input->>'cadenceSeconds')::integer,(p_input->>'warnAfterSeconds')::integer,(p_input->>'staleAfterSeconds')::integer,p_input->>'reason',p_input->>'evidence',b,d);
 PERFORM trustwork.admin_record(a,p_ctx,trustwork.jurisdiction_node(),h,'screening.list_configuration_proposed','screening_list_proposal',i,NULL,p_input || jsonb_build_object('actionDigest',d));
 RETURN i;
END $$;

CREATE FUNCTION trustwork.screening_list_decide(p_ctx jsonb, p_id uuid, p_decision text, p_digest text, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
 a trustwork.admin_actor := trustwork.screening_staff_actor(p_ctx, 'admin.screening.lists.manage');
 p trustwork.screening_list_proposal%ROWTYPE; s trustwork.screening_list_source%ROWTYPE; l uuid;
BEGIN
 IF p_decision IS NULL OR p_decision NOT IN ('approve','reject') OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
   RAISE EXCEPTION 'decision and reason required' USING ERRCODE = '22023', HINT = 'screening.reason_required';
 END IF;
 SELECT * INTO p FROM trustwork.screening_list_proposal WHERE id = p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'proposal unavailable' USING ERRCODE = 'P0002', HINT = 'access.not_found'; END IF;
 PERFORM 1 FROM trustwork.hub_profile WHERE hub_id = p.hub_id AND node_id = trustwork.jurisdiction_node() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'hub unavailable' USING ERRCODE = 'P0002', HINT = 'access.not_found'; END IF;
 IF p.requested_by = a.person_id THEN RAISE EXCEPTION 'independent reviewer required' USING ERRCODE = '42501', HINT = 'screening.second_person_required'; END IF;
 -- Both people must still hold current authority; a revoked requester cannot leave activatable work behind.
 IF NOT trustwork.admin_person_is_staff(p.requested_by,trustwork.jurisdiction_node(),NULL,'compliance-officer') THEN
   RAISE EXCEPTION 'requester no longer authorized' USING ERRCODE = '42501', HINT = 'admin.forbidden';
 END IF;
 IF p.action_digest IS DISTINCT FROM p_digest THEN RAISE EXCEPTION 'digest mismatch' USING ERRCODE = '23514', HINT = 'access.approval_digest_mismatch'; END IF;
 IF p.state <> 'pending' THEN RAISE EXCEPTION 'proposal decided' USING ERRCODE = '23514', HINT = 'admin.approval_not_pending'; END IF;
 IF p_decision = 'approve' THEN
   IF p.expires_at <= now() THEN RAISE EXCEPTION 'proposal expired' USING ERRCODE = '23514', HINT = 'admin.approval_expired'; END IF;
   SELECT * INTO s FROM trustwork.screening_list_source WHERE id = p.source_id AND current FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'source retired' USING ERRCODE = '23514', HINT = 'screening.configuration_changed'; END IF;
   IF p.before_digest <> trustwork.screening_list_configuration_digest(p.hub_id,s.code) THEN
     RAISE EXCEPTION 'configuration changed' USING ERRCODE = '23514', HINT = 'screening.configuration_changed';
   END IF;
   INSERT INTO trustwork.screening_list(hub_id,code,name,authority,source_url,adapter,mode,cadence,warn_after,stale_after,source_id)
   VALUES(p.hub_id,s.code,s.name,s.authority,s.source_url,s.adapter,'file',make_interval(secs=>p.cadence_seconds),make_interval(secs=>p.warn_after_seconds),make_interval(secs=>p.stale_after_seconds),s.id)
   ON CONFLICT (hub_id,code) WHERE hub_id IS NOT NULL DO UPDATE SET
     source_id = EXCLUDED.source_id, name = EXCLUDED.name, authority = EXCLUDED.authority, source_url = EXCLUDED.source_url,
     adapter = EXCLUDED.adapter, mode = 'file', cadence = EXCLUDED.cadence, warn_after = EXCLUDED.warn_after, stale_after = EXCLUDED.stale_after
   RETURNING id INTO l;
 END IF;
 UPDATE trustwork.screening_list_proposal SET state = CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END,
   decided_by = a.person_id, decided_at = now(), decision_reason = btrim(p_reason) WHERE id = p_id;
 PERFORM trustwork.admin_record(a,p_ctx,trustwork.jurisdiction_node(),p.hub_id,'screening.list_configuration_decided','screening_list_proposal',p_id,
   jsonb_build_object('state',p.state),jsonb_build_object('decision',p_decision,'actionDigest',p_digest,'reason',p_reason,'listId',l));
 RETURN p_id;
END $$;

CREATE FUNCTION trustwork.screening_list_source_current(p_list uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
 SELECT EXISTS (SELECT 1 FROM trustwork.screening_list l LEFT JOIN trustwork.screening_list_source s ON s.id = l.source_id
   WHERE l.id = p_list AND (l.source_id IS NULL OR (s.current AND s.adapter = l.adapter AND s.source_url = l.source_url)))
$$;
ALTER TABLE trustwork.screening_list_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.screening_list_source FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.screening_list_proposal ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.screening_list_proposal FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.screening_list_source TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.screening_list_proposal TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY staff_read ON trustwork.screening_list_source FOR SELECT TO trustwork_app USING (trustwork.jurisdiction_staff_reader());
CREATE POLICY staff_read ON trustwork.screening_list_proposal FOR SELECT TO trustwork_app USING (trustwork.jurisdiction_staff_reader());
GRANT SELECT ON trustwork.screening_list_source,trustwork.screening_list_proposal TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.screening_list_propose(jsonb,jsonb),trustwork.screening_list_decide(jsonb,uuid,text,text,text) TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.screening_list_source_current(uuid) TO trustwork_worker;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
