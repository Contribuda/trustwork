import { provenance } from '../../../../../packages/data/src/repositories/provenance.js';
import { sql } from 'kysely';
import type { z } from 'zod';
import { DIGEST_ALGORITHM, type Principal } from '../../deps/contracts.js';
import { auditEvents, outbox, type Transaction } from '../../deps/data.js';
import { withoutPrincipal } from '../../common/db.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { PrincipalService } from '../identity/principal.service.js';
import type { SecondFactorService } from '../identity/second-factor/second-factor.service.js';
import {
  comments, digests, issues, publicContent, publications, walls,
  type AuthorshipInput, type ContentStaffContext, type DraftInput, type IssueRow, type MagazineDigestRow, type PublicationRow,
} from './deps.js';
import {
  ArchiveSchema, CommentsSchema, FeedSchema, ManagePublicationViewSchema, PublicationListSchema, PublicDigestSchema, PublicIssueSchema, PublicPublicationSchema, PublicVersionViewSchema,
  StaffDigestViewSchema, StaffIssueViewSchema, WallSchema,
  type AddWallCommandSchema, type CommentCommandSchema, type CorrectCommandSchema, type CreateDigestCommandSchema, type CreateIssueCommandSchema, type CreatePublicationCommandSchema,
  type CurateIssueCommandSchema, type DraftBody, type FeedQuerySchema, type ManagePublicationView, type PublicPublication, type RecordRenderCommandSchema, type RequestRenderCommandSchema,
  type SetLinksCommandSchema, type StaffActSchema,
} from './schemas.js';
import { iso, sourcesOf, toContractCorrection, toContractPublication, toContractVersion } from './serializers.js';

type In<T extends z.ZodType> = z.infer<T>;
type StaffAct = z.infer<typeof StaffActSchema> | undefined;
/** A console command after `ElevationGuard`: the verified elevation and the `Idempotency-Key` header. */
export interface Elevated { state: RequestState; elevationId: string; idempotencyKey: string | undefined }
type ConsoleBody = { idempotencyKey: string; reason: string; reasonCode?: string | undefined };

export interface ContentServiceOptions {
  /** The hub this API serves (`TRUSTWORK_HUB_ID`), read per request. */
  hubId: () => string | null;
  /** Formats the hub reviews before personal or company publications appear (hub policy; default none). */
  reviewFormats: readonly string[];
  /** Comments are off by default per hub (publishing.md "Community around publications"). */
  commentsEnabled: () => boolean;
}

/** Hints that mean "the record is not in the state this action needs" (409); every other content hint is a 422. */
const STATE_HINTS = new Set(['use_correction', 'not_draft', 'review_required', 'invalid_transition', 'retracted', 'not_published', 'no_draft', 'draft_pending', 'issue_frozen',
  'digest_frozen', 'immutable', 'authorship_frozen', 'retained', 'moderation_mismatch', 'render_not_allowed', 'issue_empty', 'authority_busy']);
const FORBIDDEN_HINTS = new Set(['not_authorised', 'self_grant', 'self_review', 'editorial_staff_only']);

/** Database refusals of the content commands as contract errors with a `details.reason` (never a private value). */
export function mapContentError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const pg = error as { code?: string; hint?: string; constraint?: string };
  if (pg && typeof pg.code === 'string') {
    const hint = pg.hint ?? '';
    if (hint === 'admin.elevation_required') throw new ApiError('access.forbidden', 'an elevated staff session is required', { required: 'elevation' });
    if (hint === 'admin.forbidden') throw new ApiError('access.forbidden', 'the staff role does not hold this permission at the hub', { reason: 'staff_permission_missing' });
    if (hint === 'admin.context_invalid') throw new ApiError('validation.schema', 'a staff reason is required', { reason: 'staff_reason_required' });
    if (hint === 'access.no_principal') throw new ApiError('auth.session_invalid', 'authentication required');
    if (hint === 'provenance.first_party_required' || hint === 'provenance.authority_changed') throw new ApiError('access.forbidden', 'current request authority required');
    if (hint.startsWith('content.')) {
      const reason = hint.slice('content.'.length);
      if (reason === 'not_found') throw new ApiError('access.not_found', 'not found');
      if (reason === 'revision_conflict') throw new ApiError('validation.revision_conflict', 'the record changed; reload and retry', { reason });
      if (FORBIDDEN_HINTS.has(reason)) throw new ApiError('access.forbidden', reason, { reason });
      if (STATE_HINTS.has(reason)) throw new ApiError('validation.revision_conflict', reason, { reason });
      throw new ApiError('validation.schema', reason, { reason });
    }
    if (hint === 'commercial.version_frozen') throw new ApiError('validation.revision_conflict', 'published records never change', { reason: 'immutable' });
    if (pg.code === '23505') throw new ApiError('validation.revision_conflict', 'a conflicting record already exists', { reason: 'already_exists', constraint: pg.constraint ?? null });
    if (pg.code === '23503') throw new ApiError('validation.schema', 'a referenced record does not exist', { reason: 'unknown_reference' });
    if (pg.code === '23514') throw new ApiError('validation.schema', 'the record breaks a content rule', { reason: 'invalid', constraint: pg.constraint ?? null });
  }
  throw error;
}

const asDraft = (d: DraftBody): DraftInput => ({ ...d, sourceRefs: d.sourceRefs });
const asAuthorship = (list: In<typeof CreatePublicationCommandSchema>['authorship']): AuthorshipInput[] => list.map((a) => ({ ...a }));

/**
 * Publications, corrections and curated issues (CNT-001). The database is the authority: every write is a content
 * command run as the acting person in one `PrincipalService.runAs` transaction (idempotency record included), which
 * checks author versus editor rights, staff permissions with an elevated session for the editorial office, the
 * lifecycle, immutability and the licence blockers, and writes the staff audit row. This service adds the domain audit
 * row and identifiers-only outbox events for participant actions, and serializes the frozen contracts. Public reads
 * use the `content_public_*` projections: identical for every caller, ordered by time and id only, with no counts.
 */
export class ContentService {
  constructor(
    private readonly ctx: AppContext,
    private readonly principals: PrincipalService,
    private readonly secondFactors: SecondFactorService,
    private readonly options: ContentServiceOptions,
  ) {}

  private hub(): string {
    const hub = this.options.hubId();
    if (!hub) throw new ApiError('access.not_found', 'this API serves no hub');
    return hub;
  }

  private run<T>(state: RequestState, fn: (trx: Transaction, principal: Principal) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, async (trx, principal) => {
      // Publishing, correcting and retracting are the person's own acts: no agent mandate kind covers them yet.
      if (principal.delegation) throw new ApiError('access.mandate_scope', 'publications are written by the person on the first-party form');
      return fn(trx, principal);
    }, { refreshStale: false }).catch(mapContentError);
  }

  private read<T>(fn: (trx: Transaction) => Promise<T>): Promise<T> {
    return withoutPrincipal(this.ctx.pool, fn).catch(mapContentError);
  }

  /** A staff act on a publication route: the elevation of this session plus the stated reason. */
  private async staffContext(state: RequestState, act: StaffAct): Promise<ContentStaffContext | null> {
    if (!act) return null;
    const elevation = await this.secondFactors.requireElevation(state);
    return { elevationId: elevation.id, requestId: state.requestId, reasonCode: act.reasonCode ?? 'editorial_action', reasonText: act.reason };
  }

  private consoleContext(e: Elevated, body: ConsoleBody): ContentStaffContext {
    if (e.idempotencyKey !== undefined && body.idempotencyKey !== e.idempotencyKey) throw new ApiError('validation.schema', 'idempotencyKey must equal the Idempotency-Key header', { reason: 'idempotency_key_mismatch' });
    return { elevationId: e.elevationId, requestId: e.state.requestId, reasonCode: body.reasonCode ?? 'console_action', reasonText: body.reason };
  }

  private async journal(trx: Transaction, principal: Principal, state: RequestState, row: PublicationRow, action: string, basis: Record<string, unknown> = {}): Promise<void> {
    await auditEvents.append(trx, { actor_person_id: principal.personId, action, object_kind: 'publication', object_id: row.id, request_id: state.requestId, authz_epoch: principal.authzEpoch, basis: { revision: row.revision, ...basis } });
    await outbox.append(trx, { aggregate_kind: 'publication', aggregate_id: row.id, revision: row.revision, type: action, payload: { publicationId: row.id, hubId: row.hub_id, status: row.status } });
  }

  // ---- Working views ------------------------------------------------------------------------------------------------

  private async manageView(trx: Transaction, principal: Principal, id: string): Promise<ManagePublicationView> {
    const row = await publications.get(trx, id);
    if (!row) throw new ApiError('access.not_found', 'not found');
    const [versions, authorship, editors, topics, links, corrections, editions] = await Promise.all([
      publications.versions(trx, id), publications.authorship(trx, id), publications.editors(trx, id), publications.topics(trx, id), publications.links(trx, id),
      publications.corrections(trx, id), publications.editions(trx, id),
    ]);
    const company = principal.membership;
    const owner = row.owner_person_id === principal.personId || (row.owner_company_id !== null && company?.companyId === row.owner_company_id && company.permissions.includes('company.publish'));
    const editor = editors.find((e) => e.person_id === principal.personId);
    const draft = versions.find((v) => v.status === 'draft') ?? null;
    return ManagePublicationViewSchema.parse({
      projection: 'working',
      publication: toContractPublication(row, { authorship, editors, topics, links }),
      ownerKind: row.owner_kind,
      owner: row.owner_person_id ? { kind: 'person', id: row.owner_person_id } : row.owner_company_id ? { kind: 'company', id: row.owner_company_id } : null,
      articleFormat: row.article_format, originalLanguage: row.original_language, licence: row.licence, requiresReview: row.requires_review,
      scheduledFor: iso(row.scheduled_for), firstPublishedAt: iso(row.first_published_at), moderation: row.moderation_state,
      retraction: row.retraction_note ? { note: row.retraction_note, retractedAt: iso(row.retracted_at) } : null,
      myRight: owner ? 'owner' : editor ? editor.rights : 'staff',
      draft: draft ? {
        version: draft.version, title: draft.title, body: draft.body, language: draft.language, sources: sourcesOf(draft.source_refs), treatment: draft.treatment, eventTime: iso(draft.event_time),
        assistantAssisted: draft.assistant_assisted, draftedBy: draft.drafted_by, updatedAt: iso(draft.updated_at),
      } : null,
      versions: versions.filter((v) => v.status === 'published').map((v) => ({
        contract: toContractVersion(v), language: v.language, treatment: v.treatment, sources: sourcesOf(v.source_refs), assistantAssisted: v.assistant_assisted, publishedBy: v.published_by,
      })),
      corrections: corrections.map(toContractCorrection),
      editorRights: editors.map((e) => ({ personId: e.person_id, rights: e.rights, grantedAt: iso(e.granted_at) })),
      editions: editions.map((l) => ({ id: l.id, originalId: l.original_publication_id, translationId: l.translation_publication_id, language: l.language, machineAssisted: l.machine_assisted, reviewed: l.reviewed_by !== null })),
    });
  }

  manage(state: RequestState, id: string): Promise<ManagePublicationView> {
    return this.principals.runAs(state, (trx, p) => this.manageView(trx, p, id)).catch(mapContentError);
  }

  mine(state: RequestState) {
    const hubId = this.hub();
    return this.principals.runAs(state, async (trx, p) => {
      const rows = await publications.listMine(trx, hubId, p.personId, p.membership?.permissions.includes('company.publish') ? p.membership.companyId : null);
      return PublicationListSchema.parse({ items: await Promise.all(rows.map((r) => this.contractOf(trx, r))) });
    }).catch(mapContentError);
  }

  private async contractOf(trx: Transaction, row: PublicationRow) {
    const [authorship, editors, topics, links] = await Promise.all([publications.authorship(trx, row.id), publications.editors(trx, row.id), publications.topics(trx, row.id), publications.links(trx, row.id)]);
    return toContractPublication(row, { authorship, editors, topics, links });
  }

  board(state: RequestState, status: string | undefined) {
    const hubId = this.hub();
    return this.principals.runAs(state, async (trx) => {
      const rows = await publications.listBoard(trx, hubId, status ?? null);
      return PublicationListSchema.parse({ items: await Promise.all(rows.map((r) => this.contractOf(trx, r))) });
    }).catch(mapContentError);
  }

  // ---- Publication commands -----------------------------------------------------------------------------------------

  async create(state: RequestState, body: In<typeof CreatePublicationCommandSchema>): Promise<ManagePublicationView> {
    const hubId = this.hub();
    if (body.owner.kind === 'editorial' && !body.staff) throw new ApiError('access.forbidden', 'the editorial office acts through an elevated staff session', { required: 'elevation' });
    const c = await this.staffContext(state, body.staff);
    return this.run(state, async (trx, p) => {
      const row = await publications.create(trx, body.owner.kind === 'editorial' ? c : null, {
        hubId, owner: body.owner, format: body.format, articleFormat: body.articleFormat, language: body.originalLanguage, licence: body.licence,
        requiresReview: this.options.reviewFormats.includes(body.format), draft: asDraft(body.draft), authorship: asAuthorship(body.authorship),
      });
      await this.journal(trx, p, state, row, 'publication.created', { format: row.format, ownerKind: row.owner_kind });
      return this.manageView(trx, p, row.id);
    });
  }

  private async command(state: RequestState, id: string, act: StaffAct, action: string, fn: (trx: Transaction, c: ContentStaffContext | null) => Promise<PublicationRow>): Promise<ManagePublicationView> {
    const c = await this.staffContext(state, act);
    return this.run(state, async (trx, p) => {
      const row = await fn(trx, c);
      await this.journal(trx, p, state, row, action, { staff: c !== null });
      return this.manageView(trx, p, id);
    });
  }

  saveDraft(state: RequestState, id: string, body: { expectedRevision: number; draft: DraftBody | null; authorship: In<typeof CreatePublicationCommandSchema>['authorship'] | null; staff?: StaffAct }) {
    return this.command(state, id, body.staff, 'publication.draft_saved', (trx, c) => publications.saveDraft(trx, c, id, body.expectedRevision, body.draft ? asDraft(body.draft) : null, body.authorship ? asAuthorship(body.authorship) : null));
  }
  submit(state: RequestState, id: string, body: { expectedRevision: number; staff?: StaffAct }) {
    return this.command(state, id, body.staff, 'publication.submitted', (trx, c) => publications.transition(trx, c, id, body.expectedRevision, 'in_review'));
  }
  returnToDraft(state: RequestState, id: string, body: { expectedRevision: number; staff?: StaffAct }) {
    return this.command(state, id, body.staff, 'publication.returned', (trx, c) => publications.transition(trx, c, id, body.expectedRevision, 'draft'));
  }
  publish(state: RequestState, id: string, body: { expectedRevision: number; scheduledFor: string | null; staff?: StaffAct }) {
    return this.command(state, id, body.staff, body.scheduledFor ? 'publication.scheduled' : 'publication.published', (trx, c) => publications.publish(trx, c, id, body.expectedRevision, body.scheduledFor));
  }
  correct(state: RequestState, id: string, body: In<typeof CorrectCommandSchema>) {
    return this.command(state, id, body.staff, 'publication.corrected', (trx, c) => publications.correct(trx, { ...c, sessionId: state.session!.id, requestId: state.requestId }, id, body.expectedRevision, asDraft(body.draft), body.note, body.reason));
  }
  retract(state: RequestState, id: string, body: { expectedRevision: number; note: string; staff?: StaffAct }) {
    return this.command(state, id, body.staff, 'publication.retracted', (trx, c) => publications.retract(trx, c, id, body.expectedRevision, body.note));
  }
  setLinks(state: RequestState, id: string, body: In<typeof SetLinksCommandSchema>) {
    const links = body.entityLinks?.map((l) => ({ kind: l.party.kind, id: l.party.id, relation: l.relation })) ?? null;
    return this.command(state, id, body.staff, 'publication.links_edited', (trx, c) => publications.setLinks(trx, c, id, body.expectedRevision, body.topics, links));
  }

  grantEditor(state: RequestState, id: string, body: { personId: string; rights: 'edit' | 'publish' }) {
    return this.run(state, async (trx, p) => {
      await publications.grantEditor(trx, id, body.personId, body.rights);
      const row = (await publications.get(trx, id)) as PublicationRow;
      await this.journal(trx, p, state, row, 'publication.editor_granted', { editorId: body.personId, rights: body.rights });
      return this.manageView(trx, p, id);
    });
  }
  revokeEditor(state: RequestState, id: string, personId: string) {
    return this.run(state, async (trx, p) => {
      await publications.revokeEditor(trx, id, personId);
      const row = await publications.get(trx, id);
      if (row) await this.journal(trx, p, state, row, 'publication.editor_revoked', { editorId: personId });
      return row ? this.manageView(trx, p, id) : { projection: 'revoked' as const, publicationId: id };
    });
  }

  async linkEdition(state: RequestState, id: string, body: { translationId: string; machineAssisted: boolean; staff?: StaffAct }) {
    const c = await this.staffContext(state, body.staff);
    return this.run(state, async (trx, p) => {
      const link = await publications.linkEdition(trx, c, id, body.translationId, body.machineAssisted);
      await auditEvents.append(trx, { actor_person_id: p.personId, action: 'publication.edition_linked', object_kind: 'edition_link', object_id: link.id, request_id: state.requestId, authz_epoch: p.authzEpoch, basis: { machineAssisted: link.machine_assisted } });
      return this.manageView(trx, p, id);
    });
  }
  async reviewEdition(state: RequestState, linkId: string, body: { staff?: StaffAct }) {
    const c = await this.staffContext(state, body.staff);
    return this.run(state, async (trx, p) => {
      const link = await publications.reviewEdition(trx, c, linkId);
      await auditEvents.append(trx, { actor_person_id: p.personId, action: 'publication.edition_reviewed', object_kind: 'edition_link', object_id: link.id, request_id: state.requestId, authz_epoch: p.authzEpoch });
      return this.manageView(trx, p, link.translation_publication_id);
    });
  }

  comment(state: RequestState, id: string, body: In<typeof CommentCommandSchema>) {
    if (!this.options.commentsEnabled()) throw new ApiError('access.forbidden', 'comments are off in this hub', { reason: 'comments_disabled' });
    return this.run(state, async (trx, p) => {
      const row = await comments.add(trx, id, body.parentId, body.body);
      await auditEvents.append(trx, { actor_person_id: p.personId, action: 'publication.commented', object_kind: 'publication_comment', object_id: row.id, request_id: state.requestId, authz_epoch: p.authzEpoch });
      await outbox.append(trx, { aggregate_kind: 'publication', aggregate_id: id, revision: row.revision, type: 'publication.commented', payload: { publicationId: id, commentId: row.id } });
      return { id: row.id, parentId: row.parent_id, authorId: row.author_person_id, body: row.body, createdAt: iso(row.created_at) as string };
    });
  }

  addWall(state: RequestState, body: In<typeof AddWallCommandSchema>) {
    return this.run(state, async (trx, p) => {
      let versionId: string | null = null;
      if (body.publicationVersion !== null) {
        const v = await trx.selectFrom('publication_version').select('id').where('publication_id', '=', body.publicationId).where('version', '=', body.publicationVersion).executeTakeFirst();
        versionId = v?.id ?? '00000000-0000-0000-0000-000000000000';
      }
      const row = await walls.add(trx, { kind: body.wall.kind, companyId: body.wall.kind === 'company' ? body.wall.id : null, publicationId: body.publicationId, versionId, pinned: body.pinned });
      await auditEvents.append(trx, { actor_person_id: p.personId, action: 'wall.referenced', object_kind: 'wall_reference', object_id: row.id, request_id: state.requestId, authz_epoch: p.authzEpoch });
      return this.wallOf(trx, row.wall_kind, (row.wall_person_id ?? row.wall_company_id) as string);
    });
  }
  removeWall(state: RequestState, id: string) {
    return this.run(state, async (trx, p) => {
      const row = await walls.remove(trx, id);
      await auditEvents.append(trx, { actor_person_id: p.personId, action: 'wall.reference_removed', object_kind: 'wall_reference', object_id: row.id, request_id: state.requestId, authz_epoch: p.authzEpoch });
      return this.wallOf(trx, row.wall_kind, (row.wall_person_id ?? row.wall_company_id) as string);
    });
  }

  // ---- Public projections -------------------------------------------------------------------------------------------

  private async wallOf(trx: Transaction, kind: 'person' | 'company', owner: string) {
    return WallSchema.parse({ owner: { kind, id: owner }, items: (await publicContent.wall(trx, kind, owner)) ?? [] });
  }
  wall(kind: 'person' | 'company', owner: string) {
    return this.read((trx) => this.wallOf(trx, kind, owner));
  }

  publication(id: string, channel: 'web' | 'feed' | 'pdf' = 'web'): Promise<PublicPublication> {
    const hubId = this.hub();
    return this.read(async (trx) => {
      const json = await publicContent.publication(trx, hubId, id) as Record<string, unknown> | null;
      if (!json) throw new ApiError('access.not_found', 'not found');
      const current = json.current as Record<string, unknown>;
      current.provenance = await provenance.deliveryMetadata(trx,hubId,id,Number(current.version),channel);
      return PublicPublicationSchema.parse({ projection: 'public', ...json, current: { ...current, sourceRefs: sourcesOf(current.sourceRefs) } });
    });
  }
  version(id: string, version: number, channel: 'web' | 'feed' | 'pdf' = 'web') {
    const hubId = this.hub();
    return this.read(async (trx) => {
      const json = await publicContent.version(trx, hubId, id, version) as Record<string, unknown> | null;
      if (!json) throw new ApiError('access.not_found', 'not found');
      json.provenance = await provenance.deliveryMetadata(trx,hubId,id,version,channel);
      return PublicVersionViewSchema.parse({ projection: 'public', publicationId: id, ...json, sourceRefs: sourcesOf(json.sourceRefs) });
    });
  }
  feed(query: In<typeof FeedQuerySchema>) {
    const hubId = this.hub();
    const limit = query.limit ?? 20;
    return this.read(async (trx) => {
      const items = (await publicContent.feed(trx, hubId, { format: query.format ?? null, topic: query.topic ?? null, before: query.before ?? null, beforeId: query.beforeId ?? null, limit })) as { id: string; firstPublishedAt: string }[];
      const last = items.length === limit ? items.at(-1) : undefined;
      return FeedSchema.parse({ items, next: last ? { before: last.firstPublishedAt, beforeId: last.id } : null });
    });
  }
  comments(id: string) {
    const hubId = this.hub();
    return this.read(async (trx) => CommentsSchema.parse({ items: (await publicContent.comments(trx, hubId, id)) ?? [] }));
  }
  issue(number: number, edition: number | undefined) {
    const hubId = this.hub();
    return this.read(async (trx) => {
      const json = await publicContent.issue(trx, hubId, number, edition ?? null) as Record<string, unknown> | null;
      if (!json) throw new ApiError('access.not_found', 'not found');
      type Item = { position: number; section: string; publicationId: string; publicationVersion: number };
      const items = json.items as Item[];
      const renders = json.renderArtifacts as { format: 'web' | 'pdf'; hash: string; sourceEdition: number }[];
      return PublicIssueSchema.parse({
        projection: 'public',
        issue: {
          id: json.id, number: json.number, date: json.date, status: json.status, edition: json.edition, revision: json.revision,
          items: items.map((i) => ({ position: i.position, publicationId: i.publicationId, publicationVersion: i.publicationVersion, section: i.section })),
          renderArtifacts: renders.map((r) => ({ format: r.format, hash: r.hash, sourceEdition: r.sourceEdition })),
        },
        theme: json.theme, coverAssetId: json.coverAssetId, editorLetterPublicationId: json.editorLetterPublicationId, currentEdition: json.currentEdition,
        digest: { algorithm: DIGEST_ALGORITHM, value: json.digest }, releasedAt: json.releasedAt, correctionNote: json.correctionNote, items, corrections: json.corrections,
      });
    });
  }
  pdf(number: number, edition: number | undefined) {
    const hubId = this.hub();
    return this.read(async trx => {
      const row = (await sql<{ bytes: Buffer; sha256: string; edition: number }>`SELECT * FROM trustwork.content_public_pdf(${hubId}::uuid, ${number}, ${edition ?? null}::integer)`.execute(trx)).rows[0];
      if (!row) throw new ApiError('access.not_found', 'not found');
      return row;
    });
  }
  archive(year: number | undefined) {
    const hubId = this.hub();
    return this.read(async (trx) => ArchiveSchema.parse({ issues: (await publicContent.archive(trx, hubId, year ?? null)) ?? [] }));
  }
  digest(id: string) {
    const hubId = this.hub();
    return this.read(async (trx) => {
      const json = await publicContent.digest(trx, hubId, id) as Record<string, unknown> | null;
      if (!json) throw new ApiError('access.not_found', 'not found');
      return PublicDigestSchema.parse({ projection: 'public', ...json });
    });
  }

  // ---- Magazine (staff console) -------------------------------------------------------------------------------------

  private staffRun<T>(e: Elevated, body: ConsoleBody, fn: (trx: Transaction, c: ContentStaffContext, p: Principal) => Promise<T>): Promise<T> {
    const c = this.consoleContext(e, body);
    return this.principals.runAs(e.state, (trx, p) => fn(trx, c, p)).catch(mapContentError);
  }

  private async issueView(trx: Transaction, row: IssueRow) {
    const revisions = await issues.revisions(trx, row.id);
    const renders = await issues.renders(trx, revisions.map((r) => r.id));
    return StaffIssueViewSchema.parse({
      projection: 'staff',
      issue: {
        id: row.id, hubId: row.hub_id, number: row.number, date: typeof row.issue_date === 'string' ? row.issue_date.slice(0, 10) : isoDate(row.issue_date), theme: row.theme, status: row.status,
        currentEdition: row.current_edition, coverAssetId: row.cover_asset_id, editorLetterPublicationId: row.editor_letter_publication_id, revision: row.revision,
      },
      revisions: await Promise.all(revisions.map(async (r) => ({
        id: r.id, edition: r.edition, status: r.status, digest: r.digest, correctionNote: r.correction_note, releasedAt: iso(r.released_at),
        items: (await issues.items(trx, r.id)).map((i) => ({ position: i.position, section: i.section, publicationId: i.publication_id, publicationVersion: i.version })),
        renders: renders.filter((x) => x.issue_revision_id === r.id).map((x) => ({ id: x.id, format: x.format, status: x.status, sha256: x.sha256, rendererVersion: x.renderer_version, failureReason: x.failure_reason })),
      }))),
    });
  }
  private async issueEvent(trx: Transaction, row: IssueRow, type: string): Promise<void> {
    await outbox.append(trx, { aggregate_kind: 'issue', aggregate_id: row.id, revision: row.revision, type, payload: { issueId: row.id, hubId: row.hub_id, edition: row.current_edition } });
  }
  /** Items name versions by number; the command pins the version ids of this hub's publications. */
  private async pins(trx: Transaction, items: { position: number; section: string; publicationId: string; publicationVersion: number }[]) {
    return Promise.all(items.map(async (i) => {
      const v = await trx.selectFrom('publication_version').select('id').where('publication_id', '=', i.publicationId).where('version', '=', i.publicationVersion).executeTakeFirst();
      if (!v) throw new ApiError('validation.schema', 'unknown publication version', { reason: 'version_not_published', position: i.position });
      return { position: i.position, section: i.section, publicationId: i.publicationId, publicationVersionId: v.id };
    }));
  }

  issues(state: RequestState) {
    const hubId = this.hub();
    return this.principals.runAs(state, async (trx) => ({ issues: await Promise.all((await issues.list(trx, hubId)).map((r) => this.issueView(trx, r))) })).catch(mapContentError);
  }
  issueById(state: RequestState, id: string) {
    return this.principals.runAs(state, async (trx) => {
      const row = await issues.get(trx, id);
      if (!row) throw new ApiError('access.not_found', 'not found');
      return this.issueView(trx, row);
    }).catch(mapContentError);
  }
  createIssue(e: Elevated, body: In<typeof CreateIssueCommandSchema>) {
    const hubId = this.hub();
    return this.staffRun(e, body, async (trx, c) => {
      const row = await issues.create(trx, c, { hubId, number: body.number, date: body.date, theme: body.theme, coverAssetId: body.coverAssetId, editorLetterId: body.editorLetterPublicationId });
      return this.issueView(trx, row);
    });
  }
  curateIssue(e: Elevated, id: string, body: In<typeof CurateIssueCommandSchema>) {
    return this.staffRun(e, body, async (trx, c) => {
      const items = body.items ? await this.pins(trx, body.items) : null;
      const row = await issues.curate(trx, c, id, body.expectedRevision, { items, theme: body.theme, coverAssetId: body.coverAssetId, editorLetterId: body.editorLetterPublicationId });
      return this.issueView(trx, row);
    });
  }
  issueStatus(e: Elevated, id: string, body: ConsoleBody & { expectedRevision: number; status: 'draft' | 'curated' | 'review' }) {
    return this.staffRun(e, body, async (trx, c) => this.issueView(trx, await issues.transition(trx, c, id, body.expectedRevision, body.status)));
  }
  releaseIssue(e: Elevated, id: string, body: ConsoleBody & { expectedRevision: number }) {
    return this.staffRun(e, body, async (trx, c) => {
      const row = await issues.release(trx, c, id, body.expectedRevision);
      await this.issueEvent(trx, row, row.current_edition === 1 ? 'issue.released' : 'issue.corrected');
      return this.issueView(trx, row);
    });
  }
  correctIssue(e: Elevated, id: string, body: ConsoleBody & { expectedRevision: number; note: string }) {
    return this.staffRun(e, body, async (trx, c) => this.issueView(trx, await issues.correct(trx, c, id, body.expectedRevision, body.note)));
  }
  requestRender(e: Elevated, id: string, body: In<typeof RequestRenderCommandSchema>) {
    return this.staffRun(e, body, async (trx, c) => {
      const render = await issues.requestRender(trx, c, id, body.edition, body.format);
      // The opt-in local renderer picks the job up from the outbox; identifiers only.
      await outbox.append(trx, { aggregate_kind: 'issue', aggregate_id: id, revision: render.revision, type: 'issue.render_requested', payload: { issueId: id, renderId: render.id, edition: body.edition, format: body.format } });
      return this.issueView(trx, (await issues.get(trx, id)) as IssueRow);
    });
  }
  recordRender(e: Elevated, renderId: string, body: In<typeof RecordRenderCommandSchema>) {
    return this.staffRun(e, body, async (trx, c) => {
      const o = body.outcome;
      const render = await issues.recordRender(trx, c, renderId, o.status === 'rendered'
        ? { status: 'rendered', artifactId: o.artifactId, sha256: o.sha256, rendererVersion: o.rendererVersion, failureReason: null }
        : { status: 'failed', artifactId: null, sha256: null, rendererVersion: null, failureReason: o.failureReason });
      const revision = await trx.selectFrom('issue_revision').select('issue_id').where('id', '=', render.issue_revision_id).executeTakeFirstOrThrow();
      return this.issueView(trx, (await issues.get(trx, revision.issue_id)) as IssueRow);
    });
  }

  private async digestView(trx: Transaction, row: MagazineDigestRow) {
    const items = await digests.items(trx, row.id);
    return StaffDigestViewSchema.parse({
      projection: 'staff',
      digest: { id: row.id, title: row.title, period: row.period, status: row.status, releasedAt: iso(row.released_at), revision: row.revision },
      items: items.map((i) => ({ position: i.position, homeNode: i.home_node, globalId: i.global_id, version: i.version, licence: i.licence, display: i.display, title: i.title })),
    });
  }
  createDigest(e: Elevated, body: In<typeof CreateDigestCommandSchema>) {
    const hubId = this.hub();
    return this.staffRun(e, body, async (trx, c) => this.digestView(trx, await digests.create(trx, c, { hubId, title: body.title, period: body.period, publicationIds: body.publicationIds })));
  }
  releaseDigest(e: Elevated, id: string, body: ConsoleBody & { expectedRevision: number }) {
    return this.staffRun(e, body, async (trx, c) => {
      const row = await digests.release(trx, c, id, body.expectedRevision);
      await outbox.append(trx, { aggregate_kind: 'magazine_digest', aggregate_id: row.id, revision: row.revision, type: 'digest.released', payload: { digestId: row.id, hubId: row.hub_id } });
      return this.digestView(trx, row);
    });
  }
  digestById(state: RequestState, id: string) {
    return this.principals.runAs(state, async (trx) => {
      const row = await digests.get(trx, id);
      if (!row) throw new ApiError('access.not_found', 'not found');
      return this.digestView(trx, row);
    }).catch(mapContentError);
  }
}

function isoDate(value: Date | string): string {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
