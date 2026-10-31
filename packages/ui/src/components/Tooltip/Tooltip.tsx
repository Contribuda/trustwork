import type { ReactNode } from 'react';
import { OverlayArrow, Tooltip as AriaTooltip, TooltipTrigger, type TooltipProps as AriaTooltipProps } from 'react-aria-components';
import { cx } from '../../utils/cx';
import styles from './Tooltip.module.css';

export type TooltipProps = Omit<AriaTooltipProps, 'children' | 'className' | 'style'> & {
  children: ReactNode;
  className?: string | undefined;
};

/**
 * Supplementary tooltip on hover and keyboard focus; dismissible with Escape; never the only accessible name
 * (icon-only controls still carry `aria-label`). Wrap trigger + Tooltip in `TooltipTrigger`.
 */
export function Tooltip({ children, className, ...rest }: TooltipProps) {
  return (
    <AriaTooltip {...rest} offset={rest.offset ?? 8} className={cx(styles.tooltip, className)}>
      <OverlayArrow className={cx(styles.arrow)}>
        <svg width={8} height={8} viewBox="0 0 8 8" aria-hidden="true">
          <path d="M0 0 L4 4 L8 0" />
        </svg>
      </OverlayArrow>
      {children}
    </AriaTooltip>
  );
}

export { TooltipTrigger };
