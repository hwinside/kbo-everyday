#!/usr/bin/env bash
# 결함주입 게이트 — 뉴스클리핑 digest 정규화 계약이 "실제로 깨지면 RED 가 나는지" 증명한다.
#
# 배경: 통과 로그는 게이트의 검증력을 증명하지 않는다. 이 PR 이 세운 계약을 실제로
# 훼손했을 때 qa:news-clip-digest 가 반드시 실패해야 한다.
#
# 스스로 지키는 규칙 (2026-08-20 하루에 전부 한 번씩 당한 것들):
#  1. 훼손 대상은 production seam(src/types/news-clipping.ts), 테스트 파일은 안 건드린다.
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

SRC="src/types/news-clipping.ts"
GATE="npx tsx scripts/qa/news-clipping-digest-smoke.ts"

[[ -f "$SRC" ]] || { echo "FATAL: 대상 파일 없음: $SRC" >&2; exit 2; }

TMP="$(mktemp -d)"
trap 'cp "$TMP/orig.ts" "$SRC" 2>/dev/null || true; rm -rf "$TMP"' EXIT
cp "$SRC" "$TMP/orig.ts"

pass=0
fail=0

# $1=이름 $2=perl 치환식 $3=변이 후에만 존재해야 하는 앵커
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

echo "news-clipping digest mutations:"

# M1: 통합 술어를 옛 정의(articles.length>0 요구)로 되돌린다.
#     = 이 PR 이 고쳐야 했던 그 함정. 신규 쪽지가 전부 일반 텍스트로 렌더된다.
mutate "M1 통합 술어가 ref 를 인정 안 함 = 신규 쪽지 렌더 실패" \
  's/return isLegacyNewsClippingPayload\(p\) \|\| isRefNewsClippingPayload\(p\);/return isLegacyNewsClippingPayload(p); \/\/ mutation:M1/' \
  "// mutation:M1"

# M2: ref + digest 부재일 때 빈 카드를 반환한다(fail-close 해제).
#     → "오늘 기사 없음" 거짓 카드가 유저에게 나간다.
mutate "M2 digest 부재 시 빈 카드 반환 = 거짓 '기사 없음'" \
  's/  if \(!digest \|\| !Array\.isArray\(digest\.articles\) \|\| digest\.articles\.length === 0\) return null;/  if (!digest) return { team_id: payload.team_id, team_name: payload.team_name, date: payload.date, overview: "", intro: payload.intro, articles: [] };/' \
  'articles: [] };'

# M3: legacy 렌더 경로를 죽인다 → 과거 쪽지 수백만 건이 텍스트로 떨어진다.
mutate "M3 legacy 렌더 경로 소실 = 과거 쪽지 전부 깨짐" \
  's/  if \(isLegacyNewsClippingPayload\(payload\)\) \{/  if (false) {/' \
  "  if (false) {"

# M4: intro 를 view 로 전달하지 않는다 → 첫 수신 유저 인트로가 사라진다.
mutate "M4 intro 전달 누락 = 최초 수신 인트로 소실" \
  's/      intro: payload\.intro,\n      articles: payload\.articles,/      intro: undefined,\n      articles: payload.articles,/' \
  "      intro: undefined,"

# M5: ref 판정이 digest_id 유효성을 안 본다(0/음수/문자열 통과).
mutate "M5 digest_id 유효성 미검사 = 쓰레기 참조 통과" \
  's/  return typeof id === "number" && Number\.isFinite\(id\) && id > 0;/  return id !== undefined;/' \
  "  return id !== undefined;"

# M6: ref 의 team_name 을 digest 값으로 덮어쓴다(쪽지 발송 당시 사실 무시).
mutate "M6 team_name 을 digest 우선으로 = 발송 당시 사실 소실" \
  's/    team_name: payload\.team_name \|\| digest\.team_name,/    team_name: digest.team_name,/' \
  "    team_name: digest.team_name,"

# M7 (삼순 blocker 2): push_preview 생성을 죽인다 → ref payload 에 푸시 본문이 안 실려
#     디스패처가 매번 digest 를 재조회하게 된다(하루 27,208회 추가 조회).
mutate "M7 push_preview 생성 무력화 = 푸시마다 digest 재조회" \
  's/  const text = \(overview \?\? ""\)\.trim\(\);/  return undefined; \/\/ mutation:M7\n  const text = (overview ?? "").trim();/' \
  "// mutation:M7"

# M8 (삼순 blocker 2): 미리보기 길이 상한을 없앤다 → 총평 전문이 payload 에 실려
#     정규화 용량 이득이 잠식된다.
mutate "M8 push_preview 길이 상한 제거 = 용량 이득 잠식" \
  's/  return text\.length <= NEWS_CLIPPING_PUSH_PREVIEW_MAX/  return text; \/\/ mutation:M8\n  return text.length <= NEWS_CLIPPING_PUSH_PREVIEW_MAX/' \
  "// mutation:M8"

cp "$TMP/orig.ts" "$SRC"

echo ""
echo "mutations: ${pass} RED, ${fail} MISS"
[[ $fail -eq 0 ]] || exit 1
