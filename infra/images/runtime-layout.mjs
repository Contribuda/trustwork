// Image build helper (OPS-002): writes runtime package manifests for compiled workspaces.
//   node infra/images/runtime-layout.mjs <repository root> <output root> <workspace dir>...
// Each manifest keeps only what Node needs to resolve the compiled code (name, version, licence, "type": "module" and
// "exports" pointing at .js instead of .ts); scripts, bin entries and dependency lists are dropped. Every package
// (not app) is linked as node_modules/@trustwork/<dir name> so bare imports such as '@trustwork/data' resolve to the
// compiled tree. The images never contain TypeScript sources, tsx or any devDependency.
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const [root, out, ...workspaces] = process.argv.slice(2);
if (!root || !out || workspaces.length === 0) {
  console.error('usage: runtime-layout.mjs <repository root> <output root> <workspace dir>...');
  process.exit(2);
}

const toJs = (value) => {
  if (typeof value === 'string') return value.replace(/\.tsx?$/, '.js');
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, toJs(inner)]));
  return value;
};

rmSync(join(out, 'node_modules', '@trustwork'), { recursive: true, force: true });
for (const workspace of workspaces) {
  const source = JSON.parse(readFileSync(join(root, workspace, 'package.json'), 'utf8'));
  if (source.type !== 'module') throw new Error(`${workspace}: expected "type": "module"`);
  const manifest = { name: source.name, version: source.version, license: source.license, private: true, type: 'module', ...(source.exports ? { exports: toJs(source.exports) } : {}) };
  mkdirSync(join(out, workspace), { recursive: true });
  writeFileSync(join(out, workspace, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (workspace.startsWith('packages/')) {
    const link = join(out, 'node_modules', '@trustwork', basename(workspace));
    mkdirSync(join(out, 'node_modules', '@trustwork'), { recursive: true });
    symlinkSync(join('..', '..', workspace), link, 'dir');
  }
  console.log(`runtime manifest: ${workspace} (${source.name})`);
}
