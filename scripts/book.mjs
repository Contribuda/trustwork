/**
 * The Trustwork Book: built from its chapters into one offline HTML file and a Markdown text edition.
 *
 *   npm run book            writes docs/book/trustwork-book.html and docs/book/text/*.md
 *   npm run book -- --check fails when a written file drifts from the sources (part of npm run validate:docs)
 *
 * Sources live in docs/book/: book.json (parts, order of chapters, cover and colophon), chapters/*.html (one fragment
 * per chapter, starting with its <h2>), figures/*.svg (inlined where a chapter says <figure data-figure="name">),
 * art/*.svg (part openers), images/*.jpg|png (inlined as data URIs), book.css and book.js. Edit the sources, never
 * the written files. docs/book/README.md says how to contribute.
 *
 * The HTML edition stands on its own: the build refuses anything fetched from the network, an outside link anywhere
 * but the chapters flagged `links` or `sources` in book.json, a repository path anywhere but the chapters flagged
 * `repoPaths`, an unfinished passage and Cyrillic text. The text edition is for reading on GitHub and for agents: one
 * Markdown file per chapter, with the same numbering, generated from the same HTML.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const DIR = 'docs/book';
const TEXT = 'text';

const plain = (html) => decode(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
export function slug(text, max = 60) {
  const s = text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&[a-z]+;/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return (cut.includes('-') ? cut.slice(0, cut.lastIndexOf('-')) : cut).replace(/-+$/, '');
}

/* ---------- HTML edition ---------- */

function chapter(source, number, figures, images, file) {
  const headings = [];
  const used = new Set();
  let title = '';
  let html = source.replace(/<h([23])([^>]*)>([\s\S]*?)<\/h\1>/g, (_m, level, attrs, inner) => {
    const text = plain(inner);
    let id = slug(text) || `section-${headings.length + 1}`;
    if (level === '2') {
      title = text;
      id = `ch-${number}`;
    } else if (used.has(id)) {
      let n = 2;
      while (used.has(`${id}-${n}`)) n += 1;
      id = `${id}-${n}`;
    }
    used.add(id);
    headings.push({ level: Number(level), id, text });
    if (level === '2') return `<h2 id="${id}"${attrs}><span class="num">${number}</span>${inner}</h2>`;
    return `<h3 id="${id}"${attrs}>${inner}<a class="anchor" href="#${id}" aria-label="Link to this section">¶</a></h3>`;
  });
  if (!title) throw new Error(`${file}: a chapter starts with its <h2>`);
  html = html.replace(/<figure([^>]*)data-figure="([a-z0-9-]+)"([^>]*)>/g, (_m, before, name, after) => {
    const svg = figures.get(name);
    if (!svg) throw new Error(`${file}: figure "${name}" has no ${DIR}/figures/${name}.svg`);
    return `<figure${before}${after} data-figure="${name}">${svg}`;
  });
  html = html.replace(/<img([^>]*)data-image="([a-z0-9-]+)"([^>]*)>/g, (_m, before, name, after) => {
    const src = images.get(name);
    if (!src) throw new Error(`${file}: image "${name}" has no ${DIR}/images/${name}.jpg or .png`);
    return `<img${before}src="${src}" data-image="${name}"${after}>`;
  });
  return { html, headings, title };
}

function check(html, file, meta) {
  const problems = [];
  if (/<(script|link|img|iframe|video|audio|source|object|embed)\b[^>]*\b(src|href)=["']?(https?:)?\/\//i.test(html)) problems.push('loads something from the network');
  if (/url\(\s*["']?(https?:)?\/\//i.test(html)) problems.push('a CSS url() reaches the network');
  if (/@import\b/i.test(html)) problems.push('a CSS @import');
  if (!meta.sources && !meta.links && /https?:\/\//i.test(html)) problems.push('an outside link; outside links belong to the author page and the sources appendix');
  if (!meta.repoPaths && /\b(README\.md|AGENTS\.md|CONTRIBUTING\.md|docs\/[a-z-]+\/|apps\/[a-z-]+\/|packages\/[a-z-]+\/|scripts\/[a-z-]+)/.test(html.replace(/https?:\/\/[^\s"'<]+/g, ''))) problems.push('names a repository file; the book stands without the repository');
  if (/\bTODO\b|\bTBD\b|lorem ipsum/i.test(html)) problems.push('an unfinished passage');
  if (/[Ѐ-ӿ]/.test(html)) problems.push('Cyrillic text (the book is English; translations are separate editions)');
  if (problems.length) throw new Error(`${file}: ${problems.join('; ')}`);
}

function readSvg(path) {
  return readFileSync(path, 'utf8').replace(/<\?xml[^>]*>\s*/, '').replace(/<!--[\s\S]*?-->\s*/g, '').trim();
}

function load() {
  const at = (p) => join(root, DIR, p);
  const book = JSON.parse(readFileSync(at('book.json'), 'utf8'));
  const figures = new Map();
  for (const name of readdirSync(at('figures')).filter((n) => n.endsWith('.svg'))) figures.set(name.slice(0, -4), readSvg(at(`figures/${name}`)));
  const images = new Map();
  for (const name of existsSync(at('images')) ? readdirSync(at('images')) : []) {
    const m = /^([a-z0-9-]+)\.(jpg|png)$/.exec(name);
    if (m) images.set(m[1], `data:image/${m[2] === 'png' ? 'png' : 'jpeg'};base64,${readFileSync(at(`images/${name}`)).toString('base64')}`);
  }
  const chapters = [];
  let number = 0;
  for (const part of book.parts) {
    for (const meta of part.chapters) {
      number += 1;
      const source = readFileSync(at(`chapters/${meta.file}`), 'utf8');
      check(source, meta.file, meta);
      chapters.push({ part, meta, number, source, ...chapter(source, number, figures, images, meta.file) });
    }
  }
  return { book, chapters, at };
}

function art(at, name) {
  const svg = readSvg(at(`art/${name}.svg`))
    .replace(/\bid="([^"]+)"/g, `id="${name}-$1"`)
    .replace(/url\(#([^)]+)\)/g, `url(#${name}-$1)`)
    .replace(/href="#([^"]+)"/g, `href="#${name}-$1"`)
    .replace(/<svg\b/, '<svg aria-hidden="true" focusable="false" preserveAspectRatio="xMidYMid slice"');
  if (/https?:\/\/(?!www\.w3\.org\/)/i.test(svg)) throw new Error(`art/${name}.svg reaches the network`);
  return `<div class="part-art">${svg}</div>`;
}

function html({ book, chapters, at }) {
  const css = readFileSync(at('book.css'), 'utf8');
  const js = readFileSync(at('book.js'), 'utf8');
  if (/https?:\/\//i.test(css) || /@import/i.test(css)) throw new Error('book.css reaches the network');
  if (/https?:\/\//i.test(js) || /\bfetch\(|XMLHttpRequest|navigator\.sendBeacon/i.test(js)) throw new Error('book.js reaches the network');
  const body = [];
  const contents = [];
  let part = null;
  for (const c of chapters) {
    if (c.part !== part) {
      if (part) contents.push('</ol></li>');
      part = c.part;
      contents.push(`<li class="part"><span>${part.title}</span><ol>`);
      body.push(`<section class="part" id="part-${slug(plain(part.title))}" aria-label="${escape(plain(part.title))}">${part.art ? art(at, part.art) : ''}<p class="part-title">${part.title}</p></section>`);
    }
    const subs = c.headings.filter((h) => h.level === 3).map((h) => `<li><a href="#${h.id}">${h.text}</a></li>`).join('');
    contents.push(`<li><a href="#ch-${c.number}"><span class="num">${c.number}</span><span class="t">${c.title}</span></a>${subs ? `<ol class="subs">${subs}</ol>` : ''}</li>`);
    body.push(`<article class="chapter" id="chapter-${c.number}" data-chapter="${c.number}" data-title="${escape(c.title)}">\n${c.html}\n</article>`);
  }
  contents.push('</ol></li>');
  return `<!doctype html>
<html lang="en" class="no-js">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="description" content="${escape(book.description)}">
<title>${escape(book.title)}</title>
<style>
${css}
</style>
</head>
<body>
<a class="skip" href="#contents">Skip to the contents</a>
<div class="progress" aria-hidden="true"><div class="bar"></div></div>
<header class="topbar" id="top">
  <a class="brand" href="#top" aria-label="${escape(book.title)}">${book.mark}<span class="word">${book.word}</span></a>
  <span class="where" aria-live="polite"></span>
  <nav class="tools" aria-label="Book tools">
    <a class="toc-link" href="#contents">Contents</a>
    <button class="theme" type="button" aria-label="Switch between light and dark" title="Light or dark" hidden>◐</button>
  </nav>
</header>
<main class="book">
<section class="cover" aria-labelledby="book-title">
  <p class="eyebrow">${escape(book.edition)}</p>
  <h1 id="book-title">${book.title}</h1>
  <p class="subtitle">${book.subtitle}</p>
  <p class="cover-voice">${book.coverVoice}</p>${book.author ? `\n  <p class="cover-author">${book.author}</p>` : ''}
  <a class="begin" href="#ch-1">Begin reading</a>
</section>
<nav class="contents" id="contents" aria-labelledby="contents-title">
  <h2 id="contents-title">Contents</h2>
  <ol>
${contents.join('\n')}
  </ol>
</nav>
${body.join('\n')}
</main>
<footer class="colophon">
${book.colophon.map((line) => `  <p>${line}</p>`).join('\n')}
  <p><a href="#top">Back to the top</a></p>
</footer>
<script>
${js}
</script>
</body>
</html>
`;
}

/* ---------- Markdown text edition ---------- */

const VOID = new Set(['img', 'br', 'hr', 'meta', 'source']);
function parse(source) {
  const rootNode = { tag: '#root', attrs: {}, children: [] };
  const stack = [rootNode];
  const re = /<!--[\s\S]*?-->|<\/([a-z0-9]+)\s*>|<([a-z0-9]+)((?:\s+[a-z-:]+(?:="[^"]*"|='[^']*')?)*)\s*\/?>|([^<]+)/gi;
  for (const m of source.matchAll(re)) {
    const top = stack[stack.length - 1];
    if (m[4] !== undefined) top.children.push({ text: m[4] });
    else if (m[1]) {
      const at = stack.map((n) => n.tag).lastIndexOf(m[1].toLowerCase());
      if (at > 0) stack.length = at;
    } else if (m[2]) {
      const attrs = {};
      for (const a of (m[3] || '').matchAll(/([a-z-:]+)(?:="([^"]*)"|='([^']*)')?/gi)) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? '');
      const node = { tag: m[2].toLowerCase(), attrs, children: [] };
      top.children.push(node);
      if (!VOID.has(node.tag) && !m[0].endsWith('/>')) stack.push(node);
    }
  }
  return rootNode;
}
const has = (n, cls) => (n.attrs?.class || '').split(/\s+/).includes(cls);
const mdText = (t) => decode(t).replace(/\s+/g, ' ').replace(/</g, '&lt;').replace(/([*_`[\]])/g, '\\$1');

function inline(node, ctx) {
  if (node.text !== undefined) return mdText(node.text);
  const inner = () => node.children.map((c) => inline(c, ctx)).join('');
  switch (node.tag) {
    case 'strong': case 'b': { const s = inner().trim(); return s ? `**${s}**` : ''; }
    case 'em': case 'i': case 'cite': { const s = inner().trim(); return s ? `*${s}*` : ''; }
    case 'code': return '`' + plain(node.children.map(raw).join('')) + '`';
    case 'br': return '  \n';
    case 'a': {
      const href = node.attrs.href || '';
      const text = inner().trim();
      if (/^#ch-(\d+)$/.test(href)) return `[${text}](${ctx.files.get(Number(href.slice(4)))})`;
      if (href.startsWith('#') || !href) return text;
      return `[${text}](${href})`;
    }
    case 'span': return has(node, 'tag') ? `**[${inner().trim()}]**` : inner();
    case 'img': return `![${mdText(node.attrs.alt || '')}](../images/${node.attrs['data-image']}.jpg)`;
    case 'sup': return `^${inner()}`;
    default: return inner();
  }
}
const raw = (n) => (n.text !== undefined ? n.text : n.children.map(raw).join(''));
const line = (node, ctx) => inline(node, ctx).replace(/[ \t]*\n[ \t]*/g, '\n').replace(/ {2,}/g, ' ').trim();
const quote = (text) => text.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');

function block(node, ctx) {
  if (node.text !== undefined) { const t = mdText(node.text).trim(); return t ? [t] : []; }
  const kids = () => node.children.flatMap((c) => block(c, ctx));
  switch (node.tag) {
    case '#root': case 'div': case 'section': case 'article': case 'tbody': case 'thead':
      if (has(node, 'scene')) return [quote(kids().join('\n\n'))];
      if (node.tag === 'div' || node.tag === '#root') return kids();
      return kids();
    case 'h2': return [`# ${ctx.number}. ${line(node, ctx)}`];
    case 'h3': return [`## ${line(node, ctx)}`];
    case 'h4': return [`### ${line(node, ctx)}`];
    case 'p': { const t = line(node, ctx); if (!t) return []; return [has(node, 'lede') ? `*${t.replace(/\*/g, '')}*` : t]; }
    case 'aside': {
      const label = has(node, 'note') ? '**Note.** ' : '';
      const parts = kids();
      if (label && parts.length) parts[0] = label + parts[0];
      return [quote(parts.join('\n\n'))];
    }
    case 'ul': case 'ol': {
      let i = 0;
      return [node.children.filter((c) => c.tag === 'li').map((li) => {
        i += 1;
        const bullet = node.tag === 'ol' ? `${i}.` : '-';
        if (has(li, 'card')) {
          const el = li.children.filter((c) => c.tag);
          const h = el.find((c) => c.tag === 'h4');
          const meta = el.find((c) => c.tag === 'p' && has(c, 'meta'));
          const rest = el.filter((c) => c !== h && c !== meta).flatMap((c) => block(c, ctx)).join(' ');
          return `${bullet} ${h ? `**${line(h, ctx)}**` : ''}${meta ? ` (${line(meta, ctx)})` : ''}${rest ? `: ${rest}` : ''}`.replace(/\n+/g, ' ');
        }
        const nested = li.children.some((c) => ['p', 'h4', 'ul', 'ol', 'div'].includes(c.tag));
        const text = nested ? li.children.flatMap((c) => block(c, ctx)).map((t) => t.replace(/^### (.*)$/, '**$1**')).join(' — ') : line(li, ctx);
        return `${bullet} ${text.replace(/\n+/g, ' ')}`;
      }).join('\n')];
    }
    case 'dl': {
      const out = [];
      for (const c of node.children) {
        if (c.tag === 'dt') out.push(`**${line(c, ctx)}**`);
        else if (c.tag === 'dd') out.push(c.children.some((k) => k.tag === 'p') ? c.children.flatMap((k) => block(k, ctx)).join('\n\n') : line(c, ctx));
      }
      return out;
    }
    case 'table': {
      const rows = [];
      const walkRows = (n) => n.children?.forEach((c) => (c.tag === 'tr' ? rows.push(c) : walkRows(c)));
      walkRows(node);
      if (!rows.length) return [];
      const cells = rows.map((r) => r.children.filter((c) => c.tag === 'td' || c.tag === 'th').map((c) => line(c, ctx).replace(/\n+/g, ' ').replace(/\|/g, '\\|')));
      const width = Math.max(...cells.map((r) => r.length));
      const fill = (r) => `| ${[...r, ...Array(width - r.length).fill('')].join(' | ')} |`;
      return [[fill(cells[0]), `|${' --- |'.repeat(width)}`, ...cells.slice(1).map(fill)].join('\n')];
    }
    case 'figure': {
      const caption = node.children.find((c) => c.tag === 'figcaption');
      const img = node.children.find((c) => c.tag === 'img');
      const out = [];
      if (img) out.push(inline(img, ctx));
      else if (node.attrs['data-figure']) out.push(`*Figure (drawn in the HTML edition): ${caption ? line(caption, ctx).replace(/\*/g, '') : node.attrs['data-figure']}*`);
      if (img && caption) out.push(line(caption, ctx).replace(/^\*\*([^*]+)\*\* /, '**$1**. '));
      return out;
    }
    case 'figcaption': return [];
    case 'blockquote': return [quote(kids().join('\n\n'))];
    case 'hr': return ['---'];
    default: { const t = line(node, ctx); return t ? [t] : []; }
  }
}

const GENERATED = (file) => `<!-- Generated by npm run book from docs/book/chapters/${file}. Edit the chapter, not this file. -->`;

function text({ book, chapters }) {
  const files = new Map(chapters.map((c) => [c.number, `${String(c.number).padStart(2, '0')}-${slug(c.title, 48)}.md`]));
  const out = new Map();
  for (const c of chapters) {
    const ctx = { number: c.number, files };
    const prev = chapters[c.number - 2];
    const next = chapters[c.number];
    const nav = [prev ? `Previous: [${prev.number}. ${prev.title}](${files.get(prev.number)})` : null, '[Contents](README.md)', next ? `Next: [${next.number}. ${next.title}](${files.get(next.number)})` : null].filter(Boolean).join(' · ');
    const body = block(parse(c.source), ctx).join('\n\n').replace(/\n{3,}/g, '\n\n');
    out.set(files.get(c.number), `${GENERATED(c.meta.file)}\n\n*${plain(c.part.title)}*\n\n${body}\n\n---\n\n${nav}\n`);
  }
  const toc = [];
  let part = null;
  for (const c of chapters) {
    if (c.part !== part) { part = c.part; toc.push('', `**${plain(part.title)}**`, ''); }
    toc.push(`${c.number}. [${c.title}](${files.get(c.number)})`);
  }
  out.set('README.md', `<!-- Generated by npm run book from docs/book/book.json. Edit the sources, not this file. -->

# ${plain(book.title)}: text edition

*${plain(book.subtitle)}*

${plain(book.edition)}. ${plain(book.author || '')}

This is the plain text of the book, one file per chapter, generated from the same sources as the designed offline edition ([trustwork-book.html](../trustwork-book.html), download it and open it in any browser). Figures are drawn only in the HTML edition. How the book is made and how to contribute to it: [docs/book/README.md](../README.md).
${toc.join('\n').replace(/\n(\d+)\. /g, '\n$1. ')}
`);
  return out;
}

/* ---------- write or check ---------- */

export function outputs() {
  const loaded = load();
  const files = new Map([[join(DIR, loaded.book.out), html(loaded)]]);
  for (const [name, body] of text(loaded)) files.set(join(DIR, TEXT, name), body);
  return files;
}

export function drift() {
  const problems = [];
  const files = outputs();
  for (const [path, body] of files) {
    const current = existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null;
    if (current !== body) problems.push(`${path} drifts from docs/book; run \`npm run book\` and commit the result`);
  }
  const textDir = join(root, DIR, TEXT);
  for (const name of existsSync(textDir) ? readdirSync(textDir) : []) if (!files.has(join(DIR, TEXT, name))) problems.push(`${join(DIR, TEXT, name)} is not written by the build; remove it`);
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  if (process.argv.includes('--check')) {
    const problems = drift();
    if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; } else console.log('book: the HTML and text editions are current.');
  } else {
    const files = outputs();
    mkdirSync(join(root, DIR, TEXT), { recursive: true });
    const keep = new Set(files.keys());
    for (const name of existsSync(join(root, DIR, TEXT)) ? readdirSync(join(root, DIR, TEXT)) : []) if (!keep.has(join(DIR, TEXT, name))) console.warn(`book: ${join(DIR, TEXT, name)} is stale; remove it`);
    for (const [path, body] of files) writeFileSync(join(root, path), body);
    const htmlPath = [...files.keys()][0];
    console.log(`book: wrote ${htmlPath} (${(files.get(htmlPath).length / 1024).toFixed(0)} KiB) and ${files.size - 1} text files.`);
  }
}
