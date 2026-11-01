import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * QA-002 defect D6: `infra/compose.yaml` fixed the project name `trustwork-local`, which is also the shared development
 * database, so the full-stack commands joined that project and `down -v` deleted the development database volume.
 * The project name is configurable with the development default, and every documented or automated full-stack
 * command names its own project.
 */
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const STACK = /docker compose\b[^`\n"]*--profile stack/g;

test('the compose project name is configurable and defaults to the development project', () => {
  const compose = read('infra/compose.yaml');
  const names = compose.split('\n').filter((line) => /^name:/.test(line));
  assert.deepEqual(names, ['name: ${TRUSTWORK_COMPOSE_PROJECT:-trustwork-local}']);
  assert.match(compose, /-p trustwork-stack -f infra\/compose\.yaml --profile stack up/, 'the header shows the full stack under its own project');
});

test('every documented and automated full-stack command names a project other than the development one', () => {
  const files = ['infra/compose.yaml', 'infra/images/stack-smoke.mjs', '.github/workflows/images.yml', 'docs/operations/images.md', 'docs/operations/runbook.md', 'docs/operations/backup-and-restore.md', 'docs/engine/status.md'];
  let seen = 0;
  for (const file of files) {
    for (const match of read(file).matchAll(STACK)) {
      seen += 1;
      const project = /\s-p\s+(\S+)/.exec(match[0])?.[1];
      assert.ok(project, `${file}: "${match[0]}" names its compose project with -p`);
      assert.notEqual(project, 'trustwork-local', `${file}: the full stack never runs in the development project`);
    }
  }
  assert.ok(seen >= 8, `found ${seen} full-stack commands`);
});

test('the stack smoke defaults to the same project as the CI workflow', () => {
  const smoke = /const STACK_COMPOSE = '([^']+)'/.exec(read('infra/images/stack-smoke.mjs'))?.[1];
  const workflow = /^\s+COMPOSE: (.+)$/m.exec(read('.github/workflows/images.yml'))?.[1]?.trim();
  assert.equal(smoke, 'docker compose -p trustwork-stack -f infra/compose.yaml --profile stack');
  assert.equal(workflow, smoke);
});
