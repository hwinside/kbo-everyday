#!/bin/bash
# Broken 7명 cutout 재생성 — GPT Image 2 (codex-imagegen) 경로
# 2026-05-09 하린아빠 GO (#cs 사진없는선수 thread 1778241475.050539)
#
# 흐름: KBO 증명사진(public/players/{id}.jpg) → GPT Image 2 edit → 1024×1536 transparent PNG
#      → phase2-pipeline의 face detect+crop(v5 spec, 752×944) → cwebp lossless alpha
#
# 출력 위치 (덮어쓰기):
#   - GPT raw: scripts/cutouts-v2/logs/gpt-image-samples/{id}-gpt.png (1024×1536)
#   - v5 PNG : public/players-hero-v2/png/{id}.png (752×944)
#   - WEBP   : public/players-hero-v2/webp/{id}.webp
#   (allowlist 복사는 별도 step으로 copy-to-hero.sh)

set -u
cd "$(dirname "$0")/../.."

GPT_DIR="scripts/cutouts-v2/logs/gpt-image-samples"
PNG_DIR="public/players-hero-v2/png"
WEBP_DIR="public/players-hero-v2/webp"
mkdir -p "$GPT_DIR" "$PNG_DIR" "$WEBP_DIR"

LOG="scripts/cutouts-v2/logs/regen-gpt-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1

# (kboId, name, team, position) 7명
PLAYERS=(
  "52731|박준영|한화|투수"
  "54362|전준표|키움|투수"
  "54397|김지성|키움|포수"
  "54729|황준서|한화|투수"
  "55382|임진묵|키움|투수"
  "69332|주성원|키움|외야수"
  "77637|양현종|KIA|투수"
)

GPT_PROMPT_TEMPLATE='Create a clean cutout portrait of this baseball player. Crop from top of head down to about the navel/waist. Transparent background (PNG alpha). Crisp clean edges, no halo, no color bleeding. Preserve the face EXACTLY — do not invent or modify facial features, eyes, nose, mouth, cap, or uniform. Keep all original details (jersey logo, cap design, glasses if any). The player is %s, a %s for %s. Output should look like a high-quality alpha-cutout suitable for use as a hero image overlay in a sports app. No text, no watermarks, no shadows.'

OK=0; FAIL=0; SKIP=0

for entry in "${PLAYERS[@]}"; do
  IFS='|' read -r kbo name team pos <<<"$entry"
  echo ""
  echo "============== [$kbo] $name ($team $pos) =============="

  SRC_JPG="public/players/${kbo}.jpg"
  GPT_PNG="$GPT_DIR/${kbo}-gpt.png"
  HERO_PNG="$PNG_DIR/${kbo}.png"
  WEBP="$WEBP_DIR/${kbo}.webp"

  if [ ! -f "$SRC_JPG" ]; then
    echo "  ❌ SRC JPG 없음: $SRC_JPG"
    FAIL=$((FAIL+1))
    continue
  fi

  # 1. GPT Image 2 edit (이미 있으면 재사용 — 양현종 v1)
  if [ ! -f "$GPT_PNG" ]; then
    PROMPT=$(printf "$GPT_PROMPT_TEMPLATE" "$name" "$pos" "$team")
    echo "  [1/3] GPT Image 2 edit ..."
    node ~/.openclaw/workspace/skills/codex-imagegen/scripts/edit.js \
      --input "$SRC_JPG" \
      --prompt "$PROMPT" \
      --quality high \
      --size 1024x1536 \
      --format png \
      --out "$GPT_PNG" 2>&1 | tail -3 | sed 's/^/    /'
    if [ ! -f "$GPT_PNG" ]; then
      echo "  ❌ GPT Image 2 edit 실패"
      FAIL=$((FAIL+1))
      continue
    fi
  else
    echo "  [1/3] GPT Image 2 결과 재사용: $GPT_PNG"
  fi

  # 2. face detect + v5 crop (phase2-pipeline 로직 reuse, raw=GPT_PNG fallback path)
  echo "  [2/3] face detect + v5 crop (752×944) ..."
  CROP_RESULT=$(/usr/bin/python3 - "$GPT_PNG" "$HERO_PNG" << 'PYEOF'
import sys, cv2, numpy as np
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
TARGET_W, TARGET_H = 752, 944
FACE_Y_RATIO = 0.56
FACE_H_RATIO = 0.41
MIN_FACE_PX = 120  # GPT Image 2는 1024×1536 — 2K(2048×3072)보다 작으므로 thresh 낮춤

face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")

img = cv2.imread(src, cv2.IMREAD_UNCHANGED)
if img is None or img.ndim != 3 or img.shape[2] != 4:
    print("FAIL:load_or_not_rgba"); sys.exit(1)

H, W = img.shape[:2]

# 투명 PNG 합성 (gray bg) on the fly — raw PNG 없음
alpha = img[:, :, 3]
rgb = img[:, :, :3]
a3 = np.stack([alpha.astype(float)/255.0]*3, axis=-1)
flat = (rgb * a3 + 128 * (1-a3)).astype(np.uint8)
gray = cv2.cvtColor(flat, cv2.COLOR_BGR2GRAY)

# 3-stage face detect
face = None
for sf, mn, ms in [(1.1, 5, (100,100)), (1.05, 3, (80,80)), (1.03, 2, (50,50))]:
    faces = face_cascade.detectMultiScale(gray, scaleFactor=sf, minNeighbors=mn, minSize=ms)
    upper = [f for f in faces if (f[1] + f[3]/2) < H * 0.66]
    if upper:
        largest = max(upper, key=lambda f: f[2]*f[3])
        if largest[2] >= MIN_FACE_PX:
            face = largest; break
        elif face is None or largest[2] > face[2]:
            face = largest

if face is None:
    print("FAIL:no_face"); sys.exit(2)
if face[2] < MIN_FACE_PX:
    print(f"FAIL:face_too_small:{face[2]}x{face[3]}"); sys.exit(2)

x, y, w, h = face
aspect = w / h if h > 0 else 0
if aspect < 0.5 or aspect > 2.0:
    print(f"FAIL:bad_aspect:{aspect:.2f}"); sys.exit(2)

fcx, fcy = x + w//2, y + h//2
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

canvas = Image.new("RGBA", (TARGET_W, TARGET_H), (0,0,0,0))
canvas.paste(img_resized, (-crop_x, -crop_y))

arr = np.array(canvas)
ca = arr[:, :, 3]
total = ca.size
opaque_ratio = (ca == 255).sum() / total * 100
top_third = ca[:TARGET_H//3, :]
top_opaque = (top_third == 255).sum() / top_third.size * 100
center_band = ca[:, TARGET_W//4:TARGET_W*3//4]
center_opaque = (center_band == 255).sum() / center_band.size * 100

if opaque_ratio < 5:  print(f"FAIL:too_transparent:{opaque_ratio:.1f}"); sys.exit(3)
if top_opaque < 3:    print(f"FAIL:empty_top:{top_opaque:.1f}"); sys.exit(3)
if center_opaque < 10: print(f"FAIL:empty_center:{center_opaque:.1f}"); sys.exit(3)

canvas.save(dst)
print(f"OK:scale={scale:.2f}:opaque={opaque_ratio:.1f}:top={top_opaque:.1f}:center={center_opaque:.1f}:face={w}x{h}")
PYEOF
)
  echo "    $CROP_RESULT"
  if [[ "$CROP_RESULT" != OK:* ]]; then
    echo "  ❌ face crop 실패: $CROP_RESULT"
    FAIL=$((FAIL+1))
    continue
  fi

  # 3. cwebp lossless alpha
  echo "  [3/3] cwebp encode ..."
  cwebp -quiet -q 85 -alpha_q 100 -exact -metadata none "$HERO_PNG" -o "$WEBP"
  if [ ! -f "$WEBP" ]; then
    echo "  ❌ cwebp 실패"
    FAIL=$((FAIL+1))
    continue
  fi
  echo "  ✅ $kbo 완료 → $WEBP ($(stat -f%z "$WEBP") bytes)"
  OK=$((OK+1))
done

echo ""
echo "=========================================="
echo "최종: OK=$OK FAIL=$FAIL SKIP=$SKIP"
echo "=========================================="
exit $FAIL
