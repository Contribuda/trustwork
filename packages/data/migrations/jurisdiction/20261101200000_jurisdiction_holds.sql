-- SANC-001: jurisdiction holds and refusal counters (ADR 014 decisions 6 to 9; data model section 24a).
--
-- A request from a restricted place is refused at every door. When it carries a valid session, the person is held: a
-- jurisdiction_hold row names the place, the source, the geolocation dataset and the time, never a network address.
-- An open hold refuses the person on every request and at every sign-in until a compliance reviewer clears it with a
-- reason and an evidence category. The subject can never clear their own hold. At most one hold is open per person;
-- a second sighting keeps the first. Rows are never deleted: they are sanctions records kept for the pack's
-- record-keeping period through a person's erasure (US: ten years, 31 CFR 501.601), naming the erasure tombstone.
--
-- Writes happen only through the SECURITY DEFINER commands below:
--   jurisdiction_hold_session   the API gate, holding the person of a live session (possessing the token is required,
--                               so no caller can hold someone by naming them)
--   jurisdiction_session_held   the API gate, per request: is the session's person held?
--   jurisdiction_hold_open      sign-in, inside the principal transaction: is the caller held?
--   jurisdiction_count_refusal  per-day refusal counters (no person, no address)
--   jurisdiction_clear_hold     a compliance officer of the node under an elevation, never the subject, audited
-- No column of this module stores a network address.

-- 1. Holds -------------------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.jurisdiction_hold (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  place text NOT NULL CHECK (place ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'),
  source text NOT NULL CHECK (source IN ('geolocation', 'edge_header', 'self_declared', 'payout_country', 'staff_report')),
  dataset text NOT NULL CHECK (dataset ~ '^[a-z0-9][a-z0-9:_-]{0,99}$'),
  placed_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz NULL,
  cleared_by uuid NULL REFERENCES trustwork.person (id),
  clear_reason text NULL CHECK (length(btrim(clear_reason)) BETWEEN 1 AND 500),
  clear_evidence text NULL CHECK (clear_evidence IN ('document', 'call', 'travel_record', 'other')),
  CONSTRAINT jurisdiction_hold_cleared_is_whole CHECK (
    (cleared_at IS NULL AND cleared_by IS NULL AND clear_reason IS NULL AND clear_evidence IS NULL)
    OR (cleared_at IS NOT NULL AND cleared_by IS NOT NULL AND clear_reason IS NOT NULL AND clear_evidence IS NOT NULL)),
  CONSTRAINT jurisdiction_hold_not_self_cleared CHECK (cleared_by IS DISTINCT FROM person_id)
);
-- At most one open hold per person; the per-request check reads it by person.
CREATE UNIQUE INDEX jurisdiction_hold_open ON trustwork.jurisdiction_hold (person_id) WHERE cleared_at IS NULL;
CREATE INDEX jurisdiction_hold_person_idx ON trustwork.jurisdiction_hold (person_id, placed_at);

-- Only the clear columns change, once, and nothing is ever deleted.
CREATE FUNCTION trustwork.jurisdiction_hold_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'jurisdiction holds are sanctions records and are never deleted' USING ERRCODE = '23514', HINT = 'jurisdiction.hold_permanent';
  END IF;
  IF NEW.id <> OLD.id OR NEW.person_id <> OLD.person_id OR NEW.place <> OLD.place OR NEW.source <> OLD.source OR NEW.dataset <> OLD.dataset OR NEW.placed_at <> OLD.placed_at THEN
    RAISE EXCEPTION 'a hold''s sighting is immutable' USING ERRCODE = '23514', HINT = 'jurisdiction.hold_immutable';
  END IF;
  IF OLD.cleared_at IS NOT NULL THEN
    RAISE EXCEPTION 'a cleared hold stays as it was cleared' USING ERRCODE = '23514', HINT = 'jurisdiction.hold_cleared';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jurisdiction_hold_guard BEFORE UPDATE OR DELETE ON trustwork.jurisdiction_hold FOR EACH ROW EXECUTE FUNCTION trustwork.jurisdiction_hold_guard();
CREATE TRIGGER jurisdiction_hold_no_truncate BEFORE TRUNCATE ON trustwork.jurisdiction_hold FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

-- 2. Refusal counters --------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.jurisdiction_refusal_count (
  day date NOT NULL,
  place text NOT NULL CHECK (place ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'),
  door text NOT NULL CHECK (door IN ('web', 'api')),
  refusals integer NOT NULL DEFAULT 0 CHECK (refusals >= 0),
  holds integer NOT NULL DEFAULT 0 CHECK (holds >= 0),
  PRIMARY KEY (day, place, door)
);

-- 3. Helpers -----------------------------------------------------------------------------------------------------------
-- The node anchor staff permissions are resolved against (DATA-002); NULL before the setup wizard created it, in which
-- case only platform-scoped staff hold permissions.
CREATE FUNCTION trustwork.jurisdiction_node() RETURNS uuid
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT id FROM trustwork.admin_node LIMIT 1
$$;

-- The person of a live session, or NULL (revoked, expired or unknown token).
CREATE FUNCTION trustwork.jurisdiction_session_person(p_token_hash bytea) RETURNS uuid
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT s.person_id FROM trustwork.session s
  WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.idle_expires_at > now() AND s.absolute_expires_at > now()
$$;

-- 4. Commands ----------------------------------------------------------------------------------------------------------
-- The gate holds the person of a live session seen in a restricted place. The place must be restricted by the synced
-- kernel list (an unsynced list counts every place as restricted, fail closed). Answers true when this call opened a
-- hold, false when the session is not live or a hold was already open (the first sighting stands).
CREATE FUNCTION trustwork.jurisdiction_hold_session(p_token_hash bytea, p_place text, p_source text, p_dataset text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid;
  v_id uuid;
BEGIN
  IF p_token_hash IS NULL OR octet_length(p_token_hash) <> 32 THEN
    RETURN false;
  END IF;
  IF p_source NOT IN ('geolocation', 'edge_header') THEN
    RAISE EXCEPTION 'the gate records only geolocation and edge-header sightings' USING ERRCODE = 'invalid_parameter_value', HINT = 'jurisdiction.invalid_source';
  END IF;
  IF p_place IS NULL OR p_place !~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$' OR NOT trustwork.kernel_place_restricted(p_place) THEN
    RAISE EXCEPTION 'not a restricted place' USING ERRCODE = 'invalid_parameter_value', HINT = 'jurisdiction.not_restricted';
  END IF;
  v_person := trustwork.jurisdiction_session_person(p_token_hash);
  IF v_person IS NULL THEN
    RETURN false;
  END IF;
  INSERT INTO trustwork.jurisdiction_hold (person_id, place, source, dataset)
  VALUES (v_person, p_place, p_source, p_dataset)
  ON CONFLICT (person_id) WHERE cleared_at IS NULL DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END $$;

-- Per request: is the person of this live session held? (Possessing the token is the only way to ask.)
CREATE FUNCTION trustwork.jurisdiction_session_held(p_token_hash bytea) RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT EXISTS (
    SELECT 1 FROM trustwork.jurisdiction_hold h
    WHERE h.cleared_at IS NULL AND h.person_id = trustwork.jurisdiction_session_person(p_token_hash))
$$;

-- Sign-in, inside the principal transaction of the person being signed in: is the caller held?
CREATE FUNCTION trustwork.jurisdiction_hold_open() RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND EXISTS (
    SELECT 1 FROM trustwork.jurisdiction_hold h WHERE h.cleared_at IS NULL AND h.person_id = trustwork.current_person_id())
$$;

-- One refusal (and whether it held someone) for today's counter of the place and door.
CREATE FUNCTION trustwork.jurisdiction_count_refusal(p_place text, p_door text, p_held boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF p_place IS NULL OR p_place !~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$' OR NOT trustwork.kernel_place_restricted(p_place) THEN
    RAISE EXCEPTION 'not a restricted place' USING ERRCODE = 'invalid_parameter_value', HINT = 'jurisdiction.not_restricted';
  END IF;
  INSERT INTO trustwork.jurisdiction_refusal_count (day, place, door, refusals, holds)
  VALUES ((now() AT TIME ZONE 'UTC')::date, p_place, p_door, 1, CASE WHEN p_held THEN 1 ELSE 0 END)
  ON CONFLICT (day, place, door) DO UPDATE
    SET refusals = trustwork.jurisdiction_refusal_count.refusals + 1,
        holds = trustwork.jurisdiction_refusal_count.holds + EXCLUDED.holds;
END $$;

-- Is the caller a compliance officer of this node (or an auditor, for reads)? Role-based until the console vocabulary
-- gains the admin.screening.* permissions (SANC-006); the audit row names the permission admin.screening.holds.clear.
CREATE FUNCTION trustwork.jurisdiction_staff_reader() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND trustwork.jurisdiction_node() IS NOT NULL
    AND (trustwork.admin_person_is_staff(trustwork.current_person_id(), trustwork.jurisdiction_node(), NULL, 'compliance-officer')
      OR trustwork.admin_person_is_staff(trustwork.current_person_id(), trustwork.jurisdiction_node(), NULL, 'auditor'))
$$;

-- Clear a hold: a compliance officer of the node, under an elevation, who is not the subject, after establishing that
-- the person is not in a restricted place. The row lock serialises concurrent reviewers: exactly one clears, the other
-- sees jurisdiction.hold_cleared. Audited through admin_record with the reason; the API tells the person.
CREATE FUNCTION trustwork.jurisdiction_clear_hold(p_ctx jsonb, p_hold uuid, p_reason text, p_evidence text) RETURNS trustwork.jurisdiction_hold
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_node uuid := trustwork.jurisdiction_node();
  v_elevation uuid := trustwork.admin_require_elevation(p_ctx);
  v_person uuid := trustwork.current_person_id();
  v_breakglass boolean;
  v_actor trustwork.admin_actor;
  v_before trustwork.jurisdiction_hold%ROWTYPE;
  v_after trustwork.jurisdiction_hold%ROWTYPE;
BEGIN
  SELECT a.breakglass INTO v_breakglass FROM trustwork.staff_role_assignment a
   WHERE a.person_id = v_person AND a.role = 'compliance-officer' AND a.scope_kind = 'node' AND a.node_id = v_node
     AND a.revoked_at IS NULL AND a.valid_from <= now() AND (a.valid_until IS NULL OR a.valid_until > now())
   ORDER BY a.breakglass LIMIT 1;
  IF v_node IS NULL OR NOT FOUND THEN
    RAISE EXCEPTION 'only a compliance officer of this node clears a hold' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.forbidden';
  END IF;
  v_actor := ROW(v_person, 'compliance-officer', v_breakglass, v_elevation, 'admin.screening.holds.clear')::trustwork.admin_actor;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'a reason is required' USING ERRCODE = 'invalid_parameter_value', HINT = 'jurisdiction.reason_required';
  END IF;
  SELECT * INTO v_before FROM trustwork.jurisdiction_hold WHERE id = p_hold FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such hold' USING ERRCODE = 'no_data_found', HINT = 'jurisdiction.hold_not_found';
  END IF;
  IF v_before.person_id = v_person THEN
    RAISE EXCEPTION 'a hold is never cleared by its subject' USING ERRCODE = 'insufficient_privilege', HINT = 'jurisdiction.self_clear';
  END IF;
  IF trustwork.admin_conflicted(v_person, v_before.person_id, NULL) THEN
    RAISE EXCEPTION 'the reviewer declared a conflict of interest with the subject' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.conflict_of_interest';
  END IF;
  IF v_before.cleared_at IS NOT NULL THEN
    RAISE EXCEPTION 'the hold is already cleared' USING ERRCODE = '23514', HINT = 'jurisdiction.hold_cleared';
  END IF;
  UPDATE trustwork.jurisdiction_hold
     SET cleared_at = now(), cleared_by = v_person, clear_reason = btrim(p_reason), clear_evidence = p_evidence
   WHERE id = p_hold
  RETURNING * INTO v_after;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_node, NULL, 'jurisdiction.hold_cleared', 'jurisdiction_hold', v_after.id, to_jsonb(v_before), to_jsonb(v_after));
  RETURN v_after;
END $$;

-- 5. Row-level security and grants --------------------------------------------------------------------------------------
ALTER TABLE trustwork.jurisdiction_hold ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.jurisdiction_hold FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.jurisdiction_refusal_count ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.jurisdiction_refusal_count FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.jurisdiction_hold AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.jurisdiction_refusal_count AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
-- Compliance staff read holds and counters; the subject reads neither (they get held or not from the API).
CREATE POLICY jurisdiction_hold_staff_read ON trustwork.jurisdiction_hold FOR SELECT TO trustwork_app USING (trustwork.jurisdiction_staff_reader());
CREATE POLICY jurisdiction_refusal_count_staff_read ON trustwork.jurisdiction_refusal_count FOR SELECT TO trustwork_app USING (trustwork.jurisdiction_staff_reader());

GRANT SELECT ON trustwork.jurisdiction_hold, trustwork.jurisdiction_refusal_count TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.jurisdiction_node(), trustwork.jurisdiction_hold_session(bytea, text, text, text), trustwork.jurisdiction_session_held(bytea),
  trustwork.jurisdiction_hold_open(), trustwork.jurisdiction_count_refusal(text, text, boolean), trustwork.jurisdiction_staff_reader(), trustwork.jurisdiction_clear_hold(jsonb, uuid, text, text) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
