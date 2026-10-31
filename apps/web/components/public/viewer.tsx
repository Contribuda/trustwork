'use client';

import { createContext, Suspense, use, useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import NextLink from '@/components/locale/LocalLink';
import { ArrowRight } from 'lucide-react';
import { ButtonLink } from '@trustwork/ui';
import { withBase } from '@/app/_lib/base-path';
import { LIVE_CONTEXT, resolveDemoContext, withDemo, type DemoContext, type Persona } from '@/app/_lib/persona';

/**
 * Who is looking at a public page (WEB-005). Public pages never read the session on the server, so nothing on the
 * server depends on the visitor; the few parts that do (the header account, "open in workspace", "this is you") are
 * decided here in the browser. Demo: the persona from `?persona=` picks one of the synthetic principals the layout
 * handed over. Live: `GET /app/viewer` with the visitor's own session cookie (`private, no-store`), never cached for
 * anybody else. Until it answers, every visitor sees the anonymous page.
 */
export type Viewer = { name: string; personId: string; companyId: string | null };
export type DemoViewers = Record<Persona, Viewer | null>;

type ViewerState = { viewer: Viewer | null; demo: DemoContext; query: URLSearchParams | null };

const ViewerContext = createContext<ViewerState>({ viewer: null, demo: LIVE_CONTEXT, query: null });
ViewerContext.displayName = 'Viewer';

export function useViewer(): ViewerState {
  return use(ViewerContext);
}

/** Reads the query in its own Suspense boundary, so the page around it renders on the server without it. */
function QuerySync({ onQuery }: { onQuery: (query: URLSearchParams) => void }) {
  const params = useSearchParams();
  useEffect(() => onQuery(new URLSearchParams(params.toString())), [params, onQuery]);
  return null;
}

export function ViewerProvider({ demoMode, defaultPersona, demoViewers, children }: { demoMode: boolean; defaultPersona: Persona; demoViewers: DemoViewers | null; children: ReactNode }) {
  const [query, setQuery] = useState<URLSearchParams | null>(null);
  const [live, setLive] = useState<Viewer | null>(null);
  useEffect(() => {
    if (demoMode) return;
    let cancelled = false;
    fetch(withBase('/app/viewer'), { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } })
      .then((response) => (response.ok ? (response.json() as Promise<{ viewer: Viewer | null }>) : { viewer: null }))
      .then((body) => {
        if (!cancelled) setLive(body.viewer ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [demoMode]);
  const demo = demoMode ? resolveDemoContext(query ?? undefined, defaultPersona, true) : LIVE_CONTEXT;
  const viewer = demoMode ? (demoViewers?.[demo.persona] ?? null) : live;
  return (
    <ViewerContext.Provider value={{ viewer, demo, query }}>
      <Suspense fallback={null}>
        <QuerySync onQuery={setQuery} />
      </Suspense>
      {children}
    </ViewerContext.Provider>
  );
}

/** What a part of a page belongs to: a person, a company, or either (a project owned by a person or a company). */
export type ViewerMatch = { personId?: string | null; companyId?: string | null; ownerKey?: string | null };

function matches(viewer: Viewer | null, match: ViewerMatch): boolean {
  if (!viewer) return false;
  if (match.personId && viewer.personId === match.personId) return true;
  if (match.companyId && viewer.companyId === match.companyId) return true;
  return Boolean(match.ownerKey && (viewer.personId === match.ownerKey || viewer.companyId === match.ownerKey));
}

/**
 * The owner's action on a public page (edit, manage, open in the workspace) for the visitor it belongs to; everybody
 * else (and every visitor until the viewer is known) sees `children`. `look` follows the page's own button styles.
 */
export function OwnerAction({ match, href, label, look = 'button', children }: { match: ViewerMatch; href: string; label: string; look?: 'button' | 'more'; children?: ReactNode }) {
  const { viewer, demo } = useViewer();
  if (!matches(viewer, match)) return <>{children}</>;
  const target = withDemo(href, demo);
  return look === 'more' ? (
    <NextLink href={target} className="pub-more">
      {label}
      <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
    </NextLink>
  ) : (
    <ButtonLink href={target} variant="secondary">
      {label}
    </ButtonLink>
  );
}

/** Shows `children` only to visitors the part does not belong to (a claim or report box is not for the owner). */
export function NotOwner({ match, children }: { match: ViewerMatch; children: ReactNode }) {
  const { viewer } = useViewer();
  return matches(viewer, match) ? null : <>{children}</>;
}

/** A small mark for the visitor's own card in a list ("this is you"). */
export function OwnMark({ match, label, className }: { match: ViewerMatch; label: string; className: string }) {
  const { viewer } = useViewer();
  return matches(viewer, match) ? <span className={className}>{label}</span> : null;
}

/** An action for any signed-in visitor (their own page, their workspace); anonymous visitors see `children`. */
export function SignedInAction({ href, label, children }: { href: string; label: string; children?: ReactNode }) {
  const { viewer, demo } = useViewer();
  if (!viewer) return <>{children}</>;
  return (
    <ButtonLink href={withDemo(href, demo)} variant="secondary">
      {label}
    </ButtonLink>
  );
}
