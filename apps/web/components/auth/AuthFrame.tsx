import type { ReactNode } from 'react';
import NextLink from '@/components/locale/LocalLink';
import { ArrowLeft, BookOpenCheck, Building2, FolderKanban, GraduationCap, ShieldCheck, Users, type LucideIcon } from 'lucide-react';
import { Brand, MediaFrame } from '@/components/ui';
import type { MediaRef } from '@/app/_lib/media';
import { t } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';

export type AuthPoint = { icon: 'companies' | 'people' | 'projects' | 'magazine' | 'academy' | 'trust'; text: string };
const ICONS: Record<AuthPoint['icon'], LucideIcon> = { companies: Building2, people: Users, projects: FolderKanban, magazine: BookOpenCheck, academy: GraduationCap, trust: ShieldCheck };

/**
 * Auth frame (login, signup, recovery): top bar with the brand and «На главную», a photographic visual panel with
 * the headline and three value points (no people in photographs), a 480 px form column and the footer links
 * with «Помощь» last. Keyboard order: skip link → brand → «На главную» → form. Stacks to a compact banner on phones.
 */
export function AuthFrame({ headline, subline, media, points, children }: { headline: string; subline: string; media: MediaRef; points: AuthPoint[]; children: ReactNode }) {
  return (
    <div className="au">
      <a href="#main" className="skip-link">
        {t('publicShell.skipToContent')}
      </a>
      <header className="au__top">
        <Brand href="/" height={40} />
        <NextLink href="/" className="au__back">
          <ArrowLeft size={16} strokeWidth={2} aria-hidden="true" />
          <span>{t('auth.backHome')}</span>
        </NextLink>
      </header>
      <div className="au__cols">
        <aside className="au__visual" aria-hidden="true">
          <MediaFrame media={media} ratio="fill" radius="none" loading="eager" sizes="(max-width: 899px) 100vw, 60vw" className="au__photo" />
          <div className="au__shade" />
          <div className="au__visual-text">
            <span className="au__kicker">{t('brand.name')}</span>
            <p className="au__headline">{typo(headline)}</p>
            <p className="au__sub">{typo(subline)}</p>
            <ul className="au__points">
              {points.map((p) => {
                const Icon = ICONS[p.icon];
                return (
                  <li key={p.icon}>
                    <Icon size={18} strokeWidth={2} aria-hidden="true" />
                    {typo(p.text)}
                  </li>
                );
              })}
            </ul>
          </div>
        </aside>
        <main id="main" className="au__form" tabIndex={-1}>
          {children}
        </main>
      </div>
      <footer className="au__footer">
        <NextLink href="/#legal">{t('footer.privacy')}</NextLink>
        <NextLink href="/#legal">{t('footer.terms')}</NextLink>
        <NextLink href="/#help">{t('footer.help')}</NextLink>
      </footer>
    </div>
  );
}
