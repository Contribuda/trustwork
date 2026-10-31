import type { ReactNode } from 'react';
import { Bell, Menu as MenuIcon, Search, WifiOff } from 'lucide-react';
import { Button as AriaButton } from 'react-aria-components';
import { cx } from '../../utils/cx';
import { t } from '../../i18n';
import { Badge } from '../Badge/Badge';
import { Breadcrumb, type BreadcrumbItem } from '../Breadcrumb/Breadcrumb';
import { IconButton } from '../Button/Button';
import { AvatarButton } from '../Avatar/Avatar';
import { Icon } from '../Icon/Icon';
import { Menu, MenuTrigger, type MenuItemDef } from '../Menu/Menu';
import styles from './AppHeader.module.css';

export type AppHeaderProps = {
  /** Shown only when depth > 1 (top-level pages show nothing; the H1 lives in content). */
  breadcrumbs?: readonly BreadcrumbItem[] | undefined;
  onSearchPress: () => void;
  /** Unread notifications: number, `'unknown'` (dot only) or 0. */
  notificationCount: number | 'unknown';
  onNotificationsPress: () => void;
  account: { name: string; avatarSrc?: string | undefined };
  /** Avatar menu items; «Помощь» must be directly before «Выйти» (consistent help). */
  menuItems: readonly MenuItemDef[];
  onMenuAction?: ((key: string) => void) | undefined;
  /** Mobile only: opens the navigation sheet. */
  onMenuPress?: (() => void) | undefined;
  isOffline?: boolean | undefined;
  /** Extra content on the left (page title on mobile). */
  children?: ReactNode;
  className?: string | undefined;
};

/**
 * Workspace header: breadcrumb (depth > 1), global search, bell with count in its accessible name,
 * and the circular avatar as the only account control (no name, no chevron). Offline banner below.
 */
export function AppHeader({ breadcrumbs, onSearchPress, notificationCount, onNotificationsPress, account, menuItems, onMenuAction, onMenuPress, isOffline = false, children, className }: AppHeaderProps) {
  const bellLabel = notificationCount === 'unknown' ? t('shell.notificationsUnknown') : notificationCount > 0 ? t('shell.notificationsCount', { count: notificationCount }) : t('shell.notifications');
  return (
    <header aria-label={t('shell.headerLabel')} className={cx(styles.header, className)}>
      <div className={styles.bar}>
        {onMenuPress ? <IconButton icon={MenuIcon} aria-label={t('shell.openMenu')} onPress={onMenuPress} className={cx(styles.menuButton)} /> : null}
        <div className={styles.left}>
          {breadcrumbs && breadcrumbs.length > 1 ? <Breadcrumb items={breadcrumbs} /> : null}
          {children}
        </div>
        <div className={styles.right}>
          <AriaButton onPress={onSearchPress} className={cx(styles.searchField)}>
            <Icon icon={Search} size={16} className={styles.searchIconInField} />
            <span className={styles.searchLabel}>{t('shell.search')}</span>
            <span className={styles.searchHint} aria-hidden="true">
              /
            </span>
          </AriaButton>
          <IconButton icon={Search} aria-label={t('shell.search')} onPress={onSearchPress} className={cx(styles.searchIcon)} />
          <span className={styles.bellWrap}>
            <IconButton icon={Bell} aria-label={bellLabel} onPress={onNotificationsPress} />
            {notificationCount === 'unknown' ? <Badge dot tone="danger" className={cx(styles.bellBadge)} /> : <Badge count={notificationCount} className={cx(styles.bellBadge)} />}
          </span>
          <MenuTrigger>
            <AvatarButton name={account.name} src={account.avatarSrc} aria-label={t('shell.account')} />
            <Menu items={menuItems} header={account.name} aria-label={t('shell.account')} onAction={(key) => onMenuAction?.(String(key))} />
          </MenuTrigger>
        </div>
      </div>
      {isOffline ? (
        <div role="status" className={styles.offline}>
          <Icon icon={WifiOff} size={16} />
          <span>{t('shell.offline')}</span>
        </div>
      ) : null}
    </header>
  );
}
