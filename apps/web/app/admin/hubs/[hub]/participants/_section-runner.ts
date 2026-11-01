import { runWithLocaleScope } from '@trustwork/i18n-runtime';
import { demoModeEnabled } from '@/app/_lib/persona';
import { formatDate, t, tDynamic } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';
import type { CommandState } from '../../../_data/command-state';
import { consolePort } from '../../../_data/server';
import { resolveConsoleRequest } from '../../../_data/personas';
import type { SectionCommandContext, SectionCommandInput, SectionEvaluator, SectionOutcome } from './_section-command';

/** The server-side runner of HUBC-004's section commands (server only; each group's `_actions.ts` calls it). */

const FIELD_PREFIX = 'f.';

/** The localized answer of a section command for the form's live region and toast. */
export function sectionMessage(outcome: SectionOutcome): CommandState {
  const at = Date.now();
  if (outcome.status === 'not_found') return { status: 'rejected', tone: 'error', at, message: t('admin.errors.not_found') };
  if (outcome.status === 'rejected') {
    const fallback = tDynamic(`admin.errors.${outcome.code}`, t('admin.errors.invalid'), { items: '' });
    return { status: 'rejected', tone: 'error', at, message: tDynamic(`adminParticipants.errors.${outcome.code}`, fallback) };
  }
  const action = outcome.secondPerson ? tDynamic(`admin.approvals.actions.${outcome.secondPerson}`, outcome.secondPerson) : '';
  return { status: 'done', tone: 'info', at, message: tDynamic(`adminParticipants.outcomes.${outcome.kind}`, t('admin.common.demoNotSaved'), { action, date: outcome.date ? formatDate(outcome.date, 'long') : '' }) };
}

/**
 * The runner behind every HUBC-004 server action. It never trusts the page: the demo persona is read from the hidden
 * field only in demo mode, the viewer, hub and access are resolved again, and the group's evaluator decides.
 */
export async function runSectionCommand(form: FormData, evaluate: SectionEvaluator): Promise<CommandState> {
  return runSectionCommandWith(form, evaluate, sectionMessage);
}

/** The same runner with a group's own outcomes and messages (OUTR-004's outreach commands). */
export async function runSectionCommandWith<O>(form: FormData, evaluate: (input: SectionCommandInput, ctx: SectionCommandContext) => O, message: (outcome: O) => CommandState): Promise<CommandState> {
  return runWithLocaleScope(async () => {
    await primeLocale();
    const enabled = demoModeEnabled();
    const request = resolveConsoleRequest(form, enabled);
    const port = consolePort(enabled);
    const text = (name: string) => {
      const value = form.get(name);
      return typeof value === 'string' ? value : '';
    };
    const command = text('command');
    if (!/^[a-z][a-z_]*\.[a-z][a-z_]*$/.test(command)) return { status: 'rejected', tone: 'error', at: Date.now(), message: t('admin.errors.invalid') };
    const fields: Record<string, string> = {};
    for (const [key, value] of form.entries()) if (key.startsWith(FIELD_PREFIX) && typeof value === 'string') fields[key.slice(FIELD_PREFIX.length)] = value;
    const viewer = await port.viewer(request);
    const slug = text('hub');
    const hub = slug ? await port.hub(slug, request) : null;
    const access = viewer && hub ? await port.access(viewer, { nodeId: hub.hub.nodeId, hubId: hub.hub.id }) : { roles: [], permissions: [] };
    const revision = Number.parseInt(text('expectedRevision'), 10);
    const outcome = evaluate(
      { command, reason: text('reason'), expectedRevision: Number.isInteger(revision) ? revision : null, fields },
      { viewer, access, hub, now: port.now(), offline: request.demo && request.scenario === 'offline' },
    );
    return message(outcome);
  });
}
