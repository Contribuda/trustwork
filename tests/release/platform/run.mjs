// Platform release candidate runner (QA-002). Two modes, both used by .github/workflows/release-platform.yml and both
// runnable on a workstation:
//
//   node tests/release/platform/run.mjs suites   negative authorization, readiness and worker fault suites (PostgreSQL
//                                                required: TRUSTWORK_TEST_DATABASE_URL or the local test backends)
//   node tests/release/platform/run.mjs stack    builds and starts the compose stack with the release overlay under its
//                                                own project name and free ports, checks readiness, the screening
//                                                baseline and the mail path, runs the browser journey and the HTTP
//                                                gates (English and Spanish, desktop and phone), then stops and removes
//                                                exactly the containers and volumes it started
//
// Options for `stack`: --no-build (reuse images), --keep (leave the stack running and print its origin).
// Evidence: tests/release/platform/dist/summary-<mode>.json (counts, commit, timings) and the job summary in CI.
// Nothing is deployed, pushed or sent; every credential is a local throwaway from infra/compose.yaml.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const OUT = resolve(HERE, 'dist');
mkdirSync(OUT, { recursive: true });

/** Suites the release candidate runs at its exact head commit, by gate. Each must report tests and skip none. */
export const SUITES = {
  'negative authorization': [
    'tests/backend/authorization.test.ts',
    'tests/backend/hardening/privileges.test.ts',
    'tests/backend/hardening/squatting.test.ts',
    'tests/data/access.test.ts',
    'tests/admin/boundaries.test.ts',
    'tests/jurisdiction/gate-api.test.ts',
  ],
  readiness: ['tests/ops/health.test.ts', 'tests/ops/config.test.ts'],
  'worker faults': ['tests/worker/faults.test.ts', 'tests/worker/concurrency.test.ts', 'tests/worker/mail/reliability.test.ts'],
};

const commit = () => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    return process.env.GITHUB_SHA ?? 'unknown';
  }
};

function summaryLine(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

/** Counts from a TAP stream written by node:test (`# tests N`, `# pass N`, ...). */
export function tapCounts(tap) {
  const count = (name) => Number(new RegExp(`^# ${name} (\\d+)$`, 'm').exec(tap)?.[1] ?? NaN);
  return { tests: count('tests'), pass: count('pass'), fail: count('fail'), skipped: count('skipped'), todo: count('todo'), cancelled: count('cancelled') };
}

function runSuites() {
  const results = [];
  let failed = false;
  summaryLine(`### Release suites at \`${commit()}\`\n\n| Gate | Files | Tests | Pass | Fail | Skipped |\n|---|---|---|---|---|---|`);
  for (const [gate, files] of Object.entries(SUITES)) {
    const tapFile = resolve(OUT, `suite-${gate.replace(/\s+/g, '-')}.tap`);
    console.log(`\n== ${gate}: ${files.join(' ')}`);
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=tap', `--test-reporter-destination=${tapFile}`, ...files], {
      cwd: REPO,
      stdio: 'inherit',
      // Database suites fail instead of skipping when PostgreSQL is missing (tests/data/helpers/postgres.ts).
      env: { ...process.env, TRUSTWORK_REQUIRE_PG: '1' },
    });
    const counts = tapCounts(existsSync(tapFile) ? readFileSync(tapFile, 'utf8') : '');
    const ok = result.status === 0 && counts.tests > 0 && counts.fail === 0 && counts.skipped === 0 && counts.cancelled === 0;
    if (!ok) failed = true;
    results.push({ gate, files, exitCode: result.status, ...counts, ok });
    summaryLine(`| ${gate} | ${files.length} | ${counts.tests} | ${counts.pass} | ${counts.fail} | ${counts.skipped} |`);
  }
  writeFileSync(resolve(OUT, 'summary-suites.json'), `${JSON.stringify({ commit: commit(), finishedAt: new Date().toISOString(), results }, null, 2)}\n`);
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.gate}: ${r.tests} tests, ${r.pass} pass, ${r.fail} fail, ${r.skipped} skipped (exit ${r.exitCode})`);
  return failed ? 1 : 0;
}

async function freePort(preferred) {
  const tryPort = (port) => new Promise((resolvePort) => {
    const server = net.createServer();
    server.once('error', () => resolvePort(null));
    server.listen(port, '127.0.0.1', () => server.close(() => resolvePort(port)));
  });
  for (let port = preferred; port < preferred + 200; port++) if (await tryPort(port)) return port;
  throw new Error(`no free port near ${preferred}`);
}

async function runStack(options) {
  const project = process.env.TRUSTWORK_RELEASE_PROJECT ?? 'trustwork-release';
  if (project === 'trustwork-local') throw new Error('refusing the shared development project name trustwork-local');
  const stackPort = Number(process.env.TRUSTWORK_STACK_PORT ?? (await freePort(8391)));
  const pgPort = Number(process.env.TRUSTWORK_PG_PORT ?? (await freePort(54391)));
  const mailPort = Number(process.env.TRUSTWORK_RELEASE_MAIL_PORT ?? (await freePort(stackPort + 1)));
  const origin = `http://localhost:${stackPort}`;
  const env = { ...process.env, TRUSTWORK_STACK_PORT: String(stackPort), TRUSTWORK_PG_PORT: String(pgPort), TRUSTWORK_RELEASE_MAIL_PORT: String(mailPort) };
  const composeArgs = ['compose', '-p', project, '-f', 'infra/compose.yaml', '-f', 'tests/release/platform/compose.release.yaml', '--profile', 'stack'];
  const compose = (args, extra = {}) => spawnSync('docker', [...composeArgs, ...args], { cwd: REPO, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...extra });
  const checks = [];
  const check = async (name, fn) => {
    const started = Date.now();
    try {
      const detail = await fn();
      checks.push({ name, ok: true, detail: detail ?? null, ms: Date.now() - started });
      console.log(`ok   ${name}${detail ? ` (${detail})` : ''}`);
    } catch (error) {
      checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error), ms: Date.now() - started });
      console.log(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
      throw error;
    }
  };
  let journey = null;
  let exitCode = 1;
  console.log(`release stack: project=${project} origin=${origin} postgres=127.0.0.1:${pgPort} mail reader=127.0.0.1:${mailPort}`);
  try {
    await check('stack builds and starts (postgres, db-roles, migrate, api, worker, web, storage, proxy, smtp-sink)', async () => {
      const up = compose(['up', '-d', ...(options.build ? ['--build'] : ['--no-build'])], { stdio: 'inherit' });
      if (up.status !== 0) throw new Error(`docker compose up exited ${up.status}`);
    });

    await check('readiness: every long-running service healthy, the migrate job exited 0', async () => {
      const deadline = Date.now() + 240_000;
      for (;;) {
        const ps = compose(['ps', '--all', '--format', 'json']);
        if (ps.status !== 0) throw new Error(ps.stderr);
        const rows = ps.stdout.trim().split('\n').filter(Boolean).flatMap((line) => { const v = JSON.parse(line); return Array.isArray(v) ? v : [v]; });
        const by = Object.fromEntries(rows.map((r) => [r.Service, r]));
        if (by.migrate?.State === 'exited' && by.migrate.ExitCode !== 0) throw new Error(`migrate exited ${by.migrate.ExitCode}`);
        const pending = ['api', 'worker', 'web', 'proxy', 'smtp-sink'].filter((s) => by[s]?.State !== 'running' || by[s]?.Health !== 'healthy');
        if (by.migrate?.State === 'exited' && pending.length === 0) return 'api, worker, web, proxy, smtp-sink healthy';
        const broken = pending.filter((s) => by[s] && by[s].State !== 'running' && by[s].State !== 'created' && by[s].State !== 'restarting');
        if (broken.length) throw new Error(`not running: ${broken.map((s) => `${s}=${by[s].State}`).join(', ')}`);
        if (Date.now() > deadline) throw new Error(`not healthy within 240 s: ${pending.join(', ')}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    });

    await check('readiness: the API reports ready (database answers, ledger matches the shipped migrations)', async () => {
      const probe = compose(['exec', '-T', 'api', 'node', '-e', "fetch('http://127.0.0.1:3001/health/ready').then(async r=>{console.log(r.status+' '+await r.text());process.exit(r.ok?0:1)},()=>process.exit(1))"]);
      if (probe.status !== 0) throw new Error(`/health/ready: ${probe.stdout}${probe.stderr}`);
      return probe.stdout.trim().slice(0, 160);
    });

    await check('the proxy answers on the public origin', async () => {
      const response = await fetch(`${origin}/proxy/health`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`proxy health ${response.status}`);
    });

    await check('screening baseline missing on a fresh hub: screening unavailable, so the gates that read it stay closed', async () => {
      const q = compose(['exec', '-T', 'postgres', 'psql', '-U', 'trustwork_dev', '-d', 'trustwork_stack', '-tA', '-c', 'SELECT trustwork.screening_available()']);
      if (q.status !== 0) throw new Error(q.stderr);
      if (q.stdout.trim() !== 'f') throw new Error(`screening_available() = ${q.stdout.trim()} (expected f without the OFAC exports)`);
      return 'screening_available() = false';
    });

    await check('browser journey and HTTP gates (en/es, desktop/phone)', async () => {
      const run = await new Promise((resolveRun) => {
        const child = spawn('npx', ['playwright', 'test', '-c', '../../tests/release/platform/playwright.config.ts'], {
          cwd: resolve(REPO, 'apps/web'),
          stdio: 'inherit',
          env: { ...env, TRUSTWORK_STACK_ORIGIN: origin, TRUSTWORK_RELEASE_MAIL_READER: `http://127.0.0.1:${mailPort}` },
        });
        child.on('exit', (code) => resolveRun(code ?? 1));
      });
      journey = playwrightCounts(resolve(OUT, 'report.json'));
      if (run !== 0) throw new Error(`playwright exited ${run} (${JSON.stringify(journey)})`);
      if (!journey || journey.expected === 0) throw new Error('the journey ran no tests');
      return `${journey.expected} passed, ${journey.unexpected} failed, ${journey.skipped} skipped`;
    });

    await check('one-time links never reach the logs with the SMTP transport', async () => {
      const logs = compose(['logs', '--no-color', '--no-log-prefix', 'worker', 'api']).stdout ?? '';
      if (/\/verify-email\/[A-Za-z0-9_%.~-]{16,}|\/invitations\/[0-9a-f-]{36}\/[A-Za-z0-9_%.~-]{16,}/.test(logs)) throw new Error('a mailed one-time link appears in the worker or API log');
      if (/\[mail\] to=/.test(logs)) throw new Error('the log transport printed a message');
      return `${logs.split('\n').length} log lines checked`;
    });
    exitCode = 0;
  } catch {
    const logs = compose(['logs', '--no-color', '--timestamps', '--tail', '200']);
    writeFileSync(resolve(OUT, 'stack-logs.txt'), `${logs.stdout ?? ''}${logs.stderr ?? ''}`);
    console.log(`stack logs (last 200 lines per service): ${resolve(OUT, 'stack-logs.txt')}`);
  } finally {
    const summary = { commit: commit(), finishedAt: new Date().toISOString(), project, origin, checks, journey };
    writeFileSync(resolve(OUT, 'summary-stack.json'), `${JSON.stringify(summary, null, 2)}\n`);
    summaryLine(`### Release stack at \`${summary.commit}\`\n\n| Check | Result |\n|---|---|\n${checks.map((c) => `| ${c.name} | ${c.ok ? 'ok' : 'FAIL'}${c.detail ? `: ${String(c.detail).replace(/\|/g, '/').slice(0, 200)}` : ''} |`).join('\n')}`);
    if (journey) summaryLine(`\nJourney and gates: ${journey.expected} passed, ${journey.unexpected} failed, ${journey.flaky} flaky, ${journey.skipped} skipped, by project: ${JSON.stringify(journey.byProject)}`);
    if (options.keep) console.log(`stack left running: ${origin} (stop: docker ${composeArgs.join(' ')} down -v --remove-orphans)`);
    else compose(['down', '-v', '--remove-orphans'], { stdio: 'inherit' });
  }
  return exitCode;
}

/** Totals of a Playwright JSON report, overall and per project. */
export function playwrightCounts(file) {
  if (!existsSync(file)) return null;
  const report = JSON.parse(readFileSync(file, 'utf8'));
  const byProject = {};
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) for (const t of spec.tests ?? []) {
      const p = (byProject[t.projectName] ??= { expected: 0, unexpected: 0, skipped: 0, flaky: 0 });
      p[t.status] = (p[t.status] ?? 0) + 1;
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  const s = report.stats ?? {};
  return { expected: s.expected ?? 0, unexpected: s.unexpected ?? 0, skipped: s.skipped ?? 0, flaky: s.flaky ?? 0, byProject };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === 'suites') process.exitCode = runSuites();
  else if (mode === 'stack') process.exitCode = await runStack({ build: !rest.includes('--no-build'), keep: rest.includes('--keep') });
  else {
    console.error('usage: node tests/release/platform/run.mjs suites | stack [--no-build] [--keep]');
    process.exitCode = 2;
  }
}
