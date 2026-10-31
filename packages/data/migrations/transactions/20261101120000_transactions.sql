-- COM-002 commerce slice 2: quotes with immutable sent versions pinned to the current published RFQ version, their
-- frozen line projection and tax determinations, the seller-private constraint, negotiation rounds and amendment
-- requests, agreements with `terms_kind` (ADR 012 decision 19), the two private agreement halves, acceptance events,
-- orders, order changes and obligations.
--
-- Mirrors packages/contracts/src/sales.ts, transactions.ts and deals.ts. Every table is under FORCE RLS. The seller side
-- of a quote is the seller person or members of the seller company holding company.deals.manage; the buyer side is the
-- RFQ owner side (`trustwork.rfq_can`). Either side of an agreement or order reads the shared record; each private half
-- is readable only by its own side. Nothing is ever deleted; terms never change once sent or agreed.
--
-- Also here (reviewed with COM-001's integrator decision): publishing and closing a company RFQ needs only
-- company.deals.manage; the public projection still needs company.publish (`rfq_can(..., 'publish_projection')`).
-- RFQ amendments and closing now flag quote versions and quotes stale in the same transaction.
--
-- Money: orders record instructions and a transaction-budget reservation (authority, not funds); Trustwork never holds
-- participants' money (ADR 010 decision 20). Payment never reaches anything here: no table, function or ordering of
-- this module reads a billing table (tests/billing/policy.test.ts); budget and reservation ids are opaque references
-- that the API obtains from `trustwork.billing_reserve` in the same transaction as the order.

-- 0. RFQ authority (replaces COM-001 definitions) ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trustwork.rfq_can(p_rfq_id uuid, p_capability text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL
    AND p_capability IN ('read.party_private', 'write.draft', 'publish', 'invite', 'negotiate', 'accept', 'commit_order', 'publish_projection')
    AND (
      EXISTS (
        SELECT 1 FROM trustwork.rfq r
        WHERE r.id = p_rfq_id
          AND trustwork.commerce_party_acts(r.owner_person_id, r.owner_company_id, CASE WHEN p_capability = 'publish_projection' THEN 'company.publish' ELSE 'company.deals.manage' END)
      )
      OR EXISTS (
        SELECT 1 FROM trustwork.object_participation op
        WHERE op.resource_kind = 'rfq' AND op.resource_id = p_rfq_id
          AND op.side <> 'staff' AND op.audience IN ('party_private', 'owner_private')
          AND op.revoked_at IS NULL AND op.valid_from <= now() AND (op.valid_until IS NULL OR op.valid_until > now())
          AND (CASE WHEN p_capability = 'publish_projection' THEN 'publish' ELSE p_capability END) = ANY (op.capabilities)
          AND trustwork.commerce_party_acts(op.party_person_id, op.party_company_id, CASE WHEN p_capability = 'publish_projection' THEN 'company.publish' ELSE 'company.deals.manage' END)
      )
    )
$$;

-- Same as COM-001 except that the public projection needs `publish_projection` (company.publish) while publishing and
-- closing need `publish` (company.deals.manage).
CREATE OR REPLACE FUNCTION trustwork.rfq_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RFQs are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.creator_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
      RAISE EXCEPTION 'the creator is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    IF NEW.status <> 'draft' OR NEW.current_version_id IS NOT NULL THEN
      RAISE EXCEPTION 'an RFQ starts as a draft' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    IF NEW.project_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM trustwork.project p WHERE p.id = NEW.project_id AND p.owner_person_id IS NOT DISTINCT FROM NEW.owner_person_id AND p.owner_company_id IS NOT DISTINCT FROM NEW.owner_company_id
    ) THEN
      RAISE EXCEPTION 'an RFQ belongs to a project of the same owner' USING ERRCODE = 'check_violation', HINT = 'commerce.project_mismatch';
    END IF;
    IF NEW.need_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM trustwork.need n WHERE n.id = NEW.need_id AND n.status = 'ready' AND n.owner_person_id IS NOT DISTINCT FROM NEW.owner_person_id AND n.owner_company_id IS NOT DISTINCT FROM NEW.owner_company_id
    ) THEN
      RAISE EXCEPTION 'an RFQ is drafted from a ready need of the same owner' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    IF NEW.plan_project_id IS NOT NULL AND (NEW.owner_person_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM trustwork.project p WHERE p.id = NEW.plan_project_id AND p.owner_person_id = NEW.owner_person_id
    )) THEN
      RAISE EXCEPTION 'a plan item becomes an RFQ of its own person owner' USING ERRCODE = 'check_violation', HINT = 'commerce.plan_item_path';
    END IF;
    IF NEW.public_projection_enabled AND NOT trustwork.commerce_party_acts(NEW.owner_person_id, NEW.owner_company_id, 'company.publish') THEN
      RAISE EXCEPTION 'a public projection needs publish authority' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.owner_person_id IS DISTINCT FROM OLD.owner_person_id OR NEW.owner_company_id IS DISTINCT FROM OLD.owner_company_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.creator_person_id <> OLD.creator_person_id OR NEW.need_id IS DISTINCT FROM OLD.need_id
     OR NEW.plan_project_id IS DISTINCT FROM OLD.plan_project_id OR NEW.plan_item_key IS DISTINCT FROM OLD.plan_item_key OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'RFQ identity is immutable' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF OLD.status IN ('closed', 'cancelled', 'expired') THEN
    RAISE EXCEPTION 'a % RFQ is kept as it was', OLD.status USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT ((OLD.status = 'draft' AND NEW.status IN ('published', 'cancelled')) OR (OLD.status = 'published' AND NEW.status IN ('closed', 'cancelled', 'expired'))) THEN
      RAISE EXCEPTION 'RFQ transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    IF NOT trustwork.rfq_can(NEW.id, 'publish') THEN
      RAISE EXCEPTION 'publishing and closing need publish authority' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    IF NEW.closed_by_person_id IS DISTINCT FROM (CASE WHEN NEW.status IN ('closed', 'cancelled') THEN trustwork.current_person_id() END) THEN
      RAISE EXCEPTION 'the closer is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
  ELSIF NEW.closed_at IS DISTINCT FROM OLD.closed_at OR NEW.closed_by_person_id IS DISTINCT FROM OLD.closed_by_person_id OR NEW.closed_reason IS DISTINCT FROM OLD.closed_reason THEN
    RAISE EXCEPTION 'closing facts change only with the status' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN
    IF NEW.current_version_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM trustwork.rfq_version v WHERE v.id = NEW.current_version_id AND v.rfq_id = NEW.id AND v.status = 'published' AND v.version = NEW.current_version
    ) OR (OLD.current_version IS NOT NULL AND NEW.current_version <= OLD.current_version) OR NOT trustwork.rfq_can(NEW.id, 'publish') THEN
      RAISE EXCEPTION 'the current version is the latest published version' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
    END IF;
  ELSIF NEW.current_version IS DISTINCT FROM OLD.current_version THEN
    RAISE EXCEPTION 'current version number and id move together' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF (NEW.public_projection_enabled IS DISTINCT FROM OLD.public_projection_enabled OR NEW.public_projection_fields IS DISTINCT FROM OLD.public_projection_fields OR NEW.category IS DISTINCT FROM OLD.category)
     AND NOT trustwork.rfq_can(NEW.id, 'publish_projection') THEN
    RAISE EXCEPTION 'the public projection needs publish authority' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
  END IF;
  RETURN NEW;
END $$;

-- 1. Quotes -----------------------------------------------------------------------------------------------------------
-- One quote per (RFQ, seller); its versions are the negotiation. Buyer columns are copied from the RFQ by the guard.
CREATE TABLE trustwork.quote (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  rfq_id uuid NOT NULL REFERENCES trustwork.rfq (id),
  seller_person_id uuid NULL REFERENCES trustwork.person (id),
  seller_company_id uuid NULL REFERENCES trustwork.company (id),
  buyer_person_id uuid NULL REFERENCES trustwork.person (id),
  buyer_company_id uuid NULL REFERENCES trustwork.company (id),
  invitation_id uuid NULL REFERENCES trustwork.rfq_invitation (id),
  creator_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'superseded', 'withdrawn', 'expired', 'accepted')),
  stale_reason text NULL CHECK (stale_reason IN ('rfq_amended', 'rfq_closed')),
  stale_at timestamptz NULL,
  current_version integer NULL CHECK (current_version >= 1),
  current_version_id uuid NULL,
  withdrawn_reason text NULL CHECK (length(withdrawn_reason) BETWEEN 1 AND 500),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quote_seller_xor CHECK ((seller_person_id IS NULL) <> (seller_company_id IS NULL)),
  CONSTRAINT quote_buyer_xor CHECK ((buyer_person_id IS NULL) <> (buyer_company_id IS NULL)),
  CONSTRAINT quote_current_pair CHECK ((current_version IS NULL) = (current_version_id IS NULL)),
  CONSTRAINT quote_sent_has_version CHECK ((status = 'draft') = (current_version_id IS NULL)),
  CONSTRAINT quote_stale_pair CHECK ((stale_reason IS NULL) = (stale_at IS NULL)),
  CONSTRAINT quote_withdrawn CHECK ((status = 'withdrawn') = (withdrawn_reason IS NOT NULL))
);
CREATE UNIQUE INDEX quote_one_per_seller_person ON trustwork.quote (rfq_id, seller_person_id) WHERE seller_person_id IS NOT NULL;
CREATE UNIQUE INDEX quote_one_per_seller_company ON trustwork.quote (rfq_id, seller_company_id) WHERE seller_company_id IS NOT NULL;
CREATE INDEX quote_seller_person_idx ON trustwork.quote (seller_person_id) WHERE seller_person_id IS NOT NULL;
CREATE INDEX quote_seller_company_idx ON trustwork.quote (seller_company_id) WHERE seller_company_id IS NOT NULL;
CREATE TRIGGER quote_touch BEFORE UPDATE ON trustwork.quote FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- payload: QuoteVersionPayload. digest: trustwork-digest-1 over { rfqVersion, payload }, computed by the server at send.
CREATE TABLE trustwork.quote_version (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  quote_id uuid NOT NULL REFERENCES trustwork.quote (id),
  version integer NOT NULL CHECK (version >= 1),
  rfq_id uuid NOT NULL,
  rfq_version_id uuid NOT NULL,
  rfq_version integer NOT NULL CHECK (rfq_version >= 1),
  rfq_version_digest text NOT NULL CHECK (rfq_version_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'superseded', 'withdrawn', 'expired', 'accepted')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND jsonb_typeof(payload -> 'lines') = 'array'),
  digest text NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  drafted_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  sent_at timestamptz NULL,
  sent_by_person_id uuid NULL REFERENCES trustwork.person (id),
  sent_via text NULL CHECK (sent_via IN ('person', 'agent')),
  sent_by_mandate_id text NULL CHECK (sent_by_mandate_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  valid_until timestamptz NULL,
  stale_reason text NULL CHECK (stale_reason IN ('rfq_amended', 'rfq_closed')),
  stale_at timestamptz NULL,
  revalidated_from integer NULL CHECK (revalidated_from >= 1),
  answers_amendment_request_id uuid NULL,
  superseded_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quote_version_number UNIQUE (quote_id, version),
  CONSTRAINT quote_version_id_quote UNIQUE (id, quote_id),
  CONSTRAINT quote_version_rfq_version FOREIGN KEY (rfq_version_id, rfq_id) REFERENCES trustwork.rfq_version (id, rfq_id),
  CONSTRAINT quote_version_sent_shape CHECK (
    (status = 'draft') = (sent_at IS NULL) AND (sent_at IS NULL) = (digest IS NULL) AND (sent_at IS NULL) = (sent_by_person_id IS NULL)
    AND (sent_at IS NULL) = (sent_via IS NULL) AND (sent_at IS NULL) = (valid_until IS NULL) AND ((sent_via = 'agent') = (sent_by_mandate_id IS NOT NULL))
  ),
  CONSTRAINT quote_version_stale_pair CHECK ((stale_reason IS NULL) = (stale_at IS NULL)),
  CONSTRAINT quote_version_superseded CHECK ((status = 'superseded') = (superseded_at IS NOT NULL)),
  CONSTRAINT quote_version_revalidated CHECK (revalidated_from IS NULL OR revalidated_from < version)
);
CREATE UNIQUE INDEX quote_version_one_draft ON trustwork.quote_version (quote_id) WHERE status = 'draft';
CREATE UNIQUE INDEX quote_version_one_sent ON trustwork.quote_version (quote_id) WHERE status = 'sent';
CREATE INDEX quote_version_rfq_idx ON trustwork.quote_version (rfq_id, rfq_version_id);
CREATE TRIGGER quote_version_touch BEFORE UPDATE ON trustwork.quote_version FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
-- Model invariant 2: once sent, the payload, digest, RFQ pin, validity and sending facts never change, for every role.
CREATE TRIGGER quote_version_frozen BEFORE UPDATE ON trustwork.quote_version FOR EACH ROW
  EXECUTE FUNCTION trustwork.reject_update_when_frozen('status', 'draft', 'payload', 'digest', 'rfq_id', 'rfq_version_id', 'rfq_version', 'rfq_version_digest', 'valid_until', 'sent_at',
    'sent_by_person_id', 'sent_via', 'sent_by_mandate_id', 'revalidated_from', 'answers_amendment_request_id');
ALTER TABLE trustwork.quote ADD CONSTRAINT quote_current_version FOREIGN KEY (current_version_id, id) REFERENCES trustwork.quote_version (id, quote_id);

-- Tax is never a hard-coded rate (model 1.5): each sent line names how its tax was determined. In this slice the
-- determination is the seller's stated tax term (`seller_stated`), labelled as such; pack and adapter determinations
-- (INTL-US sales tax adapters) use the same row.
CREATE TABLE trustwork.tax_determination (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  quote_id uuid NOT NULL,
  quote_version_id uuid NOT NULL,
  line_id text NOT NULL CHECK (line_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  jurisdiction text NULL CHECK (length(jurisdiction) BETWEEN 1 AND 100),
  rule_ref text NOT NULL CHECK (length(rule_ref) BETWEEN 1 AND 200),
  rate text NULL CHECK (rate ~ '^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$'),
  included boolean NOT NULL,
  taxability text NOT NULL CHECK (taxability IN ('taxable', 'exempt', 'reverse_charge', 'not_applicable')),
  exemption_ref text NULL CHECK (length(exemption_ref) BETWEEN 1 AND 200),
  provider text NOT NULL CHECK (provider IN ('pack', 'adapter', 'seller_stated')),
  determined_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  determined_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tax_determination_one_per_line UNIQUE (quote_version_id, line_id),
  CONSTRAINT tax_determination_version FOREIGN KEY (quote_version_id, quote_id) REFERENCES trustwork.quote_version (id, quote_id)
);

-- A frozen projection of the payload lines written at send (the payload stays authoritative).
CREATE TABLE trustwork.quote_line (
  quote_version_id uuid NOT NULL,
  quote_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  line_id text NOT NULL CHECK (line_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  rfq_line_id text NULL CHECK (rfq_line_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  kind text NOT NULL CHECK (kind IN ('goods', 'works', 'services')),
  spec_snapshot jsonb NOT NULL CHECK (jsonb_typeof(spec_snapshot) = 'object'),
  offering_ref text NULL CHECK (offering_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  offering_version integer NULL CHECK (offering_version >= 1),
  quantity_value text NOT NULL CHECK (quantity_value ~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,6})?$'),
  quantity_unit text NOT NULL REFERENCES trustwork.unit (code),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  unit_price_minor bigint NOT NULL,
  tax_determination_id uuid NOT NULL REFERENCES trustwork.tax_determination (id),
  tax_amount_minor bigint NOT NULL,
  line_total_minor bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (quote_version_id, line_id),
  CONSTRAINT quote_line_version FOREIGN KEY (quote_version_id, quote_id) REFERENCES trustwork.quote_version (id, quote_id),
  CONSTRAINT quote_line_position UNIQUE (quote_version_id, position),
  CONSTRAINT quote_line_offering_pair CHECK ((offering_ref IS NULL) = (offering_version IS NULL))
);

-- Seller party_private: floors, margins, cost basis and negotiation notes; never in any buyer, shared or public read.
CREATE TABLE trustwork.quote_private_constraint (
  quote_id uuid PRIMARY KEY REFERENCES trustwork.quote (id),
  owner_person_id uuid NULL REFERENCES trustwork.person (id),
  owner_company_id uuid NULL REFERENCES trustwork.company (id),
  floor_prices jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(floor_prices) = 'object'),
  margin_targets jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(margin_targets) = 'object'),
  cost_basis jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(cost_basis) = 'object'),
  negotiation_notes text NOT NULL DEFAULT '' CHECK (length(negotiation_notes) <= 20000),
  updated_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quote_private_owner_xor CHECK ((owner_person_id IS NULL) <> (owner_company_id IS NULL))
);
CREATE TRIGGER quote_private_constraint_touch BEFORE UPDATE ON trustwork.quote_private_constraint FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- 2. Negotiation ------------------------------------------------------------------------------------------------------
-- The buyer asks for structured changes on exact lines of an exact sent version; the answer is a new quote version.
CREATE TABLE trustwork.amendment_request (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  quote_id uuid NOT NULL REFERENCES trustwork.quote (id),
  quote_version_id uuid NOT NULL,
  requester_person_id uuid NULL REFERENCES trustwork.person (id),
  requester_company_id uuid NULL REFERENCES trustwork.company (id),
  requested_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  requested_via text NOT NULL CHECK (requested_via IN ('person', 'agent')),
  requested_mandate_id text NULL CHECK (requested_mandate_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  line_refs text[] NOT NULL CHECK (cardinality(line_refs) BETWEEN 1 AND 200),
  changes jsonb NOT NULL CHECK (jsonb_typeof(changes) = 'array'),
  target_total_minor bigint NULL,
  target_total_currency text NULL CHECK (target_total_currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'withdrawn')),
  answered_by_version_id uuid NULL REFERENCES trustwork.quote_version (id),
  withdrawn_reason text NULL CHECK (length(withdrawn_reason) BETWEEN 1 AND 500),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT amendment_request_version FOREIGN KEY (quote_version_id, quote_id) REFERENCES trustwork.quote_version (id, quote_id),
  CONSTRAINT amendment_request_requester_xor CHECK ((requester_person_id IS NULL) <> (requester_company_id IS NULL)),
  CONSTRAINT amendment_request_mandate CHECK ((requested_via = 'agent') = (requested_mandate_id IS NOT NULL)),
  CONSTRAINT amendment_request_target_pair CHECK ((target_total_minor IS NULL) = (target_total_currency IS NULL)),
  CONSTRAINT amendment_request_answered CHECK ((status = 'answered') = (answered_by_version_id IS NOT NULL)),
  CONSTRAINT amendment_request_withdrawn CHECK ((status = 'withdrawn') = (withdrawn_reason IS NOT NULL))
);
CREATE UNIQUE INDEX amendment_request_one_open ON trustwork.amendment_request (quote_id) WHERE status = 'open';
CREATE TRIGGER amendment_request_touch BEFORE UPDATE ON trustwork.amendment_request FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
ALTER TABLE trustwork.quote_version ADD CONSTRAINT quote_version_answers FOREIGN KEY (answers_amendment_request_id) REFERENCES trustwork.amendment_request (id);

-- Every proposal is a structured version or request, numbered per quote; never chat prose.
CREATE TABLE trustwork.negotiation_round (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  rfq_id uuid NOT NULL REFERENCES trustwork.rfq (id),
  quote_id uuid NOT NULL REFERENCES trustwork.quote (id),
  round_no integer NOT NULL CHECK (round_no >= 1),
  proposal_kind text NOT NULL CHECK (proposal_kind IN ('quote_version', 'amendment_request')),
  proposal_id uuid NOT NULL,
  proposer_person_id uuid NULL REFERENCES trustwork.person (id),
  proposer_company_id uuid NULL REFERENCES trustwork.company (id),
  proposed_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  proposed_via text NOT NULL CHECK (proposed_via IN ('person', 'agent')),
  proposed_mandate_id text NULL CHECK (proposed_mandate_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT negotiation_round_number UNIQUE (quote_id, round_no),
  CONSTRAINT negotiation_round_proposal UNIQUE (proposal_kind, proposal_id),
  CONSTRAINT negotiation_round_proposer_xor CHECK ((proposer_person_id IS NULL) <> (proposer_company_id IS NULL)),
  CONSTRAINT negotiation_round_mandate CHECK ((proposed_via = 'agent') = (proposed_mandate_id IS NOT NULL))
);

-- 3. Agreements -------------------------------------------------------------------------------------------------------
-- terms_kind (ADR 012 decision 19): `rfq_quote` pins quote_version_id + rfq_version_id; `task` and `consultation` pin
-- offer_ref_id + request_ref_id, whose foreign keys and checks arrive with TASK-001 and CONS-001. The pinned versions
-- and digests are copied for every kind; accepted_terms_digest = trustwork-digest-1 over { termsKind, quoteVersion,
-- rfqVersion } is computed once by the server and checked against the stored rows at every acceptance.
CREATE TABLE trustwork.agreement (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  terms_kind text NOT NULL DEFAULT 'rfq_quote' CHECK (terms_kind IN ('rfq_quote', 'task', 'consultation')),
  buyer_person_id uuid NULL REFERENCES trustwork.person (id),
  buyer_company_id uuid NULL REFERENCES trustwork.company (id),
  seller_person_id uuid NULL REFERENCES trustwork.person (id),
  seller_company_id uuid NULL REFERENCES trustwork.company (id),
  rfq_id uuid NULL REFERENCES trustwork.rfq (id),
  quote_id uuid NULL REFERENCES trustwork.quote (id),
  quote_version_id uuid NULL,
  rfq_version_id uuid NULL,
  offer_ref_id uuid NULL,
  request_ref_id uuid NULL,
  offer_version integer NOT NULL CHECK (offer_version >= 1),
  offer_digest text NOT NULL CHECK (offer_digest ~ '^[a-f0-9]{64}$'),
  request_version integer NOT NULL CHECK (request_version >= 1),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  accepted_terms_digest text NOT NULL CHECK (accepted_terms_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted_by_buyer', 'accepted_by_both', 'declined', 'withdrawn', 'superseded')),
  supersedes_id uuid NULL REFERENCES trustwork.agreement (id),
  superseded_by uuid NULL,
  closed_reason text NULL CHECK (length(closed_reason) BETWEEN 1 AND 500),
  created_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agreement_buyer_xor CHECK ((buyer_person_id IS NULL) <> (buyer_company_id IS NULL)),
  CONSTRAINT agreement_seller_xor CHECK ((seller_person_id IS NULL) <> (seller_company_id IS NULL)),
  CONSTRAINT agreement_kind_refs CHECK (
    CASE terms_kind
      WHEN 'rfq_quote' THEN rfq_id IS NOT NULL AND quote_id IS NOT NULL AND quote_version_id IS NOT NULL AND rfq_version_id IS NOT NULL AND offer_ref_id IS NULL AND request_ref_id IS NULL
      ELSE quote_version_id IS NULL AND rfq_version_id IS NULL AND offer_ref_id IS NOT NULL AND request_ref_id IS NOT NULL
    END
  ),
  CONSTRAINT agreement_superseded CHECK ((status = 'superseded') = (superseded_by IS NOT NULL)),
  CONSTRAINT agreement_closed_reason CHECK ((status IN ('declined', 'withdrawn')) = (closed_reason IS NOT NULL)),
  CONSTRAINT agreement_quote_version FOREIGN KEY (quote_version_id, quote_id) REFERENCES trustwork.quote_version (id, quote_id),
  CONSTRAINT agreement_rfq_version FOREIGN KEY (rfq_version_id, rfq_id) REFERENCES trustwork.rfq_version (id, rfq_id),
  -- Deferred: an order change marks the old agreement superseded by the new id before the new row is inserted.
  CONSTRAINT agreement_superseded_by FOREIGN KEY (superseded_by) REFERENCES trustwork.agreement (id) DEFERRABLE INITIALLY DEFERRED
);
-- Exactly one live agreement per RFQ: two concurrent acceptances (of the same or of different quotes) cannot both commit.
CREATE UNIQUE INDEX agreement_one_live_per_rfq ON trustwork.agreement (rfq_id) WHERE terms_kind = 'rfq_quote' AND status IN ('proposed', 'accepted_by_buyer', 'accepted_by_both');
CREATE INDEX agreement_buyer_person_idx ON trustwork.agreement (buyer_person_id) WHERE buyer_person_id IS NOT NULL;
CREATE INDEX agreement_buyer_company_idx ON trustwork.agreement (buyer_company_id) WHERE buyer_company_id IS NOT NULL;
CREATE INDEX agreement_seller_person_idx ON trustwork.agreement (seller_person_id) WHERE seller_person_id IS NOT NULL;
CREATE INDEX agreement_seller_company_idx ON trustwork.agreement (seller_company_id) WHERE seller_company_id IS NOT NULL;
CREATE INDEX agreement_quote_idx ON trustwork.agreement (quote_id) WHERE quote_id IS NOT NULL;
CREATE TRIGGER agreement_touch BEFORE UPDATE ON trustwork.agreement FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- Buyer party_private: budget and approval references. Never readable by the seller.
CREATE TABLE trustwork.agreement_buyer_private (
  agreement_id uuid PRIMARY KEY REFERENCES trustwork.agreement (id),
  owner_person_id uuid NULL REFERENCES trustwork.person (id),
  owner_company_id uuid NULL REFERENCES trustwork.company (id),
  transaction_budget_id uuid NULL,
  approval_refs text[] NOT NULL DEFAULT '{}' CHECK (cardinality(approval_refs) <= 50),
  notes text NULL CHECK (length(notes) BETWEEN 1 AND 500),
  updated_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agreement_buyer_private_owner_xor CHECK ((owner_person_id IS NULL) <> (owner_company_id IS NULL))
);
CREATE TRIGGER agreement_buyer_private_touch BEFORE UPDATE ON trustwork.agreement_buyer_private FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- Seller party_private: fulfilment internals. Never readable by the buyer.
CREATE TABLE trustwork.agreement_seller_private (
  agreement_id uuid PRIMARY KEY REFERENCES trustwork.agreement (id),
  owner_person_id uuid NULL REFERENCES trustwork.person (id),
  owner_company_id uuid NULL REFERENCES trustwork.company (id),
  fulfilment_plan jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(fulfilment_plan) = 'array'),
  notes text NULL CHECK (length(notes) BETWEEN 1 AND 500),
  updated_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agreement_seller_private_owner_xor CHECK ((owner_person_id IS NULL) <> (owner_company_id IS NULL))
);
CREATE TRIGGER agreement_seller_private_touch BEFORE UPDATE ON trustwork.agreement_seller_private FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- Append-only. Buyer and seller acceptance are separate events; each repeats the agreement digest (checked here).
-- Electronic records: when the hub requires consent (ESIGN/UETA in the US pack), the event records the disclosure
-- consented to and its country-pack basis.
CREATE TABLE trustwork.acceptance_event (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  agreement_id uuid NOT NULL REFERENCES trustwork.agreement (id),
  kind text NOT NULL CHECK (kind IN ('buyer_selects', 'buyer_accepts_terms', 'seller_accepts_order', 'seller_declines', 'withdrawn')),
  terms_kind text NOT NULL CHECK (terms_kind IN ('rfq_quote', 'task', 'consultation')),
  quote_version_id uuid NULL,
  rfq_version_id uuid NULL,
  offer_version integer NOT NULL,
  offer_digest text NOT NULL CHECK (offer_digest ~ '^[a-f0-9]{64}$'),
  request_version integer NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  accepted_terms_digest text NOT NULL CHECK (accepted_terms_digest ~ '^[a-f0-9]{64}$'),
  actor_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  on_behalf_person_id uuid NULL REFERENCES trustwork.person (id),
  on_behalf_company_id uuid NULL REFERENCES trustwork.company (id),
  via text NOT NULL CHECK (via IN ('person', 'agent')),
  mandate_id text NULL CHECK (mandate_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  transaction_budget_id uuid NULL,
  reservation_id uuid NULL,
  platform_budget_id uuid NULL,
  e_records_required boolean NOT NULL,
  e_records_disclosure_key text NULL CHECK (e_records_disclosure_key ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  e_records_basis text[] NOT NULL DEFAULT '{}' CHECK (cardinality(e_records_basis) <= 20),
  e_records_consented_at timestamptz NULL,
  reason text NULL CHECK (length(reason) BETWEEN 1 AND 500),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,200}$'),
  CONSTRAINT acceptance_event_once UNIQUE (agreement_id, kind),
  CONSTRAINT acceptance_event_behalf_xor CHECK ((on_behalf_person_id IS NULL) <> (on_behalf_company_id IS NULL)),
  CONSTRAINT acceptance_event_mandate CHECK ((via = 'agent') = (mandate_id IS NOT NULL)),
  CONSTRAINT acceptance_event_consent_pair CHECK ((e_records_disclosure_key IS NULL) = (e_records_consented_at IS NULL)),
  CONSTRAINT acceptance_event_consent_required CHECK (NOT e_records_required OR e_records_consented_at IS NOT NULL OR kind IN ('seller_declines', 'withdrawn'))
);
CREATE INDEX acceptance_event_agreement_idx ON trustwork.acceptance_event (agreement_id, occurred_at);
CREATE TRIGGER acceptance_event_append_only BEFORE UPDATE OR DELETE ON trustwork.acceptance_event FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 4. Orders ------------------------------------------------------------------------------------------------------------
-- The model's `order` (ORDER is a reserved word). An order is an instruction plus a transaction-budget reservation for
-- the gross total; it never moves money.
CREATE TABLE trustwork.commercial_order (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  agreement_id uuid NOT NULL REFERENCES trustwork.agreement (id),
  accepted_terms_digest text NOT NULL CHECK (accepted_terms_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'placed' CHECK (status IN ('placed', 'accepted', 'changed', 'cancelled', 'fulfilled')),
  context_kind text NOT NULL CHECK (context_kind IN ('project', 'rfq')),
  context_id uuid NOT NULL,
  external_reference text NULL CHECK (length(external_reference) BETWEEN 1 AND 200),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  transaction_budget_id uuid NOT NULL,
  reservation_id uuid NULL,
  platform_budget_id uuid NULL,
  placed_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  placed_via text NOT NULL CHECK (placed_via IN ('person', 'agent')),
  placed_mandate_id text NULL CHECK (placed_mandate_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  cancelled_reason text NULL CHECK (length(cancelled_reason) BETWEEN 1 AND 500),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commercial_order_reservation CHECK ((amount_minor = 0) = (reservation_id IS NULL)),
  CONSTRAINT commercial_order_mandate CHECK ((placed_via = 'agent') = (placed_mandate_id IS NOT NULL)),
  CONSTRAINT commercial_order_cancelled CHECK ((status = 'cancelled') = (cancelled_reason IS NOT NULL)),
  -- Nothing in this slice charges a platform budget (PlaceOrderCommand: nullable only when no platform charge occurs).
  CONSTRAINT commercial_order_no_platform_charge CHECK (platform_budget_id IS NULL)
);
CREATE UNIQUE INDEX commercial_order_one_live ON trustwork.commercial_order (agreement_id) WHERE status <> 'cancelled';
CREATE UNIQUE INDEX commercial_order_reservation_once ON trustwork.commercial_order (reservation_id) WHERE reservation_id IS NOT NULL;
CREATE TRIGGER commercial_order_touch BEFORE UPDATE ON trustwork.commercial_order FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- Changes append jointly accepted versions; history never mutates. Accepting a change supersedes the agreement with a
-- new one pinned to the newer quote version, and moves the order to it.
CREATE TABLE trustwork.order_change (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  order_id uuid NOT NULL REFERENCES trustwork.commercial_order (id),
  previous_agreement_id uuid NOT NULL REFERENCES trustwork.agreement (id),
  previous_terms_digest text NOT NULL CHECK (previous_terms_digest ~ '^[a-f0-9]{64}$'),
  new_quote_version_id uuid NOT NULL REFERENCES trustwork.quote_version (id),
  new_rfq_version_id uuid NOT NULL REFERENCES trustwork.rfq_version (id),
  new_terms_digest text NOT NULL CHECK (new_terms_digest ~ '^[a-f0-9]{64}$'),
  new_agreement_id uuid NULL REFERENCES trustwork.agreement (id),
  proposer_person_id uuid NULL REFERENCES trustwork.person (id),
  proposer_company_id uuid NULL REFERENCES trustwork.company (id),
  proposed_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  proposed_via text NOT NULL CHECK (proposed_via IN ('person', 'agent')),
  proposed_mandate_id text NULL CHECK (proposed_mandate_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'rejected', 'withdrawn')),
  consents jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(consents) = 'array'),
  delta_reservation_id uuid NULL,
  decided_by_person_id uuid NULL REFERENCES trustwork.person (id),
  decided_reason text NULL CHECK (length(decided_reason) BETWEEN 1 AND 500),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_change_proposer_xor CHECK ((proposer_person_id IS NULL) <> (proposer_company_id IS NULL)),
  CONSTRAINT order_change_mandate CHECK ((proposed_via = 'agent') = (proposed_mandate_id IS NOT NULL)),
  CONSTRAINT order_change_accepted CHECK ((status = 'accepted') = (new_agreement_id IS NOT NULL)),
  CONSTRAINT order_change_decided CHECK ((status = 'proposed') = (decided_by_person_id IS NULL))
);
CREATE UNIQUE INDEX order_change_one_open ON trustwork.order_change (order_id) WHERE status = 'proposed';
CREATE TRIGGER order_change_touch BEFORE UPDATE ON trustwork.order_change FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- Derived from accepted terms; changes only through order changes (waived when the agreement is superseded).
CREATE TABLE trustwork.obligation (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  agreement_id uuid NOT NULL REFERENCES trustwork.agreement (id),
  position integer NOT NULL CHECK (position >= 0),
  obligor_person_id uuid NULL REFERENCES trustwork.person (id),
  obligor_company_id uuid NULL REFERENCES trustwork.company (id),
  kind text NOT NULL CHECK (kind IN ('deliver', 'perform', 'pay', 'accept')),
  due timestamptz NULL,
  amount_minor bigint NULL,
  currency text NULL CHECK (currency ~ '^[A-Z]{3}$'),
  scope_value text NULL CHECK (scope_value ~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,6})?$'),
  scope_unit text NULL REFERENCES trustwork.unit (code),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fulfilled', 'partially', 'waived', 'disputed')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT obligation_position UNIQUE (agreement_id, position),
  CONSTRAINT obligation_obligor_xor CHECK ((obligor_person_id IS NULL) <> (obligor_company_id IS NULL)),
  CONSTRAINT obligation_amount_pair CHECK ((amount_minor IS NULL) = (currency IS NULL)),
  CONSTRAINT obligation_scope_pair CHECK ((scope_value IS NULL) = (scope_unit IS NULL))
);
CREATE TRIGGER obligation_touch BEFORE UPDATE ON trustwork.obligation FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- 5. Access helpers ---------------------------------------------------------------------------------------------------
-- Owner-run so that policies on versions, lines, requests and rounds can read the quote and the RFQ without recursion.
-- 'seller': the principal acts for the seller party; 'buyer': the principal is on the RFQ owner side; otherwise NULL.
CREATE FUNCTION trustwork.quote_side(p_quote_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT CASE
    WHEN trustwork.current_person_id() IS NULL THEN NULL
    WHEN trustwork.commerce_party_acts(q.seller_person_id, q.seller_company_id, 'company.deals.manage') THEN 'seller'
    WHEN trustwork.rfq_can(q.rfq_id, 'read.party_private') THEN 'buyer'
  END
  FROM trustwork.quote q WHERE q.id = p_quote_id
$$;

CREATE FUNCTION trustwork.agreement_side(p_agreement_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT CASE
    WHEN trustwork.current_person_id() IS NULL THEN NULL
    WHEN trustwork.commerce_party_acts(a.seller_person_id, a.seller_company_id, 'company.deals.manage') THEN 'seller'
    WHEN trustwork.commerce_party_acts(a.buyer_person_id, a.buyer_company_id, 'company.deals.manage') OR (a.rfq_id IS NOT NULL AND trustwork.rfq_can(a.rfq_id, 'read.party_private')) THEN 'buyer'
  END
  FROM trustwork.agreement a WHERE a.id = p_agreement_id
$$;

CREATE FUNCTION trustwork.order_side(p_order_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.agreement_side(o.agreement_id) FROM trustwork.commercial_order o WHERE o.id = p_order_id
$$;

-- Row locks taken by the guards on rows the acting side may read but not update (a seller locks the RFQ it answers,
-- a buyer locks the quote it accepts). Owner-run: they only lock and return the row the guard already may see.
CREATE FUNCTION trustwork.transactions_rfq_for_share(p_rfq_id uuid) RETURNS trustwork.rfq
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT * FROM trustwork.rfq WHERE id = p_rfq_id AND (trustwork.rfq_can(p_rfq_id, 'read.party_private') OR trustwork.rfq_invitee(p_rfq_id, NULL)) FOR SHARE
$$;
CREATE FUNCTION trustwork.transactions_quote_for_share(p_quote_id uuid) RETURNS trustwork.quote
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT * FROM trustwork.quote WHERE id = p_quote_id AND trustwork.quote_side(p_quote_id) IS NOT NULL FOR SHARE
$$;

-- Ownership helper extended to quotes (seller side), so a seller may materialise its owner participation row.
CREATE OR REPLACE FUNCTION trustwork.owns_resource(p_resource_kind text, p_resource_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND CASE p_resource_kind
    WHEN 'project' THEN EXISTS (
      SELECT 1 FROM trustwork.project p WHERE p.id = p_resource_id
        AND (p.owner_person_id = trustwork.current_person_id() OR (p.owner_company_id IS NOT NULL AND p.owner_company_id = trustwork.current_company_id()))
    )
    WHEN 'rfq' THEN EXISTS (
      SELECT 1 FROM trustwork.rfq r WHERE r.id = p_resource_id
        AND trustwork.commerce_party_acts(r.owner_person_id, r.owner_company_id, 'company.deals.manage')
    )
    WHEN 'quote' THEN EXISTS (
      SELECT 1 FROM trustwork.quote q WHERE q.id = p_resource_id
        AND trustwork.commerce_party_acts(q.seller_person_id, q.seller_company_id, 'company.deals.manage')
    )
    ELSE false END
$$;

-- 6. Guards -----------------------------------------------------------------------------------------------------------
-- Quotes: the seller drafts against an invitation of its own party on the RFQ (never the buyer itself); identity never
-- changes; the current pointer moves only forward to a sent version; staleness is set only when true (by the RFQ
-- trigger) and cleared only when the pointer moves to a version pinned to the current RFQ version.
CREATE FUNCTION trustwork.quote_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_rfq trustwork.rfq%ROWTYPE;
  v_invitation trustwork.rfq_invitation%ROWTYPE;
  v_version trustwork.quote_version%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quotes are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.creator_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
      RAISE EXCEPTION 'the creator is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    IF NEW.status <> 'draft' OR NEW.current_version_id IS NOT NULL OR NEW.stale_reason IS NOT NULL THEN
      RAISE EXCEPTION 'a quote starts as a current draft' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    SELECT * INTO v_invitation FROM trustwork.rfq_invitation WHERE id = NEW.invitation_id;
    IF NOT FOUND OR v_invitation.rfq_id <> NEW.rfq_id OR v_invitation.party_person_id IS DISTINCT FROM NEW.seller_person_id
       OR v_invitation.party_company_id IS DISTINCT FROM NEW.seller_company_id OR v_invitation.status IN ('declined', 'withdrawn') THEN
      RAISE EXCEPTION 'a quote answers an invitation of the seller' USING ERRCODE = 'check_violation', HINT = 'transactions.not_invited';
    END IF;
    v_rfq := trustwork.transactions_rfq_for_share(NEW.rfq_id);
    IF v_rfq.id IS NULL OR v_rfq.status <> 'published' THEN
      RAISE EXCEPTION 'quotes answer a published RFQ' USING ERRCODE = 'check_violation', HINT = 'commerce.rfq_version_not_current';
    END IF;
    NEW.buyer_person_id := v_rfq.owner_person_id;
    NEW.buyer_company_id := v_rfq.owner_company_id;
    IF NEW.seller_person_id IS NOT DISTINCT FROM NEW.buyer_person_id AND NEW.seller_company_id IS NOT DISTINCT FROM NEW.buyer_company_id THEN
      RAISE EXCEPTION 'the buyer does not quote itself' USING ERRCODE = 'check_violation', HINT = 'commerce.self_invitation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.rfq_id <> OLD.rfq_id OR NEW.seller_person_id IS DISTINCT FROM OLD.seller_person_id OR NEW.seller_company_id IS DISTINCT FROM OLD.seller_company_id
     OR NEW.buyer_person_id IS DISTINCT FROM OLD.buyer_person_id OR NEW.buyer_company_id IS DISTINCT FROM OLD.buyer_company_id OR NEW.creator_person_id <> OLD.creator_person_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'quote identity is immutable' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF NEW.invitation_id IS DISTINCT FROM OLD.invitation_id THEN
    SELECT * INTO v_invitation FROM trustwork.rfq_invitation WHERE id = NEW.invitation_id;
    IF NOT FOUND OR v_invitation.rfq_id <> NEW.rfq_id OR v_invitation.party_person_id IS DISTINCT FROM NEW.seller_person_id OR v_invitation.party_company_id IS DISTINCT FROM NEW.seller_company_id THEN
      RAISE EXCEPTION 'a quote answers an invitation of the seller' USING ERRCODE = 'check_violation', HINT = 'transactions.not_invited';
    END IF;
  END IF;
  -- An accepted quote stays accepted; newer versions may still be sent for an order change.
  IF OLD.status = 'accepted' AND NEW.status <> 'accepted' THEN
    RAISE EXCEPTION 'an accepted quote stays accepted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status IN ('draft', 'sent', 'withdrawn') AND NEW.status = 'sent' AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id)
    OR (OLD.status = 'sent' AND NEW.status IN ('withdrawn', 'accepted'))
  ) THEN
    RAISE EXCEPTION 'quote transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
  END IF;
  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN
    SELECT * INTO v_version FROM trustwork.quote_version WHERE id = NEW.current_version_id;
    IF NOT FOUND OR v_version.quote_id <> NEW.id OR v_version.status <> 'sent' OR v_version.version <> NEW.current_version
       OR (OLD.current_version IS NOT NULL AND NEW.current_version <= OLD.current_version) THEN
      RAISE EXCEPTION 'the current version is the latest sent version' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
    END IF;
  ELSIF NEW.current_version IS DISTINCT FROM OLD.current_version THEN
    RAISE EXCEPTION 'current version number and id move together' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF NEW.stale_reason IS DISTINCT FROM OLD.stale_reason OR NEW.stale_at IS DISTINCT FROM OLD.stale_at THEN
    SELECT * INTO v_rfq FROM trustwork.rfq WHERE id = NEW.rfq_id;
    SELECT * INTO v_version FROM trustwork.quote_version WHERE id = NEW.current_version_id;
    IF NOT (
         (NEW.stale_reason IS NULL AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id AND v_version.rfq_version_id = v_rfq.current_version_id AND v_rfq.status = 'published')
      OR (OLD.stale_reason IS NULL AND NEW.stale_reason = 'rfq_amended' AND v_version.rfq_version_id IS DISTINCT FROM v_rfq.current_version_id)
      OR (OLD.stale_reason IS DISTINCT FROM 'rfq_closed' AND NEW.stale_reason = 'rfq_closed' AND v_rfq.status IN ('closed', 'cancelled', 'expired'))
    ) THEN
      RAISE EXCEPTION 'staleness is set only when true' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.stale_immutable';
    END IF;
  END IF;
  IF NEW.withdrawn_reason IS DISTINCT FROM OLD.withdrawn_reason AND NOT (NEW.status = 'withdrawn' OR (OLD.status = 'withdrawn' AND NEW.status = 'sent')) THEN
    RAISE EXCEPTION 'withdrawal facts change only with the status' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF NEW.status IN ('withdrawn') AND OLD.status = 'sent' AND EXISTS (
    SELECT 1 FROM trustwork.agreement a WHERE a.quote_id = NEW.id AND a.status IN ('proposed', 'accepted_by_buyer', 'accepted_by_both')
  ) THEN
    RAISE EXCEPTION 'a quote under a live agreement is not withdrawn' USING ERRCODE = 'check_violation', HINT = 'transactions.agreement_live';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quote_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.quote FOR EACH ROW EXECUTE FUNCTION trustwork.quote_guard();

-- Quote versions: drafted only against the current published RFQ version that the seller's live invitation pins, as
-- the next number, while no agreement is in acceptance on the quote; sent only while that pin is still current (the RFQ row is locked FOR SHARE, so a concurrent
-- amendment either waits and then flags the version stale, or commits first and the send is refused) and the seller's
-- invitation pinned to it is not stale; valid_until mirrors the frozen payload validity.
CREATE FUNCTION trustwork.quote_version_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_quote trustwork.quote%ROWTYPE;
  v_rfq trustwork.rfq%ROWTYPE;
  v_digest text;
  v_number integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quote versions are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  SELECT * INTO v_quote FROM trustwork.quote WHERE id = NEW.quote_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.stale_reason IS NOT NULL THEN
      RAISE EXCEPTION 'a version starts as a current draft' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    IF NEW.drafted_by_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
      RAISE EXCEPTION 'the drafter is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    IF NEW.rfq_id <> v_quote.rfq_id THEN
      RAISE EXCEPTION 'a version answers the RFQ of its quote' USING ERRCODE = 'check_violation', HINT = 'commerce.rfq_version_not_current';
    END IF;
    v_rfq := trustwork.transactions_rfq_for_share(NEW.rfq_id);
    IF v_rfq.status IS DISTINCT FROM 'published' OR v_rfq.current_version_id IS DISTINCT FROM NEW.rfq_version_id THEN
      RAISE EXCEPTION 'a quote is drafted against the current published RFQ version' USING ERRCODE = 'check_violation', HINT = 'commerce.rfq_version_not_current';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM trustwork.rfq_invitation i
      WHERE i.rfq_id = NEW.rfq_id AND i.rfq_version_id = NEW.rfq_version_id AND i.status NOT IN ('declined', 'withdrawn')
        AND i.party_person_id IS NOT DISTINCT FROM v_quote.seller_person_id AND i.party_company_id IS NOT DISTINCT FROM v_quote.seller_company_id
    ) THEN
      RAISE EXCEPTION 'the seller drafts against the version it is invited to' USING ERRCODE = 'check_violation', HINT = 'transactions.not_invited';
    END IF;
    SELECT digest, version INTO v_digest, v_number FROM trustwork.rfq_version WHERE id = NEW.rfq_version_id;
    IF v_digest IS DISTINCT FROM NEW.rfq_version_digest OR v_number IS DISTINCT FROM NEW.rfq_version THEN
      RAISE EXCEPTION 'the pinned RFQ digest is the stored one' USING ERRCODE = 'check_violation', HINT = 'commercial.digest_mismatch';
    END IF;
    IF NEW.version <> coalesce((SELECT max(version) FROM trustwork.quote_version WHERE quote_id = NEW.quote_id), 0) + 1 THEN
      RAISE EXCEPTION 'versions are numbered consecutively' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    IF EXISTS (SELECT 1 FROM trustwork.agreement a WHERE a.quote_id = NEW.quote_id AND a.status IN ('proposed', 'accepted_by_buyer')) THEN
      RAISE EXCEPTION 'terms under acceptance take no new version' USING ERRCODE = 'check_violation', HINT = 'transactions.agreement_live';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.quote_id <> OLD.quote_id OR NEW.version <> OLD.version OR NEW.drafted_by_person_id <> OLD.drafted_by_person_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'version identity is immutable' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF NEW.stale_reason IS DISTINCT FROM OLD.stale_reason OR NEW.stale_at IS DISTINCT FROM OLD.stale_at THEN
    SELECT * INTO v_rfq FROM trustwork.rfq WHERE id = NEW.rfq_id;
    IF OLD.stale_reason IS NOT NULL
       OR (NEW.stale_reason = 'rfq_amended' AND v_rfq.current_version_id IS NOT DISTINCT FROM NEW.rfq_version_id)
       OR (NEW.stale_reason = 'rfq_closed' AND v_rfq.status NOT IN ('closed', 'cancelled', 'expired')) THEN
      RAISE EXCEPTION 'staleness is set once and only when true' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.stale_immutable';
    END IF;
  END IF;
  IF NEW.status = OLD.status THEN
    IF NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
      RAISE EXCEPTION 'supersession changes only with the status' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status = 'draft' AND NEW.status = 'sent') OR (OLD.status = 'sent' AND NEW.status IN ('superseded', 'withdrawn', 'accepted'))) THEN
    RAISE EXCEPTION 'version transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
  END IF;
  IF NEW.status = 'sent' THEN
    IF NEW.sent_by_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
      RAISE EXCEPTION 'the sender is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    v_rfq := trustwork.transactions_rfq_for_share(NEW.rfq_id);
    IF v_rfq.status IS DISTINCT FROM 'published' OR v_rfq.current_version_id IS DISTINCT FROM NEW.rfq_version_id OR NEW.stale_reason IS NOT NULL THEN
      RAISE EXCEPTION 'a quote is sent only against the current published RFQ version' USING ERRCODE = 'check_violation', HINT = 'commerce.rfq_version_not_current';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM trustwork.rfq_invitation i
      WHERE i.rfq_id = NEW.rfq_id AND i.rfq_version_id = NEW.rfq_version_id AND i.stale_reason IS NULL AND i.status IN ('sent', 'viewed', 'responded')
        AND i.party_person_id IS NOT DISTINCT FROM v_quote.seller_person_id AND i.party_company_id IS NOT DISTINCT FROM v_quote.seller_company_id
    ) THEN
      RAISE EXCEPTION 'the seller holds a current invitation for this RFQ version' USING ERRCODE = 'check_violation', HINT = 'transactions.not_invited';
    END IF;
    IF NEW.valid_until IS DISTINCT FROM (NEW.payload -> 'validity' ->> 'until')::timestamptz OR NEW.valid_until <= now() THEN
      RAISE EXCEPTION 'valid_until mirrors the frozen payload validity and lies ahead' USING ERRCODE = 'check_violation', HINT = 'commercial.quote_expired';
    END IF;
    IF (SELECT count(*) FROM trustwork.quote_line WHERE quote_version_id = NEW.id) <> jsonb_array_length(NEW.payload -> 'lines') THEN
      RAISE EXCEPTION 'the line projection is written with the send' USING ERRCODE = 'check_violation', HINT = 'commerce.parts_missing';
    END IF;
  ELSIF NEW.status = 'accepted' THEN
    IF NOT EXISTS (SELECT 1 FROM trustwork.agreement a WHERE a.quote_version_id = NEW.id AND a.status = 'accepted_by_both') THEN
      RAISE EXCEPTION 'a version is accepted only by an agreement accepted by both' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
  ELSIF NEW.status = 'withdrawn' AND EXISTS (SELECT 1 FROM trustwork.agreement a WHERE a.quote_version_id = NEW.id AND a.status IN ('proposed', 'accepted_by_buyer', 'accepted_by_both')) THEN
    RAISE EXCEPTION 'a version under a live agreement is not withdrawn' USING ERRCODE = 'check_violation', HINT = 'transactions.agreement_live';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quote_version_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.quote_version FOR EACH ROW EXECUTE FUNCTION trustwork.quote_version_guard();

-- Lines and tax determinations join a version only while it is a draft (FOR SHARE waits for a concurrent send).
CREATE FUNCTION trustwork.quote_part_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_status text;
  v_quote uuid;
BEGIN
  SELECT status, quote_id INTO v_status, v_quote FROM trustwork.quote_version WHERE id = NEW.quote_version_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown quote version' USING ERRCODE = 'foreign_key_violation', HINT = 'commerce.not_found';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'a sent quote version is frozen' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF NEW.quote_id <> v_quote THEN
    RAISE EXCEPTION 'parts belong to the quote of their version' USING ERRCODE = 'check_violation', HINT = 'commerce.not_found';
  END IF;
  IF TG_TABLE_NAME = 'tax_determination' THEN
    IF to_jsonb(NEW) ->> 'determined_by_person_id' IS DISTINCT FROM trustwork.current_person_id()::text THEN
      RAISE EXCEPTION 'the determiner is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quote_line_guard BEFORE INSERT ON trustwork.quote_line FOR EACH ROW EXECUTE FUNCTION trustwork.quote_part_guard();
CREATE TRIGGER quote_line_frozen BEFORE UPDATE OR DELETE ON trustwork.quote_line FOR EACH ROW EXECUTE FUNCTION trustwork.commerce_retained();
CREATE TRIGGER tax_determination_guard BEFORE INSERT ON trustwork.tax_determination FOR EACH ROW EXECUTE FUNCTION trustwork.quote_part_guard();
CREATE TRIGGER tax_determination_frozen BEFORE UPDATE OR DELETE ON trustwork.tax_determination FOR EACH ROW EXECUTE FUNCTION trustwork.commerce_retained();

CREATE FUNCTION trustwork.quote_private_constraint_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'private constraints are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  IF NEW.updated_by_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
    RAISE EXCEPTION 'the updater is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trustwork.quote q WHERE q.id = NEW.quote_id AND q.seller_person_id IS NOT DISTINCT FROM NEW.owner_person_id AND q.seller_company_id IS NOT DISTINCT FROM NEW.owner_company_id) THEN
    RAISE EXCEPTION 'the private constraint belongs to the seller' USING ERRCODE = 'check_violation', HINT = 'commerce.not_authorised';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quote_private_constraint_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.quote_private_constraint FOR EACH ROW EXECUTE FUNCTION trustwork.quote_private_constraint_guard();

-- Amendment requests: the buyer side asks on the quote's current sent version, naming lines that exist in it; the
-- seller answers with a newer version of the same quote; the buyer withdraws.
CREATE FUNCTION trustwork.amendment_request_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_quote trustwork.quote%ROWTYPE;
  v_version trustwork.quote_version%ROWTYPE;
  v_answer trustwork.quote_version%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'amendment requests are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  SELECT * INTO v_quote FROM trustwork.quote WHERE id = NEW.quote_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.requested_by_person_id IS DISTINCT FROM trustwork.current_person_id() OR NOT trustwork.rfq_can(v_quote.rfq_id, 'negotiate') THEN
      RAISE EXCEPTION 'the buyer side negotiates' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    IF NEW.requester_person_id IS DISTINCT FROM v_quote.buyer_person_id OR NEW.requester_company_id IS DISTINCT FROM v_quote.buyer_company_id THEN
      RAISE EXCEPTION 'the requester is the buyer party' USING ERRCODE = 'check_violation', HINT = 'commerce.not_authorised';
    END IF;
    SELECT * INTO v_version FROM trustwork.quote_version WHERE id = NEW.quote_version_id;
    IF v_version.status NOT IN ('sent', 'accepted') OR v_quote.current_version_id IS DISTINCT FROM v_version.id THEN
      RAISE EXCEPTION 'amendments are requested on the current sent version' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(NEW.line_refs) AS r WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_version.payload -> 'lines') AS l WHERE l ->> 'lineId' = r)) THEN
      RAISE EXCEPTION 'requests name lines of the version' USING ERRCODE = 'check_violation', HINT = 'transactions.unknown_line';
    END IF;
    IF NEW.status <> 'open' THEN
      RAISE EXCEPTION 'a request starts open' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.quote_id <> OLD.quote_id OR NEW.quote_version_id <> OLD.quote_version_id OR NEW.requester_person_id IS DISTINCT FROM OLD.requester_person_id
     OR NEW.requester_company_id IS DISTINCT FROM OLD.requester_company_id OR NEW.requested_by_person_id <> OLD.requested_by_person_id OR NEW.requested_via <> OLD.requested_via
     OR NEW.requested_mandate_id IS DISTINCT FROM OLD.requested_mandate_id OR NEW.line_refs <> OLD.line_refs OR NEW.changes <> OLD.changes
     OR NEW.target_total_minor IS DISTINCT FROM OLD.target_total_minor OR NEW.target_total_currency IS DISTINCT FROM OLD.target_total_currency OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a request never changes' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF OLD.status <> 'open' THEN
      RAISE EXCEPTION 'a closed request stays closed' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    IF NEW.status = 'answered' THEN
      SELECT * INTO v_answer FROM trustwork.quote_version WHERE id = NEW.answered_by_version_id;
      IF NOT FOUND OR v_answer.quote_id <> NEW.quote_id OR v_answer.answers_amendment_request_id IS DISTINCT FROM NEW.id
         OR NOT trustwork.commerce_party_acts(v_quote.seller_person_id, v_quote.seller_company_id, 'company.deals.manage') THEN
        RAISE EXCEPTION 'the seller answers with a version of the same quote' USING ERRCODE = 'check_violation', HINT = 'commerce.not_authorised';
      END IF;
    ELSIF NEW.status = 'withdrawn' AND NOT trustwork.rfq_can(v_quote.rfq_id, 'negotiate') THEN
      RAISE EXCEPTION 'the buyer side withdraws' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
  ELSIF NEW.answered_by_version_id IS DISTINCT FROM OLD.answered_by_version_id OR NEW.withdrawn_reason IS DISTINCT FROM OLD.withdrawn_reason THEN
    RAISE EXCEPTION 'answers change only with the status' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER amendment_request_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.amendment_request FOR EACH ROW EXECUTE FUNCTION trustwork.amendment_request_guard();

-- Rounds: the next number of the quote; a sent quote version proposed by the seller party or a request proposed by
-- the buyer party, recorded by the principal acting for it.
CREATE FUNCTION trustwork.negotiation_round_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_quote trustwork.quote%ROWTYPE;
BEGIN
  SELECT * INTO v_quote FROM trustwork.quote WHERE id = NEW.quote_id;
  IF NEW.rfq_id <> v_quote.rfq_id OR NEW.proposed_by_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
    RAISE EXCEPTION 'a round is recorded by the principal on its quote' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
  END IF;
  IF NEW.round_no <> coalesce((SELECT max(round_no) FROM trustwork.negotiation_round WHERE quote_id = NEW.quote_id), 0) + 1 THEN
    RAISE EXCEPTION 'rounds are numbered consecutively' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
  END IF;
  IF NEW.proposal_kind = 'quote_version' THEN
    IF NOT EXISTS (SELECT 1 FROM trustwork.quote_version v WHERE v.id = NEW.proposal_id AND v.quote_id = NEW.quote_id AND v.status <> 'draft')
       OR NEW.proposer_person_id IS DISTINCT FROM v_quote.seller_person_id OR NEW.proposer_company_id IS DISTINCT FROM v_quote.seller_company_id
       OR NOT trustwork.commerce_party_acts(v_quote.seller_person_id, v_quote.seller_company_id, 'company.deals.manage') THEN
      RAISE EXCEPTION 'the seller proposes a sent version of its quote' USING ERRCODE = 'check_violation', HINT = 'commerce.not_authorised';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM trustwork.amendment_request r WHERE r.id = NEW.proposal_id AND r.quote_id = NEW.quote_id)
     OR NEW.proposer_person_id IS DISTINCT FROM v_quote.buyer_person_id OR NEW.proposer_company_id IS DISTINCT FROM v_quote.buyer_company_id
     OR NOT trustwork.rfq_can(v_quote.rfq_id, 'negotiate') THEN
    RAISE EXCEPTION 'the buyer proposes its own request' USING ERRCODE = 'check_violation', HINT = 'commerce.not_authorised';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER negotiation_round_guard BEFORE INSERT ON trustwork.negotiation_round FOR EACH ROW EXECUTE FUNCTION trustwork.negotiation_round_guard();
CREATE TRIGGER negotiation_round_append_only BEFORE UPDATE OR DELETE ON trustwork.negotiation_round FOR EACH ROW EXECUTE FUNCTION trustwork.commerce_retained();

-- Agreements: the buyer side accepts a sent, valid, non-stale quote version pinned to the current published RFQ
-- version; parties come from the RFQ and the quote; the pinned versions and digests are the stored ones. Terms never
-- change. Task and consultation agreements are created by their own slices (TASK-001, CONS-001).
CREATE FUNCTION trustwork.agreement_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_rfq trustwork.rfq%ROWTYPE;
  v_quote trustwork.quote%ROWTYPE;
  v_version trustwork.quote_version%ROWTYPE;
  v_rfq_version trustwork.rfq_version%ROWTYPE;
  v_buyer boolean;
  v_seller boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'agreements are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.terms_kind <> 'rfq_quote' THEN
      RAISE EXCEPTION '% agreements are created by their own slice', NEW.terms_kind USING ERRCODE = 'check_violation', HINT = 'transactions.terms_kind_unavailable';
    END IF;
    IF NEW.created_by_person_id IS DISTINCT FROM trustwork.current_person_id()
       OR NOT (trustwork.rfq_can(NEW.rfq_id, 'accept') OR (NEW.supersedes_id IS NOT NULL AND trustwork.agreement_side(NEW.supersedes_id) IS NOT NULL)) THEN
      RAISE EXCEPTION 'the buyer side accepts; either party applies an accepted change' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    v_rfq := trustwork.transactions_rfq_for_share(NEW.rfq_id);
    v_quote := trustwork.transactions_quote_for_share(NEW.quote_id);
    SELECT * INTO v_version FROM trustwork.quote_version WHERE id = NEW.quote_version_id;
    SELECT * INTO v_rfq_version FROM trustwork.rfq_version WHERE id = NEW.rfq_version_id;
    IF v_quote.rfq_id <> NEW.rfq_id OR v_version.quote_id <> NEW.quote_id OR v_version.rfq_version_id <> NEW.rfq_version_id THEN
      RAISE EXCEPTION 'the agreement pins a version of a quote on this RFQ' USING ERRCODE = 'check_violation', HINT = 'commercial.rfq_version_mismatch';
    END IF;
    IF NEW.buyer_person_id IS DISTINCT FROM v_rfq.owner_person_id OR NEW.buyer_company_id IS DISTINCT FROM v_rfq.owner_company_id
       OR NEW.seller_person_id IS DISTINCT FROM v_quote.seller_person_id OR NEW.seller_company_id IS DISTINCT FROM v_quote.seller_company_id THEN
      RAISE EXCEPTION 'parties come from the RFQ and the quote' USING ERRCODE = 'check_violation', HINT = 'commerce.not_authorised';
    END IF;
    IF NEW.offer_version <> v_version.version OR NEW.offer_digest IS DISTINCT FROM v_version.digest OR NEW.request_version <> v_rfq_version.version
       OR NEW.request_digest IS DISTINCT FROM v_rfq_version.digest OR v_version.rfq_version_digest IS DISTINCT FROM v_rfq_version.digest THEN
      RAISE EXCEPTION 'pinned digests are the stored ones' USING ERRCODE = 'check_violation', HINT = 'commercial.digest_mismatch';
    END IF;
    IF v_version.status <> 'sent' OR v_version.valid_until <= now() THEN
      RAISE EXCEPTION 'only a sent, valid quote version is accepted' USING ERRCODE = 'check_violation', HINT = 'commercial.quote_not_acceptable';
    END IF;
    IF v_rfq.current_version_id IS DISTINCT FROM NEW.rfq_version_id OR v_version.stale_reason IS NOT NULL THEN
      RAISE EXCEPTION 'the quote no longer answers the current RFQ version' USING ERRCODE = 'check_violation', HINT = 'commercial.stale_version';
    END IF;
    IF NEW.supersedes_id IS NULL THEN
      IF v_rfq.status <> 'published' OR NEW.status NOT IN ('proposed', 'accepted_by_buyer') THEN
        RAISE EXCEPTION 'terms are accepted on a published RFQ' USING ERRCODE = 'check_violation', HINT = 'commercial.quote_not_acceptable';
      END IF;
    ELSIF NEW.status <> 'accepted_by_both' OR NOT EXISTS (
      SELECT 1 FROM trustwork.agreement o WHERE o.id = NEW.supersedes_id AND o.superseded_by = NEW.id AND o.quote_id = NEW.quote_id AND o.status = 'superseded'
    ) OR NOT EXISTS (
      SELECT 1 FROM trustwork.order_change c WHERE c.previous_agreement_id = NEW.supersedes_id AND c.new_quote_version_id = NEW.quote_version_id AND c.status = 'proposed'
    ) THEN
      RAISE EXCEPTION 'a superseding agreement comes from an order change' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    IF NEW.superseded_by IS NOT NULL OR NEW.closed_reason IS NOT NULL THEN
      RAISE EXCEPTION 'an agreement starts open' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.terms_kind <> OLD.terms_kind OR NEW.buyer_person_id IS DISTINCT FROM OLD.buyer_person_id OR NEW.buyer_company_id IS DISTINCT FROM OLD.buyer_company_id
     OR NEW.seller_person_id IS DISTINCT FROM OLD.seller_person_id OR NEW.seller_company_id IS DISTINCT FROM OLD.seller_company_id OR NEW.rfq_id IS DISTINCT FROM OLD.rfq_id
     OR NEW.quote_id IS DISTINCT FROM OLD.quote_id OR NEW.quote_version_id IS DISTINCT FROM OLD.quote_version_id OR NEW.rfq_version_id IS DISTINCT FROM OLD.rfq_version_id
     OR NEW.offer_ref_id IS DISTINCT FROM OLD.offer_ref_id OR NEW.request_ref_id IS DISTINCT FROM OLD.request_ref_id OR NEW.offer_version <> OLD.offer_version
     OR NEW.offer_digest <> OLD.offer_digest OR NEW.request_version <> OLD.request_version OR NEW.request_digest <> OLD.request_digest
     OR NEW.accepted_terms_digest <> OLD.accepted_terms_digest OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id OR NEW.created_by_person_id <> OLD.created_by_person_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'agreed terms never change' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF NEW.status = OLD.status THEN
    IF NEW.superseded_by IS DISTINCT FROM OLD.superseded_by OR NEW.closed_reason IS DISTINCT FROM OLD.closed_reason THEN
      RAISE EXCEPTION 'closing facts change only with the status' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
    END IF;
    RETURN NEW;
  END IF;
  v_seller := trustwork.commerce_party_acts(OLD.seller_person_id, OLD.seller_company_id, 'company.deals.manage');
  v_buyer := trustwork.commerce_party_acts(OLD.buyer_person_id, OLD.buyer_company_id, 'company.deals.manage') OR (OLD.rfq_id IS NOT NULL AND trustwork.rfq_can(OLD.rfq_id, 'accept'));
  IF NOT (
       (OLD.status = 'proposed' AND NEW.status = 'accepted_by_buyer' AND v_buyer)
    OR (OLD.status IN ('proposed', 'accepted_by_buyer') AND NEW.status = 'withdrawn' AND v_buyer)
    OR (OLD.status = 'accepted_by_buyer' AND NEW.status IN ('accepted_by_both', 'declined') AND v_seller)
    OR (OLD.status = 'accepted_by_both' AND NEW.status = 'superseded' AND (v_buyer OR v_seller))
  ) THEN
    RAISE EXCEPTION 'agreement transition % -> % is not allowed for this side', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agreement_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.agreement FOR EACH ROW EXECUTE FUNCTION trustwork.agreement_guard();

-- At commit: every acceptance status is backed by its event (and the event repeats the agreement digest, below).
CREATE FUNCTION trustwork.agreement_events_present() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_status text;
  v_kind text;
BEGIN
  SELECT status INTO v_status FROM trustwork.agreement WHERE id = NEW.id;
  v_kind := CASE v_status WHEN 'accepted_by_buyer' THEN 'buyer_accepts_terms' WHEN 'accepted_by_both' THEN 'seller_accepts_order' WHEN 'declined' THEN 'seller_declines' WHEN 'withdrawn' THEN 'withdrawn' END;
  IF v_kind IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trustwork.acceptance_event e WHERE e.agreement_id = NEW.id AND e.kind = v_kind)
     AND NOT (v_status = 'accepted_by_both' AND EXISTS (SELECT 1 FROM trustwork.agreement a WHERE a.id = NEW.id AND a.supersedes_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'agreement status % needs its % event', v_status, v_kind USING ERRCODE = 'integrity_constraint_violation', HINT = 'transactions.event_missing';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER agreement_events_present AFTER INSERT OR UPDATE ON trustwork.agreement DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trustwork.agreement_events_present();

-- The digest equality trigger: an event repeats the agreement's terms kind, pinned versions and digest exactly; buyer
-- kinds are recorded by the buyer side for the buyer party, seller kinds by the seller side for the seller party.
CREATE FUNCTION trustwork.acceptance_event_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_agreement trustwork.agreement%ROWTYPE;
BEGIN
  SELECT * INTO v_agreement FROM trustwork.agreement WHERE id = NEW.agreement_id;
  IF NEW.actor_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
    RAISE EXCEPTION 'the actor is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
  END IF;
  IF NEW.terms_kind <> v_agreement.terms_kind OR NEW.quote_version_id IS DISTINCT FROM v_agreement.quote_version_id OR NEW.rfq_version_id IS DISTINCT FROM v_agreement.rfq_version_id
     OR NEW.offer_version <> v_agreement.offer_version OR NEW.offer_digest <> v_agreement.offer_digest OR NEW.request_version <> v_agreement.request_version
     OR NEW.request_digest <> v_agreement.request_digest OR NEW.accepted_terms_digest <> v_agreement.accepted_terms_digest THEN
    RAISE EXCEPTION 'an acceptance event carries the agreement digest' USING ERRCODE = 'check_violation', HINT = 'commercial.digest_mismatch';
  END IF;
  IF NEW.kind IN ('buyer_selects', 'buyer_accepts_terms', 'withdrawn') THEN
    IF NEW.on_behalf_person_id IS DISTINCT FROM v_agreement.buyer_person_id OR NEW.on_behalf_company_id IS DISTINCT FROM v_agreement.buyer_company_id
       OR NOT (trustwork.commerce_party_acts(v_agreement.buyer_person_id, v_agreement.buyer_company_id, 'company.deals.manage') OR trustwork.rfq_can(v_agreement.rfq_id, 'accept')) THEN
      RAISE EXCEPTION 'buyer events are recorded by the buyer side' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    IF v_agreement.status NOT IN ('proposed', 'accepted_by_buyer') THEN
      RAISE EXCEPTION 'the agreement is %', v_agreement.status USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
  ELSE
    IF NEW.on_behalf_person_id IS DISTINCT FROM v_agreement.seller_person_id OR NEW.on_behalf_company_id IS DISTINCT FROM v_agreement.seller_company_id
       OR NOT trustwork.commerce_party_acts(v_agreement.seller_person_id, v_agreement.seller_company_id, 'company.deals.manage') THEN
      RAISE EXCEPTION 'seller events are recorded by the seller side' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    IF v_agreement.status <> 'accepted_by_buyer' THEN
      RAISE EXCEPTION 'the seller answers terms the buyer accepted' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    IF NEW.kind = 'seller_accepts_order' AND NOT EXISTS (SELECT 1 FROM trustwork.commercial_order o WHERE o.agreement_id = NEW.agreement_id AND o.status = 'placed') THEN
      RAISE EXCEPTION 'the seller accepts a placed order' USING ERRCODE = 'check_violation', HINT = 'transactions.order_missing';
    END IF;
    IF NEW.transaction_budget_id IS NOT NULL OR NEW.reservation_id IS NOT NULL OR NEW.platform_budget_id IS NOT NULL THEN
      RAISE EXCEPTION 'seller events carry no buyer budget' USING ERRCODE = 'check_violation', HINT = 'commerce.not_authorised';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER acceptance_event_guard BEFORE INSERT ON trustwork.acceptance_event FOR EACH ROW EXECUTE FUNCTION trustwork.acceptance_event_guard();

CREATE FUNCTION trustwork.agreement_private_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_agreement trustwork.agreement%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'private halves are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  IF NEW.updated_by_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
    RAISE EXCEPTION 'the updater is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
  END IF;
  SELECT * INTO v_agreement FROM trustwork.agreement WHERE id = NEW.agreement_id;
  IF TG_TABLE_NAME = 'agreement_buyer_private' THEN
    IF NEW.owner_person_id IS DISTINCT FROM v_agreement.buyer_person_id OR NEW.owner_company_id IS DISTINCT FROM v_agreement.buyer_company_id THEN
      RAISE EXCEPTION 'the buyer half belongs to the buyer' USING ERRCODE = 'check_violation', HINT = 'commerce.not_authorised';
    END IF;
  ELSIF NEW.owner_person_id IS DISTINCT FROM v_agreement.seller_person_id OR NEW.owner_company_id IS DISTINCT FROM v_agreement.seller_company_id THEN
    RAISE EXCEPTION 'the seller half belongs to the seller' USING ERRCODE = 'check_violation', HINT = 'commerce.not_authorised';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.agreement_id <> OLD.agreement_id OR NEW.owner_person_id IS DISTINCT FROM OLD.owner_person_id OR NEW.owner_company_id IS DISTINCT FROM OLD.owner_company_id) THEN
    RAISE EXCEPTION 'a private half belongs to its agreement' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agreement_buyer_private_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.agreement_buyer_private FOR EACH ROW EXECUTE FUNCTION trustwork.agreement_private_guard();
CREATE TRIGGER agreement_seller_private_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.agreement_seller_private FOR EACH ROW EXECUTE FUNCTION trustwork.agreement_private_guard();

-- Orders: placed by the buyer side on terms the buyer accepted, carrying the agreement digest and the reservation the
-- API made for exactly the gross total through billing_reserve in the same transaction (billing checks it); the seller accepts or declines; the buyer cancels before acceptance; a
-- change moves the order to a superseding agreement. Fulfilment and later cancellation arrive with EXE-001.
CREATE FUNCTION trustwork.commercial_order_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_agreement trustwork.agreement%ROWTYPE;
  v_buyer boolean;
  v_seller boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'orders are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO v_agreement FROM trustwork.agreement WHERE id = NEW.agreement_id FOR SHARE;
    IF NEW.placed_by_person_id IS DISTINCT FROM trustwork.current_person_id() OR NOT (v_agreement.rfq_id IS NOT NULL AND trustwork.rfq_can(v_agreement.rfq_id, 'commit_order')) THEN
      RAISE EXCEPTION 'the buyer side places orders' USING ERRCODE = 'insufficient_privilege', HINT = 'commercial.authority_missing';
    END IF;
    IF v_agreement.status <> 'accepted_by_buyer' OR NEW.status <> 'placed' THEN
      RAISE EXCEPTION 'an order is placed on terms the buyer accepted' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    IF NEW.accepted_terms_digest <> v_agreement.accepted_terms_digest THEN
      RAISE EXCEPTION 'an order carries the agreement digest' USING ERRCODE = 'check_violation', HINT = 'commercial.digest_mismatch';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.context_kind <> OLD.context_kind OR NEW.context_id <> OLD.context_id OR NEW.transaction_budget_id <> OLD.transaction_budget_id
     OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id OR NEW.platform_budget_id IS DISTINCT FROM OLD.platform_budget_id OR NEW.placed_by_person_id <> OLD.placed_by_person_id
     OR NEW.placed_via <> OLD.placed_via OR NEW.placed_mandate_id IS DISTINCT FROM OLD.placed_mandate_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'order facts never change' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  v_seller := trustwork.order_side(OLD.id) = 'seller';
  v_buyer := trustwork.order_side(OLD.id) = 'buyer';
  IF NEW.agreement_id <> OLD.agreement_id OR NEW.accepted_terms_digest <> OLD.accepted_terms_digest OR NEW.amount_minor <> OLD.amount_minor OR NEW.currency <> OLD.currency THEN
    SELECT * INTO v_agreement FROM trustwork.agreement WHERE id = NEW.agreement_id;
    IF NEW.status <> 'changed' OR v_agreement.supersedes_id IS DISTINCT FROM OLD.agreement_id OR v_agreement.accepted_terms_digest <> NEW.accepted_terms_digest
       OR NOT EXISTS (SELECT 1 FROM trustwork.order_change c WHERE c.order_id = OLD.id AND c.new_agreement_id = NEW.agreement_id AND c.status = 'accepted') THEN
      RAISE EXCEPTION 'an order moves only to the agreement of an accepted change' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
    END IF;
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'placed' AND NEW.status = 'accepted' AND v_seller)
    OR (OLD.status = 'placed' AND NEW.status = 'cancelled' AND (v_buyer OR v_seller))
    OR (OLD.status IN ('accepted', 'changed') AND NEW.status = 'changed' AND (v_buyer OR v_seller))
  ) THEN
    RAISE EXCEPTION 'order transition % -> % is not allowed for this side', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
  END IF;
  IF NEW.external_reference IS DISTINCT FROM OLD.external_reference AND NOT v_buyer THEN
    RAISE EXCEPTION 'the buyer records its external reference' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commercial_order_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.commercial_order FOR EACH ROW EXECUTE FUNCTION trustwork.commercial_order_guard();

-- Order changes: proposed by either party on an accepted order, naming a newer sent version of the same quote; the
-- counterparty accepts or rejects, the proposer withdraws.
CREATE FUNCTION trustwork.order_change_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_order trustwork.commercial_order%ROWTYPE;
  v_agreement trustwork.agreement%ROWTYPE;
  v_version trustwork.quote_version%ROWTYPE;
  v_proposer_side text;
  v_side text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'order changes are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  SELECT * INTO v_order FROM trustwork.commercial_order WHERE id = NEW.order_id;
  SELECT * INTO v_agreement FROM trustwork.agreement WHERE id = NEW.previous_agreement_id;
  v_proposer_side := CASE
    WHEN NEW.proposer_person_id IS NOT DISTINCT FROM v_agreement.buyer_person_id AND NEW.proposer_company_id IS NOT DISTINCT FROM v_agreement.buyer_company_id THEN 'buyer'
    WHEN NEW.proposer_person_id IS NOT DISTINCT FROM v_agreement.seller_person_id AND NEW.proposer_company_id IS NOT DISTINCT FROM v_agreement.seller_company_id THEN 'seller' END;
  v_side := trustwork.agreement_side(NEW.previous_agreement_id);
  IF TG_OP = 'INSERT' THEN
    IF NEW.proposed_by_person_id IS DISTINCT FROM trustwork.current_person_id() OR v_proposer_side IS NULL OR v_side IS DISTINCT FROM v_proposer_side THEN
      RAISE EXCEPTION 'a party proposes changes for itself' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    IF v_order.status NOT IN ('accepted', 'changed') OR v_order.agreement_id <> NEW.previous_agreement_id OR v_order.accepted_terms_digest <> NEW.previous_terms_digest OR v_agreement.status <> 'accepted_by_both' THEN
      RAISE EXCEPTION 'changes apply to the current terms of an accepted order' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    SELECT * INTO v_version FROM trustwork.quote_version WHERE id = NEW.new_quote_version_id;
    IF v_version.quote_id IS DISTINCT FROM v_agreement.quote_id OR v_version.status <> 'sent' OR v_version.id = v_agreement.quote_version_id OR v_version.rfq_version_id <> NEW.new_rfq_version_id THEN
      RAISE EXCEPTION 'a change names a newer sent version of the same quote' USING ERRCODE = 'check_violation', HINT = 'commercial.quote_not_acceptable';
    END IF;
    IF NEW.status <> 'proposed' OR NEW.new_agreement_id IS NOT NULL THEN
      RAISE EXCEPTION 'a change starts proposed' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.order_id <> OLD.order_id OR NEW.previous_agreement_id <> OLD.previous_agreement_id OR NEW.previous_terms_digest <> OLD.previous_terms_digest
     OR NEW.new_quote_version_id <> OLD.new_quote_version_id OR NEW.new_rfq_version_id <> OLD.new_rfq_version_id OR NEW.new_terms_digest <> OLD.new_terms_digest
     OR NEW.proposer_person_id IS DISTINCT FROM OLD.proposer_person_id OR NEW.proposer_company_id IS DISTINCT FROM OLD.proposer_company_id
     OR NEW.proposed_by_person_id <> OLD.proposed_by_person_id OR NEW.proposed_via <> OLD.proposed_via OR NEW.proposed_mandate_id IS DISTINCT FROM OLD.proposed_mandate_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a proposed change never changes' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF OLD.status <> 'proposed' OR NEW.decided_by_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
      RAISE EXCEPTION 'a decided change stays decided' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    IF (NEW.status IN ('accepted', 'rejected') AND (v_side IS NULL OR v_side = v_proposer_side)) OR (NEW.status = 'withdrawn' AND v_side IS DISTINCT FROM v_proposer_side) THEN
      RAISE EXCEPTION 'the counterparty decides; the proposer withdraws' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
  ELSIF NEW.consents <> OLD.consents OR NEW.new_agreement_id IS DISTINCT FROM OLD.new_agreement_id OR NEW.delta_reservation_id IS DISTINCT FROM OLD.delta_reservation_id
        OR NEW.decided_by_person_id IS DISTINCT FROM OLD.decided_by_person_id OR NEW.decided_reason IS DISTINCT FROM OLD.decided_reason THEN
    RAISE EXCEPTION 'decision facts change only with the status' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER order_change_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.order_change FOR EACH ROW EXECUTE FUNCTION trustwork.order_change_guard();

-- Obligations: derived when both parties accepted (or a change was accepted); obligors are the parties; only the
-- status moves, and in this slice only to `waived` when the agreement is superseded.
CREATE FUNCTION trustwork.obligation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_agreement trustwork.agreement%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'obligations are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  SELECT * INTO v_agreement FROM trustwork.agreement WHERE id = NEW.agreement_id;
  IF trustwork.agreement_side(NEW.agreement_id) IS NULL THEN
    RAISE EXCEPTION 'only the parties record obligations' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF v_agreement.status <> 'accepted_by_both' OR NEW.status <> 'open' THEN
      RAISE EXCEPTION 'obligations follow accepted terms' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    IF NOT ((NEW.obligor_person_id IS NOT DISTINCT FROM v_agreement.buyer_person_id AND NEW.obligor_company_id IS NOT DISTINCT FROM v_agreement.buyer_company_id)
         OR (NEW.obligor_person_id IS NOT DISTINCT FROM v_agreement.seller_person_id AND NEW.obligor_company_id IS NOT DISTINCT FROM v_agreement.seller_company_id)) THEN
      RAISE EXCEPTION 'obligors are the parties' USING ERRCODE = 'check_violation', HINT = 'commerce.not_authorised';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.agreement_id <> OLD.agreement_id OR NEW.position <> OLD.position OR NEW.obligor_person_id IS DISTINCT FROM OLD.obligor_person_id OR NEW.obligor_company_id IS DISTINCT FROM OLD.obligor_company_id
     OR NEW.kind <> OLD.kind OR NEW.due IS DISTINCT FROM OLD.due OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.scope_value IS DISTINCT FROM OLD.scope_value OR NEW.scope_unit IS DISTINCT FROM OLD.scope_unit OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'obligations change only through order changes' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'open' AND NEW.status = 'waived' AND v_agreement.status = 'superseded') THEN
    RAISE EXCEPTION 'obligation transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER obligation_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.obligation FOR EACH ROW EXECUTE FUNCTION trustwork.obligation_guard();

-- 7. Staleness reaches quotes (replaces COM-001's trigger) ------------------------------------------------------------
-- In the same transaction as the amendment: every invitation and every quote version pinned to an earlier RFQ version
-- is flagged `rfq_amended`, and so is every quote whose current sent version is; closing, cancelling or expiring flags
-- the rest `rfq_closed`. Version flags are never cleared; a quote's flag clears only when a revalidated version is sent.
CREATE OR REPLACE FUNCTION trustwork.rfq_flag_stale() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id AND OLD.current_version_id IS NOT NULL THEN
    UPDATE trustwork.rfq_invitation SET stale_reason = 'rfq_amended', stale_at = now()
    WHERE rfq_id = NEW.id AND rfq_version_id <> NEW.current_version_id AND stale_reason IS NULL;
    UPDATE trustwork.quote_version SET stale_reason = 'rfq_amended', stale_at = now()
    WHERE rfq_id = NEW.id AND rfq_version_id <> NEW.current_version_id AND stale_reason IS NULL;
    UPDATE trustwork.quote q SET stale_reason = 'rfq_amended', stale_at = now()
    WHERE q.rfq_id = NEW.id AND q.stale_reason IS NULL AND q.current_version_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM trustwork.quote_version v WHERE v.id = q.current_version_id AND v.rfq_version_id <> NEW.current_version_id);
  END IF;
  IF NEW.status <> OLD.status AND NEW.status IN ('closed', 'cancelled', 'expired') THEN
    UPDATE trustwork.rfq_invitation SET stale_reason = 'rfq_closed', stale_at = now() WHERE rfq_id = NEW.id AND stale_reason IS NULL;
    UPDATE trustwork.quote_version SET stale_reason = 'rfq_closed', stale_at = now() WHERE rfq_id = NEW.id AND stale_reason IS NULL;
    UPDATE trustwork.quote SET stale_reason = 'rfq_closed', stale_at = now() WHERE rfq_id = NEW.id AND stale_reason IS DISTINCT FROM 'rfq_closed';
  END IF;
  RETURN NULL;
END $$;

-- 8. Row-level security -----------------------------------------------------------------------------------------------
ALTER TABLE trustwork.quote ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.quote FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.quote_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.quote_version FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.tax_determination ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.tax_determination FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.quote_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.quote_line FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.quote_private_constraint ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.quote_private_constraint FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.amendment_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.amendment_request FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.negotiation_round ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.negotiation_round FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agreement ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agreement FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agreement_buyer_private ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agreement_buyer_private FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agreement_seller_private ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.agreement_seller_private FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.acceptance_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.acceptance_event FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.commercial_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.commercial_order FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.order_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.order_change FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.obligation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.obligation FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.quote AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.quote_version AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.tax_determination AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.quote_line AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.quote_private_constraint AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.amendment_request AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.negotiation_round AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.agreement AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.agreement_buyer_private AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.agreement_seller_private AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.acceptance_event AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.commercial_order AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.order_change AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.obligation AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

-- Quotes: the seller side writes; the buyer side reads sent versions and their lines. The direct seller check covers
-- INSERT ... RETURNING, where the owner-run helper cannot see the new row yet.
CREATE POLICY quote_read ON trustwork.quote FOR SELECT TO trustwork_app
  USING (trustwork.commerce_party_acts(seller_person_id, seller_company_id, 'company.deals.manage') OR trustwork.rfq_can(rfq_id, 'read.party_private'));
CREATE POLICY quote_insert ON trustwork.quote FOR INSERT TO trustwork_app
  WITH CHECK (creator_person_id = trustwork.current_person_id() AND trustwork.commerce_party_acts(seller_person_id, seller_company_id, 'company.deals.manage'));
CREATE POLICY quote_update ON trustwork.quote FOR UPDATE TO trustwork_app
  USING (trustwork.commerce_party_acts(seller_person_id, seller_company_id, 'company.deals.manage'))
  WITH CHECK (trustwork.commerce_party_acts(seller_person_id, seller_company_id, 'company.deals.manage'));
CREATE POLICY quote_version_read ON trustwork.quote_version FOR SELECT TO trustwork_app
  USING (trustwork.quote_side(quote_id) = 'seller' OR (status <> 'draft' AND trustwork.quote_side(quote_id) = 'buyer'));
CREATE POLICY quote_version_insert ON trustwork.quote_version FOR INSERT TO trustwork_app WITH CHECK (trustwork.quote_side(quote_id) = 'seller');
CREATE POLICY quote_version_update ON trustwork.quote_version FOR UPDATE TO trustwork_app USING (trustwork.quote_side(quote_id) = 'seller') WITH CHECK (trustwork.quote_side(quote_id) = 'seller');
CREATE POLICY tax_determination_read ON trustwork.tax_determination FOR SELECT TO trustwork_app USING (EXISTS (SELECT 1 FROM trustwork.quote_version v WHERE v.id = quote_version_id));
CREATE POLICY tax_determination_insert ON trustwork.tax_determination FOR INSERT TO trustwork_app WITH CHECK (trustwork.quote_side(quote_id) = 'seller');
CREATE POLICY quote_line_read ON trustwork.quote_line FOR SELECT TO trustwork_app USING (EXISTS (SELECT 1 FROM trustwork.quote_version v WHERE v.id = quote_version_id));
CREATE POLICY quote_line_insert ON trustwork.quote_line FOR INSERT TO trustwork_app WITH CHECK (trustwork.quote_side(quote_id) = 'seller');
CREATE POLICY quote_private_constraint_read ON trustwork.quote_private_constraint FOR SELECT TO trustwork_app USING (trustwork.quote_side(quote_id) = 'seller');
CREATE POLICY quote_private_constraint_insert ON trustwork.quote_private_constraint FOR INSERT TO trustwork_app WITH CHECK (trustwork.quote_side(quote_id) = 'seller');
CREATE POLICY quote_private_constraint_update ON trustwork.quote_private_constraint FOR UPDATE TO trustwork_app
  USING (trustwork.quote_side(quote_id) = 'seller') WITH CHECK (trustwork.quote_side(quote_id) = 'seller');

-- Negotiation: both sides read; the buyer side requests; the seller side answers (through its send).
CREATE POLICY amendment_request_read ON trustwork.amendment_request FOR SELECT TO trustwork_app USING (trustwork.quote_side(quote_id) IS NOT NULL);
CREATE POLICY amendment_request_insert ON trustwork.amendment_request FOR INSERT TO trustwork_app WITH CHECK (trustwork.quote_side(quote_id) = 'buyer');
CREATE POLICY amendment_request_update ON trustwork.amendment_request FOR UPDATE TO trustwork_app
  USING (trustwork.quote_side(quote_id) IS NOT NULL) WITH CHECK (trustwork.quote_side(quote_id) IS NOT NULL);
CREATE POLICY negotiation_round_read ON trustwork.negotiation_round FOR SELECT TO trustwork_app USING (trustwork.quote_side(quote_id) IS NOT NULL);
CREATE POLICY negotiation_round_insert ON trustwork.negotiation_round FOR INSERT TO trustwork_app WITH CHECK (trustwork.quote_side(quote_id) IS NOT NULL);

-- Agreements: either side reads the shared record and the events; each private half stays with its side.
CREATE POLICY agreement_read ON trustwork.agreement FOR SELECT TO trustwork_app
  USING ((supersedes_id IS NOT NULL AND trustwork.agreement_side(supersedes_id) IS NOT NULL) OR trustwork.commerce_party_acts(buyer_person_id, buyer_company_id, 'company.deals.manage') OR trustwork.commerce_party_acts(seller_person_id, seller_company_id, 'company.deals.manage')
         OR (rfq_id IS NOT NULL AND trustwork.rfq_can(rfq_id, 'read.party_private')));
CREATE POLICY agreement_insert ON trustwork.agreement FOR INSERT TO trustwork_app
  WITH CHECK (created_by_person_id = trustwork.current_person_id() AND rfq_id IS NOT NULL
              AND (trustwork.rfq_can(rfq_id, 'accept') OR (supersedes_id IS NOT NULL AND trustwork.agreement_side(supersedes_id) IS NOT NULL)));
CREATE POLICY agreement_update ON trustwork.agreement FOR UPDATE TO trustwork_app
  USING (trustwork.agreement_side(id) IS NOT NULL) WITH CHECK (trustwork.agreement_side(id) IS NOT NULL);
CREATE POLICY agreement_buyer_private_read ON trustwork.agreement_buyer_private FOR SELECT TO trustwork_app USING (trustwork.agreement_side(agreement_id) = 'buyer');
CREATE POLICY agreement_buyer_private_insert ON trustwork.agreement_buyer_private FOR INSERT TO trustwork_app WITH CHECK (trustwork.agreement_side(agreement_id) = 'buyer');
CREATE POLICY agreement_buyer_private_update ON trustwork.agreement_buyer_private FOR UPDATE TO trustwork_app
  USING (trustwork.agreement_side(agreement_id) = 'buyer') WITH CHECK (trustwork.agreement_side(agreement_id) = 'buyer');
CREATE POLICY agreement_seller_private_read ON trustwork.agreement_seller_private FOR SELECT TO trustwork_app USING (trustwork.agreement_side(agreement_id) = 'seller');
CREATE POLICY agreement_seller_private_insert ON trustwork.agreement_seller_private FOR INSERT TO trustwork_app WITH CHECK (trustwork.agreement_side(agreement_id) = 'seller');
CREATE POLICY agreement_seller_private_update ON trustwork.agreement_seller_private FOR UPDATE TO trustwork_app
  USING (trustwork.agreement_side(agreement_id) = 'seller') WITH CHECK (trustwork.agreement_side(agreement_id) = 'seller');
CREATE POLICY acceptance_event_read ON trustwork.acceptance_event FOR SELECT TO trustwork_app USING (trustwork.agreement_side(agreement_id) IS NOT NULL);
CREATE POLICY acceptance_event_insert ON trustwork.acceptance_event FOR INSERT TO trustwork_app WITH CHECK (trustwork.agreement_side(agreement_id) IS NOT NULL);

-- Orders, changes and obligations: both sides read; the guards decide who may move what.
CREATE POLICY commercial_order_read ON trustwork.commercial_order FOR SELECT TO trustwork_app USING (trustwork.agreement_side(agreement_id) IS NOT NULL);
CREATE POLICY commercial_order_insert ON trustwork.commercial_order FOR INSERT TO trustwork_app WITH CHECK (trustwork.agreement_side(agreement_id) = 'buyer');
CREATE POLICY commercial_order_update ON trustwork.commercial_order FOR UPDATE TO trustwork_app
  USING (trustwork.agreement_side(agreement_id) IS NOT NULL) WITH CHECK (trustwork.agreement_side(agreement_id) IS NOT NULL);
CREATE POLICY order_change_read ON trustwork.order_change FOR SELECT TO trustwork_app USING (trustwork.order_side(order_id) IS NOT NULL);
CREATE POLICY order_change_insert ON trustwork.order_change FOR INSERT TO trustwork_app WITH CHECK (trustwork.order_side(order_id) IS NOT NULL);
CREATE POLICY order_change_update ON trustwork.order_change FOR UPDATE TO trustwork_app USING (trustwork.order_side(order_id) IS NOT NULL) WITH CHECK (trustwork.order_side(order_id) IS NOT NULL);
CREATE POLICY obligation_read ON trustwork.obligation FOR SELECT TO trustwork_app USING (trustwork.agreement_side(agreement_id) IS NOT NULL);
CREATE POLICY obligation_insert ON trustwork.obligation FOR INSERT TO trustwork_app WITH CHECK (trustwork.agreement_side(agreement_id) IS NOT NULL);
CREATE POLICY obligation_update ON trustwork.obligation FOR UPDATE TO trustwork_app
  USING (trustwork.agreement_side(agreement_id) IS NOT NULL) WITH CHECK (trustwork.agreement_side(agreement_id) IS NOT NULL);

-- 9. Grants -----------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT ON trustwork.quote, trustwork.quote_version, trustwork.tax_determination, trustwork.quote_line, trustwork.quote_private_constraint, trustwork.amendment_request,
  trustwork.negotiation_round, trustwork.agreement, trustwork.agreement_buyer_private, trustwork.agreement_seller_private, trustwork.acceptance_event, trustwork.commercial_order,
  trustwork.order_change, trustwork.obligation TO trustwork_app;
GRANT UPDATE (status, current_version, current_version_id, invitation_id, stale_reason, stale_at, withdrawn_reason) ON trustwork.quote TO trustwork_app;
GRANT UPDATE (status, payload, digest, sent_at, sent_by_person_id, sent_via, sent_by_mandate_id, valid_until, superseded_at, answers_amendment_request_id, revalidated_from) ON trustwork.quote_version TO trustwork_app;
GRANT UPDATE (floor_prices, margin_targets, cost_basis, negotiation_notes, updated_by_person_id) ON trustwork.quote_private_constraint TO trustwork_app;
GRANT UPDATE (status, answered_by_version_id, withdrawn_reason) ON trustwork.amendment_request TO trustwork_app;
GRANT UPDATE (status, superseded_by, closed_reason) ON trustwork.agreement TO trustwork_app;
GRANT UPDATE (transaction_budget_id, approval_refs, notes, updated_by_person_id) ON trustwork.agreement_buyer_private TO trustwork_app;
GRANT UPDATE (fulfilment_plan, notes, updated_by_person_id) ON trustwork.agreement_seller_private TO trustwork_app;
GRANT UPDATE (status, agreement_id, accepted_terms_digest, amount_minor, currency, external_reference, cancelled_reason) ON trustwork.commercial_order TO trustwork_app;
GRANT UPDATE (status, consents, new_agreement_id, delta_reservation_id, decided_by_person_id, decided_reason) ON trustwork.order_change TO trustwork_app;
GRANT UPDATE (status) ON trustwork.obligation TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.quote_side(uuid), trustwork.agreement_side(uuid), trustwork.order_side(uuid),
  trustwork.transactions_rfq_for_share(uuid), trustwork.transactions_quote_for_share(uuid) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
