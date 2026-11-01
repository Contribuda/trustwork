import type { PublicFee, PublicPrice, PublicPricing } from '@trustwork/contracts/client';

export const PRICE_SECTIONS = ['plans', 'services', 'models', 'capabilities', 'credit_packs', 'fees', 'events', 'verification'] as const;
export type PriceSection = typeof PRICE_SECTIONS[number];
export type PriceRow = { type: 'fee'; value: PublicFee } | { type: 'price'; value: PublicPrice };
export type SectionState = 'available' | 'empty' | 'unavailable' | 'error';
export type PricingSection = { key: PriceSection; state: SectionState; current: PriceRow[]; future: PriceRow[] };

function sectionFor(row: PriceRow): PriceSection {
  if (row.type === 'fee') return ['ticket', 'course'].includes(row.value.terms.kind) ? 'events' : 'fees';
  const kind = row.value.kind;
  return kind === 'plan' ? 'plans' : kind === 'model' ? 'models' : kind === 'capability' ? 'capabilities'
    : kind === 'credit_pack' ? 'credit_packs' : kind === 'verification_fee' ? 'verification' : 'services';
}
function interval(row: PriceRow) { return row.type === 'fee' ? row.value.terms : row.value; }

/** Read-only presentation. It never infers commercial categories or grants purchase authority. */
export function pricingView(pricing: PublicPricing | null, at: string) {
  at = pricing?.coverage?.generatedAt ?? at;
  const now = Date.parse(at);
  const rows: PriceRow[] = pricing ? [
    ...pricing.fees.map(value => ({ type: 'fee' as const, value })),
    ...pricing.prices.map(value => ({ type: 'price' as const, value })),
  ] : [];
  const sections: PricingSection[] = PRICE_SECTIONS.map(key => {
    const selected = rows.filter(row => sectionFor(row) === key &&
      (interval(row).effectiveTo === null || Date.parse(interval(row).effectiveTo!) > now));
    selected.sort((a, b) => {
      const scope = (r: PriceRow) => r.type === 'fee' ? `${r.value.terms.kind}/${r.value.terms.categoryKey ?? ''}/${r.value.terms.payer}` : r.value.code;
      const aa = `${scope(a)}/${interval(a).effectiveFrom}/${a.value.id}`;
      const bb = `${scope(b)}/${interval(b).effectiveFrom}/${b.value.id}`;
      return aa < bb ? -1 : aa > bb ? 1 : 0;
    });
    const source = key === 'events' ? 'fees' : key === 'verification' ? 'services' : key;
    const coverage = pricing?.coverage?.sections[source];
    const state: SectionState = !pricing ? 'error' : coverage === 'error' ? 'error' : coverage === 'unavailable' ? 'unavailable'
      : selected.length ? 'available' : coverage === 'available' ? 'empty' : 'unavailable';
    return { key, state,
      current: selected.filter(row => Date.parse(interval(row).effectiveFrom) <= now),
      future: selected.filter(row => Date.parse(interval(row).effectiveFrom) > now) };
  });
  const state: 'error' | 'unconfigured' | 'complete' | 'partial' = !pricing ? 'error' : !pricing.hubId ? 'unconfigured'
    : pricing.coverage && Object.values(pricing.coverage.sections).every(value => value === 'available') ? 'complete' : 'partial';
  return { hubId: pricing?.hubId ?? null, at, state, sections };
}
