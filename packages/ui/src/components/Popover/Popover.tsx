import type { ReactNode } from 'react';
import { Dialog, DialogTrigger, Heading, Popover as AriaPopover, type PopoverProps as AriaPopoverProps } from 'react-aria-components';
import { cx } from '../../utils/cx';
import styles from './Popover.module.css';

export type PopoverProps = Omit<AriaPopoverProps, 'children' | 'className' | 'style'> & {
  /** Accessible name of the popover dialog. */
  title: string;
  /** Hide the heading visually while keeping it as the dialog name. */
  hideTitle?: boolean | undefined;
  children: ReactNode;
  width?: number | undefined;
  className?: string | undefined;
};

/** Non-modal popover dialog anchored to its trigger (Escape closes, focus returns). Use `DialogTrigger` around trigger + Popover. */
export function Popover({ title, hideTitle = false, children, width, className, ...rest }: PopoverProps) {
  return (
    <AriaPopover {...rest} className={cx(styles.popover, className)} {...(width ? { style: { width } } : {})}>
      <Dialog className={cx(styles.dialog)}>
        <Heading slot="title" className={cx(styles.title, hideTitle && styles.hiddenTitle)}>
          {title}
        </Heading>
        {children}
      </Dialog>
    </AriaPopover>
  );
}

export { DialogTrigger as PopoverTrigger };
