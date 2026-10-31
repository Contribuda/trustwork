import { NextResponse, type NextRequest } from 'next/server';
import { data } from '@/app/_lib/data';
import { LIVE_CONTEXT, demoModeEnabled, resolveDemoContext } from '@/app/_lib/persona';

/** Per visitor, never cached: the answer depends on the visitor's own session cookie. */
export const dynamic = 'force-dynamic';

/**
 * `GET /app/viewer`: the signed-in visitor's display name, person and company ids, or `null` (WEB-005). Cached public
 * pages render the same bytes for everybody and ask this from the browser for the few parts that belong to the
 * visitor (header account, owner actions). `Cache-Control: private, no-store` and `Vary: Cookie` keep every shared and
 * browser cache from storing or replaying it for anybody else. Demo: the persona from `?persona=` (synthetic data);
 * live: the API session behind the visitor's cookie, and the query is never read.
 */
export async function GET(request: NextRequest) {
  const demo = demoModeEnabled() ? resolveDemoContext(request.nextUrl.searchParams, undefined, true) : LIVE_CONTEXT;
  const principal = await data.principalFor(demo).catch(() => null);
  const viewer = principal ? { name: principal.displayName, personId: principal.personId, companyId: principal.company?.id ?? null } : null;
  return NextResponse.json({ viewer }, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
}
