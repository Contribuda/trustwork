-- DATA-001 projects: XOR owner, distinct creator/leader, ownership transfer and leadership history.
-- No RLS on project rows in this slice: object policy resolves through object_participation (owner rows are
-- materialised by the application); commercial/project RLS follows when BE-001 materialises participation.

CREATE TABLE trustwork.project (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  owner_person_id uuid NULL REFERENCES trustwork.person (id),
  owner_company_id uuid NULL REFERENCES trustwork.company (id),
  creator_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  leader_person_id uuid NULL REFERENCES trustwork.person (id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  summary text NULL,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'active', 'suspended', 'completed', 'cancelled')),
  publicity_enabled boolean NOT NULL DEFAULT false,
  published_story text NULL,
  private_notes text NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Invariant 1: exactly one owner, person XOR company.
  CONSTRAINT project_owner_xor CHECK ((owner_person_id IS NULL) <> (owner_company_id IS NULL))
);
CREATE INDEX project_owner_person_idx ON trustwork.project (owner_person_id) WHERE owner_person_id IS NOT NULL;
CREATE INDEX project_owner_company_idx ON trustwork.project (owner_company_id) WHERE owner_company_id IS NOT NULL;
CREATE TRIGGER project_touch BEFORE UPDATE ON trustwork.project FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

CREATE TABLE trustwork.ownership_transfer (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  project_id uuid NOT NULL REFERENCES trustwork.project (id),
  from_person_id uuid NULL REFERENCES trustwork.person (id),
  from_company_id uuid NULL REFERENCES trustwork.company (id),
  to_person_id uuid NULL REFERENCES trustwork.person (id),
  to_company_id uuid NULL REFERENCES trustwork.company (id),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted_by_recipient', 'effective', 'rejected', 'expired', 'withdrawn')),
  proposed_by uuid NOT NULL REFERENCES trustwork.person (id),
  proposed_at timestamptz NOT NULL DEFAULT now(),
  recipient_consent_at timestamptz NULL,
  effective_at timestamptz NULL,
  expires_at timestamptz NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transfer_from_xor CHECK ((from_person_id IS NULL) <> (from_company_id IS NULL)),
  CONSTRAINT transfer_to_xor CHECK ((to_person_id IS NULL) <> (to_company_id IS NULL)),
  CONSTRAINT transfer_effective_requires_consent CHECK (status <> 'effective' OR (recipient_consent_at IS NOT NULL AND effective_at IS NOT NULL))
);
CREATE INDEX ownership_transfer_project_idx ON trustwork.ownership_transfer (project_id);
CREATE TRIGGER ownership_transfer_touch BEFORE UPDATE ON trustwork.ownership_transfer FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- Contract transition table: proposed -> accepted_by_recipient | rejected | expired | withdrawn;
-- accepted_by_recipient -> effective | expired | withdrawn; terminal states never change.
CREATE FUNCTION trustwork.ownership_transfer_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.project_id <> OLD.project_id OR NEW.from_person_id IS DISTINCT FROM OLD.from_person_id OR NEW.from_company_id IS DISTINCT FROM OLD.from_company_id
     OR NEW.to_person_id IS DISTINCT FROM OLD.to_person_id OR NEW.to_company_id IS DISTINCT FROM OLD.to_company_id THEN
    RAISE EXCEPTION 'ownership transfer % parties are immutable', OLD.id USING ERRCODE = 'integrity_constraint_violation', HINT = 'projects.transfer_immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'proposed' AND NEW.status IN ('accepted_by_recipient', 'rejected', 'expired', 'withdrawn'))
    OR (OLD.status = 'accepted_by_recipient' AND NEW.status IN ('effective', 'expired', 'withdrawn'))
  ) THEN
    RAISE EXCEPTION 'ownership transfer transition % -> % is not allowed', OLD.status, NEW.status
      USING ERRCODE = 'integrity_constraint_violation', HINT = 'projects.invalid_transfer_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ownership_transfer_guard BEFORE UPDATE ON trustwork.ownership_transfer FOR EACH ROW EXECUTE FUNCTION trustwork.ownership_transfer_guard();

-- Leadership is operational, never ownership; history is kept as rows with ended_at.
CREATE TABLE trustwork.leadership_assignment (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  project_id uuid NOT NULL REFERENCES trustwork.project (id),
  leader_person_id uuid NOT NULL REFERENCES trustwork.person (id),
  assigned_by uuid NOT NULL REFERENCES trustwork.person (id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz NULL,
  ended_by uuid NULL REFERENCES trustwork.person (id),
  CONSTRAINT leadership_end_shape CHECK ((ended_at IS NULL) = (ended_by IS NULL))
);
CREATE INDEX leadership_assignment_project_idx ON trustwork.leadership_assignment (project_id);
CREATE UNIQUE INDEX leadership_one_current ON trustwork.leadership_assignment (project_id) WHERE ended_at IS NULL;

GRANT SELECT, INSERT, UPDATE (owner_person_id, owner_company_id, leader_person_id, name, summary, status, publicity_enabled, published_story, private_notes) ON trustwork.project TO trustwork_app;
GRANT SELECT, INSERT, UPDATE (status, recipient_consent_at, effective_at) ON trustwork.ownership_transfer TO trustwork_app;
GRANT SELECT, INSERT, UPDATE (ended_at, ended_by) ON trustwork.leadership_assignment TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
