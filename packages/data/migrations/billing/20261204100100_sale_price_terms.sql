-- BILL-003: participant sale prices for models and capabilities, and credit packs with their validity (ADR 010 decision 25,
-- ADR 012 decision 33). No price, pack or value is seeded: amounts are the operator's settings. Provider cost records stay
-- separate and never become a sale price. AGT-004 consumes these versions when it meters usage; publishing one here charges
-- nobody. No column can reach ranking, matching, recommendations or reputation.
ALTER TABLE trustwork.offer DROP CONSTRAINT offer_kind_check;
ALTER TABLE trustwork.offer ADD CONSTRAINT offer_kind_check
 CHECK (kind IN ('plan','deliverable','credit_pack','marketplace_fee','verification_fee','agent_module','model','capability'));

CREATE TABLE trustwork.price_sale_terms (
 price_version_id uuid PRIMARY KEY REFERENCES trustwork.price_version(id),
 sale_kind text NOT NULL CHECK (sale_kind IN ('model','capability','credit_pack')),
 model_id text NULL CHECK (length(model_id) BETWEEN 1 AND 200),
 capability_id text NULL CHECK (length(capability_id) <= 100 AND capability_id ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
 meter text NULL REFERENCES trustwork.meter(code),
 per_units bigint NULL CHECK (per_units > 0),
 credit_minor bigint NULL CHECK (credit_minor > 0),
 validity_days integer NULL CHECK (validity_days BETWEEN 1 AND 3650),
 expiry_notice_days integer NULL CHECK (expiry_notice_days BETWEEN 1 AND 365),
 refund_policy_version text NULL CHECK (length(refund_policy_version) BETWEEN 1 AND 40),
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT price_sale_terms_shape CHECK (CASE sale_kind
   WHEN 'model' THEN model_id IS NOT NULL AND capability_id IS NULL AND meter IS NOT NULL AND per_units IS NOT NULL
     AND credit_minor IS NULL AND validity_days IS NULL AND expiry_notice_days IS NULL AND refund_policy_version IS NULL
   WHEN 'capability' THEN capability_id IS NOT NULL AND model_id IS NULL AND meter IS NOT NULL AND per_units IS NOT NULL
     AND credit_minor IS NULL AND validity_days IS NULL AND expiry_notice_days IS NULL AND refund_policy_version IS NULL
   -- Credits never expire silently: an expiry always comes with advance notice shorter than the validity itself.
   ELSE model_id IS NULL AND capability_id IS NULL AND meter IS NULL AND per_units IS NULL AND credit_minor IS NOT NULL AND refund_policy_version IS NOT NULL
     AND (validity_days IS NULL) = (expiry_notice_days IS NULL) AND (validity_days IS NULL OR expiry_notice_days < validity_days) END)
);
CREATE TABLE trustwork.price_sale_activation (
 price_version_id uuid PRIMARY KEY REFERENCES trustwork.price_version(id),
 approval_id uuid NOT NULL UNIQUE REFERENCES trustwork.second_person_approval(id),
 activated_by uuid NOT NULL REFERENCES trustwork.person(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER price_sale_terms_frozen BEFORE UPDATE OR DELETE ON trustwork.price_sale_terms FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER price_sale_activation_frozen BEFORE UPDATE OR DELETE ON trustwork.price_sale_activation FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

CREATE FUNCTION trustwork.billing_sale_terms(p trustwork.price_version, o trustwork.offer, s trustwork.price_sale_terms) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
 SELECT jsonb_build_object('kind', o.kind, 'code', o.code, 'name', o.name, 'currency', p.currency, 'amountMinor', p.amount_minor::text,
   'effectiveFrom', to_char(p.effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'effectiveTo', to_char(p.effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'acceptanceTextVersion', p.acceptance_text_version)
 || CASE s.sale_kind
   WHEN 'model' THEN jsonb_build_object('modelId', s.model_id, 'meter', s.meter, 'perUnits', s.per_units::text)
   WHEN 'capability' THEN jsonb_build_object('capabilityId', s.capability_id, 'meter', s.meter, 'perUnits', s.per_units::text)
   ELSE jsonb_build_object('creditMinor', s.credit_minor::text, 'validityDays', s.validity_days, 'expiryNoticeDays', s.expiry_notice_days, 'refundPolicyVersion', s.refund_policy_version) END
$$;
CREATE FUNCTION trustwork.billing_sale_digest(p trustwork.price_version, o trustwork.offer, s trustwork.price_sale_terms) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
 SELECT trustwork.admin_digest(jsonb_build_object('action', 'commerce.activate_price_version', 'id', p.id, 'hubId', o.hub_id, 'version', p.version, 'terms', trustwork.billing_sale_terms(p, o, s)))
$$;
CREATE FUNCTION trustwork.billing_sale_version(p trustwork.price_version, o trustwork.offer, s trustwork.price_sale_terms) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
 SELECT jsonb_build_object('id', p.id, 'hubId', o.hub_id, 'version', p.version, 'digest', trustwork.billing_sale_digest(p, o, s), 'terms', trustwork.billing_sale_terms(p, o, s))
$$;
-- The explicit public serializer: the shape of PublicPriceSchema. No staff, approval, provider-cost or payer value.
CREATE FUNCTION trustwork.billing_sale_public(p trustwork.price_version, o trustwork.offer, s trustwork.price_sale_terms) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
 SELECT jsonb_build_object('id', p.id, 'version', p.version, 'kind', o.kind, 'code', o.code, 'currency', p.currency, 'amountMinor', p.amount_minor::text,
   'effectiveFrom', to_char(p.effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'effectiveTo', to_char(p.effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'validity', CASE WHEN s.sale_kind <> 'credit_pack' THEN NULL WHEN s.validity_days IS NULL THEN 'none' ELSE 'P' || s.validity_days || 'D' END,
   'planVersion', NULL,
   'disclosure', jsonb_build_object('offerId', o.id, 'name', o.name, 'acceptanceTextVersion', p.acceptance_text_version, 'plan', NULL, 'digest', trustwork.billing_sale_digest(p, o, s),
     'sale', CASE WHEN s.sale_kind = 'credit_pack' THEN NULL ELSE jsonb_build_object('modelId', s.model_id, 'capabilityId', s.capability_id, 'meter', s.meter, 'perUnits', s.per_units::text) END,
     'creditPack', CASE WHEN s.sale_kind <> 'credit_pack' THEN NULL ELSE jsonb_build_object('creditMinor', s.credit_minor::text, 'validityDays', s.validity_days,
       'expiryNoticeDays', s.expiry_notice_days, 'refundPolicyVersion', s.refund_policy_version) END))
$$;

-- No path activates these kinds without disclosed terms and the exact consumed approval, the owner-run catalogue included.
CREATE FUNCTION trustwork.billing_sale_price_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE o trustwork.offer%ROWTYPE; s trustwork.price_sale_terms%ROWTYPE; x trustwork.price_sale_activation%ROWTYPE; a trustwork.second_person_approval%ROWTYPE;
BEGIN
 IF NOT (OLD.status = 'draft' AND NEW.status = 'active') THEN RETURN NEW; END IF;
 SELECT * INTO o FROM trustwork.offer WHERE id = NEW.offer_id;
 IF o.kind NOT IN ('model','capability','credit_pack') THEN RETURN NEW; END IF;
 SELECT * INTO s FROM trustwork.price_sale_terms WHERE price_version_id = NEW.id AND sale_kind = o.kind;
 IF NOT FOUND THEN RAISE EXCEPTION 'sale terms are required' USING ERRCODE = '23514', HINT = 'billing.sale_terms_missing'; END IF;
 SELECT * INTO x FROM trustwork.price_sale_activation WHERE price_version_id = NEW.id;
 SELECT * INTO a FROM trustwork.second_person_approval WHERE id = x.approval_id;
 IF x.approval_id IS NULL OR a.id IS NULL OR a.status <> 'consumed' OR a.consumed_ref IS DISTINCT FROM NEW.id OR a.action <> 'commerce.activate_price_version'
   OR a.scope_kind <> 'hub' OR a.hub_id IS DISTINCT FROM o.hub_id OR a.requested_by IS DISTINCT FROM NEW.activated_by OR a.approved_by = NEW.activated_by
   OR x.activated_by IS DISTINCT FROM NEW.activated_by OR NEW.activated_by IS DISTINCT FROM trustwork.current_person_id()
   OR a.action_digest <> trustwork.billing_sale_digest(NEW, o, s) THEN
  RAISE EXCEPTION 'exact consumed price approval required' USING ERRCODE = '42501', HINT = 'admin.approval_mismatch';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER price_version_sale_guard BEFORE UPDATE ON trustwork.price_version FOR EACH ROW EXECUTE FUNCTION trustwork.billing_sale_price_guard();

CREATE FUNCTION trustwork.billing_sale_price_draft(p_ctx jsonb, p_hub uuid, p_terms jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE a trustwork.admin_actor; o trustwork.offer%ROWTYPE; p trustwork.price_version%ROWTYPE; s trustwork.price_sale_terms%ROWTYPE; k text := p_terms->>'kind'; allowed text[];
BEGIN
 PERFORM trustwork.hubs_require_hub(p_hub);
 a := trustwork.admin_authorize(p_ctx, ARRAY['admin.commerce.price.draft'], NULL, p_hub);
 allowed := ARRAY['kind','code','name','currency','amountMinor','effectiveFrom','effectiveTo','acceptanceTextVersion'] || CASE k
   WHEN 'model' THEN ARRAY['modelId','meter','perUnits'] WHEN 'capability' THEN ARRAY['capabilityId','meter','perUnits']
   WHEN 'credit_pack' THEN ARRAY['creditMinor','validityDays','expiryNoticeDays','refundPolicyVersion'] ELSE ARRAY[]::text[] END;
 -- The allowlist is the database twin of the strict contract: no key can carry a discovery or participant control.
 IF k IS NULL OR k NOT IN ('model','capability','credit_pack') OR jsonb_typeof(p_terms) <> 'object'
   OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_terms) x WHERE NOT x = ANY(allowed)) THEN
  RAISE EXCEPTION 'invalid sale terms' USING ERRCODE = '22023', HINT = 'billing.invalid_terms';
 END IF;
 IF (SELECT lifecycle FROM trustwork.hub WHERE id = p_hub) = 'closed' THEN RAISE EXCEPTION 'closed hub' USING ERRCODE = '23514', HINT = 'billing.unavailable'; END IF;
 -- A price names something the hub really serves. Provider cost rows prove the model exists; they never set this price.
 IF k = 'model' AND NOT EXISTS (SELECT 1 FROM trustwork.model_pricing m WHERE m.hub_id = p_hub AND m.model_id = p_terms->>'modelId')
   AND NOT EXISTS (SELECT 1 FROM trustwork.model_route r WHERE r.hub_id = p_hub AND r.status = 'active' AND r.primary_ref->>'modelId' = p_terms->>'modelId') THEN
  RAISE EXCEPTION 'unknown model' USING ERRCODE = '23514', HINT = 'billing.sale_subject_unknown';
 END IF;
 IF k = 'capability' AND NOT EXISTS (SELECT 1 FROM trustwork.agent_engine_manifest m, jsonb_array_elements(m.document->'capabilities') c WHERE c->>'id' = p_terms->>'capabilityId') THEN
  RAISE EXCEPTION 'unknown capability' USING ERRCODE = '23514', HINT = 'billing.sale_subject_unknown';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtext('trustwork.billing.sale'), hashtext(p_hub::text || ':' || (p_terms->>'code')));
 SELECT * INTO o FROM trustwork.offer WHERE hub_id = p_hub AND code = p_terms->>'code';
 IF NOT FOUND THEN
  INSERT INTO trustwork.offer(hub_id, code, name, kind, created_by) VALUES (p_hub, p_terms->>'code', p_terms->>'name', k, a.person_id) RETURNING * INTO o;
 -- The offer name is part of every version's digest, so a later version cannot rename what earlier ones disclosed.
 ELSIF o.kind <> k OR o.name <> p_terms->>'name' OR o.status = 'retired' THEN
  RAISE EXCEPTION 'offer differs' USING ERRCODE = '23514', HINT = 'billing.invalid_terms';
 END IF;
 INSERT INTO trustwork.price_version(offer_id, version, amount_minor, currency, effective_from, effective_to, acceptance_text_version, drafted_by)
 VALUES (o.id, coalesce((SELECT max(version) FROM trustwork.price_version WHERE offer_id = o.id),0)+1, (p_terms->>'amountMinor')::bigint, p_terms->>'currency',
   (p_terms->>'effectiveFrom')::timestamptz, (p_terms->>'effectiveTo')::timestamptz, p_terms->>'acceptanceTextVersion', a.person_id) RETURNING * INTO p;
 INSERT INTO trustwork.price_sale_terms(price_version_id, sale_kind, model_id, capability_id, meter, per_units, credit_minor, validity_days, expiry_notice_days, refund_policy_version)
 VALUES (p.id, k, p_terms->>'modelId', p_terms->>'capabilityId', p_terms->>'meter', (p_terms->>'perUnits')::bigint, (p_terms->>'creditMinor')::bigint,
   (p_terms->>'validityDays')::integer, (p_terms->>'expiryNoticeDays')::integer, p_terms->>'refundPolicyVersion') RETURNING * INTO s;
 PERFORM trustwork.admin_record(a,p_ctx,NULL,p_hub,'billing.sale_price_drafted','price_version',p.id,NULL,to_jsonb(p));
 RETURN trustwork.billing_sale_version(p, o, s);
END $$;

CREATE FUNCTION trustwork.billing_sale_price_activate(p_ctx jsonb, p_hub uuid, p_id uuid, p_digest text, p_approval uuid, p_supersede boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE a trustwork.admin_actor; o trustwork.offer%ROWTYPE; p trustwork.price_version%ROWTYPE; s trustwork.price_sale_terms%ROWTYPE; before_p jsonb;
BEGIN
 a := trustwork.admin_authorize(p_ctx, ARRAY['admin.commerce.price.activate'], NULL, p_hub);
 SELECT v.* INTO p FROM trustwork.price_version v JOIN trustwork.offer f ON f.id = v.offer_id JOIN trustwork.price_sale_terms t ON t.price_version_id = v.id WHERE v.id = p_id AND f.hub_id = p_hub;
 IF NOT FOUND THEN RAISE EXCEPTION 'price unavailable' USING ERRCODE = 'P0002', HINT = 'admin.not_found'; END IF;
 SELECT * INTO o FROM trustwork.offer WHERE id = p.offer_id FOR UPDATE;
 PERFORM pg_advisory_xact_lock(hashtext('trustwork.billing.sale'), hashtext(p_hub::text || ':' || o.code));
 SELECT * INTO p FROM trustwork.price_version WHERE id = p_id FOR UPDATE;
 SELECT * INTO s FROM trustwork.price_sale_terms WHERE price_version_id = p_id;
 IF a.person_id = p.drafted_by THEN RAISE EXCEPTION 'drafter cannot activate' USING ERRCODE = '42501', HINT = 'admin.self_approval'; END IF;
 IF p_digest IS DISTINCT FROM trustwork.billing_sale_digest(p, o, s) THEN RAISE EXCEPTION 'changed digest' USING ERRCODE = '42501', HINT = 'admin.approval_mismatch'; END IF;
 IF p.status <> 'draft' OR o.status = 'retired' OR (SELECT lifecycle FROM trustwork.hub WHERE id = p_hub) = 'closed' THEN
  RAISE EXCEPTION 'price unavailable' USING ERRCODE = '23514', HINT = 'billing.unavailable'; END IF;
 PERFORM trustwork.admin_consume_approval(p_approval,'commerce.activate_price_version','hub',NULL,p_hub,p_digest,p.id);
 INSERT INTO trustwork.price_sale_activation(price_version_id, approval_id, activated_by) VALUES (p.id, p_approval, a.person_id);
 IF p_supersede THEN
  UPDATE trustwork.price_version SET effective_to = p.effective_from WHERE offer_id = p.offer_id AND status = 'active' AND id <> p.id
    AND effective_from < p.effective_from AND (effective_to IS NULL OR effective_to > p.effective_from);
 END IF;
 before_p := to_jsonb(p);
 UPDATE trustwork.price_version SET status='active', activated_by=a.person_id WHERE id=p.id RETURNING * INTO p;
 IF o.status = 'draft' THEN UPDATE trustwork.offer SET status='active' WHERE id=o.id RETURNING * INTO o; END IF;
 PERFORM trustwork.admin_record(a,p_ctx,NULL,p_hub,'billing.sale_price_activated','price_version',p.id,before_p,to_jsonb(p),NULL,p_approval);
 RETURN trustwork.billing_sale_version(p, o, s);
END $$;

CREATE FUNCTION trustwork.billing_sale_price_list(p_hub uuid, p_kind text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
 SELECT coalesce(jsonb_agg(trustwork.billing_sale_public(p, o, s) ORDER BY o.code, p.effective_from, p.id),'[]'::jsonb)
 FROM trustwork.price_version p JOIN trustwork.offer o ON o.id = p.offer_id JOIN trustwork.price_sale_terms s ON s.price_version_id = p.id JOIN trustwork.hub h ON h.id = o.hub_id
 WHERE o.hub_id = p_hub AND o.kind = p_kind AND o.status = 'active' AND p.status = 'active' AND h.lifecycle <> 'closed'
   AND (p.effective_to IS NULL OR p.effective_to > statement_timestamp())
$$;
-- Console reads for HUBC-009: every version with its lifecycle, at the staff member's own hub.
CREATE FUNCTION trustwork.billing_sale_price_staff_list(p_ctx jsonb, p_hub uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE result jsonb;
BEGIN
 PERFORM trustwork.admin_authorize(p_ctx, ARRAY['admin.commerce.price.draft','admin.commerce.price.activate'], NULL, p_hub);
 SELECT coalesce(jsonb_agg(trustwork.billing_sale_version(p, o, s) || jsonb_build_object('status', p.status, 'draftedBy', p.drafted_by, 'activatedBy', p.activated_by,
   'activatedAt', to_char(p.activated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY o.code, p.version DESC),'[]'::jsonb) INTO result
 FROM trustwork.price_version p JOIN trustwork.offer o ON o.id = p.offer_id JOIN trustwork.price_sale_terms s ON s.price_version_id = p.id WHERE o.hub_id = p_hub;
 RETURN result;
END $$;
CREATE FUNCTION trustwork.billing_fee_staff_list(p_ctx jsonb, p_hub uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE result jsonb;
BEGIN
 PERFORM trustwork.admin_authorize(p_ctx, ARRAY['admin.billing.fees.draft','admin.billing.fees.activate'], NULL, p_hub);
 SELECT coalesce(jsonb_agg(trustwork.billing_fee_public(f) || jsonb_build_object('status', f.status, 'draftedBy', f.drafted_by, 'activatedBy', f.activated_by,
   'activatedAt', to_char(f.activated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY f.kind, f.payer, f.category_key, f.version DESC),'[]'::jsonb) INTO result
 FROM trustwork.marketplace_fee_version f WHERE f.hub_id = p_hub;
 RETURN result;
END $$;

ALTER TABLE trustwork.price_sale_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.price_sale_terms FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.price_sale_activation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.price_sale_activation FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.price_sale_terms TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.price_sale_activation TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.billing_sale_price_draft(jsonb,uuid,jsonb), trustwork.billing_sale_price_activate(jsonb,uuid,uuid,text,uuid,boolean),
 trustwork.billing_sale_price_list(uuid,text), trustwork.billing_sale_price_staff_list(jsonb,uuid), trustwork.billing_fee_staff_list(jsonb,uuid) TO trustwork_app;
