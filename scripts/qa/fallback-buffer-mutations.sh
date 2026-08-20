#!/usr/bin/env bash
# 결함주입 게이트 — delta 버퍼가 "쓰기 횟수를 실제로 줄이면서 delta 를 잃지 않는가" 계약이
# 깨지면 RED 가 나는지 증명한다.
#
# 배경(2026-08-20):
#  - 삼순 1차 blocker 1: 이벤트마다 UPSERT 라 행 수만 줄고 쓰기 횟수·WAL 은 그대로였다.
#  - 삼순 2차 blocker 2: 임계 3건이 오고 멈추면 경보가 안 나갔다(타이머 없는 버퍼).
#  - 삼순 2차 blocker 3: drain 이 pending 을 지워 RPC 실패 시 delta 가 증발했다.
# 이 회귀들이 조용히 돌아오면 이 게이트가 반드시 죽어야 한다.
#
# 규칙 (2026-08-20 하루에 전부 한 번씩 당한 것들):
#  1. 훼손 대상은 production seam(src/lib/monitoring/fallback-buffer.ts), 테스트는 안 건드린다.
#  2. 훼손 결과는 컴파일 가능해야 한다. 문법 오류 RED 는 계약 검출이 아니다.
#  3. 변이 적용 여부를 앵커로 증명한다(미적용 = false-MISS).
#  4. **앵커는 원본에 존재하면 안 된다.** 원본에도 있는 문자열을 앵커로 쓰면 미적용인데도
#     "적용됨"으로 읽혀 GREEN 을 "검출 실패"로 오보한다(#1259 M3 이 이 함정에 걸렸다).
#  5. **앵커는 한 줄이어야 한다.** grep -F 는 여러 줄 패턴을 OR 로 해석하므로 개행이 들어가면
#     흔한 조각 하나에 매칭돼 규칙 4 검사가 무력화된다 → 고유 마커 주석을 앵커로 쓴다.
#  6. perl 은 패턴 안의 `${` 를 변수 deref 로 먼저 해석한다. 치환식에 `${` 를 넣지 않는다.
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

  # 규칙 4: 앵커가 원본에 이미 있으면 이 mutation 은 아무것도 증명하지 못한다.
  if grep -qF -- "$verify" "$TMP/orig.ts"; then
    echo "  ✗ $name — 앵커가 원본에도 존재(무의미한 검증) → mutation 설계 오류"
    fail=$((fail + 1))
    return
  fi

  cp "$TMP/orig.ts" "$SRC"
  perl -0pi -e "$expr" "$SRC"

  if ! grep -qF -- "$verify" "$SRC"; then
    echo "  ✗ $name — 변이 미적용(패턴 불일치) → 결과 신뢰 불가"
    fail=$((fail + 1))
    cp "$TMP/orig.ts" "$SRC"
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
  cp "$TMP/orig.ts" "$SRC"
}

echo "fallback buffer mutations:"

# ── 쓰기 감소 계약 ────────────────────────────────────────────────────────
# M1: 매 관측마다 flush = 1차 설계로 회귀. 이 PR 의 존재 이유가 사라진다.
mutate "M1 매 관측 flush = 쓰기 폭주 회귀(1차 설계)" \
  's/export function observeFallback\(o: FallbackObservation\): boolean \{/export function observeFallback(o: FallbackObservation): boolean {\n  if (true) { fingerprintOf(o.errorMessage); return true; } \/\/ mutation:M1/' \
  "// mutation:M1"

# M2 (삼순 2차 blocker 2): 임계까지 즉시 durable 을 없앤다 → 임계 3건이 오고 멈추면
#     경보가 "다음 관측"까지 안 나간다. 장애가 끝난 순간이 곧 경보가 필요한 순간이다.
mutate "M2 임계까지 즉시 durable 제거 = 경보 지연/누락" \
  's/  if \(confirmed \+ buffered <= o\.policy\.threshold\) return true;/  \/\/ mutation:M2/' \
  "// mutation:M2"

# M3: 누적 count 를 증가시키지 않는다 → 발생 횟수가 소실되고 임계 판정이 무너진다.
mutate "M3 count 누적 생략 = 발생 횟수 소실" \
  's/    existing\.count \+= 1;/    existing.count += 0; \/\/ mutation:M3/' \
  "// mutation:M3"

# M4: fingerprint 를 항상 null 로 → 같은 분의 서로 다른 오류가 한 행으로 뭉개진다.
mutate "M4 fingerprint 무력화 = 서로 다른 오류 뭉개짐" \
  's/  const fingerprint = fingerprintOf\(o\.errorMessage\);/  const fingerprint = null; \/\/ mutation:M4/' \
  "// mutation:M4"

# M5: 키에서 scope 를 뺀다 → 서로 다른 경기가 한 delta 로 합쳐진다.
mutate "M5 키에서 scope 제거 = 경기별 분리 관측 소실" \
  's/function keyOf\(o: FallbackObservation, fingerprint: string \| null\): string \{/function keyOf(o: FallbackObservation, fingerprint: string | null): string {\n  \/\/ mutation:M5\n  return [o.apiName, o.reason, fingerprint ?? "", o.claim ? "c" : "r"].join("\\u0000");/' \
  "// mutation:M5"

# M6: 버퍼 상한 방어 제거 → 서로 다른 키가 무한히 쌓인다(메모리 누수).
mutate "M6 버퍼 상한 방어 제거 = 무한 누적" \
  's/  if \(pending\.size >= MAX_PENDING_KEYS\) return true;/  \/\/ mutation:M6/' \
  "// mutation:M6"

# M7: 처음 보는 키에 flush 신호를 안 준다 → 한 번 놓친 키가 주기까지 갇힌다.
mutate "M7 미flush 키 갇힘 = 재시도 신호 소실" \
  's/  if \(lastFlush === undefined\) return true;/  if (lastFlush === undefined) return false; \/\/ mutation:M7/' \
  "// mutation:M7"

# M8: 정책을 delta 에 싣지 않는다(하드코딩) → 서버 임계 판정이 호출부 정책을 무시한다.
mutate "M8 정책 전달 무시 = 서버 임계 판정 오류" \
  's/      threshold: o\.policy\.threshold,/      threshold: 999, \/\/ mutation:M8/' \
  "// mutation:M8"

# ── take/ack/requeue 계약 (삼순 2차 blocker 3) ────────────────────────────
# M9: RPC 실패 복원을 죽인다 → 실패한 delta 가 그대로 증발한다(종전 결함 그대로).
mutate "M9 requeue 미복원 = RPC 실패 시 delta 증발" \
  's/export function requeueFallbackFlush\(deltas: FallbackDelta\[\]\): void \{/export function requeueFallbackFlush(deltas: FallbackDelta[]): void {\n  if (true) { inFlight.clear(); return; } \/\/ mutation:M9/' \
  "// mutation:M9"

# M10: take 가 in-flight 로 옮기지 않는다 → requeue 가 복원할 것이 없다(증발과 동치).
#      ⚠️ `prev` 를 undefined 로 바꾸는 변이는 else 분기가 그대로 등록해 **결과가 안 변한다**
#         (관측 불가 → 억지 RED 를 만들지 않는다). 실제 seam 은 등록 자체다.
mutate "M10 take 가 in-flight 미등록 = 복원 불가" \
  's/    else inFlight\.set\(entry\.key, \{ \.\.\.entry \}\);/    else { \/\* mutation:M10 \*\/ }/' \
  "/* mutation:M10 */"

# M11: ack 이 durable 카운트를 안 올린다 → 영원히 임계 미달로 읽혀 매 관측이 즉시 flush.
#      (쓰기 감소가 통째로 무효화되는데 로그상으로는 아무 일도 없다.)
mutate "M11 ack 이 durable 카운트 미갱신 = 쓰기 감소 무효화" \
  's/    durableCount\.set\(key, \(durableCount\.get\(key\) \?\? 0\) \+ entry\.count\);/    \/\/ mutation:M11/' \
  "// mutation:M11"

# M12: ack 이 성공 시각을 안 남긴다 → 주기 판정이 항상 참이 돼 매번 flush.
mutate "M12 ack 이 flush 시각 미갱신 = 주기 판정 붕괴" \
  's/    lastFlushedAt\.set\(key, now\);/    \/\/ mutation:M12/' \
  "// mutation:M12"

# M13: take 가 pending 을 안 비운다 → 같은 delta 가 반복 전송된다(중복 카운트).
mutate "M13 take 후 pending 미정리 = 중복 전송" \
  's/  pending\.clear\(\);\n  return out;/  \/\/ mutation:M13\n  return out;/' \
  "// mutation:M13"

cp "$TMP/orig.ts" "$SRC"

echo ""
echo "mutations: ${pass} RED, ${fail} MISS"
[[ $fail -eq 0 ]] || exit 1
