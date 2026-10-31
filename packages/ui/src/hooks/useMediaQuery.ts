import { useSyncExternalStore } from 'react';
import { mediaQuery } from '../../tokens/index';

/** SSR-safe media query hook; the server snapshot is `fallback` so markup does not shift on hydration for the desktop case. */
export function useMediaQuery(query: string, fallback = false): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined') return () => {};
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => (typeof window === 'undefined' ? fallback : window.matchMedia(query).matches),
    () => fallback,
  );
}

export function useIsMobile(): boolean {
  return useMediaQuery(mediaQuery.mobile, false);
}

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery(mediaQuery.reducedMotion, false);
}
