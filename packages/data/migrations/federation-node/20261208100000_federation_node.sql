-- FED-001 node identity, keys, manifest versions, peers, peering records and admission refusals
-- (docs/engine/federation.md, docs/engine/federation-protocol.md sections 4 to 8; ADR 011 decisions 2, 6 and 12;
-- ADR 014 decisions 2 to 5 through SANC-008; the authority model of DATA-002, packages/data/migrations/admin).
--
-- One database is one node. This slice extends the DATA-002 node anchor (trustwork.admin_node) with:
-- * the node identity the signed manifest publishes (DNS name, engine, operator, jurisdiction, licences, peering policy);
-- * the Ed25519 key chain: public entries with rotation hand-overs and revocations, and the sealed private seeds in a
--   table no runtime role can read (envelope encryption by the KEYS-001 key-encryption key; the plaintext exists only in
--   the memory of the process that signs);
-- * append-only manifest versions, so /.well-known/trustwork/manifest.json serves exactly what was signed;
-- * the peers this node knows: their last validated manifest, the admission outcome of SANC-008 and when the manifest
--   is due for refresh (at least daily);
-- * peering records as the protocol defines them (level, state, agreed licences, admission reference, requester and a
--   distinct second approver for deal_routing and identity), with the local phases of the double opt-in, suspension as
--   an orthogonal pause and an append-only event history: defederation ends a record and never rewrites it;
-- * admission refusal records (service, subject node name, findings, dataset), replay nonces, per-deal admissions and
--   noticed key revocations (what later packages re-verify).
--
-- Two kinds of writers:
-- * staff commands (federation_* with a p_ctx) resolve the caller's permission at the hub or the node, require a live
--   elevation, consume a second-person approval where the protocol requires one and write an admin_audit_event in the
--   same transaction (DATA-002);
-- * node-run commands (federation_node_* and the peer functions without p_ctx) are called by the node's own process
--   while it speaks the protocol: recording a signed manifest, a peer's manifest and admission, a received handshake, a
--   peer's answer, a nonce, a refusal. They take no identity and change only what the protocol allows.
--
-- Guard rails for every writer, the owner and maintenance sessions included: no node field, subject or JSON document
-- carries a network address; a record never activates without both acceptances and, above trust_verifications, a second
-- approver who is not the requester; an ended record never changes again; events, refusals and manifests are append-only.

-- 0. Vocabularies and grammars (immutable; tested against packages/contracts/src/federation.ts) -----------------------
CREATE FUNCTION trustwork.federation_levels() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['syndicate', 'trust_verifications', 'deal_routing', 'identity']::text[]
$$;
CREATE FUNCTION trustwork.federation_second_approver_levels() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['deal_routing', 'identity']::text[]
$$;
CREATE FUNCTION trustwork.federation_level_rank(p_level text) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_level WHEN 'syndicate' THEN 1 WHEN 'trust_verifications' THEN 2 WHEN 'deal_routing' THEN 3 WHEN 'identity' THEN 4 END
$$;
CREATE FUNCTION trustwork.federation_lower_level(p_a text, p_b text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT CASE WHEN trustwork.federation_level_rank(p_a) <= trustwork.federation_level_rank(p_b) THEN p_a ELSE p_b END
$$;
CREATE FUNCTION trustwork.federation_data_classes() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['directory_facts', 'person_profiles', 'editorial_publications', 'member_publications', 'imported_items', 'magazine_issues', 'events',
    'open_needs', 'reputation_snapshots', 'reviews', 'certificates', 'images', 'deal_data']::text[]
$$;
CREATE FUNCTION trustwork.federation_admission_services() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['federation_handshake', 'hub_directory', 'release_channel', 'registry_pull', 'support', 'hosted_service']::text[]
$$;
-- An IPv4 or IPv6 literal (also bracketed or with a port), the shapes `parseAddress` of the contracts refuses.
CREATE FUNCTION trustwork.federation_is_address(p_text text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_text IS NOT NULL AND (
    btrim(p_text) ~ '^\[?[0-9]{1,3}(\.[0-9]{1,3}){3}\]?(:[0-9]{1,5})?$'
    OR btrim(p_text) ~ '^\[?[0-9A-Fa-f]{0,4}(:[0-9A-Fa-f]{0,4}){2,7}(\.[0-9]{1,3}){0,3}\]?(:[0-9]{1,5})?$'
    OR btrim(p_text) ~ '^::ffff:[0-9]{1,3}(\.[0-9]{1,3}){3}$'
  )
$$;
-- A node is a lowercase DNS name with at least two labels; never an address.
CREATE FUNCTION trustwork.federation_host_ok(p_host text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT p_host IS NOT NULL AND length(p_host) <= 253
    AND p_host ~ '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*\.[a-z][a-z0-9-]{0,61}[a-z0-9]$'
    AND NOT trustwork.federation_is_address(p_host)
$$;
CREATE FUNCTION trustwork.federation_contact_ok(p_contact text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_contact IS NOT NULL AND length(p_contact) <= 320 AND p_contact ~ '^(mailto:[^[:space:]@]+@[^[:space:]@]+|https://[^[:space:]]+)$'
$$;
CREATE FUNCTION trustwork.federation_key_id_ok(p_key text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_key IS NOT NULL AND p_key ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
$$;
CREATE FUNCTION trustwork.federation_id_ok(p_id text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_id IS NOT NULL AND p_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
$$;
-- Every string value and object key of a JSON document that is a network address literal.
CREATE FUNCTION trustwork.federation_json_addresses(p_value jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  WITH RECURSIVE walk(v) AS (
    SELECT p_value
    UNION ALL
    SELECT c.v FROM walk w CROSS JOIN LATERAL (
      SELECT e.value AS v FROM jsonb_each(CASE WHEN jsonb_typeof(w.v) = 'object' THEN w.v ELSE '{}'::jsonb END) e
      UNION ALL
      SELECT to_jsonb(e.key) FROM jsonb_each(CASE WHEN jsonb_typeof(w.v) = 'object' THEN w.v ELSE '{}'::jsonb END) e
      UNION ALL
      SELECT a.value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.v) = 'array' THEN w.v ELSE '[]'::jsonb END) a
    ) c
  )
  SELECT coalesce(array_agg(DISTINCT w.v #>> '{}' ORDER BY w.v #>> '{}'), ARRAY[]::text[])
  FROM walk w WHERE jsonb_typeof(w.v) = 'string' AND trustwork.federation_is_address(w.v #>> '{}')
$$;
CREATE FUNCTION trustwork.federation_json_address_free(p_value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT p_value IS NULL OR cardinality(trustwork.federation_json_addresses(p_value)) = 0
$$;
-- The agreed licences object: exactly one term per data class, every term a known one.
CREATE FUNCTION trustwork.federation_licences_ok(p_licences jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_typeof(p_licences) = 'object'
    AND (SELECT count(*) FROM jsonb_object_keys(p_licences)) = cardinality(trustwork.federation_data_classes())
    AND NOT EXISTS (SELECT 1 FROM jsonb_each(p_licences) e WHERE NOT (e.key = ANY (trustwork.federation_data_classes())) OR jsonb_typeof(e.value) <> 'string'
      OR NOT ((e.value #>> '{}') = ANY (ARRAY['open_data_with_attribution', 'cc_by_4_0', 'redisplay_with_attribution', 'mesh_only_redisplay', 'redisplay_unchanged',
        'headline_and_link', 'contents_and_links', 'verification_record', 'own_licence_only', 'source_licence', 'link_only', 'parties_only', 'none'])))
$$;
-- The node anchor, or a refusal before the setup wizard created it.
CREATE FUNCTION trustwork.federation_node() RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_node uuid := (SELECT id FROM trustwork.admin_node LIMIT 1);
BEGIN
  IF v_node IS NULL THEN
    RAISE EXCEPTION 'the node is not set up yet' USING ERRCODE = 'object_not_in_prerequisite_state', HINT = 'federation.no_node';
  END IF;
  RETURN v_node;
END $$;
CREATE FUNCTION trustwork.federation_iso(p_at timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

-- 1. Node identity ----------------------------------------------------------------------------------------------------
-- One row per node (the manifest's node, engine, operator, jurisdiction, licences and peering policy). The operator's
-- country, the hubs with their territories and languages, the country packs and the deployment attestation are read
-- from the modules that own them (SANC-009, HUB-001) when the manifest is built.
CREATE TABLE trustwork.node_identity (
  node_id uuid PRIMARY KEY REFERENCES trustwork.admin_node (id),
  host text NOT NULL CHECK (trustwork.federation_host_ok(host)),
  engine_version text NOT NULL CHECK (engine_version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'),
  engine_source text NOT NULL CHECK (length(engine_source) <= 300 AND engine_source ~ '^https://[^[:space:]]+$'),
  operator_name text NOT NULL CHECK (length(operator_name) BETWEEN 1 AND 200),
  operator_registration_kind text NULL CHECK (operator_registration_kind ~ '^[a-z][a-z0-9_]{1,40}$'),
  operator_registration_value text NULL CHECK (length(operator_registration_value) BETWEEN 1 AND 64),
  abuse_contact text NOT NULL CHECK (trustwork.federation_contact_ok(abuse_contact)),
  takedown_contact text NOT NULL CHECK (trustwork.federation_contact_ok(takedown_contact)),
  jurisdiction text NOT NULL CHECK (jurisdiction ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'),
  licences jsonb NOT NULL CHECK (trustwork.federation_licences_ok(licences)),
  tombstone_hours integer NOT NULL CHECK (tombstone_hours BETWEEN 1 AND 72),
  offered_levels text[] NOT NULL CHECK (cardinality(offered_levels) BETWEEN 1 AND 4 AND offered_levels <@ trustwork.federation_levels() AND trustwork.admin_distinct(offered_levels)),
  agent_envelopes_per_hour integer NOT NULL CHECK (agent_envelopes_per_hour BETWEEN 0 AND 10000),
  created_by uuid NOT NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT node_identity_registration_shape CHECK ((operator_registration_kind IS NULL) = (operator_registration_value IS NULL)),
  CONSTRAINT node_identity_no_address CHECK (NOT trustwork.federation_is_address(operator_name) AND NOT trustwork.federation_is_address(coalesce(operator_registration_value, '')))
);
CREATE TRIGGER node_identity_touch BEFORE UPDATE ON trustwork.node_identity FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
CREATE FUNCTION trustwork.federation_identity_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a node identity is never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.node_id <> OLD.node_id OR NEW.host <> OLD.host OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at) THEN
    RAISE EXCEPTION 'a node keeps its name and creator' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  -- The kernel list fails closed while unsynced (kernel_place_restricted is true for every code then).
  PERFORM trustwork.kernel_lock_restrictions_shared();
  IF trustwork.kernel_place_restricted(NEW.jurisdiction) THEN
    RAISE EXCEPTION 'restricted place % cannot be a node jurisdiction', NEW.jurisdiction USING ERRCODE = 'check_violation', HINT = 'federation.restricted_place', DETAIL = NEW.jurisdiction;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER node_identity_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.node_identity FOR EACH ROW EXECUTE FUNCTION trustwork.federation_identity_guard();

-- 2. Key chain --------------------------------------------------------------------------------------------------------
-- Public entries, oldest first by position. The first key has no rotation; every later key carries the hand-over
-- signed by its predecessor, which retires exactly when the successor becomes valid. A leaked key gets a revocation
-- (compromised_since, revoked_at); signatures at or after compromised_since are refused everywhere.
CREATE TABLE trustwork.node_key (
  node_id uuid NOT NULL REFERENCES trustwork.admin_node (id),
  key_id text NOT NULL CHECK (trustwork.federation_key_id_ok(key_id)),
  position integer NOT NULL CHECK (position >= 1),
  algorithm text NOT NULL DEFAULT 'ed25519' CHECK (algorithm = 'ed25519'),
  public_key text NOT NULL CHECK (public_key ~ '^[A-Za-z0-9_-]{43}$'),
  valid_from timestamptz NOT NULL,
  retired_at timestamptz NULL,
  compromised_since timestamptz NULL,
  revoked_at timestamptz NULL,
  rotation_previous_key_id text NULL,
  rotation_signature text NULL CHECK (rotation_signature ~ '^[A-Za-z0-9_-]{86}$'),
  created_by uuid NOT NULL REFERENCES trustwork.person (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, key_id),
  CONSTRAINT node_key_position UNIQUE (node_id, position),
  CONSTRAINT node_key_public_key UNIQUE (node_id, public_key),
  CONSTRAINT node_key_genesis_shape CHECK ((position = 1) = (rotation_previous_key_id IS NULL)),
  CONSTRAINT node_key_rotation_shape CHECK ((rotation_previous_key_id IS NULL) = (rotation_signature IS NULL)),
  CONSTRAINT node_key_retires_after_valid CHECK (retired_at IS NULL OR retired_at > valid_from),
  CONSTRAINT node_key_revocation_shape CHECK ((compromised_since IS NULL) = (revoked_at IS NULL) AND (compromised_since IS NULL OR compromised_since >= valid_from)),
  CONSTRAINT node_key_revoked_is_retired CHECK (revoked_at IS NULL OR retired_at IS NOT NULL)
);
CREATE FUNCTION trustwork.federation_key_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a key chain entry is never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.position <> (SELECT coalesce(max(k.position), 0) + 1 FROM trustwork.node_key k WHERE k.node_id = NEW.node_id) THEN
      RAISE EXCEPTION 'keys append to the chain in order' USING ERRCODE = 'check_violation', HINT = 'federation.chain_order';
    END IF;
    IF NEW.position > 1 AND NOT EXISTS (SELECT 1 FROM trustwork.node_key k WHERE k.node_id = NEW.node_id AND k.position = NEW.position - 1 AND k.key_id = NEW.rotation_previous_key_id
        AND k.retired_at = NEW.valid_from) THEN
      RAISE EXCEPTION 'a rotation names its predecessor, which retires when the successor becomes valid' USING ERRCODE = 'check_violation', HINT = 'federation.handover_gap';
    END IF;
    IF NEW.retired_at IS NOT NULL OR NEW.compromised_since IS NOT NULL THEN
      RAISE EXCEPTION 'a new key is neither retired nor revoked' USING ERRCODE = 'check_violation', HINT = 'federation.chain_order';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.node_id <> OLD.node_id OR NEW.key_id <> OLD.key_id OR NEW.position <> OLD.position OR NEW.public_key <> OLD.public_key OR NEW.valid_from <> OLD.valid_from
     OR NEW.rotation_previous_key_id IS DISTINCT FROM OLD.rotation_previous_key_id OR NEW.rotation_signature IS DISTINCT FROM OLD.rotation_signature
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a key chain entry is immutable; rotate instead' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  IF OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
    RAISE EXCEPTION 'a key retires once' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  IF OLD.compromised_since IS NOT NULL AND (NEW.compromised_since IS DISTINCT FROM OLD.compromised_since OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'a revocation is published once' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER node_key_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.node_key FOR EACH ROW EXECUTE FUNCTION trustwork.federation_key_guard();

-- The sealed private seed of each key: AES-256-GCM ciphertext under a fresh data key wrapped by the node's KEK
-- (KEYS-001 envelope encryption). No runtime role can SELECT this table; the node's own process reads the material of
-- one key through federation_node_signing_material and opens it only in memory. Insert only.
CREATE TABLE trustwork.node_key_secret (
  node_id uuid NOT NULL,
  key_id text NOT NULL,
  algorithm text NOT NULL DEFAULT 'aes-256-gcm' CHECK (algorithm = 'aes-256-gcm'),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 4096),
  iv bytea NOT NULL CHECK (octet_length(iv) = 12),
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
  wrapped_key bytea NOT NULL CHECK (octet_length(wrapped_key) BETWEEN 16 AND 2048),
  kek_id text NOT NULL CHECK (kek_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, key_id),
  FOREIGN KEY (node_id, key_id) REFERENCES trustwork.node_key (node_id, key_id)
);
CREATE TRIGGER node_key_secret_permanent BEFORE UPDATE OR DELETE ON trustwork.node_key_secret FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER node_key_secret_no_truncate BEFORE TRUNCATE ON trustwork.node_key_secret FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

-- 3. Manifest versions ------------------------------------------------------------------------------------------------
-- Every signed manifest the node published, append-only; the highest version is what the well-known URL serves. A
-- manifest is a public document, so anyone may read these rows. The digest is trustwork-digest-1 of the signed document.
CREATE TABLE trustwork.node_manifest (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  node_id uuid NOT NULL REFERENCES trustwork.admin_node (id),
  version integer NOT NULL CHECK (version >= 1),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object' AND octet_length(document::text) <= 262144 AND trustwork.federation_json_address_free(document)),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  key_id text NOT NULL,
  issued_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT node_manifest_version UNIQUE (node_id, version),
  CONSTRAINT node_manifest_digest UNIQUE (node_id, digest),
  FOREIGN KEY (node_id, key_id) REFERENCES trustwork.node_key (node_id, key_id)
);
CREATE TRIGGER node_manifest_append_only BEFORE UPDATE OR DELETE ON trustwork.node_manifest FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER node_manifest_no_truncate BEFORE TRUNCATE ON trustwork.node_manifest FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

-- 4. Peers: last validated manifest and the admission outcome ---------------------------------------------------------
-- One row per peer node this node has admitted or refused. The manifest is stored as validated (the contract schema
-- refuses a restricted place and every node field is a DNS name; the address scan is the backstop). refresh_due_at keeps
-- the manifest fresh (at least daily); admission_state is the last SANC-008 outcome and admission_trigger why it ran.
CREATE TABLE trustwork.federation_peer (
  node_id uuid NOT NULL REFERENCES trustwork.admin_node (id),
  peer_node text NOT NULL CHECK (trustwork.federation_host_ok(peer_node)),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object' AND octet_length(manifest::text) <= 262144 AND trustwork.federation_json_address_free(manifest)),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  manifest_issued_at timestamptz NOT NULL,
  manifest_fetched_at timestamptz NOT NULL,
  refresh_due_at timestamptz NOT NULL,
  current_key_id text NOT NULL CHECK (trustwork.federation_key_id_ok(current_key_id)),
  attestation_expires_at timestamptz NOT NULL,
  admission_state text NOT NULL CHECK (admission_state IN ('admitted', 'refused')),
  admission_decided_at timestamptz NOT NULL,
  admission_judged text[] NOT NULL CHECK (admission_judged <@ ARRAY['declared', 'attested', 'observed']::text[]),
  admission_trigger text NOT NULL CHECK (admission_trigger IN ('handshake', 'request', 'refresh', 'key_unknown', 'manifest_changed', 'attestation_changed', 'capability_changed', 'deal_delivery', 'manual')),
  equivocation_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, peer_node),
  CONSTRAINT federation_peer_manifest_node CHECK (manifest ->> 'node' = peer_node)
);
CREATE INDEX federation_peer_due_idx ON trustwork.federation_peer (refresh_due_at);
CREATE TRIGGER federation_peer_touch BEFORE UPDATE ON trustwork.federation_peer FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
CREATE FUNCTION trustwork.federation_peer_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a known peer is never forgotten; end its peering' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.node_id <> OLD.node_id OR NEW.peer_node <> OLD.peer_node OR NEW.created_at <> OLD.created_at) THEN
    RAISE EXCEPTION 'a peer keeps its name' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.equivocation_at IS NOT NULL AND NEW.equivocation_at IS DISTINCT FROM OLD.equivocation_at THEN
    RAISE EXCEPTION 'an equivocation finding stands until the operator confirms the chain' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER federation_peer_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.federation_peer FOR EACH ROW EXECUTE FUNCTION trustwork.federation_peer_guard();

-- 5. Peering records and their history -------------------------------------------------------------------------------
-- The protocol record (PeeringRecordSchema) plus the local double opt-in phases: a record is born pending_approval and
-- becomes active only with both acceptances, the admission reference and, for deal_routing and identity, a consumed
-- second-person approval by someone other than the requester. Suspension pauses every flow without changing the
-- protocol state; ending is final. At most one open record per (local hub, peer node, peer hub).
CREATE TABLE trustwork.peering_record (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  node_id uuid NOT NULL REFERENCES trustwork.admin_node (id),
  local_hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  peer_node text NOT NULL CHECK (trustwork.federation_host_ok(peer_node)),
  peer_hub_id text NOT NULL CHECK (trustwork.federation_id_ok(peer_hub_id) AND NOT trustwork.federation_is_address(peer_hub_id)),
  direction text NOT NULL CHECK (direction IN ('outgoing', 'incoming')),
  level text NOT NULL CHECK (level = ANY (trustwork.federation_levels())),
  state text NOT NULL DEFAULT 'pending_approval' CHECK (state IN ('pending_approval', 'active', 'ended')),
  phase text NOT NULL CHECK (phase IN ('awaiting_peer', 'awaiting_acceptance', 'awaiting_second_approver', 'complete')),
  licences jsonb NOT NULL CHECK (trustwork.federation_licences_ok(licences)),
  tombstone_hours integer NOT NULL CHECK (tombstone_hours BETWEEN 1 AND 72),
  agent_envelopes_per_hour integer NOT NULL CHECK (agent_envelopes_per_hour BETWEEN 0 AND 10000),
  peer_manifest_digest text NOT NULL CHECK (peer_manifest_digest ~ '^[a-f0-9]{64}$'),
  peer_key_id text NOT NULL CHECK (trustwork.federation_key_id_ok(peer_key_id)),
  admission_decided_at timestamptz NOT NULL,
  admission_judged text[] NOT NULL CHECK (admission_judged = ARRAY['declared', 'attested', 'observed']::text[]),
  -- The local person who requested (outgoing) or accepted (incoming); null only while an incoming request waits for one.
  requested_by uuid NULL REFERENCES trustwork.person (id),
  local_accepted_at timestamptz NULL,
  peer_accepted_at timestamptz NULL,
  second_approver_id uuid NULL REFERENCES trustwork.person (id),
  approval_id uuid NULL UNIQUE REFERENCES trustwork.second_person_approval (id),
  suspended_at timestamptz NULL,
  suspension_reason text NULL CHECK (suspension_reason IN ('operator', 'admission_refused', 'attestation_expired', 'equivocation', 'peer_suspended')),
  started_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz NULL,
  ended_at timestamptz NULL,
  ended_by uuid NULL REFERENCES trustwork.person (id),
  end_reason text NULL CHECK (end_reason IN ('defederated', 'declined', 'refused_by_peer', 'peer_ended', 'superseded')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (node_id, peer_node) REFERENCES trustwork.federation_peer (node_id, peer_node),
  CONSTRAINT peering_record_requester CHECK (requested_by IS NOT NULL OR (direction = 'incoming' AND local_accepted_at IS NULL)),
  CONSTRAINT peering_record_local_acceptance CHECK (local_accepted_at IS NULL OR requested_by IS NOT NULL),
  CONSTRAINT peering_record_end_shape CHECK ((state = 'ended') = (ended_at IS NOT NULL) AND (state = 'ended') = (end_reason IS NOT NULL)),
  CONSTRAINT peering_record_active_shape CHECK (state <> 'active' OR (local_accepted_at IS NOT NULL AND peer_accepted_at IS NOT NULL AND phase = 'complete' AND activated_at IS NOT NULL)),
  CONSTRAINT peering_record_second_approver CHECK (state <> 'active' OR NOT (level = ANY (trustwork.federation_second_approver_levels()))
    OR (second_approver_id IS NOT NULL AND approval_id IS NOT NULL)),
  CONSTRAINT peering_record_distinct_people CHECK (second_approver_id IS NULL OR requested_by IS NULL OR second_approver_id <> requested_by),
  CONSTRAINT peering_record_approval_shape CHECK ((second_approver_id IS NULL) = (approval_id IS NULL)),
  CONSTRAINT peering_record_suspension_shape CHECK ((suspended_at IS NULL) = (suspension_reason IS NULL) AND (suspended_at IS NULL OR state = 'active')),
  CONSTRAINT peering_record_pending_phase CHECK ((state = 'pending_approval') = (phase <> 'complete'))
);
CREATE UNIQUE INDEX peering_record_one_open ON trustwork.peering_record (node_id, local_hub_id, peer_node, peer_hub_id) WHERE state <> 'ended';
CREATE INDEX peering_record_peer_idx ON trustwork.peering_record (node_id, peer_node, state);
CREATE INDEX peering_record_hub_idx ON trustwork.peering_record (local_hub_id, started_at DESC);
CREATE TRIGGER peering_record_touch BEFORE UPDATE ON trustwork.peering_record FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
CREATE FUNCTION trustwork.federation_record_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_approval trustwork.second_person_approval%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a peering record is never deleted; end it' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending_approval' OR NEW.ended_at IS NOT NULL OR NEW.suspended_at IS NOT NULL OR NEW.activated_at IS NOT NULL THEN
      RAISE EXCEPTION 'a peering record is born pending' USING ERRCODE = 'check_violation', HINT = 'federation.invalid_transition';
    END IF;
  ELSE
    IF OLD.state = 'ended' THEN
      RAISE EXCEPTION 'an ended peering record never changes; a new connection needs a new request' USING ERRCODE = 'integrity_constraint_violation', HINT = 'federation.ended';
    END IF;
    IF NEW.id <> OLD.id OR NEW.node_id <> OLD.node_id OR NEW.local_hub_id <> OLD.local_hub_id OR NEW.peer_node <> OLD.peer_node OR NEW.peer_hub_id <> OLD.peer_hub_id
       OR NEW.direction <> OLD.direction OR (OLD.requested_by IS NOT NULL AND NEW.requested_by IS DISTINCT FROM OLD.requested_by) OR NEW.started_at <> OLD.started_at
       OR NEW.admission_decided_at <> OLD.admission_decided_at THEN
      RAISE EXCEPTION 'a peering record keeps its parties, requester and admission' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
    END IF;
    IF OLD.state = 'active' AND NEW.state = 'pending_approval' THEN
      RAISE EXCEPTION 'an active record never returns to pending' USING ERRCODE = 'check_violation', HINT = 'federation.invalid_transition';
    END IF;
    IF trustwork.federation_level_rank(NEW.level) > trustwork.federation_level_rank(OLD.level) AND OLD.state = 'active' THEN
      RAISE EXCEPTION 'a level is raised through a new handshake with a second approver, never in place' USING ERRCODE = 'check_violation', HINT = 'federation.invalid_transition';
    END IF;
    IF OLD.local_accepted_at IS NOT NULL AND NEW.local_accepted_at IS DISTINCT FROM OLD.local_accepted_at
       OR OLD.peer_accepted_at IS NOT NULL AND NEW.peer_accepted_at IS DISTINCT FROM OLD.peer_accepted_at
       OR OLD.approval_id IS NOT NULL AND NEW.approval_id IS DISTINCT FROM OLD.approval_id THEN
      RAISE EXCEPTION 'acceptances and approvals are recorded once' USING ERRCODE = 'integrity_constraint_violation', HINT = 'admin.immutable';
    END IF;
    IF NEW.state = 'active' AND OLD.state <> 'active' THEN
      NEW.activated_at := now();
    END IF;
    IF NEW.state = 'ended' THEN
      NEW.ended_at := now();
      NEW.suspended_at := NULL;
      NEW.suspension_reason := NULL;
    END IF;
  END IF;
  -- Every writer: the approval was consumed for this record, requested by its requester, approved by someone else,
  -- for federation.raise_peering_level at this hub and the digest of this level with these parties.
  IF NEW.approval_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.approval_id IS NULL) THEN
    SELECT * INTO v_approval FROM trustwork.second_person_approval WHERE id = NEW.approval_id;
    IF NOT FOUND OR v_approval.status <> 'consumed' OR v_approval.consumed_ref IS DISTINCT FROM NEW.id OR v_approval.scope_kind <> 'hub'
       OR v_approval.hub_id IS DISTINCT FROM NEW.local_hub_id OR v_approval.requested_by IS DISTINCT FROM NEW.requested_by OR v_approval.approved_by IS DISTINCT FROM NEW.second_approver_id
       OR v_approval.action <> 'federation.raise_peering_level'
       OR v_approval.action_digest IS DISTINCT FROM trustwork.federation_peering_digest(NEW.local_hub_id, NEW.peer_node, NEW.peer_hub_id, NEW.level) THEN
      RAISE EXCEPTION 'deal_routing and identity are approved by a second person for exactly this peering' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_required';
    END IF;
  END IF;
  RETURN NEW;
END $$;
-- The digest a second person approves for a peering at deal_routing or identity (peeringLevelDigestInput in the module).
CREATE FUNCTION trustwork.federation_peering_digest(p_hub uuid, p_peer text, p_peer_hub text, p_level text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.admin_digest(jsonb_build_object('action', 'federation.raise_peering_level', 'object', 'peering_record', 'localHubId', p_hub::text,
    'peerNode', p_peer, 'peerHubId', p_peer_hub, 'level', p_level))
$$;
-- The digest a second person approves for a key rotation (keyRotationDigestInput in the module).
CREATE FUNCTION trustwork.federation_rotation_digest(p_node uuid, p_previous_key text, p_compromised_since timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.admin_digest(jsonb_build_object('action', 'ops.rotate_node_key', 'object', 'node_key', 'nodeId', p_node::text, 'previousKeyId', p_previous_key,
    'compromisedSince', CASE WHEN p_compromised_since IS NULL THEN NULL ELSE trustwork.federation_iso(p_compromised_since) END))
$$;
CREATE TRIGGER peering_record_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.peering_record FOR EACH ROW EXECUTE FUNCTION trustwork.federation_record_guard();

-- Append-only history of every transition and protocol step; details carry codes and labels, never an address.
CREATE TABLE trustwork.peering_event (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  peering_record_id uuid NOT NULL REFERENCES trustwork.peering_record (id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  event text NOT NULL CHECK (event ~ '^[a-z][a-z0-9_.]{1,60}$'),
  actor_person_id uuid NULL REFERENCES trustwork.person (id),
  from_state text NULL,
  to_state text NULL,
  reason text NULL CHECK (length(reason) BETWEEN 1 AND 500 AND NOT trustwork.federation_is_address(reason)),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object' AND octet_length(details::text) <= 8192 AND trustwork.federation_json_address_free(details))
);
CREATE INDEX peering_event_record_idx ON trustwork.peering_event (peering_record_id, occurred_at);
CREATE TRIGGER peering_event_append_only BEFORE UPDATE OR DELETE ON trustwork.peering_event FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER peering_event_no_truncate BEFORE TRUNCATE ON trustwork.peering_event FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

CREATE FUNCTION trustwork.federation_event(p_record uuid, p_event text, p_actor uuid, p_from text, p_to text, p_reason text, p_details jsonb DEFAULT '{}'::jsonb) RETURNS void
LANGUAGE sql VOLATILE SET search_path = trustwork, pg_temp AS $$
  INSERT INTO trustwork.peering_event (peering_record_id, event, actor_person_id, from_state, to_state, reason, details)
  VALUES (p_record, p_event, p_actor, p_from, p_to, NULLIF(left(p_reason, 500), ''), coalesce(p_details, '{}'::jsonb))
$$;

-- 6. Admission refusals, replay nonces, deal admissions and noticed revocations -----------------------------------------
-- What is stored when our admission check refuses (AdmissionRefusalRecordSchema): service, the subject node name,
-- findings (reason, evidence kind, source, place, dataset) and the geolocation mode. Never an address, never a header.
CREATE TABLE trustwork.admission_refusal (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  node_id uuid NOT NULL REFERENCES trustwork.admin_node (id),
  service text NOT NULL CHECK (service = ANY (trustwork.federation_admission_services())),
  subject text NULL CHECK (length(subject) <= 253 AND subject ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' AND NOT trustwork.federation_is_address(subject)),
  decided_at timestamptz NOT NULL,
  findings jsonb NOT NULL CHECK (jsonb_typeof(findings) = 'array' AND jsonb_array_length(findings) >= 1 AND octet_length(findings::text) <= 16384 AND trustwork.federation_json_address_free(findings)),
  geolocation jsonb NULL CHECK (geolocation IS NULL OR (jsonb_typeof(geolocation) = 'object' AND trustwork.federation_json_address_free(geolocation))),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admission_refusal_subject_idx ON trustwork.admission_refusal (node_id, subject, decided_at DESC);
CREATE TRIGGER admission_refusal_append_only BEFORE UPDATE OR DELETE ON trustwork.admission_refusal FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
CREATE TRIGGER admission_refusal_no_truncate BEFORE TRUNCATE ON trustwork.admission_refusal FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

-- (peer, key, nonce) seen on a signed request, kept until the signature expires: the primary key makes concurrent
-- replays resolve to exactly one acceptance.
CREATE TABLE trustwork.federation_nonce (
  node_id uuid NOT NULL REFERENCES trustwork.admin_node (id),
  peer_node text NOT NULL CHECK (trustwork.federation_host_ok(peer_node)),
  key_id text NOT NULL CHECK (trustwork.federation_key_id_ok(key_id)),
  nonce text NOT NULL CHECK (nonce ~ '^[A-Za-z0-9_-]{22,86}$'),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (node_id, peer_node, key_id, nonce)
);
CREATE INDEX federation_nonce_expiry_idx ON trustwork.federation_nonce (expires_at);

-- The admission re-run before the first delivery of every new deal with a peer (one row per deal).
CREATE TABLE trustwork.peer_deal_admission (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  node_id uuid NOT NULL REFERENCES trustwork.admin_node (id),
  peer_node text NOT NULL CHECK (trustwork.federation_host_ok(peer_node)),
  deal_ref text NOT NULL CHECK (trustwork.federation_id_ok(deal_ref) AND NOT trustwork.federation_is_address(deal_ref)),
  outcome text NOT NULL CHECK (outcome IN ('admitted', 'refused')),
  decided_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT peer_deal_admission_once UNIQUE (node_id, peer_node, deal_ref),
  FOREIGN KEY (node_id, peer_node) REFERENCES trustwork.federation_peer (node_id, peer_node)
);
CREATE TRIGGER peer_deal_admission_append_only BEFORE UPDATE OR DELETE ON trustwork.peer_deal_admission FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- A revocation a peer published: everything that peer signed with that key at or after compromised_since is
-- re-verified by the packages that hold replicas and deal objects; objects_flagged counts what they found.
CREATE TABLE trustwork.peer_key_revocation (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  node_id uuid NOT NULL REFERENCES trustwork.admin_node (id),
  peer_node text NOT NULL CHECK (trustwork.federation_host_ok(peer_node)),
  key_id text NOT NULL CHECK (trustwork.federation_key_id_ok(key_id)),
  compromised_since timestamptz NOT NULL,
  revoked_at timestamptz NOT NULL,
  noticed_at timestamptz NOT NULL DEFAULT now(),
  objects_flagged integer NOT NULL DEFAULT 0 CHECK (objects_flagged >= 0),
  CONSTRAINT peer_key_revocation_once UNIQUE (node_id, peer_node, key_id),
  FOREIGN KEY (node_id, peer_node) REFERENCES trustwork.federation_peer (node_id, peer_node)
);
CREATE TRIGGER peer_key_revocation_no_delete BEFORE DELETE ON trustwork.peer_key_revocation FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 7. Readers (row-level security helpers) ------------------------------------------------------------------------------
CREATE FUNCTION trustwork.federation_reader_permissions() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['admin.federation.read', 'admin.federation.peer.edit', 'admin.federation.defederate', 'admin.node.hubs.manage', 'admin.node.keys.rotate', 'admin.audit.read']::text[]
$$;
-- May the caller read federation records of this hub (NULL: node-level records)?
CREATE FUNCTION trustwork.federation_staff_reader(p_hub uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL
    AND (SELECT r.role FROM trustwork.admin_resolve_any(trustwork.current_person_id(), trustwork.federation_reader_permissions(),
      CASE WHEN p_hub IS NULL THEN (SELECT id FROM trustwork.admin_node LIMIT 1) END, p_hub) r) IS NOT NULL
$$;
-- A peer row is visible to node staff and to the staff of any hub that has a record with that peer.
CREATE FUNCTION trustwork.federation_peer_reader(p_peer text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.federation_staff_reader(NULL)
    OR EXISTS (SELECT 1 FROM trustwork.peering_record r WHERE r.peer_node = p_peer AND trustwork.federation_staff_reader(r.local_hub_id))
$$;
-- Admission refusal records: compliance and audit readers at the node.
CREATE FUNCTION trustwork.federation_refusal_reader() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL
    AND (SELECT r.role FROM trustwork.admin_resolve_any(trustwork.current_person_id(), ARRAY['admin.audit.read', 'admin.hub.jurisdiction.edit'],
      (SELECT id FROM trustwork.admin_node LIMIT 1), NULL) r) IS NOT NULL
$$;

-- 8. Node-run commands (the node's own process, no identity) -------------------------------------------------------------
-- A peer's admission is current when the last check admitted it, its attestation has not expired and its manifest is not
-- past its refresh by more than a day. Every point of use (flows, handshakes, requests, acceptances, lifting a
-- suspension) requires this, so a peer never keeps a flow because no refresh ran: fail closed until a fresh admission.
CREATE FUNCTION trustwork.federation_admission_stale_after() RETURNS interval
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT interval '1 day'
$$;
CREATE FUNCTION trustwork.federation_peer_current(p_peer trustwork.federation_peer) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT p_peer.admission_state = 'admitted' AND p_peer.attestation_expires_at > now() AND p_peer.refresh_due_at + trustwork.federation_admission_stale_after() > now()
$$;

-- The hubs the manifest publishes and the only hubs a peer may address: launched hubs (soft_launch, public, suspended,
-- closing) by slug (the manifest's hub id), with their territories, languages and country pack. A draft or preparing hub
-- is not published on the unauthenticated URL and a handshake or request naming it is refused like an unknown hub
-- (owner default under ADR 025, 2026-11-04). A public fact of the deployment; readable without a principal.
CREATE FUNCTION trustwork.federation_published_lifecycles() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['soft_launch', 'public', 'suspended', 'closing']::text[]
$$;
CREATE FUNCTION trustwork.federation_manifest_hubs() RETURNS TABLE (hub_id uuid, slug text, territories text[], locales text[], pack_code text, pack_version text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT h.id, h.slug, coalesce((SELECT array_agg(t.code ORDER BY t.code) FROM trustwork.hub_territory t WHERE t.hub_id = h.id), ARRAY[]::text[]), p.locales, h.pack_code, h.pack_version
  FROM trustwork.hub h JOIN trustwork.hub_profile p ON p.hub_id = h.id WHERE h.lifecycle = ANY (trustwork.federation_published_lifecycles()) ORDER BY h.slug
$$;
CREATE FUNCTION trustwork.federation_hub_by_slug(p_slug text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT h.id FROM trustwork.hub h JOIN trustwork.hub_profile p ON p.hub_id = h.id WHERE h.slug = p_slug AND h.lifecycle = ANY (trustwork.federation_published_lifecycles())
$$;
-- The sealed material of one key (default: the current key). Only the runtime role may call this; the plaintext never
-- exists outside the memory of the process that opens it.
CREATE FUNCTION trustwork.federation_node_signing_material(p_key_id text DEFAULT NULL)
RETURNS TABLE (key_id text, public_key text, ciphertext bytea, iv bytea, auth_tag bytea, wrapped_key bytea, kek_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT k.key_id, k.public_key, s.ciphertext, s.iv, s.auth_tag, s.wrapped_key, s.kek_id
  FROM trustwork.node_key k JOIN trustwork.node_key_secret s ON s.node_id = k.node_id AND s.key_id = k.key_id
  WHERE k.node_id = (SELECT id FROM trustwork.admin_node LIMIT 1) AND ((p_key_id IS NULL AND k.retired_at IS NULL) OR k.key_id = p_key_id)
  ORDER BY k.position DESC LIMIT 1
$$;

-- Records a signed manifest as the next version; the same document (same digest) is recorded once.
CREATE FUNCTION trustwork.federation_node_record_manifest(p_document jsonb, p_digest text, p_key_id text, p_issued_at timestamptz) RETURNS trustwork.node_manifest
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_node uuid := trustwork.federation_node();
  v_row trustwork.node_manifest%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('trustwork.node_manifest:' || v_node::text, 0));
  SELECT * INTO v_row FROM trustwork.node_manifest WHERE node_id = v_node AND digest = p_digest;
  IF FOUND THEN
    RETURN v_row;
  END IF;
  INSERT INTO trustwork.node_manifest (node_id, version, document, digest, key_id, issued_at)
  VALUES (v_node, (SELECT coalesce(max(version), 0) + 1 FROM trustwork.node_manifest WHERE node_id = v_node), p_document, p_digest, p_key_id, p_issued_at) RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- Stores a peer's validated manifest with the outcome of our admission check. A refusal (or an expired attestation)
-- suspends every active record with the peer; a renewed admission lifts the suspensions that admission caused.
CREATE FUNCTION trustwork.federation_peer_record(p_peer text, p_manifest jsonb, p_digest text, p_issued_at timestamptz, p_current_key text, p_attestation_expires timestamptz,
  p_admitted boolean, p_judged text[], p_trigger text, p_suspension_reason text DEFAULT NULL) RETURNS trustwork.federation_peer
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_node uuid := trustwork.federation_node();
  v_row trustwork.federation_peer%ROWTYPE;
  v_record trustwork.peering_record%ROWTYPE;
BEGIN
  IF NOT trustwork.federation_host_ok(p_peer) THEN
    RAISE EXCEPTION 'a peer is a DNS name' USING ERRCODE = 'invalid_parameter_value', HINT = 'federation.host_invalid';
  END IF;
  IF NOT p_admitted AND p_suspension_reason IS NULL THEN
    RAISE EXCEPTION 'a refusal states why flows pause' USING ERRCODE = 'invalid_parameter_value', HINT = 'federation.context_invalid';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('trustwork.federation_peer:' || p_peer, 0));
  INSERT INTO trustwork.federation_peer (node_id, peer_node, manifest, manifest_digest, manifest_issued_at, manifest_fetched_at, refresh_due_at, current_key_id, attestation_expires_at,
    admission_state, admission_decided_at, admission_judged, admission_trigger)
  VALUES (v_node, p_peer, p_manifest, p_digest, p_issued_at, now(), now() + interval '24 hours', p_current_key, p_attestation_expires,
    CASE WHEN p_admitted THEN 'admitted' ELSE 'refused' END, now(), p_judged, p_trigger)
  ON CONFLICT (node_id, peer_node) DO UPDATE SET manifest = EXCLUDED.manifest, manifest_digest = EXCLUDED.manifest_digest, manifest_issued_at = EXCLUDED.manifest_issued_at,
    manifest_fetched_at = now(), refresh_due_at = now() + interval '24 hours', current_key_id = EXCLUDED.current_key_id, attestation_expires_at = EXCLUDED.attestation_expires_at,
    admission_state = EXCLUDED.admission_state, admission_decided_at = now(), admission_judged = EXCLUDED.admission_judged, admission_trigger = EXCLUDED.admission_trigger,
    revision = trustwork.federation_peer.revision + 1
  RETURNING * INTO v_row;
  IF NOT p_admitted THEN
    FOR v_record IN SELECT * FROM trustwork.peering_record WHERE node_id = v_node AND peer_node = p_peer AND state = 'active' AND suspended_at IS NULL FOR UPDATE LOOP
      UPDATE trustwork.peering_record SET suspended_at = now(), suspension_reason = p_suspension_reason, revision = revision + 1 WHERE id = v_record.id;
      PERFORM trustwork.federation_event(v_record.id, 'peering.suspended', NULL, 'active', 'active', NULL, jsonb_build_object('reason', p_suspension_reason, 'trigger', p_trigger));
    END LOOP;
  ELSE
    FOR v_record IN SELECT * FROM trustwork.peering_record WHERE node_id = v_node AND peer_node = p_peer AND state = 'active'
        AND suspension_reason IN ('admission_refused', 'attestation_expired') FOR UPDATE LOOP
      UPDATE trustwork.peering_record SET suspended_at = NULL, suspension_reason = NULL, revision = revision + 1 WHERE id = v_record.id;
      PERFORM trustwork.federation_event(v_record.id, 'peering.suspension_lifted', NULL, 'active', 'active', NULL, jsonb_build_object('trigger', p_trigger));
    END LOOP;
  END IF;
  RETURN v_row;
END $$;

-- Two different successors signed by one key: stop trusting new signatures and suspend every flow (protocol section 5).
CREATE FUNCTION trustwork.federation_peer_equivocation(p_peer text) RETURNS trustwork.federation_peer
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_node uuid := trustwork.federation_node();
  v_row trustwork.federation_peer%ROWTYPE;
  v_record trustwork.peering_record%ROWTYPE;
BEGIN
  UPDATE trustwork.federation_peer SET equivocation_at = coalesce(equivocation_at, now()), revision = revision + 1 WHERE node_id = v_node AND peer_node = p_peer RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown peer' USING ERRCODE = 'no_data_found', HINT = 'federation.unknown_peer';
  END IF;
  FOR v_record IN SELECT * FROM trustwork.peering_record WHERE node_id = v_node AND peer_node = p_peer AND state = 'active' AND suspended_at IS NULL FOR UPDATE LOOP
    UPDATE trustwork.peering_record SET suspended_at = now(), suspension_reason = 'equivocation', revision = revision + 1 WHERE id = v_record.id;
    PERFORM trustwork.federation_event(v_record.id, 'peering.suspended', NULL, 'active', 'active', NULL, jsonb_build_object('reason', 'equivocation'));
  END LOOP;
  RETURN v_row;
END $$;

-- Serializes the records of one (peer node, local hub, peer hub) pair.
CREATE FUNCTION trustwork.federation_lock_pair(p_peer text, p_local_hub uuid, p_peer_hub text) RETURNS void
LANGUAGE sql VOLATILE AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('trustwork.peering:' || p_peer || ':' || p_local_hub::text || ':' || p_peer_hub, 0))
$$;

-- A handshake we admitted. Either the peer answers our own request (an outgoing record awaiting the peer) or it opens
-- a new incoming request that a person of the hub must accept. A repeated handshake for an open record is idempotent.
CREATE FUNCTION trustwork.federation_handshake_received(p_peer text, p_peer_hub text, p_local_hub uuid, p_level text, p_licences jsonb, p_tombstone_hours integer, p_agent_rate integer,
  p_manifest_digest text, p_key_id text) RETURNS trustwork.peering_record
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_node uuid := trustwork.federation_node();
  v_peer trustwork.federation_peer%ROWTYPE;
  v_row trustwork.peering_record%ROWTYPE;
  v_level text;
BEGIN
  -- Concurrent handshakes for one hub pair serialize here, so a repeated or racing handshake finds the first record.
  PERFORM trustwork.federation_lock_pair(p_peer, p_local_hub, p_peer_hub);
  SELECT * INTO v_peer FROM trustwork.federation_peer WHERE node_id = v_node AND peer_node = p_peer FOR SHARE;
  IF NOT FOUND OR NOT trustwork.federation_peer_current(v_peer) THEN
    RAISE EXCEPTION 'the peer is not admitted' USING ERRCODE = 'insufficient_privilege', HINT = 'federation.peer_restricted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trustwork.federation_manifest_hubs() m WHERE m.hub_id = p_local_hub) THEN
    RAISE EXCEPTION 'no such hub' USING ERRCODE = 'no_data_found', HINT = 'federation.unknown_hub';
  END IF;
  SELECT * INTO v_row FROM trustwork.peering_record WHERE node_id = v_node AND local_hub_id = p_local_hub AND peer_node = p_peer AND peer_hub_id = p_peer_hub AND state <> 'ended' FOR UPDATE;
  IF FOUND THEN
    IF v_row.state = 'active' THEN
      RETURN v_row;
    END IF;
    IF v_row.direction = 'outgoing' AND v_row.phase = 'awaiting_peer' THEN
      -- The peer may grant less than we asked; a second person's approval of a higher level covers the lower one.
      v_level := trustwork.federation_lower_level(v_row.level, p_level);
      UPDATE trustwork.peering_record SET level = v_level, peer_accepted_at = now(), peer_manifest_digest = p_manifest_digest, peer_key_id = p_key_id,
        licences = p_licences, tombstone_hours = least(tombstone_hours, p_tombstone_hours), agent_envelopes_per_hour = least(agent_envelopes_per_hour, p_agent_rate),
        state = 'active', phase = 'complete', revision = revision + 1 WHERE id = v_row.id RETURNING * INTO v_row;
      PERFORM trustwork.federation_event(v_row.id, 'peering.peer_accepted', NULL, 'pending_approval', 'active', NULL, jsonb_build_object('level', v_level));
      RETURN v_row;
    END IF;
    -- An incoming request repeated while we decide: nothing changes.
    RETURN v_row;
  END IF;
  INSERT INTO trustwork.peering_record (node_id, local_hub_id, peer_node, peer_hub_id, direction, level, state, phase, licences, tombstone_hours, agent_envelopes_per_hour,
    peer_manifest_digest, peer_key_id, admission_decided_at, admission_judged, peer_accepted_at)
  VALUES (v_node, p_local_hub, p_peer, p_peer_hub, 'incoming', p_level, 'pending_approval', 'awaiting_acceptance', p_licences, p_tombstone_hours, p_agent_rate,
    p_manifest_digest, p_key_id, v_peer.admission_decided_at, v_peer.admission_judged, now()) RETURNING * INTO v_row;
  PERFORM trustwork.federation_event(v_row.id, 'peering.requested_by_peer', NULL, NULL, 'pending_approval', NULL, jsonb_build_object('level', p_level));
  RETURN v_row;
END $$;

-- The peer's answer to the handshake we sent for this record.
CREATE FUNCTION trustwork.federation_peer_answered(p_record uuid, p_outcome text, p_level text, p_state text, p_code text) RETURNS trustwork.peering_record
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.peering_record%ROWTYPE;
  v_level text;
BEGIN
  SELECT * INTO v_row FROM trustwork.peering_record WHERE id = p_record FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such peering record' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF v_row.state = 'ended' OR v_row.phase <> 'awaiting_peer' THEN
    RETURN v_row;
  END IF;
  IF p_outcome = 'refused' THEN
    UPDATE trustwork.peering_record SET state = 'ended', end_reason = 'refused_by_peer', phase = 'complete', revision = revision + 1 WHERE id = p_record RETURNING * INTO v_row;
    PERFORM trustwork.federation_event(v_row.id, 'peering.refused_by_peer', NULL, 'pending_approval', 'ended', NULL, jsonb_build_object('code', coalesce(p_code, 'federation.peer_restricted')));
    RETURN v_row;
  END IF;
  v_level := trustwork.federation_lower_level(v_row.level, p_level);
  IF v_row.direction = 'incoming' OR p_state = 'active' THEN
    -- Our acceptance reached the peer (incoming), or the peer's record is already active (it accepted before we asked again).
    UPDATE trustwork.peering_record SET level = v_level, peer_accepted_at = coalesce(peer_accepted_at, now()), state = 'active', phase = 'complete', revision = revision + 1
     WHERE id = p_record RETURNING * INTO v_row;
    PERFORM trustwork.federation_event(v_row.id, 'peering.activated', NULL, 'pending_approval', 'active', NULL, jsonb_build_object('level', v_level));
    RETURN v_row;
  END IF;
  -- Our request was admitted and waits for a person on the peer's side.
  IF v_level <> v_row.level THEN
    UPDATE trustwork.peering_record SET level = v_level, revision = revision + 1 WHERE id = p_record RETURNING * INTO v_row;
  END IF;
  PERFORM trustwork.federation_event(v_row.id, 'peering.admitted_by_peer', NULL, 'pending_approval', 'pending_approval', NULL, jsonb_build_object('level', v_level, 'peerState', p_state));
  RETURN v_row;
END $$;

-- Stores a refusal record of our admission check (the subject is a node name or a case reference, never an address).
CREATE FUNCTION trustwork.federation_refusal_record(p_service text, p_subject text, p_decided_at timestamptz, p_findings jsonb, p_geolocation jsonb) RETURNS trustwork.admission_refusal
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.admission_refusal%ROWTYPE;
BEGIN
  IF p_subject IS NOT NULL AND trustwork.federation_is_address(p_subject) THEN
    RAISE EXCEPTION 'a subject is never a network address' USING ERRCODE = 'invalid_parameter_value', HINT = 'federation.subject_is_address';
  END IF;
  INSERT INTO trustwork.admission_refusal (node_id, service, subject, decided_at, findings, geolocation)
  VALUES (trustwork.federation_node(), p_service, p_subject, p_decided_at, p_findings, p_geolocation) RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- Remembers (peer, key, nonce) until the signature expires; false means a replay.
CREATE FUNCTION trustwork.federation_note_nonce(p_peer text, p_key_id text, p_nonce text, p_expires_at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_inserted integer;
BEGIN
  INSERT INTO trustwork.federation_nonce (node_id, peer_node, key_id, nonce, expires_at) VALUES (trustwork.federation_node(), p_peer, p_key_id, p_nonce, p_expires_at)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted = 1;
END $$;
CREATE FUNCTION trustwork.federation_purge_nonces() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM trustwork.federation_nonce WHERE expires_at < now() - interval '5 minutes';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END $$;

-- Records the admission re-run before the first delivery of a deal; the first decision for a deal stands.
CREATE FUNCTION trustwork.federation_deal_admission(p_peer text, p_deal_ref text, p_outcome text) RETURNS trustwork.peer_deal_admission
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_node uuid := trustwork.federation_node();
  v_row trustwork.peer_deal_admission%ROWTYPE;
BEGIN
  INSERT INTO trustwork.peer_deal_admission (node_id, peer_node, deal_ref, outcome) VALUES (v_node, p_peer, p_deal_ref, p_outcome)
  ON CONFLICT (node_id, peer_node, deal_ref) DO NOTHING RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN
    SELECT * INTO v_row FROM trustwork.peer_deal_admission WHERE node_id = v_node AND peer_node = p_peer AND deal_ref = p_deal_ref;
  END IF;
  RETURN v_row;
END $$;

-- Records a revocation a peer published (once per key) with how many held objects were flagged for re-verification.
CREATE FUNCTION trustwork.federation_revocation_noticed(p_peer text, p_key_id text, p_compromised_since timestamptz, p_revoked_at timestamptz, p_objects integer) RETURNS trustwork.peer_key_revocation
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_node uuid := trustwork.federation_node();
  v_row trustwork.peer_key_revocation%ROWTYPE;
BEGIN
  INSERT INTO trustwork.peer_key_revocation (node_id, peer_node, key_id, compromised_since, revoked_at, objects_flagged) VALUES (v_node, p_peer, p_key_id, p_compromised_since, p_revoked_at, p_objects)
  ON CONFLICT (node_id, peer_node, key_id) DO UPDATE SET objects_flagged = trustwork.peer_key_revocation.objects_flagged + EXCLUDED.objects_flagged RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- May a flow of this level run with the peer now? 'ok', or the protocol error code that refuses it. Suspended and
-- pending records refuse as not peered; a peer whose admission lapsed or whose attestation expired is restricted.
CREATE FUNCTION trustwork.federation_flow_allowed(p_peer text, p_required_level text, p_hub uuid DEFAULT NULL) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_node uuid := (SELECT id FROM trustwork.admin_node LIMIT 1);
  v_peer trustwork.federation_peer%ROWTYPE;
  v_best text;
BEGIN
  IF v_node IS NULL THEN
    RETURN 'federation.not_peered';
  END IF;
  SELECT * INTO v_peer FROM trustwork.federation_peer WHERE node_id = v_node AND peer_node = p_peer;
  IF NOT FOUND THEN
    RETURN 'federation.not_peered';
  END IF;
  IF NOT trustwork.federation_peer_current(v_peer) THEN
    RETURN 'federation.peer_restricted';
  END IF;
  SELECT r.level INTO v_best FROM trustwork.peering_record r WHERE r.node_id = v_node AND r.peer_node = p_peer AND r.state = 'active' AND r.suspended_at IS NULL
    AND (p_hub IS NULL OR r.local_hub_id = p_hub) ORDER BY trustwork.federation_level_rank(r.level) DESC LIMIT 1;
  IF v_best IS NULL THEN
    RETURN 'federation.not_peered';
  END IF;
  IF trustwork.federation_level_rank(v_best) < trustwork.federation_level_rank(p_required_level) THEN
    RETURN 'federation.level_insufficient';
  END IF;
  RETURN 'ok';
END $$;

-- Protocol readers for the node's own process: a peer, its open records, the peers due for a refresh.
CREATE FUNCTION trustwork.federation_peer_get(p_peer text) RETURNS SETOF trustwork.federation_peer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT * FROM trustwork.federation_peer WHERE node_id = (SELECT id FROM trustwork.admin_node LIMIT 1) AND peer_node = p_peer
$$;
CREATE FUNCTION trustwork.federation_records_of_peer(p_peer text) RETURNS SETOF trustwork.peering_record
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT * FROM trustwork.peering_record WHERE node_id = (SELECT id FROM trustwork.admin_node LIMIT 1) AND peer_node = p_peer ORDER BY started_at, id
$$;
CREATE FUNCTION trustwork.federation_record_get(p_record uuid) RETURNS SETOF trustwork.peering_record
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT * FROM trustwork.peering_record WHERE id = p_record
$$;
CREATE FUNCTION trustwork.federation_peers_due(p_now timestamptz, p_limit integer DEFAULT 100) RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT peer_node FROM trustwork.federation_peer WHERE node_id = (SELECT id FROM trustwork.admin_node LIMIT 1) AND refresh_due_at <= p_now
  ORDER BY refresh_due_at LIMIT greatest(1, least(p_limit, 1000))
$$;

-- 9. Staff commands (SECURITY DEFINER, allowlisted for the runtime role) ------------------------------------------------
-- The node identity and the genesis key: node staff holding admin.node.hubs.manage, once. The sealed seed arrives
-- already encrypted by the process (the database never sees a plaintext seed).
CREATE FUNCTION trustwork.federation_init_identity(p_ctx jsonb, p_host text, p_engine_version text, p_engine_source text, p_operator_name text, p_registration_kind text,
  p_registration_value text, p_abuse_contact text, p_takedown_contact text, p_jurisdiction text, p_licences jsonb, p_tombstone_hours integer, p_offered text[], p_agent_rate integer,
  p_key_id text, p_public_key text, p_valid_from timestamptz, p_ciphertext bytea, p_iv bytea, p_auth_tag bytea, p_wrapped_key bytea, p_kek_id text) RETURNS trustwork.node_identity
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_node uuid := trustwork.federation_node();
  v_actor trustwork.admin_actor;
  v_row trustwork.node_identity%ROWTYPE;
BEGIN
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.node.hubs.manage'], v_node, NULL);
  PERFORM pg_advisory_xact_lock(hashtextextended('trustwork.node_identity:' || v_node::text, 0));
  IF EXISTS (SELECT 1 FROM trustwork.node_identity WHERE node_id = v_node) THEN
    RAISE EXCEPTION 'the node identity exists; update it' USING ERRCODE = 'unique_violation', HINT = 'federation.identity_exists';
  END IF;
  INSERT INTO trustwork.node_identity (node_id, host, engine_version, engine_source, operator_name, operator_registration_kind, operator_registration_value, abuse_contact, takedown_contact,
    jurisdiction, licences, tombstone_hours, offered_levels, agent_envelopes_per_hour, created_by)
  VALUES (v_node, p_host, p_engine_version, p_engine_source, p_operator_name, p_registration_kind, p_registration_value, p_abuse_contact, p_takedown_contact, p_jurisdiction, p_licences,
    p_tombstone_hours, p_offered, p_agent_rate, v_actor.person_id) RETURNING * INTO v_row;
  INSERT INTO trustwork.node_key (node_id, key_id, position, public_key, valid_from, created_by) VALUES (v_node, p_key_id, 1, p_public_key, p_valid_from, v_actor.person_id);
  INSERT INTO trustwork.node_key_secret (node_id, key_id, ciphertext, iv, auth_tag, wrapped_key, kek_id) VALUES (v_node, p_key_id, p_ciphertext, p_iv, p_auth_tag, p_wrapped_key, p_kek_id);
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_node, NULL, 'federation.node_initialized', 'node_identity', v_node, NULL,
    to_jsonb(v_row) || jsonb_build_object('keyId', p_key_id, 'publicKey', p_public_key));
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.federation_update_identity(p_ctx jsonb, p_expected_revision integer, p_engine_version text, p_engine_source text, p_operator_name text, p_registration_kind text,
  p_registration_value text, p_abuse_contact text, p_takedown_contact text, p_jurisdiction text, p_licences jsonb, p_tombstone_hours integer, p_offered text[], p_agent_rate integer)
RETURNS trustwork.node_identity
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_node uuid := trustwork.federation_node();
  v_actor trustwork.admin_actor;
  v_before trustwork.node_identity%ROWTYPE;
  v_row trustwork.node_identity%ROWTYPE;
BEGIN
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.node.hubs.manage'], v_node, NULL);
  SELECT * INTO v_before FROM trustwork.node_identity WHERE node_id = v_node FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the node identity is not initialized' USING ERRCODE = 'no_data_found', HINT = 'federation.no_identity';
  END IF;
  IF v_before.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'the identity changed; reload' USING ERRCODE = 'serialization_failure', HINT = 'federation.revision_conflict';
  END IF;
  UPDATE trustwork.node_identity SET engine_version = p_engine_version, engine_source = p_engine_source, operator_name = p_operator_name, operator_registration_kind = p_registration_kind,
    operator_registration_value = p_registration_value, abuse_contact = p_abuse_contact, takedown_contact = p_takedown_contact, jurisdiction = p_jurisdiction, licences = p_licences,
    tombstone_hours = p_tombstone_hours, offered_levels = p_offered, agent_envelopes_per_hour = p_agent_rate, revision = revision + 1 WHERE node_id = v_node RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_node, NULL, 'federation.node_updated', 'node_identity', v_node, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Rotation: the current key retires at p_rotated_at and the next key becomes valid then; the hand-over statement was
-- signed by the current key in the process (the database checks the chain shape, the approval and the audit). A
-- compromise date publishes a revocation of the retiring key. Second-person action ops.rotate_node_key.
CREATE FUNCTION trustwork.federation_rotate_key(p_ctx jsonb, p_approval_id uuid, p_previous_key_id text, p_next_key_id text, p_public_key text, p_rotated_at timestamptz,
  p_rotation_signature text, p_compromised_since timestamptz, p_ciphertext bytea, p_iv bytea, p_auth_tag bytea, p_wrapped_key bytea, p_kek_id text) RETURNS trustwork.node_key
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_node uuid := trustwork.federation_node();
  v_actor trustwork.admin_actor;
  v_previous trustwork.node_key%ROWTYPE;
  v_row trustwork.node_key%ROWTYPE;
  v_approval trustwork.second_person_approval%ROWTYPE;
BEGIN
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.node.keys.rotate'], v_node, NULL);
  PERFORM pg_advisory_xact_lock(hashtextextended('trustwork.node_key:' || v_node::text, 0));
  SELECT * INTO v_previous FROM trustwork.node_key WHERE node_id = v_node AND key_id = p_previous_key_id FOR UPDATE;
  IF NOT FOUND OR v_previous.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'the rotation names the current key' USING ERRCODE = 'check_violation', HINT = 'federation.not_current_key';
  END IF;
  IF p_rotated_at < v_previous.valid_from OR p_rotated_at > now() + interval '1 hour' OR p_rotated_at < now() - interval '1 hour' THEN
    RAISE EXCEPTION 'a rotation takes effect now' USING ERRCODE = 'check_violation', HINT = 'federation.rotation_time';
  END IF;
  IF p_compromised_since IS NOT NULL AND (p_compromised_since < v_previous.valid_from OR p_compromised_since > p_rotated_at) THEN
    RAISE EXCEPTION 'a compromise lies within the key''s validity' USING ERRCODE = 'check_violation', HINT = 'federation.compromise_time';
  END IF;
  IF p_approval_id IS NULL THEN
    RAISE EXCEPTION 'a key rotation needs a second person' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_required';
  END IF;
  -- Consume before the write: the approval binds this predecessor and this compromise statement.
  v_approval := trustwork.admin_consume_approval(p_approval_id, 'ops.rotate_node_key', 'node', v_node, NULL, trustwork.federation_rotation_digest(v_node, p_previous_key_id, p_compromised_since), v_node);
  UPDATE trustwork.node_key SET retired_at = p_rotated_at, compromised_since = p_compromised_since, revoked_at = CASE WHEN p_compromised_since IS NULL THEN NULL ELSE now() END
   WHERE node_id = v_node AND key_id = p_previous_key_id;
  INSERT INTO trustwork.node_key (node_id, key_id, position, public_key, valid_from, rotation_previous_key_id, rotation_signature, created_by)
  VALUES (v_node, p_next_key_id, v_previous.position + 1, p_public_key, p_rotated_at, p_previous_key_id, p_rotation_signature, v_actor.person_id) RETURNING * INTO v_row;
  INSERT INTO trustwork.node_key_secret (node_id, key_id, ciphertext, iv, auth_tag, wrapped_key, kek_id) VALUES (v_node, p_next_key_id, p_ciphertext, p_iv, p_auth_tag, p_wrapped_key, p_kek_id);
  PERFORM trustwork.admin_record(v_actor, p_ctx, v_node, NULL, 'federation.key_rotated', 'node_key', v_node, to_jsonb(v_previous),
    to_jsonb(v_row) || jsonb_build_object('revocation', p_compromised_since IS NOT NULL), NULL, p_approval_id);
  RETURN v_row;
END $$;

-- Who may edit peering at a hub.
CREATE FUNCTION trustwork.federation_require_record(p_record uuid, p_expected_revision integer) RETURNS trustwork.peering_record
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_row trustwork.peering_record%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM trustwork.peering_record WHERE id = p_record FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such peering record' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF v_row.state = 'ended' THEN
    RAISE EXCEPTION 'an ended peering record never changes; a new connection needs a new request' USING ERRCODE = 'check_violation', HINT = 'federation.ended';
  END IF;
  IF v_row.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'the record changed; reload' USING ERRCODE = 'serialization_failure', HINT = 'federation.revision_conflict';
  END IF;
  RETURN v_row;
END $$;

-- A person of the hub asks a peer to connect. The process fetched and admitted the peer's manifest first (the peer row
-- is admitted); deal_routing and identity consume an approval of exactly this peering.
CREATE FUNCTION trustwork.federation_request_peering(p_ctx jsonb, p_local_hub uuid, p_peer text, p_peer_hub text, p_level text, p_licences jsonb, p_tombstone_hours integer,
  p_agent_rate integer, p_approval_id uuid) RETURNS trustwork.peering_record
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_node uuid := trustwork.federation_node();
  v_actor trustwork.admin_actor;
  v_peer trustwork.federation_peer%ROWTYPE;
  v_identity trustwork.node_identity%ROWTYPE;
  v_approval trustwork.second_person_approval%ROWTYPE;
  v_row trustwork.peering_record%ROWTYPE;
  v_id uuid := trustwork.new_uuid();
BEGIN
  PERFORM trustwork.hubs_require_hub(p_local_hub);
  -- An unlaunched hub is refused exactly like an unknown one, before any permission is resolved, so nothing leaks about it.
  IF NOT EXISTS (SELECT 1 FROM trustwork.federation_manifest_hubs() m WHERE m.hub_id = p_local_hub) THEN
    RAISE EXCEPTION 'no such hub' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.federation.peer.edit'], NULL, p_local_hub);
  SELECT * INTO v_identity FROM trustwork.node_identity WHERE node_id = v_node;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the node identity is not initialized' USING ERRCODE = 'object_not_in_prerequisite_state', HINT = 'federation.no_identity';
  END IF;
  IF v_identity.host = p_peer THEN
    RAISE EXCEPTION 'a node does not peer with itself' USING ERRCODE = 'check_violation', HINT = 'federation.self_peering';
  END IF;
  IF NOT (p_level = ANY (v_identity.offered_levels)) THEN
    RAISE EXCEPTION 'a node requests only a level it offers itself' USING ERRCODE = 'check_violation', HINT = 'federation.level_not_offered';
  END IF;
  PERFORM trustwork.federation_lock_pair(p_peer, p_local_hub, p_peer_hub);
  SELECT * INTO v_peer FROM trustwork.federation_peer WHERE node_id = v_node AND peer_node = p_peer FOR SHARE;
  IF NOT FOUND OR NOT trustwork.federation_peer_current(v_peer) THEN
    RAISE EXCEPTION 'the peer is not admitted' USING ERRCODE = 'insufficient_privilege', HINT = 'federation.peer_restricted';
  END IF;
  IF p_level = ANY (trustwork.federation_second_approver_levels()) THEN
    IF p_approval_id IS NULL THEN
      RAISE EXCEPTION 'deal_routing and identity need a second approver' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_required';
    END IF;
    v_approval := trustwork.admin_consume_approval(p_approval_id, 'federation.raise_peering_level', 'hub', NULL, p_local_hub,
      trustwork.federation_peering_digest(p_local_hub, p_peer, p_peer_hub, p_level), v_id);
  ELSIF p_approval_id IS NOT NULL THEN
    RAISE EXCEPTION 'syndicate and trust_verifications need no approval' USING ERRCODE = 'check_violation', HINT = 'admin.approval_mismatch';
  END IF;
  INSERT INTO trustwork.peering_record (id, node_id, local_hub_id, peer_node, peer_hub_id, direction, level, state, phase, licences, tombstone_hours, agent_envelopes_per_hour,
    peer_manifest_digest, peer_key_id, admission_decided_at, admission_judged, requested_by, local_accepted_at, second_approver_id, approval_id)
  VALUES (v_id, v_node, p_local_hub, p_peer, p_peer_hub, 'outgoing', p_level, 'pending_approval', 'awaiting_peer', p_licences, p_tombstone_hours, p_agent_rate,
    v_peer.manifest_digest, v_peer.current_key_id, v_peer.admission_decided_at, v_peer.admission_judged, v_actor.person_id, now(), v_approval.approved_by, p_approval_id)
  RETURNING * INTO v_row;
  PERFORM trustwork.federation_event(v_row.id, 'peering.requested', v_actor.person_id, NULL, 'pending_approval', p_ctx ->> 'reasonText', jsonb_build_object('level', p_level));
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_local_hub, CASE WHEN p_approval_id IS NULL THEN 'federation.peering_requested' ELSE 'federation.raise_peering_level' END,
    'peering_record', v_row.id, NULL, to_jsonb(v_row), NULL, p_approval_id);
  RETURN v_row;
END $$;

-- A person of the hub accepts an incoming request, at most at the requested level; the acceptance handshake goes back
-- to the peer afterwards and the record activates on the peer's answer (federation_peer_answered).
CREATE FUNCTION trustwork.federation_accept_peering(p_ctx jsonb, p_record uuid, p_expected_revision integer, p_level text, p_approval_id uuid) RETURNS trustwork.peering_record
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_before trustwork.peering_record%ROWTYPE;
  v_row trustwork.peering_record%ROWTYPE;
  v_approval trustwork.second_person_approval%ROWTYPE;
  v_identity trustwork.node_identity%ROWTYPE;
BEGIN
  v_before := trustwork.federation_require_record(p_record, p_expected_revision);
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.federation.peer.edit'], NULL, v_before.local_hub_id);
  IF v_before.direction <> 'incoming' OR v_before.state <> 'pending_approval' OR v_before.phase NOT IN ('awaiting_acceptance', 'awaiting_second_approver') THEN
    RAISE EXCEPTION 'only an incoming request awaiting a person is accepted' USING ERRCODE = 'check_violation', HINT = 'federation.invalid_transition';
  END IF;
  IF trustwork.federation_level_rank(p_level) > trustwork.federation_level_rank(v_before.level) THEN
    RAISE EXCEPTION 'acceptance grants at most the requested level' USING ERRCODE = 'check_violation', HINT = 'federation.level_above_request';
  END IF;
  SELECT * INTO v_identity FROM trustwork.node_identity WHERE node_id = v_before.node_id;
  IF NOT FOUND OR NOT (p_level = ANY (v_identity.offered_levels)) THEN
    RAISE EXCEPTION 'a node accepts only a level it offers itself' USING ERRCODE = 'check_violation', HINT = 'federation.level_not_offered';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trustwork.federation_peer p WHERE p.node_id = v_before.node_id AND p.peer_node = v_before.peer_node AND trustwork.federation_peer_current(p)) THEN
    RAISE EXCEPTION 'the peer is not admitted' USING ERRCODE = 'insufficient_privilege', HINT = 'federation.peer_restricted';
  END IF;
  IF p_level = ANY (trustwork.federation_second_approver_levels()) THEN
    IF p_approval_id IS NULL THEN
      RAISE EXCEPTION 'deal_routing and identity need a second approver' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_required';
    END IF;
    v_approval := trustwork.admin_consume_approval(p_approval_id, 'federation.raise_peering_level', 'hub', NULL, v_before.local_hub_id,
      trustwork.federation_peering_digest(v_before.local_hub_id, v_before.peer_node, v_before.peer_hub_id, p_level), p_record);
  ELSIF p_approval_id IS NOT NULL THEN
    RAISE EXCEPTION 'syndicate and trust_verifications need no approval' USING ERRCODE = 'check_violation', HINT = 'admin.approval_mismatch';
  END IF;
  -- The accepting person is the local person of record for an incoming request.
  UPDATE trustwork.peering_record SET level = p_level, phase = 'awaiting_peer', local_accepted_at = now(), requested_by = v_actor.person_id,
    second_approver_id = v_approval.approved_by, approval_id = p_approval_id, revision = revision + 1 WHERE id = p_record RETURNING * INTO v_row;
  PERFORM trustwork.federation_event(v_row.id, 'peering.accepted', v_actor.person_id, 'pending_approval', 'pending_approval', p_ctx ->> 'reasonText', jsonb_build_object('level', p_level));
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.local_hub_id, CASE WHEN p_approval_id IS NULL THEN 'federation.peering_accepted' ELSE 'federation.raise_peering_level' END,
    'peering_record', v_row.id, to_jsonb(v_before), to_jsonb(v_row), NULL, p_approval_id);
  RETURN v_row;
END $$;

-- Marks the record as awaiting the second approver while the approval request is open (console state only).
CREATE FUNCTION trustwork.federation_await_second_approver(p_ctx jsonb, p_record uuid, p_expected_revision integer) RETURNS trustwork.peering_record
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.peering_record%ROWTYPE;
  v_row trustwork.peering_record%ROWTYPE;
BEGIN
  v_before := trustwork.federation_require_record(p_record, p_expected_revision);
  PERFORM trustwork.admin_authorize(p_ctx, ARRAY['admin.federation.peer.edit'], NULL, v_before.local_hub_id);
  IF v_before.direction <> 'incoming' OR v_before.phase <> 'awaiting_acceptance' THEN
    RETURN v_before;
  END IF;
  UPDATE trustwork.peering_record SET phase = 'awaiting_second_approver', revision = revision + 1 WHERE id = p_record RETURNING * INTO v_row;
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.federation_decline_peering(p_ctx jsonb, p_record uuid, p_expected_revision integer) RETURNS trustwork.peering_record
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_before trustwork.peering_record%ROWTYPE;
  v_row trustwork.peering_record%ROWTYPE;
BEGIN
  v_before := trustwork.federation_require_record(p_record, p_expected_revision);
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.federation.peer.edit'], NULL, v_before.local_hub_id);
  IF v_before.state <> 'pending_approval' THEN
    RAISE EXCEPTION 'only a pending request is declined; end an active peering' USING ERRCODE = 'check_violation', HINT = 'federation.invalid_transition';
  END IF;
  UPDATE trustwork.peering_record SET state = 'ended', end_reason = 'declined', phase = 'complete', ended_by = v_actor.person_id, revision = revision + 1 WHERE id = p_record RETURNING * INTO v_row;
  PERFORM trustwork.federation_event(v_row.id, 'peering.declined', v_actor.person_id, 'pending_approval', 'ended', p_ctx ->> 'reasonText');
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.local_hub_id, 'federation.peering_declined', 'peering_record', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Protective one-person commands with a reason: lower the level, suspend, end (defederate).
CREATE FUNCTION trustwork.federation_lower_peering(p_ctx jsonb, p_record uuid, p_expected_revision integer, p_level text) RETURNS trustwork.peering_record
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_before trustwork.peering_record%ROWTYPE;
  v_row trustwork.peering_record%ROWTYPE;
BEGIN
  v_before := trustwork.federation_require_record(p_record, p_expected_revision);
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.federation.peer.edit'], NULL, v_before.local_hub_id);
  IF v_before.state <> 'active' OR trustwork.federation_level_rank(p_level) >= trustwork.federation_level_rank(v_before.level) THEN
    RAISE EXCEPTION 'lowering names a level below the current one of an active peering' USING ERRCODE = 'check_violation', HINT = 'federation.invalid_transition';
  END IF;
  UPDATE trustwork.peering_record SET level = p_level, revision = revision + 1 WHERE id = p_record RETURNING * INTO v_row;
  PERFORM trustwork.federation_event(v_row.id, 'peering.lowered', v_actor.person_id, 'active', 'active', p_ctx ->> 'reasonText', jsonb_build_object('from', v_before.level, 'to', p_level));
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.local_hub_id, 'federation.peering_lowered', 'peering_record', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.federation_suspend_peering(p_ctx jsonb, p_record uuid, p_expected_revision integer) RETURNS trustwork.peering_record
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_before trustwork.peering_record%ROWTYPE;
  v_row trustwork.peering_record%ROWTYPE;
BEGIN
  v_before := trustwork.federation_require_record(p_record, p_expected_revision);
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.federation.peer.edit'], NULL, v_before.local_hub_id);
  IF v_before.state <> 'active' OR v_before.suspended_at IS NOT NULL THEN
    RAISE EXCEPTION 'only an active, unsuspended peering is suspended' USING ERRCODE = 'check_violation', HINT = 'federation.invalid_transition';
  END IF;
  UPDATE trustwork.peering_record SET suspended_at = now(), suspension_reason = 'operator', revision = revision + 1 WHERE id = p_record RETURNING * INTO v_row;
  PERFORM trustwork.federation_event(v_row.id, 'peering.suspended', v_actor.person_id, 'active', 'active', p_ctx ->> 'reasonText', jsonb_build_object('reason', 'operator'));
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.local_hub_id, 'federation.peering_suspended', 'peering_record', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Lifting an operator suspension; a suspension the admission check caused lifts only through a renewed admission.
CREATE FUNCTION trustwork.federation_lift_suspension(p_ctx jsonb, p_record uuid, p_expected_revision integer) RETURNS trustwork.peering_record
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_before trustwork.peering_record%ROWTYPE;
  v_row trustwork.peering_record%ROWTYPE;
BEGIN
  v_before := trustwork.federation_require_record(p_record, p_expected_revision);
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.federation.peer.edit'], NULL, v_before.local_hub_id);
  IF v_before.state <> 'active' OR v_before.suspension_reason IS DISTINCT FROM 'operator' THEN
    RAISE EXCEPTION 'only an operator suspension is lifted by a person; the admission check lifts its own' USING ERRCODE = 'check_violation', HINT = 'federation.invalid_transition';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trustwork.federation_peer p WHERE p.node_id = v_before.node_id AND p.peer_node = v_before.peer_node AND trustwork.federation_peer_current(p)
      AND p.equivocation_at IS NULL) THEN
    RAISE EXCEPTION 'the peer is not admitted' USING ERRCODE = 'insufficient_privilege', HINT = 'federation.peer_restricted';
  END IF;
  UPDATE trustwork.peering_record SET suspended_at = NULL, suspension_reason = NULL, revision = revision + 1 WHERE id = p_record RETURNING * INTO v_row;
  PERFORM trustwork.federation_event(v_row.id, 'peering.suspension_lifted', v_actor.person_id, 'active', 'active', p_ctx ->> 'reasonText');
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.local_hub_id, 'federation.peering_suspension_lifted', 'peering_record', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Defederation: ends the record for good; feeds and new deliveries stop, history stays (MSH-F05).
CREATE FUNCTION trustwork.federation_end_peering(p_ctx jsonb, p_record uuid, p_expected_revision integer) RETURNS trustwork.peering_record
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor;
  v_before trustwork.peering_record%ROWTYPE;
  v_row trustwork.peering_record%ROWTYPE;
BEGIN
  v_before := trustwork.federation_require_record(p_record, p_expected_revision);
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.federation.defederate'], NULL, v_before.local_hub_id);
  UPDATE trustwork.peering_record SET state = 'ended', end_reason = 'defederated', phase = 'complete', ended_by = v_actor.person_id, revision = revision + 1 WHERE id = p_record RETURNING * INTO v_row;
  PERFORM trustwork.federation_event(v_row.id, 'peering.defederated', v_actor.person_id, v_before.state, 'ended', p_ctx ->> 'reasonText');
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.local_hub_id, 'federation.defederated', 'peering_record', v_row.id, to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- The console's refresh of a peer: the process fetched and re-admitted the manifest first; this records who asked and
-- the outcome, at the node or at a hub of the caller that has a record with the peer.
CREATE FUNCTION trustwork.federation_note_refresh(p_ctx jsonb, p_peer text, p_outcome text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_node uuid := trustwork.federation_node();
  v_person uuid := trustwork.admin_require_caller();
  v_actor trustwork.admin_actor;
  v_record trustwork.peering_record%ROWTYPE;
  v_hub uuid;
BEGIN
  IF p_outcome !~ '^[a-z][a-z0-9_.]{0,60}$' THEN
    RAISE EXCEPTION 'an outcome is a code' USING ERRCODE = 'invalid_parameter_value', HINT = 'federation.context_invalid';
  END IF;
  SELECT * INTO v_record FROM trustwork.peering_record r WHERE r.node_id = v_node AND r.peer_node = p_peer ORDER BY r.started_at, r.id LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown peer' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  SELECT r.local_hub_id INTO v_hub FROM trustwork.peering_record r WHERE r.node_id = v_node AND r.peer_node = p_peer
    AND (SELECT a.role FROM trustwork.admin_resolve_any(v_person, ARRAY['admin.federation.peer.edit'], NULL, r.local_hub_id) a) IS NOT NULL ORDER BY r.started_at, r.id LIMIT 1;
  IF v_hub IS NULL THEN
    v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.federation.peer.edit'], v_node, NULL);
    PERFORM trustwork.admin_record(v_actor, p_ctx, v_node, NULL, 'federation.peer_refreshed', 'peering_record', v_record.id, NULL, jsonb_build_object('peer', p_peer, 'outcome', p_outcome));
  ELSE
    v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.federation.peer.edit'], NULL, v_hub);
    PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_hub, 'federation.peer_refreshed', 'peering_record', v_record.id, NULL, jsonb_build_object('peer', p_peer, 'outcome', p_outcome));
  END IF;
  RETURN v_record.id;
END $$;

-- The peer ended or lowered on its side (learned through the protocol): mirrored by the process, never a person.
CREATE FUNCTION trustwork.federation_peer_ended(p_peer text, p_local_hub uuid, p_peer_hub text) RETURNS SETOF trustwork.peering_record
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_node uuid := trustwork.federation_node();
  v_record trustwork.peering_record%ROWTYPE;
BEGIN
  FOR v_record IN SELECT * FROM trustwork.peering_record WHERE node_id = v_node AND peer_node = p_peer AND state <> 'ended'
      AND (p_local_hub IS NULL OR local_hub_id = p_local_hub) AND (p_peer_hub IS NULL OR peer_hub_id = p_peer_hub) FOR UPDATE LOOP
    UPDATE trustwork.peering_record SET state = 'ended', end_reason = 'peer_ended', phase = 'complete', revision = revision + 1 WHERE id = v_record.id RETURNING * INTO v_record;
    PERFORM trustwork.federation_event(v_record.id, 'peering.ended_by_peer', NULL, 'active', 'ended', NULL);
    RETURN NEXT v_record;
  END LOOP;
END $$;

-- 10. Row-level security and grants ------------------------------------------------------------------------------------
ALTER TABLE trustwork.node_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.node_identity FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.node_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.node_key FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.node_key_secret ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.node_key_secret FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.node_manifest ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.node_manifest FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.federation_peer ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.federation_peer FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.peering_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.peering_record FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.peering_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.peering_event FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.admission_refusal ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.admission_refusal FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.federation_nonce ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.federation_nonce FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.peer_deal_admission ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.peer_deal_admission FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.peer_key_revocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.peer_key_revocation FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.node_identity AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.node_key AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.node_key_secret AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.node_manifest AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.federation_peer AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.peering_record AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.peering_event AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.admission_refusal AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.federation_nonce AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.peer_deal_admission AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.peer_key_revocation AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

-- The identity, the public key chain and the manifests are what the manifest publishes: readable by anyone.
CREATE POLICY node_identity_public_read ON trustwork.node_identity FOR SELECT TO trustwork_app USING (true);
CREATE POLICY node_key_public_read ON trustwork.node_key FOR SELECT TO trustwork_app USING (true);
CREATE POLICY node_manifest_public_read ON trustwork.node_manifest FOR SELECT TO trustwork_app USING (true);
-- Peers, records, events, deal admissions and revocations: federation staff of the node or of the hub concerned.
CREATE POLICY federation_peer_read ON trustwork.federation_peer FOR SELECT TO trustwork_app USING (trustwork.federation_peer_reader(peer_node));
CREATE POLICY peering_record_read ON trustwork.peering_record FOR SELECT TO trustwork_app USING (trustwork.federation_staff_reader(local_hub_id));
CREATE POLICY peering_event_read ON trustwork.peering_event FOR SELECT TO trustwork_app
  USING (EXISTS (SELECT 1 FROM trustwork.peering_record r WHERE r.id = peering_record_id AND trustwork.federation_staff_reader(r.local_hub_id)));
CREATE POLICY peer_deal_admission_read ON trustwork.peer_deal_admission FOR SELECT TO trustwork_app USING (trustwork.federation_peer_reader(peer_node));
CREATE POLICY peer_key_revocation_read ON trustwork.peer_key_revocation FOR SELECT TO trustwork_app USING (trustwork.federation_peer_reader(peer_node));
-- Refusal records: compliance and audit readers at the node. Nonces and sealed seeds: no policy, no grant.
CREATE POLICY admission_refusal_read ON trustwork.admission_refusal FOR SELECT TO trustwork_app USING (trustwork.federation_refusal_reader());

GRANT SELECT ON trustwork.node_identity, trustwork.node_key, trustwork.node_manifest, trustwork.federation_peer, trustwork.peering_record, trustwork.peering_event,
  trustwork.admission_refusal, trustwork.peer_deal_admission, trustwork.peer_key_revocation TO trustwork_app;
GRANT EXECUTE ON FUNCTION
  -- staff commands
  trustwork.federation_init_identity(jsonb, text, text, text, text, text, text, text, text, text, jsonb, integer, text[], integer, text, text, timestamptz, bytea, bytea, bytea, bytea, text),
  trustwork.federation_update_identity(jsonb, integer, text, text, text, text, text, text, text, text, jsonb, integer, text[], integer),
  trustwork.federation_rotate_key(jsonb, uuid, text, text, text, timestamptz, text, timestamptz, bytea, bytea, bytea, bytea, text),
  trustwork.federation_request_peering(jsonb, uuid, text, text, text, jsonb, integer, integer, uuid), trustwork.federation_accept_peering(jsonb, uuid, integer, text, uuid),
  trustwork.federation_await_second_approver(jsonb, uuid, integer), trustwork.federation_decline_peering(jsonb, uuid, integer), trustwork.federation_lower_peering(jsonb, uuid, integer, text),
  trustwork.federation_suspend_peering(jsonb, uuid, integer), trustwork.federation_lift_suspension(jsonb, uuid, integer), trustwork.federation_end_peering(jsonb, uuid, integer),
  trustwork.federation_note_refresh(jsonb, text, text),
  -- node-run commands and protocol readers
  trustwork.federation_node_signing_material(text), trustwork.federation_node_record_manifest(jsonb, text, text, timestamptz),
  trustwork.federation_peer_record(text, jsonb, text, timestamptz, text, timestamptz, boolean, text[], text, text), trustwork.federation_peer_equivocation(text),
  trustwork.federation_handshake_received(text, text, uuid, text, jsonb, integer, integer, text, text), trustwork.federation_peer_answered(uuid, text, text, text, text),
  trustwork.federation_refusal_record(text, text, timestamptz, jsonb, jsonb), trustwork.federation_note_nonce(text, text, text, timestamptz), trustwork.federation_purge_nonces(),
  trustwork.federation_deal_admission(text, text, text), trustwork.federation_revocation_noticed(text, text, timestamptz, timestamptz, integer),
  trustwork.federation_flow_allowed(text, text, uuid), trustwork.federation_peer_get(text), trustwork.federation_records_of_peer(text), trustwork.federation_record_get(uuid),
  trustwork.federation_peers_due(timestamptz, integer), trustwork.federation_peer_ended(text, uuid, text), trustwork.federation_manifest_hubs(), trustwork.federation_hub_by_slug(text),
  -- readers used by policies
  trustwork.federation_staff_reader(uuid), trustwork.federation_peer_reader(text), trustwork.federation_refusal_reader(),
  -- invoker helpers: vocabularies and the digests a console shows a second person (pure functions of their inputs)
  trustwork.federation_levels(), trustwork.federation_second_approver_levels(), trustwork.federation_level_rank(text), trustwork.federation_lower_level(text, text),
  trustwork.federation_data_classes(), trustwork.federation_admission_services(), trustwork.federation_is_address(text), trustwork.federation_host_ok(text),
  trustwork.federation_json_addresses(jsonb), trustwork.federation_peering_digest(uuid, text, text, text), trustwork.federation_rotation_digest(uuid, text, timestamptz),
  trustwork.federation_published_lifecycles()
TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
