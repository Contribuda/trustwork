-- BILL-001 billing core (slice B1 of docs/data/migration-plan.md): neutral offers and versioned prices, immutable price
-- acceptances, subscriptions and entitlements, meters and meter rates (AGT-002 contracts), marketplace fee versions
-- (hub.ts, ADR 010 decision 21), usage records, the two budget kinds with atomic reservations, a balanced append-only
-- ledger and capped credit grants.
--
-- Money is integer minor units (bigint) plus an ISO 4217 code; there is no floating point anywhere. Trustwork never
-- holds participants' money (ADR 010 decision 20): nothing here talks to a payment provider or charges anyone; the
-- ledger records budget consumption and obligations, payments and invoices come with BILL-002 and PAY-001.
--
-- Not yet available, so stored as plain uuid columns without a foreign key (documented follow-ups):
--   hub_id            -> hub (slice A1, DATA-003)
--   approval_id       -> second_person_approval (slice A2, DATA-002)
--   action_intent_id  -> action_intent (slice B2, AST-001)
--   case_id           -> support_case (slice A2)
--   payment_id        -> payment (slice B4, BILL-002)
--
-- Authority. Catalogue records (offers, price, plan, meter rate and fee versions) and entitlements, subscriptions,
-- usage, refunds, corrections and credits are written only by the owner-run path (staff commands arrive with the
-- staff roles of DATA-002; the payment path with BILL-002). Triggers enforce the version rules for every role,
-- including maintenance: born as drafts, activated by a person other than the drafter, never back-dated, frozen
-- after activation and never overlapping. The runtime role reads public catalogue rows and its own billing rows under
-- FORCE row-level security, opens billing accounts, accepts prices, cancels subscriptions and works with budgets only
-- through the SECURITY DEFINER commands below, which re-check authority in the database.

-- 0. Party visibility helpers, inlined into policies ---------------------------------------------------------------
-- viewer(p, c):  p is the caller, or c is the caller's active employer and the membership holds company.billing.view
--                or company.billing.manage.
-- manager(p, c): p is the caller, or c is the caller's active employer and the membership holds company.billing.manage.

-- 1. Meters --------------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.meter (
  code text PRIMARY KEY CHECK (code IN ('model_tokens', 'agent_actions', 'checks', 'document_pages', 'deliverables', 'translation_characters', 'retrieval_queries', 'external_calls')),
  unit text NOT NULL CHECK (unit ~ '^[a-z][a-z0-9_]{1,40}$'),
  description_key text NOT NULL CHECK (description_key ~ '^[a-z][A-Za-z0-9_.]{2,120}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Billing accounts ----------------------------------------------------------------------------------------------
CREATE TABLE trustwork.billing_account (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL,
  owner_person_id uuid NULL REFERENCES trustwork.person (id),
  owner_company_id uuid NULL REFERENCES trustwork.company (id),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  tax_registration_id text NULL CHECK (tax_registration_id IS NULL OR length(tax_registration_id) BETWEEN 1 AND 80),
  billing_address jsonb NULL CHECK (billing_address IS NULL OR jsonb_typeof(billing_address) = 'object'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_by uuid NOT NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_account_owner_xor CHECK ((owner_person_id IS NULL) <> (owner_company_id IS NULL))
);
CREATE UNIQUE INDEX billing_account_one_active ON trustwork.billing_account (coalesce(owner_person_id, owner_company_id), hub_id, currency) WHERE status = 'active';
CREATE TRIGGER billing_account_touch BEFORE UPDATE ON trustwork.billing_account FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- 3. Offers and versioned prices -----------------------------------------------------------------------------------
CREATE TABLE trustwork.offer (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,59}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('plan', 'deliverable', 'credit_pack', 'marketplace_fee', 'verification_fee', 'agent_module')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  created_by uuid NOT NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hub_id, code)
);
CREATE TRIGGER offer_touch BEFORE UPDATE ON trustwork.offer FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

CREATE TABLE trustwork.price_version (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  offer_id uuid NOT NULL REFERENCES trustwork.offer (id),
  version integer NOT NULL CHECK (version >= 1),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz NULL,
  acceptance_text_version text NOT NULL CHECK (length(acceptance_text_version) BETWEEN 1 AND 40),
  tax_rule_ref text NULL CHECK (tax_rule_ref IS NULL OR length(tax_rule_ref) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'superseded', 'cancelled')),
  drafted_by uuid NOT NULL REFERENCES trustwork.person (id),
  activated_by uuid NULL REFERENCES trustwork.person (id),
  activated_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (offer_id, version),
  CONSTRAINT price_version_activation_pair CHECK ((activated_by IS NULL) = (activated_at IS NULL)),
  CONSTRAINT price_version_activated_when_live CHECK (status IN ('draft', 'cancelled') OR activated_by IS NOT NULL),
  CONSTRAINT price_version_second_person CHECK (activated_by IS NULL OR activated_by <> drafted_by),
  CONSTRAINT price_version_not_backdated CHECK (activated_at IS NULL OR effective_from > activated_at),
  CONSTRAINT price_version_window CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE TABLE trustwork.subscription_plan_version (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  offer_id uuid NOT NULL REFERENCES trustwork.offer (id),
  version integer NOT NULL CHECK (version >= 1),
  payer_kind text NOT NULL CHECK (payer_kind IN ('person', 'company')),
  -- SubscriptionPlanVersionSchema content (packages/contracts/src/agent-catalog.ts): modules, included quota,
  -- connections, channels, representative; validated by the billing module before insert. Capacity only: no field
  -- may reach ranking, matching, recommendations, reputation, introductions or protection limits.
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  price_version_id uuid NOT NULL REFERENCES trustwork.price_version (id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'superseded', 'cancelled')),
  drafted_by uuid NOT NULL REFERENCES trustwork.person (id),
  activated_by uuid NULL REFERENCES trustwork.person (id),
  activated_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (offer_id, version),
  CONSTRAINT subscription_plan_version_activation_pair CHECK ((activated_by IS NULL) = (activated_at IS NULL)),
  CONSTRAINT subscription_plan_version_activated_when_live CHECK (status IN ('draft', 'cancelled') OR activated_by IS NOT NULL),
  CONSTRAINT subscription_plan_version_second_person CHECK (activated_by IS NULL OR activated_by <> drafted_by),
  CONSTRAINT subscription_plan_version_representative CHECK (NOT coalesce((payload ->> 'representativeIncluded')::boolean, false) OR payer_kind = 'company')
);
CREATE UNIQUE INDEX subscription_plan_version_one_active ON trustwork.subscription_plan_version (offer_id) WHERE status = 'active';

CREATE TABLE trustwork.meter_rate_version (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  meter text NOT NULL REFERENCES trustwork.meter (code),
  provider_class text NULL CHECK (provider_class IS NULL OR provider_class IN ('local', 'in_country', 'hosted_external')),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  price_per_thousand_minor bigint NOT NULL CHECK (price_per_thousand_minor >= 0),
  pass_through boolean NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'superseded', 'cancelled')),
  drafted_by uuid NOT NULL REFERENCES trustwork.person (id),
  activated_by uuid NULL REFERENCES trustwork.person (id),
  activated_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meter_rate_version_activation_pair CHECK ((activated_by IS NULL) = (activated_at IS NULL)),
  CONSTRAINT meter_rate_version_activated_when_live CHECK (status IN ('draft', 'cancelled') OR activated_by IS NOT NULL),
  CONSTRAINT meter_rate_version_second_person CHECK (activated_by IS NULL OR activated_by <> drafted_by),
  CONSTRAINT meter_rate_version_not_backdated CHECK (activated_at IS NULL OR effective_from > activated_at),
  CONSTRAINT meter_rate_version_window CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE UNIQUE INDEX meter_rate_version_number ON trustwork.meter_rate_version (hub_id, meter, coalesce(provider_class, '-'), version);

-- Same shape as MarketplaceFeeVersionSchema (packages/contracts/src/hub.ts). No column can reach ranking, matching,
-- recommendations or reputation; the fee is the same for every participant in a category.
CREATE TABLE trustwork.marketplace_fee_version (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('consultation', 'task', 'ticket', 'course')),
  category_key text NULL CHECK (category_key IS NULL OR category_key ~ '^[a-z][a-z0-9_]{1,60}$'),
  version integer NOT NULL CHECK (version >= 1),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  basis_points integer NULL CHECK (basis_points IS NULL OR basis_points BETWEEN 0 AND 10000),
  fixed_minor bigint NULL CHECK (fixed_minor IS NULL OR fixed_minor >= 0),
  payer text NOT NULL CHECK (payer IN ('buyer', 'seller')),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz NULL,
  acceptance_text_version text NOT NULL CHECK (length(acceptance_text_version) BETWEEN 1 AND 40),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'superseded', 'cancelled')),
  drafted_by uuid NOT NULL REFERENCES trustwork.person (id),
  activated_by uuid NULL REFERENCES trustwork.person (id),
  activated_at timestamptz NULL,
  approval_id uuid NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketplace_fee_version_amount CHECK (basis_points IS NOT NULL OR fixed_minor IS NOT NULL),
  CONSTRAINT marketplace_fee_version_category CHECK (category_key IS NULL OR kind IN ('consultation', 'task')),
  CONSTRAINT marketplace_fee_version_activation_pair CHECK ((activated_by IS NULL) = (activated_at IS NULL)),
  CONSTRAINT marketplace_fee_version_activated_when_live CHECK (status IN ('draft', 'cancelled') OR (activated_by IS NOT NULL AND approval_id IS NOT NULL)),
  CONSTRAINT marketplace_fee_version_second_person CHECK (activated_by IS NULL OR activated_by <> drafted_by),
  CONSTRAINT marketplace_fee_version_not_backdated CHECK (activated_at IS NULL OR effective_from >= activated_at),
  CONSTRAINT marketplace_fee_version_window CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE UNIQUE INDEX marketplace_fee_version_number ON trustwork.marketplace_fee_version (hub_id, kind, coalesce(category_key, '-'), payer, version);

-- One guard for the four version tables. Born as drafts; a draft may be edited, cancelled or activated; activation
-- records a person other than the drafter and stamps activated_at from the clock (never supplied by the caller), so an
-- effective date in the past is refused; an active version is frozen except that it may be end-dated (never into the
-- past) or marked superseded; superseded and cancelled versions never change. Activation is serialized per offer, per
-- meter or per fee scope with an advisory lock and refused when it would overlap another active version.
CREATE FUNCTION trustwork.billing_version_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
  v_key text;
  v_overlap boolean := false;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.activated_by IS NOT NULL OR NEW.activated_at IS NOT NULL THEN
      RAISE EXCEPTION '% rows are created as drafts', TG_TABLE_NAME USING ERRCODE = 'check_violation', HINT = 'billing.version_not_draft';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation', HINT = 'billing.version_frozen';
  END IF;
  v_old := to_jsonb(OLD) - 'revision' - 'updated_at';
  v_new := to_jsonb(NEW) - 'revision' - 'updated_at';
  IF (v_new ->> 'id') <> (v_old ->> 'id') OR (v_new ->> 'drafted_by') <> (v_old ->> 'drafted_by') THEN
    RAISE EXCEPTION 'identity and drafter of % never change', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation', HINT = 'billing.version_frozen';
  END IF;
  IF OLD.status = 'draft' THEN
    IF NEW.status = 'active' THEN
      IF NEW.activated_by IS NULL THEN
        RAISE EXCEPTION 'activation records the activator' USING ERRCODE = 'check_violation', HINT = 'billing.activator_missing';
      END IF;
      IF NEW.activated_by = NEW.drafted_by THEN
        RAISE EXCEPTION 'the activator of a % must differ from its drafter', TG_TABLE_NAME USING ERRCODE = 'check_violation', HINT = 'billing.activator_is_drafter';
      END IF;
      NEW.activated_at := v_now;
      IF TG_TABLE_NAME = 'marketplace_fee_version' AND (v_new ->> 'approval_id') IS NULL THEN
        RAISE EXCEPTION 'fee activation needs a second-person approval' USING ERRCODE = 'check_violation', HINT = 'billing.approval_missing';
      END IF;
      IF TG_TABLE_NAME <> 'subscription_plan_version' THEN
        IF (TG_TABLE_NAME = 'marketplace_fee_version' AND (v_new ->> 'effective_from')::timestamptz < v_now)
           OR (TG_TABLE_NAME <> 'marketplace_fee_version' AND (v_new ->> 'effective_from')::timestamptz <= v_now) THEN
          RAISE EXCEPTION '% cannot take effect before its activation', TG_TABLE_NAME USING ERRCODE = 'check_violation', HINT = 'billing.backdated';
        END IF;
      END IF;
    ELSIF NEW.status = 'cancelled' OR NEW.status = 'draft' THEN
      IF NEW.activated_by IS NOT NULL OR NEW.activated_at IS NOT NULL THEN
        RAISE EXCEPTION 'only activation records an activator' USING ERRCODE = 'check_violation', HINT = 'billing.version_frozen';
      END IF;
    ELSE
      RAISE EXCEPTION 'a draft % cannot become %', TG_TABLE_NAME, NEW.status USING ERRCODE = 'check_violation', HINT = 'billing.invalid_transition';
    END IF;
  ELSIF OLD.status = 'active' THEN
    IF NEW.status NOT IN ('active', 'superseded') THEN
      RAISE EXCEPTION 'an active % can only be superseded', TG_TABLE_NAME USING ERRCODE = 'check_violation', HINT = 'billing.invalid_transition';
    END IF;
    IF (v_new - 'status' - 'effective_to') <> (v_old - 'status' - 'effective_to') THEN
      RAISE EXCEPTION '% is frozen once active', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation', HINT = 'billing.version_frozen';
    END IF;
    IF (v_new -> 'effective_to') IS DISTINCT FROM (v_old -> 'effective_to') THEN
      IF NEW.status = 'active' AND ((v_new ->> 'effective_to') IS NULL
         OR (v_new ->> 'effective_to')::timestamptz < v_now
         OR ((v_old ->> 'effective_to') IS NOT NULL AND (v_new ->> 'effective_to')::timestamptz > (v_old ->> 'effective_to')::timestamptz)) THEN
        RAISE EXCEPTION 'an active % may only be end-dated earlier and never into the past', TG_TABLE_NAME USING ERRCODE = 'check_violation', HINT = 'billing.backdated';
      ELSIF NEW.status <> 'active' THEN
        RAISE EXCEPTION 'end-date an active version before superseding it' USING ERRCODE = 'check_violation', HINT = 'billing.invalid_transition';
      END IF;
    END IF;
  ELSE
    IF v_new <> v_old THEN
      RAISE EXCEPTION '% is frozen once %', TG_TABLE_NAME, OLD.status USING ERRCODE = 'integrity_constraint_violation', HINT = 'billing.version_frozen';
    END IF;
  END IF;

  IF NEW.status = 'active' THEN
    IF TG_TABLE_NAME = 'subscription_plan_version' THEN
      IF NOT EXISTS (SELECT 1 FROM trustwork.price_version p WHERE p.id = (v_new ->> 'price_version_id')::uuid AND p.offer_id = (v_new ->> 'offer_id')::uuid AND p.status = 'active') THEN
        RAISE EXCEPTION 'a plan version is activated with an active price version of the same offer' USING ERRCODE = 'check_violation', HINT = 'billing.price_not_active';
      END IF;
      RETURN NEW;
    END IF;
    v_key := CASE TG_TABLE_NAME
      WHEN 'price_version' THEN 'price:' || (v_new ->> 'offer_id')
      WHEN 'meter_rate_version' THEN 'rate:' || (v_new ->> 'hub_id') || ':' || (v_new ->> 'meter') || ':' || coalesce(v_new ->> 'provider_class', '-')
      ELSE 'fee:' || (v_new ->> 'hub_id') || ':' || (v_new ->> 'kind') || ':' || coalesce(v_new ->> 'category_key', '-') || ':' || (v_new ->> 'payer') END;
    PERFORM pg_advisory_xact_lock(hashtext('trustwork.billing.version'), hashtext(v_key));
    IF TG_TABLE_NAME = 'price_version' THEN
      SELECT EXISTS (SELECT 1 FROM trustwork.price_version o WHERE o.offer_id = NEW.offer_id AND o.id <> NEW.id AND o.status = 'active'
        AND tstzrange(o.effective_from, o.effective_to) && tstzrange(NEW.effective_from, NEW.effective_to)) INTO v_overlap;
    ELSIF TG_TABLE_NAME = 'meter_rate_version' THEN
      SELECT EXISTS (SELECT 1 FROM trustwork.meter_rate_version o WHERE o.hub_id = NEW.hub_id AND o.meter = NEW.meter AND o.provider_class IS NOT DISTINCT FROM NEW.provider_class
        AND o.id <> NEW.id AND o.status = 'active' AND tstzrange(o.effective_from, o.effective_to) && tstzrange(NEW.effective_from, NEW.effective_to)) INTO v_overlap;
    ELSE
      SELECT EXISTS (SELECT 1 FROM trustwork.marketplace_fee_version o WHERE o.hub_id = NEW.hub_id AND o.kind = NEW.kind AND o.category_key IS NOT DISTINCT FROM NEW.category_key
        AND o.payer = NEW.payer AND o.id <> NEW.id AND o.status = 'active' AND tstzrange(o.effective_from, o.effective_to) && tstzrange(NEW.effective_from, NEW.effective_to)) INTO v_overlap;
    END IF;
    IF v_overlap THEN
      RAISE EXCEPTION '% would overlap another active version', TG_TABLE_NAME USING ERRCODE = 'exclusion_violation', HINT = 'billing.version_overlap';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER price_version_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.price_version FOR EACH ROW EXECUTE FUNCTION trustwork.billing_version_guard();
CREATE TRIGGER price_version_touch BEFORE UPDATE ON trustwork.price_version FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
CREATE TRIGGER subscription_plan_version_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.subscription_plan_version FOR EACH ROW EXECUTE FUNCTION trustwork.billing_version_guard();
CREATE TRIGGER subscription_plan_version_touch BEFORE UPDATE ON trustwork.subscription_plan_version FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
CREATE TRIGGER meter_rate_version_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.meter_rate_version FOR EACH ROW EXECUTE FUNCTION trustwork.billing_version_guard();
CREATE TRIGGER meter_rate_version_touch BEFORE UPDATE ON trustwork.meter_rate_version FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
CREATE TRIGGER marketplace_fee_version_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.marketplace_fee_version FOR EACH ROW EXECUTE FUNCTION trustwork.billing_version_guard();
CREATE TRIGGER marketplace_fee_version_touch BEFORE UPDATE ON trustwork.marketplace_fee_version FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- 4. Price acceptance (append-only) --------------------------------------------------------------------------------
CREATE TABLE trustwork.price_acceptance (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  price_version_id uuid NOT NULL REFERENCES trustwork.price_version (id),
  acceptance_text_version text NOT NULL CHECK (length(acceptance_text_version) BETWEEN 1 AND 40),
  billing_account_id uuid NOT NULL REFERENCES trustwork.billing_account (id),
  payer_person_id uuid NULL REFERENCES trustwork.person (id),
  payer_company_id uuid NULL REFERENCES trustwork.company (id),
  accepted_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT price_acceptance_payer_xor CHECK ((payer_person_id IS NULL) <> (payer_company_id IS NULL))
);
CREATE INDEX price_acceptance_account_idx ON trustwork.price_acceptance (billing_account_id, accepted_at DESC);

-- The acceptance binds exactly the version's amount, currency and acceptance text, an active version that has not
-- ended, and the payer's own active billing account in the same currency. The time is the clock's, never the caller's.
CREATE FUNCTION trustwork.billing_acceptance_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_price trustwork.price_version%ROWTYPE;
  v_account trustwork.billing_account%ROWTYPE;
BEGIN
  SELECT * INTO v_price FROM trustwork.price_version WHERE id = NEW.price_version_id;
  IF NOT FOUND OR v_price.status <> 'active' OR (v_price.effective_to IS NOT NULL AND v_price.effective_to <= clock_timestamp()) THEN
    RAISE EXCEPTION 'price version is not open for acceptance' USING ERRCODE = 'check_violation', HINT = 'billing.price_not_active';
  END IF;
  IF NEW.amount_minor <> v_price.amount_minor OR NEW.currency <> v_price.currency OR NEW.acceptance_text_version <> v_price.acceptance_text_version THEN
    RAISE EXCEPTION 'acceptance must bind the exact price version, amount and text' USING ERRCODE = 'check_violation', HINT = 'billing.acceptance_mismatch';
  END IF;
  SELECT * INTO v_account FROM trustwork.billing_account WHERE id = NEW.billing_account_id;
  IF NOT FOUND OR v_account.status <> 'active' OR v_account.owner_person_id IS DISTINCT FROM NEW.payer_person_id OR v_account.owner_company_id IS DISTINCT FROM NEW.payer_company_id THEN
    RAISE EXCEPTION 'the billing account belongs to the payer and is active' USING ERRCODE = 'check_violation', HINT = 'billing.account_mismatch';
  END IF;
  IF v_account.currency <> v_price.currency THEN
    RAISE EXCEPTION 'currency mismatch' USING ERRCODE = 'check_violation', HINT = 'commercial.currency_mismatch';
  END IF;
  NEW.accepted_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER price_acceptance_guard BEFORE INSERT ON trustwork.price_acceptance FOR EACH ROW EXECUTE FUNCTION trustwork.billing_acceptance_guard();
CREATE TRIGGER price_acceptance_append_only BEFORE UPDATE OR DELETE ON trustwork.price_acceptance FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 5. Subscriptions and entitlements --------------------------------------------------------------------------------
CREATE TABLE trustwork.subscription (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  billing_account_id uuid NOT NULL REFERENCES trustwork.billing_account (id),
  offer_id uuid NOT NULL REFERENCES trustwork.offer (id),
  subscription_plan_version_id uuid NULL REFERENCES trustwork.subscription_plan_version (id),
  price_version_id uuid NOT NULL REFERENCES trustwork.price_version (id),
  price_acceptance_id uuid NOT NULL UNIQUE REFERENCES trustwork.price_acceptance (id),
  status text NOT NULL CHECK (status IN ('trial', 'active', 'past_due', 'cancelled', 'ended')),
  current_period_start timestamptz NOT NULL,
  current_period_end timestamptz NOT NULL,
  renews_at timestamptz NULL,
  cancelled_at timestamptz NULL,
  cancelled_by uuid NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_period CHECK (current_period_end > current_period_start),
  CONSTRAINT subscription_cancellation CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL))
);

-- Subscriptions start only on the owner-run path (payment evidence arrives with BILL-002). The acceptance must be the
-- account's own acceptance of the same price version. The runtime role may only cancel, at any time, with no fee.
CREATE FUNCTION trustwork.billing_subscription_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM trustwork.price_acceptance a JOIN trustwork.price_version p ON p.id = a.price_version_id
                   WHERE a.id = NEW.price_acceptance_id AND a.billing_account_id = NEW.billing_account_id AND a.price_version_id = NEW.price_version_id AND p.offer_id = NEW.offer_id) THEN
      RAISE EXCEPTION 'a subscription starts from the account''s acceptance of its price version' USING ERRCODE = 'check_violation', HINT = 'billing.acceptance_mismatch';
    END IF;
    IF NEW.subscription_plan_version_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM trustwork.subscription_plan_version s WHERE s.id = NEW.subscription_plan_version_id AND s.offer_id = NEW.offer_id AND s.price_version_id = NEW.price_version_id) THEN
      RAISE EXCEPTION 'plan version and price version belong together' USING ERRCODE = 'check_violation', HINT = 'billing.acceptance_mismatch';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('cancelled', 'ended') THEN
    RAISE EXCEPTION 'subscription is closed' USING ERRCODE = 'check_violation', HINT = 'billing.invalid_transition';
  END IF;
  IF NOT trustwork.in_maintenance() THEN
    IF NEW.status <> 'cancelled' OR NEW.cancelled_by IS DISTINCT FROM trustwork.current_person_id() THEN
      RAISE EXCEPTION 'participants may only cancel a subscription' USING ERRCODE = 'insufficient_privilege', HINT = 'billing.invalid_transition';
    END IF;
  END IF;
  IF NEW.status = 'cancelled' THEN
    NEW.cancelled_at := clock_timestamp();
    NEW.renews_at := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER subscription_guard BEFORE INSERT OR UPDATE ON trustwork.subscription FOR EACH ROW EXECUTE FUNCTION trustwork.billing_subscription_guard();
CREATE TRIGGER subscription_touch BEFORE UPDATE ON trustwork.subscription FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- Economic rights, separate from roles. Free basic participation needs no row (the billing module grants it to every
-- person and company); rows record trials, subscriptions, credits and sponsorships. Never read by ranking, matching,
-- recommendation or reputation code.
CREATE TABLE trustwork.entitlement (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  billing_account_id uuid NOT NULL REFERENCES trustwork.billing_account (id),
  offer_id uuid NOT NULL REFERENCES trustwork.offer (id),
  subscription_id uuid NULL REFERENCES trustwork.subscription (id),
  module_code text NULL CHECK (module_code IS NULL OR module_code ~ '^[a-z][a-z0-9_]{1,40}$'),
  limits jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(limits) = 'object'),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NULL,
  source text NOT NULL CHECK (source IN ('free_basic', 'trial', 'subscription', 'credit', 'sponsorship')),
  revoked_at timestamptz NULL,
  revoked_reason text NULL CHECK (revoked_reason IS NULL OR length(revoked_reason) BETWEEN 1 AND 500),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entitlement_window CHECK (valid_until IS NULL OR valid_until > valid_from),
  CONSTRAINT entitlement_subscription CHECK (source <> 'subscription' OR subscription_id IS NOT NULL),
  CONSTRAINT entitlement_revocation CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX entitlement_account_idx ON trustwork.entitlement (billing_account_id, valid_from);
CREATE TRIGGER entitlement_touch BEFORE UPDATE ON trustwork.entitlement FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- 6. Budgets, reservations and the ledger --------------------------------------------------------------------------
-- Two kinds: `transaction` pays other participants for goods, works and services; `platform` pays the hub for
-- platform services. One never implies the other: a reservation names the kind it needs and is refused against a
-- budget of the other kind, and there is no fallback between kinds.
CREATE TABLE trustwork.budget (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  kind text NOT NULL CHECK (kind IN ('transaction', 'platform')),
  owner_person_id uuid NULL REFERENCES trustwork.person (id),
  owner_company_id uuid NULL REFERENCES trustwork.company (id),
  project_id uuid NULL REFERENCES trustwork.project (id),
  employee_person_id uuid NULL REFERENCES trustwork.person (id),
  period_from timestamptz NOT NULL,
  period_to timestamptz NOT NULL,
  limit_minor bigint NOT NULL CHECK (limit_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  granted_by uuid NOT NULL REFERENCES trustwork.person (id),
  closed_at timestamptz NULL,
  closed_by uuid NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT budget_owner_xor CHECK ((owner_person_id IS NULL) <> (owner_company_id IS NULL)),
  CONSTRAINT budget_employee_scope CHECK (employee_person_id IS NULL OR owner_company_id IS NOT NULL),
  CONSTRAINT budget_no_self_grant CHECK (employee_person_id IS NULL OR employee_person_id <> granted_by),
  CONSTRAINT budget_period CHECK (period_to > period_from),
  CONSTRAINT budget_closed CHECK ((status = 'closed') = (closed_at IS NOT NULL AND closed_by IS NOT NULL))
);
CREATE INDEX budget_owner_idx ON trustwork.budget (coalesce(owner_person_id, owner_company_id), kind);
CREATE INDEX budget_employee_idx ON trustwork.budget (employee_person_id) WHERE employee_person_id IS NOT NULL;
CREATE TRIGGER budget_touch BEFORE UPDATE ON trustwork.budget FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

CREATE TABLE trustwork.reservation (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  budget_id uuid NOT NULL REFERENCES trustwork.budget (id),
  action_intent_id uuid NOT NULL,
  project_id uuid NULL REFERENCES trustwork.project (id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'settled', 'released', 'expired')),
  settled_minor bigint NULL CHECK (settled_minor IS NULL OR settled_minor >= 0),
  refunded_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  reserved_by uuid NOT NULL REFERENCES trustwork.person (id),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  closed_at timestamptz NULL,
  evidence_ref text NULL CHECK (evidence_ref IS NULL OR length(evidence_ref) BETWEEN 1 AND 200),
  effect_correlation_key text NOT NULL UNIQUE CHECK (length(effect_correlation_key) BETWEEN 1 AND 200),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reservation_settled CHECK ((state = 'settled') = (settled_minor IS NOT NULL)),
  CONSTRAINT reservation_settled_within CHECK (settled_minor IS NULL OR settled_minor <= amount_minor),
  CONSTRAINT reservation_refund_within CHECK (refunded_minor <= coalesce(settled_minor, 0)),
  CONSTRAINT reservation_closed CHECK ((state = 'reserved') = (closed_at IS NULL)),
  CONSTRAINT reservation_evidence CHECK (state IN ('reserved', 'expired') OR evidence_ref IS NOT NULL),
  CONSTRAINT reservation_expiry CHECK (expires_at > reserved_at)
);
CREATE INDEX reservation_budget_open_idx ON trustwork.reservation (budget_id) WHERE state = 'reserved';
CREATE INDEX reservation_expiry_idx ON trustwork.reservation (expires_at) WHERE state = 'reserved';
CREATE TRIGGER reservation_touch BEFORE UPDATE ON trustwork.reservation FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- A reservation leaves `reserved` once (settled, released or expired); afterwards only refunded_minor grows (settled).
CREATE FUNCTION trustwork.billing_reservation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reservations are never deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'billing.reservation_frozen';
  END IF;
  IF NEW.budget_id <> OLD.budget_id OR NEW.action_intent_id <> OLD.action_intent_id OR NEW.amount_minor <> OLD.amount_minor OR NEW.currency <> OLD.currency
     OR NEW.reserved_by <> OLD.reserved_by OR NEW.reserved_at <> OLD.reserved_at OR NEW.expires_at <> OLD.expires_at
     OR NEW.effect_correlation_key <> OLD.effect_correlation_key OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'reservation terms never change' USING ERRCODE = 'integrity_constraint_violation', HINT = 'billing.reservation_frozen';
  END IF;
  IF OLD.state <> 'reserved' THEN
    IF NEW.state <> OLD.state OR NEW.settled_minor IS DISTINCT FROM OLD.settled_minor OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
       OR NEW.evidence_ref IS DISTINCT FROM OLD.evidence_ref OR NEW.refunded_minor < OLD.refunded_minor
       OR (NEW.refunded_minor <> OLD.refunded_minor AND OLD.state <> 'settled') THEN
      RAISE EXCEPTION 'reservation is closed' USING ERRCODE = 'integrity_constraint_violation', HINT = 'billing.reservation_closed';
    END IF;
  ELSIF NEW.refunded_minor <> 0 THEN
    RAISE EXCEPTION 'only settled reservations are refunded' USING ERRCODE = 'integrity_constraint_violation', HINT = 'billing.reservation_not_settled';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reservation_guard BEFORE UPDATE OR DELETE ON trustwork.reservation FOR EACH ROW EXECUTE FUNCTION trustwork.billing_reservation_guard();

-- Append-only, signed, balanced to zero per batch and currency (checked at commit). Corrections are new entries that
-- reverse an earlier entry once. `budget` and `billing_account` entries name their account; `hub_revenue` (what the
-- payer owes the hub for platform services or what a goodwill credit costs it) and `commitment` (what a payer owes
-- another participant outside the platform: Trustwork never holds that money) are aggregate counter-accounts.
CREATE TABLE trustwork.ledger_entry (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  batch_id uuid NOT NULL,
  entry_kind text NOT NULL CHECK (entry_kind IN ('settlement', 'refund', 'correction', 'credit')),
  account_kind text NOT NULL CHECK (account_kind IN ('budget', 'billing_account', 'hub_revenue', 'commitment')),
  account_id uuid NULL,
  owner_person_id uuid NULL REFERENCES trustwork.person (id),
  owner_company_id uuid NULL REFERENCES trustwork.company (id),
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reservation_id uuid NULL REFERENCES trustwork.reservation (id),
  payment_id uuid NULL,
  credit_grant_id uuid NULL,
  correcting_entry_of uuid NULL UNIQUE REFERENCES trustwork.ledger_entry (id),
  reason text NULL CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ledger_entry_owner_xor CHECK ((owner_person_id IS NULL) <> (owner_company_id IS NULL)),
  CONSTRAINT ledger_entry_account CHECK ((account_kind IN ('budget', 'billing_account')) = (account_id IS NOT NULL)),
  CONSTRAINT ledger_entry_correction CHECK ((entry_kind = 'correction') = (correcting_entry_of IS NOT NULL))
);
CREATE INDEX ledger_entry_batch_idx ON trustwork.ledger_entry (batch_id);
CREATE INDEX ledger_entry_account_idx ON trustwork.ledger_entry (account_kind, account_id);
CREATE INDEX ledger_entry_reservation_idx ON trustwork.ledger_entry (reservation_id) WHERE reservation_id IS NOT NULL;
CREATE TRIGGER ledger_entry_append_only BEFORE UPDATE OR DELETE ON trustwork.ledger_entry FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- Deferred balance check. SECURITY DEFINER with the maintenance flag so it sees the whole batch whoever commits; a
-- trigger function cannot be called directly, so the EXECUTE grant (required by the definer allowlist) is inert.
CREATE FUNCTION trustwork.billing_ledger_balanced() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM trustwork.ledger_entry WHERE batch_id = NEW.batch_id GROUP BY currency HAVING sum(amount_minor) <> 0) THEN
    RAISE EXCEPTION 'ledger batch % is not balanced', NEW.batch_id USING ERRCODE = 'check_violation', HINT = 'billing.ledger_unbalanced';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_entry_balanced AFTER INSERT ON trustwork.ledger_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trustwork.billing_ledger_balanced();

-- 7. Usage records and credit grants (append-only) -----------------------------------------------------------------
CREATE TABLE trustwork.usage_record (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  principal_person_id uuid NULL REFERENCES trustwork.person (id),
  principal_company_id uuid NULL REFERENCES trustwork.company (id),
  billing_account_id uuid NOT NULL REFERENCES trustwork.billing_account (id),
  module_key text NOT NULL CHECK (module_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  capability_id text NULL CHECK (capability_id IS NULL OR (capability_id ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$' AND length(capability_id) <= 100)),
  run_id uuid NOT NULL,
  run_step_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  connection_id uuid NULL,
  meter text NOT NULL REFERENCES trustwork.meter (code),
  provider_class text NULL CHECK (provider_class IS NULL OR provider_class IN ('local', 'in_country', 'hosted_external')),
  units bigint NOT NULL CHECK (units >= 0),
  within_included_quota boolean NOT NULL,
  meter_rate_version_id uuid NULL REFERENCES trustwork.meter_rate_version (id),
  reservation_id uuid NULL REFERENCES trustwork.reservation (id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT usage_record_principal_xor CHECK ((principal_person_id IS NULL) <> (principal_company_id IS NULL)),
  CONSTRAINT usage_record_overage_priced CHECK (within_included_quota OR (meter_rate_version_id IS NOT NULL AND reservation_id IS NOT NULL)),
  CONSTRAINT usage_record_idempotent UNIQUE (run_step_id, attempt_id, meter)
);
CREATE INDEX usage_record_account_idx ON trustwork.usage_record (billing_account_id, recorded_at);

-- Usage beyond the included quota is reserved from a platform budget of the same principal, never a transaction one.
CREATE FUNCTION trustwork.billing_usage_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM trustwork.billing_account a WHERE a.id = NEW.billing_account_id
                 AND a.owner_person_id IS NOT DISTINCT FROM NEW.principal_person_id AND a.owner_company_id IS NOT DISTINCT FROM NEW.principal_company_id) THEN
    RAISE EXCEPTION 'usage is recorded on the principal''s billing account' USING ERRCODE = 'check_violation', HINT = 'billing.account_mismatch';
  END IF;
  IF NEW.reservation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM trustwork.reservation r JOIN trustwork.budget b ON b.id = r.budget_id
    WHERE r.id = NEW.reservation_id AND b.kind = 'platform'
      AND b.owner_person_id IS NOT DISTINCT FROM NEW.principal_person_id AND b.owner_company_id IS NOT DISTINCT FROM NEW.principal_company_id) THEN
    RAISE EXCEPTION 'overage is reserved from the principal''s platform budget' USING ERRCODE = 'check_violation', HINT = 'billing.budget_kind_mismatch';
  END IF;
  IF NEW.meter_rate_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM trustwork.meter_rate_version m WHERE m.id = NEW.meter_rate_version_id AND m.meter = NEW.meter AND m.status IN ('active', 'superseded')) THEN
    RAISE EXCEPTION 'overage is priced by an activated rate of the same meter' USING ERRCODE = 'check_violation', HINT = 'billing.price_not_active';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER usage_record_guard BEFORE INSERT ON trustwork.usage_record FOR EACH ROW EXECUTE FUNCTION trustwork.billing_usage_guard();
CREATE TRIGGER usage_record_append_only BEFORE UPDATE OR DELETE ON trustwork.usage_record FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- Goodwill or correction credits: capped by the issuing staff role (cap_check records the role and cap applied),
-- never issued to oneself or one's own employer, never a hidden refund (each grant posts a ledger batch), and never
-- expiring silently: a credit with an end date records the disclosure shown when it was granted.
CREATE TABLE trustwork.credit_grant (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  billing_account_id uuid NOT NULL REFERENCES trustwork.billing_account (id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{1,60}$'),
  issued_by uuid NOT NULL REFERENCES trustwork.person (id),
  cap_check jsonb NOT NULL CHECK (jsonb_typeof(cap_check) = 'object' AND cap_check ? 'roleKey' AND jsonb_typeof(cap_check -> 'capMinor') = 'string'
                                 AND (cap_check ->> 'capMinor') ~ '^(0|[1-9][0-9]{0,17})$'),
  case_id uuid NULL,
  valid_until timestamptz NULL,
  expiry_disclosure_key text NULL CHECK (expiry_disclosure_key IS NULL OR expiry_disclosure_key ~ '^[a-z][A-Za-z0-9_.]{2,120}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT credit_grant_within_cap CHECK (amount_minor <= (cap_check ->> 'capMinor')::bigint),
  CONSTRAINT credit_grant_no_silent_expiry CHECK ((valid_until IS NULL) = (expiry_disclosure_key IS NULL)),
  CONSTRAINT credit_grant_validity CHECK (valid_until IS NULL OR valid_until > created_at)
);
ALTER TABLE trustwork.ledger_entry ADD CONSTRAINT ledger_entry_credit_grant_fk FOREIGN KEY (credit_grant_id) REFERENCES trustwork.credit_grant (id);

CREATE FUNCTION trustwork.billing_credit_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_account trustwork.billing_account%ROWTYPE;
BEGIN
  SELECT * INTO v_account FROM trustwork.billing_account WHERE id = NEW.billing_account_id;
  IF NOT FOUND OR v_account.status <> 'active' THEN
    RAISE EXCEPTION 'credit goes to an active billing account' USING ERRCODE = 'check_violation', HINT = 'billing.account_mismatch';
  END IF;
  IF v_account.currency <> NEW.currency THEN
    RAISE EXCEPTION 'currency mismatch' USING ERRCODE = 'check_violation', HINT = 'commercial.currency_mismatch';
  END IF;
  IF v_account.owner_person_id = NEW.issued_by OR EXISTS (
    SELECT 1 FROM trustwork.membership m WHERE m.person_id = NEW.issued_by AND m.company_id = v_account.owner_company_id AND m.status = 'active') THEN
    RAISE EXCEPTION 'staff never credit themselves or their own employer' USING ERRCODE = 'insufficient_privilege', HINT = 'billing.self_credit';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER credit_grant_guard BEFORE INSERT ON trustwork.credit_grant FOR EACH ROW EXECUTE FUNCTION trustwork.billing_credit_guard();
CREATE TRIGGER credit_grant_append_only BEFORE UPDATE OR DELETE ON trustwork.credit_grant FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 8. Budget arithmetic and owner-run commands ----------------------------------------------------------------------
-- consumed = what settlements took net of refunds and corrections (ledger, budget account);
-- held     = open reservations that have not reached their expiry by the clock.
-- remaining = limit - consumed - held, evaluated under the budget row lock.
CREATE FUNCTION trustwork.billing_budget_committed(p_budget_id uuid, OUT consumed bigint, OUT held bigint)
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT coalesce((SELECT -sum(amount_minor) FROM trustwork.ledger_entry WHERE account_kind = 'budget' AND account_id = p_budget_id), 0)::bigint,
         coalesce((SELECT sum(amount_minor) FROM trustwork.reservation WHERE budget_id = p_budget_id AND state = 'reserved' AND expires_at > clock_timestamp()), 0)::bigint
$$;

-- Internal: posts the two legs of a budget movement (budget account and its counter-account) as one batch.
CREATE FUNCTION trustwork.billing_post_budget_movement(p_budget trustwork.budget, p_reservation_id uuid, p_entry_kind text, p_budget_delta bigint, p_reason text)
RETURNS uuid LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_batch uuid := trustwork.new_uuid();
BEGIN
  IF p_budget_delta = 0 THEN
    RETURN NULL;
  END IF;
  INSERT INTO trustwork.ledger_entry (batch_id, entry_kind, account_kind, account_id, owner_person_id, owner_company_id, amount_minor, currency, reservation_id, reason)
  VALUES (v_batch, p_entry_kind, 'budget', p_budget.id, p_budget.owner_person_id, p_budget.owner_company_id, p_budget_delta, p_budget.currency, p_reservation_id, p_reason),
         (v_batch, p_entry_kind, CASE p_budget.kind WHEN 'platform' THEN 'hub_revenue' ELSE 'commitment' END, NULL, p_budget.owner_person_id, p_budget.owner_company_id,
          -p_budget_delta, p_budget.currency, p_reservation_id, p_reason);
  RETURN v_batch;
END $$;

-- Owner-run: refund part of a settled reservation from provider or staff evidence (never above what was settled).
CREATE FUNCTION trustwork.billing_refund(p_reservation_id uuid, p_amount_minor bigint, p_evidence_ref text)
RETURNS uuid LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_reservation trustwork.reservation%ROWTYPE;
  v_budget trustwork.budget%ROWTYPE;
BEGIN
  IF p_amount_minor IS NULL OR p_amount_minor <= 0 OR coalesce(length(p_evidence_ref), 0) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'refund needs a positive amount and evidence' USING ERRCODE = 'invalid_parameter_value', HINT = 'billing.invalid_amount';
  END IF;
  SELECT * INTO v_reservation FROM trustwork.reservation WHERE id = p_reservation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown reservation' USING ERRCODE = 'no_data_found', HINT = 'access.not_found';
  END IF;
  SELECT * INTO v_budget FROM trustwork.budget WHERE id = v_reservation.budget_id FOR UPDATE;
  SELECT * INTO v_reservation FROM trustwork.reservation WHERE id = p_reservation_id FOR UPDATE;
  IF v_reservation.state <> 'settled' THEN
    RAISE EXCEPTION 'only settled reservations are refunded' USING ERRCODE = 'check_violation', HINT = 'billing.reservation_not_settled';
  END IF;
  IF v_reservation.refunded_minor + p_amount_minor > v_reservation.settled_minor THEN
    RAISE EXCEPTION 'refund exceeds the settled amount' USING ERRCODE = 'check_violation', HINT = 'billing.refund_exceeds_settlement';
  END IF;
  UPDATE trustwork.reservation SET refunded_minor = refunded_minor + p_amount_minor WHERE id = p_reservation_id;
  RETURN trustwork.billing_post_budget_movement(v_budget, p_reservation_id, 'refund', p_amount_minor, p_evidence_ref);
END $$;

-- Owner-run: reverses every entry of a batch once (a correction is a new batch). A reversal that would consume more of
-- a budget than its limit allows is refused: an overrun needs a new approval (a larger budget), never a correction.
CREATE FUNCTION trustwork.billing_correct_batch(p_batch_id uuid, p_reason text)
RETURNS uuid LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_new_batch uuid := trustwork.new_uuid();
  v_budget trustwork.budget%ROWTYPE;
  v_committed record;
  v_count integer;
BEGIN
  IF coalesce(length(p_reason), 0) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'a correction states its reason' USING ERRCODE = 'invalid_parameter_value', HINT = 'billing.reason_missing';
  END IF;
  FOR v_budget IN SELECT b.* FROM trustwork.budget b WHERE b.id IN (SELECT account_id FROM trustwork.ledger_entry WHERE batch_id = p_batch_id AND account_kind = 'budget') ORDER BY b.id FOR UPDATE LOOP
    NULL;
  END LOOP;
  IF EXISTS (SELECT 1 FROM trustwork.ledger_entry e WHERE e.batch_id = p_batch_id AND (e.entry_kind = 'correction' OR EXISTS (SELECT 1 FROM trustwork.ledger_entry c WHERE c.correcting_entry_of = e.id))) THEN
    RAISE EXCEPTION 'batch is a correction or already corrected' USING ERRCODE = 'unique_violation', HINT = 'billing.already_corrected';
  END IF;
  INSERT INTO trustwork.ledger_entry (batch_id, entry_kind, account_kind, account_id, owner_person_id, owner_company_id, amount_minor, currency, reservation_id, payment_id, credit_grant_id, correcting_entry_of, reason)
  SELECT v_new_batch, 'correction', account_kind, account_id, owner_person_id, owner_company_id, -amount_minor, currency, reservation_id, payment_id, credit_grant_id, id, p_reason
  FROM trustwork.ledger_entry WHERE batch_id = p_batch_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'unknown ledger batch' USING ERRCODE = 'no_data_found', HINT = 'access.not_found';
  END IF;
  FOR v_budget IN SELECT b.* FROM trustwork.budget b WHERE b.id IN (SELECT account_id FROM trustwork.ledger_entry WHERE batch_id = v_new_batch AND account_kind = 'budget') LOOP
    SELECT * INTO v_committed FROM trustwork.billing_budget_committed(v_budget.id);
    IF v_committed.consumed + v_committed.held > v_budget.limit_minor THEN
      RAISE EXCEPTION 'correction would overrun the budget' USING ERRCODE = 'check_violation', HINT = 'commercial.budget_insufficient';
    END IF;
  END LOOP;
  RETURN v_new_batch;
END $$;

-- Owner-run sweeper: open reservations past their expiry become `expired` and stop holding budget.
CREATE FUNCTION trustwork.billing_expire_reservations() RETURNS integer
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE trustwork.reservation SET state = 'expired', closed_at = clock_timestamp() WHERE state = 'reserved' AND expires_at <= clock_timestamp();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- Owner-run: a capped goodwill or correction credit with its ledger batch (billing account +, hub revenue -).
CREATE FUNCTION trustwork.billing_grant_credit(p_account_id uuid, p_amount_minor bigint, p_reason_code text, p_issued_by uuid, p_cap_check jsonb, p_case_id uuid, p_valid_until timestamptz, p_expiry_disclosure_key text)
RETURNS uuid LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_account trustwork.billing_account%ROWTYPE;
  v_grant uuid;
  v_batch uuid := trustwork.new_uuid();
BEGIN
  SELECT * INTO v_account FROM trustwork.billing_account WHERE id = p_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown billing account' USING ERRCODE = 'no_data_found', HINT = 'access.not_found';
  END IF;
  INSERT INTO trustwork.credit_grant (billing_account_id, amount_minor, currency, reason_code, issued_by, cap_check, case_id, valid_until, expiry_disclosure_key)
  VALUES (p_account_id, p_amount_minor, v_account.currency, p_reason_code, p_issued_by, p_cap_check, p_case_id, p_valid_until, p_expiry_disclosure_key)
  RETURNING id INTO v_grant;
  INSERT INTO trustwork.ledger_entry (batch_id, entry_kind, account_kind, account_id, owner_person_id, owner_company_id, amount_minor, currency, credit_grant_id, reason)
  VALUES (v_batch, 'credit', 'billing_account', p_account_id, v_account.owner_person_id, v_account.owner_company_id, p_amount_minor, v_account.currency, v_grant, p_reason_code),
         (v_batch, 'credit', 'hub_revenue', NULL, v_account.owner_person_id, v_account.owner_company_id, -p_amount_minor, v_account.currency, v_grant, p_reason_code);
  RETURN v_grant;
END $$;

-- 9. Runtime budget commands (SECURITY DEFINER, allowlisted) -------------------------------------------------------
-- Authority to spend from a budget:
--   personal budget            -> its owner;
--   company budget, employee X -> X while the company is X's active employer;
--   company budget, no employee -> an active member holding company.billing.manage (platform) or
--                                  company.deals.manage (transaction).
-- Transaction authority (deals.manage, a transaction budget) never opens a platform budget and vice versa.
CREATE FUNCTION trustwork.billing_may_spend(p_budget trustwork.budget) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND CASE
    WHEN p_budget.owner_person_id IS NOT NULL THEN p_budget.owner_person_id = trustwork.current_person_id()
    WHEN p_budget.owner_company_id IS DISTINCT FROM trustwork.current_company_id() THEN false
    WHEN p_budget.employee_person_id IS NOT NULL THEN p_budget.employee_person_id = trustwork.current_person_id()
    ELSE trustwork.current_membership_has(CASE p_budget.kind WHEN 'platform' THEN 'company.billing.manage' ELSE 'company.deals.manage' END)
  END
$$;
-- Authority to grant, change or close a budget: the owner person, or a billing manager of the owning company who is
-- not the budget's own employee (no one raises their own allowance).
CREATE FUNCTION trustwork.billing_may_manage_budget(p_budget trustwork.budget) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND CASE
    WHEN p_budget.owner_person_id IS NOT NULL THEN p_budget.owner_person_id = trustwork.current_person_id()
    ELSE p_budget.owner_company_id = trustwork.current_company_id() AND trustwork.current_membership_has('company.billing.manage')
         AND p_budget.employee_person_id IS DISTINCT FROM trustwork.current_person_id()
  END
$$;

CREATE FUNCTION trustwork.billing_grant_budget(p_kind text, p_owner_kind text, p_project_id uuid, p_employee_person_id uuid, p_period_from timestamptz, p_period_to timestamptz, p_limit_minor bigint, p_currency text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_company uuid := trustwork.current_company_id();
  v_id uuid;
BEGIN
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('transaction', 'platform') OR p_owner_kind IS NULL OR p_owner_kind NOT IN ('person', 'company') THEN
    RAISE EXCEPTION 'invalid budget' USING ERRCODE = 'invalid_parameter_value', HINT = 'billing.invalid_budget';
  END IF;
  IF p_owner_kind = 'person' THEN
    IF p_employee_person_id IS NOT NULL THEN
      RAISE EXCEPTION 'employee scope exists only on company budgets' USING ERRCODE = 'invalid_parameter_value', HINT = 'billing.invalid_budget';
    END IF;
  ELSE
    IF v_company IS NULL OR NOT trustwork.current_membership_has('company.billing.manage') THEN
      RAISE EXCEPTION 'permission missing' USING ERRCODE = 'insufficient_privilege', HINT = 'membership.permission_missing';
    END IF;
    IF p_employee_person_id = v_person THEN
      RAISE EXCEPTION 'nobody grants a budget to themselves' USING ERRCODE = 'insufficient_privilege', HINT = 'billing.self_grant';
    END IF;
    IF p_employee_person_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM trustwork.membership m WHERE m.person_id = p_employee_person_id AND m.company_id = v_company AND m.status = 'active' AND m.valid_from <= now()) THEN
      RAISE EXCEPTION 'the employee is not an active member' USING ERRCODE = 'insufficient_privilege', HINT = 'billing.scope_mismatch';
    END IF;
  END IF;
  IF p_project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM trustwork.project p WHERE p.id = p_project_id
      AND CASE p_owner_kind WHEN 'person' THEN p.owner_person_id = v_person ELSE p.owner_company_id = v_company END) THEN
    RAISE EXCEPTION 'project budgets belong to the project owner' USING ERRCODE = 'insufficient_privilege', HINT = 'billing.scope_mismatch';
  END IF;
  INSERT INTO trustwork.budget (kind, owner_person_id, owner_company_id, project_id, employee_person_id, period_from, period_to, limit_minor, currency, granted_by)
  VALUES (p_kind, CASE WHEN p_owner_kind = 'person' THEN v_person END, CASE WHEN p_owner_kind = 'company' THEN v_company END,
          p_project_id, p_employee_person_id, p_period_from, p_period_to, p_limit_minor, p_currency, v_person)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- A new limit is a new approval; it may never fall below what is already consumed or held.
CREATE FUNCTION trustwork.billing_set_budget_limit(p_budget_id uuid, p_limit_minor bigint, p_expected_revision integer)
RETURNS trustwork.budget LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_budget trustwork.budget%ROWTYPE;
  v_committed record;
BEGIN
  IF trustwork.current_person_id() IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  SELECT * INTO v_budget FROM trustwork.budget WHERE id = p_budget_id FOR UPDATE;
  IF NOT FOUND OR NOT (trustwork.billing_may_manage_budget(v_budget) OR trustwork.billing_may_spend(v_budget)) THEN
    RAISE EXCEPTION 'unknown budget' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  IF NOT trustwork.billing_may_manage_budget(v_budget) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = 'insufficient_privilege', HINT = 'billing.self_grant';
  END IF;
  IF v_budget.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'revision conflict' USING ERRCODE = 'serialization_failure', HINT = 'validation.revision_conflict';
  END IF;
  IF v_budget.status <> 'active' THEN
    RAISE EXCEPTION 'budget is closed' USING ERRCODE = 'check_violation', HINT = 'billing.budget_inactive';
  END IF;
  SELECT * INTO v_committed FROM trustwork.billing_budget_committed(p_budget_id);
  IF p_limit_minor IS NULL OR p_limit_minor < v_committed.consumed + v_committed.held THEN
    RAISE EXCEPTION 'limit below what is consumed or held' USING ERRCODE = 'check_violation', HINT = 'billing.limit_below_committed';
  END IF;
  UPDATE trustwork.budget SET limit_minor = p_limit_minor WHERE id = p_budget_id RETURNING * INTO v_budget;
  RETURN v_budget;
END $$;

CREATE FUNCTION trustwork.billing_close_budget(p_budget_id uuid)
RETURNS trustwork.budget LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_budget trustwork.budget%ROWTYPE;
BEGIN
  IF trustwork.current_person_id() IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  SELECT * INTO v_budget FROM trustwork.budget WHERE id = p_budget_id FOR UPDATE;
  IF NOT FOUND OR NOT trustwork.billing_may_manage_budget(v_budget) THEN
    RAISE EXCEPTION 'unknown budget' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  IF v_budget.status = 'closed' THEN
    RETURN v_budget;
  END IF;
  UPDATE trustwork.budget SET status = 'closed', closed_at = clock_timestamp(), closed_by = trustwork.current_person_id() WHERE id = p_budget_id RETURNING * INTO v_budget;
  RETURN v_budget;
END $$;

-- Atomic reservation: the budget row is locked, the kind, period, currency, project scope and spending authority are
-- checked, and the amount must fit limit - consumed - held. Idempotent per effect correlation key (same terms return
-- the existing reservation; different terms are refused).
CREATE FUNCTION trustwork.billing_reserve(p_budget_id uuid, p_kind text, p_amount_minor bigint, p_currency text, p_action_intent_id uuid, p_correlation_key text, p_project_id uuid, p_ttl interval)
RETURNS trustwork.reservation LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_budget trustwork.budget%ROWTYPE;
  v_existing trustwork.reservation%ROWTYPE;
  v_committed record;
  v_now timestamptz;
BEGIN
  IF trustwork.current_person_id() IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  IF p_amount_minor IS NULL OR p_amount_minor <= 0 OR p_ttl IS NULL OR p_ttl < interval '1 second' OR p_ttl > interval '30 days'
     OR p_action_intent_id IS NULL OR coalesce(length(p_correlation_key), 0) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid reservation' USING ERRCODE = 'invalid_parameter_value', HINT = 'billing.invalid_amount';
  END IF;
  SELECT * INTO v_budget FROM trustwork.budget WHERE id = p_budget_id FOR UPDATE;
  IF NOT FOUND OR NOT (trustwork.billing_may_spend(v_budget) OR trustwork.billing_may_manage_budget(v_budget)) THEN
    RAISE EXCEPTION 'unknown budget' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  IF v_budget.kind <> p_kind THEN
    RAISE EXCEPTION 'a % action never spends from a % budget', p_kind, v_budget.kind USING ERRCODE = 'insufficient_privilege', HINT = 'billing.budget_kind_mismatch';
  END IF;
  IF NOT trustwork.billing_may_spend(v_budget) THEN
    RAISE EXCEPTION 'no spending authority on this budget' USING ERRCODE = 'insufficient_privilege', HINT = 'commercial.authority_missing';
  END IF;
  SELECT * INTO v_existing FROM trustwork.reservation WHERE effect_correlation_key = p_correlation_key;
  IF FOUND THEN
    IF v_existing.budget_id = p_budget_id AND v_existing.amount_minor = p_amount_minor AND v_existing.currency = p_currency AND v_existing.action_intent_id = p_action_intent_id THEN
      RETURN v_existing;
    END IF;
    RAISE EXCEPTION 'correlation key already used with other terms' USING ERRCODE = 'unique_violation', HINT = 'validation.idempotency_conflict';
  END IF;
  v_now := clock_timestamp();
  IF v_budget.status <> 'active' OR v_now < v_budget.period_from OR v_now >= v_budget.period_to THEN
    RAISE EXCEPTION 'budget is not open' USING ERRCODE = 'check_violation', HINT = 'billing.budget_inactive';
  END IF;
  IF v_budget.currency <> p_currency THEN
    RAISE EXCEPTION 'currency mismatch' USING ERRCODE = 'check_violation', HINT = 'commercial.currency_mismatch';
  END IF;
  IF v_budget.project_id IS NOT NULL AND v_budget.project_id IS DISTINCT FROM p_project_id THEN
    RAISE EXCEPTION 'budget is scoped to another project' USING ERRCODE = 'insufficient_privilege', HINT = 'billing.scope_mismatch';
  END IF;
  SELECT * INTO v_committed FROM trustwork.billing_budget_committed(p_budget_id);
  IF v_budget.limit_minor - v_committed.consumed - v_committed.held < p_amount_minor THEN
    RAISE EXCEPTION 'budget insufficient' USING ERRCODE = 'check_violation', HINT = 'commercial.budget_insufficient';
  END IF;
  BEGIN
    INSERT INTO trustwork.reservation (budget_id, action_intent_id, project_id, amount_minor, currency, reserved_by, reserved_at, expires_at, effect_correlation_key)
    VALUES (p_budget_id, p_action_intent_id, p_project_id, p_amount_minor, p_currency, trustwork.current_person_id(), v_now, v_now + p_ttl, p_correlation_key)
    RETURNING * INTO v_existing;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'correlation key already used with other terms' USING ERRCODE = 'unique_violation', HINT = 'validation.idempotency_conflict';
  END;
  RETURN v_existing;
END $$;

-- Settlement on the actual amount from outcome evidence; never above the reservation (an overrun needs a new
-- reservation under a new approval). Idempotent for the same amount and evidence.
CREATE FUNCTION trustwork.billing_settle(p_reservation_id uuid, p_actual_minor bigint, p_evidence_ref text)
RETURNS trustwork.reservation LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_reservation trustwork.reservation%ROWTYPE;
  v_budget trustwork.budget%ROWTYPE;
BEGIN
  IF trustwork.current_person_id() IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  IF p_actual_minor IS NULL OR p_actual_minor < 0 OR coalesce(length(p_evidence_ref), 0) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'settlement needs an amount and evidence' USING ERRCODE = 'invalid_parameter_value', HINT = 'billing.invalid_amount';
  END IF;
  SELECT * INTO v_reservation FROM trustwork.reservation WHERE id = p_reservation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown reservation' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  SELECT * INTO v_budget FROM trustwork.budget WHERE id = v_reservation.budget_id FOR UPDATE;
  SELECT * INTO v_reservation FROM trustwork.reservation WHERE id = p_reservation_id FOR UPDATE;
  IF NOT (v_reservation.reserved_by = trustwork.current_person_id() OR trustwork.billing_may_manage_budget(v_budget)) THEN
    RAISE EXCEPTION 'unknown reservation' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  IF v_reservation.state = 'settled' AND v_reservation.settled_minor = p_actual_minor AND v_reservation.evidence_ref = p_evidence_ref THEN
    RETURN v_reservation;
  END IF;
  IF v_reservation.state <> 'reserved' THEN
    RAISE EXCEPTION 'reservation is %', v_reservation.state USING ERRCODE = 'check_violation', HINT = 'billing.reservation_closed';
  END IF;
  IF v_reservation.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'reservation expired' USING ERRCODE = 'check_violation', HINT = 'billing.reservation_expired';
  END IF;
  IF p_actual_minor > v_reservation.amount_minor THEN
    RAISE EXCEPTION 'actual exceeds the reservation; a new approval is needed' USING ERRCODE = 'check_violation', HINT = 'billing.settlement_exceeds_reservation';
  END IF;
  UPDATE trustwork.reservation SET state = 'settled', settled_minor = p_actual_minor, closed_at = clock_timestamp(), evidence_ref = p_evidence_ref
  WHERE id = p_reservation_id RETURNING * INTO v_reservation;
  PERFORM trustwork.billing_post_budget_movement(v_budget, p_reservation_id, 'settlement', -p_actual_minor, p_evidence_ref);
  RETURN v_reservation;
END $$;

CREATE FUNCTION trustwork.billing_release(p_reservation_id uuid, p_evidence_ref text)
RETURNS trustwork.reservation LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_reservation trustwork.reservation%ROWTYPE;
  v_budget trustwork.budget%ROWTYPE;
BEGIN
  IF trustwork.current_person_id() IS NULL THEN
    RAISE EXCEPTION 'principal required' USING ERRCODE = '28000', HINT = 'access.no_principal';
  END IF;
  IF coalesce(length(p_evidence_ref), 0) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'release needs evidence' USING ERRCODE = 'invalid_parameter_value', HINT = 'billing.invalid_amount';
  END IF;
  SELECT * INTO v_reservation FROM trustwork.reservation WHERE id = p_reservation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown reservation' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  SELECT * INTO v_budget FROM trustwork.budget WHERE id = v_reservation.budget_id FOR UPDATE;
  SELECT * INTO v_reservation FROM trustwork.reservation WHERE id = p_reservation_id FOR UPDATE;
  IF NOT (v_reservation.reserved_by = trustwork.current_person_id() OR trustwork.billing_may_manage_budget(v_budget)) THEN
    RAISE EXCEPTION 'unknown reservation' USING ERRCODE = 'insufficient_privilege', HINT = 'access.not_found';
  END IF;
  IF v_reservation.state = 'released' THEN
    RETURN v_reservation;
  END IF;
  IF v_reservation.state <> 'reserved' THEN
    RAISE EXCEPTION 'reservation is %', v_reservation.state USING ERRCODE = 'check_violation', HINT = 'billing.reservation_closed';
  END IF;
  UPDATE trustwork.reservation SET state = 'released', closed_at = clock_timestamp(), evidence_ref = p_evidence_ref WHERE id = p_reservation_id RETURNING * INTO v_reservation;
  RETURN v_reservation;
END $$;

-- 10. Row-level security -------------------------------------------------------------------------------------------
ALTER TABLE trustwork.meter ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.meter FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.billing_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.billing_account FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.offer ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.offer FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.price_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.price_version FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.subscription_plan_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.subscription_plan_version FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.meter_rate_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.meter_rate_version FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.marketplace_fee_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.marketplace_fee_version FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.price_acceptance ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.price_acceptance FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.subscription FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.entitlement ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.entitlement FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.budget FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.reservation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.reservation FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.ledger_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.ledger_entry FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.usage_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.usage_record FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.credit_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.credit_grant FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.meter AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.billing_account AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.offer AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.price_version AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.subscription_plan_version AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.meter_rate_version AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.marketplace_fee_version AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.price_acceptance AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.subscription AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.entitlement AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.budget AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.reservation AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.ledger_entry AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.usage_record AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.credit_grant AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

-- Public catalogue: the published (activated) layer only; drafts and cancelled drafts stay with the hub team.
CREATE POLICY meter_read ON trustwork.meter FOR SELECT TO trustwork_app USING (true);
CREATE POLICY offer_read ON trustwork.offer FOR SELECT TO trustwork_app USING (status IN ('active', 'retired'));
CREATE POLICY price_version_read ON trustwork.price_version FOR SELECT TO trustwork_app USING (status IN ('active', 'superseded'));
CREATE POLICY subscription_plan_version_read ON trustwork.subscription_plan_version FOR SELECT TO trustwork_app USING (status IN ('active', 'superseded'));
CREATE POLICY meter_rate_version_read ON trustwork.meter_rate_version FOR SELECT TO trustwork_app USING (status IN ('active', 'superseded'));
CREATE POLICY marketplace_fee_version_read ON trustwork.marketplace_fee_version FOR SELECT TO trustwork_app USING (status IN ('active', 'superseded'));

-- Private billing rows: the payer and the payer company's billing viewers or managers only (BIL-F17).
CREATE POLICY billing_account_read ON trustwork.billing_account FOR SELECT TO trustwork_app USING (
  coalesce(owner_person_id = trustwork.current_person_id(), false)
  OR (coalesce(owner_company_id = trustwork.current_company_id(), false) AND (trustwork.current_membership_has('company.billing.view') OR trustwork.current_membership_has('company.billing.manage'))));
CREATE POLICY billing_account_insert ON trustwork.billing_account FOR INSERT TO trustwork_app WITH CHECK (
  created_by = trustwork.current_person_id() AND status = 'active'
  AND (coalesce(owner_person_id = trustwork.current_person_id(), false)
       OR (coalesce(owner_company_id = trustwork.current_company_id(), false) AND trustwork.current_membership_has('company.billing.manage'))));
CREATE POLICY billing_account_update ON trustwork.billing_account FOR UPDATE TO trustwork_app
  USING (coalesce(owner_person_id = trustwork.current_person_id(), false)
         OR (coalesce(owner_company_id = trustwork.current_company_id(), false) AND trustwork.current_membership_has('company.billing.manage')))
  WITH CHECK (coalesce(owner_person_id = trustwork.current_person_id(), false)
              OR (coalesce(owner_company_id = trustwork.current_company_id(), false) AND trustwork.current_membership_has('company.billing.manage')));

CREATE POLICY price_acceptance_read ON trustwork.price_acceptance FOR SELECT TO trustwork_app USING (
  coalesce(payer_person_id = trustwork.current_person_id(), false)
  OR (coalesce(payer_company_id = trustwork.current_company_id(), false) AND (trustwork.current_membership_has('company.billing.view') OR trustwork.current_membership_has('company.billing.manage'))));
CREATE POLICY price_acceptance_insert ON trustwork.price_acceptance FOR INSERT TO trustwork_app WITH CHECK (
  accepted_by_person_id = trustwork.current_person_id()
  AND (coalesce(payer_person_id = trustwork.current_person_id(), false)
       OR (coalesce(payer_company_id = trustwork.current_company_id(), false) AND trustwork.current_membership_has('company.billing.manage'))));

CREATE POLICY subscription_read ON trustwork.subscription FOR SELECT TO trustwork_app USING (EXISTS (SELECT 1 FROM trustwork.billing_account a WHERE a.id = billing_account_id));
CREATE POLICY subscription_cancel ON trustwork.subscription FOR UPDATE TO trustwork_app
  USING (EXISTS (SELECT 1 FROM trustwork.billing_account a WHERE a.id = billing_account_id
                 AND (coalesce(a.owner_person_id = trustwork.current_person_id(), false)
                      OR (coalesce(a.owner_company_id = trustwork.current_company_id(), false) AND trustwork.current_membership_has('company.billing.manage')))))
  WITH CHECK (status = 'cancelled');
CREATE POLICY entitlement_read ON trustwork.entitlement FOR SELECT TO trustwork_app USING (EXISTS (SELECT 1 FROM trustwork.billing_account a WHERE a.id = billing_account_id));
CREATE POLICY usage_record_read ON trustwork.usage_record FOR SELECT TO trustwork_app USING (EXISTS (SELECT 1 FROM trustwork.billing_account a WHERE a.id = billing_account_id));
CREATE POLICY credit_grant_read ON trustwork.credit_grant FOR SELECT TO trustwork_app USING (EXISTS (SELECT 1 FROM trustwork.billing_account a WHERE a.id = billing_account_id));
-- Ledger: the owner's billing viewers, plus anyone who sees the reservation an entry belongs to (the scoped employee
-- sees the movements of their own budget, so the remaining balance they are shown is the one the database enforces).
CREATE POLICY ledger_entry_read ON trustwork.ledger_entry FOR SELECT TO trustwork_app USING (
  coalesce(owner_person_id = trustwork.current_person_id(), false)
  OR (coalesce(owner_company_id = trustwork.current_company_id(), false) AND (trustwork.current_membership_has('company.billing.view') OR trustwork.current_membership_has('company.billing.manage')))
  OR (reservation_id IS NOT NULL AND EXISTS (SELECT 1 FROM trustwork.reservation r WHERE r.id = reservation_id)));

-- Budgets: the owner person; for company budgets the billing viewers and managers of the current employer and the
-- scoped employee while employed there. Reservations follow the visibility of their budget.
CREATE POLICY budget_read ON trustwork.budget FOR SELECT TO trustwork_app USING (
  coalesce(owner_person_id = trustwork.current_person_id(), false)
  OR (coalesce(owner_company_id = trustwork.current_company_id(), false)
      AND (coalesce(employee_person_id = trustwork.current_person_id(), false)
           OR trustwork.current_membership_has('company.billing.view') OR trustwork.current_membership_has('company.billing.manage'))));
CREATE POLICY reservation_read ON trustwork.reservation FOR SELECT TO trustwork_app USING (EXISTS (SELECT 1 FROM trustwork.budget b WHERE b.id = budget_id));

GRANT SELECT ON trustwork.meter, trustwork.offer, trustwork.price_version, trustwork.subscription_plan_version, trustwork.meter_rate_version,
  trustwork.marketplace_fee_version, trustwork.billing_account, trustwork.price_acceptance, trustwork.subscription, trustwork.entitlement,
  trustwork.budget, trustwork.reservation, trustwork.ledger_entry, trustwork.usage_record, trustwork.credit_grant TO trustwork_app;
GRANT INSERT ON trustwork.billing_account, trustwork.price_acceptance TO trustwork_app;
GRANT UPDATE (tax_registration_id, billing_address, status) ON trustwork.billing_account TO trustwork_app;
GRANT UPDATE (status, cancelled_by) ON trustwork.subscription TO trustwork_app;

GRANT EXECUTE ON FUNCTION trustwork.billing_grant_budget(text, text, uuid, uuid, timestamptz, timestamptz, bigint, text),
  trustwork.billing_set_budget_limit(uuid, bigint, integer), trustwork.billing_close_budget(uuid),
  trustwork.billing_reserve(uuid, text, bigint, text, uuid, text, uuid, interval), trustwork.billing_settle(uuid, bigint, text),
  trustwork.billing_release(uuid, text), trustwork.billing_ledger_balanced() TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
