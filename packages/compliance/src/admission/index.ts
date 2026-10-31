import { z } from 'zod';
import {
  coveringRestrictedPlace,
  GeoDatasetSchema,
  parseAddress,
  RestrictedPlaceCodeSchema,
  type GateRequest,
  type JurisdictionGate,
  type RestrictedPlaces,
} from '../../../contracts/src/sanctions.js';
import {
  AttestedCountryCodeSchema,
  AttestedRegionCodeSchema,
  deploymentLocationRefusals,
  type AttestationField,
  type DeploymentLocationAttestationSummary,
} from '../../../contracts/src/sanctions-attestation.js';

/**
 * Admission to the services we operate (SANC-008, ADR 014 decisions 3 to 5, ADR 011 decision 12).
 *
 * This check runs on **our** side of a connection and judges the **other** party: a federation peer at handshake, a
 * node asking to be listed in the public hub directory, a client pulling a release or a container image from a channel
 * we front, a person writing to project support, a visitor of a service Contribuda hosts. It never looks at the server
 * it runs in: the engine contains no code that geolocates its own server, phones home or disables itself by location
 * (decision 3). An operator running the engine elsewhere is not affected by this module unless they call it for their
 * own receiving services.
 *
 * Three kinds of evidence, each optional per call and required per service (`ADMISSION_POLICIES`):
 *
 * - **declared**: the other party's manifest (jurisdiction, operator country, hub territories) or places it stated;
 * - **attested**: the other party's deployment-location attestation (operator entity and hosting country and region,
 *   SANC-009), which is an operator statement and never a verification (decision 5);
 * - **observed**: the place of the connection's address, resolved on our side through the geolocation port of SANC-001
 *   (`JurisdictionGate`: `ranges_file`, `edge_header`, `upstream_gate` or `fake`).
 *
 * Any evidence that is presented is judged, required evidence that is missing refuses, and nothing can admit a party
 * that one piece of evidence places in a restricted place: there is no allowlist, override, staff bypass or setting.
 * Restricted places come only from the injected authoritative list (`restricted.json` or its kernel mirror).
 *
 * The address is used for the lookup and then dropped: a decision, a refusal record and a log event carry the place,
 * the evidence source and the dataset, never an address (decision 7). A subject label that is itself an address is
 * refused rather than recorded.
 */

/* ---------- Services and policies ---------- */

export const ADMISSION_SERVICES = ['federation_handshake', 'hub_directory', 'release_channel', 'registry_pull', 'support', 'hosted_service'] as const;
export const AdmissionServiceSchema = z.enum(ADMISSION_SERVICES);
export type AdmissionService = z.infer<typeof AdmissionServiceSchema>;

export const ADMISSION_EVIDENCE_KINDS = ['declared', 'attested', 'observed'] as const;
export type AdmissionEvidenceKind = (typeof ADMISSION_EVIDENCE_KINDS)[number];

/** Which evidence each service requires. Fixed in code: a caller chooses the service, never the policy. */
export interface AdmissionPolicy {
  readonly requires: readonly AdmissionEvidenceKind[];
}
function freezePolicy(requires: AdmissionEvidenceKind[]): AdmissionPolicy {
  return Object.freeze({ requires: Object.freeze([...requires]) });
}
export const ADMISSION_POLICIES: Readonly<Record<AdmissionService, AdmissionPolicy>> = Object.freeze({
  /** A peer node at handshake (FED-001): its signed manifest, its attestation and the address it connects from. */
  federation_handshake: freezePolicy(['declared', 'attested', 'observed']),
  /** A node asking to be listed or refreshing its listing in the public hub directory: the same evidence as a peer. */
  hub_directory: freezePolicy(['declared', 'attested', 'observed']),
  /** A download from the official update and release channel where we front it: the downloader's observed place. */
  release_channel: freezePolicy(['observed']),
  /** A container image pull from a registry we front: the puller's observed place. */
  registry_pull: freezePolicy(['observed']),
  /** A support request through a channel we run: the observed place; a stated place is judged when given. */
  support: freezePolicy(['observed']),
  /** A service Contribuda hosts: its own jurisdiction gate (SANC-001) at the door, plus this check where it admits. */
  hosted_service: freezePolicy(['observed']),
});

/* ---------- Inputs ---------- */

const PlaceCodeInput = z.string().trim().toUpperCase().pipe(RestrictedPlaceCodeSchema);
/** A hub territory as the manifest writes it (`US`, `US-TX`, `US-TX:austin`); the place is the part before `:`. */
const TerritoryInput = z
  .string()
  .trim()
  .min(2)
  .max(120)
  .transform((value) => value.split(':', 1)[0]?.toUpperCase() ?? '')
  .pipe(RestrictedPlaceCodeSchema);

/**
 * The part of a node manifest this check reads (docs/engine/federation.md, "Node identity"). FED-001 owns the full,
 * signed manifest; it passes the parsed manifest after verifying the signature, and other fields are ignored.
 */
export const AdmissionManifestSchema = z.looseObject({
  node: z.string().trim().min(1).max(253),
  jurisdiction: PlaceCodeInput,
  operator: z.looseObject({ country: PlaceCodeInput }),
  hubs: z.array(z.looseObject({ territories: z.array(TerritoryInput).max(500) })).max(200),
});
export type AdmissionManifest = z.input<typeof AdmissionManifestSchema>;

/**
 * The part of a deployment-location attestation this check reads: a structural subset of
 * `DeploymentLocationAttestationSummary` (SANC-009, `packages/contracts/src/sanctions-attestation.ts`), so the summary
 * a peer publishes is passed as it is. Other fields are ignored; `basis` must stay `operator_statement`.
 */
export const AdmissionAttestationSchema = z
  .looseObject({
    operatorEntityCountry: AttestedCountryCodeSchema,
    operatorEntityRegion: AttestedRegionCodeSchema.nullable(),
    hostingCountry: AttestedCountryCodeSchema,
    hostingRegion: AttestedRegionCodeSchema.nullable(),
    expiresAt: z.iso.datetime({ offset: true }),
    basis: z.literal('operator_statement'),
  })
  .refine(
    (a) => (a.operatorEntityRegion === null || a.operatorEntityRegion.slice(0, 2) === a.operatorEntityCountry) && (a.hostingRegion === null || a.hostingRegion.slice(0, 2) === a.hostingCountry),
    { message: 'a region is an ISO 3166-2 code of the stated country' },
  );
export type AdmissionAttestation = z.input<typeof AdmissionAttestationSchema>;

export interface AdmissionRequest {
  readonly service: AdmissionService;
  /**
   * Who is being judged, for review: a node name (`build.example.org`), a support case reference, or null for an
   * anonymous download. Never an address: an address here refuses the request (`subject_is_address`).
   */
  readonly subject: string | null;
  readonly manifest?: AdmissionManifest | null;
  /** Places the other party stated about itself outside a manifest (for example the country on a support form). */
  readonly declaredPlaces?: readonly string[] | null;
  readonly attestation?: AdmissionAttestation | null;
  /** The connection as our door sees it: the client address after our trusted-proxy rules, and header access. */
  readonly observed?: GateRequest | null;
}

export interface AdmissionContext {
  /** The authoritative restricted list (`restrictedPlaces(...)` from the contracts package). */
  readonly restricted: RestrictedPlaces;
  /** The geolocation port of our receiving service (SANC-001). */
  readonly geolocation: JurisdictionGate;
  readonly now: Date;
}

/* ---------- Results ---------- */

export const ADMISSION_EVIDENCE_SOURCES = [
  'manifest_jurisdiction',
  'manifest_operator_country',
  'manifest_territory',
  'declared_place',
  'attested_operator_entity',
  'attested_hosting',
  'observed_location',
] as const;
export const AdmissionEvidenceSourceSchema = z.enum(ADMISSION_EVIDENCE_SOURCES);
export type AdmissionEvidenceSource = z.infer<typeof AdmissionEvidenceSourceSchema>;

export const ADMISSION_REFUSAL_REASONS = [
  /** Evidence places the party in a restricted place. */
  'restricted_place',
  /** A location in a country restricted only by region (Ukraine) was attested without its region. */
  'region_required',
  /** The service requires this kind of evidence and none was presented. */
  'evidence_missing',
  /** The manifest, a stated place or the attestation could not be read. */
  'evidence_invalid',
  /** The attestation has expired. */
  'attestation_expired',
  /** The service requires an observed place and our geolocation port is not configured. */
  'geolocation_unconfigured',
  /** The subject label is a network address, which is never recorded. */
  'subject_is_address',
] as const;
export const AdmissionRefusalReasonSchema = z.enum(ADMISSION_REFUSAL_REASONS);
export type AdmissionRefusalReason = z.infer<typeof AdmissionRefusalReasonSchema>;

/** Datasets that answer for declared and attested evidence; observed evidence names the geolocation dataset. */
export const DECLARED_DATASET = 'declared';
export const ATTESTED_DATASET = 'attestation';

/** One finding: the place (or null when the finding is about missing or unreadable evidence), source and dataset. */
export const AdmissionFindingSchema = z.strictObject({
  reason: AdmissionRefusalReasonSchema,
  kind: z.enum(ADMISSION_EVIDENCE_KINDS).nullable(),
  source: AdmissionEvidenceSourceSchema.nullable(),
  place: RestrictedPlaceCodeSchema.nullable(),
  dataset: GeoDatasetSchema.nullable(),
});
export type AdmissionFinding = z.infer<typeof AdmissionFindingSchema>;

/** The subject label as recorded: a node name, a case reference or null. Never an address. */
const SubjectLabelSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .refine((value) => parseAddress(value) === null, { message: 'a subject is never a network address' });

/**
 * What is stored or reviewed when we refuse: service, subject label, time, findings and the datasets consulted. The
 * schema is strict, so a record with an extra field (an address, a header dump) does not parse.
 */
export const AdmissionRefusalRecordSchema = z.strictObject({
  service: AdmissionServiceSchema,
  subject: SubjectLabelSchema.nullable(),
  decidedAt: z.iso.datetime({ offset: true }),
  findings: z.array(AdmissionFindingSchema).min(1),
  /** The geolocation mode and dataset that answered the observed place, when one was asked. */
  geolocation: z.strictObject({ mode: z.string().regex(/^[a-z_]{1,30}$/), dataset: GeoDatasetSchema.nullable() }).nullable(),
});
export type AdmissionRefusalRecord = z.infer<typeof AdmissionRefusalRecordSchema>;

export type AdmissionDecision =
  | { readonly outcome: 'admitted'; readonly service: AdmissionService; readonly decidedAt: string; readonly judged: readonly AdmissionEvidenceKind[] }
  | { readonly outcome: 'refused'; readonly service: AdmissionService; readonly decidedAt: string; readonly record: AdmissionRefusalRecord };

/* ---------- The check ---------- */

function judgeDeclared(request: AdmissionRequest, restricted: RestrictedPlaces, findings: AdmissionFinding[]): boolean {
  let presented = false;
  const restrictedFinding = (source: AdmissionEvidenceSource, code: string) => {
    const place = coveringRestrictedPlace(code, restricted);
    if (place) findings.push({ reason: 'restricted_place', kind: 'declared', source, place, dataset: DECLARED_DATASET });
  };
  if (request.manifest !== undefined && request.manifest !== null) {
    presented = true;
    const parsed = AdmissionManifestSchema.safeParse(request.manifest);
    if (!parsed.success) {
      findings.push({ reason: 'evidence_invalid', kind: 'declared', source: null, place: null, dataset: DECLARED_DATASET });
    } else {
      restrictedFinding('manifest_jurisdiction', parsed.data.jurisdiction);
      restrictedFinding('manifest_operator_country', parsed.data.operator.country);
      const seen = new Set<string>();
      for (const hub of parsed.data.hubs) {
        for (const territory of hub.territories) {
          if (seen.has(territory)) continue;
          seen.add(territory);
          restrictedFinding('manifest_territory', territory);
        }
      }
    }
  }
  if (request.declaredPlaces !== undefined && request.declaredPlaces !== null) {
    presented = true;
    for (const raw of request.declaredPlaces) {
      const parsed = PlaceCodeInput.safeParse(raw);
      if (!parsed.success) findings.push({ reason: 'evidence_invalid', kind: 'declared', source: 'declared_place', place: null, dataset: DECLARED_DATASET });
      else restrictedFinding('declared_place', parsed.data);
    }
  }
  return presented;
}

function judgeAttested(request: AdmissionRequest, context: AdmissionContext, findings: AdmissionFinding[]): boolean {
  if (request.attestation === undefined || request.attestation === null) return false;
  const parsed = AdmissionAttestationSchema.safeParse(request.attestation);
  if (!parsed.success) {
    findings.push({ reason: 'evidence_invalid', kind: 'attested', source: null, place: null, dataset: ATTESTED_DATASET });
    return true;
  }
  const a = parsed.data;
  // The same refusals the attestation itself is refused for (SANC-009), from the injected list.
  const sourceOf: Record<AttestationField, AdmissionEvidenceSource> = {
    operator_entity_country: 'attested_operator_entity',
    operator_entity_region: 'attested_operator_entity',
    hosting_country: 'attested_hosting',
    hosting_region: 'attested_hosting',
  };
  const seen = new Set<string>();
  for (const refusal of deploymentLocationRefusals(a, context.restricted)) {
    const source = sourceOf[refusal.field];
    const place = refusal.reason === 'restricted' ? coveringRestrictedPlace(refusal.place, context.restricted) : null;
    const key = `${source}|${refusal.reason}|${place ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ reason: refusal.reason === 'restricted' ? 'restricted_place' : 'region_required', kind: 'attested', source, place, dataset: ATTESTED_DATASET });
  }
  const now = context.now.getTime();
  if (!Number.isFinite(now) || now >= Date.parse(a.expiresAt)) {
    findings.push({ reason: 'attestation_expired', kind: 'attested', source: null, place: null, dataset: ATTESTED_DATASET });
  }
  return true;
}

function judgeObserved(request: AdmissionRequest, context: AdmissionContext, findings: AdmissionFinding[]): boolean {
  if (request.observed === undefined || request.observed === null) return false;
  if (context.geolocation.mode === 'unconfigured') {
    findings.push({ reason: 'geolocation_unconfigured', kind: 'observed', source: 'observed_location', place: null, dataset: null });
    return true;
  }
  const sighting = context.geolocation.decide(request.observed);
  if (sighting) {
    const place = coveringRestrictedPlace(sighting.place, context.restricted);
    const dataset = GeoDatasetSchema.safeParse(sighting.dataset).success ? sighting.dataset : null;
    findings.push({ reason: 'restricted_place', kind: 'observed', source: 'observed_location', place: place ?? null, dataset });
  }
  return true;
}

/**
 * Decide whether the other party may use one of our services. Pure and synchronous: it reads only its arguments, keeps
 * no state between calls and makes no network call (the geolocation port answers from a local dataset or a header).
 */
export function checkAdmission(request: AdmissionRequest, context: AdmissionContext): AdmissionDecision {
  const service = AdmissionServiceSchema.parse(request.service);
  const policy = ADMISSION_POLICIES[service];
  const decidedAt = context.now.toISOString();
  const findings: AdmissionFinding[] = [];

  let subject: string | null = null;
  if (request.subject !== null && request.subject !== undefined) {
    const parsed = SubjectLabelSchema.safeParse(request.subject);
    if (parsed.success) subject = parsed.data;
    else findings.push({ reason: parsed.error.issues.some((i) => i.code === 'custom') ? 'subject_is_address' : 'evidence_invalid', kind: null, source: null, place: null, dataset: null });
  }

  const presented: Record<AdmissionEvidenceKind, boolean> = {
    declared: judgeDeclared(request, context.restricted, findings),
    attested: judgeAttested(request, context, findings),
    observed: judgeObserved(request, context, findings),
  };
  for (const kind of policy.requires) {
    if (!presented[kind]) findings.push({ reason: 'evidence_missing', kind, source: null, place: null, dataset: null });
  }

  if (findings.length === 0) {
    return { outcome: 'admitted', service, decidedAt, judged: ADMISSION_EVIDENCE_KINDS.filter((kind) => presented[kind]) };
  }
  const described = presented.observed ? context.geolocation.describe() : null;
  const record = AdmissionRefusalRecordSchema.parse({
    service,
    subject,
    decidedAt,
    findings,
    geolocation: described ? { mode: described.mode, dataset: described.dataset } : null,
  });
  return { outcome: 'refused', service, decidedAt, record };
}

/**
 * The call FED-001 makes at handshake, after it has verified the peer manifest's signature and before any peering
 * record is written: the peer's manifest, the attestation summary it publishes, and the connection as our door sees it.
 * A refusal is final for that handshake; FED-001 answers HTTP 451 (RFC 7725) with the error code
 * `federation.peer_restricted`, writes no peering record, and stores the refusal record, never the address. FED-001
 * runs the check again whenever the peer's manifest or attestation changes and on every later request it admits.
 */
export function admitPeerAtHandshake(
  peer: { readonly manifest: AdmissionManifest; readonly attestation: AdmissionAttestation | DeploymentLocationAttestationSummary | null; readonly observed: GateRequest | null },
  context: AdmissionContext,
): AdmissionDecision {
  const node = typeof peer.manifest?.node === 'string' ? peer.manifest.node : null;
  return checkAdmission({ service: 'federation_handshake', subject: node, manifest: peer.manifest, attestation: peer.attestation, observed: peer.observed }, context);
}

/** The error code a receiving service answers with when a peer is refused at handshake. */
export const FEDERATION_PEER_RESTRICTED = 'federation.peer_restricted';

/**
 * The structured log event for a refusal (`admission.refused`): service, reasons, places, sources and datasets. No
 * subject, no address and no header: the record holds the subject for review, the log only counts.
 */
export function admissionLogEvent(decision: AdmissionDecision): Readonly<Record<string, unknown>> | null {
  if (decision.outcome !== 'refused') return null;
  const { findings } = decision.record;
  const unique = <T>(values: readonly (T | null)[]): T[] => [...new Set(values.filter((v): v is T => v !== null))].sort() as T[];
  return {
    event: 'admission.refused',
    service: decision.service,
    reasons: unique(findings.map((f) => f.reason)),
    places: unique(findings.map((f) => f.place)),
    sources: unique(findings.map((f) => f.source)),
    datasets: unique(findings.map((f) => f.dataset)),
    at: decision.decidedAt,
  };
}
