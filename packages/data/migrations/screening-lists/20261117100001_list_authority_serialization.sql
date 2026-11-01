-- SANC-006: forward-only authority serialization; earlier migrations remain byte-exact.
-- Order: source catalog transaction gate, domain rows, current authority rows (NOWAIT).
-- Every list SQL entry point takes the gate before any row lock. Statement triggers cover
-- maintenance DML before tuple locks; the maintenance synchronizer uses this same gate.
-- Authority rows use NOWAIT after domain locks: an in-flight revocation refuses the command,
-- never deadlocks with an owning command holding an authority row. There is no automatic retry.
CREATE FUNCTION trustwork.screening_list_authority_lock() RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
BEGIN
 IF current_setting('transaction_isolation') <> 'read committed' THEN
   RAISE EXCEPTION 'current list authority requires read committed' USING ERRCODE='40001';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtext('screening_list_sources'));
END $$;
CREATE FUNCTION trustwork.screening_list_write_lock() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
 PERFORM trustwork.screening_list_authority_lock();
 RETURN NULL;
END $$;
CREATE TRIGGER screening_list_write_lock BEFORE INSERT OR UPDATE OR DELETE ON trustwork.screening_list
 FOR EACH STATEMENT EXECUTE FUNCTION trustwork.screening_list_write_lock();
CREATE TRIGGER screening_source_write_lock BEFORE INSERT OR UPDATE OR DELETE ON trustwork.screening_list_source
 FOR EACH STATEMENT EXECUTE FUNCTION trustwork.screening_list_write_lock();
CREATE TRIGGER screening_version_write_lock BEFORE INSERT OR UPDATE OR DELETE ON trustwork.screening_list_version
 FOR EACH STATEMENT EXECUTE FUNCTION trustwork.screening_list_write_lock();
CREATE TRIGGER screening_entry_write_lock BEFORE INSERT OR UPDATE OR DELETE ON trustwork.screening_list_entry
 FOR EACH STATEMENT EXECUTE FUNCTION trustwork.screening_list_write_lock();
CREATE TRIGGER screening_proposal_write_lock BEFORE INSERT OR UPDATE OR DELETE ON trustwork.screening_list_proposal
 FOR EACH STATEMENT EXECUTE FUNCTION trustwork.screening_list_write_lock();

-- Preserve only previously installed unregistered sources, with their exact original binding.
-- New unregistered additions have no authority. Maintenance cannot mark a new row as legacy.
ALTER TABLE trustwork.screening_list ADD COLUMN legacy_source_snapshot jsonb;
UPDATE trustwork.screening_list SET legacy_source_snapshot=jsonb_build_object('adapter',adapter,'url',source_url)
 WHERE source_id IS NULL;
ALTER TABLE trustwork.screening_list_proposal ADD COLUMN requested_elevation_id uuid REFERENCES trustwork.session_elevation(id);
ALTER TABLE trustwork.screening_list_proposal ADD COLUMN authority_node_id uuid REFERENCES trustwork.admin_node(id);
ALTER TABLE trustwork.screening_list_proposal ADD COLUMN requested_authz_epoch integer;

CREATE OR REPLACE FUNCTION trustwork.screening_list_source_current(p_list uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
 PERFORM trustwork.screening_list_authority_lock();
 RETURN EXISTS (SELECT 1 FROM trustwork.screening_list l LEFT JOIN trustwork.screening_list_source s ON s.id=l.source_id
 WHERE l.id=p_list AND (
  (l.source_id IS NULL AND l.legacy_source_snapshot=jsonb_build_object('adapter',l.adapter,'url',l.source_url)) OR
  (s.current AND s.adapter=l.adapter AND s.source_url=l.source_url AND s.code=l.code)));
END $$;
CREATE FUNCTION trustwork.screening_list_binding_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
 IF (TG_OP='INSERT' AND NEW.legacy_source_snapshot IS NOT NULL) OR
    (TG_OP='UPDATE' AND NEW.legacy_source_snapshot IS DISTINCT FROM OLD.legacy_source_snapshot) THEN
   RAISE EXCEPTION 'legacy source binding is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND (NEW.last_checked_at IS DISTINCT FROM OLD.last_checked_at OR NEW.last_outcome IN ('unchanged','activated','needs_confirmation'))
   AND NOT trustwork.screening_list_source_current(OLD.id) THEN
   -- Refusal/error attempts remain recordable, but cannot confirm retired content or freshness.
   IF NEW.last_checked_at IS DISTINCT FROM OLD.last_checked_at OR NEW.last_outcome IS DISTINCT FROM OLD.last_outcome THEN
    RAISE EXCEPTION 'registered source authority unavailable' USING ERRCODE='23514', HINT='screening.configuration_changed';
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER screening_list_binding_guard BEFORE INSERT OR UPDATE ON trustwork.screening_list
 FOR EACH ROW EXECUTE FUNCTION trustwork.screening_list_binding_guard();

-- Narrow list-command helper. Shared screening_staff_actor and permission definitions stay intact.
-- Lock rows read by the authorization decision against ALL SQL writers, not just API revokers.
CREATE FUNCTION trustwork.screening_list_lock_person_authority(p_person uuid, p_elevation uuid, p_node uuid, p_epoch integer) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE e trustwork.session_elevation%ROWTYPE; s trustwork.session%ROWTYPE; at_time timestamptz; epoch integer;
BEGIN
 IF p_person IS NULL OR p_elevation IS NULL OR p_node IS NULL THEN
  RAISE EXCEPTION 'current authority unavailable' USING ERRCODE='42501', HINT='admin.forbidden';
 END IF;
 SELECT authz_epoch INTO epoch FROM trustwork.person WHERE id=p_person FOR SHARE NOWAIT;
 IF epoch IS DISTINCT FROM p_epoch THEN
  RAISE EXCEPTION 'identity authority changed' USING ERRCODE='42501', HINT='admin.forbidden';
 END IF;
 -- Elevation-to-session binding is immutable; the unlocked lookup selects which row to lock only.
 SELECT * INTO e FROM trustwork.session_elevation WHERE id=p_elevation;
 SELECT * INTO s FROM trustwork.session WHERE id=e.session_id FOR SHARE NOWAIT;
 SELECT * INTO e FROM trustwork.session_elevation WHERE id=p_elevation FOR SHARE NOWAIT;
 PERFORM 1 FROM trustwork.staff_role_assignment WHERE person_id=p_person AND role='compliance-officer'
  AND scope_kind='node' AND node_id=p_node ORDER BY id FOR SHARE NOWAIT;
 at_time := clock_timestamp();
 IF s.person_id IS DISTINCT FROM p_person OR e.person_id IS DISTINCT FROM p_person OR e.session_id IS DISTINCT FROM s.id
  OR s.revoked_at IS NOT NULL OR e.revoked_at IS NOT NULL OR s.idle_expires_at <= at_time
  OR s.absolute_expires_at <= at_time OR e.expires_at <= at_time OR e.id IS NULL OR s.id IS NULL
  OR NOT EXISTS(SELECT 1 FROM trustwork.staff_role_assignment WHERE person_id=p_person AND role='compliance-officer'
   AND scope_kind='node' AND node_id=p_node AND revoked_at IS NULL AND valid_from<=at_time AND (valid_until IS NULL OR valid_until>at_time)) THEN
  RAISE EXCEPTION 'current authority unavailable' USING ERRCODE='42501', HINT='admin.forbidden';
 END IF;
EXCEPTION WHEN lock_not_available THEN
 RAISE EXCEPTION 'authority is being changed' USING ERRCODE='42501', HINT='admin.forbidden';
END $$;
CREATE FUNCTION trustwork.screening_list_current_actor(p_ctx jsonb,p_permission text) RETURNS trustwork.admin_actor
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE a trustwork.admin_actor; n uuid;
BEGIN
 SELECT id INTO n FROM trustwork.admin_node ORDER BY id LIMIT 1 FOR SHARE NOWAIT;
 PERFORM trustwork.screening_list_lock_person_authority(trustwork.current_person_id(),(p_ctx->>'elevationId')::uuid,n,trustwork.current_authz_epoch());
 a := trustwork.screening_staff_actor(p_ctx,p_permission);
 RETURN a;
EXCEPTION WHEN lock_not_available THEN
 RAISE EXCEPTION 'authority is being changed' USING ERRCODE='42501', HINT='admin.forbidden';
END $$;

CREATE OR REPLACE FUNCTION trustwork.screening_list_lock(p_list uuid)
RETURNS TABLE (id uuid, hub_id uuid, code text, adapter text, mode text, source_url text, status text, baseline boolean, max_drop_share numeric, min_entries integer,
  active_version_id uuid, active_digest text, active_entry_count integer, staged_version_id uuid, staged_digest text)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.screening_list_authority_lock();
  PERFORM 1 FROM trustwork.screening_list l WHERE l.id = p_list FOR UPDATE;
  RETURN QUERY
  SELECT l.id, l.hub_id, l.code, l.adapter, l.mode, l.source_url, l.status, l.baseline, l.max_drop_share, l.min_entries,
    a.id, a.digest, a.entry_count, s.id, s.digest
  FROM trustwork.screening_list l
  LEFT JOIN trustwork.screening_list_version a ON a.list_id = l.id AND a.state = 'active'
  LEFT JOIN trustwork.screening_list_version s ON s.list_id = l.id AND s.state = 'staged'
  WHERE l.id = p_list;
END $$;

CREATE OR REPLACE FUNCTION trustwork.screening_list_record_attempt(p_list uuid, p_outcome text, p_error text, p_confirmed_at timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.screening_list_authority_lock();
  IF (p_confirmed_at IS NOT NULL OR p_outcome IN ('unchanged','activated','needs_confirmation')) AND NOT trustwork.screening_list_source_current(p_list) THEN
    RAISE EXCEPTION 'registered source authority unavailable' USING ERRCODE='23514', HINT='screening.configuration_changed';
  END IF;
  UPDATE trustwork.screening_list l
     SET last_attempt_at = now(), last_outcome = p_outcome, last_error = left(p_error, 300),
         last_checked_at = CASE
           WHEN p_confirmed_at IS NULL OR NOT EXISTS (SELECT 1 FROM trustwork.screening_list_version a WHERE a.list_id = l.id AND a.state = 'active') THEN l.last_checked_at
           ELSE greatest(l.last_checked_at, least(p_confirmed_at, now())) END
   WHERE l.id = p_list;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such screening list' USING ERRCODE = 'no_data_found', HINT = 'screening.list_not_found';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION trustwork.screening_list_stage(p_list uuid, p_published_on date, p_fetched_at timestamptz, p_mode text, p_source_digest text, p_entry_count integer,
  p_digest text, p_sanity jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  l trustwork.screening_list%ROWTYPE;
  v_id uuid;
BEGIN
  PERFORM trustwork.screening_list_authority_lock();
  SELECT * INTO l FROM trustwork.screening_list WHERE id = p_list FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such screening list' USING ERRCODE = 'no_data_found', HINT = 'screening.list_not_found';
  END IF;
  IF p_mode IS DISTINCT FROM l.mode THEN
    RAISE EXCEPTION 'the version was not obtained in the list''s mode' USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.mode_mismatch';
  END IF;
  UPDATE trustwork.screening_list_version SET state = 'rejected', rejected_reason = 'replaced', decided_at = now() WHERE list_id = l.id AND state = 'staged';
  INSERT INTO trustwork.screening_list_version (list_id, version, published_on, fetched_at, mode, source_digest, entry_count, digest, sanity)
  VALUES (l.id, coalesce((SELECT max(version) FROM trustwork.screening_list_version WHERE list_id = l.id), 0) + 1, p_published_on, least(p_fetched_at, now()), p_mode,
    p_source_digest, p_entry_count, p_digest, p_sanity)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION trustwork.screening_list_add_entries(p_version uuid, p_entries jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_count integer;
BEGIN
  PERFORM trustwork.screening_list_authority_lock();
  IF jsonb_typeof(p_entries) <> 'array' OR jsonb_array_length(p_entries) > 2000 THEN
    RAISE EXCEPTION 'entries come as an array of at most 2000' USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.entries_batch';
  END IF;
  INSERT INTO trustwork.screening_list_entry (list_version_id, entry_uid, entry_type, primary_name, programs, name_keys, attributes, entry_digest)
  SELECT p_version, e.entry_uid, e.entry_type, e.primary_name, coalesce(e.programs, '{}'), e.name_keys, coalesce(e.attributes, '{}'::jsonb), e.entry_digest
  FROM jsonb_to_recordset(p_entries) AS e(entry_uid text, entry_type text, primary_name text, programs text[], name_keys text[], attributes jsonb, entry_digest text);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION trustwork.screening_list_activate_version(p_version uuid, p_person uuid, p_reason text) RETURNS text
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v trustwork.screening_list_version%ROWTYPE;
  l trustwork.screening_list%ROWTYPE;
  v_count integer;
  v_previous uuid;
  v_outcome text;
BEGIN
  PERFORM trustwork.screening_list_authority_lock();
  SELECT * INTO v FROM trustwork.screening_list_version WHERE id = p_version FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such list version' USING ERRCODE = 'no_data_found', HINT = 'screening.version_not_found';
  END IF;
  SELECT * INTO l FROM trustwork.screening_list WHERE id = v.list_id FOR UPDATE;
  IF NOT trustwork.screening_list_source_current(v.list_id) OR v.registered_source_id IS DISTINCT FROM l.source_id THEN
    RAISE EXCEPTION 'registered source authority unavailable' USING ERRCODE='23514', HINT='screening.configuration_changed';
  END IF;
  IF v.state <> 'staged' THEN
    RAISE EXCEPTION 'the list version is not staged' USING ERRCODE = '23514', HINT = 'screening.version_not_staged';
  END IF;
  SELECT count(*)::integer INTO v_count FROM trustwork.screening_list_entry WHERE list_version_id = v.id;
  IF v_count <> v.entry_count OR trustwork.screening_list_entries_digest(v.id) <> v.digest THEN
    UPDATE trustwork.screening_list_version SET state = 'rejected', rejected_reason = 'entries_mismatch', decided_at = now() WHERE id = v.id;
    RETURN 'rejected';
  END IF;
  v_outcome := v.sanity ->> 'outcome';
  IF v_outcome = 'rejected' THEN
    UPDATE trustwork.screening_list_version SET state = 'rejected', rejected_reason = coalesce(v.sanity -> 'reasons' ->> 0, 'sanity'), decided_at = now() WHERE id = v.id;
    RETURN 'rejected';
  END IF;
  IF v_outcome = 'needs_confirmation' AND p_person IS NULL THEN
    RETURN 'needs_confirmation';
  END IF;
  UPDATE trustwork.screening_list_version SET state = 'superseded', decided_at = now() WHERE list_id = v.list_id AND state = 'active' RETURNING id INTO v_previous;
  UPDATE trustwork.screening_list_version SET state = 'active', activated_at = now(), activated_by = p_person, activation_reason = CASE WHEN p_person IS NULL THEN NULL ELSE btrim(p_reason) END
   WHERE id = v.id;
  UPDATE trustwork.screening_list SET last_checked_at = least(v.fetched_at, now()) WHERE id = l.id;
  INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload)
  VALUES ('screening_list', l.id::text, v.version, 'screening.list_version_activated', jsonb_build_object(
    'listId', l.id, 'listCode', l.code, 'hubId', l.hub_id, 'baseline', l.baseline, 'versionId', v.id, 'version', v.version, 'previousVersionId', v_previous,
    'entryCount', v.entry_count, 'digest', v.digest, 'publishedOn', v.published_on, 'confirmedBy', p_person));
  RETURN 'activated';
END $$;

CREATE OR REPLACE FUNCTION trustwork.screening_list_reject(p_version uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  PERFORM trustwork.screening_list_authority_lock();
  UPDATE trustwork.screening_list_version SET state = 'rejected', rejected_reason = p_reason, decided_at = now() WHERE id = p_version AND state = 'staged';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the list version is not staged' USING ERRCODE = '23514', HINT = 'screening.version_not_staged';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION trustwork.screening_list_set_status(p_ctx jsonb, p_list uuid, p_status text, p_reason text) RETURNS trustwork.screening_list
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_before trustwork.screening_list%ROWTYPE;
  v_after trustwork.screening_list%ROWTYPE;
BEGIN
  PERFORM trustwork.screening_list_authority_lock();
  IF p_status NOT IN ('active', 'paused') THEN
    RAISE EXCEPTION 'status is active or paused' USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.invalid_status';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'a reason is required' USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.reason_required';
  END IF;
  SELECT * INTO v_before FROM trustwork.screening_list WHERE id = p_list FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such screening list' USING ERRCODE = 'no_data_found', HINT = 'screening.list_not_found';
  END IF;
  IF v_before.baseline THEN
    RAISE EXCEPTION 'the baseline lists cannot be paused' USING ERRCODE = 'insufficient_privilege', HINT = 'screening.baseline_list';
  END IF;
  v_actor := trustwork.screening_list_current_actor(p_ctx,'admin.screening.lists.manage');
  UPDATE trustwork.screening_list SET status = p_status WHERE id = p_list RETURNING * INTO v_after;
  -- Digest inputs carry integers only: the share is recorded as text.
  PERFORM trustwork.admin_record(v_actor, p_ctx, trustwork.jurisdiction_node(), NULL, 'screening.list_status_set', 'screening_list', v_after.id,
    to_jsonb(v_before) || jsonb_build_object('max_drop_share', v_before.max_drop_share::text), to_jsonb(v_after) || jsonb_build_object('max_drop_share', v_after.max_drop_share::text));
  RETURN v_after;
END $$;

CREATE OR REPLACE FUNCTION trustwork.screening_list_confirm_version(p_ctx jsonb, p_version uuid, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_before trustwork.screening_list_version%ROWTYPE;
  v_after trustwork.screening_list_version%ROWTYPE;
  v_outcome text;
BEGIN
  PERFORM trustwork.screening_list_authority_lock();
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'a reason is required' USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.reason_required';
  END IF;
  SELECT * INTO v_before FROM trustwork.screening_list_version WHERE id = p_version FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such list version' USING ERRCODE = 'no_data_found', HINT = 'screening.version_not_found';
  END IF;
  IF v_before.state <> 'staged' OR v_before.sanity ->> 'outcome' <> 'needs_confirmation' THEN
    RAISE EXCEPTION 'only a staged version waiting for confirmation can be confirmed' USING ERRCODE = '23514', HINT = 'screening.confirmation_not_needed';
  END IF;
  v_actor := trustwork.screening_list_current_actor(p_ctx,'admin.screening.lists.confirm');
  v_outcome := trustwork.screening_list_activate_version(p_version, v_actor.person_id, p_reason);
  SELECT * INTO v_after FROM trustwork.screening_list_version WHERE id = p_version;
  -- Digest inputs carry integers only: the sanity record (with its shares) is recorded as text.
  PERFORM trustwork.admin_record(v_actor, p_ctx, trustwork.jurisdiction_node(), NULL, 'screening.list_version_confirmed', 'screening_list_version', p_version,
    to_jsonb(v_before) || jsonb_build_object('sanity', v_before.sanity::text), to_jsonb(v_after) || jsonb_build_object('sanity', v_after.sanity::text));
  RETURN v_outcome;
END $$;

CREATE OR REPLACE FUNCTION trustwork.screening_list_version_authority_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
   SELECT source_id INTO NEW.registered_source_id FROM trustwork.screening_list WHERE id=NEW.list_id;
 ELSIF NEW.registered_source_id IS DISTINCT FROM OLD.registered_source_id THEN
   RAISE EXCEPTION 'version source snapshot is immutable' USING ERRCODE='23514';
 END IF;
 IF (TG_OP='INSERT' OR NEW.state='active') AND
   (NOT trustwork.screening_list_source_current(NEW.list_id) OR EXISTS(
    SELECT 1 FROM trustwork.screening_list WHERE id=NEW.list_id AND
      (mode IS DISTINCT FROM NEW.mode OR source_id IS DISTINCT FROM NEW.registered_source_id))) THEN
   RAISE EXCEPTION 'registered source authority unavailable' USING ERRCODE='23514', HINT='screening.configuration_changed';
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION trustwork.screening_list_propose(p_ctx jsonb, p_input jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
 a trustwork.admin_actor;
 s trustwork.screening_list_source%ROWTYPE;
 h uuid := (p_input->>'hubId')::uuid;
 i uuid := trustwork.new_uuid(); b text; d text;
BEGIN
 PERFORM trustwork.screening_list_authority_lock();
 IF p_input - ARRAY['hubId','sourceId','cadenceSeconds','warnAfterSeconds','staleAfterSeconds','reason','evidence'] <> '{}'::jsonb THEN
   RAISE EXCEPTION 'unknown configuration field' USING ERRCODE = '22023', HINT = 'screening.invalid_configuration';
 END IF;
 PERFORM 1 FROM trustwork.hub_profile WHERE hub_id = h AND node_id = trustwork.jurisdiction_node() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'hub unavailable' USING ERRCODE = 'P0002', HINT = 'access.not_found'; END IF;
 SELECT * INTO s FROM trustwork.screening_list_source WHERE id = (p_input->>'sourceId')::uuid AND current FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'source unavailable' USING ERRCODE = 'P0002', HINT = 'access.not_found'; END IF;
 PERFORM 1 FROM trustwork.screening_list WHERE hub_id=h AND code=s.code FOR UPDATE;
 a := trustwork.screening_list_current_actor(p_ctx,'admin.screening.lists.manage');
 b := trustwork.screening_list_configuration_digest(h, s.code);
 d := trustwork.admin_digest(jsonb_build_object('action','screening.configure_file_list','proposalId',i,'input',p_input,'sourceDigest',s.source_digest,'beforeDigest',b,'requestedBy',a.person_id,'requestedElevationId',a.elevation_id,'authorityNodeId',trustwork.jurisdiction_node()));
 INSERT INTO trustwork.screening_list_proposal(id, hub_id, source_id, requested_by, cadence_seconds, warn_after_seconds, stale_after_seconds, reason, evidence, before_digest, action_digest, requested_elevation_id, authority_node_id, requested_authz_epoch)
 VALUES (i,h,s.id,a.person_id,(p_input->>'cadenceSeconds')::integer,(p_input->>'warnAfterSeconds')::integer,(p_input->>'staleAfterSeconds')::integer,p_input->>'reason',p_input->>'evidence',b,d,a.elevation_id,trustwork.jurisdiction_node(),trustwork.current_authz_epoch());
 PERFORM trustwork.admin_record(a,p_ctx,trustwork.jurisdiction_node(),h,'screening.list_configuration_proposed','screening_list_proposal',i,NULL,p_input || jsonb_build_object('actionDigest',d));
 RETURN i;
END $$;

CREATE OR REPLACE FUNCTION trustwork.screening_list_decide(p_ctx jsonb, p_id uuid, p_decision text, p_digest text, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
 a trustwork.admin_actor;
 p trustwork.screening_list_proposal%ROWTYPE; s trustwork.screening_list_source%ROWTYPE; l uuid;
BEGIN
 PERFORM trustwork.screening_list_authority_lock();
 IF p_decision IS NULL OR p_decision NOT IN ('approve','reject') OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
   RAISE EXCEPTION 'decision and reason required' USING ERRCODE = '22023', HINT = 'screening.reason_required';
 END IF;
 SELECT * INTO p FROM trustwork.screening_list_proposal WHERE id = p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'proposal unavailable' USING ERRCODE = 'P0002', HINT = 'access.not_found'; END IF;
 PERFORM 1 FROM trustwork.hub_profile WHERE hub_id = p.hub_id AND node_id = trustwork.jurisdiction_node() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'hub unavailable' USING ERRCODE = 'P0002', HINT = 'access.not_found'; END IF;
 IF p.requested_by = trustwork.current_person_id() THEN RAISE EXCEPTION 'independent reviewer required' USING ERRCODE = '42501', HINT = 'screening.second_person_required'; END IF;
 IF p.action_digest IS DISTINCT FROM p_digest THEN RAISE EXCEPTION 'digest mismatch' USING ERRCODE = '23514', HINT = 'access.approval_digest_mismatch'; END IF;
 IF p.state <> 'pending' THEN RAISE EXCEPTION 'proposal decided' USING ERRCODE = '23514', HINT = 'admin.approval_not_pending'; END IF;
 SELECT * INTO s FROM trustwork.screening_list_source WHERE id=p.source_id FOR SHARE;
 PERFORM 1 FROM trustwork.screening_list WHERE hub_id=p.hub_id AND code=s.code FOR UPDATE;
 a := trustwork.screening_list_current_actor(p_ctx,'admin.screening.lists.manage');
 IF p.authority_node_id IS DISTINCT FROM trustwork.jurisdiction_node() THEN
  RAISE EXCEPTION 'scope changed' USING ERRCODE='42501', HINT='admin.forbidden';
 END IF;
 PERFORM trustwork.screening_list_lock_person_authority(p.requested_by,p.requested_elevation_id,p.authority_node_id,p.requested_authz_epoch);
 IF p_decision = 'approve' THEN
   IF p.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'proposal expired' USING ERRCODE = '23514', HINT = 'admin.approval_expired'; END IF;
   SELECT * INTO s FROM trustwork.screening_list_source WHERE id = p.source_id AND current FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'source retired' USING ERRCODE = '23514', HINT = 'screening.configuration_changed'; END IF;
   PERFORM 1 FROM trustwork.screening_list WHERE hub_id=p.hub_id AND code=s.code FOR UPDATE;
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

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
