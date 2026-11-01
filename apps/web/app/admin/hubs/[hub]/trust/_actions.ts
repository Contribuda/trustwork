'use server';

import type { CommandState } from '../../../_data/command-state';
import { runSectionCommand } from '../participants/_section-runner';
import { evaluateTrust } from './_commands';

/** The server action behind every trust form (HUBC-004): it re-resolves the viewer and evaluates on the server. */
export async function submitTrustCommand(_previous: CommandState, form: FormData): Promise<CommandState> {
  return runSectionCommand(form, evaluateTrust);
}
