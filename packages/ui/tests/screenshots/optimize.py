#!/usr/bin/env python3
"""
Shrinks review screenshots for the repository: converts each PNG in a directory to an 8-bit palette image and
scales it down step by step until it is at or below the size budget (default 300 KB). Used for
docs/design/system/showcase/*.png so the owner can review the design system without running Storybook.

Usage: python3 packages/ui/tests/screenshots/optimize.py <dir> [--budget 300000] [--max-width 1280]
"""
from __future__ import annotations

import argparse
import io
import sys
from pathlib import Path

from PIL import Image


def shrink(path: Path, budget: int, max_width: int) -> int:
    image = Image.open(path).convert("RGB")
    if image.width > max_width:
        image = image.resize((max_width, round(image.height * max_width / image.width)), Image.Resampling.LANCZOS)
    scale = 1.0
    while True:
        candidate = image if scale == 1.0 else image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS)
        quantized = candidate.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG)
        buffer = io.BytesIO()
        quantized.save(buffer, format="PNG", optimize=True)
        if buffer.tell() <= budget or scale < 0.3:
            path.write_bytes(buffer.getvalue())
            return buffer.tell()
        scale *= 0.85


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("directory")
    parser.add_argument("--budget", type=int, default=300_000)
    parser.add_argument("--max-width", type=int, default=1280)
    args = parser.parse_args()
    for path in sorted(Path(args.directory).glob("*.png")):
        size = shrink(path, args.budget, args.max_width)
        print(f"{path.name}: {size // 1024} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
