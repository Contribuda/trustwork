import { z } from 'zod';
import { createTransport } from '@/app/_lib/data/http/transport';
import { MyStaffInvitationSchema, type MyStaffInvitation } from '../../../../../../packages/contracts/src/staff-lifecycle.js';

const InvitationsSchema = z.object({ invitations: z.array(MyStaffInvitationSchema) });
const SecondFactorSchema = z.object({ enrolled: z.boolean() });

const transport = createTransport();

/** The visitor's own open staff invitations (`GET /v1/me/staff-invitations`, by their verified addresses). */
export async function myStaffInvitations(): Promise<MyStaffInvitation[]> {
  const view = InvitationsSchema.safeParse(await transport.get('/v1/me/staff-invitations'));
  return view.success ? view.data.invitations : [];
}

/** Whether the visitor has an active second factor, which accepting needs (`GET /v1/me/second-factor`). */
export async function hasSecondFactor(): Promise<boolean> {
  return SecondFactorSchema.safeParse(await transport.get('/v1/me/second-factor')).data?.enrolled ?? false;
}

/** The demo's one example: synthetic, labelled on the page, with its controls disabled. */
export const DEMO_INVITATION: MyStaffInvitation = {
  id: 'demo-invitation', role: 'editor', scope: { kind: 'hub', hubId: 'hub-us-demo' }, validForSeconds: 90 * 86_400, reason: 'Synthetic invitation for the demo', inviterName: 'Synthetic Hub Owner',
  expiresAt: '2026-11-05T09:00:00Z',
};
