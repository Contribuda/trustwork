import type { z } from 'zod';
import { computeDigest, digestEquals, verifyDigest } from '../common/digest.js';
import { sameVersion, type VersionRefSchema } from '../common/version.js';
import { rfqVersionDigestInput, type RfqVersion, type RfqVersionPayload } from '../procurement.js';
import { isQuoteStale, quoteVersionDigestInput, type QuoteVersion, type QuoteVersionPayload } from '../sales.js';
import { AcceptanceEventRecordSchema, AgreementRecordSchema, agreementDigestInput } from '../transactions.js';

/**
 * Server-only commercial digest computation and the acceptance guard (node:crypto through `common/digest.ts`).
 * Not part of the `./client` entry: clients receive digests from the server and only compare them.
 */
type VersionRef = z.infer<typeof VersionRefSchema>;

export function computeRfqVersionDigest(payload: RfqVersionPayload) {
  return computeDigest(rfqVersionDigestInput(payload));
}
export function verifyRfqVersionDigest(version: RfqVersion): boolean {
  return version.digest !== null && verifyDigest(rfqVersionDigestInput(version.payload), version.digest);
}
export function computeQuoteVersionDigest(rfqVersion: VersionRef, payload: QuoteVersionPayload) {
  return computeDigest(quoteVersionDigestInput(rfqVersion, payload));
}
export function verifyQuoteVersionDigest(version: QuoteVersion): boolean {
  return version.digest !== null && verifyDigest(quoteVersionDigestInput(version.rfqVersion, version.payload), version.digest);
}
export function computeAgreementDigest(quoteVersion: VersionRef, rfqVersion: VersionRef) {
  return computeDigest(agreementDigestInput(quoteVersion, rfqVersion));
}

/** Server validation of an acceptance event: the recorded digest must equal the digest of the pinned versions. */
export const AcceptanceEventSchema = AcceptanceEventRecordSchema.refine((e) => digestEquals(e.acceptedTermsDigest, computeAgreementDigest(e.quoteVersion, e.rfqVersion)), {
  message: 'acceptedTermsDigest must equal the digest of the pinned versions',
  path: ['acceptedTermsDigest'],
});
/** Server validation of an agreement: `acceptedTerms.digest` is recomputed from the two version refs. */
export const AgreementSchema = AgreementRecordSchema.refine((a) => digestEquals(a.acceptedTerms.digest, computeAgreementDigest(a.acceptedTerms.quoteVersion, a.acceptedTerms.rfqVersion)), {
  message: 'acceptedTerms.digest must be the digest of the pinned versions',
  path: ['acceptedTerms', 'digest'],
});

export type AcceptanceCheck = 'ok' | 'commercial.stale_version' | 'commercial.quote_not_acceptable' | 'commercial.quote_expired' | 'commercial.digest_mismatch' | 'commercial.rfq_version_mismatch';
/**
 * Acceptance requires identity (quote pinned to the current RFQ version), status `sent`, stored-payload integrity of both
 * versions, validity taken from the frozen payload, and then that the supplied quote ref (id, version, digest) and the
 * pinned RFQ digest match the stored rows.
 */
export function checkAcceptance(input: { quoteVersion: QuoteVersion; quoteRef: VersionRef; currentRfqVersion: RfqVersion; now: Date }): AcceptanceCheck {
  const { quoteVersion, quoteRef, currentRfqVersion, now } = input;
  if (currentRfqVersion.status !== 'published' || currentRfqVersion.digest === null) return 'commercial.rfq_version_mismatch';
  if (isQuoteStale(quoteVersion.rfqVersion.id, currentRfqVersion.id)) return 'commercial.stale_version';
  if (quoteVersion.status !== 'sent' || quoteVersion.digest === null || quoteVersion.validUntil === null) return 'commercial.quote_not_acceptable';
  if (!verifyQuoteVersionDigest(quoteVersion) || !verifyRfqVersionDigest(currentRfqVersion)) return 'commercial.digest_mismatch';
  if (Date.parse(quoteVersion.payload.validity.until) <= now.getTime()) return 'commercial.quote_expired';
  const stored = { id: quoteVersion.id, version: quoteVersion.version, digest: quoteVersion.digest };
  if (!sameVersion(quoteRef, stored) || quoteRef.version !== stored.version || !digestEquals(quoteRef.digest, stored.digest)) return 'commercial.digest_mismatch';
  if (!digestEquals(quoteVersion.rfqVersion.digest, currentRfqVersion.digest)) return 'commercial.digest_mismatch';
  return 'ok';
}
