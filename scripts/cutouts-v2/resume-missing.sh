#!/bin/bash
# Phase 2 Resume: todo.json 대비 아직 webp가 없는 선수만 필터해서 파이프라인 재실행.
# - /tmp 의존 없음 (프로젝트 내 영구 경로만 사용)
# - 완료/실패 여부를 Slack 스레드로 명시 알림
#
# 사용:
#   bash scripts/cutouts-v2/resume-missing.sh              # 자동 실측, 미완성 전체 돌림
#   DRY_RUN=1 bash scripts/cutouts-v2/resume-missing.sh    # 실측만 하고 종료
#
# 환경:
#   SLACK_CHANNEL_ID   (default: C0AJJ3UTZGX = #design)
#   SLACK_THREAD_TS    (default: 1776576335.566689 = 선수 히어로 진행상황 공유 스레드)

set -u

cd "$(dirname "$0")/../.."
ROOT="$PWD"
TODO="scripts/cutouts-v2/phase2-todo.json"
WEBP_DIR="public/players-hero-v2/webp"
LOG_DIR="scripts/cutouts-v2/logs"
mkdir -p "$LOG_DIR"

STAMP=$(date +%Y%m%d-%H%M%S)
LOG="$LOG_DIR/resume-$STAMP.log"
MISSING_JSON="$LOG_DIR/resume-$STAMP-missing.json"
FILTERED_TODO="$LOG_DIR/resume-$STAMP-todo.json"

SLACK_CHANNEL_ID="${SLACK_CHANNEL_ID:-C0AJJ3UTZGX}"
SLACK_THREAD_TS="${SLACK_THREAD_TS:-1776576335.566689}"

notify() {
  local msg="$1"
  openclaw message send \
    --channel slack \
    --target "$SLACK_CHANNEL_ID" \
    --thread-id "$SLACK_THREAD_TS" \
    -m "$msg" >> "$LOG" 2>&1 || echo "[notify] slack send failed" >> "$LOG"
}

echo "[$(date '+%F %T')] resume-missing 시작" | tee -a "$LOG"

# [LOCKED MODE] LOCKED_INPUT=<path-to-filtered-todo.json> 이 주어지면 실측 건너뛰고 그 파일을 그대로 사용
#   → "숫자 1회 확정 → 동일 리스트 실행" 원칙 보장
if [ -n "${LOCKED_INPUT:-}" ]; then
  if [ ! -f "$LOCKED_INPUT" ]; then
    echo "❌ LOCKED_INPUT 파일 없음: $LOCKED_INPUT" | tee -a "$LOG"
    exit 1
  fi
  FILTERED_TODO="$LOCKED_INPUT"
  FILTERED_COUNT=$(jq 'length' "$FILTERED_TODO")
  LOCKED_SHA=$(shasum -a 256 "$FILTERED_TODO" | awk '{print $1}')
  echo "🔒 LOCKED 모드: $FILTERED_TODO ($FILTERED_COUNT명, sha256=${LOCKED_SHA:0:12}...)" | tee -a "$LOG"
  notify "[hero-resume] ⏳ 시작 (LOCKED) — $FILTERED_COUNT명, 예상 약 $((FILTERED_COUNT * 40 / 60))분, sha=${LOCKED_SHA:0:12}"
  START_TS=$(date +%s)
  INPUT_OVERRIDE="$FILTERED_TODO" bash scripts/cutouts-v2/phase2-pipeline.sh 0 "$FILTERED_COUNT" >> "$LOG" 2>&1
  RC=$?
  END_TS=$(date +%s)
  ELAPSED=$((END_TS - START_TS))
  ELAPSED_MIN=$((ELAPSED / 60))

  # 결과 재측정
  AFTER_DONE=$(ls "$WEBP_DIR" 2>/dev/null | grep -E '^[A-Za-z0-9]+\.webp$' | sed 's/\.webp$//' | sort -u | wc -l | tr -d ' ')
  TODO_TOTAL=$(jq -r '.[].kboId' "$TODO" | sort -u | wc -l | tr -d ' ')
  TODO_DONE=$(comm -12 <(jq -r '.[].kboId' "$TODO" | sort -u) <(ls "$WEBP_DIR" 2>/dev/null | grep -E '^[A-Za-z0-9]+\.webp$' | sed 's/\.webp$//' | sort -u) | wc -l | tr -d ' ')
  STILL_MISSING=$((TODO_TOTAL - TODO_DONE))
  STILL_MISSING_IDS=$(comm -23 <(jq -r '.[].kboId' "$FILTERED_TODO" | sort -u) <(ls "$WEBP_DIR" 2>/dev/null | grep -E '^[A-Za-z0-9]+\.webp$' | sed 's/\.webp$//' | sort -u) | tr '\n' ' ')

  if [ $RC -eq 0 ] && [ -z "$STILL_MISSING_IDS" ]; then
    notify "[hero-resume] ✅ 완료 — 최종 $TODO_DONE/$TODO_TOTAL, 쟔여 실패 0, $ELAPSED_MIN분 소요"
  else
    notify "[hero-resume] ⚠️ 부분 완료 — 최종 $TODO_DONE/$TODO_TOTAL, 쟔여 실패=$([ -z "$STILL_MISSING_IDS" ] && echo 0 || echo "$STILL_MISSING_IDS" | wc -w), rc=$RC, 로그=$LOG%0A수동처리 필요: $STILL_MISSING_IDS"
  fi

  echo "[$(date '+%F %T')] resume-missing 종료 (rc=$RC, done=$TODO_DONE/$TODO_TOTAL)" | tee -a "$LOG"
  exit $RC
fi

# [AUTO MODE] 실측 기반 동적 산출
# 1. todo.json 에서 kboId 목록 추출
TODO_IDS=$(jq -r '.[].kboId' "$TODO" | sort -u)
TODO_COUNT=$(echo "$TODO_IDS" | wc -l | tr -d ' ')

# 2. webp 폴더에서 완료된 kboId 목록 추출
#    kboId 는 숫자뿐 아니라 AQ###/FP### 등 영문+숫자 패턴도 정식. todo.json 에 존재하는 id 전부 허용.
DONE_IDS=$(ls "$WEBP_DIR" 2>/dev/null | grep -E '^[A-Za-z0-9]+\.webp$' | sed 's/\.webp$//' | sort -u)
DONE_COUNT=$(echo "$DONE_IDS" | wc -l | tr -d ' ')

# 3. 미완성 = todo - done
MISSING_IDS=$(comm -23 <(echo "$TODO_IDS") <(echo "$DONE_IDS"))
MISSING_COUNT=$(echo "$MISSING_IDS" | grep -c . || true)

echo "todo=$TODO_COUNT done=$DONE_COUNT missing=$MISSING_COUNT" | tee -a "$LOG"

if [ "$MISSING_COUNT" -eq 0 ]; then
  echo "🎉 미완성 0명, 전체 완료" | tee -a "$LOG"
  notify "[hero-resume] 🎉 미완성 0명, 전체 $TODO_COUNT명 완료"
  exit 0
fi

# 4. 미완성 kboId 로 phase2-todo 필터링 → 새 JSON
echo "$MISSING_IDS" | jq -R . | jq -s . > "$MISSING_JSON"
jq --slurpfile ids "$MISSING_JSON" \
   '[.[] | select(.kboId as $k | $ids[0] | index($k))]' \
   "$TODO" > "$FILTERED_TODO"

FILTERED_COUNT=$(jq 'length' "$FILTERED_TODO")
echo "filtered todo: $FILTERED_COUNT" | tee -a "$LOG"

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "DRY_RUN=1 → 실측만 마치고 종료" | tee -a "$LOG"
  notify "[hero-resume] 실측: 미완성 $MISSING_COUNT명. DRY_RUN=1 로 실행은 건너뜀."
  exit 0
fi

# 5. 파이프라인 호출: phase2-pipeline.sh 는 INPUT 을 env 로 받지는 않으니 임시 스왑
#    (원본 덮어쓰기 방지를 위해 symlink 기법 대신 환경변수 override 추가 방식 사용)
notify "[hero-resume] ⏳ 시작 — 미완성 $MISSING_COUNT명, 예상 약 $((MISSING_COUNT * 40 / 60))분"

START_TS=$(date +%s)

INPUT_OVERRIDE="$FILTERED_TODO" bash scripts/cutouts-v2/phase2-pipeline.sh 0 "$FILTERED_COUNT" >> "$LOG" 2>&1
RC=$?

END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))
ELAPSED_MIN=$((ELAPSED / 60))

# 6. 결과 재측정
# kboId 는 숫자뿐 아니라 AQ###/FP### 등 영문+숫자 포함. 위쪽 실측과 동일 패턴 사용.
AFTER_DONE=$(ls "$WEBP_DIR" 2>/dev/null | grep -E '^[A-Za-z0-9]+\.webp$' | sed 's/\.webp$//' | sort -u | wc -l | tr -d ' ')
AFTER_MISSING=$((TODO_COUNT - AFTER_DONE))

if [ $RC -eq 0 ] && [ "$AFTER_MISSING" -eq 0 ]; then
  notify "[hero-resume] ✅ 완료 — $TODO_COUNT/$TODO_COUNT ($ELAPSED_MIN분 소요)"
else
  notify "[hero-resume] ⚠️ 부분 완료 — done=$AFTER_DONE/$TODO_COUNT, 남은=$AFTER_MISSING, rc=$RC, 로그=$LOG"
fi

echo "[$(date '+%F %T')] resume-missing 종료 (rc=$RC, done=$AFTER_DONE, missing=$AFTER_MISSING)" | tee -a "$LOG"
exit $RC
