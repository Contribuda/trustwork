import type { Harness } from '../../helpers/app.js';
import { company, publishRfq, quotePayload, rfqPayload, seedWorld, sendQuote, signIn } from '../../../sourcing/helpers.js';
import type { CrashCase } from '../cases.js';

const count = async (h: Harness, query: string, params: unknown[]): Promise<number> => (await h.db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${query}) q`, params)).rows[0]?.n ?? 0;

/**
 * PRC-004: every sourcing route that completes in its transaction, crashed before COMMIT and retried: saving eligibility
 * rules, opening, saving and freezing a levelling sheet. The companies and their people are synthetic.
 */
export default {
  name: 'PRC-004: sourcing eligibility rules and levelling sheets',
  async run({ h, exactlyOnce }) {
    const w = await seedWorld(h, 'crash-sourcing');
    const [ada, rita, sam] = [await signIn(h, 'ada', 'crash-sourcing'), await signIn(h, 'rita', 'crash-sourcing'), await signIn(h, 'sam', 'crash-sourcing')];
    const rfq = await publishRfq(ada, company(w.buyer), rfqPayload(), [company(w.supplierA)]);
    await sendQuote(sam, rfq, company(w.supplierA), quotePayload('3000'));
    const id = rfq.rfq.id;

    await exactlyOnce({
      action: 'sourcing.eligibility_save', client: rita, url: `/v1/sourcing/rfqs/${id}/eligibility`, body: { rules: [{ kind: 'screening_clear' }], expectedRevision: null },
      effects: () => count(h, 'SELECT 1 FROM trustwork.sourcing_eligibility_rule_set WHERE rfq_id = $1', [id]),
    });

    const template = (await rita.get(`/v1/sourcing/rfqs/${id}/level-sheet/template`)).body as { payload: unknown };
    const opened = (await exactlyOnce({
      action: 'sourcing.sheet_draft', client: rita, url: `/v1/sourcing/rfqs/${id}/level-sheet/versions`, body: { rfqId: id, rfqVersionId: rfq.rfq.currentVersionId, payload: template.payload },
      effects: () => count(h, 'SELECT 1 FROM trustwork.bid_level_sheet_version WHERE rfq_id = $1', [id]),
    })).body as { version: { id: string }; revision: number };

    const saved = (await exactlyOnce({
      action: 'sourcing.sheet_save', client: rita, url: `/v1/sourcing/level-sheet-versions/${opened.version.id}`, body: { payload: template.payload, expectedRevision: opened.revision },
      effects: () => count(h, 'SELECT 1 FROM trustwork.audit_event WHERE action = $1 AND object_id = $2', ['sourcing.sheet_saved', opened.version.id]),
    })).body as { version: { digest: unknown }; revision: number };

    await exactlyOnce({
      action: 'sourcing.sheet_freeze', client: rita, url: `/v1/sourcing/level-sheet-versions/${opened.version.id}/freeze`, body: { digest: saved.version.digest, expectedRevision: saved.revision },
      effects: () => count(h, "SELECT 1 FROM trustwork.bid_level_sheet_version WHERE id = $1 AND status = 'frozen'", [opened.version.id]),
    });
  },
} satisfies CrashCase;
