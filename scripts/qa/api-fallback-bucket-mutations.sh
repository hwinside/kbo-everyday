#!/usr/bin/env bash
# 결함주입 게이트 — api_fallback_events 버킷 계약이 "실제로 깨지면 RED 가 나는지" 증명한다.
#
# 배경(2026-08-20): 통과 로그(53 passed)는 게이트의 검증력을 증명하지 않는다. 이 PR 이 세운
# 계약 각각을 실제로 훼손했을 때 qa:api-fallback-alert-claim:db 가 반드시 실패해야 한다.
#
# 규칙(스스로 지킨다):
#  - 훼손 대상은 **production seam**(migration SQL)이며 테스트 파일은 건드리지 않는다.
#  - 훼손 결과는 **문법적으로 유효한 SQL** 이어야 한다. SQL 문법 오류로 나는 RED 는
#    "계약을 검출했다"가 아니라 "파일을 깨뜨렸다"일 뿐이다(1차 작성 시 M1·M3·M5 가 이 함정에
#    걸려 억지 RED 를 냈고, 확인 후 전부 재작성했다).
#  - 변이가 실제로 적용됐는지 grep 으로 증명한다. 미적용 변이는 false-MISS 를 만든다.
#
# 실행: bash scripts/qa/api-fallback-bucket-mutations.sh
set -uo pipefail

MIG="supabase/migrations/20260820000000_api_fallback_events_bucket.sql"
GATE="npx tsx scripts/qa/api-fallback-alert-claim-db-integration.ts"

if [[ ! -f "$MIG" ]]; then
  echo "FATAL: migration 대상 파일 없음: $MIG" >&2
  exit 2
fi

TMP="$(mktemp -d)"
trap 'cp "$TMP/orig.sql" "$MIG" 2>/dev/null || true; rm -rf "$TMP"' EXIT
cp "$MIG" "$TMP/orig.sql"

pass=0
fail=0

# $1=이름 $2=perl 치환식 $3=치환 적용 확인용 고정문자열(적용 후 존재해야 함)
mutate() {
  local name="$1" expr="$2" verify="$3"
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
    # SQL 문법/구문 오류로 죽은 RED 는 계약 검출이 아니다. 구분해서 보고한다.
    if grep -qiE 'syntax error|does not exist|no unique or exclusion constraint' "$TMP/out.log"; then
      echo "  ✗ $name — RED 이지만 SQL 오류 때문(계약 검출 아님)"
      fail=$((fail + 1))
    else
      echo "  ✓ $name — RED"
      pass=$((pass + 1))
    fi
  fi
}

echo "api-fallback bucket mutations:"

# M1: 버킷 폭을 1분 → 매 호출 고유(clock_timestamp)로 바꾼다. 문법은 유효하지만 사실상
#     1행/폴백이 복원된다 = 이 PR 이 고친 그 결함. → "같은 scope 50회 → DB 1행" RED.
mutate "M1 버킷 폭 소멸(1분 → 매 호출) = 폴링 증폭 재발" \
  "s/v_bucket := date_trunc\('minute', now\(\)\);/v_bucket := clock_timestamp();/" \
  "v_bucket := clock_timestamp();"

# M2: 창 집계를 sum(event_count) → count(*) 로 되돌린다. 같은 scope 가 1행이므로 임계 3에
#     영원히 도달하지 못한다 = 경보 영구 미발송(조용한 실패).
mutate "M2 임계 판정 sum(event_count) → count(*) = 경보 영구 미발송" \
  "s/select coalesce\(sum\(coalesce\(event_count, 1\)\), 0\) into v_count/select count(*) into v_count/" \
  "select count(*) into v_count"

# M3: dedupe 키에서 scope 를 제거한다. 인덱스 정의와 on conflict 를 **함께** 바꿔 SQL 유효성을
#     유지한다(한쪽만 바꾸면 문법이 아니라 제약 부재로 죽는다). → 경기별 분리 관측 소실.
mutate "M3 dedupe 키에서 scope 제거 = 경기별 분리 관측 소실" \
  "s/, coalesce\(scope, ''\), bucket_start/, bucket_start/g" \
  ", bucket_start)"

# M4: event_count 증가를 생략(항상 1) → 발생 횟수가 소실되고 임계 판정도 함께 무너진다.
mutate "M4 event_count 증가 생략 = 발생 횟수 소실" \
  "s/event_count = public\.api_fallback_events\.event_count \+ 1,/event_count = 1,/" \
  "event_count = 1,"

# M5: 버킷 행 id 반환을 끊는다(항상 null). outbox 의 pending_event_id 귀속이 사라져
#     alert_sent 마킹이 어떤 행에도 붙지 않는다 = 경보 감사 추적 소실.
mutate "M5 버킷 행 id 반환 끊김 = alert_sent 귀속 소실" \
  's/  return v_id;/  return null;/' \
  "  return null;"

# M6: 옛 8-인자 claim 시그니처 drop 을 없앤다 → scope 미전달 호출이 조용히 옛 경로로 떨어져
#     증폭이 계속되는데 아무도 모른다(fail-close 해제).
mutate "M6 옛 claim 시그니처 drop 제거 = 조용한 옛 경로 잔존" \
  "s/^drop function if exists public\.claim_api_fallback_alert\(text, text, int, text, int, int, int, int\);\$/-- drop removed by mutation M6/m" \
  "-- drop removed by mutation M6"

cp "$TMP/orig.sql" "$MIG"

echo ""
echo "mutations: ${pass} RED, ${fail} MISS"
[[ $fail -eq 0 ]] || exit 1
