import { cache } from 'react';
import type { Money, Party, Quantity } from '@trustwork/contracts/client';
import { currencyCode } from '@/app/_lib/country';
import { data } from '@/app/_lib/data';
import type { AuthenticatedPrincipal, LeadRow, RfqRow } from '@/app/_lib/data/types';
import { t } from '@/app/_lib/i18n';
import type {
  AmendmentRequest,
  BuyerAgreementView,
  BuyerQuoteView,
  ComparisonEntry,
  NegotiationRound,
  Need,
  OwnerRfqView,
  QuoteComparison,
  SellerAgreementView,
  SellerQuoteView,
  SupplierRfqView,
} from './contracts';
import type { AgreementListItem, AgreementView, CommercePort, InvitationItem, NeedListItem, QuoteListItem, QuoteView, RfqListItem, RfqView, SupplierCandidate } from './port';
import { lineAmounts, totals } from './quote-math';

/**
 * Demo commerce adapter (WEB-002, `TRUSTWORK_DEMO_MODE=1`, e.g. the hosted preview). Synthetic projections in the exact
 * contract shapes the API answers, derived from the demo persona's own fixture rows (the procurement and sales lists of
 * the `DataPort`), so the demo respects the same visibility: a buyer sees its RFQs with the owner-private half, an
 * invited seller only the shared projection and its own quotes. Nothing here is a real company, offer, price or
 * signature: names come from the labelled demo fixtures, line texts from the `commerce.demo` locale keys, digests are
 * placeholders. Mutations are validated in the browser and never sent (no API exists in a demo deployment).
 */

const T0 = '2026-10-20T09:00:00.000Z';
const T1 = '2026-10-24T09:00:00.000Z';
const T2 = '2026-10-27T09:00:00.000Z';
const VALID = '2026-12-15T18:00:00.000Z';
const DEADLINE = '2026-11-14T18:00:00.000Z';
const ZONE = 'UTC';

/** Deterministic placeholder digest (not a hash of anything; the demo never signs). */
function digest(seed: string): { algorithm: 'trustwork-digest-1'; value: string } {
  let h = 0x811c9dc5;
  let out = '';
  for (let round = 0; out.length < 64; round++) {
    for (const ch of `${seed}:${round}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return { algorithm: 'trustwork-digest-1', value: out.slice(0, 64) };
}
const ref = (id: string, version: number) => ({ id, version, digest: digest(id) });
const qty = (value: string, unit: string): Quantity => ({ value, unit });
const cash = (minorUnits: string, currency: string): Money => ({ minorUnits, currency });

type Line = { lineId: string; kind: 'goods' | 'works' | 'services'; description: string; quantity: Quantity };

/** RFQ lines of a demo request: version 1 asks for 10 units of the main line, the amendment (version 2) for 12. */
function rfqLines(id: string, version: 1 | 2, kind: RfqRow['kind']): Line[] {
  const main: Line['kind'] = kind === 'bundle' ? 'goods' : kind;
  return [
    { lineId: `${id}-l1`, kind: main, description: t(main === 'goods' ? 'commerce.demo.lineGoods' : main === 'works' ? 'commerce.demo.lineWorks' : 'commerce.demo.lineServices'), quantity: qty(version === 1 ? '10' : '12', main === 'goods' ? 't' : 'm2') },
    { lineId: `${id}-l2`, kind: 'services', description: t('commerce.demo.lineDelivery'), quantity: qty('1', 'ls') },
  ];
}

function rfqPayload(row: Pick<RfqRow, 'id' | 'title' | 'kind'>, version: 1 | 2, currency: string) {
  return {
    title: row.title,
    lines: rfqLines(row.id, version, row.kind).map((l) => ({ ...l, specification: { [t('commerce.demo.specKey')]: t('commerce.demo.specValue') }, alternativesAllowed: l.kind === 'goods' })),
    deliveryTerms: { location: { region: t('commerce.demo.region') }, window: { from: { date: '2026-11-20', timeZone: ZONE }, to: { date: '2026-12-10', timeZone: ZONE } } },
    acceptanceCriteria: t('commerce.demo.acceptance'),
    paymentTermsRequested: t('commerce.demo.paymentTerms'),
    currency,
    responseDeadline: DEADLINE,
    attachments: [],
  };
}

/** A quote payload answering the given RFQ lines; `substitute` replaces the main line with an alternative. */
function quotePayload(lines: Line[], prices: [string, string], currency: string, options: { substitute?: boolean; validUntil?: string } = {}) {
  const quoteLines = lines.map((l, i) => {
    const amounts = lineAmounts({ unitPriceMinor: prices[i] ?? '0', quantity: l.quantity.value, tax: 'vat', ratePercent: '12', currency });
    const substitute = options.substitute && i === 0;
    return {
      lineId: `${l.lineId}-q`,
      rfqLineId: substitute ? null : l.lineId,
      kind: l.kind,
      specSnapshot: { [t('commerce.demo.specKey')]: substitute ? t('commerce.demo.specAlternative') : t('commerce.demo.specValue') },
      offeringVersionRef: null,
      quantity: l.quantity,
      unitPrice: cash(prices[i] ?? '0', currency),
      tax: { kind: 'vat' as const, ratePercent: '12', included: false },
      ...amounts,
      substitution: substitute ? { forRfqLineId: l.lineId, reason: t('commerce.demo.substitutionReason') } : null,
      options: [],
    };
  });
  return {
    currency,
    lines: quoteLines,
    totals: totals(quoteLines, currency),
    deliveryTerms: { milestones: [{ description: t('commerce.demo.milestone'), due: { date: '2026-12-01', timeZone: ZONE } }], location: t('commerce.demo.region') },
    paymentTerms: t('commerce.demo.paymentTerms'),
    validity: { until: options.validUntil ?? VALID },
    exclusions: [t('commerce.demo.exclusion')],
    attachments: [],
  };
}

function rfqStatus(row: RfqRow): OwnerRfqView['rfq']['status'] {
  if (row.status === 'needDraft') return 'draft';
  if (row.status === 'closed' || row.status === 'cancelled' || row.status === 'expired') return row.status;
  return 'published';
}

type Scene = {
  rows: RfqRow[];
  leads: LeadRow[];
  names: Map<string, string>;
  suppliers: Party[];
  currency: string;
  self: { person: Party; company: Party | null };
};

const scene = cache(async (principal: AuthenticatedPrincipal): Promise<Scene> => {
  const [rows, leads, companies, people] = await Promise.all([data.listRfqs(principal), data.listLeads(principal), data.listCompanies(), data.listPeople()]);
  const names = new Map<string, string>([...companies.map((c) => [`company:${c.id}`, c.name] as const), ...people.map((p) => [`person:${p.id}`, p.displayName] as const)]);
  for (const lead of leads) names.set(`company:demo-buyer-${lead.id}`, lead.buyer);
  // Only parties that could have quoted: claimed or verified companies and people, never a sourced page, never the buyer itself.
  const suppliers: Party[] = [
    ...companies.filter((c) => c.status !== 'sourced' && c.id !== principal.company?.id).map((c) => ({ kind: 'company' as const, id: c.id })),
    ...people.filter((p) => p.id !== principal.personId).slice(0, 1).map((p) => ({ kind: 'person' as const, id: p.id })),
  ].slice(0, 3);
  return { rows, leads, names, suppliers, currency: currencyCode(), self: { person: { kind: 'person', id: principal.personId }, company: principal.company ? { kind: 'company', id: principal.company.id } : null } };
});

/* ---------- Buyer side ---------- */

type BuyerRfq = { view: OwnerRfqView; quotes: Map<string, BuyerQuoteView>; comparison: QuoteComparison; historical: QuoteComparison; agreements: BuyerAgreementView[] };

function buildBuyerRfq(s: Scene, row: RfqRow): BuyerRfq {
  const status = rfqStatus(row);
  const amended = status !== 'draft' && row.version >= 2;
  const v1Id = `${row.id}-v1`;
  const v2Id = `${row.id}-v2`;
  const owner: Party = row.ownerKind === 'company' && s.self.company ? s.self.company : s.self.person;
  const currentId = status === 'draft' ? null : amended ? v2Id : v1Id;
  const versions: OwnerRfqView['versions'] = [
    {
      id: v1Id, rfqId: row.id, version: 1, status: status === 'draft' ? 'draft' : amended ? 'superseded' : 'published', payload: rfqPayload(row, 1, s.currency),
      digest: status === 'draft' ? null : digest(v1Id), publishedAt: status === 'draft' ? null : T0, publishedBy: status === 'draft' ? null : 'demo-operator', supersededBy: amended ? 2 : null, amendmentReason: null,
    },
  ];
  if (amended) versions.push({ id: v2Id, rfqId: row.id, version: 2, status: 'published', payload: rfqPayload(row, 2, s.currency), digest: digest(v2Id), publishedAt: T1, publishedBy: 'demo-operator', supersededBy: null, amendmentReason: t('commerce.demo.amendmentReason') });
  const [a, b, c] = s.suppliers;
  const sentBy = { personId: 'demo-operator', mandateId: null };
  const invitations: OwnerRfqView['invitations'] = [];
  const quotes = new Map<string, BuyerQuoteView>();
  const entries: ComparisonEntry[] = [];
  const historical: QuoteComparison['historical'] = [];
  const v1Lines = rfqLines(row.id, 1, row.kind);
  const v2Lines = rfqLines(row.id, 2, row.kind);
  const quoted = status === 'published' && row.quotesCount > 0;
  if (status === 'published' && a) {
    invitations.push({ id: `${row.id}-inv-a1`, rfqId: row.id, rfqVersion: ref(v1Id, 1), party: a, channel: 'platform', status: quoted ? 'responded' : 'sent', staleReason: amended ? 'rfq_amended' : null, sentAt: T0, sentBy });
    if (amended) invitations.push({ id: `${row.id}-inv-a2`, rfqId: row.id, rfqVersion: ref(v2Id, 2), party: a, channel: 'platform', status: 'responded', staleReason: null, sentAt: T1, sentBy });
  }
  if (status === 'published' && b) invitations.push({ id: `${row.id}-inv-b1`, rfqId: row.id, rfqVersion: ref(v1Id, 1), party: b, channel: 'platform', status: quoted ? 'responded' : 'viewed', staleReason: amended ? 'rfq_amended' : null, sentAt: T0, sentBy });
  if (status === 'published' && amended && c) invitations.push({ id: `${row.id}-inv-c2`, rfqId: row.id, rfqVersion: ref(v2Id, 2), party: c, channel: 'platform', status: 'responded', staleReason: null, sentAt: T1, sentBy });

  const sharedVersion = (quoteId: string, id: string, version: number, rfqRef: ReturnType<typeof ref>, payload: ReturnType<typeof quotePayload>, vStatus: 'sent' | 'superseded', stale: boolean) => ({
    quoteId, id, version, rfqVersion: rfqRef, status: vStatus, staleReason: stale ? ('rfq_amended' as const) : null, lines: payload.lines.map((line) => { const shared: Record<string, unknown> = { ...line }; delete shared.offeringVersionRef; return shared as Omit<typeof line, 'offeringVersionRef'>; }), totals: payload.totals,
    deliveryTerms: payload.deliveryTerms, paymentTerms: payload.paymentTerms, validUntil: payload.validity.until, exclusions: payload.exclusions, attachments: payload.attachments, digest: digest(id),
  });
  const buyer = owner;
  if (quoted && a) {
    const qid = `${row.id}-quote-a`;
    const p1 = quotePayload(v1Lines, ['95000', '120000'], s.currency);
    const versionsA = [sharedVersion(qid, `${qid}-v1`, 1, ref(v1Id, 1), p1, amended ? 'superseded' : 'sent', amended)];
    const request: AmendmentRequest = { id: `${qid}-req1`, quoteId: qid, quoteVersionId: `${qid}-v1`, requester: buyer, changes: [{ lineId: `${v1Lines[0]!.lineId}-q`, quantity: null, targetUnitPrice: cash('90000', s.currency), reason: t('commerce.demo.requestReason') }], targetTotal: null, status: amended ? 'answered' : 'open', answeredByVersion: amended ? 2 : null, revision: 1, createdAt: T0 };
    const rounds: NegotiationRound[] = [
      { roundNo: 1, proposal: { kind: 'quote_version', id: `${qid}-v1` }, proposer: a, createdAt: T0 },
      { roundNo: 2, proposal: { kind: 'amendment_request', id: request.id }, proposer: buyer, createdAt: T0 },
    ];
    if (amended) {
      const p2 = quotePayload(v2Lines, ['92000', '120000'], s.currency);
      versionsA.push(sharedVersion(qid, `${qid}-v2`, 2, ref(v2Id, 2), p2, 'sent', false));
      rounds.push({ roundNo: 3, proposal: { kind: 'quote_version', id: `${qid}-v2` }, proposer: a, createdAt: T2 });
      const lines = v2Lines.map((l, i) => ({ rfqLineId: l.lineId, match: 'matched' as const, quoteLineId: p2.lines[i]!.lineId, requested: l.quantity, offered: l.quantity, unitPrice: p2.lines[i]!.unitPrice, lineTotal: p2.lines[i]!.lineTotal, taxAmount: p2.lines[i]!.taxAmount }));
      entries.push({ quoteId: qid, seller: a, version: ref(`${qid}-v2`, 2), currency: s.currency, validUntil: VALID, lines, extras: [], exclusions: p2.exclusions, comparableTotal: p2.totals, notTotalledBecause: [] });
      historical.push({ quoteId: qid, seller: a, version: ref(`${qid}-v1`, 1), rfqVersion: ref(v1Id, 1), status: 'superseded', staleReason: 'rfq_amended' });
    } else {
      const lines = v1Lines.map((l, i) => ({ rfqLineId: l.lineId, match: 'matched' as const, quoteLineId: p1.lines[i]!.lineId, requested: l.quantity, offered: l.quantity, unitPrice: p1.lines[i]!.unitPrice, lineTotal: p1.lines[i]!.lineTotal, taxAmount: p1.lines[i]!.taxAmount }));
      entries.push({ quoteId: qid, seller: a, version: ref(`${qid}-v1`, 1), currency: s.currency, validUntil: VALID, lines, extras: [], exclusions: p1.exclusions, comparableTotal: p1.totals, notTotalledBecause: [] });
    }
    quotes.set(qid, { projection: 'shared_party', quote: { id: qid, rfqId: row.id, seller: a, buyer, status: 'sent', staleReason: null, currentVersion: versionsA.length, revision: versionsA.length + 1 }, versions: versionsA, rounds, amendmentRequests: [request] });
  }
  if (quoted && b) {
    const qid = `${row.id}-quote-b`;
    const p1 = quotePayload(v1Lines, ['88000', '100000'], s.currency);
    quotes.set(qid, { projection: 'shared_party', quote: { id: qid, rfqId: row.id, seller: b, buyer, status: 'sent', staleReason: amended ? 'rfq_amended' : null, currentVersion: 1, revision: 2 }, versions: [sharedVersion(qid, `${qid}-v1`, 1, ref(v1Id, 1), p1, 'sent', amended)], rounds: [{ roundNo: 1, proposal: { kind: 'quote_version', id: `${qid}-v1` }, proposer: b, createdAt: T0 }], amendmentRequests: [] });
    if (amended) historical.push({ quoteId: qid, seller: b, version: ref(`${qid}-v1`, 1), rfqVersion: ref(v1Id, 1), status: 'sent', staleReason: 'rfq_amended' });
    else {
      const lines = v1Lines.map((l, i) => ({ rfqLineId: l.lineId, match: 'matched' as const, quoteLineId: p1.lines[i]!.lineId, requested: l.quantity, offered: l.quantity, unitPrice: p1.lines[i]!.unitPrice, lineTotal: p1.lines[i]!.lineTotal, taxAmount: p1.lines[i]!.taxAmount }));
      entries.push({ quoteId: qid, seller: b, version: ref(`${qid}-v1`, 1), currency: s.currency, validUntil: VALID, lines, extras: [], exclusions: p1.exclusions, comparableTotal: p1.totals, notTotalledBecause: [] });
    }
  }
  if (quoted && amended && c) {
    const qid = `${row.id}-quote-c`;
    const p2 = quotePayload(v2Lines, ['81000', '90000'], s.currency, { substitute: true });
    quotes.set(qid, { projection: 'shared_party', quote: { id: qid, rfqId: row.id, seller: c, buyer, status: 'sent', staleReason: null, currentVersion: 1, revision: 2 }, versions: [sharedVersion(qid, `${qid}-v1`, 1, ref(v2Id, 2), p2, 'sent', false)], rounds: [{ roundNo: 1, proposal: { kind: 'quote_version', id: `${qid}-v1` }, proposer: c, createdAt: T2 }], amendmentRequests: [] });
    const lines = v2Lines.map((l, i) =>
      i === 0
        ? { rfqLineId: l.lineId, match: 'substitution' as const, quoteLineId: p2.lines[0]!.lineId, requested: l.quantity, offered: p2.lines[0]!.quantity, unitPrice: p2.lines[0]!.unitPrice, lineTotal: p2.lines[0]!.lineTotal, taxAmount: p2.lines[0]!.taxAmount }
        : { rfqLineId: l.lineId, match: 'matched' as const, quoteLineId: p2.lines[i]!.lineId, requested: l.quantity, offered: l.quantity, unitPrice: p2.lines[i]!.unitPrice, lineTotal: p2.lines[i]!.lineTotal, taxAmount: p2.lines[i]!.taxAmount },
    );
    entries.push({ quoteId: qid, seller: c, version: ref(`${qid}-v1`, 1), currency: s.currency, validUntil: VALID, lines, extras: [], exclusions: p2.exclusions, comparableTotal: null, notTotalledBecause: ['scope_mismatch'] });
  }

  const current = currentId ? ref(currentId, amended ? 2 : 1) : ref(v1Id, 1);
  const view: OwnerRfqView = {
    projection: 'owner_private',
    rfq: { id: row.id, owner, projectId: row.projectId, creatorPersonId: 'demo-operator', status, currentVersion: currentId ? (amended ? 2 : 1) : null, currentVersionId: currentId, revision: amended ? 6 : 3, publicProjection: { enabled: false, fields: [] }, category: null, createdAt: T0 },
    versions,
    privateConstraint: { rfqId: row.id, ownerParty: owner, budgetCeiling: cash('2500000', s.currency), evaluationWeights: {}, internalNotes: t('commerce.demo.internalNotes'), shortlist: [], revision: 1 },
    invitations,
    origin: { needId: null, planItem: null },
  };
  return {
    view,
    quotes,
    comparison: { rfqId: row.id, mode: 'current', currentRfqVersion: current, entries, historical },
    historical: { rfqId: row.id, mode: 'historical', currentRfqVersion: current, entries: [], historical: [...entries.map((e) => ({ quoteId: e.quoteId, seller: e.seller, version: e.version, rfqVersion: current, status: 'sent' as const, staleReason: null })), ...historical] },
    agreements: [],
  };
}

/* ---------- Seller side ---------- */

type SellerDeal = { lead: LeadRow; rfq: SupplierRfqView; invitation: InvitationItem; quote: SellerQuoteView | null; agreement: SellerAgreementView | null };

function buildSellerDeal(s: Scene, principal: AuthenticatedPrincipal, lead: LeadRow): SellerDeal {
  const rfqId = `demo-sale-${lead.id}`;
  const buyer: Party = { kind: 'company', id: `demo-buyer-${lead.id}` };
  const seller: Party = principal.company ? { kind: 'company', id: principal.company.id } : { kind: 'person', id: principal.personId };
  const row = { id: rfqId, title: lead.request, kind: 'works' as const };
  const amended = lead.status === 'negotiating';
  const v1 = { rfqId, id: `${rfqId}-v1`, version: 1, status: amended ? ('superseded' as const) : ('published' as const), payload: rfqPayload(row, 1, s.currency), digest: digest(`${rfqId}-v1`), publishedAt: T0, amendmentReason: null };
  const v2 = { rfqId, id: `${rfqId}-v2`, version: 2, status: 'published' as const, payload: rfqPayload(row, 2, s.currency), digest: digest(`${rfqId}-v2`), publishedAt: T1, amendmentReason: t('commerce.demo.amendmentReason') };
  // After the amendment the buyer revalidated the invitation: the supplier sees version 2 because a new invitation pins it.
  const invitations = [
    { id: `${rfqId}-inv1`, rfqId, rfqVersion: ref(v1.id, 1), party: seller, channel: 'platform' as const, status: lead.status === 'new' ? ('sent' as const) : lead.status === 'drafting' ? ('viewed' as const) : ('responded' as const), staleReason: amended ? ('rfq_amended' as const) : null, sentAt: T0 },
    ...(amended ? [{ id: `${rfqId}-inv2`, rfqId, rfqVersion: ref(v2.id, 2), party: seller, channel: 'platform' as const, status: 'sent' as const, staleReason: null, sentAt: T1 }] : []),
  ];
  const rfq: SupplierRfqView = { projection: 'shared_party', rfq: { id: rfqId, buyer, status: 'published', category: null }, versions: amended ? [v1, v2] : [v1], invitations };
  const invitation: InvitationItem = { invitation: invitations.at(-1)!, rfq: { id: rfqId, buyer, status: 'published' }, title: lead.request, responseDeadline: DEADLINE };
  let quote: SellerQuoteView | null = null;
  let agreement: SellerAgreementView | null = null;
  if (lead.status !== 'new') {
    const qid = `${rfqId}-quote`;
    const lines = rfqLines(rfqId, 1, 'works');
    const payload = quotePayload(lines, ['210000', '150000'], s.currency);
    const draft = lead.status === 'drafting';
    const sentVersion = {
      id: `${qid}-v1`, quoteId: qid, version: 1, rfqVersion: ref(v1.id, 1), status: draft ? ('draft' as const) : lead.status === 'won' ? ('accepted' as const) : ('sent' as const), payload,
      digest: draft ? null : digest(`${qid}-v1`), sentAt: draft ? null : T1, sentBy: draft ? null : { personId: principal.personId, mandateId: null }, validUntil: draft ? null : payload.validity.until, staleReason: amended ? ('rfq_amended' as const) : null, revalidatedFrom: null,
    };
    quote = {
      projection: 'owner_private',
      quote: { id: qid, rfqId, seller, buyer, status: sentVersion.status, staleReason: amended ? 'rfq_amended' : null, currentVersion: draft ? null : 1, revision: draft ? 1 : 2, createdAt: T0, invitationId: invitations[0]!.id, updatedAt: T1 },
      versions: [sentVersion],
      privateConstraint: { quoteId: qid, ownerParty: seller, floorPrices: { [`${lines[0]!.lineId}-q`]: cash('200000', s.currency) }, marginTargets: {}, costBasis: {}, negotiationNotes: t('commerce.demo.sellerNotes'), revision: 1 },
      rounds: draft ? [] : [{ roundNo: 1, proposal: { kind: 'quote_version', id: sentVersion.id }, proposer: seller, createdAt: T1 }],
      amendmentRequests: [],
    };
    if (lead.status === 'sent') {
      const agreementId = `${rfqId}-agreement`;
      const terms = { quoteVersion: ref(sentVersion.id, 1), rfqVersion: ref(v1.id, 1), digest: digest(agreementId) };
      agreement = {
        projection: 'party_private', side: 'seller', privateRevision: 1, rfqId, quoteId: qid,
        agreement: { id: agreementId, parties: { buyer, seller }, termsKind: 'rfq_quote', acceptedTerms: terms, acceptanceEventIds: [`${agreementId}-e1`], status: 'accepted_by_buyer', supersededBy: null, obligations: [], revision: 2, sellerPrivate: { fulfilmentPlan: [], notes: null } },
        events: [{ id: `${agreementId}-e1`, kind: 'buyer_accepts_terms', termsKind: 'rfq_quote', quoteVersion: terms.quoteVersion, rfqVersion: terms.rfqVersion, acceptedTermsDigest: terms.digest, onBehalfOf: buyer, electronicRecords: { disclosureKey: 'trustwork.electronic-records.v1', basis: [] }, occurredAt: T2 }],
        orders: [{ id: `${agreementId}-order`, agreementId, acceptedTermsDigest: terms.digest, status: 'placed', externalReference: null, revision: 1, createdAt: T2 }],
        orderChanges: [],
      };
    }
  }
  return { lead, rfq, invitation, quote, agreement };
}

/* ---------- Port ---------- */

const buyerRfqs = cache(async (principal: AuthenticatedPrincipal) => {
  const s = await scene(principal);
  return new Map(s.rows.map((row) => [row.id, buildBuyerRfq(s, row)] as const));
});
const sellerDeals = cache(async (principal: AuthenticatedPrincipal) => {
  const s = await scene(principal);
  return new Map(s.leads.filter((l) => l.source !== 'email').map((lead) => { const deal = buildSellerDeal(s, principal, lead); return [deal.rfq.rfq.id, deal] as const; }));
});

function demoNeed(principal: AuthenticatedPrincipal): Need {
  const owner: Party = { kind: 'person', id: principal.personId };
  return {
    projection: 'owner_private', id: 'demo-need-1', owner, projectId: null, source: 'manual', status: 'clarifying', title: t('commerce.demo.needTitle'), description: t('commerce.demo.needDescription'), region: null, window: null, acceptanceCriteria: null,
    lines: [{ lineId: 'demo-need-1-l1', position: 0, kind: 'goods', description: t('commerce.demo.needLine'), quantity: null, specification: {}, alternativesAllowed: true, evidence: null }],
    missingFields: ['lines.0.quantity', 'region', 'window', 'acceptanceCriteria'], rfqId: null, revision: 2, createdAt: T0, updatedAt: T1,
  };
}

export const demoCommercePort: CommercePort = {
  source: 'fixtures',
  async listNeeds(principal) {
    const need: Partial<Need> = { ...demoNeed(principal) };
    delete need.lines;
    return (await scene(principal)).rows.length > 0 ? [need as NeedListItem] : [];
  },
  async getNeed(principal, id) {
    return id === 'demo-need-1' && (await scene(principal)).rows.length > 0 ? demoNeed(principal) : null;
  },
  async listRfqs(principal): Promise<RfqListItem[]> {
    return [...(await buyerRfqs(principal)).values()].map(({ view }) => ({
      id: view.rfq.id, owner: view.rfq.owner, status: view.rfq.status, title: (view.versions.at(-1) ?? view.versions[0]!).payload.title, currentVersion: view.rfq.currentVersion,
      draftVersion: view.versions.find((v) => v.status === 'draft')?.version ?? null, category: null, invitations: view.invitations.length, staleInvitations: view.invitations.filter((i) => i.staleReason).length, revision: view.rfq.revision, updatedAt: T2,
    }));
  },
  async getRfq(principal, id): Promise<RfqView | null> {
    return (await buyerRfqs(principal)).get(id)?.view ?? (await sellerDeals(principal)).get(id)?.rfq ?? null;
  },
  async getComparison(principal, rfqId, mode) {
    const found = (await buyerRfqs(principal)).get(rfqId);
    return found ? (mode === 'current' ? found.comparison : found.historical) : null;
  },
  async listQuotes(principal): Promise<QuoteListItem[]> {
    return [...(await sellerDeals(principal)).values()].flatMap(({ quote }) =>
      quote ? [{ id: quote.quote.id, rfqId: quote.quote.rfqId, buyer: quote.quote.buyer, seller: quote.quote.seller, status: quote.quote.status, staleReason: quote.quote.staleReason, currentVersion: quote.quote.currentVersion, draftVersion: quote.versions.find((v) => v.status === 'draft')?.version ?? null, revision: quote.quote.revision, updatedAt: quote.quote.updatedAt }] : [],
    );
  },
  async getQuote(principal, id): Promise<QuoteView | null> {
    for (const deal of (await sellerDeals(principal)).values()) if (deal.quote?.quote.id === id) return deal.quote;
    for (const rfq of (await buyerRfqs(principal)).values()) {
      const found = rfq.quotes.get(id);
      if (found) return found;
    }
    return null;
  },
  async listInvitations(principal) {
    return [...(await sellerDeals(principal)).values()].map((d) => d.invitation);
  },
  async listAgreements(principal): Promise<AgreementListItem[]> {
    const seller = [...(await sellerDeals(principal)).values()].flatMap((d) => (d.agreement ? [d.agreement] : []));
    const buyer = [...(await buyerRfqs(principal)).values()].flatMap((r) => r.agreements);
    return [...seller, ...buyer].map((v) => ({ id: v.agreement.id, side: v.side, termsKind: v.agreement.termsKind, rfqId: v.rfqId, counterparty: v.side === 'seller' ? v.agreement.parties.buyer : v.agreement.parties.seller, status: v.agreement.status, revision: v.agreement.revision, createdAt: T2 }));
  },
  async getAgreement(principal, id): Promise<AgreementView | null> {
    for (const deal of (await sellerDeals(principal)).values()) if (deal.agreement?.agreement.id === id) return deal.agreement;
    for (const rfq of (await buyerRfqs(principal)).values()) for (const a of rfq.agreements) if (a.agreement.id === id) return a;
    return null;
  },
  async partyLabel(principal, party) {
    if (party.kind === 'company' && party.id === principal.company?.id) return principal.company.name;
    if (party.kind === 'person' && party.id === principal.personId) return principal.displayName;
    return (await scene(principal)).names.get(`${party.kind}:${party.id}`) ?? null;
  },
  async supplierCandidates(principal): Promise<SupplierCandidate[]> {
    const [companies, people] = await Promise.all([data.listCompanies(), data.listPeople()]);
    return [
      ...companies.filter((c) => c.id !== principal.company?.id).map((c) => ({ party: { kind: 'company' as const, id: c.id }, label: c.name, outreach: c.status !== 'sourced' })),
      ...people.filter((p) => p.id !== principal.personId).map((p) => ({ party: { kind: 'person' as const, id: p.id }, label: p.displayName, outreach: true })),
    ];
  },
};

/** Exported for the contract-shape tests of the demo (tests/web/commerce). */
export const demoInternals = { buildBuyerRfq, buildSellerDeal };
