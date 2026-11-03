import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withMaintenance } from '@trustwork/data';
import { SKIP_REASON, startHarness, type Response } from '../../../backend/helpers/app.js';
import { buildSupportWorld, query } from '../../../support/helpers.js';

const h = await startHarness('sanc006_card');
const S = '/v1/admin/support';

/**
 * Console design section 4.1 and the package's fourth criterion, on real PostgreSQL through the API with real elevated
 * sessions: staff without the screening role see neither the status nor its absence. No hub legal setting for the
 * restricted-servicing notice exists yet, so the notice is shown to nobody.
 */
test('SANC-006 card: other staff see neither the status nor its absence', { skip: h ? false : SKIP_REASON, timeout: 120_000 }, async (t) => {
  if (!h) return;
  const w = await buildSupportWorld(h);
  t.after(async () => { await w.close(); await h.close(); });
  const c = w.clients; const p = w.people;
  await w.elevateAll();
  const opened = await c.customer.post('/v1/support/cases', { hubId: w.world.hubId, category: 'account_access', summary: 'Synthetic: I cannot reach my account' });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const caseId = (opened.body as { case: { id: string } }).case.id;
  const card = async () => {
    const response = await query(c.agent, `${S}/cases/${caseId}/people/${p.customer}/account`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return (response.body as { account: Record<string, unknown> }).account;
  };
  const before = await card();
  await withMaintenance(h.db.admin, async (trx) => {
    await trx.insertInto('jurisdiction_hold').values({ person_id: p.customer, place: 'CU', source: 'geolocation', dataset: 'synthetic-fake' }).execute();
    await trx.insertInto('screening_subject_state').values({ subject_person_id: p.customer, names_digest: 'a'.repeat(64), last_outcome: 'possible_match', money_held: true }).execute();
  });

  await t.test('the support account card is the same with an open hold and a held state, and carries no compliance word', async () => {
    const after = await card();
    assert.deepEqual(after, before);
    assert.doesNotMatch(Object.keys(after).join(' '), /screen|sanction|hold|complian|restrict|jurisdiction|money/i);
  });

  await t.test('support, moderator and auditor get one answer whether the subject has a state, has none or does not exist', async () => {
    const answer = (r: Response) => { const rest = { ...(r.body as Record<string, unknown>) }; delete rest.requestId; return { status: r.status, rest }; };
    for (const key of ['agent', 'lead', 'moderator', 'auditor'] as const) {
      const lookup = (id: string) => c[key].get(`/v1/admin/screening/subjects/lookup/person/${id}`);
      const screened = answer(await lookup(p.customer));
      assert.ok(screened.status === 403 || screened.status === 404, `${key}: ${JSON.stringify(screened)}`);
      assert.deepEqual(answer(await lookup(p.outsider)), screened, key);
      assert.deepEqual(answer(await lookup(randomUUID())), screened, key);
    }
  });

  await t.test('holds and the queue stay closed to them', async () => {
    for (const key of ['agent', 'lead', 'moderator'] as const) {
      for (const route of ['/v1/admin/jurisdiction/holds', '/v1/admin/screening/queue']) {
        const response = await c[key].get(route);
        const items = (response.body as { items?: unknown[] }).items;
        assert.ok(response.status >= 400 || items?.length === 0, `${key} ${route}: ${JSON.stringify(response.body)}`);
      }
    }
  });
});
