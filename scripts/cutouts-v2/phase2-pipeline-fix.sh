#!/bin/bash
# Phase 2: 739명 v5 표준 cutout 배치 생성
# 파이프라인: KBO 증명사진 → Nano Banana Pro 2K → remove.bg HD → face detect crop (v5) → cwebp
#
# v5 스펙:
#   - 752x944 RGBA
#   - FACE_Y_RATIO = 0.56 (얼굴 중심이 캔버스 56% y 위치, v3 기준 - 얼굴 3% 아래)
#   - FACE_H_RATIO = 0.41 (얼굴 높이가 캔버스 41%)
#
# 실행:
#   bash scripts/cutouts-v2/phase2-pipeline.sh [START] [END]
#   START/END 생략 시 전체 배치 (default 0 ~ 739)

set -u  # -e 제외: 선수별 실패 허용

cd "$(dirname "$0")/../.."
OUTDIR="public/players-hero-v2"
mkdir -p "$OUTDIR/png" "$OUTDIR/raw" "$OUTDIR/webp"

# env
# GEMINI_API_KEY_OVERRIDE 환경변수가 세팅돼 있으면 그걸 최우선 사용 (HERO 프로젝트 키 등)
if [ -z "${GEMINI_API_KEY:-}" ]; then
  export GEMINI_API_KEY=$(grep -E '^export GEMINI_API_KEY=' ~/.zshrc | head -1 | cut -d'"' -f2)
fi
if [ -n "${GEMINI_API_KEY_OVERRIDE:-}" ]; then
  export GEMINI_API_KEY="$GEMINI_API_KEY_OVERRIDE"
  echo "Using GEMINI_API_KEY_OVERRIDE (prefix: ${GEMINI_API_KEY:0:10}...)"
fi
if [ -z "${REMOVE_BG_API_KEY:-}" ]; then
  export REMOVE_BG_API_KEY=$(grep -E '^export REMOVE_BG_API_KEY' ~/.zshrc | cut -d'"' -f2)
fi
if [ -z "$REMOVE_BG_API_KEY" ] || [ -z "$GEMINI_API_KEY" ]; then
  echo "❌ API key missing"; exit 1
fi

INPUT="${INPUT_OVERRIDE:-scripts/cutouts-v2/phase2-todo.json}"
TOTAL=$(jq 'length' "$INPUT")
START="${1:-0}"
END="${2:-$TOTAL}"
WORKER_TAG="${WORKER_TAG:-}"
LOG="/tmp/phase2${WORKER_TAG:+-}${WORKER_TAG}-$(date +%Y%m%d-%H%M).log"
FAIL_LOG="/tmp/phase2-failures.jsonl"  # 공유 (append-only, 워커 충돌 안전)
PROGRESS="/tmp/phase2${WORKER_TAG:+-}${WORKER_TAG}-progress.txt"

echo "==========================================" | tee -a "$LOG"
echo "Phase 2: 배치 $START → $END (전체 $TOTAL)" | tee -a "$LOG"
echo "시작: $(date '+%Y-%m-%d %H:%M:%S')" | tee -a "$LOG"
echo "==========================================" | tee -a "$LOG"

OK=0; FAIL=0; SKIP=0

for ((i=START; i<END; i++)); do
  IFS=$'\t' read -r kbo name team pos < <(jq -r ".[$i] | \"\(.kboId)\t\(.name)\t\(.teamName)\t\(.position)\"" "$INPUT")
  # 빈 값 방어
  [ -z "$kbo" ] && continue

  SRC_JPG="public/players/${kbo}.jpg"
  RAW_PNG="$OUTDIR/raw/${kbo}.png"
  HERO_PNG="$OUTDIR/png/${kbo}.png"
  WEBP="$OUTDIR/webp/${kbo}.webp"

  # 진행 상태 갱신
  echo "$i / $END ($kbo $team $name)" > "$PROGRESS"

  # 스킵
  if [ -f "$WEBP" ]; then
    SKIP=$((SKIP+1))
    continue
  fi

  # 원본 증명사진 없으면 skip
  if [ ! -f "$SRC_JPG" ]; then
    echo "[$i] $kbo $team $name: NO SRC JPG" >> "$LOG"
    echo "{\"kboId\":\"$kbo\",\"name\":\"$name\",\"team\":\"$team\",\"reason\":\"no_source_jpg\"}" >> "$FAIL_LOG"
    FAIL=$((FAIL+1))
    continue
  fi

  START_SEC=$(date +%s)

  # 1. Nano Banana Pro 2K
  if [ ! -f "$RAW_PNG" ]; then
    PROMPT="Official KBO baseball player portrait photograph. Upper body shot from head to chest, standing pose facing camera, wearing authentic KBO ${team} 2025 home uniform with team logo clearly visible. Studio portrait style, soft professional lighting, neutral medium-gray background (#8a8a8a), sharp focus, high detail photography. The player is ${name}, a ${pos} for ${team}. Preserve facial features and likeness from the reference photo exactly."

    ATTEMPT=0
    MAX_ATTEMPTS=2
    while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
      uv run ~/.openclaw/workspace/skills/nano-banana-pro/scripts/generate_image.py \
        --prompt "$PROMPT" \
        --filename "$RAW_PNG" \
        --input-image "$SRC_JPG" \
        --resolution 2K >/dev/null 2>&1
      [ -f "$RAW_PNG" ] && break
      ATTEMPT=$((ATTEMPT+1))
      sleep 10
    done

    if [ ! -f "$RAW_PNG" ]; then
      echo "[$i] $kbo $team $name: NANO-BANANA FAIL" >> "$LOG"
      echo "{\"kboId\":\"$kbo\",\"name\":\"$name\",\"team\":\"$team\",\"reason\":\"nano_banana_failed\"}" >> "$FAIL_LOG"
      FAIL=$((FAIL+1))
      continue
    fi
  fi

  # 2. remove.bg HD (intermediate tmp for face-detect crop input)
  TMP_HERO="$OUTDIR/png/.${kbo}.tmp.png"
  HTTP_CODE=$(curl -sS --max-time 30 -H "X-Api-Key: $REMOVE_BG_API_KEY" \
    -F "image_file=@${RAW_PNG}" \
    -F "size=hd" \
    -F "format=png" \
    -o "$TMP_HERO" \
    -w "%{http_code}" \
    https://api.remove.bg/v1.0/removebg 2>/dev/null)

  if [ "$HTTP_CODE" != "200" ]; then
    # 재시도 1회
    sleep 3
    HTTP_CODE=$(curl -sS --max-time 30 -H "X-Api-Key: $REMOVE_BG_API_KEY" \
      -F "image_file=@${RAW_PNG}" -F "size=hd" -F "format=png" \
      -o "$TMP_HERO" -w "%{http_code}" \
      https://api.remove.bg/v1.0/removebg 2>/dev/null)
  fi

  if [ "$HTTP_CODE" != "200" ]; then
    echo "[$i] $kbo $team $name: REMOVE.BG HTTP $HTTP_CODE" >> "$LOG"
    echo "{\"kboId\":\"$kbo\",\"name\":\"$name\",\"team\":\"$team\",\"reason\":\"remove_bg_http_$HTTP_CODE\"}" >> "$FAIL_LOG"
    rm -f "$TMP_HERO"
    FAIL=$((FAIL+1))
    # 크레딧 부족이면 전체 중단
    if [ "$HTTP_CODE" = "402" ]; then
      echo "❌ remove.bg 크레딧 부족 - 전체 중단" | tee -a "$LOG"
      break
    fi
    continue
  fi

  # 3. face detect → v5 crop → 752x944
  # 가드레일 v2 (2026-04-23): raw PNG 기반 face detect + 3단계 fallback + 최소 face 크기 검증
  CROP_RESULT=$(python3 - "$TMP_HERO" "$HERO_PNG" "$RAW_PNG" << 'PYEOF'
import sys, cv2, numpy as np
from PIL import Image

src, dst, raw_src = sys.argv[1], sys.argv[2], sys.argv[3]
TARGET_W, TARGET_H = 752, 944
FACE_Y_RATIO = 0.56
FACE_H_RATIO = 0.41
MIN_FACE_PX = 200

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
if use_raw and (rH != H or rW != W):
    scale_x, scale_y = W / rW, H / rH
    x, y, w, h = int(x*scale_x), int(y*scale_y), int(w*scale_x), int(h*scale_y)
fcx, fcy = x + w//2, y + h//2

aspect = w / h if h > 0 else 0
if aspect < 0.5 or aspect > 2.0:
    print(f"FAIL:bad_aspect:{aspect:.2f}"); sys.exit(2)

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
PYEOF
)
  rm -f "$TMP_HERO"

  if [[ "$CROP_RESULT" != OK:* ]]; then
    echo "[$i] $kbo $team $name: CROP $CROP_RESULT" >> "$LOG"
    echo "{\"kboId\":\"$kbo\",\"name\":\"$name\",\"team\":\"$team\",\"reason\":\"crop_$CROP_RESULT\"}" >> "$FAIL_LOG"
    FAIL=$((FAIL+1))
    continue
  fi

  # 4. cwebp lossless alpha
  cwebp -quiet -q 85 -alpha_q 100 -exact -metadata none "$HERO_PNG" -o "$WEBP" 2>/dev/null

  if [ ! -f "$WEBP" ]; then
    echo "[$i] $kbo $team $name: CWEBP FAIL" >> "$LOG"
    FAIL=$((FAIL+1))
    continue
  fi

  DURATION=$(($(date +%s) - START_SEC))
  OK=$((OK+1))

  # 10명마다 진행 로그
  if [ $(( (OK + FAIL) % 10 )) -eq 0 ]; then
    PROCESSED=$((i - START + 1))
    REMAINING=$((END - i - 1))
    echo "[$(date '+%H:%M:%S')] $i/$END - OK=$OK FAIL=$FAIL SKIP=$SKIP ($team $name ${DURATION}s)" | tee -a "$LOG"
  fi
done

echo "" | tee -a "$LOG"
echo "==========================================" | tee -a "$LOG"
echo "완료: OK=$OK FAIL=$FAIL SKIP=$SKIP" | tee -a "$LOG"
echo "종료: $(date '+%Y-%m-%d %H:%M:%S')" | tee -a "$LOG"
echo "==========================================" | tee -a "$LOG"

# remove.bg 크레딧 체크
CREDITS=$(curl -sS -H "X-Api-Key: $REMOVE_BG_API_KEY" https://api.remove.bg/v1.0/account 2>/dev/null | \
  python3 -c "import sys,json; d=json.load(sys.stdin); c=d.get('data',{}).get('attributes',{}).get('credits',{}); print(f\"subscription={c.get('subscription')}, payg={c.get('payg')}, total={c.get('total')}\")")
echo "remove.bg 잔여: $CREDITS" | tee -a "$LOG"

echo "$LOG"
