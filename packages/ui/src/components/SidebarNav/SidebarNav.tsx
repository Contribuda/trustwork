import { useId, type ReactNode } from 'react';
import { Button as AriaButton, Disclosure, DisclosurePanel, Link as AriaLink, TooltipTrigger } from 'react-aria-components';
import type { LucideIcon } from 'lucide-react';
import { ChevronDown, ChevronsLeft, ChevronsRight, Compass } from 'lucide-react';
import { cx } from '../../utils/cx';
import { t } from '../../i18n';
import { Badge } from '../Badge/Badge';
import { Brand } from '../Brand/Brand';
import { Icon } from '../Icon/Icon';
import { Tooltip } from '../Tooltip/Tooltip';
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden';
import styles from './SidebarNav.module.css';

export type SidebarNavItem = {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  isCurrent?: boolean | undefined;
  /** Number of objects needing the person's decision; rendered as a badge with a text alternative. */
  attentionCount?: number | undefined;
  /** Renders a divider before this item (group boundary; the order never changes). */
  dividerBefore?: boolean | undefined;
};

export type SidebarNavProps = {
  items: readonly SidebarNavItem[];
  /** Unpinned items shown under «Ещё» in the same order; never deleted. */
  moreItems?: readonly SidebarNavItem[] | undefined;
  /** Outbound link to the public resource («В отрасль»). */
  exitHref: string;
  brandHref: string;
  isCollapsed?: boolean | undefined;
  onCollapsedChange?: ((collapsed: boolean) => void) | undefined;
  /** `sheet` = inside the mobile navigation dialog (always expanded, no collapse control). */
  variant?: 'sidebar' | 'sheet' | undefined;
  /** Optional slot under the brand row (for example skeleton while counts load). */
  children?: ReactNode;
  className?: string | undefined;
};

function NavLink({ item, collapsed }: { item: SidebarNavItem; collapsed: boolean }) {
  const attention = item.attentionCount ?? 0;
  const link = (
    <AriaLink href={item.href} className={cx(styles.item)} {...(item.isCurrent ? { 'aria-current': 'page' } : {})}>
      <span className={styles.iconWrap}>
        <Icon icon={item.icon} size={20} />
        {collapsed && attention > 0 ? <Badge count={attention} className={cx(styles.badgeCollapsed)} /> : null}
      </span>
      {collapsed ? <VisuallyHidden>{item.label}</VisuallyHidden> : <span className={styles.label}>{item.label}</span>}
      {attention > 0 ? (
        <>
          {!collapsed ? <Badge count={attention} /> : null}
          <VisuallyHidden>, {t('shell.attention', { count: attention })}</VisuallyHidden>
        </>
      ) : null}
    </AriaLink>
  );
  if (!collapsed) return link;
  return (
    <TooltipTrigger delay={200}>
      {link}
      <Tooltip placement="right">{item.label}</Tooltip>
    </TooltipTrigger>
  );
}

/**
 * Workspace navigation (`nav[aria-label="Рабочее пространство"]`). The collapse control sits INSIDE the brand row;
 * collapsed state keeps icons, tooltips and visually hidden labels; keyboard order is identical in both states.
 * No account block, no company switcher, no automatic reordering.
 */
export function SidebarNav({ items, moreItems, exitHref, brandHref, isCollapsed = false, onCollapsedChange, variant = 'sidebar', children, className }: SidebarNavProps) {
  const collapsed = variant === 'sidebar' && isCollapsed;
  const moreId = useId();
  return (
    <nav aria-label={t('shell.navLabel')} className={cx(styles.nav, collapsed && styles.collapsed, variant === 'sheet' && styles.sheet, className)} data-collapsed={collapsed || undefined}>
      <div className={styles.brandRow}>
        <Brand variant={collapsed ? 'mark' : 'full'} height={collapsed ? 32 : 40} href={brandHref} />
        {variant === 'sidebar' ? (
          <TooltipTrigger delay={200}>
            <AriaButton className={cx(styles.collapseButton)} aria-expanded={!collapsed} aria-label={collapsed ? t('shell.expand') : t('shell.collapse')} onPress={() => onCollapsedChange?.(!collapsed)}>
              <Icon icon={collapsed ? ChevronsRight : ChevronsLeft} size={20} />
            </AriaButton>
            <Tooltip placement="right">{collapsed ? t('shell.expand') : t('shell.collapse')}</Tooltip>
          </TooltipTrigger>
        ) : null}
      </div>
      {children}
      <ul className={styles.list}>
        {items.map((item) => (
          <li key={item.id} className={cx(item.dividerBefore && styles.dividerBefore)}>
            <NavLink item={item} collapsed={collapsed} />
          </li>
        ))}
        {moreItems && moreItems.length ? (
          <li>
            <Disclosure className={cx(styles.disclosure)}>
              {({ isExpanded }) => (
                <>
                  <AriaButton slot="trigger" className={cx(styles.item, styles.moreButton)} aria-controls={moreId}>
                    <span className={styles.iconWrap}>
                      <Icon icon={ChevronDown} size={20} className={cx(styles.chevron, isExpanded && styles.chevronOpen)} />
                    </span>
                    {collapsed ? <VisuallyHidden>{t('shell.more')}</VisuallyHidden> : <span className={styles.label}>{t('shell.more')}</span>}
                  </AriaButton>
                  <DisclosurePanel id={moreId} className={cx(styles.morePanel)}>
                    <ul className={styles.list}>
                      {moreItems.map((item) => (
                        <li key={item.id}>
                          <NavLink item={item} collapsed={collapsed} />
                        </li>
                      ))}
                    </ul>
                  </DisclosurePanel>
                </>
              )}
            </Disclosure>
          </li>
        ) : null}
      </ul>
      <div className={styles.footer}>
        <NavLink item={{ id: 'exit', label: t('publicExit'), href: exitHref, icon: Compass }} collapsed={collapsed} />
      </div>
    </nav>
  );
}
