#!/usr/bin/env python3
"""Render the actual PPTX into immutable, job-local QA evidence.

This command does not claim visual acceptance.  It renders every slide, runs
the target presentation skill's overflow checker, and writes a hash-bound
render-index.json.  A visual reviewer must inspect those exact PNGs and copy
the index fields into render-qa.json together with the required visual gates.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

import PIL
from PIL import Image, UnidentifiedImageError


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
SLIDE_RE = re.compile(r"^ppt/slides/slide([1-9][0-9]*)\.xml$")
RENDER_RE = re.compile(r"^slide-([1-9][0-9]*)\.png$")


def fail(message: str) -> "None":
    raise RuntimeError(message)


def sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def safe_job_path(job_dir: Path, relative: str, *, must_exist: bool) -> Path:
    if not relative or os.path.isabs(relative) or "\\" in relative:
        fail(f"path must be a job-relative POSIX path: {relative!r}")
    parts = relative.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        fail(f"path contains an unsafe segment: {relative!r}")
    lexical = job_dir / Path(*parts)
    if must_exist and lexical.is_symlink():
        fail(f"symbolic links are not accepted as evidence inputs: {relative!r}")
    candidate = lexical.resolve(strict=False)
    if os.path.commonpath([str(job_dir), str(candidate)]) != str(job_dir):
        fail(f"path escapes the job directory: {relative!r}")
    if must_exist:
        if not candidate.exists() or not candidate.is_file() or candidate.is_symlink():
            fail(f"required regular file is missing: {relative}")
        real = candidate.resolve(strict=True)
        if os.path.commonpath([str(job_dir), str(real)]) != str(job_dir):
            fail(f"path resolves outside the job directory: {relative!r}")
        return real
    return candidate


def pptx_slide_count(pptx_path: Path) -> int:
    with pptx_path.open("rb") as handle:
        signature = handle.read(4)
    if signature != b"PK\x03\x04":
        fail(f"not an OOXML ZIP package: {pptx_path}")
    with zipfile.ZipFile(pptx_path) as package:
        numbers = sorted(
            int(match.group(1))
            for name in package.namelist()
            if (match := SLIDE_RE.match(name))
        )
    if not numbers or numbers != list(range(1, len(numbers) + 1)):
        fail("PPTX slide parts are missing or non-contiguous")
    return len(numbers)


def png_dimensions(file_path: Path) -> tuple[int, int]:
    with file_path.open("rb") as handle:
        header = handle.read(24)
    if len(header) < 24 or header[:8] != PNG_SIGNATURE or header[12:16] != b"IHDR":
        fail(f"renderer did not produce a true PNG: {file_path}")
    header_width, header_height = struct.unpack(">II", header[16:24])
    try:
        with Image.open(file_path) as image:
            if image.format != "PNG":
                fail(f"renderer output is not a PNG image: {file_path}")
            image.verify()
        with Image.open(file_path) as image:
            image.load()
            width, height = image.size
    except (UnidentifiedImageError, OSError, ValueError) as error:
        fail(f"renderer produced an undecodable PNG {file_path}: {error}")
    if width <= 0 or height <= 0 or (width, height) != (header_width, header_height):
        fail(f"invalid rendered PNG dimensions: {file_path}")
    return width, height


def executable_receipt(file_path: Path, version: str) -> dict[str, str]:
    return {
        "name": file_path.name,
        "version": version,
        "sha256": sha256_file(file_path),
    }


def runtime_receipt(args: argparse.Namespace) -> dict[str, object]:
    python_path = Path(args.python).expanduser().resolve(strict=True)
    receipt: dict[str, object] = {
        "python": {
            "implementation": sys.implementation.name,
            "version": ".".join(str(part) for part in sys.version_info[:3]),
            "executable": python_path.name,
            "sha256": sha256_file(python_path),
            "pillowVersion": PIL.__version__,
        }
    }
    if args.runtime_node:
        node = Path(args.runtime_node).expanduser().resolve(strict=True)
        node_receipt = executable_receipt(node, "runtime")
        version = subprocess.run(
            [str(node), "--version"], text=True, capture_output=True, check=False
        )
        node_receipt["version"] = (version.stdout or version.stderr or "").strip()
        receipt["node"] = node_receipt
    if args.runtime_bin_dir:
        receipt["binDir"] = Path(args.runtime_bin_dir).expanduser().resolve(strict=True).name
    if args.runtime_node_modules:
        receipt["nodeModules"] = Path(args.runtime_node_modules).expanduser().resolve(strict=True).name
    return receipt


def run_checked(
    command: list[str], label: str, env: dict[str, str]
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, text=True, capture_output=True, check=False, env=env)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        fail(f"{label} failed with exit {result.returncode}{': ' + detail if detail else ''}")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Render a real PPTX and bind every page PNG for later visual QA."
    )
    parser.add_argument("job_dir")
    parser.add_argument("pptx", help="PPTX path relative to job_dir")
    parser.add_argument("output_dir", help="new evidence directory relative to job_dir")
    parser.add_argument("--renderer", required=True, help="target pptx skill render_slides.py")
    parser.add_argument("--renderer-version", required=True, help="declared renderer implementation or bundle version")
    parser.add_argument("--slides-test", required=True, help="target pptx skill slides_test.py")
    parser.add_argument("--slides-test-version", required=True, help="declared slides-test implementation or bundle version")
    parser.add_argument("--python", default=sys.executable, help="Python runtime for the target tools")
    parser.add_argument("--runtime-node", help="bundled RUNTIME_NODE returned by workspace dependencies")
    parser.add_argument("--runtime-bin-dir", help="bundled RUNTIME_BIN_DIR returned by workspace dependencies")
    parser.add_argument("--runtime-node-modules", help="bundled RUNTIME_NODE_MODULES returned by workspace dependencies")
    args = parser.parse_args()

    job_dir = Path(args.job_dir).expanduser().resolve(strict=True)
    if not job_dir.is_dir():
        fail(f"job directory not found: {job_dir}")
    pptx_path = safe_job_path(job_dir, args.pptx, must_exist=True)
    output_dir = safe_job_path(job_dir, args.output_dir, must_exist=False)
    if output_dir.exists():
        fail(f"refusing to mix or overwrite render evidence: {args.output_dir}")
    renderer = Path(args.renderer).expanduser().resolve(strict=True)
    slides_test = Path(args.slides_test).expanduser().resolve(strict=True)
    if not renderer.is_file() or not slides_test.is_file():
        fail("renderer and slides-test must be files")

    expected_count = pptx_slide_count(pptx_path)
    tool_env = dict(os.environ)
    for option_name, env_name in (
        ("runtime_node", "RUNTIME_NODE"),
        ("runtime_bin_dir", "RUNTIME_BIN_DIR"),
        ("runtime_node_modules", "RUNTIME_NODE_MODULES"),
    ):
        value = getattr(args, option_name)
        if value:
            tool_env[env_name] = str(Path(value).expanduser().resolve(strict=True))
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    temp_dir = Path(tempfile.mkdtemp(prefix=f".{output_dir.name}.render-", dir=output_dir.parent))
    try:
        run_checked(
            [args.python, str(renderer), str(pptx_path), "--output_dir", str(temp_dir), "--width", "1920", "--height", "1080"],
            "PPTX renderer",
            tool_env,
        )
        overflow = run_checked([args.python, str(slides_test), str(pptx_path)], "overflow checker", tool_env)
        overflow_text = "\n".join([overflow.stdout or "", overflow.stderr or ""])
        if "ERROR:" in overflow_text or "overflowing original canvas" in overflow_text.lower():
            fail(f"overflow checker reported failure: {overflow_text.strip()}")

        numbered: list[tuple[int, Path]] = []
        for child in temp_dir.iterdir():
            match = RENDER_RE.match(child.name)
            if match and child.is_file() and not child.is_symlink():
                numbered.append((int(match.group(1)), child))
        numbered.sort(key=lambda item: item[0])
        if [number for number, _ in numbered] != list(range(1, expected_count + 1)):
            fail(f"renderer produced {len(numbered)} numbered PNGs for {expected_count} slides")

        slides = []
        for number, image_path in numbered:
            width, height = png_dimensions(image_path)
            if width < 1920 or height < 1080:
                fail(
                    f"renderer output is below the release evidence floor: "
                    f"slide {number} is {width}x{height}, expected at least 1920x1080"
                )
            final_image = output_dir / image_path.name
            relative = final_image.relative_to(job_dir).as_posix()
            slides.append(
                {
                    "slideNumber": number,
                    "path": relative,
                    "sha256": sha256_file(image_path),
                    "width": width,
                    "height": height,
                    "mime": "image/png",
                }
            )

        index = {
            "version": 2,
            "producer": "ppt-cast/render-pptx-qa@2",
            "producerSha256": sha256_file(Path(__file__).resolve(strict=True)),
            "artifactPath": args.pptx,
            "artifactSha256": sha256_file(pptx_path),
            "slideCount": expected_count,
            "overflowPassed": True,
            "renderedSlides": slides,
            "renderer": executable_receipt(renderer, args.renderer_version),
            "slidesTest": executable_receipt(slides_test, args.slides_test_version),
            "runtime": runtime_receipt(args),
        }
        index_path = temp_dir / "render-index.json"
        index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temp_dir, output_dir)
        print(output_dir / "render-index.json")
    except Exception:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 - CLI fail-closed boundary
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error
