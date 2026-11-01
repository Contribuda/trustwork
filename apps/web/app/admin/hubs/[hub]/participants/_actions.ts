'use server';

import type { CommandState } from '../../../_data/command-state';
import { runSectionCommand } from './_section-runner';
import { evaluateParticipants } from './_commands';

/** The server action behind every participants form (HUBC-004): it re-resolves the viewer and evaluates on the server. */
export async function submitParticipantsCommand(_previous: CommandState, form: FormData): Promise<CommandState> {
  return runSectionCommand(form, evaluateParticipants);
}
