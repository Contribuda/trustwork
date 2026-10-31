import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { REPO } from './helpers.js';

/**
 * Static map of the application message keys client components can look up, per route group (INTL-004).
 *
 * Starting from the files of a route group, server modules are followed through their (value) imports;
 * every `'use client'` module reached, and everything it imports, runs in the browser. In those modules
 * every string literal or template head that names an application key, a key subtree or a key prefix
 * (`'companyPage.ask'`, `` `taxonomy.topics.${key}` ``) is a key the browser may look up, so the namespace
 * that owns it must reach the routes of that group.
 */
const WEB = resolve(REPO, 'apps/web');
const EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

/** Route groups with their own client namespaces: the root layout's list reaches every page; a group adds its own. */
export const ROUTE_GROUPS = {
  root: { dir: 'app', nested: false },
  public: { dir: 'app/(public)', nested: true },
  auth: { dir: 'app/(auth)', nested: true },
  workspace: { dir: 'app/app', nested: true },
  onboarding: { dir: 'app/onboarding', nested: true },
} as const;
export type RouteGroup = keyof typeof ROUTE_GROUPS;

type Parsed = { client: boolean; imports: string[]; literals: Array<{ text: string; complete: boolean }> };
const parsed = new Map<string, Parsed>();

function resolveImport(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = join(WEB, specifier.slice(2));
  else if (specifier.startsWith('.')) base = resolve(dirname(from), specifier);
  else return null;
  if (/\.tsx?$/.test(base) && existsSync(base)) return base;
  for (const extension of EXTENSIONS) if (existsSync(base + extension)) return base + extension;
  return null;
}

function parse(file: string): Parsed {
  const cached = parsed.get(file);
  if (cached) return cached;
  const sourceFile = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const first = sourceFile.statements[0];
  const client = !!first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === 'use client';
  const imports: string[] = [];
  const literals: Parsed['literals'] = [];
  const addImport = (specifier: string) => {
    const target = resolveImport(file, specifier);
    if (target) imports.push(target);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const typeOnly = !!clause && (clause.isTypeOnly || (!clause.name && !!clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((e) => e.isTypeOnly)));
      if (!typeOnly && ts.isStringLiteral(node.moduleSpecifier)) addImport(node.moduleSpecifier.text);
      return;
    }
    if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) addImport(node.moduleSpecifier.text);
      return;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) addImport(node.arguments[0].text);
    if (ts.isImportTypeNode(node) || ts.isTypeNode(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literals.push({ text: node.text, complete: true });
    else if (ts.isTemplateExpression(node)) literals.push({ text: node.head.text, complete: false });
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const result = { client, imports, literals };
  parsed.set(file, result);
  return result;
}

function filesOf(group: RouteGroup): string[] {
  const { dir, nested } = ROUTE_GROUPS[group];
  const walk = (path: string): string[] =>
    readdirSync(path).flatMap((name) => {
      const full = join(path, name);
      if (statSync(full).isDirectory()) return nested && !name.startsWith('_') ? walk(full) : [];
      return /\.tsx?$/.test(name) ? [full] : [];
    });
  return walk(join(WEB, dir));
}

/** Modules that run in the browser on the routes of `group`: client boundaries and everything they import. */
export function clientModules(group: RouteGroup): string[] {
  const serverSeen = new Set<string>();
  const clientSeen = new Set<string>();
  const visitClient = (file: string): void => {
    if (clientSeen.has(file)) return;
    clientSeen.add(file);
    for (const next of parse(file).imports) visitClient(next);
  };
  const visitServer = (file: string): void => {
    if (serverSeen.has(file)) return;
    serverSeen.add(file);
    if (parse(file).client) return visitClient(file);
    for (const next of parse(file).imports) visitServer(next);
  };
  for (const file of filesOf(group)) visitServer(file);
  return [...clientSeen].sort();
}

/** Every key path of a dictionary, leaves and subtrees (`taxonomy`, `taxonomy.topics`, `taxonomy.topics.materials`). */
export function keyPaths(messages: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(messages).flatMap(([key, value]) => {
    if (key.startsWith('$')) return [];
    const path = prefix ? `${prefix}.${key}` : key;
    return value && typeof value === 'object' && !Array.isArray(value) ? [path, ...keyPaths(value as Record<string, unknown>, path)] : [path];
  });
}

/**
 * The top-level keys a literal can reach: a complete literal must be a key path (or a path ending in a dot);
 * a template head must be the start of one. `'company.deals.manage'` (a permission) or `'people.json'` match
 * nothing and are ignored.
 */
function reaches(literal: { text: string; complete: boolean }, paths: ReadonlySet<string>, sortedPaths: readonly string[]): string | null {
  const top = /^([A-Za-z][A-Za-z0-9]*)\./.exec(literal.text)?.[1] ?? (paths.has(literal.text) ? literal.text : undefined);
  if (!top || !paths.has(top)) return null;
  if (literal.complete) {
    const path = literal.text.endsWith('.') ? literal.text.slice(0, -1) : literal.text;
    return paths.has(path) ? top : null;
  }
  return sortedPaths.some((path) => path.startsWith(literal.text)) ? top : null;
}

/** Top-level application keys the browser may look up on the routes of `group`, with the client files that use them. */
export function clientKeys(group: RouteGroup, reference: Record<string, unknown>): Map<string, string[]> {
  const sortedPaths = keyPaths(reference);
  const paths = new Set(sortedPaths);
  const out = new Map<string, string[]>();
  for (const file of clientModules(group)) {
    for (const literal of parse(file).literals) {
      const top = reaches(literal, paths, sortedPaths);
      // A bare top-level word ('status', 'map') is a key only when it names a leaf: subtrees are never looked up whole.
      if (!top || (literal.complete && literal.text === top && typeof reference[top] === 'object')) continue;
      const users = out.get(top) ?? [];
      const name = relative(WEB, file);
      if (!users.includes(name)) users.push(name);
      out.set(top, users);
    }
  }
  return out;
}
