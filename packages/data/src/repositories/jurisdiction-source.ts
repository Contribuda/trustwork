import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { sql } from 'kysely';
import { computeDigest } from '../../../contracts/src/common/digest.js';
import { JurisdictionIssuerSchema, JurisdictionIssuerReceiptSchema, JurisdictionProofEnvelopeSchema, JurisdictionProofPayloadSchema, type JurisdictionIssuer } from '../../../contracts/src/jurisdiction.js';
import type { Transaction } from '../pool.js';
import type { CommandContext } from './admin.js';
import { jurisdictionEvidence } from './jurisdiction-policy.js';

/** This installed implementation and exact contract must be independently registered; runtime callers cannot replace them. */
export const SYNTHETIC_JURISDICTION_VERIFIER = Object.freeze({
  verifier: 'synthetic-ed25519-v1' as const,
  implementationDigest: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
  contractDigest: computeDigest(z.toJSONSchema(JurisdictionProofPayloadSchema)).value,
});
export function jurisdictionProofDigest(payload: unknown): string {
  return computeDigest({ kind: 'trustwork.synthetic-jurisdiction-proof.v2', payload }).value;
}

export const jurisdictionIssuers = {
  async propose(trx: Transaction, sessionId: string, ctx: CommandContext, registration: JurisdictionIssuer) {
    const doc = JurisdictionIssuerSchema.parse(registration);
    const { rows } = await sql<{ result: unknown }>`SELECT trustwork.jurisdiction_issuer_propose(${sessionId}::uuid,${JSON.stringify(ctx)}::jsonb,${JSON.stringify(doc)}::jsonb) AS result`.execute(trx);
    return JurisdictionIssuerReceiptSchema.parse(rows[0]?.result);
  },
  async activate(trx: Transaction, sessionId: string, ctx: CommandContext, id: string, digest: string) {
    const { rows } = await sql<{ result: unknown }>`SELECT trustwork.jurisdiction_issuer_activate(${sessionId}::uuid,${JSON.stringify(ctx)}::jsonb,${id}::uuid,${digest}) AS result`.execute(trx);
    return JurisdictionIssuerReceiptSchema.parse(rows[0]?.result);
  },
  async revoke(trx: Transaction, sessionId: string, ctx: CommandContext, kind: 'issuer' | 'source', id: string, digest: string) {
    const { rows } = await sql<{ result: unknown }>`SELECT trustwork.jurisdiction_source_revoke(${sessionId}::uuid,${JSON.stringify(ctx)}::jsonb,${kind},${id}::uuid,${digest}) AS result`.execute(trx);
    return JurisdictionIssuerReceiptSchema.parse(rows[0]?.result);
  },
};

/** Maintenance producer only. Neither API nor worker credentials can call this importer successfully.
 * The database owner remains the installation trust root, as for migrations; no runtime verified-result callback exists.
 * All cryptography is local. The only accepted evidence mode is synthetic, never operational legal evidence.
 */
export async function importJurisdictionProof(trx: Transaction, input: unknown) {
  const bytes = JSON.stringify(input);
  if (!bytes || Buffer.byteLength(bytes) > 16384) throw new Error('jurisdiction.proof_unavailable');
  const envelope = JurisdictionProofEnvelopeSchema.parse(input);
  const p = envelope.payload;
  await sql`SELECT trustwork.jurisdiction_lock()`.execute(trx);
  const { rows } = await sql<{ document: unknown; digest: string; issuer_id: string }>`SELECT document,digest,issuer_id FROM trustwork.jurisdiction_issuer_version WHERE id=${p.issuerVersionId}::uuid`.execute(trx);
  const row = rows[0];
  if (!row) throw new Error('jurisdiction.proof_unavailable');
  const issuer = JurisdictionIssuerSchema.parse(row.document);
  if (issuer.verifier !== SYNTHETIC_JURISDICTION_VERIFIER.verifier || issuer.implementationDigest !== SYNTHETIC_JURISDICTION_VERIFIER.implementationDigest || issuer.contractDigest !== SYNTHETIC_JURISDICTION_VERIFIER.contractDigest || row.digest !== p.issuerDigest) throw new Error('jurisdiction.proof_unavailable');
  let authentic = false;
  try {
    const key = createPublicKey(issuer.publicKey);
    authentic = key.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(jurisdictionProofDigest(p), 'hex'), key, Buffer.from(envelope.signature, 'base64'));
  } catch { /* Malformed keys and signatures have the same private refusal. */ }
  if (!authentic) throw new Error('jurisdiction.proof_unavailable');
  const check = await sql<{ ok: boolean }>`SELECT trustwork.jurisdiction_proof_matches(${JSON.stringify(p)}::jsonb) AS ok`.execute(trx);
  if (!check.rows[0]?.ok) throw new Error('jurisdiction.proof_unavailable');
  const digest = computeDigest(p).value;
  const existing = await sql<{ id: string; digest: string; signature: string; evidence_id: string; evidence_digest: string }>`
    SELECT r.id,r.digest,r.signature,o.evidence_id,a.digest AS evidence_digest FROM trustwork.jurisdiction_proof_record r
    JOIN trustwork.jurisdiction_applicability_origin o ON o.source_id=r.id JOIN trustwork.jurisdiction_applicability a ON a.id=o.evidence_id
    WHERE r.issuer_id=${row.issuer_id}::uuid AND r.record_id=${p.recordId} AND r.record_revision=${p.recordRevision}
  `.execute(trx);
  if (existing.rows[0]) {
    const old = existing.rows[0];
    const current = await sql<{ ok: boolean }>`SELECT trustwork.jurisdiction_proof_live(${old.id}::uuid) AS ok`.execute(trx);
    if (old.digest !== digest || old.signature !== envelope.signature || !current.rows[0]?.ok) throw new Error('jurisdiction.proof_unavailable');
    return { id: old.evidence_id, digest: old.evidence_digest, sourceId: old.id, sourceDigest: digest };
  }
  const source = await sql<{ id: string }>`INSERT INTO trustwork.jurisdiction_proof_record(issuer_version_id,issuer_id,record_id,record_revision,document,digest,signature)
    VALUES(${p.issuerVersionId}::uuid,${row.issuer_id}::uuid,${p.recordId},${p.recordRevision},${JSON.stringify(p)}::jsonb,${digest},${envelope.signature}) RETURNING id`.execute(trx);
  const sourceId = source.rows[0]!.id;
  await sql`INSERT INTO trustwork.jurisdiction_proof_current(issuer_id,record_id,source_id,revision)
    VALUES(${row.issuer_id}::uuid,${p.recordId},${sourceId}::uuid,1) ON CONFLICT(issuer_id,record_id) DO UPDATE SET source_id=excluded.source_id`.execute(trx);
  const evidence = await jurisdictionEvidence.stageApplicability(trx, {
    subjectKind: p.subject.kind, subjectId: p.subject.id, hubId: p.originHubId, jurisdictions: p.coverage.jurisdictions,
    evidenceId: 'synthetic.authenticatedApplicability', evidenceDigest: digest, effectiveFrom: p.effectiveFrom, effectiveUntil: p.effectiveUntil,
  });
  await sql`INSERT INTO trustwork.jurisdiction_applicability_origin(evidence_id,source_id) VALUES(${evidence.id}::uuid,${sourceId}::uuid)`.execute(trx);
  // This is an opaque import event, not a participant notification and not a human approval.
  await sql`INSERT INTO trustwork.outbox_event(aggregate_kind,aggregate_id,revision,type,payload)
    VALUES('jurisdiction_source_record',${sourceId},1,'jurisdiction.source_staged',${JSON.stringify({ sourceId })}::jsonb)`.execute(trx);
  await sql`SELECT trustwork.jurisdiction_require_proof_live(${sourceId}::uuid)`.execute(trx);
  return { ...evidence, sourceId, sourceDigest: digest };
}
