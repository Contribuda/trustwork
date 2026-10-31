import { data } from '@/app/_lib/data';
import { primeLocale } from '@/app/_lib/locale';

const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const escape = (s: string) =>
  s
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/[,;]/g, (m) => `\\${m}`);

/** iCalendar file for one event (UTC timestamps; calendar apps convert to the user's zone). */
export async function GET(_request: Request, context: { params: Promise<{ slug: string }> }) {
  await primeLocale();
  const { slug } = await context.params;
  const event = data.getEvent(slug);
  if (!event) return new Response('Not found', { status: 404 });
  const location = event.format === 'online' ? 'Онлайн' : [event.venue?.name, event.venue?.address].filter(Boolean).join(', ');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Trustwork//Events//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${event.id}@trustwork.local`,
    `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART:${stamp(event.startsAt)}`,
    `DTEND:${stamp(event.endsAt)}`,
    `SUMMARY:${escape(event.title)}`,
    `DESCRIPTION:${escape(event.lede)}`,
    `LOCATION:${escape(location)}`,
    `URL:${event.href}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return new Response(lines.join('\r\n') + '\r\n', { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="${slug}.ics"` } });
}
