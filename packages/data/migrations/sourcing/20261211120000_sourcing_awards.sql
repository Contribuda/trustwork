-- PRC-004: award decisions and outcome notices (handbook docs/engine/procurement-and-supply.md, "Sourcing events and bid
-- levelling"; data model section 18a; contracts packages/contracts/src/supply/sourcing.ts).
--
-- * award_decision: selected quote versions, reasons and the frozen sheet version, bound by a digest and decided through
--   the company's approval route of subject kind `award`. Awards belong to companies: a person who owns an RFQ accepts a
--   quote directly. One live award per RFQ. The outcome of the approval request reaches the award in the same
--   transaction (`sourcing_award_follow_approval`): approved stays approved; rejected, returned, withdrawn, expired and
--   superseded all end the award as rejected, and `approval_outcome` keeps which one it was.
-- * An approved award executes only through the COM-002 agreement and order commands, with authority and a budget
--   reservation. agreement.award_decision_id names the award: a split award may hold one live agreement per quote, where
--   a direct acceptance holds one per RFQ. A company with an active `award` route accepts through an award only.
-- * bid_outcome_notice: one per invitee. No amount, line, competitor or winner column exists, so a notice cannot carry
--   one. A band and a reason category exist only for a not-awarded supplier, after an executed award, with the buyer's
--   opt-in. The recipient reads its own row; nothing here names the award or the sender.
--
-- Entry points for the runtime role (SECURITY DEFINER, pinned search_path): sourcing_sheet_approver,
-- sourcing_award_required, sourcing_agreement_allowed (policy and guard helpers), sourcing_propose_award,
-- sourcing_award_enter_approval, sourcing_begin_execution, sourcing_complete_execution, sourcing_cancel_award,
-- sourcing_send_notices.

-- 1. Award decisions --------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.award_decision (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  rfq_id uuid NOT NULL REFERENCES trustwork.rfq (id),
  owner_company_id uuid NOT NULL REFERENCES trustwork.company (id),
  bid_level_sheet_version_id uuid NOT NULL REFERENCES trustwork.bid_level_sheet_version (id),
  selection jsonb NOT NULL CHECK (jsonb_typeof(selection) = 'array' AND jsonb_array_length(selection) BETWEEN 1 AND 50),
  reasons jsonb NOT NULL CHECK (jsonb_typeof(reasons) = 'array' AND jsonb_array_length(reasons) BETWEEN 1 AND 20),
  -- trustwork-digest-1 over { kind, version, rfqId, sheetVersionId, sheetDigest, selection, reasons }; the approval binds it.
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  approval_request_id uuid NULL REFERENCES trustwork.approval_request (id),
  approval_outcome text NULL CHECK (approval_outcome IN ('approved', 'rejected', 'returned', 'withdrawn', 'expired', 'superseded')),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'in_approval', 'approved', 'rejected', 'executed', 'cancelled')),
  agreement_ids uuid[] NOT NULL DEFAULT '{}',
  proposed_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  proposed_via text NOT NULL CHECK (proposed_via IN ('person', 'agent')),
  proposed_mandate_id text NULL CHECK (proposed_mandate_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  executed_at timestamptz NULL,
  executed_by_person_id uuid NULL REFERENCES trustwork.person (id),
  cancelled_reason text NULL CHECK (length(cancelled_reason) BETWEEN 1 AND 500),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT award_decision_mandate CHECK ((proposed_via = 'agent') = (proposed_mandate_id IS NOT NULL)),
  CONSTRAINT award_decision_goes_through_approval CHECK (status = 'proposed' OR approval_request_id IS NOT NULL),
  CONSTRAINT award_decision_executed_shape CHECK ((status = 'executed') = (cardinality(agreement_ids) > 0) AND (status = 'executed') = (executed_at IS NOT NULL) AND (executed_at IS NULL) = (executed_by_person_id IS NULL)),
  CONSTRAINT award_decision_cancelled_shape CHECK ((status = 'cancelled') = (cancelled_reason IS NOT NULL))
);
-- One live award per RFQ: two concurrent proposals cannot both commit.
CREATE UNIQUE INDEX award_decision_one_live ON trustwork.award_decision (rfq_id) WHERE status IN ('proposed', 'in_approval', 'approved', 'executed');
CREATE INDEX award_decision_request_idx ON trustwork.award_decision (approval_request_id) WHERE approval_request_id IS NOT NULL;
CREATE TRIGGER award_decision_touch BEFORE UPDATE ON trustwork.award_decision FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
CREATE TRIGGER award_decision_retained BEFORE DELETE ON trustwork.award_decision FOR EACH ROW EXECUTE FUNCTION trustwork.commerce_retained();
CREATE TRIGGER award_decision_no_truncate BEFORE TRUNCATE ON trustwork.award_decision FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

-- Contract AWARD_DECISION_TRANSITIONS; what was decided never changes.
CREATE FUNCTION trustwork.award_decision_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.rfq_id <> OLD.rfq_id OR NEW.owner_company_id <> OLD.owner_company_id OR NEW.bid_level_sheet_version_id <> OLD.bid_level_sheet_version_id
     OR NEW.selection <> OLD.selection OR NEW.reasons <> OLD.reasons OR NEW.digest <> OLD.digest OR NEW.proposed_by_person_id <> OLD.proposed_by_person_id
     OR NEW.proposed_via <> OLD.proposed_via OR NEW.proposed_mandate_id IS DISTINCT FROM OLD.proposed_mandate_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'an award keeps what was proposed' USING ERRCODE = '23514', HINT = 'sourcing.frozen';
  END IF;
  IF OLD.approval_request_id IS NOT NULL AND NEW.approval_request_id IS DISTINCT FROM OLD.approval_request_id THEN
    RAISE EXCEPTION 'an award keeps its approval request' USING ERRCODE = '23514', HINT = 'sourcing.frozen';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'proposed' AND NEW.status = 'in_approval')
    OR (OLD.status = 'in_approval' AND NEW.status IN ('approved', 'rejected'))
    OR (OLD.status = 'approved' AND NEW.status IN ('executed', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'award transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = '23514', HINT = 'sourcing.invalid_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER award_decision_guard BEFORE UPDATE ON trustwork.award_decision FOR EACH ROW EXECUTE FUNCTION trustwork.award_decision_guard();

-- Every outcome of the request reaches the award in the same transaction. approval_close runs owner-side, so this needs
-- no definer of its own.
CREATE FUNCTION trustwork.sourcing_award_follow_approval() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  UPDATE trustwork.award_decision SET status = CASE WHEN NEW.status = 'approved' THEN 'approved' ELSE 'rejected' END, approval_outcome = NEW.status
  WHERE id = NEW.subject_id AND approval_request_id = NEW.id AND status = 'in_approval';
  RETURN NULL;
END $$;
CREATE TRIGGER approval_request_award_outcome AFTER UPDATE OF status ON trustwork.approval_request FOR EACH ROW
  WHEN (NEW.subject_kind = 'award' AND OLD.status = 'pending' AND NEW.status <> 'pending') EXECUTE FUNCTION trustwork.sourcing_award_follow_approval();

-- People a live approval shows the award to also read the frozen sheet it rests on, whatever their other rights.
CREATE FUNCTION trustwork.sourcing_sheet_approver(p_version uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT EXISTS (SELECT 1 FROM trustwork.award_decision a WHERE a.bid_level_sheet_version_id = p_version AND a.approval_request_id IS NOT NULL AND trustwork.approval_request_visible(a.approval_request_id))
$$;

-- 2. Agreements through awards ----------------------------------------------------------------------------------------
ALTER TABLE trustwork.agreement ADD COLUMN award_decision_id uuid NULL REFERENCES trustwork.award_decision (id);
DROP INDEX trustwork.agreement_one_live_per_rfq;
-- A direct acceptance keeps the COM-002 rule: one live agreement per RFQ. An award holds one live agreement per quote.
CREATE UNIQUE INDEX agreement_one_live_direct_per_rfq ON trustwork.agreement (rfq_id) WHERE terms_kind = 'rfq_quote' AND award_decision_id IS NULL AND status IN ('proposed', 'accepted_by_buyer', 'accepted_by_both');
CREATE UNIQUE INDEX agreement_one_live_per_award_quote ON trustwork.agreement (award_decision_id, quote_id) WHERE award_decision_id IS NOT NULL AND status IN ('proposed', 'accepted_by_buyer', 'accepted_by_both');

-- A company with an active `award` route, or an RFQ with a live award, accepts through that award only: otherwise a direct
-- acceptance would walk around the approval.
CREATE FUNCTION trustwork.sourcing_award_required(p_rfq uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT EXISTS (SELECT 1 FROM trustwork.award_decision a WHERE a.rfq_id = p_rfq AND a.status IN ('proposed', 'in_approval', 'approved', 'executed'))
    OR EXISTS (SELECT 1 FROM trustwork.rfq r JOIN trustwork.approval_route_version v ON v.owner_company_id = r.owner_company_id AND v.subject_kind = 'award' AND v.status = 'active' WHERE r.id = p_rfq)
$$;

-- The award is approved, on this RFQ, and selects this quote version.
CREATE FUNCTION trustwork.sourcing_agreement_allowed(p_award uuid, p_rfq uuid, p_quote_version uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT EXISTS (
    SELECT 1 FROM trustwork.award_decision a
    WHERE a.id = p_award AND a.rfq_id = p_rfq AND a.status = 'approved'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(a.selection) e WHERE e ->> 'quoteVersionId' = p_quote_version::text))
$$;

CREATE FUNCTION trustwork.agreement_award_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.award_decision_id IS DISTINCT FROM OLD.award_decision_id THEN
      RAISE EXCEPTION 'agreed terms never change' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.terms_kind <> 'rfq_quote' THEN
    RETURN NEW;
  END IF;
  -- An order change supersedes an agreement of the same award.
  IF NEW.supersedes_id IS NOT NULL THEN
    NEW.award_decision_id := (SELECT o.award_decision_id FROM trustwork.agreement o WHERE o.id = NEW.supersedes_id);
    RETURN NEW;
  END IF;
  IF NEW.award_decision_id IS NULL THEN
    IF trustwork.sourcing_award_required(NEW.rfq_id) THEN
      RAISE EXCEPTION 'this RFQ is accepted through an approved award' USING ERRCODE = '23514', HINT = 'sourcing.award_required';
    END IF;
  ELSIF NOT trustwork.sourcing_agreement_allowed(NEW.award_decision_id, NEW.rfq_id, NEW.quote_version_id) THEN
    RAISE EXCEPTION 'an agreement follows an approved award of this quote version' USING ERRCODE = '23514', HINT = 'sourcing.award_not_approved';
  END IF;
  RETURN NEW;
END $$;
-- Sorts before agreement_guard, so the guard sees the copied award.
CREATE TRIGGER agreement_award_guard BEFORE INSERT OR UPDATE ON trustwork.agreement FOR EACH ROW EXECUTE FUNCTION trustwork.agreement_award_guard();

-- 3. Outcome notices --------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.bid_outcome_notice (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  rfq_id uuid NOT NULL REFERENCES trustwork.rfq (id),
  recipient_person_id uuid NULL REFERENCES trustwork.person (id),
  recipient_company_id uuid NULL REFERENCES trustwork.company (id),
  outcome text NOT NULL CHECK (outcome IN ('awarded', 'not_awarded', 'cancelled')),
  feedback_band text NULL CHECK (feedback_band IN ('within_5pct', 'within_15pct', 'above_15pct')),
  reason_category text NULL CHECK (reason_category IN ('price', 'lead_time', 'scope', 'eligibility')),
  buyer_opted_in_to_feedback boolean NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bid_outcome_notice_recipient_xor CHECK ((recipient_person_id IS NULL) <> (recipient_company_id IS NULL)),
  CONSTRAINT bid_outcome_notice_feedback CHECK ((feedback_band IS NULL AND reason_category IS NULL) OR (outcome = 'not_awarded' AND buyer_opted_in_to_feedback))
);
CREATE UNIQUE INDEX bid_outcome_notice_one_per_person ON trustwork.bid_outcome_notice (rfq_id, recipient_person_id) WHERE recipient_person_id IS NOT NULL;
CREATE UNIQUE INDEX bid_outcome_notice_one_per_company ON trustwork.bid_outcome_notice (rfq_id, recipient_company_id) WHERE recipient_company_id IS NOT NULL;
CREATE INDEX bid_outcome_notice_company_idx ON trustwork.bid_outcome_notice (recipient_company_id) WHERE recipient_company_id IS NOT NULL;
CREATE TRIGGER bid_outcome_notice_append_only BEFORE UPDATE OR DELETE ON trustwork.bid_outcome_notice FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER bid_outcome_notice_no_truncate BEFORE TRUNCATE ON trustwork.bid_outcome_notice FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

-- 4. Commands ---------------------------------------------------------------------------------------------------------
-- The RFQ is locked, so concurrent proposals resolve one by one. Each selected version must be a comparable column of the
-- frozen sheet; the service checks the line scope against the quotes.
CREATE FUNCTION trustwork.sourcing_propose_award(p_rfq uuid, p_sheet_version uuid, p_selection jsonb, p_reasons jsonb, p_digest text, p_via text, p_mandate text) RETURNS trustwork.award_decision
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_rfq trustwork.rfq%ROWTYPE;
  v_sheet trustwork.bid_level_sheet_version%ROWTYPE;
  v_row trustwork.award_decision%ROWTYPE;
BEGIN
  PERFORM trustwork.sourcing_require_runner(p_rfq);
  SELECT * INTO v_rfq FROM trustwork.rfq WHERE id = p_rfq FOR UPDATE;
  IF v_rfq.owner_company_id IS NULL THEN
    RAISE EXCEPTION 'awards go through a company approval route; a person accepts a quote directly' USING ERRCODE = '23514', HINT = 'sourcing.company_buyer_required';
  END IF;
  IF v_rfq.status <> 'published' THEN
    RAISE EXCEPTION 'an award is proposed on a published RFQ' USING ERRCODE = '23514', HINT = 'sourcing.rfq_not_open';
  END IF;
  SELECT * INTO v_sheet FROM trustwork.bid_level_sheet_version WHERE id = p_sheet_version AND rfq_id = p_rfq;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sheet version not found' USING ERRCODE = 'P0002', HINT = 'sourcing.not_found';
  END IF;
  IF v_sheet.status <> 'frozen' THEN
    RAISE EXCEPTION 'an award rests on the frozen sheet version' USING ERRCODE = '23514', HINT = 'sourcing.sheet_not_frozen';
  END IF;
  IF v_sheet.rfq_version_id IS DISTINCT FROM v_rfq.current_version_id THEN
    RAISE EXCEPTION 'the RFQ was amended after this sheet' USING ERRCODE = '23514', HINT = 'commerce.rfq_version_not_current';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_selection) s
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_sheet.payload -> 'columns') c WHERE c ->> 'quoteVersionId' = s ->> 'quoteVersionId' AND (c ->> 'comparable')::boolean)
  ) THEN
    RAISE EXCEPTION 'an award selects comparable columns of the sheet' USING ERRCODE = '23514', HINT = 'sourcing.not_comparable';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.award_decision WHERE rfq_id = p_rfq AND status IN ('proposed', 'in_approval', 'approved', 'executed')) THEN
    RAISE EXCEPTION 'this RFQ already has a live award' USING ERRCODE = '40001', HINT = 'sourcing.award_exists';
  END IF;
  INSERT INTO trustwork.award_decision (rfq_id, owner_company_id, bid_level_sheet_version_id, selection, reasons, digest, proposed_by_person_id, proposed_via, proposed_mandate_id)
  VALUES (p_rfq, v_rfq.owner_company_id, p_sheet_version, p_selection, p_reasons, p_digest, trustwork.current_person_id(), p_via, p_mandate) RETURNING * INTO v_row;
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.sourcing_award_enter_approval(p_award uuid, p_request uuid) RETURNS trustwork.award_decision
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.award_decision%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM trustwork.award_decision WHERE id = p_award FOR UPDATE;
  IF NOT FOUND OR v_row.proposed_by_person_id IS DISTINCT FROM trustwork.current_person_id() OR v_row.status <> 'proposed' THEN
    RAISE EXCEPTION 'award not found' USING ERRCODE = 'P0002', HINT = 'sourcing.not_found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trustwork.approval_request r WHERE r.id = p_request AND r.subject_kind = 'award' AND r.subject_id = p_award AND r.subject_digest = v_row.digest AND r.status = 'pending') THEN
    RAISE EXCEPTION 'the request binds this award and its digest' USING ERRCODE = '23514', HINT = 'sourcing.digest_mismatch';
  END IF;
  UPDATE trustwork.award_decision SET status = 'in_approval', approval_request_id = p_request WHERE id = p_award RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- Locks an approved award for execution. The row lock makes concurrent executions resolve one by one: the second finds it
-- executed. Placing orders is procurement.order.place; the COM-002 commands then check company.deals.manage, the budget
-- and the mandate themselves.
CREATE FUNCTION trustwork.sourcing_begin_execution(p_award uuid, p_expected integer) RETURNS trustwork.award_decision
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.award_decision%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM trustwork.award_decision WHERE id = p_award FOR UPDATE;
  IF NOT FOUND OR NOT trustwork.sourcing_rfq_reader(v_row.rfq_id) THEN
    RAISE EXCEPTION 'award not found' USING ERRCODE = 'P0002', HINT = 'sourcing.not_found';
  END IF;
  IF v_row.owner_company_id IS DISTINCT FROM trustwork.current_company_id() OR NOT trustwork.supplier_base_holds(v_row.owner_company_id, trustwork.current_person_id(), 'procurement.order.place') THEN
    RAISE EXCEPTION 'orders are placed by members holding procurement.order.place' USING ERRCODE = '42501', HINT = 'sourcing.not_authorised';
  END IF;
  IF v_row.revision <> p_expected THEN
    RAISE EXCEPTION 'the award changed meanwhile' USING ERRCODE = '40001', HINT = 'sourcing.revision_conflict';
  END IF;
  IF v_row.status <> 'approved' THEN
    RAISE EXCEPTION 'only an approved award executes' USING ERRCODE = '42501', HINT = 'sourcing.award_not_approved';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trustwork.approval_request r WHERE r.id = v_row.approval_request_id AND r.status = 'approved' AND r.subject_digest = v_row.digest) THEN
    RAISE EXCEPTION 'the approval does not bind this award' USING ERRCODE = '23514', HINT = 'sourcing.approval_digest_mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trustwork.bid_level_sheet_version s WHERE s.id = v_row.bid_level_sheet_version_id AND s.status = 'frozen') THEN
    RAISE EXCEPTION 'a newer sheet version replaced the one this award rests on' USING ERRCODE = '23514', HINT = 'sourcing.sheet_superseded';
  END IF;
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.sourcing_complete_execution(p_award uuid, p_agreements uuid[]) RETURNS trustwork.award_decision
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.award_decision%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM trustwork.award_decision WHERE id = p_award FOR UPDATE;
  IF NOT FOUND OR v_row.owner_company_id IS DISTINCT FROM trustwork.current_company_id() OR v_row.status <> 'approved' THEN
    RAISE EXCEPTION 'award not found' USING ERRCODE = 'P0002', HINT = 'sourcing.not_found';
  END IF;
  -- Every selected version has its agreement, with a live order: nothing marks an award executed but the COM-002 commands.
  IF cardinality(p_agreements) <> jsonb_array_length(v_row.selection) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_row.selection) s
    WHERE NOT EXISTS (
      SELECT 1 FROM trustwork.agreement a JOIN trustwork.commercial_order o ON o.agreement_id = a.id AND o.status <> 'cancelled'
      WHERE a.id = ANY (p_agreements) AND a.award_decision_id = p_award AND a.quote_version_id::text = s ->> 'quoteVersionId')
  ) THEN
    RAISE EXCEPTION 'every selected quote version has its agreement and order' USING ERRCODE = '23514', HINT = 'sourcing.execution_incomplete';
  END IF;
  UPDATE trustwork.award_decision SET status = 'executed', agreement_ids = p_agreements, executed_at = now(), executed_by_person_id = trustwork.current_person_id() WHERE id = p_award RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- People approved this award, so voiding it is a person's act in their own first-party session, as deciding it was.
CREATE FUNCTION trustwork.sourcing_cancel_award(p_award uuid, p_reason text, p_expected integer, p_session uuid) RETURNS trustwork.award_decision
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.award_decision%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM trustwork.award_decision WHERE id = p_award FOR UPDATE;
  IF NOT FOUND OR NOT trustwork.sourcing_rfq_reader(v_row.rfq_id) THEN
    RAISE EXCEPTION 'award not found' USING ERRCODE = 'P0002', HINT = 'sourcing.not_found';
  END IF;
  PERFORM trustwork.sourcing_require_runner(v_row.rfq_id);
  PERFORM trustwork.approval_first_party_session(p_session);
  IF v_row.revision <> p_expected THEN
    RAISE EXCEPTION 'the award changed meanwhile' USING ERRCODE = '40001', HINT = 'sourcing.revision_conflict';
  END IF;
  IF v_row.status <> 'approved' THEN
    RAISE EXCEPTION 'only an approved award is cancelled' USING ERRCODE = '23514', HINT = 'sourcing.invalid_transition';
  END IF;
  UPDATE trustwork.award_decision SET status = 'cancelled', cancelled_reason = p_reason WHERE id = p_award RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- One notice per invitee, once per RFQ. Recipients and outcomes come from the rows, never from the caller: with an executed
-- award, the sellers of the selected versions are awarded and every other invitee is not; without one, the RFQ must be
-- closed and everybody gets `cancelled`. `p_feedback` is { "<recipient id>": { "band": ..., "reason": ... } }, applied
-- only to a not-awarded recipient of an executed award with the buyer's opt-in.
CREATE FUNCTION trustwork.sourcing_send_notices(p_rfq uuid, p_award uuid, p_opted_in boolean, p_feedback jsonb, p_expected integer) RETURNS SETOF trustwork.bid_outcome_notice
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_rfq trustwork.rfq%ROWTYPE;
  v_award trustwork.award_decision%ROWTYPE;
  v_party record;
  v_outcome text;
  v_entry jsonb;
BEGIN
  PERFORM trustwork.sourcing_require_runner(p_rfq);
  SELECT * INTO v_rfq FROM trustwork.rfq WHERE id = p_rfq FOR UPDATE;
  IF v_rfq.revision <> p_expected THEN
    RAISE EXCEPTION 'the RFQ changed meanwhile' USING ERRCODE = '40001', HINT = 'sourcing.revision_conflict';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.bid_outcome_notice WHERE rfq_id = p_rfq) THEN
    RAISE EXCEPTION 'outcome notices were already sent' USING ERRCODE = '40001', HINT = 'sourcing.already_notified';
  END IF;
  IF p_award IS NOT NULL THEN
    SELECT * INTO v_award FROM trustwork.award_decision WHERE id = p_award AND rfq_id = p_rfq;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'award not found' USING ERRCODE = 'P0002', HINT = 'sourcing.not_found';
    END IF;
    IF v_award.status <> 'executed' THEN
      RAISE EXCEPTION 'outcomes follow an executed award' USING ERRCODE = '23514', HINT = 'sourcing.award_not_executed';
    END IF;
  ELSE
    IF v_rfq.status NOT IN ('closed', 'cancelled', 'expired') OR EXISTS (SELECT 1 FROM trustwork.award_decision WHERE rfq_id = p_rfq AND status = 'executed') THEN
      RAISE EXCEPTION 'a cancelled outcome needs a closed RFQ without an executed award' USING ERRCODE = '23514', HINT = 'sourcing.rfq_not_closed';
    END IF;
    IF p_opted_in THEN
      RAISE EXCEPTION 'feedback comes only after an award' USING ERRCODE = '23514', HINT = 'sourcing.feedback_needs_award';
    END IF;
  END IF;
  FOR v_party IN SELECT DISTINCT i.party_person_id, i.party_company_id FROM trustwork.rfq_invitation i WHERE i.rfq_id = p_rfq LOOP
    IF p_award IS NULL THEN
      v_outcome := 'cancelled';
    ELSIF EXISTS (
      SELECT 1 FROM trustwork.agreement a
      WHERE a.id = ANY (v_award.agreement_ids) AND a.seller_person_id IS NOT DISTINCT FROM v_party.party_person_id AND a.seller_company_id IS NOT DISTINCT FROM v_party.party_company_id
    ) THEN
      v_outcome := 'awarded';
    ELSE
      v_outcome := 'not_awarded';
    END IF;
    v_entry := CASE WHEN v_outcome = 'not_awarded' AND p_opted_in THEN p_feedback -> coalesce(v_party.party_company_id, v_party.party_person_id)::text END;
    RETURN QUERY INSERT INTO trustwork.bid_outcome_notice (rfq_id, recipient_person_id, recipient_company_id, outcome, feedback_band, reason_category, buyer_opted_in_to_feedback)
      VALUES (p_rfq, v_party.party_person_id, v_party.party_company_id, v_outcome, v_entry ->> 'band', v_entry ->> 'reason', p_opted_in) RETURNING *;
  END LOOP;
END $$;

-- 5. Row-level security -----------------------------------------------------------------------------------------------
ALTER TABLE trustwork.award_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.award_decision FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.bid_outcome_notice ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.bid_outcome_notice FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.award_decision AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.bid_outcome_notice AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

CREATE POLICY award_decision_read ON trustwork.award_decision FOR SELECT TO trustwork_app
  USING (trustwork.sourcing_rfq_reader(rfq_id) OR (approval_request_id IS NOT NULL AND trustwork.approval_request_visible(approval_request_id)));
DROP POLICY bid_level_sheet_version_read ON trustwork.bid_level_sheet_version;
CREATE POLICY bid_level_sheet_version_read ON trustwork.bid_level_sheet_version FOR SELECT TO trustwork_app
  USING (trustwork.sourcing_rfq_reader(rfq_id) OR trustwork.sourcing_sheet_approver(id));
-- The recipient reads its own notice; the buyer side reads what it sent. A company reads through members holding
-- company.deals.manage, as for its quotes.
CREATE POLICY bid_outcome_notice_read ON trustwork.bid_outcome_notice FOR SELECT TO trustwork_app
  USING (trustwork.commerce_party_acts(recipient_person_id, recipient_company_id, 'company.deals.manage') OR trustwork.sourcing_rfq_reader(rfq_id));

GRANT SELECT ON trustwork.award_decision, trustwork.bid_outcome_notice TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.sourcing_sheet_approver(uuid), trustwork.sourcing_award_required(uuid), trustwork.sourcing_agreement_allowed(uuid, uuid, uuid),
  trustwork.sourcing_propose_award(uuid, uuid, jsonb, jsonb, text, text, text), trustwork.sourcing_award_enter_approval(uuid, uuid), trustwork.sourcing_begin_execution(uuid, integer),
  trustwork.sourcing_complete_execution(uuid, uuid[]), trustwork.sourcing_cancel_award(uuid, text, integer, uuid), trustwork.sourcing_send_notices(uuid, uuid, boolean, jsonb, integer) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
