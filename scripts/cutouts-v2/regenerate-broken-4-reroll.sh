#!/bin/bash
# Broken-4 reroll — 박준영/황준서/임진묵/양현종 화각 통일 재생성
# 2026-05-09 하린아빠 옵션 B 선택 (#cs 1778338785.206989):
#   "B (윗줄 4명도 같은 v2 prompt로 reroll → 7명 완전 통일)"
#
# 1차 v1 GPT raw 화각이 v2 (전준표/김지성/주성원) 새 prompt 결과보다 헐겁게 잡힘:
#   - 1차 v1: 머리~가슴 위까지
#   - 2차 v2: 머리~어깨선까지 (목표 화각)
#
# regenerate-broken-3-reroll.sh와 동일 prompt 사용, PLAYERS만 교체.
# 다른 검증 단계는 v5 spec 그대로 (face crop / opaque ratio / cwebp).

set -u
cd "$(dirname "$0")/../.."

GPT_DIR="scripts/cutouts-v2/logs/gpt-image-samples"
PNG_DIR="public/players-hero-v2/png"
WEBP_DIR="public/players-hero-v2/webp"
TMP_DIR="scripts/cutouts-v2/logs/reroll-tmp"
mkdir -p "$GPT_DIR" "$PNG_DIR" "$WEBP_DIR" "$TMP_DIR"

LOG="scripts/cutouts-v2/logs/regen-reroll4-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1

if [ -z "${REMOVE_BG_API_KEY:-}" ]; then
  export REMOVE_BG_API_KEY=$(grep -E '^export REMOVE_BG_API_KEY' ~/.zshrc | cut -d'"' -f2)
fi
if [ -z "${REMOVE_BG_API_KEY:-}" ]; then
  echo "❌ REMOVE_BG_API_KEY 없음"; exit 1
fi

# (kboId, name, team, position) — 4명
PLAYERS=(
  "52731|박준영|한화|투수"
  "54729|황준서|한화|투수"
  "55382|임진묵|키움|투수"
  "77637|양현종|KIA|투수"
)

GPT_PROMPT_TEMPLATE='Create a clean head-and-shoulders portrait of this baseball player.

CRITICAL FRAMING RULES:
- Crop from top of head down to UPPER CHEST ONLY (just below the collar, ABOVE the chest logo).
- The shoulders MUST be at the BOTTOM of the frame — do NOT include arms, torso, jersey body below the chest, hands, or waist.
- The face and head MUST be HORIZONTALLY CENTERED in the frame (do NOT shift left or right).
- Frame the player as a tight head-and-shoulders portrait — similar in framing to a passport photo but with the cap and shoulders visible.

OTHER RULES:
- White or transparent background (preferable: transparent PNG alpha).
- Crisp clean edges, no halo, no color bleeding.
- Preserve the face EXACTLY — do not invent or modify facial features, eyes, nose, mouth, cap, or uniform.
- Keep all original details (jersey logo on cap, cap design, glasses if any).
- The player is %s, a %s for %s.
- No text overlays, no watermarks, no shadows.

This is a head-and-shoulders cutout for a sports-app hero overlay. ONLY head and shoulders should be visible.'

OK=0; FAIL=0

for entry in "${PLAYERS[@]}"; do
  IFS='|' read -r kbo name team pos <<<"$entry"
  echo ""
  echo "============== [$kbo] $name ($team $pos) =============="

  SRC_JPG="public/players/${kbo}.jpg"
  GPT_PNG="$GPT_DIR/${kbo}-gpt.png"
  RGBA_PNG="$TMP_DIR/${kbo}-rgba.png"
  HERO_PNG="$PNG_DIR/${kbo}.png"
  WEBP="$WEBP_DIR/${kbo}.webp"

  if [ ! -f "$SRC_JPG" ]; then
    echo "  ❌ SRC JPG 없음: $SRC_JPG"
    FAIL=$((FAIL+1))
    continue
  fi

  rm -f "$GPT_PNG"
  PROMPT=$(printf "$GPT_PROMPT_TEMPLATE" "$name" "$pos" "$team")
  echo "  [1/4] GPT Image 2 edit (head-and-shoulders prompt v2) ..."
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

  echo "  [2/4] remove.bg HD ..."
  HTTP_CODE=$(curl -sS --max-time 30 -H "X-Api-Key: $REMOVE_BG_API_KEY" \
    -F "image_file=@${GPT_PNG}" \
    -F "size=hd" \
    -F "format=png" \
    -o "$RGBA_PNG" \
    -w "%{http_code}" \
    https://api.remove.bg/v1.0/removebg 2>/dev/null)
  if [ "$HTTP_CODE" != "200" ]; then
    echo "  ❌ remove.bg HTTP $HTTP_CODE"
    FAIL=$((FAIL+1))
    continue
  fi

  echo "  [3/4] face detect + v5 crop (752×944) ..."
  CROP_RESULT=$(/usr/bin/python3 - "$RGBA_PNG" "$HERO_PNG" "$GPT_PNG" << 'PYEOF'
import sys, cv2, numpy as np
from PIL import Image

src, dst, raw_src = sys.argv[1], sys.argv[2], sys.argv[3]
TARGET_W, TARGET_H = 752, 944
FACE_Y_RATIO = 0.56
FACE_H_RATIO = 0.41
MIN_FACE_PX = 120

face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")

img = cv2.imread(src, cv2.IMREAD_UNCHANGED)
if img is None or img.ndim != 3 or img.shape[2] != 4:
    print("FAIL:load_or_not_rgba"); sys.exit(1)

H, W = img.shape[:2]

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

face = None
for sf, mn, ms in [(1.1, 5, (100,100)), (1.05, 3, (80,80)), (1.03, 2, (50,50))]:
    faces = face_cascade.detectMultiScale(raw_gray, scaleFactor=sf, minNeighbors=mn, minSize=ms)
    upper = [f for f in faces if (f[1] + f[3]/2) < rH * 0.66]
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
if use_raw and (rH != H or rW != W):
    sx, sy = W / rW, H / rH
    x, y, w, h = int(x*sx), int(y*sy), int(w*sx), int(h*sy)

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

  echo "  [4/4] cwebp encode ..."
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
echo "최종: OK=$OK FAIL=$FAIL"
echo "=========================================="
exit $FAIL
