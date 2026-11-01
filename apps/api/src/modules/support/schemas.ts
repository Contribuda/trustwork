import { z } from 'zod';
import { ACCOUNT_SERVICE_ACTIONS, consoleCommand, ResourceKindSchema, CapabilitySchema } from '../../deps/contracts.js';

/**
 * Request schemas of the support workspace (SUP-001). Staff commands are console commands (`consoleCommand` of the
 * frozen HUBC-000 contract: contract version, an idempotency key equal to the `Idempotency-Key` header, a staff
 * reason) plus an optional machine reason code. Participant bodies are plain strict objects. Strict objects reject
 * unknown fields, so no request can carry a score, a rank, a position, a badge or a weight (tests/support walk them).
 * No schema names a person to "act as": every action is the caller's own, on a case.
 */
const Uuid = z.uuid();
const ReasonCode = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const command = <T extends z.ZodRawShape>(shape: T) => consoleCommand({ reasonCode: ReasonCode.optional(), ...shape });
const Category = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/);
const Summary = z.string().trim().min(1).max(500);
const NoteBody = z.string().trim().min(1).max(4000);
export const UuidParams = z.strictObject({ id: Uuid });
export const CasePersonParams = z.strictObject({ id: Uuid, personId: Uuid });

/* ---------- Staff ---------- */

export const PlainCommandSchema = command({});
/** The hub defaults to the one this deployment serves (`TRUSTWORK_HUB_ID`); the database authorizes at that hub. */
const HubId = Uuid.optional();
export const OpenCaseCommandSchema = command({
  hubId: HubId,
  requesterPersonId: Uuid,
  subject: z.strictObject({ kind: z.enum(['person', 'company']), id: Uuid }),
  category: Category,
  summary: Summary,
  urgency: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
});
export const UpdateCaseCommandSchema = command({
  status: z.enum(['triaged', 'waiting_on_requester', 'grant_requested', 'in_progress', 'resolved', 'closed', 'open']).optional(),
  assignedTo: Uuid.optional(),
  urgency: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  resolutionCode: Category.optional(),
});
export const StaffNoteCommandSchema = command({ body: NoteBody, visibility: z.enum(['internal', 'requester']) });
export const CasesQuerySchema = z.strictObject({ status: z.enum(['open', 'triaged', 'waiting_on_requester', 'grant_requested', 'in_progress', 'resolved', 'closed']).optional() });

/** A lookup is a query, not a command: no idempotency key, recorded with its case. */
export const LookupQuerySchema = z.strictObject({
  hubId: HubId,
  caseId: Uuid.nullable().optional(),
  kind: z.enum(['email', 'person_id', 'company_id', 'legal_identifier', 'name', 'company_name']),
  value: z.string().trim().min(1).max(254),
  reason: z.string().min(1).max(500),
});
export const ExplainQuerySchema = z.strictObject({
  subjectPersonId: Uuid,
  resource: z.strictObject({ kind: ResourceKindSchema, id: Uuid }),
  capability: CapabilitySchema.refine((c) => !c.startsWith('staff.'), { message: 'participant capabilities only' }).optional(),
  reason: z.string().min(1).max(500),
});
export const AccountCardQuerySchema = z.strictObject({ reason: z.string().min(1).max(500) });

const GuidedTaskCode = z.string().regex(/^[a-z][a-z0-9_]{1,60}$/);
export const RequestActionCommandSchema = command({
  subjectPersonId: Uuid,
  action: z.enum(ACCOUNT_SERVICE_ACTIONS),
  evidenceRefs: z.array(Uuid).max(10).optional(),
  /** Rebind only: the address the person will prove from its mailbox. */
  newEmail: z.email().max(254).optional(),
  /** Guided task only: the code of a structured task the person performs in their own session. */
  taskCode: GuidedTaskCode.optional(),
})
  .refine((b) => (b.action === 'rebind_recovery_email') === (b.newEmail !== undefined), { message: 'newEmail goes with rebind_recovery_email only', path: ['newEmail'] })
  .refine((b) => (b.action === 'send_guided_task') === (b.taskCode !== undefined), { message: 'taskCode goes with send_guided_task only', path: ['taskCode'] });

/* ---------- Participant ---------- */

export const OpenOwnCaseSchema = z.strictObject({ hubId: HubId, forCompany: z.boolean().optional(), category: Category, summary: Summary });
export const OwnNoteSchema = z.strictObject({ body: NoteBody });
export const OwnCaseUpdateSchema = z.strictObject({ status: z.enum(['triaged', 'open', 'closed']) });
export const ShareDiagnosticsSchema = z.strictObject({
  pageId: z.string().regex(/^[a-z0-9][a-z0-9_./:-]{0,127}$/),
  appVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/),
  locale: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/).nullable().optional(),
  featureFlags: z.array(z.string().regex(/^[a-z][a-z0-9_.]{0,79}$/)).max(50).optional(),
  errorCodes: z.array(z.string().regex(/^[a-z][a-z0-9_.]{0,79}$/)).max(50).optional(),
  requestIds: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)).max(50).optional(),
  /** Only the objects the person selects; references, never content. */
  objects: z.array(z.strictObject({ type: ResourceKindSchema, id: Uuid })).max(20).optional(),
});

/** Every request schema of the module, walked by tests/support for forbidden control words. */
export const SUPPORT_REQUEST_SCHEMAS = {
  PlainCommandSchema, OpenCaseCommandSchema, UpdateCaseCommandSchema, StaffNoteCommandSchema, CasesQuerySchema, LookupQuerySchema, ExplainQuerySchema, AccountCardQuerySchema,
  RequestActionCommandSchema, OpenOwnCaseSchema, OwnNoteSchema, OwnCaseUpdateSchema, ShareDiagnosticsSchema,
} as const;
