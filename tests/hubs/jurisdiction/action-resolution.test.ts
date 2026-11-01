import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { withMaintenance } from '@trustwork/data';
import { CONTEXT_KINDS_V2, MANDATE_ACTIONS_V2 } from '../../../packages/contracts/src/agent-catalog.js';
import { jurisdictionAuthority, jurisdictionEvidence } from '../../../packages/data/src/repositories/jurisdiction-policy.js';
import { prepareJurisdictionIntent } from '../../../apps/api/src/modules/hubs/jurisdiction/intent-adapter.js';
import { provisionTestDatabase } from '../../data/helpers/postgres.js';
import { rejects } from '../helpers.js';
import { authorityFixture, createQuote, sourceDocument } from './authority-fixture.js';

const db = await provisionTestDatabase('jurisdiction_action_resolution', { weight: 2 });
test('owning action resolution refuses unsupported actions and contexts despite complete synthetic policy', { skip: db ? false : 'PostgreSQL unavailable' }, async t => {
  if (!db) return;
  t.after(() => db.close());
  await db.migrate();
  await db.createAppLogin();
  const f = await authorityFixture(db.admin, db.app);
  const { a, p } = f;
  const deal = await createQuote(a.as, p.outsider, p.moderator);
  await f.attest('person', p.outsider);
  await f.attest('person', p.moderator);
  await f.attest('project', deal.projectId);

  // Every verb has an explicit synthetic rule: refusal must come from missing owning resolution,
  // not an accidentally absent rule. This maintenance fixture is not an operational source producer.
  const document = sourceDocument('US', 'synthetic-all-actions');
  document.policy.consentRequirements = [];
  document.policy.actionLimits = MANDATE_ACTIONS_V2.map(action => ({ action, approval: 'pre_authorized', approvalAbove: null }));
  const source = await withMaintenance(db.admin, trx => jurisdictionEvidence.importSource(trx, document));
  const setting = f.payload.agentSettings.jurisdictions[0]!;
  Object.assign(setting, { sourceId: source.id, sourceRevision: source.revision, sourceDigest: source.digest, policy: document.policy });
  await f.activate(await f.draft());

  await t.test('known seller and exact quote resolve; buyer, hub staff and foreign staff cannot borrow that authority', async () => {
    const limits = await a.as(p.moderator, trx => jurisdictionAuthority.limits(trx, deal.quoteId, 'send_quote'));
    assert.equal(limits.status, 'resolved');
    assert.equal(limits.hubId, f.hubId);
    assert.equal(limits.consentSatisfied, true);
    assert.ok(limits.bindingDigest);
    for (const actor of [p.outsider, p.owner, p.officer, p.otherOwner]) {
      await rejects(a.as(actor, trx => jurisdictionAuthority.limits(trx, deal.quoteId, 'send_quote')), '42501');
    }
  });

  for (const action of MANDATE_ACTIONS_V2.filter(action => action !== 'send_quote')) {
    await t.test(`${action}: ${['negotiate', 'place_order'].includes(action) ? 'a seller quote does not grant buyer action authority' : 'a real quote and an explicit rule do not supply an owning resolver'}`, async () => {
      await rejects(a.as(p.moderator, trx => jurisdictionAuthority.limits(trx, deal.quoteId, action)), '42501');
      // Even the internal resolver, invoked here only by maintenance, must not reinterpret the verb.
      const result = await withMaintenance(db.admin, async trx => {
        const { rows } = await sql<{ result: { status: string; bindingDigest: string | null; reasons: string[] } }>`
          SELECT trustwork.jurisdiction_resolve_quote(${deal.quoteId}::uuid, ${action}, ${p.moderator}::uuid) AS result
        `.execute(trx);
        return rows[0]!.result;
      });
      assert.equal(result.status, 'unknown');
      assert.equal(result.bindingDigest, null);
      assert.deepEqual(result.reasons, ['jurisdiction_unavailable']);
    });
  }

  for (const kind of CONTEXT_KINDS_V2.filter(kind => kind !== 'quote')) {
    await t.test(`${kind}: even an existing quote UUID cannot be reinterpreted as the context`, async () => {
      await assert.rejects(a.as(p.moderator, trx => prepareJurisdictionIntent(trx, {
        personId: p.moderator, mandateId: randomUUID(), moduleKeys: ['deal_desk'], action: 'send_quote',
        context: { kind, id: deal.quoteId }, amount: null, projectId: null, at: new Date(),
      }, { hubId: f.otherHubId, forbiddenPreAuthorization: [], isRestricted: () => false })), { message: 'jurisdiction.applicability_unknown' });
    });
  }

  await t.test('unknown quote and raw internal resolver are unavailable to the runtime; no intent or attempt was created', async () => {
    await rejects(a.as(p.moderator, trx => jurisdictionAuthority.limits(trx, randomUUID(), 'send_quote')), '42501');
    await rejects(a.as(p.moderator, trx => sql`SELECT trustwork.jurisdiction_resolve_quote(${deal.quoteId}::uuid, 'send_quote', ${p.moderator}::uuid)`.execute(trx)), '42501');
    const counts = await db.admin.query('SELECT (SELECT count(*)::int FROM trustwork.action_intent) intents, (SELECT count(*)::int FROM trustwork.action_attempt) attempts, (SELECT count(*)::int FROM trustwork.jurisdiction_intent_binding) bindings');
    assert.deepEqual(counts.rows, [{ intents: 0, attempts: 0, bindings: 0 }]);
  });
});
