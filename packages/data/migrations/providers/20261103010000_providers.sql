-- KEYS-001 provider connections, write-only secrets, model routes, egress, spending caps, kill switches and cost records
-- (docs/engine/hub-console/providers-and-models.md, docs/engine/hub-console/data-model.md, ADR 010 decision 25).
--
-- Tables (hub-scoped, forced row-level security, written only through the providers_* SECURITY DEFINER commands):
-- provider_connection, secret_ref, secret_version, connection_test, provider_budget, model_route, egress_rule,
-- model_pricing, provider_route_kill_switch, provider_usage, provider_budget_alert and provider_config_change.
--
-- Authority model (DATA-002): every staff command resolves the caller's permission at the hub, requires a live elevation
-- and writes an admin_audit_event (digests) plus a provider_config_change row (before and after values) in the same
-- transaction. Enabling a non-fake connection, activating a route that may carry non-public data, allowing a non-public
-- data class and releasing a kill switch consume a second-person approval bound to the exact digest; the requester
-- executes, the approver is always another person.
--
-- Guard rails enforced for every writer:
-- * secrets: the API seals a value with a fresh data key (AES-256-GCM) wrapped by the node's key-encryption key; only
--   ciphertext reaches secret_version, which no runtime role can SELECT. Read models, audit, change log and outbox carry
--   the reference and a keyed fingerprint only; the change log refuses secret-shaped keys and values;
-- * a connection processing or storing data in a restricted place is never saved;
-- * egress is default deny: a non-public allow needs a second person, in-residency processing and zero retention, and is
--   refused for vendors that train on inputs and for brokers;
-- * active routes name pinned provider revisions on enabled connections of the same hub; non-public routes stay in the
--   hub's residency and are activated by someone other than their drafter under an approval;
-- * the call gate (providers_authorize_call) resolves the most specific active route (extension, module, job), refuses a
--   call without one, applies kill switches and egress per data class, and reserves spend under a per-hub lock so an
--   exhausted cap blocks the next paid call; a fallback never escapes an egress denial of the primary;
-- * cost records are information: no function of this module writes a billing price.

-- 0. Vocabularies and helpers (immutable; tested against packages/contracts/src/hub.ts and providers.ts) -------------
CREATE FUNCTION trustwork.providers_capabilities() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['llm', 'embeddings', 'rerank', 'image_generation', 'translation', 'speech_to_text', 'text_to_speech', 'ocr', 'web_search', 'web_fetch',
    'email', 'sms', 'messenger', 'payments', 'payouts', 'e_invoicing', 'e_signature', 'register_lookup', 'sanctions_list', 'maps_geocoding',
    'object_storage', 'tax_calculation']::text[]
$$;
CREATE FUNCTION trustwork.providers_model_jobs() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['editorial_rewrite', 'summarisation', 'translation', 'fact_check_assist', 'classification', 'entity_resolution_assist', 'agent_reasoning', 'agent_drafting',
    'moderation_triage', 'embeddings', 'rerank', 'image_generation', 'speech_to_text', 'text_to_speech', 'ocr']::text[]
$$;
CREATE FUNCTION trustwork.providers_data_classes() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['public', 'person_private', 'company_private', 'project_restricted', 'deal_party_private']::text[]
$$;
-- Every permission that lets staff read a hub's provider configuration.
CREATE FUNCTION trustwork.providers_reader_permissions() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['admin.providers.read', 'admin.providers.connection.edit', 'admin.providers.secret.write', 'admin.providers.test', 'admin.providers.toggle',
    'admin.providers.egress.edit', 'admin.providers.budget.edit', 'admin.providers.kill', 'admin.models.route.edit', 'admin.models.route.activate', 'admin.usage.read',
    'admin.audit.read']::text[]
$$;
-- looksLikeSecretValue of hub.ts: known credential prefixes, or a long token with digits and letters.
CREATE FUNCTION trustwork.providers_secret_like(p_value text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_value IS NOT NULL AND (p_value ~ '^(sk-|sk_|rk_|pk_live|whsec_|xox[abpr]-|ghp_|gho_|ghs_|github_pat_|glpat-|AKIA|ASIA|AIza|ya29\.|hf_|r8_|SG\.|key-)'
    OR (p_value ~ '^[A-Za-z0-9+/=_-]{32,}$' AND p_value ~ '[0-9]' AND p_value ~ '[A-Za-z]'))
$$;
-- isMovingAlias of providers.ts.
CREATE FUNCTION trustwork.providers_moving_alias(p_revision text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_revision IS NOT NULL AND btrim(p_revision) ~* '^(latest|stable|current|default|newest|preview|beta|auto)$|[-_.:@](latest|stable|current|default|newest|auto)$'
$$;
-- endpointProblem of providers.ts (the parts SQL can check): vendors use HTTPS on a public host; no credentials in the URL.
CREATE FUNCTION trustwork.providers_endpoint_ok(p_endpoint text, p_hosting_kind text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_endpoint IS NULL OR (
    length(p_endpoint) <= 2000 AND p_endpoint ~ '^https?://[^/@\s]+(/[^\s]*)?$'
    AND (p_hosting_kind = 'self_hosted' OR (p_endpoint ~ '^https://'
      AND split_part(split_part(substring(p_endpoint FROM '^https://([^/?#]+)'), ':', 1), ']', 1) !~* '^(localhost|.*\.localhost|.*\.local|.*\.internal|127\.[0-9.]+|10\.[0-9.]+|192\.168\.[0-9.]+|172\.(1[6-9]|2[0-9]|3[01])\.[0-9.]+|169\.254\.[0-9.]+|0\.0\.0\.0|\[.*)$')))
$$;
CREATE FUNCTION trustwork.providers_model_ref_ok(p_ref jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_typeof(p_ref) = 'object' AND (SELECT count(*) FROM jsonb_object_keys(p_ref)) = 3
    AND coalesce(p_ref ->> 'connectionId', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND length(coalesce(p_ref ->> 'modelId', '')) BETWEEN 1 AND 200
    AND p_ref ? 'modelRevision' AND (jsonb_typeof(p_ref -> 'modelRevision') = 'null'
      OR (jsonb_typeof(p_ref -> 'modelRevision') = 'string' AND length(p_ref ->> 'modelRevision') BETWEEN 1 AND 200 AND NOT trustwork.providers_moving_alias(p_ref ->> 'modelRevision')))
$$;
CREATE FUNCTION trustwork.providers_hosting_json(p_kind text, p_country text, p_zero boolean, p_trains boolean, p_broker boolean) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN p_kind = 'vendor'
    THEN jsonb_build_object('kind', 'vendor', 'country', p_country, 'zeroRetention', p_zero, 'trainsOnInputs', p_trains, 'broker', p_broker)
    ELSE jsonb_build_object('kind', 'self_hosted', 'country', p_country) END
$$;
CREATE FUNCTION trustwork.providers_scope_json(p_kind text, p_module text, p_extension uuid) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_kind WHEN 'module' THEN jsonb_build_object('kind', 'module', 'moduleKey', p_module)
                     WHEN 'extension' THEN jsonb_build_object('kind', 'extension', 'extensionId', p_extension::text)
                     ELSE jsonb_build_object('kind', 'job') END
$$;
-- A change-log image never carries a secret: no secret-shaped key at any depth, no value with a known credential prefix.
CREATE FUNCTION trustwork.providers_change_safe(p_value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  WITH RECURSIVE walk(v, k) AS (
    SELECT p_value, NULL::text
    UNION ALL
    SELECT c.v, c.k FROM walk w CROSS JOIN LATERAL (
      SELECT e.value AS v, e.key AS k FROM jsonb_each(CASE WHEN jsonb_typeof(w.v) = 'object' THEN w.v ELSE '{}'::jsonb END) e
      UNION ALL
      SELECT a.value, NULL FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.v) = 'array' THEN w.v ELSE '[]'::jsonb END) a
    ) c
  )
  SELECT p_value IS NULL OR NOT EXISTS (
    SELECT 1 FROM walk
    WHERE (k IS NOT NULL AND lower(k) ~ '^(ciphertext|iv|auth_tag|wrapped_key|value|secret|secret_value|password|token|api_key|apikey|plaintext)$')
       OR (jsonb_typeof(v) = 'string' AND (v #>> '{}') ~ '^(sk-|sk_|rk_|pk_live|whsec_|xox[abpr]-|ghp_|gho_|ghs_|github_pat_|glpat-|AKIA|ASIA|AIza|ya29\.|hf_|r8_|SG\.|key-)'))
$$;

-- Alert thresholds: at most five distinct percentages between 1 and 100.
CREATE FUNCTION trustwork.providers_percents_ok(p_values integer[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_values IS NOT NULL AND cardinality(p_values) <= 5 AND trustwork.admin_distinct(p_values)
    AND NOT EXISTS (SELECT 1 FROM unnest(p_values) p WHERE p IS NULL OR p < 1 OR p > 100)
$$;

-- The hub's personal-data countries (the active residency configuration); empty until configured, which fails closed.
CREATE FUNCTION trustwork.providers_residency(p_hub uuid) RETURNS text[]
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT coalesce(ARRAY(SELECT jsonb_array_elements_text(trustwork.hubs_active_payload(p_hub, 'residency') -> 'personalDataCountries')), ARRAY[]::text[])
$$;
CREATE FUNCTION trustwork.providers_in_residency(p_hub uuid, p_processing text, p_storage text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT p_processing = ANY (trustwork.providers_residency(p_hub)) AND (p_storage IS NULL OR p_storage = ANY (trustwork.providers_residency(p_hub)))
$$;
CREATE FUNCTION trustwork.providers_restricted(p_hub uuid, p_processing text, p_storage text) RETURNS text[]
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT ARRAY(SELECT c FROM unnest(ARRAY[p_processing, p_storage]) c WHERE c IS NOT NULL AND trustwork.hubs_place_restricted(p_hub, c) ORDER BY c)
$$;

-- 1. Provider connections ---------------------------------------------------------------------------------------------
CREATE TABLE trustwork.provider_connection (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  adapter_id text NOT NULL CHECK (adapter_id ~ '^[a-z][a-z0-9_]{1,40}$'),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 200 AND NOT trustwork.providers_secret_like(label)),
  capabilities text[] NOT NULL CHECK (cardinality(capabilities) BETWEEN 1 AND 22 AND trustwork.admin_distinct(capabilities) AND capabilities <@ trustwork.providers_capabilities()),
  mode text NOT NULL CHECK (mode IN ('fake', 'manual', 'live')),
  endpoint text NULL,
  hosting_kind text NOT NULL CHECK (hosting_kind IN ('self_hosted', 'vendor')),
  processing_country text NOT NULL CHECK (processing_country ~ '^[A-Z]{2}$'),
  storage_country text NULL CHECK (storage_country ~ '^[A-Z]{2}$'),
  region text NULL CHECK (region ~ '^[a-z0-9][a-z0-9_.-]{0,62}$'),
  zero_retention boolean NULL,
  trains_on_inputs boolean NULL,
  broker boolean NULL,
  credential_ref_id uuid NULL REFERENCES trustwork.provider_credential_ref (id),
  -- Moves with every secret write or revocation, so the revision (and any approval bound to it) moves too.
  secret_generation integer NOT NULL DEFAULT 0 CHECK (secret_generation >= 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'enabled', 'disabled')),
  last_test_id uuid NULL,
  enabled_by uuid NULL REFERENCES trustwork.person (id),
  enabled_at timestamptz NULL,
  approval_id uuid NULL REFERENCES trustwork.second_person_approval (id),
  created_by uuid NOT NULL REFERENCES trustwork.person (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_connection_vendor_terms CHECK ((hosting_kind = 'vendor') = (zero_retention IS NOT NULL AND trains_on_inputs IS NOT NULL AND broker IS NOT NULL)),
  CONSTRAINT provider_connection_fake_no_secret CHECK (mode <> 'fake' OR credential_ref_id IS NULL),
  CONSTRAINT provider_connection_endpoint CHECK (trustwork.providers_endpoint_ok(endpoint, hosting_kind)),
  CONSTRAINT provider_connection_enabled_shape CHECK ((status = 'enabled') = (enabled_by IS NOT NULL AND enabled_at IS NOT NULL) AND (approval_id IS NULL OR status = 'enabled'))
);
CREATE INDEX provider_connection_hub_idx ON trustwork.provider_connection (hub_id);
CREATE TRIGGER provider_connection_touch BEFORE UPDATE ON trustwork.provider_connection FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- 2. Secrets: references (staff-readable) and ciphertext (never readable by a runtime role) --------------------------
CREATE TABLE trustwork.secret_ref (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  connection_id uuid NOT NULL REFERENCES trustwork.provider_connection (id),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  store text NOT NULL DEFAULT 'envelope_db' CHECK (store = 'envelope_db'),
  ref text NOT NULL CHECK (ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$' AND NOT trustwork.providers_secret_like(ref)),
  keyed_fingerprint text NOT NULL CHECK (keyed_fingerprint ~ '^[a-f0-9]{12}$'),
  version integer NOT NULL CHECK (version >= 1),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'grace', 'destroyed')),
  created_by uuid NOT NULL REFERENCES trustwork.person (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz NULL,
  grace_until timestamptz NULL,
  destroyed_at timestamptz NULL,
  last_used_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, version),
  CONSTRAINT secret_ref_grace CHECK (status <> 'grace' OR (grace_until IS NOT NULL AND rotated_at IS NOT NULL)),
  CONSTRAINT secret_ref_destroyed CHECK ((status = 'destroyed') = (destroyed_at IS NOT NULL))
);
CREATE UNIQUE INDEX secret_ref_one_active ON trustwork.secret_ref (connection_id) WHERE status = 'active';
CREATE TRIGGER secret_ref_touch BEFORE UPDATE ON trustwork.secret_ref FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

CREATE TABLE trustwork.secret_version (
  secret_ref_id uuid PRIMARY KEY REFERENCES trustwork.secret_ref (id),
  algorithm text NOT NULL DEFAULT 'aes-256-gcm' CHECK (algorithm = 'aes-256-gcm'),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 20000),
  iv bytea NOT NULL CHECK (octet_length(iv) = 12),
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
  wrapped_key bytea NOT NULL CHECK (octet_length(wrapped_key) BETWEEN 16 AND 2048),
  kek_id text NOT NULL CHECK (kek_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$')
);
CREATE FUNCTION trustwork.providers_secret_ref_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'secret references are destroyed, never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION 'a secret version is born active' USING ERRCODE = 'check_violation', HINT = 'providers.invalid_transition';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.connection_id, NEW.hub_id, NEW.store, NEW.ref, NEW.keyed_fingerprint, NEW.version, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.connection_id, OLD.hub_id, OLD.store, OLD.ref, OLD.keyed_fingerprint, OLD.version, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'a secret version is immutable; write a new one' USING ERRCODE = 'integrity_constraint_violation', HINT = 'providers.invalid_transition';
  END IF;
  IF NOT (OLD.status = NEW.status OR (OLD.status = 'active' AND NEW.status IN ('grace', 'destroyed')) OR (OLD.status = 'grace' AND NEW.status = 'destroyed')) THEN
    RAISE EXCEPTION 'secret version % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'providers.invalid_transition';
  END IF;
  IF NEW.status = 'destroyed' AND OLD.status <> 'destroyed' THEN
    NEW.destroyed_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER secret_ref_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.secret_ref FOR EACH ROW EXECUTE FUNCTION trustwork.providers_secret_ref_guard();
-- Ciphertext is never changed; it is deleted only when its reference is destroyed (destruction is the deletion).
CREATE FUNCTION trustwork.providers_secret_version_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'ciphertext is never changed' USING ERRCODE = 'integrity_constraint_violation', HINT = 'providers.invalid_transition';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM trustwork.secret_ref r WHERE r.id = OLD.secret_ref_id AND r.status = 'destroyed') THEN
      RAISE EXCEPTION 'ciphertext is deleted only when its version is destroyed' USING ERRCODE = 'integrity_constraint_violation', HINT = 'providers.invalid_transition';
    END IF;
    RETURN OLD;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trustwork.secret_ref r WHERE r.id = NEW.secret_ref_id AND r.status = 'active') THEN
    RAISE EXCEPTION 'ciphertext belongs to an active version' USING ERRCODE = 'check_violation', HINT = 'providers.invalid_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER secret_version_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.secret_version FOR EACH ROW EXECUTE FUNCTION trustwork.providers_secret_version_guard();
CREATE TRIGGER secret_version_no_truncate BEFORE TRUNCATE ON trustwork.secret_version FOR EACH STATEMENT EXECUTE FUNCTION trustwork.forbid_mutation();

-- 3. Connection tests: engine-supplied synthetic input only (append-only) -------------------------------------------
CREATE TABLE trustwork.connection_test (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  connection_id uuid NOT NULL REFERENCES trustwork.provider_connection (id),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  tested_by uuid NOT NULL REFERENCES trustwork.person (id),
  tested_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL CHECK (outcome IN ('ok', 'auth_failed', 'unreachable', 'rate_limited', 'quota_exceeded', 'residency_mismatch', 'model_missing', 'error')),
  latency_ms integer NULL CHECK (latency_ms >= 0),
  models_listed integer NULL CHECK (models_listed >= 0),
  cost_minor bigint NULL CHECK (cost_minor >= 0),
  cost_currency text NULL CHECK (cost_currency ~ '^[A-Z]{3}$'),
  synthetic_input_only boolean NOT NULL DEFAULT true CHECK (synthetic_input_only),
  probe_digest text NOT NULL CHECK (probe_digest ~ '^[a-f0-9]{64}$'),
  config_digest text NOT NULL CHECK (config_digest ~ '^[a-f0-9]{64}$'),
  secret_ref_id uuid NULL REFERENCES trustwork.secret_ref (id),
  CONSTRAINT connection_test_cost CHECK ((cost_minor IS NULL) = (cost_currency IS NULL))
);
CREATE INDEX connection_test_connection_idx ON trustwork.connection_test (connection_id, tested_at);
CREATE TRIGGER connection_test_append_only BEFORE UPDATE OR DELETE ON trustwork.connection_test FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
ALTER TABLE trustwork.provider_connection ADD CONSTRAINT provider_connection_last_test_fk FOREIGN KEY (last_test_id) REFERENCES trustwork.connection_test (id);

-- What a test binds and an enabling checks: everything that decides where data goes and with which credential.
CREATE FUNCTION trustwork.providers_config_digest(p_connection uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.admin_digest(jsonb_build_object('connectionId', c.id::text, 'adapterId', c.adapter_id, 'mode', c.mode, 'endpoint', c.endpoint,
    'hosting', trustwork.providers_hosting_json(c.hosting_kind, c.processing_country, c.zero_retention, c.trains_on_inputs, c.broker),
    'storageCountry', c.storage_country, 'credentialRefId', c.credential_ref_id::text,
    'secretRefId', (SELECT r.id::text FROM trustwork.secret_ref r WHERE r.connection_id = c.id AND r.status = 'active')))
  FROM trustwork.provider_connection c WHERE c.id = p_connection
$$;
-- connectionEnableDigestInput of providers.ts (providers.enable_non_fake for a connection).
CREATE FUNCTION trustwork.providers_connection_digest(p_connection uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.admin_digest(jsonb_build_object('action', 'providers.enable_non_fake', 'object', 'provider_connection', 'hubId', c.hub_id::text, 'connectionId', c.id::text,
    'adapterId', c.adapter_id, 'mode', c.mode, 'endpoint', c.endpoint,
    'hosting', trustwork.providers_hosting_json(c.hosting_kind, c.processing_country, c.zero_retention, c.trains_on_inputs, c.broker),
    'storageCountry', c.storage_country,
    'secretFingerprint', (SELECT r.keyed_fingerprint FROM trustwork.secret_ref r WHERE r.connection_id = c.id AND r.status = 'active'),
    'credentialRefId', c.credential_ref_id::text, 'testId', c.last_test_id::text, 'revision', c.revision))
  FROM trustwork.provider_connection c WHERE c.id = p_connection
$$;

CREATE FUNCTION trustwork.providers_connection_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_places text[];
  v_approval trustwork.second_person_approval%ROWTYPE;
  v_test trustwork.connection_test%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'connections are disabled, never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  v_places := trustwork.providers_restricted(NEW.hub_id, NEW.processing_country, NEW.storage_country);
  IF cardinality(v_places) > 0 THEN
    RAISE EXCEPTION 'a connection never processes or stores data in a restricted place' USING ERRCODE = 'check_violation', HINT = 'providers.restricted_place',
      DETAIL = array_to_string(v_places, ',');
  END IF;
  IF NEW.credential_ref_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trustwork.provider_credential_ref r WHERE r.id = NEW.credential_ref_id AND r.hub_id = NEW.hub_id) THEN
    RAISE EXCEPTION 'the credential reference belongs to another hub' USING ERRCODE = 'check_violation', HINT = 'providers.credential_not_active';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.last_test_id IS NOT NULL THEN
      RAISE EXCEPTION 'a connection is born a draft' USING ERRCODE = 'check_violation', HINT = 'providers.invalid_transition';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.hub_id, NEW.adapter_id, NEW.mode, NEW.created_by, NEW.created_at) IS DISTINCT FROM ROW(OLD.id, OLD.hub_id, OLD.adapter_id, OLD.mode, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'a connection keeps its hub, adapter and mode; create another' USING ERRCODE = 'integrity_constraint_violation', HINT = 'providers.invalid_transition';
  END IF;
  IF NEW.status = 'enabled' AND (OLD.status <> 'enabled' OR NEW.approval_id IS DISTINCT FROM OLD.approval_id) THEN
    SELECT * INTO v_test FROM trustwork.connection_test WHERE id = NEW.last_test_id;
    IF NOT FOUND OR v_test.connection_id <> NEW.id OR v_test.outcome <> 'ok' THEN
      RAISE EXCEPTION 'enable only after a successful connection test' USING ERRCODE = 'check_violation', HINT = 'providers.test_required';
    END IF;
    IF NEW.mode <> 'fake' THEN
      SELECT * INTO v_approval FROM trustwork.second_person_approval WHERE id = NEW.approval_id;
      IF NOT FOUND OR v_approval.status <> 'consumed' OR v_approval.consumed_ref IS DISTINCT FROM NEW.id OR v_approval.hub_id IS DISTINCT FROM NEW.hub_id
         OR v_approval.action <> 'providers.enable_non_fake' OR v_approval.requested_by IS DISTINCT FROM NEW.enabled_by OR v_approval.approved_by = NEW.enabled_by THEN
        RAISE EXCEPTION 'a non-fake connection is enabled only under a consumed second-person approval' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_required';
      END IF;
    ELSIF NEW.approval_id IS NOT NULL THEN
      RAISE EXCEPTION 'a fake connection needs no approval' USING ERRCODE = 'check_violation', HINT = 'providers.invalid_transition';
    END IF;
    NEW.enabled_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER provider_connection_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.provider_connection FOR EACH ROW EXECUTE FUNCTION trustwork.providers_connection_guard();

-- 4. Operator spending caps -------------------------------------------------------------------------------------------
CREATE TABLE trustwork.provider_budget (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  scope_kind text NOT NULL CHECK (scope_kind IN ('hub', 'job', 'pipeline', 'agent_module', 'connection')),
  job text NULL CHECK (job = ANY (trustwork.providers_model_jobs())),
  pipeline_id uuid NULL,
  module_key text NULL CHECK (module_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  connection_id uuid NULL REFERENCES trustwork.provider_connection (id),
  period text NOT NULL CHECK (period IN ('day', 'month')),
  limit_minor bigint NOT NULL CHECK (limit_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  alert_at_percent integer[] NOT NULL DEFAULT ARRAY[]::integer[] CHECK (trustwork.providers_percents_ok(alert_at_percent)),
  on_exhausted text NOT NULL CHECK (on_exhausted IN ('pause', 'deny_new')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_by uuid NOT NULL REFERENCES trustwork.person (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_by uuid NULL REFERENCES trustwork.person (id),
  retired_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_budget_scope_shape CHECK (CASE scope_kind
    WHEN 'hub' THEN job IS NULL AND pipeline_id IS NULL AND module_key IS NULL AND connection_id IS NULL
    WHEN 'job' THEN job IS NOT NULL AND pipeline_id IS NULL AND module_key IS NULL AND connection_id IS NULL
    WHEN 'pipeline' THEN pipeline_id IS NOT NULL AND job IS NULL AND module_key IS NULL AND connection_id IS NULL
    WHEN 'agent_module' THEN module_key IS NOT NULL AND job IS NULL AND pipeline_id IS NULL AND connection_id IS NULL
    ELSE connection_id IS NOT NULL AND job IS NULL AND pipeline_id IS NULL AND module_key IS NULL END),
  CONSTRAINT provider_budget_retired CHECK ((status = 'retired') = (retired_at IS NOT NULL AND retired_by IS NOT NULL))
);
CREATE UNIQUE INDEX provider_budget_one_active ON trustwork.provider_budget (hub_id, scope_kind, coalesce(job, ''), coalesce(pipeline_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(module_key, ''), coalesce(connection_id, '00000000-0000-0000-0000-000000000000'::uuid), period) WHERE status = 'active';
CREATE TRIGGER provider_budget_touch BEFORE UPDATE ON trustwork.provider_budget FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
CREATE FUNCTION trustwork.providers_budget_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'caps are retired, never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF NEW.currency IS DISTINCT FROM (SELECT p.currency FROM trustwork.hub_profile p WHERE p.hub_id = NEW.hub_id) THEN
    RAISE EXCEPTION 'a cap is in the hub''s currency' USING ERRCODE = 'check_violation', HINT = 'providers.cap_currency';
  END IF;
  IF NEW.connection_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trustwork.provider_connection c WHERE c.id = NEW.connection_id AND c.hub_id = NEW.hub_id) THEN
    RAISE EXCEPTION 'the connection belongs to another hub' USING ERRCODE = 'check_violation', HINT = 'providers.cap_scope_unknown';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.hub_id, NEW.scope_kind, NEW.job, NEW.pipeline_id, NEW.module_key, NEW.connection_id, NEW.period, NEW.currency, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.hub_id, OLD.scope_kind, OLD.job, OLD.pipeline_id, OLD.module_key, OLD.connection_id, OLD.period, OLD.currency, OLD.created_by, OLD.created_at) THEN
      RAISE EXCEPTION 'a cap keeps its scope and period; create another' USING ERRCODE = 'integrity_constraint_violation', HINT = 'providers.invalid_transition';
    END IF;
    IF OLD.status = 'retired' THEN
      RAISE EXCEPTION 'a retired cap is final' USING ERRCODE = 'check_violation', HINT = 'providers.invalid_transition';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER provider_budget_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.provider_budget FOR EACH ROW EXECUTE FUNCTION trustwork.providers_budget_guard();

-- 5. Model routes scoped by job, agent module or extension ------------------------------------------------------------
CREATE TABLE trustwork.model_route (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  job text NOT NULL CHECK (job = ANY (trustwork.providers_model_jobs())),
  scope_kind text NOT NULL CHECK (scope_kind IN ('job', 'module', 'extension')),
  module_key text NULL CHECK (module_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  extension_id uuid NULL,
  version integer NOT NULL CHECK (version >= 1),
  primary_ref jsonb NOT NULL CHECK (trustwork.providers_model_ref_ok(primary_ref)),
  fallbacks jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(fallbacks) = 'array' AND jsonb_array_length(fallbacks) <= 3),
  allowed_data_classes text[] NOT NULL CHECK (cardinality(allowed_data_classes) BETWEEN 1 AND 5 AND trustwork.admin_distinct(allowed_data_classes)
    AND allowed_data_classes <@ trustwork.providers_data_classes()),
  max_input_tokens integer NOT NULL CHECK (max_input_tokens BETWEEN 1 AND 10000000),
  max_output_tokens integer NOT NULL CHECK (max_output_tokens BETWEEN 1 AND 1000000),
  max_file_bytes bigint NULL CHECK (max_file_bytes BETWEEN 1 AND 1073741824),
  timeout_ms integer NOT NULL CHECK (timeout_ms BETWEEN 100 AND 600000),
  budget_id uuid NULL REFERENCES trustwork.provider_budget (id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'superseded', 'disabled')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  drafted_by uuid NOT NULL REFERENCES trustwork.person (id),
  drafted_at timestamptz NOT NULL DEFAULT now(),
  activated_by uuid NULL REFERENCES trustwork.person (id),
  activated_at timestamptz NULL,
  approval_id uuid NULL REFERENCES trustwork.second_person_approval (id),
  superseded_at timestamptz NULL,
  disabled_by uuid NULL REFERENCES trustwork.person (id),
  disabled_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT model_route_scope_shape CHECK (CASE scope_kind
    WHEN 'job' THEN module_key IS NULL AND extension_id IS NULL
    WHEN 'module' THEN module_key IS NOT NULL AND extension_id IS NULL
    ELSE extension_id IS NOT NULL AND module_key IS NULL END),
  CONSTRAINT model_route_no_mixing CHECK (job NOT IN ('embeddings', 'rerank') OR jsonb_array_length(fallbacks) = 0),
  CONSTRAINT model_route_images_public CHECK (job <> 'image_generation' OR allowed_data_classes = ARRAY['public']::text[]),
  CONSTRAINT model_route_activation CHECK ((status IN ('active', 'superseded', 'disabled')) = (activated_by IS NOT NULL AND activated_at IS NOT NULL)
    OR (status = 'disabled' AND activated_by IS NULL)),
  CONSTRAINT model_route_disabled CHECK ((status = 'disabled') = (disabled_at IS NOT NULL AND disabled_by IS NOT NULL))
);
CREATE UNIQUE INDEX model_route_version ON trustwork.model_route (hub_id, job, scope_kind, coalesce(module_key, ''), coalesce(extension_id, '00000000-0000-0000-0000-000000000000'::uuid), version);
CREATE UNIQUE INDEX model_route_one_active ON trustwork.model_route (hub_id, job, scope_kind, coalesce(module_key, ''), coalesce(extension_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status = 'active';
CREATE TRIGGER model_route_touch BEFORE UPDATE ON trustwork.model_route FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- The route's models in order: the primary, then the fallbacks.
CREATE FUNCTION trustwork.providers_route_refs(p_primary jsonb, p_fallbacks jsonb) RETURNS TABLE (ord integer, ref jsonb)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT 0, p_primary UNION ALL SELECT f.ordinality::integer, f.value FROM jsonb_array_elements(p_fallbacks) WITH ORDINALITY f ORDER BY 1
$$;
-- routeActivationDigestInput of providers.ts (models.activate_private_route).
CREATE FUNCTION trustwork.providers_route_digest(p_route uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.admin_digest(jsonb_build_object('action', 'models.activate_private_route', 'object', 'model_route', 'hubId', r.hub_id::text, 'routeId', r.id::text, 'job', r.job,
    'scope', trustwork.providers_scope_json(r.scope_kind, r.module_key, r.extension_id), 'version', r.version, 'primary', r.primary_ref, 'fallbacks', r.fallbacks,
    'allowedDataClasses', to_jsonb(ARRAY(SELECT c FROM unnest(r.allowed_data_classes) c ORDER BY c COLLATE "C")),
    'limits', jsonb_build_object('maxInputTokens', r.max_input_tokens, 'maxOutputTokens', r.max_output_tokens, 'maxFileBytes', r.max_file_bytes, 'timeoutMs', r.timeout_ms),
    'budgetId', r.budget_id::text))
  FROM trustwork.model_route r WHERE r.id = p_route
$$;

CREATE FUNCTION trustwork.providers_route_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_approval trustwork.second_person_approval%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'routes are superseded or disabled, never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.fallbacks) f WHERE NOT trustwork.providers_model_ref_ok(f.value)) THEN
    RAISE EXCEPTION 'every fallback is a model reference' USING ERRCODE = 'check_violation', HINT = 'providers.route_connection_unusable';
  END IF;
  IF (SELECT count(DISTINCT (x.ref ->> 'connectionId') || '/' || (x.ref ->> 'modelId')) FROM trustwork.providers_route_refs(NEW.primary_ref, NEW.fallbacks) x)
     <> 1 + jsonb_array_length(NEW.fallbacks) THEN
    RAISE EXCEPTION 'a model appears once in a route' USING ERRCODE = 'check_violation', HINT = 'providers.route_connection_unusable';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.providers_route_refs(NEW.primary_ref, NEW.fallbacks) x
             WHERE NOT EXISTS (SELECT 1 FROM trustwork.provider_connection c WHERE c.id = (x.ref ->> 'connectionId')::uuid AND c.hub_id = NEW.hub_id)) THEN
    RAISE EXCEPTION 'a route names connections of its own hub' USING ERRCODE = 'check_violation', HINT = 'providers.route_connection_unusable';
  END IF;
  IF NEW.budget_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trustwork.provider_budget b WHERE b.id = NEW.budget_id AND b.hub_id = NEW.hub_id) THEN
    RAISE EXCEPTION 'the cap belongs to another hub' USING ERRCODE = 'check_violation', HINT = 'providers.route_budget_unknown';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'a route version is born a draft' USING ERRCODE = 'check_violation', HINT = 'providers.invalid_transition';
    END IF;
    NEW.drafted_at := now();
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.hub_id, NEW.job, NEW.scope_kind, NEW.module_key, NEW.extension_id, NEW.version, NEW.primary_ref, NEW.fallbacks, NEW.allowed_data_classes,
         NEW.max_input_tokens, NEW.max_output_tokens, NEW.max_file_bytes, NEW.timeout_ms, NEW.budget_id, NEW.reason, NEW.drafted_by, NEW.drafted_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.hub_id, OLD.job, OLD.scope_kind, OLD.module_key, OLD.extension_id, OLD.version, OLD.primary_ref, OLD.fallbacks, OLD.allowed_data_classes,
         OLD.max_input_tokens, OLD.max_output_tokens, OLD.max_file_bytes, OLD.timeout_ms, OLD.budget_id, OLD.reason, OLD.drafted_by, OLD.drafted_at) THEN
    RAISE EXCEPTION 'a route version is immutable; draft a new one' USING ERRCODE = 'integrity_constraint_violation', HINT = 'providers.invalid_transition';
  END IF;
  IF NOT (OLD.status = NEW.status OR (OLD.status = 'draft' AND NEW.status IN ('active', 'disabled')) OR (OLD.status = 'active' AND NEW.status IN ('superseded', 'disabled'))) THEN
    RAISE EXCEPTION 'route % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'providers.invalid_transition';
  END IF;
  IF NEW.status = 'active' AND OLD.status = 'draft' THEN
    IF EXISTS (SELECT 1 FROM trustwork.providers_route_refs(NEW.primary_ref, NEW.fallbacks) x WHERE jsonb_typeof(x.ref -> 'modelRevision') <> 'string') THEN
      RAISE EXCEPTION 'active routes name pinned provider revisions' USING ERRCODE = 'check_violation', HINT = 'providers.route_unpinned';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(NEW.allowed_data_classes) c WHERE c <> 'public') THEN
      IF NEW.activated_by = NEW.drafted_by THEN
        RAISE EXCEPTION 'a route that may carry non-public data is activated by someone other than its drafter' USING ERRCODE = 'insufficient_privilege', HINT = 'providers.drafter_cannot_activate';
      END IF;
      SELECT * INTO v_approval FROM trustwork.second_person_approval WHERE id = NEW.approval_id;
      IF NOT FOUND OR v_approval.status <> 'consumed' OR v_approval.consumed_ref IS DISTINCT FROM NEW.id OR v_approval.action <> 'models.activate_private_route'
         OR v_approval.requested_by IS DISTINCT FROM NEW.activated_by OR v_approval.approved_by = NEW.activated_by OR v_approval.hub_id IS DISTINCT FROM NEW.hub_id THEN
        RAISE EXCEPTION 'a non-public route is activated only under a consumed second-person approval' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_required';
      END IF;
    END IF;
    NEW.activated_at := now();
  END IF;
  IF NEW.status = 'superseded' AND OLD.status <> 'superseded' THEN
    NEW.superseded_at := now();
  END IF;
  IF NEW.status = 'disabled' AND OLD.status <> 'disabled' THEN
    NEW.disabled_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER model_route_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.model_route FOR EACH ROW EXECUTE FUNCTION trustwork.providers_route_guard();

-- 6. Egress matrix: one cell per data class and connection, versioned, a missing cell is deny (append-only) ----------
CREATE TABLE trustwork.egress_rule (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  connection_id uuid NOT NULL REFERENCES trustwork.provider_connection (id),
  data_class text NOT NULL CHECK (data_class = ANY (trustwork.providers_data_classes())),
  decision text NOT NULL CHECK (decision IN ('allow', 'deny')),
  require_in_residency boolean NOT NULL,
  require_zero_retention boolean NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  approval_id uuid NULL UNIQUE REFERENCES trustwork.second_person_approval (id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  created_by uuid NOT NULL REFERENCES trustwork.person (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, data_class, version),
  CONSTRAINT egress_rule_private_allow CHECK (decision = 'deny' OR data_class = 'public' OR (approval_id IS NOT NULL AND require_in_residency AND require_zero_retention))
);
CREATE TRIGGER egress_rule_append_only BEFORE UPDATE OR DELETE ON trustwork.egress_rule FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();
-- egressAllowDigestInput of providers.ts (egress.allow_private_class).
CREATE FUNCTION trustwork.providers_egress_digest(p_hub uuid, p_connection uuid, p_class text, p_residency boolean, p_zero boolean, p_version integer) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.admin_digest(jsonb_build_object('action', 'egress.allow_private_class', 'object', 'egress_rule', 'hubId', p_hub::text, 'connectionId', p_connection::text,
    'dataClass', p_class, 'decision', 'allow', 'requireInResidency', p_residency, 'requireZeroRetention', p_zero, 'version', p_version))
$$;
CREATE FUNCTION trustwork.providers_egress_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_approval trustwork.second_person_approval%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM trustwork.provider_connection c WHERE c.id = NEW.connection_id AND c.hub_id = NEW.hub_id) THEN
    RAISE EXCEPTION 'the connection belongs to another hub' USING ERRCODE = 'check_violation', HINT = 'providers.connection_not_enabled';
  END IF;
  IF NEW.decision = 'allow' AND NEW.data_class <> 'public' THEN
    SELECT * INTO v_approval FROM trustwork.second_person_approval WHERE id = NEW.approval_id;
    IF NOT FOUND OR v_approval.status <> 'consumed' OR v_approval.consumed_ref IS DISTINCT FROM NEW.id OR v_approval.action <> 'egress.allow_private_class'
       OR v_approval.requested_by IS DISTINCT FROM NEW.created_by OR v_approval.approved_by = NEW.created_by OR v_approval.hub_id IS DISTINCT FROM NEW.hub_id THEN
      RAISE EXCEPTION 'allowing a non-public class needs a consumed second-person approval' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_required';
    END IF;
  ELSIF NEW.approval_id IS NOT NULL THEN
    RAISE EXCEPTION 'only a non-public allow carries an approval' USING ERRCODE = 'check_violation', HINT = 'providers.invalid_transition';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER egress_rule_guard BEFORE INSERT ON trustwork.egress_rule FOR EACH ROW EXECUTE FUNCTION trustwork.providers_egress_guard();

-- 7. Cost records per model: versioned, append-only; never a sale price ---------------------------------------------
CREATE TABLE trustwork.model_pricing (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  connection_id uuid NOT NULL REFERENCES trustwork.provider_connection (id),
  model_id text NOT NULL CHECK (length(model_id) BETWEEN 1 AND 200),
  version integer NOT NULL CHECK (version >= 1),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  input_per_million_tokens numeric(20, 6) NULL CHECK (input_per_million_tokens >= 0),
  output_per_million_tokens numeric(20, 6) NULL CHECK (output_per_million_tokens >= 0),
  per_image numeric(20, 6) NULL CHECK (per_image >= 0),
  per_audio_minute numeric(20, 6) NULL CHECK (per_audio_minute >= 0),
  basis text NOT NULL CHECK (basis IN ('provider_list', 'contract', 'measured')),
  observed_at timestamptz NOT NULL,
  source_note text NULL CHECK (length(source_note) BETWEEN 1 AND 500),
  recorded_by uuid NOT NULL REFERENCES trustwork.person (id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, model_id, version),
  CONSTRAINT model_pricing_some_price CHECK (coalesce(input_per_million_tokens, output_per_million_tokens, per_image, per_audio_minute) IS NOT NULL),
  CONSTRAINT model_pricing_not_future CHECK (observed_at <= recorded_at + interval '5 minutes')
);
CREATE TRIGGER model_pricing_append_only BEFORE UPDATE OR DELETE ON trustwork.model_pricing FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 8. Route kill switches (connection kill switches are DATA-002's kill_switch, scope provider_connection) -------------
CREATE TABLE trustwork.provider_route_kill_switch (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  job text NOT NULL CHECK (job = ANY (trustwork.providers_model_jobs())),
  scope_kind text NOT NULL CHECK (scope_kind IN ('job', 'module', 'extension')),
  module_key text NULL CHECK (module_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  extension_id uuid NULL,
  state text NOT NULL DEFAULT 'engaged' CHECK (state IN ('engaged', 'released')),
  engaged_by uuid NOT NULL REFERENCES trustwork.person (id),
  engaged_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  released_by uuid NULL REFERENCES trustwork.person (id),
  released_at timestamptz NULL,
  release_approval_id uuid NULL UNIQUE REFERENCES trustwork.second_person_approval (id),
  incident_note text NULL CHECK (length(incident_note) BETWEEN 1 AND 500),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_route_kill_scope CHECK (CASE scope_kind WHEN 'job' THEN module_key IS NULL AND extension_id IS NULL
    WHEN 'module' THEN module_key IS NOT NULL AND extension_id IS NULL ELSE extension_id IS NOT NULL AND module_key IS NULL END),
  CONSTRAINT provider_route_kill_release CHECK ((state = 'released') = (released_at IS NOT NULL)
    AND (state = 'engaged' OR (released_by IS NOT NULL AND release_approval_id IS NOT NULL AND incident_note IS NOT NULL))
    AND (state = 'released' OR (released_by IS NULL AND release_approval_id IS NULL)))
);
CREATE UNIQUE INDEX provider_route_kill_one_engaged ON trustwork.provider_route_kill_switch (hub_id, job, scope_kind, coalesce(module_key, ''),
  coalesce(extension_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE state = 'engaged';
CREATE TRIGGER provider_route_kill_touch BEFORE UPDATE ON trustwork.provider_route_kill_switch FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
CREATE FUNCTION trustwork.providers_route_kill_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_approval trustwork.second_person_approval%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'kill switches are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'audit.append_only';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'engaged' THEN
      RAISE EXCEPTION 'a kill switch is born engaged' USING ERRCODE = 'check_violation', HINT = 'providers.invalid_transition';
    END IF;
    NEW.engaged_at := now();
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.hub_id, NEW.job, NEW.scope_kind, NEW.module_key, NEW.extension_id, NEW.engaged_by, NEW.engaged_at, NEW.reason)
     IS DISTINCT FROM ROW(OLD.id, OLD.hub_id, OLD.job, OLD.scope_kind, OLD.module_key, OLD.extension_id, OLD.engaged_by, OLD.engaged_at, OLD.reason) THEN
    RAISE EXCEPTION 'a kill switch keeps its target' USING ERRCODE = 'integrity_constraint_violation', HINT = 'providers.invalid_transition';
  END IF;
  IF OLD.state = 'released' THEN
    RAISE EXCEPTION 'a released switch is final; engage a new one' USING ERRCODE = 'check_violation', HINT = 'providers.kill_not_engaged';
  END IF;
  IF NEW.state = 'released' THEN
    SELECT * INTO v_approval FROM trustwork.second_person_approval WHERE id = NEW.release_approval_id;
    IF NOT FOUND OR v_approval.action <> 'kill_switch.release' OR v_approval.status <> 'consumed' OR v_approval.consumed_ref IS DISTINCT FROM NEW.id
       OR v_approval.requested_by IS DISTINCT FROM NEW.released_by OR v_approval.approved_by = NEW.released_by
       OR v_approval.action_digest <> trustwork.admin_kill_switch_release_digest(NEW.id, NEW.incident_note) THEN
      RAISE EXCEPTION 'releasing needs the consumed second-person approval of exactly this release' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_mismatch';
    END IF;
    NEW.released_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER provider_route_kill_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.provider_route_kill_switch FOR EACH ROW EXECUTE FUNCTION trustwork.providers_route_kill_guard();

-- 9. Spend ledger: one row per authorized call (reserved, then settled or released); no person, no prompt ------------
CREATE TABLE trustwork.provider_usage (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  request_ref text NOT NULL CHECK (request_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  route_id uuid NOT NULL REFERENCES trustwork.model_route (id),
  candidates uuid[] NOT NULL CHECK (cardinality(candidates) BETWEEN 1 AND 4),
  connection_id uuid NULL REFERENCES trustwork.provider_connection (id),
  model_id text NULL CHECK (length(model_id) BETWEEN 1 AND 200),
  job text NOT NULL CHECK (job = ANY (trustwork.providers_model_jobs())),
  module_key text NULL CHECK (module_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  extension_id uuid NULL,
  pipeline_id uuid NULL,
  data_classes text[] NOT NULL CHECK (cardinality(data_classes) BETWEEN 1 AND 5 AND data_classes <@ trustwork.providers_data_classes()),
  budget_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  paid boolean NOT NULL,
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'settled', 'released')),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reserved_minor bigint NOT NULL CHECK (reserved_minor >= 0),
  cost_minor bigint NULL CHECK (cost_minor >= 0),
  outcome text NULL CHECK (outcome IN ('succeeded', 'failed', 'unknown')),
  input_tokens integer NULL CHECK (input_tokens >= 0),
  output_tokens integer NULL CHECK (output_tokens >= 0),
  images integer NULL CHECK (images >= 0),
  audio_seconds integer NULL CHECK (audio_seconds >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz NULL,
  CONSTRAINT provider_usage_settled CHECK ((state = 'settled') = (settled_at IS NOT NULL AND cost_minor IS NOT NULL AND outcome IS NOT NULL AND connection_id IS NOT NULL)),
  CONSTRAINT provider_usage_free CHECK (paid OR reserved_minor = 0)
);
CREATE INDEX provider_usage_hub_idx ON trustwork.provider_usage (hub_id, created_at);
CREATE INDEX provider_usage_budget_idx ON trustwork.provider_usage USING gin (budget_ids);

-- Alerts sent once per cap, period and threshold.
CREATE TABLE trustwork.provider_budget_alert (
  budget_id uuid NOT NULL REFERENCES trustwork.provider_budget (id),
  period_start timestamptz NOT NULL,
  kind text NOT NULL CHECK (kind IN ('alert', 'exhausted')),
  percent integer NOT NULL CHECK (percent BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (budget_id, period_start, kind, percent)
);

-- 10. Change log with before and after values (never a secret) --------------------------------------------------------
CREATE TABLE trustwork.provider_config_change (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  object_type text NOT NULL CHECK (object_type IN ('provider_connection', 'secret_ref', 'connection_test', 'model_route', 'egress_rule', 'provider_budget', 'model_pricing', 'kill_switch')),
  object_id uuid NOT NULL,
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.]{1,80}$'),
  actor_person_id uuid NULL REFERENCES trustwork.person (id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  before jsonb NULL CHECK (trustwork.providers_change_safe(before)),
  after jsonb NULL CHECK (trustwork.providers_change_safe(after)),
  approval_id uuid NULL REFERENCES trustwork.second_person_approval (id),
  request_id text NULL CHECK (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  -- Only the engine's own sweeps act without a person (a rotated secret's grace period ending).
  CONSTRAINT provider_config_change_actor CHECK (actor_person_id IS NOT NULL OR action IN ('providers.secret_grace_ended'))
);
CREATE INDEX provider_config_change_hub_idx ON trustwork.provider_config_change (hub_id, occurred_at);
CREATE INDEX provider_config_change_object_idx ON trustwork.provider_config_change (object_type, object_id);
CREATE TRIGGER provider_config_change_append_only BEFORE UPDATE OR DELETE ON trustwork.provider_config_change FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 11. Command plumbing (invoker helpers, not granted) -----------------------------------------------------------------
-- Records a staff change: the admin audit row (digests) unless the caller already wrote one, and the change log row
-- (values). Images come from to_jsonb of rows that hold no secret material.
CREATE FUNCTION trustwork.providers_log(p_actor trustwork.admin_actor, p_ctx jsonb, p_hub uuid, p_object_type text, p_object_id uuid, p_action text,
  p_before jsonb, p_after jsonb, p_approval uuid DEFAULT NULL, p_audit boolean DEFAULT true) RETURNS void
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF p_audit THEN
    PERFORM trustwork.admin_record(p_actor, p_ctx, NULL, p_hub, p_action, p_object_type, p_object_id, p_before, p_after, NULL, p_approval);
  END IF;
  INSERT INTO trustwork.provider_config_change (hub_id, object_type, object_id, action, actor_person_id, reason, before, after, approval_id, request_id)
  VALUES (p_hub, p_object_type, p_object_id, p_action, p_actor.person_id, p_ctx ->> 'reasonText', p_before, p_after, p_approval, p_ctx ->> 'requestId');
END $$;
-- Outbox intents carry identifiers only.
CREATE FUNCTION trustwork.providers_notify(p_kind text, p_id uuid, p_revision integer, p_type text, p_payload jsonb) RETURNS void
LANGUAGE sql SET search_path = trustwork, pg_temp AS $$
  INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload) VALUES (p_kind, p_id::text, greatest(p_revision, 1), p_type, p_payload)
$$;
CREATE FUNCTION trustwork.providers_expect(p_actual integer, p_expected integer) RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p_expected IS NULL OR p_actual <> p_expected THEN
    RAISE EXCEPTION 'the record changed (revision % expected %)', p_actual, p_expected USING ERRCODE = 'check_violation', HINT = 'providers.revision_conflict';
  END IF;
END $$;
CREATE FUNCTION trustwork.providers_connection_for_update(p_connection uuid) RETURNS trustwork.provider_connection
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_row trustwork.provider_connection%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM trustwork.provider_connection WHERE id = p_connection FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such connection' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  RETURN v_row;
END $$;
-- Is a connection covered by an engaged kill switch (its own, or the node's)?
CREATE FUNCTION trustwork.providers_connection_killed(p_connection uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM trustwork.kill_switch k WHERE k.state = 'engaged' AND ((k.scope_kind = 'provider_connection' AND k.connection_id = p_connection) OR k.scope_kind = 'node'))
$$;
-- providerEgressDecision of providers.ts for one connection and data class.
CREATE FUNCTION trustwork.providers_egress_reason(p_connection uuid, p_class text) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  c trustwork.provider_connection%ROWTYPE;
  r trustwork.egress_rule%ROWTYPE;
BEGIN
  SELECT * INTO c FROM trustwork.provider_connection WHERE id = p_connection;
  IF NOT FOUND THEN RETURN 'connection_not_enabled'; END IF;
  IF trustwork.providers_connection_killed(c.id) THEN RETURN 'killed'; END IF;
  IF c.status <> 'enabled' THEN RETURN 'connection_not_enabled'; END IF;
  IF cardinality(trustwork.providers_restricted(c.hub_id, c.processing_country, c.storage_country)) > 0 THEN RETURN 'restricted_place'; END IF;
  SELECT * INTO r FROM trustwork.egress_rule WHERE connection_id = c.id AND data_class = p_class ORDER BY version DESC LIMIT 1;
  IF NOT FOUND THEN RETURN 'no_rule'; END IF;
  IF r.decision = 'deny' THEN RETURN 'denied'; END IF;
  IF p_class <> 'public' AND c.hosting_kind = 'vendor' AND c.trains_on_inputs THEN RETURN 'training'; END IF;
  IF p_class <> 'public' AND c.hosting_kind = 'vendor' AND c.broker THEN RETURN 'broker'; END IF;
  IF (r.require_in_residency OR p_class <> 'public') AND NOT trustwork.providers_in_residency(c.hub_id, c.processing_country, c.storage_country) THEN RETURN 'residency'; END IF;
  IF (r.require_zero_retention OR p_class <> 'public') AND c.hosting_kind = 'vendor' AND NOT c.zero_retention THEN RETURN 'retention'; END IF;
  RETURN 'allowed';
END $$;
CREATE FUNCTION trustwork.providers_period_start(p_period text, p_hub uuid) RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT date_trunc(p_period, now() AT TIME ZONE tz) AT TIME ZONE tz
  FROM (SELECT coalesce((SELECT p.time_zone FROM trustwork.hub_profile p WHERE p.hub_id = p_hub), 'UTC') AS tz) z
$$;
-- What a cap has used in its current period: settled cost plus open reservations (released calls count nothing).
CREATE FUNCTION trustwork.providers_budget_used(p_budget uuid) RETURNS TABLE (spent bigint, reserved bigint, period_start timestamptz)
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT coalesce(sum(u.cost_minor) FILTER (WHERE u.state = 'settled'), 0)::bigint, coalesce(sum(u.reserved_minor) FILTER (WHERE u.state = 'reserved'), 0)::bigint, s.ps
  FROM trustwork.provider_budget b
  CROSS JOIN LATERAL (SELECT trustwork.providers_period_start(b.period, b.hub_id) AS ps) s
  LEFT JOIN trustwork.provider_usage u ON u.hub_id = b.hub_id AND u.budget_ids @> ARRAY[b.id] AND u.created_at >= s.ps
  WHERE b.id = p_budget
  GROUP BY s.ps
$$;
-- Alerts for the caps a call counted against, once per cap, period and threshold.
CREATE FUNCTION trustwork.providers_budget_alerts(p_budgets uuid[]) RETURNS void
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  b trustwork.provider_budget%ROWTYPE;
  u record;
  v_used bigint;
  v_percent integer;
  v_threshold integer;
  v_inserted integer;
BEGIN
  FOR b IN SELECT * FROM trustwork.provider_budget WHERE id = ANY (p_budgets) AND status = 'active' LOOP
    SELECT * INTO u FROM trustwork.providers_budget_used(b.id);
    v_used := u.spent + u.reserved;
    v_percent := CASE WHEN b.limit_minor = 0 THEN 100 ELSE least(100, (v_used * 100 / b.limit_minor)::integer) END;
    FOREACH v_threshold IN ARRAY b.alert_at_percent LOOP
      IF v_percent >= v_threshold THEN
        INSERT INTO trustwork.provider_budget_alert (budget_id, period_start, kind, percent) VALUES (b.id, u.period_start, 'alert', v_threshold) ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        IF v_inserted > 0 THEN
          PERFORM trustwork.providers_notify('provider_budget', b.id, b.revision, 'providers.cap_alert',
            jsonb_build_object('hubId', b.hub_id, 'budgetId', b.id, 'percent', v_threshold, 'periodStart', u.period_start));
        END IF;
      END IF;
    END LOOP;
    IF v_used >= b.limit_minor THEN
      INSERT INTO trustwork.provider_budget_alert (budget_id, period_start, kind, percent) VALUES (b.id, u.period_start, 'exhausted', 100) ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS v_inserted = ROW_COUNT;
      IF v_inserted > 0 THEN
        PERFORM trustwork.providers_notify('provider_budget', b.id, b.revision, 'providers.cap_exhausted',
          jsonb_build_object('hubId', b.hub_id, 'budgetId', b.id, 'onExhausted', b.on_exhausted, 'periodStart', u.period_start));
      END IF;
    END IF;
  END LOOP;
END $$;

-- 12. Staff commands (SECURITY DEFINER, allowlisted for the runtime role) ---------------------------------------------
CREATE FUNCTION trustwork.providers_create_connection(p_ctx jsonb, p_hub uuid, p_adapter text, p_mode text, p_label text, p_capabilities text[], p_endpoint text,
  p_hosting_kind text, p_processing text, p_zero boolean, p_trains boolean, p_broker boolean, p_storage text, p_region text, p_credential uuid)
RETURNS trustwork.provider_connection
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.providers.connection.edit'], NULL, p_hub);
  v_row trustwork.provider_connection%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM trustwork.hub_profile WHERE hub_id = p_hub) THEN
    RAISE EXCEPTION 'no such hub' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF NOT trustwork.providers_endpoint_ok(p_endpoint, p_hosting_kind) THEN
    RAISE EXCEPTION 'the endpoint is not allowed for this hosting' USING ERRCODE = 'check_violation', HINT = 'providers.endpoint_not_allowed';
  END IF;
  IF p_mode = 'fake' AND p_credential IS NOT NULL THEN
    RAISE EXCEPTION 'fake adapters never hold secrets' USING ERRCODE = 'check_violation', HINT = 'providers.fake_holds_no_secret';
  END IF;
  INSERT INTO trustwork.provider_connection (hub_id, adapter_id, label, capabilities, mode, endpoint, hosting_kind, processing_country, storage_country, region,
    zero_retention, trains_on_inputs, broker, credential_ref_id, created_by)
  VALUES (p_hub, p_adapter, p_label, p_capabilities, p_mode, p_endpoint, p_hosting_kind, p_processing, p_storage, p_region,
    CASE WHEN p_hosting_kind = 'vendor' THEN p_zero END, CASE WHEN p_hosting_kind = 'vendor' THEN p_trains END, CASE WHEN p_hosting_kind = 'vendor' THEN p_broker END,
    p_credential, v_actor.person_id) RETURNING * INTO v_row;
  PERFORM trustwork.providers_log(v_actor, p_ctx, p_hub, 'provider_connection', v_row.id, 'providers.connection_created', NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Changing where data goes (endpoint, hosting, storage, credential) returns an enabled connection to draft.
CREATE FUNCTION trustwork.providers_update_connection(p_ctx jsonb, p_connection uuid, p_expected integer, p_label text, p_capabilities text[], p_endpoint text,
  p_hosting_kind text, p_processing text, p_zero boolean, p_trains boolean, p_broker boolean, p_storage text, p_region text, p_credential uuid)
RETURNS trustwork.provider_connection
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.provider_connection%ROWTYPE := trustwork.providers_connection_for_update(p_connection);
  v_actor trustwork.admin_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.providers.connection.edit'], NULL, v_before.hub_id);
  v_row trustwork.provider_connection%ROWTYPE;
  v_moved boolean;
BEGIN
  PERFORM trustwork.providers_expect(v_before.revision, p_expected);
  IF NOT trustwork.providers_endpoint_ok(p_endpoint, p_hosting_kind) THEN
    RAISE EXCEPTION 'the endpoint is not allowed for this hosting' USING ERRCODE = 'check_violation', HINT = 'providers.endpoint_not_allowed';
  END IF;
  IF v_before.mode = 'fake' AND p_credential IS NOT NULL THEN
    RAISE EXCEPTION 'fake adapters never hold secrets' USING ERRCODE = 'check_violation', HINT = 'providers.fake_holds_no_secret';
  END IF;
  v_moved := ROW(p_capabilities, p_endpoint, p_hosting_kind, p_processing, p_storage, CASE WHEN p_hosting_kind = 'vendor' THEN p_zero END,
                 CASE WHEN p_hosting_kind = 'vendor' THEN p_trains END, CASE WHEN p_hosting_kind = 'vendor' THEN p_broker END, p_credential)
    IS DISTINCT FROM ROW(v_before.capabilities, v_before.endpoint, v_before.hosting_kind, v_before.processing_country, v_before.storage_country, v_before.zero_retention,
                 v_before.trains_on_inputs, v_before.broker, v_before.credential_ref_id);
  UPDATE trustwork.provider_connection SET label = p_label, capabilities = p_capabilities, endpoint = p_endpoint, hosting_kind = p_hosting_kind, processing_country = p_processing,
    storage_country = p_storage, region = p_region, zero_retention = CASE WHEN p_hosting_kind = 'vendor' THEN p_zero END,
    trains_on_inputs = CASE WHEN p_hosting_kind = 'vendor' THEN p_trains END, broker = CASE WHEN p_hosting_kind = 'vendor' THEN p_broker END, credential_ref_id = p_credential,
    status = CASE WHEN v_moved AND status = 'enabled' THEN 'draft' ELSE status END,
    enabled_by = CASE WHEN v_moved AND status = 'enabled' THEN NULL ELSE enabled_by END,
    enabled_at = CASE WHEN v_moved AND status = 'enabled' THEN NULL ELSE enabled_at END,
    approval_id = CASE WHEN v_moved AND status = 'enabled' THEN NULL ELSE approval_id END
   WHERE id = p_connection RETURNING * INTO v_row;
  PERFORM trustwork.providers_log(v_actor, p_ctx, v_row.hub_id, 'provider_connection', v_row.id, 'providers.connection_updated', to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Stores a sealed secret (the API sealed it; no plaintext reaches the database). A rotation keeps the previous version in
-- grace for p_grace_hours (0 destroys it at once).
CREATE FUNCTION trustwork.providers_store_secret(p_ctx jsonb, p_connection uuid, p_expected integer, p_fingerprint text, p_ciphertext bytea, p_iv bytea, p_tag bytea,
  p_wrapped bytea, p_kek text, p_grace_hours integer) RETURNS trustwork.secret_ref
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_conn trustwork.provider_connection%ROWTYPE := trustwork.providers_connection_for_update(p_connection);
  v_actor trustwork.admin_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.providers.secret.write'], NULL, v_conn.hub_id);
  v_previous trustwork.secret_ref%ROWTYPE;
  v_previous_after trustwork.secret_ref%ROWTYPE;
  v_row trustwork.secret_ref%ROWTYPE;
  v_version integer;
BEGIN
  PERFORM trustwork.providers_expect(v_conn.revision, p_expected);
  IF v_conn.mode = 'fake' THEN
    RAISE EXCEPTION 'fake adapters never hold secrets' USING ERRCODE = 'check_violation', HINT = 'providers.fake_holds_no_secret';
  END IF;
  IF v_conn.credential_ref_id IS NOT NULL THEN
    RAISE EXCEPTION 'this connection reads its secret through a credential reference' USING ERRCODE = 'check_violation', HINT = 'providers.invalid_transition';
  END IF;
  IF p_grace_hours IS NULL OR p_grace_hours < 0 OR p_grace_hours > 168 THEN
    RAISE EXCEPTION 'grace between 0 and 168 hours' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.context_invalid';
  END IF;
  SELECT * INTO v_previous FROM trustwork.secret_ref WHERE connection_id = p_connection AND status = 'active' FOR UPDATE;
  IF FOUND THEN
    IF p_grace_hours = 0 THEN
      UPDATE trustwork.secret_ref SET status = 'destroyed', rotated_at = now() WHERE id = v_previous.id RETURNING * INTO v_previous_after;
      DELETE FROM trustwork.secret_version WHERE secret_ref_id = v_previous.id;
    ELSE
      UPDATE trustwork.secret_ref SET status = 'grace', rotated_at = now(), grace_until = now() + make_interval(hours => p_grace_hours) WHERE id = v_previous.id RETURNING * INTO v_previous_after;
    END IF;
    PERFORM trustwork.providers_log(v_actor, p_ctx, v_conn.hub_id, 'secret_ref', v_previous.id, 'providers.secret_rotated', to_jsonb(v_previous), to_jsonb(v_previous_after));
  END IF;
  SELECT coalesce(max(version), 0) + 1 INTO v_version FROM trustwork.secret_ref WHERE connection_id = p_connection;
  INSERT INTO trustwork.secret_ref (connection_id, hub_id, ref, keyed_fingerprint, version, created_by)
  VALUES (p_connection, v_conn.hub_id, 'connection:' || p_connection::text || ':v' || v_version, p_fingerprint, v_version, v_actor.person_id) RETURNING * INTO v_row;
  INSERT INTO trustwork.secret_version (secret_ref_id, ciphertext, iv, auth_tag, wrapped_key, kek_id) VALUES (v_row.id, p_ciphertext, p_iv, p_tag, p_wrapped, p_kek);
  -- The connection's revision moves so a pending enabling approval (which binds the fingerprint) no longer matches.
  UPDATE trustwork.provider_connection SET secret_generation = secret_generation + 1 WHERE id = p_connection;
  PERFORM trustwork.providers_log(v_actor, p_ctx, v_conn.hub_id, 'secret_ref', v_row.id, 'providers.secret_written', NULL, to_jsonb(v_row));
  PERFORM trustwork.providers_notify('provider_connection', p_connection, v_conn.revision + 1, 'providers.secret_written',
    jsonb_build_object('hubId', v_conn.hub_id, 'connectionId', p_connection, 'secretRefId', v_row.id, 'version', v_version));
  RETURN v_row;
END $$;

-- Revocation: every version destroyed at once; the connection stops (disabled).
CREATE FUNCTION trustwork.providers_revoke_secret(p_ctx jsonb, p_connection uuid, p_expected integer) RETURNS trustwork.provider_connection
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.provider_connection%ROWTYPE := trustwork.providers_connection_for_update(p_connection);
  v_actor trustwork.admin_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.providers.secret.write'], NULL, v_before.hub_id);
  v_row trustwork.provider_connection%ROWTYPE;
  v_ref trustwork.secret_ref%ROWTYPE;
  v_ref_after trustwork.secret_ref%ROWTYPE;
BEGIN
  PERFORM trustwork.providers_expect(v_before.revision, p_expected);
  IF NOT EXISTS (SELECT 1 FROM trustwork.secret_ref WHERE connection_id = p_connection AND status <> 'destroyed') THEN
    RAISE EXCEPTION 'no secret to revoke' USING ERRCODE = 'check_violation', HINT = 'providers.secret_not_found';
  END IF;
  FOR v_ref IN SELECT * FROM trustwork.secret_ref WHERE connection_id = p_connection AND status <> 'destroyed' ORDER BY version FOR UPDATE LOOP
    UPDATE trustwork.secret_ref SET status = 'destroyed' WHERE id = v_ref.id RETURNING * INTO v_ref_after;
    DELETE FROM trustwork.secret_version WHERE secret_ref_id = v_ref.id;
    PERFORM trustwork.providers_log(v_actor, p_ctx, v_before.hub_id, 'secret_ref', v_ref.id, 'providers.secret_revoked', to_jsonb(v_ref), to_jsonb(v_ref_after));
  END LOOP;
  UPDATE trustwork.provider_connection SET status = CASE WHEN status = 'enabled' THEN 'disabled' ELSE status END, secret_generation = secret_generation + 1,
    enabled_by = NULL, enabled_at = NULL, approval_id = NULL WHERE id = p_connection RETURNING * INTO v_row;
  PERFORM trustwork.providers_log(v_actor, p_ctx, v_row.hub_id, 'provider_connection', v_row.id, 'providers.connection_secret_revoked', to_jsonb(v_before), to_jsonb(v_row));
  PERFORM trustwork.providers_notify('provider_connection', p_connection, v_row.revision, 'providers.secret_revoked', jsonb_build_object('hubId', v_row.hub_id, 'connectionId', p_connection));
  RETURN v_row;
END $$;

-- What a connection test needs: the sealed secret of the active version (or the credential reference) and the digest of
-- the configuration it tests. Staff with admin.providers.test only; nothing is recorded until the result is.
CREATE FUNCTION trustwork.providers_test_material(p_ctx jsonb, p_connection uuid)
RETURNS TABLE (config_digest text, secret_ref_id uuid, ciphertext bytea, iv bytea, auth_tag bytea, wrapped_key bytea, kek_id text, credential_store text, credential_ref text, credential_status text)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_conn trustwork.provider_connection%ROWTYPE;
BEGIN
  SELECT * INTO v_conn FROM trustwork.provider_connection WHERE id = p_connection;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such connection' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  PERFORM trustwork.admin_authorize(p_ctx, ARRAY['admin.providers.test'], NULL, v_conn.hub_id);
  RETURN QUERY
    SELECT trustwork.providers_config_digest(v_conn.id), r.id, v.ciphertext, v.iv, v.auth_tag, v.wrapped_key, v.kek_id, cr.secret_store, cr.secret_ref, cr.status
    FROM (SELECT 1) one
    LEFT JOIN trustwork.secret_ref r ON r.connection_id = v_conn.id AND r.status = 'active'
    LEFT JOIN trustwork.secret_version v ON v.secret_ref_id = r.id
    LEFT JOIN trustwork.provider_credential_ref cr ON cr.id = v_conn.credential_ref_id;
END $$;

CREATE FUNCTION trustwork.providers_record_test(p_ctx jsonb, p_connection uuid, p_config_digest text, p_outcome text, p_latency integer, p_models integer,
  p_cost_minor bigint, p_cost_currency text, p_probe_digest text, p_secret_ref uuid) RETURNS trustwork.connection_test
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_conn trustwork.provider_connection%ROWTYPE := trustwork.providers_connection_for_update(p_connection);
  v_actor trustwork.admin_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.providers.test'], NULL, v_conn.hub_id);
  v_row trustwork.connection_test%ROWTYPE;
BEGIN
  IF p_config_digest IS DISTINCT FROM trustwork.providers_config_digest(p_connection) THEN
    RAISE EXCEPTION 'the connection changed during the test; test again' USING ERRCODE = 'check_violation', HINT = 'providers.revision_conflict';
  END IF;
  INSERT INTO trustwork.connection_test (connection_id, hub_id, tested_by, outcome, latency_ms, models_listed, cost_minor, cost_currency, probe_digest, config_digest, secret_ref_id)
  VALUES (p_connection, v_conn.hub_id, v_actor.person_id, p_outcome, p_latency, p_models, p_cost_minor, p_cost_currency, p_probe_digest, p_config_digest, p_secret_ref) RETURNING * INTO v_row;
  UPDATE trustwork.provider_connection SET last_test_id = v_row.id WHERE id = p_connection;
  PERFORM trustwork.providers_log(v_actor, p_ctx, v_conn.hub_id, 'connection_test', v_row.id, 'providers.connection_tested', NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Enabling: a passing test of exactly the current configuration; a live vendor connection needs its secret; a non-fake
-- connection consumes providers.enable_non_fake bound to providers_connection_digest.
CREATE FUNCTION trustwork.providers_enable_connection(p_ctx jsonb, p_connection uuid, p_expected integer, p_approval uuid) RETURNS trustwork.provider_connection
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.provider_connection%ROWTYPE := trustwork.providers_connection_for_update(p_connection);
  v_actor trustwork.admin_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.providers.toggle'], NULL, v_before.hub_id);
  v_test trustwork.connection_test%ROWTYPE;
  v_approval trustwork.second_person_approval%ROWTYPE;
  v_row trustwork.provider_connection%ROWTYPE;
BEGIN
  PERFORM trustwork.providers_expect(v_before.revision, p_expected);
  IF v_before.status = 'enabled' THEN
    RAISE EXCEPTION 'already enabled' USING ERRCODE = 'check_violation', HINT = 'providers.invalid_transition';
  END IF;
  IF trustwork.providers_connection_killed(p_connection) THEN
    RAISE EXCEPTION 'release the kill switch first' USING ERRCODE = 'check_violation', HINT = 'providers.connection_killed';
  END IF;
  SELECT * INTO v_test FROM trustwork.connection_test WHERE id = v_before.last_test_id;
  IF NOT FOUND OR v_test.config_digest IS DISTINCT FROM trustwork.providers_config_digest(p_connection) THEN
    RAISE EXCEPTION 'test the current configuration first' USING ERRCODE = 'check_violation', HINT = 'providers.test_required';
  END IF;
  IF v_test.outcome <> 'ok' THEN
    RAISE EXCEPTION 'the last test did not pass' USING ERRCODE = 'check_violation', HINT = 'providers.test_failed';
  END IF;
  IF v_before.mode = 'live' AND v_before.hosting_kind = 'vendor' AND v_before.credential_ref_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM trustwork.secret_ref WHERE connection_id = p_connection AND status = 'active') THEN
    RAISE EXCEPTION 'a live vendor connection needs its secret' USING ERRCODE = 'check_violation', HINT = 'providers.secret_required';
  END IF;
  IF v_before.credential_ref_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trustwork.provider_credential_ref WHERE id = v_before.credential_ref_id AND status = 'active') THEN
    RAISE EXCEPTION 'the credential reference is not active' USING ERRCODE = 'check_violation', HINT = 'providers.credential_not_active';
  END IF;
  IF v_before.mode <> 'fake' THEN
    IF p_approval IS NULL THEN
      RAISE EXCEPTION 'enabling a non-fake connection needs a second person''s approval' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_required';
    END IF;
    v_approval := trustwork.admin_consume_approval(p_approval, 'providers.enable_non_fake', 'hub', NULL, v_before.hub_id, trustwork.providers_connection_digest(p_connection), p_connection);
  END IF;
  UPDATE trustwork.provider_connection SET status = 'enabled', enabled_by = v_actor.person_id, enabled_at = now(), approval_id = v_approval.id
   WHERE id = p_connection RETURNING * INTO v_row;
  PERFORM trustwork.providers_log(v_actor, p_ctx, v_row.hub_id, 'provider_connection', v_row.id, 'providers.connection_enabled', to_jsonb(v_before), to_jsonb(v_row), v_approval.id);
  PERFORM trustwork.providers_notify('provider_connection', p_connection, v_row.revision, 'providers.connection_enabled', jsonb_build_object('hubId', v_row.hub_id, 'connectionId', p_connection, 'mode', v_row.mode));
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.providers_disable_connection(p_ctx jsonb, p_connection uuid, p_expected integer) RETURNS trustwork.provider_connection
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.provider_connection%ROWTYPE := trustwork.providers_connection_for_update(p_connection);
  v_actor trustwork.admin_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.providers.toggle'], NULL, v_before.hub_id);
  v_row trustwork.provider_connection%ROWTYPE;
BEGIN
  PERFORM trustwork.providers_expect(v_before.revision, p_expected);
  IF v_before.status = 'disabled' THEN
    RAISE EXCEPTION 'already disabled' USING ERRCODE = 'check_violation', HINT = 'providers.invalid_transition';
  END IF;
  UPDATE trustwork.provider_connection SET status = 'disabled', enabled_by = NULL, enabled_at = NULL, approval_id = NULL WHERE id = p_connection RETURNING * INTO v_row;
  PERFORM trustwork.providers_log(v_actor, p_ctx, v_row.hub_id, 'provider_connection', v_row.id, 'providers.connection_disabled', to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- One egress cell (a new version). A non-public allow is refused where the decision would refuse it anyway (training,
-- broker, outside residency, retention) and otherwise consumes egress.allow_private_class.
CREATE FUNCTION trustwork.providers_set_egress_rule(p_ctx jsonb, p_connection uuid, p_class text, p_decision text, p_residency boolean, p_zero boolean, p_approval uuid)
RETURNS trustwork.egress_rule
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_conn trustwork.provider_connection%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_before trustwork.egress_rule%ROWTYPE;
  v_row trustwork.egress_rule%ROWTYPE;
  v_version integer;
  v_id uuid := trustwork.new_uuid();
  v_approval trustwork.second_person_approval%ROWTYPE;
BEGIN
  SELECT * INTO v_conn FROM trustwork.provider_connection WHERE id = p_connection;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such connection' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.providers.egress.edit'], NULL, v_conn.hub_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('trustwork.providers.egress:' || p_connection::text || ':' || coalesce(p_class, ''), 0));
  SELECT * INTO v_before FROM trustwork.egress_rule WHERE connection_id = p_connection AND data_class = p_class ORDER BY version DESC LIMIT 1;
  v_version := coalesce(v_before.version, 0) + 1;
  IF p_decision = 'allow' AND p_class <> 'public' THEN
    IF NOT (p_residency AND p_zero) THEN
      RAISE EXCEPTION 'allowing non-public data needs in-residency processing and zero retention' USING ERRCODE = 'check_violation', HINT = 'providers.egress_not_in_residency';
    END IF;
    IF v_conn.hosting_kind = 'vendor' AND v_conn.trains_on_inputs THEN
      RAISE EXCEPTION 'a vendor that trains on inputs never receives non-public data' USING ERRCODE = 'check_violation', HINT = 'providers.egress_training';
    END IF;
    IF v_conn.hosting_kind = 'vendor' AND v_conn.broker THEN
      RAISE EXCEPTION 'brokers carry public data only' USING ERRCODE = 'check_violation', HINT = 'providers.egress_broker';
    END IF;
    IF NOT trustwork.providers_in_residency(v_conn.hub_id, v_conn.processing_country, v_conn.storage_country) THEN
      RAISE EXCEPTION 'the connection processes or stores data outside the hub''s residency' USING ERRCODE = 'check_violation', HINT = 'providers.egress_not_in_residency';
    END IF;
    IF v_conn.hosting_kind = 'vendor' AND NOT v_conn.zero_retention THEN
      RAISE EXCEPTION 'the vendor retains inputs' USING ERRCODE = 'check_violation', HINT = 'providers.egress_retention';
    END IF;
    IF p_approval IS NULL THEN
      RAISE EXCEPTION 'allowing a non-public class needs a second person''s approval' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_required';
    END IF;
    v_approval := trustwork.admin_consume_approval(p_approval, 'egress.allow_private_class', 'hub', NULL, v_conn.hub_id,
      trustwork.providers_egress_digest(v_conn.hub_id, p_connection, p_class, p_residency, p_zero, v_version), v_id);
  END IF;
  INSERT INTO trustwork.egress_rule (id, hub_id, connection_id, data_class, decision, require_in_residency, require_zero_retention, version, approval_id, reason, created_by)
  VALUES (v_id, v_conn.hub_id, p_connection, p_class, p_decision, p_residency, p_zero, v_version, v_approval.id, p_ctx ->> 'reasonText', v_actor.person_id) RETURNING * INTO v_row;
  PERFORM trustwork.providers_log(v_actor, p_ctx, v_conn.hub_id, 'egress_rule', v_row.id, 'providers.egress_rule_set', CASE WHEN v_before.id IS NULL THEN NULL ELSE to_jsonb(v_before) END,
    to_jsonb(v_row), v_approval.id);
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.providers_draft_route(p_ctx jsonb, p_hub uuid, p_job text, p_scope_kind text, p_module text, p_extension uuid, p_primary jsonb, p_fallbacks jsonb,
  p_classes text[], p_max_input integer, p_max_output integer, p_max_file bigint, p_timeout integer, p_budget uuid) RETURNS trustwork.model_route
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.models.route.edit'], NULL, p_hub);
  v_row trustwork.model_route%ROWTYPE;
  v_version integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM trustwork.hub_profile WHERE hub_id = p_hub) THEN
    RAISE EXCEPTION 'no such hub' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF p_job IN ('embeddings', 'rerank') AND jsonb_array_length(coalesce(p_fallbacks, '[]'::jsonb)) > 0 THEN
    RAISE EXCEPTION 'vectors and scores never mix models: no fallbacks' USING ERRCODE = 'check_violation', HINT = 'providers.route_fallbacks_forbidden';
  END IF;
  IF p_job = 'image_generation' AND p_classes IS DISTINCT FROM ARRAY['public']::text[] THEN
    RAISE EXCEPTION 'image prompts may contain public data only' USING ERRCODE = 'check_violation', HINT = 'providers.route_public_only';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('trustwork.providers.route:' || p_hub::text || ':' || p_job || ':' || p_scope_kind || ':' || coalesce(p_module, '') || ':' || coalesce(p_extension::text, ''), 0));
  SELECT coalesce(max(version), 0) + 1 INTO v_version FROM trustwork.model_route
   WHERE hub_id = p_hub AND job = p_job AND scope_kind = p_scope_kind AND module_key IS NOT DISTINCT FROM p_module AND extension_id IS NOT DISTINCT FROM p_extension;
  INSERT INTO trustwork.model_route (hub_id, job, scope_kind, module_key, extension_id, version, primary_ref, fallbacks, allowed_data_classes, max_input_tokens, max_output_tokens,
    max_file_bytes, timeout_ms, budget_id, reason, drafted_by)
  VALUES (p_hub, p_job, p_scope_kind, p_module, p_extension, v_version, p_primary, coalesce(p_fallbacks, '[]'::jsonb), p_classes, p_max_input, p_max_output, p_max_file, p_timeout,
    p_budget, p_ctx ->> 'reasonText', v_actor.person_id) RETURNING * INTO v_row;
  PERFORM trustwork.providers_log(v_actor, p_ctx, p_hub, 'model_route', v_row.id, 'providers.route_drafted', NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Activation: pinned revisions, enabled connections of the hub outside restricted places, residency for non-public
-- classes, and for those a second person; supersedes the active version of the same job and scope.
CREATE FUNCTION trustwork.providers_activate_route(p_ctx jsonb, p_route uuid, p_expected integer, p_approval uuid) RETURNS trustwork.model_route
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.model_route%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_previous trustwork.model_route%ROWTYPE;
  v_previous_after trustwork.model_route%ROWTYPE;
  v_row trustwork.model_route%ROWTYPE;
  v_approval trustwork.second_person_approval%ROWTYPE;
  v_private boolean;
BEGIN
  SELECT * INTO v_before FROM trustwork.model_route WHERE id = p_route;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such route' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.models.route.activate'], NULL, v_before.hub_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('trustwork.providers.route:' || v_before.hub_id::text || ':' || v_before.job || ':' || v_before.scope_kind || ':'
    || coalesce(v_before.module_key, '') || ':' || coalesce(v_before.extension_id::text, ''), 0));
  SELECT * INTO v_before FROM trustwork.model_route WHERE id = p_route FOR UPDATE;
  PERFORM trustwork.providers_expect(v_before.revision, p_expected);
  IF v_before.status <> 'draft' THEN
    RAISE EXCEPTION 'only a draft is activated' USING ERRCODE = 'check_violation', HINT = 'providers.invalid_transition';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.providers_route_refs(v_before.primary_ref, v_before.fallbacks) x WHERE jsonb_typeof(x.ref -> 'modelRevision') <> 'string') THEN
    RAISE EXCEPTION 'active routes name pinned provider revisions' USING ERRCODE = 'check_violation', HINT = 'providers.route_unpinned';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.providers_route_refs(v_before.primary_ref, v_before.fallbacks) x
             JOIN trustwork.provider_connection c ON c.id = (x.ref ->> 'connectionId')::uuid
             WHERE c.status <> 'enabled' OR cardinality(trustwork.providers_restricted(c.hub_id, c.processing_country, c.storage_country)) > 0) THEN
    RAISE EXCEPTION 'every model of an active route is on an enabled connection' USING ERRCODE = 'check_violation', HINT = 'providers.route_connection_unusable';
  END IF;
  v_private := EXISTS (SELECT 1 FROM unnest(v_before.allowed_data_classes) c WHERE c <> 'public');
  IF v_private THEN
    IF EXISTS (SELECT 1 FROM trustwork.providers_route_refs(v_before.primary_ref, v_before.fallbacks) x
               JOIN trustwork.provider_connection c ON c.id = (x.ref ->> 'connectionId')::uuid
               WHERE NOT trustwork.providers_in_residency(c.hub_id, c.processing_country, c.storage_country)) THEN
      RAISE EXCEPTION 'a route for non-public data stays in the hub''s residency' USING ERRCODE = 'check_violation', HINT = 'providers.route_outside_residency';
    END IF;
    IF v_before.drafted_by = v_actor.person_id THEN
      RAISE EXCEPTION 'a route that may carry non-public data is activated by someone other than its drafter' USING ERRCODE = 'insufficient_privilege', HINT = 'providers.drafter_cannot_activate';
    END IF;
    IF p_approval IS NULL THEN
      RAISE EXCEPTION 'activating a non-public route needs a second person''s approval' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_required';
    END IF;
    v_approval := trustwork.admin_consume_approval(p_approval, 'models.activate_private_route', 'hub', NULL, v_before.hub_id, trustwork.providers_route_digest(p_route), p_route);
  END IF;
  SELECT * INTO v_previous FROM trustwork.model_route
   WHERE hub_id = v_before.hub_id AND job = v_before.job AND scope_kind = v_before.scope_kind AND module_key IS NOT DISTINCT FROM v_before.module_key
     AND extension_id IS NOT DISTINCT FROM v_before.extension_id AND status = 'active' FOR UPDATE;
  IF FOUND THEN
    UPDATE trustwork.model_route SET status = 'superseded' WHERE id = v_previous.id RETURNING * INTO v_previous_after;
    PERFORM trustwork.providers_log(v_actor, p_ctx, v_before.hub_id, 'model_route', v_previous.id, 'providers.route_superseded', to_jsonb(v_previous), to_jsonb(v_previous_after));
  END IF;
  UPDATE trustwork.model_route SET status = 'active', activated_by = v_actor.person_id, activated_at = now(), approval_id = v_approval.id WHERE id = p_route RETURNING * INTO v_row;
  PERFORM trustwork.providers_log(v_actor, p_ctx, v_row.hub_id, 'model_route', v_row.id, 'providers.route_activated', to_jsonb(v_before), to_jsonb(v_row), v_approval.id);
  PERFORM trustwork.providers_notify('model_route', v_row.id, v_row.revision, 'providers.route_activated', jsonb_build_object('hubId', v_row.hub_id, 'routeId', v_row.id, 'job', v_row.job, 'version', v_row.version));
  RETURN v_row;
END $$;

-- Disabling narrows risk: one person; calls of the job and scope then resolve the next less specific route or stop.
CREATE FUNCTION trustwork.providers_disable_route(p_ctx jsonb, p_route uuid, p_expected integer) RETURNS trustwork.model_route
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.model_route%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.model_route%ROWTYPE;
BEGIN
  SELECT * INTO v_before FROM trustwork.model_route WHERE id = p_route FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such route' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.models.route.activate', 'admin.models.route.edit'], NULL, v_before.hub_id);
  PERFORM trustwork.providers_expect(v_before.revision, p_expected);
  IF v_before.status NOT IN ('draft', 'active') THEN
    RAISE EXCEPTION 'only a draft or the active version is disabled' USING ERRCODE = 'check_violation', HINT = 'providers.invalid_transition';
  END IF;
  UPDATE trustwork.model_route SET status = 'disabled', disabled_by = v_actor.person_id, disabled_at = now() WHERE id = p_route RETURNING * INTO v_row;
  PERFORM trustwork.providers_log(v_actor, p_ctx, v_row.hub_id, 'model_route', v_row.id, 'providers.route_disabled', to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.providers_create_budget(p_ctx jsonb, p_hub uuid, p_scope_kind text, p_job text, p_pipeline uuid, p_module text, p_connection uuid, p_period text,
  p_limit bigint, p_currency text, p_alerts integer[], p_on_exhausted text) RETURNS trustwork.provider_budget
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.providers.budget.edit'], NULL, p_hub);
  v_row trustwork.provider_budget%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM trustwork.hub_profile WHERE hub_id = p_hub) THEN
    RAISE EXCEPTION 'no such hub' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  INSERT INTO trustwork.provider_budget (hub_id, scope_kind, job, pipeline_id, module_key, connection_id, period, limit_minor, currency, alert_at_percent, on_exhausted, created_by)
  VALUES (p_hub, p_scope_kind, p_job, p_pipeline, p_module, p_connection, p_period, p_limit, p_currency, coalesce(p_alerts, ARRAY[]::integer[]), p_on_exhausted, v_actor.person_id)
  RETURNING * INTO v_row;
  PERFORM trustwork.providers_log(v_actor, p_ctx, p_hub, 'provider_budget', v_row.id, 'providers.cap_created', NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.providers_update_budget(p_ctx jsonb, p_budget uuid, p_expected integer, p_limit bigint, p_currency text, p_alerts integer[], p_on_exhausted text)
RETURNS trustwork.provider_budget
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.provider_budget%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.provider_budget%ROWTYPE;
BEGIN
  SELECT * INTO v_before FROM trustwork.provider_budget WHERE id = p_budget FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such cap' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.providers.budget.edit'], NULL, v_before.hub_id);
  PERFORM trustwork.providers_expect(v_before.revision, p_expected);
  IF p_currency IS DISTINCT FROM v_before.currency THEN
    RAISE EXCEPTION 'a cap keeps its currency' USING ERRCODE = 'check_violation', HINT = 'providers.cap_currency';
  END IF;
  UPDATE trustwork.provider_budget SET limit_minor = p_limit, alert_at_percent = coalesce(p_alerts, ARRAY[]::integer[]), on_exhausted = p_on_exhausted WHERE id = p_budget RETURNING * INTO v_row;
  PERFORM trustwork.providers_log(v_actor, p_ctx, v_row.hub_id, 'provider_budget', v_row.id, 'providers.cap_updated', to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

CREATE FUNCTION trustwork.providers_retire_budget(p_ctx jsonb, p_budget uuid, p_expected integer) RETURNS trustwork.provider_budget
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.provider_budget%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.provider_budget%ROWTYPE;
BEGIN
  SELECT * INTO v_before FROM trustwork.provider_budget WHERE id = p_budget FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such cap' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.providers.budget.edit'], NULL, v_before.hub_id);
  PERFORM trustwork.providers_expect(v_before.revision, p_expected);
  UPDATE trustwork.provider_budget SET status = 'retired', retired_by = v_actor.person_id, retired_at = now() WHERE id = p_budget RETURNING * INTO v_row;
  PERFORM trustwork.providers_log(v_actor, p_ctx, v_row.hub_id, 'provider_budget', v_row.id, 'providers.cap_retired', to_jsonb(v_before), to_jsonb(v_row));
  RETURN v_row;
END $$;

-- A new cost record version. It writes nothing but model_pricing and the log: no billing price changes with it.
CREATE FUNCTION trustwork.providers_record_pricing(p_ctx jsonb, p_connection uuid, p_model text, p_currency text, p_input numeric, p_output numeric, p_image numeric,
  p_audio numeric, p_basis text, p_observed timestamptz, p_note text) RETURNS trustwork.model_pricing
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_conn trustwork.provider_connection%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.model_pricing%ROWTYPE;
  v_version integer;
BEGIN
  SELECT * INTO v_conn FROM trustwork.provider_connection WHERE id = p_connection;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such connection' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.providers.connection.edit', 'admin.providers.budget.edit'], NULL, v_conn.hub_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('trustwork.providers.pricing:' || p_connection::text || ':' || coalesce(p_model, ''), 0));
  SELECT coalesce(max(version), 0) + 1 INTO v_version FROM trustwork.model_pricing WHERE connection_id = p_connection AND model_id = p_model;
  INSERT INTO trustwork.model_pricing (hub_id, connection_id, model_id, version, currency, input_per_million_tokens, output_per_million_tokens, per_image, per_audio_minute,
    basis, observed_at, source_note, recorded_by)
  VALUES (v_conn.hub_id, p_connection, p_model, v_version, p_currency, p_input, p_output, p_image, p_audio, p_basis, p_observed, p_note, v_actor.person_id) RETURNING * INTO v_row;
  PERFORM trustwork.providers_log(v_actor, p_ctx, v_conn.hub_id, 'model_pricing', v_row.id, 'providers.pricing_recorded', NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- Engage: immediate, one person (admin.providers.kill). A connection switch is DATA-002's kill_switch row (its command
-- writes the audit row); a route switch is this module's.
CREATE FUNCTION trustwork.providers_engage_kill(p_ctx jsonb, p_hub uuid, p_target_kind text, p_connection uuid, p_job text, p_scope_kind text, p_module text, p_extension uuid)
RETURNS TABLE (kind text, id uuid)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.providers.kill'], NULL, p_hub);
  v_switch trustwork.kill_switch%ROWTYPE;
  v_route trustwork.provider_route_kill_switch%ROWTYPE;
BEGIN
  IF p_target_kind = 'connection' THEN
    IF NOT EXISTS (SELECT 1 FROM trustwork.provider_connection c WHERE c.id = p_connection AND c.hub_id = p_hub) THEN
      RAISE EXCEPTION 'no such connection' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
    END IF;
    IF EXISTS (SELECT 1 FROM trustwork.kill_switch k WHERE k.state = 'engaged' AND k.scope_kind = 'provider_connection' AND k.connection_id = p_connection) THEN
      RAISE EXCEPTION 'already engaged' USING ERRCODE = 'check_violation', HINT = 'providers.kill_engaged';
    END IF;
    v_switch := trustwork.admin_engage_kill_switch(p_ctx, 'provider_connection', NULL, p_hub, jsonb_build_object('connectionId', p_connection::text));
    PERFORM trustwork.providers_log(v_actor, p_ctx, p_hub, 'kill_switch', v_switch.id, 'providers.kill_engaged', NULL, to_jsonb(v_switch), NULL, false);
    PERFORM trustwork.providers_notify('provider_connection', p_connection, 1, 'providers.kill_engaged', jsonb_build_object('hubId', p_hub, 'killSwitchId', v_switch.id, 'connectionId', p_connection));
    RETURN QUERY SELECT 'connection'::text, v_switch.id;
  ELSIF p_target_kind = 'route' THEN
    IF EXISTS (SELECT 1 FROM trustwork.provider_route_kill_switch k WHERE k.state = 'engaged' AND k.hub_id = p_hub AND k.job = p_job AND k.scope_kind = p_scope_kind
               AND k.module_key IS NOT DISTINCT FROM p_module AND k.extension_id IS NOT DISTINCT FROM p_extension) THEN
      RAISE EXCEPTION 'already engaged' USING ERRCODE = 'check_violation', HINT = 'providers.kill_engaged';
    END IF;
    INSERT INTO trustwork.provider_route_kill_switch (hub_id, job, scope_kind, module_key, extension_id, engaged_by, reason)
    VALUES (p_hub, p_job, p_scope_kind, p_module, p_extension, v_actor.person_id, p_ctx ->> 'reasonText') RETURNING * INTO v_route;
    PERFORM trustwork.providers_log(v_actor, p_ctx, p_hub, 'kill_switch', v_route.id, 'providers.kill_engaged', NULL, to_jsonb(v_route));
    PERFORM trustwork.providers_notify('model_route', v_route.id, 1, 'providers.kill_engaged', jsonb_build_object('hubId', p_hub, 'killSwitchId', v_route.id, 'job', p_job));
    RETURN QUERY SELECT 'route'::text, v_route.id;
  ELSE
    RAISE EXCEPTION 'a providers kill switch stops a connection or a route' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.context_invalid';
  END IF;
END $$;

-- Release: a second person approved kill_switch.release of exactly this switch and incident note.
CREATE FUNCTION trustwork.providers_release_kill(p_ctx jsonb, p_hub uuid, p_switch uuid, p_approval uuid, p_note text) RETURNS TABLE (kind text, id uuid)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.admin_authorize(p_ctx, ARRAY['admin.providers.kill'], NULL, p_hub);
  v_switch trustwork.kill_switch%ROWTYPE;
  v_switch_after trustwork.kill_switch%ROWTYPE;
  v_route trustwork.provider_route_kill_switch%ROWTYPE;
  v_route_after trustwork.provider_route_kill_switch%ROWTYPE;
  v_approval trustwork.second_person_approval%ROWTYPE;
BEGIN
  SELECT * INTO v_switch FROM trustwork.kill_switch k WHERE k.id = p_switch AND k.scope_kind = 'provider_connection' AND k.hub_id = p_hub;
  IF FOUND THEN
    IF v_switch.state <> 'engaged' THEN
      RAISE EXCEPTION 'already released' USING ERRCODE = 'check_violation', HINT = 'providers.kill_not_engaged';
    END IF;
    v_switch_after := trustwork.admin_release_kill_switch(p_ctx, p_switch, p_approval, p_note);
    PERFORM trustwork.providers_log(v_actor, p_ctx, p_hub, 'kill_switch', p_switch, 'providers.kill_released', to_jsonb(v_switch), to_jsonb(v_switch_after), v_switch_after.release_approval_id, false);
    PERFORM trustwork.providers_notify('provider_connection', v_switch.connection_id, 1, 'providers.kill_released', jsonb_build_object('hubId', p_hub, 'killSwitchId', p_switch));
    RETURN QUERY SELECT 'connection'::text, p_switch;
    RETURN;
  END IF;
  SELECT * INTO v_route FROM trustwork.provider_route_kill_switch k WHERE k.id = p_switch AND k.hub_id = p_hub FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such kill switch' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF v_route.state <> 'engaged' THEN
    RAISE EXCEPTION 'already released' USING ERRCODE = 'check_violation', HINT = 'providers.kill_not_engaged';
  END IF;
  IF p_approval IS NULL THEN
    RAISE EXCEPTION 'releasing needs a second person''s approval' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.approval_required';
  END IF;
  v_approval := trustwork.admin_consume_approval(p_approval, 'kill_switch.release', 'hub', NULL, p_hub, trustwork.admin_kill_switch_release_digest(p_switch, p_note), p_switch);
  UPDATE trustwork.provider_route_kill_switch SET state = 'released', released_by = v_actor.person_id, release_approval_id = v_approval.id, incident_note = p_note
   WHERE provider_route_kill_switch.id = p_switch RETURNING * INTO v_route_after;
  PERFORM trustwork.providers_log(v_actor, p_ctx, p_hub, 'kill_switch', p_switch, 'kill_switch.release', to_jsonb(v_route), to_jsonb(v_route_after), v_approval.id);
  PERFORM trustwork.providers_notify('model_route', p_switch, 1, 'providers.kill_released', jsonb_build_object('hubId', p_hub, 'killSwitchId', p_switch));
  RETURN QUERY SELECT 'route'::text, p_switch;
END $$;

-- 13. The call gate (runtime: API and worker; no principal, no personal data) -----------------------------------------
-- p_request: ProviderCallRequestSchema. Returns ProviderCallDecisionSchema. A dry run reserves nothing (decisionId
-- "dry-run"). Paid authorizations of one hub serialize on a lock, so caps hold under concurrency.
CREATE FUNCTION trustwork.providers_authorize_call(p_request jsonb, p_dry_run boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_hub uuid := (p_request ->> 'hubId')::uuid;
  v_job text := p_request ->> 'job';
  v_module text := p_request ->> 'moduleKey';
  v_extension uuid := (p_request ->> 'extensionId')::uuid;
  v_pipeline uuid := (p_request ->> 'pipelineId')::uuid;
  v_classes text[] := ARRAY(SELECT jsonb_array_elements_text(p_request -> 'dataClasses'));
  v_estimate bigint := (p_request #>> '{estimatedCost,minorUnits}')::bigint;
  v_currency text := p_request #>> '{estimatedCost,currency}';
  v_profile trustwork.hub_profile%ROWTYPE;
  v_route trustwork.model_route%ROWTYPE;
  v_ref record;
  v_conn trustwork.provider_connection%ROWTYPE;
  v_reason text;
  v_class text;
  v_ok boolean;
  v_candidates jsonb := '[]'::jsonb;
  v_candidate_ids uuid[] := ARRAY[]::uuid[];
  v_first_mode text;
  v_paid boolean;
  v_reserve bigint;
  v_budget trustwork.provider_budget%ROWTYPE;
  v_used record;
  v_budget_ids uuid[] := ARRAY[]::uuid[];
  v_dropped boolean;
  v_id uuid := trustwork.new_uuid();
  v_missing text;
BEGIN
  IF v_job IS NULL OR NOT (v_job = ANY (trustwork.providers_model_jobs())) OR cardinality(v_classes) = 0 OR v_estimate IS NULL OR v_estimate < 0
     OR coalesce(p_request ->> 'requestRef', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR NOT (v_classes <@ trustwork.providers_data_classes()) THEN
    RAISE EXCEPTION 'a call request names a job, data classes, an estimate and a reference' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.context_invalid';
  END IF;
  SELECT * INTO v_profile FROM trustwork.hub_profile WHERE hub_id = v_hub;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'no_active_route', 'detail', NULL);
  END IF;
  IF v_currency IS DISTINCT FROM v_profile.currency THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'currency_mismatch', 'detail', v_profile.currency);
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.kill_switch k WHERE k.state = 'engaged' AND k.scope_kind = 'node') THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'node_killed', 'detail', NULL);
  END IF;
  -- The most specific active route: extension, then module, then job.
  SELECT * INTO v_route FROM trustwork.model_route r
   WHERE r.hub_id = v_hub AND r.job = v_job AND r.status = 'active'
     AND ((r.scope_kind = 'extension' AND r.extension_id = v_extension) OR (r.scope_kind = 'module' AND r.module_key = v_module) OR r.scope_kind = 'job')
   ORDER BY CASE r.scope_kind WHEN 'extension' THEN 0 WHEN 'module' THEN 1 ELSE 2 END LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'no_active_route', 'detail', NULL);
  END IF;
  SELECT c INTO v_missing FROM unnest(v_classes) c WHERE NOT (c = ANY (v_route.allowed_data_classes)) ORDER BY c LIMIT 1;
  IF v_missing IS NOT NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'data_class_not_in_route', 'detail', v_missing);
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.provider_route_kill_switch k WHERE k.state = 'engaged' AND k.hub_id = v_hub AND k.job = v_route.job AND k.scope_kind = v_route.scope_kind
             AND k.module_key IS NOT DISTINCT FROM v_route.module_key AND k.extension_id IS NOT DISTINCT FROM v_route.extension_id) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'route_killed', 'detail', v_route.id);
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.kill_switch k WHERE k.state = 'engaged' AND k.hub_id = v_hub AND k.scope_kind = 'model_job' AND k.job = v_job) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'job_killed', 'detail', v_job);
  END IF;
  IF v_module IS NOT NULL AND EXISTS (SELECT 1 FROM trustwork.kill_switch k WHERE k.state = 'engaged' AND k.hub_id = v_hub
       AND ((k.scope_kind = 'agent_module' AND k.module_key = v_module) OR k.scope_kind = 'hub_agent_dispatch')) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'module_killed', 'detail', v_module);
  END IF;
  IF v_extension IS NOT NULL AND EXISTS (SELECT 1 FROM trustwork.kill_switch k WHERE k.state = 'engaged' AND k.hub_id = v_hub AND k.scope_kind = 'agent_extension' AND k.extension_id = v_extension) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'extension_killed', 'detail', v_extension);
  END IF;
  IF v_pipeline IS NOT NULL AND EXISTS (SELECT 1 FROM trustwork.kill_switch k WHERE k.state = 'engaged' AND k.scope_kind = 'pipeline' AND k.pipeline_id = v_pipeline) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'pipeline_killed', 'detail', v_pipeline);
  END IF;
  -- Candidates: the primary unless it is unavailable; a primary refused by egress refuses the call (a fallback never
  -- escapes an egress denial); fallbacks only where every data class is allowed.
  FOR v_ref IN SELECT * FROM trustwork.providers_route_refs(v_route.primary_ref, v_route.fallbacks) LOOP
    v_ok := true;
    FOREACH v_class IN ARRAY v_classes LOOP
      v_reason := trustwork.providers_egress_reason((v_ref.ref ->> 'connectionId')::uuid, v_class);
      IF v_reason <> 'allowed' THEN
        IF v_ref.ord = 0 AND v_reason NOT IN ('killed', 'connection_not_enabled') THEN
          RETURN jsonb_build_object('allowed', false, 'reason', 'egress_denied', 'detail', v_reason);
        END IF;
        v_ok := false;
        EXIT;
      END IF;
    END LOOP;
    IF v_ok THEN
      SELECT * INTO v_conn FROM trustwork.provider_connection WHERE id = (v_ref.ref ->> 'connectionId')::uuid;
      v_candidates := v_candidates || jsonb_build_array(jsonb_build_object('connectionId', v_conn.id, 'modelId', v_ref.ref ->> 'modelId', 'modelRevision', v_ref.ref ->> 'modelRevision', 'mode', v_conn.mode));
      v_candidate_ids := v_candidate_ids || v_conn.id;
    END IF;
  END LOOP;
  IF jsonb_array_length(v_candidates) = 0 THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'no_available_connection', 'detail', NULL);
  END IF;
  -- Caps: a paid call (the first candidate is not a fake) reserves its upper-bound estimate against every applicable
  -- active cap; a candidate whose connection cap is exhausted is skipped like an unavailable one.
  v_first_mode := v_candidates -> 0 ->> 'mode';
  v_paid := v_first_mode <> 'fake';
  v_reserve := CASE WHEN v_paid THEN v_estimate ELSE 0 END;
  IF v_paid THEN
    IF NOT p_dry_run THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('trustwork.providers.spend:' || v_hub::text, 0));
    END IF;
    -- Connection caps first (they may drop candidates).
    LOOP
      v_dropped := false;
      FOR v_budget IN SELECT * FROM trustwork.provider_budget b WHERE b.hub_id = v_hub AND b.status = 'active' AND b.scope_kind = 'connection'
                       AND b.connection_id = (v_candidates -> 0 ->> 'connectionId')::uuid LOOP
        SELECT * INTO v_used FROM trustwork.providers_budget_used(v_budget.id);
        IF NOT (v_used.spent + v_used.reserved < v_budget.limit_minor AND v_used.spent + v_used.reserved + v_reserve <= v_budget.limit_minor) THEN
          v_candidates := v_candidates - 0;
          v_candidate_ids := v_candidate_ids[2:];
          v_dropped := true;
          EXIT;
        END IF;
      END LOOP;
      EXIT WHEN NOT v_dropped OR jsonb_array_length(v_candidates) = 0;
    END LOOP;
    IF jsonb_array_length(v_candidates) = 0 THEN
      RETURN jsonb_build_object('allowed', false, 'reason', 'cap_exhausted', 'detail', v_budget.id);
    END IF;
    IF (v_candidates -> 0 ->> 'mode') = 'fake' THEN
      v_paid := false;
      v_reserve := 0;
    END IF;
  END IF;
  IF v_paid THEN
    FOR v_budget IN SELECT * FROM trustwork.provider_budget b WHERE b.hub_id = v_hub AND b.status = 'active' AND (
        b.scope_kind = 'hub' OR (b.scope_kind = 'job' AND b.job = v_job) OR (b.scope_kind = 'agent_module' AND b.module_key = v_module)
        OR (b.scope_kind = 'pipeline' AND b.pipeline_id = v_pipeline) OR b.id = v_route.budget_id
        OR (b.scope_kind = 'connection' AND b.connection_id = (v_candidates -> 0 ->> 'connectionId')::uuid)) ORDER BY b.id LOOP
      SELECT * INTO v_used FROM trustwork.providers_budget_used(v_budget.id);
      IF NOT (v_used.spent + v_used.reserved < v_budget.limit_minor AND v_used.spent + v_used.reserved + v_reserve <= v_budget.limit_minor) THEN
        RETURN jsonb_build_object('allowed', false, 'reason', 'cap_exhausted', 'detail', v_budget.id);
      END IF;
      v_budget_ids := v_budget_ids || v_budget.id;
    END LOOP;
  END IF;
  IF NOT p_dry_run THEN
    INSERT INTO trustwork.provider_usage (id, hub_id, request_ref, route_id, candidates, job, module_key, extension_id, pipeline_id, data_classes, budget_ids, paid, currency, reserved_minor)
    VALUES (v_id, v_hub, p_request ->> 'requestRef', v_route.id, v_candidate_ids, v_job, v_module, v_extension, v_pipeline, v_classes, v_budget_ids, v_paid, v_currency, v_reserve);
    PERFORM trustwork.providers_budget_alerts(v_budget_ids);
  END IF;
  RETURN jsonb_build_object('allowed', true, 'decisionId', CASE WHEN p_dry_run THEN 'dry-run' ELSE v_id::text END, 'routeId', v_route.id, 'routeVersion', v_route.version,
    'candidates', v_candidates,
    'limits', jsonb_build_object('maxInputTokens', v_route.max_input_tokens, 'maxOutputTokens', v_route.max_output_tokens, 'maxFileBytes', v_route.max_file_bytes, 'timeoutMs', v_route.timeout_ms),
    'reserved', jsonb_build_object('minorUnits', v_reserve::text, 'currency', v_currency));
END $$;

-- Settles an authorized call with what it cost (an unknown outcome keeps the full reservation as its cost). The caps
-- follow the connection that actually served it.
CREATE FUNCTION trustwork.providers_settle_call(p_decision uuid, p_connection uuid, p_model text, p_outcome text, p_cost bigint, p_input integer, p_output integer,
  p_images integer, p_audio integer) RETURNS trustwork.provider_usage
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.provider_usage%ROWTYPE;
  v_mode text;
  v_budgets uuid[];
BEGIN
  SELECT * INTO v_row FROM trustwork.provider_usage WHERE id = p_decision FOR UPDATE;
  IF NOT FOUND OR v_row.state <> 'reserved' THEN
    RAISE EXCEPTION 'no open decision' USING ERRCODE = 'check_violation', HINT = 'providers.decision_unknown';
  END IF;
  IF NOT (p_connection = ANY (v_row.candidates)) OR p_outcome NOT IN ('succeeded', 'failed', 'unknown') OR coalesce(p_cost, 0) < 0 THEN
    RAISE EXCEPTION 'the call settles on one of its candidates with an outcome' USING ERRCODE = 'invalid_parameter_value', HINT = 'admin.context_invalid';
  END IF;
  SELECT mode INTO v_mode FROM trustwork.provider_connection WHERE id = p_connection;
  v_budgets := ARRAY(SELECT b FROM unnest(v_row.budget_ids) b WHERE NOT EXISTS (SELECT 1 FROM trustwork.provider_budget x WHERE x.id = b AND x.scope_kind = 'connection'))
    || ARRAY(SELECT x.id FROM trustwork.provider_budget x WHERE x.hub_id = v_row.hub_id AND x.status = 'active' AND x.scope_kind = 'connection' AND x.connection_id = p_connection
             AND v_mode <> 'fake' AND cardinality(v_row.budget_ids) > 0);
  UPDATE trustwork.provider_usage SET state = 'settled', connection_id = p_connection, model_id = p_model, outcome = p_outcome,
    cost_minor = CASE WHEN v_mode = 'fake' THEN 0 WHEN p_outcome = 'unknown' THEN greatest(v_row.reserved_minor, coalesce(p_cost, 0)) ELSE coalesce(p_cost, 0) END,
    input_tokens = p_input, output_tokens = p_output, images = p_images, audio_seconds = p_audio, budget_ids = v_budgets, settled_at = now()
   WHERE id = p_decision RETURNING * INTO v_row;
  PERFORM trustwork.providers_budget_alerts(v_row.budget_ids);
  RETURN v_row;
END $$;

-- The call was never sent: the reservation is released.
CREATE FUNCTION trustwork.providers_release_call(p_decision uuid) RETURNS trustwork.provider_usage
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_row trustwork.provider_usage%ROWTYPE;
BEGIN
  UPDATE trustwork.provider_usage SET state = 'released' WHERE id = p_decision AND state = 'reserved' RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no open decision' USING ERRCODE = 'check_violation', HINT = 'providers.decision_unknown';
  END IF;
  RETURN v_row;
END $$;

-- The sealed secret for a call: only for an open decision of the last 15 minutes, one of its candidates, still enabled
-- and not killed. The ciphertext is useless without the node's key-encryption key, which the database never holds.
CREATE FUNCTION trustwork.providers_call_secret(p_decision uuid, p_connection uuid)
RETURNS TABLE (secret_ref_id uuid, ciphertext bytea, iv bytea, auth_tag bytea, wrapped_key bytea, kek_id text, credential_store text, credential_ref text)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_usage trustwork.provider_usage%ROWTYPE;
  v_conn trustwork.provider_connection%ROWTYPE;
  v_ref uuid;
BEGIN
  SELECT * INTO v_usage FROM trustwork.provider_usage WHERE id = p_decision;
  IF NOT FOUND OR v_usage.state <> 'reserved' OR v_usage.created_at < now() - interval '15 minutes' OR NOT (p_connection = ANY (v_usage.candidates)) THEN
    RAISE EXCEPTION 'no open decision for this connection' USING ERRCODE = 'insufficient_privilege', HINT = 'providers.decision_unknown';
  END IF;
  SELECT * INTO v_conn FROM trustwork.provider_connection WHERE id = p_connection;
  IF v_conn.status <> 'enabled' OR trustwork.providers_connection_killed(p_connection) THEN
    RAISE EXCEPTION 'the connection stopped' USING ERRCODE = 'check_violation', HINT = 'providers.connection_not_enabled';
  END IF;
  SELECT r.id INTO v_ref FROM trustwork.secret_ref r WHERE r.connection_id = p_connection AND r.status IN ('active', 'grace')
   ORDER BY (r.status = 'active') DESC, r.version DESC LIMIT 1;
  IF v_ref IS NOT NULL THEN
    UPDATE trustwork.secret_ref SET last_used_at = now() WHERE id = v_ref;
  END IF;
  RETURN QUERY
    SELECT v_ref, v.ciphertext, v.iv, v.auth_tag, v.wrapped_key, v.kek_id, cr.secret_store, cr.secret_ref
    FROM (SELECT 1) one
    LEFT JOIN trustwork.secret_version v ON v.secret_ref_id = v_ref
    LEFT JOIN trustwork.provider_credential_ref cr ON cr.id = v_conn.credential_ref_id AND cr.status = 'active';
END $$;

-- 14. Worker: rotated secrets whose grace ended are destroyed (ciphertext deleted) ------------------------------------
CREATE FUNCTION trustwork.providers_destroy_expired_secrets(p_limit integer DEFAULT 200) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_ref trustwork.secret_ref%ROWTYPE;
  v_after trustwork.secret_ref%ROWTYPE;
  v_count integer := 0;
BEGIN
  FOR v_ref IN SELECT * FROM trustwork.secret_ref WHERE status = 'grace' AND grace_until <= now() ORDER BY grace_until LIMIT greatest(1, least(coalesce(p_limit, 200), 1000))
               FOR UPDATE SKIP LOCKED LOOP
    UPDATE trustwork.secret_ref SET status = 'destroyed' WHERE id = v_ref.id RETURNING * INTO v_after;
    DELETE FROM trustwork.secret_version WHERE secret_ref_id = v_ref.id;
    INSERT INTO trustwork.provider_config_change (hub_id, object_type, object_id, action, actor_person_id, reason, before, after)
    VALUES (v_ref.hub_id, 'secret_ref', v_ref.id, 'providers.secret_grace_ended', NULL, 'Grace period of a rotated secret ended', to_jsonb(v_ref), to_jsonb(v_after));
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

-- 15. Readers ---------------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.providers_staff_reader(p_hub uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND p_hub IS NOT NULL
    AND (SELECT r.role FROM trustwork.admin_resolve_any(trustwork.current_person_id(), trustwork.providers_reader_permissions(), NULL, p_hub) r) IS NOT NULL
$$;
-- Spend of every cap of a hub in its current period (staff readers only).
CREATE FUNCTION trustwork.providers_cap_usage(p_hub uuid) RETURNS TABLE (budget_id uuid, period_start timestamptz, spent bigint, reserved bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF NOT trustwork.providers_staff_reader(p_hub) THEN
    RAISE EXCEPTION 'no such hub' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  RETURN QUERY SELECT b.id, u.period_start, u.spent, u.reserved FROM trustwork.provider_budget b CROSS JOIN LATERAL trustwork.providers_budget_used(b.id) u WHERE b.hub_id = p_hub;
END $$;
-- The hub's residency and the restricted state of each connection, for the read models (staff readers only).
CREATE FUNCTION trustwork.providers_connection_facts(p_hub uuid) RETURNS TABLE (connection_id uuid, in_residency boolean, kill_switch_id uuid, config_digest text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF NOT trustwork.providers_staff_reader(p_hub) THEN
    RAISE EXCEPTION 'no such hub' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  RETURN QUERY SELECT c.id, trustwork.providers_in_residency(c.hub_id, c.processing_country, c.storage_country),
    (SELECT k.id FROM trustwork.kill_switch k WHERE k.state = 'engaged' AND k.scope_kind = 'provider_connection' AND k.connection_id = c.id),
    trustwork.providers_config_digest(c.id)
  FROM trustwork.provider_connection c WHERE c.hub_id = p_hub;
END $$;

-- 16. Row-level security and grants -----------------------------------------------------------------------------------
ALTER TABLE trustwork.provider_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.provider_connection FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.secret_ref ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.secret_ref FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.secret_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.secret_version FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.connection_test ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.connection_test FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.provider_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.provider_budget FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.model_route ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.model_route FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.egress_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.egress_rule FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.model_pricing ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.model_pricing FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.provider_route_kill_switch ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.provider_route_kill_switch FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.provider_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.provider_usage FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.provider_budget_alert ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.provider_budget_alert FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.provider_config_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.provider_config_change FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.provider_connection AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.secret_ref AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.secret_version AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.connection_test AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.provider_budget AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.model_route AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.egress_rule AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.model_pricing AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.provider_route_kill_switch AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.provider_usage AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.provider_budget_alert AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.provider_config_change AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

-- Staff of the hub read its provider configuration, spend ledger and change log. secret_version has no runtime policy
-- and no grant: ciphertext is reachable only through providers_test_material and providers_call_secret.
CREATE POLICY provider_connection_read ON trustwork.provider_connection FOR SELECT TO trustwork_app USING (trustwork.providers_staff_reader(hub_id));
CREATE POLICY secret_ref_read ON trustwork.secret_ref FOR SELECT TO trustwork_app USING (trustwork.providers_staff_reader(hub_id));
CREATE POLICY connection_test_read ON trustwork.connection_test FOR SELECT TO trustwork_app USING (trustwork.providers_staff_reader(hub_id));
CREATE POLICY provider_budget_read ON trustwork.provider_budget FOR SELECT TO trustwork_app USING (trustwork.providers_staff_reader(hub_id));
CREATE POLICY model_route_read ON trustwork.model_route FOR SELECT TO trustwork_app USING (trustwork.providers_staff_reader(hub_id));
CREATE POLICY egress_rule_read ON trustwork.egress_rule FOR SELECT TO trustwork_app USING (trustwork.providers_staff_reader(hub_id));
CREATE POLICY model_pricing_read ON trustwork.model_pricing FOR SELECT TO trustwork_app USING (trustwork.providers_staff_reader(hub_id));
CREATE POLICY provider_route_kill_switch_read ON trustwork.provider_route_kill_switch FOR SELECT TO trustwork_app USING (trustwork.providers_staff_reader(hub_id));
CREATE POLICY provider_usage_read ON trustwork.provider_usage FOR SELECT TO trustwork_app USING (trustwork.providers_staff_reader(hub_id));
CREATE POLICY provider_config_change_read ON trustwork.provider_config_change FOR SELECT TO trustwork_app USING (trustwork.providers_staff_reader(hub_id));

GRANT SELECT ON trustwork.provider_connection, trustwork.secret_ref, trustwork.connection_test, trustwork.provider_budget, trustwork.model_route, trustwork.egress_rule,
  trustwork.model_pricing, trustwork.provider_route_kill_switch, trustwork.provider_usage, trustwork.provider_config_change TO trustwork_app;
GRANT EXECUTE ON FUNCTION
  trustwork.providers_create_connection(jsonb, uuid, text, text, text, text[], text, text, text, boolean, boolean, boolean, text, text, uuid),
  trustwork.providers_update_connection(jsonb, uuid, integer, text, text[], text, text, text, boolean, boolean, boolean, text, text, uuid),
  trustwork.providers_store_secret(jsonb, uuid, integer, text, bytea, bytea, bytea, bytea, text, integer),
  trustwork.providers_revoke_secret(jsonb, uuid, integer),
  trustwork.providers_test_material(jsonb, uuid),
  trustwork.providers_record_test(jsonb, uuid, text, text, integer, integer, bigint, text, text, uuid),
  trustwork.providers_enable_connection(jsonb, uuid, integer, uuid),
  trustwork.providers_disable_connection(jsonb, uuid, integer),
  trustwork.providers_set_egress_rule(jsonb, uuid, text, text, boolean, boolean, uuid),
  trustwork.providers_draft_route(jsonb, uuid, text, text, text, uuid, jsonb, jsonb, text[], integer, integer, bigint, integer, uuid),
  trustwork.providers_activate_route(jsonb, uuid, integer, uuid),
  trustwork.providers_disable_route(jsonb, uuid, integer),
  trustwork.providers_create_budget(jsonb, uuid, text, text, uuid, text, uuid, text, bigint, text, integer[], text),
  trustwork.providers_update_budget(jsonb, uuid, integer, bigint, text, integer[], text),
  trustwork.providers_retire_budget(jsonb, uuid, integer),
  trustwork.providers_record_pricing(jsonb, uuid, text, text, numeric, numeric, numeric, numeric, text, timestamptz, text),
  trustwork.providers_engage_kill(jsonb, uuid, text, uuid, text, text, text, uuid),
  trustwork.providers_release_kill(jsonb, uuid, uuid, uuid, text),
  trustwork.providers_authorize_call(jsonb, boolean),
  trustwork.providers_settle_call(uuid, uuid, text, text, bigint, integer, integer, integer, integer),
  trustwork.providers_release_call(uuid),
  trustwork.providers_call_secret(uuid, uuid),
  trustwork.providers_staff_reader(uuid),
  trustwork.providers_cap_usage(uuid),
  trustwork.providers_connection_facts(uuid),
  -- Invoker helpers: vocabularies (pure functions of their inputs).
  trustwork.providers_capabilities(), trustwork.providers_model_jobs(), trustwork.providers_data_classes(), trustwork.providers_moving_alias(text)
TO trustwork_app;
GRANT EXECUTE ON FUNCTION
  trustwork.providers_authorize_call(jsonb, boolean),
  trustwork.providers_settle_call(uuid, uuid, text, text, bigint, integer, integer, integer, integer),
  trustwork.providers_release_call(uuid),
  trustwork.providers_call_secret(uuid, uuid),
  trustwork.providers_destroy_expired_secrets(integer)
TO trustwork_worker;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
