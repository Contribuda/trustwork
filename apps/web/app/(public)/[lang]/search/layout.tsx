import type { ReactNode } from 'react';
import './search.css';

/** Loads the search pages' own stylesheet (WEB-005: route-level CSS; the shell and shared rules stay in ../../public.css). */
export default function SearchLayout({ children }: { children: ReactNode }) {
  return children;
}
