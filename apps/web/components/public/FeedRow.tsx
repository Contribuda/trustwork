import NextLink from '@/components/locale/LocalLink';
import { ArrowUpRight, Clock } from 'lucide-react';
import { MediaFrame } from '@/components/ui';
import type { PublicationCard } from '@/app/_lib/data/types';
import { storyCover } from '@/app/_lib/media';
import { t } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';

export type FeedRowProps = {
  card: PublicationCard;
  /** Kicker above the title (topic, or topic · region). */
  kicker: string;
  /** Outlined chip at the top of the side column (format or source type). */
  chip?: string | undefined;
  /** Short lines under the chip (author, dates). */
  lines?: readonly string[] | undefined;
  /** Warning flag («Исправлено»). */
  flag?: string | null | undefined;
  /** External link at the foot of the side column («К источнику»). */
  external?: { href: string; label: string } | null | undefined;
  /** One-line meta for narrow screens, where the side column is hidden. */
  inlineMeta: string;
};

/** List row of the editorial standard: thumbnail, kicker, title, dek; side column with chip, lines, read time, flag, link. */
export function FeedRow({ card, kicker, chip, lines = [], flag, external, inlineMeta }: FeedRowProps) {
  return (
    <article className="feed-row">
      {!card.live ? <div className="feed-row__media" aria-hidden="true">
        <MediaFrame media={storyCover(card)} ratio="fill" radius="none" sizes="(max-width: 767px) 96px, 216px" />
      </div> : null}
      <div className="feed-row__body">
        <span className="pub-kicker">{kicker}</span>
        <h3 className="feed-row__title">
          <NextLink href={card.href}>{typo(card.title)}</NextLink>
        </h3>
        <p className="feed-row__dek">{typo(card.lede)}</p>
        <span className="feed-row__meta feed-row__meta--inline">{inlineMeta}</span>
      </div>
      <div className="feed-row__side">
        {chip ? <span className="feed-row__chip">{chip}</span> : null}
        {lines.map((line) => (
          <span key={line} className="feed-row__sideline">
            {line}
          </span>
        ))}
        {card.readMinutes ? (
          <span className="feed-row__sideline feed-row__meta">
            <Clock size={14} strokeWidth={2} aria-hidden="true" />
            {t('articles.readTime', { minutes: card.readMinutes })}
          </span>
        ) : null}
        {flag ? <span className="feed-row__flag">{flag}</span> : null}
        {external ? (
          <a href={external.href} className="feed-row__source" target="_blank" rel="noopener noreferrer">
            {external.label}
            <ArrowUpRight size={14} strokeWidth={2} aria-hidden="true" />
          </a>
        ) : null}
      </div>
    </article>
  );
}
