import { primeLocale } from '@/app/_lib/locale';
import { requirePrincipal, type PageSearchParams } from '@/app/_lib/principal';
import { ProvenanceEditor } from '@/components/workspace/ProvenanceEditor';

export default async function PublicationEditorPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: PageSearchParams }) {
  await primeLocale();
  const { id } = await params;
  await requirePrincipal(searchParams, `/app/publications/${id}/edit`);
  return <ProvenanceEditor publicationId={id} />;
}
