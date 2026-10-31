import type { ConsolePermission, HubStaffRole } from '@trustwork/contracts/client';
import { StaffFixtureSchema, type StaffFixture } from '../_data/schemas.js';
import { HUB_SAMARKAND_ID, HUB_US_ID, NODE_ID } from './ids.js';

/**
 * Synthetic staff of the demo node (ADM-002). Invented people ("Synthetic Hub Owner"), role definitions over the
 * merged console vocabulary and scoped assignments (platform, node or hub, ADR 012 decision 1). The role definitions
 * are demo defaults chosen from the permission table in docs/engine/hub-console/README.md; a real node releases its
 * own definitions through ADM-001. Every record is parsed with the frozen contract schemas below.
 */

const RELEASED_AT = '2026-09-30T09:00:00Z';
const GRANTED_AT = '2026-10-01T09:00:00Z';

const person = (id: string, displayName: string) => ({ id, displayName, nameLang: 'en', synthetic: true as const });

export const PEOPLE = [
  person('p-hub-owner', 'Synthetic Hub Owner'),
  person('p-staff-admin', 'Synthetic Staff Admin'),
  person('p-compliance', 'Synthetic Compliance Officer'),
  person('p-editor', 'Synthetic Editor'),
  person('p-data-steward', 'Synthetic Data Steward'),
  person('p-trust', 'Synthetic Trust Reviewer'),
  person('p-support', 'Synthetic Support Lead'),
  person('p-commercial', 'Synthetic Commercial Admin'),
  person('p-ops', 'Synthetic Ops Engineer'),
  person('p-privacy', 'Synthetic Privacy Officer'),
  person('p-auditor', 'Synthetic Auditor'),
  person('p-node-operator', 'Synthetic Node Operator'),
  person('p-participant', 'Synthetic Participant'),
];

const SUPPORT_AGENT: ConsolePermission[] = [
  'admin.support.account.read', 'admin.support.case.create', 'admin.support.case.close', 'admin.support.grant.request', 'admin.support.explain',
  'admin.support.diagnose', 'admin.support.notifications', 'admin.support.sessions.revoke',
];

/** Permissions per role (demo defaults). Every role may request an elevated session. */
const ROLE_PERMISSIONS: Record<HubStaffRole, { scopes: Array<'platform' | 'node' | 'hub'>; permissions: ConsolePermission[] }> = {
  'hub-owner': {
    scopes: ['hub'],
    permissions: [
      'admin.hub.read', 'admin.hub.identity.edit', 'admin.hub.modes.edit', 'admin.hub.lifecycle.request', 'admin.hub.launch.check', 'admin.hub.legal.edit',
      'admin.taxonomy.read', 'admin.staff.read', 'admin.audit.read', 'admin.federation.read', 'admin.trust.method.release', 'admin.agents.read',
      'admin.providers.read', 'admin.pipelines.read', 'admin.publications.read', 'admin.claims.read', 'admin.observability.read',
    ],
  },
  'staff-admin': { scopes: ['platform', 'node', 'hub'], permissions: ['admin.hub.read', 'admin.staff.read', 'admin.staff.assign', 'admin.staff.revoke', 'admin.staff.conflict.declare'] },
  'compliance-officer': {
    scopes: ['node', 'hub'],
    permissions: [
      'admin.hub.read', 'admin.hub.legal.edit', 'admin.hub.legal.activate', 'admin.hub.residency.edit', 'admin.hub.country.edit', 'admin.hub.launch.check',
      'admin.hub.lifecycle.request', 'admin.claims.read', 'admin.claims.policy.edit', 'admin.providers.read', 'admin.providers.egress.edit', 'admin.sources.read',
      'admin.datasets.read', 'admin.federation.read',
    ],
  },
  'editor-in-chief': {
    scopes: ['platform', 'node', 'hub'],
    permissions: [
      'admin.hub.read', 'admin.publications.read', 'admin.publications.review', 'admin.publications.publish', 'admin.publications.correct', 'admin.publications.retract',
      'admin.issues.read', 'admin.issues.curate', 'admin.issues.release', 'admin.issues.correct', 'admin.editorial.items.review', 'admin.editorial.calendar.edit',
      'admin.editorial.automation.edit', 'admin.pipelines.read', 'admin.pipelines.edit', 'admin.sources.read', 'admin.taxonomy.read', 'admin.taxonomy.edit',
      'admin.events.read', 'admin.learning.read',
    ],
  },
  editor: {
    scopes: ['platform', 'node', 'hub'],
    permissions: [
      'admin.publications.read', 'admin.publications.review', 'admin.editorial.items.review', 'admin.issues.read', 'admin.events.read', 'admin.events.review',
      'admin.learning.read', 'admin.learning.review', 'admin.notifications.read', 'admin.taxonomy.read',
    ],
  },
  moderator: {
    scopes: ['platform', 'node', 'hub'],
    permissions: ['admin.moderation.read', 'admin.moderation.case.open', 'admin.moderation.decide', 'admin.moderation.review.confirm', 'admin.publications.hold', 'admin.people.consent.read'],
  },
  'trust-reviewer': {
    scopes: ['platform', 'node', 'hub'],
    permissions: [
      'admin.claims.read', 'admin.claims.decide', 'admin.claims.clarify', 'admin.claims.revoke', 'admin.trust.evidence.decide', 'admin.trust.exclude',
      'admin.trust.appeals.decide', 'admin.credentials.issue', 'admin.credentials.revoke', 'admin.people.consent.read', 'admin.matching.read',
    ],
  },
  'support-agent': { scopes: ['platform', 'node', 'hub'], permissions: SUPPORT_AGENT },
  'support-lead': {
    scopes: ['platform', 'node', 'hub'],
    permissions: [...SUPPORT_AGENT, 'admin.support.grant.approve', 'admin.support.recovery.approve', 'admin.support.second_factor.reset', 'admin.support.recovery.rebind'],
  },
  'commercial-admin': {
    scopes: ['platform', 'node', 'hub'],
    permissions: [
      'admin.hub.read', 'admin.commerce.usage.read', 'admin.commerce.offer.edit', 'admin.commerce.plan.activate', 'admin.commerce.price.draft',
      'admin.commerce.price.activate', 'admin.commerce.credit.issue', 'admin.commerce.refund.policy', 'admin.commerce.flows.read', 'admin.commerce.category_rules.edit',
      'admin.billing.invoices.read', 'admin.billing.payouts.read', 'admin.billing.payouts.release', 'admin.billing.fees.draft', 'admin.billing.fees.activate',
      'admin.agents.read', 'admin.agents.modules.edit', 'admin.marketplace.rules.edit', 'admin.hub.payments.edit',
    ],
  },
  'data-steward': {
    scopes: ['platform', 'node', 'hub'],
    permissions: [
      'admin.hub.read', 'admin.hub.country.edit', 'admin.sources.read', 'admin.sources.manage', 'admin.sources.import.activate', 'admin.sources.dedupe.decide',
      'admin.datasets.read', 'admin.datasets.edit', 'admin.links.decide', 'admin.taxonomy.read', 'admin.taxonomy.edit', 'admin.taxonomy.release', 'admin.units.edit',
      'admin.retrieval.read', 'admin.pipelines.read', 'admin.recommendations.rules.edit',
    ],
  },
  'ops-engineer': {
    scopes: ['node', 'hub'],
    permissions: [
      'admin.hub.read', 'admin.hub.modes.edit', 'admin.config.maintenance', 'admin.observability.read', 'admin.jobs.retry', 'admin.flags.edit',
      'admin.incident.open', 'admin.incident.preserve', 'admin.incident.review', 'admin.providers.read', 'admin.providers.connection.edit',
      'admin.providers.secret.write', 'admin.providers.test', 'admin.providers.toggle', 'admin.providers.budget.edit', 'admin.providers.kill',
      'admin.models.route.edit', 'admin.usage.read', 'admin.pipelines.read', 'admin.pipelines.run', 'admin.pipelines.pause', 'admin.retrieval.read',
      'admin.retrieval.reindex', 'admin.agents.read', 'admin.agents.kill', 'admin.ops.backups.read', 'admin.ops.locales.read', 'admin.notifications.read',
      'admin.assistant.reconcile', 'admin.commerce.flows.read',
    ],
  },
  'privacy-officer': {
    scopes: ['platform', 'node', 'hub'],
    permissions: ['admin.privacy.request.read', 'admin.privacy.export', 'admin.privacy.hold', 'admin.privacy.retention.edit', 'admin.privacy.erasure.execute', 'admin.people.consent.read'],
  },
  auditor: { scopes: ['platform', 'node', 'hub'], permissions: ['admin.audit.read', 'admin.audit.export', 'admin.audit.verify', 'admin.staff.read'] },
  'node-operator': {
    scopes: ['node'],
    permissions: [
      'admin.hub.read', 'admin.node.hubs.manage', 'admin.node.keys.rotate', 'admin.ops.backups.read', 'admin.ops.restore.drill', 'admin.ops.restore.execute',
      'admin.ops.updates.apply', 'admin.observability.read', 'admin.staff.read', 'admin.staff.assign', 'admin.providers.read', 'admin.audit.read',
    ],
  },
  'platform-owner': {
    scopes: ['platform'],
    permissions: ['admin.hub.read', 'admin.staff.read', 'admin.staff.assign', 'admin.staff.revoke', 'admin.staff.breakglass', 'admin.audit.read', 'admin.config.edit'],
  },
};

const definitions = (Object.entries(ROLE_PERMISSIONS) as Array<[HubStaffRole, (typeof ROLE_PERMISSIONS)[HubStaffRole]]>).map(([role, { scopes, permissions }]) => ({
  version: 1,
  role,
  scopes,
  permissions: [...permissions, 'admin.session.elevate' as const],
  caps: { creditCapMinorUnits: null, grantMaxHours: 72 },
  sodConflicts: [],
  sodMode: 'full' as const,
  releasedAt: RELEASED_AT,
  releasedBy: 'p-node-operator',
}));

type Scope = { kind: 'platform' } | { kind: 'node'; nodeId: string } | { kind: 'hub'; hubId: string };
const hub = (hubId: string): Scope => ({ kind: 'hub', hubId });
const node: Scope = { kind: 'node', nodeId: NODE_ID };
const platform: Scope = { kind: 'platform' };

function assignment(id: string, personId: string, role: HubStaffRole, scope: Scope, grantedBy: string, approvedBy: string | null, revoked?: { at: string; by: string }) {
  return {
    id,
    personId,
    role,
    scope,
    definitionVersion: 1,
    grantedBy,
    approvedBy,
    reason: 'Synthetic demo staff for the hub console fixtures',
    breakglass: false,
    incidentRef: null,
    validFrom: GRANTED_AT,
    validUntil: null,
    revokedAt: revoked?.at ?? null,
    revokedBy: revoked?.by ?? null,
  };
}

const us = hub(HUB_US_ID);
const samarkand = hub(HUB_SAMARKAND_ID);

export const STAFF: StaffFixture = StaffFixtureSchema.parse({
  synthetic: true,
  people: PEOPLE,
  definitions,
  assignments: [
    assignment('a-hub-owner-us', 'p-hub-owner', 'hub-owner', us, 'p-node-operator', 'p-staff-admin'),
    assignment('a-staff-admin-us', 'p-staff-admin', 'staff-admin', us, 'p-hub-owner', 'p-node-operator'),
    assignment('a-compliance-us', 'p-compliance', 'compliance-officer', us, 'p-staff-admin', 'p-hub-owner'),
    assignment('a-eic-us', 'p-editor', 'editor-in-chief', us, 'p-staff-admin', null),
    assignment('a-editor-samarkand', 'p-editor', 'editor', samarkand, 'p-node-operator', null),
    assignment('a-steward-us', 'p-data-steward', 'data-steward', us, 'p-staff-admin', null),
    assignment('a-trust-us', 'p-trust', 'trust-reviewer', us, 'p-staff-admin', null),
    assignment('a-moderator-us', 'p-trust', 'moderator', us, 'p-staff-admin', null),
    assignment('a-support-lead-us', 'p-support', 'support-lead', us, 'p-staff-admin', null),
    assignment('a-support-agent-samarkand', 'p-support', 'support-agent', samarkand, 'p-node-operator', null),
    assignment('a-commercial-us', 'p-commercial', 'commercial-admin', us, 'p-staff-admin', 'p-hub-owner'),
    assignment('a-ops-node', 'p-ops', 'ops-engineer', node, 'p-node-operator', null),
    assignment('a-privacy-us', 'p-privacy', 'privacy-officer', us, 'p-staff-admin', 'p-hub-owner'),
    assignment('a-auditor-platform', 'p-auditor', 'auditor', platform, 'p-node-operator', null),
    assignment('a-node-operator', 'p-node-operator', 'node-operator', node, 'p-hub-owner', 'p-staff-admin'),
    assignment('a-platform-owner', 'p-node-operator', 'platform-owner', platform, 'p-staff-admin', 'p-hub-owner'),
    // The participant once held an editor role; it was revoked, so they hold no active staff role today.
    assignment('a-editor-revoked', 'p-participant', 'editor', us, 'p-staff-admin', null, { at: '2026-10-20T09:00:00Z', by: 'p-staff-admin' }),
  ],
});

/**
 * Demo staff personas (`?persona=` on `/admin`, demo mode only). Together they hold every console role; `staff-none`
 * is a signed-in participant without an active staff role and sees the denied state on every console route.
 */
export const STAFF_PERSONAS = {
  'hub-owner': 'p-hub-owner',
  'staff-admin': 'p-staff-admin',
  compliance: 'p-compliance',
  editor: 'p-editor',
  'data-steward': 'p-data-steward',
  'trust-reviewer': 'p-trust',
  support: 'p-support',
  commercial: 'p-commercial',
  ops: 'p-ops',
  privacy: 'p-privacy',
  auditor: 'p-auditor',
  'node-operator': 'p-node-operator',
  'staff-none': 'p-participant',
} as const;
