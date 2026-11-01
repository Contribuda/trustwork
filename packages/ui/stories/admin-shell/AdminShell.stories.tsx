import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { getLocaleStore, setLocaleStore } from '@trustwork/i18n-runtime';
import { AdminShell, type AdminDestination, type AdminNavGroup } from '../../src/components/AdminShell/AdminShell';
import { EmptyState } from '../../src/components/EmptyState/EmptyState';
import { UiProvider } from '../../src/components/UiProvider/UiProvider';
import { localeTag, t } from '../../src/i18n';
import { uiLayers } from '../../src/i18n/dictionaries';
import { registerBrandOverlay } from '../../src/brand';
import { BUILT_IN_OVERLAYS, DEFAULT_BRAND_ID } from '../../../../apps/web/brand';

const meta = { title: 'Console/Admin shell', parameters: { layout: 'fullscreen' }, globals: { a11y: { manual: true } } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Example({ empty = false, long = false }: { empty?: boolean; long?: boolean }) {
  const [language, setLanguage] = useState(localeTag());
  const [current, setCurrent] = useState('overview');
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState(false);
  const [request, setRequest] = useState('');
  const overlay = BUILT_IN_OVERLAYS[DEFAULT_BRAND_ID]!;
  registerBrandOverlay(overlay);
  setLocaleStore({ ...getLocaleStore(), locale: language, layers: [...(overlay.messages[language] ? [overlay.messages[language]!] : []), ...uiLayers(language)] });
  const destinations = [
    { id: 'overview', label: t('adminShell.overview'), href: '#overview' },
    { id: 'editorial', label: t('adminShell.editorial'), href: '#editorial' },
    { id: 'outreach', label: t('adminShell.outreach'), href: '#outreach' },
    { id: 'network', label: t('adminShell.network'), href: '#network' },
    { id: 'approvals', label: long ? t('adminShell.longTitle') : t('adminShell.approvals'), href: '#approvals' },
    { id: 'notifications', label: t('adminShell.notifications'), href: '#notifications' },
    { id: 'help', label: t('adminShell.help'), href: '#help' },
  ];
  const page = destinations.find(item => item.id === current) ?? { id: 'assistant', label: t('assistant.title'), href: '#assistant' };
  const navigation: AdminNavGroup[] = empty ? [] : [
    { id: 'work', label: t('adminShell.title'), items: destinations.slice(0, 5) },
    { id: 'support', label: t('adminShell.help'), items: [destinations[5]!, { ...destinations[6]!, unavailableReason: t('adminShell.unavailable') }] },
  ];
  function navigate(destination: AdminDestination) {
    setRequest(destination.id);
    setCurrent(destination.id);
    setNotice(false);
  }
  return <UiProvider withToastRegion={false}><AdminShell
    scope={t('adminShell.scopeName')}
    currentPage={{ id: current, title: long && current === 'overview' ? t('adminShell.longTitle') : page.label }}
    account={{ name: t('adminShell.person'), company: t('adminShell.company'), actions: empty ? [] : [
      { id: 'settings', label: t('shell.menu.accountSettings'), onSelect: () => { setRequest('settings'); setNotice(true); } },
      { id: 'signout', label: t('shell.menu.signOut') },
    ] }}
    navigation={navigation} breadcrumbs={current === 'overview' ? [] : [destinations[0]!]}
    onNavigate={navigate}
    onLocaleChange={tag => { document.documentElement.lang = tag; setLanguage(tag); }}
    palette={{ query, onQueryChange: setQuery, commands: empty ? [] : destinations.slice(0, 6).filter(item => item.label.toLocaleLowerCase(language).includes(query.toLocaleLowerCase(language))).map(item => ({ id: item.id, label: item.label, group: t('adminShell.navigation'), onSelect: () => navigate(item) })) }}
    assistant={{ id: 'assistant', label: t('assistant.title'), href: '#assistant' }}
    notice={<p role="note">{t('adminShell.previewNotice')} {t('adminShell.translationNote')}</p>}
  >
    <EmptyState title={t('adminShell.emptyTitle')}><p>{t('adminShell.emptyBody')}</p></EmptyState>
    <p role="status" data-request={request}>{notice ? t('adminShell.requestNotice') : ''}</p>
  </AdminShell></UiProvider>;
}
export const Overview: Story = { render: () => <Example /> };
export const LongLabels: Story = { render: () => <Example long /> };
export const Empty: Story = { render: () => <Example empty /> };
