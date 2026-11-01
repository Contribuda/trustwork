import type { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { ApiError } from '../../../common/errors.js';
import type { RequestState } from '../../../common/request.js';
import type { Principal } from '../../../deps/contracts.js';
import { withPrincipal, PrincipalError, type Transaction } from '../../../deps/data.js';
import type { AppContext } from '../../identity/context.js';
import type { IdentityServices } from '../../identity/identity.module.js';
import type { CommandContext } from '../../../../../../packages/data/src/repositories/admin.js';
import { privacy } from '../../../../../../packages/data/src/repositories/privacy.js';
import type { BlobStore } from '../../../../../../packages/data/src/files/blob-store.js';
import type { PrivacyHoldCommandSchema, PrivacyPreferenceCommand, PrivacyRequestCommand, PrivacySubject, PrivacySourceProofSchema, PrivacySourceSubmissionSchema, PrivacyExternalSourceCaseSchema } from '../../../../../../packages/contracts/src/privacy.js';
import type { PrivacyExportPort } from './ports.js';
import { mailAddressHash } from '../../../../../../packages/data/src/repositories/mail.js';

function refusal(error: unknown): never {
  const hint = (error as { hint?: string }).hint;
  if (hint?.startsWith('privacy.') || hint?.startsWith('admin.')) {
    throw new ApiError(hint.endsWith('not_found') ? 'access.not_found' : 'access.forbidden', 'privacy operation refused', { reason: hint });
  }
  throw error;
}

export class PrivacyService {
  constructor(private readonly ctx: AppContext, private readonly identity: IdentityServices, private readonly store: BlobStore | null, private readonly exports: PrivacyExportPort) {}
  async objectToMarketing(address: string): Promise<{ accepted: true }> {
    await this.ctx.pool.query('SELECT trustwork.privacy_marketing_object($1::text)', [mailAddressHash(address)]);
    return { accepted: true };
  }
  externalSourceCase(state: RequestState, elevationId: string, input: z.infer<typeof PrivacyExternalSourceCaseSchema>) {
    return this.run(state, (trx) => privacy.externalSourceCase(trx, this.staffContext(state, elevationId, 'external_source_verification'), input));
  }
  sourceProof(state: RequestState, elevationId: string, input: z.infer<typeof PrivacySourceProofSchema>) {
    return this.run(state, async (trx) => {
      // The verifying client retains the random capability; neither audit nor idempotency stores its plaintext.
      const id = await privacy.sourceProof(trx, this.staffContext(state, elevationId, 'source_identity_verification'), input);
      return { id };
    });
  }
  proposeSourcePlan(state: RequestState, elevationId: string, requestId: string, grantId: string) {
    return this.run(state, (trx) => privacy.proposeSourcePlan(trx, this.staffContext(state, elevationId, 'privacy_source_plan'), requestId, grantId));
  }
  approveSourcePlan(state: RequestState, elevationId: string, id: string, grantId: string, digest: string) {
    return this.run(state, (trx) => privacy.approveSourcePlan(trx, this.staffContext(state, elevationId, 'privacy_source_review'), id, grantId, digest));
  }
  executeSourcePlan(state: RequestState, elevationId: string, id: string, digest: string) {
    return this.run(state, (trx) => privacy.executeSourcePlan(trx, this.staffContext(state, elevationId, 'privacy_source_execute'), id, digest));
  }
  proposePlan(state: RequestState, elevationId: string, requestId: string, grantId: string) {
    return this.run(state, (trx) => privacy.proposePlan(trx, this.staffContext(state, elevationId, 'privacy_plan_propose'), requestId, grantId));
  }
  approvePlan(state: RequestState, elevationId: string, id: string, grantId: string, digest: string) {
    return this.run(state, (trx) => privacy.approvePlan(trx, this.staffContext(state, elevationId, 'privacy_plan_approve'), id, grantId, digest));
  }
  executePlan(state: RequestState, elevationId: string, id: string, digest: string) {
    return this.run(state, (trx) => privacy.executePlan(trx, this.staffContext(state, elevationId, 'privacy_plan_execute'), id, digest));
  }
  async sourceSubmission(input: z.infer<typeof PrivacySourceSubmissionSchema>): Promise<{ accepted: true }> {
    await this.ctx.pool.query('SELECT trustwork.privacy_source_submit($1, $2, $3)', [createHash('sha256').update(input.proof).digest('hex'), input.action, input.proposedValue]);
    return { accepted: true };
  }
  private run<T>(state: RequestState, fn: (trx: Transaction, principal: Principal) => Promise<T>, options?: { snapshot: true }): Promise<T> {
    if (state.principal?.delegation) throw new ApiError('access.forbidden', 'privacy governance requires the person');
    return this.identity.principals.runAs(state, fn, options).catch(refusal);
  }
  request(state: RequestState, input: PrivacyRequestCommand) { return this.run(state, (trx) => privacy.request(trx, input)); }
  requests(state: RequestState) { return this.run(state, async (trx) => ({ requests: await privacy.requests(trx) })); }
  preference(state: RequestState, input: PrivacyPreferenceCommand) { return this.run(state, (trx) => privacy.preference(trx, input)); }
  preferences(state: RequestState) { return this.run(state, async (trx) => ({ preference: await privacy.preferences(trx) ?? null })); }
  createExport(state: RequestState, subject: PrivacySubject) {
    return this.run(state, async (trx) => ({ export: await privacy.createExport(trx, subject.kind, subject.id, this.exports.coverage), complete: false }));
  }
  /** Recompose at delivery: a stored id is not a bearer capability and there is no reusable provider URL. */
  download(state: RequestState, id: string, consume: (result: { sha256: string; archive: unknown }) => Promise<void>) {
    return this.delivery(state, async (trx, p) => {
      if (!this.store || this.store.kind !== 'filesystem') throw new ApiError('validation.schema', 'local export storage unavailable', { reason: 'storage_unavailable' });
      const row = await this.authorizeDownload(trx, p, state, id);
      const subject = { kind: row.subject_kind, id: row.subject_id };
      const data = await this.exports.compose(trx, p, state, subject);
      data.privacy = {
        requests: (await privacy.requests(trx)).filter((r) => r.subject_kind === subject.kind && r.subject_id === subject.id),
        ...(subject.kind === 'person' ? { preference: await privacy.preferences(trx) ?? null } : {}),
      };
      const archive = { format: 'privacy-json-1', complete: false, subject, coverage: this.exports.coverage, data };
      const body = Buffer.from(JSON.stringify(archive));
      const digest = createHash('sha256').update(body).digest('hex');
      const key = `privacy-exports/${row.id}/${digest}.json`;
      try {
        await this.store.put(key, body, 'application/json');
        const stored = await this.store.read(key, body.length);
        if (!stored || createHash('sha256').update(stored).digest('hex') !== digest) throw new ApiError('validation.schema', 'export storage verification failed');
        await this.checkDeliverySession(trx, p, state);
        await consume({ sha256: digest, archive });
      } finally {
        // The authenticated response is the delivery. No personal export bytes remain as an ungoverned cache.
        await this.store.delete(key);
      }
    });
  }
  private async authorizeDownload(trx: Transaction, p: Principal, state: RequestState, id: string) {
    const row = await privacy.export(trx, id);
    if (!row) throw new ApiError('access.not_found');
    // NOWAIT avoids a reverse-order cycle with membership -> person and person -> session writers.
    // A concurrent writer denies this attempt; there is no refresh, session rebinding or delivery retry.
    const person = await trx.selectFrom('person').select(['id', 'authz_epoch']).where('id', '=', p.personId).forShare().noWait().executeTakeFirst();
    if (!person || person.authz_epoch !== p.authzEpoch) throw new ApiError('validation.revision_conflict', 'authority changed');
    if (row.subject_kind === 'company') {
      await trx.selectFrom('membership').select('id').where('person_id', '=', p.personId).where('company_id', '=', row.subject_id).forShare().noWait().execute();
      const company = await trx.selectFrom('company').select('authz_epoch').where('id', '=', row.subject_id).forShare().noWait().executeTakeFirst();
      if (!company || company.authz_epoch !== p.membership?.companyAuthzEpoch) throw new ApiError('validation.revision_conflict', 'company authority changed');
    }
    await this.checkDeliverySession(trx, p, state);
    if (!await privacy.authorized(trx, row.subject_kind, row.subject_id)) throw new ApiError('access.not_found');
    return row;
  }
  downloadFile(state: RequestState, id: string, fileId: string, consume: (file: { stream: Readable; bytes: number; sha256: string }) => Promise<void>) {
    return this.delivery(state, async (trx, p) => {
      const row = await this.authorizeDownload(trx, p, state, id);
      await this.exports.file(trx, p, state, { kind: row.subject_kind, id: row.subject_id }, fileId, async (file) => {
        // Verification and owning file locks can take time. Expiry uses the current clock at delivery.
        await this.checkDeliverySession(trx, p, state);
        await consume(file);
      });
    });
  }
  /** A snapshot row lock detects changes committed since snapshot creation (40001), not stale authorization. */
  private async checkDeliverySession(trx: Transaction, p: Principal, state: RequestState) {
    const session = await trx.selectFrom('session').selectAll().where('id', '=', state.session!.id).forShare().noWait().executeTakeFirst();
    const now = this.ctx.clock.now().getTime();
    if (!session || session.person_id !== p.personId || session.person_id !== state.session!.personId
      || session.token_hash.toString('hex') !== state.sessionTokenHash || session.revoked_at
      || session.idle_expires_at.getTime() <= now || session.absolute_expires_at.getTime() <= now) {
      throw new ApiError('auth.session_invalid', 'originating session no longer valid');
    }
  }
  private async delivery<T>(state: RequestState, fn: (trx: Transaction, p: Principal) => Promise<T>): Promise<T> {
    const p = state.principal;
    if (!p || !state.session || !state.sessionTokenHash) throw new ApiError('auth.session_invalid');
    if (p.delegation) throw new ApiError('access.forbidden');
    try {
      // Deliberately bypass runAs's stale-epoch refresh: admission is bound to this resolved request.
      // The transaction and all admission locks last through the response-consumption callback.
      return await withPrincipal(this.ctx.pool, p, (trx) => fn(trx, p), { snapshot: true });
    } catch (error) {
      if (error instanceof PrincipalError || ['40001', '55P03'].includes((error as { code?: string }).code ?? '')) {
        throw new ApiError('validation.revision_conflict', 'delivery authority changed or busy');
      }
      return refusal(error);
    }
  }
  hold(state: RequestState, elevationId: string, input: z.infer<typeof PrivacyHoldCommandSchema>) {
    return this.run(state, (trx) => privacy.hold(trx, this.staffContext(state, elevationId, input.reasonCode), input.requestId, input.reasonCode, input.evidenceRef));
  }
  releaseHold(state: RequestState, elevationId: string, id: string, reasonCode: 'hold_resolved') {
    return this.run(state, (trx) => privacy.releaseHold(trx, this.staffContext(state, elevationId, reasonCode), id));
  }
  erasureCheck(state: RequestState, elevationId: string, id: string) {
    return this.run(state, (trx) => privacy.erasureCheck(trx, this.staffContext(state, elevationId, 'erasure_readiness'), id));
  }
  private staffContext(state: RequestState, elevationId: string, reasonCode: string): CommandContext {
    return { elevationId, requestId: state.requestId, reasonCode, reasonText: reasonCode };
  }
}
