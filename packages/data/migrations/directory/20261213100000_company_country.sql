-- Trusted company country (issue #592, the launch blocker recorded in #563). `hub_territory` gives each hub its
-- countries, but a company had none, and what ties a company to a place (`company_profile.region_code`, the
-- `jurisdiction` columns of its records) comes from the company or from the claim's own reviewer. This column is the
-- link claim review follows (next migration).
--
-- Rules the schema holds:
--   * a company gets its country when it is created: `directory_create_company` requires one, and a sourced row is
--     refused without one, so whatever imports companies later has to bring it;
--   * the country is an ISO 3166-1 code of a selectable, live jurisdiction, and never a restricted place. With no
--     restricted list loaded every place counts as restricted, so nothing is accepted (kernel_place_restricted);
--   * a change needs a correction row of the same transaction, for every role, maintenance included. Only
--     `directory_correct_company_country` writes one: audited, a person holding `admin.claims.authority.decide` at a
--     hub whose territories contain the old or the new country;
--   * rows that exist today stay NULL. Nothing guesses a country for them; claim review refuses them until a correction
--     sets one.

ALTER TABLE trustwork.company ADD COLUMN country_code text NULL CHECK (country_code ~ '^[A-Z]{2}$');

CREATE TABLE trustwork.company_country_correction (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  company_id uuid NOT NULL REFERENCES trustwork.company (id),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  from_country text NULL CHECK (from_country ~ '^[A-Z]{2}$'),
  to_country text NOT NULL CHECK (to_country ~ '^[A-Z]{2}$'),
  corrected_by uuid NOT NULL REFERENCES trustwork.person (id),
  corrected_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_country_correction_moves CHECK (from_country IS DISTINCT FROM to_country)
);
CREATE INDEX company_country_correction_company_idx ON trustwork.company_country_correction (company_id, corrected_at);
CREATE TRIGGER company_country_correction_append_only BEFORE UPDATE OR DELETE ON trustwork.company_country_correction FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- Whether a company may be placed in this country: selectable, live and not restricted, whatever the stored flags say.
CREATE FUNCTION trustwork.directory_country_ok(p_code text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT NOT trustwork.kernel_place_restricted(p_code)
     AND EXISTS (SELECT 1 FROM trustwork.jurisdiction j WHERE j.code = p_code AND j.level = 'country' AND j.selectable AND NOT j.restricted AND j.retired_at IS NULL)
$$;

-- Whether a hub's territories contain the country. A region or a place inside it does not: the territory has to hold
-- the place, not the place the territory, the direction `payments` uses for the same question.
CREATE FUNCTION trustwork.directory_hub_covers(p_hub uuid, p_country text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM trustwork.hub_territory t WHERE t.hub_id = p_hub AND t.code = p_country)
$$;

-- The same answer for a command that writes on it: the territory row stays locked until the transaction ends, so
-- `hubs_remove_territory` cannot take it away between this check and the write. A removal in flight is waited for, and
-- then the row is gone. A country restricted since it was added counts as covered by nobody.
CREATE FUNCTION trustwork.directory_lock_hub_cover(p_hub uuid, p_country text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
BEGIN
  PERFORM 1 FROM trustwork.hub_territory t WHERE t.hub_id = p_hub AND t.code = p_country FOR SHARE;
  RETURN FOUND AND NOT trustwork.kernel_place_restricted(p_country);
END $$;

CREATE FUNCTION trustwork.directory_company_country_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.country_code IS NOT DISTINCT FROM OLD.country_code THEN
      RETURN NEW;
    END IF;
    IF NEW.country_code IS NULL OR NOT EXISTS (
      SELECT 1 FROM trustwork.company_country_correction r
       WHERE r.company_id = NEW.id AND r.from_country IS NOT DISTINCT FROM OLD.country_code AND r.to_country = NEW.country_code AND r.corrected_at = now()) THEN
      RAISE EXCEPTION 'a company''s country changes only through a staff correction' USING ERRCODE = 'integrity_constraint_violation', HINT = 'directory.country_locked';
    END IF;
  ELSIF NEW.country_code IS NULL THEN
    IF NEW.sourced_status = 'sourced' THEN
      RAISE EXCEPTION 'an imported company brings its country' USING ERRCODE = 'check_violation', HINT = 'directory.country_required';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM trustwork.kernel_lock_restrictions_shared();
  IF NOT trustwork.directory_country_ok(NEW.country_code) THEN
    RAISE EXCEPTION 'country % cannot be chosen', NEW.country_code USING ERRCODE = 'check_violation', HINT = 'directory.country_refused';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_country_guard BEFORE INSERT OR UPDATE ON trustwork.company FOR EACH ROW EXECUTE FUNCTION trustwork.directory_company_country_guard();

-- Company creation as before, with its country (see 20261031110000_directory.sql for the founding administrator).
DROP FUNCTION trustwork.directory_create_company(text, text, text);
CREATE FUNCTION trustwork.directory_create_company(p_display_name text, p_public_description text, p_handle text, p_country text)
RETURNS TABLE (company_id uuid, membership_id uuid)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_company uuid;
  v_membership uuid;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  IF p_country IS NULL THEN
    RAISE EXCEPTION 'a company is created with its country' USING ERRCODE = 'check_violation', HINT = 'directory.country_required';
  END IF;
  INSERT INTO trustwork.company (display_name, public_description, sourced_status, claim_status, country_code)
    VALUES (p_display_name, p_public_description, 'registered', 'unclaimed', p_country)
    RETURNING id INTO v_company;
  INSERT INTO trustwork.membership (person_id, company_id, role, permissions, status, invited_by, valid_from)
    VALUES (v_person, v_company, 'administrator',
            ARRAY['company.page.edit', 'company.publish', 'company.members.manage', 'company.deals.manage', 'company.catalogue.edit', 'company.billing.view', 'company.billing.manage']::text[],
            'active', NULL, now())
    RETURNING id INTO v_membership;
  IF p_handle IS NOT NULL THEN
    PERFORM trustwork.directory_assign_handle('company', v_company, p_handle, v_person);
  END IF;
  RETURN QUERY SELECT v_company, v_membership;
END $$;

-- The staff correction. `p_from` restates the country the reviewer saw, so a second correction in flight is refused
-- rather than overwritten. The company row is locked first: a decision on this company either finished under the old
-- country or waits and reads the new one.
CREATE FUNCTION trustwork.directory_correct_company_country(p_ctx jsonb, p_hub uuid, p_company uuid, p_from text, p_to text) RETURNS trustwork.company_country_correction
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_current text;
  v_row trustwork.company_country_correction%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  v_actor := trustwork.claims_staff(p_ctx, ARRAY['admin.claims.authority.decide'], p_hub);
  SELECT country_code INTO v_current FROM trustwork.company WHERE id = p_company FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such company' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF v_current IS DISTINCT FROM p_from THEN
    RAISE EXCEPTION 'the country changed; reload' USING ERRCODE = 'serialization_failure', HINT = 'directory.country_changed';
  END IF;
  IF p_to IS NULL OR p_to IS NOT DISTINCT FROM v_current THEN
    RAISE EXCEPTION 'a correction names another country' USING ERRCODE = 'check_violation', HINT = 'directory.country_unchanged';
  END IF;
  IF NOT (trustwork.directory_lock_hub_cover(p_hub, v_current) OR trustwork.directory_lock_hub_cover(p_hub, p_to)) THEN
    RAISE EXCEPTION 'this hub covers neither country' USING ERRCODE = 'insufficient_privilege', HINT = 'directory.outside_territory';
  END IF;
  INSERT INTO trustwork.company_country_correction (company_id, hub_id, from_country, to_country, corrected_by)
  VALUES (p_company, p_hub, v_current, p_to, v_actor.person_id) RETURNING * INTO v_row;
  UPDATE trustwork.company SET country_code = p_to WHERE id = p_company;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'company.country_corrected', 'company', p_company, jsonb_build_object('country', v_current), jsonb_build_object('country', p_to));
  RETURN v_row;
END $$;

ALTER TABLE trustwork.company_country_correction ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.company_country_correction FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.company_country_correction AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.directory_create_company(text, text, text, text), trustwork.directory_correct_company_country(jsonb, uuid, uuid, text, text) TO trustwork_app;
