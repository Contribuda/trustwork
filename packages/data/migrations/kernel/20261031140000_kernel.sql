-- DATA-003 shared kernel (docs/data/model.md section 2, migration plan slice A1): the tables every later slice
-- references instead of inventing its own file, unit, jurisdiction, taxonomy or hub columns.
--
-- No real-world fact is written here as a SQL literal: the restricted-places list, units and conversion rules,
-- jurisdictions and taxonomy terms are loaded by the maintenance command (packages/data/bin/kernel-sync.mjs, repository
-- `kernelSync` in packages/data/src/repositories/kernel.ts) from @trustwork/country-packs, @trustwork/contracts and
-- data/taxonomy. Until the restricted list is loaded every place counts as restricted (fail closed).
--
-- Writes: maintenance only, except evidence_artifact (runtime INSERT under its own policy). The runtime role reads
-- reference data; it never updates or deletes a kernel row. Every table has ENABLE + FORCE row-level security.

-- 0. Restricted places ---------------------------------------------------------------------------------------------
-- Mirror of RESTRICTED in packages/country-packs (the authoritative list lives in code, model invariant 9). Synced by
-- the maintenance command; no runtime write.
CREATE TABLE trustwork.restricted_place (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'),
  basis text NOT NULL CHECK (length(basis) BETWEEN 1 AND 500),
  synced_at timestamptz NOT NULL DEFAULT now()
);

-- Every code a restriction check must see for a jurisdiction or place code: the country, the region (area before ':')
-- and the full key (placeCodes in packages/contracts/src/hub.ts). An empty list means "not loaded": restricted.
CREATE FUNCTION trustwork.kernel_place_restricted(p_code text) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
  SELECT p_code IS NULL
    OR NOT EXISTS (SELECT 1 FROM trustwork.restricted_place)
    OR EXISTS (
      SELECT 1 FROM trustwork.restricted_place r
      WHERE r.code IN (upper(left(p_code, 2)), upper(split_part(p_code, ':', 1)), upper(p_code))
    )
$$;

-- 1. Units ----------------------------------------------------------------------------------------------------------
-- UNIT_CATALOGUE of packages/contracts/src/common/units.ts (CTRY-002): dimension and system vocabularies follow the
-- contract. to_base is the exact factor to the dimension's base unit; NULL never converts (pieces, sets, lump sums).
CREATE TABLE trustwork.unit (
  code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{0,15}$'),
  dimension text NOT NULL CHECK (dimension IN ('length', 'area', 'volume', 'mass', 'time', 'count')),
  system text NOT NULL CHECK (system IN ('si', 'imperial', 'us-customary', 'inch-pound', 'neutral')),
  symbol text NOT NULL CHECK (length(symbol) BETWEEN 1 AND 12),
  to_base text NULL CHECK (to_base ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$' AND to_base ~ '[1-9]'),
  definition text NOT NULL CHECK (length(definition) BETWEEN 1 AND 500),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unit_count_never_converts CHECK ((dimension = 'count') = (to_base IS NULL))
);
CREATE TRIGGER unit_touch BEFORE UPDATE ON trustwork.unit FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- The explicit rule: value_to = value_from * numerator / denominator (exact, reduced integers). A conversion without a
-- row here does not exist; there is no implicit factor anywhere.
CREATE TABLE trustwork.unit_conversion_rule (
  from_unit text NOT NULL REFERENCES trustwork.unit (code),
  to_unit text NOT NULL REFERENCES trustwork.unit (code),
  numerator numeric NOT NULL CHECK (numerator > 0 AND numerator = trunc(numerator)),
  denominator numeric NOT NULL CHECK (denominator > 0 AND denominator = trunc(denominator)),
  exact boolean NOT NULL DEFAULT true,
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_unit, to_unit),
  CONSTRAINT unit_conversion_rule_distinct CHECK (from_unit <> to_unit)
);

CREATE FUNCTION trustwork.kernel_unit_rule_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_from text;
  v_to text;
BEGIN
  SELECT dimension INTO v_from FROM trustwork.unit WHERE code = NEW.from_unit;
  SELECT dimension INTO v_to FROM trustwork.unit WHERE code = NEW.to_unit;
  IF v_from IS DISTINCT FROM v_to OR v_from = 'count' THEN
    RAISE EXCEPTION 'no conversion between % and %', NEW.from_unit, NEW.to_unit USING ERRCODE = 'check_violation', HINT = 'validation.unit_conversion';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER unit_conversion_rule_guard BEFORE INSERT OR UPDATE ON trustwork.unit_conversion_rule FOR EACH ROW EXECUTE FUNCTION trustwork.kernel_unit_rule_guard();

-- Quantities: `qty(x)` = exact decimal text (at most six fraction digits, no negative zero) + unit code.
CREATE FUNCTION trustwork.kernel_decimal_ok(p_value text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_value IS NOT NULL AND p_value ~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,6})?$' AND p_value !~ '^-0+(\.0+)?$'
$$;

-- Formats a numeric with exactly p_scale fraction digits (never negative zero).
CREATE FUNCTION trustwork.kernel_format_decimal(p_value numeric, p_scale integer) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN round(p_value, p_scale) = 0 THEN round(0::numeric, p_scale)::text ELSE round(p_value, p_scale)::text END
$$;

-- Same-unit addition only (addQuantity in packages/contracts/src/common/quantity.ts): the result keeps the larger
-- fraction scale. Different units raise validation.unit_mismatch; convert first, explicitly.
CREATE FUNCTION trustwork.kernel_quantity_add(p_a_value text, p_a_unit text, p_b_value text, p_b_unit text) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_scale integer;
BEGIN
  IF NOT trustwork.kernel_decimal_ok(p_a_value) OR NOT trustwork.kernel_decimal_ok(p_b_value) THEN
    RAISE EXCEPTION 'quantity value is not an exact decimal' USING ERRCODE = 'invalid_parameter_value', HINT = 'validation.decimal';
  END IF;
  IF p_a_unit IS NULL OR p_b_unit IS NULL OR p_a_unit <> p_b_unit THEN
    RAISE EXCEPTION 'unit mismatch: % vs %', p_a_unit, p_b_unit USING ERRCODE = 'invalid_parameter_value', HINT = 'validation.unit_mismatch';
  END IF;
  v_scale := greatest(length(split_part(p_a_value, '.', 2)), length(split_part(p_b_value, '.', 2)));
  RETURN trustwork.kernel_format_decimal(p_a_value::numeric + p_b_value::numeric, v_scale);
END $$;


-- Converts through the explicit rule row (convertQuantity in packages/contracts/src/common/units.ts): exact integer
-- arithmetic, then rounding to p_scale (0..6) fraction digits with the caller's mode. The same unit returns the value
-- re-scaled under the same rounding; any other pair without a rule raises validation.unit_conversion.
CREATE FUNCTION trustwork.kernel_quantity_convert(p_value text, p_from text, p_to text, p_scale integer, p_rounding text) RETURNS text
LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_num numeric := 1;
  v_den numeric := 1;
  v_frac integer;
  v_n numeric;
  v_d numeric;
  v_abs numeric;
  v_q numeric;
  v_r numeric;
BEGIN
  IF NOT trustwork.kernel_decimal_ok(p_value) THEN
    RAISE EXCEPTION 'quantity value is not an exact decimal' USING ERRCODE = 'invalid_parameter_value', HINT = 'validation.decimal';
  END IF;
  IF p_scale IS NULL OR p_scale NOT BETWEEN 0 AND 6 OR p_rounding IS NULL OR p_rounding NOT IN ('half-even', 'half-up', 'down', 'up') THEN
    RAISE EXCEPTION 'scale 0..6 and an explicit rounding mode are required' USING ERRCODE = 'invalid_parameter_value', HINT = 'validation.unit_conversion';
  END IF;
  IF p_from IS DISTINCT FROM p_to THEN
    SELECT r.numerator, r.denominator INTO v_num, v_den FROM trustwork.unit_conversion_rule r WHERE r.from_unit = p_from AND r.to_unit = p_to;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no conversion rule from % to %', p_from, p_to USING ERRCODE = 'invalid_parameter_value', HINT = 'validation.unit_conversion';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM trustwork.unit WHERE code = p_from) THEN
    RAISE EXCEPTION 'unknown unit %', p_from USING ERRCODE = 'invalid_parameter_value', HINT = 'validation.unit_conversion';
  END IF;
  v_frac := length(split_part(p_value, '.', 2));
  -- result * 10^scale = value * 10^frac / 10^frac * num / den * 10^scale
  v_n := (p_value::numeric * power(10::numeric, v_frac)) * v_num * power(10::numeric, p_scale);
  v_d := v_den * power(10::numeric, v_frac);
  v_abs := abs(v_n);
  v_q := div(v_abs, v_d);
  v_r := mod(v_abs, v_d);
  IF v_r <> 0 AND (p_rounding = 'up' OR (p_rounding = 'half-up' AND v_r * 2 >= v_d)
                   OR (p_rounding = 'half-even' AND (v_r * 2 > v_d OR (v_r * 2 = v_d AND mod(v_q, 2) = 1)))) THEN
    v_q := v_q + 1;
  END IF;
  IF v_n < 0 THEN
    v_q := -v_q;
  END IF;
  RETURN trustwork.kernel_format_decimal(v_q / power(10::numeric, p_scale), p_scale);
END $$;

-- 2. Exchange-rate snapshots (A) -----------------------------------------------------------------------------------
-- ExchangeRateSnapshotSchema (packages/contracts/src/common/money.ts): quote units per one base unit. Used for explicit
-- comparisons only; never an implicit sum. Written by a rate adapter in maintenance context.
CREATE TABLE trustwork.exchange_rate_snapshot (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  base_currency text NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$'),
  quote_currency text NOT NULL CHECK (quote_currency ~ '^[A-Z]{3}$'),
  rate text NOT NULL CHECK (trustwork.kernel_decimal_ok(rate) AND rate !~ '^-' AND rate ~ '[1-9]'),
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 200),
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exchange_rate_snapshot_distinct CHECK (base_currency <> quote_currency),
  CONSTRAINT exchange_rate_snapshot_unique UNIQUE (base_currency, quote_currency, source, observed_at)
);
CREATE INDEX exchange_rate_snapshot_latest_idx ON trustwork.exchange_rate_snapshot (base_currency, quote_currency, observed_at DESC);
CREATE TRIGGER exchange_rate_snapshot_append_only BEFORE UPDATE OR DELETE ON trustwork.exchange_rate_snapshot FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

-- 3. Jurisdictions ---------------------------------------------------------------------------------------------------
-- Mirrors the country-pack trees (source 'pack') and, for every other selectable country, the country-level row of the
-- ISO dataset shipped with @trustwork/country-packs (source 'dataset'). `restricted` is computed (trigger) from the
-- restricted list and the parent; nothing can set it. A restricted code is never inserted, never selectable and never
-- served to the runtime role. Rows are never deleted: a code that leaves its pack is retired.
CREATE TABLE trustwork.jurisdiction (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?(:[a-z0-9][a-z0-9-]{0,62})?$'),
  parent_code text NULL REFERENCES trustwork.jurisdiction (code),
  level text NOT NULL CHECK (level IN ('country', 'subdivision', 'county', 'city', 'district', 'special')),
  region_kind text NULL CHECK (region_kind ~ '^[a-z][a-z-]{1,30}$'),
  source text NOT NULL CHECK (source IN ('pack', 'dataset')),
  pack_code text NULL CHECK (pack_code ~ '^[A-Z]{2}$'),
  pack_version text NOT NULL CHECK (length(pack_version) BETWEEN 1 AND 40),
  restricted boolean NOT NULL DEFAULT true,
  selectable boolean NOT NULL DEFAULT false,
  retired_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jurisdiction_country_shape CHECK ((level = 'country') = (code ~ '^[A-Z]{2}$') AND (level = 'country') = (parent_code IS NULL)),
  CONSTRAINT jurisdiction_parent_prefix CHECK (parent_code IS NULL OR left(code, 2) = left(parent_code, 2)),
  CONSTRAINT jurisdiction_pack_source CHECK ((source = 'pack') = (pack_code IS NOT NULL) AND (pack_code IS NULL OR pack_code = left(code, 2))),
  CONSTRAINT jurisdiction_restricted_not_selectable CHECK (NOT (restricted AND selectable)),
  CONSTRAINT jurisdiction_retired_not_selectable CHECK (retired_at IS NULL OR NOT selectable)
);
CREATE INDEX jurisdiction_parent_idx ON trustwork.jurisdiction (parent_code);
CREATE TRIGGER jurisdiction_touch BEFORE UPDATE ON trustwork.jurisdiction FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

CREATE FUNCTION trustwork.kernel_jurisdiction_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'jurisdictions are never deleted; retire them' USING ERRCODE = 'integrity_constraint_violation', HINT = 'kernel.jurisdiction_permanent';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.code <> OLD.code THEN
    RAISE EXCEPTION 'jurisdiction % cannot be re-coded', OLD.code USING ERRCODE = 'integrity_constraint_violation', HINT = 'kernel.jurisdiction_permanent';
  END IF;
  NEW.restricted := trustwork.kernel_place_restricted(NEW.code)
    OR coalesce((SELECT p.restricted FROM trustwork.jurisdiction p WHERE p.code = NEW.parent_code), false);
  IF TG_OP = 'INSERT' AND NEW.restricted THEN
    RAISE EXCEPTION 'restricted place % cannot be stored as a jurisdiction', NEW.code USING ERRCODE = 'check_violation', HINT = 'kernel.restricted_place';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jurisdiction_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.jurisdiction FOR EACH ROW EXECUTE FUNCTION trustwork.kernel_jurisdiction_guard();

-- Owner-run (maintenance command): recompute `restricted` after the list changed, parents before children, and make
-- newly restricted rows unselectable. Returns the number of rows whose flag changed. Not executable by the runtime.
CREATE FUNCTION trustwork.kernel_recompute_restrictions() RETURNS integer
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_total integer := 0;
  v_step integer;
BEGIN
  LOOP
    UPDATE trustwork.jurisdiction j
       SET selectable = j.selectable AND NOT (trustwork.kernel_place_restricted(j.code)
             OR coalesce((SELECT p.restricted FROM trustwork.jurisdiction p WHERE p.code = j.parent_code), false))
     WHERE j.restricted IS DISTINCT FROM (trustwork.kernel_place_restricted(j.code)
             OR coalesce((SELECT p.restricted FROM trustwork.jurisdiction p WHERE p.code = j.parent_code), false));
    GET DIAGNOSTICS v_step = ROW_COUNT;
    EXIT WHEN v_step = 0;
    v_total := v_total + v_step;
    IF v_total > 1000000 THEN
      RAISE EXCEPTION 'restriction recompute does not converge' USING ERRCODE = 'program_limit_exceeded';
    END IF;
  END LOOP;
  RETURN v_total;
END $$;

-- 4. Hub anchor -----------------------------------------------------------------------------------------------------
-- Minimal anchor that HUB-001 extends (name, locales, brand, successor, configuration): id, node-local key
-- (HubSchema.slug), lifecycle (HUB_LIFECYCLE) and the country-pack binding (HubSchema.countryPack, nullable for the
-- generic profile). A hub bound to a restricted country cannot exist.
CREATE TABLE trustwork.hub (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  lifecycle text NOT NULL DEFAULT 'draft' CHECK (lifecycle IN ('draft', 'preparing', 'soft_launch', 'public', 'suspended', 'closing', 'closed')),
  pack_code text NULL REFERENCES trustwork.jurisdiction (code),
  pack_version text NULL CHECK (length(pack_version) BETWEEN 1 AND 40),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hub_pack_binding CHECK ((pack_code IS NULL) = (pack_version IS NULL) AND (pack_code IS NULL OR pack_code ~ '^[A-Z]{2}$'))
);
CREATE TRIGGER hub_touch BEFORE UPDATE ON trustwork.hub FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

-- Serializes restriction checks against the maintenance command's list sync (exclusive lock there, shared here).
CREATE FUNCTION trustwork.kernel_lock_restrictions_shared() RETURNS void
LANGUAGE sql VOLATILE AS $$
  SELECT pg_advisory_xact_lock_shared(hashtext('trustwork.kernel_restrictions'))
$$;

CREATE FUNCTION trustwork.kernel_hub_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_j trustwork.jurisdiction%ROWTYPE;
BEGIN
  IF NEW.pack_code IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.pack_code IS DISTINCT FROM OLD.pack_code) THEN
    PERFORM trustwork.kernel_lock_restrictions_shared();
    SELECT * INTO v_j FROM trustwork.jurisdiction WHERE code = NEW.pack_code;
    IF NOT FOUND OR v_j.restricted OR trustwork.kernel_place_restricted(NEW.pack_code) THEN
      RAISE EXCEPTION 'hub cannot be bound to restricted or unknown country %', NEW.pack_code USING ERRCODE = 'check_violation', HINT = 'kernel.restricted_place';
    END IF;
    IF v_j.source <> 'pack' OR v_j.retired_at IS NOT NULL THEN
      RAISE EXCEPTION 'country % has no active country pack', NEW.pack_code USING ERRCODE = 'check_violation', HINT = 'kernel.pack_unknown';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hub_guard BEFORE INSERT OR UPDATE ON trustwork.hub FOR EACH ROW EXECUTE FUNCTION trustwork.kernel_hub_guard();

-- HubTerritorySchema: country (ISO 3166-1), region (ISO 3166-2) or place (pack or hub-local key under a country or
-- region). Descriptive, never exclusive. The country and region a territory names must be selectable, live
-- jurisdictions; a restricted place is rejected whatever the stored flags say.
CREATE TABLE trustwork.hub_territory (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NOT NULL REFERENCES trustwork.hub (id),
  level text NOT NULL CHECK (level IN ('country', 'region', 'place')),
  code text NOT NULL,
  place_key text NULL CHECK (place_key ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hub_territory_shape CHECK (CASE level
    WHEN 'country' THEN code ~ '^[A-Z]{2}$' AND place_key IS NULL
    WHEN 'region' THEN code ~ '^[A-Z]{2}-[A-Z0-9]{1,3}$' AND place_key IS NULL
    ELSE code ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?:[a-z0-9][a-z0-9-]{0,62}$' AND place_key = split_part(code, ':', 2) END),
  CONSTRAINT hub_territory_unique UNIQUE (hub_id, code)
);

CREATE FUNCTION trustwork.kernel_hub_territory_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_area text := split_part(NEW.code, ':', 1);
  v_code text;
  v_j trustwork.jurisdiction%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'hub territories are replaced, not edited' USING ERRCODE = 'integrity_constraint_violation', HINT = 'kernel.territory_immutable';
  END IF;
  PERFORM trustwork.kernel_lock_restrictions_shared();
  IF trustwork.kernel_place_restricted(NEW.code) THEN
    RAISE EXCEPTION 'restricted place % cannot be a hub territory', NEW.code USING ERRCODE = 'check_violation', HINT = 'kernel.restricted_place';
  END IF;
  FOREACH v_code IN ARRAY ARRAY[left(NEW.code, 2), v_area] LOOP
    SELECT * INTO v_j FROM trustwork.jurisdiction WHERE code = v_code;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'unknown jurisdiction % for hub territory', v_code USING ERRCODE = 'foreign_key_violation', HINT = 'kernel.jurisdiction_unknown';
    END IF;
    IF v_j.restricted THEN
      RAISE EXCEPTION 'restricted place % cannot be a hub territory', v_code USING ERRCODE = 'check_violation', HINT = 'kernel.restricted_place';
    END IF;
    IF NOT v_j.selectable THEN
      RAISE EXCEPTION 'jurisdiction % is not selectable', v_code USING ERRCODE = 'check_violation', HINT = 'kernel.jurisdiction_not_selectable';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER hub_territory_guard BEFORE INSERT OR UPDATE ON trustwork.hub_territory FOR EACH ROW EXECUTE FUNCTION trustwork.kernel_hub_territory_guard();

-- 5. Taxonomy -------------------------------------------------------------------------------------------------------
-- The open plan-step taxonomy (data/taxonomy, PLAN-000) plus the model's editorial schemes. hub_id NULL = engine term
-- or release; a hub extension never redefines an engine code. Codes are stable once released.
CREATE TABLE trustwork.taxonomy_release (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NULL REFERENCES trustwork.hub (id),
  version text NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  released_by uuid NULL REFERENCES trustwork.person (id),
  released_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT taxonomy_release_hub_releaser CHECK (hub_id IS NULL OR released_by IS NOT NULL)
);
CREATE UNIQUE INDEX taxonomy_release_engine_version ON trustwork.taxonomy_release (version) WHERE hub_id IS NULL;
CREATE UNIQUE INDEX taxonomy_release_hub_version ON trustwork.taxonomy_release (hub_id, version) WHERE hub_id IS NOT NULL;
CREATE TRIGGER taxonomy_release_append_only BEFORE UPDATE OR DELETE ON trustwork.taxonomy_release FOR EACH ROW EXECUTE FUNCTION trustwork.forbid_mutation();

CREATE TABLE trustwork.taxonomy_term (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NULL REFERENCES trustwork.hub (id),
  scheme text NOT NULL CHECK (scheme IN (
    'topic', 'category', 'article_format', 'event_type', 'licence_class', 'need_category', 'project_type',
    'work_type', 'trade', 'material', 'stage', 'skill', 'permit_type', 'inspection_type', 'decision')),
  code text NOT NULL CHECK (code ~ '^[a-z]+(\.[a-z0-9_]+)*$' AND length(code) <= 200),
  parent_id uuid NULL REFERENCES trustwork.taxonomy_term (id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'released', 'retired')),
  release_id uuid NULL REFERENCES trustwork.taxonomy_release (id),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attributes) = 'object'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT taxonomy_term_release CHECK (status = 'draft' OR release_id IS NOT NULL)
);
CREATE UNIQUE INDEX taxonomy_term_engine_code ON trustwork.taxonomy_term (code) WHERE hub_id IS NULL;
CREATE UNIQUE INDEX taxonomy_term_hub_code ON trustwork.taxonomy_term (hub_id, code) WHERE hub_id IS NOT NULL;
CREATE INDEX taxonomy_term_scheme_idx ON trustwork.taxonomy_term (scheme, status);
CREATE TRIGGER taxonomy_term_touch BEFORE UPDATE ON trustwork.taxonomy_term FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

CREATE FUNCTION trustwork.kernel_taxonomy_term_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_parent trustwork.taxonomy_term%ROWTYPE;
  v_release trustwork.taxonomy_release%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'released taxonomy code % is never deleted; retire it', OLD.code USING ERRCODE = 'integrity_constraint_violation', HINT = 'kernel.taxonomy_code_stable';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status <> 'draft' THEN
    IF NEW.code <> OLD.code OR NEW.scheme <> OLD.scheme OR NEW.hub_id IS DISTINCT FROM OLD.hub_id OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
       OR NEW.release_id IS DISTINCT FROM OLD.release_id OR NEW.status = 'draft' OR (OLD.status = 'retired' AND NEW.status <> 'retired') THEN
      RAISE EXCEPTION 'released taxonomy code % is stable', OLD.code USING ERRCODE = 'integrity_constraint_violation', HINT = 'kernel.taxonomy_code_stable';
    END IF;
  END IF;
  -- One code space: serialize on the code so a concurrent engine and hub insert cannot both pass the check below.
  PERFORM pg_advisory_xact_lock(hashtext('trustwork.taxonomy_code'), hashtext(NEW.code));
  IF NEW.hub_id IS NOT NULL AND EXISTS (SELECT 1 FROM trustwork.taxonomy_term t WHERE t.hub_id IS NULL AND t.code = NEW.code) THEN
    RAISE EXCEPTION 'hub term % would redefine an engine code', NEW.code USING ERRCODE = 'unique_violation', HINT = 'kernel.taxonomy_engine_code';
  END IF;
  IF NEW.hub_id IS NULL AND EXISTS (SELECT 1 FROM trustwork.taxonomy_term t WHERE t.hub_id IS NOT NULL AND t.code = NEW.code) THEN
    RAISE EXCEPTION 'engine code % is already used by a hub extension', NEW.code USING ERRCODE = 'unique_violation', HINT = 'kernel.taxonomy_engine_code';
  END IF;
  IF NEW.parent_id IS NOT NULL THEN
    SELECT * INTO v_parent FROM trustwork.taxonomy_term WHERE id = NEW.parent_id;
    IF v_parent.scheme <> NEW.scheme OR (v_parent.hub_id IS NOT NULL AND v_parent.hub_id IS DISTINCT FROM NEW.hub_id) THEN
      RAISE EXCEPTION 'parent of % must be in the same scheme and the engine or the same hub', NEW.code USING ERRCODE = 'check_violation', HINT = 'kernel.taxonomy_parent';
    END IF;
  END IF;
  IF NEW.release_id IS NOT NULL THEN
    SELECT * INTO v_release FROM trustwork.taxonomy_release WHERE id = NEW.release_id;
    IF v_release.hub_id IS DISTINCT FROM NEW.hub_id THEN
      RAISE EXCEPTION 'term % belongs to a release of another scope', NEW.code USING ERRCODE = 'check_violation', HINT = 'kernel.taxonomy_release_scope';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER taxonomy_term_guard BEFORE INSERT OR UPDATE OR DELETE ON trustwork.taxonomy_term FOR EACH ROW EXECUTE FUNCTION trustwork.kernel_taxonomy_term_guard();

-- Relations of the plan-step taxonomy (relations() in data/taxonomy/validate.mjs). `precedes` and `in_stage` are the
-- additions requested by PLAN-000. A relation is engine-scoped (hub_id NULL, engine terms only) or belongs to one hub
-- (its terms are engine terms or that hub's terms).
CREATE TABLE trustwork.step_term_relation (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  hub_id uuid NULL REFERENCES trustwork.hub (id),
  from_term_id uuid NOT NULL REFERENCES trustwork.taxonomy_term (id),
  relation text NOT NULL CHECK (relation IN ('requires_trade', 'uses_material', 'precedes_stage', 'needs_permit_type', 'teaches', 'precedes', 'in_stage')),
  to_term_id uuid NOT NULL REFERENCES trustwork.taxonomy_term (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT step_term_relation_not_self CHECK (from_term_id <> to_term_id),
  CONSTRAINT step_term_relation_unique UNIQUE (from_term_id, relation, to_term_id)
);
CREATE INDEX step_term_relation_to_idx ON trustwork.step_term_relation (to_term_id, relation);

CREATE FUNCTION trustwork.kernel_step_relation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
DECLARE
  v_from trustwork.taxonomy_term%ROWTYPE;
  v_to trustwork.taxonomy_term%ROWTYPE;
  v_ok boolean;
BEGIN
  SELECT * INTO v_from FROM trustwork.taxonomy_term WHERE id = NEW.from_term_id;
  SELECT * INTO v_to FROM trustwork.taxonomy_term WHERE id = NEW.to_term_id;
  IF (v_from.hub_id IS NOT NULL AND v_from.hub_id IS DISTINCT FROM NEW.hub_id) OR (v_to.hub_id IS NOT NULL AND v_to.hub_id IS DISTINCT FROM NEW.hub_id) THEN
    RAISE EXCEPTION 'relation scope does not match its terms' USING ERRCODE = 'check_violation', HINT = 'kernel.taxonomy_relation_scope';
  END IF;
  v_ok := CASE NEW.relation
    WHEN 'requires_trade' THEN v_to.scheme = 'trade'
    WHEN 'uses_material' THEN v_to.scheme = 'material'
    WHEN 'needs_permit_type' THEN v_to.scheme = 'permit_type'
    WHEN 'in_stage' THEN v_to.scheme = 'stage' AND v_from.scheme <> 'stage'
    WHEN 'precedes_stage' THEN v_from.scheme = 'stage' AND v_to.scheme = 'stage'
    WHEN 'precedes' THEN v_from.scheme IN ('work_type', 'permit_type', 'inspection_type', 'decision') AND v_to.scheme IN ('work_type', 'permit_type', 'inspection_type', 'decision')
    ELSE true END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'relation % does not fit schemes % -> %', NEW.relation, v_from.scheme, v_to.scheme USING ERRCODE = 'check_violation', HINT = 'kernel.taxonomy_relation_scheme';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER step_term_relation_guard BEFORE INSERT OR UPDATE ON trustwork.step_term_relation FOR EACH ROW EXECUTE FUNCTION trustwork.kernel_step_relation_guard();

-- 6. Evidence artifacts -------------------------------------------------------------------------------------------
-- Stored files (AttachmentRefSchema.evidenceArtifactId / hash). Access needs the authorized parent AND the artifact's
-- own classification; the bytes live in object storage under storage_key (signed URLs with a bounded TTL are the
-- storage adapter's job). Content identity (owner, parent, classification, key, hash, size, type, uploader) never
-- changes: a copy or move is a new row. Only the scanner and legal staff (maintenance) change scan_state/legal_hold.
CREATE TABLE trustwork.evidence_artifact (
  id uuid PRIMARY KEY DEFAULT trustwork.new_uuid(),
  owner_person_id uuid NULL REFERENCES trustwork.person (id),
  owner_company_id uuid NULL REFERENCES trustwork.company (id),
  parent_kind text NOT NULL CHECK (parent_kind IN ('person', 'company', 'project', 'rfq', 'quote', 'agreement', 'order', 'thread', 'publication')),
  parent_id uuid NOT NULL,
  classification text NOT NULL CHECK (classification IN ('public', 'shared', 'party_private', 'owner_private', 'restricted')),
  storage_key text NOT NULL UNIQUE CHECK (length(storage_key) <= 512 AND storage_key ~ '^[A-Za-z0-9][A-Za-z0-9/_.=-]*$' AND storage_key !~ '\.\.'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  bytes bigint NOT NULL CHECK (bytes >= 0),
  media_type text NOT NULL CHECK (media_type ~ '^[a-z]+/[a-z0-9][a-z0-9.+-]{0,126}$'),
  scan_state text NOT NULL DEFAULT 'pending' CHECK (scan_state IN ('pending', 'clean', 'quarantined')),
  uploaded_by uuid NOT NULL REFERENCES trustwork.person (id),
  legal_hold boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_artifact_owner_xor CHECK ((owner_person_id IS NULL) <> (owner_company_id IS NULL))
);
CREATE INDEX evidence_artifact_parent_idx ON trustwork.evidence_artifact (parent_kind, parent_id);
CREATE INDEX evidence_artifact_owner_person_idx ON trustwork.evidence_artifact (owner_person_id) WHERE owner_person_id IS NOT NULL;
CREATE INDEX evidence_artifact_owner_company_idx ON trustwork.evidence_artifact (owner_company_id) WHERE owner_company_id IS NOT NULL;
CREATE TRIGGER evidence_artifact_touch BEFORE UPDATE ON trustwork.evidence_artifact FOR EACH ROW EXECUTE FUNCTION trustwork.touch_row();

CREATE FUNCTION trustwork.kernel_evidence_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = trustwork, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.legal_hold THEN
      RAISE EXCEPTION 'artifact under legal hold' USING ERRCODE = 'integrity_constraint_violation', HINT = 'kernel.legal_hold';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.owner_person_id IS DISTINCT FROM OLD.owner_person_id OR NEW.owner_company_id IS DISTINCT FROM OLD.owner_company_id
     OR NEW.parent_kind <> OLD.parent_kind OR NEW.parent_id <> OLD.parent_id OR NEW.classification <> OLD.classification
     OR NEW.storage_key <> OLD.storage_key OR NEW.sha256 <> OLD.sha256 OR NEW.bytes <> OLD.bytes OR NEW.media_type <> OLD.media_type
     OR NEW.uploaded_by <> OLD.uploaded_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'evidence artifact content identity is immutable; copy or move creates a new artifact' USING ERRCODE = 'integrity_constraint_violation', HINT = 'kernel.evidence_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evidence_artifact_guard BEFORE UPDATE OR DELETE ON trustwork.evidence_artifact FOR EACH ROW EXECUTE FUNCTION trustwork.kernel_evidence_guard();

-- 7. Row-level security and grants ----------------------------------------------------------------------------------
ALTER TABLE trustwork.restricted_place ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.restricted_place FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.unit ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.unit FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.unit_conversion_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.unit_conversion_rule FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.exchange_rate_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.exchange_rate_snapshot FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.jurisdiction ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.jurisdiction FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.hub ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.hub FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.hub_territory ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.hub_territory FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.taxonomy_release ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.taxonomy_release FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.taxonomy_term ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.taxonomy_term FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.step_term_relation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.step_term_relation FORCE ROW LEVEL SECURITY;
ALTER TABLE trustwork.evidence_artifact ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.evidence_artifact FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_all ON trustwork.restricted_place AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.unit AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.unit_conversion_rule AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.exchange_rate_snapshot AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.jurisdiction AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.hub AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.hub_territory AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.taxonomy_release AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.taxonomy_term AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.step_term_relation AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY maintenance_all ON trustwork.evidence_artifact AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());

-- Public reference data (projection layer P): readable with or without an identity. Restricted jurisdictions, hubs
-- before soft launch and draft taxonomy are never served to the runtime role.
CREATE POLICY restricted_place_read ON trustwork.restricted_place FOR SELECT TO trustwork_app USING (true);
CREATE POLICY unit_read ON trustwork.unit FOR SELECT TO trustwork_app USING (true);
CREATE POLICY unit_conversion_rule_read ON trustwork.unit_conversion_rule FOR SELECT TO trustwork_app USING (true);
CREATE POLICY exchange_rate_snapshot_read ON trustwork.exchange_rate_snapshot FOR SELECT TO trustwork_app USING (true);
CREATE POLICY jurisdiction_read ON trustwork.jurisdiction FOR SELECT TO trustwork_app USING (NOT restricted);
CREATE POLICY hub_read ON trustwork.hub FOR SELECT TO trustwork_app USING (lifecycle NOT IN ('draft', 'preparing'));
CREATE POLICY hub_territory_read ON trustwork.hub_territory FOR SELECT TO trustwork_app
  USING (EXISTS (SELECT 1 FROM trustwork.hub h WHERE h.id = hub_id));
CREATE POLICY taxonomy_release_read ON trustwork.taxonomy_release FOR SELECT TO trustwork_app
  USING (hub_id IS NULL OR EXISTS (SELECT 1 FROM trustwork.hub h WHERE h.id = hub_id));
CREATE POLICY taxonomy_term_read ON trustwork.taxonomy_term FOR SELECT TO trustwork_app
  USING (status <> 'draft' AND (hub_id IS NULL OR EXISTS (SELECT 1 FROM trustwork.hub h WHERE h.id = hub_id)));
CREATE POLICY step_term_relation_read ON trustwork.step_term_relation FOR SELECT TO trustwork_app
  USING (EXISTS (SELECT 1 FROM trustwork.taxonomy_term f WHERE f.id = from_term_id) AND EXISTS (SELECT 1 FROM trustwork.taxonomy_term t WHERE t.id = to_term_id)
         AND (hub_id IS NULL OR EXISTS (SELECT 1 FROM trustwork.hub h WHERE h.id = hub_id)));

-- Evidence: the owner party always sees its artifacts. Anyone else needs an identity, a clean scan and both gates:
--   public -> the parent is visible to the caller under its own policies (a public or own profile, any company, a
--             public, owned or participated project; for other kinds, a party of the parent);
--   shared -> the caller is a party of the parent (owner or live participant);
--   party_private, owner_private -> owner party only; restricted -> no runtime read (staff case path, DATA-002).
CREATE POLICY evidence_artifact_read ON trustwork.evidence_artifact FOR SELECT TO trustwork_app
  USING (
    trustwork.current_person_id() IS NOT NULL AND (
      (classification <> 'restricted' AND (owner_person_id = trustwork.current_person_id() OR owner_company_id = trustwork.current_company_id()))
      OR (scan_state = 'clean' AND CASE classification
        WHEN 'public' THEN CASE parent_kind
          WHEN 'person' THEN EXISTS (SELECT 1 FROM trustwork.person s WHERE s.id = parent_id)
          WHEN 'company' THEN EXISTS (SELECT 1 FROM trustwork.company s WHERE s.id = parent_id)
          WHEN 'project' THEN EXISTS (SELECT 1 FROM trustwork.project p WHERE p.id = parent_id)
          ELSE trustwork.owns_resource(parent_kind, parent_id) OR trustwork.participates_in_resource(parent_kind, parent_id) END
        WHEN 'shared' THEN CASE parent_kind
          WHEN 'person' THEN parent_id = trustwork.current_person_id()
          WHEN 'company' THEN parent_id = trustwork.current_company_id()
          ELSE trustwork.owns_resource(parent_kind, parent_id) OR trustwork.participates_in_resource(parent_kind, parent_id) END
        ELSE false END)
    )
  );
-- Upload: the caller is the uploader, owns the artifact (self or the active employer), the scan is pending, no legal
-- hold, never `restricted`, and the caller may attach to the parent (self, the active employer, or owner/participant
-- of the resource). Capability checks (for example write.draft) are the command layer's job (ADR 002).
CREATE POLICY evidence_artifact_insert ON trustwork.evidence_artifact FOR INSERT TO trustwork_app
  WITH CHECK (
    trustwork.current_person_id() IS NOT NULL
    AND uploaded_by = trustwork.current_person_id()
    AND (owner_person_id = trustwork.current_person_id() OR (owner_company_id IS NOT NULL AND owner_company_id = trustwork.current_company_id()))
    AND scan_state = 'pending' AND NOT legal_hold AND classification <> 'restricted'
    AND CASE parent_kind
      WHEN 'person' THEN parent_id = trustwork.current_person_id()
      WHEN 'company' THEN parent_id = trustwork.current_company_id()
      ELSE trustwork.owns_resource(parent_kind, parent_id) OR trustwork.participates_in_resource(parent_kind, parent_id) END
  );

GRANT SELECT ON trustwork.restricted_place, trustwork.unit, trustwork.unit_conversion_rule, trustwork.exchange_rate_snapshot,
  trustwork.jurisdiction, trustwork.hub, trustwork.hub_territory, trustwork.taxonomy_release, trustwork.taxonomy_term,
  trustwork.step_term_relation, trustwork.evidence_artifact TO trustwork_app;
GRANT INSERT (owner_person_id, owner_company_id, parent_kind, parent_id, classification, storage_key, sha256, bytes, media_type, uploaded_by)
  ON trustwork.evidence_artifact TO trustwork_app;

-- Invoker helpers (not SECURITY DEFINER): quantity arithmetic and the restriction predicate for the application.
-- kernel_recompute_restrictions and the lock helper stay owner-only (only maintenance writes hubs and territories).
GRANT EXECUTE ON FUNCTION trustwork.kernel_place_restricted(text), trustwork.kernel_decimal_ok(text), trustwork.kernel_format_decimal(numeric, integer),
  trustwork.kernel_quantity_add(text, text, text, text), trustwork.kernel_quantity_convert(text, text, text, integer, text) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
