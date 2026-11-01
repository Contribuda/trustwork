import pg from 'pg';
import { PrivacyErasureLedger, type LocalJournalBinding, type LocalJournalStep } from '../../../apps/api/src/modules/platform-admin/privacy/ledger.js';
import type { PrivacyTombstone } from '../../../packages/contracts/src/privacy.js';
import { authorizeLocalPrivacyRestore } from '../../../scripts/restore/reconcile.js';
import { RoleFence } from '../../../scripts/restore/fence.js';

// IPC contains only generated local fixture configuration; never writes connection strings to logs.
interface Command { binding: LocalJournalBinding; action: 'record' | 'restore'; record?: PrivacyTombstone;
  pause?: LocalJournalStep | 'before_lift'; databaseUrl?: string; login?: string; restoreId?: string }
async function pause(stage: string) {
  process.send?.({ stage });
  await new Promise<void>((resolve) => process.once('message', () => resolve()));
}
process.once('message', async (command: Command) => {
  let pool: pg.Pool | undefined;
  try {
    const ledger = new PrivacyErasureLedger(command.binding, async (step) => {
      if (step === command.pause) await pause(step);
    });
    if (command.action === 'record') await ledger.record(command.record!);
    else {
      pool = new pg.Pool({ connectionString: command.databaseUrl, max: 2 });
      const fence = new RoleFence(pool, [command.login!]);
      await authorizeLocalPrivacyRestore({ admin: pool, privacyLedger: ledger, retainedAuthority: { directory: command.binding.authorityDirectory, journalId: command.binding.journalId }, restoreId: command.restoreId!,
        reference: 'synthetic-process-proof', operator: 'synthetic-process', fence: {
          kind: 'role', apply: () => fence.apply(), isApplied: () => fence.isApplied(), describe: () => fence.describe(),
          async lift() {
            if (command.pause === 'before_lift') await pause('before_lift');
            await fence.lift();
          },
        } });
    }
    process.send?.({ done: true });
  } catch (error) { process.send?.({ error: (error as Error).message }); process.exitCode = 1; }
  finally { await pool?.end(); process.disconnect(); }
});
