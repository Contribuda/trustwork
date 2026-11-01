-- BILL-003: fee-only governance. No prices are seeded or activated.
-- Terms are immutable even while drafted. A correction is a new version, never a silent edit.
-- Preserve existing keys and accept the existing work taxonomy's dotted identifiers.
-- This format does not establish a commercial category or authorize a source-to-fee mapping.
ALTER TABLE trustwork.marketplace_fee_version DROP CONSTRAINT marketplace_fee_version_category_key_check;
ALTER TABLE trustwork.marketplace_fee_version ADD CONSTRAINT marketplace_fee_version_category_key_check
 CHECK (category_key IS NULL OR (char_length(category_key) BETWEEN 2 AND 61 AND category_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'));

CREATE FUNCTION trustwork.billing_fee_terms(p trustwork.marketplace_fee_version) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
 SELECT jsonb_build_object('kind', p.kind, 'categoryKey', p.category_key, 'currency', p.currency,
   'basisPoints', p.basis_points, 'fixedMinor', p.fixed_minor::text, 'payer', p.payer,
   'effectiveFrom', to_char(p.effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'effectiveTo', to_char(p.effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'acceptanceTextVersion', p.acceptance_text_version)
$$;
CREATE FUNCTION trustwork.billing_fee_digest(p trustwork.marketplace_fee_version) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
 SELECT trustwork.admin_digest(jsonb_build_object('action', 'billing.activate_fee_version', 'id', p.id,
   'hubId', p.hub_id, 'version', p.version, 'terms', trustwork.billing_fee_terms(p)))
$$;
CREATE FUNCTION trustwork.billing_fee_public(p trustwork.marketplace_fee_version) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
 SELECT jsonb_build_object('id', p.id, 'hubId', p.hub_id, 'version', p.version,
   'digest', trustwork.billing_fee_digest(p), 'terms', trustwork.billing_fee_terms(p))
$$;
CREATE FUNCTION trustwork.billing_fee_authority_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE a trustwork.second_person_approval%ROWTYPE;
BEGIN
 IF NEW.effective_from <> date_trunc('milliseconds',NEW.effective_from)
   OR NEW.effective_to <> date_trunc('milliseconds',NEW.effective_to) THEN
   RAISE EXCEPTION 'fee timestamps require millisecond precision' USING ERRCODE='22023',HINT='billing.invalid_terms';
 END IF;
 IF TG_OP = 'UPDATE' THEN
   IF (to_jsonb(NEW) - ARRAY['status','activated_by','activated_at','approval_id','revision','updated_at'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','activated_by','activated_at','approval_id','revision','updated_at']) THEN
     RAISE EXCEPTION 'fee terms are immutable' USING ERRCODE = '23514', HINT = 'billing.version_frozen';
   END IF;
   IF OLD.status = 'active' AND NEW.status <> OLD.status THEN
     RAISE EXCEPTION 'active fee validity is immutable' USING ERRCODE = '23514', HINT = 'billing.version_frozen';
   END IF;
   IF NEW.status = 'active' AND OLD.status = 'draft' THEN
     SELECT * INTO a FROM trustwork.second_person_approval WHERE id = NEW.approval_id;
     IF NOT FOUND OR a.status <> 'consumed' OR a.consumed_ref IS DISTINCT FROM NEW.id
       OR a.requested_by IS DISTINCT FROM NEW.activated_by OR a.approved_by = NEW.activated_by
       OR a.scope_kind <> 'hub' OR a.hub_id IS DISTINCT FROM NEW.hub_id
       OR a.action <> 'billing.activate_fee_version' OR a.action_digest <> trustwork.billing_fee_digest(NEW)
       OR NEW.activated_by IS DISTINCT FROM trustwork.current_person_id() THEN
       RAISE EXCEPTION 'exact consumed fee approval required' USING ERRCODE = '42501', HINT = 'admin.approval_mismatch';
     END IF;
   END IF;
 END IF;
 IF NEW.status = 'active' THEN
   -- Generic and category-specific rates must not both apply to one participant.
   PERFORM pg_advisory_xact_lock(hashtext('trustwork.billing.fee'), hashtext(NEW.hub_id::text || ':' || NEW.kind || ':' || NEW.payer));
   IF EXISTS (SELECT 1 FROM trustwork.marketplace_fee_version f WHERE f.id <> NEW.id AND f.hub_id = NEW.hub_id
     AND f.kind = NEW.kind AND f.payer = NEW.payer AND f.status = 'active'
     AND (f.category_key IS NULL OR NEW.category_key IS NULL OR f.category_key = NEW.category_key)
     AND tstzrange(f.effective_from, f.effective_to, '[)') && tstzrange(NEW.effective_from, NEW.effective_to, '[)')) THEN
     RAISE EXCEPTION 'fee intervals overlap' USING ERRCODE = '23P01', HINT = 'billing.version_overlap';
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER marketplace_fee_version_authority BEFORE INSERT OR UPDATE ON trustwork.marketplace_fee_version
 FOR EACH ROW EXECUTE FUNCTION trustwork.billing_fee_authority_guard();

CREATE FUNCTION trustwork.billing_fee_draft(p_ctx jsonb, p_hub uuid, p_terms jsonb) RETURNS jsonb
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
 PERFORM trustwork.admin_record(a,p_ctx,NULL,p_hub,'billing.fee_drafted','marketplace_fee_version',f.id,NULL,to_jsonb(f));
 RETURN trustwork.billing_fee_public(f);
END $$;
CREATE FUNCTION trustwork.billing_fee_activate(p_ctx jsonb, p_hub uuid, p_id uuid, p_digest text, p_approval uuid) RETURNS jsonb
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
 old_f := to_jsonb(f);
 UPDATE trustwork.marketplace_fee_version SET status='active', activated_by=a.person_id, approval_id=p_approval WHERE id=f.id RETURNING * INTO f;
 PERFORM trustwork.admin_record(a,p_ctx,NULL,p_hub,'billing.fee_activated','marketplace_fee_version',f.id,old_f,to_jsonb(f),NULL,p_approval);
 RETURN trustwork.billing_fee_public(f);
END $$;
CREATE FUNCTION trustwork.billing_fee_list(p_hub uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
 SELECT coalesce(jsonb_agg(trustwork.billing_fee_public(f) ORDER BY f.kind,f.payer,f.category_key,f.effective_from,f.id),'[]'::jsonb)
 FROM trustwork.marketplace_fee_version f JOIN trustwork.hub h ON h.id=f.hub_id
 WHERE f.hub_id=p_hub AND f.status='active' AND (f.effective_to IS NULL OR f.effective_to > statement_timestamp()) AND h.lifecycle <> 'closed'
$$;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.billing_fee_draft(jsonb,uuid,jsonb), trustwork.billing_fee_activate(jsonb,uuid,uuid,text,uuid), trustwork.billing_fee_list(uuid) TO trustwork_app;

-- Anonymous and participant readers must use the explicit public serializer, never raw staff metadata.
DROP POLICY marketplace_fee_version_read ON trustwork.marketplace_fee_version;

CREATE FUNCTION trustwork.billing_fee_hub_available(p_hub uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
 SELECT EXISTS(SELECT 1 FROM trustwork.hub WHERE id=p_hub AND lifecycle<>'closed')
$$;
REVOKE ALL ON FUNCTION trustwork.billing_fee_hub_available(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.billing_fee_hub_available(uuid) TO trustwork_app;
