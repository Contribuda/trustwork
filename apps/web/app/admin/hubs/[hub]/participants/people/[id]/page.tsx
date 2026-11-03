import { notFound } from 'next/navigation';
import { demoModeEnabled } from '@/app/_lib/persona';
import { HubConsolePage } from '../../../../../_components/shell';
import type { PageSearchParams } from '../../../../../_components/context';
import { LiveScreening, liveSection } from '../../../trust/screening/live';

/** Only the authorized compliance panel is live here; no synthetic participant card is attached. */
export default async function ParticipantPage({ params, searchParams }: { params: Promise<{ hub: string; id: string }>; searchParams: PageSearchParams }) {
  if (demoModeEnabled()) notFound();
  const { id } = await params;
  return <HubConsolePage params={params} searchParams={searchParams} section={liveSection('participants', 'people')}>{(ctx) => LiveScreening({ hub: ctx.record.hub.slug, query: { participant: { kind: 'person', id } } })}</HubConsolePage>;
}
