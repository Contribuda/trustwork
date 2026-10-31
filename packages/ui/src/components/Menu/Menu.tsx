import type { ReactNode } from 'react';
import { Menu as AriaMenu, MenuItem as AriaMenuItem, type MenuProps as AriaMenuProps, MenuTrigger, Popover, Separator, type Key } from 'react-aria-components';
import type { LucideIcon } from 'lucide-react';
import { cx } from '../../utils/cx';
import { Icon } from '../Icon/Icon';
import styles from './Menu.module.css';

export type MenuItemDef = {
  id: Key;
  label: string;
  href?: string | undefined;
  icon?: LucideIcon | undefined;
  isDisabled?: boolean | undefined;
  isDestructive?: boolean | undefined;
  /** Renders a separator before this item. */
  separatorBefore?: boolean | undefined;
};

export type MenuProps = Omit<AriaMenuProps<MenuItemDef>, 'children' | 'className' | 'style' | 'items'> & {
  items: readonly MenuItemDef[];
  /** Read-only text shown at the top (for example the person's name in the avatar menu). */
  header?: ReactNode;
  /** Accessible name of the menu when the trigger label is not descriptive enough. */
  'aria-label'?: string | undefined;
  className?: string | undefined;
};

/**
 * WAI-ARIA menu button pattern (React Aria): Enter/Space/ArrowDown open, arrows move, Escape closes to the trigger.
 * Wrap trigger + Menu in `MenuTrigger`.
 */
export function Menu({ items, header, className, ...rest }: MenuProps) {
  return (
    <Popover className={cx(styles.popover)} placement="bottom end">
      {header ? <div className={styles.header}>{header}</div> : null}
      <AriaMenu {...rest} className={cx(styles.menu, className)}>
        {items.map((item) => (
          <MenuItemWithSeparator key={String(item.id)} item={item} />
        ))}
      </AriaMenu>
    </Popover>
  );
}

function MenuItemWithSeparator({ item }: { item: MenuItemDef }) {
  return (
    <>
      {item.separatorBefore ? <Separator className={cx(styles.separator)} /> : null}
      <AriaMenuItem id={item.id} textValue={item.label} {...(item.href ? { href: item.href } : {})} isDisabled={item.isDisabled ?? false} className={cx(styles.item, item.isDestructive && styles.destructive)}>
        {item.icon ? <Icon icon={item.icon} size={16} /> : null}
        <span>{item.label}</span>
      </AriaMenuItem>
    </>
  );
}

export { MenuTrigger };
