import { z } from 'zod';
import { PartySchema } from './access.js';
import { LegalIdentifierSchema, MembershipSchema } from './company.js';
import { IdSchema, NameSchema, TextSchema, TimestampSchema } from './common/ids.js';
import { CursorSchema, decodeCursor, encodeCursor, PAGE_LIMIT_MAX, pageSchema } from './common/pagination.js';
import { pickFields } from './common/projection.js';
import { PublicPersonSchema, toPublicPerson, type Person } from './identity.js';
import { ProjectStatusSchema, PublicProjectSchema, toPublicProject, type Project } from './projects.js';

/**
 * Directory contracts (BE-003, ADR 012 decision 18): public handles for people, companies and projects, company
 * creation with a founding administrator, and keyset-paginated directories. UUIDs stay the stable identifiers; a
 * handle is a public URL name that can change, leaves a redirect record and is never reused for another subject.
 * Every list item and lookup passes through an explicit allowlist serializer below.
 */

// ---------------------------------------------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------------------------------------------

export const HANDLE_KINDS = ['person', 'company', 'project'] as const;
export const HandleKindSchema = z.enum(HANDLE_KINDS);
export type HandleKind = z.infer<typeof HandleKindSchema>;

export const HANDLE_MIN_LENGTH = 3;
export const HANDLE_MAX_LENGTH = 40;
/** Lifetime handle records per subject (current plus retired): each record is reserved for ever, so the cap stops squatting by renaming. */
export const MAX_HANDLES_PER_SUBJECT = 10;
/**
 * Route words, platform roles and brand names that no subject may take. The database carries the same list in the
 * `directory_handle_not_reserved` check (tests/directory compare them).
 */
export const RESERVED_HANDLES = [
  'about', 'account', 'admin', 'administrator', 'api', 'app', 'auth', 'by-handle', 'companies', 'company', 'contribuda', 'contribuddha',
  'directory', 'edit', 'events', 'handles', 'help', 'hub', 'hubs', 'login', 'logout', 'me', 'moderator', 'new', 'null', 'official',
  'people', 'person', 'projects', 'project', 'register', 'root', 'search', 'security', 'settings', 'signup', 'staff', 'support',
  'system', 'trustwork', 'undefined', 'verified', 'www',
] as const;

const HANDLE_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RESERVED: ReadonlySet<string> = new Set(RESERVED_HANDLES);

export type HandleProblem = 'length' | 'charset' | 'numeric' | 'uuid_shaped' | 'reserved';
/** Why a normalized candidate cannot be a handle, or null when it can. */
export function handleProblem(handle: string): HandleProblem | null {
  if (handle.length < HANDLE_MIN_LENGTH || handle.length > HANDLE_MAX_LENGTH) return 'length';
  if (!HANDLE_SHAPE.test(handle)) return 'charset';
  if (/^[0-9]+$/.test(handle)) return 'numeric';
  if (UUID_SHAPE.test(handle)) return 'uuid_shaped';
  if (RESERVED.has(handle)) return 'reserved';
  return null;
}
/** Lower-case ASCII letters and digits in hyphen-separated groups; never all digits, never UUID-shaped, never reserved. */
export const HandleSchema = z
  .string()
  .overwrite((value) => value.trim().toLowerCase())
  .check((ctx) => {
    const problem = handleProblem(ctx.value);
    if (problem) ctx.issues.push({ code: 'custom', message: `handle ${problem}`, input: ctx.value, params: { reason: problem } });
  });
export type Handle = z.infer<typeof HandleSchema>;

export const SetHandleCommandSchema = z.strictObject({ handle: HandleSchema });
export type SetHandleCommand = z.infer<typeof SetHandleCommandSchema>;
export const HandleAssignmentSchema = z.strictObject({ kind: HandleKindSchema, id: IdSchema, handle: HandleSchema });
export type HandleAssignment = z.infer<typeof HandleAssignmentSchema>;
/** `redirect` is true when `requested` is a retired handle of the subject; clients move to `handle` (permanent redirect). */
export const HandleResolutionSchema = z.strictObject({ kind: HandleKindSchema, id: IdSchema, handle: HandleSchema, requested: HandleSchema, redirect: z.boolean() });
export type HandleResolution = z.infer<typeof HandleResolutionSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Directory projections (public layer only; private fields never reach a list or a lookup)
// ---------------------------------------------------------------------------------------------------------------

export const PersonDirectoryEntrySchema = PublicPersonSchema.extend({ handle: HandleSchema.nullable() });
export type PersonDirectoryEntry = z.infer<typeof PersonDirectoryEntrySchema>;
/** Public profiles only: a private profile is not listed and not found by handle. */
export function toPersonDirectoryEntry(person: Person, handle: string | null): PersonDirectoryEntry | null {
  const pub = toPublicPerson(person);
  return pub ? PersonDirectoryEntrySchema.parse({ ...pub, handle }) : null;
}

/** Where the record came from: `sourced` from a licensed public source, `registered` by a person on the platform. */
export const CompanyOriginSchema = z.enum(['sourced', 'registered']);
/** Claim and verification are separate from origin: a registered company is neither claimed nor verified until a recipe decides. */
export const CompanyClaimStatusSchema = z.enum(['unclaimed', 'claimed', 'verified']);
export const CompanyDirectoryEntrySchema = z.strictObject({
  id: IdSchema,
  handle: HandleSchema.nullable(),
  name: NameSchema,
  origin: CompanyOriginSchema,
  claimStatus: CompanyClaimStatusSchema,
  legalIdentifiers: z.array(LegalIdentifierSchema),
  publicDescription: TextSchema.nullable(),
});
export type CompanyDirectoryEntry = z.infer<typeof CompanyDirectoryEntrySchema>;
const COMPANY_ENTRY_FIELDS = ['id', 'handle', 'name', 'origin', 'claimStatus', 'legalIdentifiers', 'publicDescription'] as const;
/** Allowlist: internal notes, billing, verified domains and membership data of a wider record never pass. */
export function toCompanyDirectoryEntry(record: Pick<CompanyDirectoryEntry, (typeof COMPANY_ENTRY_FIELDS)[number]> & Record<string, unknown>): CompanyDirectoryEntry {
  return CompanyDirectoryEntrySchema.parse(pickFields(record, COMPANY_ENTRY_FIELDS));
}

export const ProjectDirectoryEntrySchema = PublicProjectSchema.extend({ handle: HandleSchema.nullable() });
export type ProjectDirectoryEntry = z.infer<typeof ProjectDirectoryEntrySchema>;
/** Published projects only; prices, files, notes, budgets and participants never pass. */
export function toProjectDirectoryEntry(project: Project, handle: string | null): ProjectDirectoryEntry | null {
  const pub = toPublicProject(project);
  return pub ? ProjectDirectoryEntrySchema.parse({ ...pub, handle }) : null;
}

/** "My projects": shared-level summary for the owner party or a live participant; no owner-private field is listed. */
export const MyProjectRelationSchema = z.enum(['owner', 'participant']);
export const MyProjectSchema = z.strictObject({
  id: IdSchema,
  handle: HandleSchema.nullable(),
  name: NameSchema,
  summary: TextSchema.nullable(),
  status: ProjectStatusSchema,
  owner: PartySchema,
  leaderPersonId: IdSchema.nullable(),
  published: z.boolean(),
  relation: MyProjectRelationSchema,
  createdAt: TimestampSchema,
});
export type MyProject = z.infer<typeof MyProjectSchema>;
export function toMyProject(project: Project, relation: z.infer<typeof MyProjectRelationSchema>, handle: string | null): MyProject {
  return MyProjectSchema.parse({
    ...pickFields(project, ['id', 'name', 'summary', 'status', 'owner', 'leaderPersonId', 'createdAt']),
    handle, relation, published: project.publicity.enabled,
  });
}

export const PersonDirectoryPageSchema = pageSchema(PersonDirectoryEntrySchema);
export const CompanyDirectoryPageSchema = pageSchema(CompanyDirectoryEntrySchema);
export const ProjectDirectoryPageSchema = pageSchema(ProjectDirectoryEntrySchema);
export const MyProjectPageSchema = pageSchema(MyProjectSchema);

/** Lookup by handle: the entry carries the current handle; `redirect` says the requested one was retired. */
export function handleLookupSchema<T extends z.ZodType>(item: T) {
  return z.strictObject({ item, redirect: z.boolean() });
}
export const PersonLookupSchema = handleLookupSchema(PersonDirectoryEntrySchema);
export const CompanyLookupSchema = handleLookupSchema(CompanyDirectoryEntrySchema);
export const ProjectLookupSchema = handleLookupSchema(ProjectDirectoryEntrySchema);

// ---------------------------------------------------------------------------------------------------------------
// Company creation
// ---------------------------------------------------------------------------------------------------------------

/**
 * Creates a `registered`, `unclaimed` company; the creator becomes its only (founding) administrator. Fails with
 * `membership.already_employed` while the creator has an active employer (one active employer per person).
 * Claims and verification never come from this command.
 */
export const CreateCompanyCommandSchema = z.strictObject({ name: NameSchema, handle: HandleSchema.nullable(), publicDescription: TextSchema.nullable() });
export type CreateCompanyCommand = z.infer<typeof CreateCompanyCommandSchema>;
export const CreateCompanyResultSchema = z.strictObject({ company: CompanyDirectoryEntrySchema, membership: MembershipSchema });
export type CreateCompanyResult = z.infer<typeof CreateCompanyResultSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Keyset pagination
// ---------------------------------------------------------------------------------------------------------------

/** Query-string form of `PageRequest` (limits arrive as text). */
export const DirectoryPageQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(20),
  cursor: CursorSchema.optional(),
});
export type DirectoryPageQuery = z.infer<typeof DirectoryPageQuerySchema>;

/**
 * Directory order is `(createdAt DESC, id DESC)`: both immutable, so an item never moves and concurrent inserts
 * never duplicate or skip items that existed when paging started. The sort key keeps PostgreSQL's microseconds.
 */
export const DIRECTORY_SORT_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface DirectoryPosition { createdAt: string; id: string }
export function encodeDirectoryCursor(position: DirectoryPosition): string {
  return encodeCursor({ sortKey: position.createdAt, id: position.id });
}
/** Null for anything that is not a cursor this API issued (malformed, foreign sort key, non-UUID id). */
export function decodeDirectoryCursor(cursor: string): DirectoryPosition | null {
  const payload = decodeCursor(cursor);
  if (!payload || !DIRECTORY_SORT_KEY.test(payload.sortKey) || !UUID_ID.test(payload.id)) return null;
  return { createdAt: payload.sortKey, id: payload.id };
}
