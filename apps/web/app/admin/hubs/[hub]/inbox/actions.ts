'use server';

import { runWithLocaleScope } from '@trustwork/i18n-runtime';
import { demoModeEnabled } from '@/app/_lib/persona';
import { primeLocale } from '@/app/_lib/locale';
import { t, tDynamic } from '@/app/_lib/i18n';
import { resolveConsoleRequest } from '../../../_data/personas';
import { consolePort } from '../../../_data/server';
import type { CommandState } from '../../../_data/command-state';
import { inboxCommand } from './authority';
import { FixtureReceiptSchema, type FixtureReceipt } from './transaction';

export type InboxResult = { state: CommandState; receipt: FixtureReceipt | null };

async function run(form: FormData, reconcile: boolean): Promise<InboxResult> {
  return runWithLocaleScope(async () => {
    await primeLocale();
    const text = (name: string) => typeof form.get(name) === 'string' ? String(form.get(name)) : '';
    const command = text('command');
    if (command !== 'approvals.decide') return { state: { status: 'rejected', tone: 'error', at: Date.now(), message: t('admin.errors.not_found') }, receipt: null };
    const demo = demoModeEnabled();
    const outcome = await inboxCommand(consolePort(demo), resolveConsoleRequest(form, demo), {
      command, hubSlug: text('hub'), setupToken: null, expectedRevision: Number(text('expectedRevision')), reason: text('reason'),
      fields: { requestId: text('f.requestId'), digest: text('f.digest'), decision: text('f.decision') },
    }, text('actor'), reconcile);
    const message = outcome.status === 'demo_not_saved' ? t('consoleNav.synthetic') : outcome.status === 'not_found' ? t('admin.errors.not_found') : tDynamic(`admin.errors.${outcome.code}`, t('admin.errors.invalid'));
    let receipt: FixtureReceipt | null = null;
    if (!reconcile && outcome.status === 'demo_not_saved') {
      const port = consolePort(demo);
      const request = resolveConsoleRequest(form, demo);
      const hub = await port.hub(text('hub'), request);
      const item = hub ? (await port.approvals(hub.hub.id)).requests.find((row) => row.id === text('f.requestId')) : null;
      if (hub && item) {
        const at = port.now().toISOString();
        const operationId = text('operationId');
        const approved = text('f.decision') === 'approve';
        receipt = FixtureReceiptSchema.parse({ operationId, digest: item.actionDigest.value, decision: {
          synthetic: true, requestId: item.id, hubId: hub.hub.id, action: item.action, requestedBy: item.requestedBy,
          decision: approved ? 'approve' : 'decline', decidedBy: text('actor'), decidedAt: at,
          approval: approved ? { id: operationId, action: item.action, scope: item.scope, actionDigest: item.actionDigest, requestedBy: item.requestedBy, approvedBy: text('actor'), approvedAt: at, expiresAt: item.expiresAt, revokedAt: null } : null,
        } });
      }
    }
    return { state: { status: outcome.status === 'demo_not_saved' ? 'done' : 'rejected', tone: outcome.status === 'demo_not_saved' ? 'info' : 'error', at: Date.now(), message }, receipt };
  });
}
export async function decideInbox(form: FormData): Promise<InboxResult> { return run(form, false); }
export async function reconcileInbox(form: FormData): Promise<InboxResult> { return run(form, true); }
