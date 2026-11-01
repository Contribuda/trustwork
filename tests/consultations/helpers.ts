import { withMaintenance } from '@trustwork/data';
import type { Harness } from '../backend/helpers/app.js';
import { workerLogin } from '../assistant/helpers.js';
import { activateList, CONS_ENTRIES, screen, SDN_ENTRIES } from '../screening/helpers.js';
import { baselineIds } from '../screening-lists/helpers.js';

/**
 * Screens synthetic subjects against the synthetic baseline lists through the real SANC-003 worker path, so the
 * consultation screening gate (which fails closed for anyone unscreened) lets them bind commitments. Activates the
 * baseline lists only when none is active yet (a crash-test world may already have them). Every name is synthetic.
 */
export async function screenClear(h: Harness, subjects: readonly { kind: 'person' | 'company'; id: string }[]): Promise<void> {
  const workers = await workerLogin(h);
  try {
    const worker = workers.pool(2);
    const active = await h.db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.screening_list_version v JOIN trustwork.screening_list l ON l.id = v.list_id WHERE l.baseline AND v.state = 'active'");
    if ((active.rows[0]?.n ?? 0) < 2) {
      await withMaintenance(h.db.admin, (trx) => trx.updateTable('screening_list').set({ min_entries: 1, max_drop_share: '0.99' }).where('baseline', '=', true).execute());
      const lists = await baselineIds(h.db.admin);
      await activateList(worker, lists.sdn, SDN_ENTRIES);
      await activateList(worker, lists.cons, CONS_ENTRIES);
    }
    for (const subject of subjects) {
      const result = await screen(worker, subject);
      if (result.outcome !== 'clear') throw new Error(`synthetic subject ${subject.kind}/${subject.id} screened ${result.outcome}`);
    }
  } finally {
    await workers.close();
  }
}
