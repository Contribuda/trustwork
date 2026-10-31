'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { PublicFooter, PublicHeader, type MenuItemDef } from '@trustwork/ui';
import { withDemo } from '@/app/_lib/persona';
import { t } from '@/app/_lib/i18n';
import { localHref, unprefixedLanguage } from '@/app/_lib/localize';
import { splitLanguage } from '@/app/_lib/public-paths';
import { localeTag } from '@trustwork/ui/i18n';
import { useViewer } from './viewer';

const FOOTER_TOPICS = ['materials', 'technologies', 'markets', 'projects', 'people'] as const;

const SECTION_PATHS = ['/', '/news', '/articles', '/events', '/companies', '/people', '/projects', '/magazine'] as const;

/** The page's path without its language prefix (decision 27), for the section highlight and the search box. */
function barePath(pathname: string): string {
  const lang = localeTag();
  return lang === unprefixedLanguage() ? pathname : splitLanguage(pathname, [lang]).path;
}

function currentSection(pathname: string): number | undefined {
  if (pathname === '/') return 0;
  const index = SECTION_PATHS.findIndex((path, i) => i > 0 && (pathname === path || pathname.startsWith(`${path}/`)));
  return index === -1 ? undefined : index;
}

/**
 * Public shell: header with the eight public sections (events added by owner decision 2026-10-28), search, «О платформе», sign-in or the single
 * circular avatar (menu: workspace, my page, account settings, help, sign out), `main`, footer with
 * «Помощь» last. The page is cached and the same for everybody (WEB-005): the account and the demo persona come from
 * the viewer context in the browser; links keep the page's language.
 */
export function PublicShell({ demoMode, localeControl, children }: { demoMode: boolean; localeControl?: ReactNode; children: ReactNode }) {
  const pathname = barePath(usePathname());
  const { viewer, demo, query } = useViewer();
  const account = viewer ? { name: viewer.name } : null;
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
        search={{ action: localHref('/search'), placeholder: t('search.placeholder'), defaultValue: pathname === '/search' ? (query?.get('q') ?? '') : '' }}
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
