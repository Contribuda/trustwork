-- BILL-003: a fixed fee may be any bigint, but audit digests refuse integers above 2^53-1, so a large fee could not be
-- drafted although the contract allows it. The amount now enters the audit image as text. Nothing else changes: the
-- bodies below are those of 20261111100000_fee_authority.sql, and the fee digest already used text.
CREATE FUNCTION trustwork.billing_fee_audit(p trustwork.marketplace_fee_version) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
 SELECT to_jsonb(p) || jsonb_build_object('fixed_minor', p.fixed_minor::text)
$$;
CREATE OR REPLACE FUNCTION trustwork.billing_fee_draft(p_ctx jsonb, p_hub uuid, p_terms jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE a trustwork.admin_actor; f trustwork.marketplace_fee_version%ROWTYPE;
BEGIN
 PERFORM trustwork.hubs_require_hub(p_hub);
 a := trustwork.admin_authorize(p_ctx, ARRAY['admin.billing.fees.draft'], NULL, p_hub);
 IF jsonb_typeof(p_terms) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_terms) k WHERE k NOT IN
  ('kind','categoryKey','currency','basisPoints','fixedMinor','payer','effectiveFrom','effectiveTo','acceptanceTextVersion')) THEN
  RAISE EXCEPTION 'invalid fee terms' USING ERRCODE = '22023', HINT = 'billing.invalid_terms';
 END IF;
 IF (SELECT lifecycle FROM trustwork.hub WHERE id = p_hub) = 'closed' THEN
  RAISE EXCEPTION 'closed hub' USING ERRCODE = '23514', HINT = 'billing.unavailable';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtext('trustwork.billing.fee'), hashtext(p_hub::text || ':' || (p_terms->>'kind') || ':' || (p_terms->>'payer')));
 INSERT INTO trustwork.marketplace_fee_version (hub_id, kind, category_key, version, currency, basis_points, fixed_minor, payer,
   effective_from, effective_to, acceptance_text_version, drafted_by)
 VALUES (p_hub, p_terms->>'kind', p_terms->>'categoryKey',
   coalesce((SELECT max(version) FROM trustwork.marketplace_fee_version WHERE hub_id = p_hub AND kind = p_terms->>'kind'
     AND category_key IS NOT DISTINCT FROM (p_terms->>'categoryKey') AND payer = p_terms->>'payer'),0)+1,
   p_terms->>'currency', (p_terms->>'basisPoints')::integer, (p_terms->>'fixedMinor')::bigint, p_terms->>'payer',
   (p_terms->>'effectiveFrom')::timestamptz, (p_terms->>'effectiveTo')::timestamptz, p_terms->>'acceptanceTextVersion', a.person_id)
 RETURNING * INTO f;
 PERFORM trustwork.admin_record(a,p_ctx,NULL,p_hub,'billing.fee_drafted','marketplace_fee_version',f.id,NULL,trustwork.billing_fee_audit(f));
 RETURN trustwork.billing_fee_public(f);
END $$;
CREATE OR REPLACE FUNCTION trustwork.billing_fee_activate(p_ctx jsonb, p_hub uuid, p_id uuid, p_digest text, p_approval uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE a trustwork.admin_actor; f trustwork.marketplace_fee_version%ROWTYPE; old_f jsonb;
BEGIN
 a := trustwork.admin_authorize(p_ctx, ARRAY['admin.billing.fees.activate'], NULL, p_hub);
 SELECT * INTO f FROM trustwork.marketplace_fee_version WHERE id = p_id AND hub_id = p_hub;
 IF NOT FOUND THEN RAISE EXCEPTION 'fee unavailable' USING ERRCODE = 'P0002', HINT = 'admin.not_found'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('trustwork.billing.fee'), hashtext(f.hub_id::text || ':' || f.kind || ':' || f.payer));
 SELECT * INTO f FROM trustwork.marketplace_fee_version WHERE id = p_id FOR UPDATE;
 IF a.person_id = f.drafted_by THEN RAISE EXCEPTION 'drafter cannot activate' USING ERRCODE = '42501', HINT = 'admin.self_approval'; END IF;
 IF p_digest IS DISTINCT FROM trustwork.billing_fee_digest(f) THEN RAISE EXCEPTION 'changed digest' USING ERRCODE = '42501', HINT = 'admin.approval_mismatch'; END IF;
 IF f.status <> 'draft' OR (SELECT lifecycle FROM trustwork.hub WHERE id = p_hub) = 'closed' THEN
   RAISE EXCEPTION 'fee unavailable' USING ERRCODE = '23514', HINT = 'billing.unavailable'; END IF;
 PERFORM trustwork.admin_consume_approval(p_approval,'billing.activate_fee_version','hub',NULL,p_hub,p_digest,f.id);
 old_f := trustwork.billing_fee_audit(f);
 UPDATE trustwork.marketplace_fee_version SET status='active', activated_by=a.person_id, approval_id=p_approval WHERE id=f.id RETURNING * INTO f;
 PERFORM trustwork.admin_record(a,p_ctx,NULL,p_hub,'billing.fee_activated','marketplace_fee_version',f.id,old_f,trustwork.billing_fee_audit(f),NULL,p_approval);
 RETURN trustwork.billing_fee_public(f);
END $$;
REVOKE EXECUTE ON FUNCTION trustwork.billing_fee_audit(trustwork.marketplace_fee_version) FROM PUBLIC;
