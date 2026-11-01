import { computeDigest, UsageAggregateSchema } from '../../deps/contracts.js';
import {
  CapViewSchema, connectionEnableDigestInput, ConnectionViewSchema, EgressRuleRecordSchema, ModelPricingRecordSchema, ProviderConfigChangeSchema, ProviderKillSwitchViewSchema,
  ProviderSecretVersionSchema, routeActivationDigestInput, routeNeedsSecondPerson, ScopedModelRouteSchema,
  type ConnectionTestRow, type EgressRuleRow, type HostingInput, type KillSwitchRow, type ModelPricingRow, type ModelRouteRow, type ProviderBudgetRow, type ProviderConfigChangeRow,
  type ProviderConnectionRow, type ProviderRouteKillSwitchRow, type RouteScope, type SecretRefRow, type UsageAggregateRow,
} from './deps.js';

/**
 * Row-to-view serializers (camelCase, ISO timestamps). Every view is parsed against its contract schema before it
 * leaves; a secret appears only as its reference and keyed fingerprint (`SecretRefSchema`), never as a value or
 * ciphertext, which no row read here contains.
 */
const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const req = (d: Date): string => new Date(d).toISOString();
const decimal = (v: string | null): string | null => (v === null ? null : v.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''));

export function hostingOf(c: ProviderConnectionRow): HostingInput {
  return c.hosting_kind === 'vendor'
    ? { kind: 'vendor', country: c.processing_country, zeroRetention: Boolean(c.zero_retention), trainsOnInputs: Boolean(c.trains_on_inputs), broker: Boolean(c.broker) }
    : { kind: 'self_hosted', country: c.processing_country };
}

export function toSecretVersion(r: SecretRefRow) {
  return ProviderSecretVersionSchema.parse({
    ref: { id: r.id, store: r.store, ref: r.ref, keyedFingerprint: r.keyed_fingerprint, version: r.version, createdAt: req(r.created_at), createdBy: r.created_by, rotatedAt: iso(r.rotated_at), lastUsedAt: iso(r.last_used_at) },
    status: r.status, graceUntil: iso(r.grace_until), destroyedAt: iso(r.destroyed_at),
  });
}

export function toTest(t: ConnectionTestRow) {
  return {
    at: req(t.tested_at), by: t.tested_by, outcome: t.outcome as 'ok', latencyMs: t.latency_ms, modelsListed: t.models_listed,
    cost: t.cost_minor === null || t.cost_currency === null ? null : { minorUnits: String(t.cost_minor), currency: t.cost_currency }, syntheticInputOnly: true as const,
  };
}

export interface ConnectionFacts { in_residency: boolean; kill_switch_id: string | null }
export function toConnection(c: ProviderConnectionRow, secrets: SecretRefRow[], lastTest: ConnectionTestRow | null, facts: ConnectionFacts | undefined) {
  const versions = secrets.filter((s) => s.connection_id === c.id).sort((a, b) => b.version - a.version);
  const active = versions.find((s) => s.status === 'active') ?? null;
  const killed = facts?.kill_switch_id ?? null;
  const view = ConnectionViewSchema.parse({
    id: c.id, hubId: c.hub_id, adapterId: c.adapter_id, label: c.label, capabilities: c.capabilities, mode: c.mode, endpoint: c.endpoint, hosting: hostingOf(c),
    storageCountry: c.storage_country, region: c.region, inHubResidency: facts?.in_residency ?? false, status: killed ? 'killed' : c.status,
    secret: { source: c.mode === 'fake' ? 'none' : c.credential_ref_id ? 'credential_ref' : versions.length ? 'envelope' : 'none', versions: versions.map(toSecretVersion), credentialRefId: c.credential_ref_id },
    lastTest: lastTest ? toTest(lastTest) : null, enabledBy: c.enabled_by, enabledAt: iso(c.enabled_at), approvalId: c.approval_id, killSwitchId: killed, revision: c.revision,
    createdAt: req(c.created_at),
  });
  /** What a second person approves before a non-fake connection is enabled (null when it cannot or need not be asked). */
  const enable = c.mode !== 'fake' && c.status !== 'enabled' && lastTest?.outcome === 'ok' && c.last_test_id
    ? {
        secondPersonAction: 'providers.enable_non_fake' as const,
        actionDigest: computeDigest(connectionEnableDigestInput({
          id: c.id, hubId: c.hub_id, adapterId: c.adapter_id, mode: c.mode, endpoint: c.endpoint, hosting: hostingOf(c), storageCountry: c.storage_country,
          secretFingerprint: active?.keyed_fingerprint ?? null, credentialRefId: c.credential_ref_id, testId: c.last_test_id, revision: c.revision,
        })).value,
      }
    : null;
  return { ...view, enable };
}

export function scopeOf(r: { scope_kind: string; module_key: string | null; extension_id: string | null }): RouteScope {
  return r.scope_kind === 'module' ? { kind: 'module', moduleKey: r.module_key as string } : r.scope_kind === 'extension' ? { kind: 'extension', extensionId: r.extension_id as string } : { kind: 'job' };
}
export function routeLimits(r: ModelRouteRow) {
  return { maxInputTokens: r.max_input_tokens, maxOutputTokens: r.max_output_tokens, maxFileBytes: r.max_file_bytes === null ? null : Number(r.max_file_bytes), timeoutMs: r.timeout_ms };
}
export function routeDigestInput(r: ModelRouteRow) {
  return routeActivationDigestInput({
    id: r.id, hubId: r.hub_id, job: r.job, scope: scopeOf(r), version: r.version, primary: r.primary_ref, fallbacks: r.fallbacks, allowedDataClasses: r.allowed_data_classes,
    limits: routeLimits(r), budgetId: r.budget_id,
  });
}
export function toRoute(r: ModelRouteRow, killSwitchId: string | null) {
  const view = ScopedModelRouteSchema.parse({
    id: r.id, hubId: r.hub_id, version: r.version, job: r.job, scope: scopeOf(r), primary: r.primary_ref, fallbacks: r.fallbacks, allowedDataClasses: r.allowed_data_classes,
    limits: routeLimits(r), budgetId: r.budget_id, status: r.status, reason: r.reason, draftedBy: r.drafted_by, draftedAt: req(r.drafted_at), activatedBy: r.activated_by,
    activatedAt: iso(r.activated_at), approvalId: r.approval_id, killSwitchId, revision: r.revision,
  });
  const activation = r.status === 'draft' && routeNeedsSecondPerson({ allowedDataClasses: view.allowedDataClasses })
    ? { secondPersonAction: 'models.activate_private_route' as const, actionDigest: computeDigest(routeDigestInput(r)).value }
    : null;
  return { ...view, activation };
}

export function toEgress(e: EgressRuleRow) {
  return EgressRuleRecordSchema.parse({
    id: e.id, hubId: e.hub_id, connectionId: e.connection_id, dataClass: e.data_class, decision: e.decision, requireInResidency: e.require_in_residency,
    requireZeroRetention: e.require_zero_retention, version: e.version, approvalId: e.approval_id, reason: e.reason, createdBy: e.created_by, createdAt: req(e.created_at),
  });
}

export function capScope(b: ProviderBudgetRow) {
  switch (b.scope_kind) {
    case 'job': return { kind: 'job' as const, job: b.job as never };
    case 'pipeline': return { kind: 'pipeline' as const, pipelineId: b.pipeline_id as string };
    case 'agent_module': return { kind: 'agent_module' as const, moduleKey: b.module_key as string };
    case 'connection': return { kind: 'connection' as const, connectionId: b.connection_id as string };
    default: return { kind: 'hub' as const };
  }
}
export function toCap(b: ProviderBudgetRow, usage: { period_start: Date; spent: string; reserved: string } | undefined) {
  const limit = BigInt(b.limit_minor);
  const spent = BigInt(usage?.spent ?? '0');
  const reserved = BigInt(usage?.reserved ?? '0');
  const used = spent + reserved;
  const percent = limit === 0n ? 100n : (used * 100n) / limit;
  const state = used >= limit ? 'exhausted' : b.alert_at_percent.some((p) => percent >= BigInt(p)) ? 'alert' : 'ok';
  return CapViewSchema.parse({
    budget: { id: b.id, hubId: b.hub_id, scope: capScope(b), period: b.period, limit: { minorUnits: String(b.limit_minor), currency: b.currency }, alertAtPercent: b.alert_at_percent,
      onExhausted: b.on_exhausted, revision: b.revision },
    status: b.status, periodStart: req(usage?.period_start ?? new Date()), spent: { minorUnits: spent.toString(), currency: b.currency },
    reserved: { minorUnits: reserved.toString(), currency: b.currency }, state,
  });
}

export function toPricing(p: ModelPricingRow) {
  return ModelPricingRecordSchema.parse({
    id: p.id, hubId: p.hub_id, version: p.version, connectionId: p.connection_id, modelId: p.model_id, currency: p.currency,
    inputPerMillionTokens: decimal(p.input_per_million_tokens), outputPerMillionTokens: decimal(p.output_per_million_tokens), perImage: decimal(p.per_image),
    perAudioMinute: decimal(p.per_audio_minute), basis: p.basis, observedAt: req(p.observed_at), sourceNote: p.source_note, recordedBy: p.recorded_by, recordedAt: req(p.recorded_at),
  });
}

export function toConnectionKill(k: KillSwitchRow) {
  return ProviderKillSwitchViewSchema.parse({
    id: k.id, hubId: k.hub_id, target: { kind: 'connection', connectionId: k.connection_id }, state: k.state, engagedBy: k.engaged_by, engagedAt: req(k.engaged_at), reason: k.reason,
    releasedBy: k.released_by, releasedAt: iso(k.released_at), releaseApprovalId: k.release_approval_id, incidentNote: k.incident_note,
  });
}
export function toRouteKill(k: ProviderRouteKillSwitchRow) {
  return ProviderKillSwitchViewSchema.parse({
    id: k.id, hubId: k.hub_id, target: { kind: 'route', job: k.job, scope: scopeOf(k) }, state: k.state, engagedBy: k.engaged_by, engagedAt: req(k.engaged_at), reason: k.reason,
    releasedBy: k.released_by, releasedAt: iso(k.released_at), releaseApprovalId: k.release_approval_id, incidentNote: k.incident_note,
  });
}

export function toChange(c: ProviderConfigChangeRow) {
  return ProviderConfigChangeSchema.parse({
    id: c.id, hubId: c.hub_id, objectType: c.object_type, objectId: c.object_id, action: c.action, actorPersonId: c.actor_person_id, reason: c.reason,
    before: c.before, after: c.after, approvalId: c.approval_id, occurredAt: req(c.occurred_at),
  });
}

export function toUsage(hubId: string, r: UsageAggregateRow) {
  const from = new Date(r.day);
  return UsageAggregateSchema.parse({
    hubId, from: from.toISOString(), to: new Date(from.getTime() + 86_400_000).toISOString(), job: r.job, connectionId: r.connection_id, modelId: r.model_id, pipelineId: r.pipeline_id,
    moduleKey: r.module_key, calls: r.calls, inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens), images: Number(r.images), audioSeconds: Number(r.audio_seconds),
    cost: { minorUnits: r.cost_minor, currency: r.currency },
  });
}
