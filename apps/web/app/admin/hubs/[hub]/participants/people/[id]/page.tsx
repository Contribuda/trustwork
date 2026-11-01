import { notFound } from 'next/navigation';
import { demoModeEnabled } from '@/app/_lib/persona';
import { LiveScreening } from '../../../trust/screening/live';

/** Only the authorized compliance panel is live here; no synthetic participant card is attached. */
export default async function ParticipantPage({ params }: { params: Promise<{ hub: string; id: string }> }) {
  if (demoModeEnabled()) notFound();
  const { hub, id } = await params;
  return <LiveScreening hub={hub} query={{ participant: { kind: 'person', id } }} />;
}
