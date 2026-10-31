import { sql } from 'kysely';
import type { DataPool, Transaction } from '../pool.js';
import type { ConnectionConsentRow, ConnectionRow, ConnectionSurface, MandateBindingRow, OAuthClientRegistration } from '../schema/connections.js';

/**
 * Connections repository (MCP-002, migration packages/data/migrations/connections; ADR 013 decisions 5 to 9).
 *
 * - **Pre-identity ports** run on the pool (the token endpoint and the resource check have no session): they take the
 *   SHA-256 of a presented code or token, never the value, and the owner-run commands decide everything under row locks.
 * - **Principal ports** run inside the person's `withPrincipal` transaction: consent, code issue, the connection list
 *   (row-level security: own rows only) and revocation.
 */

export interface OAuthClientRecord {
  id: string;
  clientId: string;
  registration: OAuthClientRegistration;
  clientName: string;
  clientUri: string | null;
  redirectUris: string[];
  applicationType: 'web' | 'native';
  tokenEndpointAuthMethod: 'none' | 'private_key_jwt';
  jwks: { keys: Record<string, unknown>[] } | null;
  companyId: string | null;
  metadataExpiresAt: Date | null;
  disabled: boolean;
}

interface ClientRow {
  id: string; client_id: string; registration: OAuthClientRegistration; client_name: string; client_uri: string | null; redirect_uris: string[];
  application_type: 'web' | 'native'; token_endpoint_auth_method: 'none' | 'private_key_jwt'; jwks: { keys: Record<string, unknown>[] } | null; company_id: string | null;
  metadata_expires_at: Date | null; disabled: boolean;
}
const clientOf = (r: ClientRow): OAuthClientRecord => ({
  id: r.id, clientId: r.client_id, registration: r.registration, clientName: r.client_name, clientUri: r.client_uri, redirectUris: r.redirect_uris,
  applicationType: r.application_type, tokenEndpointAuthMethod: r.token_endpoint_auth_method, jwks: r.jwks, companyId: r.company_id,
  metadataExpiresAt: r.metadata_expires_at, disabled: r.disabled,
});

export const oauthClients = {
  /** The registration of a client id (enabled or not), or null. */
  async get(pool: DataPool, clientId: string): Promise<OAuthClientRecord | null> {
    const { rows } = await pool.query<ClientRow>('SELECT * FROM trustwork.oauth_client_get($1)', [clientId]);
    return rows[0] ? clientOf(rows[0]) : null;
  },
  /** Stores a validated Client ID Metadata Document (fetched through the egress guard) with its cache expiry. */
  async storeMetadata(pool: DataPool, input: { clientId: string; clientName: string; clientUri: string | null; redirectUris: string[]; applicationType: 'web' | 'native'; digest: string; expiresAt: Date }): Promise<string> {
    const { rows } = await pool.query<{ v: string }>('SELECT trustwork.oauth_client_store_metadata($1, $2, $3, $4, $5, $6, $7) AS v',
      [input.clientId, input.clientName, input.clientUri, input.redirectUris, input.applicationType, input.digest, input.expiresAt]);
    return rows[0]?.v as string;
  },
  /** Deprecated dynamic registration (RFC 7591): a public client with a server-chosen id. */
  async registerDynamic(pool: DataPool, input: { clientId: string; clientName: string; clientUri: string | null; redirectUris: string[]; applicationType: 'web' | 'native' }): Promise<string> {
    const { rows } = await pool.query<{ v: string }>('SELECT trustwork.oauth_client_register_dynamic($1, $2, $3, $4, $5) AS v',
      [input.clientId, input.clientName, input.clientUri, input.redirectUris, input.applicationType]);
    return rows[0]?.v as string;
  },
};

export type TokenOutcome = 'issued' | 'invalid_grant' | 'invalid_verifier' | 'invalid_dpop' | 'access_denied' | 'code_replay' | 'reuse_detected';
export interface TokenIssue {
  outcome: TokenOutcome;
  connectionId: string | null;
  familyId: string | null;
  personId: string | null;
  audience: string | null;
  scopes: string[] | null;
  dpopJkt: string | null;
  accessExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
}
interface IssueRow {
  outcome: TokenOutcome; connection_id: string | null; family_id: string | null; person_id: string | null; audience: string | null; scopes: string[] | null;
  dpop_jkt: string | null; access_expires_at: Date | null; refresh_expires_at: Date | null;
}
const issueOf = (r: IssueRow | undefined): TokenIssue => r ? {
  outcome: r.outcome, connectionId: r.connection_id, familyId: r.family_id, personId: r.person_id, audience: r.audience, scopes: r.scopes, dpopJkt: r.dpop_jkt,
  accessExpiresAt: r.access_expires_at, refreshExpiresAt: r.refresh_expires_at,
} : { outcome: 'invalid_grant', connectionId: null, familyId: null, personId: null, audience: null, scopes: null, dpopJkt: null, accessExpiresAt: null, refreshExpiresAt: null };

export interface TokenLifetimes { accessTtlSeconds: number; refreshIdleSeconds: number; refreshAbsoluteSeconds: number }

export interface IntrospectedToken {
  connectionId: string;
  familyId: string;
  personId: string;
  surface: ConnectionSurface;
  clientId: string;
  scopes: string[];
  toolsets: string[];
  privateDataClasses: string[];
  mandateBindings: MandateBindingRow[];
  dpopJkt: string | null;
  expiresAt: Date;
  hubId: string | null;
}

export const oauthTokens = {
  /** Redeems an authorization code once; `challenge` is BASE64URL(SHA-256(verifier)) or null when no verifier came. */
  async redeemCode(pool: DataPool, input: { codeHash: Buffer; clientId: string; redirectUri: string; resource: string; challenge: string | null; dpopJkt: string | null; accessHash: Buffer; refreshHash: Buffer } & TokenLifetimes): Promise<TokenIssue> {
    const { rows } = await pool.query<IssueRow>('SELECT * FROM trustwork.oauth_code_redeem($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)', [
      input.codeHash, input.clientId, input.redirectUri, input.resource, input.challenge, input.dpopJkt, input.accessHash, input.refreshHash,
      input.accessTtlSeconds, input.refreshIdleSeconds, input.refreshAbsoluteSeconds,
    ]);
    return issueOf(rows[0]);
  },
  /** Rotates a refresh token; a second presentation of a rotated token revokes the family and suspends the connection. */
  async rotateRefresh(pool: DataPool, input: { refreshHash: Buffer; clientId: string; resource: string | null; dpopJkt: string | null; accessHash: Buffer; newRefreshHash: Buffer } & Omit<TokenLifetimes, 'refreshAbsoluteSeconds'>): Promise<TokenIssue> {
    const { rows } = await pool.query<IssueRow>('SELECT * FROM trustwork.oauth_refresh_rotate($1, $2, $3, $4, $5, $6, $7, $8)', [
      input.refreshHash, input.clientId, input.resource, input.dpopJkt, input.accessHash, input.newRefreshHash, input.accessTtlSeconds, input.refreshIdleSeconds,
    ]);
    return issueOf(rows[0]);
  },
  /** RFC 7009 revocation by the client that holds the token; false when nothing matched (the endpoint answers 200 anyway). */
  async revoke(pool: DataPool, tokenHash: Buffer, clientId: string): Promise<boolean> {
    const { rows } = await pool.query<{ v: boolean }>('SELECT trustwork.oauth_token_revoke($1, $2) AS v', [tokenHash, clientId]);
    return rows[0]?.v === true;
  },
  /** The live grant behind an access token for exactly this audience, or null. */
  async introspect(pool: DataPool, tokenHash: Buffer, audience: string): Promise<IntrospectedToken | null> {
    const { rows } = await pool.query<{
      connection_id: string; family_id: string; person_id: string; surface: ConnectionSurface; client_id: string; scopes: string[]; toolsets: string[];
      private_data_classes: string[]; mandate_bindings: MandateBindingRow[]; dpop_jkt: string | null; expires_at: Date; hub_id: string | null;
    }>('SELECT * FROM trustwork.connection_token_introspect($1, $2)', [tokenHash, audience]);
    const r = rows[0];
    if (!r) return null;
    return {
      connectionId: r.connection_id, familyId: r.family_id, personId: r.person_id, surface: r.surface, clientId: r.client_id, scopes: r.scopes, toolsets: r.toolsets,
      privateDataClasses: r.private_data_classes, mandateBindings: r.mandate_bindings, dpopJkt: r.dpop_jkt, expiresAt: r.expires_at, hubId: r.hub_id,
    };
  },
};

export interface ConsentGrantInput {
  clientId: string;
  redirectUri: string;
  surface: ConnectionSurface;
  resource: string;
  scopes: string[];
  privateDataClasses: string[];
  toolsets: string[];
  mandateBindings: MandateBindingRow[];
  consentTextVersion: number;
  stepUp: boolean;
  elevationId: string | null;
  locale: string;
  expiresAt: Date;
  hubId: string | null;
}

export const connectionGrants = {
  /** Records the person's consent and returns the live connection (inside the person's principal transaction). */
  async grant(trx: Transaction, input: ConsentGrantInput): Promise<{ connectionId: string; consentId: string }> {
    const { rows } = await sql<{ connection_id: string; consent_id: string }>`SELECT * FROM trustwork.connection_consent_grant(
      ${input.clientId}::text, ${input.redirectUri}::text, ${input.surface}::text, ${input.resource}::text, ${input.scopes}::text[], ${input.privateDataClasses}::text[],
      ${input.toolsets}::text[], ${JSON.stringify(input.mandateBindings)}::jsonb, ${input.consentTextVersion}::integer, ${input.stepUp}::boolean, ${input.elevationId}::uuid,
      ${input.locale}::text, ${input.expiresAt}::timestamptz, ${input.hubId}::uuid)`.execute(trx);
    const row = rows[0] as { connection_id: string; consent_id: string };
    return { connectionId: row.connection_id, consentId: row.consent_id };
  },
  /** Issues a single-use authorization code (hash only) for one of the caller's live connections; returns its expiry. */
  async issueCode(trx: Transaction, input: { connectionId: string; codeHash: Buffer; redirectUri: string; codeChallenge: string; resource: string; scopes: string[]; dpopJkt: string | null; ttlSeconds: number }): Promise<Date> {
    const { rows } = await sql<{ v: Date }>`SELECT trustwork.oauth_code_issue(${input.connectionId}::uuid, ${input.codeHash}::bytea, ${input.redirectUri}::text,
      ${input.codeChallenge}::text, ${input.resource}::text, ${input.scopes}::text[], ${input.dpopJkt}::text, ${input.ttlSeconds}::integer) AS v`.execute(trx);
    return rows[0]?.v as Date;
  },
  /** The caller's live connection and consent for one client, redirect URI and surface (any status but revoked), or null. */
  async current(trx: Transaction, key: { clientId: string; redirectUri: string; surface: ConnectionSurface }): Promise<{ connection: ConnectionRow; consent: ConnectionConsentRow } | null> {
    const connection = await trx.selectFrom('connection').selectAll().where('client_id', '=', key.clientId).where('redirect_uri', '=', key.redirectUri)
      .where('surface', '=', key.surface).where('status', '<>', 'revoked').executeTakeFirst();
    if (!connection) return null;
    const consent = await trx.selectFrom('connection_consent').selectAll().where('id', '=', connection.consent_id).executeTakeFirst();
    return consent ? { connection, consent } : null;
  },
  /** The caller's connections with their consent and client display fields, newest first (row-level security: own rows). */
  async list(trx: Transaction): Promise<{ connection: ConnectionRow; consent: ConnectionConsentRow; client: { clientName: string; registration: OAuthClientRegistration } }[]> {
    const connections = await trx.selectFrom('connection').selectAll().orderBy('created_at', 'desc').orderBy('id').execute();
    if (!connections.length) return [];
    const consents = await trx.selectFrom('connection_consent').selectAll().where('id', 'in', connections.map((c) => c.consent_id)).execute();
    const clients = await trx.selectFrom('oauth_client').select(['id', 'client_name', 'registration']).where('id', 'in', connections.map((c) => c.client_ref)).execute();
    const consentById = new Map(consents.map((k) => [k.id, k]));
    const clientById = new Map(clients.map((c) => [c.id, c]));
    return connections.flatMap((connection) => {
      const consent = consentById.get(connection.consent_id);
      const client = clientById.get(connection.client_ref);
      return consent && client ? [{ connection, consent, client: { clientName: client.client_name, registration: client.registration } }] : [];
    });
  },
  /** Revokes one of the caller's connections; false when it was already revoked. Unknown or foreign ids raise `access.not_found`. */
  async revoke(trx: Transaction, connectionId: string): Promise<boolean> {
    const { rows } = await sql<{ v: boolean }>`SELECT trustwork.connection_revoke(${connectionId}::uuid) AS v`.execute(trx);
    return rows[0]?.v === true;
  },
  /** Revokes every connection of the caller; returns how many were live. */
  async revokeAll(trx: Transaction): Promise<number> {
    const { rows } = await sql<{ v: number }>`SELECT trustwork.connection_revoke_all() AS v`.execute(trx);
    return Number(rows[0]?.v ?? 0);
  },
};
