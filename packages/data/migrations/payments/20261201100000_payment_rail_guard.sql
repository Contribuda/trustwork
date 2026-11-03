-- PAY-001. A payment rail declares where one enabled provider connection may collect and pay out (currencies,
-- places, rail kinds, effect capabilities). Rails are installation-owned facts: only the owner role writes them under
-- maintenance, no runtime role has a grant, and the operator cannot put itself into the funds flow through them.
-- The guard refuses, before any row exists, every declaration that could route participants' funds through a
-- restricted place (ADR 010 decision 20, ADR 012 decision 22, the kernel's restricted-place list), through an
-- evidence mode the connection does not have, or through anything but the provider's own connected accounts.
-- It does not seed a rail; the shipped engine still has none.
CREATE FUNCTION trustwork.payments_rail_guard() RETURNS trigger
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
  -- No Russian or otherwise restricted rail: every served place must be a known, unrestricted ISO 3166 code.
  -- An unsynced kernel counts every place as restricted, so a rail cannot be declared before the kernel exists.
  FOREACH v IN ARRAY NEW.countries LOOP
    IF v IS NULL OR v !~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$' OR trustwork.kernel_place_restricted(v) THEN
      RAISE EXCEPTION 'payment rail cannot serve a restricted or unknown place' USING ERRCODE = '23514', HINT = 'payments.rail_refused';
    END IF;
  END LOOP;
  FOREACH v IN ARRAY NEW.currencies LOOP
    IF v IS NULL OR v !~ '^[A-Z]{3}$' THEN
      RAISE EXCEPTION 'payment rail currencies are ISO 4217 codes' USING ERRCODE = '23514', HINT = 'payments.rail_refused';
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
CREATE TRIGGER payment_rail_guard BEFORE INSERT OR UPDATE ON trustwork.payment_rail
  FOR EACH ROW EXECUTE FUNCTION trustwork.payments_rail_guard();
REVOKE ALL ON FUNCTION trustwork.payments_rail_guard() FROM PUBLIC;
