'use client';

import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { RouterProvider } from 'react-aria-components';
import { withBase } from '@/app/_lib/base-path';
import { localPath } from '@/app/_lib/localize';

/**
 * Routes React Aria links (every `@trustwork/ui` Link, nav item, menu item and tab) through the Next App
 * Router so navigation is client-side: layouts keep their state, which is what lets the floating
 * assistant overlay and `/app/assistant` share one conversation across pages. Links to public pages keep the
 * language being read (ADR 012 decision 27): the rendered href and the navigation both get the language prefix.
 */
export function AppRouterProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  return (
    <RouterProvider navigate={(href) => router.push(localPath(href))} useHref={(href) => withBase(localPath(href))}>
      {children}
    </RouterProvider>
  );
}
