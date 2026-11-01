import { randomBytes } from 'node:crypto';
import { withMaintenance, type DataPool, type Transaction } from '@trustwork/data';
import type { ConsolePermission, HubStaffRole } from '@trustwork/contracts';
import { adminSetup, staffRoleDefinitions, type CommandContext } from '../../packages/data/src/repositories/admin.js';
import { hubConfig } from '../../packages/data/src/repositories/hubs.js';
import { configActivationDigestInput } from '../../packages/contracts/src/hub-core.js';
import { actors, KEYS, US_HUB, type HubWorld, type Key } from '../hubs/helpers.js';

export { actors, rejects, settle, syncKernel, US_HUB } from '../hubs/helpers.js';
export type { HubWorld, Key } from '../hubs/helpers.js';

/**
 * Synthetic world for the KEYS-001 suites: the HUB-001 people (every one labelled "Synthetic") with role definitions
 * over the real console vocabulary that include the providers permissions. Test definitions, not the released map.
 *
 * - owner: hub-owner of hub A (connects, writes secrets, tests, drafts routes, sets caps, engages kill switches)
 * - officer: compliance-officer of hub A (the second person; holds the same permissions)
 * - moderator: moderator of hub A (no providers permission)
 * - otherOwner: hub-owner of hub B (every permission, but at another hub)
 */
const PROVIDERS: ConsolePermission[] = [
  'admin.providers.read', 'admin.providers.connection.edit', 'admin.providers.secret.write', 'admin.providers.test', 'admin.providers.toggle', 'admin.providers.egress.edit',
  'admin.providers.budget.edit', 'admin.providers.kill', 'admin.models.route.edit', 'admin.models.route.activate', 'admin.usage.read', 'admin.audit.read',
];
const HUB_CONFIG: ConsolePermission[] = ['admin.hub.read', 'admin.hub.identity.edit', 'admin.hub.residency.edit', 'admin.config.edit', 'admin.hub.jurisdiction.edit', 'admin.hub.jurisdiction.activate'];
type Def = { role: HubStaffRole; scopes: ('platform' | 'node' | 'hub')[]; permissions: ConsolePermission[] };
export const PROVIDER_DEFINITIONS: Def[] = [
  { role: 'platform-owner', scopes: ['platform'], permissions: ['admin.staff.assign', 'admin.staff.revoke', 'admin.staff.read', 'admin.audit.read'] },
  { role: 'staff-admin', scopes: ['platform', 'node', 'hub'], permissions: ['admin.staff.assign', 'admin.staff.revoke', 'admin.staff.read'] },
  { role: 'node-operator', scopes: ['node'], permissions: ['admin.node.hubs.manage', 'admin.hub.read'] },
  { role: 'hub-owner', scopes: ['hub'], permissions: [...HUB_CONFIG, ...PROVIDERS] },
  { role: 'compliance-officer', scopes: ['node', 'hub'], permissions: [...HUB_CONFIG, ...PROVIDERS] },
  { role: 'moderator', scopes: ['hub'], permissions: ['admin.moderation.read'] },
];

export async function buildProvidersWorld(admin: DataPool): Promise<HubWorld> {
  return withMaintenance(admin, async (trx) => {
    for (const def of PROVIDER_DEFINITIONS) {
      await staffRoleDefinitions.release(trx, { version: 1, role: def.role, scopes: def.scopes, permissions: def.permissions, caps: { creditCapMinorUnits: null, grantMaxHours: 72 },
        sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    }
    const { id: nodeId } = await adminSetup.createNode(trx, 'Synthetic providers node');
    const people = {} as Record<Key, string>;
    const sessions = {} as Record<Key, string>;
    for (const key of KEYS) {
      people[key] = (await trx.insertInto('person').values({ display_name: `Synthetic ${key}` }).returning('id').executeTakeFirstOrThrow()).id;
      sessions[key] = (await trx.insertInto('session').values({
        person_id: people[key], token_hash: randomBytes(32), idle_expires_at: new Date(Date.now() + 86_400_000), absolute_expires_at: new Date(Date.now() + 86_400_000), auth_method: 'password',
      }).returning('id').executeTakeFirstOrThrow()).id;
    }
    await adminSetup.bootstrapFirstAdmin(trx, { personId: people.founder, role: 'platform-owner', scope: { kind: 'platform' }, definitionVersion: 1, reason: 'Synthetic setup' });
    await adminSetup.bootstrapFirstAdmin(trx, { personId: people.founder2, role: 'staff-admin', scope: { kind: 'platform' }, definitionVersion: 1, reason: 'Synthetic setup' });
    return { nodeId, people, sessions };
  });
}

/**
 * Two synthetic hubs with staff: hub A (the United States reference hub, residency US) with owner, officer and
 * moderator; hub B with its own owner. Returns the hub ids.
 */
export async function setUpHubs(a: ReturnType<typeof actors>, w: HubWorld, slug: string): Promise<{ hubA: string; hubB: string }> {
  await a.assignSensitive({ personId: w.people.operator, role: 'node-operator', scope: { kind: 'node', nodeId: w.nodeId } });
  const hubA = (await a.createHub(`${slug}-a`, US_HUB)).hub_id;
  const hubB = (await a.createHub(`${slug}-b`, { ...US_HUB, name: { en: 'Synthetic second hub', es: 'Segundo centro sintético' } })).hub_id;
  await a.assignSensitive({ personId: w.people.owner, role: 'hub-owner', scope: { kind: 'hub', hubId: hubA } });
  await a.assignSensitive({ personId: w.people.officer, role: 'compliance-officer', scope: { kind: 'hub', hubId: hubA } });
  await a.assign({ personId: w.people.moderator, role: 'moderator', scope: { kind: 'hub', hubId: hubA } });
  await a.assignSensitive({ personId: w.people.otherOwner, role: 'hub-owner', scope: { kind: 'hub', hubId: hubB } });
  return { hubA, hubB };
}

/** Activates the hub's residency (personal data in `countries`) through the second-person path of HUB-001. */
export async function activateResidency(a: ReturnType<typeof actors>, drafter: string, activator: string, hubId: string, countries: string[]): Promise<void> {
  const v = await a.cmd(drafter, (trx: Transaction, ctx: CommandContext) => hubConfig.draft(trx, ctx, hubId, 'residency', { hostingCountry: countries[0], hostingRegion: null, personalDataCountries: countries }));
  const approval = await a.approve(activator, drafter, 'hub.change_residency', hubId, configActivationDigestInput({ id: v.id, hubId, domain: 'residency', version: v.version, payloadDigest: v.payload_digest }));
  await a.cmd(activator, (trx: Transaction, ctx: CommandContext) => hubConfig.activate(trx, ctx, v.id, null, approval));
}

export const VENDOR_US = { kind: 'vendor' as const, country: 'US', zeroRetention: true, trainsOnInputs: false, broker: false };
export const SELF_US = { kind: 'self_hosted' as const, country: 'US' };
