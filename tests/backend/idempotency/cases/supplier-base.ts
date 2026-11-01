import type { Harness } from '../../helpers/app.js';
import { seedWorld, signIn, syncKernel } from '../../../supplier-base/helpers.js';
import type { CrashCase } from '../cases.js';

const count = async (h: Harness, query: string, params: unknown[]): Promise<number> => (await h.db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${query}) q`, params)).rows[0]?.n ?? 0;

/**
 * PRC-003: every supplier base route that completes in its transaction, crashed before COMMIT and retried: adding and
 * changing a supplier record, creating and changing a counterparty, drafting and recording an assessment, the
 * supplier's answer and an import. The companies and their people are synthetic.
 */
export default {
  name: 'PRC-003: supplier base records, counterparties, assessments and import',
  async run({ h, exactlyOnce }) {
    await syncKernel(h.db.admin);
    const w = await seedWorld(h, 'crash');
    const [rita, sam] = [await signIn(h, 'rita', 'crash'), await signIn(h, 'sam', 'crash')];
    const key = (action: string) => `crash-${action}`;

    const counterparty = (await exactlyOnce({
      action: 'supplier_base.counterparty_create', client: rita, url: '/v1/supplier-base/counterparties',
      body: { name: 'Synthetic Crash Counterparty', identifiers: [], contacts: [] },
      effects: () => count(h, 'SELECT 1 FROM trustwork.external_counterparty WHERE owner_company_id = $1', [w.buyer]),
    })).body as { counterparty: { id: string; revision: number } };
    await exactlyOnce({
      action: 'supplier_base.counterparty_update', client: rita, url: `/v1/supplier-base/counterparties/${counterparty.counterparty.id}`,
      body: { name: 'Synthetic Crash Counterparty Renamed', expectedRevision: counterparty.counterparty.revision, idempotencyKey: key('supplier_base.counterparty_update') },
      effects: () => count(h, "SELECT 1 FROM trustwork.external_counterparty WHERE id = $1 AND name = 'Synthetic Crash Counterparty Renamed'", [counterparty.counterparty.id]),
    });

    const record = (await exactlyOnce({
      action: 'supplier_base.maintain', client: rita, url: '/v1/supplier-base/suppliers',
      body: { supplierRecordId: null, link: { kind: 'company', id: w.supplier }, status: 'approved', expectedRevision: 1, idempotencyKey: key('supplier_base.maintain') },
      effects: () => count(h, 'SELECT 1 FROM trustwork.supplier_record WHERE owner_company_id = $1', [w.buyer]),
    })).body as { record: { id: string } };

    const draft = (await exactlyOnce({
      action: 'supplier_base.assessment_draft', client: rita, url: `/v1/supplier-base/suppliers/${record.record.id}/assessments`,
      body: { supplierRecordId: record.record.id, criteriaVersion: 1, period: { from: '2026-07-01', to: '2026-09-30' }, scores: [{ criterion: 'on_time', value: 4, evidenceRefs: [] }] },
      effects: () => count(h, 'SELECT 1 FROM trustwork.supplier_assessment WHERE supplier_record_id = $1', [record.record.id]),
    })).body as { assessment: { id: string; revision: number } };
    await exactlyOnce({
      action: 'supplier_base.assessment_record', client: rita, url: `/v1/supplier-base/assessments/${draft.assessment.id}/record`,
      body: { supplierRecordId: record.record.id, assessmentDraftId: draft.assessment.id, shareWithSupplier: true, expectedRevision: draft.assessment.revision, idempotencyKey: key('supplier_base.assessment_record') },
      effects: () => count(h, "SELECT 1 FROM trustwork.supplier_assessment WHERE id = $1 AND status = 'recorded'", [draft.assessment.id]),
    });
    await exactlyOnce({
      action: 'supplier_base.assessment_respond', client: sam, url: `/v1/supplier-base/shared-assessments/${draft.assessment.id}/respond`,
      body: { response: 'Synthetic crash answer', expectedRevision: draft.assessment.revision + 1 },
      effects: () => count(h, 'SELECT 1 FROM trustwork.supplier_assessment WHERE id = $1 AND supplier_response IS NOT NULL', [draft.assessment.id]),
    });

    await exactlyOnce({
      action: 'supplier_base.import', client: rita, url: '/v1/supplier-base/import',
      body: { file: { format: 'csv', text: 'name,regions\nSynthetic Crash Import One,US-TX\n' } },
      effects: () => count(h, "SELECT 1 FROM trustwork.external_counterparty WHERE owner_company_id = $1 AND source = 'import'", [w.buyer]),
    });
  },
} satisfies CrashCase;
