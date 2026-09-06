/**
 * **앱 기능 안내 E2E** 게이트 (2026-09-05, #improving_yajaralbot V2 48h 원장 19건).
 *
 * ## 무엇을 지키는가
 *
 * 9/3~9/5 원장에서 우리 앱 기능을 물은 19건이 전부 실패(`unsure`)하거나 동문서답
 * (`최애선수 등록 어케해`→KBO 선수등록 규정, `배경화면에 점수`→전광판 규정)으로 나갔다.
 * registry 키가 `직관기록` 하나뿐이었고 매처가 문장 머리만 봤기 때문이다.
 *
 * ## 계약 (삼순 2026-09-05 13:37 조건부 GO + 14:27 조건부 GO 4건)
 *
 *   ① 실유저 문장 그대로 → `resolveProductFeature` 가 **맞는 기능**을 고른다
 *   ② 같은 문장이 배포 라우터 `routeQuestion` 에서 `product_feature_guide` 로 끝난다
 *      (앞단 `resolveSeasonRecordIntentFor` 가 가로채지 않는다 — `순위`·구단명 포함 문장)
 *   ③ **`answerQuestion` 종단** — 실제 배포 진입점이 registry 문구 그대로를 `source=product_feature_guide`
 *      로 돌려주고 LLM 을 부르지 않는다(삼순 ③ "routeQuestion 통과는 E2E 가 아니다")
 *   ④ 야구 질문·잡담·**기록 질문(`최애팀 몇 위?`)** 은 가로채지 않는다(음성 코호트, 삼순 ①)
 *   ⑤ 안내 문구의 **버전·OS·메뉴 경로가 출시본 FAQ(`constants/faq-items.ts`) 문장에 실재**하고,
 *      문구가 가리키는 **UI 라벨이 src 에 실재**한다(삼순 ④ "현재 출시본과 대조한 근거")
 *   ⑥ 앱 사용법과 외부 영상 시청을 나눈다 — `TV 중계 어디서 봐?` 는 "앱 안에서 재생되지 않는다" 를
 *      먼저 말하는 항목으로 간다(삼순 ②)
 *   ⑦ 배선: 라우터에서 기능 안내가 `service_redirect` 보다 **앞**이다
 *
 * ## 판정면
 * 배포 코드가 실제로 부르는 함수를 그대로 태운다(사본 없음). provider·DB 호출 0회.
 *
 * 실행: npm run qa:genius-product-feature-guide
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  PRODUCT_FEATURE_KEYS,
  answerQuestion,
  productFeatureGuideAnswer,
  resolveProductFeature,
  resolveSeasonRecordIntentFor,
  routeQuestion,
  type ProductFeatureKey,
  type QaDeps,
} from "../../src/lib/baseball-qa/pipeline";
import { BASEBALL_GENIUS_MAX_ANSWER_LENGTH } from "../../src/lib/constants/baseball-genius";
import { FAQ_ALL_TEXT } from "../../src/lib/constants/faq-items";

/** 실패 줄에만 나오는 안정 ID — 통과 출력(✅)과 겹치지 않게 한다. */
const FAIL_ID = "[PFG-FAIL]";

interface PositiveCase {
  axis: string;
  /** 실유저 문장 그대로(원장 `state/yaj-48h/failure-ledger-20260905.json`·`served-quality-ledger-20260905.json`) 또는 삼순 반례. */
  question: string;
  want: ProductFeatureKey;
}

/**
 * 🔴 분모가 곧 계약이다. 축이 하나라도 0건이면 그 축은 검사되지 않은 것이므로
 *   `assertAxisCoverage` 가 fail-close 한다(vacuous PASS 방지).
 */
const POSITIVE: PositiveCase[] = [
  // ── 워치 (실패 3 + 정상경로 오답 1) ───────────────────────────────────────
  { axis: "watch", question: "워치 연동법", want: "스마트워치" },
  { axis: "watch", question: "워치 설정 어떻게 해?", want: "스마트워치" },
  { axis: "watch", question: "워치에 어떻게 설정해?", want: "스마트워치" },
  { axis: "watch", question: "이 크보팬앱이 워치에도 설정할수 있다 들었어", want: "스마트워치" },
  { axis: "watch", question: "타일 추가", want: "스마트워치" },
  { axis: "watch", question: "기아 타일추가 방법", want: "스마트워치" },
  // ── 홈 위젯·배경화면 (실패 6 + 정상경로 오답 1) ───────────────────────────
  { axis: "widget", question: "나의 폰 배경화면에 팀 순위 위젯을 하는 방법", want: "홈위젯" },
  { axis: "widget", question: "배경화면 설정", want: "홈위젯" },
  { axis: "widget", question: "이 웹은 위젯 없어?", want: "홈위젯" },
  { axis: "widget", question: "배경화면에 스코어띄울수있나요?", want: "홈위젯" },
  { axis: "widget", question: "야구 점수를 배경화면에 띄울수있나요", want: "홈위젯" },
  { axis: "widget", question: "좋아하는 야구 선수 내 배경화면에 어떻게 설정해?", want: "홈위젯" },
  { axis: "widget", question: "배경화면에 어케올랴나", want: "홈위젯" },
  // ── 잠금화면 중계 ─────────────────────────────────────────────────────────
  { axis: "lockscreen", question: "잠금화면에 경기 스코어 어떻게 띄워?", want: "잠금화면중계" },
  { axis: "lockscreen", question: "다이나믹 아일랜드에 점수 나오게 하는 법", want: "잠금화면중계" },
  { axis: "lockscreen", question: "갤럭시 나우바에 경기 나오게 할 수 있어?", want: "잠금화면중계" },
  // ── GPS 직관 인증 (실패 2) ────────────────────────────────────────────────
  { axis: "checkin", question: "gps인증 어떻게 해요", want: "직관인증" },
  { axis: "checkin", question: "gps인증은 어떻게해?", want: "직관인증" },
  { axis: "checkin", question: "직관기록", want: "직관기록" },
  { axis: "checkin", question: "직관 기록이 뭐야", want: "직관기록" },
  // ── 최애선수·최애팀 (정상경로 동문서답 1) ───────────────────────────────────
  { axis: "favorite", question: "최애선수 등록 어케해", want: "최애선수" },
  { axis: "favorite", question: "관심선수 바꾸는 법", want: "최애선수" },
  { axis: "favorite", question: "응원팀 바꾸고 싶어", want: "최애팀" },
  { axis: "favorite", question: "최애팀 바꾸는 법", want: "최애팀" },
  // ── 앱 문맥 순위 (정상경로 오답 1) ─────────────────────────────────────────
  { axis: "app_context", question: "크보팬 앱에서 순위 어떻게 봐?", want: "순위보기" },
  // 비교·배제 조사 `위젯 말고` 는 위젯을 닫고, 문장의 진짜 화제(앱에서 순위)를 살린다.
  { axis: "app_context", question: "위젯 말고 앱에서 순위 어떻게 봐", want: "순위보기" },
  // ── 앱 사용법 vs 외부 시청 분리 (삼순 ②) ───────────────────────────────────
  { axis: "viewing", question: "문자중계 어디서 보는거야", want: "문자중계" },
  { axis: "viewing", question: "야구경기 실시간으로 보고싶은데 어디서 어떻게 봐?", want: "영상중계시청" },
  { axis: "viewing", question: "TV 중계 어디서 봐?", want: "영상중계시청" },
  { axis: "viewing", question: "랜더스 인터뷰는 어디서 봐?", want: "수훈선수인터뷰" },
];

/** 야구 질문·잡담·기록 질문 — 기능 안내로 가로채면 안 된다. */
const NEGATIVE: Array<{ axis: string; question: string }> = [
  // 트리거 부분문자열 함정 — `타일` 은 `스타일` 의 시작이 아니다.
  { axis: "substring", question: "김도영 플레이 스타일 어때?" },
  { axis: "substring", question: "타순이 뭐야" },
  // 이용 술어가 있어도 `스타일` 은 `타일` 이 아니다(부분문자열 매칭 금지 — M1 의 검출면).
  { axis: "substring", question: "김도영 플레이 스타일 어떻게 봐?" },
  // 앱 문맥 없는 순위·중계·실시간은 야구 질문이다.
  { axis: "app_context_off", question: "안녕 기아 몇위야" },
  { axis: "app_context_off", question: "올해 순위 어떻게 돼?" },
  { axis: "app_context_off", question: "실시간 순위 알려줘" },
  // 시청처가 아니라 내용·사실을 묻는다.
  { axis: "viewing_off", question: "감독 인터뷰에서 뭐라고 했어" },
  { axis: "viewing_off", question: "중계권료가 얼마야" },
  // 변경 요청 없는 최애 언급은 잡담·팀 이야기다.
  { axis: "change_off", question: "너의 최애 선수는 누구니" },
  { axis: "change_off", question: "응원팀이 삼성인데 오늘 이길까" },
  // 이용 술어(`있어`)는 있지만 변경 요청이 아니다 — 봇에게 응원팀이 있냐고 묻는 잡담.
  { axis: "change_off", question: "응원팀 있어?" },
  { axis: "change_off", question: "최애 선수 있어?" },
  // 🔴 삼순 ① 반례 — 기능명이 있어도 **기록 질문**이다(단어 존재 ≠ 이용 의도).
  { axis: "stat_ask", question: "최애선수 홈런 몇 개?" },
  { axis: "stat_ask", question: "최애팀 몇 위?" },
  { axis: "stat_ask", question: "최애팀 설정한 팀 몇 위야?" },
  { axis: "stat_ask", question: "위젯에 나오는 타율 누구야" },
  // 비교·배제 조사 — X 는 화제가 아니다(종전 문서 계약).
  { axis: "excluded_tail", question: "직관기록보다 중요한거" },
  // 야구 용어·기록 질문은 그대로 야구 경로다.
  { axis: "baseball", question: "홀드가 뭐야" },
  { axis: "baseball", question: "김도영 타율" },
  { axis: "baseball", question: "희생플라이는 어느 때 치는거야" },
];

/**
 * ⑤-a 출시본 FAQ 대조 — 문구의 버전·OS·메뉴 경로는 `constants/faq-items.ts` 문장에 **부분문자열로 실재**해야 한다.
 *   CS 캐시(`state/cs-reply-style.md`)가 아니라 유저가 마이페이지에서 읽는 출시본 문장이 근거다(삼순 ④).
 */
const FAQ_FACTS: Partial<Record<ProductFeatureKey, readonly string[]>> = {
  "스마트워치": ["watchOS 10 이상", "Watch 앱에서 크보팬을 설치", "워치 Play 스토어에서 크보팬을 설치", "갤럭시워치 4 이상·Wear OS 3 이상", "경기·순위 컴플리케이션"],
  "홈위젯": ["편집 > 위젯 추가 > 크보팬", "iOS 16.1 이상", "iOS 17 이상", "위젯 > 크보팬", "팀 순위", "최애선수 카드"],
  "잠금화면중계": ["iOS 18 이상", "Android 16 이상", "마이페이지 > 설정 > 잠금화면 > 잠금화면 실시간 중계", "경기 시작 30분 전부터 종료까지", "잠금화면 카드 다시 표시", "일반 잠금화면 카드"],
  "최애선수": ["마이페이지 > 최애 선수", "최대 5명", "새 구단의 최애선수를 다시 선택"],
  "최애팀": ["새 구단의 최애선수를 다시 선택"],
};

/**
 * ⑤-b 문구가 가리키는 UI 라벨 — src 의 `.tsx` 에 문자열 그대로 실재해야 한다(정적 보조 근거, 실제 클릭 증거는 별도 QA).
 *   문구가 존재하지 않는 메뉴(`알림설정`·`선수 순위`)를 안내하던 초안 오류를 구조적으로 막는다.
 */
const UI_LABELS: Record<ProductFeatureKey, readonly string[]> = {
  "직관기록": ["직관 다이어리", "지난 경기 추가", "마이페이지"],
  "직관인증": ["직관 라이브", "직관 다이어리", "지난 경기 추가"],
  "스마트워치": ["최애팀"],
  "홈위젯": ["최애선수 카드"],
  "잠금화면중계": ["잠금화면 실시간 중계", "잠금화면 카드 다시 표시"],
  "최애팀": ["MY TEAM", "마이페이지"],
  "최애선수": ["최애 선수", "최애선수 설정하고 홈을 꾸며보세요"],
  "순위보기": ["MY TEAM"],
  "문자중계": ["크관", "문자중계"],
  "영상중계시청": ["크관", "문자중계"],
  "수훈선수인터뷰": ["수훈선수 인터뷰"],
};

/** ⑥ 외부 시청 항목은 "앱 안에서 재생되지 않는다/직접 제공하지 않는다" 를 먼저 말한다. */
const EXTERNAL_FIRST: Partial<Record<ProductFeatureKey, RegExp>> = {
  "영상중계시청": /^TV·온라인 영상 중계는 크보팬 안에서 재생되지 않습니다/u,
  "수훈선수인터뷰": /^선수·감독 인터뷰 영상은 크보팬이 직접 제공하지 않습니다/u,
};

function assertAxisCoverage(): string[] {
  const required = ["watch", "widget", "lockscreen", "checkin", "favorite", "app_context", "viewing"];
  const negRequired = ["substring", "app_context_off", "viewing_off", "change_off", "stat_ask", "excluded_tail", "baseball"];
  return [
    ...required.filter((axis) => !POSITIVE.some((c) => c.axis === axis))
      .map((axis) => `${FAIL_ID} 분모 0 축(양성): ${axis} — vacuous PASS 방지 fail-close`),
    ...negRequired.filter((axis) => !NEGATIVE.some((c) => c.axis === axis))
      .map((axis) => `${FAIL_ID} 분모 0 축(음성): ${axis} — vacuous PASS 방지 fail-close`),
    ...PRODUCT_FEATURE_KEYS.filter((key) => !POSITIVE.some((c) => c.want === key))
      .map((key) => `${FAIL_ID} registry 키 "${key}" 를 양성 코호트가 한 번도 겨냥하지 않는다`),
  ];
}

const players = [{ kboId: "1", name: "김도영", position: "내야수" }] as unknown as
  Parameters<typeof routeQuestion>[2];

function positiveChecks(): string[] {
  const out: string[] = [];
  for (const c of POSITIVE) {
    // ① 기능 선택
    const got = resolveProductFeature(c.question);
    if (got !== c.want) {
      out.push(`${FAIL_ID} [${c.axis}] resolveProductFeature("${c.question}") = ${got}, 기대 ${c.want}`);
      continue;
    }
    // ② 배포 라우터 종단 — 앞단 기록 판정이 먼저 종결하지 않는지도 같이 본다.
    const intent = resolveSeasonRecordIntentFor(c.question, players).kind;
    if (intent !== "none") {
      out.push(`${FAIL_ID} [${c.axis}] "${c.question}" 이 라우터 앞단 기록 판정(${intent})에 가로채인다`);
    }
    const route = routeQuestion(c.question, [], players, false);
    if (route !== "product_feature_guide") {
      out.push(`${FAIL_ID} [${c.axis}] routeQuestion("${c.question}") = ${route}, 기대 product_feature_guide`);
    }
  }
  return out;
}

function negativeChecks(): string[] {
  const out: string[] = [];
  for (const c of NEGATIVE) {
    const got = resolveProductFeature(c.question);
    if (got !== null) {
      out.push(`${FAIL_ID} [${c.axis}] "${c.question}" 를 기능 안내(${got})로 가로챘다`);
      continue;
    }
    const route = routeQuestion(c.question, [], players, false);
    if (route === "product_feature_guide") {
      out.push(`${FAIL_ID} [${c.axis}] routeQuestion("${c.question}") 가 product_feature_guide 다`);
    }
  }
  return out;
}

/**
 * ③ `answerQuestion` 종단 — 배포 진입점이 registry 문구 그대로를 돌려주는가.
 *   provider 는 스텁이며 **호출되면 그 자체가 FAIL** 이다(기능 안내는 결정론 경로다).
 */
function makeDeps(): { deps: QaDeps; llmCalls: () => number; logged: () => string[] } {
  let llmCalls = 0;
  const logged: string[] = [];
  const deps: QaDeps = {
    loadGlossary: async () => [],
    loadPlayers: async () => players as unknown as Awaited<ReturnType<QaDeps["loadPlayers"]>>,
    getCache: async () => null,
    setCache: async () => {},
    callLlm: async () => {
      llmCalls += 1;
      return { text: "[stub-llm]", inputTokens: 1, outputTokens: 1 };
    },
    reserveDaily: async (_userId, limit) => ({ allowed: true, remaining: limit - 1 }),
    log: async (entry) => { logged.push(entry.matchPath); },
  };
  return { deps, llmCalls: () => llmCalls, logged: () => logged };
}

async function endToEndChecks(): Promise<string[]> {
  const out: string[] = [];
  const registryAnswers = new Set(PRODUCT_FEATURE_KEYS.map((key) => productFeatureGuideAnswer(key)));
  for (const c of POSITIVE) {
    const { deps, llmCalls, logged } = makeDeps();
    const result = await answerQuestion(`pfg-${c.axis}`, c.question, deps);
    const want = productFeatureGuideAnswer(c.want);
    if (result.source !== "product_feature_guide") {
      out.push(`${FAIL_ID} [e2e:${c.axis}] answerQuestion("${c.question}").source = ${result.source}, 기대 product_feature_guide`);
    }
    if (result.answer !== want) {
      out.push(`${FAIL_ID} [e2e:${c.axis}] answerQuestion("${c.question}") 최종 답변이 registry(${c.want}) 문구와 다르다: "${result.answer.slice(0, 40)}…"`);
    }
    if (llmCalls() > 0) {
      out.push(`${FAIL_ID} [e2e:${c.axis}] "${c.question}" 에서 LLM 이 ${llmCalls()}회 호출됐다 — 기능 안내는 결정론 경로다`);
    }
    if (!logged().includes("product_feature_guide")) {
      out.push(`${FAIL_ID} [e2e:${c.axis}] "${c.question}" 로그 matchPath 에 product_feature_guide 가 없다(${logged().join(",")})`);
    }
  }
  for (const c of NEGATIVE) {
    const { deps } = makeDeps();
    const result = await answerQuestion(`pfg-neg-${c.axis}`, c.question, deps);
    if (result.source === "product_feature_guide" || registryAnswers.has(result.answer)) {
      out.push(`${FAIL_ID} [e2e:${c.axis}] "${c.question}" 종단이 기능 안내 문구로 나갔다(source=${result.source})`);
    }
  }
  return out;
}

function listTsx(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) listTsx(full, acc);
    else if (full.endsWith(".tsx")) acc.push(full);
  }
  return acc;
}

/** ⑤ 문구 계약 — FAQ 사실 대조 · UI 라벨 실재 · 상한 · 미지원 단정 금지 · 앱 최소버전 표기 금지. */
function answerContractChecks(): string[] {
  const out: string[] = [];
  const uiText = listTsx(path.join(process.cwd(), "src"))
    .filter((f) => !f.includes(`${path.sep}baseball-qa${path.sep}`))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  for (const key of PRODUCT_FEATURE_KEYS) {
    const answer = productFeatureGuideAnswer(key);
    if (answer.trim().length === 0) {
      out.push(`${FAIL_ID} [answer] "${key}" 문구가 비어 있다`);
      continue;
    }
    if (answer.length > BASEBALL_GENIUS_MAX_ANSWER_LENGTH) {
      out.push(`${FAIL_ID} [answer] "${key}" 문구 ${answer.length}자 > 상한 ${BASEBALL_GENIUS_MAX_ANSWER_LENGTH}`);
    }
    for (const fact of FAQ_FACTS[key] ?? []) {
      if (!answer.includes(fact)) {
        out.push(`${FAIL_ID} [faq] "${key}" 문구에 출시본 사실 "${fact}" 이 없다`);
      } else if (!FAQ_ALL_TEXT.includes(fact)) {
        out.push(`${FAIL_ID} [faq] "${key}" 문구의 "${fact}" 가 출시본 FAQ(constants/faq-items.ts)에 실재하지 않는다`);
      }
    }
    for (const label of UI_LABELS[key]) {
      if (!answer.includes(label)) {
        out.push(`${FAIL_ID} [ui] "${key}" 문구에 진입 라벨 "${label}" 이 없다`);
      } else if (!uiText.includes(label)) {
        out.push(`${FAIL_ID} [ui] "${key}" 문구의 라벨 "${label}" 이 src/**/*.tsx 어디에도 없다 — 존재하지 않는 메뉴를 안내한다`);
      }
    }
    const externalFirst = EXTERNAL_FIRST[key];
    if (externalFirst && !externalFirst.test(answer)) {
      out.push(`${FAIL_ID} [external] "${key}" 문구가 "앱 안에서 재생/제공되지 않는다" 를 먼저 말하지 않는다(앱 사용법과 외부 시청 미분리)`);
    }
    // 미출시·미지원 단정 금지 — "스마트워치 미지원" 류 오답 사고(CS 표준답변 ⚠️).
    if (/미지원|지원하지 않|준비 중|출시 예정|전용입니다/u.test(answer)) {
      out.push(`${FAIL_ID} [answer] "${key}" 문구가 미지원·준비중·단일 플랫폼 전용을 단정한다`);
    }
    // 앱 최소버전(1.0.x)은 출시본 FAQ 에 없다 — 현 출시본이 전부 넘긴 조건을 유저에게 되묻지 않는다.
    if (/\b1\.0\.\d+/u.test(answer)) {
      out.push(`${FAIL_ID} [answer] "${key}" 문구에 앱 최소버전(1.0.x)이 있다 — 출시본 FAQ 에 없는 조건`);
    }
  }
  return out;
}

/**
 * ⑦ 배선 불변식 — 라우터에서 기능 안내가 `service_redirect` 보다 앞이어야 한다.
 *   뒤로 가면 `이 크보팬앱이 워치에도…` 는 `크보팬`·`앱` 때문에 피드백 안내로 끝난다.
 *   주석·문자열은 blank 처리하고 센다(게이트가 자기 문서를 검사하지 않게).
 */
function wiringInvariantChecks(): string[] {
  const out: string[] = [];
  const src = readFileSync(path.join(process.cwd(), "src/lib/baseball-qa/pipeline.ts"), "utf8");
  const blanked = src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
  const guide = blanked.search(/resolveProductFeature\(question\)\s*!==\s*null\)\s*return\s*"product_feature_guide"/);
  const redirect = blanked.search(/isServiceInquiry\(normalized\)\)\s*return\s*"service_redirect"/);
  if (guide < 0 || redirect < 0) {
    out.push(`${FAIL_ID} [wiring] 라우터에서 product_feature_guide(${guide}) 또는 service_redirect(${redirect}) 분기를 찾지 못했다`);
  } else if (guide > redirect) {
    out.push(`${FAIL_ID} [wiring] 라우터에서 service_redirect 가 product_feature_guide 보다 앞이다 — 앱 기능 질문이 피드백 안내로 끝난다`);
  }
  return out;
}

async function run(): Promise<string[]> {
  return [
    ...assertAxisCoverage(),
    ...positiveChecks(),
    ...negativeChecks(),
    ...(await endToEndChecks()),
    ...answerContractChecks(),
    ...wiringInvariantChecks(),
  ];
}

async function main(): Promise<void> {
  const failures = await run();
  for (const f of failures) console.error(`  ❌ ${f}`);
  if (failures.length > 0) {
    console.error(`\n❌ qa:genius-product-feature-guide FAIL — ${failures.length}건`);
    process.exit(1);
  }
  const byAxis = new Map<string, number>();
  for (const c of POSITIVE) byAxis.set(c.axis, (byAxis.get(c.axis) ?? 0) + 1);
  console.log(
    `✅ qa:genius-product-feature-guide: 양성 ${POSITIVE.length} · 음성 ${NEGATIVE.length} · answerQuestion 종단 ${POSITIVE.length + NEGATIVE.length} · 문구 ${PRODUCT_FEATURE_KEYS.length}(FAQ·UI 라벨 대조) PASS `
    + `(${[...byAxis].map(([a, n]) => `${a} ${n}`).join(" · ")})`,
  );
}

main().catch((error: unknown) => {
  console.error(`  ❌ ${FAIL_ID} [crash] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
