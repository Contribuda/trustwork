-- PRC-004, ADR 027: sealed-until-deadline RFQs (handbook docs/engine/procurement-and-supply.md, "Sourcing events and bid
-- levelling"). A buyer may set `sealedUntilDeadline` in an RFQ version payload. The setting is part of the published
-- version: suppliers see it and its digest binds it. While the seal holds, the buyer side reads no sent quote version,
-- so neither a line, a total nor a tax determination reaches the buyer, its agents or its comparison. The seller reads
-- its own quote as always, and the buyer still sees who answered (the quote envelope and the invitation status carry no
-- price).
--
-- The seal cannot be lifted early. Once any published version of the RFQ was sealed, it lasts until the latest response
-- deadline of every published version: amending the deadline forward extends it, and an amendment that drops the flag
-- or moves the deadline back shortens nothing. Closing or cancelling the RFQ does not open it.
--
-- Once the deadline of a sealed RFQ has passed, the round is closed and nothing new competes with the opened bids: no
-- amendment is published, so the deadline never moves later and a seal never comes back; no invitation goes out; and a
-- quote version is sent only if it answers an open amendment request of the buyer, which is the negotiation round on an
-- opened bid. A new round is a new RFQ.
--
-- Authority: `sourcing_seal_end` has no grant; only the owner-run functions below call it. `sourcing_sealed_until` tells
-- the date only to those who read the setting anyway: the buyer side and the invitees. `sourcing_sealed` and
-- `sourcing_round_closed` have no check of their own because row-level security, guards and the owner-run envelope
-- delivery must get the true answer for any caller, and a check that answered "not sealed" would fail open. Each returns
-- one bit about an RFQ id, no price, party or date, and no route hands that bit to a caller who is not on the RFQ.

CREATE FUNCTION trustwork.sourcing_seal_end(p_rfq uuid) RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT CASE WHEN bool_or(v.payload ->> 'sealedUntilDeadline' = 'true') THEN max((v.payload ->> 'responseDeadline')::timestamptz) END
  FROM trustwork.rfq_version v WHERE v.rfq_id = p_rfq AND v.status <> 'draft'
$$;

CREATE FUNCTION trustwork.sourcing_sealed(p_rfq uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT coalesce(trustwork.sourcing_seal_end(p_rfq) > now(), false)
$$;

CREATE FUNCTION trustwork.sourcing_round_closed(p_rfq uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT coalesce(trustwork.sourcing_seal_end(p_rfq) <= now(), false)
$$;

CREATE FUNCTION trustwork.sourcing_sealed_until(p_rfq uuid) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.sourcing_seal_end(p_rfq) WHERE trustwork.rfq_can(p_rfq, 'read.party_private') OR trustwork.rfq_invitee(p_rfq, NULL)
$$;

-- The buyer side reads sent versions only once the seal lifts. Lines and tax determinations follow: their policies read
-- quote_version under this policy.
DROP POLICY quote_version_read ON trustwork.quote_version;
CREATE POLICY quote_version_read ON trustwork.quote_version FOR SELECT TO trustwork_app
  USING (trustwork.quote_side(quote_id) = 'seller' OR (status <> 'draft' AND trustwork.quote_side(quote_id) = 'buyer' AND NOT trustwork.sourcing_sealed(rfq_id)));

-- agents_deliver_envelope is owner-run, so it reads past that policy. A note naming a competing seller's price is refused,
-- which would confirm a guessed sealed amount; while the seal holds there is no such amount for the buyer to repeat.
CREATE OR REPLACE FUNCTION trustwork.agents_competitor_amounts(p_rfq_id uuid, p_s_kind text, p_s_id uuid, p_r_kind text, p_r_id uuid) RETURNS text[]
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT coalesce(array_agg(DISTINCT x #>> '{}') FILTER (WHERE (x #>> '{}') ~ '^\d+$'), ARRAY[]::text[])
  FROM trustwork.rfq r JOIN trustwork.quote q ON q.rfq_id = r.id JOIN trustwork.quote_version v ON v.quote_id = q.id AND v.status <> 'draft',
    LATERAL jsonb_path_query(v.payload, 'strict $.**.minorUnits') AS x
  WHERE r.id = p_rfq_id
    AND ((p_s_kind = 'person' AND r.owner_person_id = p_s_id) OR (p_s_kind = 'company' AND r.owner_company_id = p_s_id))
    AND NOT coalesce((p_r_kind = 'person' AND q.seller_person_id = p_r_id) OR (p_r_kind = 'company' AND q.seller_company_id = p_r_id), false)
    AND NOT trustwork.sourcing_sealed(r.id)
$$;

CREATE FUNCTION trustwork.sourcing_late_send_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF trustwork.sourcing_round_closed(NEW.rfq_id) AND NOT EXISTS (
    SELECT 1 FROM trustwork.amendment_request a WHERE a.id = NEW.answers_amendment_request_id AND a.quote_id = NEW.quote_id AND a.status = 'open'
  ) THEN
    RAISE EXCEPTION 'the response deadline of this sealed RFQ has passed' USING ERRCODE = '23514', HINT = 'sourcing.sealed_deadline_passed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quote_version_sealed_late_send BEFORE UPDATE OF status ON trustwork.quote_version FOR EACH ROW
  WHEN (OLD.status = 'draft' AND NEW.status = 'sent') EXECUTE FUNCTION trustwork.sourcing_late_send_guard();

-- A closed round takes no amendment: after the deadline an amendment could only reopen the bidding on opened prices, and
-- it would stale every bid with no invitation left to revalidate it. A sealed version needs a deadline still ahead.
CREATE FUNCTION trustwork.sourcing_publish_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF trustwork.sourcing_round_closed(NEW.rfq_id) THEN
    RAISE EXCEPTION 'the deadline of this sealed RFQ has passed: a new round is a new RFQ' USING ERRCODE = '23514', HINT = 'sourcing.sealed_round_closed';
  END IF;
  IF NEW.payload ->> 'sealedUntilDeadline' = 'true' AND (NEW.payload ->> 'responseDeadline')::timestamptz <= now() THEN
    RAISE EXCEPTION 'a sealed version needs a deadline still ahead' USING ERRCODE = '23514', HINT = 'sourcing.sealed_round_closed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rfq_version_sealed_round BEFORE UPDATE OF status ON trustwork.rfq_version FOR EACH ROW
  WHEN (OLD.status = 'draft' AND NEW.status = 'published') EXECUTE FUNCTION trustwork.sourcing_publish_guard();

CREATE FUNCTION trustwork.sourcing_invitation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF trustwork.sourcing_round_closed(NEW.rfq_id) THEN
    RAISE EXCEPTION 'the deadline of this sealed RFQ has passed: a new round is a new RFQ' USING ERRCODE = '23514', HINT = 'sourcing.sealed_round_closed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rfq_invitation_sealed_round BEFORE INSERT ON trustwork.rfq_invitation FOR EACH ROW EXECUTE FUNCTION trustwork.sourcing_invitation_guard();

GRANT EXECUTE ON FUNCTION trustwork.sourcing_sealed_until(uuid), trustwork.sourcing_sealed(uuid), trustwork.sourcing_round_closed(uuid) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
