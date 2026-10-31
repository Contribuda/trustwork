import { randomBytes } from 'node:crypto';
import { DEFAULT_PASSWORD_POLICY, STEP_UP_FRESHNESS_MS } from './deps/contracts.js';

/**
 * Runtime configuration of the API process. Every value is explicit (no `.env` is loaded implicitly); defaults are
 * the integrator decisions of BE-001 and the H01–H11 defaults where the human has not decided yet.
 */
export interface ApiConfig {
  host: string;
  port: number;
  /** Exact public origin the browser loads the app from; mutations must prove same-origin against it. */
  publicOrigin: string;
  /** Path the provider callback redirects to (relative to the public origin). */
  authReturnPath: string;
  cookies: { secure: boolean; hostPrefix: boolean };
  session: { idleMs: number; absoluteMs: number; stepUpMs: number; touchIntervalMs: number };
  password: { minLength: number; maxLength: number; memoryCost: number; timeCost: number; parallelism: number };
  tokens: { verifyEmailMs: number; recoveryMs: number; emailChangeMs: number; invitationMs: number };
  lockout: { windowSeconds: number; accountThreshold: number; ipThreshold: number; disableThreshold: number; disableWindowSeconds: number; retentionSeconds: number };
  rateLimit: { authPerMinute: number };
  idempotency: { retentionMs: number };
  /** `disabled` (default): no provider routes; `fake`: scriptable adapters (never in production); `live`: openid-client adapters. */
  providers: { mode: 'disabled' | 'fake' | 'live'; google: OidcClientConfig | null; apple: OidcClientConfig | null };
  production: boolean;
  /** HMAC key for the pre-login flow cookie; generated per process when unset (multi-node deployments must set it). */
  flowSecret: Buffer;
  termsVersion: string;
}
export interface OidcClientConfig { clientId: string; clientSecret: string }

function int(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${key} must be a non-negative integer`);
  return value;
}
function bool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw new Error(`${key} must be true/false`);
}

export function apiConfigFromEnv(env: NodeJS.ProcessEnv): ApiConfig {
  const host = env.API_HOST ?? '127.0.0.1';
  const port = int(env, 'API_PORT', 3001);
  const insecure = bool(env, 'API_INSECURE_COOKIES', false);
  const flowSecret = env.AUTH_FLOW_SECRET ? Buffer.from(env.AUTH_FLOW_SECRET, 'hex') : randomBytes(32);
  if (flowSecret.length < 32) throw new Error('AUTH_FLOW_SECRET must be at least 32 bytes of hex');
  const modeRaw = env.AUTH_PROVIDER_MODE ?? 'disabled';
  if (modeRaw !== 'disabled' && modeRaw !== 'fake' && modeRaw !== 'live') throw new Error('AUTH_PROVIDER_MODE must be disabled, fake or live');
  const production = env.NODE_ENV === 'production';
  if (modeRaw === 'fake' && production) throw new Error('AUTH_PROVIDER_MODE=fake is not allowed with NODE_ENV=production');
  const mode = modeRaw;
  const client = (prefix: string): OidcClientConfig | null =>
    env[`${prefix}_CLIENT_ID`] && env[`${prefix}_CLIENT_SECRET`] ? { clientId: env[`${prefix}_CLIENT_ID`] as string, clientSecret: env[`${prefix}_CLIENT_SECRET`] as string } : null;
  return {
    host,
    port,
    publicOrigin: env.PUBLIC_ORIGIN ?? `http://${host}:${port}`,
    authReturnPath: env.AUTH_RETURN_PATH ?? '/',
    cookies: { secure: !insecure, hostPrefix: !insecure },
    session: {
      idleMs: int(env, 'SESSION_IDLE_MINUTES', 30) * 60_000,
      absoluteMs: int(env, 'SESSION_ABSOLUTE_HOURS', 12) * 3_600_000,
      stepUpMs: env.SESSION_STEP_UP_MINUTES ? int(env, 'SESSION_STEP_UP_MINUTES', 10) * 60_000 : STEP_UP_FRESHNESS_MS,
      touchIntervalMs: 5 * 60_000,
    },
    password: {
      minLength: int(env, 'PASSWORD_MIN_LENGTH', DEFAULT_PASSWORD_POLICY.minLength),
      maxLength: DEFAULT_PASSWORD_POLICY.maxLength,
      memoryCost: int(env, 'ARGON2_MEMORY_KIB', 19456),
      timeCost: int(env, 'ARGON2_TIME_COST', 2),
      parallelism: int(env, 'ARGON2_PARALLELISM', 1),
    },
    tokens: {
      verifyEmailMs: int(env, 'TOKEN_VERIFY_EMAIL_HOURS', 24) * 3_600_000,
      recoveryMs: int(env, 'TOKEN_RECOVERY_MINUTES', 30) * 60_000,
      emailChangeMs: int(env, 'TOKEN_EMAIL_CHANGE_HOURS', 24) * 3_600_000,
      invitationMs: int(env, 'TOKEN_INVITATION_DAYS', 7) * 86_400_000,
    },
    lockout: {
      windowSeconds: int(env, 'AUTH_LOCKOUT_WINDOW_MINUTES', 15) * 60,
      accountThreshold: int(env, 'AUTH_LOCKOUT_THRESHOLD', 5),
      ipThreshold: int(env, 'AUTH_LOCKOUT_IP_THRESHOLD', 50),
      disableThreshold: int(env, 'AUTH_DISABLE_THRESHOLD', 100),
      disableWindowSeconds: 24 * 3_600,
      retentionSeconds: 24 * 3_600,
    },
    rateLimit: { authPerMinute: int(env, 'AUTH_RATE_LIMIT_PER_MINUTE', 60) },
    idempotency: { retentionMs: int(env, 'IDEMPOTENCY_RETENTION_HOURS', 24) * 3_600_000 },
    providers: { mode, google: client('GOOGLE'), apple: client('APPLE') },
    production,
    flowSecret,
    termsVersion: env.TERMS_VERSION ?? 'draft-2026-10',
  };
}
