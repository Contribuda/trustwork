'use client';

import type { ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { PublicFooter, PublicHeader, type MenuItemDef } from '@trustwork/ui';
import { resolveDemoContext, withDemo, type Persona } from '@/app/_lib/persona';
import { t } from '@/app/_lib/i18n';

export type ShellAccount = { name: string } | null;

const FOOTER_TOPICS = ['materials', 'technologies', 'markets', 'projects', 'people'] as const;

const SECTION_PATHS = ['/', '/news', '/articles', '/events', '/companies', '/people', '/projects', '/magazine'] as const;

function currentSection(pathname: string): number | undefined {
  if (pathname === '/') return 0;
  const index = SECTION_PATHS.findIndex((path, i) => i > 0 && (pathname === path || pathname.startsWith(`${path}/`)));
  return index === -1 ? undefined : index;
}

/**
 * Public shell: header with the eight public sections (events added by owner decision 2026-10-28), search, «О платформе», sign-in or the single
 * circular avatar (menu: workspace, my page, account settings, help, sign out), `main`, footer with
 * «Помощь» last. The demo persona comes from the query so static pages stay static.
 */
export function PublicShell({ accounts, defaultPersona, demoMode, localeControl, children }: { accounts: Record<Persona, ShellAccount>; defaultPersona: Persona; demoMode: boolean; localeControl?: ReactNode; children: ReactNode }) {
  const pathname = usePathname();
  const params = useSearchParams();
  // Live mode (WEB-004): the query never selects a principal; the layout passes the session's account under the default key.
  const demo = resolveDemoContext(params, defaultPersona, demoMode);
  const account = accounts[demo.persona];
  const hrefs = SECTION_PATHS.map((path) => withDemo(path, demo));

  const menuItems: readonly MenuItemDef[] = [
    { id: 'workspace', label: t('publicShell.toWorkspace'), href: withDemo('/app', demo) },
    { id: 'me', label: t('shell.menu.myPage'), href: withDemo('/app/me', demo) },
    { id: 'settings', label: t('shell.menu.accountSettings'), href: withDemo('/app/settings', demo) },
    { id: 'help', label: t('shell.menu.help'), href: '/#help', separatorBefore: true },
    { id: 'signOut', label: t('shell.menu.signOut'), href: demoMode ? '/?persona=anonymous' : '/logout' },
  ];

  return (
    <>
      <PublicHeader
        hrefs={hrefs}
        currentIndex={currentSection(pathname)}
        brandHref={withDemo('/', demo)}
        aboutHref="/#about"
        search={{ action: '/search', placeholder: t('search.placeholder'), defaultValue: pathname === '/search' ? (params.get('q') ?? '') : '' }}
        signInHref={account ? undefined : '/login'}
        account={account ? { name: account.name, menuItems } : undefined}
        mainId="main"
      >
        {localeControl}
      </PublicHeader>
      <main id="main" tabIndex={-1} style={{ flex: '1 1 auto' }}>
        {children}
      </main>
      <PublicFooter
        editorialLinks={[
          { label: t('footer.aboutMagazine'), href: '/magazine' },
          { label: t('magazine.suggestAction'), href: '/login?next=%2Fapp%2Fpublications' },
          { label: t('news.howWeWorkWithSources'), href: '/news#sources' },
        ]}
        topicLinks={FOOTER_TOPICS.map((key) => ({ label: t(`taxonomy.topics.${key}`), href: withDemo(`/?topic=${key}#feed`, demo) }))}
        platformLinks={[
          { label: t('footer.aboutService'), href: '/#about' },
          { label: t('footer.signIn'), href: '/login' },
          { label: t('auth.register'), href: '/signup' },
        ]}
        privacyHref="/#legal"
        termsHref="/#legal"
        helpHref="/#help"
      />
    </>
  );
}
