import {
  blockingGates,
  HUB_LIFECYCLE,
  HUB_MODULES,
  hubTransitionAllowed,
  KillSwitchScopeSchema,
  LAUNCH_GATES,
  MODULE_DEPENDENCIES,
  modesViolations,
  AUTOMATION_DOMAINS,
  SETUP_STEPS,
  territoryRestricted,
  HubTerritorySchema,
  type ConsolePermission,
  type ConsoleSecondPersonAction,
  type HubLifecycle,
  type HubModes,
  type HubModule,
  type HubTerritory,
  type RestrictedPredicate,
} from '@trustwork/contracts/client';
import type { ConsoleAccess, StaffViewer } from './port.js';
// HUBC-005: commands of the agent product, product modules, billing and communications live with their screens.
import { evaluateProductCommand, isProductCommand, PRODUCT_COMMAND_PERMISSIONS, PRODUCT_COMMANDS, PRODUCT_REJECT_CODES } from '../hubs/[hub]/modules/_kit/commands.js';
import type { HubProduct } from '../hubs/[hub]/modules/_kit/schemas.js';
import { LEGAL_DOCUMENT_KINDS, TAXONOMY_KINDS, type ApprovalRequest, type HubRecord, type LegalDocument, type SetupRun } from './schemas.js';

/**
 * Console commands (ADM-002): one pure evaluation shared by every adapter. It authorizes (role on the hub, the
 * command's permission, the approval's own permission), checks the elevated session, the reason, optimistic
 * concurrency (`expectedRevision`), the frozen contract invariants (restricted places, lifecycle transitions, launch
 * gates, mode consistency, module dependencies, approval binding) and returns what would happen. The fixture adapter
 * stops there ("Demo: changes are not saved"); the API adapter sends the same command to the backend, which repeats
 * every check as the authority.
 */

export const COMMANDS = [
  'identity.save', 'modes.save', 'lifecycle.request', 'modules.toggle', 'legal.draft', 'legal.request_activation', 'residency.request_change',
  'country.add_addition', 'taxonomy.add_term', 'launch.mark_passed', 'approvals.decide', 'approvals.withdraw', 'killswitch.engage', 'setup.save',
  ...PRODUCT_COMMANDS,
] as const;
export type CommandId = (typeof COMMANDS)[number];
export function isCommandId(value: unknown): value is CommandId {
  return typeof value === 'string' && (COMMANDS as readonly string[]).includes(value);
}

/** The permission a command needs on the hub (`staff`: any role; the approval commands then check the approval's own permission). */
export const COMMAND_PERMISSIONS: Record<Exclude<CommandId, 'setup.save'>, 'staff' | readonly ConsolePermission[]> = {
  'identity.save': ['admin.hub.identity.edit'],
  'modes.save': ['admin.hub.modes.edit'],
  'lifecycle.request': ['admin.hub.lifecycle.request'],
  'modules.toggle': ['admin.hub.modes.edit'],
  'legal.draft': ['admin.hub.legal.edit'],
  'legal.request_activation': ['admin.hub.legal.activate'],
  'residency.request_change': ['admin.hub.residency.edit'],
  'country.add_addition': ['admin.hub.country.edit'],
  'taxonomy.add_term': ['admin.taxonomy.edit'],
  'launch.mark_passed': ['admin.hub.launch.check'],
  'approvals.decide': 'staff',
  'approvals.withdraw': 'staff',
  'killswitch.engage': ['admin.providers.kill', 'admin.agents.kill'],
  ...PRODUCT_COMMAND_PERMISSIONS,
};

/** Who may approve a second-person action: a different person holding one of these permissions on the same scope. */
export const APPROVER_PERMISSIONS: Record<ConsoleSecondPersonAction, readonly ConsolePermission[]> = {
  'staff.assign_sensitive_role': ['admin.staff.assign'],
  'commerce.activate_price_version': ['admin.commerce.price.activate'],
  'privacy.execute_erasure': ['admin.privacy.erasure.execute'],
  'moderation.apply_sanction_l4': ['admin.moderation.decide'],
  'providers.enable_non_fake': ['admin.providers.toggle', 'admin.providers.egress.edit'],
  'staff.switch_sod_mode': ['admin.staff.assign'],
  'hub.transition_soft_launch': ['admin.hub.lifecycle.request'],
  'hub.transition_public': ['admin.hub.lifecycle.request'],
  'hub.change_residency': ['admin.hub.residency.edit', 'admin.hub.lifecycle.request'],
  'legal.activate_document_version': ['admin.hub.legal.activate', 'admin.hub.lifecycle.request'],
  'federation.raise_peering_level': ['admin.federation.peer.edit'],
  'models.activate_private_route': ['admin.models.route.activate'],
  'egress.allow_private_class': ['admin.providers.egress.edit'],
  'pipelines.activate_personal_data_dataset': ['admin.datasets.activate'],
  'datasets.activate_court_or_debt': ['admin.datasets.activate'],
  'automation.raise_to_supervised_autonomous': ['admin.editorial.automation.edit', 'admin.hub.modes.edit'],
  'agents.enable_commitment_module': ['admin.agents.modules.activate'],
  'agents.activate_extension': ['admin.agents.extensions.activate'],
  'jurisdiction.activate_settings': ['admin.hub.jurisdiction.activate'],
  'billing.activate_fee_version': ['admin.billing.fees.activate'],
  'billing.release_payout_batch': ['admin.billing.payouts.release'],
  'payments.change_settings': ['admin.hub.payments.edit'],
  'payments.register_source_adapter': ['admin.payments.adapters.activate'],
  'payments.accept_participant_binding': ['admin.payments.participant_binding.accept'],
  'payments.activate_account_binding': ['admin.payments.account_binding.review'],
  'sponsored.enable': ['admin.sponsored.policy.edit', 'admin.hub.lifecycle.request'],
  'staff.grant_breakglass': ['admin.staff.breakglass'],
  'support.reset_second_factor': ['admin.support.second_factor.reset'],
  'support.rebind_recovery_email': ['admin.support.recovery.approve'],
  'ops.execute_restore': ['admin.ops.restore.execute'],
  'ops.apply_production_migration': ['admin.ops.updates.apply'],
  'ops.rotate_node_key': ['admin.node.keys.rotate'],
  'kill_switch.release': ['admin.providers.kill', 'admin.agents.kill'],
};

export const REJECT_CODES = [
  'denied', 'elevation_required', 'offline', 'reason_required', 'stale', 'invalid', 'territory_restricted', 'transition_not_allowed', 'gates_open',
  'modes_violation', 'module_requires', 'module_required_by', 'counsel_missing', 'language_missing', 'own_request', 'not_own_request', 'request_void',
  'request_expired', 'digest_mismatch', 'setup_blocked', 'second_factor_required',
  ...PRODUCT_REJECT_CODES,
] as const;
export type RejectCode = (typeof REJECT_CODES)[number];

export type CommandInput = {
  command: CommandId;
  hubSlug: string | null;
  setupToken: string | null;
  reason: string;
  expectedRevision: number | null;
  fields: Readonly<Record<string, string>>;
};

export type CommandOutcome =
  | { status: 'demo_not_saved'; secondPerson: ConsoleSecondPersonAction | null }
  | { status: 'rejected'; code: RejectCode; field: string | null; detail: string[] }
  | { status: 'not_found' };

export type CommandContext = {
  viewer: StaffViewer | null;
  access: ConsoleAccess;
  hub: HubRecord | null;
  now: Date;
  offline: boolean;
  requests: readonly ApprovalRequest[];
  documents: readonly LegalDocument[];
  setup: SetupRun | null;
  isRestricted: RestrictedPredicate;
  /** The hub's agent product, modules, billing and communications (HUBC-005); absent where a caller has none. */
  product?: HubProduct | null;
};

const reject = (code: RejectCode, field: string | null = null, detail: string[] = []): CommandOutcome => ({ status: 'rejected', code, field, detail });
const accepted = (secondPerson: ConsoleSecondPersonAction | null = null): CommandOutcome => ({ status: 'demo_not_saved', secondPerson });
const NOT_FOUND: CommandOutcome = { status: 'not_found' };

/** Parses a territory code typed by staff: `US`, `US-TX` or `US-TX:austin`. */
export function parseTerritory(code: string): HubTerritory | null {
  const value = code.trim();
  const candidate = value.includes(':') ? { level: 'place', code: value, wikidata: null, osmRelation: null } : value.includes('-') ? { level: 'region', code: value } : { level: 'country', code: value };
  const parsed = HubTerritorySchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function holdsAny(access: ConsoleAccess, permissions: readonly ConsolePermission[]): boolean {
  return permissions.some((p) => access.permissions.includes(p));
}

/** Whether the viewer may approve this request now, and if not, why (shown on the approval card). */
export function approvalBlocker(request: ApprovalRequest, viewerId: string, access: ConsoleAccess, now: Date): RejectCode | null {
  if (request.requestedBy === viewerId) return 'own_request';
  if (!holdsAny(access, APPROVER_PERMISSIONS[request.action])) return 'denied';
  if (request.state !== 'pending' || request.currentDigest.value !== request.actionDigest.value) return 'request_void';
  if (Date.parse(request.expiresAt) <= now.getTime()) return 'request_expired';
  return null;
}

function setupCommand(input: CommandInput, ctx: CommandContext): CommandOutcome {
  const run = ctx.setup;
  if (!run || run.state.finishedAt !== null || Date.parse(run.state.setupTokenExpiresAt) <= ctx.now.getTime()) return NOT_FOUND;
  const step = input.fields.step;
  const index = SETUP_STEPS.findIndex((s) => s === step);
  if (index < 0) return reject('invalid', 'step');
  const currentIndex = SETUP_STEPS.indexOf(run.state.current);
  if (index > currentIndex) return reject('setup_blocked', 'step');
  if (step === 'install_check' && run.checks.some((c) => c.state === 'fail')) return reject('setup_blocked', 'step', run.checks.filter((c) => c.state === 'fail').map((c) => c.id));
  const code = (field: string) => (input.fields[field] ?? '').trim().toUpperCase();
  if (step === 'node_identity') {
    const jurisdiction = code('jurisdiction');
    if (!/^[A-Z]{2}$/.test(jurisdiction)) return reject('invalid', 'jurisdiction');
    if (ctx.isRestricted(jurisdiction)) return reject('territory_restricted', 'jurisdiction');
  }
  if (step === 'hub_identity') {
    const territory = parseTerritory(input.fields.territory ?? '');
    if (!territory) return reject('invalid', 'territory');
    if (territoryRestricted(territory, ctx.isRestricted)) return reject('territory_restricted', 'territory');
  }
  if (step === 'first_admin') {
    const factor = input.fields.secondFactor;
    if ((factor !== 'totp' && factor !== 'webauthn') || input.fields.recoveryStored !== 'on') return reject('second_factor_required', 'secondFactor');
  }
  if (step === 'storage_residency') {
    const country = code('residencyCountry');
    if (!/^[A-Z]{2}$/.test(country)) return reject('invalid', 'residencyCountry');
    if (ctx.isRestricted(country)) return reject('territory_restricted', 'residencyCountry');
  }
  if (step === 'review' && SETUP_STEPS.slice(0, -1).some((s) => !run.state.completed.includes(s))) return reject('setup_blocked', 'step');
  return accepted();
}

/** Evaluates one console command for a viewer on a hub. Pure: no clock, no I/O, no randomness beyond the context. */
export function evaluateCommand(input: CommandInput, ctx: CommandContext): CommandOutcome {
  if (input.command === 'setup.save') return setupCommand(input, ctx);
  const { viewer, hub, access } = ctx;
  if (!viewer || !hub) return NOT_FOUND;
  if (access.roles.length === 0) return reject('denied');
  const needed = COMMAND_PERMISSIONS[input.command];
  if (needed !== 'staff' && !holdsAny(access, needed)) return reject('denied');
  if (viewer.elevation.state !== 'elevated') return reject('elevation_required');
  if (ctx.offline) return reject('offline');
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > 500) return reject('reason_required', 'reason');
  const f = input.fields;
  const revisioned = ['identity.save', 'modes.save', 'modules.toggle', 'lifecycle.request'].includes(input.command);
  if (revisioned && input.expectedRevision !== hub.hub.revision) return reject('stale');
  if (isProductCommand(input.command)) return evaluateProductCommand(input.command, f, { viewerId: viewer.person.id, hub, product: ctx.product ?? null, now: ctx.now, isRestricted: ctx.isRestricted });

  switch (input.command) {
    case 'identity.save': {
      const add = (f.addTerritory ?? '').trim();
      if (add) {
        const territory = parseTerritory(add);
        if (!territory) return reject('invalid', 'addTerritory');
        if (territoryRestricted(territory, ctx.isRestricted)) return reject('territory_restricted', 'addTerritory');
      }
      const defaultLocale = f.defaultLocale;
      if (defaultLocale && !hub.hub.locales.includes(defaultLocale)) return reject('invalid', 'defaultLocale');
      return accepted();
    }
    case 'modes.save': {
      const automation = { ...hub.modes.automation };
      for (const domain of AUTOMATION_DOMAINS) {
        const value = f[`automation.${domain}`];
        if (value === undefined) continue;
        if (value !== 'manual' && value !== 'assisted' && value !== 'supervised_autonomous') return reject('invalid', `automation.${domain}`);
        automation[domain] = value;
      }
      const registration = f.registration ?? hub.modes.registration;
      const moderation = f.moderation ?? hub.modes.moderation;
      if (!['closed', 'invite_only', 'open'].includes(registration)) return reject('invalid', 'registration');
      if (!['pre_moderate_all', 'pre_moderate_new_authors', 'post_moderate'].includes(moderation)) return reject('invalid', 'moderation');
      const modes: HubModes = {
        ...hub.modes,
        registration: registration as HubModes['registration'],
        moderation: moderation as HubModes['moderation'],
        searchEngineIndexing: f.searchEngineIndexing === undefined ? hub.modes.searchEngineIndexing : f.searchEngineIndexing === 'on',
        automation,
      };
      const violations = modesViolations(hub.hub.lifecycle, modes);
      if (violations.length) return reject('modes_violation', null, violations);
      const raised = AUTOMATION_DOMAINS.some((d) => automation[d] === 'supervised_autonomous' && hub.modes.automation[d] !== 'supervised_autonomous');
      return accepted(raised ? 'automation.raise_to_supervised_autonomous' : null);
    }
    case 'lifecycle.request': {
      const to = f.to as HubLifecycle;
      if (!(HUB_LIFECYCLE as readonly string[]).includes(to)) return reject('invalid', 'to');
      if (!hubTransitionAllowed(hub.hub.lifecycle, to)) return reject('transition_not_allowed', 'to');
      if (to === 'soft_launch' || to === 'public') {
        const open = blockingGates(to, hub.gates);
        if (open.length) return reject('gates_open', 'to', open);
      }
      const violations = modesViolations(to, hub.modes);
      if (violations.length) return reject('modes_violation', 'to', violations);
      return accepted(to === 'soft_launch' ? 'hub.transition_soft_launch' : to === 'public' ? 'hub.transition_public' : null);
    }
    case 'modules.toggle': {
      const module = f.module as HubModule;
      if (!(HUB_MODULES as readonly string[]).includes(module) || (f.enable !== 'true' && f.enable !== 'false')) return reject('invalid', 'module');
      const enable = f.enable === 'true';
      const current = new Set(hub.modes.modules);
      if (enable) {
        const missing = (MODULE_DEPENDENCIES[module] ?? []).filter((d) => !current.has(d));
        if (missing.length) return reject('module_requires', 'module', missing);
        current.add(module);
      } else {
        const dependents = [...current].filter((m) => (MODULE_DEPENDENCIES[m] ?? []).includes(module));
        if (dependents.length) return reject('module_required_by', 'module', dependents);
        current.delete(module);
      }
      const violations = modesViolations(hub.hub.lifecycle, { ...hub.modes, modules: [...current] });
      if (violations.length) return reject('modes_violation', 'module', violations);
      return accepted();
    }
    case 'legal.draft':
      return (LEGAL_DOCUMENT_KINDS as readonly string[]).includes(f.kind ?? '') ? accepted() : reject('invalid', 'kind');
    case 'legal.request_activation': {
      const doc = ctx.documents.find((d) => d.id === f.documentId && d.hubId === hub.hub.id);
      if (!doc) return NOT_FOUND;
      if (doc.status === 'draft') return reject('counsel_missing', 'documentId');
      if (doc.status !== 'counsel_approved') return reject('invalid', 'documentId');
      const missing = hub.hub.locales.filter((l) => !doc.locales.includes(l));
      if (missing.length) return reject('language_missing', 'documentId', missing);
      return accepted('legal.activate_document_version');
    }
    case 'residency.request_change': {
      const country = (f.country ?? '').trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(country)) return reject('invalid', 'country');
      if (ctx.isRestricted(country)) return reject('territory_restricted', 'country');
      return accepted('hub.change_residency');
    }
    case 'country.add_addition': {
      if (!['identifier', 'register', 'licence_category', 'holiday', 'tax_fact', 'unit'].includes(f.kind ?? '')) return reject('invalid', 'kind');
      if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,60}$/.test(f.key ?? '')) return reject('invalid', 'key');
      if (!(f.label ?? '').trim()) return reject('invalid', 'label');
      return accepted();
    }
    case 'taxonomy.add_term': {
      if (!(TAXONOMY_KINDS as readonly string[]).includes(f.kind ?? '')) return reject('invalid', 'kind');
      if (!/^[a-z0-9][a-z0-9_.-]{0,60}$/.test(f.key ?? '')) return reject('invalid', 'key');
      if (!(f.label ?? '').trim()) return reject('invalid', 'label');
      return accepted();
    }
    case 'launch.mark_passed': {
      const gate = hub.gates.find((g) => g.gate === f.gate);
      if (!gate || !(LAUNCH_GATES as readonly string[]).includes(f.gate ?? '')) return reject('invalid', 'gate');
      if (gate.state === 'passed') return reject('invalid', 'gate');
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test((f.evidence ?? '').trim())) return reject('invalid', 'evidence');
      return accepted();
    }
    case 'approvals.decide': {
      const request = ctx.requests.find((r) => r.id === f.requestId && r.hubId === hub.hub.id);
      if (!request) return NOT_FOUND;
      if (f.decision !== 'approve' && f.decision !== 'decline') return reject('invalid', 'decision');
      const blocker = approvalBlocker(request, viewer.person.id, access, ctx.now);
      if (blocker) return reject(blocker);
      if (f.digest !== request.actionDigest.value) return reject('digest_mismatch');
      return accepted();
    }
    case 'approvals.withdraw': {
      const request = ctx.requests.find((r) => r.id === f.requestId && r.hubId === hub.hub.id);
      if (!request) return NOT_FOUND;
      if (request.requestedBy !== viewer.person.id) return reject('not_own_request');
      if (request.state !== 'pending') return reject('request_void');
      return accepted();
    }
    case 'killswitch.engage': {
      const kind = f.scope;
      if (kind !== 'outbound_messages' && kind !== 'hub_agent_dispatch' && kind !== 'external_agent_api') return reject('invalid', 'scope');
      if (!KillSwitchScopeSchema.safeParse({ kind, hubId: hub.hub.id }).success) return reject('invalid', 'scope');
      if (!holdsAny(access, [kind === 'outbound_messages' ? 'admin.providers.kill' : 'admin.agents.kill'])) return reject('denied');
      return accepted();
    }
  }
}
