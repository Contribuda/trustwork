import { notFound, redirect } from 'next/navigation';
import { consoleRequest, type PageSearchParams } from '../_components/context';
import { setupHref } from './steps';

/** `/admin/setup?token=…` resumes the wizard at the first incomplete step; without a valid token it is "not found". */
export default async function SetupEntry({ searchParams }: { searchParams: PageSearchParams }) {
  const raw = (await searchParams).token;
  const token = typeof raw === 'string' ? raw : '';
  const { port } = await consoleRequest(searchParams);
  const run = token ? await port.setup(token) : null;
  if (!run) notFound();
  redirect(setupHref(run.state.current, token));
}
