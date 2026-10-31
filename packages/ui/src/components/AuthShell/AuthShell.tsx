import type { ReactNode } from 'react';
import { Link as AriaLink } from 'react-aria-components';
import { ArrowLeft } from 'lucide-react';
import { cx } from '../../utils/cx';
import { t } from '../../i18n';
import type { MediaRef } from '../../media/index';
import { Brand } from '../Brand/Brand';
import { Icon } from '../Icon/Icon';
import { MediaFrame, type MediaSource } from '../MediaFrame/MediaFrame';
import styles from './AuthShell.module.css';

export type AuthShellProps = {
  brandHref: string;
  backHref: string;
  /**
   * Decorative visual panel (left on desktop): headline + subline over a photograph from the media set (`media`) or a
   * licensed image URL (`imageSrc`); without either, the navy brand panel. Photographs of people are not used.
   */
  visual: { headline: string; subline: string; media?: MediaRef | MediaSource | undefined; imageSrc?: string | undefined };
  /** Form column content (H1 + form). */
  children: ReactNode;
  privacyHref: string;
  termsHref: string;
  /** «Помощь» is always the last footer link (consistent help). */
  helpHref: string;
  mainId?: string | undefined;
  className?: string | undefined;
};

/** Auth/onboarding shell: top bar (brand, «На главную»), visual panel + 480 px form column, footer links; stacks below 900 px. */
export function AuthShell({ brandHref, backHref, visual, children, privacyHref, termsHref, helpHref, mainId = 'main', className }: AuthShellProps) {
  const media: MediaRef | MediaSource | undefined = visual.media ?? (visual.imageSrc ? { src: visual.imageSrc, alt: '' } : undefined);
  return (
    <div className={cx(styles.shell, className)}>
      <a href={`#${mainId}`} className={styles.skipLink}>
        {t('publicShell.skipToContent')}
      </a>
      <header className={styles.topBar}>
        <Brand href={brandHref} height={40} />
        <AriaLink href={backHref} className={cx(styles.backLink)}>
          <Icon icon={ArrowLeft} size={16} />
          <span>{t('auth.backHome')}</span>
        </AriaLink>
      </header>
      <div className={styles.columns}>
        <div className={styles.visual} aria-hidden="true">
          {media ? (
            <MediaFrame media={'type' in media ? media : { ...media, alt: '' }} ratio="fill" scrim="bottom" radius="none" loading="eager" sizes="(max-width: 899px) 100vw, 640px" className={styles.visualMedia} />
          ) : null}
          <div className={styles.visualText}>
            <p className={cx('trustwork-kicker', styles.visualKicker)}>{t('brand.name')}</p>
            <p className={cx('trustwork-display', styles.visualHeadline)}>{visual.headline}</p>
            <p className={cx('trustwork-body-lg', styles.visualSub)}>{visual.subline}</p>
          </div>
        </div>
        <main id={mainId} className={styles.formColumn} tabIndex={-1}>
          {children}
        </main>
      </div>
      <footer className={styles.footer}>
        <AriaLink href={privacyHref} className={cx(styles.footerLink)}>
          {t('footer.privacy')}
        </AriaLink>
        <AriaLink href={termsHref} className={cx(styles.footerLink)}>
          {t('footer.terms')}
        </AriaLink>
        <AriaLink href={helpHref} className={cx(styles.footerLink)}>
          {t('footer.help')}
        </AriaLink>
      </footer>
    </div>
  );
}
