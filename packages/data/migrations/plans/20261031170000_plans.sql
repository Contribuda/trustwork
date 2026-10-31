-- PLAN-001 project plans (ADR 010 decision 17; ADR 012 decisions 13, 14, 23 and 37). One plan per project; versions
-- draft -> proposed -> approved -> superseded; plan items keyed by the open plan-step taxonomy (DATA-003 taxonomy_term);
-- acyclic dependencies; the mutable execution state beside the frozen version; plan changes with attribution; per-item
-- shares with invited parties; permit records; the private diary and the owner-private site location.
--
-- Everything is owner-private and under FORCE RLS. Access follows the project: the owner party (a company through
-- members holding company.deals.manage, or company.publish for public shares) or a live project participation with
-- audience owner_private carrying the capability. Invitees never read plan tables: they receive only the listed fields
-- of their live shares through trustwork.plan_shared_view (owner-run, re-checks the share at every call).
-- Mirrors packages/contracts/src/plans.ts (PlanContentSchema, PlanShareSchema, transition tables).

-- 0. Access ---------------------------------------------------------------------------------------------------------
-- SECURITY DEFINER because policies on plan tables must read project and object_participation (FORCE RLS) without
-- recursion. Capabilities outside the plan vocabulary always deny.
CREATE FUNCTION trustwork.plan_project_can(p_project_id uuid, p_capability text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.current_person_id() IS NOT NULL
    AND p_capability IN ('read.owner_private', 'write.draft', 'invite', 'publish', 'accept')
    AND (
      EXISTS (
        SELECT 1 FROM trustwork.project p
        WHERE p.id = p_project_id
          AND (coalesce(p.owner_person_id = trustwork.current_person_id(), false)
               OR (coalesce(p.owner_company_id = trustwork.current_company_id(), false)
                   AND trustwork.current_membership_has(CASE WHEN p_capability = 'publish' THEN 'company.publish' ELSE 'company.deals.manage' END)))
      )
      OR EXISTS (
        SELECT 1 FROM trustwork.object_participation op
        WHERE op.resource_kind = 'project' AND op.resource_id = p_project_id
          AND op.side <> 'staff' AND op.audience = 'owner_private'
          AND op.revoked_at IS NULL AND op.valid_from <= now() AND (op.valid_until IS NULL OR op.valid_until > now())
          AND p_capability = ANY (op.capabilities)
          AND (op.party_person_id = trustwork.current_person_id()
               OR (op.party_company_id IS NOT NULL AND op.party_company_id = trustwork.current_company_id()
                   AND trustwork.current_membership_has(CASE WHEN p_capability = 'publish' THEN 'company.publish' ELSE 'company.deals.manage' END)))
      )
    )
$$;

-- Frozen rows: any UPDATE or DELETE raises, for every role (versions and their items are kept for ever).
CREATE FUNCTION trustwork.plan_frozen_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are frozen (% rejected)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation', HINT = 'plans.version_frozen';
END $$;

-- 1. Plan -----------------------------------------------------------------------------------------------------------
CREATE TABLE trustwork.plan (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  project_id uuid NOT NULL UNIQUE REFERENCES trustwork.project (id),
  status text NOT NULL DEFAULT 'drafting' CHECK (status IN ('drafting', 'active', 'closed')),
  current_version_id uuid NULL,
  time_zone text NOT NULL CHECK (time_zone ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+)+$' OR time_zone = 'UTC'),
  created_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  drafted_via text NOT NULL CHECK (drafted_via IN ('person', 'agent')),
  drafted_mandate_id text NULL CHECK (drafted_mandate_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_id_project UNIQUE (id, project_id),
  CONSTRAINT plan_agent_mandate CHECK ((drafted_via = 'agent') = (drafted_mandate_id IS NOT NULL)),
  CONSTRAINT plan_active_has_baseline CHECK (status = 'drafting' OR current_version_id IS NOT NULL)
);
CREATE TRIGGER plan_touch BEFORE UPDATE ON trustwork.plan FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

CREATE FUNCTION trustwork.plan_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'plans are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'plans.version_frozen';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
      RAISE EXCEPTION 'plan creator must be the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'plans.not_authorised';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.project_id <> OLD.project_id OR NEW.created_by_person_id <> OLD.created_by_person_id
     OR NEW.drafted_via <> OLD.drafted_via OR NEW.drafted_mandate_id IS DISTINCT FROM OLD.drafted_mandate_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'plan identity is immutable' USING ERRCODE = 'integrity_constraint_violation', HINT = 'plans.version_frozen';
  END IF;
  -- The baseline pointer only ever moves to an approved version, by a person holding `accept`; never back to none.
  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN
    IF NEW.current_version_id IS NULL OR NOT EXISTS (SELECT 1 FROM trustwork.plan_version v WHERE v.id = NEW.current_version_id AND v.status = 'approved')
       OR NOT trustwork.plan_project_can(NEW.project_id, 'accept') THEN
      RAISE EXCEPTION 'the baseline is the approved version' USING ERRCODE = 'integrity_constraint_violation', HINT = 'plans.version_frozen';
    END IF;
  END IF;
  IF OLD.status <> 'drafting' AND NEW.status = 'drafting' THEN
    RAISE EXCEPTION 'an active plan keeps its baseline' USING ERRCODE = 'integrity_constraint_violation', HINT = 'plans.version_frozen';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER plan_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.plan FOR EACH ROW EXECUTE FUNCTION trustwork.plan_guard();

-- 2. Versions -------------------------------------------------------------------------------------------------------
-- content: PlanContentSchema (summary, assumptions, budget range, timeline, items, dependencies). Editable only while
-- draft; on proposal the items and dependencies are materialised into plan_item / plan_dependency in the same
-- transaction, the digest is recorded and the version freezes. Approval is the owner's act (or of a person holding
-- `accept` with owner_private audience); an agent proposes only under a mandate and never approves.
CREATE TABLE trustwork.plan_version (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  plan_id uuid NOT NULL,
  project_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'proposed', 'approved', 'superseded')),
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object' AND jsonb_typeof(content -> 'items') = 'array' AND jsonb_typeof(content -> 'dependencies') = 'array'),
  digest text NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  based_on_version_id uuid NULL REFERENCES trustwork.plan_version (id),
  drafted_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  drafted_via text NOT NULL CHECK (drafted_via IN ('person', 'agent')),
  drafted_mandate_id text NULL CHECK (drafted_mandate_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  proposed_by_person_id uuid NULL REFERENCES trustwork.person (id),
  proposed_via text NULL CHECK (proposed_via IN ('person', 'agent')),
  proposed_mandate_id text NULL CHECK (proposed_mandate_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  proposed_at timestamptz NULL,
  approved_by_person_id uuid NULL REFERENCES trustwork.person (id),
  approved_at timestamptz NULL,
  superseded_at timestamptz NULL,
  superseded_by_version_id uuid NULL REFERENCES trustwork.plan_version (id),
  superseded_reason text NULL CHECK (superseded_reason IN ('returned', 'replaced')),
  change_id uuid NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_version_plan FOREIGN KEY (plan_id, project_id) REFERENCES trustwork.plan (id, project_id),
  CONSTRAINT plan_version_number UNIQUE (plan_id, version),
  CONSTRAINT plan_version_id_plan UNIQUE (id, plan_id),
  CONSTRAINT plan_version_digest_bound CHECK ((status = 'draft') = (digest IS NULL)),
  CONSTRAINT plan_version_proposal CHECK (
    (status = 'draft') = (proposed_at IS NULL)
    AND (proposed_at IS NULL) = (proposed_by_person_id IS NULL)
    AND (proposed_at IS NULL) = (proposed_via IS NULL)
    AND (proposed_mandate_id IS NULL OR proposed_via = 'agent')
    AND (proposed_via IS DISTINCT FROM 'agent' OR proposed_mandate_id IS NOT NULL)
  ),
  CONSTRAINT plan_version_drafted_mandate CHECK ((drafted_via = 'agent') = (drafted_mandate_id IS NOT NULL)),
  CONSTRAINT plan_version_approval CHECK (
    (approved_at IS NULL) = (approved_by_person_id IS NULL)
    AND (status <> 'approved' OR approved_at IS NOT NULL)
    AND (status NOT IN ('draft', 'proposed') OR approved_at IS NULL)
  ),
  CONSTRAINT plan_version_superseded CHECK ((status = 'superseded') = (superseded_at IS NOT NULL) AND (superseded_at IS NULL) = (superseded_reason IS NULL))
);
CREATE UNIQUE INDEX plan_version_one_draft ON trustwork.plan_version (plan_id) WHERE status = 'draft';
CREATE UNIQUE INDEX plan_version_one_proposed ON trustwork.plan_version (plan_id) WHERE status = 'proposed';
CREATE UNIQUE INDEX plan_version_one_approved ON trustwork.plan_version (plan_id) WHERE status = 'approved';
CREATE INDEX plan_version_project_idx ON trustwork.plan_version (project_id);
CREATE TRIGGER plan_version_touch BEFORE UPDATE ON trustwork.plan_version FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
ALTER TABLE trustwork.plan ADD CONSTRAINT plan_current_version FOREIGN KEY (current_version_id, id) REFERENCES trustwork.plan_version (id, plan_id);

-- 3. Items and dependencies (frozen: inserted only while their version is still a draft, never changed) ------------
CREATE TABLE trustwork.plan_item (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  plan_version_id uuid NOT NULL REFERENCES trustwork.plan_version (id),
  plan_id uuid NOT NULL,
  project_id uuid NOT NULL,
  item_key text NOT NULL CHECK (item_key ~ '^[a-z][a-z0-9_-]{0,63}$'),
  parent_key text NULL,
  position integer NOT NULL CHECK (position >= 0),
  kind text NOT NULL CHECK (kind IN ('phase', 'task', 'milestone', 'consultation', 'purchase', 'material', 'permit', 'inspection', 'decision', 'risk', 'self')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description text NULL CHECK (length(description) <= 20000),
  step_terms text[] NOT NULL DEFAULT '{}' CHECK (cardinality(step_terms) <= 30),
  required_skills text[] NOT NULL DEFAULT '{}' CHECK (cardinality(required_skills) <= 20),
  quantity_value text NULL CHECK (quantity_value ~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,6})?$'),
  quantity_unit text NULL CHECK (quantity_unit ~ '^[a-z][a-z0-9_]{0,15}$'),
  estimate_low bigint NULL CHECK (estimate_low >= 0),
  estimate_high bigint NULL,
  estimate_currency text NULL CHECK (estimate_currency ~ '^[A-Z]{3}$'),
  estimate_basis text NULL CHECK (estimate_basis IN ('template', 'licensed_source', 'own_quote', 'lesson', 'owner_estimate')),
  estimate_basis_ref text NULL CHECK (length(estimate_basis_ref) BETWEEN 1 AND 200),
  estimate_as_of date NULL,
  duration_low_days integer NULL CHECK (duration_low_days BETWEEN 0 AND 3650),
  duration_high_days integer NULL CHECK (duration_high_days BETWEEN 0 AND 3650),
  window_start date NULL,
  window_finish date NULL,
  risk_level text NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  decision_question text NULL CHECK (length(decision_question) BETWEEN 1 AND 500),
  sources jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sources) = 'array'),
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attachments) = 'array'),
  private_notes text NULL CHECK (length(private_notes) <= 20000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_item_key_unique UNIQUE (plan_version_id, item_key),
  CONSTRAINT plan_item_version FOREIGN KEY (plan_version_id, plan_id) REFERENCES trustwork.plan_version (id, plan_id),
  CONSTRAINT plan_item_parent FOREIGN KEY (plan_version_id, parent_key) REFERENCES trustwork.plan_item (plan_version_id, item_key),
  CONSTRAINT plan_item_not_own_parent CHECK (parent_key IS DISTINCT FROM item_key),
  CONSTRAINT plan_item_quantity CHECK ((quantity_value IS NULL) = (quantity_unit IS NULL)),
  -- An estimate is a range with a basis and a date, never a single figure (BudgetRangeSchema).
  CONSTRAINT plan_item_estimate_range CHECK (
    (estimate_low IS NULL) = (estimate_high IS NULL) AND (estimate_low IS NULL) = (estimate_currency IS NULL)
    AND (estimate_low IS NULL) = (estimate_basis IS NULL) AND (estimate_low IS NULL) = (estimate_as_of IS NULL)
    AND (estimate_low IS NULL OR estimate_low < estimate_high)
    AND (estimate_basis IS NULL OR estimate_basis = 'owner_estimate' OR estimate_basis_ref IS NOT NULL)
  ),
  CONSTRAINT plan_item_duration CHECK ((duration_low_days IS NULL) = (duration_high_days IS NULL) AND (duration_low_days IS NULL OR duration_low_days <= duration_high_days)),
  CONSTRAINT plan_item_window CHECK (window_start IS NULL OR window_finish IS NULL OR window_start <= window_finish),
  CONSTRAINT plan_item_risk CHECK (kind <> 'risk' OR risk_level IS NOT NULL)
);
CREATE INDEX plan_item_project_idx ON trustwork.plan_item (project_id);

CREATE TABLE trustwork.plan_dependency (
  plan_version_id uuid NOT NULL REFERENCES trustwork.plan_version (id),
  plan_id uuid NOT NULL,
  project_id uuid NOT NULL,
  predecessor_key text NOT NULL,
  successor_key text NOT NULL,
  type text NOT NULL CHECK (type IN ('fs', 'ss', 'ff', 'sf')),
  lag_days integer NOT NULL DEFAULT 0 CHECK (lag_days BETWEEN -365 AND 365),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_version_id, predecessor_key, successor_key),
  CONSTRAINT plan_dependency_not_self CHECK (predecessor_key <> successor_key),
  CONSTRAINT plan_dependency_predecessor FOREIGN KEY (plan_version_id, predecessor_key) REFERENCES trustwork.plan_item (plan_version_id, item_key),
  CONSTRAINT plan_dependency_successor FOREIGN KEY (plan_version_id, successor_key) REFERENCES trustwork.plan_item (plan_version_id, item_key)
);
CREATE INDEX plan_dependency_project_idx ON trustwork.plan_dependency (project_id);

-- Items and dependencies join a version only while it is a draft. FOR SHARE waits for a concurrent proposal (which
-- holds the version row) and then sees it frozen. Items take plan and project from their version; their terms must
-- be released taxonomy codes, and the kind must carry a term of its scheme (KIND_REQUIRED_PREFIX in the contract).
CREATE FUNCTION trustwork.plan_part_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_version trustwork.plan_version%ROWTYPE;
  v_prefix text;
BEGIN
  SELECT * INTO v_version FROM trustwork.plan_version WHERE id = NEW.plan_version_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown plan version' USING ERRCODE = 'foreign_key_violation', HINT = 'plans.not_found';
  END IF;
  IF v_version.status <> 'draft' THEN
    RAISE EXCEPTION 'plan version % is frozen', v_version.version USING ERRCODE = 'integrity_constraint_violation', HINT = 'plans.version_frozen';
  END IF;
  NEW.plan_id := v_version.plan_id;
  NEW.project_id := v_version.project_id;
  IF TG_TABLE_NAME = 'plan_item' THEN
    IF EXISTS (
      SELECT 1 FROM unnest(NEW.step_terms || NEW.required_skills) AS c(code)
      WHERE NOT EXISTS (SELECT 1 FROM trustwork.taxonomy_term t WHERE t.code = c.code AND t.status = 'released')
    ) THEN
      RAISE EXCEPTION 'plan item % names an unknown or unreleased taxonomy term', NEW.item_key USING ERRCODE = 'check_violation', HINT = 'plans.unknown_term';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(NEW.required_skills) AS c(code) WHERE c.code NOT LIKE 'trade.%') THEN
      RAISE EXCEPTION 'required skills are trade codes' USING ERRCODE = 'check_violation', HINT = 'plans.unknown_term';
    END IF;
    v_prefix := CASE NEW.kind WHEN 'phase' THEN 'stage' WHEN 'task' THEN 'work' WHEN 'consultation' THEN 'work' WHEN 'self' THEN 'work'
      WHEN 'purchase' THEN 'material' WHEN 'material' THEN 'material' WHEN 'permit' THEN 'permit' WHEN 'inspection' THEN 'inspection'
      WHEN 'decision' THEN 'decision' ELSE NULL END;
    IF v_prefix IS NOT NULL AND NOT EXISTS (SELECT 1 FROM unnest(NEW.step_terms) AS c(code) WHERE split_part(c.code, '.', 1) = v_prefix) THEN
      RAISE EXCEPTION 'a % item needs a % term', NEW.kind, v_prefix USING ERRCODE = 'check_violation', HINT = 'plans.unknown_term';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER plan_item_guard BEFORE INSERT ON trustwork.plan_item FOR EACH ROW EXECUTE FUNCTION trustwork.plan_part_guard();
CREATE TRIGGER plan_item_frozen BEFORE UPDATE OR DELETE ON trustwork.plan_item FOR EACH ROW EXECUTE FUNCTION trustwork.plan_frozen_row();
CREATE TRIGGER plan_dependency_guard BEFORE INSERT ON trustwork.plan_dependency FOR EACH ROW EXECUTE FUNCTION trustwork.plan_part_guard();
CREATE TRIGGER plan_dependency_frozen BEFORE UPDATE OR DELETE ON trustwork.plan_dependency FOR EACH ROW EXECUTE FUNCTION trustwork.plan_frozen_row();

-- Version guard: identity never changes; content, digest and proposal freeze once proposed; transitions follow the
-- contract table; proposal needs write.draft and the materialised, acyclic parts; approval needs `accept` and names the
-- principal; approval and supersession facts change only together with the status. Never deleted.
CREATE FUNCTION trustwork.plan_version_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'plan versions are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'plans.version_frozen';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'a version starts as a draft' USING ERRCODE = 'check_violation', HINT = 'plans.invalid_version_transition';
    END IF;
    IF NEW.drafted_by_person_id IS DISTINCT FROM v_person THEN
      RAISE EXCEPTION 'the drafter is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'plans.not_authorised';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.plan_id <> OLD.plan_id OR NEW.project_id <> OLD.project_id OR NEW.version <> OLD.version
     OR NEW.based_on_version_id IS DISTINCT FROM OLD.based_on_version_id OR NEW.drafted_by_person_id <> OLD.drafted_by_person_id
     OR NEW.drafted_via <> OLD.drafted_via OR NEW.drafted_mandate_id IS DISTINCT FROM OLD.drafted_mandate_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'plan version identity is immutable' USING ERRCODE = 'integrity_constraint_violation', HINT = 'plans.version_frozen';
  END IF;
  IF OLD.status <> 'draft' AND (NEW.content IS DISTINCT FROM OLD.content OR NEW.digest IS DISTINCT FROM OLD.digest
     OR NEW.proposed_by_person_id IS DISTINCT FROM OLD.proposed_by_person_id OR NEW.proposed_via IS DISTINCT FROM OLD.proposed_via
     OR NEW.proposed_mandate_id IS DISTINCT FROM OLD.proposed_mandate_id OR NEW.proposed_at IS DISTINCT FROM OLD.proposed_at) THEN
    RAISE EXCEPTION 'plan version % is frozen', OLD.version USING ERRCODE = 'integrity_constraint_violation', HINT = 'plans.version_frozen';
  END IF;
  IF NEW.change_id IS DISTINCT FROM OLD.change_id AND (OLD.change_id IS NOT NULL OR OLD.status NOT IN ('draft', 'proposed')) THEN
    RAISE EXCEPTION 'a version records one change' USING ERRCODE = 'integrity_constraint_violation', HINT = 'plans.version_frozen';
  END IF;
  IF NEW.status = OLD.status THEN
    IF NEW.approved_by_person_id IS DISTINCT FROM OLD.approved_by_person_id OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.superseded_at IS DISTINCT FROM OLD.superseded_at OR NEW.superseded_by_version_id IS DISTINCT FROM OLD.superseded_by_version_id
       OR NEW.superseded_reason IS DISTINCT FROM OLD.superseded_reason THEN
      RAISE EXCEPTION 'approval and supersession change only with the status' USING ERRCODE = 'integrity_constraint_violation', HINT = 'plans.version_frozen';
    END IF;
    IF OLD.status = 'draft' AND NEW.content IS DISTINCT FROM OLD.content AND NOT trustwork.plan_project_can(NEW.project_id, 'write.draft') THEN
      RAISE EXCEPTION 'editing a draft needs write.draft' USING ERRCODE = 'insufficient_privilege', HINT = 'plans.not_authorised';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status = 'draft' AND NEW.status = 'proposed') OR (OLD.status = 'proposed' AND NEW.status IN ('approved', 'superseded')) OR (OLD.status = 'approved' AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'plan version transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'plans.invalid_version_transition';
  END IF;
  IF NEW.status = 'proposed' THEN
    IF NEW.proposed_by_person_id IS DISTINCT FROM v_person OR NOT trustwork.plan_project_can(NEW.project_id, 'write.draft') THEN
      RAISE EXCEPTION 'proposing needs write.draft and names the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'plans.not_authorised';
    END IF;
    IF (SELECT count(*) FROM trustwork.plan_item WHERE plan_version_id = NEW.id) <> jsonb_array_length(NEW.content -> 'items')
       OR (SELECT count(*) FROM trustwork.plan_dependency WHERE plan_version_id = NEW.id) <> jsonb_array_length(NEW.content -> 'dependencies') THEN
      RAISE EXCEPTION 'items and dependencies are materialised with the proposal' USING ERRCODE = 'check_violation', HINT = 'plans.parts_missing';
    END IF;
    IF EXISTS (
      WITH RECURSIVE reach(start_key, key) AS (
        SELECT predecessor_key, successor_key FROM trustwork.plan_dependency WHERE plan_version_id = NEW.id
        UNION
        SELECT r.start_key, d.successor_key FROM reach r JOIN trustwork.plan_dependency d ON d.plan_version_id = NEW.id AND d.predecessor_key = r.key
      )
      SELECT 1 FROM reach WHERE start_key = key
    ) THEN
      RAISE EXCEPTION 'plan dependencies contain a cycle' USING ERRCODE = 'check_violation', HINT = 'plans.dependency_cycle';
    END IF;
  ELSIF NEW.status = 'approved' THEN
    IF NEW.approved_by_person_id IS DISTINCT FROM v_person OR NOT trustwork.plan_project_can(NEW.project_id, 'accept') THEN
      RAISE EXCEPTION 'only the owner or a person the owner authorised approves' USING ERRCODE = 'insufficient_privilege', HINT = 'plans.not_authorised';
    END IF;
  ELSIF NEW.status = 'superseded' THEN
    IF NEW.approved_by_person_id IS DISTINCT FROM OLD.approved_by_person_id OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
      RAISE EXCEPTION 'approval facts are kept when superseded' USING ERRCODE = 'integrity_constraint_violation', HINT = 'plans.version_frozen';
    END IF;
    IF NOT (trustwork.plan_project_can(NEW.project_id, 'write.draft') OR trustwork.plan_project_can(NEW.project_id, 'accept')) THEN
      RAISE EXCEPTION 'superseding needs plan authority' USING ERRCODE = 'insufficient_privilege', HINT = 'plans.not_authorised';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER plan_version_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.plan_version FOR EACH ROW EXECUTE FUNCTION trustwork.plan_version_guard();

-- 4. Execution state beside the frozen version --------------------------------------------------------------------
-- One row per (plan, item key). The path an item takes (task, RFQ, requisition, consultation, do it myself) is recorded
-- once and never replaced by another (ADR 012 decision 37); linking a request never edits the frozen item.
CREATE TABLE trustwork.plan_item_state (
  plan_id uuid NOT NULL,
  project_id uuid NOT NULL,
  item_key text NOT NULL CHECK (item_key ~ '^[a-z][a-z0-9_-]{0,63}$'),
  status text NOT NULL CHECK (status IN ('proposed', 'accepted', 'requested', 'in_progress', 'done', 'blocked', 'cancelled', 'skipped')),
  path text NULL CHECK (path IN ('task', 'rfq', 'requisition', 'consultation', 'self')),
  link_kind text NULL CHECK (link_kind IN ('task_request', 'rfq', 'requisition', 'consultation_request', 'permit_record', 'course', 'event')),
  link_id text NULL CHECK (link_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  blocked_from text NULL CHECK (blocked_from IN ('requested', 'in_progress')),
  actual_start date NULL,
  actual_end date NULL,
  updated_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id, item_key),
  CONSTRAINT plan_item_state_plan FOREIGN KEY (plan_id, project_id) REFERENCES trustwork.plan (id, project_id),
  CONSTRAINT plan_item_state_link CHECK ((link_kind IS NULL) = (link_id IS NULL)),
  CONSTRAINT plan_item_state_link_matches_path CHECK (link_kind IS NULL OR (path, link_kind) IN (
    ('task', 'task_request'), ('rfq', 'rfq'), ('requisition', 'requisition'), ('consultation', 'consultation_request'), ('self', 'course'), ('self', 'event')
  )),
  CONSTRAINT plan_item_state_requested CHECK (status <> 'requested' OR (link_kind IS NOT NULL AND path <> 'self')),
  CONSTRAINT plan_item_state_blocked CHECK ((status = 'blocked') = (blocked_from IS NOT NULL)),
  CONSTRAINT plan_item_state_dates CHECK (actual_start IS NULL OR actual_end IS NULL OR actual_start <= actual_end)
);
CREATE INDEX plan_item_state_project_idx ON trustwork.plan_item_state (project_id);
CREATE TRIGGER plan_item_state_touch BEFORE UPDATE ON trustwork.plan_item_state FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

CREATE FUNCTION trustwork.plan_item_state_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_plan trustwork.plan%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'item states are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'plans.version_frozen';
  END IF;
  IF NEW.updated_by_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
    RAISE EXCEPTION 'the updater is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'plans.not_authorised';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO v_plan FROM trustwork.plan WHERE id = NEW.plan_id;
    IF NOT EXISTS (SELECT 1 FROM trustwork.plan_item i WHERE i.plan_version_id = v_plan.current_version_id AND i.item_key = NEW.item_key) THEN
      RAISE EXCEPTION 'item % is not in the approved baseline', NEW.item_key USING ERRCODE = 'check_violation', HINT = 'plans.item_not_in_baseline';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.plan_id <> OLD.plan_id OR NEW.project_id <> OLD.project_id OR NEW.item_key <> OLD.item_key OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'item state identity is immutable' USING ERRCODE = 'integrity_constraint_violation', HINT = 'plans.version_frozen';
  END IF;
  IF (OLD.path IS NOT NULL AND NEW.path IS DISTINCT FROM OLD.path) OR (OLD.link_id IS NOT NULL AND (NEW.link_id IS DISTINCT FROM OLD.link_id OR NEW.link_kind IS DISTINCT FROM OLD.link_kind)) THEN
    RAISE EXCEPTION 'item % already took a path', OLD.item_key USING ERRCODE = 'integrity_constraint_violation', HINT = 'plans.item_path_taken';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'proposed' AND NEW.status IN ('accepted', 'cancelled', 'skipped'))
    OR (OLD.status = 'accepted' AND NEW.status IN ('requested', 'in_progress', 'cancelled', 'skipped'))
    OR (OLD.status = 'requested' AND NEW.status IN ('in_progress', 'blocked', 'cancelled', 'skipped'))
    OR (OLD.status = 'in_progress' AND NEW.status IN ('done', 'blocked', 'cancelled', 'skipped'))
    OR (OLD.status = 'blocked' AND (NEW.status IN ('cancelled', 'skipped') OR NEW.status = OLD.blocked_from))
  ) THEN
    RAISE EXCEPTION 'item state transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'plans.invalid_item_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER plan_item_state_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.plan_item_state FOR EACH ROW EXECUTE FUNCTION trustwork.plan_item_state_guard();

-- 5. Plan changes ---------------------------------------------------------------------------------------------------
-- What changed, why, who asked, which agreement covers it and who is accountable. Never rewritten: only the decision
-- is recorded. Approving a change requires its target version to be approved in the same transaction.
CREATE TABLE trustwork.plan_change (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  plan_id uuid NOT NULL,
  project_id uuid NOT NULL,
  from_version_id uuid NOT NULL,
  to_version_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  cause text NOT NULL CHECK (cause IN ('owner_request', 'counterparty', 'site_condition', 'regulatory', 'external', 'unknown')),
  requested_by_person_id uuid NULL REFERENCES trustwork.person (id),
  requested_by_company_id uuid NULL REFERENCES trustwork.company (id),
  accountable_person_id uuid NULL REFERENCES trustwork.person (id),
  accountable_company_id uuid NULL REFERENCES trustwork.company (id),
  agreement_id text NULL CHECK (agreement_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  schedule_impact_days integer NULL CHECK (schedule_impact_days BETWEEN -3650 AND 3650),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected', 'withdrawn')),
  created_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  decided_by_person_id uuid NULL REFERENCES trustwork.person (id),
  decided_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_change_plan FOREIGN KEY (plan_id, project_id) REFERENCES trustwork.plan (id, project_id),
  CONSTRAINT plan_change_from FOREIGN KEY (from_version_id, plan_id) REFERENCES trustwork.plan_version (id, plan_id),
  CONSTRAINT plan_change_to FOREIGN KEY (to_version_id, plan_id) REFERENCES trustwork.plan_version (id, plan_id),
  CONSTRAINT plan_change_versions_differ CHECK (from_version_id <> to_version_id),
  CONSTRAINT plan_change_requested_by CHECK (num_nonnulls(requested_by_person_id, requested_by_company_id) = 1),
  CONSTRAINT plan_change_accountable CHECK (num_nonnulls(accountable_person_id, accountable_company_id) = 1),
  CONSTRAINT plan_change_decision CHECK ((status = 'proposed') = (decided_at IS NULL) AND (decided_at IS NULL) = (decided_by_person_id IS NULL))
);
CREATE UNIQUE INDEX plan_change_one_open_per_target ON trustwork.plan_change (to_version_id) WHERE status = 'proposed';
CREATE INDEX plan_change_plan_idx ON trustwork.plan_change (plan_id, created_at);
CREATE TRIGGER plan_change_touch BEFORE UPDATE ON trustwork.plan_change FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();
ALTER TABLE trustwork.plan_version ADD CONSTRAINT plan_version_change FOREIGN KEY (change_id) REFERENCES trustwork.plan_change (id);

CREATE FUNCTION trustwork.plan_change_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_person uuid := trustwork.current_person_id();
  v_from text;
  v_to text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'plan changes are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'plans.version_frozen';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by_person_id IS DISTINCT FROM v_person OR NEW.status <> 'proposed' THEN
      RAISE EXCEPTION 'a change is proposed by the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'plans.not_authorised';
    END IF;
    SELECT status INTO v_from FROM trustwork.plan_version WHERE id = NEW.from_version_id;
    SELECT status INTO v_to FROM trustwork.plan_version WHERE id = NEW.to_version_id;
    IF v_from NOT IN ('approved', 'superseded') OR v_to NOT IN ('draft', 'proposed') THEN
      RAISE EXCEPTION 'a change goes from an approved baseline to an open version' USING ERRCODE = 'check_violation', HINT = 'plans.invalid_change';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.plan_id <> OLD.plan_id OR NEW.project_id <> OLD.project_id OR NEW.from_version_id <> OLD.from_version_id
     OR NEW.to_version_id <> OLD.to_version_id OR NEW.reason <> OLD.reason OR NEW.cause <> OLD.cause
     OR NEW.requested_by_person_id IS DISTINCT FROM OLD.requested_by_person_id OR NEW.requested_by_company_id IS DISTINCT FROM OLD.requested_by_company_id
     OR NEW.accountable_person_id IS DISTINCT FROM OLD.accountable_person_id OR NEW.accountable_company_id IS DISTINCT FROM OLD.accountable_company_id
     OR NEW.agreement_id IS DISTINCT FROM OLD.agreement_id OR NEW.schedule_impact_days IS DISTINCT FROM OLD.schedule_impact_days
     OR NEW.created_by_person_id <> OLD.created_by_person_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a plan change is never rewritten' USING ERRCODE = 'integrity_constraint_violation', HINT = 'plans.change_immutable';
  END IF;
  IF OLD.status <> 'proposed' OR NEW.status = 'proposed' THEN
    RAISE EXCEPTION 'plan change transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'plans.invalid_change';
  END IF;
  IF NEW.decided_by_person_id IS DISTINCT FROM v_person THEN
    RAISE EXCEPTION 'the decider is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'plans.not_authorised';
  END IF;
  IF NEW.status = 'withdrawn' AND OLD.created_by_person_id <> v_person THEN
    RAISE EXCEPTION 'only the proposer withdraws a change' USING ERRCODE = 'insufficient_privilege', HINT = 'plans.not_authorised';
  END IF;
  IF NEW.status IN ('approved', 'rejected') AND NOT trustwork.plan_project_can(NEW.project_id, 'accept') THEN
    RAISE EXCEPTION 'only the owner or a person the owner authorised decides a change' USING ERRCODE = 'insufficient_privilege', HINT = 'plans.not_authorised';
  END IF;
  IF NEW.status = 'approved' AND NOT EXISTS (SELECT 1 FROM trustwork.plan_version v WHERE v.id = NEW.to_version_id AND v.status = 'approved' AND v.change_id = NEW.id) THEN
    RAISE EXCEPTION 'approving a change approves its target version in the same transaction' USING ERRCODE = 'check_violation', HINT = 'plans.invalid_change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER plan_change_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.plan_change FOR EACH ROW EXECUTE FUNCTION trustwork.plan_change_guard();

-- 6. Shares: one item, one audience, exactly the listed fields ----------------------------------------------------
-- The participation rows of the plan resource: invitee party (person XOR company; none for the public needs board),
-- fields, validity and final revocation. Created only for an item of the approved baseline, by a person holding
-- `invite` (or `publish` for the public audience); address and contact only after acceptance.
CREATE TABLE trustwork.plan_share (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  plan_id uuid NOT NULL,
  project_id uuid NOT NULL,
  item_key text NOT NULL CHECK (item_key ~ '^[a-z][a-z0-9_-]{0,63}$'),
  audience text NOT NULL CHECK (audience IN ('public', 'invited', 'after_acceptance')),
  invitee_person_id uuid NULL REFERENCES trustwork.person (id),
  invitee_company_id uuid NULL REFERENCES trustwork.company (id),
  fields text[] NOT NULL CHECK (cardinality(fields) BETWEEN 1 AND 9 AND fields <@ ARRAY['scope', 'trade', 'locality', 'address', 'drawings', 'quantities', 'schedule', 'budget_range', 'contact']::text[]),
  acceptance_kind text NULL CHECK (acceptance_kind IN ('consultation_booking', 'task_assignment')),
  acceptance_id text NULL CHECK (acceptance_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  preview_digest text NOT NULL CHECK (preview_digest ~ '^[a-f0-9]{64}$'),
  confirmed_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz NULL,
  revoked_at timestamptz NULL,
  revoked_by_person_id uuid NULL REFERENCES trustwork.person (id),
  revoked_reason text NULL CHECK (length(revoked_reason) BETWEEN 1 AND 500),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_share_plan FOREIGN KEY (plan_id, project_id) REFERENCES trustwork.plan (id, project_id),
  CONSTRAINT plan_share_invitee CHECK (num_nonnulls(invitee_person_id, invitee_company_id) = CASE WHEN audience = 'public' THEN 0 ELSE 1 END),
  CONSTRAINT plan_share_public_fields CHECK (audience <> 'public' OR fields <@ ARRAY['scope', 'trade', 'locality', 'schedule']::text[]),
  CONSTRAINT plan_share_address_after_acceptance CHECK (audience = 'after_acceptance' OR NOT (fields && ARRAY['address', 'contact']::text[])),
  CONSTRAINT plan_share_acceptance CHECK ((acceptance_kind IS NULL) = (acceptance_id IS NULL) AND (audience = 'after_acceptance') = (acceptance_kind IS NOT NULL)),
  CONSTRAINT plan_share_validity CHECK (valid_until IS NULL OR valid_until > confirmed_at),
  CONSTRAINT plan_share_revocation CHECK ((revoked_at IS NULL) = (revoked_by_person_id IS NULL) AND (revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE UNIQUE INDEX plan_share_one_live_person ON trustwork.plan_share (plan_id, item_key, audience, invitee_person_id) WHERE revoked_at IS NULL AND invitee_person_id IS NOT NULL;
CREATE UNIQUE INDEX plan_share_one_live_company ON trustwork.plan_share (plan_id, item_key, audience, invitee_company_id) WHERE revoked_at IS NULL AND invitee_company_id IS NOT NULL;
CREATE UNIQUE INDEX plan_share_one_live_public ON trustwork.plan_share (plan_id, item_key) WHERE revoked_at IS NULL AND audience = 'public';
CREATE INDEX plan_share_invitee_person_idx ON trustwork.plan_share (invitee_person_id, project_id) WHERE revoked_at IS NULL;
CREATE INDEX plan_share_invitee_company_idx ON trustwork.plan_share (invitee_company_id, project_id) WHERE revoked_at IS NULL;
CREATE TRIGGER plan_share_touch BEFORE UPDATE ON trustwork.plan_share FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

CREATE FUNCTION trustwork.plan_share_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'plan shares are retained' USING ERRCODE = 'integrity_constraint_violation', HINT = 'plans.share_immutable';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.confirmed_by_person_id IS DISTINCT FROM trustwork.current_person_id() OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'a share is confirmed by the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'plans.not_authorised';
    END IF;
    IF cardinality(NEW.fields) <> (SELECT count(DISTINCT f) FROM unnest(NEW.fields) AS f) THEN
      RAISE EXCEPTION 'share fields are distinct' USING ERRCODE = 'check_violation', HINT = 'plans.invalid_share';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM trustwork.plan p JOIN trustwork.plan_item i ON i.plan_version_id = p.current_version_id
      WHERE p.id = NEW.plan_id AND i.item_key = NEW.item_key
    ) THEN
      RAISE EXCEPTION 'item % is not in the approved baseline', NEW.item_key USING ERRCODE = 'check_violation', HINT = 'plans.item_not_in_baseline';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.plan_id <> OLD.plan_id OR NEW.project_id <> OLD.project_id OR NEW.item_key <> OLD.item_key OR NEW.audience <> OLD.audience
     OR NEW.invitee_person_id IS DISTINCT FROM OLD.invitee_person_id OR NEW.invitee_company_id IS DISTINCT FROM OLD.invitee_company_id
     OR NEW.fields <> OLD.fields OR NEW.acceptance_kind IS DISTINCT FROM OLD.acceptance_kind OR NEW.acceptance_id IS DISTINCT FROM OLD.acceptance_id
     OR NEW.preview_digest <> OLD.preview_digest OR NEW.confirmed_by_person_id <> OLD.confirmed_by_person_id OR NEW.confirmed_at <> OLD.confirmed_at
     OR NEW.valid_until IS DISTINCT FROM OLD.valid_until OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a share is never widened or re-pointed; revoke it and share again' USING ERRCODE = 'integrity_constraint_violation', HINT = 'plans.share_immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'revocation is final' USING ERRCODE = 'integrity_constraint_violation', HINT = 'plans.share_immutable';
  END IF;
  IF NEW.revoked_by_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
    RAISE EXCEPTION 'the revoker is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'plans.not_authorised';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER plan_share_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.plan_share FOR EACH ROW EXECUTE FUNCTION trustwork.plan_share_guard();

-- 7. Site location, permits and diary -------------------------------------------------------------------------------
CREATE TABLE trustwork.project_location (
  project_id uuid PRIMARY KEY REFERENCES trustwork.project (id),
  address jsonb NULL CHECK (address IS NULL OR jsonb_typeof(address) = 'object'),
  region_code text NULL CHECK (region_code ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?(:[a-z0-9][a-z0-9-]{0,62})?$'),
  cadastral_ref text NULL CHECK (length(cadastral_ref) BETWEEN 1 AND 80),
  site_contact jsonb NULL CHECK (site_contact IS NULL OR jsonb_typeof(site_contact) = 'object'),
  site_access_notes text NULL CHECK (length(site_access_notes) <= 20000),
  updated_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER project_location_touch BEFORE UPDATE ON trustwork.project_location FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

CREATE TABLE trustwork.permit_record (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  project_id uuid NOT NULL REFERENCES trustwork.project (id),
  plan_item_key text NULL CHECK (plan_item_key ~ '^[a-z][a-z0-9_-]{0,63}$'),
  jurisdiction text NOT NULL CHECK (jurisdiction ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?(:[a-z0-9][a-z0-9-]{0,62})?$'),
  permit_type text NOT NULL CHECK (permit_type ~ '^permit(\.[a-z0-9_]+)+$'),
  authority text NOT NULL CHECK (length(authority) BETWEEN 1 AND 200),
  number text NULL CHECK (length(number) BETWEEN 1 AND 80),
  applied_at date NULL,
  issued_at date NULL,
  expires_at date NULL,
  inspection_results jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(inspection_results) = 'array'),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array'),
  status text NOT NULL CHECK (status IN ('planned', 'applied', 'issued', 'rejected', 'expired', 'closed')),
  created_by_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT permit_record_dates CHECK (applied_at IS NULL OR issued_at IS NULL OR applied_at <= issued_at),
  CONSTRAINT permit_record_issued CHECK (status <> 'issued' OR issued_at IS NOT NULL)
);
CREATE INDEX permit_record_project_idx ON trustwork.permit_record (project_id, created_at);
CREATE TRIGGER permit_record_touch BEFORE UPDATE ON trustwork.permit_record FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

CREATE TABLE trustwork.project_diary_entry (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  project_id uuid NOT NULL REFERENCES trustwork.project (id),
  author_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  entry_date date NOT NULL,
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 20000),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array'),
  plan_item_key text NULL CHECK (plan_item_key ~ '^[a-z][a-z0-9_-]{0,63}$'),
  visibility text NOT NULL DEFAULT 'owner_private' CHECK (visibility IN ('owner_private', 'participants')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_diary_entry_project_idx ON trustwork.project_diary_entry (project_id, entry_date, created_at);
-- Append-only: a correction is a new entry.
CREATE TRIGGER project_diary_entry_append_only BEFORE UPDATE OR DELETE ON trustwork.project_diary_entry FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- Restricted places are never stored as a site or permit jurisdiction (an empty restriction list means "not loaded":
-- restricted, trustwork.kernel_place_restricted); permit types are released taxonomy codes; authors are the principal.
CREATE FUNCTION trustwork.plan_record_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'project_location' THEN
    IF NEW.updated_by_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
      RAISE EXCEPTION 'the updater is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'plans.not_authorised';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.project_id <> OLD.project_id THEN
      RAISE EXCEPTION 'location belongs to its project' USING ERRCODE = 'integrity_constraint_violation', HINT = 'plans.version_frozen';
    END IF;
    IF NEW.region_code IS NOT NULL AND trustwork.kernel_place_restricted(NEW.region_code) THEN
      RAISE EXCEPTION 'restricted place' USING ERRCODE = 'check_violation', HINT = 'plans.restricted_place';
    END IF;
    IF NEW.address IS NOT NULL AND trustwork.kernel_place_restricted(NEW.address ->> 'countryCode') THEN
      RAISE EXCEPTION 'restricted place' USING ERRCODE = 'check_violation', HINT = 'plans.restricted_place';
    END IF;
  ELSIF TG_TABLE_NAME = 'permit_record' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.created_by_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
        RAISE EXCEPTION 'the recorder is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'plans.not_authorised';
      END IF;
      IF trustwork.kernel_place_restricted(NEW.jurisdiction) THEN
        RAISE EXCEPTION 'restricted place' USING ERRCODE = 'check_violation', HINT = 'plans.restricted_place';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM trustwork.taxonomy_term t WHERE t.code = NEW.permit_type AND t.status = 'released') THEN
        RAISE EXCEPTION 'unknown permit type' USING ERRCODE = 'check_violation', HINT = 'plans.unknown_term';
      END IF;
    ELSIF NEW.id <> OLD.id OR NEW.project_id <> OLD.project_id OR NEW.jurisdiction <> OLD.jurisdiction OR NEW.permit_type <> OLD.permit_type
       OR NEW.plan_item_key IS DISTINCT FROM OLD.plan_item_key OR NEW.created_by_person_id <> OLD.created_by_person_id OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'permit identity is immutable' USING ERRCODE = 'integrity_constraint_violation', HINT = 'plans.version_frozen';
    END IF;
  ELSIF TG_TABLE_NAME = 'project_diary_entry' THEN
    IF NEW.author_person_id IS DISTINCT FROM trustwork.current_person_id() THEN
      RAISE EXCEPTION 'the author is the principal' USING ERRCODE = 'insufficient_privilege', HINT = 'plans.not_authorised';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER project_location_guard BEFORE INSERT OR UPDATE ON trustwork.project_location FOR EACH ROW EXECUTE FUNCTION trustwork.plan_record_guard();
CREATE TRIGGER permit_record_guard BEFORE INSERT OR UPDATE ON trustwork.permit_record FOR EACH ROW EXECUTE FUNCTION trustwork.plan_record_guard();
CREATE TRIGGER project_diary_entry_guard BEFORE INSERT ON trustwork.project_diary_entry FOR EACH ROW EXECUTE FUNCTION trustwork.plan_record_guard();

-- 8. The invited view -------------------------------------------------------------------------------------------------
-- Owner-run read for an invitee: the live (not revoked, not expired, not public) shares addressed to the principal or
-- to their active employer (members holding company.deals.manage), joined with the items of the approved baseline.
-- Every column outside the share's fields is NULL; address and contact only for after_acceptance shares. No row means
-- "not found". Never returns private notes, sources, risk or decision notes, other invitees or other shares.
CREATE FUNCTION trustwork.plan_shared_view(p_project_id uuid)
RETURNS TABLE (
  share_id uuid, plan_id uuid, item_key text, audience text, fields text[], acceptance_kind text, acceptance_id text, valid_until timestamptz,
  confirmed_by uuid, confirmed_at timestamptz, preview_digest text, share_revision integer, invitee_person_id uuid, invitee_company_id uuid,
  plan_version integer, time_zone text, item_position integer, kind text, title text,
  description text, step_terms text[], required_skills text[], quantity_value text, quantity_unit text,
  estimate_low bigint, estimate_high bigint, estimate_currency text, estimate_basis text, estimate_basis_ref text, estimate_as_of date,
  duration_low_days integer, duration_high_days integer, window_start date, window_finish date, attachments jsonb,
  region_code text, address jsonb, site_contact jsonb, site_access_notes text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT s.id, s.plan_id, s.item_key, s.audience, s.fields, s.acceptance_kind, s.acceptance_id, s.valid_until,
    s.confirmed_by_person_id, s.confirmed_at, s.preview_digest, s.revision, s.invitee_person_id, s.invitee_company_id,
    v.version, pl.time_zone, i.position, i.kind, i.title,
    CASE WHEN 'scope' = ANY (s.fields) THEN i.description END,
    CASE WHEN 'trade' = ANY (s.fields) THEN i.step_terms END,
    CASE WHEN 'trade' = ANY (s.fields) THEN i.required_skills END,
    CASE WHEN 'quantities' = ANY (s.fields) THEN i.quantity_value END,
    CASE WHEN 'quantities' = ANY (s.fields) THEN i.quantity_unit END,
    CASE WHEN 'budget_range' = ANY (s.fields) THEN i.estimate_low END,
    CASE WHEN 'budget_range' = ANY (s.fields) THEN i.estimate_high END,
    CASE WHEN 'budget_range' = ANY (s.fields) THEN i.estimate_currency END,
    CASE WHEN 'budget_range' = ANY (s.fields) THEN i.estimate_basis END,
    CASE WHEN 'budget_range' = ANY (s.fields) THEN i.estimate_basis_ref END,
    CASE WHEN 'budget_range' = ANY (s.fields) THEN i.estimate_as_of END,
    CASE WHEN 'schedule' = ANY (s.fields) THEN i.duration_low_days END,
    CASE WHEN 'schedule' = ANY (s.fields) THEN i.duration_high_days END,
    CASE WHEN 'schedule' = ANY (s.fields) THEN i.window_start END,
    CASE WHEN 'schedule' = ANY (s.fields) THEN i.window_finish END,
    CASE WHEN 'drawings' = ANY (s.fields) THEN i.attachments END,
    CASE WHEN 'locality' = ANY (s.fields) THEN loc.region_code END,
    CASE WHEN 'address' = ANY (s.fields) AND s.audience = 'after_acceptance' THEN loc.address END,
    CASE WHEN 'contact' = ANY (s.fields) AND s.audience = 'after_acceptance' THEN loc.site_contact END,
    CASE WHEN 'contact' = ANY (s.fields) AND s.audience = 'after_acceptance' THEN loc.site_access_notes END
  FROM trustwork.plan_share s
  JOIN trustwork.plan pl ON pl.id = s.plan_id AND pl.project_id = p_project_id
  JOIN trustwork.plan_version v ON v.id = pl.current_version_id AND v.status = 'approved'
  JOIN trustwork.plan_item i ON i.plan_version_id = v.id AND i.item_key = s.item_key
  LEFT JOIN trustwork.project_location loc ON loc.project_id = pl.project_id
  WHERE trustwork.current_person_id() IS NOT NULL
    AND s.project_id = p_project_id
    AND s.audience <> 'public'
    AND s.revoked_at IS NULL AND (s.valid_until IS NULL OR s.valid_until > now())
    AND (s.invitee_person_id = trustwork.current_person_id()
         OR (s.invitee_company_id IS NOT NULL AND s.invitee_company_id = trustwork.current_company_id()
             AND trustwork.current_membership_has('company.deals.manage')))
  ORDER BY i.position, s.id
$$;

-- 9. Row-level security ---------------------------------------------------------------------------------------------
ALTER TABLE trustwork.plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.plan FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.plan_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.plan_version FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.plan_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.plan_item FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.plan_dependency ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.plan_dependency FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.plan_item_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.plan_item_state FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.plan_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.plan_change FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.plan_share ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.plan_share FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.project_location ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.project_location FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.permit_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.permit_record FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.project_diary_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.project_diary_entry FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.plan AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.plan_version AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.plan_item AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.plan_dependency AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.plan_item_state AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.plan_change AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.plan_share AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.project_location AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.permit_record AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.project_diary_entry AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

-- Owner side: reads need read.owner_private, writes write.draft; approval facts need accept (guards above).
CREATE POLICY plan_read ON trustwork.plan FOR SELECT TO trustwork_app USING (trustwork.plan_project_can(project_id, 'read.owner_private'));
CREATE POLICY plan_insert ON trustwork.plan FOR INSERT TO trustwork_app WITH CHECK (trustwork.plan_project_can(project_id, 'write.draft'));
CREATE POLICY plan_update ON trustwork.plan FOR UPDATE TO trustwork_app
  USING (trustwork.plan_project_can(project_id, 'write.draft') OR trustwork.plan_project_can(project_id, 'accept'))
  WITH CHECK (trustwork.plan_project_can(project_id, 'write.draft') OR trustwork.plan_project_can(project_id, 'accept'));
CREATE POLICY plan_version_read ON trustwork.plan_version FOR SELECT TO trustwork_app USING (trustwork.plan_project_can(project_id, 'read.owner_private'));
CREATE POLICY plan_version_insert ON trustwork.plan_version FOR INSERT TO trustwork_app WITH CHECK (trustwork.plan_project_can(project_id, 'write.draft'));
CREATE POLICY plan_version_update ON trustwork.plan_version FOR UPDATE TO trustwork_app
  USING (trustwork.plan_project_can(project_id, 'write.draft') OR trustwork.plan_project_can(project_id, 'accept'))
  WITH CHECK (trustwork.plan_project_can(project_id, 'write.draft') OR trustwork.plan_project_can(project_id, 'accept'));
CREATE POLICY plan_item_read ON trustwork.plan_item FOR SELECT TO trustwork_app USING (trustwork.plan_project_can(project_id, 'read.owner_private'));
CREATE POLICY plan_item_insert ON trustwork.plan_item FOR INSERT TO trustwork_app WITH CHECK (trustwork.plan_project_can(project_id, 'write.draft'));
CREATE POLICY plan_dependency_read ON trustwork.plan_dependency FOR SELECT TO trustwork_app USING (trustwork.plan_project_can(project_id, 'read.owner_private'));
CREATE POLICY plan_dependency_insert ON trustwork.plan_dependency FOR INSERT TO trustwork_app WITH CHECK (trustwork.plan_project_can(project_id, 'write.draft'));
CREATE POLICY plan_item_state_read ON trustwork.plan_item_state FOR SELECT TO trustwork_app USING (trustwork.plan_project_can(project_id, 'read.owner_private'));
CREATE POLICY plan_item_state_insert ON trustwork.plan_item_state FOR INSERT TO trustwork_app WITH CHECK (trustwork.plan_project_can(project_id, 'write.draft'));
CREATE POLICY plan_item_state_update ON trustwork.plan_item_state FOR UPDATE TO trustwork_app
  USING (trustwork.plan_project_can(project_id, 'write.draft')) WITH CHECK (trustwork.plan_project_can(project_id, 'write.draft'));
CREATE POLICY plan_change_read ON trustwork.plan_change FOR SELECT TO trustwork_app USING (trustwork.plan_project_can(project_id, 'read.owner_private'));
CREATE POLICY plan_change_insert ON trustwork.plan_change FOR INSERT TO trustwork_app WITH CHECK (trustwork.plan_project_can(project_id, 'write.draft'));
CREATE POLICY plan_change_update ON trustwork.plan_change FOR UPDATE TO trustwork_app
  USING (trustwork.plan_project_can(project_id, 'write.draft') OR trustwork.plan_project_can(project_id, 'accept'))
  WITH CHECK (trustwork.plan_project_can(project_id, 'write.draft') OR trustwork.plan_project_can(project_id, 'accept'));
-- Shares: the owner side sees and manages every share of the plan; an invitee sees only its own live rows (never other
-- invitees'). Creating or revoking needs `invite` (`publish` for the public audience).
CREATE POLICY plan_share_read ON trustwork.plan_share FOR SELECT TO trustwork_app USING (
  trustwork.plan_project_can(project_id, 'read.owner_private')
  OR (revoked_at IS NULL AND (valid_until IS NULL OR valid_until > now())
      AND (invitee_person_id = trustwork.current_person_id()
           OR (invitee_company_id IS NOT NULL AND invitee_company_id = trustwork.current_company_id() AND trustwork.current_membership_has('company.deals.manage'))))
);
CREATE POLICY plan_share_insert ON trustwork.plan_share FOR INSERT TO trustwork_app
  WITH CHECK (trustwork.plan_project_can(project_id, 'read.owner_private') AND trustwork.plan_project_can(project_id, CASE WHEN audience = 'public' THEN 'publish' ELSE 'invite' END));
CREATE POLICY plan_share_update ON trustwork.plan_share FOR UPDATE TO trustwork_app
  USING (trustwork.plan_project_can(project_id, CASE WHEN audience = 'public' THEN 'publish' ELSE 'invite' END))
  WITH CHECK (trustwork.plan_project_can(project_id, CASE WHEN audience = 'public' THEN 'publish' ELSE 'invite' END));
CREATE POLICY project_location_read ON trustwork.project_location FOR SELECT TO trustwork_app USING (trustwork.plan_project_can(project_id, 'read.owner_private'));
CREATE POLICY project_location_insert ON trustwork.project_location FOR INSERT TO trustwork_app WITH CHECK (trustwork.plan_project_can(project_id, 'write.draft'));
CREATE POLICY project_location_update ON trustwork.project_location FOR UPDATE TO trustwork_app
  USING (trustwork.plan_project_can(project_id, 'write.draft')) WITH CHECK (trustwork.plan_project_can(project_id, 'write.draft'));
CREATE POLICY permit_record_read ON trustwork.permit_record FOR SELECT TO trustwork_app USING (trustwork.plan_project_can(project_id, 'read.owner_private'));
CREATE POLICY permit_record_insert ON trustwork.permit_record FOR INSERT TO trustwork_app WITH CHECK (trustwork.plan_project_can(project_id, 'write.draft'));
CREATE POLICY permit_record_update ON trustwork.permit_record FOR UPDATE TO trustwork_app
  USING (trustwork.plan_project_can(project_id, 'write.draft')) WITH CHECK (trustwork.plan_project_can(project_id, 'write.draft'));
-- Diary: owner side; entries marked `participants` also for live project participants (never invitees of plan shares).
CREATE POLICY project_diary_entry_read ON trustwork.project_diary_entry FOR SELECT TO trustwork_app USING (
  trustwork.plan_project_can(project_id, 'read.owner_private') OR (visibility = 'participants' AND trustwork.participates_in_resource('project', project_id))
);
CREATE POLICY project_diary_entry_insert ON trustwork.project_diary_entry FOR INSERT TO trustwork_app WITH CHECK (trustwork.plan_project_can(project_id, 'write.draft'));

-- 10. Grants ----------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT ON trustwork.plan, trustwork.plan_version, trustwork.plan_item, trustwork.plan_dependency, trustwork.plan_item_state,
  trustwork.plan_change, trustwork.plan_share, trustwork.project_location, trustwork.permit_record, trustwork.project_diary_entry TO trustwork_app;
GRANT UPDATE (status, current_version_id) ON trustwork.plan TO trustwork_app;
GRANT UPDATE (status, content, digest, proposed_by_person_id, proposed_via, proposed_mandate_id, proposed_at, approved_by_person_id, approved_at,
  superseded_at, superseded_by_version_id, superseded_reason, change_id) ON trustwork.plan_version TO trustwork_app;
GRANT UPDATE (status, path, link_kind, link_id, blocked_from, actual_start, actual_end, updated_by_person_id) ON trustwork.plan_item_state TO trustwork_app;
GRANT UPDATE (status, decided_by_person_id, decided_at) ON trustwork.plan_change TO trustwork_app;
GRANT UPDATE (revoked_at, revoked_by_person_id, revoked_reason) ON trustwork.plan_share TO trustwork_app;
GRANT UPDATE (address, region_code, cadastral_ref, site_contact, site_access_notes, updated_by_person_id) ON trustwork.project_location TO trustwork_app;
GRANT UPDATE (authority, number, applied_at, issued_at, expires_at, inspection_results, evidence, status) ON trustwork.permit_record TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.plan_project_can(uuid, text), trustwork.plan_shared_view(uuid) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
