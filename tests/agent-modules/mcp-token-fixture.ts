import { randomBytes } from 'node:crypto';
import { withMaintenance } from '@trustwork/data';
import type { McpTokenAuthority } from '../../apps/api/src/modules/agent-modules/authority.js';
import type { Harness } from '../backend/helpers/app.js';
import type { ExternalConnection } from '@trustwork/contracts';

export async function installSyntheticMcpConnection(h: Harness, personId: string, hubId: string): Promise<{ connection: ExternalConnection; token: McpTokenAuthority }> {
  const clientId = `synthetic-parity-${randomBytes(5).toString('hex')}`;
  const scopes: ExternalConnection['scopes'] = ['read.public', 'read.me', 'read.contexts', 'read.private', 'propose'];
  const privateDataClasses: ExternalConnection['privateDataClasses'] = ['private_projects', 'budgets'];
  const id = await withMaintenance(h.db.admin, async trx => {
    const client = await trx.insertInto('oauth_client').values({ client_id: clientId, registration: 'pre_registered', client_name: 'Synthetic parity client', redirect_uris: ['https://client.example.invalid/cb'], application_type: 'web', token_endpoint_auth_method: 'none' }).returning('id').executeTakeFirstOrThrow();
    const consent = await trx.insertInto('connection_consent').values({ person_id: personId, client_ref: client.id, client_id: clientId, redirect_uri: 'https://client.example.invalid/cb', surface: 'participant', scopes, private_data_classes: privateDataClasses, toolsets: ['plans'], consent_text_version: 1, step_up: true, locale: 'en', expires_at: new Date(Date.now() + 86_400_000) }).returning('id').executeTakeFirstOrThrow();
    return (await trx.insertInto('connection').values({ hub_id: hubId, person_id: personId, surface: 'participant', client_ref: client.id, client_id: clientId, resource: 'https://trustwork.test/mcp', redirect_uri: 'https://client.example.invalid/cb', consent_id: consent.id, status: 'active', status_reason: null, revoked_at: null }).returning('id').executeTakeFirstOrThrow()).id;
  });
  const connection: ExternalConnection = { id, hubId, owner: { kind: 'person', personId }, protocol: 'mcp', clientId, clientNameSelfAsserted: 'Synthetic parity client', listedByHub: false,
    scopes, privateDataClasses, mandateBindings: [], rateLimitProfile: 'standard', consent: { via: 'first_party_form', personId, at: new Date().toISOString(), stepUp: true }, status: 'active', createdAt: new Date().toISOString(), lastUsedAt: null, revokedAt: null, revision: 1 };
  return { connection, token: await installSyntheticMcpToken(h, id, scopes) };
}

/** Synthetic stored authorization and token; no external client, account, secret or transport is activated. */
export async function installSyntheticMcpToken(h: Harness, connectionId: string, scopes: string[]): Promise<McpTokenAuthority> {
  return withMaintenance(h.db.admin, async trx => {
    const connection = await trx.selectFrom('connection').selectAll().where('id', '=', connectionId).executeTakeFirstOrThrow();
    const now = new Date();
    const code = await trx.insertInto('oauth_authorization_code').values({
      code_hash: randomBytes(32), connection_id: connectionId, client_id: connection.client_id, redirect_uri: connection.redirect_uri,
      code_challenge: 'a'.repeat(43), resource: connection.resource, scopes, dpop_jkt: null,
      expires_at: new Date(now.getTime() + 300_000), consumed_at: now,
    }).returning('id').executeTakeFirstOrThrow();
    const family = await trx.insertInto('connection_token_family').values({ connection_id: connectionId, code_id: code.id,
      audience: connection.resource, dpop_jkt: null, absolute_expires_at: new Date(now.getTime() + 86_400_000), revoked_at: null, revoked_reason: null,
    }).returning('id').executeTakeFirstOrThrow();
    const accessTokenHash = randomBytes(32);
    await trx.insertInto('connection_token').values({ family_id: family.id, connection_id: connectionId, kind: 'access', token_hash: accessTokenHash,
      audience: connection.resource, expires_at: new Date(now.getTime() + 600_000), rotated_from_id: null, used_at: null, revoked_at: null,
    }).execute();
    return { audience: connection.resource, accessTokenHash, dpopJkt: null };
  });
}
