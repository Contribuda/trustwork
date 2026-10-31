#!/usr/bin/env node
// Migration runner entry point: node packages/data/bin/migrate.mjs <status|up|verify> [--dir <path>]
// The TypeScript sources are loaded through tsx (a root devDependency); no build step is required.
import { register } from 'tsx/esm/api';
register();
const { runCli } = await import('../src/migrate/cli.ts');
process.exitCode = await runCli(process.argv.slice(2), process.env, { log: (s) => console.log(s), error: (s) => console.error(s) });
