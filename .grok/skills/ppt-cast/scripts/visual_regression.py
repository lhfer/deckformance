#!/usr/bin/env python3
"""Fail-closed fixed-render visual regression and OCR gate.

The gate compares two immutable ``render-index.json`` v2 evidence sets.  It
revalidates every referenced byte, measures a versioned full-frame SSIM, runs
an explicitly selected OCR executable against the current render, and emits a
self-hashed receipt.  ``--approved-change`` only waives the SSIM threshold; it
never waives input integrity, overflow, or OCR equality.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path
from typing import Any

from PIL import Image, UnidentifiedImageError


RECEIPT_SCHEMA_VERSION = "1.0.0"
RECEIPT_TYPE = "deckformance-visual-regression"
PRODUCER = "ppt-cast/visual-regression@1"
SSIM_ALGORITHM = "windowed-luma-ssim-16px-population-v1"
SSIM_THRESHOLD = 0.995
SSIM_WINDOW = 16
TEXT_NORMALIZATION = "unicode-nfkc-remove-whitespace-v1"
SHA256_RE = re.compile(r"^sha256:[a-f0-9]{64}$")
OCR_LANGUAGE_RE = re.compile(r"^[A-Za-z0-9_+.-]+$")


class GateRejected(RuntimeError):
    """A well-formed evaluation completed but failed its quality gate."""


def fail(message: str) -> "None":
    raise RuntimeError(message)


def sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def canonical_value(value: Any) -> Any:
    """Normalize receipt values so re-parsing cannot change the signed bytes."""

    if isinstance(value, list):
        return [canonical_value(item) for item in value]
    if isinstance(value, dict):
        return {key: canonical_value(value[key]) for key in sorted(value)}
    if isinstance(value, float):
        if not math.isfinite(value):
            fail("receipt values must not contain non-finite numbers")
        # Six decimals is materially finer than the 0.995 gate while avoiding
        # cross-runtime exponent spelling differences in the self-hash.
        rounded = round(value, 6)
        if rounded == 0:
            return 0
        if rounded.is_integer():
            return int(rounded)
        return rounded
    return value


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        canonical_value(value),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def receipt_sha256(receipt: dict[str, Any]) -> str:
    unsigned = dict(receipt)
    unsigned.pop("receiptSha256", None)
    return f"sha256:{hashlib.sha256(canonical_json(unsigned)).hexdigest()}"


def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            fail(f"JSON contains duplicate key: {key}")
        result[key] = value
    return result


def read_json(file_path: Path) -> Any:
    try:
        return json.loads(
            file_path.read_text(encoding="utf-8"),
            object_pairs_hook=reject_duplicate_keys,
        )
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"cannot read JSON {file_path.name}: {error}")


def is_inside(parent: Path, child: Path) -> bool:
    try:
        return os.path.commonpath([str(parent), str(child)]) == str(parent)
    except ValueError:
        return False


def safe_job_path(job_dir: Path, relative: str, *, must_exist: bool) -> Path:
    if not isinstance(relative, str) or not relative or os.path.isabs(relative) or "\\" in relative:
        fail(f"path must be a job-relative POSIX path: {relative!r}")
    if any(part in {"", ".", ".."} for part in relative.split("/")):
        fail(f"path contains an unsafe segment: {relative!r}")
    lexical = job_dir.joinpath(*relative.split("/"))
    if must_exist and lexical.is_symlink():
        fail(f"symbolic links are not accepted as evidence inputs: {relative!r}")
    candidate = lexical.resolve(strict=False)
    if not is_inside(job_dir, candidate):
        fail(f"path escapes the job directory: {relative!r}")
    if must_exist:
        if not candidate.exists() or not candidate.is_file() or candidate.is_symlink():
            fail(f"required regular file is missing: {relative}")
        real = candidate.resolve(strict=True)
        if not is_inside(job_dir, real):
            fail(f"path resolves outside the job directory: {relative!r}")
        return real
    return candidate


def descriptor(job_dir: Path, relative: str) -> dict[str, Any]:
    file_path = safe_job_path(job_dir, relative, must_exist=True)
    return {
        "path": relative,
        "sha256": sha256_file(file_path),
        "bytes": file_path.stat().st_size,
    }


def require_sha(value: Any, pointer: str) -> str:
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
        fail(f"{pointer} must be a sha256: digest")
    return value


def require_positive_int(value: Any, pointer: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        fail(f"{pointer} must be a positive integer")
    return value


def load_png(file_path: Path, pointer: str) -> Image.Image:
    try:
        with Image.open(file_path) as probe:
            if probe.format != "PNG":
                fail(f"{pointer} is not a PNG")
            probe.verify()
        with Image.open(file_path) as image:
            image.load()
            return image.convert("L")
    except (UnidentifiedImageError, OSError, ValueError) as error:
        fail(f"{pointer} is not a decodable PNG: {error}")


def validate_tool_descriptor(value: Any, pointer: str) -> None:
    if not isinstance(value, dict):
        fail(f"{pointer} must be an object")
    if not isinstance(value.get("name"), str) or not value["name"].strip():
        fail(f"{pointer}.name is required")
    if not isinstance(value.get("version"), str) or not value["version"].strip():
        fail(f"{pointer}.version is required")
    require_sha(value.get("sha256"), f"{pointer}.sha256")


def validate_render_index(job_dir: Path, index_relative: str, label: str) -> dict[str, Any]:
    index_path = safe_job_path(job_dir, index_relative, must_exist=True)
    data = read_json(index_path)
    if not isinstance(data, dict):
        fail(f"{label} render index must be an object")
    if data.get("version") != 2 or data.get("producer") != "ppt-cast/render-pptx-qa@2":
        fail(f"{label} render index must be ppt-cast/render-pptx-qa@2 version 2")
    require_sha(data.get("producerSha256"), f"{label}.producerSha256")
    validate_tool_descriptor(data.get("renderer"), f"{label}.renderer")
    validate_tool_descriptor(data.get("slidesTest"), f"{label}.slidesTest")
    if not isinstance(data.get("runtime"), dict) or not data["runtime"]:
        fail(f"{label}.runtime must be a non-empty object")
    if data.get("overflowPassed") is not True:
        fail(f"{label} render index did not pass overflow checking")

    artifact_relative = data.get("artifactPath")
    if not isinstance(artifact_relative, str):
        fail(f"{label}.artifactPath is required")
    artifact = descriptor(job_dir, artifact_relative)
    if artifact["sha256"] != require_sha(data.get("artifactSha256"), f"{label}.artifactSha256"):
        fail(f"{label} artifact hash drift: {artifact_relative}")

    slide_count = require_positive_int(data.get("slideCount"), f"{label}.slideCount")
    slides = data.get("renderedSlides")
    if not isinstance(slides, list) or len(slides) != slide_count:
        fail(f"{label}.renderedSlides must contain exactly {slide_count} pages")

    checked_slides: list[dict[str, Any]] = []
    for expected_number, slide in enumerate(slides, start=1):
        pointer = f"{label}.renderedSlides[{expected_number - 1}]"
        if not isinstance(slide, dict):
            fail(f"{pointer} must be an object")
        if slide.get("slideNumber") != expected_number:
            fail(f"{pointer}.slideNumber must be contiguous from 1")
        if slide.get("mime") != "image/png":
            fail(f"{pointer}.mime must be image/png")
        width = require_positive_int(slide.get("width"), f"{pointer}.width")
        height = require_positive_int(slide.get("height"), f"{pointer}.height")
        relative = slide.get("path")
        if not isinstance(relative, str):
            fail(f"{pointer}.path is required")
        image_desc = descriptor(job_dir, relative)
        declared_sha = require_sha(slide.get("sha256"), f"{pointer}.sha256")
        if image_desc["sha256"] != declared_sha:
            fail(f"{label} page {expected_number} image hash drift: {relative}")
        image = load_png(safe_job_path(job_dir, relative, must_exist=True), pointer)
        if image.size != (width, height):
            fail(
                f"{label} page {expected_number} dimension drift: "
                f"index={width}x{height}, actual={image.width}x{image.height}"
            )
        checked_slides.append(
            {
                "slideNumber": expected_number,
                "descriptor": image_desc,
                "width": width,
                "height": height,
                "image": image,
            }
        )

    return {
        "descriptor": descriptor(job_dir, index_relative),
        "artifact": artifact,
        "artifactSha256": data["artifactSha256"],
        "producerSha256": data["producerSha256"],
        "renderer": data["renderer"],
        "slidesTest": data["slidesTest"],
        "runtime": data["runtime"],
        "slides": checked_slides,
    }


def normalize_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value)
    return "".join(character for character in normalized if not character.isspace())


def validate_expected_text(job_dir: Path, relative: str, slide_count: int) -> dict[str, Any]:
    expected_path = safe_job_path(job_dir, relative, must_exist=True)
    data = read_json(expected_path)
    if not isinstance(data, dict) or data.get("schemaVersion") != "1.0.0":
        fail("expected-text JSON must be an object with schemaVersion 1.0.0")
    slides = data.get("slides")
    if not isinstance(slides, list) or len(slides) != slide_count:
        fail(f"expected-text.slides must contain exactly {slide_count} pages")
    expected: list[dict[str, Any]] = []
    for expected_number, item in enumerate(slides, start=1):
        pointer = f"expected-text.slides[{expected_number - 1}]"
        if not isinstance(item, dict) or item.get("slideNumber") != expected_number:
            fail(f"{pointer}.slideNumber must be contiguous from 1")
        text = item.get("expectedText")
        if not isinstance(text, str):
            fail(f"{pointer}.expectedText must be a string")
        expected.append(
            {
                "slideNumber": expected_number,
                "expectedText": text,
                "normalizedExpectedText": normalize_text(text),
            }
        )
    return {"descriptor": descriptor(job_dir, relative), "slides": expected}


def resolve_ocr_executable(command: str) -> Path:
    if not command or "\x00" in command:
        fail("--ocr-command must name one executable without shell syntax")
    found = shutil.which(command) if os.sep not in command else command
    if not found:
        fail(f"OCR executable is missing: {command}")
    try:
        executable = Path(found).expanduser().resolve(strict=True)
    except OSError as error:
        fail(f"OCR executable is missing: {command}: {error}")
    if not executable.is_file() or not os.access(executable, os.X_OK):
        fail(f"OCR command is not an executable file: {command}")
    return executable


def run_process(command: list[str], label: str) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(command, text=True, capture_output=True, check=False)
    except OSError as error:
        fail(f"{label} could not start: {error}")
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        fail(f"{label} failed with exit {result.returncode}{': ' + detail if detail else ''}")
    return result


def ocr_descriptor(executable: Path, language: str, psm: int) -> dict[str, Any]:
    version_run = run_process([str(executable), "--version"], "OCR version probe")
    version_lines = (version_run.stdout or version_run.stderr or "").splitlines()
    version = version_lines[0].strip() if version_lines else ""
    if not version:
        fail("OCR executable returned an empty version")
    return {
        "name": executable.name,
        "version": version,
        "executableSha256": sha256_file(executable),
        "language": language,
        "pageSegmentationMode": psm,
        "invocation": ["<image>", "stdout", "-l", language, "--psm", str(psm)],
    }


def run_ocr(executable: Path, image_path: Path, language: str, psm: int) -> str:
    result = run_process(
        [str(executable), str(image_path), "stdout", "-l", language, "--psm", str(psm)],
        f"OCR for {image_path.name}",
    )
    return result.stdout.rstrip("\r\n")


def windowed_ssim(left: Image.Image, right: Image.Image) -> tuple[float, float, int]:
    """Return area-weighted mean, minimum, and count of 16px luma SSIM windows."""

    if left.mode != "L" or right.mode != "L":
        raise ValueError("SSIM inputs must be luma images")
    if left.size != right.size:
        raise ValueError("SSIM inputs must have equal dimensions")
    width, height = left.size
    left_bytes = left.tobytes()
    right_bytes = right.tobytes()
    c1 = (0.01 * 255.0) ** 2
    c2 = (0.03 * 255.0) ** 2
    weighted_sum = 0.0
    pixel_total = 0
    minimum = 1.0
    window_count = 0

    for top in range(0, height, SSIM_WINDOW):
        bottom = min(top + SSIM_WINDOW, height)
        for left_edge in range(0, width, SSIM_WINDOW):
            right_edge = min(left_edge + SSIM_WINDOW, width)
            count = (bottom - top) * (right_edge - left_edge)
            sum_x = sum_y = sum_x2 = sum_y2 = sum_xy = 0.0
            for y in range(top, bottom):
                offset = y * width
                for x in range(left_edge, right_edge):
                    a = left_bytes[offset + x]
                    b = right_bytes[offset + x]
                    sum_x += a
                    sum_y += b
                    sum_x2 += a * a
                    sum_y2 += b * b
                    sum_xy += a * b
            mean_x = sum_x / count
            mean_y = sum_y / count
            variance_x = max(0.0, sum_x2 / count - mean_x * mean_x)
            variance_y = max(0.0, sum_y2 / count - mean_y * mean_y)
            covariance = sum_xy / count - mean_x * mean_y
            numerator = (2.0 * mean_x * mean_y + c1) * (2.0 * covariance + c2)
            denominator = (mean_x * mean_x + mean_y * mean_y + c1) * (
                variance_x + variance_y + c2
            )
            score = numerator / denominator if denominator else 1.0
            score = max(-1.0, min(1.0, score))
            weighted_sum += score * count
            pixel_total += count
            minimum = min(minimum, score)
            window_count += 1
    return weighted_sum / pixel_total, minimum, window_count


def write_receipt_atomic(output_path: Path, receipt: dict[str, Any]) -> None:
    if output_path.exists():
        fail(f"refusing to overwrite visual regression receipt: {output_path.name}")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temp_dir = Path(tempfile.mkdtemp(prefix=f".{output_path.name}.", dir=output_path.parent))
    temp_path = temp_dir / output_path.name
    try:
        temp_path.write_text(
            json.dumps(receipt, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
            encoding="utf-8",
        )
        os.replace(temp_path, output_path)
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Compare immutable render-index v2 evidence with SSIM and exact normalized OCR."
    )
    parser.add_argument("job_dir")
    parser.add_argument("--baseline-index", required=True, help="job-relative baseline render-index.json")
    parser.add_argument("--current-index", required=True, help="job-relative current render-index.json")
    parser.add_argument("--expected-text", required=True, help="job-relative expected-text JSON")
    parser.add_argument("--ocr-command", required=True, help="explicit tesseract-compatible executable")
    parser.add_argument("--ocr-language", required=True, help="explicit OCR language, for example eng or chi_sim+eng")
    parser.add_argument("--ocr-psm", type=int, default=6, help="tesseract page segmentation mode (default: 6)")
    parser.add_argument("--output", required=True, help="new job-relative visual regression receipt")
    parser.add_argument(
        "--approved-change",
        action="store_true",
        help="waive only the SSIM threshold; OCR, overflow, and byte bindings remain mandatory",
    )
    args = parser.parse_args()

    job_dir = Path(args.job_dir).expanduser().resolve(strict=True)
    if not job_dir.is_dir():
        fail(f"job directory not found: {job_dir}")
    output_path = safe_job_path(job_dir, args.output, must_exist=False)
    if output_path.exists():
        fail(f"refusing to overwrite visual regression receipt: {args.output}")
    if not OCR_LANGUAGE_RE.fullmatch(args.ocr_language):
        fail("--ocr-language contains unsupported characters")
    if args.ocr_psm < 0 or args.ocr_psm > 13:
        fail("--ocr-psm must be between 0 and 13")

    baseline = validate_render_index(job_dir, args.baseline_index, "baseline")
    current = validate_render_index(job_dir, args.current_index, "current")
    if len(baseline["slides"]) != len(current["slides"]):
        fail("baseline and current render indexes have different slide counts")
    expected = validate_expected_text(job_dir, args.expected_text, len(current["slides"]))
    ocr_executable = resolve_ocr_executable(args.ocr_command)
    ocr = ocr_descriptor(ocr_executable, args.ocr_language, args.ocr_psm)

    issues: list[dict[str, Any]] = []
    page_receipts: list[dict[str, Any]] = []
    for baseline_slide, current_slide, expected_slide in zip(
        baseline["slides"], current["slides"], expected["slides"], strict=True
    ):
        number = current_slide["slideNumber"]
        dimensions_match = (baseline_slide["width"], baseline_slide["height"]) == (
            current_slide["width"], current_slide["height"]
        )
        if dimensions_match:
            ssim_mean, ssim_minimum, ssim_windows = windowed_ssim(
                baseline_slide["image"], current_slide["image"]
            )
            ssim_above_threshold = ssim_mean >= SSIM_THRESHOLD
        else:
            ssim_mean = None
            ssim_minimum = None
            ssim_windows = 0
            ssim_above_threshold = False
        if not dimensions_match:
            issues.append(
                {
                    "code": "DIMENSION_MISMATCH",
                    "slideNumber": number,
                    "message": "baseline and current page dimensions differ",
                }
            )
        if not ssim_above_threshold and not args.approved_change:
            issues.append(
                {
                    "code": "SSIM_BELOW_THRESHOLD",
                    "slideNumber": number,
                    "message": f"SSIM is below the required {SSIM_THRESHOLD:.3f}",
                }
            )

        recognized = run_ocr(
            ocr_executable,
            safe_job_path(job_dir, current_slide["descriptor"]["path"], must_exist=True),
            args.ocr_language,
            args.ocr_psm,
        )
        normalized_recognized = normalize_text(recognized)
        ocr_match = normalized_recognized == expected_slide["normalizedExpectedText"]
        if not ocr_match:
            issues.append(
                {
                    "code": "OCR_MISMATCH",
                    "slideNumber": number,
                    "message": "normalized OCR output does not exactly match expected text",
                }
            )

        page_receipts.append(
            {
                "slideNumber": number,
                "baseline": {
                    **baseline_slide["descriptor"],
                    "width": baseline_slide["width"],
                    "height": baseline_slide["height"],
                },
                "current": {
                    **current_slide["descriptor"],
                    "width": current_slide["width"],
                    "height": current_slide["height"],
                },
                "dimensionsMatch": dimensions_match,
                "ssim": {
                    "mean": ssim_mean,
                    "minimumWindow": ssim_minimum,
                    "windowCount": ssim_windows,
                    "aboveThreshold": ssim_above_threshold,
                    "gateWaived": args.approved_change,
                },
                "ocr": {
                    "expectedText": expected_slide["expectedText"],
                    "recognizedText": recognized,
                    "normalizedExpectedText": expected_slide["normalizedExpectedText"],
                    "normalizedRecognizedText": normalized_recognized,
                    "matches": ocr_match,
                },
            }
        )

    passed = len(issues) == 0
    now = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    receipt: dict[str, Any] = {
        "schemaVersion": RECEIPT_SCHEMA_VERSION,
        "receiptType": RECEIPT_TYPE,
        "createdAt": now,
        "producer": {
            "id": PRODUCER,
            "implementationSha256": sha256_file(Path(__file__).resolve(strict=True)),
        },
        "policy": {
            "approvedChange": args.approved_change,
            "ssim": {
                "algorithm": SSIM_ALGORITHM,
                "threshold": SSIM_THRESHOLD,
                "windowPixels": SSIM_WINDOW,
            },
            "textNormalization": TEXT_NORMALIZATION,
        },
        "ocrEngine": ocr,
        "inputs": {
            "baselineIndex": baseline["descriptor"],
            "currentIndex": current["descriptor"],
            "expectedText": expected["descriptor"],
            "baselineArtifact": baseline["artifact"],
            "currentArtifact": current["artifact"],
        },
        "renderImplementations": {
            "baseline": {
                "producerSha256": baseline["producerSha256"],
                "renderer": baseline["renderer"],
                "slidesTest": baseline["slidesTest"],
                "runtime": baseline["runtime"],
            },
            "current": {
                "producerSha256": current["producerSha256"],
                "renderer": current["renderer"],
                "slidesTest": current["slidesTest"],
                "runtime": current["runtime"],
            },
        },
        "slides": page_receipts,
        "issues": issues,
        "summary": {
            "slideCount": len(page_receipts),
            "ssimFailureCount": sum(
                1 for page in page_receipts if not page["ssim"]["aboveThreshold"]
            ),
            "ocrFailureCount": sum(1 for page in page_receipts if not page["ocr"]["matches"]),
            "blockingIssueCount": len(issues),
        },
        "passed": passed,
    }
    receipt = canonical_value(receipt)
    receipt["receiptSha256"] = receipt_sha256(receipt)
    write_receipt_atomic(output_path, receipt)
    print(args.output)
    if not passed:
        raise GateRejected(
            f"visual regression gate rejected {len(issues)} issue(s); receipt: {args.output}"
        )


if __name__ == "__main__":
    try:
        main()
    except GateRejected as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2) from error
    except Exception as error:  # noqa: BLE001 - CLI fail-closed boundary
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error
