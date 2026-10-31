import type { ReactNode } from 'react';
import './magazine.css';

/** Loads the magazine pages' own stylesheet (WEB-005: route-level CSS; the shell and shared rules stay in ../../public.css). */
export default function MagazineLayout({ children }: { children: ReactNode }) {
  return children;
}
