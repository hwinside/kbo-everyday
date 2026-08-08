#!/usr/bin/env bash
# 거절·범위 안내 게이트의 **검출력 증명**.
#
# 게이트가 PASS 하는 것만으로는 아무것도 증명되지 않는다 — 대상 로직을 망가뜨렸을 때
# RED 가 되어야 비로소 그 게이트가 무언가를 지키고 있다는 뜻이다.
#
# ⚠️ 복원은 `git checkout --` 을 쓰지 않는다(AGENTS.md P0). 파일 백업 → 복사로 되돌리고,
#   매 변이마다 sha256 을 대조해 복원 실패 시 즉시 중단한다(#1127 에서 복원 누락이
#   오염된 소스를 그대로 커밋시킨 사고가 있었다).
set -uo pipefail
cd "$(dirname "$0")/../.."

# ⚠️ 게이트가 **둘**인 이유 (자체 발견 2026-08-08).
#
# 답변측 검증(`answerInQuestionScope`)은 refusal-scope 게이트가 안 태운다 — 그 게이트는
# 거절 문구·라우팅 계약이 대상이고, 답변 폐기 축은 team-fullname-routing 게이트가 갖고 있다.
# 그걸 모르고 M20~M22 를 refusal-scope 하나로만 판정했더니 전부 GREEN 이 떴고, 그건
# "게이트가 못 잡았다"가 아니라 **내가 엉뚱한 게이트에 물었다**는 뜻이었다.
#
# 변이가 어느 계약을 건드리는지에 따라 판정 게이트를 붙인다. 둘 중 **하나라도 RED** 면
# 그 변이는 잡힌 것이다(계약이 그 게이트에 있다는 뜻).
GATE="npx tsx scripts/qa/genius-refusal-scope-smoke.ts"
GATE_ANSWER="npx tsx scripts/qa/team-fullname-routing-smoke.ts"
FILES=(
  "src/lib/baseball-qa/pipeline.ts"
  "src/lib/constants/baseball-genius.ts"
  "src/lib/baseball-qa/gemini-request.ts"
)
BACKUP_DIR="$(mktemp -d)"
SHA_FILE="$BACKUP_DIR/.orig.sha"
for f in "${FILES[@]}"; do
  mkdir -p "$BACKUP_DIR/$(dirname "$f")"
  cp "$f" "$BACKUP_DIR/$f"
done
# bash 3.2(맥 기본)에는 연관배열이 없다 — sha 목록을 파일로 들고 대조한다.
shasum -a 256 "${FILES[@]}" > "$SHA_FILE"

restore() {
  for f in "${FILES[@]}"; do
    cp "$BACKUP_DIR/$f" "$f"
  done
  # 복원 실패를 조용히 넘기면 오염된 소스가 그대로 커밋된다(#1127 실제 사고).
  if ! shasum -a 256 -c "$SHA_FILE" >/dev/null 2>&1; then
    echo "FATAL 복원 실패 (sha 불일치) — 중단한다"
    exit 2
  fi
}
trap restore EXIT

fail=0
mutate() {
  local name="$1"; shift
  "$@"
  if $GATE >/dev/null 2>&1; then
    echo "GREEN(검출실패) $name"
    fail=1
  else
    echo "RED $name"
  fi
  restore
}

# 답변측 검증 계약(`answerInQuestionScope`·프롬프트 문맥 강제)을 건드리는 변이 전용.
# 두 게이트 중 하나라도 RED 면 잡힌 것이다.
mutate_answer() {
  local name="$1"; shift
  "$@"
  if $GATE >/dev/null 2>&1 && $GATE_ANSWER >/dev/null 2>&1; then
    echo "GREEN(검출실패) $name"
    fail=1
  else
    echo "RED $name"
  fi
  restore
}

echo "=== genius refusal scope mutation RED 증명 ==="

# M1 거절 문구를 구범위로 되돌린다 (이 PR 이 고친 그 사고)
mutate "M1  거절 문구를 구범위(룰/용어만)로 되돌림" \
  perl -0pi -e 's/저는 야구 이야기만 답해드릴 수 있어요[^"]*/야구 룰\/용어에 대한 질문만 답할 수 있어요. 예: /' src/lib/constants/baseball-genius.ts

# M2 범위어 하나만 누락시킨다 (전부 지우는 것보다 잡기 어렵다)
#
# ⚠️ 문구의 앞뒤 조사까지 패턴에 넣었더니 문구를 다듬는 순간 no-op 이 됐다(자체 발견).
#   변이는 **범위어 그 자체**만 노려서 문구 표현과 무관하게 성립해야 한다.
#   그래서 치환 전에 대상 존재를, 치환 후에 실제 변경을 각각 확인한다.
grep -q "최근 소식" src/lib/constants/baseball-genius.ts || {
  echo "FATAL M2 대상('최근 소식')이 문구에 없다 — 변이가 무의미하다"; exit 2; }
mutate "M2  거절 문구에서 범위어 '최근 소식' 만 제거" \
  perl -0pi -e 's/(BASEBALL_GENIUS_FALLBACK_ANSWER =\s*\n\s*")([^"]*)/$1 . ($2 =~ s|, 최근 소식||r)/e' src/lib/constants/baseball-genius.ts

# M3 SSOT 표에서 news_rag 범위어를 지운다 → 문구는 그대로여도 대조가 무의미해진다
mutate "M3  SSOT 표에서 news_rag 범위어 제거" \
  perl -0pi -e 's/  news_rag: "최근 소식",\n//' src/lib/constants/baseball-genius.ts

# M4 범위 안내 답변을 되묻기로 되돌린다 (라우팅은 살아있고 문구만 바뀜)
mutate "M4  범위 안내를 UNCLEAR 되묻기로 교체" \
  perl -0pi -e 's/route === "scope_guide" \? SCOPE_GUIDE_ANSWER :/route === "scope_guide" ? UNCLEAR_ANSWER :/' src/lib/baseball-qa/pipeline.ts

# M5 라우팅 자체를 제거 (`야구 룰` 이 다시 unsure 로 떨어진다)
mutate "M5  scope_guide 라우팅 제거" \
  perl -0pi -e 's/  if \(isScopeAskPhrase\(question\)\) return "scope_guide";\n//' src/lib/baseball-qa/pipeline.ts

# M6 판정을 항상 false — 라우팅 코드는 남아있지만 아무것도 안 잡는다
mutate "M6  isScopeAskPhrase 상시 false" \
  perl -0pi -e 's/  return sawMeta && !sawRemainder;/  return false;/' src/lib/baseball-qa/pipeline.ts

# M7 판정을 상시 true — 과차단(진짜 질문까지 안내문으로 덮음). 반대 방향 검출력.
mutate "M7  isScopeAskPhrase 상시 true (과차단)" \
  perl -0pi -e 's/  return sawMeta && !sawRemainder;/  return true;/' src/lib/baseball-qa/pipeline.ts

# M8 "남은 게 있는지" 검사를 지운다 = 사실상 substring 매칭으로 퇴화 → 과차단
mutate "M8  잔여 토큰 검사 제거 (substring 퇴화)" \
  perl -0pi -e 's/  return sawMeta && !sawRemainder;/  return sawMeta;/' src/lib/baseball-qa/pipeline.ts

# M9 조사 처리를 무력화 → `룰은`·`뭐가있어` 의 자수기를 못 떼어 되묻기가 진짜 질문으로 보인다
#
# ⚠️ 처음엔 `stripParticles` 를 노렸는데 그 함수는 **반증 불가능한 죽은 코드**였다
#   (통째로 무력화해도 15케이스 전수 결과 동일) → 소스에서 제거하고, 실제로 살아있는
#   `isParticleOnly` 를 노린다. 변이가 no-op 이면 GREEN 은 "게이트가 못 잡았다"가
#   아니라 "노린 코드가 없다"는 뜻이므로, 대상 존재부터 확인한다.
grep -q "function isParticleOnly" src/lib/baseball-qa/pipeline.ts || {
  echo "FATAL M9 대상(isParticleOnly)이 소스에 없다 — 변이가 무의미하다"; exit 2; }
mutate "M9  조사 잔여 판정(isParticleOnly) 무력화" \
  perl -0pi -e 's/function isParticleOnly\(residue: string\): boolean \{/function isParticleOnly(residue: string): boolean {\n  return residue === "";/' src/lib/baseball-qa/pipeline.ts

# M10 꺼풀 목록을 비운다 → 모든 문장에 잔여가 남아 안내문이 안 나간다
mutate "M10 꺼풀 정규식을 매칭 불가로" \
  perl -0pi -e 's/const SCOPE_FILLER_RE = new RegExp\(/const SCOPE_FILLER_RE = new RegExp("(?!)" ? "(?!)" : (/' src/lib/baseball-qa/pipeline.ts

# M11 결정론 경로가 LLM 을 태우게 만든다 (토큰 낭비 + 문구 흔들림)
mutate "M11 범위 안내를 LLM 경로로 흘림" \
  perl -0pi -e 's/  if \(isScopeAskPhrase\(question\)\) return "scope_guide";/  if (isScopeAskPhrase(question)) return "llm_scope_gate";/' src/lib/baseball-qa/pipeline.ts

# M12 감사 축을 도로 접는다 — `scope_guide` 를 `ack` 로 기록하면 범위 안내를 셀 수 없다
#    (삼순 2026-08-08 조건 ④. DB CHECK 은 migration 이 열어놨으니 운영은 안 죽지만,
#     대신 이 PR 이 고친 것을 사후에 측정할 방법이 사라진다.)
mutate "M12 scope_guide 를 ack 으로 접어 기록" \
  perl -0pi -e 's/await deps\.log\(\{ userId, question, questionNorm, matchPath: route, answer, inputTokens: null, outputTokens: null \}\);/await deps.log({ userId, question, questionNorm, matchPath: route === "scope_guide" ? "ack" : route, answer, inputTokens: null, outputTokens: null });/' src/lib/baseball-qa/pipeline.ts

# M13 판정 프롬프트를 구계약으로 되돌린다 (unsure 42% 의 원인)
# ⚠️ 자체 발견 2건: ①소스가 전각 물결(U+FF5E)이라 ASCII `~` 로 쓰면 치환이 no-op
#   ②`-CSD` 를 주면 입력만 디코드되고 명령행 패턴은 바이트라 역시 no-op.
#   변이 스크립트의 no-op 은 "게이트가 못 잡았다"로 위장된다 — RED 가 안 뜨면
#   게이트를 의심하기 전에 치환이 실제로 일어났는지부터 본다.
mutate "M13 판정 프롬프트를 룰/용어 한정으로 되돌림" \
  perl -0pi -e 's/범위 안인지 확실하지 않으면/야구 룰\/용어인지 확실하지 않으면/' src/lib/baseball-qa/gemini-request.ts

# M14 안내문에서 예시를 전부 제거 (범위만 나열하면 유저가 다음 행동을 못 한다)
#
# ⚠️ 자체 발견 2건: ①문구 첫머리("예를 들어")를 앵커로 썼더니 문구를 다듬자 no-op
#   ②백슬래시-따옴표를 셸·perl 양쪽에서 이스케이프하려다 패턴이 깨져 또 no-op.
#   그래서 앵커는 **형태**(이스케이프된 따옴표 쌍)로 두고, 셸 인용 지옥을 피하려고
#   `\x22`(따옴표) 16진 표기를 쓴다. 변이 후 실제 변경 여부를 직접 확인한다.
mutate "M14 범위 안내문에서 예시 제거" \
  perl -0pi -e 's/(SCOPE_GUIDE_ANSWER =)(.*?);/my($a,$b)=($1,$2); $b =~ s{\\\x22[^\\\x22]*\\\x22}{}g; $a.$b.";"/es' src/lib/baseball-qa/pipeline.ts

# M15 감사 인사를 범위 안내가 삼키게 만든다 (경계 침범).
#
# ⚠️ 처음엔 "scope_guide 를 ack 보다 앞에 둔다"로 썼는데 **동등변이**였다 — 두 집합이
#   안 겹쳐서 순서를 바꿔도 결과가 같다. 순서가 아니라 **집합이 겹치게** 만들어야
#   경계 계약을 실제로 건드린다.
mutate "M15 감사 인사(고마워)를 범위 되묻기 집합에 포함" \
  perl -0pi -e 's/  "너", "니", "봇", "야잘알봇", "답변", "대답",/  "너", "니", "봇", "야잘알봇", "답변", "대답", "고마워", "감사",/' src/lib/baseball-qa/pipeline.ts

# M16 한 글자 꺼풀을 다시 **조각 치환**으로 되돌린다 → `야수가`·`볼이` 가 통째로 녹아 과차단.
#     (삼순 2026-08-08 조건 ② 의 그 결함. 이 PR 이 고친 것을 정확히 되돌리는 변이다.)
grep -q "SCOPE_ASK_FILLERS_SINGLE" src/lib/baseball-qa/pipeline.ts || {
  echo "FATAL M16 대상(SCOPE_ASK_FILLERS_SINGLE)이 소스에 없다 — 변이가 무의미하다"; exit 2; }
mutate "M16 한 글자 꺼풀을 부분문자열로 치환 (볼·야수 과차단 재현)" \
  perl -0pi -e 's/    if \(SCOPE_SINGLE_FILLER_SET\.has\(token\)\) continue;/    token = token.split("야").join("").split("수").join("").split("볼").join("");/' src/lib/baseball-qa/pipeline.ts

# M17 메타어를 **선언 순서**로 떼도록 되돌린다 → `프로야구` 가 `프로` 잔여를 남겨 누락.
grep -q "SCOPE_META_WORDS_LONGEST_FIRST" src/lib/baseball-qa/pipeline.ts || {
  echo "FATAL M17 대상(SCOPE_META_WORDS_LONGEST_FIRST)이 소스에 없다 — 변이가 무의미하다"; exit 2; }
mutate "M17 메타어를 선언 순서로 제거 (프로야구 규칙 누락 재현)" \
  perl -0pi -e 's/    for \(const meta of SCOPE_META_WORDS_LONGEST_FIRST\) \{/    for (const meta of SCOPE_META_WORDS) {/' src/lib/baseball-qa/pipeline.ts

# M18 시스템 오류를 다시 범위밖 문구로 되돌린다 (우리 실패를 유저 질문 탓으로 돌리는 그 사고)
#
# ⚠️ 자체 발견: 처음엔 `settle(UNCLEAR_ANSWER, "error")` 를 노렸는데, 그 사이 오류 경로가
#   `SYSTEM_ERROR_ANSWER` 로 바뀌어 **패턴이 소스에 없었다**. 치환이 안 일어나면 게이트는
#   당연히 GREEN 이고, 그건 "검출 실패" 로 위장된다. 그래서 대상 존재부터 확인한다.
grep -q "export const SYSTEM_ERROR_ANSWER" src/lib/baseball-qa/pipeline.ts || {
  echo "FATAL M18 대상(SYSTEM_ERROR_ANSWER)이 소스에 없다 — 변이가 무의미하다"; exit 2; }
mutate "M18 오류 전용 문구를 BLOCKED 로 되돌림" \
  perl -0pi -e 's/export const SYSTEM_ERROR_ANSWER = BASEBALL_GENIUS_SYSTEM_ERROR_ANSWER;/export const SYSTEM_ERROR_ANSWER = BASEBALL_GENIUS_FALLBACK_ANSWER;/' src/lib/baseball-qa/pipeline.ts

# M19 시스템 오류와 이해못함을 **한 문구로 합친다** — 삼순 2026-08-08 ① 이 지적한 그 상태.
#     유저는 우리 장애를 "질문을 못 알아들었다" 로 듣고 멀쩡한 문장을 고쳐 쓴다.
mutate "M19 오류 문구를 UNCLEAR 와 동일하게 (3분기 → 2분기 퇴화)" \
  perl -0pi -e 's/export const SYSTEM_ERROR_ANSWER = BASEBALL_GENIUS_SYSTEM_ERROR_ANSWER;/export const SYSTEM_ERROR_ANSWER = BASEBALL_GENIUS_UNCLEAR_ANSWER;/' src/lib/baseball-qa/pipeline.ts

# M20 답변측 고정밀 앵커를 지운다 → 구단·선수 정상 답변이 다시 폐기된다(이 PR 이 고친 병목).
grep -q "ANSWER_SCOPE_ANCHORS" src/lib/baseball-qa/pipeline.ts || {
  echo "FATAL M20 대상(ANSWER_SCOPE_ANCHORS)이 소스에 없다 — 변이가 무의미하다"; exit 2; }
mutate_answer "M20 답변측 앵커 무력화 (구단·선수 답변 재폐기)" \
  perl -0pi -e 's/    ANSWER_SCOPE_ANCHORS\.some\(\(word\) => matchesAnswerAnchor\(tokens, word\)\);/    false;/' src/lib/baseball-qa/pipeline.ts

# M21 주제이탈 denylist 를 **AND 가 아니라 무시**하게 만든다 → `LG 티켓 가격` 이 다시 통과.
#     삼순이 반대가설로 제시한 그 경로다.
mutate_answer "M21 주제이탈 denylist 우회 (질문 신호 단독 bypass 재현)" \
  perl -0pi -e 's/  if \(ANSWER_OFF_TOPIC\.test\(normalized\)\) return false;//' src/lib/baseball-qa/pipeline.ts

# M22 프롬프트의 야구 문맥 강제를 제거한다 → 축약 답변 fail-close 를 상쇄할 근거가 사라진다.
mutate_answer "M22 프롬프트의 답변 문맥 명시 강제 제거" \
  perl -0pi -e 's/답변 첫 문장에는 이 답이 야구 이야기임이 드러나야 한다/답변은 자유롭게 쓴다/' src/lib/baseball-qa/gemini-request.ts

# M23 답변 validator 를 **질문용 어휘에 다시 연결**한다 — 삼순 2026-08-08 2차 P0 그 상태.
#     이게 잡히지 않으면 다음 사람이 "어휘 재사용"을 리팩토링으로 되돌려도 아무도 모른다.
grep -q "ANSWER_EXCLUSIVE_TERMS" src/lib/baseball-qa/pipeline.ts || {
  echo "FATAL M23 대상(ANSWER_EXCLUSIVE_TERMS)이 소스에 없다 — 변이가 무의미하다"; exit 2; }
mutate_answer "M23 답변 validator 를 질문용 BASEBALL_WORDS 에 재연결" \
  perl -0pi -e 's/  return ANSWER_EXCLUSIVE_TERMS\.some\(\(word\) => matchesAnswerAnchor\(tokens, word\)\) \|\|/  return BASEBALL_WORDS.some((word) => tokenMatches(tokens, word)) ||\n    ["경기", "공격", "수비", "주루", "득점"].some((word) => tokenMatches(tokens, word)) ||/' src/lib/baseball-qa/pipeline.ts

# M24 2차 P0 에서 내린 네 단어를 **단독 허용으로 되돌린다** → `전용 구장`·`로마 투구`·
#     `계주 주자`·`사회자 대타` 가 다시 통과한다.
mutate_answer "M24 일반어(구장·투구·주자·대타)를 단독 허용으로 되돌림" \
  perl -0pi -e 's/  "희생플라이", "태그업", "피치클락", "타율", "방어율", "평균자책", "대주자",/  "희생플라이", "태그업", "피치클락", "타율", "방어율", "평균자책", "대주자", "구장", "투구", "주자", "대타",/' src/lib/baseball-qa/pipeline.ts

# M25 답변측 구단 판정을 **질문용 broad `mentionsTeam` 으로 재연결**한다 — 삼순 3차 P0 그 상태.
#     `LG는 한국의 가전 기업입니다`·`기아는 자동차 회사입니다` 가 다시 통과한다.
#     M23 과 같은 축이다 — "질문용 판정기 재사용"이 리팩토링으로 되살아나면 게이트가 잡는다.
grep -q "answerMentionsTeam" src/lib/baseball-qa/pipeline.ts || {
  echo "FATAL M25 대상(answerMentionsTeam)이 소스에 없다 — 변이가 무의미하다"; exit 2; }
mutate_answer "M25 답변측 구단 판정을 질문용 broad mentionsTeam 에 재연결" \
  perl -0pi -e 's/  return hasAnswerBaseballSignal\(value\) \|\| answerMentionsTeam\(tokens\);/  return hasAnswerBaseballSignal(value) || mentionsTeam(tokens);/' src/lib/baseball-qa/pipeline.ts

# M26 별도 토큰 쌍 인정을 제거한다 → `LG 트윈스`(띄어쓴 형태) 정상 답변이 폐기된다.
#     과차단 방향도 게이트가 잡는지 본다 — "다 막으면 통과" 를 막는 축이다.
mutate_answer "M26 별도 토큰 구단쌍 인정 제거 (풀네임 과차단)" \
  perl -0pi -e 's/    return shorts\.some\(\(short\) => tokenMatches\(tokens, short\)\) &&\n      nicks\.some\(\(nick\) => tokenMatches\(tokens, nick\)\);/    return false;/' src/lib/baseball-qa/pipeline.ts

echo
if [ "$fail" -eq 0 ]; then
  echo "✅ 전 변이 RED — 게이트가 대상 로직을 실제로 지키고 있다"
else
  echo "❌ GREEN(검출실패) 변이가 있다 — 게이트를 보강해야 한다"
fi

restore
$GATE >/dev/null 2>&1 && echo "RESTORE-OK 원본 복원 후 게이트 GREEN" || { echo "FATAL 복원 후에도 RED"; exit 2; }
exit "$fail"
