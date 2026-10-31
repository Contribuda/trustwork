import { HUB_LIFECYCLE, LAUNCH_GATES, type LaunchGateId } from '@trustwork/contracts/client';
import { ConsoleNodeSchema, HubRecordSchema, OverviewSchema, type ConsoleNode, type HubRecord, type Overview } from '../_data/schemas.js';
import { HUB_SAMARKAND_ID, HUB_US_ID, NODE_ID } from './ids.js';

/**
 * The two example hubs of docs/engine/hub-console/README.md on one synthetic demo node (ADM-002):
 * - the United States reference hub (ADR 012 decisions 26 to 31): English and Spanish, USD, home territory San Diego,
 *   California, country pack US, demo data only, lifecycle `preparing`;
 * - a Samarkand city hub in Uzbekistan as the non-US example: Uzbek (Latin) and Russian, UZS, in-country residency,
 *   lifecycle `draft`, reduced separation of duties.
 * Names end in "(demo)" or "(example)"; domains are `.invalid`; nothing here describes a real organisation.
 */

export const NODE: ConsoleNode = ConsoleNodeSchema.parse({ id: NODE_ID, name: 'Trustwork demo node', domain: 'node.example.invalid', engineVersion: '0.1.0', synthetic: true });

const digest = (seed: string) => ({ algorithm: 'trustwork-digest-1' as const, value: seed.repeat(64 / seed.length) });

function gates(hubId: string, passed: Partial<Record<LaunchGateId, { by: string; at: string; evidence: string }>>, invalidated: Partial<Record<LaunchGateId, { by: string; at: string; evidence: string; when: string; why: string }>> = {}) {
  return LAUNCH_GATES.map((gate) => {
    const pass = passed[gate];
    const inval = invalidated[gate];
    if (inval) return { hubId, gate, state: 'invalidated' as const, evidenceRef: inval.evidence, checkedBy: inval.by, checkedAt: inval.at, invalidatedAt: inval.when, invalidationReason: inval.why };
    if (pass) return { hubId, gate, state: 'passed' as const, evidenceRef: pass.evidence, checkedBy: pass.by, checkedAt: pass.at, invalidatedAt: null, invalidationReason: null };
    return { hubId, gate, state: 'open' as const, evidenceRef: null, checkedBy: null, checkedAt: null, invalidatedAt: null, invalidationReason: null };
  });
}

const allManual = { editorial: 'manual', translation: 'manual', magazine_assembly: 'manual', data_mining: 'manual', entity_resolution: 'manual', verification_rechecks: 'manual', moderation_triage: 'manual' } as const;
const DEFAULT_MODULES = ['publications', 'magazine', 'events', 'search', 'communications'] as const;

const US: HubRecord = HubRecordSchema.parse({
  synthetic: true,
  example: 'us_reference',
  hub: {
    id: HUB_US_ID,
    nodeId: NODE_ID,
    slug: 'us-demo',
    name: { en: 'Trustwork United States (demo)', es: 'Trustwork Estados Unidos (demo)' },
    lifecycle: 'preparing',
    territories: [
      { level: 'country', code: 'US' },
      { level: 'region', code: 'US-CA' },
      { level: 'place', code: 'US-CA:san-diego', wikidata: null, osmRelation: null },
    ],
    countryPack: { code: 'US', version: '2' },
    defaultLocale: 'en',
    locales: ['en', 'es'],
    timeZone: 'America/Los_Angeles',
    currency: 'USD',
    brandOverlay: null,
    revision: 7,
  },
  modes: {
    dataMode: 'demo',
    registration: 'closed',
    modules: [...DEFAULT_MODULES, 'project_planner'],
    moderation: 'pre_moderate_new_authors',
    automation: { ...allManual, editorial: 'assisted', translation: 'assisted' },
    searchEngineIndexing: false,
    maintenance: false,
  },
  domain: 'us-demo.example.invalid',
  sodMode: 'full',
  gates: gates(
    HUB_US_ID,
    {
      data_residency_configured: { by: 'p-compliance', at: '2026-10-12T15:00:00Z', evidence: 'ev-residency-v1' },
      information_source_registered: { by: 'p-data-steward', at: '2026-10-18T10:30:00Z', evidence: 'ev-source-registry-1' },
      brand_accessibility_checked: { by: 'p-hub-owner', at: '2026-10-20T08:00:00Z', evidence: 'ev-contrast-report-1' },
      two_staff_with_second_factor: { by: 'p-staff-admin', at: '2026-10-02T09:00:00Z', evidence: 'ev-staff-list-1' },
    },
    {
      legal_documents_counsel_approved: {
        by: 'p-compliance',
        at: '2026-10-15T12:00:00Z',
        evidence: 'ev-counsel-letter-1',
        when: '2026-10-28T09:00:00Z',
        why: 'Privacy notice version 2 replaced the version counsel approved',
      },
    },
  ),
  configVersions: [
    { id: 'cv-us-identity-3', hubId: HUB_US_ID, domain: 'identity', version: 3, payloadDigest: digest('a1'), status: 'active', reason: 'Home territory San Diego, California', draftedBy: 'p-hub-owner', activatedBy: 'p-hub-owner', activatedAt: '2026-10-10T09:00:00Z', approvalId: null, effectiveFrom: '2026-10-10T09:00:00Z' },
    { id: 'cv-us-modes-2', hubId: HUB_US_ID, domain: 'modes', version: 2, payloadDigest: digest('b2'), status: 'active', reason: 'Assisted editorial and translation', draftedBy: 'p-ops', activatedBy: 'p-hub-owner', activatedAt: '2026-10-14T09:00:00Z', approvalId: null, effectiveFrom: '2026-10-14T09:00:00Z' },
    { id: 'cv-us-residency-1', hubId: HUB_US_ID, domain: 'residency', version: 1, payloadDigest: digest('c3'), status: 'active', reason: 'United States residency, state privacy regime', draftedBy: 'p-compliance', activatedBy: 'p-hub-owner', activatedAt: '2026-10-12T15:00:00Z', approvalId: 'ap-us-residency-1', effectiveFrom: '2026-10-12T15:00:00Z' },
    { id: 'cv-us-legal-2', hubId: HUB_US_ID, domain: 'legal', version: 2, payloadDigest: digest('d4'), status: 'draft', reason: 'Privacy notice version 2 with the Spanish edition', draftedBy: 'p-compliance', activatedBy: null, activatedAt: null, approvalId: null, effectiveFrom: null },
  ],
  budgets: [
    {
      budget: { id: 'bg-us-hub-month', hubId: HUB_US_ID, scope: { kind: 'hub' }, period: 'month', limit: { minorUnits: '20000', currency: 'USD' }, alertAtPercent: [50, 80], onExhausted: 'deny_new', revision: 2 },
      spentMinorUnits: '4210',
    },
    {
      budget: { id: 'bg-us-translation-day', hubId: HUB_US_ID, scope: { kind: 'job', job: 'translation' }, period: 'day', limit: { minorUnits: '1000', currency: 'USD' }, alertAtPercent: [80], onExhausted: 'pause', revision: 1 },
      spentMinorUnits: '860',
    },
  ],
  killSwitches: [],
  updatedAt: '2026-10-31T11:45:00Z',
});

const SAMARKAND: HubRecord = HubRecordSchema.parse({
  synthetic: true,
  example: 'samarkand_example',
  hub: {
    id: HUB_SAMARKAND_ID,
    nodeId: NODE_ID,
    slug: 'samarkand',
    name: { 'uz-Latn': 'Trustwork Samarqand (namuna)', ru: 'Trustwork Самарканд (пример)' },
    lifecycle: 'draft',
    territories: [{ level: 'place', code: 'UZ-SA:samarkand', wikidata: null, osmRelation: null }],
    countryPack: { code: 'UZ', version: '1' },
    defaultLocale: 'uz-Latn',
    locales: ['uz-Latn', 'ru'],
    timeZone: 'Asia/Samarkand',
    currency: 'UZS',
    brandOverlay: null,
    revision: 2,
  },
  modes: { dataMode: 'demo', registration: 'closed', modules: [...DEFAULT_MODULES], moderation: 'pre_moderate_new_authors', automation: allManual, searchEngineIndexing: false, maintenance: false },
  domain: 'samarkand.example.invalid',
  sodMode: 'reduced',
  gates: gates(HUB_SAMARKAND_ID, {}),
  configVersions: [
    { id: 'cv-sam-identity-1', hubId: HUB_SAMARKAND_ID, domain: 'identity', version: 1, payloadDigest: digest('e5'), status: 'active', reason: 'Samarkand city hub from the UZ pack', draftedBy: 'p-node-operator', activatedBy: 'p-node-operator', activatedAt: '2026-10-25T07:00:00Z', approvalId: null, effectiveFrom: '2026-10-25T07:00:00Z' },
  ],
  budgets: [],
  killSwitches: [],
  updatedAt: '2026-10-31T10:00:00Z',
});

export const HUBS: readonly HubRecord[] = [US, SAMARKAND];

/** The engaged kill switch the demo scenario `kill-switch-engaged` adds to a hub. */
export function engagedOutboundSwitch(hubId: string) {
  return { id: `ks-${hubId}-outbound`, scope: { kind: 'outbound_messages' as const, hubId }, state: 'engaged' as const, engagedBy: 'p-ops', engagedAt: '2026-10-31T11:30:00Z', reason: 'Synthetic incident drill: outbound messages paused', releasedBy: null, releasedAt: null, releaseApprovalId: null, incidentNote: null };
}

export const OVERVIEWS: readonly Overview[] = [
  OverviewSchema.parse({
    synthetic: true,
    hubId: HUB_US_ID,
    queues: [
      { id: 'claims', count: 3, nearestDeadline: null },
      { id: 'review_items', count: 5, nearestDeadline: null },
      { id: 'link_proposals', count: 2, nearestDeadline: null },
      { id: 'reports', count: 1, nearestDeadline: null },
      { id: 'support_cases', count: 4, nearestDeadline: null },
      { id: 'grant_requests', count: 1, nearestDeadline: null },
      { id: 'privacy_requests', count: 2, nearestDeadline: '2026-11-28T17:00:00Z' },
      { id: 'unknown_outcomes', count: 0, nearestDeadline: null },
      { id: 'alerts', count: 1, nearestDeadline: null },
    ],
    compliance: { legalDocumentsDue: 1, screeningListAgeDays: 3, expiringSourceLicences: 1, fakeProviders: ['llm', 'email', 'sms', 'payments', 'e_signature', 'register_lookup', 'tax_calculation'] },
    health: [
      { id: 'readiness', state: 'ok', value: null },
      { id: 'outbox_age', state: 'ok', value: 1 },
      { id: 'dead_letters', state: 'warning', value: 2 },
      { id: 'unknown_outcomes', state: 'ok', value: 0 },
      { id: 'backup_age', state: 'unknown', value: null },
    ],
    updatedAt: '2026-10-31T11:45:00Z',
  }),
  OverviewSchema.parse({
    synthetic: true,
    hubId: HUB_SAMARKAND_ID,
    queues: [],
    compliance: { legalDocumentsDue: 0, screeningListAgeDays: null, expiringSourceLicences: 0, fakeProviders: ['llm', 'email', 'sms', 'payments', 'register_lookup'] },
    health: [
      { id: 'readiness', state: 'ok', value: null },
      { id: 'outbox_age', state: 'ok', value: 0 },
      { id: 'dead_letters', state: 'ok', value: 0 },
      { id: 'unknown_outcomes', state: 'ok', value: 0 },
      { id: 'backup_age', state: 'unknown', value: null },
    ],
    updatedAt: '2026-10-31T10:00:00Z',
  }),
];

/** Lifecycle stages in order, for the modes screen. */
export const LIFECYCLE_ORDER = HUB_LIFECYCLE;
