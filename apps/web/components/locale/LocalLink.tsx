import type { ComponentProps } from 'react';
import NextLink from 'next/link';
import { localPath } from '@/app/_lib/localize';

/**
 * `next/link` that keeps the reader in the language of the page (ADR 012 decision 27): an app-absolute href to a public
 * page gets the active language's prefix, every other href is passed through. No hooks and no directive, so server
 * components render it on the server (the request's locale store) and client components in the browser.
 */
export default function LocalLink({ href, ...props }: ComponentProps<typeof NextLink>) {
  return <NextLink href={typeof href === 'string' ? localPath(href) : href} {...props} />;
}
