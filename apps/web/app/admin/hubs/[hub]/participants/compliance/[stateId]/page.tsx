import { notFound } from 'next/navigation';
import { demoModeEnabled } from '@/app/_lib/persona';
import { LiveScreening } from '../../../trust/screening/live';

/** Node-compliance projection only; the subject account never receives this panel. */
export default async function CompliancePanelPage({ params }: { params: Promise<{ hub: string; stateId: string }> }) {
  if (demoModeEnabled()) notFound();
  const { hub, stateId } = await params;
  return <LiveScreening hub={hub} query={{ subject: stateId }} />;
}
