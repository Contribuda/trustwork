"""Rebuilds the canonical logo (SVG variants per language) and the inline geometry used by <Brand />.

The brand is three blue squares plus a black stacked wordmark: «trust / work» in every language (engine set),
and per-locale deployment lettering from a brand overlay (deployment set; «строй / репутация» for the Russian
interface only, ADR 010 decision 14). Latin and Cyrillic lines are outlined from Golos Text Bold;
Georgian and Armenian lines from Noto Sans Georgian / Noto Sans Armenian Bold (all OFL 1.1).

Usage (from packages/ui):
  python3 -I brand/tools/build-logo.py <GolosText[wght].ttf> <NotoSansGeorgian[wdth,wght].ttf> <NotoSansArmenian[wdth,wght].ttf> brand src/components/Brand/wordmark.ts

Requirements: Python 3.10+, fontTools >= 4.67, brotli (pip install fonttools brotli). Font sources and
checksums: fonts/PROVENANCE.md. The wordmark is outlined at wght 700 (wdth 100) with GPOS pair kerning
applied; geometry constants below are the canonical values documented in docs/design/system/logo.md.
"""
import json
import os
import sys

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

golos_src, georgian_src, armenian_src, out_dir, ts_out = sys.argv[1:6]
SET = sys.argv[6] if len(sys.argv) > 6 else 'engine'  # 'engine' = neutral Trustwork lettering; 'deployment' = lettering from the JSON in argv[7]
WEIGHT = 700
os.makedirs(out_dir, exist_ok=True)

# Lettering per locale: two stacked lines, the brand name, and the font that has the script.
# Uzbek uses the typographic apostrophe U+2019 in the wordmark because Golos Text has no U+02BB glyph.
# Deployment lettering comes from a JSON file next to the deployment's brand overlay (apps/web/brand/lettering.json):
# { "<tag>": { "font": "golos|georgian|armenian", "line1": "...", "line2": "...", "name": "..." } }.
DEPLOYMENT = json.load(open(sys.argv[7], encoding='utf-8')) if SET == 'deployment' and len(sys.argv) > 7 else {}
# The engine's own lockup is the same in every language: the neutral name Trustwork (owner decision 2026-10-29).
ENGINE = {tag: {'font': 'golos', 'line1': 'trust', 'line2': 'work', 'name': 'Trustwork'} for tag in ['en', 'ru', 'uz-Latn', 'ka', 'hy', 'az-Latn']}
LOCALES = DEPLOYMENT if SET == 'deployment' else ENGINE


def load(path):
    font = TTFont(path)
    axes = {a.axisTag: a for a in font['fvar'].axes}
    loc = {'wght': WEIGHT}
    if 'wdth' in axes:
        loc['wdth'] = 100
    bold = instancer.instantiateVariableFont(font, loc)
    cmap = bold.getBestCmap()
    kern = {}
    if 'GPOS' in bold:
        gpos = bold['GPOS'].table
        for lookup in gpos.LookupList.Lookup:
            for st in lookup.SubTable:
                if lookup.LookupType == 9:
                    st = st.ExtSubTable
                if getattr(st, 'LookupType', lookup.LookupType) != 2:
                    continue
                if st.Format == 1:
                    for first, ps in zip(st.Coverage.glyphs, st.PairSet):
                        for pvr in ps.PairValueRecord:
                            v = pvr.Value1.XAdvance if pvr.Value1 and hasattr(pvr.Value1, 'XAdvance') else 0
                            if v:
                                kern.setdefault((first, pvr.SecondGlyph), v)
                elif st.Format == 2:
                    c1 = st.ClassDef1.classDefs
                    c2 = st.ClassDef2.classDefs
                    for first in st.Coverage.glyphs:
                        cl1 = c1.get(first, 0)
                        for second in cmap.values():
                            cl2 = c2.get(second, 0)
                            rec = st.Class1Record[cl1].Class2Record[cl2]
                            v = rec.Value1.XAdvance if rec.Value1 and hasattr(rec.Value1, 'XAdvance') else 0
                            if v:
                                kern.setdefault((first, second), v)
    return {'font': bold, 'cmap': cmap, 'gs': bold.getGlyphSet(), 'hmtx': bold['hmtx'], 'upm': bold['head'].unitsPerEm, 'kern': kern}


FONTS = {'golos': load(golos_src), 'georgian': load(georgian_src), 'armenian': load(armenian_src)}


def line(f, text):
    scale = 1 / f['upm']
    x = 0.0
    paths = []
    prev = None
    for ch in text:
        if ord(ch) not in f['cmap']:
            raise SystemExit(f'missing glyph U+{ord(ch):04X} ({ch!r})')
        g = f['cmap'][ord(ch)]
        if prev is not None:
            x += f['kern'].get((prev, g), 0)
        pen = SVGPathPen(f['gs'])
        tpen = TransformPen(pen, (scale, 0, 0, -scale, x * scale, 0))
        f['gs'][g].draw(tpen)
        d = pen.getCommands()
        if d:
            paths.append(d)
        x += f['hmtx'][g][0]
        prev = g
    return paths, x * scale


BLUE = '#1a6ee8'
INK = '#0f1627'

# Mark geometry (viewBox 0 0 100 100): three equal squares, L arrangement, top-left slot empty.
SQ, GAP, R = 46, 8, 5
squares = [(0, SQ + GAP), (SQ + GAP, SQ + GAP), (SQ + GAP, 0)]  # bottom-left, bottom-right, top-right


def rects(fill):
    return ''.join(f'<rect x="{x}" y="{y}" width="{SQ}" height="{SQ}" rx="{R}" fill="{fill}"/>' for x, y in squares)


# Wordmark: font-size in user units; baselines chosen so that the two lines span the mark height.
FS = 50.0
BASE1, BASE2 = 45.0, 96.0
MARK_SCALE = 0.98  # mark 98 units tall, top at y=8 so that it optically centres against the wordmark
MARK_X, MARK_Y = 0, 7
GAP_X = 28
WORD_X = MARK_X + 100 * MARK_SCALE + GAP_X
VB_H = 112


def fmt(n):
    s = f'{n:.3f}'.rstrip('0').rstrip('.')
    return s if s else '0'


def wordmark_group(wm, fill, x):
    g = f'<g fill="{fill}" transform="translate({fmt(x)} {BASE1}) scale({FS})">' + ''.join(f'<path d="{d}"/>' for d in wm['line1']) + '</g>'
    g += f'<g fill="{fill}" transform="translate({fmt(x)} {BASE2}) scale({FS})">' + ''.join(f'<path d="{d}"/>' for d in wm['line2']) + '</g>'
    return g


def mark_group(fill):
    return f'<g transform="translate({MARK_X} {MARK_Y}) scale({MARK_SCALE})">{rects(fill)}</g>'


HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n<!-- Trustwork logo: three squares and a stacked wordmark outlined from Golos Text Bold / Noto Sans Bold (OFL 1.1). Canonical generated asset: keep squares and paths; do not re-letter by hand. Regenerate with brand/tools/build-logo.py. -->\n'


def svg(w, h, body, title, tid, lang):
    return (HEADER + f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-labelledby="{tid}" lang="{lang}">'
            f'<title id="{tid}">{title}</title>{body}</svg>\n')


ref = (next(iter(LOCALES)) if SET == 'deployment' else 'en')
marks = {}
files = {
    'logo-mark.svg': svg(100, 100, rects(BLUE), LOCALES[ref]['name'], 'title-logo-mark', ref),
    'logo-mark-mono.svg': svg(100, 100, rects('currentColor'), LOCALES[ref]['name'], 'title-logo-mark-mono', ref),
}
for tag, spec in LOCALES.items():
    f = FONTS[spec['font']]
    l1, w1 = line(f, spec['line1'])
    l2, w2 = line(f, spec['line2'])
    width = max(w1, w2) * FS
    vb_w = round(WORD_X + width + 2)
    wm = {'line1': l1, 'line2': l2, 'width1': fmt(w1 * FS), 'width2': fmt(w2 * FS), 'viewBoxWidth': vb_w}
    marks[tag] = wm
    suffix = '' if tag == ref else f'.{tag}'
    if SET == 'engine' and tag != 'en':
        continue  # one neutral lockup; every locale shares it
    files[f'logo-full{suffix}.svg'] = svg(vb_w, VB_H, mark_group(BLUE) + wordmark_group(wm, INK, WORD_X), spec['name'], 'title-logo-full', tag)
    files[f'logo-full-mono{suffix}.svg'] = svg(vb_w, VB_H, mark_group('currentColor') + wordmark_group(wm, 'currentColor', WORD_X), spec['name'], 'title-logo-full-mono', tag)
    files[f'logo-full-inverse{suffix}.svg'] = svg(vb_w, VB_H, mark_group('#ffffff') + wordmark_group(wm, '#ffffff', WORD_X), spec['name'], 'title-logo-full-inverse', tag)

for name, text in files.items():
    open(os.path.join(out_dir, name), 'w').write(text)
    print(name, len(text))

ts = f'// Generated by brand/tools/build-logo.py ({SET} set) from Golos Text Bold and Noto Sans Bold outlines (see docs/design/system/logo.md). Do not edit by hand.\n'
ts += 'export type WordmarkLines = { readonly line1: readonly string[]; readonly line2: readonly string[]; readonly width1: number; readonly width2: number; readonly viewBoxWidth: number };\n'
ts += f'export const wordmarkGeometry = {{ fontSize: {FS}, baseline1: {BASE1}, baseline2: {BASE2} }} as const;\n'
ts += ('/** Stacked wordmark per locale tag: «trust / work» in every language. */\n' if SET == 'engine' else '/** Stacked wordmark per locale tag from the brand overlay lettering; locales without an entry use the engine lockup. */\n')
ts += ('export const wordmarks: Record<string, WordmarkLines> = {\n' if SET == 'engine' else 'export const deploymentWordmarks: Record<string, WordmarkLines> = {\n')
for tag, wm in marks.items():
    ts += f'  {json.dumps(tag)}: {{ line1: {json.dumps(wm["line1"])}, line2: {json.dumps(wm["line2"])}, width1: {wm["width1"]}, width2: {wm["width2"]}, viewBoxWidth: {wm["viewBoxWidth"]} }},\n'
ts += '};\n'
if SET == 'engine':
    ts += f'export const logoGeometry = {{ viewBoxHeight: {VB_H}, markScale: {MARK_SCALE}, markX: {MARK_X}, markY: {MARK_Y}, wordX: {fmt(WORD_X)}, square: {SQ}, gap: {GAP}, radius: {R} }} as const;\n'
open(ts_out, 'w').write(ts)
print('wordX', WORD_X, {t: m['viewBoxWidth'] for t, m in marks.items()})
