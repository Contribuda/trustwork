-- PAY-001: a safe candidate set needs authoritative absence, including racing inserts.
-- Internal consumers only. Public wrappers must first authorize the exact original parties.
CREATE FUNCTION trustwork.payments_candidate_lock() RETURNS void
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
BEGIN
 PERFORM trustwork.screening_list_authority_lock();
 LOCK TABLE trustwork.provider_connection,trustwork.payment_rail,trustwork.hub_config_current,trustwork.kill_switch IN SHARE MODE;
END $$;
CREATE FUNCTION trustwork.payments_collecting_candidates(p_hub uuid,p_country text,p_payee_country text,p_currency text) RETURNS jsonb
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE cfg trustwork.hub_config_version%ROWTYPE; c trustwork.provider_connection%ROWTYPE; rail_row trustwork.payment_rail%ROWTYPE;
 configured jsonb; choices jsonb:='[]'; proof jsonb:='[]'; rail text;
BEGIN
 PERFORM trustwork.payments_candidate_lock();
 SELECT v.* INTO cfg FROM trustwork.hub_config_current h JOIN trustwork.hub_config_version v ON v.id=h.version_id
  WHERE h.hub_id=p_hub AND h.domain='payments' FOR SHARE OF h NOWAIT;
 IF NOT FOUND OR cfg.payload->>'fundsHeldBy' IS DISTINCT FROM 'licensed_payment_provider'
  OR cfg.payload->'operatorAccountInFundsFlow' IS DISTINCT FROM 'false'::jsonb OR cfg.payload->'demoNoMoneyMoves' IS DISTINCT FROM 'true'::jsonb THEN
  RAISE EXCEPTION 'explicit collecting configuration unavailable' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM trustwork.kill_switch WHERE state='engaged' AND scope_kind='node') THEN
  RAISE EXCEPTION 'payment candidate authority stopped' USING ERRCODE='42501'; END IF;
 FOR configured IN SELECT x FROM jsonb_array_elements(cfg.payload->'providers') x ORDER BY x->>'connectionId' LOOP
  SELECT * INTO c FROM trustwork.provider_connection WHERE id=(configured->>'connectionId')::uuid FOR SHARE NOWAIT;
  IF NOT FOUND OR c.hub_id<>p_hub OR c.mode<>'fake' OR trustwork.kernel_place_restricted(c.processing_country)
   OR c.storage_country IS NOT NULL AND trustwork.kernel_place_restricted(c.storage_country) THEN
   RAISE EXCEPTION 'configured provider authority unavailable' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM trustwork.kill_switch WHERE state='engaged' AND connection_id=c.id) THEN
   RAISE EXCEPTION 'configured provider stopped' USING ERRCODE='42501'; END IF;
  SELECT * INTO rail_row FROM trustwork.payment_rail WHERE connection_id=c.id FOR SHARE NOWAIT;
  proof:=proof||jsonb_build_array(jsonb_build_object('id',c.id,'revision',c.revision,'status',c.status,'configDigest',trustwork.providers_config_digest(c.id),
    'rail',CASE WHEN rail_row.connection_id IS NULL THEN NULL ELSE jsonb_build_object('currencies',rail_row.currencies,'countries',rail_row.countries,
      'rails',rail_row.rails,'capabilities',rail_row.capabilities,'revokedAt',rail_row.revoked_at,'evidenceMode',rail_row.evidence_mode,'custody',rail_row.custody) END));
  IF c.status='enabled' AND 'payments'=ANY(c.capabilities) AND configured->'capabilities' ? 'payments'
    AND rail_row.revoked_at IS NULL AND rail_row.evidence_mode='synthetic' AND rail_row.custody='provider_connected_accounts'
    AND p_country=ANY(rail_row.countries) AND p_payee_country=ANY(rail_row.countries) AND p_currency=ANY(rail_row.currencies) AND 'create'=ANY(rail_row.capabilities) THEN
   FOREACH rail IN ARRAY rail_row.rails LOOP
    IF rail<>'provider_escrow' OR cfg.payload->>'escrowAndRetainage'='provider_managed' THEN
     choices:=choices||jsonb_build_array(jsonb_build_object('connectionId',c.id,'rail',rail,'capabilities',rail_row.capabilities));
    END IF;
   END LOOP;
  END IF;
 END LOOP;
 RETURN jsonb_build_object('configurationId',cfg.id,'configurationDigest',cfg.payload_digest,'candidates',choices,
  'authorityDigest',trustwork.admin_digest(jsonb_build_object('configurationId',cfg.id,'configurationDigest',cfg.payload_digest,'providers',proof)));
END $$;
CREATE FUNCTION trustwork.payments_local_context(p_session uuid,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE a trustwork.agreement%ROWTYPE; co trustwork.commercial_order%ROWTYPE; q trustwork.quote_version%ROWTYPE; rfq trustwork.rfq_version%ROWTYPE;
 payer jsonb; payee jsonb; br trustwork.payment_binding_review%ROWTYPE; reviews jsonb:='{}'; binding_id uuid; candidates jsonb;
 payer_lists jsonb; payee_lists jsonb; expiry timestamptz; actor uuid:=trustwork.current_person_id();
BEGIN
 PERFORM trustwork.payments_candidate_lock();
 PERFORM pg_advisory_xact_lock(hashtext('payments.agreement'),hashtext(p_input->>'agreementId'));
 PERFORM trustwork.payments_source_person(actor,p_session,trustwork.current_authz_epoch());
 SELECT * INTO a FROM trustwork.agreement WHERE id=(p_input->>'agreementId')::uuid FOR SHARE NOWAIT;
 IF NOT FOUND OR actor NOT IN(a.buyer_person_id,a.seller_person_id) OR a.buyer_person_id IS NULL OR a.seller_person_id IS NULL
  OR a.buyer_company_id IS NOT NULL OR a.seller_company_id IS NOT NULL OR a.status<>'accepted_by_both' OR a.terms_kind<>'rfq_quote' THEN
  RAISE EXCEPTION 'original individual agreement parties required' USING ERRCODE='42501'; END IF;
 SELECT * INTO co FROM trustwork.commercial_order WHERE agreement_id=a.id AND status IN ('accepted','changed','fulfilled') FOR SHARE NOWAIT;
 SELECT * INTO q FROM trustwork.quote_version WHERE id=a.quote_version_id;
 SELECT * INTO rfq FROM trustwork.rfq_version WHERE id=a.rfq_version_id;
 IF co.id IS NULL OR co.accepted_terms_digest IS DISTINCT FROM a.accepted_terms_digest OR q.digest IS DISTINCT FROM a.offer_digest
  OR q.version IS DISTINCT FROM a.offer_version OR rfq.digest IS DISTINCT FROM a.request_digest OR rfq.version IS DISTINCT FROM a.request_version
  OR q.payload->'totals'->'gross'->>'minorUnits' IS DISTINCT FROM co.amount_minor::text OR q.payload->'totals'->'gross'->>'currency' IS DISTINCT FROM co.currency THEN
  RAISE EXCEPTION 'immutable agreement provenance unavailable' USING ERRCODE='42501'; END IF;
 payer:=trustwork.payments_source_identity((p_input->>'payerBindingId')::uuid);
 payee:=trustwork.payments_source_identity((p_input->>'payeeBindingId')::uuid);
 IF payer->>'personId' IS DISTINCT FROM a.buyer_person_id::text OR payee->>'personId' IS DISTINCT FROM a.seller_person_id::text THEN
  RAISE EXCEPTION 'exact responsible participants required' USING ERRCODE='42501'; END IF;
 expiry:=least((payer->>'expiresAt')::timestamptz,(payee->>'expiresAt')::timestamptz);
 FOREACH binding_id IN ARRAY ARRAY[(p_input->>'payerBindingId')::uuid,(p_input->>'payeeBindingId')::uuid] LOOP
  SELECT * INTO br FROM trustwork.payment_binding_review WHERE participant_binding_id=binding_id FOR SHARE NOWAIT;
  IF NOT FOUND OR br.revoked_at IS NOT NULL OR br.expires_at<=clock_timestamp()
   OR br.proposer_id IN(a.buyer_person_id,a.seller_person_id) OR br.reviewer_id IN(a.buyer_person_id,a.seller_person_id) THEN
   RAISE EXCEPTION 'independent responsible participant review unavailable' USING ERRCODE='42501'; END IF;
  expiry:=least(expiry,br.expires_at);
  reviews:=reviews||jsonb_build_object(binding_id::text,jsonb_build_object('id',br.id,'digest',br.digest));
 END LOOP;
 PERFORM trustwork.payments_hub_restrictions((payer->>'hubId')::uuid,ARRAY[payer->>'place',payee->>'place',rfq.payload->'deliveryTerms'->'location'->>'region']);
 PERFORM trustwork.payments_hub_restrictions((payee->>'hubId')::uuid,ARRAY[payer->>'place',payee->>'place',rfq.payload->'deliveryTerms'->'location'->>'region']);
 payer_lists:=trustwork.payments_screen_hub_current((payer->>'hubId')::uuid,ARRAY[a.buyer_person_id,a.seller_person_id]);
 payee_lists:=trustwork.payments_screen_hub_current((payee->>'hubId')::uuid,ARRAY[a.buyer_person_id,a.seller_person_id]);
 candidates:=trustwork.payments_collecting_candidates((payee->>'hubId')::uuid,payer->>'country',payee->>'country',co.currency);
 -- Subject locks can wait. Recheck exact original identity/session/proof time after all domain waits.
 PERFORM trustwork.payments_source_person(actor,p_session,trustwork.current_authz_epoch());
 PERFORM trustwork.payments_source_identity((p_input->>'payerBindingId')::uuid);
 PERFORM trustwork.payments_source_identity((p_input->>'payeeBindingId')::uuid);
 PERFORM trustwork.payments_screen_hub_current((payer->>'hubId')::uuid,ARRAY[a.buyer_person_id,a.seller_person_id]);
 PERFORM trustwork.payments_screen_hub_current((payee->>'hubId')::uuid,ARRAY[a.buyer_person_id,a.seller_person_id]);
 IF expiry<=clock_timestamp() THEN RAISE EXCEPTION 'responsible review expired after wait' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('agreementId',a.id,'agreementDigest',a.accepted_terms_digest,'orderId',co.id,'reservationId',co.reservation_id,
  'offerVersion',a.offer_version,'offerDigest',a.offer_digest,'requestVersion',a.request_version,'requestDigest',a.request_digest,
  'payerId',a.buyer_person_id,'payeeId',a.seller_person_id,'payerBindingId',p_input->>'payerBindingId','payeeBindingId',p_input->>'payeeBindingId',
  'payer',payer,'payee',payee,'reviews',reviews,'deliveryPlace',rfq.payload->'deliveryTerms'->'location'->>'region','amountMinor',co.amount_minor::text,'currency',co.currency,
  'collectingHubId',payee->>'hubId','payerScreening',payer_lists,'payeeScreening',payee_lists,'eligibility',candidates,'factsExpireAt',expiry);
END $$;
CREATE FUNCTION trustwork.payments_settlement_options(p_session uuid,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE c jsonb;
BEGIN
 c:=trustwork.payments_local_context(p_session,p_input);
 RETURN jsonb_build_object('agreementId',c->>'agreementId','collectingHubId',c->>'collectingHubId','payerHubId',c->'payer'->>'hubId','payeeHubId',c->'payee'->>'hubId',
  'amountMinor',c->>'amountMinor','currency',c->>'currency','candidates',c->'eligibility'->'candidates','authorityDigest',c->'eligibility'->>'authorityDigest');
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'payment options authority changing' USING ERRCODE='42501',HINT='access.forbidden';
END $$;
REVOKE ALL ON FUNCTION trustwork.payments_candidate_lock(),trustwork.payments_collecting_candidates(uuid,text,text,text),trustwork.payments_local_context(uuid,jsonb),trustwork.payments_settlement_options(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.payments_settlement_options(uuid,jsonb) TO trustwork_app;
