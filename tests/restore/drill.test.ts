import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RestoreDrillSchema } from '@trustwork/contracts';
import { DEFAULT_DRILL, runDrill } from '../../scripts/restore/drill.js';

/**
 * The full restore drill (OPS-003) with Docker: opt-in because it starts its own PostgreSQL containers and takes about
 * a minute. CI runs it in .github/workflows/restore-drill.yml; locally:
 *   TRUSTWORK_RESTORE_DRILL=1 node scripts/run-tests.mjs tests/restore
 * or directly: node --import tsx scripts/restore/drill.ts --evidence <file>
 */
const enabled = process.env.TRUSTWORK_RESTORE_DRILL === '1';

test('OPS-003 restore drill: PITR into an isolated project, tombstone replay, reconciliation, measured RPO and RTO', { skip: enabled ? false : 'SKIPPED: set TRUSTWORK_RESTORE_DRILL=1 (needs Docker; CI runs it in the restore-drill workflow)', timeout: 900_000 }, async () => {
  const evidencePath = process.env.TRUSTWORK_RESTORE_DRILL_EVIDENCE ?? null;
  const evidence = await runDrill({ ...DEFAULT_DRILL, evidencePath, log: (line) => console.log(`[drill] ${line}`) });
  const failed = evidence.checks.filter((c) => !c.ok);
  assert.deepEqual(failed, [], 'every drill check passed');
  assert.equal(RestoreDrillSchema.parse(evidence.drill).outcome, 'passed');
  assert.ok(evidence.measurements.withinTargets);
  assert.ok(evidence.measurements.recoverySeconds <= evidence.measurements.targets.rtoSeconds);
  assert.ok(evidence.measurements.dataLossWindowSeconds <= evidence.measurements.targets.rpoSeconds);
  assert.equal(evidence.providerCalls.duringFence, 0, 'no provider call while the restore was fenced');
  assert.equal(evidence.providerCalls.duplicatesAfterRestore, 0, 'no effect sent twice');
  if (evidencePath) assert.equal(JSON.parse(readFileSync(evidencePath, 'utf8')).drill.id, evidence.drill.id);
});
