/**
 * KBO 기록실 소스 universe — 고정 SSOT (삼순 재리뷰 #6 반영).
 *
 * 왜 별도 파일인가: 기존 스모크는 `coverage == KBO_RECORD_BOOK_SOURCES.length`만 검사해서
 * 상수에서 소스를 지워도 GREEN이 됐다(자기참조 게이트). 그래서 **수집 대상 판단과 무관하게
 * 공식 기록실 navigation에 실재하는 경로 전체**를 이 파일에 동결하고, 인벤토리는 이 universe를
 * 기준으로 exact coverage를 검사한다. universe에서 경로를 지우면 스모크가 RED가 된다.
 *
 * 실측 근거 (2026-07-31, 삼식이):
 *   - `/Record/Player/HitterBasic/Basic1.aspx`에서 시작한 `/Record/*` 링크 BFS 전수 크롤로
 *     39경로 수집(선수 개별 상세 `*Detail/Basic.aspx?playerId=` 제외 — 878명 선수 축은
 *     player 인벤토리가 이미 담당).
 *   - 39경로 전건 HTTP 200 실측(비200 0건).
 *   - 각 경로의 서버 렌더 `<table>` 유무를 실측해 include/exclude 사유를 고정.
 *
 * 아직 확인 안 됨: 각 included 경로의 파싱 스키마(컬럼 의미·시즌 파라미터)는 S1b 범위다.
 * 여기서 정하는 것은 "무엇이 존재하고, 무엇을 수집 대상으로 삼는가"까지다.
 */

/** universe 항목의 수집 범위 판정. */
export type RecordSourceScope =
  /** S2a 인벤토리 수집 대상. */
  | "included"
  /** 존재하지만 이번 범위에서 제외 — 반드시 사유를 남긴다(조용한 누락 금지). */
  | "excluded";

export interface KboRecordUniverseEntry {
  /** 인벤토리 entityId. included 항목만 인벤토리에 등재된다. */
  id: string;
  name: string;
  /** koreabaseball.com 절대경로. */
  path: string;
  scope: RecordSourceScope;
  /** excluded면 제외 사유(필수), included면 수집 근거. */
  reason: string;
}

const ORIGIN = "https://www.koreabaseball.com";

export function kboRecordUrl(path: string): string {
  return `${ORIGIN}${path}`;
}

/**
 * 공식 기록실 navigation 전수 universe(39경로, 2026-07-31 실측).
 *
 * excluded 사유 분류:
 *   - `client_rendered_chart`: 서버 HTML에 `<table>` 데이터가 없고 JS 차트로만 그려진다.
 *     정적 fetch로는 수치를 얻을 수 없어 이번 슬라이스의 structured 수집 대상이 아니다(실측).
 *   - `query_form_only`: 사용자가 조건을 입력해야 행이 생기는 조회 폼(기본 응답 데이터행 없음, 실측).
 *   - `covered_by_player_axis`: 선수 개별 상세는 player 인벤토리 878행이 이미 담당.
 */
export const KBO_RECORD_UNIVERSE: KboRecordUniverseEntry[] = [
  // --- 선수 기록 (included) ---
  { id: "hitter_basic1", name: "선수 기록 - 타자 기본1", path: "/Record/Player/HitterBasic/Basic1.aspx", scope: "included", reason: "server_rendered_table" },
  { id: "hitter_basic2", name: "선수 기록 - 타자 기본2", path: "/Record/Player/HitterBasic/Basic2.aspx", scope: "included", reason: "server_rendered_table" },
  { id: "hitter_basic_old", name: "선수 기록 - 타자 기본(과거)", path: "/Record/Player/HitterBasic/BasicOld.aspx", scope: "included", reason: "server_rendered_table" },
  { id: "hitter_detail1", name: "선수 기록 - 타자 세부", path: "/Record/Player/HitterBasic/Detail1.aspx", scope: "included", reason: "server_rendered_table" },
  { id: "pitcher_basic1", name: "선수 기록 - 투수 기본1", path: "/Record/Player/PitcherBasic/Basic1.aspx", scope: "included", reason: "server_rendered_table" },
  { id: "pitcher_basic2", name: "선수 기록 - 투수 기본2", path: "/Record/Player/PitcherBasic/Basic2.aspx", scope: "included", reason: "server_rendered_table" },
  { id: "pitcher_basic_old", name: "선수 기록 - 투수 기본(과거)", path: "/Record/Player/PitcherBasic/BasicOld.aspx", scope: "included", reason: "server_rendered_table" },
  { id: "pitcher_detail1", name: "선수 기록 - 투수 세부1", path: "/Record/Player/PitcherBasic/Detail1.aspx", scope: "included", reason: "server_rendered_table" },
  { id: "pitcher_detail2", name: "선수 기록 - 투수 세부2", path: "/Record/Player/PitcherBasic/Detail2.aspx", scope: "included", reason: "server_rendered_table" },
  { id: "player_defense", name: "선수 기록 - 수비", path: "/Record/Player/Defense/Basic.aspx", scope: "included", reason: "server_rendered_table" },
  { id: "player_runner", name: "선수 기록 - 주루", path: "/Record/Player/Runner/Basic.aspx", scope: "included", reason: "server_rendered_table" },

  // --- 팀 기록 (included) ---
  { id: "team_hitter1", name: "팀 기록 - 타자 기본1", path: "/Record/Team/Hitter/Basic1.aspx", scope: "included", reason: "server_rendered_table" },
  { id: "team_hitter2", name: "팀 기록 - 타자 기본2", path: "/Record/Team/Hitter/Basic2.aspx", scope: "included", reason: "server_rendered_table" },
  { id: "team_hitter_old", name: "팀 기록 - 타자 기본(과거)", path: "/Record/Team/Hitter/BasicOld.aspx", scope: "included", reason: "server_rendered_table" },
  { id: "team_pitcher1", name: "팀 기록 - 투수 기본1", path: "/Record/Team/Pitcher/Basic1.aspx", scope: "included", reason: "server_rendered_table" },
  { id: "team_pitcher2", name: "팀 기록 - 투수 기본2", path: "/Record/Team/Pitcher/Basic2.aspx", scope: "included", reason: "server_rendered_table" },
  { id: "team_pitcher_old", name: "팀 기록 - 투수 기본(과거)", path: "/Record/Team/Pitcher/BasicOld.aspx", scope: "included", reason: "server_rendered_table" },
  { id: "team_defense", name: "팀 기록 - 수비", path: "/Record/Team/Defense/Basic.aspx", scope: "included", reason: "server_rendered_table" },
  { id: "team_runner", name: "팀 기록 - 주루", path: "/Record/Team/Runner/Basic.aspx", scope: "included", reason: "server_rendered_table" },

  // --- 순위 (included) ---
  { id: "team_rank", name: "팀 순위", path: "/Record/TeamRank/TeamRank.aspx", scope: "included", reason: "server_rendered_table" },
  { id: "team_rank_daily", name: "팀 순위 - 일자별", path: "/Record/TeamRank/TeamRankDaily.aspx", scope: "included", reason: "server_rendered_table" },

  // --- 역대 기록 (included) ---
  { id: "history_player_hitter", name: "역대 기록 - 타자", path: "/Record/History/Player/Hitter.aspx", scope: "included", reason: "server_rendered_table" },
  { id: "history_player_pitcher", name: "역대 기록 - 투수", path: "/Record/History/Player/Pitcher.aspx", scope: "included", reason: "server_rendered_table" },
  { id: "history_team_record", name: "역대 기록 - 팀", path: "/Record/History/Team/Record.aspx", scope: "included", reason: "server_rendered_table" },
  { id: "history_top_hitter", name: "역대 최고 기록 - 타자", path: "/Record/History/Top/Hitter.aspx", scope: "included", reason: "server_rendered_table" },
  { id: "history_top_pitcher", name: "역대 최고 기록 - 투수", path: "/Record/History/Top/Pitcher.aspx", scope: "included", reason: "server_rendered_table" },

  // --- 관중 (included: 표 존재) ---
  { id: "crowd_daily", name: "관중 - 일자별", path: "/Record/Crowd/GraphDaily.aspx", scope: "included", reason: "server_rendered_table" },
  { id: "crowd_history", name: "관중 - 역대", path: "/Record/Crowd/History.aspx", scope: "included", reason: "server_rendered_table" },

  // --- 예상 기록 (included) ---
  { id: "expectation_daily", name: "예상 기록 - 일자별", path: "/Record/Expectation/DailyList.aspx", scope: "included", reason: "server_rendered_table" },
  { id: "expectation_week", name: "예상 기록 - 주간", path: "/Record/Expectation/WeekList.aspx", scope: "included", reason: "server_rendered_table" },

  // --- excluded: JS 차트로만 렌더(서버 HTML에 데이터 표 없음, 2026-07-31 실측) ---
  { id: "crowd_graph_team", name: "관중 - 팀별 그래프", path: "/Record/Crowd/GraphTeam.aspx", scope: "excluded", reason: "client_rendered_chart" },
  { id: "crowd_graph_year", name: "관중 - 연도별 그래프", path: "/Record/Crowd/GraphYear.aspx", scope: "excluded", reason: "client_rendered_chart" },
  { id: "team_rank_graph_daily", name: "팀 순위 - 일자별 그래프", path: "/Record/TeamRank/GraphDaily.aspx", scope: "excluded", reason: "client_rendered_chart" },
  { id: "team_rank_graph_year", name: "팀 순위 - 연도별 그래프", path: "/Record/TeamRank/GraphYear.aspx", scope: "excluded", reason: "client_rendered_chart" },
  { id: "ranking_top5", name: "순위 - TOP5", path: "/Record/Ranking/Top5.aspx", scope: "excluded", reason: "client_rendered_chart" },
  { id: "ranking_week", name: "순위 - 주간", path: "/Record/Ranking/Week.aspx", scope: "excluded", reason: "client_rendered_chart" },
  { id: "ranking_month", name: "순위 - 월간", path: "/Record/Ranking/Month.aspx", scope: "excluded", reason: "client_rendered_chart" },

  // --- excluded: 조건 입력형 조회 폼(기본 응답에 데이터행 없음, 실측) ---
  { id: "etc_hit_vs_pit", name: "기타 - 타자 vs 투수", path: "/Record/Etc/HitVsPit.aspx", scope: "excluded", reason: "query_form_only" },
  { id: "record_correct", name: "기록 정정", path: "/Record/RecordCorrect/RecordCorrect.aspx", scope: "excluded", reason: "query_form_only" },
];

/** 인벤토리에 등재되는 기록실 소스(= universe의 included 부분). */
export function includedRecordSources(): KboRecordUniverseEntry[] {
  return KBO_RECORD_UNIVERSE.filter((entry) => entry.scope === "included");
}

/** 제외된 경로 — 조용한 누락 금지를 위해 사유와 함께 공개한다. */
export function excludedRecordSources(): KboRecordUniverseEntry[] {
  return KBO_RECORD_UNIVERSE.filter((entry) => entry.scope === "excluded");
}
