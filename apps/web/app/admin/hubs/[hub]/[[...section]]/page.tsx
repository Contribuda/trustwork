import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { t, tDynamic } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';
import { sectionByPath, type SectionRef } from '../../../_data/sections';
import type { HubContext, HubParams, PageSearchParams } from '../../../_components/context';
import { screenFor } from '../../../_components/screens';
import { ConsoleHeader, HubConsolePage } from '../../../_components/shell';

type Params = Promise<{ hub: string; section?: string[] }>;

const SCREENS_DOC = 'https://github.com/Contribuda/trustwork/blob/main/docs/engine/hub-console/screens.md';

/** The section of the console map this address names; anything else is "not found". */
function sectionOf(path: string[] | undefined): SectionRef {
  const ref = sectionByPath((path ?? []).join('/'));
  if (!ref) notFound();
  return ref;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  await primeLocale();
  const ref = sectionByPath(((await params).section ?? []).join('/'));
  if (!ref) return { title: t('error.notFoundTitle') };
  const screen = screenFor(ref.group.id, ref.section.id);
  return { title: screen ? screen.title() : tDynamic(`admin.sections.${ref.group.id}.${ref.section.id}`, ref.section.id) };
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
 * The hub console route (`/admin/hubs/[hub]/…`). It resolves the section from the console map and renders its screen
 * inside the shell with the section's permission rules; a section without a screen yet gets the honest "designed"
 * page instead of an imitation. One route keeps the console's client JavaScript to a single page chunk.
 */
export default async function HubConsoleRoute({ params, searchParams }: { params: Params; searchParams: PageSearchParams }) {
  const ref = sectionOf((await params).section);
  const screen = screenFor(ref.group.id, ref.section.id);
  if (!screen && ref.section.status !== 'designed') notFound();
  const hubParams: HubParams = params.then(({ hub }) => ({ hub }));
  return (
    <HubConsolePage params={hubParams} searchParams={searchParams} section={ref}>
      {(ctx) => (screen ? screen.render(ctx) : Designed(ctx, ref))}
    </HubConsolePage>
  );
}
