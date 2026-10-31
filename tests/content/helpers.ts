import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { withMaintenance, type DataPool, type Transaction } from '@trustwork/data';
import type { ConsolePermission, HubStaffRole } from '@trustwork/contracts';
import { staffRoleDefinitions } from '../../packages/data/src/repositories/admin.js';
import type { AuthorshipInput, DraftInput } from '../../packages/data/src/repositories/content.js';
import { actors, buildAdminWorld, settle, type AdminWorld } from '../data/admin/helpers.js';
import { consentPublicProfiles } from '../data/helpers/seed.js';
import { sqlState } from '../data/helpers/postgres.js';

/**
 * Synthetic content world for the CNT-001 suites, on top of DATA-002's synthetic administration world. Every person,
 * company and publication is synthetic ("Synthetic …", example.invalid); role definitions are test definitions over
 * the real console permission vocabulary, not a released capability map.
 *
 * People: writer (personal author), coauthor (credited, no editing right until granted), member (of the synthetic
 * company, holding company.publish), employee (company administrator without company.publish), editorA and editorB
 * (staff `editor` at the hub), chief (staff `editor-in-chief`), moderator (staff `moderator`), mentioned (a public
 * profile that may consent to being named), reader and outsider (no rights at all).
 */
export const CONTENT_DEFINITIONS: Array<{ role: HubStaffRole; permissions: ConsolePermission[] }> = [
  { role: 'editor', permissions: ['admin.publications.read', 'admin.publications.review', 'admin.publications.publish', 'admin.publications.correct', 'admin.publications.links.edit',
    'admin.issues.read', 'admin.issues.curate', 'admin.issues.correct', 'admin.issues.render'] },
  { role: 'editor-in-chief', permissions: ['admin.publications.read', 'admin.publications.review', 'admin.publications.publish', 'admin.publications.correct', 'admin.publications.retract',
    'admin.publications.hold', 'admin.publications.links.edit', 'admin.issues.read', 'admin.issues.curate', 'admin.issues.release', 'admin.issues.correct', 'admin.issues.render'] },
];
export type ContentKey = 'writer' | 'coauthor' | 'member' | 'editorA' | 'editorB' | 'chief' | 'mentioned' | 'reader';

export interface ContentWorld {
  admin: AdminWorld;
  hubId: string;
  otherHubId: string;
  company: string;
  people: Record<ContentKey | 'moderator' | 'employee' | 'outsider' | 'owner', string>;
  act: ReturnType<typeof actors>;
}

/** Releases the editorial role definitions (version 1) on a database whose administration world exists. */
export async function releaseContentDefinitions(trx: Transaction): Promise<void> {
  for (const def of CONTENT_DEFINITIONS) {
    await staffRoleDefinitions.release(trx, { version: 1, role: def.role, scopes: ['hub'], permissions: def.permissions, caps: { creditCapMinorUnits: null, grantMaxHours: 72 },
      sodConflicts: [], sodMode: 'reduced', releasedBy: null });
  }
}

/** Released engine topic terms `materials`, `regulation` and `markets`, plus a draft term `unreleased`. */
export async function seedTopics(trx: Transaction): Promise<void> {
  const existing = await trx.selectFrom('taxonomy_term').select('code').where('code', 'in', ['materials', 'regulation', 'markets']).where('hub_id', 'is', null).execute();
  if (existing.length === 3) return;
  const release = await trx.insertInto('taxonomy_release').values({ hub_id: null, version: `0.0.${Math.floor(Math.random() * 1e6)}`, payload: JSON.stringify({ synthetic: true }), digest: 'a'.repeat(64) })
    .returning('id').executeTakeFirstOrThrow();
  for (const code of ['materials', 'regulation', 'markets'].filter((c) => !existing.some((e) => e.code === c))) {
    await trx.insertInto('taxonomy_term').values({ hub_id: null, scheme: 'topic', code, status: 'released', release_id: release.id }).execute();
  }
  await trx.insertInto('taxonomy_term').values({ hub_id: null, scheme: 'topic', code: `unreleased.t${randomBytes(3).toString('hex')}`, status: 'draft' }).execute();
}

export async function buildContentWorld(adminPool: DataPool, runtime: DataPool): Promise<ContentWorld> {
  const world = await buildAdminWorld(adminPool);
  const extra = await withMaintenance(adminPool, async (trx) => {
    await releaseContentDefinitions(trx);
    await seedTopics(trx);
    const out = {} as Record<ContentKey, string>;
    const names: Record<ContentKey, string> = {
      writer: 'Synthetic Writer', coauthor: 'Synthetic Co-author', member: 'Synthetic Company Writer', editorA: 'Synthetic Editor A', editorB: 'Synthetic Editor B',
      chief: 'Synthetic Editor-in-Chief', mentioned: 'Synthetic Interviewee', reader: 'Synthetic Reader',
    };
    for (const key of Object.keys(names) as ContentKey[]) {
      out[key] = (await trx.insertInto('person').values({ display_name: names[key] }).returning('id').executeTakeFirstOrThrow()).id;
      const session = await trx.insertInto('session').values({
        person_id: out[key], token_hash: randomBytes(32), idle_expires_at: new Date(Date.now() + 86_400_000), absolute_expires_at: new Date(Date.now() + 86_400_000), auth_method: 'password',
      }).returning('id').executeTakeFirstOrThrow();
      world.sessions[key] = session.id;
    }
    await trx.insertInto('membership').values({ person_id: out.member, company_id: world.company, role: 'member', permissions: ['company.publish'], status: 'active', valid_from: new Date('2026-10-01T09:00:00Z') }).execute();
    // `mentioned` keeps a public, consented profile (PPL-001); a mention still needs a per-publication consent.
    await consentPublicProfiles(trx, [out.mentioned]);
    await trx.updateTable('person').set({ profile_visibility: 'public' }).where('id', '=', out.mentioned).execute();
    return out;
  });
  Object.assign(world.people as Record<string, string>, extra);
  const act = actors(adminPool, runtime, world);
  const hub = { kind: 'hub', hubId: world.hubId } as const;
  await act.assign({ personId: extra.editorA, role: 'editor', scope: hub });
  await act.assign({ personId: extra.editorB, role: 'editor', scope: hub });
  await act.assign({ personId: extra.chief, role: 'editor-in-chief', scope: hub });
  await act.assign({ personId: world.people.moderator, role: 'moderator', scope: hub });
  return {
    admin: world, hubId: world.hubId, otherHubId: world.otherHubId, company: world.company, act,
    people: { ...extra, moderator: world.people.moderator, employee: world.people.employee, outsider: world.people.outsider, owner: world.people.owner },
  };
}

/** A live mentioned_in_publication consent of the person for the publication (first-party form, synthetic evidence). */
export async function consentToMention(adminPool: DataPool, personId: string, publicationId: string): Promise<void> {
  await withMaintenance(adminPool, (trx) => sql`INSERT INTO trustwork.consent_record (subject_person_id, purpose, target_kind, target_id, notice_version, evidence)
    VALUES (${personId}::uuid, 'mentioned_in_publication', 'publication', ${publicationId}::uuid, 'mentioned_in_publication.v1', ${JSON.stringify({ method: 'first_party_form', requestId: 'synthetic-test' })}::jsonb)`.execute(trx));
}

export const ALL_USES = {
  displayHeadlineAndLink: true, displaySummary: true, storeFullText: true, indexForSearch: true, sendToModelProviders: true, translate: true, rewriteWithAttribution: true,
  reuseImages: true, syndicateToPeers: true,
};
/** A cited source; `uses` overrides the allowed uses of its licence. */
export function source(over: Record<string, unknown> = {}, uses: Partial<typeof ALL_USES> = {}) {
  return {
    uri: 'https://example.invalid/synthetic-release', name: 'Synthetic Standards Bulletin', kind: 'official_register', sourceTime: '2026-10-28T08:00:00.000Z',
    observedAt: '2026-10-28T09:30:00.000Z', license: 'Synthetic open licence', allowedUses: { ...ALL_USES, ...uses }, ...over,
  };
}
export function draft(over: Partial<DraftInput> = {}): DraftInput {
  return { title: 'Synthetic: new fire-rating rule for facades', body: 'Synthetic body text for tests.', language: 'en', sourceRefs: [], treatment: 'original_reporting', eventTime: null, assistantAssisted: false, ...over };
}
export function newsDraft(over: Partial<DraftInput> = {}): DraftInput {
  return draft({ sourceRefs: [source()], treatment: 'summary', eventTime: '2026-10-28T08:00:00.000Z', ...over });
}
export const credit = (id: string, name = 'Synthetic Writer'): AuthorshipInput[] => [{ kind: 'person', id, credit: name, assistantAssisted: false }];

/** Asserts a rejection with the SQLSTATE and (optionally) the hint. */
export async function refused(promise: Promise<unknown>, state: string, hint?: string): Promise<void> {
  const error = await settle(promise);
  assert.ok(error, `expected a rejection${hint ? ` (${hint})` : ''}`);
  assert.equal(sqlState(error), state, `${error.message} (hint ${error.hint})`);
  if (hint) assert.equal(error.hint, hint, error.message);
}
