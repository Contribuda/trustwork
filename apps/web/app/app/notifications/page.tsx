import type { Metadata } from 'next';
import NextLink from '@/components/locale/LocalLink';
import { AlertCircle, BookOpen, FileText, FolderKanban, MessageSquare, ShieldCheck, Sparkles, Tag } from 'lucide-react';
import { PageHeader } from '@/components/workspace/parts';
import { hrefFor, requirePrincipal, type PageSearchParams } from '@/app/_lib/principal';
import type { NotificationView } from '@/app/_lib/data';
import { longDate, t } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';
import { primeLocale } from '@/app/_lib/locale';
import { MarkReadButton } from './_components/NotificationActions';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('notifications.title') };
}

const ICONS: Record<NotificationView['kind'], typeof Tag> = { decision: AlertCircle, quote: Tag, project: FolderKanban, publication: FileText, assistant: Sparkles, magazine: BookOpen, message: MessageSquare, account: ShieldCheck };

function dayKey(at: string, now: Date): 'today' | 'yesterday' | 'earlier' {
  const d = new Date(at);
  const days = Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) / 86400000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : 'earlier';
}

/**
 * "All notifications": object-linked list grouped by day, never message bodies or correspondence (not a mailbox).
 * Live notifications (COMMS-001) come from the API and can be marked read; demo fixtures cannot.
 */
export default async function NotificationsPage({ searchParams }: { searchParams: PageSearchParams }) {
  await primeLocale();
  const principal = await requirePrincipal(searchParams, '/app/notifications');
  const sp = await searchParams;
  const onlyUnread = sp.filter === 'unread';
  const all = principal.notifications;
  const rows = onlyUnread ? all.filter((n) => n.unread) : all;
  const unread = all.filter((n) => n.unread).length;
  const live = all.some((n) => n.live);
  const now = all.length
    ? new Date(
        all
          .map((n) => n.at)
          .sort()
          .at(-1)!,
      )
    : new Date();
  const groups = (['today', 'yesterday', 'earlier'] as const).map((k) => ({ key: k, rows: rows.filter((n) => dayKey(n.at, now) === k) })).filter((g) => g.rows.length);
  return (
    <>
      <PageHeader title={t('notifications.title')} lede={t('notifications.lede')} />
      {all.length === 0 ? (
        <div className="ws-empty">
          <strong>{t('notifications.empty')}</strong>
        </div>
      ) : (
        <div className="ws-grid ws-grid--main">
          <div className="ws-section" style={{ gap: 18 }}>
            <nav className="ws-filter" aria-label={t('notifications.title')}>
              <NextLink href={hrefFor(principal, '/app/notifications')} className={`ws-chip${!onlyUnread ? ' ws-chip--on' : ''}`} aria-current={!onlyUnread ? 'true' : undefined}>
                {t('projectsWs.filter.all')} · {all.length}
              </NextLink>
              <NextLink href={hrefFor(principal, '/app/notifications?filter=unread')} className={`ws-chip${onlyUnread ? ' ws-chip--on' : ''}`} aria-current={onlyUnread ? 'true' : undefined}>
                {t('notifications.unread')} · {unread}
              </NextLink>
            </nav>
            {groups.length ? (
              groups.map((g) => (
                <section key={g.key} className="ws-section" aria-labelledby={`ntf-${g.key}`}>
                  <h2 id={`ntf-${g.key}`} className="ws-group-title">
                    {t(`notifications.group.${g.key}`)}
                  </h2>
                  <ul className="ws-list">
                    {g.rows.map((n) => {
                      const Icon = ICONS[n.kind];
                      return (
                        <li key={n.id} className={`ws-row${n.unread ? ' ws-row--unread' : ''}`}>
                          <span className="ws-row__main ws-row__main--icon">
                            <span className={`ws-mark ws-mark--file${n.unread ? ' is-unread' : ''}`} aria-hidden="true">
                              <Icon size={16} strokeWidth={2} />
                            </span>
                            <span>
                              <NextLink href={n.href} className="ws-row__title">
                                {typo(n.title)}
                              </NextLink>
                              <span className="ws-row__meta">
                                <span>{t(`notifications.kind.${n.kind}`)}</span>
                                <time dateTime={n.at}>{longDate(n.at)}</time>
                                {n.unread ? <span className="ws-note--accent">{t('notifications.unreadOne')}</span> : null}
                              </span>
                            </span>
                          </span>
                          <span className="ws-row__side">
                            <NextLink href={n.href} className="ws-row__action">
                              {t('notifications.open')}
                            </NextLink>
                            {n.live && n.unread ? <MarkReadButton id={n.id} /> : null}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))
            ) : (
              <div className="ws-empty">
                <strong>{t('notifications.noUnread')}</strong>
              </div>
            )}
          </div>
          <div className="ws-section">
            <ul className="ws-stats ws-stats--2">
              <li className="ws-stat">
                <strong>{unread}</strong>
                <span>{t('notifications.stats.unread')}</span>
              </li>
              <li className="ws-stat">
                <strong>{all.filter((n) => n.kind === 'decision').length}</strong>
                <span>{t('notifications.stats.decisions')}</span>
              </li>
            </ul>
            <div className="ws-card">
              <h2 className="ws-h2">{t('notifications.settingsTitle')}</h2>
              <p className="ws-muted">{t('notifications.settingsHint')}</p>
              <NextLink href={hrefFor(principal, '/app/settings#preferences')} className="ws-more">
                {t('settings.nav.preferences')}
              </NextLink>
            </div>
            {live ? (unread > 0 ? <MarkReadButton all /> : null) : <p className="ws-note">{t('notifications.demoNote')}</p>}
          </div>
        </div>
      )}
    </>
  );
}
