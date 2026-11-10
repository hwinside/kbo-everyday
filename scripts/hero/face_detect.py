#!/usr/bin/env python3
# scripts/hero/face_detect.py
#
# Actions-safe Haar face detection + v5 hero crop.
# Phase 2 of auto-hero-pipeline (specs/auto-hero-pipeline/).
#
# 입력:
#   --raw-png    Nano Banana Pro 출력 (gray bg, opaque) — face detect source
#   --alpha-png  remove.bg HD 출력 (transparent bg, RGBA) — crop source
#   --out-png    752x944 RGBA hero candidate 저장 경로
#   --meta-json  메타데이터(JSON) 저장 경로 (face bbox/scale/validation)
#
# v5 spec (phase2-pipeline.sh와 동일):
#   - 752x944 RGBA
#   - FACE_Y_RATIO 0.56  (얼굴 중심 = 캔버스 56% y)
#   - FACE_H_RATIO 0.41  (얼굴 높이 = 캔버스 41%)
#
# fail-closed gates (exit code):
#   0  ok
#   10 image_decode_failed
#   11 no_face
#   12 multiple_faces (qualified candidate > 1)
#   13 face_too_small (< MIN_FACE_PX)
#   14 face_bad_aspect (w/h <0.5 or >2.0)
#   15 crop_outside_safe_bounds (post-scale bbox margin too small)
#   16 hero_validation_failed (transparency / coverage)
#   64 usage_error
#
# 사용:
#   python3 scripts/hero/face_detect.py \
#     --raw-png /tmp/raw.png \
#     --alpha-png /tmp/alpha.png \
#     --out-png /tmp/hero.png \
#     --meta-json /tmp/hero.meta.json

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

TARGET_W = 752
TARGET_H = 944
FACE_Y_RATIO = 0.56
FACE_H_RATIO = 0.41
MIN_FACE_PX = 200            # 2K 입력 기준 (false positive 차단)
MIN_ASPECT = 0.5
MAX_ASPECT = 2.0
SAFE_BOUND_MARGIN_PX = 12    # 얼굴 bbox가 canvas edge 이내로 최소 12px 들어와야 함
MIN_OPAQUE_RATIO = 5.0       # 전체
MIN_TOP_OPAQUE = 3.0         # 상단 1/3
MIN_CENTER_OPAQUE = 10.0     # 중앙 세로 밴드

EXIT_OK = 0
EXIT_DECODE = 10
EXIT_NO_FACE = 11
EXIT_MULTI_FACE = 12
EXIT_FACE_TOO_SMALL = 13
EXIT_FACE_BAD_ASPECT = 14
EXIT_CROP_BOUNDS = 15
EXIT_VALIDATION = 16
EXIT_USAGE = 64


def fail(meta_path, exit_code, reason, **details):
    payload = {"status": "failed", "exit_code": exit_code, "reason": reason, **details}
    if meta_path:
        meta_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    sys.stderr.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.exit(exit_code)


def detect_face(raw_gray, height):
    """3-stage Haar detection. Returns list of qualified faces (post upper-2/3 + size + aspect filters)."""
    cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    )
    stages = [
        ("strict", 1.1, 5, (100, 100)),
        ("moderate", 1.05, 3, (80, 80)),
        ("permissive", 1.03, 2, (50, 50)),
    ]
    for stage_name, sf, mn, ms in stages:
        faces = cascade.detectMultiScale(
            raw_gray, scaleFactor=sf, minNeighbors=mn, minSize=ms
        )
        # 상단 2/3 안에 있는 후보만 (팔뚝/허리 false positive 차단)
        upper = [f for f in faces if (f[1] + f[3] / 2) < height * 0.66]
        # 크기 + aspect 필터 적용
        qualified = []
        for x, y, w, h in upper:
            if w < MIN_FACE_PX:
                continue
            aspect = w / h if h > 0 else 0
            if aspect < MIN_ASPECT or aspect > MAX_ASPECT:
                continue
            qualified.append((int(x), int(y), int(w), int(h)))
        if qualified:
            return stage_name, qualified, [tuple(int(v) for v in f) for f in upper]
    return None, [], []


def main():
    parser = argparse.ArgumentParser(description="v5 hero face detect + crop")
    parser.add_argument("--raw-png", required=True, help="Nano Banana 2K opaque PNG (face source)")
    parser.add_argument("--alpha-png", required=True, help="remove.bg HD RGBA PNG (crop source)")
    parser.add_argument("--out-png", required=True, help="output 752x944 hero PNG")
    parser.add_argument("--meta-json", required=True, help="output metadata JSON")
    args = parser.parse_args()

    raw_path = Path(args.raw_png)
    alpha_path = Path(args.alpha_png)
    out_path = Path(args.out_png)
    meta_path = Path(args.meta_json)

    if not raw_path.exists():
        fail(meta_path, EXIT_USAGE, "raw_png_missing", path=str(raw_path))
    if not alpha_path.exists():
        fail(meta_path, EXIT_USAGE, "alpha_png_missing", path=str(alpha_path))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    meta_path.parent.mkdir(parents=True, exist_ok=True)

    raw_img = cv2.imread(str(raw_path))
    if raw_img is None:
        fail(meta_path, EXIT_DECODE, "raw_png_decode_failed")
    alpha_img = cv2.imread(str(alpha_path), cv2.IMREAD_UNCHANGED)
    if alpha_img is None or alpha_img.ndim != 3 or alpha_img.shape[2] != 4:
        fail(meta_path, EXIT_DECODE, "alpha_png_not_rgba",
             shape=None if alpha_img is None else list(alpha_img.shape))

    rH, rW = raw_img.shape[:2]
    aH, aW = alpha_img.shape[:2]
    raw_gray = cv2.cvtColor(raw_img, cv2.COLOR_BGR2GRAY)

    stage, qualified, upper_all = detect_face(raw_gray, rH)
    if stage is None:
        fail(meta_path, EXIT_NO_FACE, "no_face_after_3_stages",
             upper_candidates=len(upper_all),
             upper=upper_all)
    if len(qualified) > 1:
        fail(meta_path, EXIT_MULTI_FACE, "ambiguous_multiple_faces",
             stage=stage, qualified=qualified)

    fx, fy, fw, fh = qualified[0]

    # raw <-> alpha 좌표 스케일 보정
    if (rH, rW) != (aH, aW):
        sx, sy = aW / rW, aH / rH
        fx, fy, fw, fh = int(fx * sx), int(fy * sy), int(fw * sx), int(fh * sy)
    fcx, fcy = fx + fw // 2, fy + fh // 2

    # === 스케일 + 재배치 ===
    target_face_h = TARGET_H * FACE_H_RATIO
    scale = target_face_h / fh
    new_W, new_H = int(aW * scale), int(aH * scale)
    new_fcx, new_fcy = int(fcx * scale), int(fcy * scale)
    new_fw, new_fh = int(fw * scale), int(fh * scale)

    target_fcx = TARGET_W // 2
    target_fcy = int(TARGET_H * FACE_Y_RATIO)
    crop_x = new_fcx - target_fcx
    crop_y = new_fcy - target_fcy

    # === 가드: 얼굴 bbox가 canvas safe bounds 안에 들어오는지 ===
    # paste 위치 기준 face의 canvas-left edge 좌표
    face_left_on_canvas = target_fcx - new_fw // 2
    face_top_on_canvas = target_fcy - new_fh // 2
    face_right_on_canvas = face_left_on_canvas + new_fw
    face_bottom_on_canvas = face_top_on_canvas + new_fh
    if (face_left_on_canvas < SAFE_BOUND_MARGIN_PX or
            face_top_on_canvas < SAFE_BOUND_MARGIN_PX or
            face_right_on_canvas > TARGET_W - SAFE_BOUND_MARGIN_PX or
            face_bottom_on_canvas > TARGET_H - SAFE_BOUND_MARGIN_PX):
        fail(meta_path, EXIT_CROP_BOUNDS, "face_outside_safe_bounds",
             scale=round(scale, 4),
             face_on_canvas=[face_left_on_canvas, face_top_on_canvas,
                             face_right_on_canvas, face_bottom_on_canvas],
             canvas=[TARGET_W, TARGET_H],
             margin=SAFE_BOUND_MARGIN_PX)

    # === Compose ===
    img_pil = Image.fromarray(cv2.cvtColor(alpha_img, cv2.COLOR_BGRA2RGBA))
    img_resized = img_pil.resize((new_W, new_H), Image.LANCZOS)
    canvas = Image.new("RGBA", (TARGET_W, TARGET_H), (0, 0, 0, 0))
    canvas.paste(img_resized, (-crop_x, -crop_y))

    arr = np.array(canvas)
    ca = arr[:, :, 3]
    total = ca.size
    opaque_ratio = float((ca == 255).sum()) / total * 100
    top_third = ca[: TARGET_H // 3, :]
    top_opaque = float((top_third == 255).sum()) / top_third.size * 100
    center_band = ca[:, TARGET_W // 4: TARGET_W * 3 // 4]
    center_opaque = float((center_band == 255).sum()) / center_band.size * 100

    if opaque_ratio < MIN_OPAQUE_RATIO:
        fail(meta_path, EXIT_VALIDATION, "too_transparent",
             opaque_ratio=round(opaque_ratio, 2))
    if top_opaque < MIN_TOP_OPAQUE:
        fail(meta_path, EXIT_VALIDATION, "empty_top",
             top_opaque=round(top_opaque, 2))
    if center_opaque < MIN_CENTER_OPAQUE:
        fail(meta_path, EXIT_VALIDATION, "empty_center",
             center_opaque=round(center_opaque, 2))

    canvas.save(out_path)

    meta = {
        "status": "ok",
        "exit_code": EXIT_OK,
        "out_png": str(out_path),
        "stage": stage,
        "face_bbox_alpha": [fx, fy, fw, fh],
        "face_size_px": [int(fw), int(fh)],
        "face_aspect": round(fw / fh, 3) if fh else 0,
        "scale": round(scale, 4),
        "scaled_canvas": [new_W, new_H],
        "crop_offset": [crop_x, crop_y],
        "face_on_canvas": [face_left_on_canvas, face_top_on_canvas,
                           face_right_on_canvas, face_bottom_on_canvas],
        "validation": {
            "opaque_ratio": round(opaque_ratio, 2),
            "top_opaque": round(top_opaque, 2),
            "center_opaque": round(center_opaque, 2),
        },
        "raw_size": [rW, rH],
        "alpha_size": [aW, aH],
        "target": [TARGET_W, TARGET_H],
        "face_y_ratio": FACE_Y_RATIO,
        "face_h_ratio": FACE_H_RATIO,
    }
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2))
    sys.stdout.write(json.dumps({"status": "ok", "stage": stage,
                                 "face_bbox": [fx, fy, fw, fh],
                                 "scale": round(scale, 4)}) + "\n")
    sys.exit(EXIT_OK)


if __name__ == "__main__":
    main()
