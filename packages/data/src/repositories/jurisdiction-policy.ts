import { sql } from 'kysely';
import type { Transaction } from '../pool.js';
import '../schema/jurisdiction-policy.js';
import { JurisdictionApplicabilitySchema, JurisdictionLimitsSchema, JurisdictionSourceSchema, JurisdictionConsentPreviewSchema, JurisdictionConsentReceiptSchema } from '../../../contracts/src/jurisdiction.js';

/** Owner-module maintenance port only. No API/worker/staff role has table writes or source assertion privileges. */
export const jurisdictionEvidence = {
  async importSource(trx: Transaction, input: unknown) {
    const document = JurisdictionSourceSchema.parse(input);
    const row = await trx.insertInto('jurisdiction_source').values({ document: JSON.stringify(document), digest: '0'.repeat(64) }).returning(['id', 'digest']).executeTakeFirstOrThrow();
    const head = await trx.insertInto('jurisdiction_source_current').values({ jurisdiction: document.jurisdiction, source_id: row.id })
      .onConflict((c) => c.column('jurisdiction').doUpdateSet({ source_id: row.id })).returning('revision').executeTakeFirstOrThrow();
    return { ...row, revision: head.revision };
  },
  async attestApplicability(trx: Transaction, input: unknown) {
    const document = JurisdictionApplicabilitySchema.parse(input);
    const row = await trx.insertInto('jurisdiction_applicability').values({ document: JSON.stringify(document), digest: '0'.repeat(64) }).returning(['id', 'digest']).executeTakeFirstOrThrow();
    await trx.insertInto('jurisdiction_applicability_current').values({ subject_kind: document.subjectKind, subject_id: document.subjectId, applicability_id: row.id })
      .onConflict((c) => c.columns(['subject_kind', 'subject_id']).doUpdateSet({ applicability_id: row.id })).execute();
    return row;
  },
};

/** Audience-checked projection only. No raw party geography, source evidence or sensitive hub payload leaves SQL. */
export const jurisdictionAuthority = {
  async preflight(trx: Transaction, versionId: string) {
    const { rows } = await sql<{ result: { status: 'ready' | 'blocked'; versionId: string; payloadDigest: string; problems: string[] } }>`SELECT trustwork.jurisdiction_preflight(${versionId}::uuid) AS result`.execute(trx);
    return rows[0]!.result;
  },
  async limits(trx: Transaction, quoteId: string, action: string) {
    const { rows } = await sql<{ result: unknown }>`SELECT trustwork.jurisdiction_limits(${quoteId}::uuid,${action}) AS result`.execute(trx);
    return JurisdictionLimitsSchema.parse(rows[0]?.result);
  },
  async bind(trx: Transaction, intentId: string, bindingDigest: string): Promise<void> {
    await sql`SELECT trustwork.jurisdiction_bind_intent(${intentId}::uuid,${bindingDigest})`.execute(trx);
  },
  async recheck(trx: Transaction, intentId: string): Promise<boolean> {
    const { rows } = await sql<{ ok: boolean }>`SELECT trustwork.jurisdiction_recheck_intent(${intentId}::uuid) AS ok`.execute(trx);
    return rows[0]?.ok === true;
  },
};

/** Worker-only fenced composition of current jurisdiction authority with the real assistant attempt command. */
export const jurisdictionWorker = {
  async beginAttempt(trx: Transaction, intentId: string, jobId: string, fencingToken: string) {
    const { rows } = await sql<{ result: import('./assistant.js').DispatchTarget }>`SELECT trustwork.jurisdiction_begin_attempt(${intentId}::uuid,${jobId}::uuid,${fencingToken}::bigint) AS result`.execute(trx);
    return rows[0]!.result;
  },
};


/** First-party consent only. Session IDs come from resolved request state, not request input. */
export const jurisdictionConsent = {
  async preview(trx: Transaction, sessionId: string, quoteId: string) {
    const { rows } = await sql<{ result: unknown }>`SELECT trustwork.jurisdiction_consent_preview(${sessionId}::uuid,${quoteId}::uuid) AS result`.execute(trx);
    return JurisdictionConsentPreviewSchema.parse(rows[0]?.result);
  },
  async grant(trx: Transaction, sessionId: string, quoteId: string, noticeDigest: string, locale: string) {
    const { rows } = await sql<{ result: unknown }>`SELECT trustwork.jurisdiction_consent_grant(${sessionId}::uuid,${quoteId}::uuid,${noticeDigest},${locale}) AS result`.execute(trx);
    return JurisdictionConsentReceiptSchema.parse(rows[0]?.result);
  },
  async revoke(trx: Transaction, sessionId: string, receiptId: string) {
    const { rows } = await sql<{ result: unknown }>`SELECT trustwork.jurisdiction_consent_revoke(${sessionId}::uuid,${receiptId}::uuid) AS result`.execute(trx);
    return JurisdictionConsentReceiptSchema.parse(rows[0]?.result);
  },
};
