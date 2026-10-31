import { forwardRef } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { Sparkles } from 'lucide-react';
import { cx } from '../../utils/cx';
import { t } from '../../i18n';
import { useIsMobile } from '../../hooks/useMediaQuery';
import { Badge } from '../Badge/Badge';
import { Icon } from '../Icon/Icon';
import styles from './Assistant.module.css';

export type AssistantLauncherProps = {
  isOpen: boolean;
  onPress: () => void;
  unreadCount?: number | undefined;
  /** A decision is waiting (approval digest); the accessible name says so. */
  actionRequired?: boolean | undefined;
  /** Force-hide; the launcher also hides itself while the overlay is open below 768 px (the sheet has its own close control). */
  isHidden?: boolean | undefined;
  className?: string | undefined;
};

/**
 * Icon-only circular launcher fixed bottom-right (56 px desktop / 48 px mobile), last in DOM order.
 * Accessible name «Помощник» plus unread / action-required state; `aria-expanded` mirrors the overlay.
 */
export const AssistantLauncher = forwardRef<HTMLButtonElement, AssistantLauncherProps>(function AssistantLauncher({ isOpen, onPress, unreadCount = 0, actionRequired = false, isHidden = false, className }, ref) {
  const isMobile = useIsMobile();
  const label = actionRequired ? t('assistant.launcherAction') : unreadCount > 0 ? t('assistant.launcherUnread', { count: unreadCount }) : isOpen ? t('assistant.launcherOpen') : t('assistant.launcher');
  if (isHidden || (isOpen && isMobile)) return null;
  return (
    <AriaButton ref={ref} onPress={onPress} aria-label={label} aria-expanded={isOpen} className={cx(styles.launcher, actionRequired && styles.launcherAction, className)}>
      <Icon icon={Sparkles} size={24} />
      {actionRequired ? <Badge dot tone="warning" className={cx(styles.launcherBadge)} /> : <Badge count={unreadCount} className={cx(styles.launcherBadge)} />}
    </AriaButton>
  );
});
