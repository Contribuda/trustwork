import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Building2, FileText, FolderKanban, Home, ShoppingCart, Sparkles, TrendingUp, User } from 'lucide-react';
import { AppHeader } from '../src/components/AppHeader/AppHeader';
import { SidebarNav, type SidebarNavItem } from '../src/components/SidebarNav/SidebarNav';
import { Skeleton } from '../src/components/Skeleton/Skeleton';
import { locale } from '../src/i18n';
import { avatarMenuItems } from './fixtures';

const icons = [Home, User, Building2, FolderKanban, ShoppingCart, TrendingUp, FileText, Sparkles];

const navItems: SidebarNavItem[] = locale.workspaceNav.map((label, index) => ({
  id: String(index),
  label,
  href: '#',
  icon: icons[index] ?? Home,
  isCurrent: index === 0,
  dividerBefore: index === 3,
  attentionCount: index === 4 ? 2 : index === 5 ? 1 : undefined,
}));

function SidebarDemo({ collapsed = false, withMore = false, loading = false }: { collapsed?: boolean; withMore?: boolean; loading?: boolean }) {
  const [isCollapsed, setCollapsed] = useState(collapsed);
  const items = withMore ? navItems.filter((i) => i.id !== '4' && i.id !== '5') : navItems;
  const more = withMore ? navItems.filter((i) => i.id === '4' || i.id === '5') : undefined;
  return (
    <div style={{ height: 640, display: 'flex', background: 'var(--color-canvas)' }}>
      <SidebarNav items={items} moreItems={more} exitHref="#" brandHref="#" isCollapsed={isCollapsed} onCollapsedChange={setCollapsed}>
        {loading ? <Skeleton lines={2} className="" /> : null}
      </SidebarNav>
      <main style={{ flex: 1, padding: 24 }}>
        <h1>Обзор</h1>
      </main>
    </div>
  );
}

const meta = { title: 'Shell/Workspace shell', component: SidebarNav } satisfies Meta<typeof SidebarNav>;
export default meta;
type Story = StoryObj;

export const SidebarExpanded: Story = { render: () => <SidebarDemo /> };
export const SidebarCollapsed: Story = { render: () => <SidebarDemo collapsed /> };
export const SidebarWithMore: Story = { render: () => <SidebarDemo withMore /> };
export const SidebarSheet: Story = {
  render: () => (
    <div style={{ maxWidth: 320 }}>
      <SidebarNav variant="sheet" items={navItems} exitHref="#" brandHref="#" />
    </div>
  ),
};

function HeaderDemo(props: Partial<React.ComponentProps<typeof AppHeader>>) {
  return (
    <div style={{ background: 'var(--color-canvas)', minHeight: 200 }}>
      <AppHeader onSearchPress={() => undefined} notificationCount={3} onNotificationsPress={() => undefined} account={{ name: 'Имя Фамилия' }} menuItems={avatarMenuItems} {...props} />
      <main style={{ padding: 24 }}>
        <h1>Обзор</h1>
      </main>
    </div>
  );
}

export const Header: Story = { render: () => <HeaderDemo /> };
export const HeaderWithBreadcrumb: Story = {
  render: () => (
    <HeaderDemo
      breadcrumbs={[
        { id: 'projects', label: 'Проекты', href: '#' },
        { id: 'project', label: 'Пример проекта' },
      ]}
    />
  ),
};
export const HeaderNoNotifications: Story = { render: () => <HeaderDemo notificationCount={0} /> };
export const HeaderUnknownCount: Story = { render: () => <HeaderDemo notificationCount="unknown" /> };
export const HeaderOffline: Story = { render: () => <HeaderDemo isOffline /> };
export const HeaderWithLongContent: Story = {
  render: () => (
    <div style={{ background: 'var(--color-canvas)' }}>
      <AppHeader onSearchPress={() => undefined} notificationCount={0} onNotificationsPress={() => undefined} account={{ name: 'Имя Фамилия' }} menuItems={avatarMenuItems} />
      <main style={{ padding: 24, display: 'grid', gap: 16 }}>
        <h1>Обзор</h1>
        {Array.from({ length: 30 }, (_, i) => (
          <p key={i}>Абзац {i + 1}. Длинное содержимое страницы, чтобы шапка оставалась закреплённой при прокрутке.</p>
        ))}
        <button type="button" data-testid="deep-control">Кнопка в середине страницы</button>
        {Array.from({ length: 30 }, (_, i) => (
          <p key={`b${i}`}>Абзац {i + 31}. Продолжение содержимого.</p>
        ))}
      </main>
    </div>
  ),
};
export const HeaderMobile: Story = { render: () => <HeaderDemo onMenuPress={() => undefined} />, globals: { viewport: { value: 'mobile375', isRotated: false } } };
