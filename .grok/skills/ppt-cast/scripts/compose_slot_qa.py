#!/usr/bin/env python3
"""Render one selected poster inside its planned final slide/video slot.

The output is a true 1920x1080 PNG suitable for asset-manifest.qa.slotComposite.
It is created before asset-manifest.json, directly from content-plan.json and
visual-plan.json, so slot-crop QA does not depend on a hand-written deck.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image


def fail(message: str) -> "None":
    raise RuntimeError(message)


def safe_job_path(job_dir: Path, relative: str, *, must_exist: bool) -> Path:
    if not relative or os.path.isabs(relative) or "\\" in relative:
        fail(f"path must be a job-relative POSIX path: {relative!r}")
    parts = relative.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        fail(f"path contains an unsafe segment: {relative!r}")
    lexical = job_dir.joinpath(*parts)
    if must_exist and lexical.is_symlink():
        fail(f"symbolic links are not accepted: {relative!r}")
    resolved = lexical.resolve(strict=False)
    if os.path.commonpath([str(job_dir), str(resolved)]) != str(job_dir):
        fail(f"path escapes the job directory: {relative!r}")
    if must_exist and (not resolved.exists() or not resolved.is_file()):
        fail(f"required file is missing: {relative}")
    return resolved


def load_json(file_path: Path) -> dict:
    value = json.loads(file_path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        fail(f"JSON root must be an object: {file_path}")
    return value


def parse_aspect(value: str) -> tuple[int, int]:
    try:
        left, right = value.split(":", 1)
        width, height = int(left), int(right)
    except (AttributeError, TypeError, ValueError) as error:
        raise RuntimeError(f"invalid slot aspect: {value!r}") from error
    if width <= 0 or height <= 0:
        fail(f"invalid slot aspect: {value!r}")
    return width, height


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("job_dir")
    parser.add_argument("slide_id")
    parser.add_argument("poster", help="selected true-PNG poster path relative to job_dir")
    parser.add_argument("output", help="new slot-composite PNG path relative to job_dir")
    args = parser.parse_args()

    job_dir = Path(args.job_dir).expanduser().resolve(strict=True)
    content = load_json(safe_job_path(job_dir, "content-plan.json", must_exist=True))
    visual = load_json(safe_job_path(job_dir, "visual-plan.json", must_exist=True))
    poster = safe_job_path(job_dir, args.poster, must_exist=True)
    output = safe_job_path(job_dir, args.output, must_exist=False)
    if output.suffix.lower() != ".png":
        fail("slot composite output must end in .png")
    if output.exists():
        fail(f"refusing to overwrite slot-composite evidence: {args.output}")

    content_slide = next((slide for slide in content.get("slides", []) if slide.get("id") == args.slide_id), None)
    visual_slide = next((slide for slide in visual.get("slides", []) if slide.get("id") == args.slide_id), None)
    if not content_slide or content_slide.get("videoRequired") is not True:
        fail(f"slide {args.slide_id!r} is not a dynamic content slide")
    if not visual_slide:
        fail(f"visual-plan.json has no shot/layout record for {args.slide_id!r}")

    expected_w, expected_h = parse_aspect(visual_slide.get("slot", {}).get("aspect"))
    with Image.open(poster) as source:
        if source.format != "PNG":
            fail("selected poster must contain true PNG bytes")
        if source.width * expected_h != source.height * expected_w:
            fail(
                f"poster aspect {source.width}x{source.height} does not match final slot {expected_w}:{expected_h}; "
                "refusing an implicit crop"
            )

    typography = visual.get("brandDirection", {}).get("typography", {})
    deck = {
        "palette": visual.get("brandDirection", {}).get("deckPalette", {}),
        "fonts": {
            "title": typography.get("title", "Arial"),
            "body": typography.get("body", "Arial"),
            "number": typography.get("number", "Arial"),
        },
        "fontFace": typography.get("body", "Arial"),
        "slides": [
            {
                "id": args.slide_id,
                "layoutId": visual_slide.get("layoutId"),
                "kicker": content_slide.get("role", ""),
                "number": args.slide_id,
                "title": content_slide.get("title", ""),
                "body": content_slide.get("body", []),
                "poster": str(poster),
            }
        ],
    }

    output.parent.mkdir(parents=True, exist_ok=True)
    preview_script = Path(__file__).resolve().parent / "preview_deck.py"
    with tempfile.TemporaryDirectory(prefix="ppt-cast-slot-") as temp_name:
        temp_dir = Path(temp_name)
        deck_path = temp_dir / "deck.json"
        preview_dir = temp_dir / "preview"
        deck_path.write_text(json.dumps(deck, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(preview_script), str(deck_path), str(preview_dir)],
            text=True,
            capture_output=True,
            check=False,
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "").strip()
            fail(f"slot-composite layout QA failed{': ' + detail if detail else ''}")
        preview = preview_dir / "slide-01.jpg"
        if not preview.exists():
            fail("preview renderer did not produce the expected slide image")
        temp_output = output.with_name(f".{output.name}.{os.getpid()}.tmp")
        try:
            with Image.open(preview) as image:
                image.convert("RGB").save(temp_output, format="PNG")
            os.replace(temp_output, output)
        finally:
            temp_output.unlink(missing_ok=True)
    print(output)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 - fail-closed CLI boundary
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error
