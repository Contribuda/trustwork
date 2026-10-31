import { decimalToScaled, type Money } from '@trustwork/contracts/client';

/**
 * Exact quote arithmetic for the seller's editor (WEB-002). The API recomputes and refuses totals that do not add up
 * (`commercial.totals_mismatch`), so the editor uses the same integer rules: the line total is unit price times
 * quantity rounded half-even to a minor unit, the tax amount is the line total times the stated rate (percent) rounded
 * half-even, an untaxed line carries no tax, and net, tax and gross are plain sums.
 */
export type TaxKind = 'vat' | 'none' | 'other';

function divideHalfEven(n: bigint, d: bigint): bigint {
  const negative = n < 0n !== d < 0n;
  const [an, ad] = [n < 0n ? -n : n, d < 0n ? -d : d];
  let q = an / ad;
  const r = an % ad;
  if (r * 2n > ad || (r * 2n === ad && q % 2n === 1n)) q += 1n;
  return negative ? -q : q;
}

export function lineTotalMinor(unitPriceMinor: string, quantity: string): bigint {
  const { scaled, scale } = decimalToScaled(quantity);
  return divideHalfEven(BigInt(unitPriceMinor) * scaled, 10n ** BigInt(scale));
}

export function taxMinor(lineTotal: bigint, kind: TaxKind, ratePercent: string | null): bigint {
  if (kind === 'none' || !ratePercent) return 0n;
  const { scaled, scale } = decimalToScaled(ratePercent);
  return divideHalfEven(lineTotal * scaled, 100n * 10n ** BigInt(scale));
}

export type LineAmounts = { lineTotal: Money; taxAmount: Money };

export function lineAmounts(input: { unitPriceMinor: string; quantity: string; tax: TaxKind; ratePercent: string | null; currency: string }): LineAmounts {
  const total = lineTotalMinor(input.unitPriceMinor, input.quantity);
  return { lineTotal: { minorUnits: total.toString(), currency: input.currency }, taxAmount: { minorUnits: taxMinor(total, input.tax, input.ratePercent).toString(), currency: input.currency } };
}

export function totals(lines: readonly LineAmounts[], currency: string): { net: Money; tax: Money; gross: Money } {
  const net = lines.reduce((sum, l) => sum + BigInt(l.lineTotal.minorUnits), 0n);
  const tax = lines.reduce((sum, l) => sum + BigInt(l.taxAmount.minorUnits), 0n);
  return { net: { minorUnits: net.toString(), currency }, tax: { minorUnits: tax.toString(), currency }, gross: { minorUnits: (net + tax).toString(), currency } };
}

/** Whether a price is below the seller's private floor (same currency; a different currency counts as below, like the API's agent rule). */
export function belowFloor(unitPriceMinor: string, currency: string, floor: Money | null | undefined): boolean {
  if (!floor) return false;
  return floor.currency !== currency || BigInt(unitPriceMinor) < BigInt(floor.minorUnits);
}
