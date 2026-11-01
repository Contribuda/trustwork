-- SUP owns this explicit nonparticipant case shape. No person, address lookup or account is manufactured.
CREATE TABLE trustwork.support_external_source_subject (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  source_field_id uuid NOT NULL REFERENCES trustwork.sourced_record_field(id), source_digest text NOT NULL,
  action text NOT NULL CHECK(action IN ('correction','erasure','objection')),
  proposed_value_digest text NOT NULL CHECK(proposed_value_digest ~ '^[a-f0-9]{64}$'),
  country text NOT NULL CHECK(country ~ '^[A-Z]{2}$'),
  method text NOT NULL CHECK(method IN ('signed_statement','record_control','verified_representative')),
  evidence_digest text NOT NULL CHECK(evidence_digest ~ '^[a-f0-9]{64}$'),
  attested_by uuid NOT NULL REFERENCES trustwork.person(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE trustwork.support_external_source_subject ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.support_external_source_subject FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance ON trustwork.support_external_source_subject TO trustwork_owner
  USING(trustwork.maintenance_on()) WITH CHECK(trustwork.maintenance_on());
CREATE TRIGGER support_external_source_immutable BEFORE UPDATE OR DELETE ON trustwork.support_external_source_subject
  FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
ALTER TABLE trustwork.support_case ALTER COLUMN requester_person_id DROP NOT NULL;
ALTER TABLE trustwork.support_case ADD COLUMN external_source_subject_id uuid UNIQUE REFERENCES trustwork.support_external_source_subject(id);
ALTER TABLE trustwork.support_case DROP CONSTRAINT support_case_subject_xor;
ALTER TABLE trustwork.support_case ADD CONSTRAINT support_case_subject_xor CHECK (
  (external_source_subject_id IS NULL AND requester_person_id IS NOT NULL AND ((subject_person_id IS NULL) <> (subject_company_id IS NULL)))
  OR (external_source_subject_id IS NOT NULL AND requester_person_id IS NULL AND subject_person_id IS NULL AND subject_company_id IS NULL AND category='privacy')
);
-- Retain the existing lifecycle/identity guard; close its nullable-requester comparison explicitly.
CREATE FUNCTION trustwork.support_external_case_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$ BEGIN
  IF NEW.external_source_subject_id IS DISTINCT FROM OLD.external_source_subject_id OR NEW.requester_person_id IS DISTINCT FROM OLD.requester_person_id THEN
    RAISE EXCEPTION 'support case identity is immutable' USING ERRCODE='23000', HINT='admin.immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER support_external_case_identity BEFORE UPDATE ON trustwork.support_case
  FOR EACH ROW EXECUTE FUNCTION trustwork.support_external_case_guard();

-- Existing request/approve/revoke/expiry authorizers remain authoritative. External cases can grant only their exact field.
CREATE FUNCTION trustwork.support_external_grant_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=trustwork,pg_temp AS $$
DECLARE v_field uuid;
BEGIN
  SELECT e.source_field_id INTO v_field FROM trustwork.support_case c JOIN trustwork.support_external_source_subject e ON e.id=c.external_source_subject_id
    WHERE c.id=NEW.support_case_id;
  IF FOUND AND (NEW.object_type IS DISTINCT FROM 'sourced_record_field' OR NEW.object_ids IS DISTINCT FROM ARRAY[v_field]) THEN
    RAISE EXCEPTION 'external case is bound to one verified field' USING ERRCODE='42501', HINT='privacy.case_grant_required';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER support_external_grant_scope BEFORE INSERT ON trustwork.case_access_grant
  FOR EACH ROW EXECUTE FUNCTION trustwork.support_external_grant_guard();

CREATE FUNCTION trustwork.support_open_external_source_case(p_ctx jsonb, p_hub uuid, p_field uuid, p_action text, p_value text,
  p_country text, p_method text, p_evidence_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=trustwork,pg_temp SET trustwork.maintenance='on' AS $$
DECLARE v_actor trustwork.admin_actor; v_source uuid; v_field trustwork.sourced_record_field%ROWTYPE;
  v_subject uuid; v_case uuid; v_note uuid;
BEGIN
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.support.case.create'], NULL, p_hub);
  PERFORM trustwork.admin_authorize(p_ctx, ARRAY['admin.privacy.request.read'], NULL, p_hub);
  -- No browse/lookup port: the caller must name a single known record. No source value is returned.
  SELECT source_id INTO v_source FROM trustwork.sourced_record_field WHERE id=p_field AND hub_id=p_hub;
  PERFORM 1 FROM trustwork.source WHERE id=v_source FOR SHARE;
  SELECT * INTO v_field FROM trustwork.sourced_record_field WHERE id=p_field AND hub_id=p_hub FOR SHARE;
  IF NOT FOUND OR NOT v_field.active OR v_field.source_id IS DISTINCT FROM v_source THEN
    RAISE EXCEPTION 'record unavailable' USING ERRCODE='42501', HINT='privacy.not_found';
  END IF;
  IF (p_action='correction') IS DISTINCT FROM (p_value IS NOT NULL) OR (p_value IS NOT NULL AND length(p_value) NOT BETWEEN 1 AND 2000) THEN
    RAISE EXCEPTION 'exact request required' USING ERRCODE='22023', HINT='privacy.proof_required';
  END IF;
  INSERT INTO trustwork.support_external_source_subject(source_field_id,source_digest,action,proposed_value_digest,country,method,evidence_digest,attested_by)
    VALUES(p_field,trustwork.privacy_source_digest(p_field),p_action,trustwork.admin_digest(coalesce(to_jsonb(p_value),'null'::jsonb)),p_country,p_method,p_evidence_digest,v_actor.person_id)
    RETURNING id INTO v_subject;
  INSERT INTO trustwork.support_case(hub_id,requester_person_id,opened_by,category,summary,external_source_subject_id)
    VALUES(p_hub,NULL,v_actor.person_id,'privacy','Verified external source request',v_subject) RETURNING id INTO v_case;
  INSERT INTO trustwork.support_case_note(support_case_id,author_person_id,body,visibility)
    VALUES(v_case,v_actor.person_id,'Verified request evidence digest: '||p_evidence_digest,'internal') RETURNING id INTO v_note;
  PERFORM trustwork.admin_record(v_actor,p_ctx,NULL,p_hub,'support.external_source_case_opened','support_case',v_case,NULL,
    jsonb_build_object('sourceFieldId',p_field,'action',p_action,'evidenceRef',v_note),v_case);
  RETURN jsonb_build_object('caseId',v_case,'evidenceRef',v_note,'subjectId',v_subject);
END $$;

-- This additional predicate never substitutes for admin_grant_usable or the existing staff/evidence checks.
CREATE FUNCTION trustwork.support_external_source_matches(p_case uuid,p_field uuid,p_action text,p_value text,p_method text,p_actor uuid,p_evidence uuid,p_check_value boolean) RETURNS boolean
LANGUAGE sql STABLE SET search_path=trustwork,pg_temp AS $$
  SELECT CASE WHEN c.external_source_subject_id IS NULL THEN true ELSE EXISTS(
    SELECT 1 FROM trustwork.support_external_source_subject e JOIN trustwork.support_case_note n ON n.support_case_id=c.id
    WHERE e.id=c.external_source_subject_id AND e.source_field_id=p_field AND e.action=p_action AND e.method=p_method
      AND e.attested_by=p_actor AND n.id=p_evidence AND n.author_person_id=p_actor AND n.visibility='internal'
      AND n.body='Verified request evidence digest: '||e.evidence_digest
      AND e.source_digest=trustwork.privacy_source_digest(p_field)
      AND (NOT p_check_value OR e.proposed_value_digest=trustwork.admin_digest(coalesce(to_jsonb(p_value),'null'::jsonb)))) END
  FROM trustwork.support_case c WHERE c.id=p_case
$$;
REVOKE EXECUTE ON FUNCTION trustwork.support_external_case_guard(),trustwork.support_external_grant_guard(),
  trustwork.support_open_external_source_case(jsonb,uuid,uuid,text,text,text,text,text),
  trustwork.support_external_source_matches(uuid,uuid,text,text,text,uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.support_open_external_source_case(jsonb,uuid,uuid,text,text,text,text,text) TO trustwork_app;
