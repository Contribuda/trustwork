import type { Metadata } from 'next';
import NextLink from '@/components/locale/LocalLink';
import { notFound } from 'next/navigation';
import { ArrowLeft, ArrowRight, ArrowUpRight, CalendarPlus, Clock, MapPin, Ticket, Users, Video } from 'lucide-react';
import { MediaFrame, Prose } from '@/components/ui';
import { PersonAvatar } from '@/components/public/PersonAvatar';
import { ShareRow } from '@/components/public/ShareRow';
import { eventBadge } from '@/components/public/EventRow';
import { renderBody } from '@/components/public/body';
import { formatLabel, topicLabel } from '@/components/public/parts';
import { data } from '@/app/_lib/data';
import { dateRangeLabel, formatLabelOf, priceLabel, timeRangeLabel, typeLabel } from '@/app/_lib/events';
import { eventCover, storyCover } from '@/app/_lib/media';
import { t } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';
import { primePublicLocale } from '@/app/_lib/locale';
import { languageAlternates } from '@/app/_lib/site';
import { localHref } from '@/app/_lib/localize';

type Params = { params: Promise<{ lang: string; slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  await primePublicLocale((await params).lang);
  const { lang, slug } = await params;
  const event = await data.getEvent(slug);
  return { alternates: languageAlternates(`/events/${slug}`, lang), title: event ? event.title : t('error.notFoundTitle'), description: event?.lede };
}

/**
 * Event page: head (type · topics, title, lede), facts panel (when, where, format, tickets), cover, body, program,
 * speakers, venue, related materials; sticky tickets card on the right (ticket types with price and availability,
 * attendance, calendar file, share); a fixed bottom bar on phones.
 */
export default async function EventPage({ params }: Params) {
  await primePublicLocale((await params).lang);
  const { slug } = await params;
  const event = await data.getEvent(slug);
  if (!event) notFound();
  const badge = eventBadge(event);
  const { nodes } = renderBody(event.body);
  const seatsLeft = event.capacity !== null ? Math.max(0, event.capacity - event.registered) : null;
  const mapHref = event.venue ? `https://www.openstreetmap.org/search?query=${encodeURIComponent(event.venue.address)}` : null;
  const openTickets = event.tickets.filter((tk) => tk.available);

  return (
    <div className="pub pub-page">
      <div className="pub-wrap pub-wrap--article">
        <NextLink href="/events" className="pub-back">
          <ArrowLeft size={16} strokeWidth={2} aria-hidden="true" />
          {t('events.backToEvents')}
        </NextLink>
        <article className="art ev">
          <div className="ev-layout">
            <header className="art-cover__content ev-head">
              <p className="art-kickers">
                <NextLink href={`/events?type=${event.type}`} className="art-kickers__type">
                  {typeLabel(event.type)}
                </NextLink>
                {event.topics.map((topic) => (
                  <NextLink key={topic} href={`/articles?topic=${topic}`}>
                    {topicLabel(topic)}
                  </NextLink>
                ))}
              </p>
              <h1 className="art-title" id="art-title" tabIndex={-1}>
                {typo(event.title)}
              </h1>
              <p className="art-lede">{typo(event.lede)}</p>
            </header>

            <dl className="ev-facts-grid">
              <div>
                <dt>{t('events.when')}</dt>
                <dd>
                  {dateRangeLabel(event.startsAt, event.endsAt, event.timezone)}
                  <span className="ev-facts-grid__sub">{timeRangeLabel(event.startsAt, event.endsAt, event.timezone)}</span>
                </dd>
              </div>
              <div>
                <dt>{t('events.where')}</dt>
                <dd>
                  {event.format === 'online' ? t('events.online') : (event.venue?.name ?? event.city)}
                  {event.format !== 'online' && event.city ? <span className="ev-facts-grid__sub">{event.city}</span> : null}
                  {event.format === 'online' && event.onlineNote ? <span className="ev-facts-grid__sub">{typo(event.onlineNote)}</span> : null}
                </dd>
              </div>
              <div>
                <dt>{t('events.format')}</dt>
                <dd>
                  {formatLabelOf(event.format)}
                  {event.format === 'hybrid' && event.onlineNote ? <span className="ev-facts-grid__sub">{typo(event.onlineNote)}</span> : null}
                </dd>
              </div>
              <div>
                <dt>{t('events.tickets')}</dt>
                <dd>
                  <span className={`ev-badge ev-badge--${badge.tone}`}>{badge.label}</span>
                  {seatsLeft !== null && event.status === 'open' ? <span className="ev-facts-grid__sub">{t('events.registeredOf', { count: event.registered, capacity: event.capacity ?? 0 })}</span> : null}
                  {seatsLeft === null && event.status === 'open' ? <span className="ev-facts-grid__sub">{t('events.registeredCount', { count: event.registered })}</span> : null}
                </dd>
              </div>
            </dl>

            <div className="art-main ev-main">
              <div className="art-cover__media ev-cover">
                <MediaFrame media={eventCover(event.cover)} ratio="fill" radius="none" loading="eager" sizes="(max-width: 767px) 100vw, 800px" />
              </div>

              <section className="ev-section" aria-labelledby="about-title">
                <h2 className="pub-h2 ev-section__title" id="about-title">
                  {t('events.about')}
                </h2>
                <Prose family="sans" measure="reader">
                  {nodes}
                </Prose>
              </section>

              {event.program.length ? (
                <section className="ev-section" aria-labelledby="program-title">
                  <h2 className="pub-h2 ev-section__title" id="program-title">
                    {t('events.program')}
                  </h2>
                  <ol className="ev-program">
                    {event.program.map((row, i) => (
                      <li key={i} className="ev-program__row">
                        <span className="ev-program__time">{row.time}</span>
                        <span className="ev-program__body">
                          <span className="ev-program__title">{typo(row.title)}</span>
                          {row.speakers.length ? <span className="ev-program__speakers">{row.speakers.map((s) => s.name).join(', ')}</span> : null}
                        </span>
                      </li>
                    ))}
                  </ol>
                </section>
              ) : null}

              {event.speakers.length ? (
                <section className="ev-section" aria-labelledby="speakers-title">
                  <h2 className="pub-h2 ev-section__title" id="speakers-title">
                    {t('events.speakers')}
                  </h2>
                  <div className="ev-speakers">
                    {event.speakers.map((s) => {
                      const inner = (
                        <>
                          <PersonAvatar name={s.name} portrait={s.portrait} size={64} />
                          <span className="ev-speaker__text">
                            <span className="ev-speaker__name">{s.name}</span>
                            <span className="ev-speaker__role">{s.role}</span>
                          </span>
                        </>
                      );
                      return s.href ? (
                        <NextLink key={s.id} href={s.href} className="ev-speaker">
                          {inner}
                        </NextLink>
                      ) : (
                        <div key={s.id} className="ev-speaker">
                          {inner}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : null}

              {event.venue ? (
                <section className="ev-section" aria-labelledby="venue-title">
                  <h2 className="pub-h2 ev-section__title" id="venue-title">
                    {t('events.venue')}
                  </h2>
                  <div className="ev-venue">
                    <MapPin size={20} strokeWidth={1.75} aria-hidden="true" />
                    <div>
                      <p className="ev-venue__name">{event.venue.name}</p>
                      <p className="ev-venue__address">{event.venue.address}</p>
                      {mapHref ? (
                        <a href={mapHref} className="pub-more" target="_blank" rel="noopener noreferrer">
                          {t('events.openMap')}
                          <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
                        </a>
                      ) : null}
                    </div>
                  </div>
                </section>
              ) : null}

              {event.related.length ? (
                <section className="ev-section" aria-labelledby="related-title">
                  <h2 className="pub-h2 ev-section__title" id="related-title">
                    {t('events.related')}
                  </h2>
                  <div className="pub-brief">
                    {event.related.map((card) => (
                      <div key={card.id} className="pub-brief__item pub-brief__item--media">
                        <span className="pub-brief__thumb" aria-hidden="true">
                          <MediaFrame media={storyCover(card)} ratio="fill" radius="none" sizes="72px" />
                        </span>
                        <span>
                          <span className="pub-kicker">{formatLabel(card)}</span>
                          <span className="pub-brief__title" style={{ display: 'block' }}>
                            <NextLink href={card.href}>{typo(card.title)}</NextLink>
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
            </div>

            <aside className="ev-aside" id="tickets">
              <section className="pub-note ev-tickets" aria-labelledby="tickets-title">
                <h2 className="pub-note__title" id="tickets-title">
                  {t('events.ticketsTitle')}
                </h2>
                <ul className="ev-ticket-list">
                  {event.tickets.map((tk) => (
                    <li key={tk.id} className={tk.available ? 'ev-ticket' : 'ev-ticket ev-ticket--off'}>
                      <div className="ev-ticket__head">
                        <span className="ev-ticket__name">{tk.name}</span>
                        <span className="ev-ticket__price">{priceLabel(tk.priceMinorUnits, false)}</span>
                      </div>
                      <p className="ev-ticket__desc">{typo(tk.description)}</p>
                      {tk.quota !== null && tk.available ? <span className="ev-ticket__left">{t('events.seatsLeft', { count: Math.max(0, tk.quota - tk.taken) })}</span> : null}
                      {tk.available ? (
                        <NextLink href={`/events/${event.slug}/register?ticket=${tk.id}`} className={tk.priceMinorUnits === 0 ? 'pub-btn pub-btn--dark' : 'pub-btn pub-btn--dark'}>
                          <Ticket size={16} strokeWidth={2} aria-hidden="true" />
                          {tk.priceMinorUnits === 0 ? t('events.ticketTake') : t('events.ticketBuy')}
                        </NextLink>
                      ) : (
                        <span className="ev-ticket__off">{event.status === 'past' ? t('events.past') : event.status === 'closed' ? t('events.closed') : t('events.soldout')}</span>
                      )}
                    </li>
                  ))}
                </ul>
                {openTickets.length ? <p className="pub-note__body ev-tickets__note">{typo(t('events.ticketsNote'))}</p> : null}
                {event.materialsHref ? (
                  <NextLink href={event.materialsHref} className="pub-btn">
                    {t('events.materials')}
                    <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
                  </NextLink>
                ) : null}
              </section>
              <section className="pub-note" aria-labelledby="org-card-title">
                <h2 className="pub-note__title" id="org-card-title">
                  {t('events.organizer')}
                </h2>
                <p className="ev-org">{event.organizer.href ? <NextLink href={event.organizer.href}>{event.organizer.name}</NextLink> : event.organizer.name}</p>
                <div className="ev-aside__facts">
                  <span>
                    <Users size={14} strokeWidth={2} aria-hidden="true" />
                    {t('events.registeredCount', { count: event.registered })}
                  </span>
                  <span>
                    <Clock size={14} strokeWidth={2} aria-hidden="true" />
                    {timeRangeLabel(event.startsAt, event.endsAt, event.timezone)}
                  </span>
                  <span>
                    {event.format === 'online' ? <Video size={14} strokeWidth={2} aria-hidden="true" /> : <MapPin size={14} strokeWidth={2} aria-hidden="true" />}
                    {event.format === 'online' ? t('events.online') : event.city}
                  </span>
                </div>
                <a href={localHref(`/events/${event.slug}/calendar.ics`)} className="pub-more">
                  <CalendarPlus size={16} strokeWidth={2} aria-hidden="true" />
                  {t('events.addToCalendar')}
                </a>
              </section>
              <section className="pub-note" aria-labelledby="share-title">
                <h2 className="pub-note__title" id="share-title">
                  {t('events.share')}
                </h2>
                <ShareRow path={event.href} title={event.title} />
              </section>
            </aside>
          </div>
        </article>
      </div>

      {event.status === 'open' ? (
        <div className="ev-bar" aria-hidden="true">
          <span className="ev-bar__text">
            <span className={`ev-badge ev-badge--${badge.tone}`}>{badge.label}</span>
            <span className="ev-bar__date">{dateRangeLabel(event.startsAt, event.endsAt, event.timezone)}</span>
          </span>
          <a href="#tickets" className="pub-btn pub-btn--dark">
            {t('events.register')}
          </a>
        </div>
      ) : null}
    </div>
  );
}
