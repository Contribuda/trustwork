import type { ApiConfig } from '../../../config.js';
import { DEFAULT_MCP_HUB_POLICY, MCP_ENDPOINT_PATHS, McpHubPolicySchema, type McpHubPolicy } from './deps.js';

/**
 * Settings of the hub authorization server (MCP-002, ADR 013 decisions 5 to 7). The issuer is the hub's public origin;
 * each MCP surface is its own protected resource whose canonical URI is the token audience. Policy values come from
 * the contract's `McpHubPolicySchema` (engine bounds) with the engine defaults, overridable per deployment until the
 * console's External agents policy (HC-82) stores them. Every variable is validated at start; a malformed value stops
 * the process instead of silently relaxing a rule.
 */
export type OAuthSurface = 'participant' | 'admin';
export type MetadataFetchMode = 'disabled' | 'fake' | 'live';

export interface OAuthSettings {
  issuer: string;
  resources: Readonly<Record<OAuthSurface, string>>;
  policy: McpHubPolicy;
  /** Client ID Metadata Documents: `live` fetches through the egress guard, `fake` uses the scriptable adapter, `disabled` refuses URL client ids. */
  metadataFetch: MetadataFetchMode;
  /** Version of the consent text the first-party page shows; a consent given under another version is asked again. */
  consentTextVersion: number;
  consentLifetimeDays: number;
  codeTtlSeconds: number;
  refreshIdleSeconds: number;
  /** Dynamic registrations accepted per client address and hour (deprecated path, rate-limited). */
  registrationsPerHour: number;
  hubId: string | null;
  /** Lifetime of the signed authorization request handed to the consent page. */
  requestTtlSeconds: number;
}

export class OAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthConfigError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new OAuthConfigError(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new OAuthConfigError(`${name} must be true or false`);
}

/**
 * Builds the settings from the API configuration and the environment:
 * `MCP_ADMIN_ENDPOINT` (default false), `MCP_DYNAMIC_REGISTRATION` (default true), `MCP_CLIENT_TRUST`
 * (`any_https_client` | `listed_clients_only`), `MCP_LISTED_CLIENTS` (JSON `[{"clientId","displayName"}]`),
 * `MCP_ACCESS_TOKEN_TTL_SECONDS` (60..900, default 900), `MCP_REFRESH_ABSOLUTE_DAYS` (1..365, default 180),
 * `MCP_REFRESH_IDLE_DAYS` (1..365, default 90), `MCP_CONSENT_TEXT_VERSION` (default 1), `MCP_CLIENT_METADATA_FETCH`
 * (default: the provider mode of the deployment), `TRUSTWORK_HUB_ID`.
 */
export function oauthSettingsFromEnv(config: ApiConfig, env: NodeJS.ProcessEnv = process.env): OAuthSettings {
  const issuer = config.publicOrigin.replace(/\/$/, '');
  let listed: unknown = [];
  if (env.MCP_LISTED_CLIENTS?.trim()) {
    try {
      listed = JSON.parse(env.MCP_LISTED_CLIENTS);
    } catch {
      throw new OAuthConfigError('MCP_LISTED_CLIENTS must be a JSON array');
    }
  }
  const trust = env.MCP_CLIENT_TRUST?.trim() || DEFAULT_MCP_HUB_POLICY.clientTrust;
  const parsed = McpHubPolicySchema.safeParse({
    ...DEFAULT_MCP_HUB_POLICY,
    endpoints: { ...DEFAULT_MCP_HUB_POLICY.endpoints, admin: bool(env, 'MCP_ADMIN_ENDPOINT', DEFAULT_MCP_HUB_POLICY.endpoints.admin) },
    dynamicRegistration: bool(env, 'MCP_DYNAMIC_REGISTRATION', DEFAULT_MCP_HUB_POLICY.dynamicRegistration),
    clientTrust: trust,
    listedClients: listed,
    accessTokenTtlSeconds: int(env, 'MCP_ACCESS_TOKEN_TTL_SECONDS', DEFAULT_MCP_HUB_POLICY.accessTokenTtlSeconds, 60, 900),
    refreshAbsoluteDays: int(env, 'MCP_REFRESH_ABSOLUTE_DAYS', DEFAULT_MCP_HUB_POLICY.refreshAbsoluteDays, 1, 365),
  });
  if (!parsed.success) throw new OAuthConfigError(`MCP hub policy is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'policy'} ${i.message}`).join('; ')}`);
  const fetchRaw = env.MCP_CLIENT_METADATA_FETCH?.trim() || config.providers.mode;
  if (fetchRaw !== 'disabled' && fetchRaw !== 'fake' && fetchRaw !== 'live') throw new OAuthConfigError('MCP_CLIENT_METADATA_FETCH must be disabled, fake or live');
  if (fetchRaw === 'fake' && config.production) throw new OAuthConfigError('MCP_CLIENT_METADATA_FETCH=fake is refused in production');
  const hub = env.TRUSTWORK_HUB_ID?.trim();
  const refreshIdleDays = int(env, 'MCP_REFRESH_IDLE_DAYS', 90, 1, 365);
  return {
    issuer,
    resources: { participant: `${issuer}${MCP_ENDPOINT_PATHS.participant}`, admin: `${issuer}${MCP_ENDPOINT_PATHS.admin}` },
    policy: parsed.data,
    metadataFetch: fetchRaw,
    consentTextVersion: int(env, 'MCP_CONSENT_TEXT_VERSION', 1, 1, 10_000),
    consentLifetimeDays: 365,
    codeTtlSeconds: 60,
    refreshIdleSeconds: Math.min(refreshIdleDays, parsed.data.refreshAbsoluteDays) * 86_400,
    registrationsPerHour: int(env, 'MCP_REGISTRATIONS_PER_HOUR', 10, 1, 1_000),
    hubId: hub && UUID.test(hub) ? hub : null,
    requestTtlSeconds: 600,
  };
}

/** The surface whose canonical URI equals `resource` exactly (RFC 8707), or null. The public surface takes no tokens. */
export function surfaceOf(settings: OAuthSettings, resource: string): OAuthSurface | null {
  if (resource === settings.resources.participant) return 'participant';
  if (resource === settings.resources.admin) return 'admin';
  return null;
}

export function protectedResourceMetadataUrl(settings: OAuthSettings, surface: OAuthSurface): string {
  return `${settings.issuer}/.well-known/oauth-protected-resource${MCP_ENDPOINT_PATHS[surface]}`;
}

export const OAUTH_PATHS = {
  authorize: '/v1/oauth/authorize',
  token: '/v1/oauth/token',
  revoke: '/v1/oauth/revoke',
  register: '/v1/oauth/register',
  /** First-party consent page (MCP-070 renders it; the API owns the request and the decision). */
  consentPage: '/oauth/consent',
  login: '/login',
} as const;
