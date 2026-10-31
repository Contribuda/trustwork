-- DATA-001 core: trusted transaction-local identity, maintenance flag, reusable trigger functions.
-- Runs as trustwork_owner inside one transaction (search_path = trustwork, pg_temp set by the runner).
-- Roles (trustwork_owner, trustwork_app) and the schema/ledger are created by the runner bootstrap, not here,
-- because they are cluster-level objects that cannot be recorded per database.

-- Functions created later by trustwork_owner must never be executable by PUBLIC; the allowlist grants EXECUTE explicitly.
-- (A per-schema default cannot revoke the built-in global PUBLIC EXECUTE, so this is the owner's global default;
-- every migration additionally revokes PUBLIC from all functions in the schema as a belt-and-braces step.)
ALTER DEFAULT PRIVILEGES FOR ROLE trustwork_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
REVOKE CREATE ON SCHEMA trustwork FROM PUBLIC;
GRANT USAGE ON SCHEMA trustwork TO trustwork_app;

-- UUID generation: time-ordered uuidv7 on PostgreSQL 18+, random v4 otherwise (checked at call time).
CREATE FUNCTION trustwork.new_uuid() RETURNS uuid
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  IF current_setting('server_version_num')::integer >= 180000 THEN
    RETURN uuidv7();
  END IF;
  RETURN gen_random_uuid();
END $$;

-- Identity readers: missing or empty setting means "no identity" and every policy denies (fail closed).
CREATE FUNCTION trustwork.current_person_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('trustwork.person_id', true), '')::uuid
$$;

-- Company context exists only together with a person (the setter derives it from the active membership).
CREATE FUNCTION trustwork.current_company_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN NULLIF(current_setting('trustwork.person_id', true), '') IS NULL THEN NULL
              ELSE NULLIF(current_setting('trustwork.company_id', true), '')::uuid END
$$;

CREATE FUNCTION trustwork.current_authz_epoch() RETURNS integer
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('trustwork.authz_epoch', true), '')::integer
$$;

-- Maintenance identity: only meaningful for policies declared TO trustwork_owner (migration runner, definer functions).
CREATE FUNCTION trustwork.maintenance_on() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT current_setting('trustwork.maintenance', true) = 'on'
$$;

-- Generic row bookkeeping: revision +1 and updated_at on every UPDATE.
CREATE FUNCTION trustwork.touch_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;

-- Append-only tables: any UPDATE or DELETE raises, for every role including the owner.
CREATE FUNCTION trustwork.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (% rejected)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
END $$;

-- Reusable immutability guard for versioned commercial rows (COM-001 attaches it to rfq_version / quote_version).
-- Trigger arguments: status column, mutable status value, then the frozen column names.
-- Once the row's status is not the mutable value, an UPDATE touching any frozen column raises,
-- and the status can never return to the mutable value.
CREATE FUNCTION trustwork.reject_update_when_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status_col text := TG_ARGV[0];
  v_mutable text := TG_ARGV[1];
  v_old jsonb := to_jsonb(OLD);
  v_new jsonb := to_jsonb(NEW);
  v_col text;
  i integer;
BEGIN
  IF TG_NARGS < 3 THEN
    RAISE EXCEPTION 'reject_update_when_frozen requires status column, mutable value and at least one frozen column';
  END IF;
  IF (v_old ->> v_status_col) IS DISTINCT FROM v_mutable THEN
    IF (v_new ->> v_status_col) IS NOT DISTINCT FROM v_mutable THEN
      RAISE EXCEPTION 'row in table % cannot return to status %', TG_TABLE_NAME, v_mutable
        USING ERRCODE = 'integrity_constraint_violation', HINT = 'commercial.version_frozen';
    END IF;
    FOR i IN 2 .. TG_NARGS - 1 LOOP
      v_col := TG_ARGV[i];
      IF (v_old -> v_col) IS DISTINCT FROM (v_new -> v_col) THEN
        RAISE EXCEPTION 'column % of table % is frozen once status is not %', v_col, TG_TABLE_NAME, v_mutable
          USING ERRCODE = 'integrity_constraint_violation', HINT = 'commercial.version_frozen';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;

-- Allowlisted helper for policies and application code; no table access.
GRANT EXECUTE ON FUNCTION trustwork.current_person_id(), trustwork.current_company_id(), trustwork.current_authz_epoch(), trustwork.new_uuid() TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
