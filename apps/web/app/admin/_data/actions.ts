'use server';

import { runWithLocaleScope } from '@trustwork/i18n-runtime';
import { demoModeEnabled } from '@/app/_lib/persona';
import { t, tDynamic } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';
import { languageName, violationLabel } from '../_components/format';
import { isCommandId, type CommandInput, type CommandOutcome } from './commands';
import type { CommandState } from './command-state';
import { consolePort } from './server';
import { resolveConsoleRequest } from './personas';

const FIELD_PREFIX = 'f.';

/** Human labels for the codes a rejection lists (gates, modules, mode violations, languages, install checks). */
function detailLabel(code: string): string {
  if (/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/.test(code)) return languageName(code);
  if (code.startsWith('module_') || /_only_|_never_|_before_|_after_/.test(code)) return violationLabel(code);
  return tDynamic(`admin.hub.launch.gates.${code}`, tDynamic(`admin.hub.modules.names.${code}`, tDynamic(`admin.setup.check.items.${code}`, code)));
}

function message(outcome: CommandOutcome): CommandState {
  const at = Date.now();
  if (outcome.status === 'demo_not_saved') {
    return outcome.secondPerson
      ? { status: 'done', tone: 'info', at, message: t('admin.common.demoSecondPerson', { action: tDynamic(`admin.approvals.actions.${outcome.secondPerson}`, outcome.secondPerson) }) }
      : { status: 'done', tone: 'info', at, message: t('admin.common.demoNotSaved') };
  }
  if (outcome.status === 'applied') return { status: 'done', tone: 'info', at, message: t('admin.common.applied') };
  if (outcome.status === 'not_found') return { status: 'rejected', tone: 'error', at, message: t('admin.errors.not_found') };
  const items = outcome.detail.map(detailLabel).join(', ');
  return { status: 'rejected', tone: outcome.code === 'stale' ? 'warning' : 'error', at, message: tDynamic(`admin.errors.${outcome.code}`, t('admin.errors.invalid'), { items }) };
}

/**
 * The one server action behind every console form (ADM-002). It never trusts the page: it resolves the viewer again
 * (demo persona from the hidden field only in demo mode; live mode has no console backend yet, so `not_found`),
 * re-reads the hub and evaluates the command with the shared authorization and invariants. In demo mode nothing is
 * stored; the answer is a localized message for the form's live region.
 */
export async function submitConsoleCommand(_previous: CommandState, form: FormData): Promise<CommandState> {
  // Server actions run outside the React render scope: give the request its own locale scope (like route handlers).
  return runWithLocaleScope(() => evaluate(form));
}

async function evaluate(form: FormData): Promise<CommandState> {
  await primeLocale();
  const enabled = demoModeEnabled();
  const request = resolveConsoleRequest(form, enabled);
  const command = form.get('command');
  if (!isCommandId(command)) return { status: 'rejected', tone: 'error', at: Date.now(), message: t('admin.errors.invalid') };
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === 'string' ? value : '';
  };
  const fields: Record<string, string> = {};
  for (const [key, value] of form.entries()) if (key.startsWith(FIELD_PREFIX) && typeof value === 'string') fields[key.slice(FIELD_PREFIX.length)] = value;
  const revision = Number.parseInt(text('expectedRevision'), 10);
  const input: CommandInput = {
    command,
    hubSlug: text('hub') || null,
    setupToken: text('token') || null,
    reason: text('reason'),
    expectedRevision: Number.isInteger(revision) ? revision : null,
    fields,
  };
  return message(await consolePort(enabled).command(request, input));
}
