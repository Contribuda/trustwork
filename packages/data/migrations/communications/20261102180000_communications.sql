-- COMMS-001: context threads, messages, notifications, channel grants, templates and deliveries (requirement R08,
-- docs/data/model.md section 13, docs/engine/communications.md).
--
-- 1. A thread always belongs to a context that exists (a guard trigger checks it for every role, maintenance
--    included). Who may read a thread is derived live from the context (`comms_party_side`), never copied: whoever is a
--    party of the context reads its threads and nobody else; RFQ and task-request threads are between the owner side
--    and one counterparty, so competitors never see each other's threads. A public project does not open its threads.
-- 2. Messages are append-only. Inbound messages are untrusted (CHECK) and unique per (provider, provider_message_id),
--    so a duplicate provider event never creates a second message.
-- 3. Notifications carry only the parameters their template declares (`comms_params_allowed`, CHECK) and are created
--    by definers that compute the values themselves and check that the recipient is a party of the linked context;
--    the read policy checks the recipient's right to the context again on every read.
-- 4. Template versions are activated only when every hub language exists, and never by their drafter (CHECK).
-- 5. E-mail deliveries reuse MAIL-001: `comms_enqueue_mail` writes the `mail_delivery` row and its `mail.requested`
--    outbox event inside the caller's transaction (the address is read inside the definer and never reaches the API);
--    suppressed addresses never receive non-transactional mail (an unsubscribe never blocks a transactional notice).

-- 0. MAIL-001's template list gains the pre-rendered notification mail ---------------------------------------------------
ALTER TABLE trustwork.mail_delivery DROP CONSTRAINT mail_delivery_template_check;
ALTER TABLE trustwork.mail_delivery ADD CONSTRAINT mail_delivery_template_check
  CHECK (template IN ('verify_email', 'already_registered', 'recovery', 'email_change', 'membership_invitation', 'security_notice', 'notification'));

-- 1. Vocabulary ---------------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.comms_context_kinds() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY['project', 'rfq', 'quote', 'agreement', 'order', 'task_request', 'task_assignment']::text[] $$;

-- Template registry mirrored from packages/contracts/src/communications.ts (NOTIFICATION_TEMPLATES; a test compares).
CREATE FUNCTION trustwork.comms_template_params(p_key text) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_key
    WHEN 'thread.opened' THEN ARRAY['contextKind', 'threadSubject', 'authorName']
    WHEN 'thread.message' THEN ARRAY['contextKind', 'threadSubject', 'authorName']
    WHEN 'account.security_notice' THEN ARRAY['event']
  END::text[]
$$;
CREATE FUNCTION trustwork.comms_template_category(p_key text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_key WHEN 'thread.opened' THEN 'messages' WHEN 'thread.message' THEN 'messages' WHEN 'account.security_notice' THEN 'account' END
$$;
CREATE FUNCTION trustwork.comms_template_transactional(p_key text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT trustwork.comms_template_category(p_key) IN ('account', 'legal') $$;
-- Defaults mirrored from DEFAULT_PREFERENCES.
CREATE FUNCTION trustwork.comms_default_frequency(p_category text, p_channel text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_channel = 'sms' THEN 'off'
    WHEN p_category IN ('messages', 'commerce', 'tasks') THEN 'immediate'
    WHEN p_category = 'projects' THEN CASE WHEN p_channel = 'email' THEN 'daily' ELSE 'off' END
    WHEN p_category IN ('account', 'legal') THEN CASE WHEN p_channel = 'email' THEN 'immediate' ELSE 'off' END
    ELSE 'off'
  END
$$;
-- A notification's parameters: an object with exactly declared keys and short string values.
CREATE FUNCTION trustwork.comms_params_allowed(p_key text, p_params jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(p_params) = 'object'
    AND trustwork.comms_template_params(p_key) IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(p_params) e
      WHERE NOT (e.key = ANY (trustwork.comms_template_params(p_key))) OR jsonb_typeof(e.value) <> 'string' OR length(e.value #>> '{}') > 200
    )
$$;

-- Channel grant scopes: {contextKinds: [...], actions: [...]} with known values only.
CREATE FUNCTION trustwork.comms_scopes_valid(p_scopes jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(p_scopes) = 'object' AND jsonb_typeof(p_scopes -> 'contextKinds') = 'array' AND jsonb_typeof(p_scopes -> 'actions') = 'array'
    AND jsonb_array_length(p_scopes -> 'contextKinds') BETWEEN 1 AND 7 AND jsonb_array_length(p_scopes -> 'actions') BETWEEN 1 AND 2
    AND (SELECT bool_and(k = ANY (trustwork.comms_context_kinds())) FROM jsonb_array_elements_text(p_scopes -> 'contextKinds') k)
    AND (SELECT bool_and(a IN ('notify', 'reply')) FROM jsonb_array_elements_text(p_scopes -> 'actions') a)
    AND (SELECT count(*) FROM jsonb_object_keys(p_scopes)) = 2
$$;

-- 2. Tables -------------------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.context_thread (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  context_kind text NOT NULL CHECK (context_kind = ANY (trustwork.comms_context_kinds())),
  context_id uuid NOT NULL,
  -- The counterparty of an RFQ or task-request thread (one owner side, many counterparties).
  counterparty_person_id uuid NULL REFERENCES trustwork.person (id),
  counterparty_company_id uuid NULL REFERENCES trustwork.company (id),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  last_message_at timestamptz NULL,
  message_count integer NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT context_thread_counterparty_shape CHECK (
    CASE WHEN context_kind IN ('rfq', 'task_request') THEN num_nonnulls(counterparty_person_id, counterparty_company_id) = 1
         ELSE counterparty_person_id IS NULL AND counterparty_company_id IS NULL END),
  -- One conversation per context (and counterparty): opening it again returns the existing thread.
  CONSTRAINT context_thread_one_per_context UNIQUE NULLS NOT DISTINCT (context_kind, context_id, counterparty_person_id, counterparty_company_id)
);
CREATE TRIGGER context_thread_touch BEFORE UPDATE ON trustwork.context_thread FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- A person's permission to connect an external channel, per scope, revocable; never a whole mailbox.
CREATE TABLE trustwork.channel_grant (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  provider text NOT NULL CHECK (provider IN ('email', 'telegram', 'whatsapp', 'sms', 'other')),
  -- Handle the adapter addresses (chat id, phone number); personal data, readable by the person only.
  account_ref text NOT NULL CHECK (length(account_ref) BETWEEN 3 AND 200),
  account_display text NOT NULL CHECK (length(account_display) BETWEEN 1 AND 200),
  scopes jsonb NOT NULL CHECK (trustwork.comms_scopes_valid(scopes)),
  -- Reference to the provider credential (CHAN-001); fake adapters need none.
  credential_ref text NULL CHECK (credential_ref IS NULL OR length(credential_ref) <= 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz NULL,
  CONSTRAINT channel_grant_revocation_shape CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX channel_grant_person_idx ON trustwork.channel_grant (person_id) WHERE status = 'active';

CREATE TABLE trustwork.message (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  thread_id uuid NOT NULL REFERENCES trustwork.context_thread (id),
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound', 'internal')),
  author_kind text NOT NULL CHECK (author_kind IN ('person', 'agent', 'system')),
  author_person_id uuid NULL REFERENCES trustwork.person (id),
  on_behalf_person_id uuid NULL REFERENCES trustwork.person (id),
  on_behalf_company_id uuid NULL REFERENCES trustwork.company (id),
  mandate_id uuid NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attachments) = 'array' AND jsonb_array_length(attachments) <= 20),
  source_time timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz NOT NULL DEFAULT now(),
  provider text NULL CHECK (provider IS NULL OR provider IN ('email', 'telegram', 'whatsapp', 'sms', 'other')),
  provider_message_id text NULL CHECK (provider_message_id IS NULL OR length(provider_message_id) BETWEEN 1 AND 200),
  channel_grant_id uuid NULL REFERENCES trustwork.channel_grant (id),
  -- What the channel claimed about the sender; informational, untrusted.
  sender_claim text NULL CHECK (sender_claim IS NULL OR length(sender_claim) <= 200),
  untrusted boolean NOT NULL DEFAULT false,
  CONSTRAINT message_inbound_untrusted CHECK (direction <> 'inbound' OR (untrusted AND provider IS NOT NULL)),
  CONSTRAINT message_provider_pair CHECK ((provider IS NULL) = (provider_message_id IS NULL)),
  CONSTRAINT message_author_shape CHECK ((author_kind = 'system') = (author_person_id IS NULL) AND (author_kind = 'agent') = (mandate_id IS NOT NULL)),
  CONSTRAINT message_on_behalf_xor CHECK (num_nonnulls(on_behalf_person_id, on_behalf_company_id) <= 1),
  -- Duplicate provider events never create a second message.
  CONSTRAINT message_provider_unique UNIQUE (provider, provider_message_id)
);
CREATE INDEX message_thread_idx ON trustwork.message (thread_id, seq);
CREATE TRIGGER message_append_only BEFORE UPDATE OR DELETE ON trustwork.message FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

CREATE TABLE trustwork.message_link (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  message_id uuid NOT NULL REFERENCES trustwork.message (id),
  object_kind text NOT NULL CHECK (object_kind IN ('rfq_version', 'quote_version', 'agreement', 'order', 'plan_version', 'task_request_version', 'task_offer', 'file')),
  object_id uuid NOT NULL,
  version_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_link_unique UNIQUE (message_id, object_kind, object_id)
);
CREATE TRIGGER message_link_append_only BEFORE UPDATE OR DELETE ON trustwork.message_link FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- Matches inbound replies to a thread and the person it was sent to. Only the SHA-256 of the token is stored.
CREATE TABLE trustwork.reply_token (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  thread_id uuid NOT NULL REFERENCES trustwork.context_thread (id),
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  channel_grant_id uuid NULL REFERENCES trustwork.channel_grant (id),
  delivery_id uuid NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reply_token_expiry CHECK (expires_at > created_at AND expires_at <= created_at + interval '90 days')
);

CREATE TABLE trustwork.notification (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  recipient_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  category text NOT NULL CHECK (category IN ('messages', 'commerce', 'tasks', 'projects', 'account', 'legal')),
  template_key text NOT NULL CHECK (trustwork.comms_template_params(template_key) IS NOT NULL),
  -- Recipient-visible values only: exactly the template's declared keys.
  params jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (trustwork.comms_params_allowed(template_key, params)),
  link_kind text NULL CHECK (link_kind IS NULL OR link_kind = ANY (trustwork.comms_context_kinds())),
  link_id uuid NULL,
  link_thread_id uuid NULL REFERENCES trustwork.context_thread (id),
  transactional boolean NOT NULL,
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  created_by_person_id uuid NULL REFERENCES trustwork.person (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz NULL,
  dismissed_at timestamptz NULL,
  CONSTRAINT notification_link_shape CHECK ((link_kind IS NULL) = (link_id IS NULL) AND (link_thread_id IS NULL OR link_kind IS NOT NULL)),
  CONSTRAINT notification_template_shape CHECK (category = trustwork.comms_template_category(template_key) AND transactional = trustwork.comms_template_transactional(template_key)),
  CONSTRAINT notification_once UNIQUE (recipient_person_id, dedupe_key)
);
CREATE INDEX notification_recipient_idx ON trustwork.notification (recipient_person_id, seq DESC);

CREATE TABLE trustwork.notification_preference (
  person_id uuid NOT NULL REFERENCES trustwork.person (id),
  category text NOT NULL CHECK (category IN ('messages', 'commerce', 'tasks', 'projects', 'account', 'legal')),
  channel text NOT NULL CHECK (channel IN ('email', 'messenger', 'sms')),
  frequency text NOT NULL CHECK (frequency IN ('immediate', 'daily', 'weekly', 'off')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, category, channel),
  -- Security and legal notices by e-mail cannot be turned off.
  CONSTRAINT notification_preference_transactional CHECK (NOT (category IN ('account', 'legal') AND channel = 'email' AND frequency = 'off'))
);

CREATE TABLE trustwork.message_template (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  key text NOT NULL CHECK (trustwork.comms_template_params(key) IS NOT NULL),
  category text NOT NULL,
  transactional boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_template_shape CHECK (category = trustwork.comms_template_category(key) AND transactional = trustwork.comms_template_transactional(key)),
  CONSTRAINT message_template_unique UNIQUE (hub_id, key)
);

CREATE TABLE trustwork.template_version (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  template_id uuid NOT NULL REFERENCES trustwork.message_template (id),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 10000),
  locale text NOT NULL CHECK (locale ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$'),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200 AND subject !~ '[\r\n]'),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  drafted_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  activated_by_person_id uuid NULL REFERENCES trustwork.person (id),
  activated_at timestamptz NULL,
  retired_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT template_version_unique UNIQUE (template_id, version, locale),
  -- Second person: the activator is never the drafter.
  CONSTRAINT template_version_second_person CHECK (activated_by_person_id IS NULL OR activated_by_person_id <> drafted_by_person_id),
  CONSTRAINT template_version_activation_shape CHECK ((status = 'draft') = (activated_by_person_id IS NULL) AND (activated_by_person_id IS NULL) = (activated_at IS NULL) AND (status = 'retired') = (retired_at IS NOT NULL))
);
CREATE UNIQUE INDEX template_version_one_active ON trustwork.template_version (template_id, locale) WHERE status = 'active';
CREATE TRIGGER template_version_frozen BEFORE UPDATE ON trustwork.template_version FOR EACH ROW
  EXECUTE FUNCTION trustwork.reject_update_when_frozen('status', 'draft', 'subject', 'body', 'locale', 'version', 'template_id', 'drafted_by_person_id');
CREATE TRIGGER template_version_touch BEFORE UPDATE ON trustwork.template_version FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- One planned or attempted delivery of a notification (or message) through one channel. Staff see counts only.
CREATE TABLE trustwork.delivery (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  notification_id uuid NULL REFERENCES trustwork.notification (id),
  message_id uuid NULL REFERENCES trustwork.message (id),
  recipient_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  channel text NOT NULL CHECK (channel IN ('email', 'sms', 'messenger', 'push')),
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 40),
  channel_grant_id uuid NULL REFERENCES trustwork.channel_grant (id),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'sent', 'delivered', 'bounced', 'failed', 'outcome_unknown', 'suppressed', 'skipped')),
  reason text NULL CHECK (reason IS NULL OR reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  provider_event_id text NULL CHECK (provider_event_id IS NULL OR length(provider_event_id) <= 200),
  provider_ref text NULL CHECK (provider_ref IS NULL OR length(provider_ref) <= 200),
  mail_delivery_id uuid NULL,
  created_by_person_id uuid NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_item_xor CHECK (num_nonnulls(notification_id, message_id) = 1),
  CONSTRAINT delivery_grant_shape CHECK (channel IN ('email', 'push') OR channel_grant_id IS NOT NULL),
  CONSTRAINT delivery_provider_event_unique UNIQUE (provider, provider_event_id)
);
CREATE UNIQUE INDEX delivery_once ON trustwork.delivery (notification_id, channel, coalesce(channel_grant_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE notification_id IS NOT NULL;
CREATE TRIGGER delivery_touch BEFORE UPDATE ON trustwork.delivery FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- Provider evidence that something left the platform (append-only).
CREATE TABLE trustwork.send_receipt (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  delivery_id uuid NULL REFERENCES trustwork.delivery (id),
  message_id uuid NULL REFERENCES trustwork.message (id),
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 40),
  provider_ref text NULL CHECK (provider_ref IS NULL OR length(provider_ref) <= 200),
  state text NOT NULL CHECK (state IN ('accepted', 'delivered', 'bounced', 'failed', 'unknown')),
  observed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT send_receipt_subject CHECK (num_nonnulls(delivery_id, message_id) >= 1)
);
CREATE TRIGGER send_receipt_append_only BEFORE UPDATE OR DELETE ON trustwork.send_receipt FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- Hub sending identities (Proposed): a live identity needs a second person to activate it; fakes need nobody.
CREATE TABLE trustwork.sender_identity (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  kind text NOT NULL CHECK (kind IN ('email_domain', 'sms_sender', 'messenger_bot')),
  value text NOT NULL CHECK (length(value) BETWEEN 1 AND 253),
  mode text NOT NULL DEFAULT 'fake' CHECK (mode IN ('fake', 'live')),
  verification jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(verification) = 'object'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'verifying', 'active', 'disabled')),
  created_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  activated_by_person_id uuid NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sender_identity_second_person CHECK (status <> 'active' OR mode = 'fake' OR (activated_by_person_id IS NOT NULL AND activated_by_person_id <> created_by_person_id)),
  CONSTRAINT sender_identity_unique UNIQUE (hub_id, kind, value)
);
CREATE TRIGGER sender_identity_touch BEFORE UPDATE ON trustwork.sender_identity FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- 3. Party resolution (live, never copied) ------------------------------------------------------------------------------
-- The person's active employer (the same derivation as set_principal).
CREATE FUNCTION trustwork.comms_active_company(p_person uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT m.company_id FROM trustwork.membership m WHERE m.person_id = p_person AND m.status = 'active' AND m.valid_from <= now()
$$;
-- Does the person (with the given active employer) act for the party? Person parties: the person; company parties:
-- active members holding the permission (NULL: any active member).
CREATE FUNCTION trustwork.comms_acts(p_party_person uuid, p_party_company uuid, p_person uuid, p_company uuid, p_permission text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT p_person IS NOT NULL AND (coalesce(p_party_person = p_person, false)
    OR (p_party_company IS NOT NULL AND p_company IS NOT NULL AND p_party_company = p_company AND EXISTS (
      SELECT 1 FROM trustwork.membership m WHERE m.person_id = p_person AND m.company_id = p_company AND m.status = 'active' AND m.valid_from <= now()
        AND (p_permission IS NULL OR p_permission = ANY (m.permissions)))))
$$;
-- The RFQ owner side for a person: the owner party (deal managers) or a live party-private participation with
-- read.party_private (the same rule as rfq_can, for an explicit person).
CREATE FUNCTION trustwork.comms_rfq_owner_side(p_rfq uuid, p_person uuid, p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM trustwork.rfq r WHERE r.id = p_rfq AND trustwork.comms_acts(r.owner_person_id, r.owner_company_id, p_person, p_company, 'company.deals.manage'))
    OR EXISTS (
      SELECT 1 FROM trustwork.object_participation op
      WHERE op.resource_kind = 'rfq' AND op.resource_id = p_rfq AND op.side <> 'staff' AND op.audience IN ('party_private', 'owner_private')
        AND op.revoked_at IS NULL AND op.valid_from <= now() AND (op.valid_until IS NULL OR op.valid_until > now())
        AND 'read.party_private' = ANY (op.capabilities)
        AND trustwork.comms_acts(op.party_person_id, op.party_company_id, p_person, p_company, 'company.deals.manage'))
$$;
CREATE FUNCTION trustwork.comms_agreement_side(p_agreement uuid, p_person uuid, p_company uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT CASE
    WHEN trustwork.comms_acts(a.seller_person_id, a.seller_company_id, p_person, p_company, 'company.deals.manage') THEN 'counterparty'
    WHEN trustwork.comms_acts(a.buyer_person_id, a.buyer_company_id, p_person, p_company, 'company.deals.manage')
      OR (a.rfq_id IS NOT NULL AND trustwork.comms_rfq_owner_side(a.rfq_id, p_person, p_company)) THEN 'owner'
  END
  FROM trustwork.agreement a WHERE a.id = p_agreement
$$;
-- How a person takes part in a context: 'owner', 'counterparty', 'participant', or NULL (not a party, or no such
-- context). A public project is not a reason to read its threads.
CREATE FUNCTION trustwork.comms_party_side(p_kind text, p_id uuid, p_person uuid, p_company uuid) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF p_person IS NULL OR p_id IS NULL THEN RETURN NULL; END IF;
  CASE p_kind
  WHEN 'project' THEN
    RETURN (SELECT CASE
      WHEN coalesce(pr.owner_person_id = p_person, false) OR (pr.owner_company_id IS NOT NULL AND pr.owner_company_id = p_company) THEN 'owner'
      WHEN EXISTS (SELECT 1 FROM trustwork.object_participation op
                   WHERE op.resource_kind = 'project' AND op.resource_id = pr.id AND op.side <> 'staff'
                     AND op.revoked_at IS NULL AND op.valid_from <= now() AND (op.valid_until IS NULL OR op.valid_until > now())
                     AND (op.party_person_id = p_person OR (op.party_company_id IS NOT NULL AND op.party_company_id = p_company))) THEN 'participant'
      END FROM trustwork.project pr WHERE pr.id = p_id);
  WHEN 'rfq' THEN
    RETURN (SELECT CASE
      WHEN trustwork.comms_rfq_owner_side(r.id, p_person, p_company) THEN 'owner'
      WHEN EXISTS (SELECT 1 FROM trustwork.rfq_invitation i WHERE i.rfq_id = r.id AND trustwork.comms_acts(i.party_person_id, i.party_company_id, p_person, p_company, 'company.deals.manage')) THEN 'counterparty'
      END FROM trustwork.rfq r WHERE r.id = p_id);
  WHEN 'quote' THEN
    RETURN (SELECT CASE
      WHEN trustwork.comms_acts(q.seller_person_id, q.seller_company_id, p_person, p_company, 'company.deals.manage') THEN 'counterparty'
      WHEN trustwork.comms_acts(q.buyer_person_id, q.buyer_company_id, p_person, p_company, 'company.deals.manage') OR trustwork.comms_rfq_owner_side(q.rfq_id, p_person, p_company) THEN 'owner'
      END FROM trustwork.quote q WHERE q.id = p_id);
  WHEN 'agreement' THEN
    RETURN trustwork.comms_agreement_side(p_id, p_person, p_company);
  WHEN 'order' THEN
    RETURN (SELECT trustwork.comms_agreement_side(o.agreement_id, p_person, p_company) FROM trustwork.commercial_order o WHERE o.id = p_id);
  WHEN 'task_request' THEN
    RETURN (SELECT CASE
      WHEN r.owner_person_id = p_person THEN 'owner'
      WHEN r.status <> 'draft' AND (r.audience = 'open'
        OR EXISTS (SELECT 1 FROM trustwork.task_invitation i WHERE i.task_request_id = r.id AND i.status = 'sent' AND trustwork.comms_acts(i.party_person_id, i.party_company_id, p_person, p_company, 'company.deals.manage'))
        OR EXISTS (SELECT 1 FROM trustwork.task_offer o WHERE o.task_request_id = r.id AND trustwork.comms_acts(o.offeror_person_id, o.offeror_company_id, p_person, p_company, 'company.deals.manage'))) THEN 'counterparty'
      END FROM trustwork.task_request r WHERE r.id = p_id);
  WHEN 'task_assignment' THEN
    RETURN (SELECT CASE
      WHEN a.owner_person_id = p_person THEN 'owner'
      WHEN trustwork.comms_acts(a.assignee_person_id, a.assignee_company_id, p_person, p_company, 'company.deals.manage') THEN 'counterparty'
      END FROM trustwork.task_assignment a WHERE a.id = p_id);
  ELSE
    RETURN NULL;
  END CASE;
END $$;
-- Does the context exist at all (any role)? A thread never exists without one.
CREATE FUNCTION trustwork.comms_context_exists(p_kind text, p_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
BEGIN
  CASE p_kind
  WHEN 'project' THEN RETURN EXISTS (SELECT 1 FROM trustwork.project WHERE id = p_id);
  WHEN 'rfq' THEN RETURN EXISTS (SELECT 1 FROM trustwork.rfq WHERE id = p_id);
  WHEN 'quote' THEN RETURN EXISTS (SELECT 1 FROM trustwork.quote WHERE id = p_id);
  WHEN 'agreement' THEN RETURN EXISTS (SELECT 1 FROM trustwork.agreement WHERE id = p_id);
  WHEN 'order' THEN RETURN EXISTS (SELECT 1 FROM trustwork.commercial_order WHERE id = p_id);
  WHEN 'task_request' THEN RETURN EXISTS (SELECT 1 FROM trustwork.task_request WHERE id = p_id);
  WHEN 'task_assignment' THEN RETURN EXISTS (SELECT 1 FROM trustwork.task_assignment WHERE id = p_id);
  ELSE RETURN false;
  END CASE;
END $$;
-- Is the party (exactly) a counterparty of the multi-counterparty context (invited, or offering)?
CREATE FUNCTION trustwork.comms_is_counterparty_party(p_kind text, p_id uuid, p_cp_person uuid, p_cp_company uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT CASE p_kind
    WHEN 'rfq' THEN EXISTS (SELECT 1 FROM trustwork.rfq_invitation i WHERE i.rfq_id = p_id
      AND i.party_person_id IS NOT DISTINCT FROM p_cp_person AND i.party_company_id IS NOT DISTINCT FROM p_cp_company)
    WHEN 'task_request' THEN EXISTS (SELECT 1 FROM trustwork.task_invitation i WHERE i.task_request_id = p_id AND i.status = 'sent'
        AND i.party_person_id IS NOT DISTINCT FROM p_cp_person AND i.party_company_id IS NOT DISTINCT FROM p_cp_company)
      OR EXISTS (SELECT 1 FROM trustwork.task_offer o WHERE o.task_request_id = p_id
        AND o.offeror_person_id IS NOT DISTINCT FROM p_cp_person AND o.offeror_company_id IS NOT DISTINCT FROM p_cp_company)
    ELSE false
  END
$$;
-- The reader's side for one thread: the context side, narrowed to the thread's counterparty for RFQ and task-request
-- threads (the owner side reads every counterparty's thread; a counterparty only its own).
CREATE FUNCTION trustwork.comms_thread_side(p_kind text, p_id uuid, p_cp_person uuid, p_cp_company uuid, p_person uuid, p_company uuid) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_side text := trustwork.comms_party_side(p_kind, p_id, p_person, p_company);
BEGIN
  IF v_side = 'counterparty' AND p_kind IN ('rfq', 'task_request') AND NOT trustwork.comms_acts(p_cp_person, p_cp_company, p_person, p_company, 'company.deals.manage') THEN
    RETURN NULL;
  END IF;
  RETURN v_side;
END $$;

-- Definers for policies and the API (current principal) -------------------------------------------------------------
CREATE FUNCTION trustwork.comms_my_side(p_kind text, p_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.comms_party_side(p_kind, p_id, trustwork.current_person_id(), trustwork.current_company_id())
$$;
CREATE FUNCTION trustwork.comms_thread_readable(p_kind text, p_id uuid, p_cp_person uuid, p_cp_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.comms_thread_side(p_kind, p_id, p_cp_person, p_cp_company, trustwork.current_person_id(), trustwork.current_company_id()) IS NOT NULL
$$;
CREATE FUNCTION trustwork.comms_thread_id_readable(p_thread uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT coalesce((SELECT trustwork.comms_thread_side(t.context_kind, t.context_id, t.counterparty_person_id, t.counterparty_company_id, trustwork.current_person_id(), trustwork.current_company_id()) IS NOT NULL
                   FROM trustwork.context_thread t WHERE t.id = p_thread), false)
$$;
-- Opening a thread: the opener is a party; on an RFQ or task request the counterparty side opens its own thread and
-- the owner side opens one only with a party that is invited or offering.
CREATE FUNCTION trustwork.comms_can_open(p_kind text, p_id uuid, p_cp_person uuid, p_cp_company uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_company uuid := trustwork.current_company_id();
  v_side text := trustwork.comms_party_side(p_kind, p_id, v_person, v_company);
BEGIN
  IF v_side IS NULL THEN RETURN false; END IF;
  IF p_kind NOT IN ('rfq', 'task_request') THEN RETURN true; END IF;
  -- The owner side never cold-opens a thread with an open-board visitor: only with an invited or offering party.
  IF v_side = 'owner' THEN RETURN trustwork.comms_is_counterparty_party(p_kind, p_id, p_cp_person, p_cp_company); END IF;
  RETURN trustwork.comms_acts(p_cp_person, p_cp_company, v_person, v_company, 'company.deals.manage');
END $$;
-- Posting: the thread is open and readable; on behalf of oneself or of one's employer as a deal manager.
CREATE FUNCTION trustwork.comms_can_post(p_thread uuid, p_on_behalf_person uuid, p_on_behalf_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT EXISTS (
    SELECT 1 FROM trustwork.context_thread t
    WHERE t.id = p_thread AND t.status = 'open'
      AND trustwork.comms_thread_side(t.context_kind, t.context_id, t.counterparty_person_id, t.counterparty_company_id, trustwork.current_person_id(), trustwork.current_company_id()) IS NOT NULL)
    AND (p_on_behalf_person IS NULL OR p_on_behalf_person = trustwork.current_person_id())
    AND (p_on_behalf_company IS NULL OR (p_on_behalf_company = trustwork.current_company_id() AND trustwork.current_membership_has('company.deals.manage')))
$$;
-- Display names of the people who appear in a thread the caller may read (authors, opener, counterparty person).
CREATE FUNCTION trustwork.comms_thread_people(p_thread uuid) RETURNS TABLE (person_id uuid, display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT p.id, p.display_name FROM trustwork.person p
  WHERE trustwork.comms_thread_id_readable(p_thread)
    AND p.id IN (SELECT m.author_person_id FROM trustwork.message m WHERE m.thread_id = p_thread AND m.author_person_id IS NOT NULL
                 UNION SELECT t.opened_by_person_id FROM trustwork.context_thread t WHERE t.id = p_thread
                 UNION SELECT t.counterparty_person_id FROM trustwork.context_thread t WHERE t.id = p_thread AND t.counterparty_person_id IS NOT NULL)
$$;

-- 4. Guards -------------------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.comms_thread_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'threads are kept with their context' USING ERRCODE = 'integrity_constraint_violation', HINT = 'comms.retained';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT trustwork.comms_context_exists(NEW.context_kind, NEW.context_id) THEN
      RAISE EXCEPTION 'no thread without a context' USING ERRCODE = 'foreign_key_violation', HINT = 'comms.context_missing';
    END IF;
    NEW.status := 'open';
    NEW.message_count := 0;
    NEW.last_message_at := NULL;
    NEW.revision := 1;
    NEW.created_at := now();
    NEW.updated_at := now();
  ELSIF NEW.context_kind <> OLD.context_kind OR NEW.context_id <> OLD.context_id OR NEW.counterparty_person_id IS DISTINCT FROM OLD.counterparty_person_id
     OR NEW.counterparty_company_id IS DISTINCT FROM OLD.counterparty_company_id OR NEW.opened_by_person_id <> OLD.opened_by_person_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a thread keeps its context' USING ERRCODE = 'integrity_constraint_violation', HINT = 'comms.immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER context_thread_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.context_thread FOR EACH ROW EXECUTE FUNCTION trustwork.comms_thread_guard();

-- Every message moves its thread's counters (the runtime role cannot update threads itself).
CREATE FUNCTION trustwork.comms_message_counted() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  UPDATE trustwork.context_thread SET message_count = message_count + 1, last_message_at = greatest(coalesce(last_message_at, NEW.received_at), NEW.received_at)
  WHERE id = NEW.thread_id;
  RETURN NULL;
END $$;
CREATE TRIGGER message_counted AFTER INSERT ON trustwork.message FOR EACH ROW EXECUTE FUNCTION trustwork.comms_message_counted();

CREATE FUNCTION trustwork.comms_message_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  NEW.received_at := now();
  IF NEW.direction = 'inbound' THEN NEW.untrusted := true; END IF;
  IF NEW.source_time > now() + interval '5 minutes' THEN NEW.source_time := now(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER message_guard BEFORE INSERT ON trustwork.message FOR EACH ROW EXECUTE FUNCTION trustwork.comms_message_guard();

CREATE FUNCTION trustwork.comms_notification_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'notifications are dismissed, not deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'comms.retained';
  END IF;
  IF ROW(NEW.id, NEW.recipient_person_id, NEW.category, NEW.template_key, NEW.params, NEW.link_kind, NEW.link_id, NEW.link_thread_id, NEW.transactional, NEW.dedupe_key, NEW.created_by_person_id, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.recipient_person_id, OLD.category, OLD.template_key, OLD.params, OLD.link_kind, OLD.link_id, OLD.link_thread_id, OLD.transactional, OLD.dedupe_key, OLD.created_by_person_id, OLD.created_at) THEN
    RAISE EXCEPTION 'a notification only changes its read and dismissed marks' USING ERRCODE = 'integrity_constraint_violation', HINT = 'comms.immutable';
  END IF;
  -- Marks are set once and kept.
  NEW.read_at := coalesce(OLD.read_at, NEW.read_at);
  NEW.dismissed_at := coalesce(OLD.dismissed_at, NEW.dismissed_at);
  RETURN NEW;
END $$;
CREATE TRIGGER notification_guard BEFORE UPDATE OR DELETE ON trustwork.notification FOR EACH ROW EXECUTE FUNCTION trustwork.comms_notification_guard();

CREATE FUNCTION trustwork.comms_channel_grant_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'channel grants are revoked, not deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'comms.retained';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.status := 'active';
    NEW.revoked_at := NULL;
    NEW.granted_at := now();
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.person_id, NEW.provider, NEW.account_ref, NEW.account_display, NEW.scopes, NEW.credential_ref, NEW.granted_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.person_id, OLD.provider, OLD.account_ref, OLD.account_display, OLD.scopes, OLD.credential_ref, OLD.granted_at)
     OR OLD.status = 'revoked' OR NEW.status <> 'revoked' THEN
    RAISE EXCEPTION 'a channel grant only changes by revocation, once' USING ERRCODE = 'integrity_constraint_violation', HINT = 'comms.immutable';
  END IF;
  NEW.revoked_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER channel_grant_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.channel_grant FOR EACH ROW EXECUTE FUNCTION trustwork.comms_channel_grant_guard();

CREATE FUNCTION trustwork.comms_template_version_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'template versions are retired, not deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'comms.retained';
  END IF;
  IF OLD.status = 'active' AND NEW.status NOT IN ('active', 'retired') OR OLD.status = 'retired' AND NEW.status <> 'retired' THEN
    RAISE EXCEPTION 'template versions move draft -> active -> retired' USING ERRCODE = 'integrity_constraint_violation', HINT = 'comms.immutable';
  END IF;
  IF OLD.status <> 'draft' AND (NEW.activated_by_person_id IS DISTINCT FROM OLD.activated_by_person_id OR NEW.activated_at IS DISTINCT FROM OLD.activated_at) THEN
    RAISE EXCEPTION 'an activation is recorded once' USING ERRCODE = 'integrity_constraint_violation', HINT = 'comms.immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER template_version_guard BEFORE UPDATE OR DELETE ON trustwork.template_version FOR EACH ROW EXECUTE FUNCTION trustwork.comms_template_version_guard();
CREATE TRIGGER message_template_retained BEFORE UPDATE OR DELETE ON trustwork.message_template FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 5. Notifications and deliveries ---------------------------------------------------------------------------------------
-- One delivery the API still has to act on (render and enqueue mail, or dispatch through a channel adapter).
CREATE TYPE trustwork.comms_planned_delivery AS (
  delivery_id uuid, notification_id uuid, recipient_person_id uuid, channel text, provider text, channel_grant_id uuid, account_ref text,
  languages text[], template_key text, params jsonb, transactional boolean, link_kind text, link_id uuid, link_thread_id uuid
);

-- Plans the deliveries of one notification from the recipient's preferences (defaults when unset) and live grants.
-- Daily and weekly digests are not sent yet (no immediate delivery is planned for them).
CREATE FUNCTION trustwork.comms_plan_deliveries(p_notification uuid, p_actor uuid) RETURNS SETOF trustwork.comms_planned_delivery
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  n trustwork.notification%ROWTYPE;
  v_langs text[];
  v_freq text;
  v_id uuid;
  g trustwork.channel_grant%ROWTYPE;
  v_channel text;
BEGIN
  SELECT * INTO n FROM trustwork.notification WHERE id = p_notification;
  SELECT coalesce(pp.languages, '{}') INTO v_langs FROM trustwork.person_profile pp WHERE pp.person_id = n.recipient_person_id;
  v_langs := coalesce(v_langs, '{}');
  -- E-mail through the hub sender (no grant needed); transactional notices always at once.
  v_freq := CASE WHEN n.transactional THEN 'immediate'
                 ELSE coalesce((SELECT frequency FROM trustwork.notification_preference WHERE person_id = n.recipient_person_id AND category = n.category AND channel = 'email'),
                               trustwork.comms_default_frequency(n.category, 'email')) END;
  IF v_freq = 'immediate' THEN
    INSERT INTO trustwork.delivery (notification_id, recipient_person_id, channel, provider, created_by_person_id)
    VALUES (n.id, n.recipient_person_id, 'email', 'mail', p_actor) ON CONFLICT DO NOTHING RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN
      RETURN NEXT ROW(v_id, n.id, n.recipient_person_id, 'email', 'mail', NULL::uuid, NULL::text, v_langs, n.template_key, n.params, n.transactional, n.link_kind, n.link_id, n.link_thread_id)::trustwork.comms_planned_delivery;
    END IF;
  END IF;
  -- Messengers and SMS only through a live grant whose scope covers the context kind and the notify action.
  IF n.link_kind IS NOT NULL THEN
    FOR g IN SELECT * FROM trustwork.channel_grant cg
             WHERE cg.person_id = n.recipient_person_id AND cg.status = 'active' AND cg.provider <> 'email'
               AND cg.scopes -> 'contextKinds' ? n.link_kind AND cg.scopes -> 'actions' ? 'notify'
             ORDER BY cg.granted_at, cg.id LOOP
      v_channel := CASE WHEN g.provider = 'sms' THEN 'sms' ELSE 'messenger' END;
      v_freq := coalesce((SELECT frequency FROM trustwork.notification_preference WHERE person_id = n.recipient_person_id AND category = n.category AND channel = v_channel),
                         trustwork.comms_default_frequency(n.category, v_channel));
      CONTINUE WHEN v_freq <> 'immediate';
      v_id := NULL;
      INSERT INTO trustwork.delivery (notification_id, recipient_person_id, channel, provider, channel_grant_id, created_by_person_id)
      VALUES (n.id, n.recipient_person_id, v_channel, g.provider, g.id, p_actor) ON CONFLICT DO NOTHING RETURNING id INTO v_id;
      IF v_id IS NOT NULL THEN
        RETURN NEXT ROW(v_id, n.id, n.recipient_person_id, v_channel, g.provider, g.id, g.account_ref, v_langs, n.template_key, n.params, n.transactional, n.link_kind, n.link_id, n.link_thread_id)::trustwork.comms_planned_delivery;
      END IF;
    END LOOP;
  END IF;
END $$;

-- People who may be told about a message: the thread's own people and the named people of its context; each one is
-- kept only while they are a party of the thread (checked for that person and their active employer).
CREATE FUNCTION trustwork.comms_company_deal_people(p_company uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT m.person_id FROM trustwork.membership m
  WHERE p_company IS NOT NULL AND m.company_id = p_company AND m.status = 'active' AND m.valid_from <= now() AND 'company.deals.manage' = ANY (m.permissions)
$$;
CREATE FUNCTION trustwork.comms_thread_candidates(p_thread uuid) RETURNS SETOF uuid
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  t trustwork.context_thread%ROWTYPE;
BEGIN
  SELECT * INTO t FROM trustwork.context_thread WHERE id = p_thread;
  RETURN QUERY SELECT t.opened_by_person_id;
  RETURN QUERY SELECT DISTINCT m.author_person_id FROM trustwork.message m WHERE m.thread_id = t.id AND m.author_person_id IS NOT NULL;
  IF t.counterparty_person_id IS NOT NULL THEN RETURN QUERY SELECT t.counterparty_person_id; END IF;
  RETURN QUERY SELECT trustwork.comms_company_deal_people(t.counterparty_company_id);
  CASE t.context_kind
  WHEN 'project' THEN
    RETURN QUERY SELECT x FROM trustwork.project pr, LATERAL unnest(ARRAY[pr.owner_person_id, pr.creator_person_id, pr.leader_person_id]) x WHERE pr.id = t.context_id AND x IS NOT NULL;
    RETURN QUERY SELECT trustwork.comms_company_deal_people(pr.owner_company_id) FROM trustwork.project pr WHERE pr.id = t.context_id;
    RETURN QUERY SELECT op.party_person_id FROM trustwork.object_participation op
      WHERE op.resource_kind = 'project' AND op.resource_id = t.context_id AND op.party_person_id IS NOT NULL AND op.revoked_at IS NULL;
    RETURN QUERY SELECT trustwork.comms_company_deal_people(op.party_company_id) FROM trustwork.object_participation op
      WHERE op.resource_kind = 'project' AND op.resource_id = t.context_id AND op.party_company_id IS NOT NULL AND op.revoked_at IS NULL;
  WHEN 'rfq' THEN
    RETURN QUERY SELECT x FROM trustwork.rfq r, LATERAL unnest(ARRAY[r.owner_person_id, r.creator_person_id]) x WHERE r.id = t.context_id AND x IS NOT NULL;
    RETURN QUERY SELECT trustwork.comms_company_deal_people(r.owner_company_id) FROM trustwork.rfq r WHERE r.id = t.context_id;
  WHEN 'quote' THEN
    RETURN QUERY SELECT x FROM trustwork.quote q, LATERAL unnest(ARRAY[q.seller_person_id, q.creator_person_id, q.buyer_person_id]) x WHERE q.id = t.context_id AND x IS NOT NULL;
    RETURN QUERY SELECT trustwork.comms_company_deal_people(c) FROM trustwork.quote q, LATERAL unnest(ARRAY[q.seller_company_id, q.buyer_company_id]) c WHERE q.id = t.context_id AND c IS NOT NULL;
    RETURN QUERY SELECT x FROM trustwork.quote q JOIN trustwork.rfq r ON r.id = q.rfq_id, LATERAL unnest(ARRAY[r.owner_person_id, r.creator_person_id]) x WHERE q.id = t.context_id AND x IS NOT NULL;
    RETURN QUERY SELECT trustwork.comms_company_deal_people(r.owner_company_id) FROM trustwork.quote q JOIN trustwork.rfq r ON r.id = q.rfq_id WHERE q.id = t.context_id;
  WHEN 'agreement', 'order' THEN
    RETURN QUERY SELECT x FROM trustwork.agreement a, LATERAL unnest(ARRAY[a.buyer_person_id, a.seller_person_id, a.created_by_person_id]) x
      WHERE a.id = CASE WHEN t.context_kind = 'agreement' THEN t.context_id ELSE (SELECT o.agreement_id FROM trustwork.commercial_order o WHERE o.id = t.context_id) END AND x IS NOT NULL;
    RETURN QUERY SELECT trustwork.comms_company_deal_people(c) FROM trustwork.agreement a, LATERAL unnest(ARRAY[a.buyer_company_id, a.seller_company_id]) c
      WHERE a.id = CASE WHEN t.context_kind = 'agreement' THEN t.context_id ELSE (SELECT o.agreement_id FROM trustwork.commercial_order o WHERE o.id = t.context_id) END AND c IS NOT NULL;
  WHEN 'task_request' THEN
    RETURN QUERY SELECT r.owner_person_id FROM trustwork.task_request r WHERE r.id = t.context_id;
  WHEN 'task_assignment' THEN
    RETURN QUERY SELECT x FROM trustwork.task_assignment a, LATERAL unnest(ARRAY[a.owner_person_id, a.assignee_person_id, a.created_by_person_id]) x WHERE a.id = t.context_id AND x IS NOT NULL;
    RETURN QUERY SELECT trustwork.comms_company_deal_people(a.assignee_company_id) FROM trustwork.task_assignment a WHERE a.id = t.context_id;
  ELSE
    NULL;
  END CASE;
END $$;

-- Tells every other party of the thread about one message the caller wrote (once per message). The parameters are
-- computed here from the thread and the author, never taken from the caller. Returns the deliveries to act on.
CREATE FUNCTION trustwork.comms_fanout_message(p_message uuid, p_template text) RETURNS SETOF trustwork.comms_planned_delivery
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  m trustwork.message%ROWTYPE;
  t trustwork.context_thread%ROWTYPE;
  v_actor uuid := trustwork.current_person_id();
  v_params jsonb;
  v_recipient uuid;
  v_notification uuid;
BEGIN
  IF p_template NOT IN ('thread.opened', 'thread.message') THEN
    RAISE EXCEPTION 'unknown thread template %', p_template USING ERRCODE = 'check_violation', HINT = 'comms.template_unknown';
  END IF;
  SELECT * INTO m FROM trustwork.message WHERE id = p_message;
  IF m.id IS NULL OR v_actor IS NULL OR m.author_person_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'only the author announces a message' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  SELECT * INTO t FROM trustwork.context_thread WHERE id = m.thread_id;
  v_params := jsonb_build_object('contextKind', t.context_kind, 'threadSubject', left(t.subject, 200),
    'authorName', left(coalesce((SELECT display_name FROM trustwork.person WHERE id = v_actor), ''), 200));
  FOR v_recipient IN
    SELECT DISTINCT c FROM trustwork.comms_thread_candidates(t.id) c
    WHERE c IS NOT NULL AND c <> v_actor
      AND trustwork.comms_thread_side(t.context_kind, t.context_id, t.counterparty_person_id, t.counterparty_company_id, c, trustwork.comms_active_company(c)) IS NOT NULL
    ORDER BY c
  LOOP
    v_notification := NULL;
    INSERT INTO trustwork.notification (recipient_person_id, category, template_key, params, link_kind, link_id, link_thread_id, transactional, dedupe_key, created_by_person_id)
    VALUES (v_recipient, 'messages', p_template, v_params, t.context_kind, t.context_id, t.id, false, 'message:' || m.id::text, v_actor)
    ON CONFLICT (recipient_person_id, dedupe_key) DO NOTHING RETURNING id INTO v_notification;
    IF v_notification IS NOT NULL THEN
      RETURN QUERY SELECT * FROM trustwork.comms_plan_deliveries(v_notification, v_actor);
    END IF;
  END LOOP;
END $$;

-- Producer for other modules: one notification of a non-thread template. A linked notification needs both the caller
-- and the recipient to be parties of the context; an unlinked one (account notices) goes to the caller only.
CREATE FUNCTION trustwork.comms_notify(p_recipient uuid, p_template text, p_params jsonb, p_link_kind text, p_link_id uuid, p_dedupe text) RETURNS SETOF trustwork.comms_planned_delivery
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor uuid := trustwork.current_person_id();
  v_notification uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'a principal is required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  IF trustwork.comms_template_params(p_template) IS NULL OR p_template LIKE 'thread.%' THEN
    RAISE EXCEPTION 'template % is not produced here', p_template USING ERRCODE = 'check_violation', HINT = 'comms.template_unknown';
  END IF;
  IF NOT trustwork.comms_params_allowed(p_template, coalesce(p_params, '{}'::jsonb)) THEN
    RAISE EXCEPTION 'parameters outside the template' USING ERRCODE = 'check_violation', HINT = 'comms.params_not_allowed';
  END IF;
  IF p_link_kind IS NULL THEN
    IF p_recipient <> v_actor THEN
      RAISE EXCEPTION 'an unlinked notice goes to its own person only' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
    END IF;
  ELSIF trustwork.comms_party_side(p_link_kind, p_link_id, v_actor, trustwork.current_company_id()) IS NULL
     OR trustwork.comms_party_side(p_link_kind, p_link_id, p_recipient, trustwork.comms_active_company(p_recipient)) IS NULL THEN
    RAISE EXCEPTION 'both people must be parties of the context' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  INSERT INTO trustwork.notification (recipient_person_id, category, template_key, params, link_kind, link_id, transactional, dedupe_key, created_by_person_id)
  VALUES (p_recipient, trustwork.comms_template_category(p_template), p_template, coalesce(p_params, '{}'::jsonb), p_link_kind, p_link_id,
          trustwork.comms_template_transactional(p_template), p_dedupe, v_actor)
  ON CONFLICT (recipient_person_id, dedupe_key) DO NOTHING RETURNING id INTO v_notification;
  IF v_notification IS NOT NULL THEN
    RETURN QUERY SELECT * FROM trustwork.comms_plan_deliveries(v_notification, v_actor);
  END IF;
END $$;

-- The delivery of the caller's own planning, locked; refuses anything else.
CREATE FUNCTION trustwork.comms_own_delivery(p_delivery uuid) RETURNS trustwork.delivery
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  d trustwork.delivery%ROWTYPE;
BEGIN
  SELECT * INTO d FROM trustwork.delivery WHERE id = p_delivery FOR UPDATE;
  IF d.id IS NULL OR trustwork.current_person_id() IS NULL OR d.created_by_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
    RAISE EXCEPTION 'unknown delivery' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  RETURN d;
END $$;

-- Address hash exactly as MAIL-001 computes it (mailAddressHash: sha256 of "mail:" || normalized address).
CREATE FUNCTION trustwork.comms_mail_hash(p_address text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT encode(sha256(convert_to('mail:' || lower(normalize(btrim(p_address), NFC)), 'UTF8')), 'hex') $$;

-- Enqueues one planned e-mail delivery through MAIL-001 (mail_delivery + mail.requested in this transaction). The
-- recipient address is read here and never returned. Suppressed addresses get no non-transactional mail; an
-- unsubscribe never blocks a transactional notice, a bounce, complaint or legal entry blocks everything.
CREATE FUNCTION trustwork.comms_enqueue_mail(p_delivery uuid, p_locale text, p_subject text, p_body text, p_path text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  d trustwork.delivery := trustwork.comms_own_delivery(p_delivery);
  v_transactional boolean;
  v_address text;
  v_hash text;
  v_reason text;
  v_mail uuid := trustwork.new_uuid();
BEGIN
  IF d.channel <> 'email' OR d.state <> 'queued' OR d.mail_delivery_id IS NOT NULL THEN
    RAISE EXCEPTION 'delivery is not a queued e-mail' USING ERRCODE = 'check_violation', HINT = 'comms.delivery_state';
  END IF;
  IF p_path !~ '^/app/[A-Za-z0-9/_.?=&-]{0,255}$' THEN
    RAISE EXCEPTION 'links stay inside the workspace' USING ERRCODE = 'check_violation', HINT = 'comms.link_invalid';
  END IF;
  SELECT n.transactional INTO v_transactional FROM trustwork.notification n WHERE n.id = d.notification_id;
  SELECT b.email_normalized INTO v_address FROM trustwork.email_binding b
  WHERE b.person_id = d.recipient_person_id AND b.is_primary AND b.verified_at IS NOT NULL;
  IF v_address IS NULL THEN
    UPDATE trustwork.delivery SET state = 'skipped', reason = 'no_verified_address' WHERE id = d.id;
    RETURN 'skipped';
  END IF;
  v_hash := trustwork.comms_mail_hash(v_address);
  SELECT s.reason INTO v_reason FROM trustwork.suppression_entry s WHERE s.address_hash = v_hash;
  IF v_reason IS NOT NULL AND (v_reason <> 'unsubscribe' OR NOT coalesce(v_transactional, false)) THEN
    UPDATE trustwork.delivery SET state = 'suppressed', reason = 'suppressed_' || v_reason WHERE id = d.id;
    RETURN 'suppressed';
  END IF;
  INSERT INTO trustwork.mail_delivery (id, template, locale_preferences, recipient, recipient_hash, params)
  VALUES (v_mail, 'notification', ARRAY[p_locale], v_address, v_hash,
          jsonb_build_object('subject', left(p_subject, 200), 'body', left(p_body, 1200), 'path', p_path, 'transactional', CASE WHEN v_transactional THEN 'true' ELSE 'false' END));
  INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload) VALUES ('mail_delivery', v_mail::text, 1, 'mail.requested', '{}'::jsonb);
  UPDATE trustwork.delivery SET mail_delivery_id = v_mail WHERE id = d.id;
  RETURN 'queued';
END $$;

-- Records what a channel adapter answered for one of the caller's queued deliveries. An unknown outcome is final until
-- reconciled: it is never retried blindly.
CREATE FUNCTION trustwork.comms_settle_delivery(p_delivery uuid, p_state text, p_provider_ref text, p_reason text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  d trustwork.delivery := trustwork.comms_own_delivery(p_delivery);
BEGIN
  IF p_state NOT IN ('sent', 'failed', 'outcome_unknown', 'skipped') THEN
    RAISE EXCEPTION 'unknown delivery outcome %', p_state USING ERRCODE = 'check_violation', HINT = 'comms.delivery_state';
  END IF;
  IF d.state <> 'queued' OR d.mail_delivery_id IS NOT NULL THEN
    RETURN d.state;
  END IF;
  UPDATE trustwork.delivery SET state = p_state, provider_ref = left(p_provider_ref, 200), reason = p_reason WHERE id = d.id;
  IF p_state <> 'skipped' THEN
    INSERT INTO trustwork.send_receipt (delivery_id, provider, provider_ref, state)
    VALUES (d.id, d.provider, left(p_provider_ref, 200), CASE p_state WHEN 'sent' THEN 'accepted' WHEN 'failed' THEN 'failed' ELSE 'unknown' END);
  END IF;
  RETURN p_state;
END $$;

-- Issues the reply token of a messenger or SMS delivery (hash only), bound to the thread, the recipient and the grant.
CREATE FUNCTION trustwork.comms_issue_reply_token(p_delivery uuid, p_token_hash text, p_expires_at timestamptz) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  d trustwork.delivery := trustwork.comms_own_delivery(p_delivery);
  v_thread uuid;
BEGIN
  SELECT n.link_thread_id INTO v_thread FROM trustwork.notification n WHERE n.id = d.notification_id;
  IF v_thread IS NULL OR d.channel_grant_id IS NULL OR d.state <> 'queued' THEN
    RAISE EXCEPTION 'only queued channel deliveries of a thread carry a reply token' USING ERRCODE = 'check_violation', HINT = 'comms.delivery_state';
  END IF;
  INSERT INTO trustwork.reply_token (thread_id, person_id, channel_grant_id, delivery_id, token_hash, expires_at)
  VALUES (v_thread, d.recipient_person_id, d.channel_grant_id, d.id, p_token_hash, p_expires_at);
END $$;

-- Pre-identity lookup for inbound intake: which thread and person a reply token belongs to, while the token is
-- unexpired and its grant is still live with the reply action. The intake then acts as that person (RLS decides).
CREATE FUNCTION trustwork.comms_resolve_reply_token(p_token_hash text)
RETURNS TABLE (thread_id uuid, person_id uuid, authz_epoch integer, channel_grant_id uuid, provider text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT rt.thread_id, rt.person_id, p.authz_epoch, rt.channel_grant_id, coalesce(g.provider, 'email')
  FROM trustwork.reply_token rt
  JOIN trustwork.person p ON p.id = rt.person_id
  LEFT JOIN trustwork.channel_grant g ON g.id = rt.channel_grant_id
  WHERE rt.token_hash = p_token_hash AND rt.expires_at > now()
    AND (rt.channel_grant_id IS NULL OR (g.status = 'active' AND g.scopes -> 'actions' ? 'reply'))
$$;

-- The caller unsubscribes their verified primary address from non-transactional mail (suppression `unsubscribe`).
CREATE FUNCTION trustwork.comms_mail_unsubscribe() RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_address text;
  v_added text;
BEGIN
  SELECT b.email_normalized INTO v_address FROM trustwork.email_binding b
  WHERE b.person_id = trustwork.current_person_id() AND b.is_primary AND b.verified_at IS NOT NULL;
  IF v_address IS NULL THEN RETURN false; END IF;
  INSERT INTO trustwork.suppression_entry (address_hash, reason, source) VALUES (trustwork.comms_mail_hash(v_address), 'unsubscribe', 'comms:self')
  ON CONFLICT (address_hash) DO NOTHING RETURNING address_hash INTO v_added;
  RETURN v_added IS NOT NULL;
END $$;
-- The suppression reason of the caller's own verified primary address (for the settings page), or NULL.
CREATE FUNCTION trustwork.comms_mail_suppression() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT s.reason FROM trustwork.email_binding b JOIN trustwork.suppression_entry s ON s.address_hash = trustwork.comms_mail_hash(b.email_normalized)
  WHERE b.person_id = trustwork.current_person_id() AND b.is_primary AND b.verified_at IS NOT NULL
$$;

-- 6. Templates ----------------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.comms_template_staff(p_hub uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.admin_has_any_permission(ARRAY['admin.notifications.template.edit', 'admin.config.edit'], NULL, p_hub)
$$;
-- Drafts one language of a template version: a new version (the next number) or a version that is still a draft.
CREATE FUNCTION trustwork.comms_template_draft(p_hub uuid, p_key text, p_version integer, p_locale text, p_subject text, p_body text) RETURNS trustwork.template_version
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor uuid := trustwork.current_person_id();
  v_template trustwork.message_template%ROWTYPE;
  v_max integer;
  v_row trustwork.template_version%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR NOT trustwork.admin_has_permission('admin.notifications.template.edit', NULL, p_hub) THEN
    RAISE EXCEPTION 'drafting templates needs admin.notifications.template.edit' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.forbidden';
  END IF;
  IF trustwork.comms_template_params(p_key) IS NULL THEN
    RAISE EXCEPTION 'unknown template %', p_key USING ERRCODE = 'check_violation', HINT = 'comms.template_unknown';
  END IF;
  INSERT INTO trustwork.message_template (hub_id, key, category, transactional)
  VALUES (p_hub, p_key, trustwork.comms_template_category(p_key), trustwork.comms_template_transactional(p_key))
  ON CONFLICT (hub_id, key) DO NOTHING;
  SELECT * INTO v_template FROM trustwork.message_template WHERE hub_id = p_hub AND key = p_key FOR UPDATE;
  SELECT max(version) INTO v_max FROM trustwork.template_version WHERE template_id = v_template.id;
  IF EXISTS (SELECT 1 FROM trustwork.template_version WHERE template_id = v_template.id AND version = p_version AND status <> 'draft') THEN
    RAISE EXCEPTION 'version % is no longer a draft', p_version USING ERRCODE = 'check_violation', HINT = 'comms.template_frozen';
  END IF;
  IF p_version <> coalesce(v_max, 0) + 1 AND NOT EXISTS (SELECT 1 FROM trustwork.template_version WHERE template_id = v_template.id AND version = p_version) THEN
    RAISE EXCEPTION 'draft the next version (%)', coalesce(v_max, 0) + 1 USING ERRCODE = 'check_violation', HINT = 'comms.template_version_gap';
  END IF;
  INSERT INTO trustwork.template_version (template_id, version, locale, subject, body, drafted_by_person_id)
  VALUES (v_template.id, p_version, p_locale, p_subject, p_body, v_actor)
  ON CONFLICT (template_id, version, locale) DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body, drafted_by_person_id = EXCLUDED.drafted_by_person_id
    WHERE trustwork.template_version.status = 'draft'
  RETURNING * INTO v_row;
  INSERT INTO trustwork.audit_event (actor_person_id, action, object_kind, object_id, basis)
  VALUES (v_actor, 'comms.template_drafted', 'template_version', v_row.id::text, jsonb_build_object('key', p_key, 'version', p_version, 'locale', p_locale));
  RETURN v_row;
END $$;
-- Activates a draft version: it must exist in every required (hub) language, and no language of it may have been
-- drafted by the activator. The previously active version is retired in the same transaction.
CREATE FUNCTION trustwork.comms_template_activate(p_hub uuid, p_key text, p_version integer, p_required text[], p_reason text) RETURNS SETOF trustwork.template_version
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor uuid := trustwork.current_person_id();
  v_template trustwork.message_template%ROWTYPE;
  v_missing text[];
BEGIN
  IF v_actor IS NULL OR NOT trustwork.admin_has_permission('admin.config.edit', NULL, p_hub) THEN
    RAISE EXCEPTION 'activating templates needs admin.config.edit' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.forbidden';
  END IF;
  IF p_required IS NULL OR cardinality(p_required) = 0 THEN
    RAISE EXCEPTION 'the hub languages are required' USING ERRCODE = 'check_violation', HINT = 'comms.template_incomplete';
  END IF;
  SELECT * INTO v_template FROM trustwork.message_template WHERE hub_id = p_hub AND key = p_key FOR UPDATE;
  IF v_template.id IS NULL OR NOT EXISTS (SELECT 1 FROM trustwork.template_version WHERE template_id = v_template.id AND version = p_version) THEN
    RAISE EXCEPTION 'no such template version' USING ERRCODE = 'no_data_found', HINT = 'access.not_found';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.template_version WHERE template_id = v_template.id AND version = p_version AND status <> 'draft') THEN
    RAISE EXCEPTION 'version % is not a draft', p_version USING ERRCODE = 'check_violation', HINT = 'comms.template_frozen';
  END IF;
  SELECT array_agg(l ORDER BY l) INTO v_missing FROM unnest(p_required) l
  WHERE NOT EXISTS (SELECT 1 FROM trustwork.template_version v WHERE v.template_id = v_template.id AND v.version = p_version AND v.locale = l);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'version % lacks languages %', p_version, array_to_string(v_missing, ', ') USING ERRCODE = 'check_violation', HINT = 'comms.template_incomplete', DETAIL = array_to_string(v_missing, ',');
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.template_version WHERE template_id = v_template.id AND version = p_version AND drafted_by_person_id = v_actor) THEN
    RAISE EXCEPTION 'the drafter cannot activate' USING ERRCODE = 'check_violation', HINT = 'comms.second_person_required';
  END IF;
  UPDATE trustwork.template_version SET status = 'retired', retired_at = now() WHERE template_id = v_template.id AND status = 'active';
  UPDATE trustwork.template_version SET status = 'active', activated_by_person_id = v_actor, activated_at = now() WHERE template_id = v_template.id AND version = p_version;
  INSERT INTO trustwork.audit_event (actor_person_id, action, object_kind, object_id, reason, basis)
  VALUES (v_actor, 'comms.template_activated', 'message_template', v_template.id::text, left(p_reason, 500),
          jsonb_build_object('key', p_key, 'version', p_version, 'requiredLocales', to_jsonb(p_required)));
  RETURN QUERY SELECT * FROM trustwork.template_version WHERE template_id = v_template.id AND version = p_version ORDER BY locale;
END $$;
CREATE FUNCTION trustwork.comms_template_versions(p_hub uuid, p_key text) RETURNS SETOF trustwork.template_version
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF NOT trustwork.comms_template_staff(p_hub) THEN
    RAISE EXCEPTION 'templates are staff configuration' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.forbidden';
  END IF;
  RETURN QUERY SELECT v.* FROM trustwork.template_version v JOIN trustwork.message_template t ON t.id = v.template_id
    WHERE t.hub_id = p_hub AND t.key = p_key ORDER BY v.version DESC, v.locale;
END $$;
-- Active texts of a template (rendered output is public by nature): every language of the active version.
CREATE FUNCTION trustwork.comms_active_template(p_hub uuid, p_key text) RETURNS TABLE (locale text, version integer, subject text, body text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT v.locale, v.version, v.subject, v.body FROM trustwork.template_version v JOIN trustwork.message_template t ON t.id = v.template_id
  WHERE t.hub_id = p_hub AND t.key = p_key AND v.status = 'active' AND trustwork.current_person_id() IS NOT NULL
$$;
-- Deliverability for the hub console: counts per channel and state, never per person.
CREATE FUNCTION trustwork.comms_delivery_counts(p_hub uuid) RETURNS TABLE (channel text, state text, n integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF NOT trustwork.admin_has_any_permission(ARRAY['admin.notifications.read', 'admin.config.edit'], NULL, p_hub) THEN
    RAISE EXCEPTION 'delivery counts are staff information' USING ERRCODE = 'insufficient_privilege', HINT = 'admin.forbidden';
  END IF;
  -- E-mail takes the MAIL-001 state of its mail delivery (pending and sending are still queued).
  RETURN QUERY SELECT d.channel, CASE WHEN d.channel = 'email' AND md.id IS NOT NULL THEN
      CASE md.state WHEN 'sent' THEN 'sent' WHEN 'suppressed' THEN 'suppressed' WHEN 'pending' THEN 'queued' WHEN 'sending' THEN 'queued' ELSE 'failed' END
    ELSE d.state END, count(*)::int
    FROM trustwork.delivery d LEFT JOIN trustwork.mail_delivery md ON md.id = d.mail_delivery_id
    GROUP BY 1, 2 ORDER BY 1, 2;
END $$;

-- 7. Row-level security -------------------------------------------------------------------------------------------------
ALTER TABLE trustwork.context_thread ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.context_thread FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.message ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.message FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.message_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.message_link FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.reply_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.reply_token FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.channel_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.channel_grant FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.send_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.send_receipt FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.notification FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.notification_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.notification_preference FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.message_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.message_template FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.template_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.template_version FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.delivery FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.sender_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.sender_identity FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.context_thread AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.message AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.message_link AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.reply_token AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.channel_grant AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.send_receipt AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.notification AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.notification_preference AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.message_template AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.template_version AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.delivery AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.sender_identity AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

-- Threads: parties of the context (narrowed to the counterparty for RFQs and task requests); nobody else.
CREATE POLICY context_thread_read ON trustwork.context_thread FOR SELECT TO trustwork_app
  USING (trustwork.comms_thread_readable(context_kind, context_id, counterparty_person_id, counterparty_company_id));
CREATE POLICY context_thread_insert ON trustwork.context_thread FOR INSERT TO trustwork_app
  WITH CHECK (opened_by_person_id = trustwork.current_person_id() AND trustwork.comms_can_open(context_kind, context_id, counterparty_person_id, counterparty_company_id));
-- Messages: readable with their thread; written by the author into an open thread they may read.
CREATE POLICY message_read ON trustwork.message FOR SELECT TO trustwork_app
  USING (EXISTS (SELECT 1 FROM trustwork.context_thread t WHERE t.id = thread_id));
CREATE POLICY message_insert ON trustwork.message FOR INSERT TO trustwork_app
  WITH CHECK (author_person_id = trustwork.current_person_id() AND author_kind IN ('person', 'agent') AND direction IN ('internal', 'inbound')
              AND trustwork.comms_can_post(thread_id, on_behalf_person_id, on_behalf_company_id));
CREATE POLICY message_link_read ON trustwork.message_link FOR SELECT TO trustwork_app
  USING (EXISTS (SELECT 1 FROM trustwork.message m WHERE m.id = message_id));
CREATE POLICY message_link_insert ON trustwork.message_link FOR INSERT TO trustwork_app
  WITH CHECK (EXISTS (SELECT 1 FROM trustwork.message m WHERE m.id = message_id AND m.author_person_id = trustwork.current_person_id()));
CREATE POLICY send_receipt_read ON trustwork.send_receipt FOR SELECT TO trustwork_app
  USING (message_id IS NOT NULL AND EXISTS (SELECT 1 FROM trustwork.message m WHERE m.id = message_id));
-- Channel grants: the person only.
CREATE POLICY channel_grant_read ON trustwork.channel_grant FOR SELECT TO trustwork_app USING (person_id = trustwork.current_person_id());
CREATE POLICY channel_grant_insert ON trustwork.channel_grant FOR INSERT TO trustwork_app WITH CHECK (person_id = trustwork.current_person_id());
CREATE POLICY channel_grant_update ON trustwork.channel_grant FOR UPDATE TO trustwork_app USING (person_id = trustwork.current_person_id()) WITH CHECK (person_id = trustwork.current_person_id());
-- Notifications: the recipient only, and only while the recipient is still a party of the linked context (checked
-- again on every read: derived signals inherit the current rights of the source).
CREATE POLICY notification_read ON trustwork.notification FOR SELECT TO trustwork_app
  USING (recipient_person_id = trustwork.current_person_id()
         AND (link_kind IS NULL
              OR (link_thread_id IS NOT NULL AND trustwork.comms_thread_id_readable(link_thread_id))
              OR (link_thread_id IS NULL AND trustwork.comms_my_side(link_kind, link_id) IS NOT NULL)));
CREATE POLICY notification_update ON trustwork.notification FOR UPDATE TO trustwork_app
  USING (recipient_person_id = trustwork.current_person_id()) WITH CHECK (recipient_person_id = trustwork.current_person_id());
CREATE POLICY notification_preference_read ON trustwork.notification_preference FOR SELECT TO trustwork_app USING (person_id = trustwork.current_person_id());
CREATE POLICY notification_preference_insert ON trustwork.notification_preference FOR INSERT TO trustwork_app WITH CHECK (person_id = trustwork.current_person_id());
CREATE POLICY notification_preference_update ON trustwork.notification_preference FOR UPDATE TO trustwork_app
  USING (person_id = trustwork.current_person_id()) WITH CHECK (person_id = trustwork.current_person_id());
-- reply_token, delivery, message_template, template_version and sender_identity: no runtime policy (definers only).

-- 8. Grants -------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT (context_kind, context_id, counterparty_person_id, counterparty_company_id, subject, opened_by_person_id) ON trustwork.context_thread TO trustwork_app;
GRANT SELECT, INSERT (thread_id, direction, author_kind, author_person_id, on_behalf_person_id, on_behalf_company_id, mandate_id, body, attachments, source_time, provider,
  provider_message_id, channel_grant_id, sender_claim, untrusted) ON trustwork.message TO trustwork_app;
GRANT SELECT, INSERT (message_id, object_kind, object_id, version_id) ON trustwork.message_link TO trustwork_app;
GRANT SELECT ON trustwork.send_receipt TO trustwork_app;
GRANT SELECT, INSERT (person_id, provider, account_ref, account_display, scopes), UPDATE (status) ON trustwork.channel_grant TO trustwork_app;
GRANT SELECT, UPDATE (read_at, dismissed_at) ON trustwork.notification TO trustwork_app;
GRANT SELECT, INSERT (person_id, category, channel, frequency), UPDATE (frequency, updated_at) ON trustwork.notification_preference TO trustwork_app;

-- Pure vocabulary helpers used by CHECK constraints (evaluated with the inserting role's privileges).
GRANT EXECUTE ON FUNCTION trustwork.comms_context_kinds(), trustwork.comms_template_params(text), trustwork.comms_template_category(text), trustwork.comms_template_transactional(text),
  trustwork.comms_params_allowed(text, jsonb), trustwork.comms_scopes_valid(jsonb) TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.comms_my_side(text, uuid), trustwork.comms_thread_readable(text, uuid, uuid, uuid), trustwork.comms_thread_id_readable(uuid),
  trustwork.comms_can_open(text, uuid, uuid, uuid), trustwork.comms_can_post(uuid, uuid, uuid), trustwork.comms_thread_people(uuid),
  trustwork.comms_fanout_message(uuid, text), trustwork.comms_notify(uuid, text, jsonb, text, uuid, text), trustwork.comms_enqueue_mail(uuid, text, text, text, text),
  trustwork.comms_settle_delivery(uuid, text, text, text), trustwork.comms_issue_reply_token(uuid, text, timestamptz), trustwork.comms_resolve_reply_token(text),
  trustwork.comms_mail_unsubscribe(), trustwork.comms_mail_suppression(), trustwork.comms_template_staff(uuid),
  trustwork.comms_template_draft(uuid, text, integer, text, text, text), trustwork.comms_template_activate(uuid, text, integer, text[], text),
  trustwork.comms_template_versions(uuid, text), trustwork.comms_active_template(uuid, text), trustwork.comms_delivery_counts(uuid)
  TO trustwork_app;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
