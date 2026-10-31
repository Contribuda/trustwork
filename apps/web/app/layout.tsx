import type { ReactNode } from 'react';

/**
 * No shared document (WEB-005). Public pages (`app/(public)/[lang]`) render the HTML document for the language in their
 * URL and the visitor's country, never the session; the workspace, sign-in, onboarding and not-found pages
 * render it per request from the visitor's cookies (`components/RootDocument.tsx`). There is no app-wide
 * `force-dynamic`: each tree declares its own rendering, and no public page reads the session.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return children;
}
