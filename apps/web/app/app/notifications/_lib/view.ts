import { contextPath, type Notification } from '@trustwork/contracts/client';
import type { NotificationView } from '@/app/_lib/data/types';
import { shortDate, t, type LocaleKey } from '@/app/_lib/i18n';

/**
 * Maps a notification of `GET /v1/notifications` (COMMS-001) to the view the bell and the notifications page render.
 * The title is built here from the template key and its parameters in the reader's language; the parameters are only
 * values the reader may see (the API restricts them per template), never a message body.
 */
/** The register's last valid day as a localized date; anything else shows nothing rather than raw text. */
function registerDate(value: string | undefined): string {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? shortDate(value) : '';
}

/** A claim notice in the reader's language (CLM-001): the outcome word of the template picks the sentence. */
const CLAIM_OUTCOMES: Record<string, LocaleKey> = {
  in_dispute: 'notifications.template.claimInDispute', back_in_review: 'notifications.template.claimBackInReview', approved: 'notifications.template.claimApproved',
  rejected: 'notifications.template.claimRejected', revoked: 'notifications.template.claimRevoked',
};
function claimTitle(n: Notification): string {
  const company = n.params.companyName ?? '';
  if (n.templateKey === 'claims.page_notice') {
    return n.params.stage === 'handed_over' ? t('notifications.template.claimPageHandedOver', { company })
      : t('notifications.template.claimPageOpened', { company, date: registerDate(n.params.waitingUntil) });
  }
  return t(CLAIM_OUTCOMES[n.params.outcome ?? ''] ?? 'notifications.template.claimBackInReview', { company });
}

export function notificationView(n: Notification): NotificationView {
  const kind: NotificationView['kind'] = n.category === 'account' || n.category === 'legal' ? 'account'
    : n.link?.kind === 'rfq' || n.link?.kind === 'quote' ? 'quote'
      : n.category === 'messages' ? 'message' : 'project';
  const params = { authorName: n.params.authorName ?? '', threadSubject: n.params.threadSubject ?? '' };
  const title = n.templateKey === 'thread.opened' ? t('notifications.template.threadOpened', params)
    : n.templateKey === 'thread.message' ? t('notifications.template.threadMessage', params)
      : n.templateKey === 'registers.licence_expiring' ? t('notifications.template.registerExpiring', { date: registerDate(n.params.validUntil) })
        : n.templateKey === 'claims.page_notice' || n.templateKey === 'claims.claim_update' ? claimTitle(n)
          : t('notifications.template.securityNotice');
  return { id: n.id, kind, title, at: n.createdAt, href: n.link ? contextPath(n.link.kind, n.link.id) : '/app/notifications', unread: n.readAt === null, live: true };
}
