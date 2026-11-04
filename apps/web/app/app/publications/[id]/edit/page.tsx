import { t } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';
import { requirePrincipal, type PageSearchParams } from '@/app/_lib/principal';
import { localeName } from '@/components/locale/languages';
import { ProvenanceEditor } from '@/components/workspace/ProvenanceEditor';

const PUBLICATION_LANGUAGES = ['en', 'es', 'ru', 'uz-Latn', 'ka', 'hy', 'az-Latn'];

export default async function PublicationEditorPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: PageSearchParams }) {
  await primeLocale();
  const { id } = await params;
  await requirePrincipal(searchParams, `/app/publications/${id}/edit`);
  return <><p>{t('publicationProvenance.creditRequired')}</p><ProvenanceEditor publicationId={id} languages={PUBLICATION_LANGUAGES.map((tag) => ({ tag, name: localeName(tag) }))} /></>;
}
