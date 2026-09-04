/**
 * 야잘알봇 시즌 기록 질의 (kbo_structured).
 *
 * `문보경 올해 2루타 몇 개?` 처럼 **수치**를 묻는 질문은 나무위키(tier2)로 답하면 안 된다
 * (§12 수치 계약: 위키 숫자는 정본이 아니다). 대신 운영 DB의 구조화 기록
 * `player_stats_batter` / `player_stats_pitcher` 최신 row 를 kboId 로 직접 조회해
 * **원값 그대로** 답한다. 계산하지 않고, 추정하지 않고, 없으면 답하지 않는다.
 *
 * 하린아빠 2026-08-03: "그런대 기록도 레퍼런스하는거야? 가령 문보경 올해 2루타 몇개 쳤어?"
 */

/** 지원 시즌. 운영 DB 의 stats 테이블은 **현재 시즌 단일 스냅샷**이라 과거 시즌 row 가 없다. */
export const SUPPORTED_SEASON = 2026;

/**
 * 답변 가능한 타자 지표.
 *
 * ⚠️ `pa`(타석)·`sac`(희생번트)·`sf`(희생플라이) 는 **의도적으로 제외**한다.
 * Naver 폴백 경로가 이 세 필드를 제공하지 않아 upsert 페이로드에서 빠지고(기존값 보존 목적),
 * 그 결과 KBO 수집이 끊긴 구간 동안 값이 과거에 얼어붙는다. Production 실측(2026-08-03)에서
 * 330행 중 233행이 `pa < ab` — 야구 규칙상 불가능한 값이다. 틀린 숫자를 답하느니 안 답한다.
 * (데이터 정합 자체는 별도 P0 트랙.)
 */
export const BATTER_METRICS = {
  avg: { label: "타율", aliases: ["타율", "타률", "애버리지"], kind: "rate" },
  games: { label: "경기", aliases: ["경기", "출장", "경기수"], kind: "count" },
  ab: { label: "타수", aliases: ["타수"], kind: "count" },
  runs: { label: "득점", aliases: ["득점"], kind: "count" },
  hits: { label: "안타", aliases: ["안타"], kind: "count" },
  doubles: { label: "2루타", aliases: ["2루타", "이루타", "２루타", "2베이스", "투베이스"], kind: "count" },
  triples: { label: "3루타", aliases: ["3루타", "삼루타", "３루타", "3베이스", "쓰리베이스"], kind: "count" },
  hr: { label: "홈런", aliases: ["홈런", "홈란", "아치"], kind: "count" },
  tb: { label: "루타", aliases: ["루타", "총루타"], kind: "count" },
  rbi: { label: "타점", aliases: ["타점"], kind: "count" },
  // ⚠️ 아래 5개는 `player_stats_batter` 테이블에 **컬럼이 없다**. 앱이 실제로 서빙하는
  // 정본은 `/api/stats` 응답이라 조회 소스를 그쪽으로 분리한다
  // (`SERVED_ONLY_BATTER_METRICS`). static JSON 이 아니다 — `/api/stats` 는 static 위에
  // live Runner map 을 덮어쓴다(삼순 3차 P0-3 실측: 이주형 sb static 4 vs 앱 0).
  //
  // 하린아빠 2026-08-04 20:42 "도루 OPS가 왜 없어? / 우리가 다 제공하고 있는 데이터인데".
  // 실제로 선수 상세·팀 기록·타이틀 탭이 전부 이 값을 표시하고 있었다. 내가 DB 테이블
  // 하나만 보고 "데이터가 없다"고 단정한 것이 틀렸다.
  sb: { label: "도루", aliases: ["도루"], kind: "count" },
  cs: { label: "도루실패", aliases: ["도루실패", "도루자"], kind: "count" },
  obp: { label: "출루율", aliases: ["출루율"], kind: "rate" },
  slg: { label: "장타율", aliases: ["장타율"], kind: "rate" },
  ops: { label: "OPS", aliases: ["ops"], kind: "rate" },
  // WAR 은 **저장된 칼럼이 아니라 기본 스탬에서 파생**된다. 그래서 "DB 에 없다"는
  // 이유로 못 답한다고 하면 틀리다 — 앱은 선수 상세페이지·기록실·세이버 카드에서
  // 이미 보여주고 있다. 화면과 **같은 함수**(`calcBatterSaber`)로 만든다
  // (`served-record.ts` · `batterWarOf`). 소수 2자리 표기도 화면과 같다.
  war: { label: "WAR", aliases: ["war"], kind: "rate" },
  // ⚠️ bare `wRC` 는 여기 없다. wRC 와 wRC+ 는 **다른 지표**다 — wRC 는 가중 득점 생산량(counting),
  // wRC+ 는 리그·구장 보정 지수(100=평균). 우리가 계산하는 건 wRC+ 뿐이라, `wRC` 질문에
  // wRC+ 값을 주면 다른 지표를 속여 답하는 것이 된다(삼순 #1100 8차 P0-2).
  wrc_plus: { label: "wRC+", aliases: ["wrc+", "wrc플러스"], kind: "rate" },
} as const;

/**
 * DB 테이블이 아니라 **앱이 서빙하는 `/api/stats` 응답**에서 읽어야 하는 타자 지표.
 *
 * `player_stats_batter` 는 KBO/Naver cron upsert 결과인데 sb·cs·obp·slg·ops 컬럼이 없다.
 * 반면 앱 화면(선수 상세·팀 기록·타이틀)은 `/api/stats` 로 이 값들을 보여주고 있다.
 *
 * ⚠️ **static JSON 을 직접 읽으면 안 된다**(삼순 #1100 3차 P0-3). `/api/stats` 는 static row
 * 위에 전페이지 live Runner map 을 마지막에 덮어쓴다. Production 실측(2026-08-04):
 * 이주형(`50167`) `sb` — static JSON `4` vs 앱 서빙 `0`. static 을 읽으면 봇이 앱과
 * 다른 숫자를 말한다 — 이 기능의 유일한 계약이 깨진다. 그래서 앱과 **같은 최종 경계**를 본다.
 *
 * 겹치는 지표(games·hits·hr·rbi…)는 DB row 와 교차검증해 두 소스가 갈라지면 fail-close 한다.
 */
export const SERVED_ONLY_BATTER_METRICS = ["sb", "cs", "obp", "slg", "ops", "war", "wrc_plus"] as const;
export type ServedOnlyBatterMetric = (typeof SERVED_ONLY_BATTER_METRICS)[number];

export function isServedOnlyMetric(metric: string): metric is ServedOnlyBatterMetric {
  return (SERVED_ONLY_BATTER_METRICS as readonly string[]).includes(metric);
}

/** 답변 가능한 투수 지표. Naver 폴백이 매 갱신마다 직접 주는 필드만. */
export const PITCHER_METRICS = {
  era: { label: "평균자책점", aliases: ["평균자책", "평균자책점", "방어율", "era"], kind: "rate" },
  games: { label: "경기", aliases: ["경기", "출장", "등판", "경기수"], kind: "count" },
  wins: { label: "승", aliases: ["승", "승수", "몇승"], kind: "count" },
  losses: { label: "패", aliases: ["패", "패수", "몇패"], kind: "count" },
  saves: { label: "세이브", aliases: ["세이브"], kind: "count" },
  holds: { label: "홀드", aliases: ["홀드"], kind: "count" },
  wpct: { label: "승률", aliases: ["승률"], kind: "rate" },
  ip: { label: "이닝", aliases: ["이닝", "투구이닝"], kind: "raw" },
  h: { label: "피안타", aliases: ["피안타"], kind: "count" },
  hr: { label: "피홈런", aliases: ["피홈런"], kind: "count" },
  bb: { label: "볼넷", aliases: ["볼넷", "사사구", "포볼"], kind: "count" },
  hbp: { label: "사구", aliases: ["사구", "몸에맞는공", "몸에맞는볼"], kind: "count" },
  so: { label: "탈삼진", aliases: ["삼진", "탈삼진", "케이"], kind: "count" },
  r: { label: "실점", aliases: ["실점"], kind: "count" },
  er: { label: "자책점", aliases: ["자책", "자책점"], kind: "count" },
  whip: { label: "WHIP", aliases: ["whip"], kind: "rate" },
} as const;

export type BatterMetricKey = keyof typeof BATTER_METRICS;
export type PitcherMetricKey = keyof typeof PITCHER_METRICS;

/**
 * 제외 지표 — 질문에 이게 나오면 **답변하지 않는다**.
 *
 * 단순 미지원이 아니라 "값은 있는데 믿을 수 없다"는 뜻이다. 조용히 빈손으로 두면
 * 나중에 누가 allowlist 에 넣어버릴 수 있어 명시 집합으로 남긴다.
 */
export const UNTRUSTED_METRIC_ALIASES = [
  "타석", "희생번트", "희생타", "희생플라이", "번트타", "사사구", "pa", "sac", "sf",
] as const;

/**
 * ⚠️ `wrc` 는 `타석`(pa) 알리아스 `pa` 를 **문자열로 포함**한다(`w-r-c` 가 아니라
 * `wrc+` 표기의 NFKC 정규화 결과가 아니며, 실제로는 `김도영 wRC 얼마야` 같은
 * 질문이 untrusted 판정에 먼저 걸렸다). 지표어를 먼저 보면 몸통이 바뀌므로,
 * untrusted 검사 전에 **명시적으로 면제**할 지표 패턴을 둔다.
 */
const UNTRUSTED_EXEMPT_PATTERNS: ReadonlyArray<RegExp> = [
  /wrc\+?/gi,
];

/**
 * untrusted 지표에 대해 **값을 명시적으로 요구**하는 표현 (2026-09-04).
 *
 * 🔴 왜 이게 필요한가. 종전은 지표어가 **글자로 있기만 하면** 차단했다. 그래서
 *   `희생번트는 타수에 들어가?`·`타석이랑 타수 차이가 뭐야?` 처럼 **뜻을 물은** 질문에
 *   "그 기록은 아직 정확하게 안내할 수 없습니다" 가 나갔다(정의 질문 8/8 차단, 실측).
 *   검수 사전에 용어가 있어도 이 판정이 사전보다 앞이라 못 간다.
 *
 * ⚠️ **열린 쪽을 룰로 닫지 않는다** (M90 `open_language_never_closes_with_rules`).
 *   "정의 질문인가" 를 맞히려 들면 반례마다 룰이 쌓인다 — 8월에 세 번 겪은 축이다.
 *   대신 반대를 닫는다: **수량을 요구하는 표현**은 폐쇄적이다(몇·개수·얼마…).
 *
 * ⚠️ `알려`·`보여` 를 넣지 않는다 — `희생번트랑 희생플라이 차이 알려줘` 는 정의 요청이다.
 *   `NUMERIC_QUESTION` 을 그대로 재사용하지 않는 이유가 이것이다(그쪽은 값/서술 분기용).
 */
const UNTRUSTED_VALUE_ASK =
  /몇|얼마|개수|개야|개나|개는|개\?|수는|성적|기록은\s*어때|쳋|덧|총\s*몇/;

/**
 * untrusted 지표의 **뜻·규칙**을 묻는 술어. 있으면 값 요구가 아니므로 양보한다.
 *
 * ⚠️ 이 집합은 "정의 질문 감지기" 가 아니다 — 그건 열린 문제다. 여기서는 값 요구가
 *   없다는 것을 이미 확인한 뒤의 **보조 신호**로만 쓴다. 놓쳐도 손실은
 *   "사전 대신 차단 안내" 로 종전과 같을 뿐이라 fail-safe 방향이다.
 */
const UNTRUSTED_DEFINITION_ASK =
  /뭐|뭔|무엇|뜻|의미|정의|설명|차이|다른\s*점|들어가|포함|영향|계산|세는|치는|기록돼|기록되|기록하|규칙|룰\b|어떻게/;

/**
 * untrusted 지표 질문이 **값을 요구**하는가 — 차단/양보의 단일 술어 (삼순 2026-09-04).
 *
 * 계약(삼순 조건부 GO 문면 그대로):
 * ```
 * 차단 = untrusted 지표 AND ( 명시적 값 요구  OR  선수+지표 bare query )
 * 양보 = 정의 술어가 붙고 값 요구가 없을 때
 * 차단 = 혼합(`희생번트가 뭐야, 김도영은 몇 개야?`) — 값 요구가 이긴다
 * ```
 *
 * 🔴 **선수명만으로 값 요구로 보지 않는다** (삼순 NO-GO 포인트). 내가 처음 제안한
 *   `수량 요구 ∪ 선수 결속` 은 합집합이라 `김도영 희생번트가 뭐야?` 를 다시 막는다 —
 *   정의 질문을 열어주려던 수정이 정의 질문을 막는 꼴이었다. 선수 결속은
 *   **정의 술어가 없을 때만**(= bare query) 값 요구로 읽는다.
 *
 * ⚠️ 순서가 계약이다: 명시적 값 요구를 **먼저** 보므로 혼합 질문은 자연히 차단된다.
 */
export function untrustedValueAsk(question: string, playerBound: boolean): boolean {
  const spaced = normalizeWithSpaces(question);
  // ① 명시적 값 요구 — 정의 술어가 같이 있어도 이긴다(혼합 질문 차단).
  if (UNTRUSTED_VALUE_ASK.test(spaced)) return true;
  // ② 선수+지표 bare query — 정의 술어가 **없을 때만**. `김도영 희생번트`(값 요구)
  //   와 `김도영 희생번트가 뭐야?`(정의)를 가르는 것이 이 조건이다.
  if (playerBound && !UNTRUSTED_DEFINITION_ASK.test(spaced)) return true;
  return false;
}

/** 시즌 표현. 올해만 답한다 — 과거 시즌 row 가 DB 에 없기 때문이다. */
const CURRENT_SEASON_WORDS = ["올해", "올시즌", "이번시즌", "금년", "올해의", String(SUPPORTED_SEASON)];
const UNSUPPORTED_SEASON_WORDS = [
  "작년", "지난해", "지난시즌", "지난 시즌", "전시즌", "전 시즌", "이전시즌", "이전 시즌", "지지난해", "재작년",
  "통산", "커리어", "역대", "생애", "누적",
];

/**
 * 연도별 시리즈 의도 (2026-08-10 하린아빠 캐처: `최형우의 연도별 타율 추이`).
 * ⚠️ 열린 언어 재진입이 아니다 — 이 단어들은 기록 질문의 시점 한정어로 폐쇄적이고,
 * 놀치면 기존 경로(올해 단답)로 내려가 틀린 답이 아니라 좁은 답이 된다(fail-open 안전).
 */
const SERIES_WORDS = ["연도별", "년도별", "시즌별", "해마다", "매년", "추이"];
/**
 * literal A′ frozen contract (삼순 10차): 데뷔/입단이 full-origin series 로 해석되는
 * **유일한** 문자 형태. 이 인접 패턴 밖은 전부 fail-close — 확장·추론 금지.
 */
const CANONICAL_DEBUT_SERIES =
  /(?:데뷔|입단)(?:시점|초)?(?:이래|이후|부터|후)(?:(?:현재|지금|올해|오늘)까지)?(?:연도별|년도별|시즌별)/;
const CAREER_TOTAL_WORDS = ["통산", "커리어", "역대", "생애", "누적"];
/** 상대 과거 시즌어 → 몇 해 전인가. */
const RELATIVE_PAST_SEASONS: ReadonlyArray<readonly [string, number]> = [
  ["지지난해", 2], ["재작년", 2],
  ["작년", 1], ["지난해", 1], ["지난시즌", 1], ["지난 시즌", 1],
  ["전시즌", 1], ["전 시즌", 1], ["이전시즌", 1], ["이전 시즌", 1],
];

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

/** 시점 참조 전수 스캔 결과 — selector 는 이 구조만 보고 결정한다. */
interface TemporalScan {
  readonly spaced: string;
  /** 과거 상대어(작년=1·재작년=2…) — 참조가 정확히 1개일 때만 non-null. */
  readonly pastDelta: number | null;
  /** 명시 연도 — distinct 가 정확히 1개일 때만 non-null. */
  readonly explicitYear: number | null;
  /** 명시연도(distinct)+상대연도+현재어 총 참조 수. */
  readonly refTotal: number;
  /** 최근 N<단위> (단위 무관 — `최근 3년`·`최근 10경기` 모두). */
  readonly recentRange: boolean;
  /**
   * 데뷔/입단 한정의 **구조 분류** (삼순 5차 — regex 덧대기 금지):
   * none = 언급 없음 · full_origin = 데뷔 기점 전체(전 커리어 동치, career 로만 해석) ·
   * other = 그 외 전부(단일 데뷔 시즌·bounded N년·bare 언급) — 축소 금지, fail-close.
   */
  readonly debutScope: "none" | "full_origin" | "other";
  /** 시점 토큰을 소거한 잔여 문자열에 남은 범위 표지(까지·이후·이전·부터·~). */
  readonly rangeMarker: boolean;
  readonly seriesWord: boolean;
  readonly careerWord: boolean;
}

/**
 * 시점 참조를 **소거 방식**으로 센다. 긴 토큰부터 소거해야 `재작년`⊃`작년` 같은 부분열
 * 중복 집계가 없고(`작년과 재작년` = 2), `이전시즌`(지원 상대어)을 소거한 뒤에 남는
 * `이전`(범위 표지)만 range 로 판정할 수 있다.
 */
function scanTemporalRefs(question: string): TemporalScan {
  const spaced = normalizeWithSpaces(question);
  let rest = spaced.replace(/\s+/g, "");
  // ── 데뷔/입단 한정 — literal A′ (삼순 10차 frozen contract) ─────────────────
  // 자연어 추론(careerReq·unitLeft·잔여검사) 없음. `데뷔|입단` 은 **원 캡처의
  // canonical span 에 annual series 표지가 문자 그대로 인접**할 때만 full_origin:
  //   (데뷔|입단)(시점|초)?(이래|이후|부터|후)((현재|지금|올해|오늘)까지)?(연도별|년도별|시즌별)
  // 이 literal 패턴 밖의 모든 데뷔/입단 언급(이래/후 bare·통산어 동반·서수·수사·
  // 명명형·bounded·`후 3년 … 추이` 등 사이에 무엇이든 끼는 형태)은 분기 하나로
  // other(fail-close). 상대시점 자연어는 별도 트랙(제한 AST + career row 환산) 몫이다.
  let debutScope: "none" | "full_origin" | "other" = "none";
  if (/데뷔|입단/.test(rest)) {
    if (CANONICAL_DEBUT_SERIES.test(rest)) {
      debutScope = "full_origin";
      // canonical span 은 참조·범위표지 집계 **전에** 통째로 소거한다 — `현재까지` 를
      // 참조·cutoff 로 세면서 범위로 오판하는 것을 구조로 방지 (캡처 exact).
      // series 표지는 spaced 기준 seriesWord 검출로 이미 확보되므로 함께 소거해도 된다.
      rest = rest.replace(new RegExp(CANONICAL_DEBUT_SERIES.source, "g"), "\u0000");
    } else {
      debutScope = "other";
    }
  }
  const recentRange = /최근\d+/.test(rest);
  const explicitYearSet = new Set(
    [...rest.matchAll(/(?:19|20)\d{2}/g)].map((match) => Number(match[0])),
  );
  rest = rest.replace(/(?:19|20)\d{2}(?:년|시즌)?/g, "\u0000");
  const pastDeltas: number[] = [];
  for (const [word, delta] of [
    ["지지난해", 2], ["재작년", 2],
    ["이전시즌", 1], ["전시즌", 1], ["지난시즌", 1], ["지난해", 1], ["작년", 1],
  ] as const) {
    while (rest.includes(word)) {
      rest = rest.replace(word, "\u0000");
      pastDeltas.push(delta);
    }
  }
  let currentRefs = 0;
  // `현재/지금/현시즌` 도 현재 시점 참조다 (삼순 3차: `작년과 현재 비교` 가 refTotal=1 로
  // 작년 단일값 축소). 긴 토큰 먼저 — `현시즌` 소거 후 잔여에서 `현재` 를 세지 않도록.
  for (const word of ["이번시즌", "올시즌", "현시즌", "올해", "금년", "현재", "지금"]) {
    while (rest.includes(word)) {
      rest = rest.replace(word, "\u0000");
      currentRefs += 1;
    }
  }
  const refTotal = explicitYearSet.size + pastDeltas.length + currentRefs;
  return {
    spaced,
    pastDelta: refTotal === 1 && pastDeltas.length === 1 ? pastDeltas[0] : null,
    explicitYear: refTotal === 1 && explicitYearSet.size === 1 ? [...explicitYearSet][0] : null,
    refTotal,
    recentRange,
    debutScope,
    rangeMarker: /까지|이후|이전|부터|[~∼]/.test(rest),
    seriesWord: SERIES_WORDS.some((word) => spaced.includes(word)),
    careerWord: CAREER_TOTAL_WORDS.some((word) => spaced.includes(word)),
  };
}

function normalizeWithSpaces(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** 모든 명시 연도 중 2026 외 값은 미지원. 하드코딩 연도 목록은 2019/2027을 놓친다. */
function hasUnsupportedSeason(value: string): boolean {
  const normalized = normalizeWithSpaces(value);
  if (UNSUPPORTED_SEASON_WORDS.some((word) => normalized.includes(normalizeWithSpaces(word)))) return true;
  return [...normalized.matchAll(/(?:19|20)\d{2}(?:\s*년|\s*시즌)?/g)]
    .some((match) => Number(match[0].match(/\d{4}/)?.[0]) !== SUPPORTED_SEASON);
}

/** 수치를 묻는 문장인가. 이게 false 면 기록 경로가 아니다(서술형 RAG 로 간다). */
/** wRC+ 표기(공백 허용). bare wRC 와 구분하는 유일한 신호다. */

/** `wRC+` · `wRC 플러스` — 우리가 실제로 계산하는 지표. */
const WRC_PLUS_PATTERN = /wrc\s*\+|wrc\s*플러스/i;

/** wRC 토큰 자체. bare 여부 판정에 쓴다. */
const BARE_WRC_PATTERN = /wrc/i;

const NUMERIC_QUESTION = /몇|얼마|개야|개나|개\?|기록|스탯|성적|알려|보여|어때|어떻게\s*돼|쳤|던졌|했/;
/**
 * 서술·평가를 묻는 신호. 지표어가 섞여 있어도 **숫자 질문이 아니다**.
 *
 * `김도영 홈런 잘 치는 편이야?` 는 홈런 개수가 아니라 평가를 물은 것이라 서술형 RAG 담당이다.
 * 구단 축의 `TEAM_DESCRIPTIVE_ASK` 와 같은 역할·같은 모양 — 선수 축에도 동일하게 둔다.
 */
const DESCRIPTIVE_ASK =
  /잘\s*(?:치|하|때리|던지|막)|못\s*(?:치|하)|어떤\s*선수|유명|이야기|역사|유래|별명|소개|누구/;

/**
 * 동문서답 방지 (A안, #1243 — 최소 범위). 질문의 **초점**이 세레머니(의례)인데
 * "엔티티 + 지표어"(`기아` + `안타`)만 보고 시즌/팀 누적 숫자를 던지는 동문서답을 막는다.
 *   · `안타를 쳤을때 기아만의 세레머니 있어?` → 팀 안타 988 (X) → 세레머니 이야기(team_rag) (O)
 *
 * ⚠️ **키워드 존재가 아니라 초점이다** (삼순 2026-08-18 6차 NO-GO):
 *   ① 토픽은 `세레머니|세리머니` 원문 축만(응원가·치어리더 등 팬문화 전반 확장은
 *     실로그·반례 근거가 생기면 별도 PR).
 *   ② 명시 수치 요구(`몇 개`·`얼마`)가 있으면 문화 양보 미발동 — `세레머니 말고 올해 팀 홈런
 *     몇 개야?` 는 스탯 질문이다(kbo_structured 유지).
 *   ③ `세레머니 말고/빼고/됐고` 기각 구문도 미발동 — 세레머니는 배제 대상이지 초점이 아니다.
 *   세 조건 모두 닫힌 집합(lessons `open_language_never_closes_with_rules`)이라 거울 회귀 불가.
 *   시점(어제·오늘)·순위·추세·방법 등 스탯 스코프 오답은 A 범위 밖 — B(단일 분류기) 트랙.
 */
// 세레머니 원문 축 표기 변형(오탈자 포함) — 닫힌 집합.
const CEREMONY_TOPIC = /세레머니|세리머니|세레모니|세리모니|쑬레머니/;
// 기각 분할자 — `…는 말고/빼고/됐고 …`처럼 앞 화제를 버리고 뒤 화제로 넘어가는 표지.
const DISMISS_SPLIT = /말고|말구|빼고|빼구|됐고|됐으니|제외하고|제외/;

/**
 * 질문 초점이 세레머니(구단 의례)인가 — 그렇다면 구조화 스탯을 양보하고 team_rag(나무위키
 * 근거)에 맡긴다. 근거가 없으면 team_rag 가 null 로 양보하므로 과탐지도 안전하다.
 *
 * 판정 = **세그먼트 순서** (삼순 2026-08-18 8차 NO-GO — 기각어 근접창 `{0,2}` 방식 금지):
 *   기각 표지(`말고/빼고/됐고…`)로 문장을 분할하면 질문의 실제 초점은 **마지막 세그먼트**에
 *   남는다. 세레머니 토큰이 마지막 세그먼트에 있을 때만 문화 초점이다.
 *   · `세레머니 이야기는 됐고 KIA 팀 타율 알려줘` → 세레머니가 앞 세그먼트 → false(스탯 유지)
 *   · `홈런 말고 세레머니 알려줘` → 세레머니가 마지막 세그먼트 → true(team_rag)
 *   거리 제한이 없어 `이야기는/은 일단` 같은 삽입어에 뚛리지 않고, 분할자 집합은 닫혔다.
 *
 * ⚠️ 수치어(`몇|얼마`)는 배제조건이 **아니다** (삼순 7차): `세레머니 몇 번 해?`는 세레머니
 *   수량 질문 — 초점은 여전히 세레머니다.
 */
export function isCulturalTopicQuestion(question: string): boolean {
  const compact = normalize(question);
  const segments = compact.split(DISMISS_SPLIT);
  return CEREMONY_TOPIC.test(segments[segments.length - 1] ?? "");
}

export interface SeasonRecordQuery {
  /** 'batter' | 'pitcher' — 어느 테이블을 볼지. */
  table: "batter" | "pitcher";
  metric: string;
  label: string;
  kind: "count" | "rate" | "raw";
}

/** 과거·통산·연도별은 KBO 공식 연도별 테이블(career-series)을 본다. */
export type CareerSpan =
  | { type: "series" }
  | { type: "career" }
  | { type: "year"; year: number };

/**
 * `resolveSeasonRecordIntent` 의 부가 문맥 — 질문 문자열만으로는 모르는 것.
 *
 * 🔴 `playerBound` 는 **파이프라인이 이미 계산한 사실**을 넘겨받는 것이지,
 *   이 모듈이 이름을 다시 푸는 게 아니다. 로스터 매칭을 여기서 재구현하면 두 곳이
 *   갈라지고, 그 드리프트가 곱 9월 하니스 사고의 구조였다.
 *
 * ⚠️ 기본값 `false` 는 **안전한 쪽**이 아니라 보수적인 쪽이다(양보). 호출부가
 *   선수 결속을 안 넘기면 bare query 축이 꺼져 값 요구가 사전으로 샐다 —
 *   그래서 호출부 두 곳을 모두 게이트로 묶어 둔다.
 */
export interface SeasonRecordIntentOptions {
  /** 질문이 로스터 선수에 결속됐는가(파이프라인 판정 결과). */
  playerBound?: boolean;
}

export type SeasonRecordIntent =
  | { kind: "none" }
  /** 신뢰할 수 없는 지표(pa/sac/sf) — 명시적으로 답변 거절. */
  | { kind: "untrusted_metric" }
  /** 지원하지 않는 시즌(미래 연도 등) — fail-close. */
  | { kind: "unsupported_season" }
  /** 연도별 시리즈·통산·과거 시즌 — KBO 공식 Total.aspx 조회. */
  | { kind: "career"; query: SeasonRecordQuery; span: CareerSpan }
  | { kind: "query"; query: SeasonRecordQuery };

/**
 * 질문에서 "올해 시즌 기록" 의도를 뽑는다.
 *
 * 판정 순서가 곧 안전 계약이다.
 *   ① 신뢰 못 하는 지표 → 즉시 거절 (allowlist 확인보다 먼저 — 통과 경로를 아예 안 만든다)
 *   ② 과거 시즌 → 거절 (DB 에 그 시즌 row 가 없다)
 *   ③ allowlist 지표 매칭
 *   ④ 수치 질문 형태인지 확인
 */
export function resolveSeasonRecordIntent(
  question: string,
  preferredTable?: "batter" | "pitcher",
  options?: SeasonRecordIntentOptions,
): SeasonRecordIntent {
  const compact = normalize(question);

  // ⚠️ 지표어를 먼저 오려낸다 — `wrc` 는 untrusted 알리아스 `pa` 를 문자열로 포함하진
  // 않지만, 같은 종류의 부분문자열 충돌이 반복되어 명시 면제 목록을 둔다.
  const untrustedTarget = UNTRUSTED_EXEMPT_PATTERNS.reduce(
    (acc, pattern) => acc.replace(pattern, ""),
    compact,
  );
  if (UNTRUSTED_METRIC_ALIASES.some((alias) => untrustedTarget.includes(normalize(alias)))) {
    // 🔴 **지표어 존재 → 값 요구** 로 바꾸었다 (2026-09-04, 삼순 조건부 GO).
    //   종전은 글자만 있으면 차단해서 뜻을 물은 질문에도 "기록을 안내할 수 없다" 가 나갔다.
    if (untrustedValueAsk(question, options?.playerBound === true)) {
      return { kind: "untrusted_metric" };
    }
    // 값 요구가 아니면 이 경로의 소관이 아니다 — `none` 으로 양보해 사전·RAG·LLM 이 받는다.
    return { kind: "none" };
  }
  // 서술·평가형은 지표어가 섞여 있어도 숫자 질문이 아니다 — 서술형 RAG 담당.
  if (DESCRIPTIVE_ASK.test(compact)) return { kind: "none" };
  // 동문서답 방지 (A안) — 질문 초점이 구단 문화·응원 의례(세레머니 등)이면 시즌 누적을
  //   던지지 않고 team_rag/LLM 로 양보한다. 시점·순위·추세 등 스탯 스코프 오답은 B 트랙.
  if (isCulturalTopicQuestion(question)) return { kind: "none" };
  // bare `wRC` 는 **명시 거절**한다(삼순 #1100 8차 P0-1).
  // wRC(가중 득점 생산량) ≠ wRC+(리그·구장 보정 지수). 우린 wRC+ 만 계산하므로
  // bare wRC 에 wRC+ 값을 주면 다른 지표를 속여 답하는 것이다 — 도루·OPS·WAR 은
  // "앱이 이미 그 값을 보여준다"라 열었지만, 이건 앱이 보여주는 값 자체가 다르다.
  if (BARE_WRC_PATTERN.test(compact) && !WRC_PLUS_PATTERN.test(compact)) {
    return { kind: "untrusted_metric" };
  }
  // ⚠️ 수치 의문 판정을 여기서 끝내지 않는다.
  // `김도영 타율`·`김도영 OPS`·`김도영 WAR` 처럼 **지표명만 적은** 질문이 의문사가 없다는
  // 이유로 전부 fail-close 됐다(실측). 유저가 지표명을 적은 순간 원하는 건 그 값이다.
  // 그래서 의문사 확인은 **지표 매칭 뒤로** 미룬다(아래 `explicitlyNumeric` 사용부).
  const explicitlyNumeric = NUMERIC_QUESTION.test(compact);

  // substring 매칭은 1글자 `패`를 `패스트볼`에서 잡고, `승`을 `승부`에서 잡는다.
  // 지표별 경계 regex를 명시해 합성어를 기록 질문으로 오답 변환하지 않는다.
  const patterns: Array<{
    table: "batter" | "pitcher";
    metric: string;
    pattern: RegExp;
    /**
     * 타자/투수 어느 쪽인지 표현만으로는 알 수 없는 공통어인가.
     * `경기 수`만 해당한다 — 이때만 로스터 포지션으로 disambiguate 한다.
     * `등판`(투수 전용)·`출장`(타자 전용)은 표현 자체가 테이블을 지정하므로 절대 덮어쓰지 않는다.
     */
    ambiguous?: true;
  }> = [
    // 투수 전용(타자 공통명보다 먼저)
    { table: "pitcher", metric: "era", pattern: /평균\s*자책(?:점)?|방어율|\bera\b/i },
    { table: "pitcher", metric: "hr", pattern: /피\s*홈런/ },
    { table: "pitcher", metric: "h", pattern: /피\s*안타/ },
    { table: "pitcher", metric: "saves", pattern: /세이브/ },
    { table: "pitcher", metric: "holds", pattern: /홀드/ },
    { table: "pitcher", metric: "wpct", pattern: /승률/ },
    { table: "pitcher", metric: "ip", pattern: /투구\s*이닝|이닝/ },
    { table: "pitcher", metric: "bb", pattern: /볼넷|포볼/ },
    { table: "pitcher", metric: "hbp", pattern: /몸에\s*맞는\s*(?:공|볼)|사구(?!체)/ },
    { table: "pitcher", metric: "so", pattern: /탈\s*삼진|삼진/ },
    { table: "pitcher", metric: "er", pattern: /자책(?:점)?/ },
    { table: "pitcher", metric: "r", pattern: /실점/ },
    { table: "pitcher", metric: "whip", pattern: /\bwhip\b/i },
    // `등판`은 투수 전용 표현 — 로스터 포지션이 타자여도 pitcher 테이블 그대로 두고 fail-close 한다.
    { table: "pitcher", metric: "games", pattern: /등판(?:\s*(?:경기|수))?/ },
    // `몇승/몇 승/승수/10승`은 허용하되 승부·승률은 제외.
    { table: "pitcher", metric: "wins", pattern: /(?:몇\s*승(?:수)?|\d+\s*승(?:수)?|승수|승\s*(?:몇|개))(?!부|률|리)/ },
    // ⚠️ `(?<!실|승)` — `도루 실패 몇 개`가 "실패 몇"으로 잡혀 **투수 패전 수**로 답하던
    // 회귀를 막는다(2026-08-04 도루 지표 추가 중 실측). `승패`도 같은 함정이다.
    { table: "pitcher", metric: "losses", pattern: /(?:몇\s*패(?:수)?|\d+\s*패(?:수)?|패수|(?<!실|승)패\s*(?:몇|개))(?!스트|배|션)/ },

    // 타자
    // ⚠️ `wRC+`·`wRC 플러스` 만 잡는다. bare `wRC` 는 위에서 명시 거절된다 —
    // wRC(가중 득점 생산량)와 wRC+(리그·구장 보정 지수)는 다른 지표고 우리는 wRC+ 만
    // 계산한다. 같은 값으로 답하면 **다른 지표를 속여 답하는 것**이다(삼순 #1100 8차 P0-1).
    { table: "batter", metric: "wrc_plus", pattern: /wrc\s*\+|wrc\s*플러스/i },
    { table: "batter", metric: "avg", pattern: /(?<!장)타율|타률|애버리지/ },
    { table: "batter", metric: "doubles", pattern: /(?:2|이)\s*루타|투\s*베이스/ },
    { table: "batter", metric: "triples", pattern: /(?:3|삼)\s*루타|쓰리\s*베이스/ },
    { table: "batter", metric: "hr", pattern: /홈런|홈란|아치/ },
    { table: "batter", metric: "tb", pattern: /총\s*루타|루타/ },
    { table: "batter", metric: "rbi", pattern: /타점/ },
    { table: "batter", metric: "ab", pattern: /타수/ },
    { table: "batter", metric: "runs", pattern: /득점/ },
    { table: "batter", metric: "hits", pattern: /안타/ },
    // 도루 계열 — `도루실패/도루자`를 `도루`보다 **먼저** 둔다.
    // `도루` 패턴이 먼저 매칭되면 `도루 실패 몇 개`가 도루 성공 수로 답해진다.
    { table: "batter", metric: "cs", pattern: /도루\s*(?:실패|자)/ },
    { table: "batter", metric: "sb", pattern: /도루/ },
    // 출루율·장타율·OPS. `(?<!장)타율` 이 위에 있어 `장타율`은 avg 로 안 샌다.
    { table: "batter", metric: "obp", pattern: /출루율/ },
    { table: "batter", metric: "slg", pattern: /장타율/ },
    { table: "batter", metric: "ops", pattern: /\bops\b|오피에스/i },
    // WAR — `워`로 읽힌 한글 표기는 넣지 않는다(일반어 오탐). 영문 경계만.
    { table: "batter", metric: "war", pattern: /\bwar\b/i },
    // `출장`은 타자 전용 표현. 공통어 `경기 수`보다 먼저 매칭돼야 표현이 보존된다.
    { table: "batter", metric: "games", pattern: /출장(?:\s*(?:경기|수))?/ },
    // 공통어 — 여기서만 포지션 결속이 허용된다.
    { table: "batter", metric: "games", pattern: /경기\s*수/, ambiguous: true },
  ];

  const normalized = normalizeWithSpaces(question);
  let best = patterns.find((entry) => entry.pattern.test(normalized));
  // 지표어가 없으면 이 경로 대상이 아니다. 의문사만 있고 지표가 없는 문장(`김도영 어때?`)은
  // 여기서 걸러져 서술형 RAG 로 간다.
  if (!best) return { kind: "none" };
  // 지표어는 잡혔는데 의문 표현이 전혀 없고, 지표명 외의 서술 요구도 없는 경우 —
  // `김도영 타율` 같은 형태다. 이건 값 요청으로 본다(위 주석 참조).
  void explicitlyNumeric;
  // 공통어 `경기 수`만 이름으로 확정된 로스터 포지션에 결속한다(투수면 pitcher).
  // explicit `등판`/`출장`까지 뒤집으면 `문보경 등판 수`에 타자 경기 수를 답하는 오답이 된다.
  if (best.ambiguous && preferredTable) best = { ...best, table: preferredTable };
  const metrics = best.table === "pitcher" ? PITCHER_METRICS : BATTER_METRICS;
  const def = metrics[best.metric as keyof typeof metrics] as {
    label: string;
    kind: SeasonRecordQuery["kind"];
  };
  const query: SeasonRecordQuery = {
    table: best.table,
    metric: best.metric,
    label: def.label,
    kind: def.kind,
  };

  // ── 시점 판정 (2026-08-10 캐처: `연도별 타율 추이`가 올해 단일값으로 오답) ──────
  // 종전에는 통산·과거 시즌을 "준비 중" fail-close 로 닫았다. 정본이 없어서가 아니라
  // KBO 공식 연도별 테이블(Total.aspx)을 안 보고 있었던 것 — 이제 그 정본으로 답한다.
  //
  // ⚠️ selector 계약 (삼순 2026-08-10 2차 NO-GO — exact 정규식 덧대기 금지):
  //   시점 참조(명시연도·상대연도·현재·최근범위·cutoff)를 **먼저 전부 추출**하고,
  //   복수/범위/미지원 조합이면 축소하지 말고 fail-close 한다. series/career/year 선택은
  //   그 다음이다. "좁은 한정이 넓은 시점어를 이긴다" 를 문장 나열이 아니라 구조로 강제.
  const scan = scanTemporalRefs(question);
  // ⓪-a 월별/경기별 축 — 우리 정본은 연도별 테이블뿐이다. 월·경기 단위 시계열은
  //   서빙 데이터가 없으므로 어느 쪽으로도 축소하지 않고 fail-close (삼순 10차).
  if (/월별|경기별/.test(scan.spaced)) return { kind: "unsupported_season" };
  // ⓪ 데뷔/입단 한정 중 A′ 폐쇄집합(명시 series/통산) 밖 전부 — 서수·수사·명명형·
  //   bounded·bare 를 가리지 않고 현재시즌으로도 전 커리어로도 축소하지 않는다.
  if (scan.debutScope === "other") return { kind: "unsupported_season" };
  // ① 최근 N<단위> 범위 — 단위 무관(경기·년·시즌·일·주…). 연도별 테이블로 답할 수 없다.
  if (scan.recentRange) return { kind: "unsupported_season" };
  // ② 시점 참조 2개 이상 = 비교·범위 질의 (`작년과 올해`·`작년과 재작년`·`2025년과 2026년`).
  //   단일값으로 축소하면 오답이다.
  if (scan.refTotal > 1) return { kind: "unsupported_season" };
  // ③ cutoff·범위 표지(까지·이후·이전·부터·~)가 시점 참조/통산어에 붙으면 부분합·구간
  //   질의다 — 현재 통산 행(올해 포함)·단일 연도와 다른 값이라 fail-close.
  if (scan.rangeMarker && (scan.refTotal > 0 || scan.careerWord)) {
    return { kind: "unsupported_season" };
  }
  // ④ 최고/최저(커리어하이) — 통산 **평균/누계**와 다른 극값이다. 규정타석 판정이 필요해
  //   정본 조회가 아니다 → fail-close.
  if (/최고|최저|최악|커리어\s*하이|하이라이트|베스트|기록\s*경신/.test(scan.spaced)) {
    return { kind: "unsupported_season" };
  }
  // ⑤ 여기부터 시점 참조는 0개 또는 1개다.
  if (scan.seriesWord) {
    // `작년 추이` 처럼 단일 시점+시리즈는 모순 조합 — 축소하지 않고 닫는다.
    if (scan.refTotal > 0) return { kind: "unsupported_season" };
    return { kind: "career", query, span: { type: "series" } };
  }
  if (scan.careerWord) {
    // 명시 통산어(통산/커리어/역대…)만 career total 이다. A′(삼순 10차)에서
    // full_origin 은 항상 명시 series/통산어와 동반되므로 별도 disjunct 는 죽은
    // 코드다 — `데뷔 이래 홈런`(통산어 없음)은 이제 ⓪에서 fail-close 된다.
    if (scan.refTotal > 0) return { kind: "unsupported_season" };
    return { kind: "career", query, span: { type: "career" } };
  }
  if (scan.pastDelta !== null) {
    return { kind: "career", query, span: { type: "year", year: SUPPORTED_SEASON - scan.pastDelta } };
  }
  if (scan.explicitYear !== null && scan.explicitYear !== SUPPORTED_SEASON) {
    if (scan.explicitYear > SUPPORTED_SEASON || scan.explicitYear < 1982) {
      return { kind: "unsupported_season" };
    }
    return { kind: "career", query, span: { type: "year", year: scan.explicitYear } };
  }
  // 현재 시즌 지목(올해) 또는 시점 표현 없음 → 기존 현재 시즌 경로.
  return { kind: "query", query };
}

/** 명시적으로 올해를 지목했는가. 시즌 표현이 아예 없으면 현재 시즌으로 본다. */
export function mentionsCurrentSeason(question: string): boolean {
  return !hasUnsupportedSeason(question);
}

export { CURRENT_SEASON_WORDS };

/** DB row (snake_case 그대로). 값 변환은 하지 않는다. */
export interface SeasonRecordRow {
  player_key: string;
  kbo_id: string;
  name: string;
  team: string | null;
  updated_at: string;
  [metric: string]: unknown;
}

/**
 * stats cron 1주기.
 *
 * Vercel cron 실측: `/api/cron/stats` 는 `0 21 * * *` (매일 21:00 UTC) 1회다.
 * 한 주기를 넘겨도 갱신이 없으면 그 값은 "오늘 경기 결과가 빠진 값"일 수 있으므로 답하지 않는다.
 * 삼순 확정 계약대로 경계는 24시간이다 — 25시간 row를 허용했던 30h 구현은 회귀다.
 */
export const STATS_STALE_MS = 24 * 60 * 60 * 1000;

export type SeasonRecordOutcome =
  | { kind: "ok"; value: string; label: string; asOf: string; name: string; team: string | null }
  /** row 없음 / 값 없음 — 수집 안 된 선수. */
  | { kind: "missing" }
  /** 기준시각이 너무 오래됨 — 틀린 값을 최신인 척 답하지 않는다. */
  | { kind: "stale"; asOf: string }
  /** identity 불일치·행 중복 등 신뢰 붕괴. */
  | { kind: "inconsistent" };

/**
 * 조회 결과를 답변 가능한 형태로 확정한다.
 *
 * @param rows kboId exact 조회 결과 (이름 조회 금지 — 동명이인이 섞인다)
 * @param expectedKboId 서버가 특정한 kboId. row 가 이걸 벗어나면 타 선수 오염이다.
 * @param now 판정 기준 시각 (테스트 주입)
 */
export function resolveSeasonRecord(
  rows: SeasonRecordRow[],
  query: SeasonRecordQuery,
  expectedKboId: string,
  now: number,
  expectedName?: string,
  expectedTeam?: string | null,
): SeasonRecordOutcome {
  // row 0 = 미수집, 2+ = 같은 kboId 가 여러 행 → 어느 게 맞는지 모른다. 둘 다 답하지 않는다.
  if (rows.length !== 1) return rows.length === 0 ? { kind: "missing" } : { kind: "inconsistent" };
  const row = rows[0];
  // 서버가 특정한 선수의 행이 맞는지 두 축으로 재확인한다.
  // player_key 는 upsert 충돌키(정본), kbo_id 는 소비자 식별키다. 둘 중 하나라도 다르면
  // 조회 조건이 제거/변경됐거나 오염행이다 — 이름이 같아도 답하지 않는다.
  if (row.player_key !== expectedKboId || row.kbo_id !== expectedKboId) {
    return { kind: "inconsistent" };
  }
  if (expectedName !== undefined &&
      (row.name !== expectedName || (row.team ?? null) !== (expectedTeam ?? null))) {
    return { kind: "inconsistent" };
  }

  const updatedAt = Date.parse(row.updated_at);
  if (!Number.isFinite(updatedAt)) return { kind: "inconsistent" };
  // 미래 시각도 잘못된 데이터다. `now - future`가 음수라 stale 검사만으로는 통과한다.
  if (updatedAt > now) return { kind: "inconsistent" };
  if (now - updatedAt > STATS_STALE_MS) return { kind: "stale", asOf: row.updated_at };

  const raw = row[query.metric];
  if (raw === null || raw === undefined || raw === "") return { kind: "missing" };

  // **원값 그대로** 낸다. 재계산하지 않는다 — 타율을 hits/ab 로 다시 구하면 DB 표기와 어긋난다.
  let value: string;
  if (query.kind === "count") {
    // 경기수·안타·2루타 같은 누적 count 는 **0 이상 정수**다. 1.5는 오염값이다.
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
      return { kind: "inconsistent" };
    }
    value = String(raw);
  } else if (query.kind === "rate") {
    if (typeof raw !== "string" && typeof raw !== "number") return { kind: "inconsistent" };
    value = String(raw).trim();
    // 타율 `.238`, ERA `3.42`, WHIP `1.23`만. `N/A`·Infinity·음수는 금지.
    if (!/^(?:\d+(?:\.\d{1,3})?|\.\d{1,3})$/.test(value) || Number(value) < 0) {
      return { kind: "inconsistent" };
    }
    // 타율·승률은 확률값이라 [0,1]. ERA/WHIP은 1을 넘을 수 있으므로 공통 상한 금지.
    if ((query.metric === "avg" || query.metric === "wpct") && Number(value) > 1) {
      return { kind: "inconsistent" };
    }
  } else {
    if (typeof raw !== "string") return { kind: "inconsistent" };
    value = raw.trim();
    // 이닝은 cron mapper가 보장하는 KBO 표기(예: `120`, `120 1/3`, `120 2/3`)만.
    if (!/^\d+(?: [12]\/3)?$/.test(value)) return { kind: "inconsistent" };
  }

  return {
    kind: "ok",
    value,
    label: query.label,
    asOf: row.updated_at,
    name: row.name,
    team: (row.team as string | null) ?? null,
  };
}

/** 기준시각을 KST 날짜로 표기. 유저가 "언제 기준 값인지" 알아야 숫자를 믿을 수 있다. */
export function formatAsOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const mm = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(kst.getUTCDate()).padStart(2, "0");
  return `${mm}/${dd}`;
}

export function composeSeasonRecordAnswer(outcome: Extract<SeasonRecordOutcome, { kind: "ok" }>): string {
  const asOf = formatAsOf(outcome.asOf);
  const who = outcome.team ? `${outcome.name}(${outcome.team})` : outcome.name;
  const suffix = asOf ? `\n\n📊 ${SUPPORTED_SEASON} 시즌 · ${asOf} 기준` : "";
  return `${who} 선수의 ${SUPPORTED_SEASON} 시즌 ${outcome.label}은 ${outcome.value}입니다.${suffix}`;
}

export const UNTRUSTED_METRIC_ANSWER =
  "그 기록은 아직 정확하게 안내할 수 없습니다. 확인 가능한 기록은 타율·안타·2루타·홈런·타점 등입니다.";
// ⚠️ 2026-08-11 문구 갱신 (P1, 삼순 8/11): #1143/#1144 머지로 통산·특정 연도·연도별 시리즈가
// 지원된다. 종전 문구("통산 기록은 아직 준비 중")는 지원 기능을 미지원으로 안내하는 거짓말이다.
// 이 문구가 닫는 건 frozen contract 밖 상대 기간 표현(`데뷔 후 3년`·`최근 5경기`)뿐이므로
// 지원하는 질문 형태를 정확히 안내한다.
export const UNSUPPORTED_SEASON_ANSWER =
  "그 기간 형태로는 아직 집계할 수 없습니다. 확인 가능한 범위는 특정 연도(예: 2019년 타율), 통산 기록, 연도별 기록입니다.";
export const RECORD_MISSING_ANSWER =
  "그 선수의 올 시즌 기록을 아직 찾지 못했습니다. 조금 뒤 다시 질문하면 최신 상태로 확인하겠습니다.";
