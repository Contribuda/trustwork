-- BILL-003: referral programme terms, versioned and disclosed like fee versions (ADR 018, ADR 025 decision 21).
-- Terms only: nothing here issues a reward, seeds a programme or chooses a value. GROW-001 owns any reward execution.
-- A reward is a platform credit, never cash. Activation needs a second person and the reference of the counsel review.
-- No column can reach ranking, matching, recommendations or reputation, and no reader of those surfaces uses this table.

CREATE OR REPLACE FUNCTION trustwork.admin_second_person_actions() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['staff.assign_sensitive_role', 'commerce.activate_price_version', 'privacy.execute_erasure', 'moderation.apply_sanction_l4', 'providers.enable_non_fake', 'staff.switch_sod_mode',
    'hub.transition_soft_launch', 'hub.transition_public', 'hub.change_residency', 'legal.activate_document_version', 'federation.raise_peering_level',
    'models.activate_private_route', 'egress.allow_private_class', 'pipelines.activate_personal_data_dataset', 'datasets.activate_court_or_debt',
    'automation.raise_to_supervised_autonomous', 'agents.enable_commitment_module', 'agents.activate_extension', 'jurisdiction.activate_settings',
    'billing.activate_fee_version', 'billing.release_payout_batch', 'payments.change_settings', 'sponsored.enable', 'staff.grant_breakglass',
    'support.reset_second_factor', 'support.rebind_recovery_email', 'ops.execute_restore', 'ops.apply_production_migration', 'ops.rotate_node_key',
    'kill_switch.release', 'growth.activate_referral_terms', 'payments.register_source_adapter', 'payments.accept_participant_binding', 'payments.activate_account_binding', 'screening.clear_match', 'screening.reverse_confirmation']::text[]
$$;
CREATE OR REPLACE FUNCTION trustwork.admin_action_permissions(p_action text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_action
    WHEN 'staff.assign_sensitive_role' THEN ARRAY['admin.staff.assign']
    WHEN 'commerce.activate_price_version' THEN ARRAY['admin.commerce.price.activate']
    WHEN 'privacy.execute_erasure' THEN ARRAY['admin.privacy.erasure.execute']
    WHEN 'moderation.apply_sanction_l4' THEN ARRAY['admin.moderation.decide']
    WHEN 'providers.enable_non_fake' THEN ARRAY['admin.providers.toggle']
    WHEN 'staff.switch_sod_mode' THEN ARRAY['admin.staff.assign']
    WHEN 'hub.transition_soft_launch' THEN ARRAY['admin.hub.lifecycle.request']
    WHEN 'hub.transition_public' THEN ARRAY['admin.hub.lifecycle.request']
    WHEN 'hub.change_residency' THEN ARRAY['admin.hub.residency.edit']
    WHEN 'legal.activate_document_version' THEN ARRAY['admin.hub.legal.activate']
    WHEN 'federation.raise_peering_level' THEN ARRAY['admin.federation.peer.edit']
    WHEN 'models.activate_private_route' THEN ARRAY['admin.models.route.activate']
    WHEN 'egress.allow_private_class' THEN ARRAY['admin.providers.egress.edit']
    WHEN 'pipelines.activate_personal_data_dataset' THEN ARRAY['admin.pipelines.activate', 'admin.datasets.activate']
    WHEN 'datasets.activate_court_or_debt' THEN ARRAY['admin.datasets.activate']
    WHEN 'automation.raise_to_supervised_autonomous' THEN ARRAY['admin.editorial.automation.edit', 'admin.config.edit']
    WHEN 'agents.enable_commitment_module' THEN ARRAY['admin.agents.modules.activate']
    WHEN 'agents.activate_extension' THEN ARRAY['admin.agents.extensions.activate']
    WHEN 'jurisdiction.activate_settings' THEN ARRAY['admin.hub.jurisdiction.activate']
    WHEN 'billing.activate_fee_version' THEN ARRAY['admin.billing.fees.activate']
    WHEN 'billing.release_payout_batch' THEN ARRAY['admin.billing.payouts.release']
    WHEN 'payments.change_settings' THEN ARRAY['admin.hub.payments.edit']
    WHEN 'sponsored.enable' THEN ARRAY['admin.sponsored.policy.edit']
    WHEN 'staff.grant_breakglass' THEN ARRAY['admin.staff.breakglass']
    WHEN 'support.reset_second_factor' THEN ARRAY['admin.support.second_factor.reset']
    WHEN 'support.rebind_recovery_email' THEN ARRAY['admin.support.recovery.rebind']
    WHEN 'ops.execute_restore' THEN ARRAY['admin.ops.restore.execute']
    WHEN 'ops.apply_production_migration' THEN ARRAY['admin.ops.updates.apply']
    WHEN 'ops.rotate_node_key' THEN ARRAY['admin.node.keys.rotate']
    WHEN 'kill_switch.release' THEN ARRAY['admin.providers.kill', 'admin.agents.kill', 'admin.pipelines.pause']
    WHEN 'growth.activate_referral_terms' THEN ARRAY['admin.growth.referrals.activate']
    WHEN 'payments.register_source_adapter' THEN ARRAY['admin.payments.adapters.propose','admin.payments.adapters.activate']
    WHEN 'payments.accept_participant_binding' THEN ARRAY['admin.payments.participant_binding.propose','admin.payments.participant_binding.accept']
    WHEN 'payments.activate_account_binding' THEN ARRAY['admin.payments.account_binding.propose','admin.payments.account_binding.review']
    END::text[]
$$;

CREATE TABLE trustwork.referral_terms_version (
 id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
 hub_id uuid NOT NULL REFERENCES trustwork.hub(id),
 programme_key text NOT NULL CHECK (programme_key ~ '^[a-z][a-z0-9_]{1,60}$'),
 version integer NOT NULL CHECK (version >= 1),
 eligible_parties text NOT NULL CHECK (eligible_parties IN ('person','company','person_or_company')),
 reward_kind text NOT NULL CHECK (reward_kind = 'platform_credit'),
 currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 referrer_reward_minor bigint NOT NULL CHECK (referrer_reward_minor >= 0),
 referee_reward_minor bigint NOT NULL CHECK (referee_reward_minor >= 0),
 max_rewards_per_referrer integer NULL CHECK (max_rewards_per_referrer BETWEEN 1 AND 1000),
 effective_from timestamptz NOT NULL,
 effective_to timestamptz NULL,
 acceptance_text_version text NOT NULL CHECK (length(acceptance_text_version) BETWEEN 1 AND 40),
 public_terms jsonb NOT NULL CHECK (jsonb_typeof(public_terms) = 'object'),
 legal_review_ref text NOT NULL CHECK (length(legal_review_ref) BETWEEN 1 AND 200),
 status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','withdrawn')),
 drafted_by uuid NOT NULL REFERENCES trustwork.person(id),
 activated_by uuid NULL REFERENCES trustwork.person(id),
 activated_at timestamptz NULL,
 approval_id uuid NULL REFERENCES trustwork.second_person_approval(id),
 withdrawn_by uuid NULL REFERENCES trustwork.person(id),
 withdrawn_at timestamptz NULL,
 revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (hub_id, programme_key, version),
 CONSTRAINT referral_terms_window CHECK (effective_to IS NULL OR effective_to > effective_from),
 CONSTRAINT referral_terms_second_person CHECK (activated_by IS NULL OR activated_by <> drafted_by),
 CONSTRAINT referral_terms_not_backdated CHECK (activated_at IS NULL OR effective_from >= date_trunc('milliseconds', activated_at)),
 CONSTRAINT referral_terms_activation CHECK ((status = 'draft') = (activated_by IS NULL) AND (activated_by IS NULL) = (activated_at IS NULL) AND (activated_by IS NULL) = (approval_id IS NULL)),
 CONSTRAINT referral_terms_withdrawal CHECK ((status = 'withdrawn') = (withdrawn_by IS NOT NULL) AND (withdrawn_by IS NULL) = (withdrawn_at IS NULL))
);
CREATE INDEX referral_terms_version_hub_idx ON trustwork.referral_terms_version (hub_id, status, programme_key);
CREATE TRIGGER referral_terms_version_touch BEFORE UPDATE ON trustwork.referral_terms_version FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

CREATE FUNCTION trustwork.billing_referral_terms(p trustwork.referral_terms_version) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
 SELECT jsonb_build_object('programmeKey', p.programme_key, 'eligibleParties', p.eligible_parties, 'rewardKind', p.reward_kind, 'currency', p.currency,
   'referrerRewardMinor', p.referrer_reward_minor::text, 'refereeRewardMinor', p.referee_reward_minor::text, 'maxRewardsPerReferrer', p.max_rewards_per_referrer,
   'effectiveFrom', to_char(p.effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'effectiveTo', to_char(p.effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'acceptanceTextVersion', p.acceptance_text_version, 'publicTerms', p.public_terms)
$$;
-- The counsel review reference is bound by the digest the second person approves; it never reaches the public projection.
CREATE FUNCTION trustwork.billing_referral_digest(p trustwork.referral_terms_version) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
 SELECT trustwork.admin_digest(jsonb_build_object('action', 'growth.activate_referral_terms', 'id', p.id, 'hubId', p.hub_id, 'version', p.version,
   'terms', trustwork.billing_referral_terms(p), 'legalReviewRef', p.legal_review_ref))
$$;
CREATE FUNCTION trustwork.billing_referral_public(p trustwork.referral_terms_version) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
 SELECT jsonb_build_object('id', p.id, 'hubId', p.hub_id, 'version', p.version, 'digest', trustwork.billing_referral_digest(p), 'terms', trustwork.billing_referral_terms(p))
$$;
CREATE FUNCTION trustwork.billing_referral_staff(p trustwork.referral_terms_version) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
 SELECT trustwork.billing_referral_public(p) || jsonb_build_object('status', p.status, 'legalReviewRef', p.legal_review_ref, 'draftedBy', p.drafted_by, 'activatedBy', p.activated_by,
   'activatedAt', to_char(p.activated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'withdrawnAt', to_char(p.withdrawn_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
$$;

-- Audit digests refuse integers above 2^53-1, and a reward may be any bigint, so amounts enter the audit image as text.
CREATE FUNCTION trustwork.billing_referral_audit(p trustwork.referral_terms_version) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = trustwork, pg_temp AS $$
 SELECT to_jsonb(p) || jsonb_build_object('referrer_reward_minor', p.referrer_reward_minor::text, 'referee_reward_minor', p.referee_reward_minor::text)
$$;

CREATE FUNCTION trustwork.billing_referral_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE a trustwork.second_person_approval%ROWTYPE;
 lifecycle text[] := ARRAY['status','activated_by','activated_at','approval_id','withdrawn_by','withdrawn_at','revision','updated_at'];
BEGIN
 IF TG_OP = 'DELETE' THEN
  RAISE EXCEPTION 'referral terms are never deleted' USING ERRCODE = '23514', HINT = 'billing.version_frozen';
 END IF;
 IF TG_OP = 'INSERT' THEN
  IF NEW.status <> 'draft' OR NEW.activated_by IS NOT NULL OR NEW.withdrawn_by IS NOT NULL THEN
   RAISE EXCEPTION 'referral terms are born as drafts' USING ERRCODE = '23514', HINT = 'billing.version_not_draft';
  END IF;
  IF NEW.effective_from <> date_trunc('milliseconds', NEW.effective_from) OR NEW.effective_to <> date_trunc('milliseconds', NEW.effective_to) THEN
   RAISE EXCEPTION 'referral timestamps require millisecond precision' USING ERRCODE = '22023', HINT = 'billing.invalid_terms';
  END IF;
  RETURN NEW;
 END IF;
 IF (to_jsonb(NEW) - lifecycle) IS DISTINCT FROM (to_jsonb(OLD) - lifecycle) THEN
  RAISE EXCEPTION 'referral terms are immutable' USING ERRCODE = '23514', HINT = 'billing.version_frozen';
 END IF;
 IF NOT ((OLD.status = 'draft' AND NEW.status = 'active') OR (OLD.status = 'active' AND NEW.status = 'withdrawn')) THEN
  RAISE EXCEPTION 'invalid referral transition' USING ERRCODE = '23514', HINT = 'billing.version_frozen';
 END IF;
 IF NEW.status = 'withdrawn' THEN
  IF (to_jsonb(NEW) - ARRAY['status','withdrawn_by','withdrawn_at','revision','updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','withdrawn_by','withdrawn_at','revision','updated_at'])
    OR NEW.withdrawn_by IS DISTINCT FROM trustwork.current_person_id() THEN
   RAISE EXCEPTION 'referral withdrawal changes nothing else' USING ERRCODE = '23514', HINT = 'billing.version_frozen';
  END IF;
  RETURN NEW;
 END IF;
 NEW.activated_at := clock_timestamp();
 SELECT * INTO a FROM trustwork.second_person_approval WHERE id = NEW.approval_id;
 IF NOT FOUND OR a.status <> 'consumed' OR a.consumed_ref IS DISTINCT FROM NEW.id
   OR a.requested_by IS DISTINCT FROM NEW.activated_by OR a.approved_by = NEW.activated_by OR NEW.activated_by = NEW.drafted_by
   OR a.scope_kind <> 'hub' OR a.hub_id IS DISTINCT FROM NEW.hub_id
   OR a.action <> 'growth.activate_referral_terms' OR a.action_digest <> trustwork.billing_referral_digest(NEW)
   OR NEW.activated_by IS DISTINCT FROM trustwork.current_person_id() THEN
  RAISE EXCEPTION 'exact consumed referral approval required' USING ERRCODE = '42501', HINT = 'admin.approval_mismatch';
 END IF;
 IF NEW.effective_from < date_trunc('milliseconds', NEW.activated_at) THEN
  RAISE EXCEPTION 'referral terms cannot take effect before their activation' USING ERRCODE = '23514', HINT = 'billing.backdated';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtext('trustwork.billing.referral'), hashtext(NEW.hub_id::text || ':' || NEW.programme_key));
 IF EXISTS (SELECT 1 FROM trustwork.referral_terms_version r WHERE r.id <> NEW.id AND r.hub_id = NEW.hub_id AND r.programme_key = NEW.programme_key AND r.status = 'active'
   AND tstzrange(r.effective_from, r.effective_to, '[)') && tstzrange(NEW.effective_from, NEW.effective_to, '[)')) THEN
  RAISE EXCEPTION 'referral intervals overlap' USING ERRCODE = '23P01', HINT = 'billing.version_overlap';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER referral_terms_version_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.referral_terms_version
 FOR EACH ROW EXECUTE FUNCTION trustwork.billing_referral_guard();

CREATE FUNCTION trustwork.billing_referral_draft(p_ctx jsonb, p_hub uuid, p_terms jsonb, p_legal_review_ref text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE a trustwork.admin_actor; r trustwork.referral_terms_version%ROWTYPE;
BEGIN
 PERFORM trustwork.hubs_require_hub(p_hub);
 a := trustwork.admin_authorize(p_ctx, ARRAY['admin.growth.referrals.draft'], NULL, p_hub);
 -- The allowlist is the database twin of the strict contract: no key can carry a discovery or participant control.
 IF jsonb_typeof(p_terms) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_terms) k WHERE k NOT IN
  ('programmeKey','eligibleParties','rewardKind','currency','referrerRewardMinor','refereeRewardMinor','maxRewardsPerReferrer','effectiveFrom','effectiveTo','acceptanceTextVersion','publicTerms'))
  OR jsonb_typeof(p_terms->'publicTerms') IS DISTINCT FROM 'object'
  OR EXISTS (SELECT 1 FROM jsonb_each(p_terms->'publicTerms') e WHERE jsonb_typeof(e.value) <> 'string' OR length(btrim(e.value #>> '{}')) = 0) THEN
  RAISE EXCEPTION 'invalid referral terms' USING ERRCODE = '22023', HINT = 'billing.invalid_terms';
 END IF;
 IF (SELECT lifecycle FROM trustwork.hub WHERE id = p_hub) = 'closed' THEN
  RAISE EXCEPTION 'closed hub' USING ERRCODE = '23514', HINT = 'billing.unavailable';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtext('trustwork.billing.referral'), hashtext(p_hub::text || ':' || (p_terms->>'programmeKey')));
 INSERT INTO trustwork.referral_terms_version (hub_id, programme_key, version, eligible_parties, reward_kind, currency, referrer_reward_minor, referee_reward_minor,
   max_rewards_per_referrer, effective_from, effective_to, acceptance_text_version, public_terms, legal_review_ref, drafted_by)
 VALUES (p_hub, p_terms->>'programmeKey',
   coalesce((SELECT max(version) FROM trustwork.referral_terms_version WHERE hub_id = p_hub AND programme_key = p_terms->>'programmeKey'),0)+1,
   p_terms->>'eligibleParties', p_terms->>'rewardKind', p_terms->>'currency', (p_terms->>'referrerRewardMinor')::bigint, (p_terms->>'refereeRewardMinor')::bigint,
   (p_terms->>'maxRewardsPerReferrer')::integer, (p_terms->>'effectiveFrom')::timestamptz, (p_terms->>'effectiveTo')::timestamptz,
   p_terms->>'acceptanceTextVersion', p_terms->'publicTerms', p_legal_review_ref, a.person_id)
 RETURNING * INTO r;
 PERFORM trustwork.admin_record(a,p_ctx,NULL,p_hub,'billing.referral_drafted','referral_terms_version',r.id,NULL,trustwork.billing_referral_audit(r));
 RETURN trustwork.billing_referral_public(r);
END $$;

CREATE FUNCTION trustwork.billing_referral_activate(p_ctx jsonb, p_hub uuid, p_id uuid, p_digest text, p_approval uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE a trustwork.admin_actor; r trustwork.referral_terms_version%ROWTYPE; before_r jsonb;
BEGIN
 a := trustwork.admin_authorize(p_ctx, ARRAY['admin.growth.referrals.activate'], NULL, p_hub);
 SELECT * INTO r FROM trustwork.referral_terms_version WHERE id = p_id AND hub_id = p_hub;
 IF NOT FOUND THEN RAISE EXCEPTION 'referral terms unavailable' USING ERRCODE = 'P0002', HINT = 'admin.not_found'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('trustwork.billing.referral'), hashtext(r.hub_id::text || ':' || r.programme_key));
 SELECT * INTO r FROM trustwork.referral_terms_version WHERE id = p_id FOR UPDATE;
 IF a.person_id = r.drafted_by THEN RAISE EXCEPTION 'drafter cannot activate' USING ERRCODE = '42501', HINT = 'admin.self_approval'; END IF;
 IF p_digest IS DISTINCT FROM trustwork.billing_referral_digest(r) THEN RAISE EXCEPTION 'changed digest' USING ERRCODE = '42501', HINT = 'admin.approval_mismatch'; END IF;
 IF r.status <> 'draft' OR (SELECT lifecycle FROM trustwork.hub WHERE id = p_hub) = 'closed' THEN
  RAISE EXCEPTION 'referral terms unavailable' USING ERRCODE = '23514', HINT = 'billing.unavailable'; END IF;
 -- Disclosure in every hub language is a condition of activation, not of drafting.
 IF EXISTS (SELECT 1 FROM trustwork.hub_profile h, unnest(h.locales) l WHERE h.hub_id = p_hub AND NOT r.public_terms ? l) THEN
  RAISE EXCEPTION 'public terms are missing a hub language' USING ERRCODE = '23514', HINT = 'billing.language_missing'; END IF;
 PERFORM trustwork.admin_consume_approval(p_approval,'growth.activate_referral_terms','hub',NULL,p_hub,p_digest,r.id);
 before_r := trustwork.billing_referral_audit(r);
 UPDATE trustwork.referral_terms_version SET status='active', activated_by=a.person_id, activated_at=clock_timestamp(), approval_id=p_approval WHERE id=r.id RETURNING * INTO r;
 PERFORM trustwork.admin_record(a,p_ctx,NULL,p_hub,'billing.referral_activated','referral_terms_version',r.id,before_r,trustwork.billing_referral_audit(r),NULL,p_approval);
 RETURN trustwork.billing_referral_public(r);
END $$;

-- Stopping a programme protects participants, so it takes one accountable person and an audit record. Rewards already
-- earned belong to GROW-001 and are not touched here.
CREATE FUNCTION trustwork.billing_referral_withdraw(p_ctx jsonb, p_hub uuid, p_id uuid, p_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE a trustwork.admin_actor; r trustwork.referral_terms_version%ROWTYPE; before_r jsonb;
BEGIN
 a := trustwork.admin_authorize(p_ctx, ARRAY['admin.growth.referrals.activate'], NULL, p_hub);
 SELECT * INTO r FROM trustwork.referral_terms_version WHERE id = p_id AND hub_id = p_hub;
 IF NOT FOUND THEN RAISE EXCEPTION 'referral terms unavailable' USING ERRCODE = 'P0002', HINT = 'admin.not_found'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('trustwork.billing.referral'), hashtext(r.hub_id::text || ':' || r.programme_key));
 SELECT * INTO r FROM trustwork.referral_terms_version WHERE id = p_id FOR UPDATE;
 IF p_digest IS DISTINCT FROM trustwork.billing_referral_digest(r) THEN RAISE EXCEPTION 'changed digest' USING ERRCODE = '42501', HINT = 'admin.approval_mismatch'; END IF;
 IF r.status <> 'active' THEN RAISE EXCEPTION 'referral terms unavailable' USING ERRCODE = '23514', HINT = 'billing.unavailable'; END IF;
 before_r := trustwork.billing_referral_audit(r);
 UPDATE trustwork.referral_terms_version SET status='withdrawn', withdrawn_by=a.person_id, withdrawn_at=clock_timestamp() WHERE id=r.id RETURNING * INTO r;
 PERFORM trustwork.admin_record(a,p_ctx,NULL,p_hub,'billing.referral_withdrawn','referral_terms_version',r.id,before_r,trustwork.billing_referral_audit(r));
 RETURN trustwork.billing_referral_public(r);
END $$;

CREATE FUNCTION trustwork.billing_referral_list(p_hub uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
 SELECT coalesce(jsonb_agg(trustwork.billing_referral_public(r) ORDER BY r.programme_key, r.effective_from, r.id),'[]'::jsonb)
 FROM trustwork.referral_terms_version r JOIN trustwork.hub h ON h.id = r.hub_id
 WHERE r.hub_id = p_hub AND r.status = 'active' AND (r.effective_to IS NULL OR r.effective_to > statement_timestamp()) AND h.lifecycle <> 'closed'
$$;
CREATE FUNCTION trustwork.billing_referral_staff_list(p_ctx jsonb, p_hub uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
DECLARE result jsonb;
BEGIN
 PERFORM trustwork.admin_authorize(p_ctx, ARRAY['admin.growth.referrals.draft','admin.growth.referrals.activate'], NULL, p_hub);
 SELECT coalesce(jsonb_agg(trustwork.billing_referral_staff(r) ORDER BY r.programme_key, r.version DESC),'[]'::jsonb) INTO result
 FROM trustwork.referral_terms_version r WHERE r.hub_id = p_hub;
 RETURN result;
END $$;

ALTER TABLE trustwork.referral_terms_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.referral_terms_version FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.referral_terms_version TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trustwork.billing_referral_draft(jsonb,uuid,jsonb,text), trustwork.billing_referral_activate(jsonb,uuid,uuid,text,uuid),
 trustwork.billing_referral_withdraw(jsonb,uuid,uuid,text), trustwork.billing_referral_list(uuid), trustwork.billing_referral_staff_list(jsonb,uuid) TO trustwork_app;
