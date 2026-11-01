import { notFound, redirect } from 'next/navigation';
import { consoleRequest, type PageSearchParams } from '../_components/context';
import { setupHref } from './steps';
import { readSetupView } from './_live/api';

/** `/admin/setup?token=…` resumes the wizard at the first incomplete step; without a valid token it is "not found" (live: `/v1/setup`, HUB-004). */
export default async function SetupEntry({ searchParams }: { searchParams: PageSearchParams }) {
  const raw = (await searchParams).token;
  const token = typeof raw === 'string' ? raw : '';
  const { port, demo } = await consoleRequest(searchParams);
  // Live mode reads the run from the API (HUB-004); demo mode from the synthetic fixtures.
  const current = demo ? (token ? await port.setup(token) : null)?.state.current : (token ? await readSetupView(token) : null)?.state.current;
  if (!current) notFound();
  redirect(setupHref(current, token));
}
