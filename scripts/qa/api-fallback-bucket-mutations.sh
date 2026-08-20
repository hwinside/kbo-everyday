#!/usr/bin/env bash
# 결함주입 게이트 — api_fallback_events 버킷/flush 계약이 "실제로 깨지면 RED 가 나는지" 증명한다.
#
# 배경(2026-08-20): 통과 로그는 게이트의 검증력을 증명하지 않는다. 이 PR 이 세운 계약을
# 실제로 훼손했을 때 qa:api-fallback-alert-claim:db 가 반드시 실패해야 한다.
#
# 스스로 지키는 규칙 (전부 실제로 한 번씩 당한 것들이다):
#  1. 훼손 대상은 production seam(migration SQL)이며 테스트 파일은 건드리지 않는다.
#  2. 훼손 결과는 **문법적으로 유효한 SQL** 이어야 한다. SQL 오류로 나는 RED 는 "계약을
#     검출했다"가 아니라 "파일을 깨뜨렸다"일 뿐이다. → 러너가 SQL 오류 RED 를 MISS 로 잡는다.
#  3. 변이가 실제로 적용됐는지 앵커로 증명한다. 미적용 변이는 false-MISS 를 만든다.
#  4. **그 앵커는 원본에 존재하면 안 된다.** 원본에도 있는 문자열을 앵커로 쓰면 변이가
#     적용되지 않았는데도 "적용됨"으로 읽혀 게이트 GREEN 을 "검출 실패"로 오보한다.
#     (1차 작성에서 M3 이 정확히 이 함정에 걸렸다 — 앵커 `, bucket_start)` 가 원본에도 있었다.)
#
# 실행: bash scripts/qa/api-fallback-bucket-mutations.sh
set -uo pipefail

MIG="supabase/migrations/20260820000000_api_fallback_events_bucket.sql"
GATE="npx tsx scripts/qa/api-fallback-alert-claim-db-integration.ts"

[[ -f "$MIG" ]] || { echo "FATAL: migration 대상 파일 없음: $MIG" >&2; exit 2; }

TMP="$(mktemp -d)"
trap 'cp "$TMP/orig.sql" "$MIG" 2>/dev/null || true; rm -rf "$TMP"' EXIT
cp "$MIG" "$TMP/orig.sql"

pass=0
fail=0

# $1=이름 $2=perl 치환식 $3=변이 후에만 존재해야 하는 앵커
mutate() {
  local name="$1" expr="$2" verify="$3"

  # 규칙 4: 앵커가 원본에 이미 있으면 이 mutation 은 아무것도 증명하지 못한다.
  if grep -qF -- "$verify" "$TMP/orig.sql"; then
    echo "  ✗ $name — 앵커가 원본에도 존재(무의미한 검증) → mutation 설계 오류"
    fail=$((fail + 1))
    return
  fi

  cp "$TMP/orig.sql" "$MIG"
  perl -0pi -e "$expr" "$MIG"

  if ! grep -qF -- "$verify" "$MIG"; then
    echo "  ✗ $name — 변이 미적용(패턴 불일치) → 결과 신뢰 불가"
    fail=$((fail + 1))
    return
  fi

  if $GATE > "$TMP/out.log" 2>&1; then
    echo "  ✗ $name — 훼손했는데 게이트 GREEN (검출 실패)"
    fail=$((fail + 1))
  else
    if grep -qiE 'syntax error|does not exist|no unique or exclusion constraint|ambiguous' "$TMP/out.log"; then
      echo "  ✗ $name — RED 이지만 SQL 오류 때문(계약 검출 아님)"
      fail=$((fail + 1))
    else
      echo "  ✓ $name — RED"
      pass=$((pass + 1))
    fi
  fi
}

echo "api-fallback bucket mutations:"

# M1: 버킷 폭을 1분 → 매 호출 고유로. 문법은 유효하지만 사실상 1행/flush 가 복원된다.
mutate "M1 버킷 폭 소멸(1분 → 매 호출) = 증폭 재발" \
  "s/v_bucket := date_trunc\('minute', now\(\)\);/v_bucket := clock_timestamp();/" \
  "v_bucket := clock_timestamp();"

# M2: 창 집계를 sum(event_count) → count(*) 로. 같은 키가 1행이라 임계 도달 불가 = 경보 영구 미발송.
mutate "M2 임계 판정 sum(event_count) → count(*) = 경보 영구 미발송" \
  "s/select coalesce\(sum\(coalesce\(ev\.event_count, 1\)\), 0\) into v_count/select count(*)::bigint into v_count/" \
  "select count(*)::bigint into v_count"

# M3: dedupe 키에서 scope 를 제거. 인덱스와 on conflict 를 **함께** 바꿔 SQL 유효성 유지.
#     앵커는 변이 후에만 나타나는 형태여야 한다(규칙 4).
mutate "M3 dedupe 키에서 scope 제거 = 경기별 분리 관측 소실" \
  "s/coalesce\(scope, ''\), coalesce\(fingerprint, ''\)/coalesce(fingerprint, '')/g" \
  "reason, coalesce(fingerprint, ''), bucket_start"

# M4: dedupe 키에서 fingerprint 를 제거 → 같은 분의 서로 다른 오류가 한 행으로 뭉개진다(blocker 4).
mutate "M4 dedupe 키에서 fingerprint 제거 = 서로 다른 오류 뭉개짐" \
  "s/coalesce\(scope, ''\), coalesce\(fingerprint, ''\)/coalesce(scope, '')/g" \
  "reason, coalesce(scope, ''), bucket_start"

# M5: event_count 누적을 무시(항상 1) → batch count 가 소실되고 임계 판정도 무너진다.
mutate "M5 batch count 누적 무시 = 발생 횟수 소실" \
  "s/      event_count = public\.api_fallback_events\.event_count\n                    \+ greatest\(coalesce\(\(e->>'count'\)::int, 1\), 1\),/      event_count = 1,/" \
  "      event_count = 1,"

# M6: 신규 insert 시 count 를 무시하고 1 로 고정 → 첫 flush 의 batch 량이 통째로 사라진다.
mutate "M6 신규 버킷이 batch count 무시 = 첫 flush 량 소실" \
  "s/       greatest\(coalesce\(\(e->>'count'\)::int, 1\), 1\), false\)/       1, false)/" \
  "       1, false)"

# M7: EXPAND 계약 파기 — 옛 8-인자 wrapper 를 없앤다. 배포 순서 어느 쪽이든 창이 생긴다(blocker 2).
mutate "M7 옛 8-인자 wrapper 제거 = 배포 창 취약(EXPAND 파기)" \
  "s/^create or replace function public\.claim_api_fallback_alert\(\$/create or replace function public.removed_claim_wrapper(/m" \
  "public.removed_claim_wrapper("

# M8: 집계 RPC 가 occurrences 를 row count 로 반환 → 리포트가 "장애 줄었다" 오보를 낸다(blocker 3).
mutate "M8 집계 RPC 가 row count 반환 = 리포트 오보" \
  "s/    sum\(coalesce\(ev\.event_count, 1\)\)::bigint as occurrences,/    count(*)::bigint as occurrences,/" \
  "    count(*)::bigint as occurrences,"

cp "$TMP/orig.sql" "$MIG"

echo ""
echo "mutations: ${pass} RED, ${fail} MISS"
[[ $fail -eq 0 ]] || exit 1
