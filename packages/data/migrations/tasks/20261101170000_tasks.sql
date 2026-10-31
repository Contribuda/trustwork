-- TASK-001: scoped tasks from plan items for contractors and trades. Task requests cut from an approved plan item,
-- immutable published request versions, versioned task offers pinned to the current request version by id and digest,
-- the two private halves, invitations, agreements with terms_kind `task` (ADR 012 decision 19), task assignments that
-- name the plan item and the agreement version, execution records per milestone and reviews of completed tasks.
--
-- Mirrors packages/contracts/src/tasks.ts. The commercial kernel is reused, not rebuilt: a task request behaves like an
-- RFQ, a task offer version like a quote version, the agreement is the COM-002 agreement with terms_kind `task`
-- (offer_ref_id = task_offer.id, request_ref_id = task_request_version.id, both digests copied and checked here), and
-- its acceptance events and obligations are the COM-002 tables.
--
-- Authority: the owner side of a task request is the person who owns the project (consumer mode, ADR 012 decision 37:
-- inside companies purchases start as requisitions). The offeror side is the offering person, or members of the
-- offering company holding company.deals.manage. Every table is under FORCE RLS; nothing is ever deleted.
--
-- Privacy: offerors read only published request versions (the brief built from listed plan fields) and their own
-- invitations and offers; competing offerors never see each other's offers or the invitee list; the owner never sees
-- offer drafts or the offeror's private half; the site address, contact and access notes reach the assignee only
-- through `task_assignment_site` after assignment.
--
-- Money: none. Obligations record who pays what per milestone; Trustwork never holds participants' money
-- (ADR 010 decision 20). No table, function or ordering here reads a billing table (tests/billing/policy.test.ts).

-- 1. Task requests ------------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.task_request (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  owner_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  project_id uuid NOT NULL REFERENCES trustwork.project (id),
  plan_id uuid NOT NULL,
  plan_version_id uuid NOT NULL REFERENCES trustwork.plan_version (id),
  plan_item_key text NOT NULL CHECK (plan_item_key ~ '^[a-z][a-z0-9_-]{0,63}$'),
  audience text NOT NULL CHECK (audience IN ('invited', 'open')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'closed', 'cancelled', 'expired')),
  current_version integer NULL CHECK (current_version >= 1),
  current_version_id uuid NULL,
  closed_reason text NULL CHECK (length(closed_reason) BETWEEN 1 AND 500),
  creator_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_request_plan FOREIGN KEY (plan_id, project_id) REFERENCES trustwork.plan (id, project_id),
  CONSTRAINT task_request_current CHECK ((current_version IS NULL) = (current_version_id IS NULL)),
  CONSTRAINT task_request_closed CHECK ((status IN ('closed', 'cancelled')) = (closed_reason IS NOT NULL))
);
-- A plan item becomes at most one live task request (the plan item records the path `task` with this request).
CREATE UNIQUE INDEX task_request_one_per_plan_item ON trustwork.task_request (project_id, plan_item_key) WHERE status <> 'cancelled';
CREATE INDEX task_request_owner_idx ON trustwork.task_request (owner_person_id);
CREATE INDEX task_request_open_idx ON trustwork.task_request (status, audience);
CREATE TRIGGER task_request_touch BEFORE UPDATE ON trustwork.task_request FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- The owner's party_private half: the ceiling an agent never accepts above, and notes. Never readable by offerors.
CREATE TABLE trustwork.task_request_private (
  task_request_id uuid PRIMARY KEY REFERENCES trustwork.task_request (id),
  owner_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  budget_ceiling_minor bigint NULL CHECK (budget_ceiling_minor >= 0),
  budget_ceiling_currency text NULL CHECK (budget_ceiling_currency ~ '^[A-Z]{3}$'),
  owner_notes text NULL CHECK (length(owner_notes) BETWEEN 1 AND 500),
  updated_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_request_private_ceiling CHECK ((budget_ceiling_minor IS NULL) = (budget_ceiling_currency IS NULL))
);
CREATE TRIGGER task_request_private_touch BEFORE UPDATE ON trustwork.task_request_private FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- Versions: the brief is immutable once published and carries its trustwork-digest-1 (computed by the server).
CREATE TABLE trustwork.task_request_version (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  task_request_id uuid NOT NULL REFERENCES trustwork.task_request (id),
  version integer NOT NULL CHECK (version >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'superseded')),
  terms jsonb NOT NULL CHECK (jsonb_typeof(terms) = 'object'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  digest text NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  drafted_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  published_at timestamptz NULL,
  published_by_person_id uuid NULL REFERENCES trustwork.person (id),
  published_via text NULL CHECK (published_via IN ('person', 'agent')),
  published_mandate_id text NULL CHECK (published_mandate_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  amendment_reason text NULL CHECK (length(amendment_reason) BETWEEN 1 AND 500),
  superseded_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_request_version_number UNIQUE (task_request_id, version),
  CONSTRAINT task_request_version_pair UNIQUE (id, task_request_id),
  CONSTRAINT task_request_version_digest CHECK ((status = 'draft') = (digest IS NULL)),
  CONSTRAINT task_request_version_published CHECK ((status = 'draft') = (published_at IS NULL) AND (status = 'draft') = (published_by_person_id IS NULL) AND (status = 'draft') = (published_via IS NULL)),
  CONSTRAINT task_request_version_mandate CHECK (published_via IS NULL OR (published_via = 'agent') = (published_mandate_id IS NOT NULL)),
  CONSTRAINT task_request_version_superseded CHECK ((status = 'superseded') = (superseded_at IS NOT NULL))
);
CREATE UNIQUE INDEX task_request_version_one_draft ON trustwork.task_request_version (task_request_id) WHERE status = 'draft';
CREATE TRIGGER task_request_version_touch BEFORE UPDATE ON trustwork.task_request_version FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
CREATE TRIGGER task_request_version_frozen BEFORE UPDATE ON trustwork.task_request_version FOR EACH ROW
  EXECUTE FUNCTION trustwork.reject_update_when_frozen('status', 'draft', 'terms', 'payload', 'digest', 'published_at', 'published_by_person_id', 'published_via', 'published_mandate_id', 'amendment_reason', 'version', 'task_request_id');
ALTER TABLE trustwork.task_request ADD CONSTRAINT task_request_current_version FOREIGN KEY (current_version_id, id) REFERENCES trustwork.task_request_version (id, task_request_id);

-- Invitations name a person or a company; the owner invites, the invitee may decline, the owner may withdraw.
CREATE TABLE trustwork.task_invitation (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  task_request_id uuid NOT NULL REFERENCES trustwork.task_request (id),
  party_person_id uuid NULL REFERENCES trustwork.person (id),
  party_company_id uuid NULL REFERENCES trustwork.company (id),
  status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'withdrawn', 'declined')),
  sent_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  sent_via text NOT NULL CHECK (sent_via IN ('person', 'agent')),
  sent_mandate_id text NULL CHECK (sent_mandate_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_invitation_party_xor CHECK ((party_person_id IS NULL) <> (party_company_id IS NULL)),
  CONSTRAINT task_invitation_mandate CHECK ((sent_via = 'agent') = (sent_mandate_id IS NOT NULL))
);
CREATE UNIQUE INDEX task_invitation_once ON trustwork.task_invitation (task_request_id, coalesce(party_person_id, party_company_id)) WHERE status = 'sent';
CREATE INDEX task_invitation_person_idx ON trustwork.task_invitation (party_person_id) WHERE party_person_id IS NOT NULL;
CREATE INDEX task_invitation_company_idx ON trustwork.task_invitation (party_company_id) WHERE party_company_id IS NOT NULL;
CREATE TRIGGER task_invitation_touch BEFORE UPDATE ON trustwork.task_invitation FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- 2. Offers -------------------------------------------------------------------------------------------------------------
-- Each row is one version of one offeror's offer on a request (the model's `task_offer (V)`). owner_person_id is copied
-- from the request by the guard so the owner's read policy needs no join.
CREATE TABLE trustwork.task_offer (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  task_request_id uuid NOT NULL REFERENCES trustwork.task_request (id),
  offeror_person_id uuid NULL REFERENCES trustwork.person (id),
  offeror_company_id uuid NULL REFERENCES trustwork.company (id),
  owner_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  version integer NOT NULL CHECK (version >= 1),
  request_version_id uuid NOT NULL,
  request_version integer NOT NULL CHECK (request_version >= 1),
  request_version_digest text NOT NULL CHECK (request_version_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'superseded', 'withdrawn', 'expired', 'accepted', 'declined')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  valid_until timestamptz NOT NULL,
  digest text NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  stale_reason text NULL CHECK (stale_reason IN ('request_amended', 'request_closed')),
  stale_at timestamptz NULL,
  drafted_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  sent_at timestamptz NULL,
  sent_by_person_id uuid NULL REFERENCES trustwork.person (id),
  sent_via text NULL CHECK (sent_via IN ('person', 'agent')),
  sent_mandate_id text NULL CHECK (sent_mandate_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  withdrawn_reason text NULL CHECK (length(withdrawn_reason) BETWEEN 1 AND 500),
  superseded_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_offer_offeror_xor CHECK ((offeror_person_id IS NULL) <> (offeror_company_id IS NULL)),
  CONSTRAINT task_offer_request_version FOREIGN KEY (request_version_id, task_request_id) REFERENCES trustwork.task_request_version (id, task_request_id),
  CONSTRAINT task_offer_digest CHECK ((status = 'draft') = (digest IS NULL)),
  CONSTRAINT task_offer_sent CHECK ((status = 'draft') = (sent_at IS NULL) AND (status = 'draft') = (sent_by_person_id IS NULL) AND (status = 'draft') = (sent_via IS NULL)),
  CONSTRAINT task_offer_mandate CHECK (sent_via IS NULL OR (sent_via = 'agent') = (sent_mandate_id IS NOT NULL)),
  CONSTRAINT task_offer_withdrawn CHECK ((status = 'withdrawn') = (withdrawn_reason IS NOT NULL)),
  CONSTRAINT task_offer_superseded CHECK ((status = 'superseded') = (superseded_at IS NOT NULL)),
  CONSTRAINT task_offer_stale CHECK ((stale_reason IS NULL) = (stale_at IS NULL))
);
CREATE UNIQUE INDEX task_offer_version ON trustwork.task_offer (task_request_id, coalesce(offeror_person_id, offeror_company_id), version);
CREATE UNIQUE INDEX task_offer_one_draft ON trustwork.task_offer (task_request_id, coalesce(offeror_person_id, offeror_company_id)) WHERE status = 'draft';
CREATE UNIQUE INDEX task_offer_one_sent ON trustwork.task_offer (task_request_id, coalesce(offeror_person_id, offeror_company_id)) WHERE status = 'sent';
CREATE INDEX task_offer_person_idx ON trustwork.task_offer (offeror_person_id) WHERE offeror_person_id IS NOT NULL;
CREATE INDEX task_offer_company_idx ON trustwork.task_offer (offeror_company_id) WHERE offeror_company_id IS NOT NULL;
CREATE TRIGGER task_offer_touch BEFORE UPDATE ON trustwork.task_offer FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
-- Sent offers are frozen for every role, the owner and maintenance included.
CREATE TRIGGER task_offer_frozen BEFORE UPDATE ON trustwork.task_offer FOR EACH ROW
  EXECUTE FUNCTION trustwork.reject_update_when_frozen('status', 'draft', 'payload', 'valid_until', 'digest', 'request_version_id', 'request_version', 'request_version_digest', 'sent_at',
    'sent_by_person_id', 'sent_via', 'sent_mandate_id', 'version', 'task_request_id', 'offeror_person_id', 'offeror_company_id', 'owner_person_id');

-- The offeror's party_private half: floor and notes. Never readable by the owner.
CREATE TABLE trustwork.task_offer_private (
  task_offer_id uuid PRIMARY KEY REFERENCES trustwork.task_offer (id),
  offeror_person_id uuid NULL REFERENCES trustwork.person (id),
  offeror_company_id uuid NULL REFERENCES trustwork.company (id),
  floor_price_minor bigint NULL CHECK (floor_price_minor >= 0),
  floor_price_currency text NULL CHECK (floor_price_currency ~ '^[A-Z]{3}$'),
  offeror_notes text NULL CHECK (length(offeror_notes) BETWEEN 1 AND 500),
  updated_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_offer_private_offeror_xor CHECK ((offeror_person_id IS NULL) <> (offeror_company_id IS NULL)),
  CONSTRAINT task_offer_private_floor CHECK ((floor_price_minor IS NULL) = (floor_price_currency IS NULL))
);
CREATE TRIGGER task_offer_private_touch BEFORE UPDATE ON trustwork.task_offer_private FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- 3. Assignments, execution records and reviews ---------------------------------------------------------------------
-- Created only by the offeror's confirmation of an agreement accepted by both. Always names the plan item (project,
-- plan, approved plan version, item key) and the agreement version (id and accepted-terms digest); the milestones are
-- the frozen milestones of the accepted offer.
CREATE TABLE trustwork.task_assignment (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  task_request_id uuid NOT NULL REFERENCES trustwork.task_request (id),
  task_offer_id uuid NOT NULL REFERENCES trustwork.task_offer (id),
  agreement_id uuid NOT NULL UNIQUE REFERENCES trustwork.agreement (id),
  agreement_digest text NOT NULL CHECK (agreement_digest ~ '^[a-f0-9]{64}$'),
  offer_version integer NOT NULL CHECK (offer_version >= 1),
  offer_digest text NOT NULL CHECK (offer_digest ~ '^[a-f0-9]{64}$'),
  request_version_id uuid NOT NULL,
  request_version integer NOT NULL CHECK (request_version >= 1),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  project_id uuid NOT NULL REFERENCES trustwork.project (id),
  plan_id uuid NOT NULL,
  plan_version_id uuid NOT NULL REFERENCES trustwork.plan_version (id),
  plan_item_key text NOT NULL CHECK (plan_item_key ~ '^[a-z][a-z0-9_-]{0,63}$'),
  owner_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  assignee_person_id uuid NULL REFERENCES trustwork.person (id),
  assignee_company_id uuid NULL REFERENCES trustwork.company (id),
  milestones jsonb NOT NULL CHECK (jsonb_typeof(milestones) = 'array' AND jsonb_array_length(milestones) >= 1),
  status text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned', 'in_progress', 'delivered', 'accepted', 'disputed', 'cancelled')),
  completed_at timestamptz NULL,
  created_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_assignment_assignee_xor CHECK ((assignee_person_id IS NULL) <> (assignee_company_id IS NULL)),
  CONSTRAINT task_assignment_completed CHECK ((status = 'accepted') = (completed_at IS NOT NULL)),
  CONSTRAINT task_assignment_plan FOREIGN KEY (plan_id, project_id) REFERENCES trustwork.plan (id, project_id),
  CONSTRAINT task_assignment_request_version FOREIGN KEY (request_version_id, task_request_id) REFERENCES trustwork.task_request_version (id, task_request_id)
);
-- Exactly one live assignment per task request: two concurrent confirmations cannot both commit.
CREATE UNIQUE INDEX task_assignment_one_live ON trustwork.task_assignment (task_request_id) WHERE status <> 'cancelled';
CREATE INDEX task_assignment_owner_idx ON trustwork.task_assignment (owner_person_id);
CREATE INDEX task_assignment_person_idx ON trustwork.task_assignment (assignee_person_id) WHERE assignee_person_id IS NOT NULL;
CREATE INDEX task_assignment_company_idx ON trustwork.task_assignment (assignee_company_id) WHERE assignee_company_id IS NOT NULL;
CREATE TRIGGER task_assignment_touch BEFORE UPDATE ON trustwork.task_assignment FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- Append-only execution evidence: the assignee claims delivery of a milestone with evidence (asserted); the owner, in
-- person, accepts (confirmed) or rejects that claim.
CREATE TABLE trustwork.task_execution_record (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  assignment_id uuid NOT NULL REFERENCES trustwork.task_assignment (id),
  milestone_key text NOT NULL CHECK (milestone_key ~ '^[a-z][a-z0-9_-]{0,63}$'),
  kind text NOT NULL CHECK (kind IN ('delivery_claim', 'acceptance', 'rejection')),
  claim_id uuid NULL REFERENCES trustwork.task_execution_record (id),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) <= 20),
  note text NULL CHECK (length(note) BETWEEN 1 AND 500),
  by_person_id uuid NULL REFERENCES trustwork.person (id),
  by_company_id uuid NULL REFERENCES trustwork.company (id),
  recorded_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  via text NOT NULL CHECK (via IN ('person', 'agent')),
  mandate_id text NULL CHECK (mandate_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT task_execution_record_by_xor CHECK ((by_person_id IS NULL) <> (by_company_id IS NULL)),
  CONSTRAINT task_execution_record_claim CHECK ((kind = 'delivery_claim') = (claim_id IS NULL)),
  CONSTRAINT task_execution_record_evidence CHECK (kind <> 'delivery_claim' OR jsonb_array_length(evidence) >= 1),
  CONSTRAINT task_execution_record_reason CHECK (kind <> 'rejection' OR note IS NOT NULL),
  CONSTRAINT task_execution_record_mandate CHECK ((via = 'agent') = (mandate_id IS NOT NULL)),
  -- Accepting or rejecting work is human-only (confirm_execution).
  CONSTRAINT task_execution_record_human_decision CHECK (kind = 'delivery_claim' OR via = 'person')
);
CREATE INDEX task_execution_record_assignment_idx ON trustwork.task_execution_record (assignment_id, created_at);
CREATE TRIGGER task_execution_record_append_only BEFORE UPDATE OR DELETE ON trustwork.task_execution_record FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- Reviews of completed tasks only, one per side, written by a person for the side it acts for.
CREATE TABLE trustwork.task_review (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  assignment_id uuid NOT NULL REFERENCES trustwork.task_assignment (id),
  author_side text NOT NULL CHECK (author_side IN ('owner', 'assignee')),
  author_person_id uuid NULL REFERENCES trustwork.person (id),
  author_company_id uuid NULL REFERENCES trustwork.company (id),
  subject_person_id uuid NULL REFERENCES trustwork.person (id),
  subject_company_id uuid NULL REFERENCES trustwork.company (id),
  written_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  text text NULL CHECK (length(text) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_review_once UNIQUE (assignment_id, author_side),
  CONSTRAINT task_review_author_xor CHECK ((author_person_id IS NULL) <> (author_company_id IS NULL)),
  CONSTRAINT task_review_subject_xor CHECK ((subject_person_id IS NULL) <> (subject_company_id IS NULL))
);
CREATE TRIGGER task_review_append_only BEFORE UPDATE OR DELETE ON trustwork.task_review FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 4. Access helpers -----------------------------------------------------------------------------------------------------
-- Owner-run so that policies on versions, invitations and records can read the envelope without recursion.
CREATE FUNCTION trustwork.task_request_owned(p_task_request_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL
    AND EXISTS (SELECT 1 FROM trustwork.task_request r WHERE r.id = p_task_request_id AND r.owner_person_id = trustwork.current_person_id())
$$;

-- Who may read a published brief: the owner; for open requests every signed-in person; otherwise a party with a live
-- invitation or an offer on it. Drafts are the owner's only.
CREATE FUNCTION trustwork.task_request_visible(p_task_request_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL AND EXISTS (
    SELECT 1 FROM trustwork.task_request r
    WHERE r.id = p_task_request_id
      AND (r.owner_person_id = trustwork.current_person_id()
           OR (r.status <> 'draft' AND (
                 r.audience = 'open'
              OR EXISTS (SELECT 1 FROM trustwork.task_invitation i WHERE i.task_request_id = r.id AND i.status = 'sent'
                           AND trustwork.commerce_party_acts(i.party_person_id, i.party_company_id, 'company.deals.manage'))
              OR EXISTS (SELECT 1 FROM trustwork.task_offer o WHERE o.task_request_id = r.id
                           AND trustwork.commerce_party_acts(o.offeror_person_id, o.offeror_company_id, 'company.deals.manage')))))
  )
$$;

-- 'owner' or 'assignee' for the principal, otherwise NULL.
CREATE FUNCTION trustwork.task_assignment_side(p_assignment_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT CASE
    WHEN trustwork.current_person_id() IS NULL THEN NULL
    WHEN a.owner_person_id = trustwork.current_person_id() THEN 'owner'
    WHEN trustwork.commerce_party_acts(a.assignee_person_id, a.assignee_company_id, 'company.deals.manage') THEN 'assignee'
  END
  FROM trustwork.task_assignment a WHERE a.id = p_assignment_id
$$;

-- The site of the assigned plan item (region, address, site contact, access notes) for the parties of a live
-- assignment; nobody else, and nothing before assignment (the project location is otherwise owner-private).
CREATE FUNCTION trustwork.task_assignment_site(p_assignment_id uuid)
RETURNS TABLE (region_code text, address jsonb, site_contact jsonb, site_access_notes text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT l.region_code, l.address, l.site_contact, l.site_access_notes
  FROM trustwork.task_assignment a
  JOIN trustwork.project_location l ON l.project_id = a.project_id
  WHERE a.id = p_assignment_id AND a.status <> 'cancelled'
    AND (a.owner_person_id = trustwork.current_person_id() OR trustwork.commerce_party_acts(a.assignee_person_id, a.assignee_company_id, 'company.deals.manage'))
$$;

-- Row lock the owner takes on the offer it accepts (it may read a sent offer but not update it), so a concurrent
-- withdrawal waits and then sees the agreement. Owner-run: it only locks and returns the row the owner already reads.
CREATE FUNCTION trustwork.tasks_offer_for_share(p_offer_id uuid) RETURNS trustwork.task_offer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT * FROM trustwork.task_offer WHERE id = p_offer_id AND status <> 'draft' AND owner_person_id = trustwork.current_person_id() FOR SHARE
$$;

-- Live task agreements of a request (any of its versions).
CREATE FUNCTION trustwork.task_request_live_agreement(p_task_request_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM trustwork.agreement a JOIN trustwork.task_request_version v ON v.id = a.request_ref_id
    WHERE a.terms_kind = 'task' AND v.task_request_id = p_task_request_id AND a.status IN ('proposed', 'accepted_by_buyer', 'accepted_by_both')
  )
$$;

-- 5. Guards -------------------------------------------------------------------------------------------------------------
-- Task requests: the person owning the project cuts a request from an item of its approved plan (kind task or phase);
-- identity never changes; the current pointer moves only forward to a published version and never while an acceptance
-- is pending; terminal states stay as they were. `closed` is reached only through an assignment (fact-checked).
CREATE FUNCTION trustwork.task_request_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'task requests are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.creator_person_id IS DISTINCT FROM trustwork.current_person_id() OR NEW.owner_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
      RAISE EXCEPTION 'the owner cuts its own task requests' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM trustwork.project p WHERE p.id = NEW.project_id AND p.owner_person_id = NEW.owner_person_id) THEN
      RAISE EXCEPTION 'a plan item becomes a task of its own person owner' USING ERRCODE = 'check_violation', HINT = 'commerce.plan_item_path';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM trustwork.plan pl JOIN trustwork.plan_item i ON i.plan_version_id = pl.current_version_id
      WHERE pl.id = NEW.plan_id AND pl.project_id = NEW.project_id AND pl.current_version_id = NEW.plan_version_id AND i.item_key = NEW.plan_item_key AND i.kind IN ('task', 'phase')
    ) THEN
      RAISE EXCEPTION 'a task is cut from a task or phase of the approved plan' USING ERRCODE = 'check_violation', HINT = 'tasks.item_not_in_baseline';
    END IF;
    IF NEW.status <> 'draft' OR NEW.current_version_id IS NOT NULL OR NEW.closed_reason IS NOT NULL THEN
      RAISE EXCEPTION 'a task request starts as a draft' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.owner_person_id <> OLD.owner_person_id OR NEW.project_id <> OLD.project_id OR NEW.plan_id <> OLD.plan_id OR NEW.plan_version_id <> OLD.plan_version_id
     OR NEW.plan_item_key <> OLD.plan_item_key OR NEW.audience <> OLD.audience OR NEW.creator_person_id <> OLD.creator_person_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'task request identity is immutable' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF OLD.status IN ('closed', 'cancelled', 'expired') THEN
    RAISE EXCEPTION 'a % task request is kept as it was', OLD.status USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NEW.status = 'closed' THEN
      IF OLD.status <> 'published' OR NOT EXISTS (SELECT 1 FROM trustwork.task_assignment a WHERE a.task_request_id = OLD.id AND a.status <> 'cancelled') THEN
        RAISE EXCEPTION 'a task request closes through its assignment' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
      END IF;
    ELSIF NOT ((OLD.status = 'draft' AND NEW.status IN ('published', 'cancelled')) OR (OLD.status = 'published' AND NEW.status IN ('cancelled', 'expired'))) THEN
      RAISE EXCEPTION 'task request transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    ELSIF OLD.owner_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
      RAISE EXCEPTION 'the owner publishes and cancels' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    ELSIF NEW.status IN ('cancelled', 'expired') AND trustwork.task_request_live_agreement(OLD.id) THEN
      RAISE EXCEPTION 'an acceptance is pending or the task is agreed' USING ERRCODE = 'check_violation', HINT = 'transactions.agreement_live';
    END IF;
  ELSIF NEW.closed_reason IS DISTINCT FROM OLD.closed_reason THEN
    RAISE EXCEPTION 'closing facts change only with the status' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN
    IF NEW.current_version_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM trustwork.task_request_version v WHERE v.id = NEW.current_version_id AND v.task_request_id = NEW.id AND v.status = 'published' AND v.version = NEW.current_version
    ) OR (OLD.current_version IS NOT NULL AND NEW.current_version <= OLD.current_version) OR OLD.owner_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
      RAISE EXCEPTION 'the current version is the latest published version' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
    END IF;
    IF trustwork.task_request_live_agreement(OLD.id) THEN
      RAISE EXCEPTION 'a task request is not amended while an acceptance is pending or agreed' USING ERRCODE = 'check_violation', HINT = 'transactions.agreement_live';
    END IF;
  ELSIF NEW.current_version IS DISTINCT FROM OLD.current_version THEN
    RAISE EXCEPTION 'current version number and id move together' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_request_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.task_request FOR EACH ROW EXECUTE FUNCTION trustwork.task_request_guard();

CREATE FUNCTION trustwork.task_request_private_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'private halves are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  IF NEW.updated_by_person_id IS DISTINCT FROM trustwork.current_person_id() OR NOT EXISTS (
    SELECT 1 FROM trustwork.task_request r WHERE r.id = NEW.task_request_id AND r.owner_person_id = NEW.owner_person_id AND r.owner_person_id = trustwork.current_person_id()
  ) THEN
    RAISE EXCEPTION 'the owner keeps its own private half' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.task_request_id <> OLD.task_request_id OR NEW.owner_person_id <> OLD.owner_person_id) THEN
    RAISE EXCEPTION 'a private half belongs to its request' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_request_private_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.task_request_private FOR EACH ROW EXECUTE FUNCTION trustwork.task_request_private_guard();

-- Versions: the owner drafts while the request is open; publishing needs the digest and the publisher; the previous
-- published version is superseded only by a newer published one.
CREATE FUNCTION trustwork.task_request_version_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_request trustwork.task_request%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'request versions are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  SELECT * INTO v_request FROM trustwork.task_request WHERE id = NEW.task_request_id;
  IF v_request.owner_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
    RAISE EXCEPTION 'the owner drafts and publishes its briefs' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.drafted_by_person_id IS DISTINCT FROM trustwork.current_person_id() OR v_request.status NOT IN ('draft', 'published') THEN
      RAISE EXCEPTION 'a version starts as the owner''s draft of an open request' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    IF NEW.version <> coalesce((SELECT max(version) FROM trustwork.task_request_version WHERE task_request_id = NEW.task_request_id), 0) + 1 THEN
      RAISE EXCEPTION 'versions are numbered in order' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.drafted_by_person_id <> OLD.drafted_by_person_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'version identity is immutable' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT ((OLD.status = 'draft' AND NEW.status = 'published' AND NEW.published_by_person_id = trustwork.current_person_id())
         OR (OLD.status = 'published' AND NEW.status = 'superseded')) THEN
      RAISE EXCEPTION 'version transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_request_version_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.task_request_version FOR EACH ROW EXECUTE FUNCTION trustwork.task_request_version_guard();

CREATE FUNCTION trustwork.task_invitation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_request trustwork.task_request%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invitations are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  SELECT * INTO v_request FROM trustwork.task_request WHERE id = NEW.task_request_id;
  IF TG_OP = 'INSERT' THEN
    IF v_request.owner_person_id IS DISTINCT FROM trustwork.current_person_id() OR NEW.sent_by_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
      RAISE EXCEPTION 'the owner invites' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    IF NEW.party_person_id IS NOT DISTINCT FROM v_request.owner_person_id THEN
      RAISE EXCEPTION 'the owner does not invite itself' USING ERRCODE = 'check_violation', HINT = 'commerce.self_invitation';
    END IF;
    IF v_request.status <> 'published' OR NEW.status <> 'sent' THEN
      RAISE EXCEPTION 'invitations go out for a published request' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.task_request_id <> OLD.task_request_id OR NEW.party_person_id IS DISTINCT FROM OLD.party_person_id OR NEW.party_company_id IS DISTINCT FROM OLD.party_company_id
     OR NEW.sent_by_person_id <> OLD.sent_by_person_id OR NEW.sent_via <> OLD.sent_via OR NEW.sent_mandate_id IS DISTINCT FROM OLD.sent_mandate_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'an invitation never changes' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'sent' AND NEW.status = 'withdrawn' AND v_request.owner_person_id = trustwork.current_person_id())
    OR (OLD.status = 'sent' AND NEW.status = 'declined' AND trustwork.commerce_party_acts(OLD.party_person_id, OLD.party_company_id, 'company.deals.manage'))
  ) THEN
    RAISE EXCEPTION 'invitation transition % -> % is not allowed for this side', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_invitation_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.task_invitation FOR EACH ROW EXECUTE FUNCTION trustwork.task_invitation_guard();

-- Offers: drafted by an eligible offeror (open request, or a live invitation of its own party; never the owner)
-- against the current published request version; sent only while that version is current; superseded by the next
-- sent version; withdrawn only while no agreement on it is live; accepted only through an agreement accepted by both.
-- Staleness is set only when true and never cleared (amendment or closing, by the owner-run flag trigger).
CREATE FUNCTION trustwork.task_offer_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_request trustwork.task_request%ROWTYPE;
  v_version trustwork.task_request_version%ROWTYPE;
  v_offeror boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'offers are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  SELECT * INTO v_request FROM trustwork.task_request WHERE id = NEW.task_request_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.drafted_by_person_id IS DISTINCT FROM trustwork.current_person_id() OR NOT trustwork.commerce_party_acts(NEW.offeror_person_id, NEW.offeror_company_id, 'company.deals.manage') THEN
      RAISE EXCEPTION 'an offeror drafts for its own party' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    IF v_request.id IS NULL OR NOT trustwork.task_request_visible(NEW.task_request_id) THEN
      RAISE EXCEPTION 'the request is not visible to this party' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_found';
    END IF;
    NEW.owner_person_id := v_request.owner_person_id;
    IF NEW.offeror_person_id IS NOT DISTINCT FROM v_request.owner_person_id THEN
      RAISE EXCEPTION 'the owner does not offer on its own request' USING ERRCODE = 'check_violation', HINT = 'commerce.self_invitation';
    END IF;
    IF v_request.audience = 'invited' AND NOT EXISTS (
      SELECT 1 FROM trustwork.task_invitation i WHERE i.task_request_id = NEW.task_request_id AND i.status = 'sent'
        AND i.party_person_id IS NOT DISTINCT FROM NEW.offeror_person_id AND i.party_company_id IS NOT DISTINCT FROM NEW.offeror_company_id
    ) THEN
      RAISE EXCEPTION 'an invited request takes offers from invited parties' USING ERRCODE = 'insufficient_privilege', HINT = 'transactions.not_invited';
    END IF;
    SELECT * INTO v_version FROM trustwork.task_request_version WHERE id = NEW.request_version_id;
    IF v_request.status <> 'published' OR v_request.current_version_id IS DISTINCT FROM NEW.request_version_id OR v_version.version <> NEW.request_version
       OR v_version.digest IS DISTINCT FROM NEW.request_version_digest THEN
      RAISE EXCEPTION 'offers pin the current published request version' USING ERRCODE = 'check_violation', HINT = 'commerce.rfq_version_not_current';
    END IF;
    IF NEW.status <> 'draft' OR NEW.stale_reason IS NOT NULL THEN
      RAISE EXCEPTION 'an offer starts as a draft' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    IF NEW.version <> coalesce((SELECT max(o.version) FROM trustwork.task_offer o WHERE o.task_request_id = NEW.task_request_id
         AND o.offeror_person_id IS NOT DISTINCT FROM NEW.offeror_person_id AND o.offeror_company_id IS NOT DISTINCT FROM NEW.offeror_company_id), 0) + 1 THEN
      RAISE EXCEPTION 'offer versions are numbered in order' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.drafted_by_person_id <> OLD.drafted_by_person_id OR NEW.created_at <> OLD.created_at
     OR NEW.task_request_id <> OLD.task_request_id OR NEW.offeror_person_id IS DISTINCT FROM OLD.offeror_person_id OR NEW.offeror_company_id IS DISTINCT FROM OLD.offeror_company_id
     OR NEW.owner_person_id <> OLD.owner_person_id OR NEW.version <> OLD.version OR NEW.request_version_id <> OLD.request_version_id
     OR NEW.request_version <> OLD.request_version OR NEW.request_version_digest <> OLD.request_version_digest THEN
    RAISE EXCEPTION 'offer identity is immutable' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF NEW.stale_reason IS DISTINCT FROM OLD.stale_reason OR NEW.stale_at IS DISTINCT FROM OLD.stale_at THEN
    IF OLD.stale_reason IS NOT NULL OR NEW.stale_reason IS NULL
       OR (NEW.stale_reason = 'request_amended' AND v_request.current_version_id = OLD.request_version_id)
       OR (NEW.stale_reason = 'request_closed' AND v_request.status = 'published') THEN
      RAISE EXCEPTION 'staleness is set only when true and never cleared' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.stale_immutable';
    END IF;
    RETURN NEW;
  END IF;
  v_offeror := trustwork.commerce_party_acts(OLD.offeror_person_id, OLD.offeror_company_id, 'company.deals.manage');
  IF NOT v_offeror THEN
    RAISE EXCEPTION 'only the offeror changes its offer' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
  END IF;
  IF NEW.status = OLD.status THEN
    IF OLD.status <> 'draft' AND (NEW.withdrawn_reason IS DISTINCT FROM OLD.withdrawn_reason OR NEW.superseded_at IS DISTINCT FROM OLD.superseded_at) THEN
      RAISE EXCEPTION 'closing facts change only with the status' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'sent' THEN
    IF NEW.sent_by_person_id IS DISTINCT FROM trustwork.current_person_id() OR v_request.status <> 'published' OR v_request.current_version_id IS DISTINCT FROM OLD.request_version_id
       OR OLD.stale_reason IS NOT NULL THEN
      RAISE EXCEPTION 'an offer is sent against the current published request version' USING ERRCODE = 'check_violation', HINT = 'commerce.rfq_version_not_current';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'sent' AND NEW.status = 'superseded' THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('draft', 'sent') AND NEW.status = 'withdrawn' THEN
    IF EXISTS (SELECT 1 FROM trustwork.agreement a WHERE a.terms_kind = 'task' AND a.offer_ref_id = OLD.id AND a.status IN ('proposed', 'accepted_by_buyer', 'accepted_by_both')) THEN
      RAISE EXCEPTION 'an offer under a live agreement is not withdrawn' USING ERRCODE = 'check_violation', HINT = 'transactions.agreement_live';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'sent' AND NEW.status = 'accepted' THEN
    IF NOT EXISTS (SELECT 1 FROM trustwork.agreement a WHERE a.terms_kind = 'task' AND a.offer_ref_id = OLD.id AND a.status = 'accepted_by_both') THEN
      RAISE EXCEPTION 'an offer is accepted through an agreement accepted by both' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'offer transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
END $$;
CREATE TRIGGER task_offer_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.task_offer FOR EACH ROW EXECUTE FUNCTION trustwork.task_offer_guard();

CREATE FUNCTION trustwork.task_offer_private_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_offer trustwork.task_offer%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'private halves are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  SELECT * INTO v_offer FROM trustwork.task_offer WHERE id = NEW.task_offer_id;
  IF NEW.updated_by_person_id IS DISTINCT FROM trustwork.current_person_id() OR v_offer.id IS NULL
     OR NEW.offeror_person_id IS DISTINCT FROM v_offer.offeror_person_id OR NEW.offeror_company_id IS DISTINCT FROM v_offer.offeror_company_id
     OR NOT trustwork.commerce_party_acts(v_offer.offeror_person_id, v_offer.offeror_company_id, 'company.deals.manage') THEN
    RAISE EXCEPTION 'the offeror keeps its own private half' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.task_offer_id <> OLD.task_offer_id) THEN
    RAISE EXCEPTION 'a private half belongs to its offer' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_offer_private_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.task_offer_private FOR EACH ROW EXECUTE FUNCTION trustwork.task_offer_private_guard();

-- Assignments: created by the offeror side for an agreement accepted by both, repeating its digests, parties, the
-- plan item of the request and the milestones of the offer exactly. Afterwards only the status moves: the assignee
-- delivers, the owner accepts (every milestone accepted) or sends a milestone back.
CREATE FUNCTION trustwork.task_assignment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_agreement trustwork.agreement%ROWTYPE;
  v_offer trustwork.task_offer%ROWTYPE;
  v_request trustwork.task_request%ROWTYPE;
  v_side text;
  v_accepted integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'assignments are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO v_agreement FROM trustwork.agreement WHERE id = NEW.agreement_id;
    SELECT * INTO v_offer FROM trustwork.task_offer WHERE id = NEW.task_offer_id;
    SELECT * INTO v_request FROM trustwork.task_request WHERE id = NEW.task_request_id;
    IF NEW.created_by_person_id IS DISTINCT FROM trustwork.current_person_id() OR NOT trustwork.commerce_party_acts(NEW.assignee_person_id, NEW.assignee_company_id, 'company.deals.manage') THEN
      RAISE EXCEPTION 'the assignee confirms its assignment' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    IF v_agreement.terms_kind IS DISTINCT FROM 'task' OR v_agreement.status <> 'accepted_by_both' OR v_agreement.offer_ref_id IS DISTINCT FROM NEW.task_offer_id
       OR v_agreement.request_ref_id IS DISTINCT FROM NEW.request_version_id OR v_offer.task_request_id IS DISTINCT FROM NEW.task_request_id THEN
      RAISE EXCEPTION 'an assignment follows a task agreement accepted by both' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    IF NEW.agreement_digest <> v_agreement.accepted_terms_digest OR NEW.offer_digest <> v_agreement.offer_digest OR NEW.offer_version <> v_agreement.offer_version
       OR NEW.request_digest <> v_agreement.request_digest OR NEW.request_version <> v_agreement.request_version OR NEW.offer_digest IS DISTINCT FROM v_offer.digest THEN
      RAISE EXCEPTION 'an assignment repeats the agreement version' USING ERRCODE = 'check_violation', HINT = 'commercial.digest_mismatch';
    END IF;
    IF NEW.owner_person_id IS DISTINCT FROM v_agreement.buyer_person_id OR NEW.owner_person_id IS DISTINCT FROM v_request.owner_person_id
       OR NEW.assignee_person_id IS DISTINCT FROM v_agreement.seller_person_id OR NEW.assignee_company_id IS DISTINCT FROM v_agreement.seller_company_id THEN
      RAISE EXCEPTION 'parties come from the agreement' USING ERRCODE = 'check_violation', HINT = 'commerce.not_authorised';
    END IF;
    IF NEW.project_id <> v_request.project_id OR NEW.plan_id <> v_request.plan_id OR NEW.plan_version_id <> v_request.plan_version_id OR NEW.plan_item_key <> v_request.plan_item_key THEN
      RAISE EXCEPTION 'an assignment names the plan item of its request' USING ERRCODE = 'check_violation', HINT = 'commerce.plan_item_path';
    END IF;
    IF NEW.milestones IS DISTINCT FROM (v_offer.payload -> 'milestones') THEN
      RAISE EXCEPTION 'milestones are those of the accepted offer' USING ERRCODE = 'check_violation', HINT = 'commercial.digest_mismatch';
    END IF;
    IF NEW.status <> 'assigned' OR NEW.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'an assignment starts assigned' USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.task_request_id <> OLD.task_request_id OR NEW.task_offer_id <> OLD.task_offer_id OR NEW.agreement_id <> OLD.agreement_id OR NEW.agreement_digest <> OLD.agreement_digest
     OR NEW.offer_version <> OLD.offer_version OR NEW.offer_digest <> OLD.offer_digest OR NEW.request_version_id <> OLD.request_version_id OR NEW.request_version <> OLD.request_version
     OR NEW.request_digest <> OLD.request_digest OR NEW.project_id <> OLD.project_id OR NEW.plan_id <> OLD.plan_id OR NEW.plan_version_id <> OLD.plan_version_id
     OR NEW.plan_item_key <> OLD.plan_item_key OR NEW.owner_person_id <> OLD.owner_person_id OR NEW.assignee_person_id IS DISTINCT FROM OLD.assignee_person_id
     OR NEW.assignee_company_id IS DISTINCT FROM OLD.assignee_company_id OR NEW.milestones IS DISTINCT FROM OLD.milestones OR NEW.created_by_person_id <> OLD.created_by_person_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'assignment terms never change' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
  END IF;
  IF NEW.status = OLD.status THEN
    IF NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
      RAISE EXCEPTION 'completion changes only with the status' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.version_frozen';
    END IF;
    RETURN NEW;
  END IF;
  v_side := trustwork.task_assignment_side(OLD.id);
  SELECT count(DISTINCT r.milestone_key) INTO v_accepted FROM trustwork.task_execution_record r WHERE r.assignment_id = OLD.id AND r.kind = 'acceptance';
  IF NOT (
       (OLD.status IN ('assigned', 'in_progress') AND NEW.status IN ('in_progress', 'delivered') AND v_side = 'assignee')
    OR (OLD.status = 'delivered' AND NEW.status = 'in_progress' AND v_side = 'owner')
    OR (OLD.status IN ('in_progress', 'delivered') AND NEW.status = 'accepted' AND v_side = 'owner' AND v_accepted = jsonb_array_length(OLD.milestones))
  ) THEN
    RAISE EXCEPTION 'assignment transition % -> % is not allowed for this side', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_assignment_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.task_assignment FOR EACH ROW EXECUTE FUNCTION trustwork.task_assignment_guard();

-- Execution records: the assignee claims an open milestone (one unanswered claim at a time, never after acceptance);
-- the owner answers the latest unanswered claim; nothing after the task is completed or cancelled.
CREATE FUNCTION trustwork.task_execution_record_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_assignment trustwork.task_assignment%ROWTYPE;
  v_latest trustwork.task_execution_record%ROWTYPE;
  v_answered boolean;
BEGIN
  SELECT * INTO v_assignment FROM trustwork.task_assignment WHERE id = NEW.assignment_id;
  IF NEW.recorded_by_person_id IS DISTINCT FROM trustwork.current_person_id() OR v_assignment.id IS NULL THEN
    RAISE EXCEPTION 'the recorder is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
  END IF;
  IF v_assignment.status NOT IN ('assigned', 'in_progress', 'delivered') THEN
    RAISE EXCEPTION 'a % task takes no more records', v_assignment.status USING ERRCODE = 'check_violation', HINT = 'commerce.invalid_transition';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_assignment.milestones) m WHERE m ->> 'key' = NEW.milestone_key) THEN
    RAISE EXCEPTION 'unknown milestone' USING ERRCODE = 'check_violation', HINT = 'tasks.unknown_milestone';
  END IF;
  SELECT * INTO v_latest FROM trustwork.task_execution_record r WHERE r.assignment_id = NEW.assignment_id AND r.milestone_key = NEW.milestone_key AND r.kind = 'delivery_claim'
    ORDER BY r.created_at DESC, r.id DESC LIMIT 1;
  v_answered := v_latest.id IS NOT NULL AND EXISTS (SELECT 1 FROM trustwork.task_execution_record r WHERE r.claim_id = v_latest.id);
  IF NEW.kind = 'delivery_claim' THEN
    IF NEW.by_person_id IS DISTINCT FROM v_assignment.assignee_person_id OR NEW.by_company_id IS DISTINCT FROM v_assignment.assignee_company_id
       OR NOT trustwork.commerce_party_acts(v_assignment.assignee_person_id, v_assignment.assignee_company_id, 'company.deals.manage') THEN
      RAISE EXCEPTION 'the assignee claims delivery' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
    END IF;
    IF (v_latest.id IS NOT NULL AND NOT v_answered)
       OR EXISTS (SELECT 1 FROM trustwork.task_execution_record r WHERE r.assignment_id = NEW.assignment_id AND r.milestone_key = NEW.milestone_key AND r.kind = 'acceptance') THEN
      RAISE EXCEPTION 'the milestone has an open claim or is accepted' USING ERRCODE = 'check_violation', HINT = 'tasks.milestone_not_open';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.by_person_id IS DISTINCT FROM v_assignment.owner_person_id OR NEW.by_company_id IS NOT NULL OR v_assignment.owner_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
    RAISE EXCEPTION 'the owner decides on delivered work' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
  END IF;
  IF v_latest.id IS NULL OR NEW.claim_id IS DISTINCT FROM v_latest.id OR v_answered THEN
    RAISE EXCEPTION 'a decision answers the latest open claim of the milestone' USING ERRCODE = 'check_violation', HINT = 'tasks.claim_not_open';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_execution_record_guard BEFORE INSERT ON trustwork.task_execution_record FOR EACH ROW EXECUTE FUNCTION trustwork.task_execution_record_guard();

-- Reviews: allowed only for completed tasks (status accepted), by a person acting for its side, about the other side.
CREATE FUNCTION trustwork.task_review_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_assignment trustwork.task_assignment%ROWTYPE;
BEGIN
  SELECT * INTO v_assignment FROM trustwork.task_assignment WHERE id = NEW.assignment_id;
  IF NEW.written_by_person_id IS DISTINCT FROM trustwork.current_person_id() OR v_assignment.id IS NULL OR trustwork.task_assignment_side(NEW.assignment_id) IS DISTINCT FROM NEW.author_side THEN
    RAISE EXCEPTION 'a party reviews for its own side' USING ERRCODE = 'insufficient_privilege', HINT = 'commerce.not_authorised';
  END IF;
  IF v_assignment.status <> 'accepted' THEN
    RAISE EXCEPTION 'reviews are allowed only for completed tasks' USING ERRCODE = 'check_violation', HINT = 'tasks.review_not_allowed';
  END IF;
  IF NOT ((NEW.author_side = 'owner' AND NEW.author_person_id = v_assignment.owner_person_id AND NEW.author_company_id IS NULL
            AND NEW.subject_person_id IS NOT DISTINCT FROM v_assignment.assignee_person_id AND NEW.subject_company_id IS NOT DISTINCT FROM v_assignment.assignee_company_id)
       OR (NEW.author_side = 'assignee' AND NEW.author_person_id IS NOT DISTINCT FROM v_assignment.assignee_person_id AND NEW.author_company_id IS NOT DISTINCT FROM v_assignment.assignee_company_id
            AND NEW.subject_person_id = v_assignment.owner_person_id AND NEW.subject_company_id IS NULL)) THEN
    RAISE EXCEPTION 'a review names the two parties of the task' USING ERRCODE = 'check_violation', HINT = 'commerce.not_authorised';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_review_guard BEFORE INSERT ON trustwork.task_review FOR EACH ROW EXECUTE FUNCTION trustwork.task_review_guard();

-- 6. Owner-run side effects in the same transaction -------------------------------------------------------------------
-- An amendment flags every offer pinned to an earlier request version `request_amended`; closing, cancelling or
-- expiring flags the remaining open offers `request_closed`. Offers belong to the offerors, so the owner's statement
-- cannot update them directly; this trigger does it with the owner role, and the offer guard checks the facts.
CREATE FUNCTION trustwork.task_request_flag_stale() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id AND NEW.current_version_id IS NOT NULL THEN
    UPDATE trustwork.task_offer SET stale_reason = 'request_amended', stale_at = clock_timestamp()
    WHERE task_request_id = NEW.id AND request_version_id <> NEW.current_version_id AND stale_reason IS NULL AND status IN ('draft', 'sent');
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('closed', 'cancelled', 'expired') THEN
    UPDATE trustwork.task_offer SET stale_reason = 'request_closed', stale_at = clock_timestamp()
    WHERE task_request_id = NEW.id AND stale_reason IS NULL AND status IN ('draft', 'sent');
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER task_request_flag_stale AFTER UPDATE OF current_version_id, status ON trustwork.task_request FOR EACH ROW EXECUTE FUNCTION trustwork.task_request_flag_stale();

-- An assignment closes its request (the request belongs to the owner; the assignee's statement cannot update it).
CREATE FUNCTION trustwork.task_assignment_close_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
BEGIN
  UPDATE trustwork.task_request SET status = 'closed', closed_reason = 'assigned' WHERE id = NEW.task_request_id AND status = 'published';
  RETURN NULL;
END $$;
CREATE TRIGGER task_assignment_close_request AFTER INSERT ON trustwork.task_assignment FOR EACH ROW EXECUTE FUNCTION trustwork.task_assignment_close_request();

-- 7. Agreements with terms_kind task (replaces COM-002 definitions) -------------------------------------------------
-- The owner accepts a sent, valid, non-stale offer pinned to the current published version of its own request; the
-- parties come from the request and the offer; the pinned versions and digests are the stored ones; one live task
-- agreement per request (the request row is locked; the unique index below backs it for the same version). The
-- rfq_quote branch is unchanged; consultation agreements stay refused until CONS-001.
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
  v_buyer boolean;
  v_seller boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'agreements are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'commerce.retained';
  END IF;
  IF TG_OP = 'INSERT' THEN
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

-- One live task agreement per request version (with the request lock and the amendment block above: per request).
CREATE UNIQUE INDEX agreement_one_live_per_task_request_version ON trustwork.agreement (request_ref_id) WHERE terms_kind = 'task' AND status IN ('proposed', 'accepted_by_buyer', 'accepted_by_both');
CREATE INDEX agreement_offer_ref_idx ON trustwork.agreement (offer_ref_id) WHERE offer_ref_id IS NOT NULL;

-- The digest equality trigger, unchanged except that a task seller accepts the agreement itself (no order in this
-- slice: obligations record the payments, which move outside the platform or through a licensed provider).
CREATE OR REPLACE FUNCTION trustwork.acceptance_event_guard() RETURNS trigger
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
    IF NEW.kind = 'seller_accepts_order' AND v_agreement.terms_kind = 'rfq_quote' AND NOT EXISTS (SELECT 1 FROM trustwork.commercial_order o WHERE o.agreement_id = NEW.agreement_id AND o.status = 'placed') THEN
      RAISE EXCEPTION 'the seller accepts a placed order' USING ERRCODE = 'check_violation', HINT = 'transactions.order_missing';
    END IF;
    IF NEW.transaction_budget_id IS NOT NULL OR NEW.reservation_id IS NOT NULL OR NEW.platform_budget_id IS NOT NULL THEN
      RAISE EXCEPTION 'seller events carry no buyer budget' USING ERRCODE = 'check_violation', HINT = 'commerce.not_authorised';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- The insert policy now admits the task owner as well (COM-002 required an RFQ).
DROP POLICY agreement_insert ON trustwork.agreement;
CREATE POLICY agreement_insert ON trustwork.agreement FOR INSERT TO trustwork_app
  WITH CHECK (created_by_person_id = trustwork.current_person_id() AND (
    (terms_kind = 'rfq_quote' AND rfq_id IS NOT NULL AND (trustwork.rfq_can(rfq_id, 'accept') OR (supersedes_id IS NOT NULL AND trustwork.agreement_side(supersedes_id) IS NOT NULL)))
    OR (terms_kind = 'task' AND buyer_person_id = trustwork.current_person_id() AND buyer_company_id IS NULL)));

-- 8. Row-level security -----------------------------------------------------------------------------------------------
ALTER TABLE trustwork.task_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.task_request FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.task_request_private ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.task_request_private FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.task_request_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.task_request_version FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.task_invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.task_invitation FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.task_offer ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.task_offer FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.task_offer_private ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.task_offer_private FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.task_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.task_assignment FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.task_execution_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.task_execution_record FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.task_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.task_review FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.task_request AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.task_request_private AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.task_request_version AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.task_invitation AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.task_offer AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.task_offer_private AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.task_assignment AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.task_execution_record AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.task_review AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

-- Requests: the owner reads and writes; others read published briefs they may see (open, invited, or offered on).
CREATE POLICY task_request_read ON trustwork.task_request FOR SELECT TO trustwork_app
  USING (owner_person_id = trustwork.current_person_id() OR trustwork.task_request_visible(id));
CREATE POLICY task_request_insert ON trustwork.task_request FOR INSERT TO trustwork_app
  WITH CHECK (creator_person_id = trustwork.current_person_id() AND owner_person_id = trustwork.current_person_id());
CREATE POLICY task_request_update ON trustwork.task_request FOR UPDATE TO trustwork_app
  USING (owner_person_id = trustwork.current_person_id()) WITH CHECK (owner_person_id = trustwork.current_person_id());
CREATE POLICY task_request_private_read ON trustwork.task_request_private FOR SELECT TO trustwork_app USING (owner_person_id = trustwork.current_person_id());
CREATE POLICY task_request_private_insert ON trustwork.task_request_private FOR INSERT TO trustwork_app WITH CHECK (owner_person_id = trustwork.current_person_id());
CREATE POLICY task_request_private_update ON trustwork.task_request_private FOR UPDATE TO trustwork_app
  USING (owner_person_id = trustwork.current_person_id()) WITH CHECK (owner_person_id = trustwork.current_person_id());
CREATE POLICY task_request_version_read ON trustwork.task_request_version FOR SELECT TO trustwork_app
  USING (trustwork.task_request_owned(task_request_id) OR (status <> 'draft' AND trustwork.task_request_visible(task_request_id)));
CREATE POLICY task_request_version_insert ON trustwork.task_request_version FOR INSERT TO trustwork_app WITH CHECK (trustwork.task_request_owned(task_request_id));
CREATE POLICY task_request_version_update ON trustwork.task_request_version FOR UPDATE TO trustwork_app
  USING (trustwork.task_request_owned(task_request_id)) WITH CHECK (trustwork.task_request_owned(task_request_id));

-- Invitations: the owner sees all of its request's invitations; an invitee only its own.
CREATE POLICY task_invitation_read ON trustwork.task_invitation FOR SELECT TO trustwork_app
  USING (trustwork.task_request_owned(task_request_id) OR trustwork.commerce_party_acts(party_person_id, party_company_id, 'company.deals.manage'));
CREATE POLICY task_invitation_insert ON trustwork.task_invitation FOR INSERT TO trustwork_app WITH CHECK (trustwork.task_request_owned(task_request_id));
CREATE POLICY task_invitation_update ON trustwork.task_invitation FOR UPDATE TO trustwork_app
  USING (trustwork.task_request_owned(task_request_id) OR trustwork.commerce_party_acts(party_person_id, party_company_id, 'company.deals.manage'))
  WITH CHECK (trustwork.task_request_owned(task_request_id) OR trustwork.commerce_party_acts(party_person_id, party_company_id, 'company.deals.manage'));

-- Offers: the offeror side reads and writes its own; the owner reads sent versions only. Competing offerors match
-- neither branch, so they never see each other's offers. The private half is the offeror's only.
CREATE POLICY task_offer_read ON trustwork.task_offer FOR SELECT TO trustwork_app
  USING (trustwork.commerce_party_acts(offeror_person_id, offeror_company_id, 'company.deals.manage') OR (status <> 'draft' AND owner_person_id = trustwork.current_person_id()));
CREATE POLICY task_offer_insert ON trustwork.task_offer FOR INSERT TO trustwork_app
  WITH CHECK (drafted_by_person_id = trustwork.current_person_id() AND trustwork.commerce_party_acts(offeror_person_id, offeror_company_id, 'company.deals.manage'));
CREATE POLICY task_offer_update ON trustwork.task_offer FOR UPDATE TO trustwork_app
  USING (trustwork.commerce_party_acts(offeror_person_id, offeror_company_id, 'company.deals.manage'))
  WITH CHECK (trustwork.commerce_party_acts(offeror_person_id, offeror_company_id, 'company.deals.manage'));
CREATE POLICY task_offer_private_read ON trustwork.task_offer_private FOR SELECT TO trustwork_app
  USING (trustwork.commerce_party_acts(offeror_person_id, offeror_company_id, 'company.deals.manage'));
CREATE POLICY task_offer_private_insert ON trustwork.task_offer_private FOR INSERT TO trustwork_app
  WITH CHECK (trustwork.commerce_party_acts(offeror_person_id, offeror_company_id, 'company.deals.manage'));
CREATE POLICY task_offer_private_update ON trustwork.task_offer_private FOR UPDATE TO trustwork_app
  USING (trustwork.commerce_party_acts(offeror_person_id, offeror_company_id, 'company.deals.manage'))
  WITH CHECK (trustwork.commerce_party_acts(offeror_person_id, offeror_company_id, 'company.deals.manage'));

-- Assignments, records and reviews: the two parties only.
CREATE POLICY task_assignment_read ON trustwork.task_assignment FOR SELECT TO trustwork_app
  USING (owner_person_id = trustwork.current_person_id() OR trustwork.commerce_party_acts(assignee_person_id, assignee_company_id, 'company.deals.manage'));
CREATE POLICY task_assignment_insert ON trustwork.task_assignment FOR INSERT TO trustwork_app
  WITH CHECK (created_by_person_id = trustwork.current_person_id() AND trustwork.commerce_party_acts(assignee_person_id, assignee_company_id, 'company.deals.manage'));
CREATE POLICY task_assignment_update ON trustwork.task_assignment FOR UPDATE TO trustwork_app
  USING (owner_person_id = trustwork.current_person_id() OR trustwork.commerce_party_acts(assignee_person_id, assignee_company_id, 'company.deals.manage'))
  WITH CHECK (owner_person_id = trustwork.current_person_id() OR trustwork.commerce_party_acts(assignee_person_id, assignee_company_id, 'company.deals.manage'));
CREATE POLICY task_execution_record_read ON trustwork.task_execution_record FOR SELECT TO trustwork_app USING (trustwork.task_assignment_side(assignment_id) IS NOT NULL);
CREATE POLICY task_execution_record_insert ON trustwork.task_execution_record FOR INSERT TO trustwork_app WITH CHECK (trustwork.task_assignment_side(assignment_id) IS NOT NULL);
CREATE POLICY task_review_read ON trustwork.task_review FOR SELECT TO trustwork_app USING (trustwork.task_assignment_side(assignment_id) IS NOT NULL);
CREATE POLICY task_review_insert ON trustwork.task_review FOR INSERT TO trustwork_app WITH CHECK (trustwork.task_assignment_side(assignment_id) IS NOT NULL);

-- 9. Grants -------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT ON trustwork.task_request, trustwork.task_request_private, trustwork.task_request_version, trustwork.task_invitation, trustwork.task_offer,
  trustwork.task_offer_private, trustwork.task_assignment, trustwork.task_execution_record, trustwork.task_review TO trustwork_app;
GRANT UPDATE (status, current_version, current_version_id, closed_reason) ON trustwork.task_request TO trustwork_app;
GRANT UPDATE (budget_ceiling_minor, budget_ceiling_currency, owner_notes, updated_by_person_id) ON trustwork.task_request_private TO trustwork_app;
GRANT UPDATE (status, terms, payload, digest, published_at, published_by_person_id, published_via, published_mandate_id, amendment_reason, superseded_at) ON trustwork.task_request_version TO trustwork_app;
GRANT UPDATE (status) ON trustwork.task_invitation TO trustwork_app;
GRANT UPDATE (status, payload, valid_until, digest, sent_at, sent_by_person_id, sent_via, sent_mandate_id, withdrawn_reason, superseded_at) ON trustwork.task_offer TO trustwork_app;
GRANT UPDATE (floor_price_minor, floor_price_currency, offeror_notes, updated_by_person_id) ON trustwork.task_offer_private TO trustwork_app;
GRANT UPDATE (status, completed_at) ON trustwork.task_assignment TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.task_request_owned(uuid), trustwork.task_request_visible(uuid), trustwork.task_assignment_side(uuid), trustwork.task_assignment_site(uuid),
  trustwork.tasks_offer_for_share(uuid), trustwork.task_request_live_agreement(uuid), trustwork.task_request_flag_stale(), trustwork.task_assignment_close_request() TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
