import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { sql } from 'kysely';
import { AUTOMATION_DOMAINS, type HubModes } from '../../../packages/contracts/src/hub.js';
import { hubConfig } from '../../../packages/data/src/repositories/hubs.js';
import { withMaintenance, type DataPool } from '@trustwork/data';
import { JurisdictionProofPayloadSchema, JURISDICTION_ISSUER_PERMISSIONS, type JurisdictionIssuer, type JurisdictionProofPayload } from '../../../packages/contracts/src/jurisdiction.js';
import { staffAssignments, staffRoleDefinitions } from '../../../packages/data/src/repositories/admin.js';
import { importJurisdictionProof, jurisdictionIssuers, jurisdictionProofDigest, SYNTHETIC_JURISDICTION_VERIFIER } from '../../../packages/data/src/repositories/jurisdiction-source.js';
import { jurisdictionApplicabilityReview } from '../../../packages/data/src/repositories/jurisdiction-policy.js';
import type { actors, HubWorld } from '../helpers.js';

type World = { a: ReturnType<typeof actors>; p: HubWorld['people']; world: HubWorld; hubId: string };
/** Generated test keys never leave this synthetic fixture; all proofs use the real pinned importer. */
export async function syntheticSourceAuthority(admin: DataPool, f: World) {
  const mode = await admin.query("SELECT 1 FROM trustwork.hub_config_current WHERE hub_id=$1 AND domain='modes'", [f.hubId]);
  if (!mode.rowCount) {
    const modes: HubModes = { dataMode: 'demo', registration: 'closed', modules: [], moderation: 'pre_moderate_all', automation: Object.fromEntries(AUTOMATION_DOMAINS.map(d => [d, 'manual'])) as HubModes['automation'], searchEngineIndexing: false, maintenance: false };
    const draft = await f.a.cmd(f.p.owner, (trx, ctx) => hubConfig.draft(trx, ctx, f.hubId, 'modes', modes));
    await f.a.cmd(f.p.owner, (trx, ctx) => hubConfig.activate(trx, ctx, draft.id, draft.revision, null));
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const version = 81;
  await withMaintenance(admin, async trx => {
    const existing = await trx.selectFrom('staff_role_definition_version').select('id').where('role', '=', 'data-steward').where('version', '=', version).executeTakeFirst();
    if (!existing) await staffRoleDefinitions.release(trx, { version, role: 'data-steward', scopes: ['hub'], permissions: [...JURISDICTION_ISSUER_PERMISSIONS, 'admin.hub.modes.edit'], caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
  });
  for (const personId of [f.p.owner, f.p.officer]) {
    await f.a.cmd(f.p.founder, (trx, ctx) => staffAssignments.assign(trx, ctx, { personId, role: 'data-steward', definitionVersion: version, scope: { kind: 'hub', hubId: f.hubId } }));
  }
  const registration: JurisdictionIssuer = {
    schemaVersion: 2, issuerId: randomUUID(), hubId: f.hubId, ...SYNTHETIC_JURISDICTION_VERIFIER,
    keyId: 'synthetic.localKey', publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), evidenceMode: 'synthetic',
    subjectKinds: ['person', 'company', 'project'], actions: ['send_quote', 'negotiate', 'place_order', 'accept_order'], contextKinds: ['quote', 'agreement'], jurisdictions: ['US', 'GB', 'US-CA'],
    competenceDigest: 'd'.repeat(64), independence: 'required', effectiveFrom: new Date(Date.now() - 1000).toISOString(), effectiveUntil: new Date(Date.now() + 3600_000).toISOString(),
  };
  const proposed = await f.a.cmd(f.p.owner, (trx, ctx) => jurisdictionIssuers.propose(trx, f.world.sessions.owner, ctx, registration));
  await f.a.cmd(f.p.officer, (trx, ctx) => jurisdictionIssuers.activate(trx, f.world.sessions.officer, ctx, proposed.id, proposed.digest));
  const envelope = (payload: JurisdictionProofPayload) => ({ payload, signature: sign(null, Buffer.from(jurisdictionProofDigest(payload), 'hex'), privateKey).toString('base64') });
  const payload = async (kind: 'person' | 'company' | 'project', id: string, quoteId: string, jurisdictions = ['US'], action: JurisdictionProofPayload['action'] = 'send_quote', contextKind: 'quote' | 'agreement' = 'quote') => withMaintenance(admin, async trx => {
    const snapshots = await sql<{ subject: unknown; context: unknown; demo: unknown }>`SELECT trustwork.jurisdiction_context_subject(${kind},${id}::uuid,${contextKind},${quoteId}::uuid) AS subject,trustwork.jurisdiction_owning_context(${contextKind},${quoteId}::uuid,${action}) AS context,trustwork.jurisdiction_demo_authority(${f.hubId}::uuid) AS demo`.execute(trx);
    const recordId = `synthetic.${kind}.${id}.${quoteId}.${action}.${contextKind}`;
    const revisions = await sql<{ revision: number }>`SELECT coalesce(max(record_revision),0)+1 AS revision FROM trustwork.jurisdiction_proof_record WHERE issuer_id=${registration.issuerId}::uuid AND record_id=${recordId}`.execute(trx);
    return JurisdictionProofPayloadSchema.parse({
      schemaVersion: 2, issuerVersionId: proposed.id, issuerDigest: proposed.digest, keyId: registration.keyId,
      audienceHubId: f.hubId, originHubId: f.hubId, evidenceMode: 'synthetic', demoAuthority: snapshots.rows[0]!.demo, recordId, recordRevision: revisions.rows[0]!.revision,
      action, subject: snapshots.rows[0]!.subject, context: snapshots.rows[0]!.context,
      linkage: { kind: 'verified_engine_subject', evidenceDigest: 'e'.repeat(64) },
      coverage: { status: 'complete', jurisdictions, basisDigest: 'b'.repeat(64), competenceDigest: registration.competenceDigest, independenceEvidenceDigest: 'a'.repeat(64) },
      issuedAt: new Date().toISOString(), effectiveFrom: new Date(Date.now() - 1000).toISOString(), effectiveUntil: new Date(Date.now() + 1800_000).toISOString(),
    });
  });
  const stage = (p: JurisdictionProofPayload) => withMaintenance(admin, trx => importJurisdictionProof(trx, envelope(p)));
  const activate = async (e: Awaited<ReturnType<typeof stage>>) => {
    const review = await f.a.cmd(f.p.owner, (trx, ctx) => jurisdictionApplicabilityReview.propose(trx, f.world.sessions.owner, ctx, e.id, e.digest));
    await f.a.cmd(f.p.officer, (trx, ctx) => jurisdictionApplicabilityReview.activate(trx, f.world.sessions.officer, ctx, review.reviewId, e.digest));
    return e;
  };
  return { registration, proposed, payload, envelope, stage, activate, issue: async (kind: 'person' | 'company' | 'project', id: string, quoteId: string, jurisdictions = ['US'], action: JurisdictionProofPayload['action'] = 'send_quote', contextKind: 'quote' | 'agreement' = 'quote') => activate(await stage(await payload(kind, id, quoteId, jurisdictions, action, contextKind))) };
}
