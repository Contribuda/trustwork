import type { SuppressionEntry } from './schemas.js';

/* The exact suppression lookup of HC-175 (OUTR-004), kept free of React so the scans and unit tests can call it. */

/** Exact-match normalisation of an identifier: an address or domain compared without case or surrounding space. */
export function normaliseIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

/** The one suppression entry for an exact identifier, or null; there is no partial match and no listing. */
export function exactSuppression(ledger: readonly SuppressionEntry[], query: string): SuppressionEntry | null {
  const wanted = normaliseIdentifier(query);
  if (wanted.length < 3 || wanted.length > 320) return null;
  return ledger.find((e) => normaliseIdentifier(e.identifier) === wanted) ?? null;
}
