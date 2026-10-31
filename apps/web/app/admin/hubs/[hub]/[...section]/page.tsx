import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { t, tDynamic } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';
import { sectionByPath, type SectionRef } from '../../../_data/sections';
import type { HubContext, HubParams, PageSearchParams } from '../../../_components/context';
import { ConsoleHeader, HubConsolePage } from '../../../_components/shell';

type Params = Promise<{ hub: string; section: string[] }>;

const SCREENS_DOC = 'https://github.com/Contribuda/trustwork/blob/main/docs/engine/hub-console/screens.md';

function designedSection(path: string[]): SectionRef {
  const ref = sectionByPath(path.join('/'));
  // Only sections of the console map that are not built yet render here; anything else is "not found".
  if (!ref || ref.section.status !== 'designed') notFound();
  return ref;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  await primeLocale();
  const ref = sectionByPath((await params).section.join('/'));
  return { title: ref ? tDynamic(`admin.sections.${ref.group.id}.${ref.section.id}`, ref.section.id) : t('error.notFoundTitle') };
}

function Designed(ctx: HubContext, ref: SectionRef) {
  const name = tDynamic(`admin.sections.${ref.group.id}.${ref.section.id}`, ref.section.id);
  return (
    <>
      <ConsoleHeader ctx={ctx} title={name} status="designed" />
      <section className="admin-panel" aria-labelledby="designed-title" data-testid="admin-designed">
        <h2 id="designed-title" className="admin-h2">
          {t('admin.designed.title')}
        </h2>
        <p>{t('admin.designed.body', { screen: ref.section.screen })}</p>
        <p>
          <a href={SCREENS_DOC} rel="noopener noreferrer" target="_blank">
            {t('admin.designed.handbook')}
            <span className="admin-visually-hidden"> {t('admin.common.opensNewTab')}</span>
          </a>
        </p>
      </section>
    </>
  );
}

/**
 * Every console section that is designed but not built yet (screens.md): an honest status page inside the shell, with
 * the same permission rules as the real screen. A package that builds a section adds its own route (which takes
 * precedence over this catch-all) and flips the section's `status` in its group file.
 */
export default async function DesignedSectionPage({ params, searchParams }: { params: Params; searchParams: PageSearchParams }) {
  const { section } = await params;
  const ref = designedSection(section);
  const hubParams: HubParams = params.then(({ hub }) => ({ hub }));
  return (
    <HubConsolePage params={hubParams} searchParams={searchParams} section={ref}>
      {(ctx) => Designed(ctx, ref)}
    </HubConsolePage>
  );
}
