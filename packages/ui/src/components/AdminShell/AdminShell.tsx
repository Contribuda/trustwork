import {
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Menu as MenuIcon, Search } from "lucide-react";
import { Brand } from "../Brand/Brand";
import { AvatarButton } from "../Avatar/Avatar";
import { Button, IconButton } from "../Button/Button";
import { Menu, MenuTrigger, type MenuItemDef } from "../Menu/Menu";
import { Dialog } from "../Dialog/Dialog";
import {
  CommandPalette,
  type CommandPaletteProps,
} from "../CommandPalette/CommandPalette";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { localeTag, t } from "../../i18n";
import s from "./AdminShell.module.css";

export type AdminDestination = { id: string; label: string; href: string };
export type AdminNavItem = AdminDestination & { unavailableReason?: string };
export type AdminNavGroup = {
  id: string;
  label: string;
  items: readonly AdminNavItem[];
};
export type AdminAccountAction = Omit<MenuItemDef, "href" | "isDisabled"> & {
  /** Missing callbacks remain visibly unavailable; the shell never implies persistence. */
  onSelect?: () => void;
};
export type AdminShellProps = {
  /** Already projected for this viewer by the owning application. Never an authority check. */
  navigation: readonly AdminNavGroup[];
  currentPage: { id: string; title: string };
  /** One current staff scope, displayed as text. No participant impersonation or scope switch. */
  scope: string;
  account: {
    name: string;
    company?: string;
    actions: readonly AdminAccountAction[];
  };
  breadcrumbs?: readonly AdminDestination[];
  onNavigate: (destination: AdminDestination) => void;
  onLocaleChange: (locale: string) => void;
  palette: Omit<
    CommandPaletteProps,
    "isOpen" | "onOpenChange" | "enableShortcut"
  >;
  /** One destination for the existing assistant; the shell creates no chat surface. */
  assistant?: AdminDestination;
  children: ReactNode;
  notice?: ReactNode;
};

export const ADMIN_SHELL_LOCALES = [
  "en",
  "es",
  "ru",
  "uz-Latn",
  "ka",
  "hy",
  "az-Latn",
] as const;

/** Ordinary links preserve modified-click/new-tab behavior; same-tab routing belongs to the application. */
function routeClick(
  event: MouseEvent<HTMLAnchorElement>,
  destination: AdminDestination,
  navigate: AdminShellProps["onNavigate"],
) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  navigate(destination);
}

export function AdminContextNavigation({
  groups,
  currentId,
  onNavigate,
}: {
  groups: readonly AdminNavGroup[];
  currentId: string;
  onNavigate: AdminShellProps["onNavigate"];
}) {
  const id = useId();
  return (
    <nav aria-label={t("adminShell.navigation")} className={s.navigation}>
      {!groups.some((group) => group.items.length) && (
        <p>{t("adminShell.emptyNavigation")}</p>
      )}
      {groups
        .filter((group) => group.items.length)
        .map((group, index) => (
          <section key={group.id} aria-labelledby={`${id}-${index}`}>
            <h2 id={`${id}-${index}`}>{group.label}</h2>
            <ul>
              {group.items.map((item) => (
                <li key={item.id}>
                  {item.unavailableReason ? (
                    <>
                      <span aria-disabled="true" className={s.unavailable}>
                        {item.label}
                      </span>
                      <small>{item.unavailableReason}</small>
                    </>
                  ) : (
                    <a
                      href={item.href}
                      aria-current={currentId === item.id ? "page" : undefined}
                      onClick={(event) => routeClick(event, item, onNavigate)}
                    >
                      {item.label}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
    </nav>
  );
}

/** Shared header composition. Menu owns its keyboard model; the avatar is the only account control. */
function AdminHeader({
  scope,
  account,
  onLocaleChange,
  onMenu,
  menuOpen,
  menuId,
  menuRef,
  onSearch,
  accountOpen,
  onAccountOpenChange,
}: {
  scope: string;
  account: AdminShellProps["account"];
  onLocaleChange: AdminShellProps["onLocaleChange"];
  onMenu: () => void;
  menuOpen: boolean;
  menuId: string;
  menuRef: RefObject<HTMLButtonElement | null>;
  onSearch: () => void;
  accountOpen: boolean;
  onAccountOpenChange: (open: boolean) => void;
}) {
  const language = localeTag();
  const languageId = useId();
  return (
    <header className={s.header}>
      <div className={s.identity}>
        <Brand height={32} />
        <div>
          <strong>{t("adminShell.title")}</strong>
          <p>{t("adminShell.scope", { scope })}</p>
        </div>
      </div>
      <div className={s.controls}>
        <IconButton
          ref={menuRef}
          icon={MenuIcon}
          aria-label={t("adminShell.navigation")}
          aria-expanded={menuOpen}
          {...(menuOpen ? { "aria-controls": menuId } : {})}
          onPress={onMenu}
        />
        <IconButton
          icon={Search}
          aria-label={t("consoleKit.commands")}
          onPress={onSearch}
        />
        <div className={s.language}>
          <label htmlFor={languageId}>{t("consoleKit.language")}</label>
          <select
            id={languageId}
            value={language}
            onChange={(event) => onLocaleChange(event.target.value)}
          >
            {ADMIN_SHELL_LOCALES.map((tag) => (
              <option key={tag} value={tag}>
                {t(`adminShell.languages.${tag}`)}
              </option>
            ))}
          </select>
        </div>
        <MenuTrigger isOpen={accountOpen} onOpenChange={onAccountOpenChange}>
          <AvatarButton
            name={account.name}
            aria-label={t("shell.account")}
            size={40}
          />
          <Menu
            aria-label={t("shell.account")}
            className={s.accountMenu}
            header={
              <div className={s.accountDetails}>
                <span>{account.name}</span>
                {account.company && <span>{account.company}</span>}
                {account.actions.some((action) => !action.onSelect) && (
                  <p>{t("adminShell.accountUnavailable")}</p>
                )}
                {!account.actions.length && (
                  <p>{t("adminShell.emptyAccount")}</p>
                )}
              </div>
            }
            items={account.actions.map((action) => ({
              ...action,
              isDisabled: !action.onSelect,
            }))}
            onAction={(key) =>
              account.actions.find((action) => action.id === key)?.onSelect?.()
            }
          />
        </MenuTrigger>
      </div>
    </header>
  );
}

/** Presentation only: caller-owned routes, commands, translations and projected context; no data access. */
export function AdminShell({
  navigation,
  currentPage,
  scope,
  account,
  breadcrumbs = [],
  onNavigate,
  onLocaleChange,
  palette,
  assistant,
  notice,
  children,
}: AdminShellProps) {
  const id = useId();
  const menuId = `${id}-menu`;
  const mainId = `${id}-main`;
  const mobile = useIsMobile();
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const lastPage = useRef(currentPage.id);
  const lastMobile = useRef(mobile);

  useEffect(() => {
    if (
      lastMobile.current !== mobile &&
      mobile &&
      sidebarRef.current?.contains(document.activeElement)
    )
      menuRef.current?.focus();
    lastMobile.current = mobile;
    // An open modal stays open across a resize: its focused control is never unmounted.
  }, [mobile]);

  useEffect(() => {
    if (lastPage.current === currentPage.id) return;
    lastPage.current = currentPage.id;
    setMenuOpen(false);
    setPaletteOpen(false);
    setAccountOpen(false);
    // Allow React Aria's overlay restoration to finish before announcing the new page.
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => headingRef.current?.focus());
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [currentPage.id]);

  function openPalette(open: boolean) {
    // Do not let the global shortcut stack a dialog over another menu/dialog.
    if (
      open &&
      (menuOpen || accountOpen || document.querySelector('[role="dialog"]'))
    )
      return;
    setPaletteOpen(open);
  }
  const parent = breadcrumbs.at(-1);
  return (
    <div className={s.shell}>
      <a
        className={s.skip}
        href={`#${mainId}`}
        onClick={(event) => {
          event.preventDefault();
          headingRef.current?.focus();
        }}
      >
        {t("adminShell.skip")}
      </a>
      <AdminHeader
        scope={scope}
        account={account}
        onLocaleChange={onLocaleChange}
        onMenu={() => setMenuOpen(true)}
        menuOpen={menuOpen}
        menuId={menuId}
        menuRef={menuRef}
        onSearch={() => openPalette(true)}
        accountOpen={accountOpen}
        onAccountOpenChange={setAccountOpen}
      />
      {notice && <div className={s.notice}>{notice}</div>}
      <div className={s.layout}>
        <div ref={sidebarRef} className={s.sidebar} hidden={mobile}>
          <AdminContextNavigation
            groups={navigation}
            currentId={currentPage.id}
            onNavigate={onNavigate}
          />
        </div>
        <main id={mainId} className={s.main}>
          {breadcrumbs.length > 0 && (
            <nav aria-label={t("common.breadcrumbs")} className={s.breadcrumbs}>
              <ol>
                {(mobile && parent ? [parent] : breadcrumbs).map((item) => (
                  <li key={item.id}>
                    <a
                      href={item.href}
                      onClick={(event) => routeClick(event, item, onNavigate)}
                    >
                      {mobile
                        ? t("adminShell.back", { page: item.label })
                        : item.label}
                    </a>
                  </li>
                ))}
                {!mobile && <li aria-current="page">{currentPage.title}</li>}
              </ol>
            </nav>
          )}
          <div className={s.titleRow}>
            <h1 ref={headingRef} tabIndex={-1}>
              {currentPage.title}
            </h1>
            {assistant && (
              <a
                href={assistant.href}
                onClick={(event) => routeClick(event, assistant, onNavigate)}
              >
                {assistant.label}
              </a>
            )}
          </div>
          {children}
        </main>
      </div>
      <Dialog
        title={t("adminShell.navigation")}
        isOpen={menuOpen}
        onOpenChange={setMenuOpen}
        size="sheet"
        className={s.menuSheet}
      >
        <div id={menuId}>
          <p className={s.scrollHint}>{t("adminShell.scrollNavigation")}</p>
          <AdminContextNavigation
            groups={navigation}
            currentId={currentPage.id}
            onNavigate={(destination) => {
              setMenuOpen(false);
              onNavigate(destination);
            }}
          />
        </div>
        <Button variant="secondary" onPress={() => setMenuOpen(false)}>
          {t("common.close")}
        </Button>
      </Dialog>
      <CommandPalette
        {...palette}
        isOpen={paletteOpen}
        onOpenChange={openPalette}
        enableShortcut={!menuOpen && !accountOpen}
      />
    </div>
  );
}
