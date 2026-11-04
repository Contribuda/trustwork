-- PRC-004: buyer-private bid levelling sheets and eligibility rules (handbook docs/engine/procurement-and-supply.md,
-- "Sourcing events and bid levelling"; data model section 18a; contracts packages/contracts/src/supply/sourcing.ts).
--
-- * bid_level_sheet: one working document per RFQ, owned by the buyer party.
-- * bid_level_sheet_version: versions over pinned quote versions (id, version and digest). A draft changes; freezing
--   binds the digest; a newer frozen version supersedes the older one. Buyer adjustments live in the payload beside the
--   quoted cells, labelled, and never alter a quote. A column of a stale or no longer current quote version is
--   non-comparable: the commands refuse a column that claims otherwise.
-- * sourcing_eligibility_rule_set: the buyer's private eligibility rules for one RFQ (licence category, insurance minimum,
--   prequalification sections, region, screening clear). Eligibility shows pass, fail or unknown; unknown is not failure.
--
-- None of these rows reaches a seller: every policy names the buyer side only, no function hands them out, and no
-- command appends an outbox event, so no notification, index, federation feed or statistic can carry them.
--
-- Entry points for the runtime role (SECURITY DEFINER, pinned search_path): sourcing_rfq_reader, sourcing_rfq_runner
-- (policy and guard helpers), sourcing_open_draft, sourcing_save_draft, sourcing_freeze_sheet, sourcing_save_eligibility.
-- The runtime role reads the tables under row-level security and writes nothing directly.

-- 1. Authority --------------------------------------------------------------------------------------------------------
-- Readers: the owner person, or members of the owner company holding company.deals.manage or procurement.sourcing.run.
-- A co-buyer participation on the RFQ is not enough: the sheet is the owner's working document.
CREATE FUNCTION trustwork.sourcing_rfq_reader(p_rfq uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND EXISTS (
    SELECT 1 FROM trustwork.rfq r WHERE r.id = p_rfq AND (
      r.owner_person_id = trustwork.current_person_id()
      OR (r.owner_company_id IS NOT NULL AND r.owner_company_id = trustwork.current_company_id() AND (
        trustwork.commerce_party_acts(NULL, r.owner_company_id, 'company.deals.manage')
        OR trustwork.supplier_base_holds(r.owner_company_id, trustwork.current_person_id(), 'procurement.sourcing.run')))))
$$;

-- Runners change the event: the owner person, or members holding procurement.sourcing.run who can also read the quotes
-- (company.deals.manage). Company administrators hold every procurement permission.
CREATE FUNCTION trustwork.sourcing_rfq_runner(p_rfq uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND EXISTS (
    SELECT 1 FROM trustwork.rfq r WHERE r.id = p_rfq AND (
      r.owner_person_id = trustwork.current_person_id()
      OR (r.owner_company_id IS NOT NULL AND r.owner_company_id = trustwork.current_company_id()
        AND trustwork.commerce_party_acts(NULL, r.owner_company_id, 'company.deals.manage')
        AND trustwork.supplier_base_holds(r.owner_company_id, trustwork.current_person_id(), 'procurement.sourcing.run'))))
$$;

-- Readers of the event learn when its seal lifts, also those holding only procurement.sourcing.run.
CREATE OR REPLACE FUNCTION trustwork.sourcing_sealed_until(p_rfq uuid) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.sourcing_seal_end(p_rfq) WHERE trustwork.rfq_can(p_rfq, 'read.party_private') OR trustwork.rfq_invitee(p_rfq, NULL) OR trustwork.sourcing_rfq_reader(p_rfq)
$$;

CREATE FUNCTION trustwork.sourcing_require_runner(p_rfq uuid) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF trustwork.current_person_id() IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  IF NOT trustwork.sourcing_rfq_reader(p_rfq) THEN
    RAISE EXCEPTION 'RFQ not found' USING ERRCODE = 'P0002', HINT = 'sourcing.not_found';
  END IF;
  IF NOT trustwork.sourcing_rfq_runner(p_rfq) THEN
    RAISE EXCEPTION 'sourcing events are run by members holding procurement.sourcing.run and company.deals.manage' USING ERRCODE = '42501', HINT = 'sourcing.not_authorised';
  END IF;
END $$;

-- 2. Sheets -----------------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.bid_level_sheet (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  rfq_id uuid NOT NULL UNIQUE REFERENCES trustwork.rfq (id),
  owner_person_id uuid NULL REFERENCES trustwork.person (id),
  owner_company_id uuid NULL REFERENCES trustwork.company (id),
  current_version_id uuid NULL,
  created_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bid_level_sheet_owner_xor CHECK ((owner_person_id IS NULL) <> (owner_company_id IS NULL))
);
CREATE TRIGGER bid_level_sheet_touch BEFORE UPDATE ON trustwork.bid_level_sheet FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
CREATE TRIGGER bid_level_sheet_retained BEFORE DELETE ON trustwork.bid_level_sheet FOR EACH ROW EXECUTE FUNCTION trustwork.commerce_retained();
CREATE TRIGGER bid_level_sheet_no_truncate BEFORE TRUNCATE ON trustwork.bid_level_sheet FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

-- payload: BidLevelSheetPayload. digest: trustwork-digest-1 over { kind, version, rfqVersionId, payload }, computed by the
-- server at every save; freezing binds it.
CREATE TABLE trustwork.bid_level_sheet_version (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  sheet_id uuid NOT NULL REFERENCES trustwork.bid_level_sheet (id),
  rfq_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  rfq_version_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'frozen', 'superseded')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND jsonb_typeof(payload -> 'columns') = 'array' AND jsonb_typeof(payload -> 'cells') = 'array' AND jsonb_typeof(payload -> 'adjustments') = 'array'),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  prepared_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  mandate_id text NULL CHECK (mandate_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  frozen_at timestamptz NULL,
  frozen_by_person_id uuid NULL REFERENCES trustwork.person (id),
  superseded_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bid_level_sheet_version_number UNIQUE (sheet_id, version),
  CONSTRAINT bid_level_sheet_version_id_sheet UNIQUE (id, sheet_id),
  CONSTRAINT bid_level_sheet_version_rfq_version FOREIGN KEY (rfq_version_id, rfq_id) REFERENCES trustwork.rfq_version (id, rfq_id),
  CONSTRAINT bid_level_sheet_version_frozen_shape CHECK ((status = 'draft') = (frozen_at IS NULL) AND (frozen_at IS NULL) = (frozen_by_person_id IS NULL)),
  CONSTRAINT bid_level_sheet_version_superseded_shape CHECK ((status = 'superseded') = (superseded_at IS NOT NULL))
);
CREATE UNIQUE INDEX bid_level_sheet_version_one_draft ON trustwork.bid_level_sheet_version (sheet_id) WHERE status = 'draft';
CREATE UNIQUE INDEX bid_level_sheet_version_one_frozen ON trustwork.bid_level_sheet_version (sheet_id) WHERE status = 'frozen';
CREATE INDEX bid_level_sheet_version_rfq_idx ON trustwork.bid_level_sheet_version (rfq_id);
ALTER TABLE trustwork.bid_level_sheet ADD CONSTRAINT bid_level_sheet_current FOREIGN KEY (current_version_id, id) REFERENCES trustwork.bid_level_sheet_version (id, sheet_id);
CREATE TRIGGER bid_level_sheet_version_touch BEFORE UPDATE ON trustwork.bid_level_sheet_version FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
-- Once frozen, the payload, digest, pins and freezing facts never change and the status never returns to draft, for every role.
CREATE TRIGGER bid_level_sheet_version_frozen BEFORE UPDATE ON trustwork.bid_level_sheet_version FOR EACH ROW
  EXECUTE FUNCTION trustwork.reject_update_when_frozen('status', 'draft', 'payload', 'digest', 'rfq_version_id', 'prepared_by_person_id', 'mandate_id', 'frozen_at', 'frozen_by_person_id');
CREATE TRIGGER bid_level_sheet_version_retained BEFORE DELETE ON trustwork.bid_level_sheet_version FOR EACH ROW EXECUTE FUNCTION trustwork.commerce_retained();
CREATE TRIGGER bid_level_sheet_version_no_truncate BEFORE TRUNCATE ON trustwork.bid_level_sheet_version FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

CREATE FUNCTION trustwork.bid_level_sheet_version_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.sheet_id <> OLD.sheet_id OR NEW.rfq_id <> OLD.rfq_id OR NEW.version <> OLD.version OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a sheet version keeps its identity' USING ERRCODE = '23514', HINT = 'sourcing.frozen';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'draft' AND NEW.status = 'frozen') OR (OLD.status = 'frozen' AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'sheet version transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = '23514', HINT = 'sourcing.invalid_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bid_level_sheet_version_guard BEFORE UPDATE ON trustwork.bid_level_sheet_version FOR EACH ROW EXECUTE FUNCTION trustwork.bid_level_sheet_version_guard();

-- The pins of a payload, repeated in SQL so a bug in the service cannot widen them: every quote version column names a
-- sent version of a quote on this RFQ by id, version and digest; a column claiming to be comparable answers the sheet's
-- RFQ version, carries no stale flag, is the current sent or accepted version and is still valid. Captured quotes arrive
-- with document intake (PRC-005).
CREATE FUNCTION trustwork.sourcing_check_pins(p_rfq uuid, p_rfq_version uuid, p_payload jsonb) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_column jsonb;
  v_quote trustwork.quote_version%ROWTYPE;
BEGIN
  FOR v_column IN SELECT e FROM jsonb_array_elements(p_payload -> 'columns') e LOOP
    IF v_column ->> 'kind' <> 'quote_version' THEN
      RAISE EXCEPTION 'captured quotes arrive with document intake' USING ERRCODE = '23514', HINT = 'sourcing.captured_quote_unavailable';
    END IF;
    SELECT * INTO v_quote FROM trustwork.quote_version WHERE id = (v_column ->> 'quoteVersionId')::uuid AND rfq_id = p_rfq AND status <> 'draft';
    IF NOT FOUND OR v_quote.version <> (v_column ->> 'version')::integer OR v_quote.digest IS DISTINCT FROM v_column #>> '{digest,value}' THEN
      RAISE EXCEPTION 'a column pins a sent version of a quote on this RFQ by id and digest' USING ERRCODE = '23514', HINT = 'sourcing.pin_mismatch';
    END IF;
    IF (v_column ->> 'comparable')::boolean AND (v_quote.rfq_version_id <> p_rfq_version OR v_quote.stale_reason IS NOT NULL OR v_quote.status NOT IN ('sent', 'accepted') OR v_quote.valid_until <= now()) THEN
      RAISE EXCEPTION 'a stale quote version is non-comparable' USING ERRCODE = '23514', HINT = 'sourcing.stale_comparable';
    END IF;
  END LOOP;
END $$;

-- 3. Eligibility rules ------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.sourcing_eligibility_rule_set (
  rfq_id uuid PRIMARY KEY REFERENCES trustwork.rfq (id),
  rules jsonb NOT NULL CHECK (jsonb_typeof(rules) = 'array' AND jsonb_array_length(rules) <= 30),
  updated_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER sourcing_eligibility_rule_set_touch BEFORE UPDATE ON trustwork.sourcing_eligibility_rule_set FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
CREATE TRIGGER sourcing_eligibility_rule_set_retained BEFORE DELETE ON trustwork.sourcing_eligibility_rule_set FOR EACH ROW EXECUTE FUNCTION trustwork.commerce_retained();

-- 4. Commands ---------------------------------------------------------------------------------------------------------
-- A new draft of the sheet, the first one included. The RFQ row is locked, so concurrent first drafts create one sheet
-- and one draft. A sealed RFQ is refused: nobody levels what nobody may read.
CREATE FUNCTION trustwork.sourcing_open_draft(p_rfq uuid, p_rfq_version uuid, p_payload jsonb, p_digest text, p_mandate text) RETURNS trustwork.bid_level_sheet_version
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_rfq trustwork.rfq%ROWTYPE;
  v_sheet trustwork.bid_level_sheet%ROWTYPE;
  v_next integer;
  v_row trustwork.bid_level_sheet_version%ROWTYPE;
BEGIN
  PERFORM trustwork.sourcing_require_runner(p_rfq);
  SELECT * INTO v_rfq FROM trustwork.rfq WHERE id = p_rfq FOR UPDATE;
  IF trustwork.sourcing_sealed(p_rfq) THEN
    RAISE EXCEPTION 'quotes stay sealed until the response deadline' USING ERRCODE = '42501', HINT = 'sourcing.sealed';
  END IF;
  IF v_rfq.current_version_id IS DISTINCT FROM p_rfq_version THEN
    RAISE EXCEPTION 'a sheet levels the current published RFQ version' USING ERRCODE = '23514', HINT = 'commerce.rfq_version_not_current';
  END IF;
  PERFORM trustwork.sourcing_check_pins(p_rfq, p_rfq_version, p_payload);
  SELECT * INTO v_sheet FROM trustwork.bid_level_sheet WHERE rfq_id = p_rfq;
  IF NOT FOUND THEN
    INSERT INTO trustwork.bid_level_sheet (rfq_id, owner_person_id, owner_company_id, created_by_person_id)
    VALUES (p_rfq, v_rfq.owner_person_id, v_rfq.owner_company_id, trustwork.current_person_id()) RETURNING * INTO v_sheet;
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.bid_level_sheet_version WHERE sheet_id = v_sheet.id AND status = 'draft') THEN
    RAISE EXCEPTION 'this sheet already has a draft' USING ERRCODE = '40001', HINT = 'sourcing.draft_exists';
  END IF;
  SELECT coalesce(max(version), 0) + 1 INTO v_next FROM trustwork.bid_level_sheet_version WHERE sheet_id = v_sheet.id;
  INSERT INTO trustwork.bid_level_sheet_version (sheet_id, rfq_id, version, rfq_version_id, payload, digest, prepared_by_person_id, mandate_id)
  VALUES (v_sheet.id, p_rfq, v_next, p_rfq_version, p_payload, p_digest, trustwork.current_person_id(), p_mandate) RETURNING * INTO v_row;
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.sourcing_lock_version(p_version uuid, p_expected integer) RETURNS trustwork.bid_level_sheet_version
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_row trustwork.bid_level_sheet_version%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM trustwork.bid_level_sheet_version WHERE id = p_version FOR UPDATE;
  IF NOT FOUND OR NOT trustwork.sourcing_rfq_reader(v_row.rfq_id) THEN
    RAISE EXCEPTION 'sheet version not found' USING ERRCODE = 'P0002', HINT = 'sourcing.not_found';
  END IF;
  PERFORM trustwork.sourcing_require_runner(v_row.rfq_id);
  -- A draft can outlive an amendment that seals the RFQ. These commands run owner-side and read past row-level security,
  -- so they stop here: nothing is saved or frozen while the seal holds.
  IF trustwork.sourcing_sealed(v_row.rfq_id) THEN
    RAISE EXCEPTION 'quotes stay sealed until the response deadline' USING ERRCODE = '42501', HINT = 'sourcing.sealed';
  END IF;
  IF v_row.status <> 'draft' THEN
    RAISE EXCEPTION 'a frozen sheet version never changes' USING ERRCODE = '23514', HINT = 'sourcing.frozen';
  END IF;
  IF v_row.revision <> p_expected THEN
    RAISE EXCEPTION 'the sheet version changed meanwhile' USING ERRCODE = '40001', HINT = 'sourcing.revision_conflict';
  END IF;
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.sourcing_save_draft(p_version uuid, p_payload jsonb, p_digest text, p_expected integer, p_mandate text) RETURNS trustwork.bid_level_sheet_version
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.bid_level_sheet_version%ROWTYPE;
BEGIN
  v_row := trustwork.sourcing_lock_version(p_version, p_expected);
  PERFORM trustwork.sourcing_check_pins(v_row.rfq_id, v_row.rfq_version_id, p_payload);
  UPDATE trustwork.bid_level_sheet_version SET payload = p_payload, digest = p_digest, prepared_by_person_id = trustwork.current_person_id(), mandate_id = p_mandate
  WHERE id = p_version RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- Freezes the draft the caller reviewed (its digest restated) and supersedes the frozen version before it. The pins are
-- checked again: a quote that went stale after the last save makes the caller save the draft first.
CREATE FUNCTION trustwork.sourcing_freeze_sheet(p_version uuid, p_digest text, p_expected integer) RETURNS trustwork.bid_level_sheet_version
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.bid_level_sheet_version%ROWTYPE;
BEGIN
  v_row := trustwork.sourcing_lock_version(p_version, p_expected);
  IF v_row.digest <> p_digest THEN
    RAISE EXCEPTION 'the sheet is not the one reviewed' USING ERRCODE = '40001', HINT = 'sourcing.digest_mismatch';
  END IF;
  IF (SELECT current_version_id FROM trustwork.rfq WHERE id = v_row.rfq_id) IS DISTINCT FROM v_row.rfq_version_id THEN
    RAISE EXCEPTION 'the RFQ was amended after this draft' USING ERRCODE = '23514', HINT = 'commerce.rfq_version_not_current';
  END IF;
  PERFORM trustwork.sourcing_check_pins(v_row.rfq_id, v_row.rfq_version_id, v_row.payload);
  UPDATE trustwork.bid_level_sheet_version SET status = 'superseded', superseded_at = now() WHERE sheet_id = v_row.sheet_id AND status = 'frozen';
  UPDATE trustwork.bid_level_sheet_version SET status = 'frozen', frozen_at = now(), frozen_by_person_id = trustwork.current_person_id() WHERE id = p_version RETURNING * INTO v_row;
  UPDATE trustwork.bid_level_sheet SET current_version_id = p_version WHERE id = v_row.sheet_id;
  RETURN v_row;
END $$;

-- `p_expected` is the revision the caller read, or NULL for the first save of this RFQ's rules.
CREATE FUNCTION trustwork.sourcing_save_eligibility(p_rfq uuid, p_rules jsonb, p_expected integer) RETURNS trustwork.sourcing_eligibility_rule_set
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.sourcing_eligibility_rule_set%ROWTYPE;
BEGIN
  PERFORM trustwork.sourcing_require_runner(p_rfq);
  PERFORM 1 FROM trustwork.rfq WHERE id = p_rfq FOR UPDATE;
  SELECT * INTO v_row FROM trustwork.sourcing_eligibility_rule_set WHERE rfq_id = p_rfq FOR UPDATE;
  IF FOUND IS DISTINCT FROM (p_expected IS NOT NULL) OR v_row.revision IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'the eligibility rules changed meanwhile' USING ERRCODE = '40001', HINT = 'sourcing.revision_conflict';
  END IF;
  INSERT INTO trustwork.sourcing_eligibility_rule_set (rfq_id, rules, updated_by_person_id) VALUES (p_rfq, p_rules, trustwork.current_person_id())
  ON CONFLICT (rfq_id) DO UPDATE SET rules = EXCLUDED.rules, updated_by_person_id = EXCLUDED.updated_by_person_id
  RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- 5. Row-level security -----------------------------------------------------------------------------------------------
ALTER TABLE trustwork.bid_level_sheet ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.bid_level_sheet FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.bid_level_sheet_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.bid_level_sheet_version FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.sourcing_eligibility_rule_set ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.sourcing_eligibility_rule_set FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.bid_level_sheet AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.bid_level_sheet_version AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.sourcing_eligibility_rule_set AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

CREATE POLICY bid_level_sheet_read ON trustwork.bid_level_sheet FOR SELECT TO trustwork_app USING (trustwork.sourcing_rfq_reader(rfq_id));
CREATE POLICY bid_level_sheet_version_read ON trustwork.bid_level_sheet_version FOR SELECT TO trustwork_app USING (trustwork.sourcing_rfq_reader(rfq_id));
CREATE POLICY sourcing_eligibility_rule_set_read ON trustwork.sourcing_eligibility_rule_set FOR SELECT TO trustwork_app USING (trustwork.sourcing_rfq_reader(rfq_id));

GRANT SELECT ON trustwork.bid_level_sheet, trustwork.bid_level_sheet_version, trustwork.sourcing_eligibility_rule_set TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.sourcing_rfq_reader(uuid), trustwork.sourcing_rfq_runner(uuid), trustwork.sourcing_open_draft(uuid, uuid, jsonb, text, text),
  trustwork.sourcing_save_draft(uuid, jsonb, text, integer, text), trustwork.sourcing_freeze_sheet(uuid, text, integer), trustwork.sourcing_save_eligibility(uuid, jsonb, integer) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
