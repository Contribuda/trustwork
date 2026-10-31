import type { ReactNode } from 'react';
import './companies.css';

/** Loads the companies pages' own stylesheet (WEB-005: route-level CSS; the shell and shared rules stay in ../../public.css). */
export default function CompaniesLayout({ children }: { children: ReactNode }) {
  return children;
}
