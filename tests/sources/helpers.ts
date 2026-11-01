import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { withMaintenance, type DataPool, type Transaction } from '@trustwork/data';
import type { ConsolePermission, HubStaffRole } from '@trustwork/contracts';
import { staffRoleDefinitions, type CommandContext } from '../../packages/data/src/repositories/admin.js';
import type { RegisterSourceInput, StagedItemInput } from '../../packages/data/src/repositories/sources.js';
import { ALL_USES, MOST_RESTRICTIVE_USES } from '../../packages/contracts/src/sources.js';
import { buildContentWorld, type ContentWorld } from '../content/helpers.js';

/**
 * Synthetic world for the SRC-001 suites, on top of CNT-001's content world (editors holding admin.publications.review,
 * an editor-in-chief, a moderator and participants without rights). Every person, hub, source and site is synthetic
 * ("Synthetic …", example.invalid / *.example hosts); role definitions are test definitions over the real console
 * vocabulary, not a released capability map.
 *
 * - stewardA, stewardB: `data-steward` at the hub (register, check, activate sources; stage and activate batches; links)
 * - officerA, officerB: `compliance-officer` at the hub (sponsored content policy; the second person for each other)
 * - otherSteward: `data-steward` at the other hub (every registry permission, but elsewhere)
 */
export const SOURCES_DEFINITIONS: Array<{ role: HubStaffRole; permissions: ConsolePermission[] }> = [
  { role: 'data-steward', permissions: ['admin.sources.read', 'admin.sources.manage', 'admin.sources.takedown', 'admin.sources.import.activate', 'admin.sources.dedupe.decide', 'admin.links.decide'] },
  { role: 'compliance-officer', permissions: ['admin.sources.read', 'admin.sponsored.policy.edit'] },
];
export type SourcesKey = 'stewardA' | 'stewardB' | 'officerA' | 'officerB' | 'otherSteward';

export interface SourcesWorld {
  content: ContentWorld;
  hubId: string;
  otherHubId: string;
  people: ContentWorld['people'] & Record<SourcesKey, string>;
  act: ContentWorld['act'];
  /** Runs a staff command as the person under a fresh elevation. */
  cmd<T>(personId: string, fn: (trx: Transaction, ctx: CommandContext) => Promise<T>): Promise<T>;
}

export async function buildSourcesWorld(adminPool: DataPool, runtime: DataPool): Promise<SourcesWorld> {
  const content = await buildContentWorld(adminPool, runtime);
  const names: Record<SourcesKey, string> = {
    stewardA: 'Synthetic Data Steward A', stewardB: 'Synthetic Data Steward B', officerA: 'Synthetic Compliance Officer A', officerB: 'Synthetic Compliance Officer B',
    otherSteward: 'Synthetic Other Hub Steward',
  };
  const mine = await withMaintenance(adminPool, async (trx) => {
    for (const def of SOURCES_DEFINITIONS) {
      await staffRoleDefinitions.release(trx, { version: 1, role: def.role, scopes: ['hub'], permissions: def.permissions, caps: { creditCapMinorUnits: null, grantMaxHours: 72 },
        sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    }
    const out = {} as Record<SourcesKey, string>;
    for (const key of Object.keys(names) as SourcesKey[]) {
      out[key] = (await trx.insertInto('person').values({ display_name: names[key] }).returning('id').executeTakeFirstOrThrow()).id;
      const session = await trx.insertInto('session').values({
        person_id: out[key], token_hash: randomBytes(32), idle_expires_at: new Date(Date.now() + 86_400_000), absolute_expires_at: new Date(Date.now() + 86_400_000), auth_method: 'password',
      }).returning('id').executeTakeFirstOrThrow();
      content.admin.sessions[key] = session.id;
    }
    return out;
  });
  Object.assign(content.admin.people as Record<string, string>, mine);
  const hub = { kind: 'hub', hubId: content.hubId } as const;
  await content.act.assign({ personId: mine.stewardA, role: 'data-steward', scope: hub });
  await content.act.assign({ personId: mine.stewardB, role: 'data-steward', scope: hub });
  await content.act.assign({ personId: mine.otherSteward, role: 'data-steward', scope: { kind: 'hub', hubId: content.otherHubId } });
  await content.act.assignSensitive({ personId: mine.officerA, role: 'compliance-officer', scope: hub });
  await content.act.assignSensitive({ personId: mine.officerB, role: 'compliance-officer', scope: hub });
  const act = content.act;
  return {
    content, hubId: content.hubId, otherHubId: content.otherHubId, act, people: { ...content.people, ...mine },
    async cmd<T>(personId: string, fn: (trx: Transaction, ctx: CommandContext) => Promise<T>): Promise<T> {
      const ctx = await act.elevate(personId);
      return act.as(personId, (trx) => fn(trx, ctx));
    },
  };
}

export const DISPLAY_ONLY = { ...MOST_RESTRICTIVE_USES, displayHeadlineAndLink: true };
export const OPEN_USES = { ...ALL_USES };

/** A source registration (an RSS feed under an open licence by default). */
export function sourceInput(owner: string, over: Partial<RegisterSourceInput> = {}): RegisterSourceInput {
  return {
    kind: 'rss', name: 'Synthetic Trade Journal', url: 'https://allow.synthetic-journal.example/feed.xml', ownerPersonId: owner, readerKind: 'industry_media', purposes: ['news_desk'],
    licence: { kind: 'open_licence', name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/', agreementRef: null }, allowedUses: { ...OPEN_USES },
    attributionTemplate: 'Source: Synthetic Trade Journal', takedownContact: 'rights@synthetic-journal.example', personalData: false, legalBasis: null, ...over,
  };
}

export function item(n: number | string, over: Partial<StagedItemInput> = {}): StagedItemInput {
  return {
    externalId: `synthetic-${n}`, url: `https://allow.synthetic-journal.example/news/${n}`, title: `Synthetic: drainage standard update ${n}`, summary: null, fullText: null,
    sourceTime: '2026-10-28T08:00:00.000Z', sponsored: null, ...over,
  };
}

export const robotsInput = (domain: string, over: Record<string, unknown> = {}) => ({
  domain, robotsUrl: `https://${domain}/robots.txt`, userAgent: 'TrustworkSourcesBot', robotsDigest: randomBytes(32).toString('hex'), allowed: true, status: 'allowed' as const,
  crawlDelaySeconds: null, allowedPaths: ['/'], disallowedPaths: [] as string[], licenceUrls: [] as string[], ...over,
});

export const uuid = (): string => randomUUID();

/** Asserts the editorial draft a person creates from an item is a draft (never published). */
export function assertDraft(status: string): void {
  assert.equal(status, 'draft');
}
