import { z } from 'zod';
import { approvalStage, hubApprovals, type ApprovalStage, type LiveApproval } from './live-approvals.js';
import { claimSettings, providerDraft, recipeDraft, type VerificationCommandId } from '../hubs/[hub]/participants/verification/_commands.js';
import type { CommandOutcome, RejectCode } from './commands.js';

/**
 * HC-23 Verification on the API (HUBC-007): recipes and check providers from HUB-003, the claim waiting periods from
 * CLM-001, the hub's provider credentials (HUB-001) and the screening lists (SANC-006). Every read is the viewer's own,
 * under the elevated session; nothing here is computed for display that the API did not answer.
 */

const UUID = z.uuid();
const Timestamp = z.iso.datetime();
const StepSchema = z.union([z.object({ check: z.string(), required: z.boolean() }), z.object({ anyOf: z.array(z.string()) })]);
const ProviderSchema = z.object({
  id: UUID, hubId: UUID, checkType: z.string(), adapter: z.string(), mode: z.enum(['fake', 'manual', 'live']), credentialRefId: UUID.nullable(), retentionDays: z.int(), legalBasis: z.string(),
  costMinor: z.string().nullable(), status: z.enum(['active', 'retired']), revision: z.int().min(1),
});
const RecipeSchema = z.object({
  id: UUID, hubId: UUID, key: z.string(), version: z.int().min(1), subjectKind: z.enum(['company', 'person']), trigger: z.string(), steps: z.array(StepSchema), badgeCategories: z.array(z.string()),
  recheckMonths: z.int(), status: z.enum(['draft', 'active', 'superseded']), draftedBy: UUID, activatedBy: UUID.nullable(), activatedAt: Timestamp.nullable(), revision: z.int().min(1), createdAt: Timestamp,
});
const OverviewSchema = z.object({ providers: z.array(ProviderSchema), recipes: z.array(RecipeSchema) });
const ClaimsOverviewSchema = z.object({ settings: z.object({ waitingDays: z.int(), coolingDays: z.int(), revision: z.int(), updatedAt: Timestamp.nullable() }) });
const CredentialsSchema = z.object({ items: z.array(z.object({ id: UUID, provider: z.string(), adapter: z.string(), mode: z.string(), status: z.string() })) });
const ListsSchema = z.object({ items: z.array(z.object({ code: z.string(), baseline: z.boolean(), hubId: UUID.nullable(), mode: z.string(), status: z.string(), freshness: z.object({ ageSeconds: z.number().nullable() }).passthrough() })) });
const LiveDigestSchema = z.object({ action: z.string(), actionDigest: z.string().regex(/^[a-f0-9]{64}$/), revision: z.int() });
const ConfigCurrentSchema = z.object({ items: z.array(z.record(z.string(), z.unknown())) });
const RecordedRecipesSchema = z.object({ activeRecipes: z.array(z.object({ recipeId: UUID })) });

export type VerificationProvider = z.infer<typeof ProviderSchema>;
export type VerificationRecipe = z.infer<typeof RecipeSchema>;
export type VerificationCredential = z.infer<typeof CredentialsSchema>['items'][number];
/** One credential a provider could go live with, with the digest a second person approves and where it stands. */
export type LiveOption = { credentialId: string; digest: string; stage: ApprovalStage };
export type VerificationView = {
  hubId: string;
  recipes: VerificationRecipe[];
  providers: VerificationProvider[];
  /** `null`: the viewer may not read them (never "nothing is set"). */
  settings: z.infer<typeof ClaimsOverviewSchema>['settings'] | null;
  credentials: VerificationCredential[] | null;
  lists: z.infer<typeof ListsSchema>['items'] | null;
  /** Per provider that may still go live: the options by credential. */
  liveOptions: Readonly<Record<string, readonly LiveOption[]>>;
  /** The active `verification` configuration version the launch checklist reads, and whether it names exactly the active recipes. */
  config: { version: number; current: boolean } | null;
};

export type SectionApi = { get(path: `/v1/${string}`): Promise<unknown> };
type Read = <T>(read: Promise<T>) => Promise<T | null>;

export const activeRecipes = (recipes: readonly VerificationRecipe[]) => recipes.filter((r) => r.status === 'active');

/** The payload of a `verification` configuration version: which recipe versions the hub runs. */
export function configPayload(recipes: readonly VerificationRecipe[]) {
  return { activeRecipes: activeRecipes(recipes).map((r) => ({ recipeId: r.id, key: r.key, version: r.version, subjectKind: r.subjectKind, trigger: r.trigger })) };
}

async function goLiveOptions(api: SectionApi, orNothing: Read, hub: string, providers: readonly VerificationProvider[], credentials: readonly VerificationCredential[], approvals: readonly LiveApproval[], viewerId: string | null, now: Date) {
  const options: Record<string, LiveOption[]> = {};
  const usable = credentials.filter((c) => c.status === 'active' && c.mode !== 'fake');
  for (const provider of providers.filter((p) => p.status === 'active' && p.mode !== 'live')) {
    const rows: LiveOption[] = [];
    for (const credential of usable) {
      const answer = LiveDigestSchema.safeParse(await orNothing(api.get(`/v1/admin/hubs/${hub}/verification/providers/${encodeURIComponent(provider.id)}/live-digest?credentialRefId=${encodeURIComponent(credential.id)}`)));
      if (answer.success) rows.push({ credentialId: credential.id, digest: answer.data.actionDigest, stage: viewerId ? approvalStage(approvals, answer.data.action, answer.data.actionDigest, viewerId, now) : { stage: 'none' } });
    }
    options[provider.id] = rows;
  }
  return options;
}

/** The section's view for this viewer, or null when the API does not show it (no reader permission, unknown hub). */
export async function readVerification(api: SectionApi, orNothing: Read, hubId: string, viewerId: string | null, now: Date): Promise<VerificationView | null> {
  const hub = encodeURIComponent(hubId);
  const overview = await orNothing(api.get(`/v1/admin/hubs/${hub}/verification`));
  if (overview === null) return null;
  const { providers, recipes } = OverviewSchema.parse(overview);
  const [claims, credentialList, lists, approvals, current] = await Promise.all([
    orNothing(api.get(`/v1/admin/hubs/${hub}/claims`)),
    orNothing(api.get(`/v1/admin/hubs/${hub}/credentials`)),
    orNothing(api.get('/v1/admin/screening/lists')),
    orNothing(api.get(`/v1/admin/approvals?hubId=${hub}`)),
    orNothing(api.get(`/v1/admin/hubs/${hub}/config/current`)),
  ]);
  const credentials = CredentialsSchema.safeParse(credentialList).data?.items ?? null;
  const row = ConfigCurrentSchema.safeParse(current).data?.items.find((i) => i.domain === 'verification');
  const recorded = RecordedRecipesSchema.safeParse(row?.payload).data?.activeRecipes.map((r) => r.recipeId).sort() ?? null;
  const version = z.int().min(1).safeParse(row?.version).data;
  const running = activeRecipes(recipes).map((r) => r.id).sort();
  return {
    hubId, recipes: [...recipes].sort((a, b) => a.key.localeCompare(b.key) || b.version - a.version), providers,
    settings: ClaimsOverviewSchema.safeParse(claims).data?.settings ?? null,
    credentials,
    lists: ListsSchema.safeParse(lists).data?.items.filter((l) => l.hubId === null || l.hubId === hubId) ?? null,
    liveOptions: await goLiveOptions(api, orNothing, hub, providers, credentials ?? [], hubApprovals(approvals, hubId), viewerId, now),
    config: version === undefined ? null : { version, current: recorded !== null && recorded.length === running.length && recorded.every((id, i) => id === running[i]) },
  };
}

export type SectionAnswer = { status: number; code: string | null; body?: unknown };
export type VerificationSend = {
  /** A staff command with reason, idempotency key and console contract version. */
  send(path: `/v1/${string}`, rest: Record<string, unknown>): Promise<SectionAnswer>;
  /** A new configuration version, activated at once: `verification` is not a sensitive domain. */
  saveConfig(domain: string, payload: Record<string, unknown>): Promise<CommandOutcome>;
  read(): Promise<VerificationView | null>;
  viewerId: string;
  hubId: string;
};

const RefusalSchema = z.object({ details: z.object({ reason: z.string() }) });
const as = (code: RejectCode, field: string | null = null): CommandOutcome => ({ status: 'rejected', code, field, detail: [] });

/** The API's refusal in the console's words; the API decided, this only names it. */
export function verificationRefusal(answer: SectionAnswer): CommandOutcome {
  const reason = RefusalSchema.safeParse(answer.body).data?.details.reason;
  if (answer.status === 404) return { status: 'not_found' };
  if (answer.status === 401) return as('elevation_required');
  if (answer.code === 'access.approval_digest_mismatch') return as('digest_mismatch');
  if (answer.code === 'access.second_approver_required') return as(reason === 'self_approval' ? 'own_request' : 'second_person_pending');
  if (answer.status === 403) return as(reason === 'elevation_required' ? 'elevation_required' : 'denied');
  // A provider of this check and adapter already exists: the form is what to correct.
  if (reason === 'duplicate') return as('invalid', 'adapter');
  // Another staff member moved the version.
  if (answer.code === 'validation.revision_conflict') return as('stale');
  return as('invalid');
}

const done = (answer: SectionAnswer): CommandOutcome => (answer.status >= 200 && answer.status < 300 ? { status: 'applied' } : verificationRefusal(answer));

/** One verification command against the API. The form was checked by the shell's evaluation; the API repeats every rule. */
export async function verificationCommand(command: VerificationCommandId, f: Readonly<Record<string, string>>, io: VerificationSend): Promise<CommandOutcome> {
  const base = `/v1/admin/hubs/${encodeURIComponent(io.hubId)}` as const;
  const invalid = (body: object): CommandOutcome | null => ('field' in body ? as('invalid', (body as { field: string }).field) : null);
  switch (command) {
    case 'verification.recipe_draft': {
      const body = recipeDraft(f);
      return invalid(body) ?? done(await io.send(`${base}/verification/recipes`, body));
    }
    case 'verification.recipe_activate':
      // The revision the page showed: a recipe moved by someone else answers a conflict, never an activation of what nobody saw.
      return done(await io.send(`${base}/verification/recipes/${encodeURIComponent(f.recipeId ?? '')}/activate`, { expectedRevision: Number.parseInt(f.revision ?? '', 10) }));
    case 'verification.provider_register': {
      const body = providerDraft(f);
      return invalid(body) ?? done(await io.send(`${base}/verification/providers`, body));
    }
    case 'verification.claim_settings': {
      const body = claimSettings(f);
      return invalid(body) ?? done(await io.send(`${base}/claims/settings`, body));
    }
    case 'verification.config_record': {
      const view = await io.read();
      if (!view) return { status: 'not_found' };
      if (activeRecipes(view.recipes).length === 0) return as('invalid');
      return io.saveConfig('verification', configPayload(view.recipes));
    }
    case 'verification.provider_request_live':
    case 'verification.provider_go_live': {
      const view = await io.read();
      const provider = view?.providers.find((p) => p.id === f.providerId);
      const option = view?.liveOptions[f.providerId ?? '']?.find((o) => o.credentialId === f.credentialRefId);
      if (!view || !provider || !option) return { status: 'not_found' };
      if (command === 'verification.provider_request_live') {
        if (option.stage.stage !== 'none') return as('second_person_pending');
        const answer = await io.send('/v1/admin/approvals', { subject: { action: 'providers.enable_non_fake', scope: { kind: 'hub', hubId: io.hubId }, actionDigest: option.digest } });
        return answer.status >= 200 && answer.status < 300 ? { status: 'pending_second_person', secondPerson: 'providers.enable_non_fake' } : verificationRefusal(answer);
      }
      if (option.stage.stage !== 'approved') return as('second_person_pending');
      return done(await io.send(`${base}/verification/providers/${encodeURIComponent(provider.id)}/live`, { expectedRevision: provider.revision, credentialRefId: option.credentialId, approvalId: option.stage.requestId }));
    }
  }
}
