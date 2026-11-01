import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Harness } from '../backend/helpers/app.js';
import type { privacyWorld } from './helpers.js';
import { caseGrants, supportCases } from '../../packages/data/src/repositories/admin.js';
import { importBatches, sources } from '../../packages/data/src/repositories/sources.js';
import { sourceInput, item } from '../sources/helpers.js';

/** A synthetic unclaimed source record, with real two-person grants and a recorded human verification note. */
export async function privacySourceFixture(h: Harness, world: Awaited<ReturnType<typeof privacyWorld>>) {
  const ctx = await world.context(world.people.officer); const reviewCtx = await world.context(world.people.reviewer);
  const hubId = (await h.db.admin.query<{ id: string }>('SELECT id FROM trustwork.hub ORDER BY id LIMIT 1')).rows[0]!.id;
  let source = await world.as(world.people.officer, (trx) => sources.register(trx, ctx, hubId, sourceInput(world.people.officer)));
  source = await world.as(world.people.reviewer, (trx) => sources.setStatus(trx, reviewCtx, source.id, source.revision, 'active'));
  const recordId = randomUUID();
  const field = { recordKind: 'company', recordId, field: 'contact', value: 'Synthetic sourced subject value', itemExternalId: null };
  const batch = await world.as(world.people.officer, (trx) => importBatches.stage(trx, ctx, source.id, { items: [item(randomUUID())], fields: [field], links: [] }));
  await world.as(world.people.reviewer, (trx) => importBatches.decide(trx, reviewCtx, batch.id, batch.revision, 'activate'));
  const fieldId = (await h.db.admin.query<{ id: string }>('SELECT id FROM trustwork.sourced_record_field WHERE import_batch_id=$1', [batch.id])).rows[0]!.id;
  const support = await world.as(world.people.officer, (trx) => supportCases.open(trx, ctx, { hubId, requesterPersonId: world.people.subject,
    subject: { kind: 'person', id: world.people.subject }, category: 'privacy', summary: 'Synthetic nonparticipant record verification' }));
  const note = await world.as(world.people.officer, (trx) => supportCases.addNote(trx, ctx, support.id, 'Synthetic signed statement reviewed for this exact sourced record; no identity documents retained.', 'internal'));
  let grant = await world.as(world.people.officer, (trx) => caseGrants.request(trx, ctx, { supportCaseId: support.id, objectType: 'sourced_record_field', objectIds: [fieldId],
    projectionClass: 'support_private_limited', purpose: 'Synthetic record identity tie', expiresInSeconds: 3600 }));
  grant = await world.as(world.people.reviewer, (trx) => caseGrants.decide(trx, reviewCtx, grant.id, 'approve', grant.request_digest));
  const proof = randomBytes(32).toString('hex');
  return { ctx, reviewCtx, source, field, fieldId, grant, proof, body: { sourceFieldId: fieldId, grantId: grant.id,
    action: 'objection' as const, method: 'signed_statement' as const, evidenceRef: note.id, tokenHash: createHash('sha256').update(proof).digest('hex') } };
}
