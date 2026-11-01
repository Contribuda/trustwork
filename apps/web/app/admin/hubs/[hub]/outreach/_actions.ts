'use server';

import { t, tDynamic } from '@/app/_lib/i18n';
import type { CommandState } from '../../../_data/command-state';
import { runSectionCommandWith, sectionMessage } from '../participants/_section-runner';
import { evaluateOutreach, type OutreachOutcome } from './_commands';

function outreachMessage(outcome: OutreachOutcome): CommandState {
  if (!('outreach' in outcome)) return sectionMessage(outcome);
  const at = Date.now();
  if (outcome.status === 'rejected') return { status: 'rejected', tone: 'error', at, message: tDynamic(`adminOutreach.errors.${outcome.code}`, t('admin.errors.invalid')) };
  return { status: 'done', tone: 'info', at, message: tDynamic(`adminOutreach.outcomes.${outcome.kind}`, t('admin.common.demoNotSaved')) };
}

/** The server action behind every outreach form (OUTR-004): it re-resolves the viewer and evaluates on the server. */
export async function submitOutreachCommand(_previous: CommandState, form: FormData): Promise<CommandState> {
  return runSectionCommandWith(form, evaluateOutreach, outreachMessage);
}
