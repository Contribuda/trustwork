import type { ReactNode } from 'react';
import './events.css';

/** Loads the events pages' own stylesheet (WEB-005: route-level CSS; the shell and shared rules stay in ../../public.css). */
export default function EventsLayout({ children }: { children: ReactNode }) {
  return children;
}
