#!/usr/bin/env bash
# 결함주입 게이트 — 뉴스클리핑 digest 정규화 계약이 "실제로 깨지면 RED 가 나는지" 증명한다.
#
# 배경: 통과 로그는 게이트의 검증력을 증명하지 않는다. 이 PR 이 세운 계약을 실제로
# 훼손했을 때 qa:news-clip-digest 가 반드시 실패해야 한다.
#
# 스스로 지키는 규칙 (2026-08-20 하루에 전부 한 번씩 당한 것들):
#  1. 훼손 대상은 production seam(src/types/news-clipping.ts, src/lib/news-clipping-digest-loader.ts).
#     테스트 파일은 안 건드린다.
#  2. 훼손 결과는 **컴파일 가능한 코드**여야 한다. 문법 오류 RED 는 계약 검출이 아니다.
#  3. 변이 적용 여부를 앵커로 증명한다(미적용 = false-MISS).
#  4. **앵커는 원본에 존재하면 안 된다.** 원본에도 있는 문자열을 앵커로 쓰면 변이 미적용인데도
#     "적용됨"으로 읽혀, 게이트 GREEN 을 "검출 실패"로 오보한다(#1259 M3 이 이 함정에 걸렸다).
#  5. **앵커는 반드시 한 줄이어야 한다.** `grep -F` 는 여러 줄 패턴을 OR 로 해석하므로
#     앵커에 개행이 들어가면 `}` 같은 흔한 조각 하나에 매칭돼 규칙 4 검사가 무력화된다.
#     → 변이마다 고유 마커 주석(`// mutation:MN`)을 심고 그것을 앵커로 쓴다.
#
# 실행: bash scripts/qa/news-clipping-digest-mutations.sh
set -uo pipefail

TYPES="src/types/news-clipping.ts"
LOADER="src/lib/news-clipping-digest-loader.ts"
GATE="npx tsx scripts/qa/news-clipping-digest-smoke.ts"

for f in "$TYPES" "$LOADER"; do
  [[ -f "$f" ]] || { echo "FATAL: 대상 파일 없음: $f" >&2; exit 2; }
done

TMP="$(mktemp -d)"
restore_all() {
  cp "$TMP/types.orig" "$TYPES" 2>/dev/null || true
  cp "$TMP/loader.orig" "$LOADER" 2>/dev/null || true
}
trap 'restore_all; rm -rf "$TMP"' EXIT
cp "$TYPES" "$TMP/types.orig"
cp "$LOADER" "$TMP/loader.orig"

pass=0
fail=0

# $1=이름 $2=대상파일 $3=perl 치환식 $4=변이 후에만 존재해야 하는 앵커
mutate() {
  local name="$1" target="$2" expr="$3" verify="$4"
  local orig
  case "$target" in
    "$TYPES") orig="$TMP/types.orig" ;;
    "$LOADER") orig="$TMP/loader.orig" ;;
    *) echo "  ✗ $name — 알 수 없는 대상 파일: $target"; fail=$((fail + 1)); return ;;
  esac

  # 규칙 4: 앵커가 원본(두 파일 어디든)에 이미 있으면 이 mutation 은 아무것도 증명하지 못한다.
  if grep -qF -- "$verify" "$TMP/types.orig" || grep -qF -- "$verify" "$TMP/loader.orig"; then
    echo "  ✗ $name — 앵커가 원본에도 존재(무의미한 검증) → mutation 설계 오류"
    fail=$((fail + 1))
    return
  fi

  restore_all
  perl -0pi -e "$expr" "$target"

  if ! grep -qF -- "$verify" "$target"; then
    echo "  ✗ $name — 변이 미적용(패턴 불일치) → 결과 신뢰 불가"
    fail=$((fail + 1))
    restore_all
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
  restore_all
}

echo "news-clipping digest mutations:"

# ── 렌더 계약 (types) ────────────────────────────────────────────────────
# M1: 통합 술어를 옛 정의(articles.length>0 요구)로 되돌린다.
#     = 이 PR 이 고쳐야 했던 그 함정. 신규 쪽지가 전부 일반 텍스트로 렌더된다.
mutate "M1 통합 술어가 ref 를 인정 안 함 = 신규 쪽지 렌더 실패" "$TYPES" \
  's/return isLegacyNewsClippingPayload\(p\) \|\| isRefNewsClippingPayload\(p\);/return isLegacyNewsClippingPayload(p); \/\/ mutation:M1/' \
  "// mutation:M1"

# M2: ref + digest 부재일 때 빈 카드를 반환한다(fail-close 해제).
#     → "오늘 기사 없음" 거짓 카드가 유저에게 나간다.
mutate "M2 digest 부재 시 빈 카드 반환 = 거짓 '기사 없음'" "$TYPES" \
  's/  if \(!digest \|\| !Array\.isArray\(digest\.articles\) \|\| digest\.articles\.length === 0\) return null;/  if (!digest) return { team_id: payload.team_id, team_name: payload.team_name, date: payload.date, overview: "", intro: payload.intro, articles: [] };/' \
  'articles: [] };'

# M3: legacy 렌더 경로를 죽인다 → 과거 쪽지 수백만 건이 텍스트로 떨어진다.
mutate "M3 legacy 렌더 경로 소실 = 과거 쪽지 전부 깨짐" "$TYPES" \
  's/  if \(isLegacyNewsClippingPayload\(payload\)\) \{/  if (false) {/' \
  "  if (false) {"

# M4: intro 를 view 로 전달하지 않는다 → 첫 수신 유저 인트로가 사라진다.
mutate "M4 intro 전달 누락 = 최초 수신 인트로 소실" "$TYPES" \
  's/      intro: payload\.intro,\n      articles: payload\.articles,/      intro: undefined,\n      articles: payload.articles,/' \
  "      intro: undefined,"

# M5: ref 판정이 digest_id 유효성을 안 본다(0/음수/문자열 통과).
mutate "M5 digest_id 유효성 미검사 = 쓰레기 참조 통과" "$TYPES" \
  's/  return typeof id === "number" && Number\.isFinite\(id\) && id > 0;\n\}/  return id !== undefined; \/\/ mutation:M5\n}/' \
  "// mutation:M5"

# M6: ref 의 team_name 을 digest 값으로 덮어쓴다(쪽지 발송 당시 사실 무시).
mutate "M6 team_name 을 digest 우선으로 = 발송 당시 사실 소실" "$TYPES" \
  's/    team_name: payload\.team_name \|\| digest\.team_name,/    team_name: digest.team_name,/' \
  "    team_name: digest.team_name,"

# ── 푸시 조회 계약 (삼순 blocker 2) ───────────────────────────────────────
# M7: 총평이 빌 때 preview 를 비운다 → 신규 발송에서도 push_preview 가 사라져
#     dispatch 가 per-DM digest 조회로 떨어진다(하루 27,208회).
mutate "M7 빈 총평 preview 미충전 = 신규 발송 조회 부활" "$TYPES" \
  's/  if \(!text\) return NEWS_CLIPPING_PUSH_PREVIEW_FALLBACK;/  if (!text) return ""; \/\/ mutation:M7/' \
  "// mutation:M7"

# M8: 미리보기 길이 상한을 없앤다 → 총평 전문이 payload 에 실려 정규화 용량 이득이 잠식된다.
mutate "M8 push_preview 길이 상한 제거 = 용량 이득 잠식" "$TYPES" \
  's/  return text\.length <= NEWS_CLIPPING_PUSH_PREVIEW_MAX/  return text; \/\/ mutation:M8\n  return text.length <= NEWS_CLIPPING_PUSH_PREVIEW_MAX/' \
  "// mutation:M8"

# M9 (blocker 2, 3차 핵심): 조회 여부를 버전이 아니라 preview 유무로만 판정하게 되돌린다.
#     → "신규인데 총평이 비어 preview 가 빈" 쪽지가 구형과 구분되지 않아 조회가 조용히 부활한다.
mutate "M9 조회 판정을 preview 유무로 회귀 = 신규 발송 조회 부활" "$TYPES" \
  's/  if \(typeof p\.v === "number" && p\.v >= 1\) return false;/  \/\/ mutation:M9/' \
  "// mutation:M9"

# M10: 구형 ref 의 폴백 조회까지 막는다 → 과거 참조형 쪽지 푸시가 기본 문구로 조용히 열화.
mutate "M10 구형 ref 폴백 조회 차단 = 과거 푸시 본문 소실" "$TYPES" \
  's/  return typeof p\.digest_id === "number" && Number\.isFinite\(p\.digest_id\) && p\.digest_id > 0;/  return false; \/\/ mutation:M10/' \
  "// mutation:M10"

# ── 로더 계약 (삼순 blocker 1) ────────────────────────────────────────────
# M11: 재시도 예약을 죽인다 = 2차 구현의 그 결함 그대로.
#      실패 후 타이머가 안 걸리면 조용한 대화는 영원히 텍스트로 남는다.
mutate "M11 재시도 스케줄 소실 = 1회 실패 후 영구 텍스트" "$LOADER" \
  's/  private scheduleRetry\(\): void \{/  private scheduleRetry(): void {\n    if (true) return; \/\/ mutation:M11/' \
  "// mutation:M11"

# M12: 부분 누락을 실패로 세지 않는다 → 못 받은 id 가 영원히 재시도 대상에서 빠지지 않고
#      무한 재시도로 돌거나(상한 무력화) 성공으로 오인된다.
mutate "M12 실패 카운트 미증가 = 시도 상한 무력화(무한 재시도)" "$LOADER" \
  's/      this\.attempts\.set\(id, \(this\.attempts\.get\(id\) \?\? 0\) \+ 1\);/      \/\/ mutation:M12/' \
  "// mutation:M12"

# M13: 이미 요청 중인 id 를 다시 요청한다 → 같은 digest 를 중복 조회한다.
mutate "M13 in-flight 중복 조회 허용 = 같은 digest 반복 요청" "$LOADER" \
  's/      if \(this\.inFlight\.has\(id\)\) continue;/      \/\/ mutation:M13/' \
  "// mutation:M13"

# M14: 요청하지 않은 행도 수용한다 → 응답 오염이 그대로 캐시에 들어간다.
mutate "M14 응답 오염 방어 해제 = 요청 안 한 digest 수용" "$LOADER" \
  's/      if \(!ids\.includes\(row\.id\)\) continue; \/\/ 요청하지 않은 행은 무시\(응답 오염 방어\)/      \/\/ mutation:M14/' \
  "// mutation:M14"

# M15: 시도 상한을 없앤다 → 실패가 계속되면 무한 재시도로 클라가 DB 를 두드린다.
mutate "M15 시도 상한 제거 = 무한 재시도" "$LOADER" \
  's/      if \(\(this\.attempts\.get\(id\) \?\? 0\) >= DIGEST_MAX_ATTEMPTS\) continue;/      \/\/ mutation:M15/' \
  "// mutation:M15"

# M16: dispose 가 예약된 재시도 타이머를 취소하지 않게 한다 → 화면을 떠난 뒤에도
#      백오프 타이머가 살아 DB 를 두드린다.
#      ⚠️ request()/pump() 의 disposed 가드는 **서로를 가려서** 한 겹만 지우면 결과가 안 변한다
#         (관측 불가 → 억지 RED 를 만들지 않는다). 실제로 관측되는 seam 은 타이머 취소다.
mutate "M16 dispose 가 재시도 타이머를 안 지움 = 언마운트 누수" "$LOADER" \
  's/    if \(this\.timer !== null\) \{\n      this\.clearTimeoutFn\(this\.timer\);\n      this\.timer = null;\n    \}/    \/\/ mutation:M16/' \
  "// mutation:M16"

restore_all

echo ""
echo "mutations: ${pass} RED, ${fail} MISS"
[[ $fail -eq 0 ]] || exit 1
