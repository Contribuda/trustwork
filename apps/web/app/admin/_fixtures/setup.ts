import { createHash } from 'node:crypto';
import { SetupRunSchema, type SetupRun } from '../_data/schemas.js';

/**
 * Demo setup runs for the wizard (`/admin/setup/[step]?token=…`, demo mode only). The tokens below are public demo
 * values printed in this file on purpose: they unlock nothing but these synthetic runs, and only the SHA-256 hash is
 * kept in the state, as the contract requires (`SetupStateSchema.setupTokenHash`). The demo node itself finished
 * setup, so without a token every setup route is "not found".
 */
export const DEMO_SETUP_TOKEN = 'demo-setup-token-0001';
/** A run that has not started: its install check reports a blocking failure, so nothing after step 1 can be reached. */
export const DEMO_FRESH_SETUP_TOKEN = 'demo-setup-token-fresh';

export const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

const ALL_BUT_REVIEW = ['install_check', 'node_identity', 'hub_identity', 'operator', 'first_admin', 'storage_residency', 'providers', 'modes'] as const;

export const SETUP_RUNS: readonly SetupRun[] = [
  SetupRunSchema.parse({
    synthetic: true,
    state: {
      nodeId: 'node-setup-demo',
      completed: [...ALL_BUT_REVIEW],
      current: 'review',
      setupTokenHash: sha256(DEMO_SETUP_TOKEN),
      setupTokenExpiresAt: '2026-11-01T12:00:00Z',
      firstAdmin: { personId: 'p-hub-owner', secondFactor: 'webauthn', recoveryCodesIssuedAt: '2026-10-31T11:20:00Z' },
      startedAt: '2026-10-31T11:00:00Z',
      finishedAt: null,
    },
    checks: [
      { id: 'address', state: 'pass' },
      { id: 'database', state: 'pass' },
      { id: 'object_storage', state: 'pass' },
      { id: 'worker', state: 'pass' },
      { id: 'clock', state: 'warn' },
      { id: 'secret_store', state: 'pass' },
    ],
  }),
  SetupRunSchema.parse({
    synthetic: true,
    state: {
      nodeId: 'node-setup-fresh',
      completed: [],
      current: 'install_check',
      setupTokenHash: sha256(DEMO_FRESH_SETUP_TOKEN),
      setupTokenExpiresAt: '2026-11-01T12:00:00Z',
      firstAdmin: null,
      startedAt: '2026-10-31T11:55:00Z',
      finishedAt: null,
    },
    checks: [
      { id: 'address', state: 'pass' },
      { id: 'database', state: 'pass' },
      { id: 'object_storage', state: 'pass' },
      { id: 'worker', state: 'fail' },
      { id: 'clock', state: 'pass' },
      { id: 'secret_store', state: 'pass' },
    ],
  }),
];
