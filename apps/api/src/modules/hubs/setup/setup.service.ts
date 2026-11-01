import type { z } from 'zod';
import { nextSetupStep, type Principal } from '../../../deps/contracts.js';
import type { Transaction } from '../../../deps/data.js';
import { withoutPrincipal } from '../../../common/db.js';
import { ApiError } from '../../../common/errors.js';
import type { RequestState } from '../../../common/request.js';
import type { AuthService } from '../../identity/auth.service.js';
import type { AppContext } from '../../identity/context.js';
import type { PrincipalService } from '../../identity/principal.service.js';
import type { SecondFactorService } from '../../identity/second-factor/second-factor.service.js';
import { loadRestrictedPlaces } from '../../jurisdiction/gate.js';
import { summaryView, type AttestationService, type ConfiguredGateMode } from '../../jurisdiction/attestation/attestation.service.js';
import {
  configPayloadProblems, DEPLOYMENT_ATTESTATION_STATEMENT_VERSION, deploymentAttestations, FinishSetupResultSchema, FirstAdminAnswerSchema, hubConfig, HubIdentityAnswerSchema, hubs,
  InstallCheckAnswerSchema, InstallCheckSchema, maskEmail, ModesAnswerSchema, NodeIdentityAnswerSchema, OperatorAnswerSchema, OperatorScreeningSchema, ProvidersAnswerSchema,
  setupDeploymentDocument, setupHubSlug, setupLegalPayload, setupModes, setupModesProblems, setupPlaceRefusals, setupProvidersPayload, setupResidencyPayload, setupRuns,
  SetupViewSchema, splitDeploymentConfig, StorageResidencyAnswerSchema, type CommandContext, type FinishSetupResult, type FirstAdminAccount, type InstallCheck,
  type OperatorScreening, type SavedSetupStep, type SetupRunRow, type SetupView,
} from './deps.js';
import { mapRefusals, notFound } from './errors.js';
import { runInstallChecks, type InstallCheckOptions } from './install-checks.js';
import type { OperatorScreeningPort } from './operator-screening.js';
import { setupTokenHash } from './token.js';

export interface SetupServiceOptions {
  /** The jurisdiction gate this process runs (SANC-001); setup finishes only with a configured, attestable mode. */
  gateMode: ConfiguredGateMode;
  checks: InstallCheckOptions;
  screening: OperatorScreeningPort;
}

const iso = (d: Date): string => d.toISOString();
const ATTESTABLE = new Set(['ranges_file', 'edge_header', 'upstream_gate']);

/** The stored answer of a step without the server's additions (install checks, operator screening). */
function stored<T extends z.ZodType>(run: SetupRunRow, step: string, schema: T): z.infer<T> | null {
  const raw = (run.answers as Record<string, unknown>)[step];
  if (!raw || typeof raw !== 'object') return null;
  const answer = Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([key]) => key !== 'checks' && key !== 'screening'));
  const parsed = schema.safeParse(answer);
  return parsed.success ? parsed.data : null;
}

/**
 * The setup wizard backend (HUB-004): a fresh node becomes a configured draft hub.
 *
 * - The installer issues the one-time token (owner-run, `issue-token.ts`); every route below carries it in
 *   `X-Trustwork-Setup-Token`, and the database finds the open run of its hash or answers "not found".
 * - Steps 1 to 4 need only the token. Step 5 creates the founding administrator's account (the mailbox proof verifies
 *   the address), and once that person is signed in with an authenticator app and recovery codes, binds the run to
 *   them: from then on every change also needs their session.
 * - Finishing (step 9) runs in one transaction as the founding administrator under an elevated session: the
 *   deployment location is attested through SANC-009's command, the hub, its territories and every launch gate are
 *   created through HUB-001's `hubs_create`, configuration version 1 of `identity` and `country` (CFG-001's deployment
 *   document) and `modes` is activated, the sensitive `legal`, `residency` and `providers` versions are drafted for a
 *   second person, and the token is invalidated. Nothing is sent anywhere; every provider stays fake.
 */
export class SetupService {
  constructor(
    private readonly ctx: AppContext,
    private readonly principals: PrincipalService,
    private readonly auth: AuthService,
    private readonly secondFactors: SecondFactorService,
    private readonly attestation: AttestationService,
    private readonly options: SetupServiceOptions,
  ) {}

  private get now(): Date {
    return this.ctx.clock.now();
  }

  /** The caller's transaction: as the signed-in person when there is a session, otherwise without an identity. */
  private tx<T>(state: RequestState, fn: (trx: Transaction, principal: Principal | null) => Promise<T>): Promise<T> {
    return mapRefusals(() => (state.principal ? this.principals.runAs(state, (trx, p) => fn(trx, p)) : withoutPrincipal(this.ctx.pool, (trx) => fn(trx, null))));
  }

  private async openRun(trx: Transaction, hash: string): Promise<SetupRunRow> {
    const run = await setupRuns.open(trx, hash);
    if (!run) throw notFound();
    return run;
  }

  private async view(trx: Transaction, run: SetupRunRow, principal: Principal | null): Promise<SetupView> {
    const answers = run.answers as Record<string, Record<string, unknown> | undefined>;
    const savedChecks = InstallCheckSchema.array().safeParse(answers.install_check?.checks);
    const checks: InstallCheck[] = savedChecks.success ? savedChecks.data : await runInstallChecks(this.ctx.pool, this.options.checks, this.now, null);
    const screening = OperatorScreeningSchema.safeParse(answers.operator?.screening);
    const completed = run.completed as SetupView['state']['completed'];
    return SetupViewSchema.parse({
      state: {
        nodeId: run.node_id ?? run.id,
        completed,
        current: nextSetupStep({ completed }) ?? 'review',
        setupTokenHash: run.token_hash,
        setupTokenExpiresAt: iso(run.token_expires_at as Date),
        firstAdmin: run.first_admin_person_id
          ? { personId: run.first_admin_person_id, secondFactor: run.first_admin_second_factor, recoveryCodesIssuedAt: iso(run.recovery_codes_issued_at as Date) }
          : null,
        startedAt: iso(run.started_at),
        finishedAt: null,
      },
      checks,
      answers: run.answers,
      operatorScreening: screening.success ? screening.data : null,
      adminAccount: run.admin_email ? { maskedEmail: maskEmail(run.admin_email) } : null,
      session: {
        signedIn: principal !== null,
        isFirstAdmin: principal !== null && principal.personId === run.first_admin_person_id,
        secondFactor: principal !== null && (await this.secondFactors.hasActiveFactor(trx, principal.personId)),
      },
      attestation: await this.attestation.currentStatus(),
      hubId: run.hub_id,
    });
  }

  /** `GET /v1/setup`: the open run of the token (resume at `state.current`), or "not found". */
  get(state: RequestState, token: string): Promise<SetupView> {
    const hash = setupTokenHash(token);
    return this.tx(state, async (trx, p) => this.view(trx, await this.openRun(trx, hash), p));
  }

  /** `POST /v1/setup/steps/:step`: one step's answer, validated, refused when restricted, stored in order. */
  async save(state: RequestState, token: string, step: SavedSetupStep, answer: Record<string, unknown>): Promise<SetupView> {
    const hash = setupTokenHash(token);
    if (step !== 'install_check' && step !== 'providers' && step !== 'modes') {
      const refused = setupPlaceRefusals(step, answer, await loadRestrictedPlaces(this.ctx.pool));
      if (refused.length) throw new ApiError('validation.schema', 'a restricted place is never offered, hosted or served', { reason: 'restricted_place', items: refused });
    }
    if (step === 'hub_identity') {
      const zone = HubIdentityAnswerSchema.parse(answer).timeZone;
      try {
        new Intl.DateTimeFormat('en', { timeZone: zone });
      } catch {
        throw new ApiError('validation.schema', 'unknown time zone', { reason: 'time_zone_unknown', items: [zone] });
      }
    }
    if (step === 'modes') {
      const problems = setupModesProblems(ModesAnswerSchema.parse(answer));
      if (problems.length) throw new ApiError('validation.schema', 'the modes contradict a draft hub', { reason: 'modes_violation', items: problems });
    }
    const checks = step === 'install_check' ? await runInstallChecks(this.ctx.pool, this.options.checks, this.now, new Date(InstallCheckAnswerSchema.parse(answer).clientTime)) : null;
    return this.tx(state, async (trx, p) => {
      let record: Record<string, unknown> = answer;
      if (checks) record = { ...answer, checks };
      if (step === 'operator') {
        await this.openRun(trx, hash);
        const screening: OperatorScreening = await this.options.screening.screen(trx, hash, OperatorAnswerSchema.parse(answer).legalName, this.now);
        record = { ...answer, screening };
      }
      return this.view(trx, await setupRuns.save(trx, hash, step, record), p);
    });
  }

  /** `POST /v1/setup/first-admin/account`: records the address and creates the account (verification mail through the outbox). */
  async createAdminAccount(state: RequestState, token: string, body: FirstAdminAccount, locales: readonly string[]): Promise<{ status: 'verification_sent' }> {
    const hash = setupTokenHash(token);
    await this.tx(state, (trx) => setupRuns.claimAdmin(trx, hash, body.email));
    return this.auth.signup({ name: body.name, email: body.email, password: body.password, acceptedTermsVersion: 'setup-wizard' }, state.requestId, locales);
  }

  /** `POST /v1/setup/first-admin`: the signed-in caller with an authenticator app and recovery codes becomes the founding administrator. */
  async confirmFirstAdmin(state: RequestState, token: string, body: z.infer<typeof FirstAdminAnswerSchema>): Promise<SetupView> {
    const hash = setupTokenHash(token);
    return this.tx(state, async (trx, p) => {
      await this.openRun(trx, hash);
      if (!p) throw new ApiError('auth.session_invalid', 'authentication required');
      return this.view(trx, await setupRuns.bootstrapAdmin(trx, hash, body.secondFactor), p);
    });
  }

  /** `POST /v1/setup/finish` (elevated founding administrator): attest, create the hub and its configuration, finish. */
  async finish(state: RequestState, elevationId: string, token: string): Promise<FinishSetupResult> {
    const hash = setupTokenHash(token);
    const gateMode = this.options.gateMode;
    return this.tx(state, async (trx, p) => {
      if (!p) throw new ApiError('auth.session_invalid', 'authentication required');
      const run = await setupRuns.beginFinish(trx, hash);
      const node = stored(run, 'node_identity', NodeIdentityAnswerSchema);
      const hub = stored(run, 'hub_identity', HubIdentityAnswerSchema);
      const operator = stored(run, 'operator', OperatorAnswerSchema);
      const residency = stored(run, 'storage_residency', StorageResidencyAnswerSchema);
      const providers = stored(run, 'providers', ProvidersAnswerSchema);
      const modes = stored(run, 'modes', ModesAnswerSchema);
      if (!node || !hub || !operator || !residency || !providers || !modes) {
        const missing = (['node_identity', 'hub_identity', 'operator', 'storage_residency', 'providers', 'modes'] as const).filter((s, i) => ![node, hub, operator, residency, providers, modes][i]);
        throw new ApiError('validation.schema', 'complete the earlier steps first', { reason: 'step_out_of_order', items: missing });
      }
      // The jurisdiction-gate mode must be configured in this process and be the one the operator states (SANC-009).
      if (!ATTESTABLE.has(gateMode)) throw new ApiError('validation.schema', 'configure the jurisdiction gate (TRUSTWORK_JURISDICTION_GATE) before finishing', { reason: 'jurisdiction_gate_unconfigured', items: [gateMode] });
      if (gateMode !== operator.gateMode) throw new ApiError('validation.schema', 'the configured jurisdiction gate differs from the stated one', { reason: 'jurisdiction_gate_mismatch', items: [gateMode, operator.gateMode] });
      const cmd: CommandContext = { elevationId, requestId: state.requestId, reasonCode: 'setup_wizard', reasonText: 'Setup wizard: first run of this node' };

      // 1. The deployment-location attestation (SANC-009), unless the current one already states exactly this.
      const statement = { operatorEntityCountry: operator.entityCountry, operatorEntityRegion: operator.entityRegion, hostingCountry: operator.hostingCountry, hostingRegion: operator.hostingRegion, gateMode: operator.gateMode };
      const before = await deploymentAttestations.current(trx);
      const same = before !== null && before.operator_entity_country === statement.operatorEntityCountry && before.operator_entity_region === statement.operatorEntityRegion
        && before.hosting_country === statement.hostingCountry && before.hosting_region === statement.hostingRegion && before.gate_mode === statement.gateMode;
      const sameStatus = same ? await this.attestation.statusOf(summaryView(before)) : null;
      let attestationId: string;
      if (same && sameStatus && (sameStatus.state === 'valid' || sameStatus.state === 'renewal_due')) attestationId = before.id;
      else attestationId = (await deploymentAttestations.attest(trx, cmd, { ...statement, supersedes: before?.id ?? null, statementVersion: DEPLOYMENT_ATTESTATION_STATEMENT_VERSION })).id;
      const current = await deploymentAttestations.current(trx);
      const status = await this.attestation.statusOf(current ? summaryView(current) : null);
      if (status.state !== 'valid' && status.state !== 'renewal_due') {
        throw new ApiError('validation.schema', 'setup finishes only with a valid deployment-location attestation', { reason: 'attestation_invalid', items: status.problems });
      }

      // 2. The hub, its territories and every launch gate (HUB-001), as a draft.
      const pack = hub.startingPoint === 'pack'
        ? await trx.selectFrom('jurisdiction').select(['code', 'pack_version']).where('code', '=', hub.country).where('source', '=', 'pack').where('retired_at', 'is', null).executeTakeFirst()
        : undefined;
      if (hub.startingPoint === 'pack' && !pack) throw new ApiError('validation.schema', 'the country has no active pack', { reason: 'pack_unknown', items: [hub.country] });
      const slug = setupHubSlug(hub);
      const profile = await hubs.create(trx, cmd, {
        slug, name: hub.name, defaultLocale: hub.defaultLocale, locales: [...hub.locales], timeZone: hub.timeZone, currency: hub.currency,
        countryPack: pack ? { code: pack.code, version: pack.pack_version } : null, territories: hub.territories.map((t) => ({ level: t.level, code: t.code })),
      });
      const hubId = profile.hub_id;

      // 3. Configuration version 1: identity and country from CFG-001's deployment document, and modes, activated now
      // (none is sensitive); legal, residency and providers drafted for the second person (sensitive domains).
      const { identity, country } = splitDeploymentConfig(setupDeploymentDocument(node, hub));
      const versions: FinishSetupResult['configVersions'] = [];
      const draft = async (domain: string, payload: Record<string, unknown>, activate: boolean, source: 'console' | 'deployment_import' = 'console') => {
        const problems = configPayloadProblems(domain as Parameters<typeof configPayloadProblems>[0], payload);
        if (problems.length) throw new ApiError('validation.schema', 'a configuration built from the answers does not match its domain', { reason: 'payload_invalid', items: problems.slice(0, 20) });
        const v = await hubConfig.draft(trx, cmd, hubId, domain, payload, source);
        const out = activate ? await hubConfig.activate(trx, cmd, v.id, v.revision, null) : v;
        versions.push({ domain, versionId: out.id, status: activate ? 'active' : 'draft' });
      };
      await draft('identity', identity as Record<string, unknown>, true, 'deployment_import');
      await draft('country', country as Record<string, unknown>, true, 'deployment_import');
      await draft('modes', setupModes(modes) as unknown as Record<string, unknown>, true);
      await draft('legal', setupLegalPayload(operator) as unknown as Record<string, unknown>, false);
      await draft('residency', setupResidencyPayload(operator, residency) as unknown as Record<string, unknown>, false);
      await draft('providers', setupProvidersPayload(providers), false);

      // 4. Finish: the database re-checks the founding administrator, the second factor and the attestation in force.
      await setupRuns.finish(trx, hash, hubId);
      return FinishSetupResultSchema.parse({ hubId, slug, attestationId, configVersions: versions, next: ['inviteStaff', 'legalDocuments', 'firstSource', 'verificationRecipe', 'backupDrill'] });
    });
  }
}
