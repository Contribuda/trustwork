/** Entry point kept for the API bootstrap; the implementation lives in `common/idempotency/` (BE-005). */
export { IdempotencyInterceptor, IDEMPOTENCY_TAKEOVER_LEASE_MS } from './idempotency/index.js';
