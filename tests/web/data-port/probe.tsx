/**
 * WEB-006 runtime probe of the data boundary, run by `data-port.test.ts` in a child process with this
 * directory's tsconfig (for the web app's `@/` paths). Prints one JSON report; the test asserts on it.
 */
import { data } from '@/app/_lib/data';
import type { DataPort, Principal } from '@/app/_lib/data';
import { PERSONAS } from '@/app/_lib/persona';

const anonymous: Principal = { kind: 'anonymous', persona: 'anonymous', demo: { persona: 'anonymous', scenario: 'default', fromQuery: false, defaultPersona: 'mixed' } };

async function settle<T>(work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  const report: Record<string, unknown> = { source: data.source };

  // Every method returns a promise, even when it fails (errors arrive as rejections, never as synchronous throws).
  const methods = Object.keys(data).filter((key) => typeof (data as unknown as Record<string, unknown>)[key] === 'function') as Array<keyof DataPort>;
  const nonPromise: string[] = [];
  const syncThrows: string[] = [];
  for (const name of methods) {
    const fn = data[name] as unknown as (...args: unknown[]) => unknown;
    let result: unknown;
    try {
      result = fn(anonymous, 'unknown');
    } catch {
      syncThrows.push(name);
      continue;
    }
    if (!(result instanceof Promise)) nonPromise.push(name);
    else await result.catch(() => undefined);
  }
  report.methods = methods.length;
  report.nonPromise = nonPromise;
  report.syncThrows = syncThrows;

  // Public lookups by handle.
  const people = await data.listPeople();
  const person = people[0];
  report.personHandleRoundTrip = person ? (await data.getPerson(person.handle))?.id === person.id : null;
  report.personHrefUsesHandle = person ? person.href === `/people/${person.handle}` : null;
  const companies = await data.listCompanies();
  const company = companies[0];
  report.companyHandleRoundTrip = company ? (await data.getCompany(company.handle))?.id === company.id : null;
  const projects = await data.listPublicProjects();
  const project = projects[0];
  report.projectHandleRoundTrip = project ? (await data.getPublicProject(project.handle))?.id === project.id : null;
  report.unknownHandle = [await data.getPerson('no-such-handle'), await data.getCompany('no-such-handle'), await data.getPublicProject('no-such-handle')];
  // A UUID is not a public address: public lookups never resolve by id.
  report.publicLookupById = person ? await data.getPerson(person.id) : null;

  // Workspace objects by id, for the signed-in person only.
  const principal = await data.principalFor({ persona: 'mixed', scenario: 'default', fromQuery: false, defaultPersona: 'mixed' });
  report.principal = principal ? { kind: principal.kind, hasHandle: typeof principal.handle === 'string' && principal.handle.length > 0 } : null;
  report.anonymousPrincipal = await data.principalFor({ persona: 'anonymous', scenario: 'default', fromQuery: false, defaultPersona: 'mixed' });
  if (principal) {
    const rows = await data.listWorkspaceProjects(principal);
    const row = rows[0];
    report.workspaceRows = rows.length;
    report.workspaceIdRoundTrip = row ? (await data.getWorkspaceProject(principal, row.id))?.id === row.id : null;
    report.workspaceLookupByHandle = row ? await data.getWorkspaceProject(principal, row.handle) : null;
  }
  // A project that is not public is reachable in a participant's workspace by id but never through the public port by handle.
  const hidden = new Map<string, string>();
  for (const persona of PERSONAS) {
    const who = await data.principalFor({ persona, scenario: 'default', fromQuery: false, defaultPersona: 'mixed' });
    if (!who) continue;
    for (const row of await data.listWorkspaceProjects(who)) if (!projects.some((p) => p.id === row.id)) hidden.set(row.id, row.handle);
  }
  report.privateProjects = hidden.size;
  report.privateProjectsPublic = (await Promise.all([...hidden.values()].map((handle) => data.getPublicProject(handle)))).filter(Boolean).length;
  const denied = await settle(() => data.listWorkspaceProjects(anonymous));
  report.anonymousWorkspace = denied.ok ? 'resolved' : 'rejected';

  // Concurrent reads return the same projections as sequential ones (no shared mutable state across calls).
  const [a, b] = await Promise.all([data.getHome(), data.getHome()]);
  report.concurrentHomeEqual = JSON.stringify(a) === JSON.stringify(b);

  process.stdout.write(JSON.stringify(report));
}

main().catch((error) => {
  process.stderr.write(String(error instanceof Error ? error.stack : error));
  process.exit(1);
});
