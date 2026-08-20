#!/usr/bin/env bash
# 결함주입 게이트 — delta 버퍼가 "쓰기 횟수를 실제로 줄이는가" 계약이 깨지면 RED 가 나는지 증명한다.
#
# 배경(2026-08-20 삼순 blocker 1): 1차 설계는 이벤트마다 UPSERT 라 행 수만 줄고 쓰기 횟수·WAL 은
# 그대로였다. 그 회귀가 조용히 돌아오면 이 게이트가 반드시 죽어야 한다.
#
# 규칙:
#  - 훼손 대상은 production seam(src/lib/monitoring/fallback-buffer.ts), 테스트는 안 건드린다.
#  - 훼손 결과는 컴파일 가능해야 한다. 문법 오류 RED 는 계약 검출이 아니다.
#  - 변이 적용 여부를 grep 으로 증명한다(미적용 = false-MISS).
set -uo pipefail

SRC="src/lib/monitoring/fallback-buffer.ts"
GATE="npx tsx scripts/qa/fallback-buffer-smoke.ts"

[[ -f "$SRC" ]] || { echo "FATAL: 대상 파일 없음: $SRC" >&2; exit 2; }

TMP="$(mktemp -d)"
trap 'cp "$TMP/orig.ts" "$SRC" 2>/dev/null || true; rm -rf "$TMP"' EXIT
cp "$SRC" "$TMP/orig.ts"

pass=0
fail=0

mutate() {
  local name="$1" expr="$2" verify="$3"
  cp "$TMP/orig.ts" "$SRC"
  perl -0pi -e "$expr" "$SRC"

  if ! grep -qF -- "$verify" "$SRC"; then
    echo "  ✗ $name — 변이 미적용(패턴 불일치) → 결과 신뢰 불가"
    fail=$((fail + 1))
    return
  fi

  if $GATE > "$TMP/out.log" 2>&1; then
    echo "  ✗ $name — 훼손했는데 게이트 GREEN (검출 실패)"
    fail=$((fail + 1))
  else
    if grep -qiE 'SyntaxError|Transform failed|Cannot find name|error TS' "$TMP/out.log"; then
      echo "  ✗ $name — RED 이지만 컴파일 오류 때문(계약 검출 아님)"
      fail=$((fail + 1))
    else
      echo "  ✓ $name — RED"
      pass=$((pass + 1))
    fi
  fi
}

echo "fallback buffer mutations:"

# M1: 매 관측마다 flush = 1차 설계로 회귀. 이 PR 의 존재 이유가 사라진다.
#     → "버스트 5,000건 → RPC 1회" 가 깨져야 한다.
mutate "M1 매 관측 flush = 쓰기 폭주 회귀(1차 설계)" \
  's/  const lastFlush = lastFlushedAt\.get\(key\);\n  if \(lastFlush === undefined\) return true;/  return true;\n  const lastFlush = lastFlushedAt.get(key);\n  if (lastFlush === undefined) return true;/' \
  "  return true;
  const lastFlush"

# M2: 첫 관측을 즉시 내보내지 않는다 → 경보 임계 판정이 최대 30초 지연된다.
mutate "M2 첫 관측 즉시 flush 제거 = 경보 지연" \
  's/  if \(lastFlush === undefined\) return true;/  if (lastFlush === undefined) return false;/' \
  "if (lastFlush === undefined) return false;"

# M3: 누적 count 를 증가시키지 않는다 → 발생 횟수가 소실되고 임계 판정이 무너진다.
mutate "M3 count 누적 생략 = 발생 횟수 소실" \
  's/    existing\.count \+= 1;/    existing.count += 0;/' \
  "existing.count += 0;"

# M4: fingerprint 를 항상 null 로 → 같은 분의 서로 다른 오류가 한 행으로 뭉개진다(blocker 4 회귀).
mutate "M4 fingerprint 무력화 = 서로 다른 오류 뭉개짐" \
  's/  const fingerprint = fingerprintOf\(o\.errorMessage\);/  const fingerprint = null;/' \
  "  const fingerprint = null;"

# M5: 키에서 scope 를 뺀다 → 서로 다른 경기가 한 delta 로 합쳐진다.
#     ⚠️ perl 은 \Q..\E 안이라도 `${...}` 를 변수 deref 로 먼저 해석한다. 그래서 패턴에
#        `${` 가 들어가면 "syntax error near ??" 로 죽는다 → `$` 없는 조각만 앵커로 쓴다.
mutate "M5 키에서 scope 제거 = 경기별 분리 관측 소실" \
  's/\Qo.scope ?? ""\E/""/' \
  'u0000${""}'

# M6: 버퍼 상한 방어 제거 → 서로 다른 키가 무한히 쌓인다(메모리 누수).
mutate "M6 버퍼 상한 방어 제거 = 무한 누적" \
  's/  if \(pending\.size >= MAX_PENDING_KEYS\) return true;/  if (false) return true;/' \
  "  if (false) return true;"

# M7: drain 이 lastFlushedAt 을 갱신하지 않는다 → 주기 판정이 영원히 참이 돼 매번 flush.
mutate "M7 drain 이 flush 시각 미갱신 = 주기 판정 붕괴" \
  's/    lastFlushedAt\.set\(entry\.key, now\);//' \
  "  const out: FallbackDelta[] = [];"

# M8: 정책을 delta 에 싣지 않는다(하드코딩) → 서버 임계 판정이 호출부 정책을 무시한다.
mutate "M8 정책 전달 무시 = 서버 임계 판정 오류" \
  's/      threshold: o\.policy\.threshold,/      threshold: 999,/' \
  "      threshold: 999,"

cp "$TMP/orig.ts" "$SRC"

echo ""
echo "mutations: ${pass} RED, ${fail} MISS"
[[ $fail -eq 0 ]] || exit 1
