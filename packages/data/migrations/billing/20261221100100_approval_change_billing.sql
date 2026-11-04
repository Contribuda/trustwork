-- HUBC-007: what a second person approves for the billing actions, read here because only billing reads billing tables.
-- The rows are found by recomputing the digest the executing command compares, and the card's fields are generated from
-- that same digest input, so every term the digest binds is shown. admin_change_resolve calls these. Nothing here touches
-- ranking, matching or reputation, and the answer goes only to the approval's own readers.

CREATE FUNCTION trustwork.billing_change_fee(a trustwork.second_person_approval) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  f trustwork.marketplace_fee_version%ROWTYPE;
  v_input jsonb;
BEGIN
  SELECT x.* INTO f FROM trustwork.marketplace_fee_version x WHERE x.hub_id = a.hub_id AND trustwork.billing_fee_digest(x) = a.action_digest;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_input := jsonb_build_object('action', 'billing.activate_fee_version', 'id', f.id, 'hubId', f.hub_id, 'version', f.version, 'terms', trustwork.billing_fee_terms(f));
  RETURN trustwork.admin_change_found(v_input, v_input, f.status = 'draft', a.action_digest);
END $$;

-- A metered price and a plan activate under the same action as a sale price, each with its own digest: the terms of a
-- metered price, cost beside sale; and a plan with its price, which one approval covers.
CREATE FUNCTION trustwork.billing_change_metered(a trustwork.second_person_approval) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  q trustwork.price_version%ROWTYPE;
  v_input jsonb;
BEGIN
  SELECT p.* INTO q FROM trustwork.price_version p JOIN trustwork.offer o ON o.id = p.offer_id JOIN trustwork.metered_price_term t ON t.price_version_id = p.id
   WHERE o.hub_id = a.hub_id AND trustwork.billing_metered_digest(p) = a.action_digest;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_input := jsonb_build_object('action', 'commerce.activate_price_version', 'id', q.id, 'offerId', q.offer_id, 'version', q.version, 'terms', trustwork.billing_metered_terms(q));
  RETURN trustwork.admin_change_found(v_input, v_input, q.status = 'draft', a.action_digest);
END $$;

CREATE FUNCTION trustwork.billing_change_plan(a trustwork.second_person_approval) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v trustwork.subscription_plan_version%ROWTYPE;
  q trustwork.price_version%ROWTYPE;
  v_input jsonb;
BEGIN
  SELECT p.* INTO v FROM trustwork.subscription_plan_version p JOIN trustwork.offer o ON o.id = p.offer_id JOIN trustwork.price_version x ON x.id = p.price_version_id
   WHERE o.hub_id = a.hub_id AND trustwork.billing_plan_digest(p, x) = a.action_digest;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO q FROM trustwork.price_version WHERE id = v.price_version_id;
  v_input := jsonb_build_object('action', 'commerce.activate_price_version', 'id', v.id, 'offerId', v.offer_id, 'version', v.version, 'plan', v.payload,
    'price', jsonb_build_object('id', q.id, 'amountMinor', q.amount_minor::text, 'currency', q.currency, 'effectiveFrom', trustwork.billing_iso(q.effective_from),
      'effectiveTo', trustwork.billing_iso(q.effective_to), 'acceptanceTextVersion', q.acceptance_text_version));
  RETURN trustwork.admin_change_found(v_input, v_input, v.status = 'draft', a.action_digest);
END $$;

-- What the second person approves here is two digests: the version's terms, and which version they replace.
CREATE FUNCTION trustwork.billing_change_price(a trustwork.second_person_approval) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  r record;
  v_input jsonb;
BEGIN
  SELECT p.id, p.version, p.status, o.hub_id, trustwork.billing_sale_terms(p, o, s) AS terms, trustwork.billing_sale_digest(p, o, s) AS version_digest,
      CASE WHEN trustwork.billing_sale_activation_digest(trustwork.billing_sale_digest(p, o, s), old.id) = a.action_digest THEN old.id END AS supersedes INTO r
    FROM trustwork.price_version p JOIN trustwork.offer o ON o.id = p.offer_id JOIN trustwork.price_sale_terms s ON s.price_version_id = p.id
    LEFT JOIN trustwork.price_version old ON old.offer_id = p.offer_id AND old.id <> p.id
   WHERE o.hub_id = a.hub_id AND (trustwork.billing_sale_activation_digest(trustwork.billing_sale_digest(p, o, s), old.id) = a.action_digest
      OR trustwork.billing_sale_activation_digest(trustwork.billing_sale_digest(p, o, s), NULL) = a.action_digest)
   ORDER BY trustwork.billing_sale_activation_digest(trustwork.billing_sale_digest(p, o, s), old.id) = a.action_digest DESC NULLS LAST LIMIT 1;
  IF NOT FOUND THEN RETURN coalesce(trustwork.billing_change_metered(a), trustwork.billing_change_plan(a)); END IF;
  v_input := jsonb_build_object('action', 'commerce.activate_price_version', 'versionDigest', r.version_digest, 'supersedes', r.supersedes);
  RETURN trustwork.admin_change_found(v_input, v_input || jsonb_build_object('id', r.id, 'version', r.version, 'terms', r.terms), r.status = 'draft', a.action_digest);
END $$;

CREATE FUNCTION trustwork.billing_change_referral(a trustwork.second_person_approval) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = trustwork, pg_temp AS $$
DECLARE
  r trustwork.referral_terms_version%ROWTYPE;
  v_input jsonb;
BEGIN
  SELECT x.* INTO r FROM trustwork.referral_terms_version x WHERE x.hub_id = a.hub_id AND trustwork.billing_referral_digest(x) = a.action_digest;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_input := jsonb_build_object('action', 'growth.activate_referral_terms', 'id', r.id, 'hubId', r.hub_id, 'version', r.version, 'terms', trustwork.billing_referral_terms(r), 'legalReviewRef', r.legal_review_ref);
  RETURN trustwork.admin_change_found(v_input, v_input, r.status = 'draft', a.action_digest);
END $$;

-- Who reads a price depends on what it is. A metered price has the readers of billing_metered_staff_list and needs its
-- elevation, because its cost is on the card; a plan has the plan permission; a sale price has the readers of its list.
CREATE FUNCTION trustwork.billing_change_needs_elevation(a trustwork.second_person_approval) RETURNS boolean
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$ SELECT trustwork.billing_change_metered(a) IS NOT NULL $$;

CREATE FUNCTION trustwork.billing_change_readers(a trustwork.second_person_approval) RETURNS text[]
LANGUAGE sql STABLE SET search_path = trustwork, pg_temp AS $$
  SELECT CASE
    WHEN trustwork.billing_change_metered(a) IS NOT NULL THEN ARRAY['admin.commerce.price.draft', 'admin.commerce.price.activate', 'admin.commerce.usage.read']
    WHEN trustwork.billing_change_plan(a) IS NOT NULL THEN ARRAY['admin.commerce.plan.activate']
    ELSE ARRAY['admin.commerce.price.draft', 'admin.commerce.price.activate'] END
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
