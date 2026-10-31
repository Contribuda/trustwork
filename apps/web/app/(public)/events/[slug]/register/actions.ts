'use server';

import { redirect } from 'next/navigation';
import { data } from '@/app/_lib/data';
import { encodeTicket } from '@/app/_lib/events';

/**
 * Registration (demo): validates the form, encodes the participant into a signed-less token and redirects to the
 * ticket page for free tickets or to the demo payment page for paid ones. Nothing is stored; the stand has no server.
 */
export async function registerAction(formData: FormData): Promise<void> {
  const slug = String(formData.get('slug') ?? '');
  const ticketId = String(formData.get('ticket') ?? '');
  const name = String(formData.get('name') ?? '').trim();
  const email = String(formData.get('email') ?? '').trim();
  const company = String(formData.get('company') ?? '').trim();
  const qty = Math.min(10, Math.max(1, Number.parseInt(String(formData.get('qty') ?? '1'), 10) || 1));
  const agree = formData.get('agree') === 'on';
  const event = data.getEvent(slug);
  const ticket = event?.tickets.find((tk) => tk.id === ticketId);
  const back = (error: string) =>
    redirect(`/events/${slug}/register?ticket=${encodeURIComponent(ticketId)}&error=${error}&name=${encodeURIComponent(name)}&email=${encodeURIComponent(email)}&company=${encodeURIComponent(company)}&qty=${qty}`);
  if (!event || !ticket || !ticket.available) back('ticket');
  if (name.length < 3 || !name.includes(' ')) back('name');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) back('email');
  if (!agree) back('agree');
  const token = encodeTicket({ slug, ticketId, name, email, company, qty, paid: ticket!.priceMinorUnits === 0 });
  if (ticket!.priceMinorUnits > 0) redirect(`/events/${slug}/pay?t=${token}`);
  redirect(`/events/${slug}/ticket?t=${token}`);
}

/** Demo payment: flips the token to paid and shows the ticket. No provider is connected. */
export async function payAction(formData: FormData): Promise<void> {
  const slug = String(formData.get('slug') ?? '');
  const token = String(formData.get('t') ?? '');
  const { decodeTicket } = await import('@/app/_lib/events');
  const parsed = decodeTicket(token);
  if (!parsed || parsed.slug !== slug) redirect(`/events/${slug}`);
  redirect(`/events/${slug}/ticket?t=${encodeTicket({ ...parsed!, paid: true })}`);
}
