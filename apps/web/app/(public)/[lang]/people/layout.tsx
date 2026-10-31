import type { ReactNode } from 'react';
import './people.css';

/** Loads the people pages' own stylesheet (WEB-005: route-level CSS; the shell and shared rules stay in ../../public.css). */
export default function PeopleLayout({ children }: { children: ReactNode }) {
  return children;
}
