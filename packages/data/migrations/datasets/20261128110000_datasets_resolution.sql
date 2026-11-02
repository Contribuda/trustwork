-- MINE-001 part 2: entity resolution, links never merges (docs/engine/hub-console/data-mining.md "Entity resolution";
-- docs/engine/discovery-and-outreach.md section 2; LinkProposalSchema in packages/contracts/src/hub.ts).
--
-- A link proposal says that a dataset record seems to describe a company, a person or another record, with evidence,
-- a confidence between 0 and 1 (a matching measure, never a reputation score) and the scoring method version. A person
-- decides; the effect is always a link. Rules:
--   * a person is linked only with their own confirmation or a signed statement;
--   * a pair marked distinct by a person is never proposed again;
--   * the proposer never decides their own proposal;
--   * a batch decision covers only proposals whose evidence is an identifier match from a statutory register (the
--     record's source is an official register and the company holds the identifier); the deciding person names the
--     sample they saw (at least five, or all when fewer) and the counts are recorded with the scoring method.
-- The resolver (`datasets_resolve`) proposes identifier matches only; similarity proposals come from people or later
-- methods and never qualify for a batch.

CREATE FUNCTION trustwork.datasets_evidence_kinds() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['identifier_match', 'name_address_similarity', 'register_officer_match', 'signed_statement', 'subject_confirmation', 'peer_link']::text[]
$$;
CREATE FUNCTION trustwork.datasets_scoring_method() RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 'trustwork-resolve/1'::text $$;

-- Evidence: one to six items {kind, detail, similarity|null} with known kinds; similarity is a decimal string in [0, 1]
-- (UnitIntervalSchema), never a float.
CREATE FUNCTION trustwork.datasets_evidence_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_typeof(p) = 'array' AND jsonb_array_length(p) BETWEEN 1 AND 6
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p) e WHERE NOT (
      jsonb_typeof(e) = 'object' AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e) k) = ARRAY['detail', 'kind', 'similarity']
      AND (e ->> 'kind') = ANY (trustwork.datasets_evidence_kinds())
      AND jsonb_typeof(e -> 'detail') = 'string' AND length(e ->> 'detail') BETWEEN 1 AND 500
      AND (jsonb_typeof(e -> 'similarity') = 'null' OR (jsonb_typeof(e -> 'similarity') = 'string' AND (e ->> 'similarity') ~ '^(0(\.[0-9]{1,3})?|1(\.0{1,3})?)$'))))
$$;

CREATE TABLE trustwork.entity_link_batch (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  decision text NOT NULL CHECK (decision IN ('accepted', 'rejected')),
  proposal_count integer NOT NULL CHECK (proposal_count BETWEEN 1 AND 1000),
  sample_ids uuid[] NOT NULL CHECK (cardinality(sample_ids) >= 1),
  scoring_method text NOT NULL,
  decided_by uuid NOT NULL REFERENCES trustwork.person (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entity_link_batch_sample CHECK (cardinality(sample_ids) >= least(5, proposal_count) AND cardinality(sample_ids) <= proposal_count)
);
CREATE TRIGGER entity_link_batch_append_only BEFORE UPDATE OR DELETE ON trustwork.entity_link_batch FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

CREATE TABLE trustwork.entity_link_proposal (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  record_id uuid NOT NULL,
  dataset_id uuid NOT NULL REFERENCES trustwork.dataset (id),
  target_kind text NOT NULL CHECK (target_kind IN ('company', 'person', 'dataset_record')),
  target_id uuid NOT NULL,
  evidence jsonb NOT NULL CHECK (trustwork.datasets_evidence_ok(evidence)),
  confidence numeric(4, 3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  scoring_method text NOT NULL CHECK (scoring_method ~ '^[a-z][a-z0-9-]{1,40}/[0-9]{1,4}$'),
  statutory_identifier boolean NOT NULL,
  proposed_by_kind text NOT NULL CHECK (proposed_by_kind IN ('resolver', 'person')),
  proposed_by uuid NULL REFERENCES trustwork.person (id),
  state text NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed', 'accepted', 'rejected', 'withdrawn')),
  decided_by uuid NULL REFERENCES trustwork.person (id),
  decided_at timestamptz NULL,
  batch_id uuid NULL REFERENCES trustwork.entity_link_batch (id),
  effect text NOT NULL DEFAULT 'link' CHECK (effect = 'link'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entity_link_proposal_proposer CHECK ((proposed_by_kind = 'person') = (proposed_by IS NOT NULL)),
  CONSTRAINT entity_link_proposal_decision CHECK ((state IN ('accepted', 'rejected')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT entity_link_proposal_four_eyes CHECK (decided_by IS NULL OR proposed_by IS NULL OR decided_by <> proposed_by),
  CONSTRAINT entity_link_proposal_self CHECK (NOT (target_kind = 'dataset_record' AND target_id = record_id)),
  -- A person is linked only with their own confirmation or a signed statement.
  CONSTRAINT entity_link_proposal_person CHECK (state <> 'accepted' OR target_kind <> 'person'
    OR evidence @> '[{"kind": "subject_confirmation"}]'::jsonb OR evidence @> '[{"kind": "signed_statement"}]'::jsonb),
  CONSTRAINT entity_link_proposal_batch CHECK (batch_id IS NULL OR statutory_identifier)
);
CREATE UNIQUE INDEX entity_link_proposal_open_uq ON trustwork.entity_link_proposal (record_id, target_kind, target_id) WHERE state IN ('proposed', 'accepted');
CREATE INDEX entity_link_proposal_hub_idx ON trustwork.entity_link_proposal (hub_id, state, created_at);

CREATE TABLE trustwork.entity_distinct_pair (
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  record_id uuid NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('company', 'person', 'dataset_record')),
  target_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 500),
  marked_by uuid NOT NULL REFERENCES trustwork.person (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (record_id, target_kind, target_id)
);
CREATE TRIGGER entity_distinct_pair_permanent BEFORE UPDATE OR DELETE ON trustwork.entity_distinct_pair FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- Audit payload of a proposal: integers and text only (the audit digest refuses fractions), confidence in thousandths.
CREATE FUNCTION trustwork.datasets_link_audit(p trustwork.entity_link_proposal) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
  SELECT jsonb_build_object('id', p.id, 'recordId', p.record_id, 'targetKind', p.target_kind, 'targetId', p.target_id, 'state', p.state,
    'statutoryIdentifier', p.statutory_identifier, 'scoringMethod', p.scoring_method, 'confidencePermille', round(p.confidence * 1000)::integer,
    'evidenceKinds', (SELECT jsonb_agg(e ->> 'kind') FROM jsonb_array_elements(p.evidence) e), 'batchId', p.batch_id)
$$;

-- Whether the target exists (companies, people, records of the same hub).
CREATE FUNCTION trustwork.datasets_target_exists(p_hub uuid, p_kind text, p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT CASE p_kind
    WHEN 'company' THEN EXISTS (SELECT 1 FROM trustwork.company WHERE id = p_id)
    WHEN 'person' THEN EXISTS (SELECT 1 FROM trustwork.person WHERE id = p_id)
    WHEN 'dataset_record' THEN EXISTS (SELECT 1 FROM trustwork.dataset_record WHERE id = p_id AND hub_id = p_hub)
    ELSE false END
$$;

-- Statutory identifier evidence: the record came from an official register and the company holds its identifier.
CREATE FUNCTION trustwork.datasets_statutory_match(p_record trustwork.dataset_record, p_kind text, p_target uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT p_kind = 'company' AND p_record.identifier_kind IS NOT NULL
    AND EXISTS (SELECT 1 FROM trustwork.source s WHERE s.id = p_record.source_id AND s.reader_kind = 'official_register')
    AND EXISTS (SELECT 1 FROM trustwork.company c, jsonb_array_elements(c.legal_identifiers) i
                 WHERE c.id = p_target AND jsonb_typeof(i) = 'object' AND i ->> 'kind' = p_record.identifier_kind AND trustwork.datasets_norm(i ->> 'value') = p_record.identifier_norm)
$$;

-- Inserts a proposal unless the pair is marked distinct or already open or accepted. Returns NULL when skipped.
CREATE FUNCTION trustwork.datasets_insert_proposal(p_record trustwork.dataset_record, p_kind text, p_target uuid, p_evidence jsonb, p_confidence numeric, p_by uuid)
RETURNS trustwork.entity_link_proposal
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_row trustwork.entity_link_proposal%ROWTYPE;
BEGIN
  IF EXISTS (SELECT 1 FROM trustwork.entity_distinct_pair WHERE record_id = p_record.id AND target_kind = p_kind AND target_id = p_target) THEN
    RETURN NULL;
  END IF;
  -- The resolver never repeats a pair a person rejected; a person may propose it again with new evidence.
  IF p_by IS NULL AND EXISTS (SELECT 1 FROM trustwork.entity_link_proposal WHERE record_id = p_record.id AND target_kind = p_kind AND target_id = p_target AND state = 'rejected') THEN
    RETURN NULL;
  END IF;
  INSERT INTO trustwork.entity_link_proposal (hub_id, record_id, dataset_id, target_kind, target_id, evidence, confidence, scoring_method, statutory_identifier, proposed_by_kind, proposed_by)
  VALUES (p_record.hub_id, p_record.id, p_record.dataset_id, p_kind, p_target, p_evidence, p_confidence, trustwork.datasets_scoring_method(),
    p_evidence @> '[{"kind": "identifier_match"}]'::jsonb AND trustwork.datasets_statutory_match(p_record, p_kind, p_target),
    CASE WHEN p_by IS NULL THEN 'resolver' ELSE 'person' END, p_by)
  ON CONFLICT DO NOTHING
  RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- The resolver for a dataset: every record with an identifier and every company holding it (same kind, normalised
-- value) becomes a proposal with identifier evidence. Names never produce a proposal here.
CREATE FUNCTION trustwork.datasets_resolve_dataset(p_dataset uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_record trustwork.dataset_record%ROWTYPE;
  v_company uuid;
  v_row trustwork.entity_link_proposal%ROWTYPE;
  v_count integer := 0;
BEGIN
  FOR v_record IN SELECT * FROM trustwork.dataset_record WHERE dataset_id = p_dataset AND identifier_kind IS NOT NULL ORDER BY id LOOP
    FOR v_company IN SELECT DISTINCT c.id FROM trustwork.company c, jsonb_array_elements(c.legal_identifiers) i
        WHERE jsonb_typeof(i) = 'object' AND i ->> 'kind' = v_record.identifier_kind AND trustwork.datasets_norm(i ->> 'value') = v_record.identifier_norm ORDER BY c.id LOOP
      v_row := trustwork.datasets_insert_proposal(v_record, 'company', v_company,
        jsonb_build_array(jsonb_build_object('kind', 'identifier_match', 'detail', 'Same ' || v_record.identifier_kind || ' identifier', 'similarity', '1')), 0.99, NULL);
      IF v_row.id IS NOT NULL THEN v_count := v_count + 1; END IF;
    END LOOP;
  END LOOP;
  RETURN v_count;
END $$;

-- Staff: run the resolver for a dataset of the hub.
CREATE FUNCTION trustwork.datasets_resolve(p_ctx jsonb, p_dataset uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_dataset trustwork.dataset%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_count integer;
BEGIN
  PERFORM trustwork.admin_require_caller();
  v_dataset := trustwork.datasets_locked(p_dataset);
  v_actor := trustwork.datasets_staff(p_ctx, ARRAY['admin.datasets.edit', 'admin.links.decide'], v_dataset.hub_id);
  v_count := trustwork.datasets_resolve_dataset(p_dataset);
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_dataset.hub_id, 'datasets.resolved', 'dataset', v_dataset.id, NULL, jsonb_build_object('proposals', v_count));
  RETURN v_count;
END $$;

-- A person proposes a link with their own evidence (similarity, officer match, statements, a subject's confirmation).
CREATE FUNCTION trustwork.datasets_propose_link(p_ctx jsonb, p_record uuid, p_kind text, p_target uuid, p_evidence jsonb, p_confidence numeric) RETURNS trustwork.entity_link_proposal
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_record trustwork.dataset_record%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.entity_link_proposal%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_record FROM trustwork.dataset_record WHERE id = p_record;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such record' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.datasets_staff(p_ctx, ARRAY['admin.datasets.edit', 'admin.links.decide'], v_record.hub_id);
  IF NOT trustwork.datasets_target_exists(v_record.hub_id, p_kind, p_target) THEN
    RAISE EXCEPTION 'no such target' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.entity_distinct_pair WHERE record_id = p_record AND target_kind = p_kind AND target_id = p_target) THEN
    RAISE EXCEPTION 'the pair was marked distinct' USING ERRCODE = 'check_violation', HINT = 'datasets.marked_distinct';
  END IF;
  v_row := trustwork.datasets_insert_proposal(v_record, p_kind, p_target, p_evidence, p_confidence, v_actor.person_id);
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'the link is already proposed' USING ERRCODE = 'unique_violation', HINT = 'datasets.already_proposed';
  END IF;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_record.hub_id, 'datasets.link_proposed', 'entity_link_proposal', v_row.id, NULL, trustwork.datasets_link_audit(v_row));
  RETURN v_row;
END $$;

-- One decision on one proposal (accept, reject or withdraw); the proposer never decides their own.
CREATE FUNCTION trustwork.datasets_decide_link(p_ctx jsonb, p_proposal uuid, p_expected_revision integer, p_decision text) RETURNS trustwork.entity_link_proposal
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_before trustwork.entity_link_proposal%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.entity_link_proposal%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_before FROM trustwork.entity_link_proposal WHERE id = p_proposal FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such proposal' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.datasets_staff(p_ctx, ARRAY['admin.links.decide'], v_before.hub_id);
  PERFORM trustwork.datasets_check_revision(v_before.revision, p_expected_revision);
  IF v_before.state <> 'proposed' OR p_decision NOT IN ('accepted', 'rejected', 'withdrawn') THEN
    RAISE EXCEPTION 'a proposal is decided once' USING ERRCODE = 'check_violation', HINT = 'datasets.invalid_transition';
  END IF;
  IF v_before.proposed_by = v_actor.person_id THEN
    RAISE EXCEPTION 'the proposer does not decide their own proposal' USING ERRCODE = 'insufficient_privilege', HINT = 'datasets.own_proposal';
  END IF;
  IF p_decision = 'accepted' AND v_before.target_kind = 'person'
     AND NOT (v_before.evidence @> '[{"kind": "subject_confirmation"}]'::jsonb OR v_before.evidence @> '[{"kind": "signed_statement"}]'::jsonb) THEN
    RAISE EXCEPTION 'a person is linked only with their own confirmation' USING ERRCODE = 'check_violation', HINT = 'datasets.person_confirmation_required';
  END IF;
  UPDATE trustwork.entity_link_proposal SET state = p_decision, decided_by = CASE WHEN p_decision = 'withdrawn' THEN NULL ELSE v_actor.person_id END,
         decided_at = CASE WHEN p_decision = 'withdrawn' THEN NULL ELSE now() END, revision = revision + 1
   WHERE id = p_proposal RETURNING * INTO v_row;
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_row.hub_id, 'datasets.link_' || p_decision, 'entity_link_proposal', v_row.id, trustwork.datasets_link_audit(v_before),
    trustwork.datasets_link_audit(v_row));
  RETURN v_row;
END $$;

-- Marks a pair distinct: open proposals for it are withdrawn and the pair is never proposed again.
CREATE FUNCTION trustwork.datasets_mark_distinct(p_ctx jsonb, p_record uuid, p_kind text, p_target uuid, p_reason text) RETURNS trustwork.entity_distinct_pair
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_record trustwork.dataset_record%ROWTYPE;
  v_actor trustwork.admin_actor;
  v_row trustwork.entity_distinct_pair%ROWTYPE;
BEGIN
  PERFORM trustwork.admin_require_caller();
  SELECT * INTO v_record FROM trustwork.dataset_record WHERE id = p_record;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such record' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  v_actor := trustwork.datasets_staff(p_ctx, ARRAY['admin.links.decide'], v_record.hub_id);
  IF EXISTS (SELECT 1 FROM trustwork.entity_link_proposal WHERE record_id = p_record AND target_kind = p_kind AND target_id = p_target AND state = 'accepted') THEN
    RAISE EXCEPTION 'an accepted link is ended, not marked distinct' USING ERRCODE = 'check_violation', HINT = 'datasets.link_accepted';
  END IF;
  INSERT INTO trustwork.entity_distinct_pair (hub_id, record_id, target_kind, target_id, reason, marked_by)
  VALUES (v_record.hub_id, p_record, p_kind, p_target, p_reason, v_actor.person_id)
  ON CONFLICT DO NOTHING RETURNING * INTO v_row;
  IF v_row.record_id IS NULL THEN
    SELECT * INTO v_row FROM trustwork.entity_distinct_pair WHERE record_id = p_record AND target_kind = p_kind AND target_id = p_target;
  END IF;
  UPDATE trustwork.entity_link_proposal SET state = 'withdrawn', revision = revision + 1
   WHERE record_id = p_record AND target_kind = p_kind AND target_id = p_target AND state = 'proposed';
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, v_record.hub_id, 'datasets.marked_distinct', 'dataset_record', p_record, NULL, to_jsonb(v_row));
  RETURN v_row;
END $$;

-- One reviewed decision over many proposals: every one must be open, of this hub, with statutory identifier evidence
-- and not proposed by the decider; the sample the person saw (at least five, or all) is recorded with the counts.
CREATE FUNCTION trustwork.datasets_batch_decide(p_ctx jsonb, p_hub uuid, p_proposals uuid[], p_sample uuid[], p_decision text) RETURNS trustwork.entity_link_batch
LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE
  v_actor trustwork.admin_actor := trustwork.datasets_staff(p_ctx, ARRAY['admin.links.decide'], p_hub);
  v_found integer;
  v_batch trustwork.entity_link_batch%ROWTYPE;
BEGIN
  IF p_decision NOT IN ('accepted', 'rejected') OR coalesce(cardinality(p_proposals), 0) NOT BETWEEN 1 AND 1000
     OR NOT trustwork.datasets_distinct(ARRAY(SELECT x::text FROM unnest(p_proposals) x)) THEN
    RAISE EXCEPTION 'one to 1000 distinct proposals and a decision' USING ERRCODE = 'check_violation', HINT = 'datasets.invalid_batch';
  END IF;
  PERFORM 1 FROM trustwork.entity_link_proposal WHERE id = ANY (p_proposals) ORDER BY id FOR UPDATE;
  SELECT count(*) INTO v_found FROM trustwork.entity_link_proposal WHERE id = ANY (p_proposals) AND hub_id = p_hub;
  IF v_found <> cardinality(p_proposals) THEN
    RAISE EXCEPTION 'no such proposal' USING ERRCODE = 'no_data_found', HINT = 'admin.not_found';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.entity_link_proposal WHERE id = ANY (p_proposals) AND NOT statutory_identifier) THEN
    RAISE EXCEPTION 'a batch decision needs statutory identifier evidence for every proposal' USING ERRCODE = 'check_violation', HINT = 'datasets.batch_requires_statutory_identifier';
  END IF;
  IF EXISTS (SELECT 1 FROM trustwork.entity_link_proposal WHERE id = ANY (p_proposals) AND (state <> 'proposed' OR proposed_by = v_actor.person_id)) THEN
    RAISE EXCEPTION 'every proposal must be open and proposed by someone else' USING ERRCODE = 'check_violation', HINT = 'datasets.invalid_batch';
  END IF;
  IF p_sample IS NULL OR NOT (p_sample <@ p_proposals) OR cardinality(p_sample) < least(5, cardinality(p_proposals)) THEN
    RAISE EXCEPTION 'name the sample you saw: at least five proposals, or all of them' USING ERRCODE = 'check_violation', HINT = 'datasets.sample_required';
  END IF;
  INSERT INTO trustwork.entity_link_batch (hub_id, decision, proposal_count, sample_ids, scoring_method, decided_by)
  VALUES (p_hub, p_decision, cardinality(p_proposals), p_sample, trustwork.datasets_scoring_method(), v_actor.person_id) RETURNING * INTO v_batch;
  UPDATE trustwork.entity_link_proposal SET state = p_decision, decided_by = v_actor.person_id, decided_at = now(), batch_id = v_batch.id, revision = revision + 1
   WHERE id = ANY (p_proposals);
  PERFORM trustwork.admin_record(v_actor, p_ctx, NULL, p_hub, 'datasets.links_batch_' || p_decision, 'entity_link_batch', v_batch.id, NULL, to_jsonb(v_batch));
  RETURN v_batch;
END $$;

-- A buried record takes its open proposals with it (withdrawn; decided ones stay as history).
CREATE OR REPLACE FUNCTION trustwork.datasets_bury(p_record trustwork.dataset_record, p_reason text) RETURNS void
LANGUAGE sql VOLATILE SET search_path = trustwork, pg_temp AS $$
  INSERT INTO trustwork.dataset_tombstone (hub_id, dataset_id, record_id, key_digest, reason)
  VALUES (p_record.hub_id, p_record.dataset_id, p_record.id, encode(sha256(convert_to('dataset-record:' || p_record.dataset_id::text || ':' || p_record.external_key, 'UTF8')), 'hex'), p_reason);
  UPDATE trustwork.entity_link_proposal SET state = 'withdrawn', revision = revision + 1 WHERE record_id = p_record.id AND state = 'proposed';
  DELETE FROM trustwork.dataset_record WHERE id = p_record.id;
$$;

-- Worker: the resolver after a refresh.
CREATE FUNCTION trustwork.datasets_worker_resolve(p_dataset uuid) RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT trustwork.datasets_resolve_dataset(p_dataset)
$$;

ALTER TABLE trustwork.entity_link_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.entity_link_batch FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.entity_link_proposal ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.entity_link_proposal FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.entity_distinct_pair ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.entity_distinct_pair FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.entity_link_batch AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.entity_link_proposal AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.entity_distinct_pair AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY entity_link_batch_read ON trustwork.entity_link_batch FOR SELECT TO trustwork_app USING (trustwork.datasets_staff_reader(hub_id));
CREATE POLICY entity_link_proposal_read ON trustwork.entity_link_proposal FOR SELECT TO trustwork_app USING (trustwork.datasets_staff_reader(hub_id));
CREATE POLICY entity_distinct_pair_read ON trustwork.entity_distinct_pair FOR SELECT TO trustwork_app USING (trustwork.datasets_staff_reader(hub_id));

GRANT SELECT ON trustwork.entity_link_batch, trustwork.entity_link_proposal, trustwork.entity_distinct_pair TO trustwork_app;
GRANT EXECUTE ON FUNCTION
  trustwork.datasets_resolve(jsonb, uuid), trustwork.datasets_propose_link(jsonb, uuid, text, uuid, jsonb, numeric),
  trustwork.datasets_decide_link(jsonb, uuid, integer, text), trustwork.datasets_mark_distinct(jsonb, uuid, text, uuid, text),
  trustwork.datasets_batch_decide(jsonb, uuid, uuid[], uuid[], text),
  trustwork.datasets_evidence_kinds(), trustwork.datasets_scoring_method(), trustwork.datasets_evidence_ok(jsonb)
TO trustwork_app;
GRANT EXECUTE ON FUNCTION trustwork.datasets_worker_resolve(uuid) TO trustwork_worker;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
