/**
 * KBO 공식 선수 상세의 **연도별 성적 테이블**(`…Detail/Total.aspx`)을 typed 로 읽는다.
 *
 * ── 왜 이 파일이 있는가 (2026-08-10 하린아빠 캡처) ──────────────────────────
 *
 *     유저: `최형우의 연도별 타율 추이가 어떻게 돼?`
 *     봇  : `최형우(삼성) 선수의 2026 시즌 타율은 .321입니다.`   ← 올해 단일값만 반복
 *
 *   연도별·통산·과거 시즌 의도가 감지되지 않아 "올해 단일값" 경로가 선점했다.
 *   기존 계약은 통산·작년을 fail-close("준비 중")로 닫았는데, 정본이 없어서가
 *   아니라 **정본을 안 보고 있어서**였다.
 *
 * ── 문장을 파싱하지 않는다 (draft `lblDraft` 선례와 같은 축) ────────────────
 *
 *   KBO 공식 선수 상세에는 연도별 성적이 **이미 구조화 테이블**로 있다:
 *
 *       HitterDetail/Total.aspx?playerId=72443   (타자: 연도·팀명·AVG·G·…)
 *       PitcherDetail/Total.aspx?playerId=61101  (투수: 연도·팀명·ERA·G·…)
 *
 *   첫 행은 `통산`, 이후 연도 오름차순. 컬럼 의미가 하나뿐이라 #1110 의 반대가설
 *   (같은 chunk 안 다른 연도와 구분 불가)이 성립하지 않는다 — 파싱이 아니라 조회다.
 *
 *   ⚠️ 이 값은 RAG 근거가 아니다. 렌더도 코드가 한다(LLM·RAG·cache 불사용).
 *     검증 실패는 전부 null = "모른다" — 지어내지 않고 fail-close 한다.
 */

export interface CareerRecordRow {
  /** 4자리 연도. 통산 행은 별도 필드로 분리한다. */
  year: number;
  /** 그 해 소속 구단 표기 (공식 페이지 그대로: `삼성`·`KIA`·`LG` …) */
  team: string;
  /** 헤더 컬럼명(AVG·G·HR…) → 원값 문자열. 재계산·재서술하지 않는다. */
  values: Record<string, string>;
}

export interface CareerRecord {
  /** 페이지 상단 선수명 — 호출부가 후보 선수와 identity 대조한다. */
  playerName: string;
  /** 연도 오름차순 시즌 행들. */
  rows: CareerRecordRow[];
  /** `통산` 행 (팀명 없음). 없으면 null — 통산 질문은 답하지 않는다. */
  career: Record<string, string> | null;
}

/** KBO 출범(1982) 이전 연도·미래 연도는 데이터 오류다. */
const KBO_FIRST_SEASON = 1982;

/**
 * 지표 → 공식 테이블 컬럼명. **여기 없는 지표는 연도별로 답하지 않는다** —
 * obp/slg/ops/war/wrc+ 는 Total.aspx 에 컬럼이 없거나 우리가 파생 계산하는 값이라
 * (파생 계산을 과거 시즌에 재적용하면 검증 불가) 폐쇄집합으로만 연다.
 */
export const CAREER_METRIC_COLUMNS: Readonly<Record<"batter" | "pitcher", Readonly<Record<string, string>>>> = {
  batter: {
    avg: "AVG", games: "G", ab: "AB", runs: "R", hits: "H",
    doubles: "2B", triples: "3B", hr: "HR", tb: "TB", rbi: "RBI",
    sb: "SB", cs: "CS",
  },
  pitcher: {
    era: "ERA", games: "G", wins: "W", losses: "L", saves: "SV",
    holds: "HLD", wpct: "WPCT", ip: "IP", h: "H", hr: "HR",
    bb: "BB", hbp: "HBP", so: "SO", r: "R", er: "ER", whip: "WHIP",
  },
};

/** 값 형식 검증 — 형식이 다르면 그 행 전체를 버린다(부분 신뢰 금지). */
function isPlausibleValue(value: string): boolean {
  // 정수(2409) · 비율(0.310) · 이닝(1479 1/3) · 대시(결측 표기 `-`)
  return /^\d+$/.test(value) || /^\d+\.\d{1,3}$/.test(value) || /^\d+(?: \d\/\d)?$/.test(value) || value === "-";
}

function stripTags(cell: string): string {
  return cell.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
}

/**
 * Total.aspx HTML → CareerRecord. **어떤 이상이든 null** — 호출부는 null 을
 * "확인 못 함"으로 닫는다. 부분 성공을 돌려주지 않는다(잘린 시리즈는 오답이다).
 */
export function parseCareerTotalsHtml(html: string, currentSeason: number): CareerRecord | null {
  const nameMatch = html.match(/lblName[^>]*>([^<]+)</);
  const playerName = nameMatch?.[1]?.trim();
  if (!playerName) return null;

  const tableMatch = html.match(/<table[^>]*>[\s\S]*?<\/table>/);
  if (!tableMatch) return null;
  const table = tableMatch[0];

  // ⚠️ 셀 추출은 행 단위로 td|th 를 같이 본다 — 실측: 데이터 행의 `연도`/`통산` 셀이
  // <th> 로 되어 있어 td 만 뽑으면 컬럼이 하나씩 밀린다(전면 null 로 죽던 결함).
  const trs = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  const rowCells = trs
    .map((tr) => [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => stripTags(m[1])))
    .filter((cells) => cells.length > 0);
  if (rowCells.length < 2) return null;
  const headers = rowCells[0];
  if (headers[0] !== "연도" || headers[1] !== "팀명" || headers.length < 4) return null;

  const rows: CareerRecordRow[] = [];
  let career: Record<string, string> | null = null;
  for (const cells of rowCells.slice(1)) {
    if (cells[0] === "통산") {
      // 통산 행은 팀명 칸이 없다 — 컬럼이 하나 앞으로 당겨진다.
      if (cells.length !== headers.length - 1) return null;
      const values: Record<string, string> = {};
      for (let i = 1; i < cells.length; i += 1) {
        if (!isPlausibleValue(cells[i])) return null;
        values[headers[i + 1]] = cells[i];
      }
      career = values;
      continue;
    }
    if (cells.length !== headers.length) return null;
    const year = Number(cells[0]);
    if (!Number.isInteger(year) || year < KBO_FIRST_SEASON || year > currentSeason) return null;
    const values: Record<string, string> = {};
    for (let i = 2; i < cells.length; i += 1) {
      if (!isPlausibleValue(cells[i])) return null;
      values[headers[i]] = cells[i];
    }
    rows.push({ year, team: cells[1], values });
  }

  if (rows.length === 0) return null;
  // 연도 오름차순 강제 — 순서가 흐트러진 테이블은 구조가 변한 것이다.
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].year <= rows[i - 1].year) return null;
  }
  return { playerName, rows, career };
}

/** 공식 상세 URL. playerId = kboId (roster SSOT 의 그 값이다). */
export function careerTotalsUrl(table: "batter" | "pitcher", kboId: string): string {
  const path = table === "pitcher" ? "PitcherDetail" : "HitterDetail";
  return `https://www.koreabaseball.com/Record/Player/${path}/Total.aspx?playerId=${kboId}`;
}

export type CareerRecordFetcher = (
  table: "batter" | "pitcher",
  kboId: string,
) => Promise<CareerRecord | null>;

/**
 * seam factory — 게이트가 이 **같은 함수**를 fixture HTML 로 실행한다
 * (인라인 lambda 는 정규식 검사만 남아 false-green 이 된다, 삼순 #1100 3차 P0-3).
 *
 * 외부 시그니처(UA·Referer)는 한 곳에 모은다 — KBO 는 정책을 예고 없이 바꾼다
 * (2026-05-20 Referer 정책 변경으로 분산 호출 11파일 전면 장애).
 */
export function createCareerRecordFetcher(
  fetchHtml?: (url: string) => Promise<string | null>,
  now?: () => number,
): CareerRecordFetcher {
  const loadHtml = fetchHtml ?? (async (url: string) => {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
        Referer: "https://www.koreabaseball.com/",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return res.text();
  });
  return async (table, kboId) => {
    if (!/^\d+$/.test(kboId)) return null; // URL 주입 방지 — kboId 는 숫자다.
    const html = await loadHtml(careerTotalsUrl(table, kboId));
    if (!html) return null;
    const season = new Date(now ? now() : Date.now()).getFullYear();
    return parseCareerTotalsHtml(html, season);
  };
}

/* ── 렌더 (코드가 한다 — LLM 불사용) ─────────────────────────────────────── */

/**
 * 연도별 시리즈 답변. 하린아빠 2026-08-10: "단답형 가능한 질문은 단답형으로,
 * 긴 답변이 필요한 경우는 충분히 길게" — 시리즈는 전 연도를 다 보여준다.
 */
export function composeCareerSeriesAnswer(
  name: string,
  label: string,
  column: string,
  record: CareerRecord,
): string | null {
  const lines: string[] = [];
  for (const row of record.rows) {
    const value = row.values[column];
    if (value === undefined) return null; // 컬럼 결측 = 테이블 구조 변화 — 답하지 않는다.
    lines.push(`${row.year} ${row.team} ${value}`);
  }
  const careerValue = record.career?.[column];
  const tail = careerValue !== undefined ? `\n통산 ${careerValue}` : "";
  return `${name} 선수의 연도별 ${label}이에요 (KBO 공식 기록):\n${lines.join("\n")}${tail}`;
}

export function composeCareerTotalAnswer(
  name: string,
  label: string,
  column: string,
  record: CareerRecord,
): string | null {
  const value = record.career?.[column];
  if (value === undefined) return null;
  return `${name} 선수의 KBO 통산 ${label}은(는) ${value}입니다. (공식 기록 기준)`;
}

export function composeCareerYearAnswer(
  name: string,
  label: string,
  column: string,
  year: number,
  record: CareerRecord,
): string | null {
  const row = record.rows.find((r) => r.year === year);
  const value = row?.values[column];
  if (!row || value === undefined) return null;
  return `${name} 선수의 ${year} 시즌 ${label}은(는) ${value}입니다. (${row.team} 소속, KBO 공식 기록)`;
}
