/**
 * ICU subset used by the mail dictionaries, the same subset as the interface dictionaries (`packages/ui/src/i18n`):
 * `{name}` interpolation and `{count, plural, one {...} few {...} many {...} other {...}}` with `#` as the number.
 * The plural category comes from `Intl.PluralRules` and `#` from `Intl.NumberFormat` for the message's locale.
 * A placeholder without a value throws, so a template that needs a parameter it was not given fails loudly.
 */
export type MessageParams = Readonly<Record<string, string | number>>;

export class MessageFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessageFormatError';
  }
}

const pluralCache = new Map<string, Intl.PluralRules>();
const numberCache = new Map<string, Intl.NumberFormat>();
function pluralRules(locale: string): Intl.PluralRules {
  let rules = pluralCache.get(locale);
  if (!rules) pluralCache.set(locale, (rules = new Intl.PluralRules(locale)));
  return rules;
}
function numberFormat(locale: string): Intl.NumberFormat {
  let format = numberCache.get(locale);
  if (!format) numberCache.set(locale, (format = new Intl.NumberFormat(locale)));
  return format;
}

/** Index of the brace closing the one opened at `open`. */
function closing(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new MessageFormatError(`unbalanced braces in message: ${source}`);
}

function pluralBranches(body: string): Map<string, string> {
  const branches = new Map<string, string>();
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i]!)) i += 1;
    if (i >= body.length) break;
    const start = i;
    while (i < body.length && /[\w=]/.test(body[i]!)) i += 1;
    const selector = body.slice(start, i);
    while (i < body.length && /\s/.test(body[i]!)) i += 1;
    if (!selector || body[i] !== '{') throw new MessageFormatError(`malformed plural branch near: ${body.slice(start, start + 20)}`);
    const end = closing(body, i);
    branches.set(selector, body.slice(i + 1, end));
    i = end + 1;
  }
  if (!branches.has('other')) throw new MessageFormatError('a plural needs an "other" branch');
  return branches;
}

export function formatMessage(source: string, params: MessageParams, locale: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch !== '{') {
      if (ch === '}') throw new MessageFormatError(`unbalanced braces in message: ${source}`);
      out += ch;
      i += 1;
      continue;
    }
    const end = closing(source, i);
    const inner = source.slice(i + 1, end);
    const comma = inner.indexOf(',');
    if (comma === -1) {
      const name = inner.trim();
      const value = params[name];
      if (value === undefined) throw new MessageFormatError(`missing parameter {${name}}`);
      out += typeof value === 'number' ? numberFormat(locale).format(value) : value;
    } else {
      const name = inner.slice(0, comma).trim();
      const rest = inner.slice(comma + 1);
      const second = rest.indexOf(',');
      if (second === -1 || rest.slice(0, second).trim() !== 'plural') throw new MessageFormatError(`unsupported argument type in {${inner}}`);
      const raw = params[name];
      const count = typeof raw === 'number' ? raw : Number(raw);
      if (raw === undefined || !Number.isFinite(count)) throw new MessageFormatError(`plural parameter {${name}} must be a number`);
      const branches = pluralBranches(rest.slice(second + 1));
      const branch = branches.get(`=${count}`) ?? branches.get(pluralRules(locale).select(count)) ?? branches.get('other')!;
      out += formatMessage(branch.replace(/#/g, numberFormat(locale).format(count)), params, locale);
    }
    i = end + 1;
  }
  return out;
}

/** Placeholder names a message uses (top level and inside plural branches). */
export function placeholdersOf(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/\{\s*([A-Za-z_][\w]*)\s*(,|\})/g)) names.add(match[1]!);
  return names;
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}
