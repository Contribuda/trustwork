import { notFound } from 'next/navigation';
import { demoModeEnabled } from '@/app/_lib/persona';
import { HubConsolePage } from '../../../../../_components/shell';
import type { PageSearchParams } from '../../../../../_components/context';
import { LiveScreening, liveSection } from '../../../trust/screening/live';

/** Node-compliance projection only; the subject account never receives this panel. */
export default async function CompliancePanelPage({ params, searchParams }: { params: Promise<{ hub: string; stateId: string }>; searchParams: PageSearchParams }) {
  if (demoModeEnabled()) notFound();
  const { stateId } = await params;
  return <HubConsolePage params={params} searchParams={searchParams} section={liveSection('trust', 'screening')}>{(ctx) => LiveScreening({ hub: ctx.record.hub.slug, query: { subject: stateId } })}</HubConsolePage>;
}
