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
TOP = 233                 # headroom; subject top anchored here
SCALE = 1.265             # 1.15 (#294) * 1.10 (#295) over height-fit
ERODE_PX = 3
FEATHER = 1.2
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
    sw, sh = cut.size

    scale = ((CANVAS_H - TOP) / sh) * SCALE
    nw, nh = round(sw * scale), round(sh * scale)
    big = _defringe(cut.resize((nw, nh), Image.LANCZOS))

    arr = np.array(big)
    a = arr[..., 3]
    mask = binary_erosion(a > 30, iterations=ERODE_PX)
    arr[..., 3] = np.where(mask, a, 0).astype(np.uint8)
    big = Image.fromarray(arr, "RGBA")
    big.putalpha(big.split()[3].filter(ImageFilter.GaussianBlur(FEATHER)))

    canvas = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    canvas.alpha_composite(big, ((CANVAS_W - nw) // 2, TOP))
    os.makedirs(OUT_DIR, exist_ok=True)
    canvas.save(os.path.join(OUT_DIR, f"{kbo_id}.webp"), "WEBP", quality=92, method=6)
    return True, "ok"


def roster_ids():
    return [p["kboId"] for p in json.load(open(ROSTER, encoding="utf-8"))]


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--all", action="store_true", help="every roster player with an official shot")
    g.add_argument("--missing-only", action="store_true", help="only roster players lacking a hero webp")
    g.add_argument("--ids", help="comma-separated kboIds")
    ap.add_argument("--keep", default="", help="comma-separated kboIds to skip (preserve existing)")
    ap.add_argument("--update-approved", action="store_true", help="rewrite hero-approved list to all heroes present")
    args = ap.parse_args()

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
