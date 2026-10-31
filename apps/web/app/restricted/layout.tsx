import type { ReactNode } from 'react';
import { VisitorDocument } from '@/components/RootDocument';

/** Per visitor, never cached: the refusal page renders in the visitor's cookie language (SANC-001, WEB-005). */
export const dynamic = 'force-dynamic';

/** The jurisdiction refusal page's document, without the first-visit country window: there is nothing to choose. */
export default function RestrictedLayout({ children }: { children: ReactNode }) {
  return <VisitorDocument gate="none">{children}</VisitorDocument>;
}
