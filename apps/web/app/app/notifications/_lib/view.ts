import { contextPath, type Notification } from '@trustwork/contracts/client';
import type { NotificationView } from '@/app/_lib/data/types';
import { shortDate, t } from '@/app/_lib/i18n';

/**
 * Maps a notification of `GET /v1/notifications` (COMMS-001) to the view the bell and the notifications page render.
 * The title is built here from the template key and its parameters in the reader's language; the parameters are only
 * values the reader may see (the API restricts them per template), never a message body.
 */
/** The register's last valid day as a localized date; anything else shows nothing rather than raw text. */
function registerDate(value: string | undefined): string {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? shortDate(value) : '';
}

export function notificationView(n: Notification): NotificationView {
  const kind: NotificationView['kind'] = n.category === 'account' || n.category === 'legal' ? 'account'
    : n.link?.kind === 'rfq' || n.link?.kind === 'quote' ? 'quote'
      : n.category === 'messages' ? 'message' : 'project';
  const params = { authorName: n.params.authorName ?? '', threadSubject: n.params.threadSubject ?? '' };
  const title = n.templateKey === 'thread.opened' ? t('notifications.template.threadOpened', params)
    : n.templateKey === 'thread.message' ? t('notifications.template.threadMessage', params)
      : n.templateKey === 'registers.licence_expiring' ? t('notifications.template.registerExpiring', { date: registerDate(n.params.validUntil) })
        : t('notifications.template.securityNotice');
  return { id: n.id, kind, title, at: n.createdAt, href: n.link ? contextPath(n.link.kind, n.link.id) : '/app/notifications', unread: n.readAt === null, live: true };
}
