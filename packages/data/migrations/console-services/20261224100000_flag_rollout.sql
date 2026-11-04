-- ADM-005 part 1: rollout stages of a feature flag (docs/engine/hub-console/console-design.md, section 6.2; contract
-- packages/contracts/src/console-services.ts).
--
-- A flag moves off -> staff only -> a share of people (1, 5, 25 or 50 percent, deterministic buckets) -> on. The stage
-- lives beside the flag and changes nothing about what a flag is: feature_flag still refuses access, projection, egress
-- and ranking words and values, and a stage only says for whom the flag is in force.
--
-- * A stage cannot target a person. The table has a stage and a percent; it has no person, company, session or list
--   column, so no writer can store one. The bucket comes from the flag's server-chosen id and the person id, so signing
--   in again cannot reach a share, and only a percent of people is selected; the application computes it
--   (flag-buckets.ts), nothing stores it.
-- * Off is immediate and needs one person: it takes no revision, so a flag can always be stopped whatever anyone else is
--   doing, and every read sees the row as it is (no cache, no job). Any other stage restates the revision it was decided
--   on, so a widening prepared before someone turned the flag off is refused and cannot switch it back on.
-- * A new flag starts off. Flags that existed before this migration keep working as they did, at stage on.
-- * Extending an expired flag brings it back at off, with a new revision. It was out of force, whoever looks at it now
--   decided nothing about it, and it must not return for everyone by a change of date. This is a trigger, so it holds
--   for every writer of feature_flag; the flags.set audit row of the extension records the act.
-- * No flag may be about ranking, matching, reputation or payment (FLAG_REFUSED_KEY): payment never changes the first
--   three, so a flag cannot reach any of them. feature_flag refused ranking and access words already. Existing rows are
--   not validated but are set off here, and any rewrite of them is refused.

CREATE TABLE trustwork.feature_flag_rollout (
  flag_id uuid PRIMARY KEY REFERENCES trustwork.feature_flag (id),
  stage text NOT NULL DEFAULT 'off' CHECK (stage IN ('off', 'staff_only', 'share', 'on')),
  share_percent integer NULL CHECK (share_percent IN (1, 5, 25, 50)),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feature_flag_rollout_share_shape CHECK ((stage = 'share') = (share_percent IS NOT NULL))
);
CREATE FUNCTION trustwork.console_rollout_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a flag keeps its rollout; set it off' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF NEW.flag_id <> OLD.flag_id THEN
    RAISE EXCEPTION 'a rollout belongs to its flag' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  -- Not touch_row, which keeps the revision of an unchanged row: turning off a flag that is already off still ends every
  -- widening decided on the revision before it.
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER feature_flag_rollout_guard BEFORE UPDATE OR DELETE ON trustwork.feature_flag_rollout FOR EACH ROW EXECUTE FUNCTION trustwork.console_rollout_guard();

-- Every flag has a rollout from the moment it exists, whichever writer made it.
CREATE FUNCTION trustwork.console_flag_rollout_born() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  INSERT INTO trustwork.feature_flag_rollout (flag_id) VALUES (NEW.id);
  RETURN NULL;
END $$;
CREATE TRIGGER feature_flag_rollout_born AFTER INSERT ON trustwork.feature_flag FOR EACH ROW EXECUTE FUNCTION trustwork.console_flag_rollout_born();

ALTER TABLE trustwork.feature_flag_rollout ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.feature_flag_rollout FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.feature_flag_rollout AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
-- As feature_flag: no personal or private data, and every runtime honours a stage.
CREATE POLICY feature_flag_rollout_read ON trustwork.feature_flag_rollout FOR SELECT TO trustwork_app USING (true);
CREATE POLICY feature_flag_rollout_worker_read ON trustwork.feature_flag_rollout FOR SELECT TO trustwork_worker USING (true);
GRANT SELECT ON trustwork.feature_flag_rollout TO trustwork_app, trustwork_worker;

ALTER TABLE trustwork.feature_flag ADD CONSTRAINT feature_flag_key_no_outcome CHECK (key !~ '(^|[._])(rank|match|reput|payment|payout|sponsor|recommend)') NOT VALID;

SET LOCAL trustwork.maintenance = 'on';
INSERT INTO trustwork.feature_flag_rollout (flag_id, stage)
SELECT f.id, CASE WHEN f.key ~ '(^|[._])(rank|match|reput|payment|payout|sponsor|recommend)' THEN 'off' ELSE 'on' END FROM trustwork.feature_flag f;
SET LOCAL trustwork.maintenance = 'off';

-- An expired flag that gets a future expiry returns at off, and the revision moves, so nothing decided before it applies.
CREATE FUNCTION trustwork.console_flag_revived() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF OLD.expires_at <= now() AND NEW.expires_at > now() THEN
    UPDATE trustwork.feature_flag_rollout SET stage = 'off', share_percent = NULL WHERE flag_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER feature_flag_rollout_revived AFTER UPDATE OF expires_at ON trustwork.feature_flag FOR EACH ROW EXECUTE FUNCTION trustwork.console_flag_revived();

-- The one command that moves a stage (admin.flags.edit at the flag's own scope).
CREATE FUNCTION trustwork.console_flag_set_stage(p_ctx jsonb, p_flag uuid, p_stage text, p_share integer, p_expected_revision integer) RETURNS trustwork.feature_flag_rollout
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_flag trustwork.feature_flag%ROWTYPE;
  v_before trustwork.feature_flag_rollout%ROWTYPE;
  v_row trustwork.feature_flag_rollout%ROWTYPE;
  v_actor trustwork.admin_actor;
BEGIN
  SELECT * INTO v_flag FROM trustwork.feature_flag WHERE id = p_flag;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such flag' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.flags.edit'], v_flag.node_id, v_flag.hub_id);
  SELECT * INTO v_before FROM trustwork.feature_flag_rollout WHERE flag_id = p_flag FOR UPDATE;
  IF p_stage <> 'off' THEN
    IF p_expected_revision IS DISTINCT FROM v_before.revision THEN
      RAISE EXCEPTION 'the flag changed since this stage was decided' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
    END IF;
    IF v_flag.expires_at <= now() THEN
      RAISE EXCEPTION 'an expired flag stays off; extend it first' USING ERRCODE = 'check_violation', HINT = 'admin.invalid_transition';
    END IF;
  END IF;
  UPDATE trustwork.feature_flag_rollout SET stage = p_stage, share_percent = p_share WHERE flag_id = p_flag RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_flag.node_id, v_flag.hub_id, 'flags.stage_' || p_stage, 'feature_flag', p_flag, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.console_flag_set_stage(jsonb, uuid, text, integer, integer) TO trustwork_app;
