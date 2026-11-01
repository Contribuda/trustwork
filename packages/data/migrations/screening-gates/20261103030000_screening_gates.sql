-- SANC-004: the money and commitment gates (ADR 014 decisions 9, 12, 13, 15 and 16; data model section 24a).
--
-- * screening_gate_check answers, inside the transaction that binds a commitment or moves money, the effective state of
--   every subject of that act (the parties and the acting person): the SANC-003 effective state (unscreened,
--   insufficient name, open or confirmed match, a result older than the active baseline versions, a missing or stale
--   baseline) plus an open jurisdiction hold (SANC-001). The API refuses unless every subject is clear; a gate that
--   cannot read this refuses too (fail closed).
-- * No stale answer binds. Before it reads, the check takes, until the end of the caller's transaction, a share lock
--   on the baseline list rows (a list version activation updates them), on each subject's state row (every result
--   and every decision updates it) and a shared per-person advisory lock (every new hold takes the exclusive one in
--   the trigger below). Then it reads with a fresh snapshot. A decision, a result, an activation or a hold racing the
--   commitment therefore either commits first and is seen, or waits until the commitment has committed or rolled
--   back. Freshness by age is read at that moment (it has no writer to wait for).
-- * screening_gate_declare_place: a person who declares their own place (payout country, residence) in a restricted
--   place is held (source payout_country or self_declared, dataset `declaration`). Only the caller can be held this
--   way; a place entered for anything else holds nobody. An unsynced kernel list counts every place as restricted
--   (fail closed, as in SANC-001).
-- * Nothing here is stored or returned beyond the effective state words the gate itself needs; the API never shows a
--   counterparty anything but "cannot transact now", and nothing reaches ranking, matching or reputation.
--
-- Entry points (SECURITY DEFINER, pinned search_path), runtime (trustwork_app):
--   screening_gate_check, screening_gate_declare_place
-- No table is added; the trigger function is internal (no grant).

-- 1. Holds take the exclusive per-person gate lock ---------------------------------------------------------------------
-- Key space: (hashtext('trustwork.screening_gate'), hashtext(person id)). A collision only makes two people wait for
-- each other briefly; it never lets a commitment through.
CREATE FUNCTION trustwork.screening_gate_hold_lock() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('trustwork.screening_gate'), hashtext(NEW.person_id::text));
  RETURN NEW;
END $$;
CREATE TRIGGER jurisdiction_hold_screening_gate_lock BEFORE INSERT ON trustwork.jurisdiction_hold
  FOR EACH ROW EXECUTE FUNCTION trustwork.screening_gate_hold_lock();

-- 2. The gate's read -------------------------------------------------------------------------------------------------
-- One row per distinct subject, in the order given. Raises screening.subject_not_found for an unknown subject and
-- screening.gate_subjects for a malformed list; the API refuses on any error.
CREATE FUNCTION trustwork.screening_gate_check(p_kinds text[], p_ids uuid[])
RETURNS TABLE (subject_kind text, subject_id uuid, money_held boolean, suspended boolean, reasons text[], appealable boolean, place_hold boolean)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_n integer := coalesce(cardinality(p_kinds), 0);
  v_i integer;
  v record;
BEGIN
  IF v_n = 0 OR v_n > 16 OR v_n <> coalesce(cardinality(p_ids), 0) OR array_position(p_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'one to sixteen subjects are checked at once' USING ERRCODE = 'invalid_parameter_value', HINT = 'screening.gate_subjects';
  END IF;
  FOR v_i IN 1 .. v_n LOOP
    PERFORM trustwork.screening_subject(p_kinds[v_i], p_ids[v_i]);
  END LOOP;
  -- Locks, in a fixed order: baseline lists, then subject states, then per-person hold keys.
  PERFORM 1 FROM trustwork.screening_list l WHERE l.baseline ORDER BY l.id FOR SHARE;
  PERFORM 1 FROM trustwork.screening_subject_state s
   WHERE (s.subject_person_id IS NOT NULL AND s.subject_person_id = ANY (SELECT p_ids[i] FROM generate_subscripts(p_ids, 1) i WHERE p_kinds[i] = 'person'))
      OR (s.subject_company_id IS NOT NULL AND s.subject_company_id = ANY (SELECT p_ids[i] FROM generate_subscripts(p_ids, 1) i WHERE p_kinds[i] = 'company'))
   ORDER BY s.id FOR SHARE;
  FOR v IN SELECT DISTINCT p_ids[i] AS id FROM generate_subscripts(p_ids, 1) i WHERE p_kinds[i] = 'person' ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock_shared(hashtext('trustwork.screening_gate'), hashtext(v.id::text));
  END LOOP;
  -- A new statement of a volatile function: a fresh snapshot that sees everything committed before the locks.
  RETURN QUERY
    WITH s AS (
      SELECT DISTINCT ON (p_kinds[i], p_ids[i]) i AS pos, p_kinds[i] AS kind, p_ids[i] AS id
      FROM generate_subscripts(p_ids, 1) i ORDER BY p_kinds[i], p_ids[i], i
    )
    SELECT s.kind, s.id, e.money_held, e.suspended, e.reasons, e.appealable,
           s.kind = 'person' AND EXISTS (SELECT 1 FROM trustwork.jurisdiction_hold h WHERE h.person_id = s.id AND h.cleared_at IS NULL)
    FROM s
    CROSS JOIN LATERAL trustwork.screening_effective(CASE WHEN s.kind = 'person' THEN s.id END, CASE WHEN s.kind = 'company' THEN s.id END) e
    ORDER BY s.pos;
END $$;

-- 3. Declared own places -----------------------------------------------------------------------------------------------
-- The caller declares their own place (a payout country, a residence). Answers true when the place is restricted; the
-- caller is then held (one open hold per person, the first sighting stands). The API commits this in its own
-- transaction and then refuses the request, so the hold outlives the refusal.
CREATE FUNCTION trustwork.screening_gate_declare_place(p_place text, p_source text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'a verified identity is required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('self_declared', 'payout_country') THEN
    RAISE EXCEPTION 'only own-place declarations hold the declaring person' USING ERRCODE = 'invalid_parameter_value', HINT = 'jurisdiction.invalid_source';
  END IF;
  IF p_place IS NULL OR p_place !~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$' THEN
    RAISE EXCEPTION 'a place is an ISO 3166 code' USING ERRCODE = 'invalid_parameter_value', HINT = 'jurisdiction.invalid_place';
  END IF;
  IF NOT trustwork.kernel_place_restricted(p_place) THEN
    RETURN false;
  END IF;
  INSERT INTO trustwork.jurisdiction_hold (person_id, place, source, dataset)
  VALUES (v_person, p_place, p_source, 'declaration')
  ON CONFLICT (person_id) WHERE cleared_at IS NULL DO NOTHING;
  RETURN true;
END $$;

REVOKE EXECUTE ON FUNCTION trustwork.screening_gate_hold_lock() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.screening_gate_check(text[], uuid[]), trustwork.screening_gate_declare_place(text, text) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
