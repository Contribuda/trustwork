#!/usr/bin/env python3
"""
Generates the original SVG cover artworks of @trustwork/ui (packages/ui/media/artworks/*.svg).

Each artwork is an abstract "material" composition (concrete grain, wood lamellae, glass grid, steel
profile, brick bond, mineral wool, facade cassettes, blueprint lines, isometric blocks, ...) drawn with
the brand palette, finished with a subtle procedural noise (feTurbulence) so flat fills read as
material rather than vector clip-art. Generation is deterministic: every artwork uses its own fixed
seed, so re-running the script yields byte-identical files. No third-party rights are involved.

Usage (from the repository root):
  python3 packages/ui/media/tools/build-artworks.py

Output: artworks/<id>.svg (1600x1000 viewBox, 16:10; covers crop it to other ratios) and
artworks/manifest.json (id, Russian title/alt, tone for text overlays, dominant colour, kinds).
"""
from __future__ import annotations

import json
import math
import random
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "artworks"
W, H = 1600, 1000

# Brand palette (see packages/ui/tokens/index.ts). Only blue is saturated; everything else is navy,
# warm greys and sand so photographs and artworks sit together.
P = {
    "navy": "#0f1f3d",
    "navy2": "#16295a",
    "ink": "#111827",
    "blue": "#0756d8",
    "blue600": "#1a6ee8",
    "blue400": "#5b93f0",
    "blue200": "#b7cdf5",
    "blue100": "#e6eefc",
    "blue50": "#f0f5ff",
    "warm": "#f6f5f2",
    "sand": "#e9e4da",
    "sand2": "#d8d0c2",
    "tan": "#c9b79a",
    "tan2": "#b39f7f",
    "stone": "#cfd3d9",
    "stone2": "#b4bac4",
    "slate": "#5b6472",
    "slate2": "#7a8494",
    "white": "#ffffff",
}


def noise_filter(strength: float = 0.07, freq: float = 0.9) -> str:
    return (
        f'<filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="{freq}" '
        f'numOctaves="2" stitchTiles="stitch" result="t"/><feColorMatrix in="t" type="saturate" values="0" result="g"/>'
        f'<feComponentTransfer in="g"><feFuncA type="table" tableValues="0 {strength}"/></feComponentTransfer></filter>'
    )


def grain_rect() -> str:
    return f'<rect width="{W}" height="{H}" filter="url(#grain)"/>'


def svg(body: str, defs: str = "", strength: float = 0.07, freq: float = 0.9) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-hidden="true">'
        f"<defs>{noise_filter(strength, freq)}{defs}</defs>{body}{grain_rect()}</svg>"
    )


def rect(x, y, w, h, fill, extra="") -> str:
    return f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" fill="{fill}"{extra}/>'


def poly(points, fill, extra="") -> str:
    pts = " ".join(f"{x:.1f},{y:.1f}" for x, y in points)
    return f'<polygon points="{pts}" fill="{fill}"{extra}/>'


def concrete_grain(r: random.Random) -> str:
    body = [rect(0, 0, W, H, P["stone"])]
    # cast shadow band from a slab edge and a soft lighter zone
    body.append(f'<rect width="{W}" height="{H}" fill="url(#lg)"/>')
    for _ in range(1400):
        x, y = r.uniform(0, W), r.uniform(0, H)
        s = r.uniform(1.2, 5.5)
        c = r.choice([P["stone2"], P["slate2"], P["white"], P["sand2"]])
        body.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{s:.1f}" fill="{c}" opacity="{r.uniform(0.25, 0.7):.2f}"/>')
    # formwork tie holes
    for i in range(3):
        for j in range(2):
            cx, cy = 300 + i * 500, 300 + j * 400
            body.append(f'<circle cx="{cx}" cy="{cy}" r="26" fill="{P["slate"]}" opacity="0.55"/>')
            body.append(f'<circle cx="{cx}" cy="{cy}" r="18" fill="{P["ink"]}" opacity="0.5"/>')
    body.append(rect(0, 640, W, 4, P["slate2"], ' opacity="0.5"'))
    body.append(rect(820, 0, 4, H, P["slate2"], ' opacity="0.4"'))
    defs = f'<linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{P["white"]}" stop-opacity="0.35"/><stop offset="0.6" stop-color="{P["white"]}" stop-opacity="0"/><stop offset="1" stop-color="{P["slate"]}" stop-opacity="0.35"/></linearGradient>'
    return svg("".join(body), defs, strength=0.12, freq=0.75)


def wood_lamellae(r: random.Random) -> str:
    body = [rect(0, 0, W, H, P["warm"])]
    x = 0.0
    while x < W:
        w = r.uniform(42, 78)
        tone = r.choice([P["tan"], P["tan2"], P["sand2"], P["tan"]])
        body.append(rect(x, 0, w - 6, H, tone))
        # grain lines
        for _ in range(int(w / 9)):
            gx = x + r.uniform(2, w - 10)
            body.append(f'<path d="M{gx:.1f},0 C{gx + r.uniform(-6, 6):.1f},{H * 0.33:.0f} {gx + r.uniform(-6, 6):.1f},{H * 0.66:.0f} {gx + r.uniform(-4, 4):.1f},{H}" stroke="{P["ink"]}" stroke-opacity="{r.uniform(0.04, 0.12):.2f}" stroke-width="{r.uniform(0.8, 2):.1f}" fill="none"/>')
        body.append(rect(x + w - 6, 0, 6, H, P["navy"], ' opacity="0.18"'))
        x += w
    body.append(f'<rect width="{W}" height="{H}" fill="url(#lg)"/>')
    defs = f'<linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{P["white"]}" stop-opacity="0.25"/><stop offset="1" stop-color="{P["navy"]}" stop-opacity="0.22"/></linearGradient>'
    return svg("".join(body), defs, strength=0.08)


def glass_grid(r: random.Random) -> str:
    body = [rect(0, 0, W, H, P["navy"])]
    cols, rows = 10, 7
    cw, ch = W / cols, H / rows
    for i in range(cols):
        for j in range(rows):
            t = (i / cols + j / rows) / 2
            base = r.choice([P["blue"], P["blue600"], P["navy2"], P["blue400"]]) if r.random() < 0.55 else P["navy2"]
            op = 0.35 + 0.55 * (1 - abs(t - 0.45))
            body.append(rect(i * cw + 4, j * ch + 4, cw - 8, ch - 8, base, f' opacity="{op:.2f}"'))
            if r.random() < 0.25:
                body.append(rect(i * cw + 4, j * ch + 4, cw - 8, (ch - 8) * r.uniform(0.2, 0.5), P["blue100"], f' opacity="{r.uniform(0.08, 0.22):.2f}"'))
    # mullions
    for i in range(cols + 1):
        body.append(rect(i * cw - 3, 0, 6, H, P["ink"], ' opacity="0.55"'))
    for j in range(rows + 1):
        body.append(rect(0, j * ch - 3, W, 6, P["ink"], ' opacity="0.55"'))
    body.append(poly([(0, 0), (W * 0.55, 0), (W * 0.15, H)], P["white"], ' opacity="0.07"'))
    return svg("".join(body), strength=0.06)


def steel_profile(r: random.Random) -> str:
    body = [rect(0, 0, W, H, P["warm"])]
    # repeated I-beam sections
    y = 70
    while y < H - 60:
        x = 60 + r.uniform(-30, 30)
        while x < W:
            bw, bh = 130, 150
            c = r.choice([P["slate"], P["slate2"], P["stone2"], P["navy"]])
            body.append(rect(x, y, bw, 22, c))
            body.append(rect(x, y + bh - 22, bw, 22, c))
            body.append(rect(x + bw / 2 - 11, y + 22, 22, bh - 44, c))
            body.append(rect(x + 4, y + 4, bw - 8, 6, P["white"], ' opacity="0.35"'))
            x += 230
        y += 210
    body.append(poly([(0, H * 0.72), (W, H * 0.3), (W, H), (0, H)], P["navy"], ' opacity="0.08"'))
    return svg("".join(body), strength=0.07)


def brick_bond(r: random.Random) -> str:
    body = [rect(0, 0, W, H, P["sand"])]
    bh, bw, m = 62, 190, 10
    row = 0
    y = -20
    while y < H:
        x = -bw / 2 if row % 2 else 0
        while x < W:
            c = r.choice([P["stone2"], P["stone"], P["slate2"], P["sand2"]])
            if r.random() < 0.08:
                c = P["blue"]
            elif r.random() < 0.08:
                c = P["navy"]
            body.append(rect(x + m, y + m, bw - m, bh - m, c, ' rx="3"'))
            body.append(rect(x + m, y + m, bw - m, 8, P["white"], ' opacity="0.18"'))
            x += bw
        y += bh
        row += 1
    body.append(f'<rect width="{W}" height="{H}" fill="url(#lg)"/>')
    defs = f'<linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{P["white"]}" stop-opacity="0.2"/><stop offset="1" stop-color="{P["navy"]}" stop-opacity="0.18"/></linearGradient>'
    return svg("".join(body), defs, strength=0.09)


def mineral_wool(r: random.Random) -> str:
    body = [rect(0, 0, W, H, P["sand"])]
    for _ in range(260):
        y0 = r.uniform(-50, H + 50)
        amp = r.uniform(10, 40)
        d = f"M-20,{y0:.1f}"
        x = -20
        while x < W + 40:
            x += r.uniform(80, 160)
            d += f" Q{x - 60:.0f},{y0 + r.uniform(-amp, amp):.1f} {x:.0f},{y0 + r.uniform(-amp / 2, amp / 2):.1f}"
        c = r.choice([P["tan"], P["tan2"], P["sand2"], P["white"], P["slate2"]])
        body.append(f'<path d="{d}" stroke="{c}" stroke-width="{r.uniform(1.5, 7):.1f}" stroke-opacity="{r.uniform(0.25, 0.8):.2f}" fill="none" stroke-linecap="round"/>')
    # a cut edge: layered strata on the right
    body.append(rect(W * 0.72, 0, W * 0.28, H, P["navy"], ' opacity="0.9"'))
    for k in range(6):
        body.append(rect(W * 0.72, k * H / 6, W * 0.28, H / 6 - 10, r.choice([P["navy2"], P["blue"], P["slate"]]), f' opacity="{0.5 + k * 0.06:.2f}"'))
    return svg("".join(body), strength=0.1, freq=1.1)


def facade_cassettes(r: random.Random) -> str:
    body = [rect(0, 0, W, H, P["stone"])]
    cols = 8
    cw = W / cols
    for i in range(cols):
        y = -r.uniform(0, 120)
        while y < H:
            h = r.uniform(120, 300)
            c = r.choice([P["stone2"], P["stone"], P["sand2"], P["slate2"], P["blue200"]])
            if r.random() < 0.1:
                c = P["navy"]
            body.append(rect(i * cw + 6, y + 6, cw - 12, h - 12, c, ' rx="2"'))
            body.append(rect(i * cw + 6, y + h - 18, cw - 12, 12, P["ink"], ' opacity="0.2"'))
            body.append(rect(i * cw + cw - 18, y + 6, 12, h - 12, P["ink"], ' opacity="0.12"'))
            y += h
    body.append(poly([(0, 0), (W, 0), (W, H * 0.35), (0, H * 0.75)], P["white"], ' opacity="0.16"'))
    return svg("".join(body), strength=0.07)


def blueprint_lines(r: random.Random) -> str:
    body = [rect(0, 0, W, H, P["navy"])]
    stroke = P["blue200"]
    # grid
    for x in range(0, W + 1, 50):
        body.append(f'<line x1="{x}" y1="0" x2="{x}" y2="{H}" stroke="{stroke}" stroke-opacity="{0.18 if x % 250 == 0 else 0.07}" stroke-width="1"/>')
    for y in range(0, H + 1, 50):
        body.append(f'<line x1="0" y1="{y}" x2="{W}" y2="{y}" stroke="{stroke}" stroke-opacity="{0.18 if y % 250 == 0 else 0.07}" stroke-width="1"/>')
    # plan outline with rooms
    ox, oy, ow, oh = 240, 180, 1000, 620
    body.append(f'<rect x="{ox}" y="{oy}" width="{ow}" height="{oh}" fill="none" stroke="{P["white"]}" stroke-width="5"/>')
    x = ox
    for _ in range(4):
        x += r.uniform(160, 300)
        if x < ox + ow - 100:
            body.append(f'<line x1="{x:.0f}" y1="{oy}" x2="{x:.0f}" y2="{oy + oh}" stroke="{P["white"]}" stroke-width="3" stroke-opacity="0.9"/>')
    body.append(f'<line x1="{ox}" y1="{oy + 380}" x2="{ox + ow}" y2="{oy + 380}" stroke="{P["white"]}" stroke-width="3" stroke-opacity="0.9"/>')
    # door arcs and windows
    for _ in range(7):
        cx, cy = r.uniform(ox + 60, ox + ow - 60), r.choice([oy, oy + 380, oy + oh])
        body.append(f'<path d="M{cx:.0f},{cy} a70,70 0 0 1 70,70" fill="none" stroke="{stroke}" stroke-width="2"/>')
    for _ in range(14):
        wx = r.uniform(ox + 40, ox + ow - 120)
        body.append(f'<rect x="{wx:.0f}" y="{oy - 6}" width="80" height="12" fill="{P["blue600"]}"/>')
    # dimension lines
    body.append(f'<line x1="{ox}" y1="{oy - 70}" x2="{ox + ow}" y2="{oy - 70}" stroke="{stroke}" stroke-width="2"/>')
    body.append(f'<line x1="{ox - 70}" y1="{oy}" x2="{ox - 70}" y2="{oy + oh}" stroke="{stroke}" stroke-width="2"/>')
    for i in range(0, ow + 1, 250):
        body.append(f'<line x1="{ox + i}" y1="{oy - 82}" x2="{ox + i}" y2="{oy - 58}" stroke="{stroke}" stroke-width="2"/>')
    body.append(f'<circle cx="{ox + ow + 150}" cy="{oy + 130}" r="80" fill="none" stroke="{stroke}" stroke-width="2"/>')
    body.append(f'<line x1="{ox + ow + 150}" y1="{oy + 30}" x2="{ox + ow + 150}" y2="{oy + 230}" stroke="{stroke}" stroke-width="2"/>')
    body.append(f'<line x1="{ox + ow + 50}" y1="{oy + 130}" x2="{ox + ow + 250}" y2="{oy + 130}" stroke="{stroke}" stroke-width="2"/>')
    return svg("".join(body), strength=0.05, freq=1.2)


def iso_blocks(r: random.Random) -> str:
    body = [rect(0, 0, W, H, P["blue50"])]
    s = 90  # tile size
    cos30 = math.cos(math.radians(30))
    heights = [[r.randint(0, 4) for _ in range(9)] for _ in range(9)]
    for gy in range(9):
        for gx in range(9):
            h = heights[gy][gx]
            if h == 0:
                continue
            cx = W / 2 + (gx - gy) * s * cos30
            cy = 170 + (gx + gy) * s * 0.5
            for lvl in range(h):
                z = cy - lvl * s * 0.8
                top = [(cx, z - s / 2), (cx + s * cos30, z - s / 4 + 0 * s), (cx, z), (cx - s * cos30, z - s / 4)]
                left = [(cx - s * cos30, z - s / 4), (cx, z), (cx, z + s * 0.8), (cx - s * cos30, z + s * 0.8 - s / 4)]
                right = [(cx + s * cos30, z - s / 4), (cx, z), (cx, z + s * 0.8), (cx + s * cos30, z + s * 0.8 - s / 4)]
                shade = r.random() < 0.15
                body.append(poly(left, P["navy"] if shade else P["slate2"]))
                body.append(poly(right, P["navy2"] if shade else P["stone2"]))
                body.append(poly(top, P["blue"] if shade else P["white"]))
    return svg("".join(body), strength=0.05)


def rebar_mesh(r: random.Random) -> str:
    body = [rect(0, 0, W, H, P["sand"])]
    step = 110
    for x in range(40, W, step):
        body.append(rect(x, 0, 14, H, P["slate"]))
        body.append(rect(x + 2, 0, 4, H, P["white"], ' opacity="0.3"'))
    for y in range(40, H, step):
        body.append(rect(0, y, W, 14, P["slate2"]))
        body.append(rect(0, y + 2, W, 4, P["white"], ' opacity="0.25"'))
        for x in range(40, W, step):
            body.append(f'<circle cx="{x + 7}" cy="{y + 7}" r="12" fill="none" stroke="{P["ink"]}" stroke-width="3" stroke-opacity="0.6"/>')
    body.append(poly([(0, 0), (W * 0.6, 0), (0, H * 0.6)], P["white"], ' opacity="0.25"'))
    body.append(poly([(W, H), (W * 0.4, H), (W, H * 0.4)], P["navy"], ' opacity="0.12"'))
    return svg("".join(body), strength=0.08)


def corrugated_sheet(r: random.Random) -> str:
    body = [rect(0, 0, W, H, P["stone"])]
    period = 56
    for x in range(0, W, period):
        body.append(f'<rect x="{x}" y="0" width="{period}" height="{H}" fill="url(#wave)"/>')
    body.append(poly([(0, 0), (W, 0), (W, H * 0.22), (0, H * 0.58)], P["navy"], ' opacity="0.78"'))
    defs = f'<linearGradient id="wave" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="{P["slate"]}"/><stop offset="0.35" stop-color="{P["white"]}"/><stop offset="0.6" stop-color="{P["stone2"]}"/><stop offset="1" stop-color="{P["slate"]}"/></linearGradient>'
    return svg("".join(body), defs, strength=0.06)


def terrazzo(r: random.Random) -> str:
    body = [rect(0, 0, W, H, P["warm"])]
    for _ in range(520):
        cx, cy = r.uniform(0, W), r.uniform(0, H)
        n = r.randint(4, 7)
        rad = r.uniform(8, 42)
        pts = []
        for k in range(n):
            a = 2 * math.pi * k / n + r.uniform(-0.3, 0.3)
            pts.append((cx + math.cos(a) * rad * r.uniform(0.6, 1.2), cy + math.sin(a) * rad * r.uniform(0.6, 1.2)))
        c = r.choices([P["navy"], P["blue"], P["slate2"], P["stone2"], P["tan"], P["blue200"]], weights=[3, 2, 4, 5, 3, 2])[0]
        body.append(poly(pts, c, f' opacity="{r.uniform(0.75, 1):.2f}"'))
    return svg("".join(body), strength=0.06)


def wall_layers(r: random.Random) -> str:
    body = [rect(0, 0, W, H, P["warm"])]
    layers = [(0, 0.16, P["stone2"]), (0.16, 0.24, P["stone"]), (0.24, 0.52, P["tan"]), (0.52, 0.58, P["navy"]), (0.58, 0.8, P["sand2"]), (0.8, 1.0, P["blue200"])]
    for a, b, c in layers:
        body.append(rect(0, 0, W * a, H, c) if False else rect(W * a, 0, W * (b - a), H, c))
    # insulation hatch in the tan layer
    for y in range(-200, H + 200, 44):
        body.append(f'<line x1="{W * 0.24:.0f}" y1="{y}" x2="{W * 0.52:.0f}" y2="{y + 240}" stroke="{P["tan2"]}" stroke-width="10" stroke-opacity="0.6"/>')
    # cassette joints in the last layer
    for y in range(0, H, 140):
        body.append(rect(W * 0.8, y, W * 0.2, 6, P["white"], ' opacity="0.6"'))
    # anchors
    for y in range(90, H, 180):
        body.append(rect(W * 0.14, y, W * 0.68, 10, P["slate"]))
        body.append(f'<circle cx="{W * 0.82:.0f}" cy="{y + 5}" r="14" fill="{P["navy"]}"/>')
    body.append(f'<rect width="{W}" height="{H}" fill="url(#lg)"/>')
    defs = f'<linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{P["white"]}" stop-opacity="0.2"/><stop offset="1" stop-color="{P["navy"]}" stop-opacity="0.18"/></linearGradient>'
    return svg("".join(body), defs, strength=0.08)


def timber_frame(r: random.Random) -> str:
    body = [rect(0, 0, W, H, P["blue100"])]
    body.append(f'<rect width="{W}" height="{H}" fill="url(#sky)"/>')
    # posts
    for x in range(120, W, 260):
        body.append(rect(x, 120, 44, H - 120, P["tan"]))
        body.append(rect(x, 120, 10, H - 120, P["white"], ' opacity="0.35"'))
    # plates
    body.append(rect(60, 120, W - 120, 44, P["tan2"]))
    body.append(rect(60, 560, W - 120, 36, P["tan2"]))
    # rafters
    for x in range(100, W, 180):
        body.append(poly([(x, 130), (x + 36, 130), (x + 460, -40), (x + 424, -40)], P["tan"]))
    # diagonal braces
    for x in range(120, W - 260, 520):
        body.append(poly([(x + 44, 164), (x + 64, 164), (x + 282, 560), (x + 262, 560)], P["tan2"]))
    body.append(rect(0, H - 90, W, 90, P["stone"]))
    defs = f'<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{P["blue200"]}"/><stop offset="1" stop-color="{P["white"]}" stop-opacity="0"/></linearGradient>'
    return svg("".join(body), defs, strength=0.06)


def glass_night(r: random.Random) -> str:
    body = [rect(0, 0, W, H, P["ink"])]
    cols, rows = 16, 10
    cw, ch = W / cols, H / rows
    for i in range(cols):
        for j in range(rows):
            lit = r.random() < 0.42
            c = r.choice([P["blue200"], P["blue100"], P["blue400"], P["white"]]) if lit else P["navy"]
            body.append(rect(i * cw + 3, j * ch + 3, cw - 6, ch - 6, c, f' opacity="{(r.uniform(0.55, 0.95) if lit else r.uniform(0.5, 0.9)):.2f}"'))
    body.append(poly([(0, H), (W * 0.7, H), (0, H * 0.2)], P["blue"], ' opacity="0.18"'))
    return svg("".join(body), strength=0.06)


def formwork(r: random.Random) -> str:
    body = [rect(0, 0, W, H, P["sand2"])]
    pw, ph = 400, 500
    for i in range(5):
        for j in range(3):
            x, y = i * pw - 100, j * ph - 150
            c = r.choice([P["tan"], P["sand2"], P["tan2"]])
            body.append(rect(x + 5, y + 5, pw - 10, ph - 10, c))
            for k in range(26):
                gx = x + 12 + k * 15
                body.append(f'<line x1="{gx}" y1="{y + 8}" x2="{gx + r.uniform(-4, 4):.0f}" y2="{y + ph - 8}" stroke="{P["ink"]}" stroke-opacity="0.05" stroke-width="1.5"/>')
            for (tx, ty) in [(x + 90, y + 110), (x + pw - 90, y + 110), (x + 90, y + ph - 110), (x + pw - 90, y + ph - 110)]:
                body.append(f'<circle cx="{tx}" cy="{ty}" r="16" fill="{P["slate"]}"/>')
                body.append(f'<circle cx="{tx}" cy="{ty}" r="7" fill="{P["ink"]}"/>')
    body.append(poly([(0, H * 0.7), (W, H * 0.45), (W, H), (0, H)], P["navy"], ' opacity="0.14"'))
    return svg("".join(body), strength=0.09)


ARTWORKS = [
    ("concrete-grain", "Бетон: зерно и опалубочные стяжки", "light", "#cfd3d9", ["material", "concrete", "texture"], concrete_grain),
    ("wood-lamellae", "Дерево: ламели", "light", "#c9b79a", ["material", "wood", "texture"], wood_lamellae),
    ("glass-grid", "Стекло: сетка фасада", "dark", "#0f1f3d", ["facade", "glass", "company"], glass_grid),
    ("steel-profile", "Сталь: двутавры", "light", "#f6f5f2", ["material", "steel", "structure"], steel_profile),
    ("brick-bond", "Кирпич: ложковая перевязка", "light", "#e9e4da", ["material", "brick", "texture"], brick_bond),
    ("mineral-wool", "Минеральная вата: волокно и слои", "light", "#e9e4da", ["material", "insulation", "supply"], mineral_wool),
    ("facade-cassettes", "Фасад: ритм кассет", "light", "#cfd3d9", ["facade", "project", "company"], facade_cassettes),
    ("blueprint-lines", "Чертёж: план и размерные линии", "dark", "#0f1f3d", ["drawing", "document", "article", "news"], blueprint_lines),
    ("iso-blocks", "Изометрия: сборка блоков", "light", "#f0f5ff", ["project", "supply", "article"], iso_blocks),
    ("rebar-mesh", "Арматура: сетка и вязка", "light", "#e9e4da", ["material", "steel", "site"], rebar_mesh),
    ("corrugated-sheet", "Профлист: волна и тень", "light", "#cfd3d9", ["material", "steel", "facade"], corrugated_sheet),
    ("terrazzo", "Терраццо: крошка в основе", "light", "#f6f5f2", ["material", "texture", "article"], terrazzo),
    ("wall-layers", "Стена в разрезе: слои ограждающей конструкции", "light", "#f6f5f2", ["structure", "insulation", "article"], wall_layers),
    ("timber-frame", "Каркас: стойки, обвязка, стропила", "light", "#e6eefc", ["structure", "wood", "project", "site"], timber_frame),
    ("glass-night", "Стеклянный фасад вечером", "dark", "#111827", ["facade", "glass", "news"], glass_night),
    ("formwork", "Опалубка: щиты и стяжки", "light", "#d8d0c2", ["site", "concrete", "material"], formwork),
]


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = []
    for index, (id_, title, tone, dominant, kinds, fn) in enumerate(ARTWORKS):
        r = random.Random(f"trustwork-artwork-{id_}")
        text = fn(r)
        path = OUT / f"{id_}.svg"
        path.write_text(text, encoding="utf-8")
        manifest.append({"id": id_, "file": f"{id_}.svg", "title": title, "alt": title, "tone": tone, "dominant": dominant, "kinds": kinds, "bytes": len(text.encode("utf-8")), "seed": f"trustwork-artwork-{id_}"})
        print(f"{id_}: {len(text.encode('utf-8')) // 1024} KB")
    (OUT / "manifest.json").write_text(json.dumps({"viewBox": [W, H], "artworks": manifest}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
