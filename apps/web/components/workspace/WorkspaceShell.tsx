'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { AppHeader, AssistantLauncher, AssistantOverlay, Dialog, Link, SidebarNav, useMediaQuery, type MenuItemDef, type SidebarNavItem } from '@trustwork/ui';
import { Building2, FileText, FolderKanban, LayoutDashboard, ShoppingCart, Sparkles, Tag, User, WifiOff } from 'lucide-react';
import { SearchDialog } from '@/components/SearchDialog';
import { AssistantProvider, useAssistant } from './AssistantContext';
import { resolveDemoContext, withDemo, type DemoContext, type Persona } from '@/app/_lib/persona';
import type { NotificationView } from '@/app/_lib/data';
import { t, workspaceNav } from '@/app/_lib/i18n';
import { shortDate } from '@/app/_lib/i18n';
import styles from './WorkspaceShell.module.css';

export type ShellData = {
  name: string;
  pinned: { procurement: boolean; sales: boolean };
  attention: { procurement: number; sales: number; projects: number; publications: number; assistant: number };
  notifications: NotificationView[];
  assistantUnread: number;
  isPlatformAdmin: boolean;
};

const STORAGE_KEY = 'trustwork.sidebar.collapsed';
const NAV_PATHS = ['/app', '/app/me', '/app/company', '/app/projects', '/app/procurement', '/app/sales', '/app/publications', '/app/assistant'] as const;
const NAV_ICONS = [LayoutDashboard, User, Building2, FolderKanban, ShoppingCart, Tag, FileText, Sparkles] as const;

function isCurrentPath(pathname: string, path: string): boolean {
  return path === '/app' ? pathname === '/app' : pathname === path || pathname.startsWith(`${path}/`);
}

function buildNav(shell: ShellData, pathname: string, demo: DemoContext): { items: SidebarNavItem[]; more: SidebarNavItem[] } {
  const attention = [0, 0, 0, shell.attention.projects, shell.attention.procurement, shell.attention.sales, shell.attention.publications, shell.attention.assistant];
  const all: SidebarNavItem[] = NAV_PATHS.map((path, index) => ({
    id: path,
    label: workspaceNav()[index]!,
    href: withDemo(path, demo),
    icon: NAV_ICONS[index]!,
    isCurrent: isCurrentPath(pathname, path),
    attentionCount: attention[index],
    dividerBefore: index === 3,
  }));
  const unpinned = new Set<string>();
  if (!shell.pinned.procurement) unpinned.add('/app/procurement');
  if (!shell.pinned.sales) unpinned.add('/app/sales');
  return { items: all.filter((item) => !unpinned.has(item.id)), more: all.filter((item) => unpinned.has(item.id)) };
}

function Shell({ shell, demo, localeControl, children }: { shell: ShellData; demo: DemoContext; localeControl?: ReactNode; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isTablet = useMediaQuery('(min-width: 768px) and (max-width: 1279px)', false);
  const [collapsed, setCollapsed] = useState(false);
  const [restored, setRestored] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const assistant = useAssistant();
  const isOffline = demo.scenario === 'offline';

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
    setCollapsed(stored === null ? isTablet : stored === '1');
    setRestored(true);
  }, [isTablet]);

  const onCollapsedChange = (next: boolean) => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  };

  const { items, more } = buildNav(shell, pathname, demo);
  const unread = shell.notifications.filter((n) => n.unread).length;
  const menuItems: MenuItemDef[] = [
    { id: 'me', label: t('shell.menu.myPage'), href: withDemo('/app/me', demo) },
    { id: 'account', label: t('shell.menu.accountSettings'), href: withDemo('/app/settings', demo) },
    { id: 'security', label: t('shell.menu.security'), href: withDemo('/app/settings#security', demo) },
    { id: 'billing', label: t('shell.menu.billing'), href: withDemo('/app/settings#billing', demo) },
    ...(shell.isPlatformAdmin ? [{ id: 'admin', label: t('shell.menu.admin'), href: '/admin' }] : []),
    { id: 'exit', label: t('publicExit'), href: withDemo('/', demo), separatorBefore: true },
    { id: 'help', label: t('shell.menu.help'), href: '/#help' },
    { id: 'signOut', label: t('shell.menu.signOut'), href: '/?persona=anonymous', separatorBefore: true },
  ];

  return (
    <>
      <a href="#main" className={styles.skipLink}>
        {t('shell.skipToContent')}
      </a>
      <div className={styles.layout}>
        {isTablet && !collapsed && restored ? <div className={styles.sidebarSpacer} aria-hidden="true" /> : null}
        <SidebarNav
          items={items}
          moreItems={more}
          exitHref={withDemo('/', demo)}
          brandHref={withDemo('/app', demo)}
          isCollapsed={collapsed}
          onCollapsedChange={onCollapsedChange}
          className={styles.sidebar}
          {...(!collapsed ? { 'data-expanded': 'true' } : {})}
          {...(restored ? { 'data-restored': 'true' } : {})}
        />
        <div className={styles.content}>
          <AppHeader
            onSearchPress={() => setSearchOpen(true)}
            notificationCount={unread}
            onNotificationsPress={() => setNotificationsOpen(true)}
            account={{ name: shell.name }}
            menuItems={menuItems}
            onMenuPress={() => setNavOpen(true)}
            isOffline={isOffline}
          >
            {localeControl}
          </AppHeader>
          <main id="main" tabIndex={-1} className={`${styles.main} trustwork-scroll`}>
            {children}
          </main>
        </div>
      </div>

      <Dialog title={t('shell2.navSheetTitle')} isOpen={navOpen} onOpenChange={setNavOpen} size="sheet">
        <SidebarNav variant="sheet" items={items} moreItems={more} exitHref={withDemo('/', demo)} brandHref={withDemo('/app', demo)} />
      </Dialog>

      <Dialog title={t('shell2.notificationsTitle')} isOpen={notificationsOpen} onOpenChange={setNotificationsOpen} size="sm">
        {isOffline ? (
          <p className={styles.offline}>
            <WifiOff size={16} aria-hidden="true" /> {t('shell.offline')}
          </p>
        ) : null}
        {shell.notifications.length === 0 ? (
          <p>{t('shell.noNotifications')}</p>
        ) : (
          <ul className={styles.notificationList}>
            {shell.notifications.map((n) => (
              <li key={n.id} className={styles.notification} {...(n.unread ? { 'data-unread': 'true' } : {})}>
                <span className={styles.notificationMeta}>
                  {t(`notifications.kind.${n.kind}`)} · {shortDate(n.at)}
                </span>
                <Link href={n.href}>{n.title}</Link>
              </li>
            ))}
          </ul>
        )}
        <p style={{ marginTop: 'var(--space-4)' }}>
          <Link href={withDemo('/app/notifications', demo)} variant="standalone">
            {t('shell.allNotifications')}
          </Link>
        </p>
      </Dialog>

      <SearchDialog isOpen={searchOpen} onOpenChange={setSearchOpen} />

      <AssistantOverlay
        isOpen={assistant.isOpen}
        onClose={assistant.close}
        onMinimize={assistant.minimize}
        pageHref={withDemo('/app/assistant', demo)}
        state={isOffline ? 'offline' : 'online'}
        messages={assistant.messages}
        onSend={assistant.send}
        attentionCount={assistant.attention}
        onAttentionOpen={() => {
          assistant.minimize();
          router.push(withDemo('/app/assistant', demo));
        }}
        returnFocusTo={launcherRef}
      />
      <AssistantLauncher ref={launcherRef} isOpen={assistant.isOpen} onPress={() => (assistant.isOpen ? assistant.close() : assistant.open())} unreadCount={assistant.unread} actionRequired={assistant.attention > 0} />
    </>
  );
}

/**
 * Workspace shell for every `/app/*` route. Picks the demo principal's shell data from the query
 * (layouts cannot read the URL), keeps the single assistant conversation in context so the overlay and
 * `/app/assistant` share it, and never renders an inbox, company switcher, role switch or second avatar.
 */
export function WorkspaceShell({ shells, defaultPersona, localeControl, children }: { shells: Partial<Record<Persona, ShellData>>; defaultPersona: Persona; localeControl?: ReactNode; children: ReactNode }) {
  const params = useSearchParams();
  const demo = resolveDemoContext(params, defaultPersona);
  const shell = shells[demo.persona];
  if (!shell) return <>{children}</>;
  return (
    <AssistantProvider initialUnread={shell.assistantUnread} attention={shell.attention.assistant}>
      <Shell shell={shell} demo={demo} localeControl={localeControl}>
        {children}
      </Shell>
    </AssistantProvider>
  );
}
