#!/usr/bin/env python3
"""
Hero cutout pipeline (KBO official headshot -> transparent hero slot).

Replaces the old Gemini-image + remove.bg generation. Fully local & free:
official shot -> rembg (u2net_human_seg, alpha matting) -> alpha erode +
distance-transform de-fringe + feather -> 1.265x framing on a 752x944 canvas
(top headroom 233, horizontally centered, overflow cropped) -> webp.

Source : public/players/{kboId}.jpg   (KBO official, person/middle)
Output : public/players-hero/{kboId}.webp
Roster : src/lib/constants/players-roster.json
Approve: src/lib/constants/hero-approved-kboids.json

Usage:
  build-hero.py --all                 # every roster player with an official shot
  build-hero.py --missing-only        # only roster players lacking a hero webp
  build-hero.py --ids 53123,69102     # specific kboIds
  build-hero.py --all --keep 53123,69102,69100,65207,66108   # don't touch these
  build-hero.py --all --update-approved                       # rewrite approved list
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image, ImageFilter
from rembg import remove, new_session
from scipy.ndimage import distance_transform_edt, binary_erosion

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SRC_DIR = os.path.join(REPO, "public", "players")
OUT_DIR = os.path.join(REPO, "public", "players-hero")
ROSTER = os.path.join(REPO, "src", "lib", "constants", "players-roster.json")
APPROVED = os.path.join(REPO, "src", "lib", "constants", "hero-approved-kboids.json")

# Framing constants — validated to pixel-match the human-approved LG five (#295).
CANVAS_W, CANVAS_H = 752, 944
TOP = 233                 # legacy headroom; subject top anchored here
SCALE = 1.265             # legacy: 1.15 (#294) * 1.10 (#295) over height-fit
ERODE_PX = 3
FEATHER = 1.2

# Framing mode. "legacy" = height-fit + fixed SCALE (KBO 공홈 저해상도 소스용).
# "silhouette" = 컷아웃 알파에서 정수리·어깨선을 직접 잡아 얼굴 크기를 선수 간
# 통일하고 어깨선을 캔버스 하단에 걸치는 히어로 구도(고해상도 다음 원본용).
FRAME_MODE = "legacy"
SIL_TOP = 70              # silhouette: 정수리 위 여백(px)
SIL_SHOULDER_F = 1.7      # silhouette: 어깨선 판정 = 머리폭의 이 배수
SIL_SHOULDER_TARGET = 0.99  # silhouette: 어깨선을 캔버스 높이의 이 지점에 앵커
# 과크롭 guard: 클로즈업 원본(머리가 프레임 가득)은 crown→어깨 span이 작아
# scale이 과도하게 커지며 눈/모자 위주로 잘림. scale이 이 상한을 넘으면
# silhouette를 포기하고 legacy height-fit(머리 전체 보존)으로 폴백한다.
# (정상 selfie 범위 scale≤1.45 / 과크롭 클로즈업 scale≥1.6 → 1.5에서 분리)
SIL_SCALE_CAP = 1.5
ALPHA_MATTING = dict(
    alpha_matting=True,
    alpha_matting_foreground_threshold=240,
    alpha_matting_background_threshold=10,
    alpha_matting_erode_size=10,
)

_session = None


def session():
    global _session
    if _session is None:
        _session = new_session("u2net_human_seg")
    return _session


def _defringe(rgba):
    """Bleed nearest fully-opaque color into edge/transparent pixels (kills white halo)."""
    arr = np.array(rgba)
    rgb, a = arr[..., :3], arr[..., 3]
    opaque = a > 200
    if opaque.sum() == 0:
        return rgba
    idx = distance_transform_edt(~opaque, return_distances=False, return_indices=True)
    return Image.fromarray(np.dstack([rgb[tuple(idx)], a]).astype(np.uint8), "RGBA")


def _place_legacy(cut):
    """height-fit + 고정 SCALE, 수평 중앙. 정수리를 TOP에 앵커."""
    sw, sh = cut.size
    scale = ((CANVAS_H - TOP) / sh) * SCALE
    nw, nh = round(sw * scale), round(sh * scale)
    big = _defringe(cut.resize((nw, nh), Image.LANCZOS))
    return big, (CANVAS_W - nw) // 2, TOP


def _place_silhouette(cut):
    """컷아웃 알파에서 정수리·어깨선을 직접 검출 → 어깨선을 캔버스 하단에 앵커.
    얼굴 크기가 선수 간 통일되고 비율은 원본 그대로(균등 스케일).
    반환: (big, ox, oy, mode) — mode는 'silhouette' 또는 과크롭 guard 발동 시
    'legacy-fallback'(클로즈업 원본 → legacy height-fit으로 머리 전체 보존)."""
    op = np.array(cut.split()[3]) > 40
    rows = np.where(op.any(axis=1))[0]
    crown, bottom = int(rows[0]), int(rows[-1])
    Hc = max(1, bottom - crown)
    widths = op.sum(axis=1)
    head_band = max(8, int(0.12 * Hc))
    band = widths[crown:crown + head_band]
    head_w = float(np.median(band[band > 0])) if (band > 0).any() else float(op.sum(axis=1).max())
    shoulder_y = None
    for y in range(crown + int(0.18 * Hc), bottom):
        if widths[y] >= SIL_SHOULDER_F * head_w:
            shoulder_y = y
            break
    span = max(1, (shoulder_y if shoulder_y is not None else crown + int(0.62 * Hc)) - crown)
    scale = ((CANVAS_H * SIL_SHOULDER_TARGET) - SIL_TOP) / span
    # 과크롭 guard: 어깨 미검출이거나 scale이 상한 초과(클로즈업 원본) → legacy 폴백.
    if shoulder_y is None or scale > SIL_SCALE_CAP:
        big, ox, oy = _place_legacy(cut)
        return big, ox, oy, "legacy-fallback"
    cols = np.where(op[crown:crown + head_band].any(axis=0))[0]
    cx = (float(cols[0]) + float(cols[-1])) / 2 if len(cols) else cut.size[0] / 2
    nw, nh = round(cut.size[0] * scale), round(cut.size[1] * scale)
    big = _defringe(cut.resize((nw, nh), Image.LANCZOS))
    ox = round(CANVAS_W / 2 - cx * scale)
    oy = round(SIL_TOP - crown * scale)
    return big, ox, oy, "silhouette"


def build(kbo_id):
    src_path = os.path.join(SRC_DIR, f"{kbo_id}.jpg")
    if not os.path.exists(src_path):
        return False, "no official source"
    src = Image.open(src_path).convert("RGB")
    cut = remove(src, session=session(), **ALPHA_MATTING).convert("RGBA")
    bb = cut.split()[3].getbbox()
    if bb is None:
        return False, "empty cutout"
    cut = cut.crop(bb)

    if FRAME_MODE == "silhouette":
        big, ox, oy, mode = _place_silhouette(cut)
    else:
        big, ox, oy = _place_legacy(cut)
        mode = "legacy"

    arr = np.array(big)
    a = arr[..., 3]
    mask = binary_erosion(a > 30, iterations=ERODE_PX)
    arr[..., 3] = np.where(mask, a, 0).astype(np.uint8)
    big = Image.fromarray(arr, "RGBA")
    big.putalpha(big.split()[3].filter(ImageFilter.GaussianBlur(FEATHER)))

    canvas = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    canvas.alpha_composite(big, (ox, oy))
    os.makedirs(OUT_DIR, exist_ok=True)
    canvas.save(os.path.join(OUT_DIR, f"{kbo_id}.webp"), "WEBP", quality=92, method=6)
    return True, mode


def roster_ids():
    return [p["kboId"] for p in json.load(open(ROSTER, encoding="utf-8"))]


def verify():
    """머지 게이트: hero-approved 목록과 실제 webp 정합성 + 규격(752x944 RGBA, 비어있지 않은 알파)."""
    present = sorted(f[:-5] for f in os.listdir(OUT_DIR) if f.endswith(".webp"))
    approved = json.load(open(APPROVED, encoding="utf-8"))
    ok = True
    extra = set(approved) - set(present)
    missing = set(present) - set(approved)
    if extra:
        print(f"VERIFY FAIL: approved에 있으나 webp 없음 {sorted(extra)[:10]}", file=sys.stderr); ok = False
    if missing:
        print(f"VERIFY FAIL: webp 있으나 approved 누락 {sorted(missing)[:10]}", file=sys.stderr); ok = False
    bad = []
    for kid in present:
        im = Image.open(os.path.join(OUT_DIR, f"{kid}.webp"))
        if im.size != (CANVAS_W, CANVAS_H):
            bad.append((kid, f"size {im.size}")); continue
        if im.convert("RGBA").mode != "RGBA":
            bad.append((kid, "no alpha")); continue
        if (np.array(im.convert("RGBA"))[..., 3] > 10).sum() == 0:
            bad.append((kid, "empty alpha"))
    if bad:
        ok = False
        for kid, why in bad[:15]:
            print(f"VERIFY FAIL {kid}: {why}", file=sys.stderr)
    print(f"verify: approved={len(approved)} present={len(present)} bad={len(bad)} -> {'PASS' if ok else 'FAIL'}")
    return ok


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--all", action="store_true", help="every roster player with an official shot")
    g.add_argument("--missing-only", action="store_true", help="only roster players lacking a hero webp")
    g.add_argument("--ids", help="comma-separated kboIds")
    g.add_argument("--verify", action="store_true",
                   help="머지 게이트: approved==present 정합성 + 모든 hero webp 752x944 RGBA 비어있지 않은 알파 검증")
    ap.add_argument("--keep", default="", help="comma-separated kboIds to skip (preserve existing)")
    ap.add_argument("--update-approved", action="store_true", help="rewrite hero-approved list to all heroes present")
    ap.add_argument("--src-dir", help="source jpg 디렉토리 override (기본 public/players). 다음 원본 고해상도용")
    ap.add_argument("--frame", choices=["legacy", "silhouette"], default="legacy",
                    help="legacy=고정 SCALE / silhouette=정수리·어깨선 정규화(다음 고해상도용)")
    args = ap.parse_args()

    global SRC_DIR, FRAME_MODE
    if args.src_dir:
        SRC_DIR = os.path.abspath(args.src_dir)
    FRAME_MODE = args.frame

    if args.verify:
        sys.exit(0 if verify() else 1)

    keep = {x for x in args.keep.split(",") if x}
    if args.ids:
        ids = [x for x in args.ids.split(",") if x]
    else:
        ids = roster_ids()
        if args.missing_only:
            ids = [i for i in ids if not os.path.exists(os.path.join(OUT_DIR, f"{i}.webp"))]
    ids = [i for i in ids if i not in keep]

    done, skipped, failed = 0, 0, []
    for i in ids:
        ok, msg = build(i)
        if ok:
            done += 1
        else:
            failed.append((i, msg))
    skipped = len(keep)
    print(f"generated={done} kept={skipped} failed={len(failed)}")
    for i, msg in failed:
        print(f"  FAIL {i}: {msg}", file=sys.stderr)

    if args.update_approved:
        present = sorted(
            f[:-5] for f in os.listdir(OUT_DIR) if f.endswith(".webp")
        )
        json.dump(present, open(APPROVED, "w", encoding="utf-8"),
                  ensure_ascii=False, indent=2)
        print(f"approved list updated: {len(present)} ids")


if __name__ == "__main__":
    main()
