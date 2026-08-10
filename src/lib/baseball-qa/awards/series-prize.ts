/**
 * KBO 공식 한국시리즈 MVP 수상 정본 조회 (`/Player/Awards/SeriesPrize.aspx`).
 *
 * 왜 이 축인가 (삼순 2026-08-10 NO-GO 반영): `작년 LG우승에 가장 큰 기여를 한 사람은
 * 누구야?` 를 generic LLM 에 위임하면 모델이 오지환·박동원 등 다른 실존 선수를 확신해서
 * 말해도 어떤 가드도 못 잡는다 — 이름은 숫자 가드 밖이고, `answerInQuestionScope` 는
 * 야구 신호만 본다. 그런데 이 질문에는 **정본이 있다**: KBO 공식 수상 현황 페이지가
 * 연도별 한국시리즈 MVP 를 구조화 테이블로 서빙한다(2025 = 김현수·LG·외야수 실측).
 * `lblDraft` 입단연도 축과 같은 원리 — 뜻이 하나뿐인 구조화 필드의 **조회**라 파싱
 * 반대가설이 성립하지 않고, LLM·RAG·cache 를 태우지 않는다.
 *
 * fail-close 계약: 신원 마커·헤더·연도 범위·행 구조 중 하나라도 어긋나면 전체 거부(null).
 * 미배선·조회 실패·연도 미보유는 지어내지 않고 좁은 안내로 닫는다.
 */

export interface SeriesPrizeWinner {
  readonly name: string;
  readonly team: string;
  readonly position: string;
}

export interface SeriesPrizeRow {
  readonly year: number;
  /** 한국시리즈 MVP. 시즌 미종료·미수상 연도는 null (`-` 행). */
  readonly koreanSeries: SeriesPrizeWinner | null;
}

/** KBO 리그 원년. 이 범위 밖 연도가 보이면 파싱이 깨진 것이다. */
const KBO_FIRST_YEAR = 1982;

/**
 * KST 기준 연도. `getUTCFullYear()` 를 그대로 쓰면 KST 1/1 00:00~08:59 에 `작년` 이
 * 1년 어긋난다 (삼순 P1) — 서비스 시간대는 KST 하나뿐이므로 여기서 고정한다.
 */
export function kstYear(now: Date): number {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).getUTCFullYear();
}

/** 페이지 신원 마커 — 이게 없으면 KBO 수상 페이지가 아니다 (리다이렉트·에러 페이지 방어). */
const PAGE_MARKER = "한국시리즈";
const HEADER_MARKER_ALLSTAR = "올스타전";

const NAME_RE = /^[가-힣]{2,12}$/;
const TEAM_RE = /^[가-힣A-Za-z]{2,8}$/;

function cleanCell(cell: string): string[] {
  const spans = [...cell.matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map((m) => m[1].trim());
  if (spans.length > 0) return spans;
  const text = cell.replace(/<[^>]+>/g, " ").trim();
  return text.length > 0 ? text.split(/\s+/) : [];
}

/**
 * 수상 테이블 파싱. 어떤 이상이라도 있으면 **전체 거부(null)** — 부분 결과를 믿지 않는다.
 */
export function parseSeriesPrize(html: string, now: Date = new Date()): SeriesPrizeRow[] | null {
  if (!html.includes(PAGE_MARKER) || !html.includes(HEADER_MARKER_ALLSTAR)) return null;
  const rows: SeriesPrizeRow[] = [];
  for (const tr of html.match(/<tr>[\s\S]*?<\/tr>/g) ?? []) {
    const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => cleanCell(m[1]));
    if (cells.length !== 3) continue; // 헤더(2단 rowspan)·다른 구획은 건너뛴다
    const yearText = cells[0].join("");
    if (!/^\d{4}$/.test(yearText)) continue;
    const year = Number(yearText);
    // 연도 범위 검증 — 원년 이전이나 미래 연도가 보이면 파싱 전체를 버린다.
    if (year < KBO_FIRST_YEAR || year > kstYear(now) + 1) return null;
    const ks = cells[2];
    if (ks.length === 3 && ks.every((v) => v === "-")) {
      rows.push({ year, koreanSeries: null });
      continue;
    }
    // 수상자 셀은 (선수·구단·포지션) 3값이어야 하고 형식이 어긋나면 전체 거부.
    if (ks.length !== 3 || !NAME_RE.test(ks[0]) || !TEAM_RE.test(ks[1]) || !NAME_RE.test(ks[2])) {
      return null;
    }
    rows.push({ year, koreanSeries: { name: ks[0], team: ks[1], position: ks[2] } });
  }
  if (rows.length === 0) return null;
  // 연도 내림차순 + 중복 없음 — 테이블 구조가 바뀌면 여기서 걸린다.
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].year >= rows[i - 1].year) return null;
  }
  return rows;
}

/** 한국시리즈 MVP 를 직접 묻는 모양 (`작년 한국시리즈 MVP 누구야?`). */
const KS_MVP_DIRECT = /한국\s*시리즈.*(mvp|엠브이피|최우수)|(mvp|엠브이피).*한국\s*시리즈|코시.*(mvp|엠브이피)/;
/**
 * 우승 기여·주역을 묻는 모양 (`작년 LG우승에 가장 큰 기여를 한 사람은 누구야?`).
 *
 * ⚠️ 양성 결속 계약 (삼순 2026-08-10 3차 — denylist 금지): KS MVP proxy 로 허용되는
 * 모양은 정확히 두 가지뿐이다.
 *   (a) `한국시리즈/코시` 를 직접 지목한 우승 기여 질문
 *   (b) **구단 지목 + 무한정 `우승`** (원 사고 형태 `작년 LG우승 기여자`) — KBO 구단의
 *       무한정 "우승" 은 한국시리즈 우승을 뜻한다.
 * 그 밖은 전부 물러난다(null → 기존 경로). 특히 **다른 대회·타이틀 문맥이 하나라도
 * 보이면** (a)(b) 를 만족해도 구조적으로 물러난다 — `아시안게임 우승`·`국가대표`·
 * `준우승`·`정규시즌 우승` 을 KS MVP 로 바꿔 답하는 것이 원 결함이다.
 */
const CHAMPION_WORD = /우승/;
const KS_WORD = /한국\s*시리즈|코시|한시\s*리즈|korean\s*series/;
/** KS 가 아닌 대회·타이틀 문맥 — 하나라도 보이면 이 정본 밖. */
const OTHER_COMPETITION = new RegExp(
  [
    "준\\s*우승", "정규\\s*(?:시즌|리그)", "페넌트", "리그\\s*우승", "전반기", "후반기",
    "와일드\\s*카드", "\\bwc\\b", "플레이\\s*오프", "\\bpo\\b", "포스트\\s*시즌", "가을\\s*야구",
    "아시안\\s*게임", "아시아드", "올림픽", "국가\\s*대표", "국대", "\\bwbc\\b", "프리미어\\s*12",
    "월드\\s*시리즈", "일본\\s*시리즈", "메이저", "\\bmlb\\b", "\\bnpb\\b",
    "퓨처스", "2군", "시범\\s*경기", "올스타",
  ].join("|"),
);
const CONTRIB_WORD = /기여|공헌|주역|일등\s*공신|이끌|만들/;
const PERSON_ASK = /누구|누가|사람|선수/;

export type SeriesPrizeIntent = "ks_mvp" | "champion_contrib" | null;

/**
 * 이 정본이 답할 수 있는 질문인가. 판정 입력이 **폐쇄집합**(수상 타이틀·우승 기여 어휘)
 * 이라 룰이 맞다 — 열린 의도 분류가 아니다 (2026-08-10 룰 최소화 기조와 상충하지 않음).
 */
export function resolveSeriesPrizeIntent(question: string): SeriesPrizeIntent {
  const normalized = question.normalize("NFKC").toLowerCase();
  // 다른 대회·타이틀 문맥이 보이면 직접 지목형이라도 물러난다 (`아시안게임에서 우승한
  // 국가대표 중 한국시리즈 MVP 출신` 같은 혼합 질문을 정본 단답으로 오답하지 않기 위함).
  if (OTHER_COMPETITION.test(normalized)) return null;
  if (KS_MVP_DIRECT.test(normalized)) return "ks_mvp";
  if (CHAMPION_WORD.test(normalized) && CONTRIB_WORD.test(normalized) && PERSON_ASK.test(normalized)) {
    // 양성 결속: (a) KS 직접 지목, 또는 (b) 구단 지목 + 무한정 우승.
    if (KS_WORD.test(normalized) || resolvePrizeTeamMention(question) !== null) {
      return "champion_contrib";
    }
  }
  return null;
}

/** 연도 해석 결과 — 단일 확정 / 무지정(최근 확정 연도) / 복수·범위·역대(판정 불가). */
export type SeriesPrizeYearResolution =
  | { readonly kind: "year"; readonly year: number }
  | { readonly kind: "latest" }
  | { readonly kind: "ambiguous" };

/**
 * 질문의 대상 연도를 **구조적으로** 해석한다 (삼순 4차 P0 — 첫 값만 고르면
 * `2024년과 2025년`→2024 단일답, `작년과 올해`→작년 단일답, `역대`→최신 단일답으로
 * 축소된다). 시점 참조를 전부 세어 복수·범위·역대는 `ambiguous` 로 fail-close 하고,
 * 호출부는 **정본 조회 전에** 물러난다. 단일 참조만 연도로 확정하며, 참조가 없으면
 * `latest`(가장 최근 확정 연도 — 정본에서 결정론).
 */
export function resolveSeriesPrizeYear(question: string, now: Date): SeriesPrizeYearResolution {
  let rest = question.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  // 범위·집합 표지: 하나라도 보이면 단일 연도 단답 자체가 성립하지 않는다.
  if (/역대|최근\d+|이후|이전|부터|까지|매년|연도별|모두|전부|각각|씩|[~∼]/.test(rest)) {
    return { kind: "ambiguous" };
  }
  const explicitYears = new Set(
    [...rest.matchAll(/(19[89]\d|20\d{2})(?:년|시즌)/g)].map((m) => Number(m[1])),
  );
  rest = rest.replace(/(19[89]\d|20\d{2})(?:년|시즌)/g, "\u0000");
  const year = kstYear(now);
  let pastYear: number | null = null;
  let pastRefs = 0;
  for (const [word, delta] of [["지지난해", 2], ["재작년", 2], ["지난해", 1], ["작년", 1]] as const) {
    while (rest.includes(word)) {
      rest = rest.replace(word, "\u0000");
      pastRefs += 1;
      pastYear = year - delta;
    }
  }
  let currentRefs = 0;
  for (const word of ["이번시즌", "올시즌", "올해", "금년"]) {
    while (rest.includes(word)) {
      rest = rest.replace(word, "\u0000");
      currentRefs += 1;
    }
  }
  const refTotal = explicitYears.size + pastRefs + currentRefs;
  if (refTotal > 1) return { kind: "ambiguous" };
  if (explicitYears.size === 1) return { kind: "year", year: [...explicitYears][0] };
  if (pastRefs === 1 && pastYear !== null) return { kind: "year", year: pastYear };
  if (currentRefs === 1) return { kind: "year", year };
  return { kind: "latest" };
}

/**
 * 질문이 지목한 구단 → 수상표 표기(`LG`·`KIA`·`한화`…). 파이프라인의 토큰 기반
 * resolveMentionedTeam 은 `한화우승` 붙여쓰기(원 사고 형태)를 못 자르고, canonical
 * 표기도 수상표와 다를 수 있어 전제 비교가 어긋난다 (삼순 P1) — 이 경로 전용으로
 * **수상표 표기에 결속된 폐쇄 alias** 를 compact 부분열로 판정한다. 2개 이상 걸리면
 * 전제 판정 불가로 null (틀린 정정 금지).
 */
const PRIZE_TEAM_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["엘지", "LG"], ["lg", "LG"], ["트윈스", "LG"],
  ["기아", "KIA"], ["kia", "KIA"], ["타이거즈", "KIA"], ["해태", "해태"],
  ["삼성", "삼성"], ["라이온즈", "삼성"],
  ["두산", "두산"], ["베어스", "두산"], ["ob", "OB"],
  ["한화", "한화"], ["이글스", "한화"], ["빙그레", "빙그레"],
  ["롯데", "롯데"], ["자이언츠", "롯데"],
  ["키움", "키움"], ["히어로즈", "키움"], ["넥센", "넥센"],
  ["ssg", "SSG"], ["랜더스", "SSG"], ["sk", "SK"], ["와이번스", "SK"],
  ["엔씨", "NC"], ["nc", "NC"], ["다이노스", "NC"],
  ["케이티", "KT"], ["kt", "KT"], ["위즈", "KT"],
  ["현대", "현대"], ["유니콘스", "현대"],
];

export function resolvePrizeTeamMention(question: string): string | null {
  const compact = question.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  const hits = new Set<string>();
  for (const [alias, table] of PRIZE_TEAM_ALIASES) {
    if (compact.includes(alias)) hits.add(table);
  }
  // SSG 가 걸리면 부분열 SK 도 걸린다 — 상위 표기가 있으면 부분열 표기는 지운다.
  if (hits.has("SSG")) hits.delete("SK");
  return hits.size === 1 ? [...hits][0] : null;
}

export interface SeriesPrizeAnswer {
  readonly answer: string;
  /** 정본 값으로 답했으면 true — 로그 라벨(kbo_structured)이 갈린다. */
  readonly grounded: boolean;
}

/**
 * 정본 행으로 답변 렌더. 값이 없거나 연도가 범위 밖이면 지어내지 않고 좁은 안내.
 *
 * @param mentionedTeam 질문이 지목한 구단 canonical (`LG`·`한화`…). 수상 구단과 다르면
 *   **전제를 정정**한다 — `작년 한화 우승에 기여한 선수?` 에 김현수만 주면 유저는
 *   한화 우승으로 읽는다 (입단연도 축의 askedTeam 계약과 같은 원리).
 */
export function renderSeriesPrizeAnswer(
  rows: SeriesPrizeRow[],
  intent: Exclude<SeriesPrizeIntent, null>,
  askedYear: number | null,
  mentionedTeam: string | null,
  nowYear: number,
): SeriesPrizeAnswer {
  const year = askedYear ?? rows.find((row) => row.koreanSeries !== null)?.year ?? null;
  if (year === null) {
    return { answer: "한국시리즈 MVP 기록을 아직 확인할 수 없어요. 조금 뒤에 다시 물어봐 주세요!", grounded: false };
  }
  const row = rows.find((r) => r.year === year);
  if (!row) {
    return { answer: `${year}년 한국시리즈 MVP 기록은 아직 갖고 있지 않아요. 다른 연도를 물어봐 주세요!`, grounded: false };
  }
  if (!row.koreanSeries) {
    // 같은 `-` 라도 뜻이 갈린다 (삼순 P1): 현재 시즌은 "아직 미확정", 과거 연도는
    // 한국시리즈 미개최(1985 삼성 전·후기 통합우승 등) — "시즌이 끝나면" 은 오안내다.
    if (year >= nowYear) {
      return { answer: `${year}년 한국시리즈는 아직 MVP가 정해지지 않았어요. 시즌이 끝나면 알려드릴게요!`, grounded: true };
    }
    return { answer: `${year}년에는 한국시리즈가 열리지 않아 한국시리즈 MVP가 없어요.`, grounded: true };
  }
  const w = row.koreanSeries;
  const who = `${w.name} 선수(${w.team}, ${w.position})`;
  // 전제 정정 — 질문이 지목한 구단과 실제 수상(우승) 구단이 다르면 먼저 바로잡는다.
  const premiseFix = mentionedTeam && mentionedTeam !== w.team
    ? `${year}년 한국시리즈 우승은 ${mentionedTeam}이(가) 아니라 ${w.team}이었어요. `
    : "";
  if (intent === "ks_mvp") {
    return { answer: `${premiseFix}${year}년 한국시리즈 MVP는 ${who}예요.`, grounded: true };
  }
  return {
    answer:
      `${premiseFix}기준에 따라 다를 수 있지만, ${year}년 한국시리즈 MVP 기준으로는 ${who}가 우승의 주역으로 꼽혀요. ` +
      "시즌 전체 기여는 타율·홈런·WAR 같은 어떤 스탯을 기준으로 보느냐에 따라 달라질 수 있어요.",
    grounded: true,
  };
}

const SERIES_PRIZE_URL = "https://www.koreabaseball.com/Player/Awards/SeriesPrize.aspx";

/**
 * production `QaDeps.fetchSeriesPrizeHtml` 주입값 factory (fetch-season-record 와 같은 seam).
 * 테스트가 이 함수를 직접 실행해 URL·헤더 계약을 검증할 수 있게 분리한다.
 */
export function createSeriesPrizeHtmlFetcher(
  fetchImpl: typeof fetch = fetch,
): () => Promise<string> {
  return async () => {
    const res = await fetchImpl(SERIES_PRIZE_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; keubo-fan-bot)" },
      // 수상 정보는 연 단위로만 바뀐다 — 재검증 주기를 길게 잡아 원본 부하를 줄인다.
      next: { revalidate: 21600 },
    } as RequestInit);
    if (!res.ok) throw new Error(`series prize fetch failed: ${res.status}`);
    return res.text();
  };
}

export { SERIES_PRIZE_URL };
