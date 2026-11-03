import test from 'node:test';
import assert from 'node:assert/strict';
import type { OwnerRfqView } from '../../packages/contracts/src/commerce.js';
import type { SellerQuoteView } from '../../packages/contracts/src/deals.js';
import { activatePolicy, buildAgentWorld } from '../agent-modules/helpers.js';
import { negotiationPolicy } from '../agent-modules/fixtures.js';
import { buildWorld, envelope, ok, ownDraft, PERSON, quotePayload } from '../assistant-goals/helpers.js';
import { SKIP_REASON, startHarness, type Client, type Response } from '../backend/helpers/app.js';
import { rfqPayload } from './helpers.js';

/**
 * ADR 027 decision 7 through the envelope route on the real database: `agents_deliver_envelope` is owner-run and reads past
 * row-level security, and it refuses a note naming a competing seller's price. During the seal that refusal would confirm a
 * guessed sealed amount, so the buyer's agent gets the same answer whether or not its note holds one. After the deadline
 * the bid is open, the buyer may read the amount, and the rule against repeating it to a competitor applies again.
 */
const h = await startHarness('sourcing_sealed_oracle');

test('a sealed price cannot be confirmed through an envelope note', { skip: h ? false : SKIP_REASON, timeout: 120_000 }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const agentWorld = await buildAgentWorld(h);
  await activatePolicy(h, agentWorld, negotiationPolicy(agentWorld.hubId));
  const w = await buildWorld(h);
  const { petr, boris, carl } = w.clients;
  const deadline = new Date(Date.now() + 12_000).toISOString();

  let rfq = ok<OwnerRfqView>(await petr.post('/v1/rfqs', { owner: w.petrParty, projectId: null, payload: rfqPayload({ sealed: true, deadline }), category: 'landscaping', publicProjection: { enabled: false, fields: [] }, privateConstraint: null, source: null, actor: PERSON }), 201);
  rfq = ok<OwnerRfqView>(await petr.post(`/v1/rfqs/${rfq.rfq.id}/publish`, { rfqId: rfq.rfq.id, version: 1, expectedRevision: rfq.rfq.revision, amendmentReason: null, actor: PERSON }));
  for (const party of [w.supplier, w.carlParty]) ok(await petr.post(`/v1/rfqs/${rfq.rfq.id}/invitations`, { rfqId: rfq.rfq.id, rfqVersionId: rfq.rfq.currentVersionId, party, channel: 'platform', actor: PERSON }), 201);
  const bid = async (client: Client, seller: { kind: 'person' | 'company'; id: string }, unitPrice: string, laying: string) => {
    const created = ok<SellerQuoteView>(await client.post('/v1/quotes', { rfqId: rfq.rfq.id, rfqVersionId: rfq.rfq.currentVersionId, seller, payload: quotePayload(unitPrice, laying), privateConstraint: null, actor: PERSON }), 201);
    ok<SellerQuoteView>(await client.post(`/v1/quotes/${created.quote.id}/send`, { quoteId: created.quote.id, version: 1, expectedRevision: created.quote.revision, actor: PERSON }));
  };
  await bid(boris, w.supplier, '3000', '50000');
  await bid(carl, w.carlParty, '3177', '61311');

  const mandateId = ok<{ id: string }>(await petr.post('/v1/assistant/mandates', ownDraft(rfq.rfq.id, ['negotiate', 'communicate'])), 201).id;
  const clarify = (text: string): Promise<Response> => petr.post('/v1/assistant/envelopes', envelope({ actingAs: { kind: 'own_agent', mandateId }, to: w.supplier, context: { kind: 'rfq', id: rfq.rfq.id }, intent: 'clarify', note: { text, locale: 'en' } }));
  const answer = (r: Response) => [r.status, (r.body as { status?: string }).status ?? (r.body as { code?: string }).code];
  const SEALED = 'Another bidder offers 31.77 per square metre';
  const GUESS = 'Another bidder offers 27.19 per square metre';

  await t.test('during the seal: the same answer whether the note holds a sealed amount or a wrong guess', async () => {
    const [hit, miss] = [await clarify(SEALED), await clarify(GUESS)];
    assert.deepEqual(answer(hit), answer(miss), JSON.stringify([hit.body, miss.body]));
    assert.deepEqual(answer(hit), [200, 'delivered']);
  });

  await t.test('after the deadline: the bid is open, and repeating it to a competitor is refused as ever', async () => {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(deadline) - Date.now()) + 200));
    const [hit, miss] = [await clarify(SEALED), await clarify(GUESS)];
    assert.deepEqual([hit.status, (hit.body as { details?: { reason?: string } }).details?.reason], [403, 'competitor_pricing'], JSON.stringify(hit.body));
    assert.deepEqual(answer(miss), [200, 'delivered']);
  });
});
