-- BILL-003 after CONS-001: immutable local source provenance, never a caller-supplied participant home hub.
CREATE TABLE trustwork.billing_consultation_origin (
 source_kind text NOT NULL CHECK(source_kind IN ('offering','request')),
 source_id uuid NOT NULL,
 hub_id uuid NOT NULL REFERENCES trustwork.hub(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(source_kind,source_id)
);
CREATE TRIGGER billing_consultation_origin_frozen BEFORE UPDATE OR DELETE ON trustwork.billing_consultation_origin FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
ALTER TABLE trustwork.billing_consultation_origin ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.billing_consultation_origin FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.billing_consultation_origin TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());

CREATE FUNCTION trustwork.billing_consultation_origin(p_hub uuid,p_kind text,p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
BEGIN
 IF p_hub IS NULL OR NOT EXISTS(SELECT 1 FROM trustwork.hub WHERE id=p_hub AND lifecycle<>'closed') THEN
  RAISE EXCEPTION 'served hub unavailable' USING ERRCODE='23514',HINT='billing.unavailable'; END IF;
 IF p_kind='request' THEN
  IF NOT EXISTS(SELECT 1 FROM trustwork.consultation_request WHERE id=p_id AND requester_person_id=trustwork.current_person_id()) THEN
   RAISE EXCEPTION 'request unavailable' USING ERRCODE='P0002',HINT='admin.not_found'; END IF;
 ELSIF p_kind='offering' THEN
  IF NOT EXISTS(SELECT 1 FROM trustwork.consultation_offering WHERE offering_id=p_id AND trustwork.commerce_party_acts(owner_person_id,owner_company_id,'company.catalogue.edit')) THEN
   RAISE EXCEPTION 'offering unavailable' USING ERRCODE='P0002',HINT='admin.not_found'; END IF;
 ELSE RAISE EXCEPTION 'invalid source kind' USING ERRCODE='22023',HINT='billing.invalid_terms';
 END IF;
 INSERT INTO trustwork.billing_consultation_origin(source_kind,source_id,hub_id) VALUES(p_kind,p_id,p_hub);
END $$;

CREATE FUNCTION trustwork.billing_consultation_quote(p_hub uuid,p_request uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE r trustwork.consultation_request%ROWTYPE; buyer_hub uuid; seller_hub uuid;
 b trustwork.marketplace_fee_version%ROWTYPE; s trustwork.marketplace_fee_version%ROWTYPE; k text;
BEGIN
 SELECT * INTO r FROM trustwork.consultation_request WHERE id=p_request;
 IF NOT FOUND OR NOT trustwork.commerce_party_acts(r.offering_owner_person_id,r.offering_owner_company_id,'company.deals.manage') THEN
  RAISE EXCEPTION 'request unavailable' USING ERRCODE='P0002',HINT='admin.not_found'; END IF;
 SELECT hub_id INTO buyer_hub FROM trustwork.billing_consultation_origin WHERE source_kind='request' AND source_id=r.id;
 SELECT hub_id INTO seller_hub FROM trustwork.billing_consultation_origin WHERE source_kind='offering' AND source_id=r.offering_id;
 IF buyer_hub IS NULL OR seller_hub IS NULL OR p_hub IS DISTINCT FROM seller_hub
  OR EXISTS(SELECT 1 FROM trustwork.hub WHERE id IN(buyer_hub,seller_hub) AND lifecycle='closed') THEN
  RAISE EXCEPTION 'source hub unavailable' USING ERRCODE='23514',HINT='billing.unavailable'; END IF;
 FOR k IN SELECT unnest(ARRAY[buyer_hub::text||':consultation:buyer',seller_hub::text||':consultation:seller']) ORDER BY 1 LOOP
  PERFORM pg_advisory_xact_lock(hashtext('trustwork.billing.fee'),hashtext(k));
 END LOOP;
 SELECT * INTO b FROM trustwork.marketplace_fee_version WHERE hub_id=buyer_hub AND kind='consultation' AND payer='buyer'
  AND (category_key IS NULL OR category_key=r.kind) AND status='active' AND effective_from<=clock_timestamp() AND (effective_to IS NULL OR effective_to>clock_timestamp());
 SELECT * INTO s FROM trustwork.marketplace_fee_version WHERE hub_id=seller_hub AND kind='consultation' AND payer='seller'
  AND (category_key IS NULL OR category_key=r.kind) AND status='active' AND effective_from<=clock_timestamp() AND (effective_to IS NULL OR effective_to>clock_timestamp());
 IF b.id IS NULL OR s.id IS NULL THEN RAISE EXCEPTION 'published fees unavailable' USING ERRCODE='23514',HINT='billing.unavailable'; END IF;
 RETURN jsonb_build_object('buyerFee',trustwork.billing_fee_public(b),'sellerFee',trustwork.billing_fee_public(s));
END $$;

CREATE FUNCTION trustwork.billing_consultation_proposed(p_hub uuid,p_booking uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE b trustwork.consultation_booking%ROWTYPE; q jsonb;
BEGIN
 SELECT * INTO b FROM trustwork.consultation_booking WHERE id=p_booking;
 IF NOT FOUND OR NOT trustwork.commerce_party_acts(b.seller_person_id,b.seller_company_id,'company.deals.manage') THEN
  RAISE EXCEPTION 'booking unavailable' USING ERRCODE='P0002',HINT='admin.not_found'; END IF;
 q:=trustwork.billing_consultation_quote(p_hub,b.request_id);
 IF b.terms#>>'{pricing,commission,status}' IS DISTINCT FROM 'versioned_fees'
  OR b.terms#>'{pricing,commission,buyerFee}' IS DISTINCT FROM q->'buyerFee'
  OR b.terms#>'{pricing,commission,sellerFee}' IS DISTINCT FROM q->'sellerFee' THEN
  RAISE EXCEPTION 'proposal must pin the published fee versions' USING ERRCODE='23514',HINT='billing.fee_outdated'; END IF;
 INSERT INTO trustwork.billing_fee_scope(source_kind,source_id,source_digest,fee_kind,category_key,buyer_person_id,seller_person_id,seller_company_id,buyer_hub_id,seller_hub_id)
 VALUES('consultation',b.id,b.terms_digest,'consultation',b.kind,b.client_person_id,b.seller_person_id,b.seller_company_id,
 (q#>>'{buyerFee,hubId}')::uuid,(q#>>'{sellerFee,hubId}')::uuid);
END $$;

CREATE FUNCTION trustwork.billing_consultation_confirm(p_hub uuid,p_booking uuid,p_side text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE b trustwork.consultation_booking%ROWTYPE; s trustwork.billing_fee_scope%ROWTYPE;
 d trustwork.billing_fee_disclosure%ROWTYPE; c trustwork.billing_fee_confirmation%ROWTYPE;
BEGIN
 SELECT * INTO b FROM trustwork.consultation_booking WHERE id=p_booking FOR UPDATE;
 SELECT * INTO s FROM trustwork.billing_fee_scope WHERE source_kind='consultation' AND source_id=p_booking AND source_digest=b.terms_digest;
 IF b.id IS NULL OR s.id IS NULL OR b.status<>'proposed' THEN
  RAISE EXCEPTION 'fee-bound proposal unavailable' USING ERRCODE='23514',HINT='billing.unavailable'; END IF;
 IF trustwork.billing_fee_side(s,p_hub) IS DISTINCT FROM p_side THEN
  RAISE EXCEPTION 'wrong booking party' USING ERRCODE='P0002',HINT='admin.not_found'; END IF;
 d:=trustwork.billing_fee_disclose(p_hub,s.id);
 -- The participant accepted the immutable booking digest; never replace its shown fees with today's rates.
 IF d.snapshot->'buyerFee' IS DISTINCT FROM b.terms#>'{pricing,commission,buyerFee}'
  OR d.snapshot->'sellerFee' IS DISTINCT FROM b.terms#>'{pricing,commission,sellerFee}' THEN
  RAISE EXCEPTION 'shown fee version outdated' USING ERRCODE='23514',HINT='billing.fee_outdated'; END IF;
 IF p_side='seller' AND NOT EXISTS(SELECT 1 FROM trustwork.billing_fee_binding x WHERE x.booking_id=b.id
   AND x.person_id=b.client_person_id AND x.source_hub_id=s.buyer_hub_id AND x.local_fee_id=d.buyer_fee_id AND x.counterparty_fee_id=d.seller_fee_id) THEN
  RAISE EXCEPTION 'buyer has not confirmed these fees' USING ERRCODE='23514',HINT='billing.unavailable'; END IF;
 c:=trustwork.billing_fee_confirm(p_hub,d.id,d.digest);
 PERFORM trustwork.billing_fee_bind(p_hub,c.id,b.id,b.terms_digest);
END $$;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.billing_consultation_origin(uuid,text,uuid),trustwork.billing_consultation_quote(uuid,uuid),
 trustwork.billing_consultation_proposed(uuid,uuid),trustwork.billing_consultation_confirm(uuid,uuid,text) TO trustwork_app;

-- Protect the stored commitment too: bypassing the service cannot book a fee-bound proposal without both bindings.
CREATE FUNCTION trustwork.billing_consultation_booking_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE s trustwork.billing_fee_scope%ROWTYPE; buyer_fee uuid; seller_fee uuid;
BEGIN
 IF NEW.status='booked' AND OLD.status='proposed' AND NEW.terms#>>'{pricing,commission,status}'='versioned_fees' THEN
  SELECT * INTO s FROM trustwork.billing_fee_scope WHERE source_kind='consultation' AND source_id=NEW.id AND source_digest=NEW.terms_digest;
  buyer_fee:=(NEW.terms#>>'{pricing,commission,buyerFee,id}')::uuid;
  seller_fee:=(NEW.terms#>>'{pricing,commission,sellerFee,id}')::uuid;
  IF s.id IS NULL OR NOT EXISTS(SELECT 1 FROM trustwork.billing_fee_binding x JOIN trustwork.billing_fee_confirmation c ON c.id=x.confirmation_id
   JOIN trustwork.billing_fee_disclosure d ON d.id=c.disclosure_id WHERE x.booking_id=NEW.id AND x.source_digest=NEW.terms_digest
   AND d.scope_id=s.id AND d.side='buyer' AND x.source_hub_id=s.buyer_hub_id AND x.local_fee_id=buyer_fee AND x.counterparty_fee_id=seller_fee)
   OR NOT EXISTS(SELECT 1 FROM trustwork.billing_fee_binding x JOIN trustwork.billing_fee_confirmation c ON c.id=x.confirmation_id
   JOIN trustwork.billing_fee_disclosure d ON d.id=c.disclosure_id WHERE x.booking_id=NEW.id AND x.source_digest=NEW.terms_digest
   AND d.scope_id=s.id AND d.side='seller' AND x.source_hub_id=s.seller_hub_id AND x.local_fee_id=seller_fee AND x.counterparty_fee_id=buyer_fee) THEN
   RAISE EXCEPTION 'both fee confirmations are required' USING ERRCODE='23514',HINT='billing.unavailable';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER billing_consultation_booking_guard BEFORE UPDATE OF status ON trustwork.consultation_booking
 FOR EACH ROW EXECUTE FUNCTION trustwork.billing_consultation_booking_guard();
REVOKE ALL ON FUNCTION trustwork.billing_consultation_booking_guard() FROM PUBLIC;
