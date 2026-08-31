/**
 * 의도 라우팅 게이트 — official RAG **앞**에서 잡담·후속을 가른다.
 *
 * ## 왜 필요한가 (2026-08-31 실측)
 *
 * 48h 실패 코호트의 L4(대화 후속)·L5(페르소나·잡담) **38건 전수가 official RAG 로
 * 라우팅**됐다. `search_baseball_genius_official_chunks` 의 거리 임계(0.42)를
 * 100% 통과했기 때문이다:
 *
 *     사랑해요 0.3803 · 병신 0.3494 · 어이 0.3664 · 알려줘서 고마워👍 0.3685
 *     오늘 대구 날씨 어떨거 같아 0.3753     ← #1317 이 "막힌다"고 적은 바로 그 축
 *     top1 분포 min 0.2402 · median 0.3535 · max 0.4074
 *
 * `#1317` 은 `scopeGate` 방어를 풀면서 "방어를 라우팅 라벨에서 근거 거리로 옮긴 것이지
 * 없앤 것이 아니다" 라고 적었고 근거는 비야구 5샘플(주식·날씨·점심·파이썬·아이폰)의
 * 0.4281~0.5139 였다. **그 5개가 실유저 잡담을 대표하지 않았다** — 영어·타 도메인
 * 명사는 멀지만 한국어 짧은 구어는 야구 코퍼스와 가깝다.
 *
 * 그래서 `병신` 이 KBO 공식야구규칙 12개를 근거로 받아 LLM 에 들어가고, 모델이
 * INSUFFICIENT 를 고르는 것이 **정상 동작**이 된다. 프롬프트를 아무리 고쳐도 안 산다 —
 * 애초에 잘못된 프롬프트에 도착한 것이기 때문이다.
 *
 * ## 왜 임계 조정·어휘 목록이 아닌가
 *
 *  · **임계 조정 불가** — 분포가 겹친다. `야구 용어` 0.2402 · `야구` 0.2450 은 정상
 *    질문인데 잡담보다 가깝다. 어떤 임계도 한쪽을 틀린다
 *    (`open_language_never_closes_with_rules` 의 거리 버전 — #1317 주석이 엔티티
 *     소유권에서 이미 같은 결론을 냈다).
 *  · **어휘 목록 불가** — 48h 에서 `FOLLOWUP_PHRASES` 폐쇄집합이 후속 25건 중
 *    **0건** 적중했다. 실유저는 `정리해줘`·`그게뭔소리야`·`아 그렇군` 이라고 쓴다.
 *    반례마다 목록이 자란다.
 *
 * ## 계약 — 입력은 열고, 출력은 코드가 닫는다
 *
 * 판정은 LLM 이 한다(열린 자연어). 그러나 **유저에게 나가는 표면은 코드가 고정**한다:
 *
 *  ① 출력은 4개 sentinel 폐쇄집합. 그 밖의 값은 판정 실패 → `BASEBALL`(기존 경로) 로
 *     fail-open 한다. ⚠️ 여기서 fail-open 이 맞다 — 판정 실패로 정상 야구 질문을
 *     잡담 취급하면 새 결함을 만든다. 기존 경로는 오늘과 같은 동작이라 손해가 없다.
 *  ② `SMALLTALK_SAFE` 의 생성 문장은 **사실 주장 가드**를 통과해야 한다. 숫자·선수명·
 *     구단명·지표어가 하나라도 있으면 폐기하고 고정 문안으로 떨어진다. 잡담에는
 *     애초에 근거가 필요한 주장이 없으므로, 주장이 섞였다는 것 자체가 이탈 신호다.
 *  ③ `FOLLOWUP` 의 답은 **직전 답변 안의 숫자만** 쓸 수 있다. 새 숫자가 나오면
 *     근거 없는 생성이므로 폐기한다(`numericTokensSubsetOf` 와 같은 토큰 규칙).
 *
 * 이 모듈은 **순수 함수만** 담는다 — provider 호출은 `server.ts`, 배선은 `pipeline.ts`.
 * 순수 로직을 렌더·네트워크와 섞으면 mutation 게이트가 실제 변조본을 실행할 수 없다
 * (2026-08-22 M90: "검증 가능성은 코드 배치의 함수다").
 */

import { createHash } from "node:crypto";

/** 판정 결과 폐쇄집합. 이 4개 밖의 값은 전부 판정 실패로 취급한다. */
export const INTENT_SENTINELS = [
  /** 인사·감사·페르소나·"뭐 할 수 있어?" — 짧게 받아준다. */
  "SMALLTALK_SAFE",
  /** 욕설·성적·정치·타 도메인(날씨·주식…) — 범위 안내로 부드럽게 전환. */
  "SMALLTALK_SCOPE",
  /** 직전 답변에 이어지는 요약·재설명·되묻기. */
  "FOLLOWUP",
  /**
   * 무슨 얘기인지 특정이 안 된다 — **되묻는다**.
   *
   * 삼순 2026-08-31 지시 ③. `방금 점수 어떻게 냈어?` 처럼 새 정본이 필요한데
   * 어느 경기인지 모르는 경우가 여기다. 실측(10회)에서 이 문장은 FOLLOWUP 5 :
   * BASEBALL 5 로 갈렸는데, 그건 모델이 헷갈린 게 아니라 **두 해석이 다 맞기**
   * 때문이다. 한쪽으로 억지로 몰면 어느 쪽이든 절반은 틀린다 —
   * 되묻는 것이 유일하게 항상 옳은 행동이다.
   *
   * 이 경로는 **추가 LLM·RAG·cache 를 일절 쓰지 않는다**(고정 되묻기 문구).
   */
  "NEEDS_CLARIFICATION",
  /** 야구 질문 — 기존 라우팅 그대로. */
  "BASEBALL",
] as const;

export type QuestionIntent = (typeof INTENT_SENTINELS)[number];

const SENTINEL_SET = new Set<string>(INTENT_SENTINELS);

/** 잡담 답변 길이 상한. 짧게 받는 것이 계약이라 길면 이탈로 본다. */
export const SMALLTALK_MAX_CHARS = 120;
/** 후속 답변 길이 상한 — 직전 답변의 요약·재설명이므로 원문보다 길 이유가 없다. */
export const FOLLOWUP_MAX_CHARS = 400;

export const INTENT_CLASSIFIER_PROMPT = [
  "너는 KBO 야구 챗봇 '야잘알봇'에 들어온 메시지를 **어느 경로로 보낼지**만 정하는 분류기다.",
  "답변을 생성하는 것이 아니라 분류가 목적이다. 단 SMALLTALK_SAFE·FOLLOWUP 은 짧은 답변까지 함께 만든다.",
  "",
  "네 가지 중 하나를 고른다.",
  "",
  "SMALLTALK_SAFE — 야구 지식이 필요 없는 가벼운 대화.",
  "  인사(안녕·야잘알봇아 나 궁금한거 있어), 감사·칭찬(알려줘서 고마워·사랑해요),",
  "  너에 대한 질문(너 뭐야·너 남자야 여자야·어떤 얘기 나눌 수 있어),",
  "  이름·정체성에 대한 가벼운 물음.",
  "  → answer 에 **짧고 다정한 한두 문장**을 쓴다. 사실·수치·선수·구단 이야기는 절대 넣지 않는다.",
  "",
  "SMALLTALK_SCOPE — 답할 수 없거나 답하면 안 되는 것.",
  "  욕설·비하·성적 표현, 정치·인물 논평, 날씨·주식·번역·코딩 등 야구 밖 주제,",
  "  역할 변경 요구(반말로 해줘·다른 캐릭터가 되어라).",
  "  **KBO 밖의 야구도 여기다** — 너는 KBO(한국 프로야구) 전용이다:",
  "    · 해외리그 자체를 묻는 것(MLB·메이저리그·일본프로야구·NPB 팀·선수·기록·일정)",
  "    · 야구 게임·시뮬레이션 이야기(게임 내 능력치·선수카드·시즌모드)",
  "    · 아마추어·사회인 야구, 다른 종목",
  "  ⚠️ 단, **KBO 를 거쳐 간 선수의 KBO 시절**은 KBO 다(BASEBALL 로 보낸다).",
  "    예: 류현진의 한화 시절 기록, 김하성이 뛰던 키움 시절 — 우리 데이터에 있다.",
  "    해외 진출 이후의 성적·소속팀은 우리 데이터에 없으므로 SMALLTALK_SCOPE 다.",
  "  ⚠️ **KBO 구단의 것은 전부 KBO 다** — 처음 듣는 이름이어도 SCOPE 로 보내지 마라:",
  "    마스코트(호걸이·턱돌이·블레오), 홈구장과 그 시설물(몬스터월·그린존),",
  "    응원단·응원가·유니폼·굿즈·구단 행사.",
  "    이런 고유명은 낯설다는 이유로 게임·해외 것으로 오해하기 쉽지만 우리 주제다.",
  "  → answer 는 비운다. 안내문은 코드가 낸다.",
  "",
  "FOLLOWUP — <직전 대화> 가 주어졌고, 이번 메시지가 **그 답변에 이어지는** 요청.",
  "  요약·재설명 요청(정리해줘·더 쉽게 설명해줘·위에 내용 짧게),",
  "  직전 답변에 대한 되물음(그게 무슨 말이야·그런게 돼?·왜?),",
  "  직전 답변에 대한 반응(아 그렇군·응 그래).",
  "  → answer 에 **직전 답변 안의 내용만으로** 다시 설명한다.",
  "  ⚠️ 직전 답변에 없는 사실·수치를 새로 만들지 않는다. 직전 답변만으로 답할 수 없으면",
  "    FOLLOWUP 이 아니라 BASEBALL 로 분류한다(새 조회가 필요하다는 뜻이다).",
  "",
  "NEEDS_CLARIFICATION — 새로 조회해야 답할 수 있는데 **무엇을 조회할지 특정이 안 되는** 경우.",
  "  예: '방금 점수 어떻게 냈어?' — 어느 경기인지 <직전 대화> 에도 없다.",
  "      '11번' · '25년도는' 처럼 앞말 없이는 뜻이 정해지지 않는 조각.",
  "  **뜻이 갈리는 짧은 약어·오탈자도 여기다.** 'OVR' 처럼 게임 용어일 수도, 기록 약어일 수도,",
  "    오타일 수도 있는 것은 **단정하지 말고 되묻는다.** 하나로 찍어서 틀리면 유저는 엉뚱한",
  "    답을 받지만, 되물으면 한 번만 더 적으면 된다.",
  "  ⚠️ <직전 대화> 에 구단명·경기·선수가 있어서 대상이 특정되면 NEEDS_CLARIFICATION 이 아니라",
  "    BASEBALL 이다. 되묻기는 정말 모를 때만 쓴다 — 알 수 있는데 되물으면 유저를 두 번 일하게 한다.",
  "  → answer 는 비운다. 되묻는 문구는 코드가 낸다.",
  "  → 대신 **무엇이 특정 안 되는지**를 \"clarify\" 에 적는다. 둘 중 하나다:",
  "     \"game\"  = 어느 **경기**인지 모른다(방금 점수·아까 그 경기·역전했어?).",
  "               ⚠️ 이번 메시지나 <직전 대화> 가 **경기·점수·승패**를 말하고 있을 때만 쓴다.",
  "     \"other\" = 그 밖(뜻이 갈리는 약어·앞말 없는 조각).",
  "",
  "BASEBALL — 위 넷이 아닌 전부. 야구 규칙·용어·선수·구단·기록·경기·일정 질문.",
  "  판단이 서지 않으면 BASEBALL 을 고른다. 잘못 분류해서 야구 질문을 잡담으로 처리하는 쪽이",
  "  그 반대보다 나쁘다.",
  "",
  "",
  "그리고 **team** 을 함께 답한다 — 이 질문이 **특정 KBO 구단의 것**을 묻고 있는가.",
  "  구단의 것 = 그 구단의 선수·기록·역사·성적뿐 아니라 **마스코트·홈구장과 그 시설물·",
  "  응원단·응원가·유니폼·굿즈·구단 행사**까지 포함한다.",
  "  → 해당하면 아래 열 개 중 하나를 그대로 쓴다:",
  "     LG · KIA · 두산 · 롯데 · 삼성 · 한화 · 키움 · KT · SSG · NC",
  "  → 특정 구단의 것이 아니면(야구 규칙·용어·일반 질문·잡담) 빈 문자열.",
  "  ⚠️ 구단명이 문장에 없어도 된다 — 그 구단 것이면 고른다.",
  "    예: '호걸이 이름 뜻이 뭐야?'(KIA 마스코트) → KIA",
  "        '몬스터월이 뭐야?'(대전 한화생명볼파크 시설) → 한화",
  "  ⚠️ 반대로 구단명이 있어도 그 구단의 것을 묻는 게 아니면 빈 문자열이다.",
  "    예: '한화 경기에서 보크가 뭐야?' → 보크는 규칙이므로 빈 문자열.",
  "",
  "그리고 **standalone** 을 함께 답한다 — **이번 메시지 하나만 놓고** 무엇을 묻는지가",
  "  정해지는가(앞 대화를 빌리지 않고).",
  "  true  = 정해진다. '보크가 뭐야' · '오늘 LG 선발 누구야'.",
  "  false = 안 정해진다. '기아타이거즈에서' · '25년도는' · '11번' 처럼 앞 문장의 빈자리를",
  "          채워야만 뜻이 생기는 조각.",
  "  ⚠️ FOLLOWUP 은 이 값과 무관하다 — 직전 답변을 다시 설명하는 것은 새 조회가 아니다.",
  "  ⚠️ 짧다고 false 가 아니다. '보크?' 는 짧지만 단독으로 완결이다.",
  "",
  '반드시 JSON 하나만 출력한다: {"intent":"위 다섯 중 하나","answer":"SMALLTALK_SAFE·FOLLOWUP 일 때만, 아니면 빈 문자열","clarify":"NEEDS_CLARIFICATION 일 때만 game 또는 other","standalone":true 또는 false,"team":"위 열 개 중 하나 또는 빈 문자열"}',
].join("\n");

/**
 * 되묻기 대상 — **폐쇄집합**.
 *
 * LLM 이 자유 문장으로 "무엇이 모호한지" 를 쓰게 두면 그 문장이 유저에게 나가거나
 * 코드 분기 키가 되면서 열린 집합이 된다. 두 값만 받고 나머지는 `other` 로 접는다
 * (입력은 열고 출력은 코드가 닫는다).
 */
export const CLARIFY_TARGETS = ["game", "other"] as const;

/**
 * KBO 구단 canonical — **폐쇄집합**. `TEAMS` 의 표기와 같아야 한다.
 *
 * 🔴 이건 어휘 목록이 아니라 **출력 정의역**이다. 분류기가 자유 문자열로 구단을 쓰면
 *   `엘지`·`LG트윈스`·`엘지트윈스` 가 뒤섞여 하류가 못 받는다. 입력은 열어 두고
 *   (무엇이 그 구단 것인지는 LLM 이 판단) 출력만 이 열 개로 닫는다.
 *   구단 수가 늘지 않는 한 이 배열은 자라지 않는다 — 반례마다 늘어나는 어휘 목록과 다르다.
 */
export const KBO_TEAM_CANONICALS = [
  "LG", "KIA", "두산", "롯데", "삼성", "한화", "키움", "KT", "SSG", "NC",
] as const;
export type KboTeamCanonical = (typeof KBO_TEAM_CANONICALS)[number];
export type ClarifyTarget = (typeof CLARIFY_TARGETS)[number];

export interface IntentDecision {
  intent: QuestionIntent;
  /**
   * `NEEDS_CLARIFICATION` 일 때 무엇이 특정 안 되는가. 그 외 경로에서는 항상 null 이다.
   * `game` 이면 코드가 **오늘 경기 목록**을 붙여 되묻는다.
   */
  clarify: ClarifyTarget | null;
  /**
   * 이 질문이 **어느 KBO 구단의 것**을 묻는가 (없으면 null).
   *
   * 🔴 왜 코드 목록이 아니라 LLM 판정인가 (하린아빠 2026-08-31).
   *   `호걸이`(KIA 마스코트)·`몬스터월`(한화 구장 시설)이 구단 문서가 아니라 KBO 규칙집으로
   *   새고 있었다. 초안에서 나는 마스코트 이름 목록(`TEAM_ALIASES.assets`)을 만들어 막았는데,
   *   그건 **빠진 이름이 나올 때마다 자라는 어휘 목록**이다 — 응원가·굿즈·시설물까지 치면
   *   끝이 없고, 정확히 `open_language_never_closes_with_rules` 가 말하는 축이다.
   *
   *   "무엇이 그 구단의 것인가" 는 열린 집합이라 LLM 이 판단하고, **출력만 10개 폐쇄집합**
   *   으로 닫는다. 계약 밖 값은 null 로 접으므로 미탐의 대가는 종전 동작이다.
   */
  team: KboTeamCanonical | null;
  /**
   * 이번 메시지 **하나만으로** 무엇을 묻는지가 정해지는가 (삼순 2026-08-31).
   *
   * 🔴 왜 "맥락과 합쳐 복원 가능한가" 가 아니라 "혼자 완결인가" 인가.
   *   삼순 계약: `BASEBALL` 은 **앞 질문과 현재 조각을 grounded full query 로 실제 결합해
   *   정본 경로로 보낼 수 있을 때만** 허용한다. 그런데 **그 결합 경로가 이 PR 에 없다.**
   *   LLM 에게 "복원 가능하냐" 고 물으면 `기아타이거즈에서` 에 true 라고 답하는데(맞는 말이다),
   *   우리는 그 복원을 실행할 수 없으므로 조각이 그대로 RAG 로 들어간다 —
   *   실측에서 정확히 그 일이 일어났다(team RAG 진입).
   *   그래서 우리가 물어야 할 것은 **우리 능력에 맞춘 질문**이다.
   *
   * 🔴 조사·어미 목록으로 판정하지 않는다(삼순 NO-GO). 문장이 완결인지는 어휘가 아니라
   *   의미의 문제라 목록으로 닫으면 반례마다 자란다.
   *
   * ⚠️ 미수신·형식 위반은 `true` 로 접는다 — 이 값은 **기존 경로를 닫는 데만** 쓰이므로
   *   모를 때 열어두는 쪽이 종전 동작(fail-open)이다.
   */
  standalone: boolean;
  /**
   * 이 판정이 **분류기의 실제 응답**에서 나왔는가 (삼순 2026-08-31 ⓒ-①).
   *
   * 🔴 `BASEBALL` 은 두 가지 서로 다른 것을 뜻해 왔다:
   *   ① 분류기가 "야구 질문이다" 라고 **명시적으로 답했다**
   *   ② 파싱 실패·계약 밖 sentinel·응답 없음 → **모르겠다**(fail-open 기본값)
   *
   *   지금까지 소비자는 둘을 구분할 수 없었고, 그래서 ②일 때도 official RAG 가
   *   열렸다. `질문답헤줘` 의 official 누수 1회가 정확히 그 경로다 —
   *   분류기 판정 20회 중 BASEBALL 은 0회인데도 누수가 났다.
   *
   *   값이 `false` 면 "판정 없음" 이므로 **개방 결정의 근거로 쓰면 안 된다.**
   *   판정이 없을 때는 이 PR 이 연 문을 닫고 종전 계약(사전·엔티티 게이트)으로 돌아간다.
   */
  verdictKnown: boolean;
  /** `SMALLTALK_SAFE`·`FOLLOWUP` 일 때만 채워진다. 가드 미통과면 null. */
  answer: string | null;
  /** 가드가 답을 버렸는가 — 관측용(값이 아니라 provenance 를 따로 남긴다). */
  answerRejected: boolean;
  /** 답을 버린 이유. 관측 전용이며 유저에게 나가지 않는다. */
  rejectReason: string | null;
}

/** 숫자 토큰(연속 숫자열 + 소수점). `numericTokensSubsetOf` 와 같은 규칙이다. */
function numericTokens(text: string): string[] {
  return text.match(/\p{N}+(?:[.]\p{N}+)?/gu) ?? [];
}

/**
 * 잡담 답변에 **사실 주장**이 섞였는가.
 *
 * 잡담에는 근거가 필요한 주장이 원래 없다. 그러므로 주장이 보이면 그건 모델이
 * 잡담 경로를 벗어나 야구 사실을 생성했다는 뜻이고, 근거가 없으므로 폐기가 맞다.
 *
 * ⚠️ 어휘 사전으로 "잡담다움"을 정의하려는 것이 아니다 — 그건 열린 집합이라 닫히지
 *   않는다. 여기서 보는 것은 **닫힌 신호**뿐이다: 숫자 · 호출부가 넘겨준 엔티티 이름.
 *   엔티티 목록은 로스터/구단 SSOT 에서 오므로 이 모듈이 사전을 소유하지 않는다.
 */
export function smalltalkClaimViolation(
  answer: string,
  entityNames: readonly string[],
): string | null {
  if (answer.trim().length === 0) return "empty";
  if (answer.length > SMALLTALK_MAX_CHARS) return "too_long";
  if (/https?:\/\/|www\.|```|<a\b/i.test(answer)) return "markup";
  if (numericTokens(answer).length > 0) return "numeric_claim";
  for (const name of entityNames) {
    if (name.length >= 2 && answer.includes(name)) return `entity_claim:${name}`;
  }
  return null;
}

/**
 * 후속 답변이 직전 답변 밖의 수치를 만들었는가.
 *
 * 후속은 **재서술**이므로 새 수치가 나올 자리가 없다. 직전 답변에 있던 숫자를 다시
 * 쓰는 것만 허용한다(질문에 유저가 적은 숫자도 허용 — 되받아 해석하는 경우).
 */
export function followupClaimViolation(
  answer: string,
  previousAnswer: string,
  question: string,
): string | null {
  if (answer.trim().length === 0) return "empty";
  if (answer.length > FOLLOWUP_MAX_CHARS) return "too_long";
  if (/https?:\/\/|www\.|```|<a\b/i.test(answer)) return "markup";
  const allowed = new Set([...numericTokens(previousAnswer), ...numericTokens(question)]);
  for (const token of numericTokens(answer)) {
    if (!allowed.has(token)) return `numeric_not_in_context:${token}`;
  }
  return null;
}

/**
 * provider 원응답 → 판정.
 *
 * 파싱 실패·계약 밖 sentinel 은 **BASEBALL 로 fail-open** 한다. 판정기가 죽었다고
 * 정상 야구 질문을 잡담으로 보내면 새 결함이 되지만, 기존 경로로 흘리면 오늘과
 * 같은 동작이라 손해가 없다. (fail-close 가 항상 옳은 것이 아니라, **틀렸을 때 덜
 * 나쁜 쪽**이 옳다.)
 */
export function parseIntentResponse(
  raw: string,
  options: {
    /** 직전 사용자 질문 — `game` cue 판정에 쓴다(맥락에 경기 얘기가 있었는가). */
    previousQuestion?: string | null;
    entityNames?: readonly string[];
    previousAnswer?: string | null;
    question?: string;
  } = {},
): IntentDecision {
  // 판정 미확정 — `verdictKnown: false` 로 표시한다. 소비자는 이걸 개방 근거로 쓰지 않는다.
  const fallback: IntentDecision = {
    intent: "BASEBALL", clarify: null, standalone: true, team: null, verdictKnown: false,
    answer: null, answerRejected: false, rejectReason: null,
  };
  let value: unknown;
  try {
    value = JSON.parse(raw.trim());
  } catch {
    return fallback;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const row = value as Record<string, unknown>;
  const intent = String(row.intent);
  if (!SENTINEL_SET.has(intent)) return fallback;

  if (intent === "BASEBALL" || intent === "SMALLTALK_SCOPE" || intent === "NEEDS_CLARIFICATION") {
    // 세 경로 모두 유저 문구를 **코드가** 낸다 — 생성문을 받지 않는다.
    //   · BASEBALL 은 기존 경로가 답을 만든다
    //   · SMALLTALK_SCOPE·NEEDS_CLARIFICATION 은 고정 문안이다(추가 LLM/RAG/cache 0)
    //
    // 되묻기 대상은 폐쇄집합으로 접는다 — 계약 밖 값은 `other`(경기 목록을 붙이지 않는다).
    // 모를 때 목록을 안 붙이는 쪽이, 엉뚱한 경기를 들이미는 쪽보다 덜 나쁘다.
    let clarify: ClarifyTarget | null = intent === "NEEDS_CLARIFICATION"
      ? (CLARIFY_TARGETS as readonly string[]).includes(String(row.clarify))
        ? (String(row.clarify) as ClarifyTarget)
        : "other"
      : null;

    // 🔴 `clarify` 판정은 **분류기에 맡긴다** (하린아빠 2026-08-31: 룰베이스로 블로커를
    //   풀지 말 것). 초안에서 나는 `경기|점수|스코어|이겼|…` 정규식으로 `game` 을 한 번 더
    //   검사했는데, 그건 프롬프트가 이미 요구한 것을 코드에서 **이중 판정**하는 것이고
    //   반례가 나올 때마다 어휘가 자라는 축이다(`open_language_never_closes_with_rules`).
    //   안전은 룰이 아니라 **게이트**로 지킨다 — "cue 없는 질문에 경기 목록이 붙지 않는다"
    //   를 관측으로 고정하면 판정은 열려 있고 검증만 닫힌다.

    // 구단 귀속 — 폐쇄집합 밖은 null 로 접는다(미탐 = 종전 동작).
    const team = (KBO_TEAM_CANONICALS as readonly string[]).includes(String(row.team))
      ? (String(row.team) as KboTeamCanonical) : null;

    // 미수신·형식 위반은 true 로 접는다(fail-open — 기존 경로 유지).
    const standalone = row.standalone === false ? false : true;

    // 🔴 조각인데 `BASEBALL` 이면 되묻기로 내린다 (삼순 2026-08-31 계약).
    //   결합 경로가 없으므로 흘려보내면 조각이 그대로 RAG 질의가 된다.
    //   되묻기는 유저에게 한 번 더 적게 하지만, 엉뚱한 근거로 답하는 것보다 낫다.
    if (intent === "BASEBALL" && !standalone) {
      return {
        intent: "NEEDS_CLARIFICATION", clarify: "other", standalone: false, team, verdictKnown: true,
        answer: null, answerRejected: false, rejectReason: null,
      };
    }
    return {
      intent: intent as QuestionIntent, clarify, standalone, team, verdictKnown: true,
      answer: null, answerRejected: false, rejectReason: null,
    };
  }

  const answer = typeof row.answer === "string" ? row.answer.trim() : "";
  const violation = intent === "SMALLTALK_SAFE"
    ? smalltalkClaimViolation(answer, options.entityNames ?? [])
    : followupClaimViolation(answer, options.previousAnswer ?? "", options.question ?? "");

  if (violation) {
    return {
      intent: intent as QuestionIntent,
      clarify: null,
      standalone: true,
      team: null,
      verdictKnown: true,
      answer: null,
      answerRejected: true,
      rejectReason: violation,
    };
  }
  return {
    intent: intent as QuestionIntent, clarify: null, standalone: true, team: null, verdictKnown: true,
    answer, answerRejected: false, rejectReason: null,
  };
}

/**
 * 프롬프트 계약 버전 — 프롬프트 본문의 해시다.
 *
 * 상수를 손으로 올리지 않는다. 계약(프롬프트)을 고치면 값이 자동으로 바뀌고, 과거 판정은
 * fingerprint 불일치로 재사용되지 않는다. 사람이 올리기로 하면 언젠가 잊고, 그때
 * **바뀐 계약으로 만든 판정과 옛 판정이 같은 키를 공유**한다.
 */
export function intentPromptVersion(): string {
  return createHash("sha256").update(INTENT_CLASSIFIER_PROMPT).digest("hex").slice(0, 12);
}

/**
 * 판정 재사용 키 — `messageId` 는 호출부(job 행)가 쥐고 있으므로 여기서는 **입력**만 해싱한다.
 *
 * 🔴 질문뿐 아니라 **주입된 직전 대화까지** 넣는다. 이게 전역 캐시와 갈리는 지점이다 —
 *   같은 문장이라도 앞 맥락이 다르면 다른 판정이어야 하고, 해시가 달라져 재사용되지 않는다.
 */
export function intentFingerprint(
  question: string,
  context?: { question: string; answer: string } | null,
): string {
  const payload = JSON.stringify({
    q: question,
    cq: context?.question ?? null,
    ca: context?.answer ?? null,
    v: intentPromptVersion(),
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

/** durable 재생 대상 — 최초 판정 1개. */
export interface StoredIntentDecision {
  verdict: string | null;
  fingerprint: string | null;
  answer: string | null;
  clarify: string | null;
  team: string | null;
  /**
   * 저장 당시 그 판정이 **분류기의 명시 응답**이었는가 (삼순 2026-08-31 NO-GO ①).
   *
   * 🔴 초안은 이 값을 저장하지 않고 재생 시 `true` 로 하드코딩했다. 그러면
   *   **판정 실패로 fail-open 된 회차를 재처리할 때 "판정이 있었다" 로 둔갑**한다 —
   *   provenance 를 만든 이유가 정확히 그걸 막으려는 것이었는데 재생 경로가 그걸 지웠다.
   *   ("값으로는 결측을 판정할 수 없다 — provenance 를 별도 축으로 싣는다", M90)
   *
   *   미저장(구 행)은 `null` 이고, 그때는 **알 수 없음 → false 로 접는다.**
   *   모르는 상태를 "판정 있음" 으로 올리면 개방이 열리므로, 덜 나쁜 쪽으로 내린다.
   */
  verdictKnown: boolean | null;
}

/**
 * 저장된 판정을 이번 입력에 재생할 수 있는가.
 *
 * fingerprint 가 정확히 같을 때만 재생한다. 다르면(맥락이 바뀌었거나 프롬프트가 바뀌었거나)
 * 재생하지 않고 새로 분류한다 — 낡은 계약의 판정을 되살리지 않는다.
 */
export function replayableIntent(
  stored: StoredIntentDecision | null | undefined,
  fingerprint: string,
): IntentDecision | null {
  if (!stored?.verdict || !stored.fingerprint) return null;
  if (stored.fingerprint !== fingerprint) return null;
  if (!SENTINEL_SET.has(stored.verdict)) return null;
  return {
    intent: stored.verdict as QuestionIntent,
    // 재생 시에도 되묻기 대상을 복원한다 — 안 하면 재처리 때 경기 목록이 사라져
    // 같은 messageId 가 다른 문구를 받는다(재생의 의미가 없어진다).
    clarify: stored.clarify && (CLARIFY_TARGETS as readonly string[]).includes(stored.clarify)
      ? (stored.clarify as ClarifyTarget) : null,
    // 재생분은 이미 강등까지 끝난 판정이다 — 다시 강등하지 않는다.
    standalone: true,
    // 🔴 provenance 는 **저장된 값을 그대로 재생**한다(하드코딩 금지 — 삼순 NO-GO ①).
    //   미저장(구 행)은 알 수 없으므로 false 로 접는다: 모름을 "판정 있음"으로 올리면
    //   fail-open 회차의 재처리에서 official 개방이 되살아난다.
    verdictKnown: stored.verdictKnown === true,
    team: stored.team && (KBO_TEAM_CANONICALS as readonly string[]).includes(stored.team)
      ? (stored.team as KboTeamCanonical) : null,
    answer: stored.answer ?? null,
    answerRejected: false,
    rejectReason: null,
  };
}
