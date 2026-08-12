/**
 * KBO 공식 통산표 지표 카탈로그 — **크롤러·서빙·질문 해석이 공유하는 단일 SSOT**.
 *
 * ⚠️ 이 파일은 "룰"이 아니라 **데이터 표**다. 지표를 늘려도 판정 분기는 늘어나지 않는다.
 *   질문 문법은 `career-leaderboard.ts` 에 하나뿐이고, 지표 어휘만 여기서 주입한다.
 *
 * 실측 근거 (2026-08-12, `docs/baseball-qa/kbo-record-endpoint-audit.md` + 직접 probe):
 * - 타자 통산 `HitterBasic/BasicTotal.aspx`
 *   헤더: 순위 선수명 팀명 AVG G PA AB R H 2B 3B HR TB RBI SB BB HBP SO GDP E
 * - 투수 통산 `PitcherBasic/BasicTotal.aspx`
 *   헤더: 순위 선수명 팀명 ERA G CG SHO W L SV HLD WPCT TBF IP H HR BB HBP SO R ER
 *
 * **통산표는 모든 컬럼을 매 행에 담는다.** 그래서 지표마다 정렬을 바꿔 재크롤할 필요가 없다 —
 * 한 번 전 페이지를 훑어 전 컬럼을 파싱하고, 순위는 코드가 정렬해서 만든다.
 */

/** 통산 누적이 **덧셈으로 성립**하는 counting 지표만 여기 둔다. */
export interface CareerMetricSpec {
  /** 카탈로그 키(=JSON 필드명). */
  readonly key: string;
  /** 통산표 컬럼 헤더(파싱 검증용). */
  readonly column: string;
  /** 앱이 서빙하는 2026 시즌 행의 필드명. 없으면 증분을 못 구한다. */
  readonly currentField: string;
  /** 답변에 쓰는 한국어 라벨. */
  readonly label: string;
  /** 질문에서 이 지표를 가리키는 표현들(라벨 포함, 공백 제거 비교). */
  readonly aliases: readonly string[];
  /** 세는 단위 — `2,695안타` 처럼 붙여 렌더한다. 없으면 값만 렌더. */
  readonly unit: string;
}

/**
 * ⚠️ **counting 지표만** 싣는다. `AVG`·`ERA`·`WPCT`·`WHIP` 같은 rate 는 통산을
 * 덧셈으로 만들 수 없다(0.310 + 0.301 은 통산 타율이 아니다). 구성요소로 재계산하는
 * 축은 별도 슬라이스로 남긴다 — 지금 넣으면 검증 없이 추정값이 나간다.
 *
 * ⚠️ `CG`(완투)·`SHO`(완봉)·`TBF` 는 통산표에는 있으나 **앱이 2026 증분을 서빙하지 않는다.**
 * 증분 없이 기준선만 답하면 "2025년 말 값"을 현재 통산으로 말하는 오답이 된다.
 * 그래서 카탈로그에 넣지 않는다 — 별도 수집 슬라이스가 붙으면 그때 추가한다.
 */
export const CAREER_HITTER_METRICS: readonly CareerMetricSpec[] = [
  { key: "games", column: "G", currentField: "games", label: "경기", unit: "경기", aliases: ["경기", "타자경기", "출장", "출장경기", "경기수", "출전경기"] },
  { key: "pa", column: "PA", currentField: "pa", label: "타석", unit: "타석", aliases: ["타석"] },
  { key: "ab", column: "AB", currentField: "ab", label: "타수", unit: "타수", aliases: ["타수"] },
  { key: "runs", column: "R", currentField: "runs", label: "득점", unit: "점", aliases: ["득점"] },
  { key: "hits", column: "H", currentField: "hits", label: "안타", unit: "안타", aliases: ["안타", "최다안타"] },
  { key: "doubles", column: "2B", currentField: "doubles", label: "2루타", unit: "개", aliases: ["2루타", "이루타"] },
  { key: "triples", column: "3B", currentField: "triples", label: "3루타", unit: "개", aliases: ["3루타", "삼루타"] },
  { key: "hr", column: "HR", currentField: "hr", label: "홈런", unit: "개", aliases: ["홈런", "홈런수", "hr"] },
  { key: "tb", column: "TB", currentField: "tb", label: "루타", unit: "루타", aliases: ["루타", "총루타"] },
  { key: "rbi", column: "RBI", currentField: "rbi", label: "타점", unit: "타점", aliases: ["타점", "rbi"] },
  { key: "sb", column: "SB", currentField: "sb", label: "도루", unit: "개", aliases: ["도루", "도루수"] },
  { key: "bb", column: "BB", currentField: "bb", label: "볼넷", unit: "개", aliases: ["볼넷", "타자볼넷"] },
  { key: "hbp", column: "HBP", currentField: "hbp", label: "사구", unit: "개", aliases: ["사구", "타자사구", "몸에맞는공"] },
  { key: "so", column: "SO", currentField: "so", label: "삼진", unit: "개", aliases: ["삼진", "타자삼진"] },
  { key: "gdp", column: "GDP", currentField: "gdp", label: "병살타", unit: "개", aliases: ["병살타", "병살"] },
];

export const CAREER_PITCHER_METRICS: readonly CareerMetricSpec[] = [
  { key: "games", column: "G", currentField: "games", label: "경기", unit: "경기", aliases: ["경기", "등판", "등판수", "경기수"] },
  { key: "wins", column: "W", currentField: "wins", label: "승", unit: "승", aliases: ["승", "승수", "승리"] },
  { key: "losses", column: "L", currentField: "losses", label: "패", unit: "패", aliases: ["패", "패수", "패전"] },
  { key: "saves", column: "SV", currentField: "saves", label: "세이브", unit: "개", aliases: ["세이브"] },
  { key: "holds", column: "HLD", currentField: "holds", label: "홀드", unit: "개", aliases: ["홀드"] },
  { key: "h", column: "H", currentField: "h", label: "피안타", unit: "개", aliases: ["피안타"] },
  { key: "hr", column: "HR", currentField: "hr", label: "피홈런", unit: "개", aliases: ["피홈런"] },
  { key: "bb", column: "BB", currentField: "bb", label: "볼넷", unit: "개", aliases: ["볼넷", "투수볼넷"] },
  { key: "hbp", column: "HBP", currentField: "hbp", label: "사구", unit: "개", aliases: ["사구", "투수사구"] },
  { key: "so", column: "SO", currentField: "so", label: "탈삼진", unit: "개", aliases: ["탈삼진", "삼진"] },
  { key: "r", column: "R", currentField: "r", label: "실점", unit: "점", aliases: ["실점"] },
  { key: "er", column: "ER", currentField: "er", label: "자책점", unit: "점", aliases: ["자책점", "자책"] },
];

export type CareerTable = "batter" | "pitcher";

export const CAREER_METRICS_BY_TABLE: Readonly<Record<CareerTable, readonly CareerMetricSpec[]>> = {
  batter: CAREER_HITTER_METRICS,
  pitcher: CAREER_PITCHER_METRICS,
};

/** `table:key` 형태의 canonical 식별자. 타자 삼진과 투수 탈삼진처럼 같은 키가 갈린다. */
export function careerMetricId(table: CareerTable, key: string): string {
  return `${table}:${key}`;
}

/**
 * 질문 어휘 → 지표. **투수 전용 표현이 아니면 타자를 먼저 본다.**
 *
 * `삼진` 은 타자(당한 삼진)와 투수(탈삼진) 양쪽에 있다. 어느 쪽인지 질문만으로 못 정하면
 * 답하지 않는 게 맞다 — 여기서는 `ambiguous` 로 돌려주고 호출부가 fail-close 한다.
 */
export interface CareerMetricMatch {
  readonly table: CareerTable;
  readonly spec: CareerMetricSpec;
}

export function matchCareerMetric(compactQuestion: string): CareerMetricMatch | "ambiguous" | null {
  const hits: CareerMetricMatch[] = [];
  for (const table of ["batter", "pitcher"] as const) {
    for (const spec of CAREER_METRICS_BY_TABLE[table]) {
      if (spec.aliases.some((alias) => compactQuestion.includes(alias.replace(/\s+/g, "")))) {
        hits.push({ table, spec });
      }
    }
  }
  if (hits.length === 0) return null;
  // 같은 지표를 여러 alias 로 맞춘 경우는 하나로 본다.
  const ids = new Set(hits.map((h) => careerMetricId(h.table, h.spec.key)));
  if (ids.size === 1) return hits[0];
  // 서로 다른 지표가 동시에 잡히면 무엇을 물었는지 확정할 수 없다.
  return "ambiguous";
}
