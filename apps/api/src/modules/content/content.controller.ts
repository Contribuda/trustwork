import type { FastifyReply } from 'fastify';
import { Controller, Get, HttpCode, Inject, Post, Res, UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { Authenticated, Idempotent, Req, ReqState, type RequestState, type TrustworkRequest } from '../../common/request.js';
import { Body, Params, Query } from '../../common/zod.js';
import { Elevation, ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import type { SessionElevationRow } from '../identity/second-factor/deps.js';
import { ContentService, type Elevated } from './content.service.js';
import {
  AddWallCommandSchema, ArchiveQuerySchema, BoardQuerySchema, CommentCommandSchema, CorrectCommandSchema, CorrectIssueCommandSchema, CreateDigestCommandSchema, CreateIssueCommandSchema,
  CreatePublicationCommandSchema, CurateIssueCommandSchema, DigestReleaseCommandSchema, EditorParams, EmptyCommandSchema, FeedQuerySchema, GrantEditorCommandSchema, IdParams,
  IssueNumberParams, IssueQuerySchema, IssueRevisionCommandSchema, IssueStatusCommandSchema, LinkEditionCommandSchema, PublishCommandSchema, RecordRenderCommandSchema,
  RequestRenderCommandSchema, RetractCommandSchema, ReviewEditionCommandSchema, RevisionCommandSchema, SaveDraftCommandSchema, SetLinksCommandSchema, VersionParams, WallParams,
} from './schemas.js';

type P<T extends z.ZodType> = z.infer<T>;
type Id = P<typeof IdParams>;

/**
 * Writing and managing publications (CNT-001). Every route needs a session; mutations carry the CSRF header and an
 * `Idempotency-Key` and complete in their request transaction. A body with `staff` acts as hub staff (editorial office,
 * reviewer, link fixes) and additionally needs a live elevation of this session; the database checks the permission.
 */
@Controller('v1')
@Authenticated()
export class PublicationsController {
  constructor(@Inject(ContentService) private readonly content: ContentService) {}

  @Get('me/publications')
  mine(@ReqState() state: RequestState) {
    return this.content.mine(state);
  }

  @Post('publications') @HttpCode(201) @Idempotent('content.publication_create')
  create(@Body(CreatePublicationCommandSchema) body: P<typeof CreatePublicationCommandSchema>, @ReqState() state: RequestState) {
    return this.content.create(state, body);
  }

  @Get('publications/:id/manage')
  manage(@Params(IdParams) params: Id, @ReqState() state: RequestState) {
    return this.content.manage(state, params.id);
  }

  @Post('publications/:id/draft') @HttpCode(200) @Idempotent('content.publication_draft', 'id')
  draft(@Params(IdParams) params: Id, @Body(SaveDraftCommandSchema) body: P<typeof SaveDraftCommandSchema>, @ReqState() state: RequestState) {
    return this.content.saveDraft(state, params.id, body);
  }

  @Post('publications/:id/submit') @HttpCode(200) @Idempotent('content.publication_submit', 'id')
  submit(@Params(IdParams) params: Id, @Body(RevisionCommandSchema) body: P<typeof RevisionCommandSchema>, @ReqState() state: RequestState) {
    return this.content.submit(state, params.id, body);
  }

  @Post('publications/:id/return') @HttpCode(200) @Idempotent('content.publication_return', 'id')
  returnToDraft(@Params(IdParams) params: Id, @Body(RevisionCommandSchema) body: P<typeof RevisionCommandSchema>, @ReqState() state: RequestState) {
    return this.content.returnToDraft(state, params.id, body);
  }

  @Post('publications/:id/publish') @HttpCode(200) @Idempotent('content.publication_publish', 'id')
  publish(@Params(IdParams) params: Id, @Body(PublishCommandSchema) body: P<typeof PublishCommandSchema>, @ReqState() state: RequestState) {
    return this.content.publish(state, params.id, body);
  }

  @Post('publications/:id/corrections') @HttpCode(201) @Idempotent('content.publication_correct', 'id')
  correct(@Params(IdParams) params: Id, @Body(CorrectCommandSchema) body: P<typeof CorrectCommandSchema>, @ReqState() state: RequestState) {
    return this.content.correct(state, params.id, body);
  }

  @Post('publications/:id/retract') @HttpCode(200) @Idempotent('content.publication_retract', 'id')
  retract(@Params(IdParams) params: Id, @Body(RetractCommandSchema) body: P<typeof RetractCommandSchema>, @ReqState() state: RequestState) {
    return this.content.retract(state, params.id, body);
  }

  @Post('publications/:id/links') @HttpCode(200) @Idempotent('content.publication_links', 'id')
  links(@Params(IdParams) params: Id, @Body(SetLinksCommandSchema) body: P<typeof SetLinksCommandSchema>, @ReqState() state: RequestState) {
    return this.content.setLinks(state, params.id, body);
  }

  @Post('publications/:id/editors') @HttpCode(200) @Idempotent('content.editor_grant', 'id')
  grantEditor(@Params(IdParams) params: Id, @Body(GrantEditorCommandSchema) body: P<typeof GrantEditorCommandSchema>, @ReqState() state: RequestState) {
    return this.content.grantEditor(state, params.id, body);
  }

  @Post('publications/:id/editors/:personId/revoke') @HttpCode(200) @Idempotent('content.editor_revoke', 'id')
  revokeEditor(@Params(EditorParams) params: P<typeof EditorParams>, @Body(EmptyCommandSchema) _body: P<typeof EmptyCommandSchema>, @ReqState() state: RequestState) {
    return this.content.revokeEditor(state, params.id, params.personId);
  }

  @Post('publications/:id/editions') @HttpCode(201) @Idempotent('content.edition_link', 'id')
  linkEdition(@Params(IdParams) params: Id, @Body(LinkEditionCommandSchema) body: P<typeof LinkEditionCommandSchema>, @ReqState() state: RequestState) {
    return this.content.linkEdition(state, params.id, body);
  }

  @Post('edition-links/:id/review') @HttpCode(200) @Idempotent('content.edition_review', 'id')
  reviewEdition(@Params(IdParams) params: Id, @Body(ReviewEditionCommandSchema) body: P<typeof ReviewEditionCommandSchema>, @ReqState() state: RequestState) {
    return this.content.reviewEdition(state, params.id, body);
  }

  @Post('publications/:id/comments') @HttpCode(201) @Idempotent('content.comment', 'id')
  comment(@Params(IdParams) params: Id, @Body(CommentCommandSchema) body: P<typeof CommentCommandSchema>, @ReqState() state: RequestState) {
    return this.content.comment(state, params.id, body);
  }

  @Post('walls') @HttpCode(201) @Idempotent('content.wall_add')
  addWall(@Body(AddWallCommandSchema) body: P<typeof AddWallCommandSchema>, @ReqState() state: RequestState) {
    return this.content.addWall(state, body);
  }

  @Post('walls/:id/remove') @HttpCode(200) @Idempotent('content.wall_remove', 'id')
  removeWall(@Params(IdParams) params: Id, @Body(EmptyCommandSchema) _body: P<typeof EmptyCommandSchema>, @ReqState() state: RequestState) {
    return this.content.removeWall(state, params.id);
  }
}

/**
 * Public reading: the projections are identical for every caller (signed in or not), ordered by time and id only,
 * and carry no readership, traffic, price or paywall field.
 */
@Controller('v1')
export class PublicContentController {
  constructor(@Inject(ContentService) private readonly content: ContentService) {}

  @Get('publications')
  feed(@Query(FeedQuerySchema) query: P<typeof FeedQuerySchema>) {
    return this.content.feed(query);
  }

  @Get('publications/:id')
  publication(@Params(IdParams) params: Id) {
    return this.content.publication(params.id);
  }

  @Get('publications/:id/versions/:version')
  version(@Params(VersionParams) params: P<typeof VersionParams>) {
    return this.content.version(params.id, params.version);
  }

  @Get('publications/:id/comments')
  comments(@Params(IdParams) params: Id) {
    return this.content.comments(params.id);
  }

  @Get('magazine/issues')
  archive(@Query(ArchiveQuerySchema) query: P<typeof ArchiveQuerySchema>) {
    return this.content.archive(query.year);
  }

  @Get('magazine/issues/:number/pdf')
  async pdf(@Params(IssueNumberParams) params: P<typeof IssueNumberParams>, @Query(IssueQuerySchema) query: P<typeof IssueQuerySchema>, @Res() reply: FastifyReply) {
    const artifact = await this.content.pdf(params.number, query.edition);
    return reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', `attachment; filename="issue-${params.number}-edition-${artifact.edition}.pdf"`)
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .type('application/pdf').send(artifact.bytes);
  }

  @Get('magazine/issues/:number')
  issue(@Params(IssueNumberParams) params: P<typeof IssueNumberParams>, @Query(IssueQuerySchema) query: P<typeof IssueQuerySchema>) {
    return this.content.issue(params.number, query.edition);
  }

  @Get('magazine/digests/:id')
  digest(@Params(IdParams) params: Id) {
    return this.content.digest(params.id);
  }

  @Get('walls/:kind/:id')
  wall(@Params(WallParams) params: P<typeof WallParams>) {
    return this.content.wall(params.kind, params.id);
  }
}

function elevated(state: RequestState, elevation: SessionElevationRow, request: TrustworkRequest): Elevated {
  const header = request.headers['idempotency-key'];
  return { state, elevationId: elevation.id, idempotencyKey: Array.isArray(header) ? header[0] : header };
}

/**
 * The editorial board and the magazine desk (`/v1/admin/content`): staff routes behind an elevated session
 * (`ElevationGuard`); every mutation is a console command (contract version, idempotency key equal to the header,
 * reason) authorized again by the database at the hub and recorded in the staff audit.
 */
@Controller('v1/admin/content')
@Authenticated()
@UseGuards(ElevationGuard)
export class ContentStaffController {
  constructor(@Inject(ContentService) private readonly content: ContentService) {}

  @Get('publications')
  board(@Query(BoardQuerySchema) query: P<typeof BoardQuerySchema>, @ReqState() state: RequestState) {
    return this.content.board(state, query.status);
  }

  @Get('issues')
  issues(@ReqState() state: RequestState) {
    return this.content.issues(state);
  }

  @Get('issues/:id')
  issue(@Params(IdParams) params: Id, @ReqState() state: RequestState) {
    return this.content.issueById(state, params.id);
  }

  @Post('issues') @HttpCode(201) @Idempotent('content.issue_create')
  createIssue(@Body(CreateIssueCommandSchema) body: P<typeof CreateIssueCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.content.createIssue(elevated(state, e, r), body);
  }

  @Post('issues/:id/curate') @HttpCode(200) @Idempotent('content.issue_curate', 'id')
  curate(@Params(IdParams) params: Id, @Body(CurateIssueCommandSchema) body: P<typeof CurateIssueCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.content.curateIssue(elevated(state, e, r), params.id, body);
  }

  @Post('issues/:id/status') @HttpCode(200) @Idempotent('content.issue_status', 'id')
  status(@Params(IdParams) params: Id, @Body(IssueStatusCommandSchema) body: P<typeof IssueStatusCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.content.issueStatus(elevated(state, e, r), params.id, body);
  }

  @Post('issues/:id/release') @HttpCode(200) @Idempotent('content.issue_release', 'id')
  release(@Params(IdParams) params: Id, @Body(IssueRevisionCommandSchema) body: P<typeof IssueRevisionCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.content.releaseIssue(elevated(state, e, r), params.id, body);
  }

  @Post('issues/:id/corrections') @HttpCode(201) @Idempotent('content.issue_correct', 'id')
  correct(@Params(IdParams) params: Id, @Body(CorrectIssueCommandSchema) body: P<typeof CorrectIssueCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.content.correctIssue(elevated(state, e, r), params.id, body);
  }

  @Post('issues/:id/renders') @HttpCode(201) @Idempotent('content.render_request', 'id')
  render(@Params(IdParams) params: Id, @Body(RequestRenderCommandSchema) body: P<typeof RequestRenderCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.content.requestRender(elevated(state, e, r), params.id, body);
  }

  @Post('renders/:id/result') @HttpCode(200) @Idempotent('content.render_record', 'id')
  renderResult(@Params(IdParams) params: Id, @Body(RecordRenderCommandSchema) body: P<typeof RecordRenderCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.content.recordRender(elevated(state, e, r), params.id, body);
  }

  @Get('digests/:id')
  digest(@Params(IdParams) params: Id, @ReqState() state: RequestState) {
    return this.content.digestById(state, params.id);
  }

  @Post('digests') @HttpCode(201) @Idempotent('content.digest_create')
  createDigest(@Body(CreateDigestCommandSchema) body: P<typeof CreateDigestCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.content.createDigest(elevated(state, e, r), body);
  }

  @Post('digests/:id/release') @HttpCode(200) @Idempotent('content.digest_release', 'id')
  releaseDigest(@Params(IdParams) params: Id, @Body(DigestReleaseCommandSchema) body: P<typeof DigestReleaseCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.content.releaseDigest(elevated(state, e, r), params.id, body);
  }
}
