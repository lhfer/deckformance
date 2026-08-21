#!/usr/bin/env python3
"""Create a hash-bound receipt for an already completed real macOS PowerPoint playback run.

This producer does not synthesize playback evidence.  It accepts an exact
candidate, a real screen capture, and a structured event/assertion log; then it
binds those bytes to the installed, code-signed Microsoft PowerPoint bundle.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import plistlib
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path


PRODUCER_ID = "deckformance/powerpoint-verify-macos"
PRODUCER_VERSION = "2.0.0"
PLAYBACK_KEYS = (
    "autoPlayOnce",
    "noLoop",
    "manualAdvance",
    "forwardNavigationPassed",
    "backNavigationPassed",
    "reentryAutoplayOnce",
)
EVENT_SEQUENCE = (
    "enter",
    "autoplay-start",
    "autoplay-end",
    "forward",
    "back",
    "reenter",
    "reentry-autoplay-start",
)


def fail(message: str) -> "None":
    raise RuntimeError(message)


def sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def safe_job_file(job_dir: Path, relative: str, *, must_exist: bool = True) -> Path:
    if not relative or os.path.isabs(relative) or "\\" in relative:
        fail(f"path must be job-relative POSIX: {relative!r}")
    if any(part in {"", ".", ".."} for part in relative.split("/")):
        fail(f"unsafe job path: {relative!r}")
    candidate = (job_dir / Path(*relative.split("/"))).resolve(strict=False)
    if os.path.commonpath([str(job_dir), str(candidate)]) != str(job_dir):
        fail(f"path escapes job: {relative!r}")
    if must_exist and (not candidate.is_file() or candidate.is_symlink()):
        fail(f"missing regular evidence file: {relative}")
    return candidate


def run(command: list[str], label: str) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, text=True, capture_output=True, check=False)
    if result.returncode != 0:
        fail(f"{label} failed: {(result.stderr or result.stdout or '').strip()}")
    return result


def codesign_metadata(app: Path) -> dict[str, object]:
    run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)], "PowerPoint code-signature verification")
    result = run(["/usr/bin/codesign", "-dvvv", "--verbose=4", str(app)], "PowerPoint code-signature inspection")
    text = "\n".join([result.stdout, result.stderr])

    def one(key: str) -> str:
        match = re.search(rf"^{re.escape(key)}=(.+)$", text, re.MULTILINE)
        if not match or not match.group(1).strip():
            fail(f"PowerPoint code signature omitted {key}")
        return match.group(1).strip()

    authorities = [item.strip() for item in re.findall(r"^Authority=(.+)$", text, re.MULTILINE) if item.strip()]
    if not authorities:
        fail("PowerPoint code signature omitted signing authorities")
    return {
        "valid": True,
        "identifier": one("Identifier"),
        "teamIdentifier": one("TeamIdentifier"),
        "cdHash": one("CDHash"),
        "authorities": authorities,
    }


def powerpoint_metadata(app: Path) -> dict[str, object]:
    info_path = app / "Contents" / "Info.plist"
    if not info_path.is_file():
        fail(f"PowerPoint Info.plist missing: {info_path}")
    with info_path.open("rb") as handle:
        info = plistlib.load(handle)
    if info.get("CFBundleIdentifier") != "com.microsoft.Powerpoint":
        fail("the selected app is not Microsoft PowerPoint")
    executable = app / "Contents" / "MacOS" / str(info.get("CFBundleExecutable", ""))
    if not executable.is_file():
        fail("PowerPoint executable is missing")
    return {
        "bundleIdentifier": info["CFBundleIdentifier"],
        "shortVersion": str(info.get("CFBundleShortVersionString", "")),
        "bundleVersion": str(info.get("CFBundleVersion", "")),
        "executableSha256": sha256_file(executable),
        "codeSignature": codesign_metadata(app),
    }


def parse_rate(value: str) -> float:
    if "/" in value:
        numerator, denominator = value.split("/", 1)
        return float(numerator) / float(denominator)
    return float(value)


def validate_capture(capture: Path, dynamic_slide_count: int) -> None:
    result = run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,width,height,avg_frame_rate,r_frame_rate:format=duration",
            "-of",
            "json",
            str(capture),
        ],
        "PowerPoint capture probe",
    )
    value = json.loads(result.stdout)
    stream = next((item for item in value.get("streams", []) if item.get("codec_type") == "video"), None)
    if not stream:
        fail("PowerPoint capture has no video stream")
    rates = []
    for key in ("avg_frame_rate", "r_frame_rate"):
        try:
            rates.append(parse_rate(str(stream.get(key, "0"))))
        except (ValueError, ZeroDivisionError):
            pass
    duration = float(value.get("format", {}).get("duration", 0))
    minimum_duration = max(5.0, dynamic_slide_count * 4.0)
    if (
        int(stream.get("width", 0)) < 1920
        or int(stream.get("height", 0)) < 1080
        or not rates
        or max(rates) < 29
        or duration < minimum_duration
    ):
        fail(
            "PowerPoint capture must be at least 1920x1080, 29fps, and "
            f"{minimum_duration:g}s for {dynamic_slide_count} dynamic slide(s)"
        )


def parse_timestamp(value: object) -> datetime:
    if not isinstance(value, str) or not value:
        fail("playback event timestamps must be ISO-8601 strings")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise RuntimeError(f"invalid playback event timestamp: {value!r}") from error
    if parsed.utcoffset() is None:
        fail(f"playback event timestamp must include a timezone: {value!r}")
    return parsed


def validate_event_log(log: dict[str, object], tested_slide_ids: list[str], asserted_delay: float) -> None:
    events = log.get("events")
    if not isinstance(events, list) or not events:
        fail("structured playback log requires event evidence")
    allowed = set(tested_slide_ids)
    normalized = []
    for index, event in enumerate(events):
        if (
            not isinstance(event, dict)
            or event.get("slideId") not in allowed
            or not isinstance(event.get("event"), str)
            or not event["event"]
        ):
            fail(f"invalid playback event at index {index}")
        normalized.append({**event, "index": index, "timestamp": parse_timestamp(event.get("at"))})
    latest = max(item["timestamp"] for item in normalized)
    if parse_timestamp(log.get("completedAt")) < latest:
        fail("playback log completedAt precedes an event")
    max_delay = 0.0
    for slide_id in tested_slide_ids:
        slide_events = [item for item in normalized if item["slideId"] == slide_id]
        sequence = []
        for event_type in EVENT_SEQUENCE:
            matches = [item for item in slide_events if item["event"] == event_type]
            if len(matches) != 1:
                fail(f"slide {slide_id} requires exactly one {event_type} event")
            sequence.append(matches[0])
        for previous, current in zip(sequence, sequence[1:]):
            if current["index"] <= previous["index"] or current["timestamp"] <= previous["timestamp"]:
                fail(f"slide {slide_id} events must follow {' -> '.join(EVENT_SEQUENCE)}")
        initial_delay = (sequence[1]["timestamp"] - sequence[0]["timestamp"]).total_seconds()
        reentry_delay = (sequence[6]["timestamp"] - sequence[5]["timestamp"]).total_seconds()
        if not 0 <= initial_delay <= 1 or not 0 <= reentry_delay <= 1:
            fail(f"slide {slide_id} autoplay must start within one second on entry and reentry")
        max_delay = max(max_delay, initial_delay, reentry_delay)
    if asserted_delay + 1e-9 < max_delay:
        fail("autoPlayWithinSeconds is lower than the delay derived from the event log")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("job_dir")
    parser.add_argument("job_id")
    parser.add_argument("capture", help="job-relative real playback capture MP4")
    parser.add_argument("test_log", help="job-relative structured playback log JSON")
    parser.add_argument("output", help="new job-relative verification receipt JSON")
    parser.add_argument("--artifact", default="candidate.pptx")
    parser.add_argument("--powerpoint-app", default="/Applications/Microsoft PowerPoint.app")
    args = parser.parse_args()

    if sys.platform != "darwin":
        fail("real PowerPoint verification receipts can only be produced on macOS")
    job_dir = Path(args.job_dir).expanduser().resolve(strict=True)
    artifact = safe_job_file(job_dir, args.artifact)
    capture = safe_job_file(job_dir, args.capture)
    test_log_path = safe_job_file(job_dir, args.test_log)
    output = safe_job_file(job_dir, args.output, must_exist=False)
    if output.exists():
        fail(f"refusing to overwrite receipt: {args.output}")
    if capture.suffix.lower() != ".mp4" or test_log_path.suffix.lower() != ".json":
        fail("capture must be .mp4 and the structured test log must be .json")

    power_point = powerpoint_metadata(Path(args.powerpoint_app).expanduser().resolve(strict=True))
    power_point_version = f"{power_point['shortVersion']} ({power_point['bundleVersion']})"
    log = json.loads(test_log_path.read_text(encoding="utf-8"))
    artifact_hash = sha256_file(artifact)
    if (
        not isinstance(log, dict)
        or log.get("schemaVersion") != "2.0.0"
        or log.get("logType") != "deckformance-powerpoint-playback-log"
        or log.get("jobId") != args.job_id
        or log.get("artifactSha256") != artifact_hash
        or log.get("powerPointVersion") != power_point_version
        or not isinstance(log.get("events"), list)
        or not log["events"]
    ):
        fail("structured playback log does not bind this job, candidate, PowerPoint version, and event sequence")
    assertions = log.get("assertions")
    if not isinstance(assertions, dict) or any(assertions.get(key) is not True for key in PLAYBACK_KEYS):
        fail("structured playback assertions are incomplete or failed")
    auto_play_seconds = assertions.get("autoPlayWithinSeconds")
    if not isinstance(auto_play_seconds, (int, float)) or not 0 <= auto_play_seconds <= 1:
        fail("autoPlayWithinSeconds must be within 0..1")
    tested_slide_ids = log.get("testedSlideIds")
    if not isinstance(tested_slide_ids, list) or not tested_slide_ids or len(set(tested_slide_ids)) != len(tested_slide_ids):
        fail("structured playback log must list unique tested slide IDs")
    validate_event_log(log, tested_slide_ids, float(auto_play_seconds))
    validate_capture(capture, len(tested_slide_ids))

    os_version = platform.mac_ver()[0]
    receipt = {
        "schemaVersion": "2.0.0",
        "receiptType": "deckformance-powerpoint-playback",
        "producer": {
            "id": PRODUCER_ID,
            "version": PRODUCER_VERSION,
            "implementationSha256": sha256_file(Path(__file__).resolve(strict=True)),
        },
        "jobId": args.job_id,
        "artifactPath": args.artifact,
        "artifactSha256": artifact_hash,
        "powerPointVersion": power_point_version,
        "powerPoint": power_point,
        "system": {"platform": "macos", "osVersion": os_version, "arch": platform.machine()},
        "testedAt": log.get("completedAt"),
        "testedSlideIds": tested_slide_ids,
        "capturePath": args.capture,
        "captureSha256": sha256_file(capture),
        "testLogPath": args.test_log,
        "testLogSha256": sha256_file(test_log_path),
        "playback": {key: assertions[key] for key in (*PLAYBACK_KEYS, "autoPlayWithinSeconds")},
        "passed": True,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_name(f".{output.name}.{os.getpid()}.tmp")
    try:
        temp.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temp, output)
    finally:
        temp.unlink(missing_ok=True)
    print(output)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 - fail-closed receipt boundary
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error
