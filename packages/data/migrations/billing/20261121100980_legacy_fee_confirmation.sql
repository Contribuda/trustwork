-- BILL-003 / TASK-001 / CONS-001: only immutable migration-captured sources retain their original fees.
-- No timestamp, absent origin, caller price or chosen hub establishes historical authority.
CREATE FUNCTION trustwork.billing_task_legacy_proceeds(p_agreement uuid,p_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE a trustwork.agreement%ROWTYPE; o trustwork.task_offer%ROWTYPE; r trustwork.task_request%ROWTYPE;
 v trustwork.task_request_version%ROWTYPE; expected text;
BEGIN
 SELECT * INTO a FROM trustwork.agreement WHERE id=p_agreement AND terms_kind='task' FOR UPDATE;
 IF a.id IS NULL OR NOT trustwork.commerce_party_acts(a.seller_person_id,a.seller_company_id,'company.deals.manage') THEN
  RAISE EXCEPTION 'agreement unavailable' USING ERRCODE='P0002',HINT='admin.not_found'; END IF;
 IF a.status<>'accepted_by_buyer' OR a.accepted_terms_digest IS DISTINCT FROM p_digest THEN
  RAISE EXCEPTION 'agreement unavailable' USING ERRCODE='23514',HINT='billing.source_outdated'; END IF;
 IF NOT EXISTS(SELECT 1 FROM trustwork.billing_fee_legacy_source WHERE source_kind='task' AND source_id=a.id AND source_digest=a.accepted_terms_digest) THEN RETURN NULL; END IF;
 SELECT * INTO o FROM trustwork.task_offer WHERE id=a.offer_ref_id FOR SHARE;
 SELECT * INTO v FROM trustwork.task_request_version WHERE id=a.request_ref_id FOR SHARE;
 SELECT * INTO r FROM trustwork.task_request WHERE id=o.task_request_id FOR SHARE;
 expected:=trustwork.admin_digest(jsonb_build_object('termsKind','task',
  'quoteVersion',jsonb_build_object('id',o.id,'version',o.version,'digest',jsonb_build_object('algorithm','trustwork-digest-1','value',o.digest)),
  'rfqVersion',jsonb_build_object('id',v.id,'version',v.version,'digest',jsonb_build_object('algorithm','trustwork-digest-1','value',v.digest))));
 IF o.id IS NULL OR v.id IS NULL OR r.id IS NULL OR o.status<>'sent' OR o.valid_until<=clock_timestamp()
  OR r.status<>'published' OR r.current_version_id IS DISTINCT FROM v.id OR v.task_request_id IS DISTINCT FROM r.id
  OR a.buyer_person_id IS DISTINCT FROM r.owner_person_id OR a.buyer_company_id IS NOT NULL
  OR a.seller_person_id IS DISTINCT FROM o.offeror_person_id OR a.seller_company_id IS DISTINCT FROM o.offeror_company_id
  OR o.request_version_id IS DISTINCT FROM v.id OR o.request_version IS DISTINCT FROM v.version OR o.request_version_digest IS DISTINCT FROM v.digest
  OR a.offer_version IS DISTINCT FROM o.version OR a.offer_digest IS DISTINCT FROM o.digest
  OR a.request_version IS DISTINCT FROM v.version OR a.request_digest IS DISTINCT FROM v.digest OR expected IS DISTINCT FROM a.accepted_terms_digest THEN
  RAISE EXCEPTION 'agreement unavailable' USING ERRCODE='23514',HINT='billing.source_outdated'; END IF;
 -- The original task contract has one immutable offered price and no commission field.
 RETURN o.payload->'price';
END $$;

ALTER FUNCTION trustwork.billing_consultation_confirm(uuid,uuid,text) RENAME TO billing_consultation_confirm_versioned;
REVOKE ALL ON FUNCTION trustwork.billing_consultation_confirm_versioned(uuid,uuid,text) FROM PUBLIC,trustwork_app,trustwork_worker;
CREATE FUNCTION trustwork.billing_consultation_confirm(p_hub uuid,p_booking uuid,p_side text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE b trustwork.consultation_booking%ROWTYPE; r trustwork.consultation_request%ROWTYPE; a trustwork.agreement%ROWTYPE;
BEGIN
 SELECT * INTO b FROM trustwork.consultation_booking WHERE id=p_booking FOR UPDATE;
 IF b.id IS NULL OR p_side IS NULL OR p_side NOT IN ('buyer','seller')
  OR (p_side='buyer' AND b.client_person_id IS DISTINCT FROM trustwork.current_person_id())
  OR (p_side='seller' AND NOT trustwork.commerce_party_acts(b.seller_person_id,b.seller_company_id,'company.deals.manage')) THEN
  RAISE EXCEPTION 'booking unavailable' USING ERRCODE='P0002',HINT='admin.not_found'; END IF;
 IF EXISTS(SELECT 1 FROM trustwork.billing_fee_legacy_source WHERE source_kind='consultation' AND source_id=b.id AND source_digest=b.terms_digest) THEN
  SELECT * INTO r FROM trustwork.consultation_request WHERE id=b.request_id FOR SHARE;
  IF b.status<>'proposed' OR b.valid_until<=clock_timestamp() OR r.id IS NULL OR r.requester_person_id IS DISTINCT FROM b.client_person_id
   OR b.terms#>>'{request,id}' IS DISTINCT FROM r.id::text OR b.terms#>>'{request,digest,value}' IS DISTINCT FROM r.digest THEN
   RAISE EXCEPTION 'booking unavailable' USING ERRCODE='23514',HINT='billing.source_outdated'; END IF;
  IF p_side='buyer' THEN
   IF b.agreement_id IS NOT NULL OR r.status<>'offered' THEN
    RAISE EXCEPTION 'booking unavailable' USING ERRCODE='23514',HINT='billing.source_outdated'; END IF;
  ELSE
   SELECT * INTO a FROM trustwork.agreement WHERE id=b.agreement_id AND terms_kind='consultation';
   IF a.id IS NULL OR a.status<>'accepted_by_buyer' OR a.offer_ref_id IS DISTINCT FROM b.id OR a.request_ref_id IS DISTINCT FROM r.id
    OR a.offer_digest IS DISTINCT FROM b.terms_digest OR a.request_digest IS DISTINCT FROM r.digest
    OR a.buyer_person_id IS DISTINCT FROM b.client_person_id OR a.buyer_company_id IS NOT NULL
    OR a.seller_person_id IS DISTINCT FROM b.seller_person_id OR a.seller_company_id IS DISTINCT FROM b.seller_company_id THEN
    RAISE EXCEPTION 'booking unavailable' USING ERRCODE='23514',HINT='billing.source_outdated'; END IF;
  END IF;
  -- Original immutable pricing/commission stays in the booking terms; no retroactive binding or charge.
  RETURN;
 END IF;
 PERFORM trustwork.billing_consultation_confirm_versioned(p_hub,p_booking,p_side);
END $$;
REVOKE ALL ON FUNCTION trustwork.billing_task_legacy_proceeds(uuid,text),trustwork.billing_consultation_confirm(uuid,uuid,text) FROM PUBLIC,trustwork_app,trustwork_worker;
GRANT EXECUTE ON FUNCTION trustwork.billing_task_legacy_proceeds(uuid,text),trustwork.billing_consultation_confirm(uuid,uuid,text) TO trustwork_app;
