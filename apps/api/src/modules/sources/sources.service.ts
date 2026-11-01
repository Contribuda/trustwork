import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { z } from 'zod';
import { computeDigest, HUB_CONSOLE_CONTRACT_VERSION, type ConsoleCommandResult, type ConsolePermission, type Principal } from '../../deps/contracts.js';
import { withPrincipal, type Transaction } from '../../deps/data.js';
import { withoutPrincipal } from '../../common/db.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { PrincipalService } from '../identity/principal.service.js';
import {
  adminAudit, approvals, contentSourceRef, evaluateRobots, importBatches, parseRsl, PublicProvenanceSchema, publicSources, publications, recordLinks, sourceItems, sources,
  sponsoredPolicy, sponsoredPolicyDigestInput, SponsoredSlotSchema, takedowns,
  type AllowedUses, type AssistItemCommandSchema, type CheckRobotsCommandSchema, type CheckRslCommandSchema, type CommandContext, type DecideBatchCommandSchema,
  type DecideItemCommand, type DecideLinkCommandSchema, type ProposeLinkCommandSchema, type RecordTermsCheckCommandSchema, type RegisterSourceCommand, type SetSourceTermsCommand,
  type SetSponsoredPolicyCommand, type SourceRow, type SourceStatusCommandSchema, type StageBatchCommand, type StaffRole, type TakedownCommandSchema,
} from './deps.js';
import { isAuthorityRefusal, sourcesRefusal } from './errors.js';
import { bounded, type SourcePolicyFetcher, type SummaryDrafter } from './ports.js';
import { toBatch, toCrawlPolicy, toItem, toLink, toSource, toSponsoredPolicy, toTakedown } from './views.js';

type Body<S extends z.ZodType> = z.infer<S>;
type Cmd = { idempotencyKey: string; reason: string };
export interface Elevated { state: RequestState; elevationId: string; idempotencyKey: string | undefined }
interface Attempt { hubId: string; permission: ConsolePermission; action: string; objectType: string; objectId: string }
export interface SourcesServiceOptions { policyFetcher: SourcePolicyFetcher; summaryDrafter: SummaryDrafter }

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const NO_OBJECT = '00000000-0000-4000-8000-000000000000';

/**
 * Hub source registry use cases (SRC-001). Every staff command runs in one `PrincipalService.runAs` transaction as the
 * staff member through a `sources_*` SECURITY DEFINER command that checks the permission at the hub, the elevation,
 * separation of duties and the licence rules, and writes the audit row in that transaction (BE-005 completes the
 * idempotency record there too). Refusals of authority leave a `denied` audit row in a transaction of their own.
 *
 * Outside calls go through the adapter ports only (robots.txt and RSL fetches, the summary drafter), bounded in time;
 * this slice wires fakes. The summary drafter is called only after `sources_item_egress` confirmed that the item's
 * licence allows sending it to a model provider, so a display-only source never reaches one.
 */
export class SourcesService {
  constructor(private readonly ctx: AppContext, private readonly principals: PrincipalService, private readonly options: SourcesServiceOptions) {}

  /* ---------- Plumbing ---------- */

  private commandContext(e: Elevated, body: Cmd): CommandContext {
    if (e.idempotencyKey !== undefined && body.idempotencyKey !== e.idempotencyKey) throw new ApiError('validation.schema', 'idempotencyKey must equal the Idempotency-Key header', { reason: 'idempotency_key_mismatch' });
    return { elevationId: e.elevationId, requestId: e.state.requestId, reasonCode: 'console_action', reasonText: body.reason };
  }

  private async staff<T>(e: Elevated, body: Cmd, attempt: Attempt, fn: (trx: Transaction, cmd: CommandContext, p: Principal) => Promise<T>): Promise<T> {
    const cmd = this.commandContext(e, body);
    try {
      return await this.principals.runAs(e.state, (trx, p) => fn(trx, cmd, p));
    } catch (error) {
      const refusal = sourcesRefusal(error);
      if (refusal && isAuthorityRefusal(refusal)) await this.recordDenied(e, cmd, attempt, refusal).catch((failure: unknown) => this.ctx.log('sources.denied_audit_failed', failure));
      throw refusal ?? error;
    }
  }

  private read<T>(state: RequestState, fn: (trx: Transaction, p: Principal) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, fn).catch((error: unknown) => {
      throw sourcesRefusal(error) ?? error;
    });
  }

  private publicRead<T>(fn: (trx: Transaction) => Promise<T>): Promise<T> {
    return withoutPrincipal(this.ctx.pool, fn).catch((error: unknown) => {
      throw sourcesRefusal(error) ?? error;
    });
  }

  /** A denied audit row, when the person holds a staff role covering the hub (their own assignments are readable). */
  private async recordDenied(e: Elevated, cmd: CommandContext, attempt: Attempt, refusal: ApiError): Promise<void> {
    const p = e.state.principal as Principal;
    await withPrincipal(this.ctx.pool, { personId: p.personId, authzEpoch: p.authzEpoch }, async (trx) => {
      const role = await trx.selectFrom('staff_role_assignment').select('role').where('person_id', '=', p.personId).where('revoked_at', 'is', null)
        .where((eb) => eb.or([eb('scope_kind', 'in', ['platform', 'node']), eb('hub_id', '=', attempt.hubId)]))
        .where((eb) => eb.or([eb('valid_until', 'is', null), eb('valid_until', '>', new Date())])).orderBy('breakglass').limit(1).executeTakeFirst();
      if (!role) return;
      const reason = typeof refusal.details?.reason === 'string' ? refusal.details.reason : refusal.code.replace(/\W/g, '_');
      await adminAudit.append(trx, {
        actorPersonId: p.personId, actorRole: role.role as StaffRole, scope: { kind: 'hub', hubId: attempt.hubId }, permission: attempt.permission, elevationId: cmd.elevationId,
        action: attempt.action, objectType: attempt.objectType, objectId: attempt.objectId, reasonCode: `denied_${reason}`.slice(0, 64).replace(/[^a-z0-9_]/g, '_'), reasonText: cmd.reasonText,
        outcome: 'denied', requestId: cmd.requestId,
      });
    });
  }

  /** The console result envelope with the audit row this request wrote for the object. */
  private async result(trx: Transaction, cmd: CommandContext, outcome: 'applied' | 'pending_second_person', objectId: string, revision: number, approvalRequestId: string | null): Promise<ConsoleCommandResult> {
    const row = await trx.selectFrom('admin_audit_event').select('id').where('request_id', '=', cmd.requestId).where('object_id', '=', objectId).orderBy('sequence', 'desc').limit(1).executeTakeFirst();
    if (!row) throw new Error('the command wrote no audit row');
    return { contractVersion: HUB_CONSOLE_CONTRACT_VERSION, outcome, objectId, revision, approvalRequestId, auditEventId: row.id };
  }

  private async sourceOf(trx: Transaction, hubId: string, sourceId: string): Promise<SourceRow> {
    const row = await sources.get(trx, sourceId);
    if (!row || row.hub_id !== hubId) throw new ApiError('access.not_found', 'access.not_found');
    return row;
  }

  private async sourceView(trx: Transaction, row: SourceRow) {
    return toSource(row, (await sources.currentPolicies(trx, [row.id])).get(row.id));
  }

  private async itemView(trx: Transaction, hubId: string, itemId: string) {
    const row = await sourceItems.get(trx, itemId);
    if (!row || row.hub_id !== hubId) throw new ApiError('access.not_found', 'access.not_found');
    return toItem(row, await sourceItems.effectiveUses(trx, itemId) as AllowedUses);
  }

  /* ---------- Reads (staff of the hub) ---------- */

  listSources(state: RequestState, hubId: string, status?: string) {
    return this.read(state, async (trx) => {
      const rows = await sources.list(trx, hubId, status);
      const policies = await sources.currentPolicies(trx, rows.map((r) => r.id));
      return { items: rows.map((r) => toSource(r, policies.get(r.id))) };
    });
  }

  getSource(state: RequestState, hubId: string, sourceId: string) {
    return this.read(state, async (trx) => {
      const row = await this.sourceOf(trx, hubId, sourceId);
      const history = await sources.policyHistory(trx, sourceId);
      return { source: toSource(row, history[0]), crawlPolicies: history.map(toCrawlPolicy) };
    });
  }

  listBatches(state: RequestState, hubId: string, status?: string) {
    return this.read(state, async (trx) => ({ items: (await importBatches.list(trx, hubId, status)).map(toBatch) }));
  }

  getBatch(state: RequestState, hubId: string, batchId: string) {
    return this.read(state, async (trx) => {
      const batch = await importBatches.get(trx, batchId);
      if (!batch || batch.hub_id !== hubId) throw new ApiError('access.not_found', 'access.not_found');
      const items = await sourceItems.list(trx, hubId, { batchId });
      return { batch: toBatch(batch), items: await Promise.all(items.map(async (i) => toItem(i, await sourceItems.effectiveUses(trx, i.id) as AllowedUses))) };
    });
  }

  /** The human review queue: items of activated batches waiting for a person, oldest first. */
  queue(state: RequestState, hubId: string) {
    return this.read(state, async (trx) => {
      const rows = await sourceItems.queue(trx, hubId);
      return { items: await Promise.all(rows.map(async (i) => toItem(i, await sourceItems.effectiveUses(trx, i.id) as AllowedUses))) };
    });
  }

  getItem(state: RequestState, hubId: string, itemId: string) {
    return this.read(state, async (trx) => ({ item: await this.itemView(trx, hubId, itemId) }));
  }

  listLinks(state: RequestState, hubId: string, linkState?: string) {
    return this.read(state, async (trx) => ({ items: (await recordLinks.list(trx, hubId, linkState)).map(toLink) }));
  }

  getTakedown(state: RequestState, hubId: string, takedownId: string) {
    return this.read(state, async (trx) => {
      const row = await takedowns.get(trx, takedownId);
      if (!row || row.hub_id !== hubId) throw new ApiError('access.not_found', 'access.not_found');
      return { takedown: toTakedown(row, await takedowns.tombstones(trx, takedownId)) };
    });
  }

  getSponsoredPolicy(state: RequestState, hubId: string) {
    return this.read(state, async (trx) => {
      const { rows } = await sql<{ ok: boolean }>`SELECT trustwork.sources_staff_reader(${hubId}::uuid) AS ok`.execute(trx);
      if (!rows[0]?.ok) throw new ApiError('access.not_found', 'access.not_found');
      return { policy: toSponsoredPolicy(hubId, await sponsoredPolicy.current(trx, hubId)) };
    });
  }

  /* ---------- Sources ---------- */

  register(e: Elevated, hubId: string, body: RegisterSourceCommand) {
    return this.staff(e, body, { hubId, permission: 'admin.sources.manage', action: 'source.registered', objectType: 'source', objectId: NO_OBJECT }, async (trx, cmd) => {
      const row = await sources.register(trx, cmd, hubId, {
        kind: body.kind, name: body.name, url: body.url, ownerPersonId: body.ownerPersonId, readerKind: body.readerKind, purposes: body.purposes, licence: body.licence,
        allowedUses: body.allowedUses, attributionTemplate: body.attributionTemplate, takedownContact: body.takedownContact, personalData: body.personalData, legalBasis: body.legalBasis,
      });
      return { result: await this.result(trx, cmd, 'applied', row.id, row.revision, null), source: await this.sourceView(trx, row) };
    });
  }

  setTerms(e: Elevated, hubId: string, sourceId: string, body: SetSourceTermsCommand) {
    return this.staff(e, body, { hubId, permission: 'admin.sources.manage', action: 'source.terms_set', objectType: 'source', objectId: sourceId }, async (trx, cmd) => {
      await this.sourceOf(trx, hubId, sourceId);
      const row = await sources.setTerms(trx, cmd, sourceId, body.expectedRevision, {
        readerKind: body.readerKind, purposes: body.purposes, licence: body.licence, allowedUses: body.allowedUses, attributionTemplate: body.attributionTemplate,
        takedownContact: body.takedownContact, personalData: body.personalData, legalBasis: body.legalBasis,
      });
      return { result: await this.result(trx, cmd, 'applied', row.id, row.revision, null), source: await this.sourceView(trx, row) };
    });
  }

  recordTerms(e: Elevated, hubId: string, sourceId: string, body: Body<typeof RecordTermsCheckCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.sources.manage', action: 'source.terms_recorded', objectType: 'source', objectId: sourceId }, async (trx, cmd) => {
      await this.sourceOf(trx, hubId, sourceId);
      const row = await sources.recordTerms(trx, cmd, sourceId, body.expectedRevision, { termsUrl: body.termsUrl, termsDigest: body.termsDigest, automatedAccess: body.automatedAccess, notes: body.notes });
      return { result: await this.result(trx, cmd, 'applied', row.id, row.revision, null), source: await this.sourceView(trx, row) };
    });
  }

  /** Fetches robots.txt through the adapter port, evaluates it for the source URL and records the check. */
  checkRobots(e: Elevated, hubId: string, sourceId: string, body: Body<typeof CheckRobotsCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.sources.manage', action: 'source.robots_recorded', objectType: 'source', objectId: sourceId }, async (trx, cmd) => {
      const source = await this.sourceOf(trx, hubId, sourceId);
      if (!source.url) throw new ApiError('validation.schema', 'a robots.txt check needs a source URL', { reason: 'url_required' });
      const url = new URL(source.url);
      const robotsUrl = `${url.origin}/robots.txt`;
      const fetched = await bounded(this.options.policyFetcher.robots(robotsUrl), { status: 'unavailable' as const });
      if (fetched.status === 'unavailable') throw new ApiError('validation.revision_conflict', 'the site did not answer; nothing was recorded', { reason: 'source_unreachable' });
      const text = fetched.status === 'found' ? fetched.body : '';
      const evaluation = evaluateRobots(text, body.userAgent, `${url.pathname}${url.search}`);
      const policy = await sources.recordRobots(trx, cmd, sourceId, {
        domain: url.host.toLowerCase(), robotsUrl, userAgent: body.userAgent, robotsDigest: sha256(text), allowed: evaluation.allowed, status: evaluation.status,
        crawlDelaySeconds: evaluation.crawlDelaySeconds, allowedPaths: evaluation.allowedPaths.slice(0, 200), disallowedPaths: evaluation.disallowedPaths.slice(0, 200),
        licenceUrls: evaluation.licenceUrls.slice(0, 20),
      });
      const after = await this.sourceOf(trx, hubId, sourceId);
      return { result: await this.result(trx, cmd, 'applied', policy.id, after.revision, null), crawlPolicy: toCrawlPolicy(policy), source: await this.sourceView(trx, after) };
    });
  }

  /** Fetches the source's RSL document through the adapter port and records the reading as a suggestion (never a widening). */
  checkRsl(e: Elevated, hubId: string, sourceId: string, body: Body<typeof CheckRslCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.sources.manage', action: 'source.rsl_recorded', objectType: 'source', objectId: sourceId }, async (trx, cmd) => {
      const source = await this.sourceOf(trx, hubId, sourceId);
      const fetched = await bounded(this.options.policyFetcher.rsl(body.rslUrl), { status: 'unavailable' as const });
      if (fetched.status === 'unavailable') throw new ApiError('validation.revision_conflict', 'the site did not answer; nothing was recorded', { reason: 'source_unreachable' });
      const reading = fetched.status === 'found' ? parseRsl(fetched.body, source.url ?? body.rslUrl) : null;
      const row = await sources.recordRsl(trx, cmd, sourceId, source.revision, reading
        ? { status: reading.status, digest: sha256(fetched.status === 'found' ? fetched.body : ''), ceiling: reading.ceiling, suggested: reading.suggested }
        : { status: 'absent', digest: null, ceiling: null, suggested: null });
      return { result: await this.result(trx, cmd, 'applied', row.id, row.revision, null), source: await this.sourceView(trx, row), reading };
    });
  }

  setStatus(e: Elevated, hubId: string, sourceId: string, body: Body<typeof SourceStatusCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.sources.manage', action: `source.${body.to === 'active' ? 'activated' : body.to}`, objectType: 'source', objectId: sourceId }, async (trx, cmd) => {
      await this.sourceOf(trx, hubId, sourceId);
      const row = await sources.setStatus(trx, cmd, sourceId, body.expectedRevision, body.to);
      return { result: await this.result(trx, cmd, 'applied', row.id, row.revision, null), source: await this.sourceView(trx, row) };
    });
  }

  takedownSource(e: Elevated, hubId: string, sourceId: string, body: Body<typeof TakedownCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.sources.takedown', action: 'source.taken_down', objectType: 'source', objectId: sourceId }, async (trx, cmd) => {
      await this.sourceOf(trx, hubId, sourceId);
      const row = await sources.takedown(trx, cmd, { sourceId, itemId: null }, body.reasonCategory, body.note);
      return { result: await this.result(trx, cmd, 'applied', sourceId, 1, null), takedown: toTakedown(row, await takedowns.tombstones(trx, row.id)) };
    });
  }

  /* ---------- Import batches and the review queue ---------- */

  stageBatch(e: Elevated, hubId: string, sourceId: string, body: StageBatchCommand) {
    return this.staff(e, body, { hubId, permission: 'admin.sources.manage', action: 'import_batch.staged', objectType: 'import_batch', objectId: sourceId }, async (trx, cmd) => {
      await this.sourceOf(trx, hubId, sourceId);
      const row = await importBatches.stage(trx, cmd, sourceId, { items: body.items, fields: body.fields, links: body.links });
      return { result: await this.result(trx, cmd, 'applied', row.id, row.revision, null), batch: toBatch(row) };
    });
  }

  decideBatch(e: Elevated, hubId: string, batchId: string, body: Body<typeof DecideBatchCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.sources.import.activate', action: `import_batch.${body.decision === 'activate' ? 'activated' : 'rejected'}`, objectType: 'import_batch', objectId: batchId }, async (trx, cmd) => {
      const batch = await importBatches.get(trx, batchId);
      if (!batch || batch.hub_id !== hubId) throw new ApiError('access.not_found', 'access.not_found');
      const row = await importBatches.decide(trx, cmd, batchId, body.expectedRevision, body.decision);
      return { result: await this.result(trx, cmd, 'applied', row.id, row.revision, null), batch: toBatch(row) };
    });
  }

  /**
   * A person's decision on an imported item. `draft` creates a CNT-001 editorial news draft from the item in the same
   * transaction (still reviewed by a second editor before it is published) and records the decision with that draft;
   * the cited source carries the item's effective licence flags, so CNT-001's licence checks see what the registry knows.
   */
  decideItem(e: Elevated, hubId: string, itemId: string, body: DecideItemCommand) {
    return this.staff(e, body, { hubId, permission: 'admin.publications.review', action: `source_item.${body.decision === 'draft' ? 'drafted' : 'discarded'}`, objectType: 'source_item', objectId: itemId }, async (trx, cmd) => {
      const item = await sourceItems.get(trx, itemId);
      if (!item || item.hub_id !== hubId) throw new ApiError('access.not_found', 'access.not_found');
      let publicationId: string | null = null;
      if (body.decision === 'draft') {
        const source = await this.sourceOf(trx, hubId, item.source_id);
        const uses = await sourceItems.effectiveUses(trx, itemId) as AllowedUses;
        const text = body.useAssistedSummary ? item.assisted_summary : item.summary;
        if (body.treatment === 'summary' && !text) throw new ApiError('validation.schema', 'a summary treatment needs a stored or assisted summary', { reason: 'summary_missing' });
        const ref = contentSourceRef({ name: source.name, readerKind: source.reader_kind as never, licence: { kind: source.licence_kind as never, name: source.licence_name } },
          { url: item.url, sourceTime: item.source_time ? item.source_time.toISOString() : null, observedAt: item.observed_at.toISOString(), effectiveUses: uses });
        const publication = await publications.create(trx, cmd, {
          hubId, owner: { kind: 'editorial' }, format: 'news', articleFormat: null, language: body.language as string, licence: 'all_rights', requiresReview: true,
          draft: {
            title: item.title, body: body.treatment === 'summary' ? (text as string) : '', language: body.language as string, sourceRefs: [ref], treatment: body.treatment as 'summary' | 'headline_link',
            eventTime: body.eventTime ?? (item.source_time ? item.source_time.toISOString() : null), assistantAssisted: body.useAssistedSummary,
          },
          authorship: [{ kind: 'editorial', credit: body.credit as string, assistantAssisted: body.useAssistedSummary }],
        });
        publicationId = publication.id;
      }
      const row = await sourceItems.decide(trx, cmd, itemId, body.expectedRevision, body.decision, publicationId);
      return { result: await this.result(trx, cmd, 'applied', row.id, row.revision, null), item: toItem(row, await sourceItems.effectiveUses(trx, itemId) as AllowedUses), publicationId };
    });
  }

  /** A machine-assisted summary suggestion: the licence check runs before the drafter is called; a refused item never reaches it. */
  assistItem(e: Elevated, hubId: string, itemId: string, body: Body<typeof AssistItemCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.publications.review', action: 'source_item.assisted', objectType: 'source_item', objectId: itemId }, async (trx, cmd) => {
      const item = await sourceItems.get(trx, itemId);
      if (!item || item.hub_id !== hubId) throw new ApiError('access.not_found', 'access.not_found');
      const payload = await sourceItems.egress(trx, itemId, 'model_provider');
      const drafted = await this.options.summaryDrafter.draft({ title: payload.title, text: payload.fullText ?? payload.summary ?? payload.title, language: body.language, attribution: payload.attribution });
      const row = await sourceItems.recordAssist(trx, cmd, itemId, body.expectedRevision, drafted.summary.slice(0, 2000), body.language);
      return { result: await this.result(trx, cmd, 'applied', row.id, row.revision, null), item: toItem(row, await sourceItems.effectiveUses(trx, itemId) as AllowedUses) };
    });
  }

  takedownItem(e: Elevated, hubId: string, itemId: string, body: Body<typeof TakedownCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.sources.takedown', action: 'source_item.taken_down', objectType: 'source_item', objectId: itemId }, async (trx, cmd) => {
      const item = await sourceItems.get(trx, itemId);
      if (!item || item.hub_id !== hubId) throw new ApiError('access.not_found', 'access.not_found');
      const row = await sources.takedown(trx, cmd, { sourceId: null, itemId }, body.reasonCategory, body.note);
      return { result: await this.result(trx, cmd, 'applied', itemId, 1, null), takedown: toTakedown(row, await takedowns.tombstones(trx, row.id)) };
    });
  }

  /* ---------- Record links ---------- */

  proposeLink(e: Elevated, hubId: string, body: Body<typeof ProposeLinkCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.links.decide', action: 'record_link.proposed', objectType: 'record_link_proposal', objectId: NO_OBJECT }, async (trx, cmd) => {
      const row = await recordLinks.propose(trx, cmd, hubId, { left: body.left, rightLocalId: body.rightLocalId, rightGlobalId: body.rightGlobalId, evidence: body.evidence });
      return { result: await this.result(trx, cmd, 'applied', row.id, row.revision, null), link: toLink(row) };
    });
  }

  decideLink(e: Elevated, hubId: string, linkId: string, body: Body<typeof DecideLinkCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.links.decide', action: `record_link.${body.decision === 'accept' ? 'accepted' : 'rejected'}`, objectType: 'record_link_proposal', objectId: linkId }, async (trx, cmd) => {
      const link = await recordLinks.get(trx, linkId);
      if (!link || link.hub_id !== hubId) throw new ApiError('access.not_found', 'access.not_found');
      const row = await recordLinks.decide(trx, cmd, linkId, body.expectedRevision, body.decision);
      return { result: await this.result(trx, cmd, 'applied', row.id, row.revision, null), link: toLink(row) };
    });
  }

  /* ---------- Sponsored content policy ---------- */

  /**
   * A new version of the hub's sponsored content policy. Switching it on without an approval asks a second person for
   * exactly this version (`sponsored.enable`) and answers `pending_second_person`; the same person calls again with the
   * approved request. Switching it off applies at once.
   */
  setSponsoredPolicy(e: Elevated, hubId: string, body: SetSponsoredPolicyCommand) {
    return this.staff(e, body, { hubId, permission: 'admin.sponsored.policy.edit', action: 'sponsored_policy.set', objectType: 'sponsored_content_policy', objectId: hubId }, async (trx, cmd) => {
      const current = await sponsoredPolicy.current(trx, hubId);
      const version = (current?.version ?? 0) + 1;
      if (body.allowed && body.approvalId === null) {
        const digest = computeDigest(sponsoredPolicyDigestInput({ hubId, version, allowed: true, maxSlotsPerPage: body.maxSlotsPerPage, requireVerifiedSponsor: body.requireVerifiedSponsor })).value;
        const request = await approvals.request(trx, cmd, { action: 'sponsored.enable', scope: { kind: 'hub', hubId }, actionDigest: digest });
        return { result: await this.result(trx, cmd, 'pending_second_person', request.id, version, request.id), policy: toSponsoredPolicy(hubId, current), approvalDigest: digest };
      }
      const row = await sponsoredPolicy.set(trx, cmd, hubId, body);
      return { result: await this.result(trx, cmd, 'applied', row.id, row.version, null), policy: toSponsoredPolicy(hubId, row), approvalDigest: null };
    });
  }

  /* ---------- Public projections ---------- */

  provenance(hubId: string, recordKind: string, recordId: string) {
    return this.publicRead(async (trx) => {
      const json = await publicSources.provenance(trx, hubId, recordKind, recordId) as { fields: unknown[] } | null;
      if (!json || json.fields.length === 0) throw new ApiError('access.not_found', 'access.not_found');
      return PublicProvenanceSchema.parse({ projection: 'public', ...json });
    });
  }

  sponsoredSlot(hubId: string) {
    return this.publicRead(async (trx) => SponsoredSlotSchema.parse({ projection: 'public', ...(await publicSources.sponsoredSlot(trx, hubId) as object) }));
  }
}
