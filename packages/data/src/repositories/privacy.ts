import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { Transaction } from '../pool.js';
import type { LegalHoldRow, PrivacyCountryPolicyTable, PrivacyExportRow, PrivacyPreferenceRow, PrivacyRequestRow, PrivacyResponseDraftRow } from '../schema/privacy.js';
import type { CommandContext } from './admin.js';

/**
 * Structural shape of a validated country pack's privacy facets (`packages/country-packs/src/facets.ts`,
 * `PrivacyFactSchema`). The data package keeps no build-time dependency on the packs package, like the kernel sync.
 */
interface PrivacyPackFactBase { id: string; verification: string; sources: readonly { url: string }[]; effectiveFrom?: string; effectiveTo?: string }
export type PrivacyPackFact =
  | (PrivacyPackFactBase & { type: 'law'; subjectRequestDays?: number })
  | (PrivacyPackFactBase & { type: 'retention'; years: number })
  | (PrivacyPackFactBase & { type: string });
export interface PrivacyPackLike { code: string; enabled: boolean; facets?: { privacy?: readonly PrivacyPackFact[] } | null }

/** One country's policy as derived from its pack, with the reasons it stays `UNKNOWN` and the gaps the pack schema has. */
export interface PrivacyPolicyDerivation {
  country: string; version: string; review: 'UNKNOWN' | 'verified'; sources: string[];
  deadlineDays: number | null; retentionDays: number | null; registryPollHours: null; registryDeadlineDays: null;
  facts: { deadline: string | null; retention: string | null };
  /** Why the policy is not `verified`; empty when it is. Every reason names the fact it concerns where one exists. */
  reasons: string[];
  /** Facts the pack schema cannot express yet; they never make a policy `UNKNOWN` by themselves. */
  gaps: string[];
}
export interface PrivacyPolicySyncReport {
  applied: { country: string; review: 'UNKNOWN' | 'verified'; version: string; changed: boolean }[];
  /** Rows a maintainer wrote by hand (version without the `pack:` prefix); the sync never overwrites them. */
  manual: string[];
}
const PACK_VERSION_PREFIX = 'pack:';
const DAYS_PER_YEAR = 365.25;

function effective(fact: PrivacyPackFactBase, now: Date): boolean {
  const from = fact.effectiveFrom ? Date.parse(`${fact.effectiveFrom}T00:00:00Z`) : null;
  const to = fact.effectiveTo ? Date.parse(`${fact.effectiveTo}T00:00:00Z`) : null;
  return (from === null || from <= now.getTime()) && (to === null || to > now.getTime());
}

/**
 * Country-pack facts are the only source of request deadlines and retention bounds (PRV-001 acceptance). The engine
 * never invents a number: without an `official` law fact carrying `subjectRequestDays` and an `official` retention fact
 * the country stays `UNKNOWN`, with null deadline and retention. Where several facts apply the strictest deadline and
 * the longest retention win, so that no request is answered late and no record is deleted before its longest bound.
 * Facts are read at country level only: a request carries a country code, not a subdivision.
 */
export function privacyPolicyFromPack(pack: PrivacyPackLike, now: Date = new Date()): PrivacyPolicyDerivation {
  const facts = (pack.facets?.privacy ?? []).filter((f) => effective(f, now));
  const deadlines = facts.filter((f): f is PrivacyPackFactBase & { type: 'law'; subjectRequestDays: number } => f.type === 'law' && typeof (f as { subjectRequestDays?: number }).subjectRequestDays === 'number')
    .sort((a, b) => a.subjectRequestDays - b.subjectRequestDays || a.id.localeCompare(b.id));
  const retentions = facts.filter((f): f is PrivacyPackFactBase & { type: 'retention'; years: number } => f.type === 'retention')
    .sort((a, b) => b.years - a.years || a.id.localeCompare(b.id));
  const deadline = deadlines[0] ?? null;
  const retention = retentions[0] ?? null;
  const reasons: string[] = [];
  if (!pack.enabled) reasons.push('pack_disabled');
  if (!deadline) reasons.push('no_subject_request_deadline_fact');
  else if (deadline.verification !== 'official') reasons.push(`deadline_fact_unverified:${deadline.id}:${deadline.verification}`);
  if (!retention) reasons.push('no_retention_fact');
  else if (retention.verification !== 'official') reasons.push(`retention_fact_unverified:${retention.id}:${retention.verification}`);
  const verified = reasons.length === 0;
  const contributing = [deadline, retention].filter((f): f is NonNullable<typeof f> => f !== null);
  const digest = createHash('sha256').update(JSON.stringify(contributing.map((f) => ({ ...f, sources: [...f.sources].map((s) => s.url).sort() })))).digest('hex');
  return {
    country: pack.code.toUpperCase(), version: `${PACK_VERSION_PREFIX}${pack.code.toUpperCase()}:${digest.slice(0, 32)}`, review: verified ? 'verified' : 'UNKNOWN',
    sources: [...new Set(contributing.flatMap((f) => f.sources.map((s) => s.url)))].sort(),
    deadlineDays: verified ? deadline!.subjectRequestDays : null,
    retentionDays: verified ? Math.ceil(retention!.years * DAYS_PER_YEAR) : null,
    registryPollHours: null, registryDeadlineDays: null,
    facts: { deadline: deadline?.id ?? null, retention: retention?.id ?? null },
    reasons,
    // No pack fact type carries a regulator registry's polling cadence or deadline; the DROP intake stays UNKNOWN.
    gaps: ['registry_cadence_not_in_pack_schema', 'retention_per_record_class_not_in_policy'],
  };
}

export const privacyPolicies = {
  fromPacks(packs: readonly PrivacyPackLike[], now: Date = new Date()): PrivacyPolicyDerivation[] {
    return packs.map((p) => privacyPolicyFromPack(p, now)).sort((a, b) => a.country.localeCompare(b.country));
  },
  /** Built-in packs through the packs package, imported by URL like the kernel sync (no build-time dependency). */
  async fromRepository(now: Date = new Date()): Promise<PrivacyPolicyDerivation[]> {
    const packsModule = (await import(new URL('../../../country-packs/src/index.ts', import.meta.url).href)) as { PACKS: readonly PrivacyPackLike[] };
    return privacyPolicies.fromPacks(packsModule.PACKS, now);
  },
  /**
   * Writes the derived policies. Must run inside `withMaintenance`. Serialized against itself by an advisory lock; the
   * row updates serialize with plan snapshots (`FOR SHARE`), so a changed version invalidates approved plans at
   * execution. Rows written by hand are reported and left alone. Idempotent.
   */
  async apply(trx: Transaction, derivations: readonly PrivacyPolicyDerivation[]): Promise<PrivacyPolicySyncReport> {
    await sql`SELECT pg_advisory_xact_lock(hashtext('trustwork.privacy_country_policy'))`.execute(trx);
    const report: PrivacyPolicySyncReport = { applied: [], manual: [] };
    for (const d of derivations) {
      const existing = await trx.selectFrom('privacy_country_policy').selectAll().where('country', '=', d.country).forUpdate().executeTakeFirst();
      if (existing && !existing.version.startsWith(PACK_VERSION_PREFIX)) { report.manual.push(d.country); continue; }
      const row: Omit<PrivacyCountryPolicyTable, 'sources'> & { sources: string } = {
        country: d.country, version: d.version, review: d.review, sources: JSON.stringify(d.sources),
        deadline_days: d.deadlineDays, retention_days: d.retentionDays, registry_poll_hours: d.registryPollHours, registry_deadline_days: d.registryDeadlineDays,
      };
      const changed = !existing || existing.version !== d.version || existing.review !== d.review
        || existing.deadline_days !== d.deadlineDays || existing.retention_days !== d.retentionDays;
      if (!existing) await trx.insertInto('privacy_country_policy').values(row).execute();
      else if (changed) await trx.updateTable('privacy_country_policy').set(row).where('country', '=', d.country).execute();
      report.applied.push({ country: d.country, review: d.review, version: d.version, changed });
    }
    return report;
  },
};

/** The API-level delegation marker of a principal acting through an assistant; the database never sees a mandate otherwise. */
export interface PrivacyDelegation { mandateId: string; mandateRevision: number; principalPersonId: string }

export const privacy = {
  /** Preparation only: a Draft package for a privacy request. The caller may be an assistant acting for a staff member. */
  async prepareResponseDraft(trx: Transaction, requestId: string, coverage: unknown, delegation: PrivacyDelegation | null): Promise<PrivacyResponseDraftRow> {
    return (await sql<PrivacyResponseDraftRow>`SELECT * FROM trustwork.privacy_response_draft_prepare(${requestId}::uuid, ${JSON.stringify(coverage)}::jsonb,
      ${delegation ? JSON.stringify({ mandateId: delegation.mandateId, mandateRevision: delegation.mandateRevision }) : null}::jsonb)`.execute(trx)).rows[0]!;
  },
  async responseDrafts(trx: Transaction, requestId: string): Promise<PrivacyResponseDraftRow[]> {
    return (await sql<PrivacyResponseDraftRow>`SELECT * FROM trustwork.privacy_response_drafts(${requestId}::uuid)`.execute(trx)).rows;
  },
  async proposeSourcePlan(trx: Transaction, ctx: CommandContext, requestId: string, grantId: string): Promise<{ id: string; digest: string; approvalId: string; snapshot: Record<string, unknown> }> {
    return (await sql<{ result: { id: string; digest: string; approvalId: string; snapshot: Record<string, unknown> } }>`SELECT trustwork.privacy_source_plan_propose(${JSON.stringify(ctx)}::jsonb,${requestId}::uuid,${grantId}::uuid) AS result`.execute(trx)).rows[0]!.result;
  },
  async approveSourcePlan(trx: Transaction, ctx: CommandContext, id: string, grantId: string, digest: string) {
    await sql`SELECT trustwork.privacy_source_plan_approve(${JSON.stringify(ctx)}::jsonb,${id}::uuid,${grantId}::uuid,${digest})`.execute(trx);
    return { approved: true };
  },
  async executeSourcePlan(trx: Transaction, ctx: CommandContext, id: string, digest: string): Promise<{ status: 'applied' | 'blocked'; complete: false; reason?: string }> {
    return (await sql<{ result: { status: 'applied' | 'blocked'; complete: false; reason?: string } }>`SELECT trustwork.privacy_source_plan_execute(${JSON.stringify(ctx)}::jsonb,${id}::uuid,${digest}) AS result`.execute(trx)).rows[0]!.result;
  },
  async sourceHold(trx: Transaction, ctx: CommandContext, fieldId: string, grantId: string, reason: string, evidenceRef: string) {
    return (await sql<{ id: string }>`SELECT trustwork.privacy_source_hold_place(${JSON.stringify(ctx)}::jsonb,${fieldId}::uuid,${grantId}::uuid,${reason},${evidenceRef}::uuid) AS id`.execute(trx)).rows[0]!;
  },
  async externalSourceCase(trx: Transaction, ctx: CommandContext, input: { hubId: string; sourceFieldId: string; action: string; proposedValue: string | null; country: string; method: string; evidenceDigest: string }): Promise<{ caseId: string; evidenceRef: string; subjectId: string }> {
    return (await sql<{ result: { caseId: string; evidenceRef: string; subjectId: string } }>`SELECT trustwork.support_open_external_source_case(${JSON.stringify(ctx)}::jsonb,
      ${input.hubId}::uuid, ${input.sourceFieldId}::uuid, ${input.action}, ${input.proposedValue}, ${input.country}, ${input.method}, ${input.evidenceDigest}) AS result`.execute(trx)).rows[0]!.result;
  },
  async proposePlan(trx: Transaction, ctx: CommandContext, requestId: string, grantId: string): Promise<{ id: string; digest: string; approvalId: string; state: 'proposed'; snapshot: Record<string, unknown> }> {
    return (await sql<{ result: { id: string; digest: string; approvalId: string; state: 'proposed'; snapshot: Record<string, unknown> } }>`SELECT trustwork.privacy_plan_propose(${JSON.stringify(ctx)}::jsonb, ${requestId}::uuid, ${grantId}::uuid) AS result`.execute(trx)).rows[0]!.result;
  },
  async approvePlan(trx: Transaction, ctx: CommandContext, id: string, grantId: string, digest: string): Promise<{ id: string; digest: string; state: 'approved'; executable: false }> {
    return (await sql<{ result: { id: string; digest: string; state: 'approved'; executable: false } }>`SELECT trustwork.privacy_plan_approve(${JSON.stringify(ctx)}::jsonb, ${id}::uuid, ${grantId}::uuid, ${digest}) AS result`.execute(trx)).rows[0]!.result;
  },
  async executePlan(trx: Transaction, ctx: CommandContext, id: string, digest: string): Promise<{ status: 'blocked' | 'invalidated'; complete: false; reason: string; gaps: { module: string; action: string; gap: string }[] }> {
    return (await sql<{ result: { status: 'blocked' | 'invalidated'; complete: false; reason: string; gaps: { module: string; action: string; gap: string }[] } }>`SELECT trustwork.privacy_plan_execute(${JSON.stringify(ctx)}::jsonb, ${id}::uuid, ${digest}) AS result`.execute(trx)).rows[0]!.result;
  },
  async sourceProof(trx: Transaction, ctx: CommandContext, input: { sourceFieldId: string; grantId: string; action: string; tokenHash: string; method: string; evidenceRef: string }): Promise<string> {
    return (await sql<{ id: string }>`SELECT trustwork.privacy_source_prove(${JSON.stringify(ctx)}::jsonb, ${input.sourceFieldId}::uuid, ${input.grantId}::uuid,
      ${input.action}, ${input.tokenHash}, ${input.method}, ${input.evidenceRef}::uuid) AS id`.execute(trx)).rows[0]!.id;
  },
  async registryReceive(trx: Transaction, ctx: CommandContext, registrationId: string, items: unknown): Promise<{ status: 'UNKNOWN' | 'not_due' | 'received'; received: number; nextPollAt: string | null }> {
    return (await sql<{ result: { status: 'UNKNOWN' | 'not_due' | 'received'; received: number; nextPollAt: string | null } }>`SELECT trustwork.privacy_registry_receive(${JSON.stringify(ctx)}::jsonb, ${registrationId}::uuid, ${JSON.stringify(items)}::jsonb) AS result`.execute(trx)).rows[0]!.result;
  },
  /** Worker-only; the delivery row must already be locked. Keep this transaction through dispatch. */
  async marketingAllowed(trx: Transaction, digest: string): Promise<boolean> {
    return (await sql<{ allowed: boolean }>`SELECT trustwork.privacy_marketing_allowed(${digest}) AS allowed`.execute(trx)).rows[0]?.allowed === true;
  },
  async authorized(trx: Transaction, kind: 'person' | 'company', id: string): Promise<boolean> {
    const r = await sql<{ allowed: boolean }>`SELECT trustwork.privacy_subject_authorized(${kind}, ${id}::uuid) AS allowed`.execute(trx);
    return r.rows[0]?.allowed === true;
  },
  async request(trx: Transaction, input: unknown): Promise<PrivacyRequestRow> {
    return (await sql<PrivacyRequestRow>`SELECT * FROM trustwork.privacy_request_create(${JSON.stringify(input)}::jsonb)`.execute(trx)).rows[0]!;
  },
  requests(trx: Transaction) { return trx.selectFrom('privacy_request').selectAll().orderBy('created_at').orderBy('id').execute(); },
  async preference(trx: Transaction, input: unknown): Promise<PrivacyPreferenceRow> {
    return (await sql<PrivacyPreferenceRow>`SELECT * FROM trustwork.privacy_preference_set(${JSON.stringify(input)}::jsonb)`.execute(trx)).rows[0]!;
  },
  preferences(trx: Transaction) { return trx.selectFrom('privacy_preference').selectAll().executeTakeFirst(); },
  async createExport(trx: Transaction, kind: 'person' | 'company', id: string, coverage: unknown): Promise<PrivacyExportRow> {
    return (await sql<PrivacyExportRow>`SELECT * FROM trustwork.privacy_export_create(${kind}, ${id}::uuid, ${JSON.stringify(coverage)}::jsonb)`.execute(trx)).rows[0]!;
  },
  export(trx: Transaction, id: string) { return trx.selectFrom('privacy_export').selectAll().where('id', '=', id).executeTakeFirst(); },
  async hold(trx: Transaction, ctx: CommandContext, requestId: string, reasonCode: string, evidenceRef: string): Promise<LegalHoldRow> {
    return (await sql<LegalHoldRow>`SELECT * FROM trustwork.privacy_hold_place(${JSON.stringify(ctx)}::jsonb, ${requestId}::uuid, ${reasonCode}, ${evidenceRef}::uuid)`.execute(trx)).rows[0]!;
  },
  async releaseHold(trx: Transaction, ctx: CommandContext, id: string): Promise<LegalHoldRow> {
    return (await sql<LegalHoldRow>`SELECT * FROM trustwork.privacy_hold_release(${JSON.stringify(ctx)}::jsonb, ${id}::uuid)`.execute(trx)).rows[0]!;
  },
  async erasureCheck(trx: Transaction, ctx: CommandContext, id: string): Promise<{ ready: false; reason: string }> {
    return (await sql<{ result: { ready: false; reason: string } }>`SELECT trustwork.privacy_erasure_check(${JSON.stringify(ctx)}::jsonb, ${id}::uuid) AS result`.execute(trx)).rows[0]!.result;
  },
};
