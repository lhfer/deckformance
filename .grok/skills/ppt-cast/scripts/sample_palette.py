#!/usr/bin/env python3
"""Quantize a bible still into a few hex swatches (skip near-white/near-black)."""

from __future__ import annotations

import argparse
import sys
from collections import Counter
from pathlib import Path

from PIL import Image


def hex_of(rgb: tuple[int, int, int]) -> str:
    return f"{rgb[0]:02X}{rgb[1]:02X}{rgb[2]:02X}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image")
    parser.add_argument("--n", type=int, default=6)
    args = parser.parse_args()
    if args.n < 1:
        parser.error("--n must be at least 1")

    im = Image.open(args.image).convert("RGB").resize((48, 48), Image.Resampling.BOX)
    counts: Counter[tuple[int, int, int]] = Counter()
    for r, g, b in im.getdata():
        if r > 245 and g > 245 and b > 245:
            continue
        if r < 18 and g < 18 and b < 18:
            continue
        if max(r, g, b) - min(r, g, b) < 48:
            continue
        qr, qg, qb = (r // 16) * 16, (g // 16) * 16, (b // 16) * 16
        counts[(qr, qg, qb)] += 1

    if not counts:
        print(
            "no usable chromatic swatches found; use the brand palette or choose a clearer character reference",
            file=sys.stderr,
        )
        return 1

    print(Path(args.image).name)
    for rgb, n in counts.most_common(args.n):
        print(f"{hex_of(rgb)}  n={n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
