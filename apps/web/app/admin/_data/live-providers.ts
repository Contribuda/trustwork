import { z } from 'zod';
import { computeDigest } from '../../../../../packages/contracts/src/common/digest.js';
import { egressAllowDigestInput, providerKillReleaseDigestInput } from '../../../../../packages/contracts/src/providers.js';
import { approvalStage, hubApprovals, type ApprovalStage, type LiveApproval } from './live-approvals.js';
import { connectionDraft, credentialDraft, egressCell, pricingDraft, type ProviderCommandId } from '../hubs/[hub]/integrations/providers/_commands.js';
import type { CommandOutcome, RejectCode } from './commands.js';

/**
 * HC-100 Providers and HC-102 Egress on the API (HUBC-007): connections, their secret references, tests, enabling, kill
 * switches and cost records from KEYS-001, the hub's credential references from HUB-001. No secret value is read or sent
 * here: a connection shows its reference and keyed fingerprint only, and the schemas below keep nothing else, so a field
 * added to an API view does not reach a page by accident.
 */

const UUID = z.uuid();
const Timestamp = z.iso.datetime();
const SecretVersionSchema = z.object({
  ref: z.object({ id: UUID, store: z.string(), keyedFingerprint: z.string(), version: z.int(), createdAt: Timestamp, rotatedAt: Timestamp.nullable(), lastUsedAt: Timestamp.nullable() }),
  status: z.enum(['active', 'grace', 'destroyed']), graceUntil: Timestamp.nullable(), destroyedAt: Timestamp.nullable(),
});
const HostingSchema = z.object({ kind: z.enum(['self_hosted', 'vendor']), country: z.string(), zeroRetention: z.boolean().optional(), trainsOnInputs: z.boolean().optional(), broker: z.boolean().optional() });
const ConnectionSchema = z.object({
  id: UUID, hubId: UUID, adapterId: z.string(), label: z.string(), capabilities: z.array(z.string()), mode: z.enum(['fake', 'manual', 'live']), endpoint: z.string().nullable(), hosting: HostingSchema,
  storageCountry: z.string().nullable(), region: z.string().nullable(), inHubResidency: z.boolean(), status: z.enum(['draft', 'enabled', 'disabled', 'killed']),
  secret: z.object({ source: z.enum(['none', 'envelope', 'credential_ref']), versions: z.array(SecretVersionSchema), credentialRefId: UUID.nullable() }),
  lastTest: z.object({ at: Timestamp, outcome: z.string(), latencyMs: z.int().nullable() }).nullable(), killSwitchId: UUID.nullable(), revision: z.int().min(1),
  enable: z.object({ secondPersonAction: z.string(), actionDigest: z.string() }).nullable(),
});
const ConnectionsSchema = z.object({ items: z.array(ConnectionSchema) });
/** A credential as the page may show it: where the secret lives and its state. */
const CredentialSchema = z.object({
  id: UUID, provider: z.string(), adapter: z.string(), mode: z.enum(['fake', 'manual', 'live']), secret: z.object({ store: z.string(), ref: z.string() }), status: z.string(), revision: z.int(),
  activation: z.object({ secondPersonAction: z.string(), actionDigest: z.string() }).nullable(),
});
const CredentialsSchema = z.object({ items: z.array(CredentialSchema) });
const PricingSchema = z.object({
  items: z.array(z.object({
    id: UUID, version: z.int(), connectionId: UUID, modelId: z.string(), currency: z.string(), inputPerMillionTokens: z.string().nullable(), outputPerMillionTokens: z.string().nullable(), basis: z.string(), observedAt: Timestamp, sourceNote: z.string().nullable(),
  })),
});
const EgressRuleSchema = z.object({ id: UUID, connectionId: UUID, dataClass: z.string(), decision: z.enum(['allow', 'deny']), requireInResidency: z.boolean(), requireZeroRetention: z.boolean(), version: z.int() });
const EgressSchema = z.object({ cells: z.array(EgressRuleSchema), history: z.array(EgressRuleSchema) });
const ConfigCurrentSchema = z.object({ items: z.array(z.record(z.string(), z.unknown())) });
const TestAnswerSchema = z.object({ test: z.object({ outcome: z.string() }), reason: z.string().nullable() });
const CommandAnswerSchema = z.object({ result: z.object({ outcome: z.string() }) });

export type ProviderConnection = z.infer<typeof ConnectionSchema> & { enableStage: ApprovalStage };
export type ProviderCredential = z.infer<typeof CredentialSchema> & { activationStage: ApprovalStage };
export type ModelCost = z.infer<typeof PricingSchema>['items'][number];
export type EgressRule = z.infer<typeof EgressRuleSchema>;
export type ProvidersView = {
  connections: ProviderConnection[];
  /** `null`: the viewer may not read this list (never "none"). */
  credentials: ProviderCredential[] | null;
  costs: ModelCost[] | null;
  egress: { cells: EgressRule[]; history: EgressRule[] } | null;
  /** The active `egress` configuration version the launch checklist reads. */
  egressReview: { version: number } | null;
};

export type SectionApi = { get(path: `/v1/${string}`): Promise<unknown> };
type Read = <T>(read: Promise<T>) => Promise<T | null>;

/** The section's view for this viewer, or null when the API does not show it (no providers permission, unknown hub). */
export async function readProviders(api: SectionApi, orNothing: Read, hubId: string, viewerId: string | null, now: Date): Promise<ProvidersView | null> {
  const hub = encodeURIComponent(hubId);
  const list = await orNothing(api.get(`/v1/admin/hubs/${hub}/providers/connections`));
  if (list === null) return null;
  const [credentials, costs, egress, current, approvalLists] = await Promise.all([
    orNothing(api.get(`/v1/admin/hubs/${hub}/credentials`)),
    orNothing(api.get(`/v1/admin/hubs/${hub}/providers/pricing`)),
    orNothing(api.get(`/v1/admin/hubs/${hub}/providers/egress`)),
    orNothing(api.get(`/v1/admin/hubs/${hub}/config/current`)),
    orNothing(api.get(`/v1/admin/approvals?hubId=${hub}`)),
  ]);
  const approvals: readonly LiveApproval[] = hubApprovals(approvalLists, hubId);
  const stageOf = (digest: { secondPersonAction: string; actionDigest: string } | null): ApprovalStage => (digest && viewerId ? approvalStage(approvals, digest.secondPersonAction, digest.actionDigest, viewerId, now) : { stage: 'none' });
  const row = ConfigCurrentSchema.safeParse(current).data?.items.find((i) => i.domain === 'egress');
  const version = z.int().min(1).safeParse(row?.version).data;
  return {
    connections: ConnectionsSchema.parse(list).items.filter((c) => c.hubId === hubId).map((c) => ({ ...c, enableStage: stageOf(c.enable) })),
    credentials: CredentialsSchema.safeParse(credentials).data?.items.map((c) => ({ ...c, activationStage: stageOf(c.activation) })) ?? null,
    costs: PricingSchema.safeParse(costs).data?.items ?? null,
    egress: EgressSchema.safeParse(egress).data ?? null,
    egressReview: version === undefined ? null : { version },
  };
}

export type SectionAnswer = { status: number; code: string | null; body?: unknown };
export type ProviderSend = {
  send(path: `/v1/${string}`, rest: Record<string, unknown>): Promise<SectionAnswer>;
  /** A new configuration version and its activation, which a sensitive domain leaves as a draft for a second person. */
  saveConfig(domain: string, payload: Record<string, unknown>): Promise<CommandOutcome>;
  read(): Promise<ProvidersView | null>;
  form: { currency: string; now: Date };
  viewerId: string;
  hubId: string;
  now: Date;
  /** The hub's requests as this viewer sees them. */
  approvals(): Promise<readonly LiveApproval[]>;
};

const RefusalSchema = z.object({ details: z.object({ reason: z.string() }) });
const as = (code: RejectCode, field: string | null = null, detail: string[] = []): CommandOutcome => ({ status: 'rejected', code, field, detail });

/** The API's refusal in the console's words. A provider rule keeps its own reason: `providers.reasons.*` words every one. */
export function providerRefusal(answer: SectionAnswer): CommandOutcome {
  const reason = RefusalSchema.safeParse(answer.body).data?.details.reason;
  if (answer.status === 404) return { status: 'not_found' };
  if (answer.status === 401) return as('elevation_required');
  if (answer.code === 'access.approval_digest_mismatch') return as('digest_mismatch');
  if (answer.code === 'access.second_approver_required') return as(reason === 'self_approval' ? 'own_request' : 'second_person_pending');
  if (answer.status === 403) return as(reason === 'elevation_required' ? 'elevation_required' : 'denied');
  if (reason === 'revision_conflict') return as('stale');
  return reason ? as('provider_reason', null, [reason]) : as('invalid');
}

const done = (answer: SectionAnswer): CommandOutcome => (answer.status >= 200 && answer.status < 300 ? { status: 'applied' } : providerRefusal(answer));
const pending = (action: 'providers.enable_non_fake' | 'egress.allow_private_class' | 'kill_switch.release'): CommandOutcome => ({ status: 'pending_second_person', secondPerson: action });
/** Applied, or the second person the API asked for instead. */
const settled = (answer: SectionAnswer, action: Parameters<typeof pending>[0]): CommandOutcome => {
  if (answer.status < 200 || answer.status >= 300) return providerRefusal(answer);
  return CommandAnswerSchema.safeParse(answer.body).data?.result.outcome === 'pending_second_person' ? pending(action) : { status: 'applied' };
};

/** One provider command against the API. The form was checked by the shell's evaluation; the API repeats every rule. */
export async function providerCommand(command: ProviderCommandId, f: Readonly<Record<string, string>>, io: ProviderSend): Promise<CommandOutcome> {
  const base = `/v1/admin/hubs/${encodeURIComponent(io.hubId)}` as const;
  const providers = `${base}/providers` as const;
  const invalid = (body: object): CommandOutcome | null => ('field' in body ? as('invalid', (body as { field: string }).field) : null);
  /** The connection the form names, from a fresh read: its revision is the API's, never the page's. */
  const connection = async () => (await io.read())?.connections.find((c) => c.id === f.connectionId) ?? null;
  const path = (id: string | undefined) => `${providers}/connections/${encodeURIComponent(id ?? '')}` as const;
  switch (command) {
    case 'providers.connection_create': {
      const body = connectionDraft(f);
      return invalid(body) ?? done(await io.send(`${providers}/connections`, body));
    }
    case 'providers.connection_test': {
      const answer = await io.send(`${path(f.connectionId)}/test`, { connectionId: f.connectionId, syntheticInputOnly: true });
      if (answer.status < 200 || answer.status >= 300) return providerRefusal(answer);
      const test = TestAnswerSchema.safeParse(answer.body).data;
      // A test that ran and did not pass is an answer, not a success: it is recorded, and the page shows its outcome.
      return test?.test.outcome === 'ok' ? { status: 'applied' } : as('provider_reason', null, [test?.reason ?? 'test_failed']);
    }
    case 'providers.connection_enable': {
      const c = await connection();
      if (!c) return { status: 'not_found' };
      if (c.mode === 'fake') return done(await io.send(`${path(c.id)}/enable`, { expectedRevision: c.revision, approvalId: null }));
      if (c.enableStage.stage === 'requested') return as('second_person_pending');
      return settled(await io.send(`${path(c.id)}/enable`, { expectedRevision: c.revision, approvalId: c.enableStage.stage === 'approved' ? c.enableStage.requestId : null }), 'providers.enable_non_fake');
    }
    case 'providers.connection_disable': {
      const c = await connection();
      return c ? done(await io.send(`${path(c.id)}/disable`, { expectedRevision: c.revision })) : { status: 'not_found' };
    }
    case 'providers.secret_revoke': {
      const c = await connection();
      return c ? done(await io.send(`${path(c.id)}/secret/revoke`, { expectedRevision: c.revision })) : { status: 'not_found' };
    }
    case 'providers.kill_engage':
      return done(await io.send(`${providers}/kill-switches`, { target: { kind: 'connection', connectionId: f.connectionId } }));
    case 'providers.kill_release': {
      // The approval binds the switch and the incident note, so the same note finishes what it asked for.
      const killSwitchId = f.killSwitchId ?? '';
      const incidentNote = (f.incidentNote ?? '').trim();
      const stage = approvalStage(await io.approvals(), 'kill_switch.release', computeDigest(providerKillReleaseDigestInput({ killSwitchId, incidentNote })).value, io.viewerId, io.now);
      if (stage.stage === 'requested') return as('second_person_pending');
      return settled(await io.send(`${providers}/kill-switches/${encodeURIComponent(killSwitchId)}/release`, { incidentNote, approvalId: stage.stage === 'approved' ? stage.requestId : null }), 'kill_switch.release');
    }
    case 'providers.credential_register': {
      const body = credentialDraft(f);
      return invalid(body) ?? done(await io.send(`${base}/credentials`, body));
    }
    case 'providers.credential_activate': {
      const credential = (await io.read())?.credentials?.find((c) => c.id === f.credentialId);
      if (!credential) return { status: 'not_found' };
      if (credential.activationStage.stage === 'requested') return as('second_person_pending');
      return settled(await io.send(`${base}/credentials/${encodeURIComponent(credential.id)}/activate`, { approvalId: credential.activationStage.stage === 'approved' ? credential.activationStage.requestId : null }), 'providers.enable_non_fake');
    }
    case 'providers.credential_retire':
      return done(await io.send(`${base}/credentials/${encodeURIComponent(f.credentialId ?? '')}/retire`, {}));
    case 'providers.pricing_record': {
      const body = pricingDraft(f, io.form);
      return invalid(body) ?? done(await io.send(`${providers}/pricing`, body));
    }
    case 'providers.egress_set': {
      const cell = egressCell(f);
      if ('field' in cell) return as('invalid', cell.field);
      if (cell.decision === 'deny' || cell.dataClass === 'public') return done(await io.send(`${providers}/egress`, { ...cell, approvalId: null }));
      // The approval binds the next version of this cell, so the same choice finishes what it asked for.
      const view = await io.read();
      if (!view?.egress) return { status: 'not_found' };
      const version = Math.max(0, ...view.egress.history.filter((r) => r.connectionId === cell.connectionId && r.dataClass === cell.dataClass).map((r) => r.version)) + 1;
      const digest = computeDigest(egressAllowDigestInput({ hubId: io.hubId, connectionId: cell.connectionId, dataClass: cell.dataClass, requireInResidency: cell.requireInResidency, requireZeroRetention: cell.requireZeroRetention, version })).value;
      const stage = approvalStage(await io.approvals(), 'egress.allow_private_class', digest, io.viewerId, io.now);
      if (stage.stage === 'requested') return as('second_person_pending');
      return settled(await io.send(`${providers}/egress`, { ...cell, approvalId: stage.stage === 'approved' ? stage.requestId : null }), 'egress.allow_private_class');
    }
    case 'providers.egress_signoff': {
      const view = await io.read();
      if (!view?.egress) return { status: 'not_found' };
      // What is signed off is the matrix as it stands: non-public data is denied except for these cells.
      const allowedNonPublic = view.egress.cells.filter((c) => c.decision === 'allow' && c.dataClass !== 'public').map((c) => ({ connectionId: c.connectionId, dataClass: c.dataClass, cellVersion: c.version }));
      return io.saveConfig('egress', { defaultNonPublic: 'deny', allowedNonPublic });
    }
  }
}
