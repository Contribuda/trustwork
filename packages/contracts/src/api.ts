import { z } from 'zod';
import { AdminAuditEventSchema, CaseAccessGrantSchema } from './admin.js';
import { ObjectParticipationSchema, PolicyDecisionSchema } from './access.js';
import { ActionIntentSchema, MandateSchema } from './assistant.js';
import { BudgetSchema, PriceVersionSchema, ReservationSchema } from './billing.js';
import { ErrorEnvelopeSchema } from './common/errors.js';
import { IdempotencyKeySchema } from './common/idempotency.js';
import { RevisionSchema } from './common/ids.js';
import { PublicCompanySchema } from './company.js';
import { IssueSchema, PublicationSchema } from './content.js';
import { LoginCommandSchema, PublicPersonSchema, SessionViewSchema, SignupCommandSchema } from './identity.js';
import { PublicRfqSchema, SharedRfqVersionSchema } from './procurement.js';
import { PublicProjectSchema } from './projects.js';
import { EmbeddingConfigSchema, IndexGenerationSchema, SearchRequestSchema, StructuredFactSchema } from './retrieval.js';
import { SharedQuoteVersionSchema } from './sales.js';
import { PlaceOrderCommandSchema, SharedAgreementSchema } from './transactions.js';

export const API_VERSION = 'v1' as const;
export const API_PREFIX = `/${API_VERSION}` as const;
/** Single public origin: `/v1/*` is proxied to the API process; no CORS for first-party traffic. */
export const SESSION_COOKIE = '__Host-sr_session' as const;
export const FLOW_COOKIE = '__Host-sr_flow' as const;
export const CSRF_HEADER = 'X-Trustwork-Request' as const;
export const REQUEST_ID_HEADER = 'X-Request-Id' as const;
export function apiPath(path: `/${string}`): string {
  return `${API_PREFIX}${path}`;
}

/** Liveness (`GET /health`, `GET /health/live`); `externalProviders` reports the configured provider mode truthfully. */
export const HealthSchema = z.strictObject({ status: z.literal('ok'), mode: z.literal('bootstrap'), externalProviders: z.enum(['disabled', 'fake', 'live']) });
export type Health = z.infer<typeof HealthSchema>;
export const health: Health = { status: 'ok', mode: 'bootstrap', externalProviders: 'disabled' };
/**
 * Readiness (`GET /health/ready`, 200 when `ready`, 503 otherwise): the database answers and the migration ledger
 * matches the migrations the running build ships. States and migration file names only; never error text.
 */
export const ReadinessSchema = z.strictObject({
  status: z.enum(['ready', 'not_ready']),
  checks: z.strictObject({
    database: z.enum(['ok', 'unreachable', 'timeout', 'not_configured']),
    ledger: z.enum(['ok', 'schema_ahead', 'pending', 'checksum_mismatch', 'missing', 'out_of_order', 'unreadable', 'unverifiable', 'not_checked']),
  }),
  /** Latest migration recorded in the ledger. */
  schemaVersion: z.string().min(1).nullable(),
  /** Latest migration shipped with the running build. */
  expectedSchemaVersion: z.string().min(1).nullable(),
});
export type Readiness = z.infer<typeof ReadinessSchema>;

/** Every mutation carries an idempotency key; versioned edits add `expectedRevision`. Unknown fields are rejected (strict objects). */
export const MutationEnvelopeSchema = z.strictObject({ idempotencyKey: IdempotencyKeySchema, expectedRevision: RevisionSchema.optional() });
export function mutation<T extends z.ZodRawShape>(shape: T) {
  return z.strictObject({ ...MutationEnvelopeSchema.shape, ...shape });
}
/** Durable commands return an action id; acknowledgement never implies the external effect happened. */
export const CommandAcceptedSchema = z.strictObject({ actionId: z.string().min(1), state: z.enum(['proposed', 'authorized', 'reserved', 'queued']), revision: RevisionSchema });
export const RevisionedResultSchema = z.strictObject({ id: z.string().min(1), revision: RevisionSchema });

/** JSON Schema is generated from the Zod source (draft 2020-12) so OpenAPI never diverges from the accepted contract. */
export const CONTRACT_SCHEMAS = {
  ErrorEnvelope: ErrorEnvelopeSchema,
  Health: HealthSchema,
  Readiness: ReadinessSchema,
  SignupCommand: SignupCommandSchema,
  LoginCommand: LoginCommandSchema,
  SessionView: SessionViewSchema,
  PublicPerson: PublicPersonSchema,
  PublicCompany: PublicCompanySchema,
  PublicProject: PublicProjectSchema,
  ObjectParticipation: ObjectParticipationSchema,
  PolicyDecision: PolicyDecisionSchema,
  PublicRfq: PublicRfqSchema,
  SharedRfqVersion: SharedRfqVersionSchema,
  SharedQuoteVersion: SharedQuoteVersionSchema,
  SharedAgreement: SharedAgreementSchema,
  PlaceOrderCommand: PlaceOrderCommandSchema,
  Mandate: MandateSchema,
  ActionIntent: ActionIntentSchema,
  Budget: BudgetSchema,
  Reservation: ReservationSchema,
  PriceVersion: PriceVersionSchema,
  Publication: PublicationSchema,
  Issue: IssueSchema,
  SearchRequest: SearchRequestSchema,
  StructuredFact: StructuredFactSchema,
  EmbeddingConfig: EmbeddingConfigSchema,
  IndexGeneration: IndexGenerationSchema,
  AdminAuditEvent: AdminAuditEventSchema,
  CaseAccessGrant: CaseAccessGrantSchema,
  CommandAccepted: CommandAcceptedSchema,
} as const;
export function contractJsonSchemas(): Record<keyof typeof CONTRACT_SCHEMAS, Record<string, unknown>> {
  const out = {} as Record<keyof typeof CONTRACT_SCHEMAS, Record<string, unknown>>;
  for (const [name, schema] of Object.entries(CONTRACT_SCHEMAS) as [keyof typeof CONTRACT_SCHEMAS, z.ZodType][]) {
    out[name] = z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any' }) as Record<string, unknown>;
  }
  return out;
}
