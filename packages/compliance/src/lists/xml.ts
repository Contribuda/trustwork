/**
 * A small, strict XML reader for list exports (no dependency). It reads elements, attributes, text, CDATA, comments
 * and the XML declaration, resolves the five predefined entities and numeric character references, and refuses
 * everything else: a document type declaration (so no external or expanding entities), an unknown entity, a
 * mismatched or unclosed tag, text outside the root, or a document deeper or larger than its limits. Namespaces are
 * reduced to local names, because the OFAC exports changed their namespace URI between publication systems.
 */
export interface XmlElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: XmlElement[];
  /** Concatenated character data directly inside this element, trimmed. */
  text: string;
}

export class XmlFormatError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`malformed XML at offset ${offset}: ${message}`);
    this.name = 'XmlFormatError';
  }
}

export interface XmlLimits {
  readonly maxDepth: number;
  readonly maxElements: number;
}
const DEFAULT_LIMITS: XmlLimits = { maxDepth: 32, maxElements: 5_000_000 };

const NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/;
const PREDEFINED: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}

function decode(raw: string, offset: number): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&(?:([^;&\s<]{1,10});)?/g, (match: string, ref: string | undefined, at: number) => {
    if (ref === undefined) throw new XmlFormatError('bare ampersand', offset + at);
    const numeric = /^#(?:x([0-9a-fA-F]{1,6})|(\d{1,7}))$/.exec(ref);
    if (numeric) {
      const code = numeric[1] !== undefined ? Number.parseInt(numeric[1], 16) : Number.parseInt(numeric[2] as string, 10);
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new XmlFormatError(`bad character reference ${match}`, offset + at);
      return String.fromCodePoint(code);
    }
    const value = PREDEFINED[ref];
    if (value === undefined) throw new XmlFormatError(`unknown entity ${match}`, offset + at);
    return value;
  });
}

function parseAttributes(source: string, offset: number): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /\s*([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
  let at = 0;
  while (at < source.length) {
    if (/^\s*$/.test(source.slice(at))) break;
    pattern.lastIndex = at;
    const match = pattern.exec(source);
    if (!match) throw new XmlFormatError('malformed attribute', offset + at);
    const name = match[1] as string;
    if (!NAME.test(name)) throw new XmlFormatError(`bad attribute name ${name}`, offset + at);
    const key = localName(name);
    if (name.startsWith('xmlns')) {
      at = pattern.lastIndex;
      continue;
    }
    if (key in attributes) throw new XmlFormatError(`duplicate attribute ${key}`, offset + at);
    attributes[key] = decode(match[2] ?? match[3] ?? '', offset + at);
    at = pattern.lastIndex;
  }
  return attributes;
}

/** Parses a whole document and returns its root element. */
export function parseXml(input: string, limits: XmlLimits = DEFAULT_LIMITS): XmlElement {
  let text = input;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const stack: XmlElement[] = [];
  const textParts: string[][] = [];
  let root: XmlElement | null = null;
  let elements = 0;
  let at = 0;
  const appendText = (raw: string, offset: number) => {
    if (stack.length === 0) {
      if (raw.trim() !== '') throw new XmlFormatError('text outside the root element', offset);
      return;
    }
    (textParts[textParts.length - 1] as string[]).push(raw);
  };
  while (at < text.length) {
    const lt = text.indexOf('<', at);
    if (lt < 0) {
      appendText(decode(text.slice(at), at), at);
      break;
    }
    if (lt > at) appendText(decode(text.slice(at, lt), at), at);
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end < 0) throw new XmlFormatError('unclosed comment', lt);
      at = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end < 0) throw new XmlFormatError('unclosed CDATA section', lt);
      appendText(text.slice(lt + 9, end), lt);
      at = end + 3;
      continue;
    }
    if (text.startsWith('<!', lt)) throw new XmlFormatError('document type declarations are refused', lt);
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end < 0) throw new XmlFormatError('unclosed processing instruction', lt);
      at = end + 2;
      continue;
    }
    const gt = text.indexOf('>', lt + 1);
    if (gt < 0) throw new XmlFormatError('unclosed tag', lt);
    const body = text.slice(lt + 1, gt);
    if (body.startsWith('/')) {
      const name = body.slice(1).trim();
      const open = stack.pop();
      if (!open || open.name !== localName(name)) throw new XmlFormatError(`unexpected closing tag ${name}`, lt);
      open.text = (textParts.pop() as string[]).join('').trim();
      at = gt + 1;
      continue;
    }
    const selfClosing = body.endsWith('/');
    const inner = selfClosing ? body.slice(0, -1) : body;
    const nameEnd = inner.search(/\s|$/);
    const rawName = inner.slice(0, nameEnd);
    if (!NAME.test(rawName)) throw new XmlFormatError(`bad element name ${rawName.slice(0, 40)}`, lt);
    if (root !== null && stack.length === 0) throw new XmlFormatError('more than one root element', lt);
    elements += 1;
    if (elements > limits.maxElements) throw new XmlFormatError('too many elements', lt);
    const element: XmlElement = { name: localName(rawName), attributes: parseAttributes(inner.slice(nameEnd), lt), children: [], text: '' };
    if (stack.length === 0) root = element;
    else (stack[stack.length - 1] as XmlElement).children.push(element);
    if (!selfClosing) {
      if (stack.length + 1 > limits.maxDepth) throw new XmlFormatError('nesting too deep', lt);
      stack.push(element);
      textParts.push([]);
    }
    at = gt + 1;
  }
  if (stack.length) throw new XmlFormatError(`unclosed element ${(stack[stack.length - 1] as XmlElement).name}`, text.length);
  if (!root) throw new XmlFormatError('no root element', 0);
  return root;
}

/** The first direct child with this local name, or null. */
export function child(element: XmlElement, name: string): XmlElement | null {
  return element.children.find((c) => c.name === name) ?? null;
}

/** Every direct child with this local name. */
export function childrenNamed(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((c) => c.name === name);
}

/** The trimmed text of the first direct child with this local name, or null when it is missing or empty. */
export function childText(element: XmlElement, name: string): string | null {
  const found = child(element, name);
  return found && found.text !== '' ? found.text : null;
}
