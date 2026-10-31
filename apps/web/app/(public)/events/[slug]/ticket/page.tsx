import type { Metadata } from 'next';
import NextLink from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight, CalendarPlus, MapPin, Video } from 'lucide-react';
import { Brand } from '@/components/ui';
import { data } from '@/app/_lib/data';
import { codeMatrix, dateRangeLabel, decodeTicket, placeLine, ticketCode, timeRangeLabel, typeLabel } from '@/app/_lib/events';
import { t } from '@/app/_lib/i18n';
import type { PageSearchParams } from '@/app/_lib/principal';
import { typo } from '@/app/_lib/typo';
import { primeLocale } from '@/app/_lib/locale';

type Props = { params: Promise<{ slug: string }>; searchParams: PageSearchParams };

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('events.ticketTitle') };
}

/** Ticket page: event, holder, ticket type, status, code with a decorative matrix, calendar file. Token comes from the query (demo). */
export default async function TicketPage({ params, searchParams }: Props) {
  await primeLocale();
  const { slug } = await params;
  const sp = await searchParams;
  const event = data.getEvent(slug);
  if (!event) notFound();
  const parsed = decodeTicket(typeof sp.t === 'string' ? sp.t : undefined);
  const ticket = parsed ? event.tickets.find((tk) => tk.id === parsed.ticketId) : undefined;
  if (!parsed || parsed.slug !== slug || !ticket) {
    return (
      <div className="pub pub-page">
        <div className="pub-wrap">
          <h1 className="pub-h1">{t('events.ticketTitle')}</h1>
          <p className="pub-lede">{t('events.ticketInvalid')}</p>
          <NextLink href={event.href} className="pub-more">
            {t('events.ticketBackToEvent')}
            <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
          </NextLink>
        </div>
      </div>
    );
  }
  const code = ticketCode(parsed);
  const matrix = codeMatrix(code);
  const status = ticket.priceMinorUnits === 0 ? t('events.ticketFree') : parsed.paid ? t('events.ticketPaid') : t('events.ticketPending');

  return (
    <div className="pub pub-page">
      <div className="pub-wrap ev-ticket-wrap">
        <h1 className="pub-h1">{t('events.ticketTitle')}</h1>
        <p className="pub-lede">{t('events.ticketShow')}</p>
        <article className="tk" aria-label={t('events.ticketTitle')}>
          <div className="tk__main">
            <div className="tk__brand">
              <Brand height={28} decorative />
              <span className="pub-kicker">{typeLabel(event.type)}</span>
            </div>
            <h2 className="tk__title">{typo(event.title)}</h2>
            <dl className="tk__facts">
              <div>
                <dt>{t('events.when')}</dt>
                <dd>
                  {dateRangeLabel(event.startsAt, event.endsAt, event.timezone)}
                  <br />
                  {timeRangeLabel(event.startsAt, event.endsAt, event.timezone)}
                </dd>
              </div>
              <div>
                <dt>{t('events.where')}</dt>
                <dd>
                  {event.format === 'online' ? <Video size={14} strokeWidth={2} aria-hidden="true" /> : <MapPin size={14} strokeWidth={2} aria-hidden="true" />}{' '}
                  {event.format === 'online' ? t('events.online') : (event.venue?.name ?? placeLine(event))}
                  {event.venue ? (
                    <>
                      <br />
                      <span className="tk__sub">{event.venue.address}</span>
                    </>
                  ) : null}
                </dd>
              </div>
              <div>
                <dt>{t('events.ticketHolder')}</dt>
                <dd>
                  {parsed.name}
                  {parsed.company ? (
                    <>
                      <br />
                      <span className="tk__sub">{parsed.company}</span>
                    </>
                  ) : null}
                </dd>
              </div>
              <div>
                <dt>{t('events.ticketType')}</dt>
                <dd>
                  {ticket.name}
                  {parsed.qty > 1 ? ` × ${parsed.qty}` : ''}
                  <br />
                  <span className={`ev-badge ${ticket.priceMinorUnits === 0 ? 'ev-badge--free' : parsed.paid ? 'ev-badge--paid' : 'ev-badge--muted'}`}>{status}</span>
                </dd>
              </div>
            </dl>
          </div>
          <div className="tk__stub" aria-hidden="true">
            <svg className="tk__qr" viewBox={`0 0 ${matrix.length} ${matrix.length}`} shapeRendering="crispEdges">
              {matrix.map((row, y) => row.map((on, x) => (on ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" /> : null)))}
            </svg>
            <span className="tk__code-label">{t('events.ticketCode')}</span>
            <span className="tk__code">{code}</span>
          </div>
        </article>
        <p className="pub-note__body" style={{ marginTop: 'var(--space-4)' }}>
          {t('events.ticketSent', { email: parsed.email })}
        </p>
        <div className="pub-actions" style={{ marginTop: 'var(--space-5)' }}>
          <a href={`/events/${slug}/calendar.ics`} className="pub-btn pub-btn--dark">
            <CalendarPlus size={16} strokeWidth={2} aria-hidden="true" />
            {t('events.addToCalendar')}
          </a>
          <NextLink href={event.href} className="pub-btn">
            {t('events.ticketBackToEvent')}
          </NextLink>
          <NextLink href="/events" className="pub-more">
            {t('events.ticketMore')}
            <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
          </NextLink>
        </div>
      </div>
    </div>
  );
}
