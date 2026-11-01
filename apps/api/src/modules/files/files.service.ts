import { createHash, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Party, Principal } from '../../deps/contracts.js';
import { auditEvents, outbox, type Transaction } from '../../deps/data.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { ParticipationService } from '../identity/policy/participation.service.js';
import type { PrincipalService } from '../identity/principal.service.js';
import {
  allowedClassifications, boundedTtl, DeleteFileResultSchema, DownloadTicketSchema, FileListSchema, FileRefSchema, files, MEDIA_TYPE_LIMITS, resolveClassification,
  sizeLimitExceeded, StartUploadResultSchema,
  type BlobStore, type CompleteUploadCommandSchema, type CopyFileCommandSchema, type DeleteFileCommandSchema, type DownloadTicket, type FileActorInput, type FileEventTypeSchema,
  type FileListQuerySchema, type FileParentRef, type FileRef, type FileRow, type MoveFileCommandSchema, type StartUploadCommand, type StartUploadResult,
} from './deps.js';
import type { FileMandateCheck, FileMandatePort } from './mandates.js';

type In<T extends z.ZodType> = z.infer<T>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESOURCE_KINDS = new Set(['project', 'rfq', 'quote', 'agreement', 'order', 'thread', 'publication']);
const iso = (value: Date | string): string => new Date(value).toISOString();

/** Database hints of the files commands and the kernel guards, mapped to frozen contract codes. */
const HINTS: Record<string, { code: ConstructorParameters<typeof ApiError>[0]; reason: string }> = {
  'files.not_found': { code: 'access.not_found', reason: 'not_found' },
  'files.parent_not_found': { code: 'access.not_found', reason: 'parent_not_found' },
  'files.not_clean': { code: 'validation.schema', reason: 'not_clean' },
  'files.classification_not_allowed': { code: 'validation.schema', reason: 'classification_not_allowed' },
  'files.same_parent': { code: 'validation.schema', reason: 'same_parent' },
  'files.upload_expired': { code: 'validation.schema', reason: 'upload_expired' },
  'files.window_bounds': { code: 'validation.schema', reason: 'window_bounds' },
  'files.legal_hold': { code: 'access.forbidden', reason: 'legal_hold' },
  'kernel.legal_hold': { code: 'access.forbidden', reason: 'legal_hold' },
  'kernel.evidence_immutable': { code: 'validation.schema', reason: 'immutable' },
};
function mapDatabaseError(error: unknown): never {
  const pg = error as { code?: string; hint?: string; constraint?: string; message?: string };
  if (pg && typeof pg.code === 'string') {
    const mapped = pg.hint ? HINTS[pg.hint] : undefined;
    if (mapped) throw new ApiError(mapped.code, mapped.reason, { reason: mapped.reason });
    // The kernel insert policy refused the row: the caller may not attach to this parent (existence is not disclosed).
    if (pg.code === '42501') throw new ApiError('access.not_found', 'not_found', { reason: 'parent_not_found' });
    if (pg.code === '23505' && pg.constraint === 'evidence_artifact_storage_key_key') throw new ApiError('validation.revision_conflict', 'this upload key was already used for this owner', { reason: 'upload_key_taken' });
    if (pg.code === '23505') throw new ApiError('validation.revision_conflict', 'a conflicting record already exists', { constraint: pg.constraint ?? null });
    if (pg.code === '23503') throw new ApiError('access.not_found', 'not_found', { reason: 'parent_not_found' });
  }
  throw error;
}

function partyOf(row: { owner_person_id: string | null; owner_company_id: string | null }): Party {
  return row.owner_person_id ? { kind: 'person', id: row.owner_person_id } : { kind: 'company', id: row.owner_company_id as string };
}
function mandateContext(parent: FileParentRef): FileMandateCheck['context'] {
  if (parent.kind === 'person') return { kind: 'profile', id: parent.id };
  if (parent.kind === 'thread') return null;
  return { kind: parent.kind, id: parent.id };
}
/** Images display inline; every other type downloads as an attachment named "file" (no client-chosen name or header). */
function dispositionFor(mediaType: string): 'inline' | 'attachment' {
  return MEDIA_TYPE_LIMITS[mediaType]?.family === 'image' ? 'inline' : 'attachment';
}

export interface FilesServiceOptions { store: BlobStore; uploadTtlSeconds?: number | undefined; downloadTtlSeconds?: number | undefined; mandates: FileMandatePort }

/**
 * Files and attachments (FILE-001). One `withPrincipal` transaction per request (the idempotency record completes inside
 * it, BE-005). Reads are decided twice: the database policy on `evidence_artifact` (parent access AND classification,
 * clean scan for anyone but the owner party, hidden once deletion is requested), then the in-process rule below
 * (company data needs `company.deals.manage`, R28). Signed URLs are computed locally (no provider call in a request);
 * the bytes never pass through the API.
 */
export class FilesService {
  private readonly uploadTtl: number;
  private readonly downloadTtl: number;

  constructor(private readonly ctx: AppContext, private readonly principals: PrincipalService, private readonly policy: ParticipationService, private readonly options: FilesServiceOptions) {
    this.uploadTtl = boundedTtl('upload', options.uploadTtlSeconds);
    this.downloadTtl = boundedTtl('download', options.downloadTtlSeconds);
  }

  private run<T>(state: RequestState, fn: (trx: Transaction, principal: Principal) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, fn).catch(mapDatabaseError);
  }

  private hasDeals(p: Principal): boolean {
    return p.membership?.permissions.includes('company.deals.manage') ?? false;
  }

  /** The caller acts for the party: the person itself, or a member of the active employer with company.deals.manage. */
  private actsFor(p: Principal, party: Party): boolean {
    if (party.kind === 'person') return party.id === p.personId;
    return p.membership?.companyId === party.id && this.hasDeals(p);
  }

  private async actor(p: Principal, input: FileActorInput, action: FileMandateCheck['action'], parent: FileParentRef): Promise<{ via: 'person' | 'agent'; mandateId: string | null }> {
    if (input.via === 'person') return { via: 'person', mandateId: null };
    const ok = await this.options.mandates.allows({ personId: p.personId, mandateId: input.mandateId, action, context: mandateContext(parent), at: this.ctx.clock.now() });
    if (!ok) throw new ApiError('access.mandate_scope', `the agent needs a ${action} mandate for this object`);
    return { via: 'agent', mandateId: input.mandateId };
  }

  /**
   * In-process read rule on top of the database policy. The owner person reads its files; company files need
   * company.deals.manage unless public; a `shared` file of another party needs a live participation of the caller (in
   * person, or of the employer with company.deals.manage) that carries `read.shared`; public files follow the parent.
   */
  private async mayRead(trx: Transaction, p: Principal, row: FileRow): Promise<boolean> {
    if (row.owner_person_id !== null && row.owner_person_id === p.personId) return true;
    if (row.owner_company_id !== null && row.owner_company_id === p.membership?.companyId) return row.classification === 'public' || this.hasDeals(p);
    if (row.scan_state !== 'clean') return false;
    if (row.classification === 'public') return true;
    if (row.classification !== 'shared' || !RESOURCE_KINDS.has(row.parent_kind)) return false;
    const rows = await this.policy.rowsFor(trx, { kind: row.parent_kind as 'project', id: row.parent_id });
    const now = this.ctx.clock.now().getTime();
    return rows.some((r) => r.side !== 'staff' && r.revokedAt === null && Date.parse(r.validFrom) <= now && (r.validUntil === null || Date.parse(r.validUntil) > now)
      && r.capabilities.includes('read.shared')
      && ((r.party.kind === 'person' && r.party.id === p.personId) || (r.party.kind === 'company' && r.party.id === p.membership?.companyId && this.hasDeals(p))));
  }

  private async load(trx: Transaction, p: Principal, id: string): Promise<FileRow> {
    if (!UUID.test(id)) throw new ApiError('access.not_found');
    const row = await files.get(trx, id);
    if (!row || !(await this.mayRead(trx, p, row))) throw new ApiError('access.not_found');
    return row;
  }

  private view(row: FileRow, p: Principal): FileRef {
    const owner = partyOf(row);
    return FileRefSchema.parse({
      id: row.id, owner, parent: { kind: row.parent_kind, id: row.parent_id }, classification: row.classification, mediaType: row.media_type, bytes: Number(row.bytes),
      sha256: row.sha256, scanState: row.scan_state, quarantineReason: this.actsFor(p, owner) ? (row.state?.quarantine_reason ?? null) : null,
      origin: row.state?.origin ?? 'upload', uploadedBy: row.uploaded_by, createdAt: iso(row.created_at), revision: row.revision,
    });
  }

  private async audit(trx: Transaction, p: Principal, state: RequestState, action: string, objectId: string, basis: Record<string, unknown>): Promise<void> {
    await auditEvents.append(trx, { actor_person_id: p.personId, action, object_kind: 'evidence_artifact', object_id: objectId, request_id: state.requestId, authz_epoch: p.authzEpoch, basis });
  }
  /** Identifiers only; the worker reads everything else under its own role. */
  private async event(trx: Transaction, type: z.infer<typeof FileEventTypeSchema>, artifactId: string, revision: number): Promise<void> {
    await outbox.append(trx, { aggregate_kind: 'evidence_artifact', aggregate_id: artifactId, revision, type, payload: { artifactId } });
  }

  /** Storage key of an upload: a digest of owner and upload key, so the same key for the same owner never makes a second file. */
  private uploadKey(owner: Party, uploadKey: string): string {
    return `files/u/${createHash('sha256').update(`${owner.kind}:${owner.id}:${uploadKey}`).digest('hex')}`;
  }

  async startUpload(input: StartUploadCommand, state: RequestState): Promise<StartUploadResult> {
    const limit = sizeLimitExceeded(input.mediaType, input.bytes);
    if (limit !== null) throw new ApiError('validation.payload_too_large', `at most ${limit} bytes for ${input.mediaType}`, { maximum: limit });
    const classification = resolveClassification(input.parent.kind, input.classification);
    if (classification === null) throw new ApiError('validation.schema', 'classification not accepted for this parent', { reason: 'classification_not_allowed', allowed: allowedClassifications(input.parent.kind) });
    return this.run(state, async (trx, p) => {
      if (!this.actsFor(p, input.owner)) throw new ApiError('access.forbidden', 'files belong to a party you act for', { reason: 'not_authorised' });
      if (!UUID.test(input.owner.id)) throw new ApiError('access.forbidden', 'files belong to a party you act for', { reason: 'not_authorised' });
      if (!UUID.test(input.parent.id)) throw new ApiError('access.not_found', 'not_found', { reason: 'parent_not_found' });
      const actor = await this.actor(p, input.actor, 'prepare', input.parent);
      const storageKey = this.uploadKey(input.owner, input.uploadKey);
      const { id } = await files.startUpload(trx, {
        owner: input.owner.kind === 'person' ? { personId: input.owner.id } : { companyId: input.owner.id },
        parent: input.parent, classification, storageKey, sha256: input.sha256, bytes: input.bytes, mediaType: input.mediaType, uploadedBy: p.personId,
      }, this.uploadTtl);
      const row = await files.get(trx, id);
      if (!row) throw new Error('uploaded artifact is not readable by its uploader');
      await this.audit(trx, p, state, 'file.upload_started', id, { parentKind: input.parent.kind, classification, mediaType: input.mediaType, bytes: input.bytes, via: actor.via, mandateId: actor.mandateId });
      const upload = this.options.store.presignPut(storageKey, { contentType: input.mediaType, contentLength: input.bytes, expiresInSeconds: this.uploadTtl, now: this.ctx.clock.now() });
      return StartUploadResultSchema.parse({ file: this.view(row, p), upload: { method: 'PUT', url: upload.url, headers: upload.headers, expiresAt: upload.expiresAt.toISOString() } });
    });
  }

  async completeUpload(id: string, input: In<typeof CompleteUploadCommandSchema>, state: RequestState): Promise<FileRef> {
    return this.run(state, async (trx, p) => {
      const row = await this.load(trx, p, id);
      if (row.uploaded_by !== p.personId) throw new ApiError('access.not_found');
      const actor = await this.actor(p, input.actor, 'prepare', { kind: row.parent_kind, id: row.parent_id });
      if (await files.completeUpload(trx, id)) {
        await this.audit(trx, p, state, 'file.upload_completed', id, { via: actor.via, mandateId: actor.mandateId });
        await this.event(trx, 'file.uploaded', id, row.revision);
      }
      return this.view((await files.get(trx, id)) as FileRow, p);
    });
  }

  async get(id: string, state: RequestState): Promise<FileRef> {
    return this.run(state, async (trx, p) => this.view(await this.load(trx, p, id), p));
  }

  async list(query: In<typeof FileListQuerySchema>, state: RequestState): Promise<z.infer<typeof FileListSchema>> {
    return this.run(state, async (trx, p) => {
      // The database returns only rows the caller may see; a parent the caller cannot see yields an empty list, the same
      // answer as a parent without files (no existence hint).
      if (!UUID.test(query.parentId)) return FileListSchema.parse({ items: [] });
      const rows = await files.forParent(trx, query.parentKind, query.parentId);
      const items: FileRef[] = [];
      for (const row of rows) if (await this.mayRead(trx, p, row)) items.push(this.view(row, p));
      return FileListSchema.parse({ items });
    });
  }

  /** A signed GET with a bounded lifetime, issued only after the read decision; only clean files are served. */
  async downloadUrl(id: string, state: RequestState): Promise<DownloadTicket> {
    return this.run(state, async (trx, p) => {
      const row = await this.load(trx, p, id);
      if (row.scan_state !== 'clean') throw new ApiError('validation.schema', 'the file is not available for download', { reason: row.scan_state === 'pending' ? 'scan_pending' : 'quarantined' });
      const download = this.options.store.presignGet(row.storage_key, { expiresInSeconds: this.downloadTtl, now: this.ctx.clock.now(), contentType: row.media_type, disposition: dispositionFor(row.media_type) });
      return DownloadTicketSchema.parse({ file: this.view(row, p), download: { method: 'GET', url: download.url, headers: download.headers, expiresAt: download.expiresAt.toISOString() } });
    });
  }

  private async transferChecks(trx: Transaction, p: Principal, id: string, parent: FileParentRef): Promise<FileRow> {
    const source = await this.load(trx, p, id);
    if (!this.actsFor(p, partyOf(source))) throw new ApiError('access.forbidden', 'only the owner party copies or moves a file', { reason: 'not_authorised' });
    if (!UUID.test(parent.id)) throw new ApiError('access.not_found', 'not_found', { reason: 'parent_not_found' });
    if (source.classification === 'restricted' || !allowedClassifications(parent.kind).includes(source.classification)) {
      throw new ApiError('validation.schema', 'the target parent does not accept this classification', { reason: 'classification_not_allowed' });
    }
    return source;
  }

  /** Copy to another parent of the same owner: same owner, classification and content; audited; the worker copies the bytes. */
  async copy(id: string, input: In<typeof CopyFileCommandSchema>, state: RequestState): Promise<FileRef> {
    return this.run(state, async (trx, p) => {
      const source = await this.transferChecks(trx, p, id, input.parent);
      const actor = await this.actor(p, input.actor, 'record_evidence', input.parent);
      const storageKey = `files/c/${createHash('sha256').update(randomUUID()).digest('hex')}`;
      const copyId = await files.copy(trx, source.id, input.parent, storageKey);
      const copy = await files.get(trx, copyId);
      if (!copy) throw new Error('copied artifact is not readable by its owner');
      const basis = { sourceId: source.id, from: { kind: source.parent_kind, id: source.parent_id }, to: input.parent, owner: partyOf(source), classification: source.classification, sha256: source.sha256, via: actor.via, mandateId: actor.mandateId };
      await this.audit(trx, p, state, 'file.copied', copyId, basis);
      await this.event(trx, 'file.copy_requested', copyId, copy.revision);
      return this.view(copy, p);
    });
  }

  /** Move to another parent of the same owner: a new artifact with the same owner, classification and bytes; audited. */
  async move(id: string, input: In<typeof MoveFileCommandSchema>, state: RequestState): Promise<FileRef> {
    return this.run(state, async (trx, p) => {
      const source = await this.transferChecks(trx, p, id, input.parent);
      const actor = await this.actor(p, input.actor, 'record_evidence', input.parent);
      const movedId = await files.move(trx, source.id, input.parent);
      const moved = await files.get(trx, movedId);
      if (!moved) throw new Error('moved artifact is not readable by its owner');
      const basis = { sourceId: source.id, from: { kind: source.parent_kind, id: source.parent_id }, to: input.parent, owner: partyOf(source), classification: source.classification, sha256: source.sha256, via: actor.via, mandateId: actor.mandateId };
      await this.audit(trx, p, state, 'file.moved', movedId, basis);
      await this.event(trx, 'file.moved', movedId, moved.revision);
      return this.view(moved, p);
    });
  }

  /** Deletion request by the owner party: hidden at once, removed by the worker with a tombstone. */
  async remove(id: string, input: In<typeof DeleteFileCommandSchema>, state: RequestState): Promise<z.infer<typeof DeleteFileResultSchema>> {
    return this.run(state, async (trx, p) => {
      const row = await this.load(trx, p, id);
      if (!this.actsFor(p, partyOf(row))) throw new ApiError('access.forbidden', 'only the owner party deletes a file', { reason: 'not_authorised' });
      const actor = await this.actor(p, input.actor, 'maintain_records', { kind: row.parent_kind, id: row.parent_id });
      if (await files.requestDeletion(trx, id)) {
        await this.audit(trx, p, state, 'file.deletion_requested', id, { via: actor.via, mandateId: actor.mandateId });
        await this.event(trx, 'file.deletion_requested', id, row.revision + 1);
      }
      return DeleteFileResultSchema.parse({ id, deletionRequested: true });
    });
  }
}
