import { z } from 'zod';
import { consoleCommand, DatasetOutputSchema, DatasetSubjectSchema, LegalBasisSchema, PersonalDataCategorySchema } from '../../deps/contracts.js';

/**
 * Console commands of the datasets routes (MINE-001). Every command carries the console base (contract version,
 * idempotency key, staff reason); the vocabularies come from DatasetSchema's own enums in packages/contracts/src/hub.ts;
 * the database repeats every rule (people, court and debt rules, second persons, licences, provenance).
 */
const Id = z.uuid();
const Decimal01 = z.string().regex(/^(0(\.[0-9]{1,3})?|1(\.0{1,3})?)$/);
const Day = z.iso.date();

export const ProposeDatasetCommandSchema = consoleCommand({
  subject: DatasetSubjectSchema,
  name: z.string().trim().min(1).max(200),
  sourceIds: z.array(Id).min(1).max(20),
  purpose: z.string().trim().min(10).max(500),
  legalBasis: LegalBasisSchema,
  personalData: z.strictObject({ present: z.boolean(), naturalPersons: z.boolean(), categories: z.array(PersonalDataCategorySchema).max(6) }),
  impactAssessmentRef: Id.nullable(),
  retention: z.strictObject({ className: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), days: z.int().min(1).max(3650) }),
  outputs: z.array(DatasetOutputSchema).min(1).max(7),
  publicDisplay: z.boolean(),
  subjectNotice: z.boolean(),
  refreshScheduleId: Id.nullable(),
});
export const ActivateDatasetCommandSchema = consoleCommand({ expectedRevision: z.int().min(1), approvalId: Id.nullable() });
export const DatasetStatusCommandSchema = consoleCommand({ expectedRevision: z.int().min(1), to: z.enum(['paused', 'retired']) });
export const DatasetLicenceCommandSchema = consoleCommand({
  supplier: z.string().trim().min(1).max(200),
  agreementDigest: z.string().regex(/^[a-f0-9]{64}$/),
  agreementRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$/),
  purposes: z.array(DatasetOutputSchema).min(1).max(7),
  uses: z.strictObject({ display: z.boolean(), enrich: z.boolean(), contactUse: z.boolean(), syndicate: z.boolean() }),
  validFrom: Day,
  validUntil: Day,
}).refine((c) => c.validUntil >= c.validFrom, { message: 'the licence ends after it starts', path: ['validUntil'] });
export const ContactUseCommandSchema = consoleCommand({ expectedRevision: z.int().min(1), allowed: z.boolean() });
export const MarkContactCommandSchema = consoleCommand({ allowed: z.boolean() });
export const DoNotCollectCommandSchema = consoleCommand({
  kind: z.enum(['identifier', 'domain', 'email']),
  value: z.string().trim().min(1).max(320),
  entryReason: z.enum(['objection', 'erasure', 'legal_demand', 'operator_decision']),
});
/** An operator file or a staff run: records with their source and URL; provenance and licence come from the source. */
export const IngestCommandSchema = consoleCommand({
  records: z.array(z.strictObject({
    sourceId: Id,
    externalKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$/),
    identifierKind: z.string().regex(/^[A-Z]{2}(?:-[A-Z0-9]{1,3})?-[A-Z][A-Z0-9]{1,11}$/).nullable(),
    identifierValue: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ./-]{0,63}$/).nullable(),
    naturalPerson: z.boolean(),
    fields: z.record(z.string().regex(/^[a-z][a-zA-Z0-9_]{0,60}$/), z.string().max(2000)),
    sourceUrl: z.url({ protocol: /^https$/ }).max(2000),
    method: z.enum(['register_api', 'structured_feed', 'page_markup', 'manual', 'operator_file']),
  }).refine((r) => (r.identifierKind === null) === (r.identifierValue === null), { message: 'identifier kind and value come together' })).min(1).max(500),
});
export const ResolveCommandSchema = consoleCommand({});
const Evidence = z.strictObject({
  kind: z.enum(['identifier_match', 'name_address_similarity', 'register_officer_match', 'signed_statement', 'subject_confirmation', 'peer_link']),
  detail: z.string().trim().min(1).max(500),
  similarity: Decimal01.nullable(),
});
const TargetKind = z.enum(['company', 'person', 'dataset_record']);
export const ProposeLinkCommandSchema = consoleCommand({ recordId: Id, targetKind: TargetKind, targetId: Id, evidence: z.array(Evidence).min(1).max(6), confidence: Decimal01 });
export const DecideLinkCommandSchema = consoleCommand({ expectedRevision: z.int().min(1), decision: z.enum(['accepted', 'rejected', 'withdrawn']) });
export const MarkDistinctCommandSchema = consoleCommand({ recordId: Id, targetKind: TargetKind, targetId: Id, distinctReason: z.string().trim().min(10).max(500) });
export const BatchDecisionCommandSchema = consoleCommand({
  proposalIds: z.array(Id).min(1).max(1000),
  sampleIds: z.array(Id).min(1).max(1000),
  decision: z.enum(['accepted', 'rejected']),
});
export const LinksQuerySchema = z.strictObject({ state: z.enum(['proposed', 'accepted', 'rejected', 'withdrawn']).optional() });
