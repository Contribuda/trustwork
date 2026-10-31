import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Dialog as AriaDialog, Link as AriaLink, Modal, ModalOverlay } from 'react-aria-components';
import { Menu as MenuIcon, Search, X } from 'lucide-react';
import { cx } from '../../utils/cx';
import { locale, t, type LocaleKey } from '../../i18n';
import { Brand } from '../Brand/Brand';
import { ButtonLink, IconButton } from '../Button/Button';
import { AvatarButton } from '../Avatar/Avatar';
import { Menu, MenuTrigger, type MenuItemDef } from '../Menu/Menu';
import styles from './PublicShell.module.css';

export type PublicNavProps = {
  /** Hrefs in the exact order of `ru.publicNav` (eight public sections). */
  hrefs: readonly string[];
  currentIndex?: number | undefined;
};

export type PublicHeaderProps = PublicNavProps & {
  brandHref: string;
  aboutHref: string;
  /** Inline search: the icon expands a field in the top bar that submits a GET to `action`. */
  search?: { action: string; placeholder: string; name?: string | undefined; defaultValue?: string | undefined } | undefined;
  /** Legacy: open an external search dialog instead of the inline field. */
  onSearchPress?: (() => void) | undefined;
  /** Anonymous: sign-in link; authenticated: avatar + menu. */
  signInHref?: string | undefined;
  account?: { name: string; avatarSrc?: string | undefined; menuItems: readonly MenuItemDef[]; onMenuAction?: ((key: string) => void) | undefined } | undefined;
  /** Id of the main landmark for the skip link. */
  mainId?: string | undefined;
  children?: ReactNode;
  className?: string | undefined;
};

function NavList({ hrefs, currentIndex, onNavigate, className }: PublicNavProps & { onNavigate?: (() => void) | undefined; className?: string | undefined }) {
  return (
    <ul className={cx(styles.navList, className)}>
      {locale.publicNav.map((_, index) => (
        <li key={index}>
          <AriaLink href={hrefs[index] ?? '#'} className={cx(styles.navLink)} {...(index === currentIndex ? { 'aria-current': 'page' } : {})} {...(onNavigate ? { onPress: onNavigate } : {})}>
            {t(`publicNav.${index}` as LocaleKey)}
          </AriaLink>
        </li>
      ))}
    </ul>
  );
}

/**
 * Public header: brand, tagline, inline search (icon expands a field that submits to the search route), «О платформе», sign-in or avatar; navigation row with exactly the seven
 * accepted sections (`nav[aria-label="Разделы"]`, `aria-current`). Mobile: menu button opens a modal sheet with the same items in the same order.
 */
export function PublicHeader({ hrefs, currentIndex, brandHref, aboutHref, search, onSearchPress, signInHref, account, mainId = 'main', children, className }: PublicHeaderProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (searchOpen) inputRef.current?.focus();
  }, [searchOpen]);
  return (
    <header className={cx(styles.header, className)}>
      <a href={`#${mainId}`} className={styles.skipLink}>
        {t('publicShell.skipToContent')}
      </a>
      <div className={styles.topBar}>
        <div className={styles.brandGroup}>
          <Brand href={brandHref} height={36} />
          <span className={styles.tagline}>{t('publicShell.tagline')}</span>
        </div>
        <div className={styles.actions}>
          {children}
          {search ? (
            <form
              role="search"
              action={search.action}
              method="get"
              className={cx(styles.searchForm)}
              data-open={searchOpen ? 'true' : undefined}
              onSubmit={(event) => {
                if (!inputRef.current?.value.trim()) {
                  event.preventDefault();
                  setSearchOpen(true);
                  inputRef.current?.focus();
                }
              }}
            >
              <input
                ref={inputRef}
                name={search.name ?? 'q'}
                type="search"
                className={styles.searchInput}
                placeholder={search.placeholder}
                aria-label={t('publicShell.search')}
                defaultValue={search.defaultValue ?? ''}
                tabIndex={searchOpen ? 0 : -1}
                autoComplete="off"
                enterKeyHint="search"
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setSearchOpen(false);
                }}
                onBlur={(event) => {
                  const next = event.relatedTarget as HTMLElement | null;
                  if (!event.currentTarget.value.trim() && !next?.closest(`.${styles.searchForm}`)) setSearchOpen(false);
                }}
              />
              {searchOpen ? (
                <button type="button" className={styles.searchClose} aria-label={t('publicShell.closeSearch')} onClick={() => setSearchOpen(false)}>
                  <X size={16} strokeWidth={2} aria-hidden="true" />
                </button>
              ) : null}
              <IconButton
                icon={Search}
                aria-label={t('publicShell.search')}
                aria-expanded={searchOpen}
                onPress={() => {
                  if (!searchOpen) setSearchOpen(true);
                  else if (inputRef.current?.value.trim()) inputRef.current.form?.requestSubmit();
                  else inputRef.current?.focus();
                }}
              />
            </form>
          ) : onSearchPress ? (
            <IconButton icon={Search} aria-label={t('publicShell.search')} onPress={onSearchPress} />
          ) : null}
          <AriaLink href={aboutHref} className={cx(styles.aboutLink)}>
            {t('publicShell.about')}
          </AriaLink>
          {account ? (
            <MenuTrigger>
              <AvatarButton name={account.name} src={account.avatarSrc} aria-label={t('shell.account')} size={36} />
              <Menu items={account.menuItems} header={account.name} onAction={(key) => account.onMenuAction?.(String(key))} />
            </MenuTrigger>
          ) : signInHref ? (
            <AriaLink href={signInHref} className={cx(styles.signIn)}>
              {t('publicShell.signIn')}
            </AriaLink>
          ) : null}
          <IconButton icon={MenuIcon} aria-label={t('publicShell.menu')} onPress={() => setSheetOpen(true)} className={cx(styles.menuButton)} aria-expanded={sheetOpen} />
        </div>
      </div>
      <nav aria-label={t('publicShell.navLabel')} className={styles.navRow}>
        <NavList hrefs={hrefs} currentIndex={currentIndex} />
      </nav>
      <ModalOverlay isOpen={sheetOpen} onOpenChange={setSheetOpen} isDismissable className={cx(styles.sheetOverlay)}>
        <Modal className={cx(styles.sheet)}>
          <AriaDialog aria-label={t('publicShell.menu')} className={cx(styles.sheetDialog)}>
            <div className={styles.sheetHeader}>
              <Brand height={32} decorative />
              <IconButton icon={X} aria-label={t('publicShell.closeMenu')} onPress={() => setSheetOpen(false)} />
            </div>
            <nav aria-label={t('publicShell.navLabel')}>
              <NavList hrefs={hrefs} currentIndex={currentIndex} onNavigate={() => setSheetOpen(false)} className={styles.sheetNav} />
            </nav>
            {signInHref && !account ? (
              <ButtonLink href={signInHref} fullWidth onPress={() => setSheetOpen(false)}>
                {t('publicShell.signIn')}
              </ButtonLink>
            ) : null}
          </AriaDialog>
        </Modal>
      </ModalOverlay>
    </header>
  );
}
