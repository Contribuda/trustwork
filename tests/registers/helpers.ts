import { withMaintenance, type DataPool, type Transaction } from '@trustwork/data';
import { staffRoleDefinitions, type CommandContext } from '../../packages/data/src/repositories/admin.js';
import { sources } from '../../packages/data/src/repositories/sources.js';
import type { SourceRow } from '../../packages/data/src/schema/sources.js';
import type { RegisterSourceInput } from '../../packages/data/src/repositories/sources.js';
import { ALL_USES, MOST_RESTRICTIVE_USES } from '../../packages/contracts/src/sources.js';
import { actors, buildAdminWorld } from '../data/admin/helpers.js';

/**
 * Synthetic world for the REG-001 suites on DATA-002's administration world. Every person, company, source and
 * identifier is synthetic; register links point to the reserved `.invalid` domain. Role definitions are test
 * definitions over the real console vocabulary, not a released capability map.
 *
 * - hubOwner, lead2: `data-steward` at the hub (sources, links and live-mode approvals; second person for each other)
 * - agent: `trust-reviewer` at the hub (reads facts through a claims permission, changes nothing)
 * - otherAgent: `data-steward` at the other hub (every registers permission, but elsewhere)
 * - employee: administrator of the world's company; outsider: no rights at all
 */
export async function registersWorld(admin: DataPool, runtime: DataPool) {
  const w = await buildAdminWorld(admin);
  const a = actors(admin, runtime, w);
  await withMaintenance(admin, async (trx) => {
    await staffRoleDefinitions.release(trx, { version: 1, role: 'data-steward', scopes: ['hub'],
      permissions: ['admin.sources.read', 'admin.sources.manage', 'admin.sources.takedown', 'admin.sources.dedupe.decide', 'admin.providers.toggle'],
      caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    await staffRoleDefinitions.release(trx, { version: 1, role: 'trust-reviewer', scopes: ['hub'], permissions: ['admin.claims.read', 'admin.claims.decide'],
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
  /** Registers (hubOwner) and activates (lead2) a source; an official register with display allowed by default. */
  const activeSource = async (over: Partial<RegisterSourceInput> = {}, hubId = w.hubId, by = [w.people.hubOwner, w.people.lead2] as const): Promise<SourceRow> => {
    const s = await cmd(by[0], (trx, ctx) => sources.register(trx, ctx, hubId, registerSource(by[0], over)));
    return cmd(by[1], (trx, ctx) => sources.setStatus(trx, ctx, s.id, s.revision, 'active'));
  };
  /** A synthetic company with legal identifiers (kind and value) and optional administrators. */
  const company = (name: string, identifiers: Array<{ kind: string; value: string }>, claim: 'unclaimed' | 'claimed' | 'verified' = 'claimed', administrators: string[] = []) =>
    withMaintenance(admin, async (trx) => {
      const id = (await trx.insertInto('company').values({ display_name: name, claim_status: claim,
        legal_identifiers: JSON.stringify(identifiers.map((i) => ({ ...i, status: 'sourced' }))) }).returning('id').executeTakeFirstOrThrow()).id;
      for (const personId of administrators) {
        await trx.insertInto('membership').values({ person_id: personId, company_id: id, role: 'administrator', permissions: ['company.members.manage'], status: 'active',
          valid_from: new Date('2026-10-01T09:00:00Z') }).execute();
      }
      return id;
    });
  return { w, ...a, hub, cmd, activeSource, company };
}

export function registerSource(owner: string, over: Partial<RegisterSourceInput> = {}): RegisterSourceInput {
  return {
    kind: 'register_open_data', name: 'Synthetic State Licence Board', url: 'https://licences.synthetic-board.invalid/data', ownerPersonId: owner, readerKind: 'official_register',
    purposes: ['company_directory', 'verification_evidence'], licence: { kind: 'statutory_public', name: null, url: null, agreementRef: null },
    allowedUses: { ...MOST_RESTRICTIVE_USES, displayHeadlineAndLink: true, displaySummary: true, indexForSearch: true }, attributionTemplate: 'Source: Synthetic State Licence Board',
    takedownContact: 'records@synthetic-board.invalid', personalData: true, legalBasis: 'statutory_public_register', ...over,
  };
}

export const OPEN_REGISTER_USES = { ...ALL_USES };
export const NO_DISPLAY_USES = { ...MOST_RESTRICTIVE_USES };
