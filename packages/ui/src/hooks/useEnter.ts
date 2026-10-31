import type { CSSProperties } from 'react';
import { usePrefersReducedMotion } from './useMediaQuery';

export type EnterOptions = {
  /** Position in a staggered group (delay = index × 40 ms). */
  index?: number | undefined;
  /** Disables the animation (for example after the first render of a list). */
  enabled?: boolean | undefined;
};

/**
 * Props for the page/section enter animation (fade + rise 240 ms, ease-out, 40 ms stagger). Returns a class name
 * and style to spread on the element; nothing is applied under `prefers-reduced-motion` or when disabled.
 */
export function useEnter({ index = 0, enabled = true }: EnterOptions = {}): { className: string; style: CSSProperties } {
  const reduced = usePrefersReducedMotion();
  if (!enabled || reduced) return { className: '', style: {} };
  return { className: 'trustwork-enter', style: { ['--enter-index' as string]: index } as CSSProperties };
}
