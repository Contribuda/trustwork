import type { ReactNode } from 'react';
import './certificates.css';

/** Loads the certificates pages' own stylesheet (WEB-005: route-level CSS; the shell and shared rules stay in ../../public.css). */
export default function CertificatesLayout({ children }: { children: ReactNode }) {
  return children;
}
