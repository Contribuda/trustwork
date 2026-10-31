import NextLink from '@/components/locale/LocalLink';
import { ArrowRight, MapPin, Users, Video } from 'lucide-react';
import { PersonAvatar } from '@/components/public/PersonAvatar';
import type { EventCard } from '@/app/_lib/data/types';
import { dayTile, placeLine, priceLabel, timeRangeLabel, typeLabel } from '@/app/_lib/events';
import { t } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';

/** Status badge text for a card: price for open events, «Мест нет» / «Регистрация закрыта» / «Прошло» otherwise. */
export function eventBadge(card: EventCard): { label: string; tone: 'free' | 'paid' | 'muted' } {
  if (card.status === 'past') return { label: t('events.past'), tone: 'muted' };
  if (card.status === 'soldout') return { label: t('events.soldout'), tone: 'muted' };
  if (card.status === 'closed') return { label: t('events.closed'), tone: 'muted' };
  if (card.priceFromMinorUnits === 0) return { label: card.priceToMinorUnits > 0 ? t('events.freeOption') : t('events.free'), tone: 'free' };
  return { label: priceLabel(card.priceFromMinorUnits), tone: 'paid' };
}

/** Calendar row of the events section: date tile, type · place, title, lede, organizer and speakers; side with price and action. */
export function EventRow({ card, id }: { card: EventCard; id?: string | undefined }) {
  const tile = dayTile(card.startsAt, card.timezone);
  const badge = eventBadge(card);
  const seatsLeft = card.capacity !== null ? Math.max(0, card.capacity - card.registered) : null;
  const action = card.status === 'past' ? t('events.materials') : card.status === 'open' ? t('events.register') : t('events.details');
  return (
    <article className="ev-row" id={id}>
      <div className="ev-tile" aria-hidden="true">
        <span className="ev-tile__weekday">{tile.weekday}</span>
        <span className="ev-tile__day">{tile.day}</span>
        <span className="ev-tile__month">{tile.month}</span>
      </div>
      <div className="ev-row__body">
        <span className="pub-kicker">
          {typeLabel(card.type)} · {card.format === 'online' ? t('events.online') : placeLine(card)}
        </span>
        <h3 className="ev-row__title">
          <NextLink href={card.href}>{typo(card.title)}</NextLink>
        </h3>
        <p className="ev-row__lede">{typo(card.lede)}</p>
        <div className="ev-row__meta">
          <span className="ev-row__fact">{timeRangeLabel(card.startsAt, card.endsAt, card.timezone)}</span>
          <span className="ev-row__fact">
            {card.format === 'online' ? <Video size={14} strokeWidth={2} aria-hidden="true" /> : <MapPin size={14} strokeWidth={2} aria-hidden="true" />}
            {card.format === 'online' ? t('events.online') : (card.venueName ?? card.city)}
          </span>
          {card.speakers.length ? (
            <span className="ev-row__speakers" aria-label={t('events.speakers')}>
              {card.speakers.slice(0, 3).map((s) => (
                <PersonAvatar key={s.id} name={s.name} portrait={s.portrait} size={32} />
              ))}
              {card.speakers.length > 3 ? <span className="ev-row__more">+{card.speakers.length - 3}</span> : null}
            </span>
          ) : null}
        </div>
      </div>
      <div className="ev-row__side">
        <span className={`ev-badge ev-badge--${badge.tone}`}>{badge.label}</span>
        {card.status === 'open' && seatsLeft !== null ? (
          <span className="ev-row__seats">
            <Users size={14} strokeWidth={2} aria-hidden="true" />
            {t('events.seatsLeft', { count: seatsLeft })}
          </span>
        ) : null}
        {card.status === 'open' && seatsLeft === null ? (
          <span className="ev-row__seats">
            <Users size={14} strokeWidth={2} aria-hidden="true" />
            {t('events.registeredCount', { count: card.registered })}
          </span>
        ) : null}
        <NextLink href={card.href} className={card.status === 'open' ? 'pub-btn pub-btn--dark ev-row__action' : 'pub-btn ev-row__action'}>
          {action}
          <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
        </NextLink>
      </div>
    </article>
  );
}
