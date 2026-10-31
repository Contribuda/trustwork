import type { LocaleKey } from '@/app/_lib/i18n';
import { localTimeZone, localToTimestamp, quantityValue, rateValue, toMinor } from './amounts';
import { lineAmounts, totals, type TaxKind } from './quote-math';

/**
 * Payload builders of the commerce commands (WEB-002). Fields are rendered on the server as plain labelled inputs; the
 * one client form reads them and these pure functions turn them into the exact contract command, or a localized
 * refusal naming the field to fix. The API validates everything again; this only spares a round trip and keeps
 * computed values (exact totals, minor units, UTC timestamps) right.
 */
export interface FieldReader {
  get(name: string): string;
  checked(name: string): boolean;
}
export type Step = { path: `/v1/${string}`; payload: Record<string, unknown>; revisionFromQuote?: boolean };
export type Built = { ok: true; steps: Step[] } | { ok: false; error: LocaleKey; field?: string };

export type Shape =
  | { kind: 'plain' }
  | { kind: 'reason'; field: string }
  | { kind: 'need'; mode: 'create' | 'save' }
  | { kind: 'rfqDraft'; payload: Record<string, unknown>; deadline: { local: string; value: string } }
  | { kind: 'convert' }
  | { kind: 'private'; currency: string }
  | { kind: 'invite' }
  | { kind: 'amendment'; currency: string }
  | { kind: 'accept' }
  | { kind: 'placeOrder' }
  | { kind: 'quote'; currency: string; payload: Record<string, unknown>; privatePath: `/v1/${string}`; privateRevision: number; sendPath: `/v1/${string}`; validity: { local: string; value: string } };

const fail = (error: LocaleKey, field?: string): Built => (field ? { ok: false, error, field } : { ok: false, error });
const ok = (path: `/v1/${string}`, payload: Record<string, unknown>): Built => ({ ok: true, steps: [{ path, payload }] });
const ACTOR = { via: 'person' } as const;

/** Rows of a line editor: `line.<i>.<field>`; blank new rows are ignored, rows ticked "remove" are dropped. */
function lines(f: FieldReader, strict: boolean): { rows: Array<Record<string, unknown>>; error?: { key: LocaleKey; field: string } } {
  const count = Number(f.get('lines')) || 0;
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count; i++) {
    const p = `line.${i}.`;
    const description = f.get(`${p}description`).trim();
    const lineId = f.get(`${p}lineId`);
    if (f.checked(`${p}remove`) || (!description && !lineId && !f.get(`${p}quantity`).trim())) continue;
    if (!description) return { rows, error: { key: 'commerce.lines.descriptionRequired', field: `${p}description` } };
    const typed = f.get(`${p}quantity`).trim();
    const value = typed ? quantityValue(typed) : null;
    if (typed && !value) return { rows, error: { key: 'commerce.lines.quantityInvalid', field: `${p}quantity` } };
    const kind = f.get(`${p}kind`) || null;
    if (strict && !kind) return { rows, error: { key: 'commerce.lines.kindRequired', field: `${p}kind` } };
    if (strict && !value) return { rows, error: { key: 'commerce.lines.quantityInvalid', field: `${p}quantity` } };
    const spec = f.get(`${p}spec`);
    rows.push({ ...(lineId ? { lineId } : {}), kind, description, quantity: value ? { value, unit: f.get(`${p}unit`) || 'pc' } : null, specification: spec ? (JSON.parse(spec) as Record<string, string>) : {}, alternativesAllowed: f.checked(`${p}alternatives`) });
  }
  return { rows };
}

function window(f: FieldReader, strict: boolean): { value: { from: { date: string; timeZone: string }; to: { date: string; timeZone: string } } | null } | { error: LocaleKey } {
  const from = f.get('from');
  const to = f.get('to');
  if (!from && !to && !strict) return { value: null };
  if (!from || !to || from > to) return { error: 'commerce.need.windowInvalid' };
  const zone = f.get('timeZone') || localTimeZone();
  return { value: { from: { date: from, timeZone: zone }, to: { date: to, timeZone: zone } } };
}

function newLineId(): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `line-${random}`;
}

/** Builds the steps of one submission. `base` carries the server-known parts (ids, revisions, refs); typed values come from `f`. */
export function build(shape: Shape, path: `/v1/${string}`, base: Record<string, unknown>, f: FieldReader, intent: string | null): Built {
  switch (shape.kind) {
    case 'plain':
      return ok(path, base);
    case 'reason': {
      const reason = f.get('reason').trim();
      return reason ? ok(path, { ...base, [shape.field]: reason }) : fail('commerce.reasonRequired', 'reason');
    }
    case 'need': {
      const title = f.get('title').trim();
      if (!title) return fail('commerce.need.titleRequired', 'title');
      const rows = lines(f, false);
      if (rows.error) return fail(rows.error.key, rows.error.field);
      const w = window(f, false);
      if ('error' in w) return fail(w.error, 'from');
      const fields = { title, description: f.get('description').trim() || null, region: f.get('region').trim() || null, window: w.value, acceptanceCriteria: f.get('acceptance').trim() || null, lines: rows.rows.map((row) => { const l: Record<string, unknown> = { ...row, evidence: null }; delete l.lineId; return l; }) };
      if (shape.mode === 'save') return ok(path, { ...base, fields, actor: ACTOR });
      const [kind, id] = f.get('owner').split(':');
      return ok(path, { owner: { kind, id }, projectId: null, source: 'manual', fields, actor: ACTOR });
    }
    case 'rfqDraft': {
      const title = f.get('title').trim();
      if (!title) return fail('commerce.need.titleRequired', 'title');
      const rows = lines(f, true);
      if (rows.error) return fail(rows.error.key, rows.error.field);
      if (rows.rows.length === 0) return fail('commerce.lines.empty', 'line.0.description');
      const region = f.get('region').trim();
      if (!region) return fail('commerce.rfq.regionRequired', 'region');
      const w = window(f, true);
      if ('error' in w || !w.value) return fail('commerce.need.windowInvalid', 'from');
      const acceptance = f.get('acceptance').trim();
      if (!acceptance) return fail('commerce.rfq.acceptanceRequired', 'acceptance');
      const typed = f.get('deadline');
      const deadline = typed === shape.deadline.local ? shape.deadline.value : localToTimestamp(typed);
      if (!deadline) return fail('commerce.convert.deadlineInvalid', 'deadline');
      const original = shape.payload as { deliveryTerms: { location: Record<string, unknown> } };
      const payload = {
        ...shape.payload,
        title,
        lines: rows.rows.map((l) => ({ lineId: (l.lineId as string | undefined) ?? newLineId(), kind: l.kind, description: l.description, specification: l.specification, quantity: l.quantity, alternativesAllowed: l.alternativesAllowed })),
        deliveryTerms: { location: { ...original.deliveryTerms.location, region }, window: w.value },
        acceptanceCriteria: acceptance,
        paymentTermsRequested: f.get('payment').trim() || null,
        responseDeadline: deadline,
      };
      return ok(path, { ...base, payload, actor: ACTOR });
    }
    case 'convert': {
      const currency = f.get('currency').trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) return fail('commerce.convert.currencyInvalid', 'currency');
      const deadline = localToTimestamp(f.get('deadline'));
      if (!deadline || Date.parse(deadline) <= Date.now()) return fail('commerce.convert.deadlineInvalid', 'deadline');
      const typed = f.get('ceiling').trim();
      const ceiling = typed ? toMinor(typed, currency) : null;
      if (typed && ceiling === null) return fail('commerce.amountInvalid', 'ceiling');
      const notes = f.get('notes').trim();
      const privateConstraint = ceiling !== null || notes ? { budgetCeiling: ceiling !== null ? { minorUnits: ceiling, currency } : null, evaluationWeights: {}, internalNotes: notes, shortlist: [] } : null;
      return ok(path, { ...base, rfq: { currency, responseDeadline: deadline, paymentTermsRequested: f.get('payment').trim() || null, attachments: [], category: null }, privateConstraint, actor: ACTOR });
    }
    case 'private': {
      const typed = f.get('ceiling').trim();
      const ceiling = typed ? toMinor(typed, shape.currency) : null;
      if (typed && ceiling === null) return fail('commerce.amountInvalid', 'ceiling');
      return ok(path, { ...base, budgetCeiling: ceiling === null ? null : { minorUnits: ceiling, currency: shape.currency }, evaluationWeights: {}, internalNotes: f.get('notes').trim(), shortlist: [] });
    }
    case 'invite': {
      const [kind, id] = f.get('supplier').split(':');
      if ((kind !== 'company' && kind !== 'person') || !id) return fail('commerce.invite.choose', 'supplier');
      return ok(path, { ...base, party: { kind, id }, channel: 'platform', actor: ACTOR });
    }
    case 'amendment': {
      const count = Number(f.get('lines')) || 0;
      const changes: Array<Record<string, unknown>> = [];
      for (let i = 0; i < count; i++) {
        const price = f.get(`line.${i}.price`).trim();
        const reason = f.get(`line.${i}.reason`).trim();
        if (!price && !reason) continue;
        const minor = price ? toMinor(price, shape.currency) : null;
        if (price && minor === null) return fail('commerce.amountInvalid', `line.${i}.price`);
        changes.push({ lineId: f.get(`line.${i}.lineId`), quantity: null, targetUnitPrice: minor === null ? null : { minorUnits: minor, currency: shape.currency }, reason: reason || null });
      }
      if (changes.length === 0) return fail('commerce.negotiation.nothingAsked', 'line.0.price');
      const total = f.get('total').trim();
      const totalMinor = total ? toMinor(total, shape.currency) : null;
      if (total && totalMinor === null) return fail('commerce.amountInvalid', 'total');
      return ok(path, { ...base, changes, targetTotal: totalMinor === null ? null : { minorUnits: totalMinor, currency: shape.currency }, actor: ACTOR });
    }
    case 'accept': {
      if (!f.checked('consent')) return fail('commerce.consent.required', 'consent');
      return ok(path, { ...base, electronicRecords: { consented: true, disclosureKey: f.get('disclosureKey') }, actor: ACTOR });
    }
    case 'placeOrder': {
      const budget = f.get('budget').trim();
      if (!budget) return fail('commerce.order.budgetRequired', 'budget');
      return ok(path, { ...base, transactionBudgetId: budget, platformBudgetId: null, externalReference: f.get('reference').trim() || null, actor: ACTOR });
    }
    case 'quote':
      return buildQuote(shape, path, base, f, intent);
  }
}

type QuoteLineIn = { lineId: string; rfqLineId: string | null; kind: string; specSnapshot: Record<string, string>; substitution: { forRfqLineId: string; reason: string } | null; options: unknown[] };

function buildQuote(shape: Extract<Shape, { kind: 'quote' }>, path: `/v1/${string}`, base: Record<string, unknown>, f: FieldReader, intent: string | null): Built {
  const { currency } = shape;
  const original = shape.payload as { lines: QuoteLineIn[]; deliveryTerms: { location: string } };
  const built = [];
  const floors: Record<string, { minorUnits: string; currency: string }> = {};
  for (let i = 0; i < original.lines.length; i++) {
    const before = original.lines[i]!;
    const p = `q.${i}.`;
    const value = quantityValue(f.get(`${p}quantity`));
    if (!value) return fail('commerce.lines.quantityInvalid', `${p}quantity`);
    const price = toMinor(f.get(`${p}price`), currency);
    if (price === null) return fail('commerce.amountInvalid', `${p}price`);
    const tax = (f.get(`${p}tax`) || 'none') as TaxKind;
    const rate = tax === 'none' ? null : rateValue(f.get(`${p}rate`) || '0');
    if (tax !== 'none' && rate === null) return fail('commerce.quote.rateInvalid', `${p}rate`);
    const answers = before.rfqLineId ?? before.substitution?.forRfqLineId ?? null;
    const substitute = f.checked(`${p}substitution`) && answers !== null;
    const reason = f.get(`${p}reason`).trim();
    if (substitute && !reason) return fail('commerce.quote.reasonRequired', `${p}reason`);
    const floor = f.get(`${p}floor`).trim();
    if (floor) {
      const minor = toMinor(floor, currency);
      if (minor === null) return fail('commerce.amountInvalid', `${p}floor`);
      floors[before.lineId] = { minorUnits: minor, currency };
    }
    built.push({
      lineId: before.lineId, rfqLineId: substitute ? null : answers, kind: before.kind, specSnapshot: before.specSnapshot, offeringVersionRef: null, quantity: { value, unit: f.get(`${p}unit`) },
      unitPrice: { minorUnits: price, currency }, tax: { kind: tax, ratePercent: rate, included: false },
      ...lineAmounts({ unitPriceMinor: price, quantity: value, tax, ratePercent: rate, currency }),
      substitution: substitute && answers ? { forRfqLineId: answers, reason } : null, options: before.options,
    });
  }
  const milestones = [];
  const count = Number(f.get('milestones')) || 0;
  for (let i = 0; i < count; i++) {
    const description = f.get(`m.${i}.description`).trim();
    const due = f.get(`m.${i}.due`);
    if (!description && !due) continue;
    if (!description || !due) return fail('commerce.quote.milestoneInvalid', `m.${i}.description`);
    milestones.push({ description, due: { date: due, timeZone: f.get('timeZone') || localTimeZone() } });
  }
  const typed = f.get('validity');
  const until = typed === shape.validity.local ? shape.validity.value : localToTimestamp(typed);
  if (!until || Date.parse(until) <= Date.now()) return fail('commerce.quote.validityInvalid', 'validity');
  const payload = {
    ...shape.payload,
    lines: built,
    totals: totals(built, currency),
    deliveryTerms: { milestones, location: f.get('location').trim() || original.deliveryTerms.location },
    paymentTerms: f.get('paymentTerms').trim(),
    validity: { until },
    exclusions: f.get('exclusions').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 50),
  };
  const steps: Step[] = [
    { path, payload: { ...base, payload, actor: ACTOR } },
    { path: shape.privatePath, payload: { expectedRevision: shape.privateRevision, floorPrices: floors, marginTargets: {}, costBasis: {}, negotiationNotes: f.get('notes').trim() } },
  ];
  if (intent === 'send') steps.push({ path: shape.sendPath, payload: { quoteId: base.quoteId, version: base.version, expectedRevision: 0, actor: ACTOR }, revisionFromQuote: true });
  const first: Record<string, unknown> = { ...steps[0]!.payload };
  delete first.quoteId;
  delete first.version;
  steps[0] = { ...steps[0]!, payload: first };
  return { ok: true, steps };
}
