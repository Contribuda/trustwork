import { withMaintenance, type DataPool, type Transaction } from '@trustwork/data';
import { staffRoleDefinitions, type CommandContext } from '../../packages/data/src/repositories/admin.js';
import { sources, type RegisterSourceInput } from '../../packages/data/src/repositories/sources.js';
import type { SourceRow } from '../../packages/data/src/schema/sources.js';
import type { DatasetRecordInput, ProposeDatasetInput } from '../../packages/data/src/repositories/datasets.js';
import { MOST_RESTRICTIVE_USES } from '../../packages/contracts/src/sources.js';
import { actors, buildAdminWorld } from '../data/admin/helpers.js';

/**
 * Synthetic world for the MINE-001 suites on DATA-002's administration world. Every person, company, source, record
 * and identifier is synthetic; URLs use the reserved `.invalid` domain. Role definitions are test definitions over the
 * real console vocabulary, not a released capability map.
 *
 * - hubOwner, lead2: `data-steward` at the hub (sources, datasets, activation; second person for each other)
 * - agent: `trust-reviewer` at the hub (reads datasets through admin.links.decide, changes nothing)
 * - otherAgent: `data-steward` at the other hub; outsider: no rights at all
 */
export async function datasetsWorld(admin: DataPool, runtime: DataPool) {
  const w = await buildAdminWorld(admin);
  const a = actors(admin, runtime, w);
  await withMaintenance(admin, async (trx) => {
    await staffRoleDefinitions.release(trx, { version: 1, role: 'data-steward', scopes: ['hub'],
      permissions: ['admin.sources.read', 'admin.sources.manage', 'admin.datasets.read', 'admin.datasets.edit', 'admin.datasets.activate', 'admin.links.decide'],
      caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    await staffRoleDefinitions.release(trx, { version: 1, role: 'trust-reviewer', scopes: ['hub'], permissions: ['admin.links.decide'],
      caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
  });
  const hub = { kind: 'hub', hubId: w.hubId } as const;
  await a.assign({ personId: w.people.hubOwner, role: 'data-steward', scope: hub });
  await a.assign({ personId: w.people.lead2, role: 'data-steward', scope: hub });
  await a.assign({ personId: w.people.agent, role: 'trust-reviewer', scope: hub });
  await a.assign({ personId: w.people.otherAgent, role: 'data-steward', scope: { kind: 'hub', hubId: w.otherHubId } });
  const cmd = async <T>(person: string, fn: (trx: Transaction, ctx: CommandContext) => Promise<T>): Promise<T> => {
    const ctx = await a.elevate(person);
    return a.as(person, (trx) => fn(trx, ctx));
  };
  const activeSource = async (over: Partial<RegisterSourceInput> = {}): Promise<SourceRow> => {
    const s = await cmd(w.people.hubOwner, (trx, ctx) => sources.register(trx, ctx, w.hubId, sourceInput(w.people.hubOwner, over)));
    return cmd(w.people.lead2, (trx, ctx) => sources.setStatus(trx, ctx, s.id, s.revision, 'active'));
  };
  return { w, ...a, hub, cmd, activeSource };
}

export function sourceInput(owner: string, over: Partial<RegisterSourceInput> = {}): RegisterSourceInput {
  return {
    kind: 'register_open_data', name: 'Synthetic Business Register', url: 'https://register.synthetic-state.invalid/data', ownerPersonId: owner, readerKind: 'official_register',
    purposes: ['company_directory', 'verification_evidence'], licence: { kind: 'statutory_public', name: null, url: null, agreementRef: null },
    allowedUses: { ...MOST_RESTRICTIVE_USES, displayHeadlineAndLink: true, displaySummary: true, indexForSearch: true }, attributionTemplate: 'Source: Synthetic Business Register',
    takedownContact: 'records@synthetic-state.invalid', personalData: false, legalBasis: 'statutory_public_register', ...over,
  };
}

export function datasetInput(sourceIds: string[], over: Partial<ProposeDatasetInput> = {}): ProposeDatasetInput {
  return {
    subject: 'companies', name: 'Synthetic active contractors', sourceIds, purpose: 'Companies registered in the state, for the directory and claim checks.',
    legalBasis: 'statutory_public_register', personalData: { present: false, naturalPersons: false, categories: [] }, impactAssessmentRef: null,
    retention: { className: 'register_mirror', days: 365 }, outputs: ['directory_sourced_records', 'verification_evidence'], publicDisplay: true, subjectNotice: false,
    refreshScheduleId: null, ...over,
  };
}

export function record(sourceId: string, key: string, over: Partial<DatasetRecordInput> = {}): DatasetRecordInput {
  return {
    sourceId, externalKey: key, identifierKind: 'US-CA-SOS', identifierValue: key.replace(/\D/g, '') || '1', naturalPerson: false,
    fields: { legalName: `Synthetic Builders ${key}`, status: 'active', website: `https://${key.toLowerCase()}.synthetic-builders.invalid/` },
    sourceUrl: `https://register.synthetic-state.invalid/entity/${key}`, ...over,
  };
}
