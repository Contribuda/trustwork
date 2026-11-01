-- BILL-003: task source provenance and an explicit fee disclosure before acceptance.
CREATE TABLE trustwork.billing_task_origin (
 source_kind text NOT NULL CHECK(source_kind IN ('request','offer')),
 source_id uuid NOT NULL,
 hub_id uuid NOT NULL REFERENCES trustwork.hub(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(source_kind,source_id)
);
CREATE TRIGGER billing_task_origin_frozen BEFORE UPDATE OR DELETE ON trustwork.billing_task_origin FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
ALTER TABLE trustwork.billing_task_origin ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.billing_task_origin FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.billing_task_origin TO trustwork_owner USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());
CREATE FUNCTION trustwork.billing_task_origin(p_hub uuid,p_kind text,p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
BEGIN
 IF p_hub IS NULL OR NOT EXISTS(SELECT 1 FROM trustwork.hub WHERE id=p_hub AND lifecycle<>'closed') THEN
  RAISE EXCEPTION 'served hub unavailable' USING ERRCODE='23514',HINT='billing.unavailable'; END IF;
 IF p_kind='request' THEN
  IF NOT EXISTS(SELECT 1 FROM trustwork.task_request WHERE id=p_id AND owner_person_id=trustwork.current_person_id()) THEN
   RAISE EXCEPTION 'request unavailable' USING ERRCODE='P0002',HINT='admin.not_found'; END IF;
 ELSIF p_kind='offer' THEN
  IF NOT EXISTS(SELECT 1 FROM trustwork.task_offer WHERE id=p_id AND trustwork.commerce_party_acts(offeror_person_id,offeror_company_id,'company.deals.manage')) THEN
   RAISE EXCEPTION 'offer unavailable' USING ERRCODE='P0002',HINT='admin.not_found'; END IF;
 ELSE RAISE EXCEPTION 'invalid source kind' USING ERRCODE='22023',HINT='billing.invalid_terms'; END IF;
 INSERT INTO trustwork.billing_task_origin(source_kind,source_id,hub_id) VALUES(p_kind,p_id,p_hub);
END $$;
-- The digest input consists only of ASCII identifiers, frozen digests and integer versions.
-- Its canonical form is identical to agreementDigestInput(..., 'task'); the real API tests compare both.
CREATE FUNCTION trustwork.billing_task_scope(p_hub uuid,p_offer uuid) RETURNS trustwork.billing_fee_scope
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE o trustwork.task_offer%ROWTYPE; r trustwork.task_request%ROWTYPE; s trustwork.billing_fee_scope%ROWTYPE;
 buyer_hub uuid; seller_hub uuid; digest text;
BEGIN
 SELECT * INTO o FROM trustwork.task_offer WHERE id=p_offer;
 SELECT * INTO r FROM trustwork.task_request WHERE id=o.task_request_id FOR UPDATE;
 IF o.id IS NULL OR r.id IS NULL OR NOT (r.owner_person_id=trustwork.current_person_id()
   OR trustwork.commerce_party_acts(o.offeror_person_id,o.offeror_company_id,'company.deals.manage')) THEN
  RAISE EXCEPTION 'offer unavailable' USING ERRCODE='P0002',HINT='admin.not_found'; END IF;
 SELECT hub_id INTO buyer_hub FROM trustwork.billing_task_origin WHERE source_kind='request' AND source_id=r.id;
 SELECT hub_id INTO seller_hub FROM trustwork.billing_task_origin WHERE source_kind='offer' AND source_id=o.id;
 IF buyer_hub IS NULL OR seller_hub IS NULL THEN RAISE EXCEPTION 'source hub unavailable' USING ERRCODE='23514',HINT='billing.unavailable'; END IF;
 IF o.status<>'sent' OR o.digest IS NULL OR r.status<>'published' OR r.current_version_id<>o.request_version_id
   OR o.valid_until<=clock_timestamp() THEN RAISE EXCEPTION 'offer outdated' USING ERRCODE='23514',HINT='billing.source_outdated'; END IF;
 digest:=trustwork.admin_digest(jsonb_build_object('termsKind','task',
   'quoteVersion',jsonb_build_object('id',o.id,'version',o.version,'digest',jsonb_build_object('algorithm','trustwork-digest-1','value',o.digest)),
   'rfqVersion',jsonb_build_object('id',o.request_version_id,'version',o.request_version,'digest',jsonb_build_object('algorithm','trustwork-digest-1','value',o.request_version_digest))));
 -- No invented mapping from taxonomy to fee categories: the current task contract supports the general task rate.
 INSERT INTO trustwork.billing_fee_scope(source_kind,source_id,source_digest,fee_kind,category_key,buyer_person_id,seller_person_id,seller_company_id,buyer_hub_id,seller_hub_id)
 VALUES('task',o.id,digest,'task',NULL,r.owner_person_id,o.offeror_person_id,o.offeror_company_id,buyer_hub,seller_hub)
 ON CONFLICT(source_kind,source_id,source_digest) DO NOTHING;
 SELECT * INTO s FROM trustwork.billing_fee_scope WHERE source_kind='task' AND source_id=o.id AND source_digest=digest;
 PERFORM trustwork.billing_fee_side(s,p_hub);
 RETURN s;
END $$;
CREATE FUNCTION trustwork.billing_task_disclose(p_hub uuid,p_offer uuid) RETURNS trustwork.billing_fee_disclosure
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE s trustwork.billing_fee_scope%ROWTYPE; d trustwork.billing_fee_disclosure%ROWTYPE; currency text;
BEGIN
 s:=trustwork.billing_task_scope(p_hub,p_offer);
 d:=trustwork.billing_fee_disclose(p_hub,s.id);
 SELECT payload#>>'{price,currency}' INTO currency FROM trustwork.task_offer WHERE id=p_offer;
 IF d.snapshot#>>'{buyerFee,terms,currency}' IS DISTINCT FROM currency OR d.snapshot#>>'{sellerFee,terms,currency}' IS DISTINCT FROM currency THEN
  RAISE EXCEPTION 'fee currency unavailable' USING ERRCODE='23514',HINT='billing.unavailable'; END IF;
 RETURN d;
END $$;
CREATE FUNCTION trustwork.billing_task_confirm(p_hub uuid,p_agreement uuid,p_disclosure uuid,p_digest text,p_side text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE a trustwork.agreement%ROWTYPE; s trustwork.billing_fee_scope%ROWTYPE; d trustwork.billing_fee_disclosure%ROWTYPE; c trustwork.billing_fee_confirmation%ROWTYPE;
BEGIN
 SELECT * INTO a FROM trustwork.agreement WHERE id=p_agreement AND terms_kind='task' FOR UPDATE;
 IF a.id IS NULL OR a.status<>'accepted_by_buyer' THEN RAISE EXCEPTION 'agreement unavailable' USING ERRCODE='P0002',HINT='admin.not_found'; END IF;
 s:=trustwork.billing_task_scope(p_hub,a.offer_ref_id);
 d:=trustwork.billing_fee_check_disclosure(p_hub,p_disclosure,p_digest);
 IF d.scope_id<>s.id OR d.side IS DISTINCT FROM p_side OR s.source_digest<>a.accepted_terms_digest THEN
  RAISE EXCEPTION 'disclosure does not match agreement' USING ERRCODE='23514',HINT='billing.source_outdated'; END IF;
 IF p_side='seller' AND NOT EXISTS(SELECT 1 FROM trustwork.billing_fee_binding x JOIN trustwork.billing_fee_confirmation bc ON bc.id=x.confirmation_id
   JOIN trustwork.billing_fee_disclosure bd ON bd.id=bc.disclosure_id WHERE x.booking_id=a.id AND bd.scope_id=s.id AND bd.side='buyer'
   AND x.source_digest=a.accepted_terms_digest AND x.source_hub_id=s.buyer_hub_id AND x.local_fee_id=d.buyer_fee_id AND x.counterparty_fee_id=d.seller_fee_id) THEN
  RAISE EXCEPTION 'buyer confirmed different fees' USING ERRCODE='23514',HINT='billing.fee_outdated'; END IF;
 c:=trustwork.billing_fee_confirm(p_hub,d.id,d.digest);
 PERFORM trustwork.billing_fee_bind(p_hub,c.id,a.id,a.accepted_terms_digest);
END $$;
CREATE FUNCTION trustwork.billing_task_agreement_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
BEGIN
 IF NEW.terms_kind='task' AND NEW.status='accepted_by_both' AND OLD.status='accepted_by_buyer'
 AND EXISTS(SELECT 1 FROM trustwork.billing_task_origin WHERE source_kind='offer' AND source_id=NEW.offer_ref_id)
 AND (SELECT count(DISTINCT d.side) FROM trustwork.billing_fee_binding b JOIN trustwork.billing_fee_confirmation c ON c.id=b.confirmation_id
   JOIN trustwork.billing_fee_disclosure d ON d.id=c.disclosure_id JOIN trustwork.billing_fee_scope s ON s.id=d.scope_id
   WHERE b.booking_id=NEW.id AND b.source_digest=NEW.accepted_terms_digest AND s.source_kind='task' AND s.source_id=NEW.offer_ref_id)<>2 THEN
  RAISE EXCEPTION 'both fee confirmations are required' USING ERRCODE='23514',HINT='billing.unavailable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER billing_task_agreement_guard BEFORE UPDATE OF status ON trustwork.agreement FOR EACH ROW EXECUTE FUNCTION trustwork.billing_task_agreement_guard();
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.billing_task_origin(uuid,text,uuid),trustwork.billing_task_disclose(uuid,uuid),trustwork.billing_task_confirm(uuid,uuid,uuid,text,text) TO trustwork_app;
