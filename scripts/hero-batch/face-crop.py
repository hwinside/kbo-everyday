#!/usr/bin/env python3
"""
v5 표준 얼굴 검출 + crop → 752x944 RGBA cutout.

phase2-pipeline.sh 의 인라인 PYEOF 블록을 그대로 떼어낸 standalone 판
(CI 에서 `pip install opencv-python-headless pillow numpy` 로 실행 가능).

usage: face-crop.py <transparent_png_in> <hero_png_out> <raw_png_for_facedetect>
exit:  0=OK / 1=load / 2=no_face|bad / 3=guard_fail   (stdout 첫 토큰이 OK: / FAIL:)
"""
import sys, cv2, numpy as np
from PIL import Image

src, dst, raw_src = sys.argv[1], sys.argv[2], sys.argv[3]
TARGET_W, TARGET_H = 752, 944
FACE_Y_RATIO = 0.56
FACE_H_RATIO = 0.41
MIN_FACE_PX = 200  # 2K 이미지 기준 최소 200px (false positive 차단)

face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")

# 투명 PNG (배경 제거 완료) 로드
img = cv2.imread(src, cv2.IMREAD_UNCHANGED)
if img is None or img.ndim != 3 or img.shape[2] != 4:
    print("FAIL:load_or_not_rgba"); sys.exit(1)

H, W = img.shape[:2]

# === 가드레일 핵심: raw PNG (불투명 원본)에서 face detect ===
raw_img = cv2.imread(raw_src)
if raw_img is not None:
    rH, rW = raw_img.shape[:2]
    raw_gray = cv2.cvtColor(raw_img, cv2.COLOR_BGR2GRAY)
    use_raw = True
else:
    alpha = img[:, :, 3]
    rgb = img[:, :, :3]
    a3 = np.stack([alpha.astype(float)/255.0]*3, axis=-1)
    flat = (rgb * a3 + 128 * (1-a3)).astype(np.uint8)
    raw_gray = cv2.cvtColor(flat, cv2.COLOR_BGR2GRAY)
    rH, rW = H, W
    use_raw = False

# 3단계 face detect (strict → moderate → permissive)
face = None
for stage, (sf, mn, ms) in enumerate([
    (1.1, 5, (100, 100)),
    (1.05, 3, (80, 80)),
    (1.03, 2, (50, 50)),
]):
    faces = face_cascade.detectMultiScale(raw_gray, scaleFactor=sf, minNeighbors=mn, minSize=ms)
    upper = [f for f in faces if (f[1] + f[3]/2) < rH * 0.66]
    if upper:
        largest = max(upper, key=lambda f: f[2]*f[3])
        if largest[2] >= MIN_FACE_PX:
            face = largest
            break
        elif face is None or largest[2] > face[2]:
            face = largest

if face is None:
    print("FAIL:no_face"); sys.exit(2)
if face[2] < MIN_FACE_PX:
    print(f"FAIL:face_too_small:{face[2]}x{face[3]}"); sys.exit(2)

x, y, w, h = face

# raw와 투명 PNG 크기가 다를 수 있으므로 좌표 스케일 보정
if use_raw and (rH != H or rW != W):
    scale_x, scale_y = W / rW, H / rH
    x, y, w, h = int(x*scale_x), int(y*scale_y), int(w*scale_x), int(h*scale_y)

fcx, fcy = x + w//2, y + h//2

# === 가드레일: face aspect ratio 검증 ===
aspect = w / h if h > 0 else 0
if aspect < 0.5 or aspect > 2.0:
    print(f"FAIL:bad_aspect:{aspect:.2f}"); sys.exit(2)

# 스케일 & 재배치
target_face_h = TARGET_H * FACE_H_RATIO
scale = target_face_h / h
new_W, new_H = int(W * scale), int(H * scale)
img_pil = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGRA2RGBA))
img_resized = img_pil.resize((new_W, new_H), Image.LANCZOS)
new_fcx, new_fcy = int(fcx * scale), int(fcy * scale)

target_fcx = TARGET_W // 2
target_fcy = int(TARGET_H * FACE_Y_RATIO)
crop_x = new_fcx - target_fcx
crop_y = new_fcy - target_fcy

canvas = Image.new("RGBA", (TARGET_W, TARGET_H), (0, 0, 0, 0))
canvas.paste(img_resized, (-crop_x, -crop_y))

# === 가드레일: 다중 검수 ===
arr = np.array(canvas)
ca = arr[:, :, 3]
total = ca.size

opaque_ratio = (ca == 255).sum() / total * 100
if opaque_ratio < 5:
    print(f"FAIL:too_transparent:{opaque_ratio:.1f}"); sys.exit(3)

top_third = ca[:TARGET_H//3, :]
top_opaque = (top_third == 255).sum() / top_third.size * 100
if top_opaque < 3:
    print(f"FAIL:empty_top:{top_opaque:.1f}"); sys.exit(3)

center_band = ca[:, TARGET_W//4:TARGET_W*3//4]
center_opaque = (center_band == 255).sum() / center_band.size * 100
if center_opaque < 10:
    print(f"FAIL:empty_center:{center_opaque:.1f}"); sys.exit(3)

canvas.save(dst)
print(f"OK:scale={scale:.2f}:opaque={opaque_ratio:.1f}:top={top_opaque:.1f}:center={center_opaque:.1f}:face={w}x{h}")
