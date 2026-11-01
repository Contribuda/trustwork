-- BILL-003: internal booking adapters supply immutable, authorized source provenance.
-- No participant or staff API can create a scope or choose either party's home hub.
-- Unimplemented booking/federation modules have no scope and remain unavailable.
CREATE TABLE trustwork.billing_fee_scope (
 id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
 source_kind text NOT NULL CHECK (source_kind IN ('consultation','task','marketplace','ticket','course')),
 source_id uuid NOT NULL,
 source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
 fee_kind text NOT NULL CHECK (fee_kind IN ('consultation','task','ticket','course')),
 category_key text NULL,
 buyer_person_id uuid NULL REFERENCES trustwork.person(id),
 buyer_company_id uuid NULL REFERENCES trustwork.company(id),
 seller_person_id uuid NULL REFERENCES trustwork.person(id),
 seller_company_id uuid NULL REFERENCES trustwork.company(id),
 buyer_hub_id uuid NOT NULL REFERENCES trustwork.hub(id),
 seller_hub_id uuid NOT NULL REFERENCES trustwork.hub(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((buyer_person_id IS NULL) <> (buyer_company_id IS NULL)),
 CHECK ((seller_person_id IS NULL) <> (seller_company_id IS NULL)),
 UNIQUE(source_kind,source_id,source_digest)
);
CREATE TABLE trustwork.billing_fee_disclosure (
 id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
 scope_id uuid NOT NULL REFERENCES trustwork.billing_fee_scope(id),
 person_id uuid NOT NULL REFERENCES trustwork.person(id),
 source_hub_id uuid NOT NULL REFERENCES trustwork.hub(id),
 side text NOT NULL CHECK (side IN ('buyer','seller')),
 buyer_fee_id uuid NOT NULL REFERENCES trustwork.marketplace_fee_version(id),
 seller_fee_id uuid NOT NULL REFERENCES trustwork.marketplace_fee_version(id),
 snapshot jsonb NOT NULL,
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE trustwork.billing_fee_confirmation (
 id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
 disclosure_id uuid NOT NULL UNIQUE REFERENCES trustwork.billing_fee_disclosure(id),
 person_id uuid NOT NULL REFERENCES trustwork.person(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE trustwork.billing_fee_binding (
 id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
 confirmation_id uuid NOT NULL UNIQUE REFERENCES trustwork.billing_fee_confirmation(id),
 booking_id uuid NOT NULL,
 source_digest text NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
 person_id uuid NOT NULL REFERENCES trustwork.person(id),
 source_hub_id uuid NOT NULL REFERENCES trustwork.hub(id),
 local_fee_id uuid NOT NULL REFERENCES trustwork.marketplace_fee_version(id),
 counterparty_fee_id uuid NOT NULL REFERENCES trustwork.marketplace_fee_version(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(booking_id,person_id)
);
CREATE TRIGGER billing_fee_scope_frozen BEFORE UPDATE OR DELETE ON trustwork.billing_fee_scope FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER billing_fee_disclosure_frozen BEFORE UPDATE OR DELETE ON trustwork.billing_fee_disclosure FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER billing_fee_confirmation_frozen BEFORE UPDATE OR DELETE ON trustwork.billing_fee_confirmation FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER billing_fee_binding_frozen BEFORE UPDATE OR DELETE ON trustwork.billing_fee_binding FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
ALTER TABLE trustwork.billing_fee_scope ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.billing_fee_scope FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.billing_fee_disclosure ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.billing_fee_disclosure FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.billing_fee_confirmation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.billing_fee_confirmation FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.billing_fee_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.billing_fee_binding FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.billing_fee_scope TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.billing_fee_disclosure TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.billing_fee_confirmation TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.billing_fee_binding TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY own_read ON trustwork.billing_fee_disclosure FOR SELECT TO trustwork_app USING (person_id=trustwork.current_person_id());
CREATE POLICY own_read ON trustwork.billing_fee_confirmation FOR SELECT TO trustwork_app USING (person_id=trustwork.current_person_id());
CREATE POLICY own_read ON trustwork.billing_fee_binding FOR SELECT TO trustwork_app USING (person_id=trustwork.current_person_id());
GRANT SELECT ON trustwork.billing_fee_disclosure,trustwork.billing_fee_confirmation,trustwork.billing_fee_binding TO trustwork_app;

CREATE FUNCTION trustwork.billing_fee_side(s trustwork.billing_fee_scope,p_hub uuid) RETURNS text
LANGUAGE plpgsql STABLE SET search_path=trustwork,pg_temp AS $$
BEGIN
 IF p_hub=s.buyer_hub_id AND trustwork.commerce_party_acts(s.buyer_person_id,s.buyer_company_id,'company.deals.manage') THEN RETURN 'buyer'; END IF;
 IF p_hub=s.seller_hub_id AND trustwork.commerce_party_acts(s.seller_person_id,s.seller_company_id,'company.deals.manage') THEN RETURN 'seller'; END IF;
 RAISE EXCEPTION 'fee scope unavailable' USING ERRCODE='P0002',HINT='admin.not_found';
END $$;
CREATE FUNCTION trustwork.billing_fee_disclose(p_hub uuid,p_scope uuid) RETURNS trustwork.billing_fee_disclosure
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE s trustwork.billing_fee_scope%ROWTYPE; d trustwork.billing_fee_disclosure%ROWTYPE;
 b trustwork.marketplace_fee_version%ROWTYPE; v trustwork.marketplace_fee_version%ROWTYPE;
 side text; snapshot jsonb; k text;
BEGIN
 SELECT * INTO s FROM trustwork.billing_fee_scope WHERE id=p_scope;
 IF NOT FOUND THEN RAISE EXCEPTION 'fee scope unavailable' USING ERRCODE='P0002',HINT='admin.not_found'; END IF;
 side:=trustwork.billing_fee_side(s,p_hub);
 IF EXISTS(SELECT 1 FROM trustwork.hub WHERE id IN(s.buyer_hub_id,s.seller_hub_id) AND lifecycle='closed') THEN
  RAISE EXCEPTION 'source hub unavailable' USING ERRCODE='23514',HINT='billing.unavailable'; END IF;
 -- One global order for both home hubs, shared by disclosures, confirmation and consumption.
 FOR k IN SELECT unnest(ARRAY[s.buyer_hub_id::text||':'||s.fee_kind||':buyer',s.seller_hub_id::text||':'||s.fee_kind||':seller']) ORDER BY 1 LOOP
   PERFORM pg_advisory_xact_lock(hashtext('trustwork.billing.fee'),hashtext(k));
 END LOOP;
 SELECT * INTO b FROM trustwork.marketplace_fee_version WHERE hub_id=s.buyer_hub_id AND kind=s.fee_kind AND payer='buyer'
 AND (category_key IS NULL OR category_key=s.category_key) AND status='active' AND effective_from<=clock_timestamp() AND (effective_to IS NULL OR effective_to>clock_timestamp());
 SELECT * INTO v FROM trustwork.marketplace_fee_version WHERE hub_id=s.seller_hub_id AND kind=s.fee_kind AND payer='seller'
 AND (category_key IS NULL OR category_key=s.category_key) AND status='active' AND effective_from<=clock_timestamp() AND (effective_to IS NULL OR effective_to>clock_timestamp());
 IF b.id IS NULL OR v.id IS NULL THEN RAISE EXCEPTION 'both published fees are required' USING ERRCODE='23514',HINT='billing.unavailable'; END IF;
 snapshot:=jsonb_build_object('scopeId',s.id,'sourceDigest',s.source_digest,'sourceHubId',p_hub,'side',side,
   'buyerFee',trustwork.billing_fee_public(b),'sellerFee',trustwork.billing_fee_public(v));
 INSERT INTO trustwork.billing_fee_disclosure(scope_id,person_id,source_hub_id,side,buyer_fee_id,seller_fee_id,snapshot,digest)
 VALUES(s.id,trustwork.current_person_id(),p_hub,side,b.id,v.id,snapshot,trustwork.admin_digest(snapshot)) RETURNING * INTO d;
 RETURN d;
END $$;
CREATE FUNCTION trustwork.billing_fee_check_disclosure(p_hub uuid,p_id uuid,p_digest text) RETURNS trustwork.billing_fee_disclosure
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE d trustwork.billing_fee_disclosure%ROWTYPE; s trustwork.billing_fee_scope%ROWTYPE; k text;
BEGIN
 SELECT * INTO d FROM trustwork.billing_fee_disclosure WHERE id=p_id AND person_id=trustwork.current_person_id() AND source_hub_id=p_hub;
 IF NOT FOUND THEN RAISE EXCEPTION 'disclosure unavailable' USING ERRCODE='P0002',HINT='admin.not_found'; END IF;
 SELECT * INTO s FROM trustwork.billing_fee_scope WHERE id=d.scope_id;
 IF EXISTS(SELECT 1 FROM trustwork.hub WHERE id IN(s.buyer_hub_id,s.seller_hub_id) AND lifecycle='closed') THEN
  RAISE EXCEPTION 'source hub unavailable' USING ERRCODE='23514',HINT='billing.unavailable'; END IF;
 IF trustwork.billing_fee_side(s,p_hub)<>d.side THEN RAISE EXCEPTION 'authority changed' USING ERRCODE='42501',HINT='admin.forbidden'; END IF;
 IF p_digest IS DISTINCT FROM d.digest OR trustwork.admin_digest(d.snapshot)<>d.digest THEN
  RAISE EXCEPTION 'disclosure digest mismatch' USING ERRCODE='42501',HINT='admin.approval_mismatch'; END IF;
 FOR k IN SELECT unnest(ARRAY[s.buyer_hub_id::text||':'||s.fee_kind||':buyer',s.seller_hub_id::text||':'||s.fee_kind||':seller']) ORDER BY 1 LOOP
   PERFORM pg_advisory_xact_lock(hashtext('trustwork.billing.fee'),hashtext(k));
 END LOOP;
 IF (SELECT count(*) FROM trustwork.marketplace_fee_version WHERE id IN(d.buyer_fee_id,d.seller_fee_id)
   AND status='active' AND effective_from<=clock_timestamp() AND (effective_to IS NULL OR effective_to>clock_timestamp()))<>2 THEN
   RAISE EXCEPTION 'shown fee version is outdated; disclose again' USING ERRCODE='23514',HINT='billing.fee_outdated'; END IF;
 RETURN d;
END $$;
CREATE FUNCTION trustwork.billing_fee_confirm(p_hub uuid,p_id uuid,p_digest text) RETURNS trustwork.billing_fee_confirmation
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE d trustwork.billing_fee_disclosure%ROWTYPE; c trustwork.billing_fee_confirmation%ROWTYPE;
BEGIN
 d:=trustwork.billing_fee_check_disclosure(p_hub,p_id,p_digest);
 INSERT INTO trustwork.billing_fee_confirmation(disclosure_id,person_id) VALUES(d.id,trustwork.current_person_id()) RETURNING * INTO c;
 INSERT INTO trustwork.audit_event(actor_person_id,action,object_kind,object_id,after_digest)
 VALUES(c.person_id,'billing.fees_confirmed','fee_confirmation',c.id::text,d.digest);
 RETURN c;
END $$;
-- Internal module command only: the booking's own transaction passes its actual id and immutable terms digest.
CREATE FUNCTION trustwork.billing_fee_bind(p_hub uuid,p_confirmation uuid,p_booking uuid,p_source_digest text) RETURNS trustwork.billing_fee_binding
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE c trustwork.billing_fee_confirmation%ROWTYPE; d trustwork.billing_fee_disclosure%ROWTYPE; b trustwork.billing_fee_binding%ROWTYPE;
BEGIN
 SELECT * INTO c FROM trustwork.billing_fee_confirmation WHERE id=p_confirmation AND person_id=trustwork.current_person_id() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'confirmation unavailable' USING ERRCODE='P0002',HINT='admin.not_found'; END IF;
 SELECT * INTO d FROM trustwork.billing_fee_disclosure WHERE id=c.disclosure_id;
 d:=trustwork.billing_fee_check_disclosure(p_hub,d.id,d.digest);
 IF p_source_digest IS DISTINCT FROM d.snapshot->>'sourceDigest' THEN
  RAISE EXCEPTION 'booking terms differ from the disclosure' USING ERRCODE='23514',HINT='billing.source_outdated'; END IF;
 INSERT INTO trustwork.billing_fee_binding(confirmation_id,booking_id,source_digest,person_id,source_hub_id,local_fee_id,counterparty_fee_id)
 VALUES(c.id,p_booking,p_source_digest,c.person_id,p_hub,CASE WHEN d.side='buyer' THEN d.buyer_fee_id ELSE d.seller_fee_id END,
 CASE WHEN d.side='buyer' THEN d.seller_fee_id ELSE d.buyer_fee_id END) RETURNING * INTO b;
 INSERT INTO trustwork.audit_event(actor_person_id,action,object_kind,object_id,after_digest)
 VALUES(c.person_id,'billing.fees_bound','fee_binding',b.id::text,d.digest);
 RETURN b;
END $$;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.billing_fee_disclose(uuid,uuid),trustwork.billing_fee_confirm(uuid,uuid,text),trustwork.billing_fee_bind(uuid,uuid,uuid,text) TO trustwork_app;
