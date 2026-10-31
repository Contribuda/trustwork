import type { ReactNode } from 'react';
import { Link as AriaLink } from 'react-aria-components';
import { cx } from '../../utils/cx';
import { t } from '../../i18n';
import { Brand } from '../Brand/Brand';
import styles from './PublicShell.module.css';

export type FooterLink = { label: string; href: string };

export type SocialLink = { label: string; href: string; icon: ReactNode };

export type PublicFooterProps = {
  editorialLinks: readonly FooterLink[];
  /** Topic links («Темы»); the column is omitted when empty. */
  topicLinks?: readonly FooterLink[] | undefined;
  platformLinks: readonly FooterLink[];
  /** Social accounts; rendered only when the product has real ones. */
  socialLinks?: readonly SocialLink[] | undefined;
  privacyHref: string;
  termsHref: string;
  /** «Помощь» is always the last link of the legal group (WCAG 2.2 3.2.6 consistent help). */
  helpHref: string;
  className?: string | undefined;
};

/** `contentinfo` landmark on a light surface: brand, tagline and social links; «Редакция», «Темы», «Платформа» columns; a bottom row with the copyright, legal links and «Помощь» last (WCAG 2.2 consistent help). */
export function PublicFooter({ editorialLinks, topicLinks, platformLinks, socialLinks, privacyHref, termsHref, helpHref, className }: PublicFooterProps) {
  const column = (title: string, links: readonly FooterLink[]) => (
    <div className={styles.footerColumn}>
      <h2 className={styles.footerTitle}>{title}</h2>
      <ul className={styles.footerList}>
        {links.map((link) => (
          <li key={link.href + link.label}>
            <AriaLink href={link.href} className={cx(styles.footerLink)}>
              {link.label}
            </AriaLink>
          </li>
        ))}
      </ul>
    </div>
  );
  return (
    <footer className={cx(styles.footer, className)}>
      <div className={styles.footerInner}>
        <div className={styles.footerBrand}>
          <Brand height={32} decorative />
          <p className={styles.footerTagline}>{t('footer.tagline')}</p>
          {socialLinks && socialLinks.length ? (
            <ul className={styles.footerSocial} aria-label={t('footer.social')}>
              {socialLinks.map((link) => (
                <li key={link.href}>
                  <AriaLink href={link.href} className={cx(styles.footerSocialLink)} aria-label={link.label}>
                    <span aria-hidden="true">{link.icon}</span>
                  </AriaLink>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {column(t('footer.editorial'), editorialLinks)}
        {topicLinks && topicLinks.length ? column(t('footer.topics'), topicLinks) : null}
        {column(t('footer.platform'), platformLinks)}
      </div>
      <div className={styles.footerBottom}>
        <p className={styles.copyright}>{t('footer.copyright')}</p>
        <ul className={styles.footerLegal} aria-label={t('footer.legal')}>
          {[
            { label: t('footer.privacy'), href: privacyHref },
            { label: t('footer.terms'), href: termsHref },
            { label: t('footer.help'), href: helpHref },
          ].map((link) => (
            <li key={link.href + link.label}>
              <AriaLink href={link.href} className={cx(styles.footerLink, styles.footerLegalLink)}>
                {link.label}
              </AriaLink>
            </li>
          ))}
        </ul>
      </div>
    </footer>
  );
}
