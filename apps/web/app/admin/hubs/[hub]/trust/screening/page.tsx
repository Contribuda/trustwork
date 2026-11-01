import { demoModeEnabled } from '@/app/_lib/persona';
import { sectionById } from '../../../../_data/sections';
import { HubConsolePage } from '../../../../_components/shell';
import type { PageSearchParams } from '../../../../_components/context';
import { screen } from './_screen';
import { LiveScreening } from './live';

export default async function ScreeningPage({ params, searchParams }: { params: Promise<{ hub: string }>; searchParams: PageSearchParams }) {
  if (demoModeEnabled()) return <HubConsolePage params={params} searchParams={searchParams} section={sectionById('trust', 'screening')!}>{(ctx) => screen.render(ctx, { rest: [], query: {} })}</HubConsolePage>;
  const query = await searchParams;
  return <LiveScreening hub={(await params).hub} query={{ subject: typeof query.subject === 'string' ? query.subject : undefined, view: typeof query.view === 'string' ? query.view : undefined }} />;
}
