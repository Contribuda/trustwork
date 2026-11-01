import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { withMaintenance } from '@trustwork/data';
import { computeQuoteVersionDigest, computeAgreementDigest, type QuoteVersionPayload } from '@trustwork/contracts';
import { quotes, quoteVersions, quoteLines, taxDeterminations, amendmentRequests, agreements, acceptanceEvents } from '../../../packages/data/src/repositories/transactions.js';
import { rfqVersions, rfqs } from '../../../packages/data/src/repositories/commerce.js';
import { jurisdictionAuthority, jurisdictionEvidence } from '../../../packages/data/src/repositories/jurisdiction-policy.js';
import { jurisdictionIssuers } from '../../../packages/data/src/repositories/jurisdiction-source.js';
import { evaluateLimits } from '../../../apps/api/src/modules/hubs/jurisdiction/intent-adapter.js';
import { provisionTestDatabase } from '../../data/helpers/postgres.js';
import { authorityFixture, createQuote, sourceDocument } from './authority-fixture.js';
import { syntheticSourceAuthority } from './source-fixture.js';

const db = await provisionTestDatabase('jurisdiction_negotiation', { weight: 2 });
test('buyer quote negotiation resolves its actual sent owner version, never an arbitrary quote action', { skip: !db }, async t => {
  if (!db) return; t.after(() => db.close()); await db.migrate(); await db.createAppLogin();
  const f = await authorityFixture(db.admin, db.app), deal = await createQuote(f.a.as, f.p.outsider, f.p.moderator);
  const producer = await syntheticSourceAuthority(db.admin, f);
  const source = sourceDocument('US', 'synthetic-buyer-amendment'); source.policy.consentRequirements = [];
  source.policy.actionLimits.push({ action: 'place_order', approval: 'pre_authorized', approvalAbove: { minorUnits: '50', currency: 'USD' } });
  source.policy.actionLimits.push({ action: 'negotiate', approval: 'pre_authorized', approvalAbove: { minorUnits: '50', currency: 'USD' } });
  const imported = await withMaintenance(db.admin, trx => jurisdictionEvidence.importSource(trx, source));
  Object.assign(f.payload.agentSettings.jurisdictions[0]!, { sourceId: imported.id, sourceRevision: imported.revision, sourceDigest: imported.digest, policy: source.policy });
  await f.activate(await f.draft());
  const limits = () => f.a.as(f.p.outsider, trx => jurisdictionAuthority.limits(trx, deal.quoteId, 'negotiate'));
  const issue = async (action: 'send_quote' | 'negotiate' | 'place_order') => {
    for (const [kind, id] of [['person', f.p.outsider], ['person', f.p.moderator], ['project', deal.projectId]] as const) await producer.issue(kind, id, deal.quoteId, ['US'], action);
  };
  const usd = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
  const payload: QuoteVersionPayload = {
    currency: 'USD', paymentTerms: 'Synthetic terms', validity: { until: '2099-01-01T00:00:00.000Z' }, exclusions: [], attachments: [],
    deliveryTerms: { milestones: [], location: 'Synthetic site' }, totals: { net: usd('100'), tax: usd('0'), gross: usd('100') },
    lines: [{ lineId: 'q1', rfqLineId: 'synthetic', kind: 'goods', specSnapshot: {}, offeringVersionRef: null, quantity: { value: '1', unit: 'm2' },
      unitPrice: usd('100'), tax: { kind: 'none', ratePercent: null, included: false }, taxAmount: usd('0'), lineTotal: usd('100'), substitution: null, options: [] }],
  };
  const send = () => f.a.as(f.p.moderator, async trx => {
    const quote = await quotes.lock(trx, deal.quoteId); assert.ok(quote?.invitation_id);
    const current = await sql<{ current_version_id: string }>`SELECT current_version_id FROM trustwork.rfq WHERE id=${quote.rfq_id}::uuid`.execute(trx);
    const rv = await rfqVersions.get(trx, current.rows[0]!.current_version_id); assert.ok(rv?.digest);
    const prior = await quoteVersions.inStatus(trx, quote.id, 'sent');
    const draft = await quoteVersions.insertDraft(trx, { quote_id: quote.id, version: (quote.current_version ?? 0) + 1, rfq_id: quote.rfq_id,
      rfq_version_id: rv.id, rfq_version: rv.version, rfq_version_digest: rv.digest, payload, drafted_by_person_id: f.p.moderator, revalidated_from: null, answers_amendment_request_id: null });
    if (prior) await quoteVersions.supersede(trx, prior.id, new Date());
    const tax = await taxDeterminations.insertMany(trx, quote.id, draft.id, f.p.moderator, [{ line_id: 'q1', jurisdiction: 'synthetic', rule_ref: 'synthetic.none', rate: null, included: false, taxability: 'not_applicable', exemption_ref: null, provider: 'seller_stated' }]);
    await quoteLines.insertMany(trx, quote.id, draft.id, [{ position: 0, line_id: 'q1', rfq_line_id: 'synthetic', kind: 'goods', spec_snapshot: {}, offering_ref: null, offering_version: null,
      quantity_value: '1', quantity_unit: 'm2', currency: 'USD', unit_price_minor: '100', tax_determination_id: tax[0]!.id, tax_amount_minor: '0', line_total_minor: '100' }]);
    const digest = computeQuoteVersionDigest({ id: rv.id, version: rv.version, digest: { algorithm: 'trustwork-digest-1', value: rv.digest } }, payload).value;
    const sent = await quoteVersions.send(trx, draft.id, { digest, personId: f.p.moderator, via: 'person', mandateId: null, validUntil: payload.validity.until, at: new Date() }); assert.ok(sent);
    await quotes.setCurrent(trx, quote.id, { status: 'sent', current_version: sent.version, current_version_id: sent.id, invitation_id: quote.invitation_id, clearStale: true });
    return sent;
  });
  await t.test('draft state and caller action assertion cannot create negotiation applicability', async () => {
    assert.equal((await limits()).status, 'unknown');
    await assert.rejects(producer.stage({ ...await producer.payload('person', f.p.outsider, deal.quoteId), action: 'negotiate' }));
    await assert.rejects(f.a.cmd(f.p.moderator, (trx, ctx) => jurisdictionIssuers.propose(trx, f.world.sessions.moderator, ctx, producer.registration)), { code: '42501' });
    const ctx = await f.a.elevate(f.p.owner);
    const malformed = { ...producer.registration, competenceDigest: null };
    await assert.rejects(f.a.as(f.p.owner, trx => sql`SELECT trustwork.jurisdiction_issuer_propose(${f.world.sessions.owner}::uuid,${JSON.stringify(ctx)}::jsonb,${JSON.stringify(malformed)}::jsonb)`.execute(trx)), { code: '23514' });
  });
  const sent = await send();
  await t.test('seller applicability cannot be reused; exact buyer source resolves with protective limits', async () => {
    await issue('send_quote'); assert.equal((await limits()).status, 'unknown');
    await issue('negotiate'); const result = await limits(); assert.equal(result.status, 'resolved'); assert.equal(result.hubId, f.hubId);
    assert.equal(evaluateLimits(result, usd('51')).effect, 'ask'); assert.equal(evaluateLimits(result, usd('50')).effect, 'allow');
    for (const actor of [f.p.moderator, f.p.owner, f.p.officer, f.p.otherOwner]) await assert.rejects(f.a.as(actor, trx => jurisdictionAuthority.limits(trx, deal.quoteId, 'negotiate')), { code: '42501' });
    assert.equal((await f.a.as(f.p.outsider, trx => jurisdictionAuthority.limits(trx, deal.quoteId, 'place_order'))).status, 'unknown');
    for (const action of ['accept_order']) await assert.rejects(f.a.as(f.p.outsider, trx => jurisdictionAuthority.limits(trx, deal.quoteId, action)), { code: '42501' });
    assert.ok(!JSON.stringify(result).includes(sent.digest!));
  });
  await t.test('actual owning amendment uses this exact current version and rejects the seller', async () => {
    const input = { quote_id: deal.quoteId, quote_version_id: sent.id, requester_person_id: f.p.outsider, requester_company_id: null,
      requested_by_person_id: f.p.outsider, requested_via: 'person' as const, requested_mandate_id: null, line_refs: ['q1'], changes: [{ lineId: 'q1', note: 'Synthetic amendment' }],
      target_total_minor: null, target_total_currency: null };
    await assert.rejects(f.a.as(f.p.moderator, trx => amendmentRequests.insert(trx, { ...input, requested_by_person_id: f.p.moderator })), { code: '42501' });
    const request = await f.a.as(f.p.outsider, trx => amendmentRequests.insert(trx, input)); assert.equal(request.quote_version_id, sent.id);
  });
  await t.test('real version replacement invalidates old source and binding; fresh review is required', async () => {
    const old = await limits(), proof = await producer.payload('person', f.p.outsider, deal.quoteId, ['US'], 'negotiate');
    await send(); assert.equal((await limits()).status, 'unknown'); await assert.rejects(producer.stage(proof));
    await issue('negotiate'); const next = await limits(); assert.equal(next.status, 'resolved'); assert.notEqual(next.bindingDigest, old.bindingDigest);
  });
  await t.test('current-version writer and resolver serialize in both owning row-lock orders', async () => {
    const wait = async () => {
      for (let n = 0; n < 100; n++) {
        if ((await db.admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rowCount) return;
        await new Promise(r => setTimeout(r, 10));
      }
      assert.fail('owner competitor did not reach its real row lock');
    };
    for (const first of ['writer', 'resolver'] as const) {
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(r => { entered = r; }), held = new Promise<void>(r => { release = r; });
      // The real owner command retires the current sent version. No source or final projection is edited.
      const retire = (hold: boolean) => f.a.as(f.p.moderator, async trx => {
        const q = await quotes.lock(trx, deal.quoteId); assert.ok(q?.current_version_id);
        await quoteVersions.setStatus(trx, q.current_version_id, 'sent', 'withdrawn');
        if (hold) { entered(); await held; }
      });
      const resolve = (hold: boolean) => f.a.as(f.p.outsider, async trx => {
        const result = await jurisdictionAuthority.limits(trx, deal.quoteId, 'negotiate');
        if (hold) { assert.equal(result.status, 'resolved'); entered(); await held; }
        return result;
      });
      const winner = first === 'writer' ? retire(true) : resolve(true); await started;
      const other = first === 'writer' ? resolve(false) : retire(false);
      try { await wait(); } finally { release(); }
      await winner; const result = await other;
      if (first === 'writer') assert.equal(result?.status, 'unknown');
      assert.equal((await limits()).status, 'unknown');
      await send(); await issue('negotiate');
    }
  });
  await t.test('a required negotiation consent is never borrowed from the send-quote consent API', async () => {
    source.version = 'synthetic-negotiate-requires-consent'; source.policy.consentRequirements = ['synthetic.electronicRecords'];
    const src = await withMaintenance(db.admin, trx => jurisdictionEvidence.importSource(trx, source));
    Object.assign(f.payload.agentSettings.jurisdictions[0]!, { sourceId: src.id, sourceRevision: src.revision, sourceDigest: src.digest, policy: source.policy });
    await f.activate(await f.draft()); const result = await limits(); assert.equal(result.consentSatisfied, false); assert.equal(evaluateLimits(result, usd('1')).effect, 'deny');
  });
  await t.test('initial buyer acceptance binds the unique sent version and fences live agreements in both orders', async () => {
    source.version = 'synthetic-initial-acceptance'; source.policy.consentRequirements = [];
    const src = await withMaintenance(db.admin, trx => jurisdictionEvidence.importSource(trx, source));
    Object.assign(f.payload.agentSettings.jurisdictions[0]!, { sourceId: src.id, sourceRevision: src.revision, sourceDigest: src.digest, policy: source.policy });
    await f.activate(await f.draft());
    const initial = () => f.a.as(f.p.outsider, trx => jurisdictionAuthority.limits(trx, deal.quoteId, 'place_order'));
    for (const who of [f.p.moderator, f.p.owner, f.p.otherOwner]) await assert.rejects(f.a.as(who, trx => jurisdictionAuthority.limits(trx, deal.quoteId, 'place_order')), { code: '42501' });
    for (const first of ['accept', 'resolve'] as const) {
      await issue('place_order'); const before = await initial(); assert.equal(before.status, 'resolved');
      assert.equal(evaluateLimits(before, usd('51')).effect, 'ask');
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(r => { entered = r; }), held = new Promise<void>(r => { release = r; });
      const accept = (hold: boolean) => f.a.as(f.p.outsider, async trx => {
        const quote = await quotes.get(trx, deal.quoteId); assert.ok(quote?.current_version_id);
        const rfq = await rfqs.lock(trx, quote.rfq_id); assert.ok(rfq?.current_version_id);
        const qv = await quoteVersions.get(trx, quote.current_version_id), rv = await rfqVersions.get(trx, rfq.current_version_id); assert.ok(qv?.digest && rv?.digest);
        const terms = computeAgreementDigest({ id: qv.id, version: qv.version, digest: { algorithm: 'trustwork-digest-1', value: qv.digest } }, { id: rv.id, version: rv.version, digest: { algorithm: 'trustwork-digest-1', value: rv.digest } });
        const a = await agreements.insert(trx, { buyer_person_id: f.p.outsider, buyer_company_id: null, seller_person_id: f.p.moderator, seller_company_id: null,
          rfq_id: rfq.id, quote_id: quote.id, quote_version_id: qv.id, rfq_version_id: rv.id, offer_version: qv.version, offer_digest: qv.digest,
          request_version: rv.version, request_digest: rv.digest, accepted_terms_digest: terms.value, status: 'accepted_by_buyer', supersedes_id: null, created_by_person_id: f.p.outsider });
        const event = { agreement_id: a.id, terms_kind: a.terms_kind, quote_version_id: a.quote_version_id, rfq_version_id: a.rfq_version_id,
          offer_version: a.offer_version, offer_digest: a.offer_digest, request_version: a.request_version, request_digest: a.request_digest, accepted_terms_digest: a.accepted_terms_digest,
          actor_person_id: f.p.outsider, on_behalf_person_id: f.p.outsider, on_behalf_company_id: null, via: 'person' as const, mandate_id: null,
          transaction_budget_id: null, reservation_id: null, platform_budget_id: null, e_records_required: false, e_records_disclosure_key: null, e_records_basis: [], e_records_consented_at: null };
        await acceptanceEvents.insert(trx, { ...event, kind: 'buyer_accepts_terms', reason: null, idempotency_key: `synthetic.accept.${a.id}` });
        if (hold) { entered(); await held; }
        return { a, event };
      });
      const resolve = (hold: boolean) => f.a.as(f.p.outsider, async trx => {
        const result = await jurisdictionAuthority.limits(trx, deal.quoteId, 'place_order');
        if (hold) { assert.equal(result.status, 'resolved'); entered(); await held; }
        return result;
      });
      const firstAccept = first === 'accept' ? accept(true) : null, firstResolve = first === 'resolve' ? resolve(true) : null;
      await started; const secondAccept = first === 'resolve' ? accept(false) : null, secondResolve = first === 'accept' ? resolve(false) : null;
      try {
        let waited = false;
        for (let n = 0; n < 200; n++) {
          if ((await db.admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rowCount) { waited = true; break; }
          await new Promise(r => setTimeout(r, 10));
        }
        assert.ok(waited, 'actual owner acceptance or resolution reached its row lock');
      } finally { release(); }
      const accepted = await (firstAccept ?? secondAccept)!; await firstResolve;
      if (secondResolve) assert.equal((await secondResolve).status, 'unknown');
      assert.equal((await initial()).status, 'unknown');
      await f.a.as(f.p.outsider, async trx => {
        await acceptanceEvents.insert(trx, { ...accepted.event, kind: 'withdrawn', reason: 'Synthetic owner withdrawal', idempotency_key: `synthetic.withdraw.${accepted.a.id}` });
        await agreements.setStatus(trx, accepted.a.id, accepted.a.revision, { status: 'withdrawn', closed_reason: 'Synthetic owner withdrawal' });
      });
      assert.equal((await initial()).status, 'unknown', 'a retired agreement cannot revive the old context proof');
    }
  });

});
