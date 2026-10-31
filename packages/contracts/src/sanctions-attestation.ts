import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common/ids.js';
import { coveringRestrictedPlace, type JurisdictionGateMode, type RestrictedPlaces } from './sanctions.js';

/* ---------- Deployment-location attestation (SANC-009, ADR 014 decisions 3 to 5) ---------- */

/**
 * The engine never geolocates the server it runs on (decision 3). The operator **states** in the setup wizard where its
 * legal entity and its hosting are, and which jurisdiction-gate mode it runs; a restricted place is refused, the
 * statement is recorded append-only and audited, and it is renewed when a location or the gate mode changes and at
 * least every `DEPLOYMENT_ATTESTATION_VALIDITY_DAYS`. It is evidence, not a guarantee (decision 5): `basis` is always
 * `operator_statement`, and no reader may present it as a verification.
 */
export const DEPLOYMENT_ATTESTATION_STATEMENT_VERSION = 'deployment-location-1';
/** An attestation lasts this long; the database fixes `expires_at = attested_at + 365 days`. */
export const DEPLOYMENT_ATTESTATION_VALIDITY_DAYS = 365;
/** The renewal reminder starts this many days before expiry. */
export const DEPLOYMENT_ATTESTATION_RENEWAL_NOTICE_DAYS = 30;
/** Gate modes an operator can attest; `fake` is a test adapter, never a deployment statement. */
export const ATTESTED_GATE_MODES = ['ranges_file', 'edge_header', 'upstream_gate'] as const;
export const AttestedGateModeSchema = z.enum(ATTESTED_GATE_MODES);
export type AttestedGateMode = z.infer<typeof AttestedGateModeSchema>;
/** The permissions that authorize an attestation, held at the node (node or platform scope; a hub scope never covers it). */
export const ATTESTATION_PERMISSIONS = ['admin.node.hubs.manage', 'admin.hub.jurisdiction.edit'] as const;

export const AttestedCountryCodeSchema = z.string().regex(/^[A-Z]{2}$/);
export const AttestedRegionCodeSchema = z.string().regex(/^[A-Z]{2}-[A-Z0-9]{1,3}$/);
const HexDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

const locationShape = {
  operatorEntityCountry: AttestedCountryCodeSchema,
  operatorEntityRegion: AttestedRegionCodeSchema.nullable(),
  hostingCountry: AttestedCountryCodeSchema,
  hostingRegion: AttestedRegionCodeSchema.nullable(),
};
type LocationFields = { operatorEntityCountry: string; operatorEntityRegion: string | null; hostingCountry: string; hostingRegion: string | null };
const regionsMatch = (l: LocationFields) =>
  (l.operatorEntityRegion === null || l.operatorEntityRegion.slice(0, 2) === l.operatorEntityCountry) && (l.hostingRegion === null || l.hostingRegion.slice(0, 2) === l.hostingCountry);
const REGION_MESSAGE = { message: 'a region is an ISO 3166-2 code of the stated country', path: ['hostingRegion'] };

/** Staff command: attest (supersedes null) or renew (supersedes = the current attestation id). */
export const AttestDeploymentLocationCommandSchema = z
  .strictObject({
    ...locationShape,
    gateMode: AttestedGateModeSchema,
    supersedes: z.uuid().nullable(),
    statementVersion: z.literal(DEPLOYMENT_ATTESTATION_STATEMENT_VERSION),
    /** The attesting person confirms the statement is true to their knowledge; there is no implicit attestation. */
    confirmed: z.literal(true),
    reason: z.string().trim().min(1).max(500),
  })
  .refine(regionsMatch, REGION_MESSAGE);
export type AttestDeploymentLocationCommand = z.infer<typeof AttestDeploymentLocationCommandSchema>;

const withinValidity = (a: { attestedAt: string; expiresAt: string }) => Date.parse(a.expiresAt) - Date.parse(a.attestedAt) === DEPLOYMENT_ATTESTATION_VALIDITY_DAYS * 86_400_000;
const VALIDITY_MESSAGE = { message: `an attestation expires ${DEPLOYMENT_ATTESTATION_VALIDITY_DAYS} days after it was made`, path: ['expiresAt'] };

/** The current attestation as every reader sees it (launch gate, node manifest, our services): no attesting person. */
export const DeploymentLocationAttestationSummarySchema = z
  .strictObject({
    id: IdSchema,
    nodeId: IdSchema,
    ...locationShape,
    gateMode: AttestedGateModeSchema,
    statementDigest: HexDigestSchema,
    attestedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    supersedesId: IdSchema.nullable(),
    basis: z.literal('operator_statement'),
  })
  .refine(regionsMatch, REGION_MESSAGE)
  .refine(withinValidity, VALIDITY_MESSAGE);
export type DeploymentLocationAttestationSummary = z.infer<typeof DeploymentLocationAttestationSummarySchema>;

/** The full record (`SC`, node staff): who attested, through which role and permission, under which elevation. */
export const DeploymentLocationAttestationSchema = z
  .strictObject({
    id: IdSchema,
    nodeId: IdSchema,
    ...locationShape,
    gateMode: AttestedGateModeSchema,
    statementVersion: z.literal(DEPLOYMENT_ATTESTATION_STATEMENT_VERSION),
    statementDigest: HexDigestSchema,
    attestedBy: IdSchema,
    attesterRole: z.string().regex(/^[a-z][a-z-]{1,40}$/),
    permission: z.enum(ATTESTATION_PERMISSIONS),
    sessionElevationId: IdSchema,
    breakglass: z.boolean(),
    attestedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    supersedesId: IdSchema.nullable(),
    basis: z.literal('operator_statement'),
  })
  .refine(regionsMatch, REGION_MESSAGE)
  .refine(withinValidity, VALIDITY_MESSAGE)
  .refine((a) => a.supersedesId !== a.id, { message: 'an attestation never supersedes itself', path: ['supersedesId'] });
export type DeploymentLocationAttestation = z.infer<typeof DeploymentLocationAttestationSchema>;

/**
 * The digest input the database binds into `statement_digest` (trustwork-digest-1 over these keys): the statement, the
 * attesting person and elevation, the times and the predecessor. The server-side trustwork-digest-1 of
 * `deploymentAttestationStatement(a)` equals `a.statementDigest` for every recorded attestation.
 */
export function deploymentAttestationStatement(a: DeploymentLocationAttestation): Record<string, string | null> {
  return {
    statementVersion: a.statementVersion, nodeId: a.nodeId, operatorEntityCountry: a.operatorEntityCountry, operatorEntityRegion: a.operatorEntityRegion,
    hostingCountry: a.hostingCountry, hostingRegion: a.hostingRegion, gateMode: a.gateMode, attestedBy: a.attestedBy, sessionElevationId: a.sessionElevationId,
    attestedAt: a.attestedAt, expiresAt: a.expiresAt, supersedesId: a.supersedesId,
  };
}

export type AttestationField = 'operator_entity_country' | 'operator_entity_region' | 'hosting_country' | 'hosting_region';
export interface AttestationRefusal {
  field: AttestationField;
  place: string;
  reason: 'restricted' | 'region_required';
}
/** Must a place in this country be stated with its region? Yes when the restricted list names a region of it (UA-43 for UA). */
export function attestationRegionRequired(country: string, restricted: RestrictedPlaces): boolean {
  for (const code of restricted.codes) if (code.startsWith(`${country}-`)) return true;
  return false;
}
/** What the database refuses in a statement (`attestation_refusals`), computed from the injected restricted list. */
export function deploymentLocationRefusals(l: LocationFields, restricted: RestrictedPlaces): AttestationRefusal[] {
  const out: AttestationRefusal[] = [];
  const side = (country: string, region: string | null, countryField: AttestationField, regionField: AttestationField) => {
    const countryRestricted = coveringRestrictedPlace(country, restricted) !== null;
    if (countryRestricted) out.push({ field: countryField, place: country, reason: 'restricted' });
    if (region !== null && coveringRestrictedPlace(region, restricted) !== null) out.push({ field: regionField, place: region, reason: 'restricted' });
    if (region === null && !countryRestricted && attestationRegionRequired(country, restricted)) out.push({ field: regionField, place: country, reason: 'region_required' });
  };
  side(l.operatorEntityCountry, l.operatorEntityRegion, 'operator_entity_country', 'operator_entity_region');
  side(l.hostingCountry, l.hostingRegion, 'hosting_country', 'hosting_region');
  return out;
}

export const DEPLOYMENT_ATTESTATION_STATES = ['missing', 'valid', 'renewal_due', 'expired', 'contradicted', 'restricted'] as const;
export const DeploymentAttestationStateSchema = z.enum(DEPLOYMENT_ATTESTATION_STATES);
export type DeploymentAttestationState = z.infer<typeof DeploymentAttestationStateSchema>;
export const DEPLOYMENT_ATTESTATION_PROBLEMS = [
  'no_attestation', 'expired', 'gate_mode_changed', 'operator_entity_country_changed', 'operator_entity_region_changed', 'hosting_country_changed', 'hosting_region_changed',
  'place_now_restricted', 'region_now_required',
] as const;
export const DeploymentAttestationProblemSchema = z.enum(DEPLOYMENT_ATTESTATION_PROBLEMS);
export type DeploymentAttestationProblem = z.infer<typeof DeploymentAttestationProblemSchema>;

/** What the console, the launch gate and other services read: the state, why, and when to renew. */
export const DeploymentAttestationStatusSchema = z.strictObject({
  state: DeploymentAttestationStateSchema,
  problems: z.array(DeploymentAttestationProblemSchema),
  attestation: DeploymentLocationAttestationSummarySchema.nullable(),
  renewalDueAt: TimestampSchema.nullable(),
  /** This attestation's share of the `sanctions_screening_configured` launch gate (the gate needs more evidence than this). */
  launchGate: z.strictObject({ gate: z.literal('sanctions_screening_configured'), contribution: z.enum(['satisfied', 'open', 'invalidated']) }),
  reminder: z.strictObject({ kind: z.enum(['attest', 'renew', 'reattest']), dueAt: TimestampSchema.nullable() }).nullable(),
  basis: z.literal('operator_statement'),
});
export type DeploymentAttestationStatus = z.infer<typeof DeploymentAttestationStatusSchema>;

/**
 * The deployment's configuration as the process knows it. `gateMode` is the configured jurisdiction gate; the location
 * fields are given only by a configuration that states them elsewhere (for example the setup wizard's operator step or
 * a residency configuration); `undefined` means "not stated there", which never contradicts the attestation.
 */
export interface DeploymentConfiguration {
  gateMode: JurisdictionGateMode | 'unconfigured';
  operatorEntityCountry?: string;
  operatorEntityRegion?: string | null;
  hostingCountry?: string;
  hostingRegion?: string | null;
}

/**
 * The state of the deployment-location attestation at `now` (ADR 014 decision 4): `restricted` when a stated place is
 * refused by the current list, `contradicted` when the configuration says otherwise (or the list now needs a region),
 * `expired` after `expiresAt`, `renewal_due` within the notice period, `valid` otherwise, `missing` before the first
 * attestation. Anything but `valid` and `renewal_due` keeps (or puts) the launch gate open.
 */
export function deploymentAttestationStatus(
  attestation: DeploymentLocationAttestationSummary | null,
  context: { now: Date; restricted: RestrictedPlaces; configuration: DeploymentConfiguration },
): DeploymentAttestationStatus {
  const basis = 'operator_statement' as const;
  const gate = 'sanctions_screening_configured' as const;
  if (attestation === null) {
    return { state: 'missing', problems: ['no_attestation'], attestation: null, renewalDueAt: null, launchGate: { gate, contribution: 'open' }, reminder: { kind: 'attest', dueAt: null }, basis };
  }
  const now = context.now.getTime();
  const expiresAt = Date.parse(attestation.expiresAt);
  const renewalDueAt = new Date(expiresAt - DEPLOYMENT_ATTESTATION_RENEWAL_NOTICE_DAYS * 86_400_000);
  const problems: DeploymentAttestationProblem[] = [];
  const refusals = deploymentLocationRefusals(attestation, context.restricted);
  if (refusals.some((r) => r.reason === 'restricted')) problems.push('place_now_restricted');
  if (refusals.some((r) => r.reason === 'region_required')) problems.push('region_now_required');
  const c = context.configuration;
  if (c.gateMode !== attestation.gateMode) problems.push('gate_mode_changed');
  if (c.operatorEntityCountry !== undefined && c.operatorEntityCountry !== attestation.operatorEntityCountry) problems.push('operator_entity_country_changed');
  if (c.operatorEntityRegion !== undefined && c.operatorEntityRegion !== attestation.operatorEntityRegion) problems.push('operator_entity_region_changed');
  if (c.hostingCountry !== undefined && c.hostingCountry !== attestation.hostingCountry) problems.push('hosting_country_changed');
  if (c.hostingRegion !== undefined && c.hostingRegion !== attestation.hostingRegion) problems.push('hosting_region_changed');
  const expired = !Number.isFinite(now) || now >= expiresAt;
  if (expired) problems.push('expired');
  let state: DeploymentAttestationState;
  if (problems.includes('place_now_restricted')) state = 'restricted';
  else if (problems.some((p) => p !== 'expired')) state = 'contradicted';
  else if (expired) state = 'expired';
  else if (now >= renewalDueAt.getTime()) state = 'renewal_due';
  else state = 'valid';
  const inForce = state === 'valid' || state === 'renewal_due';
  return {
    state, problems, attestation, renewalDueAt: renewalDueAt.toISOString(),
    launchGate: { gate, contribution: inForce ? 'satisfied' : 'invalidated' },
    reminder: state === 'valid' ? null : state === 'renewal_due' ? { kind: 'renew', dueAt: attestation.expiresAt } : { kind: 'reattest', dueAt: null },
    basis,
  };
}
