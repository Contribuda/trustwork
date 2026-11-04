-- HUBC-007 audit fix: the second person approved without seeing the change. A second_person_approval holds an action, a
-- scope, a digest and the requester's free-text reason, and the card showed exactly those. Nothing tied what the card
-- said to what the digest binds, so a reason could say "weekend moderator" while the digest bound hub-owner for a friend.
--
-- admin_approval_change answers, for one approval, the structured change its digest binds. It never reads the reason.
-- A change is only reported when the digest proves it, from one of two sources:
--   * the object itself: the versions, documents, connections and other rows an action activates are looked up by
--     recomputing, with the same digest function the executing command uses, the digest of each candidate and comparing
--     it with the approval's. A request opened through POST /v1/admin/approvals with a digest from another module's read
--     is covered the same way;
--   * the digest input, for what no row holds yet (a role for a person, a sanction, a kill switch release, a transition
--     whose revision has since moved). second_person_approval_subject keeps it, and refuses, for every writer, an input
--     that does not hash to the approval's digest.
--
-- The rules of the card, each held here and not only in the console:
--   * every field the digest binds is on the card: the fields are generated from the digest input itself (`show`), never
--     from a hand list. Only `action`, `object` and `hubId`, which the card shows as its title and scope, are left out, and
--     the hash of a new recovery address, which appears masked. Where the digest binds a digest of a stored document, the
--     document's terms are expanded: a configuration version shows every changed value down to the leaf.
--   * nothing is cut silently: a value or a list too long to show, or a value that cannot be read as what its key says,
--     leaves `complete: false` on that card only, and no stored value can fail the reading of the list;
--   * private detail has readers: a change is shown only to someone holding the read permission of its domain
--     (admin_change_read_permissions); anyone else who may read the approval gets its action, scope and digest, and the
--     API drops the reason for them too, on the approval and on its audit rows. An action nothing maps is read by nobody.
--     A price is read by the kind of change: a metered price as the staff list of prices, elevation included, because its
--     cost is there; a plan by the plan permission;
--   * what is not shown cannot be approved: a trigger on second_person_approval refuses the approval of a change that is
--     unproven (admin.change_unbound), incomplete (admin.change_incomplete) or hidden from the approver
--     (admin.change_hidden). Screening's own actions and the platform erasure plan, each reviewed through its own command,
--     are outside the card.
--
-- The answer: { bound, visible, complete, current, currentDigest, fields: [{ field, before, after }], apply }. A field is
-- the path of a value in the digest input, in dots. `current` is false when the object moved on, so executing would fail;
-- `currentDigest` is the digest of the action as it stands now, null when there is none. `apply` tells the console how to
-- finish an approved change that has no version to activate. Values are { kind: none | text | key | person | duration };
-- a person carries the identifier, because a display name is chosen at sign-up and is not unique, and for staff and
-- support changes the masked primary verified address, as the support workspace shows it;
-- a key names a locale entry under `admin.`. What reads billing tables lives in the billing module
-- (20261221100100_approval_change_billing.sql), which alone reads them.

CREATE TABLE trustwork.second_person_approval_subject (
  approval_id uuid PRIMARY KEY REFERENCES trustwork.second_person_approval (id),
  subject jsonb NOT NULL CHECK (jsonb_typeof(subject) = 'object' AND octet_length(subject::text) <= 16384),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION trustwork.admin_approval_subject_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF trustwork.admin_digest(NEW.subject) IS DISTINCT FROM (SELECT a.action_digest FROM trustwork.second_person_approval a WHERE a.id = NEW.approval_id) THEN
    RAISE EXCEPTION 'the digest input does not hash to the approval''s digest' USING ERRCODE = 'check_violation', HINT = 'admin.approval_mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER second_person_approval_subject_guard BEFORE INSERT ON trustwork.second_person_approval_subject FOR EACH ROW EXECUTE FUNCTION trustwork.admin_approval_subject_guard();
CREATE TRIGGER second_person_approval_subject_immutable BEFORE UPDATE OR DELETE ON trustwork.second_person_approval_subject FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

ALTER TABLE trustwork.second_person_approval_subject ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.second_person_approval_subject FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.second_person_approval_subject AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
GRANT SELECT ON trustwork.second_person_approval_subject TO trustwork_app;

-- The requester records what the digest of their own open request was computed from.
CREATE FUNCTION trustwork.admin_bind_approval_subject(p_approval uuid, p_subject jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.admin_require_caller();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM trustwork.second_person_approval a WHERE a.id = p_approval AND a.requested_by = v_person AND a.status = 'pending') THEN
    RAISE EXCEPTION 'no open request of the caller' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  INSERT INTO trustwork.second_person_approval_subject (approval_id, subject) VALUES (p_approval, p_subject);
END $$;

-- Values and rows of a change ---------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.admin_change_none() RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT '{"kind":"none"}'::jsonb $$;

CREATE FUNCTION trustwork.admin_change_text(p_value text) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT CASE WHEN p_value IS NULL OR p_value = '' THEN trustwork.admin_change_none() ELSE jsonb_build_object('kind', 'text', 'value', p_value) END
$$;

CREATE FUNCTION trustwork.admin_change_key(p_key text) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT jsonb_build_object('kind', 'key', 'key', p_key) $$;

CREATE FUNCTION trustwork.admin_change_person(p_person uuid, p_address boolean DEFAULT false) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT coalesce((SELECT jsonb_build_object('kind', 'person', 'personId', p.id, 'displayName', nullif(btrim(p.display_name), ''),
      'maskedEmail', CASE WHEN p_address THEN (SELECT trustwork.support_mask_email(b.email_normalized) FROM trustwork.email_binding b WHERE b.person_id = p.id AND b.is_primary AND b.verified_at IS NOT NULL) END)
    FROM trustwork.person p WHERE p.id = p_person), trustwork.admin_change_text(p_person::text))
$$;

-- A value that cannot be read as what its key says. It never reaches a reader: admin_change_answer turns it into a note
-- and the card is incomplete.
CREATE FUNCTION trustwork.admin_change_unreadable() RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT '{"kind":"unreadable"}'::jsonb $$;

-- What the contract of the card can carry; anything else would drop the card or the list in the reader's hands.
CREATE FUNCTION trustwork.admin_change_value_sound(p_value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_value ->> 'kind'
    WHEN 'none' THEN true WHEN 'text' THEN true WHEN 'person' THEN true WHEN 'duration' THEN true
    WHEN 'key' THEN p_value ->> 'key' ~ '^[a-z][a-zA-Z0-9_-]*(\.[a-z][a-zA-Z0-9_-]*)*$'
    ELSE false END
$$;

CREATE FUNCTION trustwork.admin_change_row(p_field text, p_after jsonb, p_before jsonb DEFAULT '{"kind":"none"}'::jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT jsonb_build_object('field', p_field, 'before', p_before, 'after', p_after) $$;

-- Every leaf of a JSON value with its path. A list of plain values is one leaf; a list of objects is walked by index.
-- A dot inside a key is not a step: {"a.b": 1} and {"a": {"b": 1}} are different values, so such a key keeps its own
-- path, which the card cannot name, and leaves the card incomplete rather than hiding a difference.
CREATE FUNCTION trustwork.admin_change_leaves(p_value jsonb, p_path text DEFAULT NULL) RETURNS TABLE (path text, value jsonb)
LANGUAGE plpgsql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_key text;
  v_item jsonb;
  v_index integer := 0;
BEGIN
  IF jsonb_typeof(p_value) = 'object' AND p_value <> '{}'::jsonb THEN
    FOR v_key, v_item IN SELECT e.key, e.value FROM jsonb_each(p_value) e ORDER BY e.key COLLATE "C" LOOP
      RETURN QUERY SELECT * FROM trustwork.admin_change_leaves(v_item, coalesce(p_path || '.', '') || replace(v_key, '.', '%2E'));
    END LOOP;
  ELSIF jsonb_typeof(p_value) = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_value) e WHERE jsonb_typeof(e) IN ('object', 'array')) THEN
    FOR v_item IN SELECT e FROM jsonb_array_elements(p_value) e LOOP
      RETURN QUERY SELECT * FROM trustwork.admin_change_leaves(v_item, coalesce(p_path || '.', '') || v_index::text);
      v_index := v_index + 1;
    END LOOP;
  ELSE
    path := p_path;
    value := p_value;
    RETURN NEXT;
  END IF;
END $$;

-- How a leaf reads on the card; anything without a better form is its stored text.
CREATE FUNCTION trustwork.admin_change_value(p_action text, p_path text, p_value jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_leaf text := regexp_replace(coalesce(p_path, ''), '^.*\.', '');
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' THEN
    RETURN CASE WHEN v_leaf = 'validForSeconds' THEN trustwork.admin_change_key('approvals.noEndDate') ELSE trustwork.admin_change_none() END;
  END IF;
  IF jsonb_typeof(p_value) = 'boolean' THEN
    RETURN trustwork.admin_change_key(CASE WHEN p_value = 'true'::jsonb THEN 'approvals.values.yes' ELSE 'approvals.values.no' END);
  END IF;
  IF v_leaf IN ('personId', 'subjectPersonId') THEN
    IF jsonb_typeof(p_value) <> 'string' OR (p_value #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN trustwork.admin_change_unreadable(); END IF;
    RETURN trustwork.admin_change_person((p_value #>> '{}')::uuid, p_action LIKE 'staff.%' OR p_action LIKE 'support.%');
  END IF;
  IF v_leaf = 'role' AND (p_value #>> '{}') ~ '^[a-z][a-zA-Z0-9_-]*$' THEN RETURN trustwork.admin_change_key('roles.' || (p_value #>> '{}')); END IF;
  IF p_path = 'scope.kind' AND p_action LIKE 'staff.%' THEN RETURN trustwork.admin_change_key('approvals.scopes.' || (p_value #>> '{}')); END IF;
  IF p_path = 'kind' AND p_action = 'legal.activate_document_version' THEN RETURN trustwork.admin_change_key('hub.legal.kinds.' || (p_value #>> '{}')); END IF;
  IF v_leaf LIKE '%Seconds' AND jsonb_typeof(p_value) = 'number' THEN
    IF (p_value #>> '{}') !~ '^[0-9]{1,15}$' THEN RETURN trustwork.admin_change_unreadable(); END IF;
    RETURN jsonb_build_object('kind', 'duration', 'seconds', (p_value #>> '{}')::bigint);
  END IF;
  IF jsonb_typeof(p_value) = 'array' THEN
    RETURN trustwork.admin_change_text((SELECT string_agg(e #>> '{}', ', ') FROM jsonb_array_elements(p_value) e));
  END IF;
  IF jsonb_typeof(p_value) = 'object' THEN RETURN trustwork.admin_change_none(); END IF;
  RETURN trustwork.admin_change_text(p_value #>> '{}');
END $$;

-- The rows of everything a value holds.
CREATE FUNCTION trustwork.admin_change_rows(p_action text, p_value jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT coalesce(jsonb_agg(trustwork.admin_change_row(l.path, trustwork.admin_change_value(p_action, l.path, l.value))), '[]'::jsonb) FROM trustwork.admin_change_leaves(p_value) l
$$;

-- The rows of every leaf that differs between two values: a change deep in a long payload shows as that change.
CREATE FUNCTION trustwork.admin_change_diff(p_action text, p_before jsonb, p_after jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT coalesce(jsonb_agg(trustwork.admin_change_row(coalesce(a.path, b.path), trustwork.admin_change_value(p_action, a.path, a.value), trustwork.admin_change_value(p_action, b.path, b.value)) ORDER BY coalesce(a.path, b.path) COLLATE "C"), '[]'::jsonb)
    FROM trustwork.admin_change_leaves(coalesce(p_after, '{}'::jsonb)) a FULL JOIN trustwork.admin_change_leaves(coalesce(p_before, '{}'::jsonb)) b ON a.path = b.path
   WHERE a.value IS DISTINCT FROM b.value AND coalesce(a.path, b.path) IS NOT NULL
$$;

-- What a resolver finds: `proof` the digest input, `show` what the card generates its fields from (the digest input,
-- expanded where it binds a digest of a stored document), `extra` rows that go first.
CREATE FUNCTION trustwork.admin_change_found(p_proof jsonb, p_show jsonb, p_current boolean, p_current_digest text, p_extra jsonb DEFAULT '[]'::jsonb, p_apply jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_build_object('proof', p_proof, 'show', p_show, 'current', p_current, 'currentDigest', p_current_digest, 'extra', p_extra, 'apply', p_apply)
$$;

-- What each second-person action binds ------------------------------------------------------------------------------
-- A role for a person: the digest input of a direct request, or the invitation or activation that asked for the approval.
CREATE FUNCTION trustwork.admin_change_assignment(a trustwork.second_person_approval, s jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_person uuid;
  v_role text;
  v_definition integer;
  v_seconds bigint;
  v_current boolean;
  v_input jsonb;
BEGIN
  IF s IS NOT NULL THEN
    RETURN trustwork.admin_change_found(s, s, true, a.action_digest);
  END IF;
  SELECT i.person_id, i.role, i.definition_version, i.valid_for_seconds, i.status = 'accepted' AND i.expires_at > now()
    INTO v_person, v_role, v_definition, v_seconds, v_current FROM trustwork.staff_invitation i WHERE i.approval_id = a.id;
  IF v_person IS NULL THEN
    SELECT x.person_id, x.role, e.definition_version, x.window_seconds, x.status = 'pending'
      INTO v_person, v_role, v_definition, v_seconds, v_current
      FROM trustwork.staff_activation x JOIN trustwork.staff_eligible_role e ON e.id = x.eligible_role_id WHERE x.approval_id = a.id;
  END IF;
  IF v_person IS NULL THEN RETURN NULL; END IF;
  v_input := jsonb_build_object('action', a.action, 'personId', v_person::text, 'role', v_role, 'scope', trustwork.admin_scope_json(a.scope_kind, a.node_id, a.hub_id),
    'definitionVersion', v_definition, 'breakglass', false, 'incidentId', NULL, 'validForSeconds', v_seconds);
  IF trustwork.admin_digest(v_input) IS DISTINCT FROM a.action_digest THEN RETURN NULL; END IF;
  RETURN trustwork.admin_change_found(v_input, v_input, v_current, a.action_digest);
END $$;

CREATE FUNCTION trustwork.admin_change_sanction(a trustwork.second_person_approval, s jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_subject jsonb;
  v_current boolean;
BEGIN
  IF s IS NULL THEN RETURN NULL; END IF;
  v_subject := CASE s #>> '{subject,kind}'
    WHEN 'person' THEN trustwork.admin_change_person((s #>> '{subject,id}')::uuid)
    ELSE trustwork.admin_change_text((SELECT c.display_name FROM trustwork.company c WHERE c.id = (s #>> '{subject,id}')::uuid)) END;
  v_current := EXISTS (SELECT 1 FROM trustwork.moderation_case m WHERE m.id = (s ->> 'moderationCaseId')::uuid AND m.status <> 'closed');
  RETURN trustwork.admin_change_found(s, s, v_current, a.action_digest, jsonb_build_array(trustwork.admin_change_row('sanctionSubject', v_subject)));
END $$;

-- A transition: the lifecycle it leaves and enters, and whether the hub is still where the approval found it.
CREATE FUNCTION trustwork.admin_change_transition(a trustwork.second_person_approval, s jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_hub trustwork.hub%ROWTYPE;
  v_to text := CASE a.action WHEN 'hub.transition_public' THEN 'public' ELSE 'soft_launch' END;
  v_now text;
  v_input jsonb := s;
BEGIN
  SELECT * INTO v_hub FROM trustwork.hub WHERE id = a.hub_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_now := trustwork.hubs_transition_digest(v_hub.id, v_hub.lifecycle, v_to, v_hub.revision);
  IF v_input IS NULL AND v_now = a.action_digest THEN
    v_input := jsonb_build_object('action', a.action, 'object', 'hub', 'hubId', v_hub.id::text, 'from', v_hub.lifecycle, 'to', v_to, 'revision', v_hub.revision);
  END IF;
  IF v_input IS NULL THEN RETURN NULL; END IF;
  RETURN trustwork.admin_change_found(v_input, v_input - 'from' - 'to', v_now = a.action_digest, v_now,
    jsonb_build_array(trustwork.admin_change_row('lifecycle', trustwork.admin_change_key('lifecycle.' || v_to), trustwork.admin_change_key('lifecycle.' || (v_input ->> 'from')))),
    jsonb_build_object('kind', 'lifecycle', 'to', v_to, 'revision', (v_input ->> 'revision')::integer));
END $$;

-- A configuration version: the digest binds the payload's digest, so the card shows the payload, as every leaf that
-- differs from the active version of the domain.
CREATE FUNCTION trustwork.admin_change_config(a trustwork.second_person_approval) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v trustwork.hub_config_version%ROWTYPE;
  v_old trustwork.hub_config_version%ROWTYPE;
  v_input jsonb;
BEGIN
  SELECT c.* INTO v FROM trustwork.hub_config_version c WHERE c.hub_id = a.hub_id AND trustwork.hubs_domain_action(c.domain) = a.action
    AND trustwork.hubs_config_digest(c.id, c.hub_id, c.domain, c.version, c.payload_digest) = a.action_digest;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT o.* INTO v_old FROM trustwork.hub_config_current k JOIN trustwork.hub_config_version o ON o.id = k.version_id WHERE k.hub_id = v.hub_id AND k.domain = v.domain;
  v_input := jsonb_build_object('action', a.action, 'object', 'hub_config_version', 'hubId', v.hub_id::text, 'domain', v.domain, 'versionId', v.id::text, 'version', v.version, 'payloadDigest', v.payload_digest);
  RETURN trustwork.admin_change_found(v_input, v_input, v.status = 'draft', a.action_digest,
    jsonb_build_array(trustwork.admin_change_row('configVersion', trustwork.admin_change_text(v.version::text), trustwork.admin_change_text(v_old.version::text)))
      || trustwork.admin_change_diff(a.action, v_old.payload, v.payload));
END $$;

CREATE FUNCTION trustwork.admin_change_legal(a trustwork.second_person_approval) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  d trustwork.legal_document_version%ROWTYPE;
  c trustwork.counsel_approval%ROWTYPE;
  v_old integer;
  v_input jsonb;
BEGIN
  SELECT y.* INTO c FROM trustwork.legal_document_version x JOIN trustwork.counsel_approval y ON y.hub_id = x.hub_id AND x.id = ANY (y.document_version_ids)
   WHERE x.hub_id = a.hub_id AND trustwork.hubs_legal_digest(x.id, x.hub_id, x.kind, x.locale, x.version, x.body_digest, y.id) = a.action_digest;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT x.* INTO d FROM trustwork.legal_document_version x
   WHERE x.id = ANY (c.document_version_ids) AND trustwork.hubs_legal_digest(x.id, x.hub_id, x.kind, x.locale, x.version, x.body_digest, c.id) = a.action_digest;
  SELECT o.version INTO v_old FROM trustwork.legal_document_version o WHERE o.hub_id = d.hub_id AND o.kind = d.kind AND o.locale = d.locale AND o.status = 'active';
  v_input := jsonb_build_object('action', a.action, 'object', 'legal_document_version', 'hubId', d.hub_id::text, 'documentVersionId', d.id::text, 'kind', d.kind, 'locale', d.locale,
    'version', d.version, 'bodyDigest', d.body_digest, 'counselApprovalId', c.id::text);
  RETURN trustwork.admin_change_found(v_input, v_input, d.status = 'draft', a.action_digest, jsonb_build_array(
    trustwork.admin_change_row('activeVersion', trustwork.admin_change_text(d.version::text), trustwork.admin_change_text(v_old::text)),
    trustwork.admin_change_row('counsel', trustwork.admin_change_text(c.counsel_name || ', ' || c.firm || ', ' || c.approved_on::text))));
END $$;

-- providers.enable_non_fake: a stored credential, a provider connection, a verification provider or a register adapter.
-- The last two hash a text of id, revision and credential, so the row itself is what the card shows.
CREATE FUNCTION trustwork.admin_change_provider(a trustwork.second_person_approval) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  c trustwork.provider_credential_ref%ROWTYPE;
  n trustwork.provider_connection%ROWTYPE;
  v_input jsonb;
  v_row jsonb;
BEGIN
  SELECT x.* INTO c FROM trustwork.provider_credential_ref x
   WHERE x.hub_id = a.hub_id AND trustwork.hubs_credential_digest(x.id, x.hub_id, x.provider, x.adapter, x.mode, x.secret_store, x.secret_ref) = a.action_digest;
  IF FOUND THEN
    v_input := jsonb_build_object('action', a.action, 'object', 'provider_credential_ref', 'hubId', c.hub_id::text, 'credentialId', c.id::text, 'provider', c.provider, 'adapter', c.adapter,
      'mode', c.mode, 'secretStore', c.secret_store, 'secretRef', c.secret_ref);
    RETURN trustwork.admin_change_found(v_input, v_input, c.status = 'registered', a.action_digest);
  END IF;
  SELECT x.* INTO n FROM trustwork.provider_connection x WHERE x.hub_id = a.hub_id AND trustwork.providers_connection_digest(x.id) = a.action_digest;
  IF FOUND THEN
    v_input := jsonb_build_object('action', a.action, 'object', 'provider_connection', 'hubId', n.hub_id::text, 'connectionId', n.id::text, 'adapterId', n.adapter_id, 'mode', n.mode, 'endpoint', n.endpoint,
      'hosting', trustwork.providers_hosting_json(n.hosting_kind, n.processing_country, n.zero_retention, n.trains_on_inputs, n.broker), 'storageCountry', n.storage_country,
      'secretFingerprint', (SELECT r.keyed_fingerprint FROM trustwork.secret_ref r WHERE r.connection_id = n.id AND r.status = 'active'),
      'credentialRefId', n.credential_ref_id::text, 'testId', n.last_test_id::text, 'revision', n.revision);
    RETURN trustwork.admin_change_found(v_input, v_input, true, a.action_digest);
  END IF;
  SELECT to_jsonb(p) - 'created_at' - 'updated_at' - 'created_by' - 'approval_id' - 'hub_id' || jsonb_build_object('credentialRefId', x.id::text, 'provider', x.provider) INTO v_row
    FROM trustwork.verification_provider p JOIN trustwork.provider_credential_ref x ON x.hub_id = p.hub_id
   WHERE p.hub_id = a.hub_id AND trustwork.verification_provider_digest(p.id, p.revision, x.id) = a.action_digest;
  IF v_row IS NOT NULL THEN RETURN trustwork.admin_change_found(NULL, v_row - 'credential_ref_id', true, a.action_digest); END IF;
  SELECT to_jsonb(p) - 'created_at' - 'updated_at' - 'created_by' - 'approval_id' - 'hub_id' - 'last_run_at' || jsonb_build_object('credentialRefId', x.id::text, 'provider', x.provider) INTO v_row
    FROM trustwork.register_adapter p JOIN trustwork.provider_credential_ref x ON x.hub_id = p.hub_id
   WHERE p.hub_id = a.hub_id AND trustwork.registers_adapter_digest(p.id, p.revision, x.id) = a.action_digest;
  IF v_row IS NOT NULL THEN RETURN trustwork.admin_change_found(NULL, v_row - 'credential_ref_id', true, a.action_digest); END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION trustwork.admin_change_route(a trustwork.second_person_approval) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  r trustwork.model_route%ROWTYPE;
  v_input jsonb;
BEGIN
  SELECT m.* INTO r FROM trustwork.model_route m WHERE m.hub_id = a.hub_id AND trustwork.providers_route_digest(m.id) = a.action_digest;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_input := jsonb_build_object('action', a.action, 'object', 'model_route', 'hubId', r.hub_id::text, 'routeId', r.id::text, 'job', r.job,
    'scope', trustwork.providers_scope_json(r.scope_kind, r.module_key, r.extension_id), 'version', r.version, 'primary', r.primary_ref, 'fallbacks', r.fallbacks,
    'allowedDataClasses', to_jsonb(ARRAY(SELECT c FROM unnest(r.allowed_data_classes) c ORDER BY c COLLATE "C")),
    'limits', jsonb_build_object('maxInputTokens', r.max_input_tokens, 'maxOutputTokens', r.max_output_tokens, 'maxFileBytes', r.max_file_bytes, 'timeoutMs', r.timeout_ms),
    'budgetId', r.budget_id::text);
  RETURN trustwork.admin_change_found(v_input, v_input, r.status = 'draft', a.action_digest);
END $$;

-- An egress rule is the next version of its connection and class, or a later rule has overtaken it. Without a recorded
-- digest input the few allowed combinations of the hub's connections are tried.
CREATE FUNCTION trustwork.admin_change_egress(a trustwork.second_person_approval, s jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_input jsonb := s;
  v_next integer;
BEGIN
  IF v_input IS NULL THEN
    SELECT jsonb_build_object('action', 'egress.allow_private_class', 'object', 'egress_rule', 'hubId', a.hub_id::text, 'connectionId', c.id::text, 'dataClass', k.class, 'decision', 'allow',
        'requireInResidency', r.flag, 'requireZeroRetention', z.flag, 'version', v.version) INTO v_input
      FROM trustwork.provider_connection c CROSS JOIN unnest(trustwork.providers_data_classes()) k(class) CROSS JOIN (VALUES (true), (false)) r(flag) CROSS JOIN (VALUES (true), (false)) z(flag)
      CROSS JOIN LATERAL (SELECT coalesce(max(e.version), 0) + 1 AS version FROM trustwork.egress_rule e WHERE e.connection_id = c.id AND e.data_class = k.class) v
     WHERE c.hub_id = a.hub_id AND trustwork.providers_egress_digest(a.hub_id, c.id, k.class, r.flag, z.flag, v.version) = a.action_digest;
    IF v_input IS NULL THEN RETURN NULL; END IF;
  END IF;
  SELECT coalesce(max(e.version), 0) + 1 INTO v_next FROM trustwork.egress_rule e WHERE e.connection_id = (v_input ->> 'connectionId')::uuid AND e.data_class = v_input ->> 'dataClass';
  RETURN trustwork.admin_change_found(v_input, v_input, v_next = (v_input ->> 'version')::integer, a.action_digest,
    jsonb_build_array(trustwork.admin_change_row('adapterId', trustwork.admin_change_text((SELECT c.adapter_id FROM trustwork.provider_connection c WHERE c.id = (v_input ->> 'connectionId')::uuid)))));
END $$;

CREATE FUNCTION trustwork.admin_change_peering(a trustwork.second_person_approval, s jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF s IS NULL THEN RETURN NULL; END IF;
  RETURN trustwork.admin_change_found(s, s, NOT EXISTS (SELECT 1 FROM trustwork.peering_record r WHERE r.local_hub_id = a.hub_id AND r.peer_node = s ->> 'peerNode' AND r.peer_hub_id = s ->> 'peerHubId'
    AND r.level = s ->> 'level' AND r.state = 'active'), a.action_digest);
END $$;

-- A dataset's digest hashes its id and revision: the row at that revision is what it binds.
CREATE FUNCTION trustwork.admin_change_dataset(a trustwork.second_person_approval) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  d trustwork.dataset%ROWTYPE;
BEGIN
  SELECT x.* INTO d FROM trustwork.dataset x WHERE x.hub_id = a.hub_id AND trustwork.datasets_activation_digest(x.id, x.revision) = a.action_digest;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN trustwork.admin_change_found(NULL, to_jsonb(d) - 'hub_id' - 'status' - 'proposed_by' - 'activated_by' - 'activated_at' - 'approval_id' - 'created_at' - 'updated_at', d.status = 'proposed', a.action_digest);
END $$;

-- Payment sources: the review material hashes the participant binding and, for an account, its evidence.
CREATE FUNCTION trustwork.admin_change_payment_source(a trustwork.second_person_approval) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  g trustwork.payment_source_registration%ROWTYPE;
  r record;
  v_input jsonb;
BEGIN
  IF a.action = 'payments.register_source_adapter' THEN
    SELECT x.* INTO g FROM trustwork.payment_source_registration x WHERE x.hub_id = a.hub_id AND x.digest = a.action_digest;
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_input := jsonb_build_object('kind', 'payment_source_registration', 'id', g.id, 'payload', g.payload);
    RETURN trustwork.admin_change_found(v_input, v_input - 'kind', g.revoked_at IS NULL AND g.expires_at > now(), a.action_digest);
  END IF;
  SELECT p.id, p.person_id, p.hub_id, i.digest AS identity_digest, i.assertion ->> 'residenceCountry' AS country, b.id AS account_id, e.digest AS account_digest INTO r
    FROM trustwork.payment_participant_binding_version p JOIN trustwork.payment_identity_link_version i ON i.id = p.identity_link_id
    LEFT JOIN trustwork.payment_account_binding_version b ON b.participant_binding_id = p.id
    LEFT JOIN trustwork.payment_account_evidence e ON e.id = b.account_evidence_id
   WHERE p.hub_id = a.hub_id AND trustwork.admin_digest(jsonb_build_object('kind', a.action, 'participantBindingId', p.id, 'identityDigest', i.digest, 'accountBindingId', b.id,
     'accountDigest', e.digest, 'hubId', p.hub_id::text)) = a.action_digest;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_input := jsonb_build_object('kind', a.action, 'participantBindingId', r.id, 'identityDigest', r.identity_digest, 'accountBindingId', r.account_id, 'accountDigest', r.account_digest, 'hubId', r.hub_id::text);
  RETURN trustwork.admin_change_found(v_input, (v_input - 'kind') || jsonb_build_object('personId', r.person_id::text, 'country', r.country), true, a.action_digest);
END $$;

-- A sponsored policy is the next version of the hub's policy, or another version has taken its place. Without a recorded
-- digest input the few allowed settings of the next version are tried.
CREATE FUNCTION trustwork.admin_change_sponsored(a trustwork.second_person_approval, s jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_input jsonb := s;
  v_next integer := (SELECT coalesce(max(p.version), 0) + 1 FROM trustwork.sponsored_content_policy p WHERE p.hub_id = a.hub_id);
BEGIN
  IF v_input IS NULL THEN
    SELECT jsonb_build_object('action', 'sponsored.enable', 'object', 'sponsored_content_policy', 'hubId', a.hub_id::text, 'version', v_next, 'allowed', true, 'maxSlotsPerPage', m.slots, 'requireVerifiedSponsor', v.flag) INTO v_input
      FROM generate_series(0, 3) m(slots) CROSS JOIN (VALUES (true), (false)) v(flag)
     WHERE trustwork.sources_sponsored_digest(a.hub_id, v_next, true, m.slots, v.flag) = a.action_digest;
    IF v_input IS NULL THEN RETURN NULL; END IF;
  END IF;
  RETURN trustwork.admin_change_found(v_input, v_input, v_next = (v_input ->> 'version')::integer, a.action_digest);
END $$;

CREATE FUNCTION trustwork.admin_change_kill_switch(a trustwork.second_person_approval, s jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_id uuid;
  v_kind text;
  v_state text;
BEGIN
  IF s IS NULL THEN RETURN NULL; END IF;
  v_id := (s ->> 'killSwitchId')::uuid;
  SELECT k.scope_kind, k.state INTO v_kind, v_state FROM trustwork.kill_switch k WHERE k.id = v_id;
  IF NOT FOUND THEN
    SELECT 'model_route', k.state INTO v_kind, v_state FROM trustwork.provider_route_kill_switch k WHERE k.id = v_id;
  END IF;
  RETURN trustwork.admin_change_found(s, s, v_state = 'engaged', a.action_digest, jsonb_build_array(trustwork.admin_change_row('killSwitch', trustwork.admin_change_text(v_kind))));
END $$;

-- The digest hashes the new address; the card shows it masked, as the support workspace does.
CREATE FUNCTION trustwork.admin_change_support(a trustwork.second_person_approval) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  x trustwork.account_service_action%ROWTYPE;
  v_input jsonb;
BEGIN
  SELECT r.* INTO x FROM trustwork.account_service_action r WHERE r.approval_id = a.id AND r.request_digest = a.action_digest;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_input := jsonb_build_object('action', 'support.' || x.action, 'serviceActionId', x.id::text, 'supportCaseId', x.support_case_id::text, 'subjectPersonId', x.subject_person_id::text,
    'evidenceRefs', coalesce((SELECT jsonb_agg(e ORDER BY e COLLATE "C") FROM (SELECT y::text AS e FROM unnest(x.evidence_refs) y) q), '[]'::jsonb),
    'newEmailSha256', CASE WHEN x.new_email_normalized IS NULL THEN NULL ELSE encode(sha256(convert_to(x.new_email_normalized, 'UTF8')), 'hex') END);
  RETURN trustwork.admin_change_found(v_input, v_input - 'newEmailSha256', x.state = 'pending', a.action_digest,
    jsonb_build_array(trustwork.admin_change_row('newAddress', trustwork.admin_change_text(trustwork.support_mask_email(x.new_email_normalized)))));
END $$;

-- What proves an approval's change, or NULL. Sensitive configuration domains share their action with an object of their
-- own, so the version is tried first; a recorded digest input proves itself for an action with no resolver of its own.
CREATE FUNCTION trustwork.admin_change_resolve(a trustwork.second_person_approval) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  s jsonb;
  v_found jsonb;
BEGIN
  SELECT x.subject INTO s FROM trustwork.second_person_approval_subject x WHERE x.approval_id = a.id;
  v_found := CASE
    WHEN a.action IN ('staff.assign_sensitive_role', 'staff.grant_breakglass') THEN trustwork.admin_change_assignment(a, s)
    WHEN a.action = 'moderation.apply_sanction_l4' THEN trustwork.admin_change_sanction(a, s)
    WHEN a.action IN ('hub.transition_soft_launch', 'hub.transition_public') THEN trustwork.admin_change_transition(a, s)
    WHEN a.action = 'models.activate_private_route' THEN trustwork.admin_change_route(a)
    WHEN a.action IN ('datasets.activate_court_or_debt', 'pipelines.activate_personal_data_dataset') THEN trustwork.admin_change_dataset(a)
    WHEN a.action = 'billing.activate_fee_version' THEN trustwork.billing_change_fee(a)
    WHEN a.action = 'commerce.activate_price_version' THEN trustwork.billing_change_price(a)
    WHEN a.action = 'growth.activate_referral_terms' THEN trustwork.billing_change_referral(a)
    WHEN a.action LIKE 'payments.%' AND a.action <> 'payments.change_settings' THEN trustwork.admin_change_payment_source(a)
    WHEN a.action = 'sponsored.enable' THEN trustwork.admin_change_sponsored(a, s)
    WHEN a.action = 'kill_switch.release' THEN trustwork.admin_change_kill_switch(a, s)
    WHEN a.action LIKE 'support.%' THEN trustwork.admin_change_support(a)
  END;
  IF v_found IS NULL AND a.hub_id IS NOT NULL THEN
    v_found := trustwork.admin_change_config(a);
  END IF;
  IF v_found IS NULL THEN
    v_found := CASE
      WHEN a.action = 'legal.activate_document_version' THEN trustwork.admin_change_legal(a)
      WHEN a.action = 'providers.enable_non_fake' THEN trustwork.admin_change_provider(a)
      WHEN a.action = 'egress.allow_private_class' THEN trustwork.admin_change_egress(a, s)
      WHEN a.action = 'federation.raise_peering_level' THEN trustwork.admin_change_peering(a, s)
    END;
  END IF;
  IF v_found IS NULL AND s IS NOT NULL THEN
    v_found := trustwork.admin_change_found(s, s, true, a.action_digest);
  END IF;
  RETURN v_found;
END $$;

-- The card's answer. Nothing is cut silently: over the limits the rows are cut and `complete` says so.
CREATE FUNCTION trustwork.admin_change_answer(a trustwork.second_person_approval) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_found jsonb;
  v_rows jsonb;
  v_complete boolean;
  v_unproved CONSTANT jsonb := jsonb_build_object('bound', false, 'visible', true, 'complete', false, 'current', false, 'currentDigest', NULL, 'fields', '[]'::jsonb, 'apply', NULL);
BEGIN
  v_found := trustwork.admin_change_resolve(a);
  IF v_found IS NULL THEN RETURN v_unproved; END IF;
  v_rows := (v_found -> 'extra') || trustwork.admin_change_rows(a.action, (v_found -> 'show') - 'action' - 'object' - 'hubId');
  v_complete := jsonb_array_length(v_rows) <= 1000 AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE length(coalesce(r #>> '{before,value}', '')) > 4000 OR length(coalesce(r #>> '{after,value}', '')) > 4000
      OR coalesce(r ->> 'field', '') !~ '^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_-]+)*$' OR NOT trustwork.admin_change_value_sound(r -> 'before') OR NOT trustwork.admin_change_value_sound(r -> 'after'));
  IF NOT v_complete THEN
    SELECT coalesce(jsonb_agg(CASE
        WHEN length(coalesce(r #>> '{before,value}', '')) > 4000 OR length(coalesce(r #>> '{after,value}', '')) > 4000 THEN trustwork.admin_change_row(r ->> 'field', trustwork.admin_change_key('approvals.tooLong'))
        WHEN NOT trustwork.admin_change_value_sound(r -> 'before') OR NOT trustwork.admin_change_value_sound(r -> 'after') THEN trustwork.admin_change_row(r ->> 'field', trustwork.admin_change_key('approvals.unreadable'))
        ELSE r END), '[]'::jsonb)
      INTO v_rows FROM (SELECT r FROM jsonb_array_elements(v_rows) r WHERE coalesce(r ->> 'field', '') ~ '^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_-]+)*$' LIMIT 1000) q;
  END IF;
  RETURN jsonb_build_object('bound', true, 'visible', true, 'complete', v_complete, 'current', v_found -> 'current', 'currentDigest', CASE WHEN (v_found ->> 'current')::boolean THEN v_found -> 'currentDigest' END,
    'fields', v_rows, 'apply', v_found -> 'apply');
EXCEPTION WHEN data_exception THEN
  -- A proved digest input the reading cannot follow: this card proves nothing; the list and every other card go on.
  RETURN v_unproved;
END $$;

-- Who reads the detail of a change: the read permission of its domain. Names, cases and addresses have the readers their
-- own tables have (moderation_case_read, account_service_action_read); a payment source's only through its review; what
-- gives someone a role, those who manage staff. Everything else is the hub's own configuration and offers.
CREATE FUNCTION trustwork.admin_change_read_permissions(p_action text, p_hub uuid) RETURNS text[]
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT CASE
    WHEN p_action LIKE 'screening.%' THEN ARRAY['admin.screening.matches.decide', 'admin.screening.matches.approve']
    WHEN trustwork.admin_action_permissions(p_action) IS NULL THEN '{}'::text[]
    WHEN p_action IN ('staff.assign_sensitive_role', 'staff.grant_breakglass') THEN ARRAY['admin.staff.read'] || trustwork.admin_action_permissions(p_action)
    WHEN p_action = 'moderation.apply_sanction_l4' THEN ARRAY['admin.moderation.read']
    WHEN p_action LIKE 'support.%' THEN trustwork.support_staff_permissions()
    -- By action alone, as for an audit row with no approval; admin_change_readers tells a metered price from a plan.
    WHEN p_action = 'commerce.activate_price_version' THEN ARRAY['admin.commerce.price.draft', 'admin.commerce.price.activate', 'admin.commerce.usage.read']
    WHEN p_action LIKE 'payments.%' AND p_action <> 'payments.change_settings' THEN trustwork.admin_action_permissions(p_action)
    WHEN p_hub IS NOT NULL THEN trustwork.admin_action_permissions(p_action) || trustwork.hubs_reader_permissions()
    ELSE trustwork.admin_action_permissions(p_action) END
$$;

-- One action can carry changes with different readers: a price asks the billing module which kind it is.
CREATE FUNCTION trustwork.admin_change_readers(a trustwork.second_person_approval) RETURNS text[]
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF a.action = 'commerce.activate_price_version' THEN RETURN trustwork.billing_change_readers(a); END IF;
  RETURN trustwork.admin_change_read_permissions(a.action, a.hub_id);
END $$;

CREATE FUNCTION trustwork.admin_change_may_read(a trustwork.second_person_approval, p_person uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT p_person IS NOT NULL AND (SELECT r.role FROM trustwork.admin_resolve_any(p_person, trustwork.admin_change_readers(a), a.node_id, a.hub_id) r) IS NOT NULL
$$;

-- A change whose list asks for an elevation asks for one here too, named by the caller and live, as admin_require_elevation.
CREATE FUNCTION trustwork.admin_change_elevated(a trustwork.second_person_approval, p_person uuid, p_elevation uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF a.action <> 'commerce.activate_price_version' OR NOT trustwork.billing_change_needs_elevation(a) THEN RETURN true; END IF;
  RETURN EXISTS (SELECT 1 FROM trustwork.session_elevation e JOIN trustwork.session s ON s.id = e.session_id
    WHERE e.id = p_elevation AND e.person_id = p_person AND e.revoked_at IS NULL AND e.expires_at > now()
      AND s.person_id = p_person AND s.revoked_at IS NULL AND s.idle_expires_at > now() AND s.absolute_expires_at > now());
END $$;

-- The answer for one approval. Its own readers (the second_person_approval_read policy) get the change if they read its
-- domain, and its action, scope and digest otherwise; anyone else gets nothing. Not an error: a list read must survive a
-- request decided between its two statements.
CREATE FUNCTION trustwork.admin_approval_change(p_approval uuid, p_elevation uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  a trustwork.second_person_approval%ROWTYPE;
BEGIN
  SELECT * INTO a FROM trustwork.second_person_approval WHERE id = p_approval;
  IF NOT FOUND OR v_person IS NULL OR NOT (a.requested_by = v_person OR a.approved_by IS NOT DISTINCT FROM v_person
      OR trustwork.admin_has_any_permission(ARRAY['admin.staff.read', 'admin.audit.read'], a.node_id, a.hub_id)
      OR (a.status = 'pending' AND trustwork.admin_has_any_permission(trustwork.admin_action_permissions(a.action), a.node_id, a.hub_id))) THEN
    RETURN NULL;
  END IF;
  IF NOT trustwork.admin_change_may_read(a, v_person) OR NOT trustwork.admin_change_elevated(a, v_person, p_elevation) THEN
    RETURN jsonb_build_object('bound', false, 'visible', false, 'complete', false, 'current', false, 'currentDigest', NULL, 'fields', '[]'::jsonb, 'apply', NULL);
  END IF;
  RETURN trustwork.admin_change_answer(a);
END $$;

-- The digest input of an approval, for what checks the card against it. No caller at runtime.
CREATE FUNCTION trustwork.admin_change_binding(p_approval uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.admin_change_resolve(a) FROM trustwork.second_person_approval a WHERE a.id = p_approval
$$;

CREATE FUNCTION trustwork.admin_change_subject_readable(p_approval uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT EXISTS (SELECT 1 FROM trustwork.second_person_approval a WHERE a.id = p_approval AND trustwork.admin_change_may_read(a, trustwork.current_person_id()))
$$;

-- The reason of a staff command says what the change is, so an audit row has the readers of its change: its approval's
-- when it has one, its action's when it is a second-person action with none (a refused attempt), and otherwise the
-- audit's own. Answers only for the rows the caller names, and only whether their text may be read.
CREATE FUNCTION trustwork.admin_audit_reasons_readable(p_events uuid[]) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT e.id FROM trustwork.admin_audit_event e
    LEFT JOIN trustwork.second_person_approval a ON a.id = coalesce(e.approval_id, CASE WHEN e.object_type = 'second_person_approval' THEN e.object_id END)
   WHERE e.id = ANY (p_events) AND CASE
     WHEN a.id IS NOT NULL THEN trustwork.admin_change_may_read(a, trustwork.current_person_id())
     WHEN e.action = ANY (trustwork.admin_second_person_actions()) THEN (SELECT r.role FROM trustwork.admin_resolve_any(trustwork.current_person_id(),
       trustwork.admin_change_read_permissions(e.action, e.hub_id), e.node_id, e.hub_id) r) IS NOT NULL
     ELSE true END
$$;

-- What is not shown cannot be approved. The trigger sees every approving writer, the inbox and the activation alike.
CREATE FUNCTION trustwork.admin_approval_shown_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_answer jsonb;
BEGIN
  IF NEW.status <> 'approved' OR OLD.status <> 'pending' OR NEW.action LIKE 'screening.%' OR (NEW.action = 'privacy.execute_erasure' AND NEW.scope_kind = 'platform') THEN
    RETURN NEW;
  END IF;
  IF NOT trustwork.admin_change_may_read(NEW, NEW.approved_by) THEN
    RAISE EXCEPTION 'the second person may not read this change' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.change_hidden';
  END IF;
  v_answer := trustwork.admin_change_answer(NEW);
  IF NOT (v_answer ->> 'bound')::boolean THEN
    RAISE EXCEPTION 'nothing proves what this digest binds' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.change_unbound';
  END IF;
  IF NOT (v_answer ->> 'complete')::boolean THEN
    RAISE EXCEPTION 'this change is too long to show whole' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.change_incomplete';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER second_person_approval_shown BEFORE UPDATE ON trustwork.second_person_approval FOR EACH ROW EXECUTE FUNCTION trustwork.admin_approval_shown_guard();

-- Read as the detail of a change is: see admin_change_may_read. Writes go through admin_bind_approval_subject only.
CREATE POLICY second_person_approval_subject_read ON trustwork.second_person_approval_subject FOR SELECT TO trustwork_app
  USING (trustwork.admin_change_subject_readable(approval_id));

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.admin_bind_approval_subject(uuid, jsonb), trustwork.admin_approval_change(uuid, uuid), trustwork.admin_change_subject_readable(uuid),
  trustwork.admin_audit_reasons_readable(uuid[]) TO trustwork_app;
