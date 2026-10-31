import { z } from 'zod';
import { PartySchema } from './access.js';
import { AgentCapabilitySchema, type AgentCapability, type CapabilityKind, type ContextKindV2, type MandateActionV2, type PrivateDataClass, type SideEffect } from './agent-catalog.js';
import { AttachmentRefSchema, IdSchema, RevisionSchema, TimestampSchema, type AttachmentRef } from './common/ids.js';

/**
 * Files and attachments (FILE-001): the contract layer over the kernel table `evidence_artifact` (DATA-003).
 *
 * Invariants restated here and enforced again by the database (packages/data/migrations/kernel and .../files):
 * - a file belongs to exactly one owner party and one parent object; reading it needs access to the parent AND its own
 *   classification (deny by default, "not found" when existence is not known to the caller);
 * - the classification is inherited from the parent kind: a request may only make it stricter, or pick one of the
 *   looser classes the parent kind explicitly allows (a public avatar, logo or publication image);
 * - uploader, owner, scan state, hash, size and type are never chosen by a client after the upload starts: the server
 *   derives the uploader from the session, the database refuses a foreign owner and a non-pending scan state, and the
 *   worker verifies the stored bytes against the declared hash, size and type before the file becomes visible;
 * - a file is visible to anyone but its owner party only after the scanner marked it `clean`; `quarantined` is final;
 * - bytes move only through short-lived signed URLs: uploads through a signed PUT, downloads through a signed GET that
 *   the API issues only after the authorization check, each with a bounded time to live;
 * - copy and move keep the owner party and the classification and are audited; the content identity of a stored file
 *   never changes (a copy or a move is a new artifact);
 * - deletion and erasure run in the worker and leave a tombstone outside the database, so a restore replays them.
 */

/* ---------- Vocabulary ---------- */

export const FILE_PARENT_KINDS = ['person', 'company', 'project', 'rfq', 'quote', 'agreement', 'order', 'thread', 'publication'] as const;
export const FileParentKindSchema = z.enum(FILE_PARENT_KINDS);
export type FileParentKind = z.infer<typeof FileParentKindSchema>;

/** Every class the kernel stores. `restricted` is staff-case material (exports, case evidence) and never requested by a participant. */
export const FILE_CLASSIFICATIONS = ['public', 'shared', 'party_private', 'owner_private', 'restricted'] as const;
export const FileClassificationSchema = z.enum(FILE_CLASSIFICATIONS);
export type FileClassification = z.infer<typeof FileClassificationSchema>;
export const RequestableClassificationSchema = FileClassificationSchema.exclude(['restricted']);
export type RequestableClassification = z.infer<typeof RequestableClassificationSchema>;

/** Strictness order: a higher rank reveals the file to fewer people. */
export const CLASSIFICATION_RANK: Readonly<Record<FileClassification, number>> = { public: 0, shared: 1, party_private: 2, owner_private: 3, restricted: 4 };

/**
 * Classification inherited from the parent kind. `default` applies when the request names none; a request may name any
 * stricter requestable class, and a looser one only when it is listed in `looser` (the parent kind publishes it).
 */
export const CLASSIFICATION_POLICY: Readonly<Record<FileParentKind, { default: RequestableClassification; looser: readonly RequestableClassification[] }>> = {
  person: { default: 'owner_private', looser: ['public'] },
  company: { default: 'owner_private', looser: ['public'] },
  project: { default: 'shared', looser: ['public'] },
  rfq: { default: 'shared', looser: [] },
  quote: { default: 'shared', looser: [] },
  agreement: { default: 'shared', looser: [] },
  order: { default: 'shared', looser: [] },
  thread: { default: 'shared', looser: [] },
  publication: { default: 'public', looser: [] },
};

/** The classes a parent kind accepts. */
export function allowedClassifications(kind: FileParentKind): RequestableClassification[] {
  const policy = CLASSIFICATION_POLICY[kind];
  return RequestableClassificationSchema.options.filter((c) => CLASSIFICATION_RANK[c] >= CLASSIFICATION_RANK[policy.default] || policy.looser.includes(c));
}
/** The class a new file gets under a parent, or null when the parent kind does not accept the requested class. */
export function resolveClassification(kind: FileParentKind, requested: RequestableClassification | null | undefined): RequestableClassification | null {
  const chosen = requested ?? CLASSIFICATION_POLICY[kind].default;
  return allowedClassifications(kind).includes(chosen) ? chosen : null;
}

export const ScanStateSchema = z.enum(['pending', 'clean', 'quarantined']);
export type ScanState = z.infer<typeof ScanStateSchema>;
/**
 * Why the worker refused to publish a file. `location_metadata`: a `public` image still carries GPS or location
 * metadata (public projections never keep location; private parties keep originals, EXE-F10).
 */
export const QUARANTINE_REASONS = ['malware', 'hash_mismatch', 'size_mismatch', 'type_mismatch', 'missing_content', 'location_metadata', 'unreadable'] as const;
export const QuarantineReasonSchema = z.enum(QUARANTINE_REASONS);
export type QuarantineReason = z.infer<typeof QuarantineReasonSchema>;
export const FileOriginSchema = z.enum(['upload', 'copy', 'move']);
export type FileOrigin = z.infer<typeof FileOriginSchema>;

/* ---------- Limits (enforced by the API on the declaration and by the worker on the stored bytes) ---------- */

export const FILE_MAX_BYTES = 50 * 1024 * 1024;
export type MediaFamily = 'image' | 'document' | 'spreadsheet' | 'text';
/**
 * The media types a hub accepts by default, with their size limits. Anything else is refused. SVG, HTML and archives
 * are deliberately absent (active content and decompression bombs); office formats are stored, never unpacked.
 */
export const MEDIA_TYPE_LIMITS: Readonly<Record<string, { family: MediaFamily; maxBytes: number }>> = {
  'image/jpeg': { family: 'image', maxBytes: 15 * 1024 * 1024 },
  'image/png': { family: 'image', maxBytes: 15 * 1024 * 1024 },
  'image/webp': { family: 'image', maxBytes: 15 * 1024 * 1024 },
  'application/pdf': { family: 'document', maxBytes: FILE_MAX_BYTES },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { family: 'document', maxBytes: 25 * 1024 * 1024 },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { family: 'spreadsheet', maxBytes: 25 * 1024 * 1024 },
  'text/plain': { family: 'text', maxBytes: 5 * 1024 * 1024 },
  'text/csv': { family: 'text', maxBytes: 5 * 1024 * 1024 },
};
export const ACCEPTED_MEDIA_TYPES = Object.keys(MEDIA_TYPE_LIMITS) as readonly string[];
export const MediaTypeSchema = z.string().refine((t) => Object.hasOwn(MEDIA_TYPE_LIMITS, t), { message: 'media type is not accepted' });
export function mediaTypeLimit(mediaType: string): number | null {
  return Object.hasOwn(MEDIA_TYPE_LIMITS, mediaType) ? (MEDIA_TYPE_LIMITS[mediaType] as { maxBytes: number }).maxBytes : null;
}

/** The limit a declared or stored size exceeds for its media type, or null when it fits. */
export function sizeLimitExceeded(mediaType: string, bytes: number): number | null {
  const limit = mediaTypeLimit(mediaType) ?? 0;
  return bytes > limit || bytes > FILE_MAX_BYTES ? Math.min(limit, FILE_MAX_BYTES) : null;
}

/** Signed URL lifetimes in seconds. The API never issues a URL longer than the maximum, whatever it is configured to. */
export const SIGNED_URL_TTL = { upload: { default: 300, min: 30, max: 900 }, download: { default: 60, min: 10, max: 300 } } as const;
export function boundedTtl(kind: keyof typeof SIGNED_URL_TTL, requested: number | null | undefined): number {
  const limits = SIGNED_URL_TTL[kind];
  const value = requested ?? limits.default;
  return Math.min(limits.max, Math.max(limits.min, Math.floor(value)));
}

export const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/, 'lowercase hex sha-256');
/** Client-chosen key of one upload attempt; the same key for the same owner never creates a second file. */
export const UploadKeySchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, 'upload key: 16 to 128 characters [A-Za-z0-9_-]');

/* ---------- Commands ---------- */

export const FileParentRefSchema = z.strictObject({ kind: FileParentKindSchema, id: IdSchema });
export type FileParentRef = z.infer<typeof FileParentRefSchema>;

/** A person acts on their own authority; their agent only under a structured mandate (the API's mandate port). */
export const FileActorInputSchema = z.discriminatedUnion('via', [
  z.strictObject({ via: z.literal('person') }),
  z.strictObject({ via: z.literal('agent'), mandateId: IdSchema }),
]);
export type FileActorInput = z.infer<typeof FileActorInputSchema>;
const actor = FileActorInputSchema.default({ via: 'person' });

/**
 * Starts an upload: declares owner, parent, class, type, exact size and SHA-256. The response carries the pending file
 * and a signed PUT. Size and type limits are checked here and again on the stored bytes.
 */
export const StartUploadCommandSchema = z.strictObject({
  owner: PartySchema,
  parent: FileParentRefSchema,
  classification: RequestableClassificationSchema.nullable().default(null),
  mediaType: MediaTypeSchema,
  /** Exact size in bytes. The per-type limit is checked by `sizeLimitExceeded` (HTTP 413), not by the schema. */
  bytes: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
  sha256: Sha256HexSchema,
  uploadKey: UploadKeySchema,
  actor,
}).superRefine((c, ctx) => {
  if (c.classification !== null && resolveClassification(c.parent.kind, c.classification) === null) ctx.addIssue({ code: 'custom', path: ['classification'], message: `class ${c.classification} is not accepted for a ${c.parent.kind}` });
  if (c.parent.kind === 'person' && c.owner.kind !== 'person') ctx.addIssue({ code: 'custom', path: ['owner'], message: 'files of a person belong to that person' });
});
export type StartUploadCommand = z.infer<typeof StartUploadCommandSchema>;

/** The uploader reports that the bytes were sent; the worker then verifies and scans them. */
export const CompleteUploadCommandSchema = z.strictObject({ actor });
/** Copy or move to another parent of the same owner party; class and owner are kept (there is no field to change them). */
export const CopyFileCommandSchema = z.strictObject({ parent: FileParentRefSchema, actor });
export const MoveFileCommandSchema = z.strictObject({ parent: FileParentRefSchema, actor });
export const DeleteFileCommandSchema = z.strictObject({ actor });
export const FileListQuerySchema = z.strictObject({ parentKind: FileParentKindSchema, parentId: IdSchema });
export const FileQuerySchema = z.strictObject({ id: IdSchema });
export const DownloadUrlQuerySchema = z.strictObject({ id: IdSchema });

/* ---------- Views ---------- */

/** Metadata of one file as the caller may see it. Never carries the storage key, a URL or the legal-hold flag. */
export const FileRefSchema = z.strictObject({
  id: IdSchema,
  owner: PartySchema,
  parent: FileParentRefSchema,
  classification: FileClassificationSchema,
  mediaType: z.string().min(3).max(130),
  bytes: z.int().min(0),
  sha256: Sha256HexSchema,
  scanState: ScanStateSchema,
  /** Only the owner party sees why its file was quarantined; others never see a quarantined file. */
  quarantineReason: QuarantineReasonSchema.nullable(),
  origin: FileOriginSchema,
  uploadedBy: IdSchema,
  createdAt: TimestampSchema,
  revision: RevisionSchema,
});
export type FileRef = z.infer<typeof FileRefSchema>;
export const FileListSchema = z.strictObject({ items: z.array(FileRefSchema).max(500) });

/** A signed request the client performs against object storage. Headers are part of the signature and must be sent as given. */
export const SignedRequestSchema = z.strictObject({
  method: z.enum(['PUT', 'GET']),
  url: z.url(),
  headers: z.record(z.string().regex(/^[a-z0-9-]{1,64}$/), z.string().max(512)),
  expiresAt: TimestampSchema,
});
export type SignedRequest = z.infer<typeof SignedRequestSchema>;
export const StartUploadResultSchema = z.strictObject({ file: FileRefSchema, upload: SignedRequestSchema.extend({ method: z.literal('PUT') }) });
export type StartUploadResult = z.infer<typeof StartUploadResultSchema>;
export const DownloadTicketSchema = z.strictObject({ file: FileRefSchema, download: SignedRequestSchema.extend({ method: z.literal('GET') }) });
export type DownloadTicket = z.infer<typeof DownloadTicketSchema>;
export const DeleteFileResultSchema = z.strictObject({ id: IdSchema, deletionRequested: z.literal(true) });

/** The reference other contracts embed (plans, RFQs, sales); only a clean file that its parent's parties may see qualifies. */
export function attachmentRefOf(file: FileRef): AttachmentRef | null {
  if (file.scanState !== 'clean' || (file.classification !== 'shared' && file.classification !== 'public')) return null;
  return AttachmentRefSchema.parse({ evidenceArtifactId: file.id, hash: file.sha256, audience: 'shared' });
}

/* ---------- Outbox events, jobs, tombstones and erasure ---------- */

/** Identifiers only: the worker reads everything else under its own role. */
export const FILE_EVENT_TYPES = ['file.uploaded', 'file.copy_requested', 'file.moved', 'file.deletion_requested'] as const;
export const FileEventTypeSchema = z.enum(FILE_EVENT_TYPES);
export const FileEventPayloadSchema = z.strictObject({ artifactId: z.uuid() });
export type FileEventPayload = z.infer<typeof FileEventPayloadSchema>;

/** Worker job payloads. */
export const FileScanJobSchema = z.strictObject({ artifactId: z.uuid() });
export const FileDeleteJobSchema = z.strictObject({ artifactId: z.uuid() });

/**
 * Erasure of files decided by the privacy officer and executed by two people (retention and privacy, section on
 * subject rights). Lawful holds still win: an artifact under legal hold is reported, never erased.
 */
export const FileErasureRequestSchema = z.strictObject({
  privacyRequestId: IdSchema,
  artifactIds: z.array(z.uuid()).min(1).max(500),
  executedBy: z.uuid(),
  secondApprover: z.uuid(),
}).refine((r) => r.executedBy !== r.secondApprover, { message: 'erasure needs two different people', path: ['secondApprover'] })
  .refine((r) => new Set(r.artifactIds).size === r.artifactIds.length, { message: 'artifact ids are distinct', path: ['artifactIds'] });
export type FileErasureRequest = z.infer<typeof FileErasureRequestSchema>;

/**
 * What must stay gone. Written to the tombstone ledger in object storage (outside the restorable database snapshot)
 * before the bytes and the row are removed; a restore replays every tombstone before the files are served again.
 * Carries no personal data: identifiers, the storage key and the reason only.
 */
export const FileTombstoneSchema = z.strictObject({
  v: z.literal(1),
  artifactId: z.uuid(),
  storageKey: z.string().min(1).max(512),
  reason: z.enum(['deleted', 'erased']),
  privacyRequestId: IdSchema.nullable(),
  recordedAt: TimestampSchema,
});
export type FileTombstone = z.infer<typeof FileTombstoneSchema>;

/* ---------- Capability registry entries (ADR 010 decision 23: every file operation for the interface and the agent) ---------- */

export interface FileCapabilityEntry { capability: AgentCapability; apiRoute: string }
interface Spec {
  id: string;
  kind: CapabilityKind;
  action: MandateActionV2 | null;
  input: string;
  output: string;
  effects: SideEffect[];
  untrusted?: boolean;
  privateData?: PrivateDataClass[];
  route: string;
}
const FILE_CONTEXTS: ContextKindV2[] = ['profile', 'company', 'project', 'rfq', 'quote', 'agreement', 'order', 'publication'];
const camel = (s: string) => s.replace(/[._]([a-z])/g, (_, ch: string) => ch.toUpperCase());
function entry(s: Spec): FileCapabilityEntry {
  const capability: AgentCapability = AgentCapabilitySchema.parse({
    id: s.id,
    version: 1,
    source: { kind: 'module', moduleKey: 'files', moduleVersion: '1.0.0' },
    kind: s.kind,
    input: { contract: 'files', schema: s.input, version: 1 },
    output: { contract: 'files', schema: s.output, version: 1 },
    mandateAction: s.action,
    contextKinds: FILE_CONTEXTS,
    confirmation: s.kind === 'commit' ? 'mandate' : 'none',
    budgetKind: null,
    reads: ['public', 'shared_party', 'party_private', 'owner_private'],
    privateDataClasses: s.privateData ?? ['private_projects'],
    sideEffects: s.effects,
    acceptsUntrustedText: s.untrusted ?? false,
    meters: s.kind === 'commit' ? ['agent_actions'] : [],
    surfaces: ['ui', 'agent', 'mcp'],
    status: 'live',
    labelKey: `files.capability.${camel(s.id)}`,
  });
  return { capability, apiRoute: s.route };
}

export const FILE_CAPABILITIES: readonly FileCapabilityEntry[] = [
  entry({ id: 'files.list', kind: 'read', action: null, input: 'FileListQuerySchema', output: 'FileListSchema', effects: ['none'], route: 'GET /v1/files' }),
  entry({ id: 'files.get', kind: 'read', action: null, input: 'FileQuerySchema', output: 'FileRefSchema', effects: ['none'], route: 'GET /v1/files/:id' }),
  entry({ id: 'files.download_url', kind: 'read', action: null, input: 'DownloadUrlQuerySchema', output: 'DownloadTicketSchema', effects: ['none'], route: 'GET /v1/files/:id/download' }),
  entry({ id: 'files.upload', kind: 'draft', action: 'prepare', input: 'StartUploadCommandSchema', output: 'StartUploadResultSchema', effects: ['draft_state'], untrusted: true, route: 'POST /v1/files/uploads' }),
  entry({ id: 'files.complete_upload', kind: 'draft', action: 'prepare', input: 'CompleteUploadCommandSchema', output: 'FileRefSchema', effects: ['draft_state'], route: 'POST /v1/files/:id/complete' }),
  entry({ id: 'files.copy', kind: 'commit', action: 'record_evidence', input: 'CopyFileCommandSchema', output: 'FileRefSchema', effects: ['state_change'], route: 'POST /v1/files/:id/copy' }),
  entry({ id: 'files.move', kind: 'commit', action: 'record_evidence', input: 'MoveFileCommandSchema', output: 'FileRefSchema', effects: ['state_change'], route: 'POST /v1/files/:id/move' }),
  entry({ id: 'files.delete', kind: 'commit', action: 'maintain_records', input: 'DeleteFileCommandSchema', output: 'DeleteFileResultSchema', effects: ['state_change'], route: 'POST /v1/files/:id/delete' }),
];
