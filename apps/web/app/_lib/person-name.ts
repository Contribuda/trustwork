import { t } from './i18n';

/**
 * A contract person may carry no display name (provider sign-up without a name, BE-002): the interface shows the
 * localized placeholder instead of inventing a name.
 */
export function personDisplayName(displayName: string | null): string {
  return displayName ?? t('personPage.unnamed');
}
