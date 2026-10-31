import { z } from 'zod';
import { PartySchema } from '../access.js';
import { Sha256HexSchema } from '../common/digest-schema.js';
import { IdSchema, TimestampSchema } from '../common/ids.js';
import { VersionNumberSchema } from '../common/version.js';
import { transitionGuard } from './common.js';

/**
 * Document types, requirement sets, completeness and e-document exchange (PRC-012). Document types are country-pack
 * data; the engine knows no country. Exchange goes through network adapters with fakes; unknown outcomes reconcile.
 */

/** A document type from the bound country pack, for example `{ pack: 'US', key: 'certificate_of_insurance' }`. */
export const DocumentTypeRefSchema = z.strictObject({ pack: z.string().regex(/^[A-Z]{2}$/), key: z.string().regex(/^[a-z0-9][a-z0-9_.-]{1,79}$/) });
export type DocumentTypeRef = z.infer<typeof DocumentTypeRefSchema>;
const typeId = (t: DocumentTypeRef) => `${t.pack}:${t.key}`;

export const RequirementSubjectKindSchema = z.enum(['supplier_onboarding', 'order', 'goods_receipt', 'trade_invoice', 'payment', 'project_handover']);

export const DocumentRequirementSetSchema = z.strictObject({
  id: IdSchema,
  owner: PartySchema.nullable(),
  /** Hub template when `owner` is null. */
  hubId: IdSchema.nullable(),
  subjectKind: RequirementSubjectKindSchema,
  version: VersionNumberSchema,
  payload: z.strictObject({
    requirements: z.array(z.strictObject({ type: DocumentTypeRefSchema, required: z.boolean(), mustBeUnexpired: z.boolean(), blocksPayment: z.boolean() })).min(1).max(50),
  }).refine((p) => new Set(p.requirements.map((r) => typeId(r.type))).size === p.requirements.length, { message: 'each document type once', path: ['requirements'] }),
  status: z.enum(['draft', 'active', 'superseded']),
}).refine((s) => (s.owner === null) !== (s.hubId === null), { message: 'a company set or a hub template', path: ['owner'] });
export type DocumentRequirementSet = z.infer<typeof DocumentRequirementSetSchema>;

export const DocumentLinkStatusSchema = z.enum(['missing', 'received', 'in_review', 'approved', 'rejected', 'expired']);
export const DocumentLinkSchema = z.strictObject({
  id: IdSchema,
  subject: z.strictObject({ kind: z.string().regex(/^[a-z_]{3,40}$/), id: IdSchema }),
  type: DocumentTypeRefSchema,
  /** Exactly one source once something was received. */
  fileId: IdSchema.nullable(),
  intakeDocumentId: IdSchema.nullable(),
  eDocumentExchangeId: IdSchema.nullable(),
  status: DocumentLinkStatusSchema,
  validUntil: z.iso.date().nullable(),
  approvalRequestId: IdSchema.nullable(),
}).refine((l) => [l.fileId, l.intakeDocumentId, l.eDocumentExchangeId].filter((x) => x !== null).length === (l.status === 'missing' ? 0 : 1), { message: 'a received document has exactly one source', path: ['fileId'] });
export type DocumentLink = z.infer<typeof DocumentLinkSchema>;

export type Completeness = { complete: boolean; paymentBlocked: boolean; present: string[]; missing: string[]; expired: string[]; inReview: string[] };

/** Completeness = every required type approved and, where required, unexpired on `today` (ISO date). */
export function documentCompleteness(set: DocumentRequirementSet, links: readonly DocumentLink[], today: string): Completeness {
  const out: Completeness = { complete: true, paymentBlocked: false, present: [], missing: [], expired: [], inReview: [] };
  for (const req of set.payload.requirements) {
    const id = typeId(req.type);
    const mine = links.filter((l) => typeId(l.type) === id);
    const approved = mine.find((l) => l.status === 'approved' && !(req.mustBeUnexpired && l.validUntil !== null && l.validUntil < today));
    let bucket: 'present' | 'missing' | 'expired' | 'inReview';
    if (approved) bucket = 'present';
    else if (mine.some((l) => l.status === 'expired' || (l.status === 'approved' && l.validUntil !== null && l.validUntil < today))) bucket = 'expired';
    else if (mine.some((l) => l.status === 'received' || l.status === 'in_review')) bucket = 'inReview';
    else bucket = 'missing';
    out[bucket].push(id);
    if (bucket !== 'present' && req.required) {
      out.complete = false;
      if (req.blocksPayment) out.paymentBlocked = true;
    }
  }
  return out;
}

export const EDocumentExchangeStatusSchema = z.enum(['queued', 'sent', 'delivered', 'accepted', 'rejected', 'received', 'outcome_unknown']);
export type EDocumentExchangeStatus = z.infer<typeof EDocumentExchangeStatusSchema>;
/** `queued → sent → delivered → accepted | rejected`; inbound starts at `received`; `outcome_unknown` reconciles, never re-sends. */
export const E_DOCUMENT_EXCHANGE_TRANSITIONS: Readonly<Record<EDocumentExchangeStatus, readonly EDocumentExchangeStatus[]>> = {
  queued: ['sent', 'outcome_unknown'],
  sent: ['delivered', 'accepted', 'rejected', 'outcome_unknown'],
  delivered: ['accepted', 'rejected', 'outcome_unknown'],
  outcome_unknown: ['delivered', 'accepted', 'rejected'],
  accepted: [], rejected: [], received: [],
};
export const eDocumentExchangeTransitionAllowed = transitionGuard(E_DOCUMENT_EXCHANGE_TRANSITIONS);

export const EDocumentExchangeSchema = z.strictObject({
  id: IdSchema,
  /** Network key from the country pack, for example `peppol`, `mx-cfdi`, `br-nfe`. */
  network: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  direction: z.enum(['outbound', 'inbound']),
  document: z.strictObject({ kind: z.enum(['trade_invoice_version', 'credit_note', 'order', 'dispatch_notice']), id: IdSchema }),
  providerConnectionId: IdSchema,
  externalId: z.string().min(1).max(200).nullable(),
  payloadDigest: Sha256HexSchema,
  status: EDocumentExchangeStatusSchema,
  observedAt: TimestampSchema,
}).refine((e) => (e.direction === 'inbound') === (e.status === 'received'), { message: 'inbound exchanges are received; outbound ones are sent', path: ['status'] });
