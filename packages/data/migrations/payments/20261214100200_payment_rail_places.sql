-- PAY-001. The rail guard of 20261201100000 checked a served place only by its shape, so an invented code such as `ZZ`
-- passed, and it checked a currency only by its shape, so `RUB` passed. Replaces the guard function; the trigger stays.
-- Restricted places (NOTICE) keep their one source of truth: packages/country-packs/packs/restricted.json, synced into
-- `restricted_place`. This adds no list. The shipped engine has no rail, so no stored row needs checking again.
CREATE OR REPLACE FUNCTION trustwork.payments_rail_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE c trustwork.provider_connection%ROWTYPE; v text;
BEGIN
  SELECT * INTO c FROM trustwork.provider_connection WHERE id = NEW.connection_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment rail requires a provider connection' USING ERRCODE = '23514', HINT = 'payments.rail_refused';
  END IF;
  IF NEW.custody <> 'provider_connected_accounts' THEN
    RAISE EXCEPTION 'participants'' funds move only through the provider''s connected accounts' USING ERRCODE = '23514', HINT = 'payments.rail_refused';
  END IF;
  -- Synthetic evidence belongs to a fake connection only; a live connection never carries a synthetic rail.
  IF (NEW.evidence_mode = 'synthetic') <> (c.mode = 'fake') THEN
    RAISE EXCEPTION 'payment rail evidence mode must match the connection mode' USING ERRCODE = '23514', HINT = 'payments.rail_refused';
  END IF;
  IF NOT ('payments' = ANY (c.capabilities)) THEN
    RAISE EXCEPTION 'payment rail requires a payments-capable connection' USING ERRCODE = '23514', HINT = 'payments.rail_refused';
  END IF;
  IF 'payout' = ANY (NEW.capabilities) AND NOT ('payouts' = ANY (c.capabilities)) THEN
    RAISE EXCEPTION 'payout rail requires a payouts-capable connection' USING ERRCODE = '23514', HINT = 'payments.rail_refused';
  END IF;
  -- The connection itself must not process or store in a restricted place (the connection record owns those facts).
  IF trustwork.kernel_place_restricted(c.processing_country)
     OR (c.storage_country IS NOT NULL AND trustwork.kernel_place_restricted(c.storage_country)) THEN
    RAISE EXCEPTION 'payment rail cannot route through a restricted processing or storage place' USING ERRCODE = '23514', HINT = 'payments.rail_refused';
  END IF;
  -- Every served place is a live row of the kernel's jurisdictions, which hold the ISO 3166 countries and the pack
  -- regions and never a restricted place, so an invented code is refused like a restricted one. A country with a
  -- restricted region is refused as a whole: rails match payers by country, so `UA` would reach `UA-43`.
  -- An unsynced kernel has no jurisdictions and counts every place as restricted: no rail before the kernel exists.
  FOREACH v IN ARRAY NEW.countries LOOP
    IF v IS NULL OR v !~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$' OR trustwork.kernel_place_restricted(v)
       OR EXISTS (SELECT 1 FROM trustwork.restricted_place r WHERE r.code LIKE v || '-%')
       OR NOT EXISTS (SELECT 1 FROM trustwork.jurisdiction j WHERE j.code = v AND NOT j.restricted AND j.retired_at IS NULL) THEN
      RAISE EXCEPTION 'payment rail cannot serve a restricted or unknown place' USING ERRCODE = '23514', HINT = 'payments.rail_refused';
    END IF;
  END LOOP;
  -- A national ISO 4217 code starts with the ISO 3166 code of its country (RUB, CUP, IRR, KPW), so the restricted-place
  -- list decides the currency as well and no second list exists. Supranational codes start with X and pass.
  FOREACH v IN ARRAY NEW.currencies LOOP
    IF v IS NULL OR v !~ '^[A-Z]{3}$' THEN
      RAISE EXCEPTION 'payment rail currencies are ISO 4217 codes' USING ERRCODE = '23514', HINT = 'payments.rail_refused';
    END IF;
    IF trustwork.kernel_place_restricted(left(v, 2)) THEN
      RAISE EXCEPTION 'payment rail cannot use the currency of a restricted place' USING ERRCODE = '23514', HINT = 'payments.rail_refused';
    END IF;
  END LOOP;
  FOREACH v IN ARRAY NEW.rails LOOP
    IF v IS NULL OR v NOT IN ('card', 'ach', 'push_to_phone', 'qr', 'provider_escrow') THEN
      RAISE EXCEPTION 'unknown payment rail kind' USING ERRCODE = '23514', HINT = 'payments.rail_refused';
    END IF;
  END LOOP;
  FOREACH v IN ARRAY NEW.capabilities LOOP
    IF v IS NULL OR v NOT IN ('create', 'confirm', 'refund', 'payout', 'connected_account') THEN
      RAISE EXCEPTION 'unknown payment rail capability' USING ERRCODE = '23514', HINT = 'payments.rail_refused';
    END IF;
  END LOOP;
  IF TG_OP = 'UPDATE' AND (NEW.connection_id <> OLD.connection_id OR NEW.custody <> OLD.custody OR NEW.evidence_mode <> OLD.evidence_mode) THEN
    RAISE EXCEPTION 'payment rail connection, custody and evidence mode are immutable' USING ERRCODE = '23514', HINT = 'payments.rail_refused';
  END IF;
  RETURN NEW;
END $$;
