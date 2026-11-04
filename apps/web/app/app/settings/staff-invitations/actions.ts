'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { sessionPost, type SessionPostAnswer } from '@/app/_lib/data/http/session-post';
import { demoModeEnabled } from '@/app/_lib/persona';

const SETTINGS = '/app/settings';
const RefusalSchema = z.object({ details: z.object({ required: z.string() }) });

/** The word the section shows for an answer of the API (`settings.staffInvitations.result.*`). */
function resultOf(answer: SessionPostAnswer, accept: boolean): string {
  if (answer.status >= 200 && answer.status < 300) return accept ? 'accepted' : 'declined';
  if (answer.status === 403 && RefusalSchema.safeParse(answer.body).data?.details.required === 'second_factor') return 'second_factor';
  // Unknown to this person, already answered, withdrawn or expired: to them the invitation is simply no longer open.
  if (answer.status === 404 || answer.status === 409) return 'gone';
  return 'failed';
}

/**
 * The invited person answers (`POST /v1/me/staff-invitations/:id/respond`). The API decides: only the person whose
 * verified address the invitation names gets past it, and accepting needs an active second factor. A server action with
 * a redirect adds no client JavaScript; the settings section words the result. A demo stores nothing.
 */
export async function respondToStaffInvitation(form: FormData): Promise<void> {
  const id = z.uuid().safeParse(form.get('invitationId'));
  if (demoModeEnabled() || !id.success) redirect(SETTINGS);
  const accept = form.get('accept') === 'yes';
  const answer = await sessionPost(`/v1/me/staff-invitations/${id.data}/respond`, { accept }, randomUUID());
  redirect(`${SETTINGS}?invitation=${resultOf(answer, accept)}#staff-invitations`);
}
