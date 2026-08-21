#!/usr/bin/env python3
"""Extract the five bound QA frames: start / 20% / 50% / 80% / end."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


def ffprobe_duration(src: Path) -> float:
    out = subprocess.check_output(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(src),
        ],
        text=True,
    ).strip()
    return float(out)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video")
    parser.add_argument("outdir")
    args = parser.parse_args()

    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        print("ffmpeg/ffprobe required", file=sys.stderr)
        return 1

    src = Path(args.video).resolve()
    if not src.exists():
        print(f"missing video: {src}", file=sys.stderr)
        return 1

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    duration = ffprobe_duration(src)
    if duration <= 0:
        print("duration is 0", file=sys.stderr)
        return 1

    samples = (("00", 0.0), ("20", 0.2), ("50", 0.5), ("80", 0.8), ("100", 1.0))
    targets = [outdir / f"frame_{label}.png" for label, _ in samples]
    existing = [target for target in targets if target.exists()]
    if existing:
        print(
            "refusing to mix new QA evidence with existing frames: "
            + ", ".join(str(item) for item in existing),
            file=sys.stderr,
        )
        return 1

    created: list[Path] = []
    try:
        for (label, frac), dest in zip(samples, targets, strict=True):
            t = 0.0 if frac == 0 else max(0.0, min(max(0.0, duration - 0.05), duration * frac))
            temp = dest.with_name(f".{dest.name}.{os.getpid()}.tmp.png")
            result = subprocess.run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-y",
                    "-ss",
                    f"{t:.3f}",
                    "-i",
                    str(src),
                    "-frames:v",
                    "1",
                    str(temp),
                ],
                capture_output=True,
                text=True,
                timeout=60,
            )
            if result.returncode != 0:
                detail = (result.stderr or result.stdout or "unknown ffmpeg error").strip()
                raise RuntimeError(f"failed to extract {label}% frame: {detail}")
            temp.replace(dest)
            created.append(dest)
            print(dest)
    except Exception as exc:
        for item in created:
            item.unlink(missing_ok=True)
        for item in outdir.glob(f".*.{os.getpid()}.tmp.png"):
            item.unlink(missing_ok=True)
        print(str(exc), file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
