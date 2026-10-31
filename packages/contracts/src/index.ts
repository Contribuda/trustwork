/**
 * @trustwork/contracts — frozen v1 domain and API contracts (FND-002).
 * Zod 4 schemas are the single source of truth; inferred types are exported beside them.
 * This server barrel adds digest computation (node:crypto) and the server-only commercial guards to `./client`.
 */
export * from './client.js';
export { computeDigest, verifyDigest } from './common/digest.js';
export * from './server/commercial.js';
