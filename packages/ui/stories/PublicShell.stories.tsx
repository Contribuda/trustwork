import type { Meta, StoryObj } from '@storybook/react-vite';
import { PublicFooter } from '../src/components/PublicShell/PublicFooter';
import { PublicHeader } from '../src/components/PublicShell/PublicHeader';
import { t } from '../src/i18n';

const hrefs = ['/', '/news', '/articles', '/events', '/companies', '/people', '/projects', '/magazine'] as const;

const meta = {
  title: 'Shell/Public shell',
  component: PublicHeader,
  args: { hrefs, currentIndex: 0, brandHref: '/', aboutHref: '/about', onSearchPress: () => undefined, signInHref: '/login' },
} satisfies Meta<typeof PublicHeader>;
export default meta;
type Story = StoryObj<typeof meta>;

export const HeaderAnonymous: Story = {
  render: (args) => (
    <div style={{ background: 'var(--color-canvas)' }}>
      <PublicHeader {...args} />
      <main id="main" style={{ padding: 24 }}>
        <h1>Главная</h1>
      </main>
    </div>
  ),
};

export const HeaderAuthenticated: Story = {
  render: (args) => (
    <div style={{ background: 'var(--color-canvas)' }}>
      <PublicHeader
        {...args}
        currentIndex={3}
        account={{
          name: 'Имя Фамилия',
          menuItems: [
            { id: 'workspace', label: t('publicShell.toWorkspace'), href: '/app' },
            { id: 'settings', label: t('shell.menu.accountSettings'), href: '#' },
            { id: 'help', label: t('shell.menu.help'), href: '#' },
            { id: 'signOut', label: t('shell.menu.signOut'), separatorBefore: true },
          ],
        }}
      />
      <main id="main" style={{ padding: 24 }}>
        <h1>Компании</h1>
      </main>
    </div>
  ),
};

export const HeaderMobile: Story = { ...HeaderAnonymous, globals: { viewport: { value: 'mobile375', isRotated: false } } };

export const Footer: Story = {
  render: () => (
    <PublicFooter
      topicLinks={[
        { label: 'Материалы', href: '#' },
        { label: 'Технологии', href: '#' },
        { label: 'Рынки', href: '#' },
        { label: 'Люди', href: '#' },
      ]}
      editorialLinks={[
        { label: 'О редакции', href: '#' },
        { label: 'Как мы работаем с источниками', href: '#' },
        { label: 'Предложить материал', href: '#' },
        { label: 'Контакты', href: '#' },
      ]}
      platformLinks={[
        { label: 'О сервисе', href: '#' },
        { label: t('publicShell.signIn'), href: '/login' },
      ]}
      privacyHref="/privacy"
      termsHref="/terms"
      helpHref="/help"
    />
  ),
};

export const FooterMobile: Story = { ...Footer, globals: { viewport: { value: 'mobile375', isRotated: false } } };
