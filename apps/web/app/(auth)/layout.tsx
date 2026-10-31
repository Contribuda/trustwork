import type { ReactNode } from 'react';
import '../auth.css';
import { primeLocale } from '@/app/_lib/locale';

/** Auth routes (login, signup, recovery) share the auth stylesheet; the frame is rendered by each page. */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  await primeLocale();
  return children;
}
