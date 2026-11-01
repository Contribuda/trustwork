import { sql, type RawBuilder } from 'kysely';
import type { Transaction } from '../pool.js';
import type {
  CorrectionTable, EditionLinkTable, EditorRightsValue, IssueRevisionTable, IssueTable, MagazineDigestTable, PublicationCommentTable, PublicationTable, PublicationVersionTable,
  RenderArtifactTable, WallReferenceTable,
} from '../schema/content.js';
import type { Selectable } from 'kysely';
import '../schema/content.js';

/**
 * Content persistence (CNT-001). Every write is a SECURITY DEFINER command of packages/data/migrations/content run
 * under `withPrincipal` as the acting person; editorial and magazine commands also take a staff `ContentStaffContext`
 * (a live elevation of the caller, a request id and a reason) and record an admin_audit_event in the same transaction.
 * Refusals are SQLSTATE 42501 / 23514 / P0002 / 40001 with a `content.*` or `admin.*` hint. Public reads go through
 * the `content_public_*` projections and need no identity.
 */
export type PublicationRow = Selectable<PublicationTable>;
export type PublicationVersionRow = Selectable<PublicationVersionTable>;
export type CorrectionRow = Selectable<CorrectionTable>;
export type EditionLinkRow = Selectable<EditionLinkTable>;
export type WallReferenceRow = Selectable<WallReferenceTable>;
export type PublicationCommentRow = Selectable<PublicationCommentTable>;
export type IssueRow = Selectable<IssueTable>;
export type IssueRevisionRow = Selectable<IssueRevisionTable>;
export type RenderArtifactRow = Selectable<RenderArtifactTable>;
export type MagazineDigestRow = Selectable<MagazineDigestTable>;

/** The staff context the editorial commands require (same shape as DATA-002's CommandContext). */
export interface ContentStaffContext { elevationId: string; requestId: string; reasonCode: string; reasonText: string }
/** Correction release retains the exact first-party request session, including participant commands. */
export type ContentCorrectionContext = { sessionId: string; requestId: string } & Partial<ContentStaffContext>;
/** A draft as the commands take it; sourceRefs keep the contract shape plus name, kind and allowedUses. */
export interface DraftInput {
  title: string;
  body: string;
  language: string;
  sourceRefs: unknown[];
  treatment: 'headline_link' | 'summary' | 'rewrite' | 'translation' | 'original_reporting';
  eventTime: string | null;
  assistantAssisted: boolean;
}
export interface AuthorshipInput { kind: 'person' | 'company' | 'editorial'; id?: string | undefined; credit: string; assistantAssisted: boolean }
export interface IssueItemInput { position: number; section: string; publicationId: string; publicationVersionId: string }

const ctx = (c: ContentStaffContext | ContentCorrectionContext | null) => (c ? JSON.stringify(c) : null);
const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));
async function one<T>(query: RawBuilder<T>, trx: Transaction, what: string): Promise<T> {
  const { rows } = await query.execute(trx);
  const row = rows[0];
  if (!row) throw new Error(`${what} returned no row`);
  return row;
}
async function value<T>(query: RawBuilder<{ v: T }>, trx: Transaction): Promise<T> {
  const { rows } = await query.execute(trx);
  return rows[0]?.v as T;
}

export const publications = {
  create(trx: Transaction, c: ContentStaffContext | null, input: {
    hubId: string; owner: { kind: 'person' } | { kind: 'company'; id: string } | { kind: 'editorial' }; format: string; articleFormat: string | null; language: string;
    licence: 'all_rights' | 'cc_by'; requiresReview: boolean; draft: DraftInput; authorship: AuthorshipInput[];
  }): Promise<PublicationRow> {
    return one(sql<PublicationRow>`SELECT * FROM trustwork.content_create(${ctx(c)}::jsonb, ${input.hubId}::uuid, ${input.owner.kind}, ${input.owner.kind === 'company' ? input.owner.id : null}::uuid,
      ${input.format}, ${input.articleFormat}, ${input.language}, ${input.licence}, ${input.requiresReview}, ${json(input.draft)}::jsonb, ${json(input.authorship)}::jsonb)`, trx, 'content_create');
  },
  saveDraft(trx: Transaction, c: ContentStaffContext | null, id: string, expectedRevision: number, draft: DraftInput | null, authorship: AuthorshipInput[] | null): Promise<PublicationRow> {
    return one(sql<PublicationRow>`SELECT * FROM trustwork.content_save_draft(${ctx(c)}::jsonb, ${id}::uuid, ${expectedRevision}::int, ${json(draft)}::jsonb, ${json(authorship)}::jsonb)`, trx, 'content_save_draft');
  },
  transition(trx: Transaction, c: ContentStaffContext | null, id: string, expectedRevision: number, to: 'in_review' | 'draft'): Promise<PublicationRow> {
    return one(sql<PublicationRow>`SELECT * FROM trustwork.content_transition(${ctx(c)}::jsonb, ${id}::uuid, ${expectedRevision}::int, ${to})`, trx, 'content_transition');
  },
  publish(trx: Transaction, c: ContentStaffContext | null, id: string, expectedRevision: number, scheduledFor: string | null): Promise<PublicationRow> {
    return one(sql<PublicationRow>`SELECT * FROM trustwork.content_publish(${ctx(c)}::jsonb, ${id}::uuid, ${expectedRevision}::int, ${scheduledFor}::timestamptz)`, trx, 'content_publish');
  },
  correct(trx: Transaction, c: ContentStaffContext | ContentCorrectionContext | null, id: string, expectedRevision: number, draft: DraftInput, note: string, reason: string): Promise<PublicationRow> {
    return one(sql<PublicationRow>`SELECT * FROM trustwork.content_correct(${ctx(c)}::jsonb, ${id}::uuid, ${expectedRevision}::int, ${json(draft)}::jsonb, ${note}, ${reason})`, trx, 'content_correct');
  },
  retract(trx: Transaction, c: ContentStaffContext | null, id: string, expectedRevision: number, note: string): Promise<PublicationRow> {
    return one(sql<PublicationRow>`SELECT * FROM trustwork.content_retract(${ctx(c)}::jsonb, ${id}::uuid, ${expectedRevision}::int, ${note})`, trx, 'content_retract');
  },
  setLinks(trx: Transaction, c: ContentStaffContext | null, id: string, expectedRevision: number, topics: string[] | null, links: { kind: 'person' | 'company'; id: string; relation: string }[] | null): Promise<PublicationRow> {
    return one(sql<PublicationRow>`SELECT * FROM trustwork.content_set_links(${ctx(c)}::jsonb, ${id}::uuid, ${expectedRevision}::int, ${topics}::text[], ${json(links)}::jsonb)`, trx, 'content_set_links');
  },
  grantEditor(trx: Transaction, id: string, personId: string, rights: EditorRightsValue) {
    return one(sql<{ id: string }>`SELECT * FROM trustwork.content_grant_editor(${id}::uuid, ${personId}::uuid, ${rights})`, trx, 'content_grant_editor');
  },
  revokeEditor(trx: Transaction, id: string, personId: string) {
    return one(sql<{ id: string }>`SELECT * FROM trustwork.content_revoke_editor(${id}::uuid, ${personId}::uuid)`, trx, 'content_revoke_editor');
  },
  linkEdition(trx: Transaction, c: ContentStaffContext | null, originalId: string, translationId: string, machineAssisted: boolean): Promise<EditionLinkRow> {
    return one(sql<EditionLinkRow>`SELECT * FROM trustwork.content_link_edition(${ctx(c)}::jsonb, ${originalId}::uuid, ${translationId}::uuid, ${machineAssisted})`, trx, 'content_link_edition');
  },
  reviewEdition(trx: Transaction, c: ContentStaffContext | null, linkId: string): Promise<EditionLinkRow> {
    return one(sql<EditionLinkRow>`SELECT * FROM trustwork.content_review_edition(${ctx(c)}::jsonb, ${linkId}::uuid)`, trx, 'content_review_edition');
  },
  /** Rows the caller may see (row-level security: owner party, live editor, publications staff). */
  get(trx: Transaction, id: string): Promise<PublicationRow | undefined> {
    return trx.selectFrom('publication').selectAll().where('id', '=', id).executeTakeFirst();
  },
  /** The caller's working set in this hub: owned or edited publications, newest first. */
  listMine(trx: Transaction, hubId: string, personId: string, companyId: string | null, limit = 200): Promise<PublicationRow[]> {
    return trx.selectFrom('publication').selectAll().where('hub_id', '=', hubId)
      .where((eb) => eb.or([
        eb('owner_person_id', '=', personId),
        ...(companyId ? [eb('owner_company_id', '=', companyId)] : []),
        eb.exists(eb.selectFrom('publication_editor as e').select('e.id').whereRef('e.publication_id', '=', 'publication.id').where('e.person_id', '=', personId).where('e.revoked_at', 'is', null)),
      ]))
      .orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit).execute();
  },
  /** The editorial board: every publication of the hub the staff member may read, by status. */
  listBoard(trx: Transaction, hubId: string, status: string | null, limit = 200): Promise<PublicationRow[]> {
    let q = trx.selectFrom('publication').selectAll().where('hub_id', '=', hubId);
    if (status) q = q.where('status', '=', status as PublicationRow['status']);
    return q.orderBy('updated_at', 'desc').orderBy('id', 'desc').limit(limit).execute();
  },
  versions(trx: Transaction, id: string): Promise<PublicationVersionRow[]> {
    return trx.selectFrom('publication_version').selectAll().where('publication_id', '=', id).orderBy('version').execute();
  },
  authorship(trx: Transaction, id: string) {
    return trx.selectFrom('publication_authorship').selectAll().where('publication_id', '=', id).orderBy('position').execute();
  },
  editors(trx: Transaction, id: string) {
    return trx.selectFrom('publication_editor').selectAll().where('publication_id', '=', id).where('revoked_at', 'is', null).orderBy('granted_at').execute();
  },
  topics(trx: Transaction, id: string): Promise<string[]> {
    return trx.selectFrom('publication_topic as pt').innerJoin('taxonomy_term as t', 't.id', 'pt.term_id').select('t.code').where('pt.publication_id', '=', id).where('pt.removed_at', 'is', null)
      .orderBy('t.code').execute().then((rows) => rows.map((r) => r.code));
  },
  links(trx: Transaction, id: string) {
    return trx.selectFrom('entity_link').selectAll().where('publication_id', '=', id).where('removed_at', 'is', null).orderBy('created_at').orderBy('id').execute();
  },
  corrections(trx: Transaction, id: string): Promise<CorrectionRow[]> {
    return trx.selectFrom('correction').selectAll().where('publication_id', '=', id).orderBy('corrected_at').execute();
  },
  editions(trx: Transaction, id: string): Promise<EditionLinkRow[]> {
    return trx.selectFrom('edition_link').selectAll().where((eb) => eb.or([eb('original_publication_id', '=', id), eb('translation_publication_id', '=', id)])).orderBy('created_at').execute();
  },
};

export const walls = {
  add(trx: Transaction, input: { kind: 'person' | 'company'; companyId: string | null; publicationId: string; versionId: string | null; pinned: boolean }): Promise<WallReferenceRow> {
    return one(sql<WallReferenceRow>`SELECT * FROM trustwork.content_wall_add(${input.kind}, ${input.companyId}::uuid, ${input.publicationId}::uuid, ${input.versionId}::uuid, ${input.pinned})`, trx, 'content_wall_add');
  },
  remove(trx: Transaction, id: string): Promise<WallReferenceRow> {
    return one(sql<WallReferenceRow>`SELECT * FROM trustwork.content_wall_remove(${id}::uuid)`, trx, 'content_wall_remove');
  },
};

export const comments = {
  add(trx: Transaction, publicationId: string, parentId: string | null, body: string): Promise<PublicationCommentRow> {
    return one(sql<PublicationCommentRow>`SELECT * FROM trustwork.content_comment(${publicationId}::uuid, ${parentId}::uuid, ${body})`, trx, 'content_comment');
  },
};

export const contentModeration = {
  /** ADM-001 ModerationTargetPort effect, inside the staff command's transaction; returns applied | unknown_target | not_content | none. */
  apply(trx: Transaction, moderationCaseId: string, effect: 'hold' | 'remove' | 'restore' | 'none'): Promise<string> {
    return value(sql<{ v: string }>`SELECT trustwork.content_apply_moderation(${moderationCaseId}::uuid, ${effect}) AS v`, trx);
  },
};

export const issues = {
  create(trx: Transaction, c: ContentStaffContext, input: { hubId: string; number: number; date: string; theme: string | null; coverAssetId: string | null; editorLetterId: string | null }): Promise<IssueRow> {
    return one(sql<IssueRow>`SELECT * FROM trustwork.content_issue_create(${ctx(c)}::jsonb, ${input.hubId}::uuid, ${input.number}::int, ${input.date}::date, ${input.theme}, ${input.coverAssetId}::uuid,
      ${input.editorLetterId}::uuid)`, trx, 'content_issue_create');
  },
  curate(trx: Transaction, c: ContentStaffContext, id: string, expectedRevision: number, input: { items: IssueItemInput[] | null; theme: string | null; coverAssetId: string | null; editorLetterId: string | null }): Promise<IssueRow> {
    return one(sql<IssueRow>`SELECT * FROM trustwork.content_issue_curate(${ctx(c)}::jsonb, ${id}::uuid, ${expectedRevision}::int, ${json(input.items)}::jsonb, ${input.theme}, ${input.coverAssetId}::uuid,
      ${input.editorLetterId}::uuid)`, trx, 'content_issue_curate');
  },
  transition(trx: Transaction, c: ContentStaffContext, id: string, expectedRevision: number, to: 'draft' | 'curated' | 'review'): Promise<IssueRow> {
    return one(sql<IssueRow>`SELECT * FROM trustwork.content_issue_transition(${ctx(c)}::jsonb, ${id}::uuid, ${expectedRevision}::int, ${to})`, trx, 'content_issue_transition');
  },
  release(trx: Transaction, c: ContentStaffContext, id: string, expectedRevision: number): Promise<IssueRow> {
    return one(sql<IssueRow>`SELECT * FROM trustwork.content_issue_release(${ctx(c)}::jsonb, ${id}::uuid, ${expectedRevision}::int)`, trx, 'content_issue_release');
  },
  correct(trx: Transaction, c: ContentStaffContext, id: string, expectedRevision: number, note: string): Promise<IssueRow> {
    return one(sql<IssueRow>`SELECT * FROM trustwork.content_issue_correct(${ctx(c)}::jsonb, ${id}::uuid, ${expectedRevision}::int, ${note})`, trx, 'content_issue_correct');
  },
  requestRender(trx: Transaction, c: ContentStaffContext, id: string, edition: number, format: 'web' | 'pdf'): Promise<RenderArtifactRow> {
    return one(sql<RenderArtifactRow>`SELECT * FROM trustwork.content_render_request(${ctx(c)}::jsonb, ${id}::uuid, ${edition}::int, ${format})`, trx, 'content_render_request');
  },
  recordRender(trx: Transaction, c: ContentStaffContext, renderId: string, input: { status: 'rendered' | 'failed'; artifactId: string | null; sha256: string | null; rendererVersion: string | null; failureReason: string | null }): Promise<RenderArtifactRow> {
    return one(sql<RenderArtifactRow>`SELECT * FROM trustwork.content_render_record(${ctx(c)}::jsonb, ${renderId}::uuid, ${input.status}, ${input.artifactId}::uuid, ${input.sha256}, ${input.rendererVersion},
      ${input.failureReason})`, trx, 'content_render_record');
  },
  get(trx: Transaction, id: string): Promise<IssueRow | undefined> {
    return trx.selectFrom('issue').selectAll().where('id', '=', id).executeTakeFirst();
  },
  list(trx: Transaction, hubId: string): Promise<IssueRow[]> {
    return trx.selectFrom('issue').selectAll().where('hub_id', '=', hubId).orderBy('number', 'desc').limit(500).execute();
  },
  revisions(trx: Transaction, id: string): Promise<IssueRevisionRow[]> {
    return trx.selectFrom('issue_revision').selectAll().where('issue_id', '=', id).orderBy('edition').execute();
  },
  items(trx: Transaction, revisionId: string) {
    return trx.selectFrom('issue_item as i').innerJoin('publication_version as v', 'v.id', 'i.publication_version_id')
      .select(['i.position', 'i.section', 'i.publication_id', 'i.publication_version_id', 'v.version']).where('i.issue_revision_id', '=', revisionId).orderBy('i.position').execute();
  },
  renders(trx: Transaction, revisionIds: string[]): Promise<RenderArtifactRow[]> {
    if (!revisionIds.length) return Promise.resolve([]);
    return trx.selectFrom('render_artifact').selectAll().where('issue_revision_id', 'in', revisionIds).orderBy('requested_at').execute();
  },
};

export const digests = {
  create(trx: Transaction, c: ContentStaffContext, input: { hubId: string; title: string; period: string; publicationIds: string[] }): Promise<MagazineDigestRow> {
    return one(sql<MagazineDigestRow>`SELECT * FROM trustwork.content_digest_create(${ctx(c)}::jsonb, ${input.hubId}::uuid, ${input.title}, ${input.period}, ${input.publicationIds}::uuid[])`, trx, 'content_digest_create');
  },
  release(trx: Transaction, c: ContentStaffContext, id: string, expectedRevision: number): Promise<MagazineDigestRow> {
    return one(sql<MagazineDigestRow>`SELECT * FROM trustwork.content_digest_release(${ctx(c)}::jsonb, ${id}::uuid, ${expectedRevision}::int)`, trx, 'content_digest_release');
  },
  get(trx: Transaction, id: string): Promise<MagazineDigestRow | undefined> {
    return trx.selectFrom('magazine_digest').selectAll().where('id', '=', id).executeTakeFirst();
  },
  items(trx: Transaction, id: string) {
    return trx.selectFrom('magazine_digest_item').selectAll().where('digest_id', '=', id).orderBy('position').execute();
  },
};

/** Public projections: identical for every caller, no identity needed (null when nothing public exists). */
export const publicContent = {
  publication(trx: Transaction, hubId: string, id: string): Promise<unknown> {
    return value(sql<{ v: unknown }>`SELECT trustwork.content_public_publication(${hubId}::uuid, ${id}::uuid) AS v`, trx);
  },
  version(trx: Transaction, hubId: string, id: string, version: number): Promise<unknown> {
    return value(sql<{ v: unknown }>`SELECT trustwork.content_public_version(${hubId}::uuid, ${id}::uuid, ${version}::int) AS v`, trx);
  },
  feed(trx: Transaction, hubId: string, filter: { format: string | null; topic: string | null; before: string | null; beforeId: string | null; limit: number }): Promise<unknown> {
    return value(sql<{ v: unknown }>`SELECT trustwork.content_public_feed(${hubId}::uuid, ${filter.format}, ${filter.topic}, ${filter.before}::timestamptz, ${filter.beforeId}::uuid, ${filter.limit}::int) AS v`, trx);
  },
  issue(trx: Transaction, hubId: string, number: number, edition: number | null): Promise<unknown> {
    return value(sql<{ v: unknown }>`SELECT trustwork.content_public_issue(${hubId}::uuid, ${number}::int, ${edition}::int) AS v`, trx);
  },
  archive(trx: Transaction, hubId: string, year: number | null): Promise<unknown> {
    return value(sql<{ v: unknown }>`SELECT trustwork.content_public_archive(${hubId}::uuid, ${year}::int) AS v`, trx);
  },
  wall(trx: Transaction, kind: 'person' | 'company', ownerId: string): Promise<unknown> {
    return value(sql<{ v: unknown }>`SELECT trustwork.content_public_wall(${kind}, ${ownerId}::uuid) AS v`, trx);
  },
  comments(trx: Transaction, hubId: string, publicationId: string): Promise<unknown> {
    return value(sql<{ v: unknown }>`SELECT trustwork.content_public_comments(${hubId}::uuid, ${publicationId}::uuid) AS v`, trx);
  },
  digest(trx: Transaction, hubId: string, id: string): Promise<unknown> {
    return value(sql<{ v: unknown }>`SELECT trustwork.content_public_digest(${hubId}::uuid, ${id}::uuid) AS v`, trx);
  },
};

/** Worker entry point (trustwork_worker): publishes scheduled publications whose time has come. */
export const contentWorker = {
  publishDue(trx: Transaction, limit = 50): Promise<number> {
    return value(sql<{ v: number }>`SELECT trustwork.content_publish_due(${limit}::int) AS v`, trx);
  },
};
