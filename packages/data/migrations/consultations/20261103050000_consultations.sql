-- CONS-001: consultations and mentoring from plan items. Consultation offerings on catalogue offerings, the experts'
-- availability windows, consultation requests cut from plan items (or asked directly) with the requester's private
-- half, proposals that become bookings, sessions, deliverables, reminders and mentoring relationships. Agreements are
-- the COM-002 agreement with terms_kind `consultation` (ADR 012 decision 19): offer_ref_id = consultation_booking.id,
-- request_ref_id = consultation_request.id, both digests copied and checked here.
--
-- Mirrors packages/contracts/src/consultations.ts. Authority: the requester is a person (the project owner for a plan
-- item). The expert side is the owner of the catalogue offering: the person, or members of the owning company holding
-- company.deals.manage (company.catalogue.edit to register an offering); the named expert person keeps the
-- availability windows. Every table is under FORCE RLS; nothing is ever deleted.
--
-- Privacy: the expert reads the frozen brief (question, shared materials and the plan fields the requester chose),
-- never the requester's private half (budget ceiling, notes); a site visit's site reaches the expert only through
-- consultation_booking_site() after the booking; a requester sees the expert's free windows and remaining capacity
-- only, never other clients; a deliverable is visible to the two parties unless its author publishes it.
--
-- Money: none. A priced booking records the client's `pay` obligation; charging through a licensed provider is
-- CONS-002 and Trustwork never holds participants' money (ADR 010 decision 20). The hub commission is frozen into the
-- booked terms from the hub's price setting (BILL-003 port in the API). No table, function or ordering here reads a
-- billing table (tests/billing/policy.test.ts).

-- 1. Offerings and availability -----------------------------------------------------------------------------------------
-- A consultation offering extends one catalogue offering of kind `services`; price and options stay in the catalogue's
-- immutable offering_version, which a proposal pins by id and digest.
CREATE TABLE trustwork.consultation_offering (
  offering_id uuid PRIMARY KEY REFERENCES trustwork.offering (id),
  owner_person_id uuid NULL REFERENCES trustwork.person (id),
  owner_company_id uuid NULL REFERENCES trustwork.company (id),
  expert_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  kind text NOT NULL CHECK (kind IN ('session', 'drawing_review', 'quote_review', 'site_visit', 'mentoring')),
  modes text[] NOT NULL CHECK (cardinality(modes) BETWEEN 1 AND 5 AND modes <@ ARRAY['video', 'chat', 'phone', 'in_person', 'async']::text[]),
  topics text[] NOT NULL DEFAULT '{}' CHECK (cardinality(topics) <= 20),
  regions text[] NOT NULL DEFAULT '{}' CHECK (cardinality(regions) <= 50),
  languages text[] NOT NULL CHECK (cardinality(languages) BETWEEN 1 AND 10),
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 15 AND 480),
  deliverable_kind text NOT NULL CHECK (deliverable_kind IN ('written_advice', 'marked_up_document', 'site_report', 'checklist', 'recording')),
  pricing text NOT NULL CHECK (pricing IN ('free', 'fixed', 'hourly')),
  cancellation jsonb NOT NULL CHECK (jsonb_typeof(cancellation) = 'object'),
  licence_required boolean NOT NULL,
  licence_credential_id uuid NULL REFERENCES trustwork.professional_credential (id),
  recording_offered boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'retired')),
  created_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consultation_offering_owner_xor CHECK ((owner_person_id IS NULL) <> (owner_company_id IS NULL)),
  CONSTRAINT consultation_offering_licence CHECK (NOT licence_required OR licence_credential_id IS NOT NULL),
  CONSTRAINT consultation_offering_site_regions CHECK (kind <> 'site_visit' OR cardinality(regions) >= 1)
);
CREATE INDEX consultation_offering_owner_person_idx ON trustwork.consultation_offering (owner_person_id) WHERE owner_person_id IS NOT NULL;
CREATE INDEX consultation_offering_owner_company_idx ON trustwork.consultation_offering (owner_company_id) WHERE owner_company_id IS NOT NULL;
CREATE INDEX consultation_offering_expert_idx ON trustwork.consultation_offering (expert_person_id);
CREATE TRIGGER consultation_offering_touch BEFORE UPDATE ON trustwork.consultation_offering FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- The named expert's own time. Bookings serialize against the window's capacity and the expert's other bookings.
CREATE TABLE trustwork.availability_window (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  expert_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  time_zone text NOT NULL CHECK (time_zone ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+)+$|^UTC$'),
  capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 50),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_window_order CHECK (starts_at < ends_at AND ends_at - starts_at <= interval '14 days')
);
CREATE INDEX availability_window_expert_idx ON trustwork.availability_window (expert_person_id, starts_at);
CREATE TRIGGER availability_window_touch BEFORE UPDATE ON trustwork.availability_window FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- 2. Requests -----------------------------------------------------------------------------------------------------------
-- A request is frozen when sent: the brief (built field by field from the plan item) carries its trustwork-digest-1.
-- The expert and the offering owner are copied from the offering by the guard, so the expert's read policy needs no join.
CREATE TABLE trustwork.consultation_request (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  requester_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  offering_id uuid NOT NULL REFERENCES trustwork.consultation_offering (offering_id),
  offering_owner_person_id uuid NULL REFERENCES trustwork.person (id),
  offering_owner_company_id uuid NULL REFERENCES trustwork.company (id),
  expert_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  project_id uuid NULL REFERENCES trustwork.project (id),
  plan_id uuid NULL,
  plan_version_id uuid NULL REFERENCES trustwork.plan_version (id),
  plan_item_key text NULL CHECK (plan_item_key ~ '^[a-z][a-z0-9_-]{0,63}$'),
  mentoring_relationship_id uuid NULL,
  kind text NOT NULL CHECK (kind IN ('session', 'drawing_review', 'quote_review', 'site_visit', 'mentoring')),
  licence_required boolean NOT NULL,
  terms jsonb NOT NULL CHECK (jsonb_typeof(terms) = 'object'),
  brief jsonb NOT NULL CHECK (jsonb_typeof(brief) = 'object'),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'offered', 'booked', 'withdrawn', 'expired', 'declined')),
  closed_reason text NULL CHECK (length(closed_reason) BETWEEN 1 AND 500),
  sent_via text NOT NULL CHECK (sent_via IN ('person', 'agent')),
  sent_mandate_id text NULL CHECK (sent_mandate_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consultation_request_owner_xor CHECK ((offering_owner_person_id IS NULL) <> (offering_owner_company_id IS NULL)),
  CONSTRAINT consultation_request_plan FOREIGN KEY (plan_id, project_id) REFERENCES trustwork.plan (id, project_id),
  CONSTRAINT consultation_request_plan_item CHECK ((project_id IS NULL) = (plan_item_key IS NULL) AND (project_id IS NULL) = (plan_version_id IS NULL) AND (project_id IS NULL) = (plan_id IS NULL)),
  CONSTRAINT consultation_request_mandate CHECK ((sent_via = 'agent') = (sent_mandate_id IS NOT NULL)),
  CONSTRAINT consultation_request_closed CHECK ((status IN ('withdrawn', 'declined', 'expired')) = (closed_reason IS NOT NULL)),
  CONSTRAINT consultation_request_mentoring CHECK ((kind = 'mentoring') = (mentoring_relationship_id IS NOT NULL))
);
-- A plan item takes one consultation path (the plan item records `consultation` with this request).
CREATE UNIQUE INDEX consultation_request_one_per_plan_item ON trustwork.consultation_request (project_id, plan_item_key) WHERE project_id IS NOT NULL AND status NOT IN ('withdrawn', 'declined', 'expired');
CREATE INDEX consultation_request_requester_idx ON trustwork.consultation_request (requester_person_id);
CREATE INDEX consultation_request_owner_person_idx ON trustwork.consultation_request (offering_owner_person_id) WHERE offering_owner_person_id IS NOT NULL;
CREATE INDEX consultation_request_owner_company_idx ON trustwork.consultation_request (offering_owner_company_id) WHERE offering_owner_company_id IS NOT NULL;
CREATE TRIGGER consultation_request_touch BEFORE UPDATE ON trustwork.consultation_request FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- The requester's party_private half: the budget ceiling an agent never books above, and notes. Never readable by the expert.
CREATE TABLE trustwork.consultation_request_private (
  request_id uuid PRIMARY KEY REFERENCES trustwork.consultation_request (id),
  requester_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  budget_ceiling_minor bigint NULL CHECK (budget_ceiling_minor >= 0),
  budget_ceiling_currency text NULL CHECK (budget_ceiling_currency ~ '^[A-Z]{3}$'),
  requester_notes text NULL CHECK (length(requester_notes) BETWEEN 1 AND 500),
  updated_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consultation_request_private_ceiling CHECK ((budget_ceiling_minor IS NULL) = (budget_ceiling_currency IS NULL))
);
CREATE TRIGGER consultation_request_private_touch BEFORE UPDATE ON trustwork.consultation_request_private FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- 3. Mentoring --------------------------------------------------------------------------------------------------------------
-- Double opt-in between two persons; either side pauses, resumes or ends. Sessions are consultation requests of kind
-- `mentoring` naming the relationship.
CREATE TABLE trustwork.mentoring_relationship (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  mentor_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  mentee_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  proposed_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  topics text[] NOT NULL CHECK (cardinality(topics) BETWEEN 1 AND 10),
  terms text NOT NULL CHECK (terms IN ('free', 'paid')),
  offering_id uuid NULL REFERENCES trustwork.consultation_offering (offering_id),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'active', 'paused', 'declined', 'ended')),
  started_at timestamptz NULL,
  ended_at timestamptz NULL,
  ended_reason text NULL CHECK (length(ended_reason) BETWEEN 1 AND 500),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mentoring_relationship_two_people CHECK (mentor_person_id <> mentee_person_id),
  CONSTRAINT mentoring_relationship_proposer CHECK (proposed_by_person_id IN (mentor_person_id, mentee_person_id)),
  CONSTRAINT mentoring_relationship_paid CHECK ((terms = 'paid') = (offering_id IS NOT NULL)),
  CONSTRAINT mentoring_relationship_ended CHECK ((status IN ('ended', 'declined')) = (ended_at IS NOT NULL) AND (status = 'ended') = (ended_reason IS NOT NULL))
);
CREATE UNIQUE INDEX mentoring_relationship_one_live ON trustwork.mentoring_relationship (mentor_person_id, mentee_person_id) WHERE status IN ('proposed', 'active', 'paused');
CREATE INDEX mentoring_relationship_mentee_idx ON trustwork.mentoring_relationship (mentee_person_id);
CREATE TRIGGER mentoring_relationship_touch BEFORE UPDATE ON trustwork.mentoring_relationship FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
ALTER TABLE trustwork.consultation_request ADD CONSTRAINT consultation_request_relationship FOREIGN KEY (mentoring_relationship_id) REFERENCES trustwork.mentoring_relationship (id);

-- 4. Proposals and bookings -------------------------------------------------------------------------------------------------
-- One row per proposal: frozen and digest-bound from the moment the expert proposes it (price, hub commission, slot,
-- cancellation terms, the pinned catalogue version and the licence label inside `terms`). The client's acceptance is
-- the COM-002 agreement; the expert's confirmation books it and takes capacity.
CREATE TABLE trustwork.consultation_booking (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  request_id uuid NOT NULL REFERENCES trustwork.consultation_request (id),
  offering_id uuid NOT NULL REFERENCES trustwork.consultation_offering (offering_id),
  offering_version_id uuid NOT NULL,
  offering_version integer NOT NULL CHECK (offering_version >= 1),
  offering_version_digest text NOT NULL CHECK (offering_version_digest ~ '^[a-f0-9]{64}$'),
  expert_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  seller_person_id uuid NULL REFERENCES trustwork.person (id),
  seller_company_id uuid NULL REFERENCES trustwork.company (id),
  client_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  kind text NOT NULL CHECK (kind IN ('session', 'drawing_review', 'quote_review', 'site_visit', 'mentoring')),
  mode text NOT NULL CHECK (mode IN ('video', 'chat', 'phone', 'in_person', 'async')),
  window_id uuid NULL REFERENCES trustwork.availability_window (id),
  slot_start timestamptz NULL,
  slot_end timestamptz NULL,
  deliverable_due date NULL,
  terms jsonb NOT NULL CHECK (jsonb_typeof(terms) = 'object'),
  terms_digest text NOT NULL CHECK (terms_digest ~ '^[a-f0-9]{64}$'),
  valid_until timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'booked', 'held', 'delivered', 'accepted', 'cancelled', 'declined', 'withdrawn', 'disputed')),
  agreement_id uuid NULL REFERENCES trustwork.agreement (id),
  recording_consent boolean NOT NULL DEFAULT false,
  closed_reason text NULL CHECK (length(closed_reason) BETWEEN 1 AND 500),
  cancellation_kind text NULL CHECK (cancellation_kind IN ('client', 'expert', 'no_show')),
  cancellation_absent_side text NULL CHECK (cancellation_absent_side IN ('client', 'expert')),
  cancellation_charge_minor bigint NULL CHECK (cancellation_charge_minor >= 0),
  cancellation_charge_currency text NULL CHECK (cancellation_charge_currency ~ '^[A-Z]{3}$'),
  cancelled_at timestamptz NULL,
  cancelled_by_person_id uuid NULL REFERENCES trustwork.person (id),
  booked_at timestamptz NULL,
  proposed_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  proposed_via text NOT NULL CHECK (proposed_via IN ('person', 'agent')),
  proposed_mandate_id text NULL CHECK (proposed_mandate_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consultation_booking_seller_xor CHECK ((seller_person_id IS NULL) <> (seller_company_id IS NULL)),
  CONSTRAINT consultation_booking_offering_version FOREIGN KEY (offering_version_id, offering_id) REFERENCES trustwork.offering_version (id, offering_id),
  CONSTRAINT consultation_booking_slot CHECK ((slot_start IS NULL) = (slot_end IS NULL) AND (slot_start IS NULL) = (window_id IS NULL) AND (slot_start IS NULL OR slot_start < slot_end)),
  CONSTRAINT consultation_booking_sync CHECK ((mode = 'async') = (slot_start IS NULL) AND (mode = 'async') = (deliverable_due IS NOT NULL)),
  CONSTRAINT consultation_booking_site_visit CHECK (kind <> 'site_visit' OR mode = 'in_person'),
  CONSTRAINT consultation_booking_mandate CHECK ((proposed_via = 'agent') = (proposed_mandate_id IS NOT NULL)),
  CONSTRAINT consultation_booking_closed CHECK ((status IN ('declined', 'withdrawn', 'cancelled')) = (closed_reason IS NOT NULL)),
  CONSTRAINT consultation_booking_cancelled CHECK ((status = 'cancelled') = (cancellation_kind IS NOT NULL) AND (status = 'cancelled') = (cancelled_at IS NOT NULL)
    AND (status = 'cancelled') = (cancelled_by_person_id IS NOT NULL) AND coalesce(cancellation_kind = 'no_show', false) = (cancellation_absent_side IS NOT NULL)
    AND (cancellation_charge_minor IS NULL) = (cancellation_charge_currency IS NULL)),
  CONSTRAINT consultation_booking_booked CHECK ((status IN ('booked', 'held', 'delivered', 'accepted', 'disputed') OR (status = 'cancelled' AND booked_at IS NOT NULL)) = (booked_at IS NOT NULL))
);
-- One open proposal per request at a time; one booking per agreement.
CREATE UNIQUE INDEX consultation_booking_one_proposal ON trustwork.consultation_booking (request_id) WHERE status = 'proposed';
CREATE UNIQUE INDEX consultation_booking_agreement ON trustwork.consultation_booking (agreement_id) WHERE agreement_id IS NOT NULL;
CREATE INDEX consultation_booking_window_idx ON trustwork.consultation_booking (window_id) WHERE window_id IS NOT NULL;
CREATE INDEX consultation_booking_expert_idx ON trustwork.consultation_booking (expert_person_id, slot_start);
CREATE INDEX consultation_booking_client_idx ON trustwork.consultation_booking (client_person_id);
CREATE INDEX consultation_booking_seller_person_idx ON trustwork.consultation_booking (seller_person_id) WHERE seller_person_id IS NOT NULL;
CREATE INDEX consultation_booking_seller_company_idx ON trustwork.consultation_booking (seller_company_id) WHERE seller_company_id IS NOT NULL;
CREATE TRIGGER consultation_booking_touch BEFORE UPDATE ON trustwork.consultation_booking FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- 5. Sessions, deliverables and reminders ---------------------------------------------------------------------------------
-- Opened with the booking: a site visit records when its site was revealed to the expert. Times are recorded once.
CREATE TABLE trustwork.consultation_session (
  booking_id uuid PRIMARY KEY REFERENCES trustwork.consultation_booking (id),
  started_at timestamptz NULL,
  ended_at timestamptz NULL,
  attendance jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attendance) = 'object'),
  meeting_link_ref text NULL CHECK (length(meeting_link_ref) BETWEEN 1 AND 200),
  site_address_revealed_at timestamptz NULL,
  recorded_by_person_id uuid NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consultation_session_times CHECK ((started_at IS NULL) = (ended_at IS NULL) AND (started_at IS NULL) = (recorded_by_person_id IS NULL) AND (started_at IS NULL OR started_at < ended_at))
);
CREATE TRIGGER consultation_session_touch BEFORE UPDATE ON trustwork.consultation_session FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- The expert's work product. Delivery is an EXE-001 execution claim (`service_delivered` on the expert's perform
-- obligation), acceptance the client's EXE-001 confirmation: separate, append-only records. The content never changes;
-- only the decision link (once, by the client) and the author's publication (once) are recorded here.
CREATE TABLE trustwork.consultation_deliverable (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  booking_id uuid NOT NULL REFERENCES trustwork.consultation_booking (id),
  agreement_id uuid NOT NULL REFERENCES trustwork.agreement (id),
  kind text NOT NULL CHECK (kind IN ('written_advice', 'marked_up_document', 'site_report', 'checklist', 'recording')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attachments) = 'array' AND jsonb_array_length(attachments) <= 20),
  claim_id uuid NOT NULL UNIQUE REFERENCES trustwork.execution_claim (id),
  author_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  seller_person_id uuid NULL REFERENCES trustwork.person (id),
  seller_company_id uuid NULL REFERENCES trustwork.company (id),
  client_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  delivered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  confirmation_id uuid NULL UNIQUE REFERENCES trustwork.execution_confirmation (id),
  decision text NULL CHECK (decision IN ('accepted', 'rejected')),
  decided_at timestamptz NULL,
  published_at timestamptz NULL,
  CONSTRAINT consultation_deliverable_seller_xor CHECK ((seller_person_id IS NULL) <> (seller_company_id IS NULL)),
  CONSTRAINT consultation_deliverable_decision CHECK ((confirmation_id IS NULL) = (decision IS NULL) AND (decision IS NULL) = (decided_at IS NULL))
);
CREATE INDEX consultation_deliverable_booking_idx ON trustwork.consultation_deliverable (booking_id, delivered_at);
CREATE INDEX consultation_deliverable_published_idx ON trustwork.consultation_deliverable (published_at) WHERE published_at IS NOT NULL;

-- Reminders a day and an hour before a booked slot, posted to the booking's agreement thread (COMMS-001) by the
-- delivery job; cancelled with the booking.
CREATE TABLE trustwork.consultation_reminder (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  booking_id uuid NOT NULL REFERENCES trustwork.consultation_booking (id),
  agreement_id uuid NOT NULL REFERENCES trustwork.agreement (id),
  remind_at timestamptz NOT NULL,
  offset_minutes integer NOT NULL CHECK (offset_minutes BETWEEN 1 AND 10080),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled', 'sent')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consultation_reminder_once UNIQUE (booking_id, offset_minutes)
);
CREATE INDEX consultation_reminder_due_idx ON trustwork.consultation_reminder (remind_at) WHERE status = 'scheduled';
CREATE TRIGGER consultation_reminder_touch BEFORE UPDATE ON trustwork.consultation_reminder FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- 6. Access helpers -----------------------------------------------------------------------------------------------------------
-- 'client' or 'expert' for the principal on a booking, otherwise NULL. Owner-run so that policies on sessions,
-- deliverables and reminders can read the booking without recursion.
CREATE FUNCTION trustwork.consultation_booking_side(p_booking_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT CASE
    WHEN trustwork.current_person_id() IS NULL THEN NULL
    WHEN b.client_person_id = trustwork.current_person_id() THEN 'client'
    WHEN trustwork.commerce_party_acts(b.seller_person_id, b.seller_company_id, 'company.deals.manage') THEN 'expert'
  END
  FROM trustwork.consultation_booking b WHERE b.id = p_booking_id
$$;

-- Facts of an active or paused offering any signed-in person may rely on (the terms the public page shows anyway);
-- guards and the requester read them here because the offering row itself is the owner's.
CREATE FUNCTION trustwork.consultation_offering_facts(p_offering_id uuid)
RETURNS TABLE (offering_id uuid, owner_person_id uuid, owner_company_id uuid, expert_person_id uuid, kind text, status text, licence_required boolean, licence_credential_id uuid,
  modes text[], regions text[], duration_minutes integer, pricing text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT o.offering_id, o.owner_person_id, o.owner_company_id, o.expert_person_id, o.kind, o.status, o.licence_required, o.licence_credential_id, o.modes, o.regions, o.duration_minutes, o.pricing
  FROM trustwork.consultation_offering o
  WHERE trustwork.current_person_id() IS NOT NULL AND o.offering_id = p_offering_id AND o.status <> 'retired'
$$;

-- Whether a recorded licence may back advice now: the expert's own current (not superseded) licence, not revoked or
-- suspended by the register, not expired by its stated or the register's date (mirrors credentialStatus in
-- packages/contracts/src/reputation-builder.ts). Checked or self-declared both pass; the label says which.
CREATE FUNCTION trustwork.consultation_licence_usable(p_credential_id uuid, p_expert uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  -- Checks and superseding credentials hold an FK KEY SHARE lock on this row. FOR UPDATE serializes a
  -- commitment with either append, including an insert that is not committed yet; read the facts after it.
  PERFORM 1 FROM trustwork.professional_credential WHERE id = p_credential_id FOR UPDATE;
  RETURN coalesce((
    SELECT c.kind = 'licence' AND c.holder_person_id = p_expert
       AND NOT EXISTS (SELECT 1 FROM trustwork.professional_credential s WHERE s.supersedes_id = c.id)
       AND (c.valid_until IS NULL OR c.valid_until >= current_date)
       AND coalesce(last.outcome NOT IN ('revoked', 'suspended'), true)
       AND NOT (last.outcome = 'match' AND last.register_valid_until IS NOT NULL AND last.register_valid_until < current_date)
    FROM trustwork.professional_credential c
    LEFT JOIN LATERAL (SELECT k.outcome, k.register_valid_until FROM trustwork.credential_check k WHERE k.credential_id = c.id ORDER BY k.checked_at DESC, k.id DESC LIMIT 1) last ON true
    WHERE c.id = p_credential_id), false);
END $$;

-- The facts behind a licence label (never the number): shown publicly with an active offering (anonymous callers
-- too), and to signed-in people for offerings and proposals of that expert.
CREATE FUNCTION trustwork.consultation_credential_facts(p_offering_id uuid)
RETURNS TABLE (credential_id uuid, jurisdiction text, credential_type text, valid_until date, last_outcome text, register_valid_until date, checked_at timestamptz, superseded boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT c.id, c.jurisdiction, c.credential_type, c.valid_until, last.outcome, last.register_valid_until, last.checked_at,
         EXISTS (SELECT 1 FROM trustwork.professional_credential s WHERE s.supersedes_id = c.id)
  FROM trustwork.consultation_offering o
  JOIN trustwork.professional_credential c ON c.id = o.licence_credential_id AND c.kind = 'licence' AND c.holder_person_id = o.expert_person_id
  LEFT JOIN LATERAL (SELECT k.outcome, k.register_valid_until, k.checked_at FROM trustwork.credential_check k WHERE k.credential_id = c.id ORDER BY k.checked_at DESC, k.id DESC LIMIT 1) last ON true
  WHERE o.offering_id = p_offering_id AND (o.status = 'active' OR trustwork.current_person_id() IS NOT NULL)
$$;

-- The catalogue version a proposal pins: the current published version of the offering, for the expert side
-- (deal managers may propose without the catalogue editing permission).
CREATE FUNCTION trustwork.consultation_current_version(p_offering_id uuid)
RETURNS TABLE (version_id uuid, version integer, digest text, payload jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT v.id, v.version, v.digest, v.payload
  FROM trustwork.consultation_offering co
  JOIN trustwork.offering o ON o.id = co.offering_id AND o.status = 'active'
  JOIN trustwork.offering_version v ON v.id = o.current_version_id AND v.status = 'published'
  WHERE co.offering_id = p_offering_id
    AND (trustwork.commerce_party_acts(co.owner_person_id, co.owner_company_id, 'company.deals.manage') OR trustwork.commerce_party_acts(co.owner_person_id, co.owner_company_id, 'company.catalogue.edit'))
$$;

-- Public offerings: active consultation offerings with their terms and only the catalogue fields the owner made
-- public; anonymous callers may use it. Newest first, then by id: nothing about payment exists to order by.
CREATE FUNCTION trustwork.consultation_public_offerings(p_owner_person_id uuid, p_owner_company_id uuid, p_offering_id uuid)
RETURNS TABLE (offering_id uuid, owner_person_id uuid, owner_company_id uuid, kind text, modes text[], topics text[], regions text[], languages text[], duration_minutes integer,
  deliverable_kind text, pricing text, title text, list_price jsonb, credential_id uuid, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT co.offering_id, co.owner_person_id, co.owner_company_id, co.kind, co.modes, co.topics, co.regions, co.languages, co.duration_minutes, co.deliverable_kind, co.pricing,
         CASE WHEN 'title' = ANY (v.public_fields) THEN v.payload ->> 'title' END,
         CASE WHEN 'listPrice' = ANY (v.public_fields) THEN v.payload -> 'listPrice' END,
         co.licence_credential_id, co.created_at
  FROM trustwork.consultation_offering co
  JOIN trustwork.offering o ON o.id = co.offering_id AND o.status = 'active'
  JOIN trustwork.offering_version v ON v.id = o.current_version_id
  WHERE co.status = 'active'
    AND (p_owner_person_id IS NULL OR co.owner_person_id = p_owner_person_id)
    AND (p_owner_company_id IS NULL OR co.owner_company_id = p_owner_company_id)
    AND (p_offering_id IS NULL OR co.offering_id = p_offering_id)
    AND num_nonnulls(p_owner_person_id, p_owner_company_id, p_offering_id) >= 1
  ORDER BY co.created_at DESC, co.offering_id
$$;

-- A window's facts for the expert and for the expert side of any offering naming that expert (a company's deal
-- managers propose slots of their named expert); nothing for anyone else.
CREATE FUNCTION trustwork.consultation_window_facts(p_window_id uuid)
RETURNS TABLE (window_id uuid, expert_person_id uuid, starts_at timestamptz, ends_at timestamptz, time_zone text, capacity integer, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT w.id, w.expert_person_id, w.starts_at, w.ends_at, w.time_zone, w.capacity, w.status
  FROM trustwork.availability_window w
  WHERE w.id = p_window_id AND trustwork.current_person_id() IS NOT NULL
    AND (w.expert_person_id = trustwork.current_person_id() OR EXISTS (
      SELECT 1 FROM trustwork.consultation_offering o WHERE o.expert_person_id = w.expert_person_id AND trustwork.commerce_party_acts(o.owner_person_id, o.owner_company_id, 'company.deals.manage')))
$$;

-- Live bookings (holding capacity and the expert's time).
CREATE FUNCTION trustwork.consultation_booking_live(p_status text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT p_status IN ('booked', 'held', 'delivered', 'accepted', 'disputed')
$$;

-- The free windows of the addressed expert for a requester of a live request: start, end, time zone and remaining
-- capacity, nothing about other clients or their bookings.
CREATE FUNCTION trustwork.consultation_free_windows(p_request_id uuid)
RETURNS TABLE (window_id uuid, starts_at timestamptz, ends_at timestamptz, time_zone text, remaining integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT w.id, w.starts_at, w.ends_at, w.time_zone,
         w.capacity - (SELECT count(*)::integer FROM trustwork.consultation_booking b WHERE b.window_id = w.id AND trustwork.consultation_booking_live(b.status))
  FROM trustwork.consultation_request r
  JOIN trustwork.availability_window w ON w.expert_person_id = r.expert_person_id AND w.status = 'open' AND w.ends_at > now()
  WHERE r.id = p_request_id AND r.requester_person_id = trustwork.current_person_id() AND r.status IN ('requested', 'offered')
    AND w.capacity > (SELECT count(*) FROM trustwork.consultation_booking b WHERE b.window_id = w.id AND trustwork.consultation_booking_live(b.status))
  ORDER BY w.starts_at, w.id
  LIMIT 100
$$;

-- Booked counts of the caller's own windows.
CREATE FUNCTION trustwork.consultation_window_booked(p_window_id uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT count(*)::integer FROM trustwork.consultation_booking b JOIN trustwork.availability_window w ON w.id = b.window_id
  WHERE b.window_id = p_window_id AND w.expert_person_id = trustwork.current_person_id() AND trustwork.consultation_booking_live(b.status)
$$;

-- Capacity, serialized: called by the booking guard when a proposal becomes a booking. The expert's bookings are
-- serialized by a transaction lock on the expert, the window row is locked, and then (each statement seeing the latest
-- committed rows) the window must be open and cover the slot, have capacity left, and the expert must have no other live
-- synchronous booking overlapping the slot. Returns NULL when the booking fits, otherwise the reason.
CREATE FUNCTION trustwork.consultation_reserve_capacity(p_booking_id uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  b trustwork.consultation_booking%ROWTYPE;
  w trustwork.availability_window%ROWTYPE;
  v_live integer;
BEGIN
  SELECT * INTO b FROM trustwork.consultation_booking WHERE id = p_booking_id;
  IF b.id IS NULL OR NOT trustwork.commerce_party_acts(b.seller_person_id, b.seller_company_id, 'company.deals.manage') THEN
    RETURN 'not_authorised';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('trustwork.consultation.expert:' || b.expert_person_id::text, 0));
  IF b.window_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO w FROM trustwork.availability_window WHERE id = b.window_id FOR UPDATE;
  IF w.status <> 'open' OR w.expert_person_id <> b.expert_person_id OR b.slot_start < w.starts_at OR b.slot_end > w.ends_at THEN
    RETURN 'slot_unavailable';
  END IF;
  SELECT count(*)::integer INTO v_live FROM trustwork.consultation_booking x WHERE x.window_id = w.id AND x.id <> b.id AND trustwork.consultation_booking_live(x.status);
  IF v_live >= w.capacity THEN
    RETURN 'capacity_exhausted';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.consultation_booking x
             WHERE x.expert_person_id = b.expert_person_id AND x.id <> b.id AND x.slot_start IS NOT NULL AND trustwork.consultation_booking_live(x.status)
               AND tstzrange(x.slot_start, x.slot_end) && tstzrange(b.slot_start, b.slot_end)) THEN
    RETURN 'slot_overlaps';
  END IF;
  RETURN NULL;
END $$;

-- The site of a booked site visit (region, address, contact, access notes) for its two parties; nothing before the
-- booking, nothing for other kinds, nothing once it was cancelled or declined.
CREATE FUNCTION trustwork.consultation_booking_site(p_booking_id uuid)
RETURNS TABLE (region_code text, address jsonb, site_contact jsonb, site_access_notes text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT l.region_code, l.address, l.site_contact, l.site_access_notes
  FROM trustwork.consultation_booking b
  JOIN trustwork.consultation_request r ON r.id = b.request_id
  JOIN trustwork.project_location l ON l.project_id = r.project_id
  WHERE b.id = p_booking_id AND b.kind = 'site_visit' AND b.status IN ('booked', 'held', 'delivered', 'accepted', 'disputed')
    AND (b.client_person_id = trustwork.current_person_id() OR trustwork.commerce_party_acts(b.seller_person_id, b.seller_company_id, 'company.deals.manage'))
$$;

-- Published deliverables, publicly: the author's own work (title, body, kinds, author party, date), never the client,
-- the project, the booking terms or attachments. Anonymous callers may use it.
CREATE FUNCTION trustwork.consultation_public_deliverable(p_deliverable_id uuid)
RETURNS TABLE (deliverable_id uuid, kind text, consultation_kind text, title text, body text, author_person_id uuid, author_company_id uuid, published_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT d.id, d.kind, b.kind, d.title, d.body, d.seller_person_id, d.seller_company_id, d.published_at
  FROM trustwork.consultation_deliverable d JOIN trustwork.consultation_booking b ON b.id = d.booking_id
  WHERE d.id = p_deliverable_id AND d.published_at IS NOT NULL
$$;

-- Requests move with their proposals and bookings (the request belongs to the requester; the expert's statement
-- cannot update it). The request guard checks the facts behind each move.
CREATE FUNCTION trustwork.consultation_booking_sync_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_next text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  END IF;
  v_next := CASE
    WHEN NEW.status = 'proposed' THEN 'offered'
    WHEN NEW.status = 'booked' AND (TG_OP = 'INSERT' OR OLD.status = 'proposed') THEN 'booked'
    WHEN NEW.status IN ('withdrawn', 'declined', 'cancelled') THEN 'requested'
  END;
  IF v_next IS NOT NULL THEN
    UPDATE trustwork.consultation_request SET status = v_next WHERE id = NEW.request_id AND status IN ('requested', 'offered', 'booked') AND status <> v_next;
  END IF;
  RETURN NULL;
END $$;

-- 7. Guards ------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION trustwork.consultation_offering_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_offering trustwork.offering%ROWTYPE;
  v_region text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'consultation offerings are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  IF NOT trustwork.commerce_party_acts(coalesce(NEW.owner_person_id, OLD.owner_person_id), coalesce(NEW.owner_company_id, OLD.owner_company_id), 'company.catalogue.edit') THEN
    RAISE EXCEPTION 'the offering owner registers its consultations' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
  END IF;
  FOREACH v_region IN ARRAY NEW.regions LOOP
    IF trustwork.commerce_region_restricted(v_region) THEN
      RAISE EXCEPTION 'a restricted place is never served' USING ERRCODE = 'check_violation', HINT = 'commerce.restricted_place';
    END IF;
  END LOOP;
  IF NEW.licence_credential_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM trustwork.professional_credential c WHERE c.id = NEW.licence_credential_id AND c.kind = 'licence' AND c.holder_person_id = NEW.expert_person_id
  ) THEN
    RAISE EXCEPTION 'the licence is a licence credential of the expert' USING ERRCODE = 'check_violation', HINT = 'consultations.licence_not_recorded';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO v_offering FROM trustwork.offering WHERE id = NEW.offering_id;
    IF v_offering.id IS NULL OR v_offering.kind <> 'services' OR v_offering.status <> 'active'
       OR NEW.owner_person_id IS DISTINCT FROM v_offering.owner_person_id OR NEW.owner_company_id IS DISTINCT FROM v_offering.owner_company_id THEN
      RAISE EXCEPTION 'a consultation is an active services offering of its owner' USING ERRCODE = 'check_violation', HINT = 'consultations.offering_not_services';
    END IF;
    IF NEW.created_by_person_id IS DISTINCT FROM trustwork.current_person_id() OR NEW.expert_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
      RAISE EXCEPTION 'the expert registers itself' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION 'an offering starts active' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.offering_id <> OLD.offering_id OR NEW.owner_person_id IS DISTINCT FROM OLD.owner_person_id OR NEW.owner_company_id IS DISTINCT FROM OLD.owner_company_id
     OR NEW.expert_person_id <> OLD.expert_person_id OR NEW.kind <> OLD.kind OR NEW.created_by_person_id <> OLD.created_by_person_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'offering identity is immutable' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF OLD.status = 'retired' THEN
    RAISE EXCEPTION 'a retired offering stays retired' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consultation_offering_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.consultation_offering FOR EACH ROW EXECUTE FUNCTION trustwork.consultation_offering_guard();

CREATE FUNCTION trustwork.availability_window_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'windows are closed, not deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  IF coalesce(NEW.expert_person_id = trustwork.current_person_id(), false) IS NOT TRUE THEN
    RAISE EXCEPTION 'the expert keeps its own windows' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.ends_at <= now() THEN
      RAISE EXCEPTION 'a window opens for future time' USING ERRCODE = 'check_violation', HINT = 'consultations.window_in_past';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.expert_person_id <> OLD.expert_person_id OR NEW.starts_at <> OLD.starts_at OR NEW.ends_at <> OLD.ends_at OR NEW.time_zone <> OLD.time_zone
     OR NEW.capacity <> OLD.capacity OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a window never changes; close it and open another' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'open' AND NEW.status = 'closed') THEN
    RAISE EXCEPTION 'a closed window stays closed' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER availability_window_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.availability_window FOR EACH ROW EXECUTE FUNCTION trustwork.availability_window_guard();

-- Requests: a person asks one active offering; for a plan item, of its own person-owned project's approved plan; the
-- expert and offering owner come from the offering; licence and mentoring rules hold. Afterwards only the status moves:
-- the requester withdraws, the expert side declines, and proposals and bookings move it (owner-run, facts checked).
CREATE FUNCTION trustwork.consultation_request_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  f record;
  v_live_proposal boolean;
  v_live_booking boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'requests are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.requester_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
      RAISE EXCEPTION 'a person asks for itself' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    SELECT * INTO f FROM trustwork.consultation_offering_facts(NEW.offering_id);
    IF f.offering_id IS NULL OR f.status <> 'active' THEN
      RAISE EXCEPTION 'the offering is not open for requests' USING ERRCODE = 'check_violation', HINT = 'consultations.offering_unavailable';
    END IF;
    NEW.offering_owner_person_id := f.owner_person_id;
    NEW.offering_owner_company_id := f.owner_company_id;
    NEW.expert_person_id := f.expert_person_id;
    IF NEW.requester_person_id = f.expert_person_id OR NEW.requester_person_id IS NOT DISTINCT FROM f.owner_person_id
       OR (f.owner_company_id IS NOT NULL AND trustwork.commerce_party_acts(NULL, f.owner_company_id, 'company.deals.manage')) THEN
      RAISE EXCEPTION 'nobody asks itself' USING ERRCODE = 'check_violation', HINT = 'commerce.self_invitation';
    END IF;
    IF NEW.kind <> f.kind THEN
      RAISE EXCEPTION 'the request asks for the kind the offering gives' USING ERRCODE = 'check_violation', HINT = 'consultations.kind_mismatch';
    END IF;
    IF NEW.project_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM trustwork.project p WHERE p.id = NEW.project_id AND p.owner_person_id = NEW.requester_person_id) THEN
        RAISE EXCEPTION 'a plan item becomes a consultation of its own person owner' USING ERRCODE = 'check_violation', HINT = 'commerce.plan_item_path';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM trustwork.plan pl JOIN trustwork.plan_item i ON i.plan_version_id = pl.current_version_id
        WHERE pl.id = NEW.plan_id AND pl.project_id = NEW.project_id AND pl.current_version_id = NEW.plan_version_id AND i.item_key = NEW.plan_item_key
          AND i.kind IN ('consultation', 'task', 'phase', 'decision', 'permit', 'inspection', 'purchase', 'material')
      ) THEN
        RAISE EXCEPTION 'a consultation is asked about an item of the approved plan' USING ERRCODE = 'check_violation', HINT = 'consultations.item_not_in_baseline';
      END IF;
    ELSIF NEW.kind = 'site_visit' THEN
      RAISE EXCEPTION 'a site visit is asked about a project item' USING ERRCODE = 'check_violation', HINT = 'consultations.site_needs_project';
    END IF;
    IF NEW.mentoring_relationship_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM trustwork.mentoring_relationship m WHERE m.id = NEW.mentoring_relationship_id AND m.status = 'active'
        AND m.mentee_person_id = NEW.requester_person_id AND m.mentor_person_id = f.expert_person_id
    ) THEN
      RAISE EXCEPTION 'mentoring sessions follow an active relationship with this mentor' USING ERRCODE = 'check_violation', HINT = 'consultations.mentoring_not_active';
    END IF;
    IF NEW.status <> 'requested' OR NEW.closed_reason IS NOT NULL THEN
      RAISE EXCEPTION 'a request starts requested' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.requester_person_id, NEW.offering_id, NEW.offering_owner_person_id, NEW.offering_owner_company_id, NEW.expert_person_id, NEW.project_id, NEW.plan_id,
         NEW.plan_version_id, NEW.plan_item_key, NEW.mentoring_relationship_id, NEW.kind, NEW.licence_required, NEW.terms, NEW.brief, NEW.digest, NEW.sent_via, NEW.sent_mandate_id, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.requester_person_id, OLD.offering_id, OLD.offering_owner_person_id, OLD.offering_owner_company_id, OLD.expert_person_id, OLD.project_id, OLD.plan_id,
         OLD.plan_version_id, OLD.plan_item_key, OLD.mentoring_relationship_id, OLD.kind, OLD.licence_required, OLD.terms, OLD.brief, OLD.digest, OLD.sent_via, OLD.sent_mandate_id, OLD.created_at) THEN
    RAISE EXCEPTION 'a sent request never changes' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF NEW.status = OLD.status THEN
    IF NEW.closed_reason IS DISTINCT FROM OLD.closed_reason THEN
      RAISE EXCEPTION 'closing facts change only with the status' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('withdrawn', 'declined', 'expired') THEN
    RAISE EXCEPTION 'a % request is kept as it was', OLD.status USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  v_live_proposal := EXISTS (SELECT 1 FROM trustwork.consultation_booking b WHERE b.request_id = OLD.id AND b.status = 'proposed');
  v_live_booking := EXISTS (SELECT 1 FROM trustwork.consultation_booking b WHERE b.request_id = OLD.id AND trustwork.consultation_booking_live(b.status));
  IF NEW.status IN ('withdrawn', 'declined') THEN
    IF OLD.status NOT IN ('requested', 'offered') OR v_live_proposal OR v_live_booking THEN
      RAISE EXCEPTION 'a request with an open proposal or a booking is not closed' USING ERRCODE = 'check_violation', HINT = 'consultations.proposal_open';
    END IF;
    IF NEW.status = 'withdrawn' AND OLD.requester_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
      RAISE EXCEPTION 'the requester withdraws' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    IF NEW.status = 'declined' AND NOT trustwork.commerce_party_acts(OLD.offering_owner_person_id, OLD.offering_owner_company_id, 'company.deals.manage') THEN
      RAISE EXCEPTION 'the expert side declines' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT trustwork.maintenance_on() OR NOT (
       (NEW.status = 'offered' AND OLD.status = 'requested' AND v_live_proposal)
    OR (NEW.status = 'booked' AND OLD.status IN ('requested', 'offered') AND v_live_booking)
    OR (NEW.status = 'requested' AND OLD.status IN ('offered', 'booked') AND NOT v_live_proposal AND NOT v_live_booking)
  ) THEN
    RAISE EXCEPTION 'request transition % -> % does not follow its proposals', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consultation_request_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.consultation_request FOR EACH ROW EXECUTE FUNCTION trustwork.consultation_request_guard();

CREATE FUNCTION trustwork.consultation_request_private_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'private halves are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  IF NEW.updated_by_person_id IS DISTINCT FROM trustwork.current_person_id() OR NOT EXISTS (
    SELECT 1 FROM trustwork.consultation_request r WHERE r.id = NEW.request_id AND r.requester_person_id = NEW.requester_person_id AND r.requester_person_id = trustwork.current_person_id()
  ) THEN
    RAISE EXCEPTION 'the requester keeps its own private half' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.request_id <> OLD.request_id OR NEW.requester_person_id <> OLD.requester_person_id) THEN
    RAISE EXCEPTION 'a private half belongs to its request' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consultation_request_private_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.consultation_request_private FOR EACH ROW EXECUTE FUNCTION trustwork.consultation_request_private_guard();

-- Mentoring: double opt-in, either side pauses, resumes or ends; paid mentoring names the mentor's mentoring offering.
CREATE FUNCTION trustwork.mentoring_relationship_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_me uuid := trustwork.current_person_id();
  v_side text;
  f record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'relationships are ended, not deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF v_me IS NULL OR NEW.proposed_by_person_id IS DISTINCT FROM v_me OR v_me NOT IN (NEW.mentor_person_id, NEW.mentee_person_id) THEN
      RAISE EXCEPTION 'a person proposes for itself' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    IF NEW.offering_id IS NOT NULL THEN
      SELECT * INTO f FROM trustwork.consultation_offering_facts(NEW.offering_id);
      IF f.offering_id IS NULL OR f.kind <> 'mentoring' OR f.status <> 'active' OR f.expert_person_id <> NEW.mentor_person_id THEN
        RAISE EXCEPTION 'paid mentoring names the mentor''s active mentoring offering' USING ERRCODE = 'check_violation', HINT = 'consultations.mentoring_offering';
      END IF;
    END IF;
    IF NEW.status <> 'proposed' OR NEW.started_at IS NOT NULL OR NEW.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'a relationship starts proposed' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.mentor_person_id, NEW.mentee_person_id, NEW.proposed_by_person_id, NEW.topics, NEW.terms, NEW.offering_id, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.mentor_person_id, OLD.mentee_person_id, OLD.proposed_by_person_id, OLD.topics, OLD.terms, OLD.offering_id, OLD.created_at) THEN
    RAISE EXCEPTION 'a relationship''s terms never change' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF v_me IS NULL OR v_me NOT IN (OLD.mentor_person_id, OLD.mentee_person_id) THEN
    RAISE EXCEPTION 'only the two people move their relationship' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
  END IF;
  v_side := CASE WHEN v_me = OLD.proposed_by_person_id THEN 'proposer' ELSE 'other' END;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'proposed' AND NEW.status IN ('active', 'declined') AND v_side = 'other')
    OR (OLD.status = 'proposed' AND NEW.status = 'ended' AND v_side = 'proposer')
    OR (OLD.status = 'active' AND NEW.status IN ('paused', 'ended'))
    OR (OLD.status = 'paused' AND NEW.status IN ('active', 'ended'))
  ) THEN
    RAISE EXCEPTION 'relationship transition % -> % is not allowed for this side', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
  END IF;
  IF NEW.status = 'active' AND OLD.status = 'proposed' THEN
    NEW.started_at := now();
  ELSIF NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'the start is recorded once' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF NEW.status IN ('ended', 'declined') AND OLD.status NOT IN ('ended', 'declined') THEN
    NEW.ended_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mentoring_relationship_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.mentoring_relationship FOR EACH ROW EXECUTE FUNCTION trustwork.mentoring_relationship_guard();

-- Bookings. Insert (a proposal): by the expert side of the request's offering, while the request waits for an
-- answer, pinning the offering's current published catalogue version and digest, with the parties, kind and licence
-- facts of the request and the offering; a slot lies in an open window of the expert. Afterwards the terms never
-- change for any role; only the life of the booking moves, each step by its side and on its facts.
CREATE FUNCTION trustwork.consultation_booking_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  r trustwork.consultation_request%ROWTYPE;
  f record;
  v record;
  a trustwork.agreement%ROWTYPE;
  v_seller boolean;
  v_client boolean;
  v_reason text;
  v_window record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bookings are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO r FROM trustwork.consultation_request WHERE id = NEW.request_id FOR UPDATE;
    IF r.id IS NULL OR NOT trustwork.commerce_party_acts(r.offering_owner_person_id, r.offering_owner_company_id, 'company.deals.manage') OR NEW.proposed_by_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
      RAISE EXCEPTION 'the expert side proposes' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    IF r.status <> 'requested' THEN
      RAISE EXCEPTION 'the request is not waiting for a proposal' USING ERRCODE = 'check_violation', HINT = 'consultations.request_not_open';
    END IF;
    SELECT * INTO f FROM trustwork.consultation_offering_facts(r.offering_id);
    IF NEW.offering_id <> r.offering_id OR f.status <> 'active' OR NEW.kind <> r.kind OR NEW.client_person_id <> r.requester_person_id OR NEW.expert_person_id <> r.expert_person_id
       OR NEW.seller_person_id IS DISTINCT FROM r.offering_owner_person_id OR NEW.seller_company_id IS DISTINCT FROM r.offering_owner_company_id THEN
      RAISE EXCEPTION 'a proposal answers its request with its offering' USING ERRCODE = 'check_violation', HINT = 'consultations.proposal_mismatch';
    END IF;
    IF NOT (NEW.mode = ANY (f.modes)) THEN
      RAISE EXCEPTION 'a mode the offering does not give' USING ERRCODE = 'check_violation', HINT = 'consultations.mode_not_offered';
    END IF;
    SELECT * INTO v FROM trustwork.consultation_current_version(r.offering_id);
    IF v.version_id IS NULL OR v.version_id <> NEW.offering_version_id OR v.version <> NEW.offering_version OR v.digest IS DISTINCT FROM NEW.offering_version_digest THEN
      RAISE EXCEPTION 'a proposal pins the current published catalogue version' USING ERRCODE = 'check_violation', HINT = 'commercial.stale_version';
    END IF;
    IF (r.licence_required OR f.licence_required) AND (f.licence_credential_id IS NULL OR NOT trustwork.consultation_licence_usable(f.licence_credential_id, f.expert_person_id)) THEN
      RAISE EXCEPTION 'licence-requiring advice is offered only with a recorded licence' USING ERRCODE = 'check_violation', HINT = 'consultations.licence_required';
    END IF;
    IF NEW.window_id IS NOT NULL THEN
      SELECT * INTO v_window FROM trustwork.consultation_window_facts(NEW.window_id);
      IF v_window.window_id IS NULL OR v_window.expert_person_id <> NEW.expert_person_id OR v_window.status <> 'open' OR NEW.slot_start < v_window.starts_at OR NEW.slot_end > v_window.ends_at THEN
        RAISE EXCEPTION 'the slot lies in an open window of the expert' USING ERRCODE = 'check_violation', HINT = 'consultations.slot_unavailable';
      END IF;
      IF NEW.slot_start <= now() THEN
        RAISE EXCEPTION 'a slot is in the future' USING ERRCODE = 'check_violation', HINT = 'consultations.slot_unavailable';
      END IF;
    END IF;
    IF NEW.status <> 'proposed' OR NEW.agreement_id IS NOT NULL OR NEW.booked_at IS NOT NULL OR NEW.recording_consent OR NEW.valid_until <= now() THEN
      RAISE EXCEPTION 'a proposal starts open' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.request_id, NEW.offering_id, NEW.offering_version_id, NEW.offering_version, NEW.offering_version_digest, NEW.expert_person_id, NEW.seller_person_id, NEW.seller_company_id,
         NEW.client_person_id, NEW.kind, NEW.mode, NEW.window_id, NEW.slot_start, NEW.slot_end, NEW.deliverable_due, NEW.terms, NEW.terms_digest, NEW.valid_until, NEW.proposed_by_person_id,
         NEW.proposed_via, NEW.proposed_mandate_id, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.request_id, OLD.offering_id, OLD.offering_version_id, OLD.offering_version, OLD.offering_version_digest, OLD.expert_person_id, OLD.seller_person_id, OLD.seller_company_id,
         OLD.client_person_id, OLD.kind, OLD.mode, OLD.window_id, OLD.slot_start, OLD.slot_end, OLD.deliverable_due, OLD.terms, OLD.terms_digest, OLD.valid_until, OLD.proposed_by_person_id,
         OLD.proposed_via, OLD.proposed_mandate_id, OLD.created_at) THEN
    RAISE EXCEPTION 'booked consultation terms never change' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  v_seller := trustwork.commerce_party_acts(OLD.seller_person_id, OLD.seller_company_id, 'company.deals.manage');
  v_client := OLD.client_person_id = trustwork.current_person_id();
  IF NOT (v_seller OR v_client) THEN
    RAISE EXCEPTION 'only the two parties move a booking' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
  END IF;
  -- The client's acceptance links the agreement (once) and its recording consent.
  IF NEW.agreement_id IS DISTINCT FROM OLD.agreement_id OR NEW.recording_consent IS DISTINCT FROM OLD.recording_consent THEN
    SELECT * INTO a FROM trustwork.agreement WHERE id = NEW.agreement_id;
    IF OLD.agreement_id IS NOT NULL OR NOT v_client OR OLD.status <> 'proposed' OR a.id IS NULL OR a.terms_kind <> 'consultation' OR a.offer_ref_id <> OLD.id OR a.status <> 'accepted_by_buyer'
       OR (NEW.recording_consent AND (OLD.terms ->> 'recordingOffered')::boolean IS NOT TRUE) THEN
      RAISE EXCEPTION 'the client links its own acceptance once' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
    END IF;
  END IF;
  IF NEW.status = OLD.status THEN
    IF ROW(NEW.closed_reason, NEW.cancellation_kind, NEW.cancellation_absent_side, NEW.cancellation_charge_minor, NEW.cancellation_charge_currency, NEW.cancelled_at, NEW.cancelled_by_person_id, NEW.booked_at)
       IS DISTINCT FROM ROW(OLD.closed_reason, OLD.cancellation_kind, OLD.cancellation_absent_side, OLD.cancellation_charge_minor, OLD.cancellation_charge_currency, OLD.cancelled_at, OLD.cancelled_by_person_id, OLD.booked_at) THEN
      RAISE EXCEPTION 'closing facts change only with the status' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO a FROM trustwork.agreement WHERE id = coalesce(NEW.agreement_id, OLD.agreement_id);
  IF OLD.status = 'proposed' AND NEW.status = 'withdrawn' THEN
    IF NOT ((v_seller AND (a.id IS NULL OR a.status IN ('withdrawn', 'declined'))) OR (v_client AND a.status = 'withdrawn')) THEN
      RAISE EXCEPTION 'a proposal under a pending acceptance is not withdrawn' USING ERRCODE = 'check_violation', HINT = 'transactions.agreement_live';
    END IF;
  ELSIF OLD.status = 'proposed' AND NEW.status = 'declined' THEN
    IF NOT ((v_client AND a.id IS NULL) OR (v_seller AND a.status = 'declined')) THEN
      RAISE EXCEPTION 'the client declines a proposal; the expert declines an acceptance' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
  ELSIF OLD.status = 'proposed' AND NEW.status = 'booked' THEN
    IF NOT v_seller OR a.status IS DISTINCT FROM 'accepted_by_both' OR NEW.booked_at IS NULL THEN
      RAISE EXCEPTION 'the expert books terms accepted by both' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    IF OLD.terms #>> '{credential,credentialId}' IS NOT NULL
       AND NOT trustwork.consultation_licence_usable((OLD.terms #>> '{credential,credentialId}')::uuid, OLD.expert_person_id) THEN
      RAISE EXCEPTION 'the pinned licence is no longer usable' USING ERRCODE = 'check_violation', HINT = 'consultations.licence_required';
    END IF;
    v_reason := trustwork.consultation_reserve_capacity(OLD.id);
    IF v_reason IS NOT NULL THEN
      RAISE EXCEPTION 'the slot cannot be booked: %', v_reason USING ERRCODE = 'check_violation', HINT = 'consultations.' || v_reason;
    END IF;
  ELSIF OLD.status = 'booked' AND NEW.status = 'held' THEN
    IF OLD.slot_start IS NULL OR OLD.slot_start > now() + interval '10 minutes'
       OR NOT EXISTS (SELECT 1 FROM trustwork.consultation_session s WHERE s.booking_id = OLD.id AND s.ended_at IS NOT NULL) THEN
      RAISE EXCEPTION 'a session is held once it took place' USING ERRCODE = 'check_violation', HINT = 'consultations.session_not_recorded';
    END IF;
  ELSIF OLD.status IN ('booked', 'held') AND NEW.status = 'delivered' THEN
    IF NOT v_seller OR (OLD.slot_start IS NOT NULL AND OLD.status <> 'held')
       OR NOT EXISTS (SELECT 1 FROM trustwork.consultation_deliverable d WHERE d.booking_id = OLD.id AND d.decision IS NULL) THEN
      RAISE EXCEPTION 'the expert delivers after the session' USING ERRCODE = 'check_violation', HINT = 'consultations.not_deliverable';
    END IF;
  ELSIF OLD.status = 'delivered' AND NEW.status IN ('accepted', 'held', 'booked') THEN
    IF NOT v_client OR NOT EXISTS (
      SELECT 1 FROM (SELECT d.decision FROM trustwork.consultation_deliverable d WHERE d.booking_id = OLD.id ORDER BY d.delivered_at DESC, d.id DESC LIMIT 1) last
      WHERE (NEW.status = 'accepted' AND last.decision = 'accepted') OR (NEW.status <> 'accepted' AND last.decision = 'rejected')
    ) OR (NEW.status = 'held' AND OLD.slot_start IS NULL) OR (NEW.status = 'booked' AND OLD.slot_start IS NOT NULL) THEN
      RAISE EXCEPTION 'the client decides on the deliverable' USING ERRCODE = 'check_violation', HINT = 'consultations.decision_missing';
    END IF;
  ELSIF OLD.status = 'booked' AND NEW.status = 'cancelled' THEN
    IF NEW.cancelled_by_person_id IS DISTINCT FROM trustwork.current_person_id() OR NEW.cancelled_at IS NULL
       OR (NEW.cancellation_kind = 'client' AND NOT v_client) OR (NEW.cancellation_kind = 'expert' AND NOT v_seller)
       OR (NEW.cancellation_kind = 'no_show' AND (OLD.slot_start IS NULL OR OLD.slot_start > now()
           OR (NEW.cancellation_absent_side = 'client' AND NOT v_seller) OR (NEW.cancellation_absent_side = 'expert' AND NOT v_client))) THEN
      RAISE EXCEPTION 'a party cancels for its own side or records the other side''s absence after the start' USING ERRCODE = 'check_violation', HINT = 'consultations.cancellation_not_allowed';
    END IF;
  ELSE
    RAISE EXCEPTION 'booking transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
  END IF;
  IF NEW.booked_at IS DISTINCT FROM OLD.booked_at AND NOT (OLD.status = 'proposed' AND NEW.status = 'booked') THEN
    RAISE EXCEPTION 'the booking time is recorded once' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consultation_booking_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.consultation_booking FOR EACH ROW EXECUTE FUNCTION trustwork.consultation_booking_guard();
CREATE TRIGGER consultation_booking_sync_request AFTER INSERT OR UPDATE OF status ON trustwork.consultation_booking FOR EACH ROW EXECUTE FUNCTION trustwork.consultation_booking_sync_request();

CREATE FUNCTION trustwork.consultation_session_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  b trustwork.consultation_booking%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sessions are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  SELECT * INTO b FROM trustwork.consultation_booking WHERE id = NEW.booking_id;
  IF trustwork.consultation_booking_side(NEW.booking_id) IS NULL THEN
    RAISE EXCEPTION 'only the two parties record a session' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF b.status <> 'booked' OR NEW.started_at IS NOT NULL THEN
      RAISE EXCEPTION 'a session opens with the booking' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    -- A site visit's site becomes readable to the expert now (consultation_booking_site); the moment is recorded.
    NEW.site_address_revealed_at := CASE WHEN b.kind = 'site_visit' THEN now() END;
    RETURN NEW;
  END IF;
  IF NEW.booking_id <> OLD.booking_id OR NEW.site_address_revealed_at IS DISTINCT FROM OLD.site_address_revealed_at OR NEW.created_at <> OLD.created_at
     OR (OLD.started_at IS NOT NULL AND ROW(NEW.started_at, NEW.ended_at, NEW.attendance, NEW.recorded_by_person_id) IS DISTINCT FROM ROW(OLD.started_at, OLD.ended_at, OLD.attendance, OLD.recorded_by_person_id)) THEN
    RAISE EXCEPTION 'a session is recorded once' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF NEW.started_at IS NOT NULL AND (b.status <> 'booked' OR NEW.recorded_by_person_id IS DISTINCT FROM trustwork.current_person_id() OR NEW.ended_at > now() + interval '10 minutes') THEN
    RAISE EXCEPTION 'a party records a session that took place' USING ERRCODE = 'check_violation', HINT = 'consultations.session_not_recorded';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consultation_session_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.consultation_session FOR EACH ROW EXECUTE FUNCTION trustwork.consultation_session_guard();

-- Deliverables: by a person of the expert side, for a booking that is due for delivery, tied to that person's own
-- service_delivered claim on the agreement's perform obligation; one undecided deliverable at a time. Content never
-- changes; the client links its decision once (a confirmation of that claim); the author publishes once.
CREATE FUNCTION trustwork.consultation_deliverable_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  b trustwork.consultation_booking%ROWTYPE;
  c trustwork.execution_claim%ROWTYPE;
  k trustwork.execution_confirmation%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'deliverables are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  SELECT * INTO b FROM trustwork.consultation_booking WHERE id = NEW.booking_id;
  IF TG_OP = 'INSERT' THEN
    IF b.id IS NULL OR NEW.author_person_id IS DISTINCT FROM trustwork.current_person_id() OR NOT trustwork.commerce_party_acts(b.seller_person_id, b.seller_company_id, 'company.deals.manage') THEN
      RAISE EXCEPTION 'the expert side delivers' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    IF NOT ((b.status = 'held' AND b.slot_start IS NOT NULL) OR (b.status = 'booked' AND b.slot_start IS NULL)) THEN
      RAISE EXCEPTION 'a deliverable follows the session (or the booking of a review)' USING ERRCODE = 'check_violation', HINT = 'consultations.not_deliverable';
    END IF;
    IF NEW.agreement_id IS DISTINCT FROM b.agreement_id OR NEW.client_person_id <> b.client_person_id
       OR NEW.seller_person_id IS DISTINCT FROM b.seller_person_id OR NEW.seller_company_id IS DISTINCT FROM b.seller_company_id THEN
      RAISE EXCEPTION 'a deliverable names its booking''s parties' USING ERRCODE = 'check_violation', HINT = 'commerce.not_authorised';
    END IF;
    SELECT * INTO c FROM trustwork.execution_claim WHERE id = NEW.claim_id;
    IF c.id IS NULL OR c.agreement_id <> b.agreement_id OR c.kind <> 'service_delivered' OR c.recorded_by_person_id <> NEW.author_person_id
       OR NOT trustwork.execution_same_party(c.claimant_person_id, c.claimant_company_id, b.seller_person_id, b.seller_company_id) THEN
      RAISE EXCEPTION 'a deliverable is the expert''s own delivery claim' USING ERRCODE = 'check_violation', HINT = 'consultations.claim_mismatch';
    END IF;
    IF EXISTS (SELECT 1 FROM trustwork.consultation_deliverable d WHERE d.booking_id = NEW.booking_id AND d.decision IS NULL) THEN
      RAISE EXCEPTION 'a deliverable awaits a decision' USING ERRCODE = 'check_violation', HINT = 'consultations.deliverable_open';
    END IF;
    IF NEW.confirmation_id IS NOT NULL OR NEW.published_at IS NOT NULL THEN
      RAISE EXCEPTION 'a deliverable starts undecided and unpublished' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.booking_id, NEW.agreement_id, NEW.kind, NEW.title, NEW.body, NEW.attachments, NEW.claim_id, NEW.author_person_id, NEW.seller_person_id, NEW.seller_company_id,
         NEW.client_person_id, NEW.delivered_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.booking_id, OLD.agreement_id, OLD.kind, OLD.title, OLD.body, OLD.attachments, OLD.claim_id, OLD.author_person_id, OLD.seller_person_id, OLD.seller_company_id,
         OLD.client_person_id, OLD.delivered_at) THEN
    RAISE EXCEPTION 'a delivered deliverable never changes' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF ROW(NEW.confirmation_id, NEW.decision, NEW.decided_at) IS DISTINCT FROM ROW(OLD.confirmation_id, OLD.decision, OLD.decided_at) THEN
    SELECT * INTO k FROM trustwork.execution_confirmation WHERE id = NEW.confirmation_id;
    IF OLD.confirmation_id IS NOT NULL OR OLD.client_person_id IS DISTINCT FROM trustwork.current_person_id() OR k.id IS NULL OR k.claim_id <> OLD.claim_id
       OR k.decided_by_person_id <> OLD.client_person_id OR NEW.decision IS DISTINCT FROM (CASE k.decision WHEN 'accepted' THEN 'accepted' ELSE 'rejected' END) THEN
      RAISE EXCEPTION 'the client records its own decision once' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
    END IF;
  END IF;
  IF NEW.published_at IS DISTINCT FROM OLD.published_at AND (OLD.published_at IS NOT NULL OR OLD.author_person_id IS DISTINCT FROM trustwork.current_person_id()) THEN
    RAISE EXCEPTION 'only the author publishes, once' USING ERRCODE = 'insufficient_privilege', HINT = 'consultations.not_author';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consultation_deliverable_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.consultation_deliverable FOR EACH ROW EXECUTE FUNCTION trustwork.consultation_deliverable_guard();

CREATE FUNCTION trustwork.consultation_reminder_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  b trustwork.consultation_booking%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reminders are cancelled, not deleted' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  SELECT * INTO b FROM trustwork.consultation_booking WHERE id = NEW.booking_id;
  IF trustwork.consultation_booking_side(NEW.booking_id) IS NULL THEN
    RAISE EXCEPTION 'only the two parties schedule reminders' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF b.status <> 'booked' OR b.slot_start IS NULL OR NEW.agreement_id IS DISTINCT FROM b.agreement_id OR NEW.status <> 'scheduled'
       OR NEW.remind_at <> b.slot_start - make_interval(mins => NEW.offset_minutes) THEN
      RAISE EXCEPTION 'reminders follow the booked slot' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.booking_id, NEW.agreement_id, NEW.remind_at, NEW.offset_minutes, NEW.created_at) IS DISTINCT FROM ROW(OLD.id, OLD.booking_id, OLD.agreement_id, OLD.remind_at, OLD.offset_minutes, OLD.created_at)
     OR (NEW.status <> OLD.status AND NOT (OLD.status = 'scheduled' AND NEW.status = 'cancelled' AND b.status = 'cancelled')) THEN
    RAISE EXCEPTION 'a reminder is cancelled with its booking only' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consultation_reminder_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.consultation_reminder FOR EACH ROW EXECUTE FUNCTION trustwork.consultation_reminder_guard();

-- 8. Agreements with terms_kind consultation (replaces the TASK-001 definition) ------------------------------------------
-- The client accepts an open, valid proposal on its own request: the parties come from the request and the proposal,
-- the pinned digests are the stored ones, the request row is locked and no other booking of the request is live or
-- pending acceptance; one live agreement per proposal (the unique index below). The rfq_quote and task branches are
-- unchanged.
CREATE OR REPLACE FUNCTION trustwork.agreement_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_rfq trustwork.rfq%ROWTYPE;
  v_quote trustwork.quote%ROWTYPE;
  v_version trustwork.quote_version%ROWTYPE;
  v_rfq_version trustwork.rfq_version%ROWTYPE;
  v_task_version trustwork.task_request_version%ROWTYPE;
  v_task trustwork.task_request%ROWTYPE;
  v_offer trustwork.task_offer%ROWTYPE;
  v_request trustwork.consultation_request%ROWTYPE;
  v_booking trustwork.consultation_booking%ROWTYPE;
  v_buyer boolean;
  v_seller boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'agreements are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.terms_kind = 'consultation' THEN
      IF NEW.created_by_person_id IS DISTINCT FROM trustwork.current_person_id() OR NEW.buyer_person_id IS DISTINCT FROM trustwork.current_person_id() OR NEW.buyer_company_id IS NOT NULL THEN
        RAISE EXCEPTION 'the client accepts in person' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
      END IF;
      IF NEW.supersedes_id IS NOT NULL OR NEW.rfq_id IS NOT NULL OR NEW.quote_id IS NOT NULL OR NEW.superseded_by IS NOT NULL OR NEW.closed_reason IS NOT NULL OR NEW.status <> 'accepted_by_buyer' THEN
        RAISE EXCEPTION 'a consultation agreement starts accepted by the client' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
      END IF;
      SELECT * INTO v_request FROM trustwork.consultation_request WHERE id = NEW.request_ref_id FOR UPDATE;
      IF v_request.id IS NULL OR v_request.requester_person_id IS DISTINCT FROM NEW.buyer_person_id THEN
        RAISE EXCEPTION 'the client accepts proposals on its own request' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
      END IF;
      SELECT * INTO v_booking FROM trustwork.consultation_booking WHERE id = NEW.offer_ref_id FOR UPDATE;
      IF v_booking.id IS NULL OR v_booking.request_id <> v_request.id THEN
        RAISE EXCEPTION 'the agreement pins a proposal on this request' USING ERRCODE = 'check_violation', HINT = 'commercial.rfq_version_mismatch';
      END IF;
      IF NEW.seller_person_id IS DISTINCT FROM v_booking.seller_person_id OR NEW.seller_company_id IS DISTINCT FROM v_booking.seller_company_id THEN
        RAISE EXCEPTION 'parties come from the request and the proposal' USING ERRCODE = 'check_violation', HINT = 'commerce.not_authorised';
      END IF;
      IF NEW.offer_version <> 1 OR NEW.offer_digest IS DISTINCT FROM v_booking.terms_digest OR NEW.request_version <> 1 OR NEW.request_digest IS DISTINCT FROM v_request.digest THEN
        RAISE EXCEPTION 'pinned digests are the stored ones' USING ERRCODE = 'check_violation', HINT = 'commercial.digest_mismatch';
      END IF;
      IF v_booking.status <> 'proposed' OR v_booking.agreement_id IS NOT NULL OR v_booking.valid_until <= now() OR v_request.status <> 'offered' THEN
        RAISE EXCEPTION 'only an open, valid proposal on a waiting request is accepted' USING ERRCODE = 'check_violation', HINT = 'commercial.quote_not_acceptable';
      END IF;
      IF EXISTS (SELECT 1 FROM trustwork.consultation_booking b WHERE b.request_id = v_request.id AND trustwork.consultation_booking_live(b.status))
         OR EXISTS (SELECT 1 FROM trustwork.agreement x JOIN trustwork.consultation_booking b ON b.id = x.offer_ref_id
                    WHERE x.terms_kind = 'consultation' AND b.request_id = v_request.id AND x.status = 'accepted_by_buyer') THEN
        RAISE EXCEPTION 'a request has one live booking' USING ERRCODE = 'check_violation', HINT = 'transactions.agreement_live';
      END IF;
      IF v_booking.terms #>> '{credential,credentialId}' IS NOT NULL
         AND NOT trustwork.consultation_licence_usable((v_booking.terms #>> '{credential,credentialId}')::uuid, v_booking.expert_person_id) THEN
        RAISE EXCEPTION 'the pinned licence is no longer usable' USING ERRCODE = 'check_violation', HINT = 'consultations.licence_required';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.terms_kind = 'task' THEN
      IF NEW.created_by_person_id IS DISTINCT FROM trustwork.current_person_id() OR NEW.buyer_person_id IS DISTINCT FROM trustwork.current_person_id() OR NEW.buyer_company_id IS NOT NULL THEN
        RAISE EXCEPTION 'the task owner accepts in person' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
      END IF;
      IF NEW.supersedes_id IS NOT NULL OR NEW.rfq_id IS NOT NULL OR NEW.quote_id IS NOT NULL OR NEW.superseded_by IS NOT NULL OR NEW.closed_reason IS NOT NULL OR NEW.status <> 'accepted_by_buyer' THEN
        RAISE EXCEPTION 'a task agreement starts accepted by the owner' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
      END IF;
      SELECT * INTO v_task_version FROM trustwork.task_request_version WHERE id = NEW.request_ref_id;
      SELECT * INTO v_task FROM trustwork.task_request WHERE id = v_task_version.task_request_id FOR UPDATE;
      IF v_task.id IS NULL OR v_task.owner_person_id IS DISTINCT FROM NEW.buyer_person_id THEN
        RAISE EXCEPTION 'the owner accepts offers on its own request' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
      END IF;
      v_offer := trustwork.tasks_offer_for_share(NEW.offer_ref_id);
      IF v_offer.id IS NULL OR v_offer.task_request_id <> v_task.id OR v_offer.request_version_id <> v_task_version.id THEN
        RAISE EXCEPTION 'the agreement pins an offer on this request version' USING ERRCODE = 'check_violation', HINT = 'commercial.rfq_version_mismatch';
      END IF;
      IF NEW.seller_person_id IS DISTINCT FROM v_offer.offeror_person_id OR NEW.seller_company_id IS DISTINCT FROM v_offer.offeror_company_id THEN
        RAISE EXCEPTION 'parties come from the request and the offer' USING ERRCODE = 'check_violation', HINT = 'commerce.not_authorised';
      END IF;
      IF NEW.offer_version <> v_offer.version OR NEW.offer_digest IS DISTINCT FROM v_offer.digest OR NEW.request_version <> v_task_version.version
         OR NEW.request_digest IS DISTINCT FROM v_task_version.digest OR v_offer.request_version_digest IS DISTINCT FROM v_task_version.digest THEN
        RAISE EXCEPTION 'pinned digests are the stored ones' USING ERRCODE = 'check_violation', HINT = 'commercial.digest_mismatch';
      END IF;
      IF v_task.current_version_id IS DISTINCT FROM v_task_version.id OR v_offer.stale_reason IS NOT NULL THEN
        RAISE EXCEPTION 'the offer no longer answers the current request version' USING ERRCODE = 'check_violation', HINT = 'commercial.stale_version';
      END IF;
      IF v_offer.status <> 'sent' OR v_offer.valid_until <= now() OR v_task.status <> 'published' THEN
        RAISE EXCEPTION 'only a sent, valid offer on a published request is accepted' USING ERRCODE = 'check_violation', HINT = 'commercial.quote_not_acceptable';
      END IF;
      IF trustwork.task_request_live_agreement(v_task.id) OR EXISTS (SELECT 1 FROM trustwork.task_assignment a WHERE a.task_request_id = v_task.id AND a.status <> 'cancelled') THEN
        RAISE EXCEPTION 'a task request has one live agreement' USING ERRCODE = 'check_violation', HINT = 'transactions.agreement_live';
      END IF;
      RETURN NEW;
    END IF;
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
    OR (OLD.status = 'accepted_by_both' AND NEW.status = 'superseded' AND (v_buyer OR v_seller) AND OLD.terms_kind = 'rfq_quote')
  ) THEN
    RAISE EXCEPTION 'agreement transition % -> % is not allowed for this side', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
  END IF;
  RETURN NEW;
END $$;

-- One live consultation agreement per proposal (with the request lock above: one pending acceptance per request).
CREATE UNIQUE INDEX agreement_one_live_per_consultation_booking ON trustwork.agreement (offer_ref_id) WHERE terms_kind = 'consultation' AND status IN ('proposed', 'accepted_by_buyer', 'accepted_by_both');

-- The insert policy now admits the client of a consultation as well.
DROP POLICY agreement_insert ON trustwork.agreement;
CREATE POLICY agreement_insert ON trustwork.agreement FOR INSERT TO trustwork_app
  WITH CHECK (created_by_person_id = trustwork.current_person_id() AND (
    (terms_kind = 'rfq_quote' AND rfq_id IS NOT NULL AND (trustwork.rfq_can(rfq_id, 'accept') OR (supersedes_id IS NOT NULL AND trustwork.agreement_side(supersedes_id) IS NOT NULL)))
    OR (terms_kind = 'task' AND buyer_person_id = trustwork.current_person_id() AND buyer_company_id IS NULL)
    OR (terms_kind = 'consultation' AND buyer_person_id = trustwork.current_person_id() AND buyer_company_id IS NULL)));

-- 9. Row-level security --------------------------------------------------------------------------------------------------------
ALTER TABLE trustwork.consultation_offering ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.consultation_offering FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.availability_window ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.availability_window FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.consultation_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.consultation_request FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.consultation_request_private ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.consultation_request_private FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.mentoring_relationship ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.mentoring_relationship FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.consultation_booking ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.consultation_booking FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.consultation_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.consultation_session FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.consultation_deliverable ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.consultation_deliverable FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.consultation_reminder ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.consultation_reminder FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.consultation_offering AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.availability_window AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.consultation_request AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.consultation_request_private AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.mentoring_relationship AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.consultation_booking AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.consultation_session AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.consultation_deliverable AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.consultation_reminder AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

-- Offerings: the owner side reads and writes; everyone else reads through consultation_public_offerings().
CREATE POLICY consultation_offering_read ON trustwork.consultation_offering FOR SELECT TO trustwork_app
  USING (trustwork.commerce_party_acts(owner_person_id, owner_company_id, 'company.catalogue.edit') OR trustwork.commerce_party_acts(owner_person_id, owner_company_id, 'company.deals.manage'));
CREATE POLICY consultation_offering_insert ON trustwork.consultation_offering FOR INSERT TO trustwork_app
  WITH CHECK (trustwork.commerce_party_acts(owner_person_id, owner_company_id, 'company.catalogue.edit'));
CREATE POLICY consultation_offering_update ON trustwork.consultation_offering FOR UPDATE TO trustwork_app
  USING (trustwork.commerce_party_acts(owner_person_id, owner_company_id, 'company.catalogue.edit')) WITH CHECK (trustwork.commerce_party_acts(owner_person_id, owner_company_id, 'company.catalogue.edit'));
-- Windows: the expert only (requesters see free windows through consultation_free_windows()).
CREATE POLICY availability_window_read ON trustwork.availability_window FOR SELECT TO trustwork_app USING (expert_person_id = trustwork.current_person_id());
CREATE POLICY availability_window_insert ON trustwork.availability_window FOR INSERT TO trustwork_app WITH CHECK (expert_person_id = trustwork.current_person_id());
CREATE POLICY availability_window_update ON trustwork.availability_window FOR UPDATE TO trustwork_app
  USING (expert_person_id = trustwork.current_person_id()) WITH CHECK (expert_person_id = trustwork.current_person_id());
-- Requests: the requester and the expert side of the addressed offering; the private half is the requester's only.
CREATE POLICY consultation_request_read ON trustwork.consultation_request FOR SELECT TO trustwork_app
  USING (requester_person_id = trustwork.current_person_id() OR trustwork.commerce_party_acts(offering_owner_person_id, offering_owner_company_id, 'company.deals.manage'));
CREATE POLICY consultation_request_insert ON trustwork.consultation_request FOR INSERT TO trustwork_app WITH CHECK (requester_person_id = trustwork.current_person_id());
CREATE POLICY consultation_request_update ON trustwork.consultation_request FOR UPDATE TO trustwork_app
  USING (requester_person_id = trustwork.current_person_id() OR trustwork.commerce_party_acts(offering_owner_person_id, offering_owner_company_id, 'company.deals.manage'))
  WITH CHECK (requester_person_id = trustwork.current_person_id() OR trustwork.commerce_party_acts(offering_owner_person_id, offering_owner_company_id, 'company.deals.manage'));
CREATE POLICY consultation_request_private_read ON trustwork.consultation_request_private FOR SELECT TO trustwork_app USING (requester_person_id = trustwork.current_person_id());
CREATE POLICY consultation_request_private_insert ON trustwork.consultation_request_private FOR INSERT TO trustwork_app WITH CHECK (requester_person_id = trustwork.current_person_id());
CREATE POLICY consultation_request_private_update ON trustwork.consultation_request_private FOR UPDATE TO trustwork_app
  USING (requester_person_id = trustwork.current_person_id()) WITH CHECK (requester_person_id = trustwork.current_person_id());
-- Mentoring: the two people.
CREATE POLICY mentoring_relationship_read ON trustwork.mentoring_relationship FOR SELECT TO trustwork_app
  USING (trustwork.current_person_id() IN (mentor_person_id, mentee_person_id));
CREATE POLICY mentoring_relationship_insert ON trustwork.mentoring_relationship FOR INSERT TO trustwork_app WITH CHECK (proposed_by_person_id = trustwork.current_person_id());
CREATE POLICY mentoring_relationship_update ON trustwork.mentoring_relationship FOR UPDATE TO trustwork_app
  USING (trustwork.current_person_id() IN (mentor_person_id, mentee_person_id)) WITH CHECK (trustwork.current_person_id() IN (mentor_person_id, mentee_person_id));
-- Bookings, sessions, deliverables and reminders: the two parties only.
CREATE POLICY consultation_booking_read ON trustwork.consultation_booking FOR SELECT TO trustwork_app
  USING (client_person_id = trustwork.current_person_id() OR trustwork.commerce_party_acts(seller_person_id, seller_company_id, 'company.deals.manage'));
CREATE POLICY consultation_booking_insert ON trustwork.consultation_booking FOR INSERT TO trustwork_app
  WITH CHECK (proposed_by_person_id = trustwork.current_person_id() AND trustwork.commerce_party_acts(seller_person_id, seller_company_id, 'company.deals.manage'));
CREATE POLICY consultation_booking_update ON trustwork.consultation_booking FOR UPDATE TO trustwork_app
  USING (client_person_id = trustwork.current_person_id() OR trustwork.commerce_party_acts(seller_person_id, seller_company_id, 'company.deals.manage'))
  WITH CHECK (client_person_id = trustwork.current_person_id() OR trustwork.commerce_party_acts(seller_person_id, seller_company_id, 'company.deals.manage'));
CREATE POLICY consultation_session_read ON trustwork.consultation_session FOR SELECT TO trustwork_app USING (trustwork.consultation_booking_side(booking_id) IS NOT NULL);
CREATE POLICY consultation_session_insert ON trustwork.consultation_session FOR INSERT TO trustwork_app WITH CHECK (trustwork.consultation_booking_side(booking_id) IS NOT NULL);
CREATE POLICY consultation_session_update ON trustwork.consultation_session FOR UPDATE TO trustwork_app
  USING (trustwork.consultation_booking_side(booking_id) IS NOT NULL) WITH CHECK (trustwork.consultation_booking_side(booking_id) IS NOT NULL);
CREATE POLICY consultation_deliverable_read ON trustwork.consultation_deliverable FOR SELECT TO trustwork_app USING (trustwork.consultation_booking_side(booking_id) IS NOT NULL);
CREATE POLICY consultation_deliverable_insert ON trustwork.consultation_deliverable FOR INSERT TO trustwork_app WITH CHECK (trustwork.consultation_booking_side(booking_id) = 'expert');
CREATE POLICY consultation_deliverable_update ON trustwork.consultation_deliverable FOR UPDATE TO trustwork_app
  USING (trustwork.consultation_booking_side(booking_id) IS NOT NULL) WITH CHECK (trustwork.consultation_booking_side(booking_id) IS NOT NULL);
CREATE POLICY consultation_reminder_read ON trustwork.consultation_reminder FOR SELECT TO trustwork_app USING (trustwork.consultation_booking_side(booking_id) IS NOT NULL);
CREATE POLICY consultation_reminder_insert ON trustwork.consultation_reminder FOR INSERT TO trustwork_app WITH CHECK (trustwork.consultation_booking_side(booking_id) IS NOT NULL);
CREATE POLICY consultation_reminder_update ON trustwork.consultation_reminder FOR UPDATE TO trustwork_app
  USING (trustwork.consultation_booking_side(booking_id) IS NOT NULL) WITH CHECK (trustwork.consultation_booking_side(booking_id) IS NOT NULL);

-- 10. Grants -------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT ON trustwork.consultation_offering, trustwork.availability_window, trustwork.consultation_request, trustwork.consultation_request_private,
  trustwork.mentoring_relationship, trustwork.consultation_booking, trustwork.consultation_session, trustwork.consultation_deliverable, trustwork.consultation_reminder TO trustwork_app;
GRANT UPDATE (modes, topics, regions, languages, duration_minutes, deliverable_kind, pricing, cancellation, licence_required, licence_credential_id, recording_offered, status)
  ON trustwork.consultation_offering TO trustwork_app;
GRANT UPDATE (status) ON trustwork.availability_window TO trustwork_app;
GRANT UPDATE (status, closed_reason) ON trustwork.consultation_request TO trustwork_app;
GRANT UPDATE (budget_ceiling_minor, budget_ceiling_currency, requester_notes, updated_by_person_id) ON trustwork.consultation_request_private TO trustwork_app;
GRANT UPDATE (status, started_at, ended_at, ended_reason) ON trustwork.mentoring_relationship TO trustwork_app;
GRANT UPDATE (status, agreement_id, recording_consent, closed_reason, cancellation_kind, cancellation_absent_side, cancellation_charge_minor, cancellation_charge_currency, cancelled_at,
  cancelled_by_person_id, booked_at) ON trustwork.consultation_booking TO trustwork_app;
GRANT UPDATE (started_at, ended_at, attendance, recorded_by_person_id) ON trustwork.consultation_session TO trustwork_app;
GRANT UPDATE (confirmation_id, decision, decided_at, published_at) ON trustwork.consultation_deliverable TO trustwork_app;
GRANT UPDATE (status) ON trustwork.consultation_reminder TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.consultation_booking_side(uuid), trustwork.consultation_offering_facts(uuid), trustwork.consultation_licence_usable(uuid, uuid),
  trustwork.consultation_credential_facts(uuid), trustwork.consultation_current_version(uuid), trustwork.consultation_public_offerings(uuid, uuid, uuid), trustwork.consultation_booking_live(text),
  trustwork.consultation_free_windows(uuid), trustwork.consultation_window_facts(uuid), trustwork.consultation_window_booked(uuid), trustwork.consultation_reserve_capacity(uuid), trustwork.consultation_booking_site(uuid),
  trustwork.consultation_public_deliverable(uuid) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
