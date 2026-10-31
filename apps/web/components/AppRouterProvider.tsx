'use client';

import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { RouterProvider } from 'react-aria-components';
import { withBase } from '@/app/_lib/base-path';

/**
 * Routes React Aria links (every `@trustwork/ui` Link, nav item, menu item and tab) through the Next App
 * Router so navigation is client-side: layouts keep their state, which is what lets the floating
 * assistant overlay and `/app/assistant` share one conversation across pages.
 */
export function AppRouterProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  return (
    <RouterProvider navigate={(href) => router.push(href)} useHref={withBase}>
      {children}
    </RouterProvider>
  );
}
