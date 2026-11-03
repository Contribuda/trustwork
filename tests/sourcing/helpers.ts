import assert from 'node:assert/strict';
import { hash } from '@node-rs/argon2';
import { withMaintenance, withPrincipal, type DataPool, type Transaction } from '@trustwork/data';
import type { Client, Harness, Response } from '../backend/helpers/app.js';
import { principalFor } from '../data/helpers/seed.js';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import { screenEveryoneClear } from '../screening-gates/helpers.js';
import type { OwnerRfqView } from '../../packages/contracts/src/commerce.js';
import type { SellerQuoteView } from '../../packages/contracts/src/deals.js';

/**
 * A synthetic world for the PRC-004 suites (every name is fictitious, every address example.invalid):
 * - the buying company "Synthetic Builders": Ada (administrator: every procurement permission and company.deals.manage),
 *   Rita (member with company.deals.manage and a grant of procurement.sourcing.run from Ada), Dana (member with
 *   company.deals.manage, no sourcing grant), Mia (member without any permission);
 * - three suppliers, "Synthetic Supply A/B/C", with the administrators Sam, Tess and Vera;
 * - another buyer "Synthetic Elsewhere" with Otto (administrator).
 */
export const PASSWORD = 'synthetic-sourcing-password-01';
export const PEOPLE = ['ada', 'rita', 'dana', 'mia', 'sam', 'tess', 'vera', 'otto'] as const;
export type Person = (typeof PEOPLE)[number];
const ALL_COMPANY_PERMISSIONS = ['company.page.edit', 'company.publish', 'company.members.manage', 'company.deals.manage', 'company.catalogue.edit', 'company.billing.view', 'company.billing.manage'];

export interface World {
  label: string;
  buyer: string;
  supplierA: string;
  supplierB: string;
  supplierC: string;
  otherBuyer: string;
  people: Record<Person, string>;
}
export type Party = { kind: 'person' | 'company'; id: string };

export const PERSON = { via: 'person' as const };
export const loginEmail = (p: Person, label: string) => `sourcing-${p}-${label}@example.invalid`;
export const company = (id: string): Party => ({ kind: 'company', id });
export const usd = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const bdate = (date: string) => ({ date, timeZone: 'America/Los_Angeles' });

export async function syncKernel(admin: DataPool): Promise<void> {
  await withMaintenance(admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
}

export async function grant(admin: DataPool, w: World, person: Person, action: string, companyId = w.buyer, grantedBy: Person = 'ada'): Promise<string> {
  return withMaintenance(admin, async (trx) => (await trx.insertInto('permission_grant').values({ principal_person_id: w.people[person], action, scope: JSON.stringify({ companyId }), granted_by: w.people[grantedBy] }).returning('id').executeTakeFirstOrThrow()).id);
}

export async function seedWorld(h: Harness, label: string): Promise<World> {
  const passwordHash = await hash(PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
  const w = await withMaintenance(h.db.admin, async (trx) => {
    const newCompany = async (name: string) =>
      (await trx.insertInto('company').values({ display_name: `${name} ${label}`, claim_status: 'claimed', sourced_status: 'registered', public_description: `${name}: synthetic test company` }).returning('id').executeTakeFirstOrThrow()).id;
    const buyer = await newCompany('Synthetic Builders');
    const supplierA = await newCompany('Synthetic Supply A');
    const supplierB = await newCompany('Synthetic Supply B');
    const supplierC = await newCompany('Synthetic Supply C');
    const otherBuyer = await newCompany('Synthetic Elsewhere');
    const employer: Record<Person, string> = { ada: buyer, rita: buyer, dana: buyer, mia: buyer, sam: supplierA, tess: supplierB, vera: supplierC, otto: otherBuyer };
    const admins = new Set<Person>(['ada', 'sam', 'tess', 'vera', 'otto']);
    const dealMakers = new Set<Person>(['rita', 'dana']);
    const people = {} as Record<Person, string>;
    for (const p of PEOPLE) {
      const id = (await trx.insertInto('person').values({ display_name: `Synthetic ${p} ${label}`, profile_visibility: 'private' }).returning('id').executeTakeFirstOrThrow()).id;
      people[p] = id;
      await trx.insertInto('email_binding').values({ person_id: id, email_normalized: loginEmail(p, label), is_primary: true, verified_at: new Date('2026-10-01T09:00:00Z') }).execute();
      await trx.insertInto('credential').values({ person_id: id, kind: 'password', password_hash: passwordHash }).execute();
      await trx.insertInto('membership').values({
        person_id: id, company_id: employer[p], role: admins.has(p) ? 'administrator' : 'member', permissions: admins.has(p) ? ALL_COMPANY_PERMISSIONS : dealMakers.has(p) ? ['company.deals.manage'] : [], status: 'active',
        valid_from: new Date('2026-10-01T09:00:00Z'),
      }).execute();
    }
    return { label, buyer, supplierA, supplierB, supplierC, otherBuyer, people };
  });
  await grant(h.db.admin, w, 'rita', 'procurement.sourcing.run');
  await syncKernel(h.db.admin);
  // SANC-004: quotes, acceptance and orders need every party screened clear against fresh baseline lists.
  await screenEveryoneClear(h.db.admin);
  return w;
}

export async function signIn(h: Harness, p: Person, label: string): Promise<Client> {
  const client = h.client();
  const response = await client.post('/v1/auth/login', { email: loginEmail(p, label), password: PASSWORD }, { idempotencyKey: null });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return client;
}

export async function as<T>(h: Harness, w: World, p: Person, fn: (trx: Transaction) => Promise<T>): Promise<T> {
  return withPrincipal(h.pool, await principalFor(h.db.admin, w.people[p]), fn);
}

export function ok<T>(r: Response, status = 200): T {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body as T;
}

export const refused = (r: Response, status: number, code: string, reason?: string): void => {
  const body = r.body as { code?: string; details?: { reason?: string } };
  assert.equal(r.status, status, JSON.stringify(r.body));
  assert.equal(body.code, code, JSON.stringify(r.body));
  if (reason) assert.equal(body.details?.reason, reason, JSON.stringify(r.body));
};

export const count = async (admin: DataPool, query: string, params: unknown[] = []): Promise<number> =>
  (await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${query}) q`, params)).rows[0]?.n ?? 0;

interface PgError { code?: string; hint?: string; message?: string }
/** Expects a database hint or SQLSTATE. */
export async function fails(promise: Promise<unknown>, expected: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const e = error as PgError;
    assert.ok(e.hint === expected || e.code === expected, `expected ${expected}, got ${e.code} ${e.hint ?? ''} ${e.message ?? ''}`);
    return;
  }
  assert.fail(`expected ${expected}, but it succeeded`);
}

/** An RFQ payload with two lines; `sealed` and the deadline are what the sealed suite varies. */
export const rfqPayload = (over: { sealed?: boolean; deadline?: string; quantity?: string } = {}) => ({
  title: 'Patio pavers and laying', currency: 'USD', responseDeadline: over.deadline ?? '2027-02-15T17:00:00.000Z', attachments: [], paymentTermsRequested: 'Net 30', acceptanceCriteria: 'Level within 3 mm per metre',
  deliveryTerms: { location: { region: 'US-CA' }, window: { from: bdate('2027-03-01'), to: bdate('2027-03-31') } },
  lines: [
    { lineId: 'pavers', kind: 'goods', description: 'Concrete pavers, grey', specification: { thickness: '60 mm' }, quantity: { value: over.quantity ?? '10', unit: 'm2' }, alternativesAllowed: true },
    { lineId: 'laying', kind: 'works', description: 'Lay the pavers', specification: {}, quantity: { value: '1', unit: 'ls' }, alternativesAllowed: false },
  ],
  ...(over.sealed === undefined ? {} : { sealedUntilDeadline: over.sealed }),
});

/** A quote covering both lines by default; `lines: ['pavers']` quotes one line only. */
export function quotePayload(unitPrice: string, over: { lines?: readonly ('pavers' | 'laying')[]; quantity?: string; laying?: string; currency?: string } = {}) {
  const quantity = over.quantity ?? '10';
  const laying = over.laying ?? '50000';
  const currency = over.currency ?? 'USD';
  const money = (minorUnits: string) => ({ minorUnits, currency });
  const wanted = over.lines ?? ['pavers', 'laying'];
  const goods = (BigInt(quantity) * BigInt(unitPrice)).toString();
  const lines = [
    ...(wanted.includes('pavers') ? [{ lineId: 'q1', rfqLineId: 'pavers', kind: 'goods', specSnapshot: { thickness: '60 mm' }, offeringVersionRef: null, quantity: { value: quantity, unit: 'm2' }, unitPrice: money(unitPrice), tax: { kind: 'none', ratePercent: null, included: false }, taxAmount: money('0'), lineTotal: money(goods), substitution: null, options: [] }] : []),
    ...(wanted.includes('laying') ? [{ lineId: 'q2', rfqLineId: 'laying', kind: 'works', specSnapshot: {}, offeringVersionRef: null, quantity: { value: '1', unit: 'ls' }, unitPrice: money(laying), tax: { kind: 'none', ratePercent: null, included: false }, taxAmount: money('0'), lineTotal: money(laying), substitution: null, options: [] }] : []),
  ];
  const total = lines.reduce((sum, l) => sum + BigInt(l.lineTotal.minorUnits), 0n).toString();
  return {
    currency, paymentTerms: 'Net 30', validity: { until: '2027-06-01T00:00:00.000Z' }, exclusions: [], attachments: [],
    deliveryTerms: { milestones: [{ description: 'Delivery and laying', due: bdate('2027-03-20') }], location: 'Site, San Diego County' },
    totals: { net: money(total), tax: money('0'), gross: money(total) }, lines,
  };
}

/** A published RFQ of the buyer company (or of `owner`), with its invitations. */
export async function publishRfq(client: Client, owner: Party, payload: ReturnType<typeof rfqPayload>, invitees: readonly Party[], projectId: string | null = null): Promise<OwnerRfqView> {
  let rfq = ok<OwnerRfqView>(await client.post('/v1/rfqs', { owner, projectId, payload, category: 'landscaping', publicProjection: { enabled: false, fields: [] }, privateConstraint: null, source: null, actor: PERSON }), 201);
  rfq = ok<OwnerRfqView>(await client.post(`/v1/rfqs/${rfq.rfq.id}/publish`, { rfqId: rfq.rfq.id, version: 1, expectedRevision: rfq.rfq.revision, amendmentReason: null, actor: PERSON }));
  for (const party of invitees) ok(await client.post(`/v1/rfqs/${rfq.rfq.id}/invitations`, { rfqId: rfq.rfq.id, rfqVersionId: rfq.rfq.currentVersionId, party, channel: 'platform', actor: PERSON }), 201);
  return ok<OwnerRfqView>(await client.get(`/v1/rfqs/${rfq.rfq.id}`));
}

export async function draftQuote(client: Client, rfq: OwnerRfqView, seller: Party, payload: ReturnType<typeof quotePayload>): Promise<SellerQuoteView> {
  return ok<SellerQuoteView>(await client.post('/v1/quotes', { rfqId: rfq.rfq.id, rfqVersionId: rfq.rfq.currentVersionId, seller, payload, privateConstraint: null, actor: PERSON }), 201);
}
export async function sendQuote(client: Client, rfq: OwnerRfqView, seller: Party, payload: ReturnType<typeof quotePayload>): Promise<SellerQuoteView> {
  const created = await draftQuote(client, rfq, seller, payload);
  return ok<SellerQuoteView>(await client.post(`/v1/quotes/${created.quote.id}/send`, { quoteId: created.quote.id, version: 1, expectedRevision: created.quote.revision, actor: PERSON }));
}
/** Publishes an amendment with the given payload. */
export async function amendRfq(client: Client, rfq: OwnerRfqView, payload: ReturnType<typeof rfqPayload>): Promise<OwnerRfqView> {
  let r = ok<OwnerRfqView>(await client.post(`/v1/rfqs/${rfq.rfq.id}/versions`, { expectedRevision: rfq.rfq.revision, amendmentReason: 'Terms changed', actor: PERSON }), 201);
  const draft = r.versions.find((v) => v.status === 'draft')!;
  r = ok<OwnerRfqView>(await client.post(`/v1/rfqs/${rfq.rfq.id}/versions/${draft.id}`, { expectedRevision: r.rfq.revision, payload, actor: PERSON }));
  return ok<OwnerRfqView>(await client.post(`/v1/rfqs/${rfq.rfq.id}/publish`, { rfqId: rfq.rfq.id, version: draft.version, expectedRevision: r.rfq.revision, amendmentReason: 'Terms changed', actor: PERSON }));
}
