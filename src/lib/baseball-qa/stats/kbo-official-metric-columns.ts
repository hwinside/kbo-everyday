/**
 * KBO 공식 기록실 **지표 컬럼 inventory** — 통산 리더보드 판정의 유일한 근거.
 *
 * 출처(2026-08-11 실측 감사, `state/kbo-career-endpoint-audit.md`): 아래 페이지들의 표 헤더를
 * 직접 열어 수집한 컬럼이다. 이 파일은 **그 컬럼 목록 자체**이고, 질문 판정에 쓰는 어휘
 * (`CAREER_LEADERBOARD_METRIC_WORDS`)는 여기서 기계적으로 파생된다 — 두 목록을 따로 유지하면
 * 조용히 어긋난다(삼순 #1159 5·8차 drift 실측).
 *   - 타자: HitterBasic/Basic1, Basic2, BasicTotal, Detail1
 *   - 투수: PitcherBasic/Basic1, Basic2, BasicTotal, Detail1
 *   - 수비: Defense/Basic · 주루: Runner/Basic
 *
 * ⚠️ `general: true` 인 컬럼은 **공식 컬럼이지만 한국어 일반명사와 충돌**한다(`G=경기`,
 * `GS=선발`). 이 어휘 하나만으로 리더보드로 단정하면 `역대 최고의 경기 알려줘`·
 * `커리어 선발로 가장 기억나는 경기는?` 같은 서술·주관 질문까지 fail-close 로 막는다
 * (삼순 #1159 10차 P0). 그래서 판정 어휘에서 제외하고, 같은 컬럼의 **비일반 alias**
 * (`경기수`·`출장경기`·`선발등판`)로만 결속한다. 표현 regex 를 늘리는 것이 아니라
 * **컬럼의 다른 공식 표기**를 쓰는 것이므로 닫힌 집합 계약은 유지된다.
 */
export interface KboOfficialMetricColumn {
  /** 공식 표 헤더 코드 (예: `H`, `HR`, `PKO`). */
  code: string;
  /** 한국어 질문에서 이 컬럼을 지칭하는 어휘. 소문자·공백제거 형태로 비교된다. */
  terms: readonly string[];
  /** 어휘가 일반명사와 충돌해 단독 결속이 위험한 컬럼. 비일반 alias 를 `terms` 에 함께 둔다. */
  general?: readonly string[];
  source: "hitter" | "pitcher" | "defense" | "runner";
}

export const KBO_OFFICIAL_METRIC_COLUMNS: readonly KboOfficialMetricColumn[] = [
  // ── 타자 (Basic1 / Basic2 / BasicTotal / Detail1) ──
  { code: "AVG", source: "hitter", terms: ["타율", "타격률"] },
  { code: "G", source: "hitter", terms: ["경기수", "출장경기", "경기출장"], general: ["경기"] },
  { code: "PA", source: "hitter", terms: ["타석"] },
  { code: "AB", source: "hitter", terms: ["타수"] },
  { code: "R", source: "hitter", terms: ["득점"] },
  { code: "H", source: "hitter", terms: ["안타"] },
  { code: "2B", source: "hitter", terms: ["2루타", "이루타"] },
  { code: "3B", source: "hitter", terms: ["3루타", "삼루타"] },
  { code: "HR", source: "hitter", terms: ["홈런"] },
  { code: "TB", source: "hitter", terms: ["루타"] },
  { code: "RBI", source: "hitter", terms: ["타점"] },
  { code: "SAC", source: "hitter", terms: ["희생번트", "희생타"] },
  { code: "SF", source: "hitter", terms: ["희생플라이"] },
  { code: "BB", source: "hitter", terms: ["볼넷"] },
  { code: "IBB", source: "hitter", terms: ["고의사구"] },
  { code: "HBP", source: "hitter", terms: ["사구", "몸에맞는공"] },
  { code: "SO", source: "hitter", terms: ["삼진"] },
  { code: "GDP", source: "hitter", terms: ["병살", "병살타"] },
  { code: "SLG", source: "hitter", terms: ["장타율"] },
  { code: "OBP", source: "hitter", terms: ["출루율"] },
  { code: "OPS", source: "hitter", terms: ["ops"] },
  { code: "MH", source: "hitter", terms: ["멀티히트"] },
  { code: "RISP", source: "hitter", terms: ["득점권타율", "득점권"] },
  { code: "PH-BA", source: "hitter", terms: ["대타타율"] },
  { code: "XBH", source: "hitter", terms: ["장타"] },
  { code: "GO", source: "hitter", terms: ["땅볼"] },
  { code: "AO", source: "hitter", terms: ["뜬공"] },
  { code: "GW RBI", source: "hitter", terms: ["결승타", "결승타점"] },
  { code: "BB/K", source: "hitter", terms: ["볼넷삼진비율"] },
  { code: "P/PA", source: "hitter", terms: ["타석당투구수"] },
  { code: "ISOP", source: "hitter", terms: ["순장타율", "isop"] },
  { code: "XR", source: "hitter", terms: ["추정득점"] },
  { code: "GPA", source: "hitter", terms: ["gpa"] },

  // ── 투수 (Basic1 / Basic2 / BasicTotal / Detail1) ──
  { code: "ERA", source: "pitcher", terms: ["평균자책", "방어율"] },
  { code: "W", source: "pitcher", terms: ["다승", "승수", "승리"] },
  { code: "L", source: "pitcher", terms: ["패전", "패수"] },
  { code: "SV", source: "pitcher", terms: ["세이브"] },
  { code: "HLD", source: "pitcher", terms: ["홀드"] },
  { code: "WPCT", source: "pitcher", terms: ["승률"] },
  { code: "IP", source: "pitcher", terms: ["이닝"] },
  { code: "ER", source: "pitcher", terms: ["자책점"] },
  { code: "R-pit", source: "pitcher", terms: ["실점"] },
  { code: "H-pit", source: "pitcher", terms: ["피안타"] },
  { code: "HR-pit", source: "pitcher", terms: ["피홈런"] },
  { code: "SO-pit", source: "pitcher", terms: ["탈삼진"] },
  { code: "WHIP", source: "pitcher", terms: ["whip"] },
  { code: "CG", source: "pitcher", terms: ["완투"] },
  { code: "SHO", source: "pitcher", terms: ["완봉"] },
  { code: "QS", source: "pitcher", terms: ["퀄리티스타트", "qs"] },
  { code: "BSV", source: "pitcher", terms: ["블론세이브"] },
  { code: "TBF", source: "pitcher", terms: ["상대타자수"] },
  { code: "NP", source: "pitcher", terms: ["투구수"] },
  { code: "AVG-pit", source: "pitcher", terms: ["피안타율"] },
  { code: "WP", source: "pitcher", terms: ["폭투"] },
  { code: "BK", source: "pitcher", terms: ["보크"] },
  { code: "GS", source: "pitcher", terms: ["선발등판", "선발경기"], general: ["선발"] },
  { code: "GF", source: "pitcher", terms: ["경기종료"] },
  { code: "SVO", source: "pitcher", terms: ["세이브기회"] },
  { code: "TS", source: "pitcher", terms: ["터프세이브"] },
  // ⚠️ `SVP(세이브포인트)` 는 감사한 10개 기록표의 컬럼이 아니라 역대 Top 페이지 드롭다운
  // 항목이라 여기 두지 않는다. expected-set 대조(extra 0)를 통과하려면 inventory 는
  // **감사 문서의 표 컬럼과 정확히 같은 집합**이어야 한다.

  // ── 수비 (Defense/Basic) ──
  { code: "E", source: "defense", terms: ["실책"] },
  { code: "PO", source: "defense", terms: ["자살"] },
  { code: "A", source: "defense", terms: ["보살"] },
  { code: "DP", source: "defense", terms: ["더블플레이"] },
  { code: "FPCT", source: "defense", terms: ["수비율"] },
  { code: "PB", source: "defense", terms: ["포일"] },
  { code: "CS%", source: "defense", terms: ["도루저지율", "도루저지"] },

  // ── 주루 (Runner/Basic) ──
  { code: "SBA", source: "runner", terms: ["도루시도"] },
  { code: "SB", source: "runner", terms: ["도루"] },
  { code: "CS", source: "runner", terms: ["도루자", "도루실패"] },
  { code: "SB%", source: "runner", terms: ["도루성공률"] },
  { code: "OOB", source: "runner", terms: ["주루사"] },
  { code: "PKO", source: "runner", terms: ["견제사"] },
];

/**
 * 판정 어휘 = inventory 의 `terms` 전집합. `general` 어휘는 의도적으로 제외한다(위 주석).
 * 이 파생이 유일한 경로이므로 컬럼을 추가하면 판정이 자동으로 따라오고, 반대로 판정 어휘만
 * 몰래 늘리는 것은 불가능하다(게이트가 exact-set 으로 대조한다).
 */
export const KBO_OFFICIAL_METRIC_TERMS: readonly string[] = Object.freeze(
  Array.from(new Set(KBO_OFFICIAL_METRIC_COLUMNS.flatMap((column) => column.terms))),
);

/** 단독 결속이 금지된 일반명사 어휘 전집합 — 게이트가 판정 어휘와의 교집합 0 을 검증한다. */
export const KBO_OFFICIAL_GENERAL_TERMS: readonly string[] = Object.freeze(
  Array.from(new Set(KBO_OFFICIAL_METRIC_COLUMNS.flatMap((column) => column.general ?? []))),
);
