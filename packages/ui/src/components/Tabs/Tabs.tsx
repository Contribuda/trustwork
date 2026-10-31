import type { ReactNode } from 'react';
import { Tab as AriaTab, TabList as AriaTabList, TabPanel as AriaTabPanel, Tabs as AriaTabs, type TabsProps as AriaTabsProps, type Key } from 'react-aria-components';
import { cx } from '../../utils/cx';
import styles from './Tabs.module.css';

export type TabDef = { id: Key; label: string; content: ReactNode; isDisabled?: boolean | undefined; /** Link-style tab (deep-link routing). */ href?: string | undefined };

export type TabsProps = Omit<AriaTabsProps, 'children' | 'className' | 'style'> & {
  /** Accessible name for the tab list. */
  'aria-label': string;
  tabs: readonly TabDef[];
  className?: string | undefined;
};

/** WAI-ARIA tabs (arrow keys move, panel is focusable so deep links land on content); overflow scrolls horizontally with a visible fade. */
export function Tabs({ tabs, className, 'aria-label': ariaLabel, ...rest }: TabsProps) {
  return (
    <AriaTabs {...rest} className={cx(styles.tabs, className)}>
      <div className={styles.scroller}>
        <AriaTabList aria-label={ariaLabel} className={cx(styles.list)}>
          {tabs.map((tab) => (
            <AriaTab key={String(tab.id)} id={tab.id} isDisabled={tab.isDisabled ?? false} {...(tab.href ? { href: tab.href } : {})} className={cx(styles.tab)}>
              {tab.label}
            </AriaTab>
          ))}
        </AriaTabList>
      </div>
      {tabs.map((tab) => (
        <AriaTabPanel key={String(tab.id)} id={tab.id} className={cx(styles.panel)}>
          {tab.content}
        </AriaTabPanel>
      ))}
    </AriaTabs>
  );
}
