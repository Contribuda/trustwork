import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { t, tDynamic } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';
import { SECTIONS, sectionByPath, type SectionRef } from '../../../_data/sections';
import type { HubContext, HubParams, PageSearchParams } from '../../../_components/context';
import type { Screen, ScreenRoute } from '../../../_components/screen';
import { screenFor } from '../../../_components/screens';
import { ConsoleHeader, HubConsolePage } from '../../../_components/shell';

type Params = Promise<{ hub: string; section?: string[] }>;

const SCREENS_DOC = 'https://github.com/Contribuda/trustwork/blob/main/docs/engine/hub-console/screens.md';

type Resolved = { ref: SectionRef; screen: Screen | null; rest: string[] };

/**
 * The section of the console map this address names, or the deepest section whose screen accepts the remaining
 * segments as a detail address (`support/cases/sc-1`); anything else is null ("not found").
 */
function resolveAddress(path: string[] | undefined): Resolved | null {
  const segments = (path ?? []).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  const exact = sectionByPath(segments.join('/'));
  if (exact) return { ref: exact, screen: screenFor(exact.group.id, exact.section.id), rest: [] };
  const candidates = SECTIONS.filter(({ section }) => {
    const parts = section.path ? section.path.split('/') : [];
    return parts.length < segments.length && parts.every((part, i) => segments[i] === part);
  }).sort((a, b) => b.section.path.length - a.section.path.length);
  for (const ref of candidates) {
    const screen = screenFor(ref.group.id, ref.section.id);
    const rest = segments.slice(ref.section.path ? ref.section.path.split('/').length : 0);
    if (screen?.accepts?.(rest)) return { ref, screen, rest };
  }
  return null;
}

/** The query a screen may read: everything except the demo persona and scenario, first value of each name. */
async function screenQuery(searchParams: PageSearchParams): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(await searchParams)) {
    if (name === 'persona' || name === 'scenario') continue;
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string') out[name] = first.slice(0, 200);
  }
  return out;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  await primeLocale();
  const resolved = resolveAddress((await params).section);
  if (!resolved) return { title: t('error.notFoundTitle') };
  const { ref, screen } = resolved;
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
  const resolved = resolveAddress((await params).section);
  if (!resolved) notFound();
  const { ref, screen, rest } = resolved;
  if (!screen && ref.section.status !== 'designed') notFound();
  const hubParams: HubParams = params.then(({ hub }) => ({ hub }));
  const route: ScreenRoute = { rest, query: await screenQuery(searchParams) };
  return (
    <HubConsolePage params={hubParams} searchParams={searchParams} section={ref}>
      {(ctx) => (screen ? screen.render(ctx, route) : Designed(ctx, ref))}
    </HubConsolePage>
  );
}
