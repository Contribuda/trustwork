-- MAIL-001: transactional mail through the outbox. The API records a mail_delivery row and a `mail.requested`
-- outbox event in the transaction of the identity change; the worker renders the localized template, sends it through
-- the configured transport and records the outcome here. Bounce and complaint receipts land in inbox_receipt and a
-- hard bounce or complaint adds the address hash to suppression_entry.
--
-- Data minimisation: the outbox payload carries the delivery id only. The recipient address and the sealed one-time
-- secret (AES-256-GCM under a key that lives outside the database, see packages/data/src/repositories/mail.ts) stay in
-- mail_delivery until the delivery reaches a final state; then the worker clears both. The API may only insert rows
-- (no SELECT); the worker reads them and updates the state columns. Neither role may delete.

CREATE TABLE trustwork.mail_delivery (
  id uuid PRIMARY KEY,
  -- Insertion order for operators and tests (several rows of one transaction share created_at).
  seq bigint GENERATED ALWAYS AS IDENTITY,
  template text NOT NULL CHECK (template IN ('verify_email', 'already_registered', 'recovery', 'email_change', 'membership_invitation', 'security_notice')),
  -- Language preferences of the request that caused the mail (sanitised Accept-Language, best first); empty when
  -- someone else caused it (the worker then uses the hub default language).
  locale_preferences text[] NOT NULL DEFAULT '{}' CHECK (cardinality(locale_preferences) <= 6),
  recipient text NULL CHECK (recipient IS NULL OR length(recipient) BETWEEN 3 AND 320),
  recipient_hash text NOT NULL CHECK (recipient_hash ~ '^[a-f0-9]{64}$'),
  -- Non-secret template parameters only (expiry durations, ids, public names). Never a token.
  params jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(params) = 'object' AND pg_column_size(params) <= 4096),
  sealed_secret bytea NULL CHECK (sealed_secret IS NULL OR length(sealed_secret) <= 512),
  secret_expires_at timestamptz NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'sent', 'suppressed', 'rate_limited', 'expired', 'failed')),
  job_id uuid NULL,
  attempt_ref text NULL CHECK (attempt_ref IS NULL OR length(attempt_ref) <= 128),
  claimed_at timestamptz NULL,
  sent_at timestamptz NULL,
  provider_message_id text NULL CHECK (provider_message_id IS NULL OR length(provider_message_id) <= 200),
  feedback text NULL CHECK (feedback IS NULL OR feedback IN ('delivered', 'soft_bounce', 'hard_bounce', 'complaint')),
  feedback_at timestamptz NULL,
  last_error text NULL CHECK (last_error IS NULL OR length(last_error) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_delivery_secret_expiry CHECK (sealed_secret IS NULL OR secret_expires_at IS NOT NULL),
  CONSTRAINT mail_delivery_final_minimised CHECK (state IN ('pending', 'sending') OR (recipient IS NULL AND sealed_secret IS NULL))
);
-- Per-recipient and global send rate windows count claims (sending or sent).
CREATE INDEX mail_delivery_recipient_claim_idx ON trustwork.mail_delivery (recipient_hash, claimed_at) WHERE claimed_at IS NOT NULL;
CREATE INDEX mail_delivery_claim_idx ON trustwork.mail_delivery (claimed_at) WHERE claimed_at IS NOT NULL;
CREATE INDEX mail_delivery_open_idx ON trustwork.mail_delivery (state, created_at) WHERE state IN ('pending', 'sending');

-- Addresses that must not receive mail: hard bounces and complaints (transport feedback), later unsubscribe and legal
-- entries (COMMS-001). Keyed by the address hash, never the address. Entries are removed by operations only.
CREATE TABLE trustwork.suppression_entry (
  address_hash text PRIMARY KEY CHECK (address_hash ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK (reason IN ('bounce', 'complaint', 'unsubscribe', 'legal')),
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 100),
  delivery_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- API role: records intents only.
GRANT INSERT (id, template, locale_preferences, recipient, recipient_hash, params, sealed_secret, secret_expires_at) ON trustwork.mail_delivery TO trustwork_app;

-- Worker role: reads deliveries, moves their state and clears personal data; reads and adds suppression entries.
GRANT SELECT, UPDATE (state, recipient, sealed_secret, job_id, attempt_ref, claimed_at, sent_at, provider_message_id, feedback, feedback_at, last_error, updated_at) ON trustwork.mail_delivery TO trustwork_worker;
GRANT SELECT, INSERT ON trustwork.suppression_entry TO trustwork_worker;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
