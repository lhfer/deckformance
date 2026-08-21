#!/usr/bin/env python3
"""Rasterize deck.json for early layout QA.

This is not a substitute for rendering the authored PPTX, but it uses the same
point-to-pixel scale and layout font overrides so it does not hide obvious
wrapping, missing-poster, or density failures before authoring starts.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


ORPHAN_PUNCTUATION = set("，。！？；：、,.!?;:)]}》」』】")


def hex_rgb(s: str, fallback: str) -> tuple[int, int, int]:
    s = (s or fallback).replace("#", "").upper()
    if len(s) != 6:
        s = fallback
    return int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)


def load_font(
    size: int, bold: bool = False, cjk: bool = False
) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    if cjk:
        candidates = (
            "/System/Library/Fonts/STHeiti Medium.ttc" if bold else "/System/Library/Fonts/STHeiti Light.ttc",
            "/System/Library/Fonts/Hiragino Sans GB.ttc",
            "/System/Library/Fonts/STHeiti Medium.ttc",
        )
    else:
        candidates = (
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/Library/Fonts/Arial Bold.ttf" if bold else "/Library/Fonts/Arial.ttf",
            "/System/Library/Fonts/Helvetica.ttc",
        )
    for p in candidates:
        if Path(p).exists():
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                continue
    return ImageFont.load_default()


def cover_paste(base: Image.Image, src_path: Path, box: tuple[int, int, int, int]) -> None:
    x, y, w, h = box
    im = Image.open(src_path).convert("RGB")
    fitted = ImageOps.fit(im, (w, h), method=Image.Resampling.LANCZOS)
    base.paste(fitted, (x, y))


def wrap(draw: ImageDraw.ImageDraw, text: str, font, max_w: int) -> list[str]:
    if any("\u4e00" <= ch <= "\u9fff" for ch in text):
        units = list(text)
        joiner = ""
    else:
        units = text.split()
        joiner = " "
    lines: list[str] = []
    cur = ""
    for unit in units:
        trial = (cur + joiner + unit).strip() if cur else unit
        if draw.textlength(trial, font=font) <= max_w:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = unit
    if cur:
        lines.append(cur)
    return lines or [""]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("deck")
    parser.add_argument("outdir")
    args = parser.parse_args()

    skill_dir = Path(__file__).resolve().parent.parent
    layouts_doc = json.loads((skill_dir / "references" / "layouts.json").read_text())
    deck_path = Path(args.deck).resolve()
    deck = json.loads(deck_path.read_text())
    deck_dir = deck_path.parent
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    inch = 192  # 10" × 5.625" → 1920 × 1080
    W = int(layouts_doc["slide"]["w"] * inch)
    H = int(layouts_doc["slide"]["h"] * inch)
    pal = deck.get("palette") or {}
    bg = hex_rgb(pal.get("bg"), "F4EFE6")
    panel = hex_rgb(pal.get("panel"), "1C1C1C")
    title_on_dark = hex_rgb(pal.get("title"), "F7F4EF")
    body_on_dark = hex_rgb(pal.get("body"), "C4BFB6")
    muted_on_dark = hex_rgb(pal.get("muted"), "8E8A84")
    ink = hex_rgb(pal.get("ink"), "1C1C1C")
    ink_muted = hex_rgb(pal.get("inkMuted"), "6B6560")
    fonts = layouts_doc["fonts"]
    issues: list[str] = []
    cjk = bool(deck.get("fontFace")) or any(
        any(
            "\u4e00" <= ch <= "\u9fff"
            for ch in str(s.get("title", "") + "".join(s.get("body") or []))
        )
        for s in deck.get("slides") or []
    )

    def px(spec):
        return (
            int(spec["x"] * inch),
            int(spec["y"] * inch),
            int(spec["w"] * inch),
            int(spec["h"] * inch),
        )

    def pt_px(value: int | float) -> int:
        return max(1, round(float(value) * inch / 72))

    def aligned_x(align: str, x: int, w: int, text_width: float) -> float:
        if align == "right":
            return x + w - text_width
        if align == "center":
            return x + (w - text_width) / 2
        return x

    for i, slide in enumerate(deck["slides"], start=1):
        layout = layouts_doc["layouts"][slide["layoutId"]]
        img = Image.new("RGB", (W, H), bg)
        draw = ImageDraw.Draw(img)
        dark = bool(layout.get("onDarkPanel"))
        tcol = title_on_dark if dark else ink
        bcol = body_on_dark if dark else ink_muted
        mcol = muted_on_dark if dark else ink_muted

        if "card" in layout:
            cx, cy, cw, ch = px(layout["card"])
            radius = int((layout["card"].get("radius") or 0.12) * inch)
            overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
            od = ImageDraw.Draw(overlay)
            od.rounded_rectangle(
                [cx + 6, cy + 8, cx + cw + 6, cy + ch + 8],
                radius=radius,
                fill=(0, 0, 0, 38),
            )
            img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
            draw = ImageDraw.Draw(img)
            draw.rounded_rectangle(
                [cx, cy, cx + cw, cy + ch], radius=radius, fill=panel
            )
        elif "panel" in layout:
            x, y, w, h = px(layout["panel"])
            draw.rectangle([x, y, x + w, y + h], fill=panel)

        if "video" in layout:
            box = px(layout["video"])
            poster = slide.get("poster")
            poster_path = deck_dir / poster if poster else None
            if poster_path and poster_path.exists():
                cover_paste(img, poster_path, box)
            else:
                x, y, w, h = box
                draw.rectangle([x, y, x + w, y + h], fill=bg)
                issues.append(f"slide {i}: missing poster for media layout {slide['layoutId']}")

        if "overlay" in layout:
            ox, oy, ow, oh = px(layout["overlay"])
            overlay_spec = layout["overlay"]
            alpha = round(255 * (1 - float(overlay_spec.get("transparency", 0)) / 100))
            radius = int((overlay_spec.get("radius") or 0.12) * inch)
            layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
            ld = ImageDraw.Draw(layer)
            ld.rounded_rectangle(
                [ox, oy, ox + ow, oy + oh], radius=radius, fill=(*panel, alpha)
            )
            img = Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")
            draw = ImageDraw.Draw(img)

        def put_text(spec_key, text, size, color, bold=False, latin=False):
            if spec_key not in layout or not text:
                return
            spec = layout[spec_key]
            x, y, w, h = px(spec)
            font_size = pt_px(size)
            font = load_font(font_size, bold=bold, cjk=(cjk and not latin))
            lines = wrap(draw, text, font, w - 8)
            line_h = int(font_size * 1.2)
            align = spec.get("align", "left")
            cy = y
            for line_number, line in enumerate(lines, start=1):
                if line and line[0] in ORPHAN_PUNCTUATION:
                    issues.append(
                        f"slide {i} {spec_key}: line {line_number} starts with orphan punctuation {line[0]!r}"
                    )
                if cy + line_h > y + h:
                    issues.append(
                        f"slide {i} {spec_key}: text exceeds its {w}x{h}px box"
                    )
                    break
                tw = draw.textlength(line, font=font)
                tx = aligned_x(align, x, w, tw)
                draw.text((tx, cy), line, font=font, fill=color)
                cy += line_h

        put_text("kicker", slide.get("kicker"), fonts["kicker"], mcol)
        put_text("number", slide.get("number"), fonts["number"], mcol, latin=True)
        title_size = layout.get("title", {}).get("fontSize", fonts["title"])
        body_size = layout.get("body", {}).get("fontSize", fonts["body"])
        put_text("title", slide.get("title"), title_size, tcol, bold=True)
        body = slide.get("body") or []
        if "body" in layout and body:
            spec = layout["body"]
            x, y, w, h = px(spec)
            font_size = pt_px(body_size)
            font = load_font(font_size, cjk=cjk)
            cy = y
            line_h = int(font_size * 1.3)
            align = spec.get("align", "left")
            for paragraph_number, para in enumerate(body, start=1):
                for line_number, line in enumerate(wrap(draw, str(para), font, w - 8), start=1):
                    if line and line[0] in ORPHAN_PUNCTUATION:
                        issues.append(
                            f"slide {i} body paragraph {paragraph_number} line {line_number}: "
                            f"starts with orphan punctuation {line[0]!r}"
                        )
                    if cy + line_h > y + h:
                        issues.append(f"slide {i} body: text exceeds its {w}x{h}px box")
                        break
                    tw = draw.textlength(line, font=font)
                    draw.text((aligned_x(align, x, w, tw), cy), line, font=font, fill=bcol)
                    cy += line_h
                cy += int(font_size * 0.4)

        dest = outdir / f"slide-{i:02d}.jpg"
        img.save(dest, quality=90)
        print(dest)

    if issues:
        print("preview QA failed:", file=sys.stderr)
        for item in issues:
            print(f"- {item}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
