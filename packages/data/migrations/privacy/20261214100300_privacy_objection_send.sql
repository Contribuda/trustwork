-- PRV-001. privacy_objection suppressed only the addresses verified at that moment, and no send path read
-- direct_marketing_objection, so an address verified later received non-transactional mail. An objection belongs to the
-- person, not to the addresses they had that day. The final dispatch port now answers for the person who holds the
-- address, whichever address it is. The worker calls this port on non-transactional mail only.
--
-- This migration changes nothing on an identity table, and must not: sign-in, verification and address changes write
-- email_binding under the runtime role, and an index on an expression makes every such write need EXECUTE on the
-- expression's function. An objection never touches those paths.

-- A send holds the contact lock and then the person lock through transport and commit, and an objection takes them in
-- the same order. So a touch in transport finishes before the objection is acknowledged, and an objection that holds
-- the person lock is committed before the send reads the preference. The address need not be one the objection saw.
CREATE OR REPLACE FUNCTION trustwork.privacy_marketing_allowed(p_digest text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE v_person uuid;
BEGIN
  IF p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
  PERFORM trustwork.privacy_contact_lock(p_digest);
  IF EXISTS(SELECT 1 FROM trustwork.privacy_suppression WHERE digest = p_digest AND marketing) THEN RETURN false; END IF;
  -- The port receives MAIL's hash, never an address. The caller has already claimed its delivery, so the claimed row
  -- gives the address, and the unique index gives its one holder. An address without a holder has only the check above.
  SELECT b.person_id INTO v_person FROM trustwork.email_binding b
   WHERE b.email_normalized IN (SELECT lower(normalize(btrim(d.recipient), NFC)) FROM trustwork.mail_delivery d
     WHERE d.recipient_hash = p_digest AND d.claimed_at IS NOT NULL AND d.recipient IS NOT NULL);
  IF v_person IS NULL THEN RETURN true; END IF;
  PERFORM trustwork.privacy_contact_lock('person:' || v_person::text);
  RETURN NOT EXISTS(SELECT 1 FROM trustwork.privacy_preference p WHERE p.person_id = v_person AND p.direct_marketing_objection);
END $$;

CREATE OR REPLACE FUNCTION trustwork.privacy_objection(p_person uuid) RETURNS void
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE v_email text;
BEGIN
  INSERT INTO trustwork.privacy_preference(person_id, direct_marketing_objection) VALUES(p_person, true)
    ON CONFLICT(person_id) DO UPDATE SET direct_marketing_objection = true, revision = privacy_preference.revision + 1, updated_at = now();
  FOR v_email IN SELECT email_normalized FROM trustwork.email_binding WHERE person_id = p_person AND verified_at IS NOT NULL ORDER BY email_normalized LOOP
    -- Retain the original journal key; add MAIL's namespaced key without rewriting retained decisions.
    INSERT INTO trustwork.privacy_suppression(digest, person_id)
      VALUES(encode(sha256(convert_to(v_email, 'UTF8')), 'hex'), p_person) ON CONFLICT(digest) DO UPDATE SET marketing = true;
    PERFORM trustwork.privacy_marketing_object(trustwork.comms_mail_hash(v_email));
  END LOOP;
  -- After the contact locks, as in the send path: it waits for a touch in transport to an address not listed above.
  PERFORM trustwork.privacy_contact_lock('person:' || p_person::text);
END $$;
