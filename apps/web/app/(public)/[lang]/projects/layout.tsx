import type { ReactNode } from 'react';
import './projects.css';

/** Loads the projects pages' own stylesheet (WEB-005: route-level CSS; the shell and shared rules stay in ../../public.css). */
export default function ProjectsLayout({ children }: { children: ReactNode }) {
  return children;
}
