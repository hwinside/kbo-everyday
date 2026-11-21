#!/usr/bin/env python3
# scripts/hero/contact_sheet.py
#
# 한 batch run의 hero candidate들을 grid composite한 contact sheet 생성.
# Phase 2 of auto-hero-pipeline.
#
# 입력 (--manifest, JSON):
#   {
#     "runId": "20260510-001234",
#     "items": [
#       {
#         "kboId": "50157", "name": "김윤식", "team": "LG", "position": "투수",
#         "source_jpg": "/path/to/raw_kbo.jpg",
#         "hero_png": "/path/to/hero.png",
#         "status": "ok" | "failed",
#         "failure_reason": "no_face" | ...
#       },
#       ...
#     ]
#   }
#
# 출력 (--out): 단일 JPG. 4-col grid. 각 cell:
#   [원본 KBO jpg | hero (신규 candidate 또는 기존 자산)] + 라벨(kboId / 이름 / 팀)
#   status 별 보더 색:
#     ok               초록  — 신규 생성 candidate
#     review_existing  노랑  — generated_unapproved (재생성 안 함, 기존 자산 검수)
#     failed           빨강  — 실패 + reason 표기
#
# 사용:
#   python3 scripts/hero/contact_sheet.py --manifest /tmp/run.json --out /tmp/sheet.jpg

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

CELL_W = 480           # 각 셀 가로 (source + hero 합)
CELL_H = 320           # 각 셀 세로
THUMB_W = 220          # source/hero 각각의 썸네일 가로
THUMB_H = 270
PAD = 10
LABEL_BAR_H = 38
COLS = 4
BG = (24, 24, 28, 255)
LABEL_BG = (40, 40, 44, 255)
LABEL_FG = (235, 235, 235, 255)
OK_BORDER = (44, 180, 96, 255)
REVIEW_BORDER = (230, 180, 50, 255)   # 노랑 — 기존 자산 review-only
FAIL_BORDER = (220, 64, 64, 255)
PLACEHOLDER = (60, 60, 64, 255)


def border_for(status):
    if status == "ok":
        return OK_BORDER
    if status == "review_existing":
        return REVIEW_BORDER
    return FAIL_BORDER


def load_font(size):
    candidates = [
        "/System/Library/Fonts/AppleSDGothicNeo.ttc",
        "/System/Library/Fonts/Supplemental/AppleGothic.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for p in candidates:
        if Path(p).exists():
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                continue
    return ImageFont.load_default()


def fit_thumb(path: Path, size, *, transparent=False):
    if not path or not path.exists():
        return Image.new("RGBA", size, PLACEHOLDER)
    try:
        img = Image.open(path)
        if transparent:
            img = img.convert("RGBA")
            bg = Image.new("RGBA", img.size, (32, 32, 36, 255))
            bg.alpha_composite(img)
            img = bg
        else:
            img = img.convert("RGBA")
        img.thumbnail(size, Image.LANCZOS)
        canvas = Image.new("RGBA", size, (32, 32, 36, 255))
        x = (size[0] - img.size[0]) // 2
        y = (size[1] - img.size[1]) // 2
        canvas.paste(img, (x, y), img)
        return canvas
    except Exception:
        return Image.new("RGBA", size, PLACEHOLDER)


def draw_cell(item, font_label, font_meta):
    cell = Image.new("RGBA", (CELL_W, CELL_H + LABEL_BAR_H), BG)
    src_thumb = fit_thumb(Path(item["source_jpg"]) if item.get("source_jpg") else None, (THUMB_W, THUMB_H))
    # review_existing은 PNG이 없고 WEBP만 있을 수 있음 (`public/players-hero-v2/png/{id}.png` 미커밋 케이스).
    hero_path = item.get("hero_png") or item.get("hero_webp")
    hero_thumb = fit_thumb(Path(hero_path) if hero_path else None, (THUMB_W, THUMB_H), transparent=True)
    cell.paste(src_thumb, (PAD, PAD))
    cell.paste(hero_thumb, (PAD * 2 + THUMB_W, PAD))

    status = item.get("status")
    border = border_for(status)
    draw = ImageDraw.Draw(cell)
    draw.rectangle([(0, 0), (CELL_W - 1, CELL_H + LABEL_BAR_H - 1)], outline=border, width=3)
    draw.rectangle([(0, CELL_H), (CELL_W, CELL_H + LABEL_BAR_H)], fill=LABEL_BG)
    label = f"{item.get('kboId','?')} · {item.get('name','')} · {item.get('team','')}"
    draw.text((PAD, CELL_H + 6), label, fill=LABEL_FG, font=font_label)
    if status == "ok":
        face = item.get("face") or {}
        bbox = face.get("face_size_px")
        stage = face.get("stage", "?")
        scale = face.get("scale", 0)
        meta = f"stage={stage} face={bbox} scale={scale}"
        draw.text((PAD, CELL_H + 22), meta, fill=(180, 180, 180), font=font_meta)
    elif status == "review_existing":
        draw.text((PAD, CELL_H + 22), "REVIEW (기존 자산 / 재생성 X)", fill=REVIEW_BORDER, font=font_meta)
    else:
        reason = item.get("failure_reason") or "failed"
        draw.text((PAD, CELL_H + 22), f"FAIL: {reason}", fill=FAIL_BORDER, font=font_meta)
    return cell


def main():
    parser = argparse.ArgumentParser(description="hero candidate contact sheet")
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    manifest = json.loads(Path(args.manifest).read_text())
    items = manifest.get("items", [])
    if not items:
        # 빈 sheet 방지: 1x1 placeholder
        Image.new("RGB", (CELL_W, CELL_H), BG[:3]).save(args.out, "JPEG", quality=85)
        print(json.dumps({"status": "ok", "items": 0, "out": args.out}))
        return

    rows = (len(items) + COLS - 1) // COLS
    sheet_w = COLS * CELL_W
    sheet_h = rows * (CELL_H + LABEL_BAR_H) + 70  # 70 = header
    sheet = Image.new("RGB", (sheet_w, sheet_h), BG[:3])
    header_draw = ImageDraw.Draw(sheet)
    title_font = load_font(22)
    sub_font = load_font(14)
    label_font = load_font(14)
    meta_font = load_font(12)

    title = f"Hero candidate contact sheet — run {manifest.get('runId','?')}"
    header_draw.text((20, 14), title, fill=(240, 240, 240), font=title_font)
    n_ok = sum(1 for i in items if i.get("status") == "ok")
    n_review = sum(1 for i in items if i.get("status") == "review_existing")
    n_failed = sum(1 for i in items if i.get("status") == "failed")
    summary = (
        f"items={len(items)} · ok={n_ok} · review={n_review} · failed={n_failed} · "
        f"generated_at={manifest.get('generatedAt','')}"
    )
    header_draw.text((20, 44), summary, fill=(180, 180, 180), font=sub_font)

    for idx, item in enumerate(items):
        row = idx // COLS
        col = idx % COLS
        cell = draw_cell(item, label_font, meta_font)
        x = col * CELL_W
        y = 70 + row * (CELL_H + LABEL_BAR_H)
        sheet.paste(cell.convert("RGB"), (x, y))

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    sheet.save(args.out, "JPEG", quality=85, optimize=True)
    print(json.dumps({"status": "ok", "items": len(items), "rows": rows, "out": args.out}))


if __name__ == "__main__":
    main()
