import { data } from '@/app/_lib/data';
import { t } from '@/app/_lib/i18n';
import { withPublicLocale } from '@/app/_lib/locale';
import { localPath } from '@/app/_lib/localize';
import { absoluteUrl } from '@/app/_lib/site';

const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const escape = (s: string) =>
  s
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/[,;]/g, (m) => `\\${m}`);

/** iCalendar file for one event in the language of its URL (ADR 012 decision 27) (UTC timestamps; calendar apps convert to the user's zone). */
export const GET = withPublicLocale(async (_request: Request, context: { params: Promise<{ lang: string; slug: string }> }) => {
  const { slug } = await context.params;
  const event = await data.getEvent(slug);
  if (!event) return new Response('Not found', { status: 404 });
  const location = event.format === 'online' ? t('events.online') : [event.venue?.name, event.venue?.address].filter(Boolean).join(', ');
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
    `URL:${absoluteUrl(localPath(event.href))}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return new Response(lines.join('\r\n') + '\r\n', { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="${slug}.ics"` } });
});
