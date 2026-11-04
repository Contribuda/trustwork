import { z } from 'zod';
import { IanaTimeZoneSchema, RevisionSchema, TimestampSchema } from './common/ids.js';
import { consoleCommand, HUB_STAFF_ROLES, HubConfigDomainSchema, HubStaffRoleSchema, StaffScopeSchema } from './hub.js';

/**
 * Console navigation services (ADM-005, docs/engine/hub-console/console-design.md sections 3.4, 3.5 and 6.2): the object
 * lookup behind the palette's `#`, one read model of a staff member's work, saved views, notification settings and the
 * rollout stage of a feature flag.
 *
 * The rule of this file: **what the console navigates by carries no free text.** A search request is one identifier; a
 * hit or a work item is identifiers, codes, integers and timestamps, each leaf a uuid, an enum or a closed pattern. No
 * name, e-mail, summary, title, purpose, reason or description appears, not of a participant and not of staff, because
 * those fields are where private data lives and the object's own screen already answers who may read them.
 * `tests/admin/console-services/schema-walk.test.ts` walks these schemas and fails on a free string.
 *
 * Plain words stay in the browser: sections, commands and help are filtered there from the viewer's own access, and
 * `@` names from the staff directory they may already read, so no name or address typed into the palette is ever sent.
 */

const UuidSchema = z.uuid();
const CodeSchema = z.string().regex(/^[a-z][a-z0-9_.]{0,80}$/, 'machine code');
/** A second-person action as the database names it: modules add actions (screening has its own), and one unknown to a client must not fail a list. */
export const ConsoleActionCodeSchema = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, 'second-person action');

/* ---------- Object lookup ---------- */

/** What a console lookup accepts: an object id or request id (uuid), a case or audit number, or a flag key. */
export const CONSOLE_REF_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const CONSOLE_REF_NUMBER = /^[1-9][0-9]{0,14}$/;
export const CONSOLE_REF_KEY = /^[a-z][a-z0-9_.]{2,80}$/;
export type ConsoleRef = { kind: 'id'; id: string } | { kind: 'number'; number: string } | { kind: 'key'; key: string };

/** Which kind of identifier a reference is; `null` for anything else (an address, a name with a capital, a phone with a plus). */
export function parseConsoleRef(value: string): ConsoleRef | null {
  if (CONSOLE_REF_UUID.test(value)) return { kind: 'id', id: value };
  if (CONSOLE_REF_NUMBER.test(value)) return { kind: 'number', number: value };
  if (CONSOLE_REF_KEY.test(value)) return { kind: 'key', key: value };
  return null;
}

/**
 * The console target of a read: a hub, the node, or (neither) the platform, as `TargetQuerySchema` of the staff routes.
 * An object is found only at exactly this target, so a person covering two hubs never gets one hub's object while
 * acting on the other.
 */
const TargetShape = { hubId: UuidSchema.optional(), nodeId: UuidSchema.optional() };
/** `StaffScopeSchema` with the identifiers this store uses, for commands that name a scope. */
const CommandScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('platform') }),
  z.strictObject({ kind: z.literal('node'), nodeId: UuidSchema }),
  z.strictObject({ kind: z.literal('hub'), hubId: UuidSchema }),
]);
const oneTarget = (q: { hubId?: string | undefined; nodeId?: string | undefined }): boolean => !(q.hubId && q.nodeId);

export const ConsoleSearchQuerySchema = z.strictObject({
  ...TargetShape,
  ref: z.string().min(1).max(81).refine((value) => parseConsoleRef(value) !== null, { message: 'an object id, a number or a flag key' }),
}).refine(oneTarget, { message: 'one target' });
export type ConsoleSearchQuery = z.infer<typeof ConsoleSearchQuerySchema>;

const AuditOutcomeSchema = z.enum(['applied', 'denied', 'failed']);
const IncidentSeveritySchema = z.enum(['sev1', 'sev2', 'sev3', 'sev4']);
const IncidentKindSchema = z.enum(['security', 'privacy_breach', 'provider', 'content', 'availability']);

/** The stages of a flag, narrowest first (console-design 6.2). The share is in deterministic buckets of people. */
export const FLAG_ROLLOUT_STAGES = ['off', 'staff_only', 'share', 'on'] as const;
export const FlagRolloutStageSchema = z.enum(FLAG_ROLLOUT_STAGES);
export type FlagRolloutStage = z.infer<typeof FlagRolloutStageSchema>;
export const FLAG_SHARE_PERCENTS = [1, 5, 25, 50] as const;
export const FlagSharePercentSchema = z.union([z.literal(1), z.literal(5), z.literal(25), z.literal(50)]);
export type FlagSharePercent = z.infer<typeof FlagSharePercentSchema>;

const hit = <K extends string, T extends z.ZodRawShape>(kind: K, shape: T) => z.strictObject({ kind: z.literal(kind), id: UuidSchema, scope: StaffScopeSchema, ...shape });
export const ConsoleSearchHitSchema = z.discriminatedUnion('kind', [
  hit('approval', { action: ConsoleActionCodeSchema, status: z.enum(['pending', 'approved', 'declined', 'revoked', 'consumed']) }),
  hit('config_version', { domain: HubConfigDomainSchema, version: z.int().min(1), status: z.enum(['draft', 'active', 'superseded', 'cancelled']) }),
  hit('incident', { incidentKind: IncidentKindSchema, severity: IncidentSeveritySchema, status: z.enum(['open', 'mitigated', 'resolved', 'closed']) }),
  hit('support_case', { number: z.int().min(1), status: z.enum(['open', 'triaged', 'waiting_on_requester', 'grant_requested', 'in_progress', 'resolved', 'closed']) }),
  hit('moderation_case', { status: z.enum(['open', 'in_review', 'decided', 'appealed', 'appeal_decided', 'closed']) }),
  hit('appeal', { status: z.enum(['submitted', 'in_review', 'upheld', 'overturned', 'partially_overturned', 'withdrawn']) }),
  hit('pipeline_run', { state: CodeSchema, dryRun: z.boolean() }),
  hit('audit_event', { sequence: z.int().min(1), action: z.string().regex(/^[a-z][A-Za-z0-9_.]{0,99}$/), outcome: AuditOutcomeSchema, occurredAt: TimestampSchema }),
  hit('flag', { key: CodeSchema, stage: FlagRolloutStageSchema, sharePercent: FlagSharePercentSchema.nullable(), expiresAt: TimestampSchema }),
  hit('staff', {}),
]);
export type ConsoleSearchHit = z.infer<typeof ConsoleSearchHitSchema>;

/**
 * The answer to a lookup. `hits` is empty, and the response is byte-identical, for an object that does not exist and for
 * one the reader may not read. There is deliberately no count, facet, total or suggestion: nothing here is computed
 * from rows the reader does not see. Hits are in a fixed order of kinds, then by number or id, never by a hidden field.
 */
export const ConsoleSearchResultSchema = z.strictObject({ hits: z.array(ConsoleSearchHitSchema).max(20) });
export type ConsoleSearchResult = z.infer<typeof ConsoleSearchResultSchema>;

/* ---------- Work items ---------- */

export const CONSOLE_WORK_VIEWS = ['waiting', 'mine', 'assigned', 'done'] as const;
export const ConsoleWorkViewSchema = z.enum(CONSOLE_WORK_VIEWS);
export type ConsoleWorkView = z.infer<typeof ConsoleWorkViewSchema>;

export const ConsoleWorkQuerySchema = z.strictObject({ ...TargetShape, view: ConsoleWorkViewSchema }).refine(oneTarget, { message: 'one target' });
export const ConsoleTargetQuerySchema = z.strictObject(TargetShape).refine(oneTarget, { message: 'one target' });

export const CONSOLE_WORK_KINDS = [
  'approval', 'recovery_escalation', 'case_grant', 'access_review_item', 'staff_activation', 'support_case', 'moderation_case', 'appeal', 'incident', 'pipeline_alert',
] as const;
export const ConsoleWorkKindSchema = z.enum(CONSOLE_WORK_KINDS);
export type ConsoleWorkKind = z.infer<typeof ConsoleWorkKindSchema>;

/** Why a row is the viewer's: "You hold Commercial admin at this hub", or what they did themselves. */
export const ConsoleWorkReasonSchema = z.discriminatedUnion('code', [
  z.strictObject({ code: z.literal('holds_role'), role: HubStaffRoleSchema }),
  z.strictObject({ code: z.literal('escalated_to_owner_role'), role: HubStaffRoleSchema }),
  z.strictObject({ code: z.literal('assigned_to_you') }),
  z.strictObject({ code: z.literal('requested_by_you') }),
  z.strictObject({ code: z.literal('opened_by_you') }),
  z.strictObject({ code: z.literal('acknowledged_by_you') }),
  z.strictObject({ code: z.literal('decided_by_you') }),
]);
export type ConsoleWorkReason = z.infer<typeof ConsoleWorkReasonSchema>;

/**
 * One row of the inbox: what, where, in which state, until when and why it is the viewer's. Who asked is a staff person
 * id, resolved through the directory. The reason a person gave, the change and the purpose of a grant stay on the
 * object's own read, where their readers are decided; for an approval that is `GET /v1/admin/approvals/:id`.
 */
export const ConsoleWorkItemSchema = z.strictObject({
  kind: ConsoleWorkKindSchema,
  id: UuidSchema,
  scope: StaffScopeSchema,
  state: CodeSchema,
  /** The second-person action of an approval or a recovery escalation. */
  action: ConsoleActionCodeSchema.nullable(),
  /** The incident's severity. */
  severity: IncidentSeveritySchema.nullable(),
  /** The role under review, or the role an activation would give. */
  role: HubStaffRoleSchema.nullable(),
  requestedBy: UuidSchema.nullable(),
  at: TimestampSchema,
  expiresAt: TimestampSchema.nullable(),
  reason: ConsoleWorkReasonSchema,
});
export type ConsoleWorkItem = z.infer<typeof ConsoleWorkItemSchema>;

export const CONSOLE_WORK_LIMIT = 500;
export const ConsoleWorkListSchema = z.strictObject({
  view: ConsoleWorkViewSchema,
  items: z.array(ConsoleWorkItemSchema).max(CONSOLE_WORK_LIMIT),
  /** More rows the viewer may read exist than this list carries. */
  truncated: z.boolean(),
});
export type ConsoleWorkList = z.infer<typeof ConsoleWorkListSchema>;
/** The band's count: "Waiting for me" only, the same rows the list shows. */
export const ConsoleWorkCountSchema = z.strictObject({ waiting: z.int().min(0).max(CONSOLE_WORK_LIMIT), truncated: z.boolean() });
export type ConsoleWorkCount = z.infer<typeof ConsoleWorkCountSchema>;

/* ---------- Saved views ---------- */

export const CONSOLE_VIEW_SURFACES = [
  'inbox:waiting', 'inbox:mine', 'inbox:assigned', 'inbox:done', 'users:people', 'users:companies', 'users:staff', 'users:clients',
  'audit:events', 'audit:access', 'flags', 'incidents', 'moderation:cases', 'support:cases', 'pipelines:runs',
] as const;
export const ConsoleViewSurfaceSchema = z.enum(CONSOLE_VIEW_SURFACES);
export type ConsoleViewSurface = z.infer<typeof ConsoleViewSurfaceSchema>;

const SEVERITIES = ['sev1', 'sev2', 'sev3', 'sev4'] as const;
const PERIODS = ['day', 'week', 'month', 'quarter'] as const;
const WORK_SURFACE = {
  filters: { kind: CONSOLE_WORK_KINDS, severity: SEVERITIES, role: HUB_STAFF_ROLES },
  columns: ['kind', 'state', 'action', 'severity', 'role', 'at', 'expiresAt', 'reason'],
} as const;

/**
 * Every filter, value and column a saved view may hold, per surface. A pattern cannot tell a code from a name that has
 * been made to look like one (`Maria.Petrova`, `maria:example.invalid`, a uuid without its hyphens), so nothing here is
 * matched by shape: a value is on this list or it is refused. A view therefore cannot carry anything someone typed, or
 * tell a team who or what its owner was looking at. People and companies have no filters: nothing about them is a
 * saved choice. `console_view_vocabulary()` holds the same list for every writer (tested equal); a screen that needs a
 * new filter adds it to both.
 */
export const CONSOLE_VIEW_VOCABULARY = {
  'inbox:waiting': WORK_SURFACE,
  'inbox:mine': WORK_SURFACE,
  'inbox:assigned': WORK_SURFACE,
  'inbox:done': WORK_SURFACE,
  'users:people': { filters: {}, columns: ['displayName', 'joinedAt'] },
  'users:companies': { filters: {}, columns: ['displayName', 'joinedAt'] },
  'users:staff': { filters: { role: HUB_STAFF_ROLES, secondFactor: ['enrolled', 'none'] }, columns: ['displayName', 'role', 'scope', 'secondFactor', 'validUntil'] },
  'users:clients': { filters: {}, columns: ['displayName', 'state'] },
  'audit:events': {
    filters: { outcome: ['applied', 'denied', 'failed'], scopeKind: ['platform', 'node', 'hub'], period: PERIODS, secondPerson: ['yes'], breakglass: ['yes'] },
    columns: ['sequence', 'occurredAt', 'action', 'outcome', 'actorRole', 'scope', 'objectType'],
  },
  'audit:access': { filters: { kind: ['case_read', 'dispute_evidence_read', 'audit_read', 'evidence_view'], period: PERIODS }, columns: ['sequence', 'occurredAt', 'kind', 'objectType'] },
  flags: {
    filters: { stage: FLAG_ROLLOUT_STAGES, declaredEffect: ['ui', 'behaviour', 'content', 'operations'], expired: ['yes', 'no'] },
    columns: ['key', 'stage', 'sharePercent', 'declaredEffect', 'expiresAt'],
  },
  incidents: { filters: { state: ['open', 'mitigated', 'resolved', 'closed'], severity: SEVERITIES, kind: ['security', 'privacy_breach', 'provider', 'content', 'availability'] }, columns: ['severity', 'kind', 'state', 'openedAt'] },
  'moderation:cases': {
    filters: { state: ['open', 'in_review', 'decided', 'appealed', 'appeal_decided', 'closed'], decision: ['no_action', 'warning', 'content_removed', 'content_restored', 'sanction'] },
    columns: ['state', 'decision', 'openedAt', 'decidedAt'],
  },
  'support:cases': { filters: { state: ['open', 'triaged', 'waiting_on_requester', 'grant_requested', 'in_progress', 'resolved', 'closed'] }, columns: ['number', 'state', 'category', 'openedAt'] },
  'pipelines:runs': {
    filters: {
      state: ['queued', 'running', 'succeeded', 'partially_succeeded', 'failed', 'cancelled', 'skipped_window', 'skipped_budget', 'stopped_by_kill_switch'],
      trigger: ['schedule', 'manual', 'dry_run', 'retry', 'backfill', 'event'],
    },
    columns: ['state', 'trigger', 'dryRun', 'queuedAt', 'finishedAt'],
  },
} as const satisfies Record<ConsoleViewSurface, { filters: Readonly<Record<string, readonly string[]>>; columns: readonly string[] }>;

const ViewKeySchema = z.string().regex(/^[a-z][a-zA-Z0-9]{0,63}$/, 'a filter or column key');
const ViewValueSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/, 'a filter value is a code');

/**
 * What a saved view remembers: filters, columns and a sort. It stores no search text and no identifier, because a view
 * is shared and a shared view is read by people who did not type it: every key and value comes from
 * `CONSOLE_VIEW_VOCABULARY`. The rows a view shows are computed for each reader at read time, under that reader's own
 * permissions; it stores none.
 */
export const ConsoleViewConfigurationSchema = z.strictObject({
  filters: z.record(ViewKeySchema, z.array(ViewValueSchema).min(1).max(20)).refine((filters) => Object.keys(filters).length <= 20, { message: 'at most 20 filters' }),
  columns: z.array(ViewKeySchema).max(40),
  sort: z.strictObject({ column: ViewKeySchema, direction: z.enum(['ascending', 'descending']) }).nullable(),
});
export type ConsoleViewConfiguration = z.infer<typeof ConsoleViewConfigurationSchema>;

/** Is every filter, value and column of this configuration on the surface's list? */
export function consoleViewConfigurationAllowed(surface: ConsoleViewSurface, configuration: ConsoleViewConfiguration): boolean {
  const { filters, columns } = CONSOLE_VIEW_VOCABULARY[surface] as { filters: Readonly<Record<string, readonly string[]>>; columns: readonly string[] };
  return Object.entries(configuration.filters).every(([key, values]) => Object.hasOwn(filters, key) && values.every((value) => filters[key]?.includes(value)))
    && configuration.columns.every((column) => columns.includes(column))
    && (configuration.sort === null || columns.includes(configuration.sort.column));
}

/** A view's name is shown to its team: no address and no telephone number. */
const ViewNameSchema = z.string().overwrite((value) => value.normalize('NFC').trim()).min(1).max(80)
  .refine((value) => !value.includes('@') && !/[0-9][0-9 ()./-]{5,}[0-9]/.test(value), { message: 'a view name holds no address or telephone number' });

export const ConsoleSavedViewSchema = z.strictObject({
  id: UuidSchema,
  scope: StaffScopeSchema,
  surface: ConsoleViewSurfaceSchema,
  name: z.string().min(1).max(80),
  configuration: ConsoleViewConfigurationSchema,
  /** The role whose holders covering the scope share the view; null for a personal view. */
  teamRole: HubStaffRoleSchema.nullable(),
  /** The reader's own view, which only they change. Who owns someone else's team view is not shown. */
  mine: z.boolean(),
  isDefault: z.boolean(),
  revision: RevisionSchema,
  updatedAt: TimestampSchema,
});
export type ConsoleSavedView = z.infer<typeof ConsoleSavedViewSchema>;

export const ConsoleViewsQuerySchema = z.strictObject({ ...TargetShape, surface: ConsoleViewSurfaceSchema.optional() }).refine(oneTarget, { message: 'one target' });

const viewFields = {
  name: ViewNameSchema,
  configuration: ConsoleViewConfigurationSchema,
  teamRole: HubStaffRoleSchema.nullable(),
  isDefault: z.boolean(),
};
export const CreateConsoleViewCommandSchema = consoleCommand({ scope: CommandScopeSchema, surface: ConsoleViewSurfaceSchema, ...viewFields })
  .refine((view) => consoleViewConfigurationAllowed(view.surface, view.configuration), { message: 'a filter, value or column this surface does not have', path: ['configuration'] });
export type CreateConsoleViewCommand = z.infer<typeof CreateConsoleViewCommandSchema>;
/** The surface is the stored view's, so the database checks the configuration against it (`admin.view_configuration`). */
export const UpdateConsoleViewCommandSchema = consoleCommand({ expectedRevision: RevisionSchema, ...viewFields });
export type UpdateConsoleViewCommand = z.infer<typeof UpdateConsoleViewCommandSchema>;
export const RemoveConsoleViewCommandSchema = consoleCommand({ expectedRevision: RevisionSchema });
export type RemoveConsoleViewCommand = z.infer<typeof RemoveConsoleViewCommandSchema>;

/* ---------- Notification settings ---------- */

/**
 * The categories a staff member may opt into by e-mail (console-design 3.5: counts in the console always, e-mail opt-in
 * per category). Notices carry identifiers and the action name, never private values.
 */
export const CONSOLE_NOTIFICATION_CATEGORIES = ['approvals', 'case_grants', 'recovery', 'access_reviews', 'assigned_cases', 'appeals', 'incidents', 'alerts'] as const;
export const ConsoleNotificationCategorySchema = z.enum(CONSOLE_NOTIFICATION_CATEGORIES);
export type ConsoleNotificationCategory = z.infer<typeof ConsoleNotificationCategorySchema>;

const MinuteOfDaySchema = z.int().min(0).max(1439);
export const ConsoleQuietHoursSchema = z.strictObject({ fromMinute: MinuteOfDaySchema, untilMinute: MinuteOfDaySchema, timeZone: IanaTimeZoneSchema })
  .refine((q) => q.fromMinute !== q.untilMinute, { message: 'quiet hours have a length' });
export type ConsoleQuietHours = z.infer<typeof ConsoleQuietHoursSchema>;

const NotificationFields = { emailCategories: z.array(ConsoleNotificationCategorySchema).max(CONSOLE_NOTIFICATION_CATEGORIES.length).refine((list) => new Set(list).size === list.length, { message: 'each category once' }), quietHours: ConsoleQuietHoursSchema.nullable() };
/** `revision` 0: nothing was ever set, which means no e-mail at all. */
export const ConsoleNotificationSettingsSchema = z.strictObject({ ...NotificationFields, revision: z.int().min(0) });
export type ConsoleNotificationSettings = z.infer<typeof ConsoleNotificationSettingsSchema>;
export const SetConsoleNotificationsCommandSchema = consoleCommand({ scope: CommandScopeSchema, expectedRevision: z.int().min(0), ...NotificationFields });
export type SetConsoleNotificationsCommand = z.infer<typeof SetConsoleNotificationsCommandSchema>;

/* ---------- Flag rollout ---------- */

/**
 * Keys a flag may not have, on top of the access and ranking words `feature_flag` already refuses: ranking, matching,
 * reputation, payment and what follows from them. Payment never changes ranking, matching or reputation, so no flag can
 * reach those subjects at all. A word counts at the start of a segment (`ui.payment_form`, `matching.v2`), so
 * `ops.dispatch` and `retrieval.rerank_model` stay possible. The table holds the same pattern for every writer.
 */
export const FLAG_REFUSED_KEY = /(^|[._])(rank|match|reput|payment|payout|sponsor|recommend)/;

export const ConsoleFlagSchema = z.strictObject({
  id: UuidSchema,
  key: CodeSchema,
  scope: StaffScopeSchema,
  declaredEffect: z.enum(['ui', 'behaviour', 'content', 'operations']),
  stage: FlagRolloutStageSchema,
  sharePercent: FlagSharePercentSchema.nullable(),
  expiresAt: TimestampSchema,
  /** An expired flag is in force for nobody, and listed for removal from code. Extending it brings it back at off. */
  expired: z.boolean(),
  revision: RevisionSchema,
});
export type ConsoleFlag = z.infer<typeof ConsoleFlagSchema>;

/**
 * A stage names a share of people at most: nothing here can name a person, a company, a session or a list of them,
 * and the table it is stored in has no column that could (tested). `expectedRevision` protects a widening from racing
 * a change someone else made; it is ignored for `off`, which always wins so that a flag can be stopped at once.
 */
export const SetFlagStageCommandSchema = consoleCommand({
  stage: FlagRolloutStageSchema,
  sharePercent: FlagSharePercentSchema.nullable(),
  expectedRevision: RevisionSchema,
}).refine((c) => (c.stage === 'share') === (c.sharePercent !== null), { message: 'a share names its percent, and only a share does', path: ['sharePercent'] });
export type SetFlagStageCommand = z.infer<typeof SetFlagStageCommandSchema>;

/** The session read takes nothing: the hub is the one this API serves, and the person is the caller. */
export const ActiveFlagsQuerySchema = z.strictObject({});
/** The flags in force for the caller at the served hub, and nothing about the others. */
export const ActiveFlagsSchema = z.strictObject({ flags: z.array(z.strictObject({ key: CodeSchema, value: z.unknown() })) });
export type ActiveFlags = z.infer<typeof ActiveFlagsSchema>;
