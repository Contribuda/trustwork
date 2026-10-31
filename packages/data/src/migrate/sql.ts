/**
 * Splits a SQL script into top-level statements. Understands single/double quotes, dollar quoting,
 * line and block comments. Used only for `-- trustwork:no-transaction` migrations, where every statement
 * must be sent on its own (CREATE INDEX CONCURRENTLY refuses to run inside a transaction block, and a
 * multi-statement simple query is an implicit transaction block).
 */
export function splitStatements(script: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  const n = script.length;
  while (i < n) {
    const ch = script[i] as string;
    const next = script[i + 1];
    if (ch === '-' && next === '-') {
      const end = script.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      current += script.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = script.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      current += script.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (script[j] === ch) {
          if (script[j + 1] === ch) { j += 2; continue; }
          break;
        }
        j++;
      }
      current += script.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(script.slice(i, i + 64));
      if (tag) {
        const close = script.indexOf(tag[0], i + tag[0].length);
        const stop = close === -1 ? n : close + tag[0].length;
        current += script.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (current.trim() && !/^(\s|--[^\n]*\n?)*$/.test(current)) statements.push(current.trim());
  return statements.filter((s) => s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim() !== '');
}

export interface ExpectRows { kind: 'exact' | 'min' | 'max'; value: number }
export interface MigrationDirectives { noTransaction: boolean; expectRows: ExpectRows | null }

/** Parses the `-- trustwork:` directives in the leading comment block of a migration. */
export function parseDirectives(script: string): MigrationDirectives {
  const directives: MigrationDirectives = { noTransaction: false, expectRows: null };
  for (const line of script.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (!trimmed.startsWith('--')) break;
    const match = /^--\s*trustwork:([a-z-]+)(?:\s+(\S+))?/.exec(trimmed);
    if (!match) continue;
    const [, name, argument] = match;
    if (name === 'no-transaction') directives.noTransaction = true;
    else if (name === 'expect-rows') {
      const spec = /^(?:(min|max):)?(\d+)$/.exec(argument ?? '');
      if (!spec) throw new Error(`Invalid -- trustwork:expect-rows directive: ${trimmed}`);
      directives.expectRows = { kind: (spec[1] as 'min' | 'max' | undefined) ?? 'exact', value: Number(spec[2]) };
    } else throw new Error(`Unknown migration directive: ${trimmed}`);
  }
  if (directives.noTransaction && directives.expectRows) throw new Error('expect-rows cannot be combined with no-transaction (no rollback would be possible)');
  return directives;
}

export function rowsSatisfy(expect: ExpectRows, affected: number): boolean {
  if (expect.kind === 'exact') return affected === expect.value;
  if (expect.kind === 'min') return affected >= expect.value;
  return affected <= expect.value;
}
