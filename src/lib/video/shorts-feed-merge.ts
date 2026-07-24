/**
 * shorts-feed 다중 팀 노출 합류 + 노출 라벨 override (2026-07-24 삼순 라운드4 NO-GO #2).
 *
 * team=LG 피드에 비-LG 저장행(제목에 독립 LG 야구 문맥)을 합류시킬 때,
 * 저장 team_id(수집 계약)는 그대로 두되 **노출 표시값(팀 라벨)은 요청 팀(LG)으로
 * override**한다. 안 그러면 저장 team_id=키움 운영행(79W-OwErIEA)이 LG 피드에
 * 합류했는데 홈 카드가 `키움` 배지로 표시되는 End-User 오표시가 난다.
 */

import { detectAllTeamsFromTitle } from "./team-detector";

export interface ShortsRow {
  video_id: string;
  title: string | null;
  team_id: string | null;
  channel_id: string | null;
  published_at: string;
  [key: string]: unknown;
}

export interface LgFeedJoinResult {
  rows: ShortsRow[];
  /** 노출 응답에서 team_id 대신 쓸 표시 팀 (video_id → 표시팀). */
  displayTeam: Map<string, string>;
}

/**
 * base(LG 1차 조회 결과)에 lgCandidates(비-LG 저장행 중 제목에 LG/엘지 포함)를
 * 다중 팀 노출 경계 게이트로 합류시키고, 합류 행의 노출 라벨을 LG로 override한다.
 */
export function joinLgFeedRows(
  base: ShortsRow[],
  lgCandidates: ShortsRow[],
  trustedForLg: ReadonlySet<string>,
): LgFeedJoinResult {
  const seen = new Set(base.map((v) => v.video_id));
  const rows = [...base];
  const displayTeam = new Map<string, string>();
  let appended = false;

  for (const v of lgCandidates) {
    if (seen.has(v.video_id)) continue;
    const teams = detectAllTeamsFromTitle(v.title ?? "", {
      trustedChannel: Boolean(v.channel_id && trustedForLg.has(v.channel_id)),
    });
    if (!teams.includes("LG")) continue;
    seen.add(v.video_id);
    rows.push(v);
    // 저장 team_id는 유지(수집 계약), 노출 라벨만 요청 팀(LG)으로 override.
    displayTeam.set(v.video_id, "LG");
    appended = true;
  }

  // 합류 행이 맨 뒤에 붙지 않도록 최신순 재정렬
  if (appended) {
    rows.sort((a, b) => (a.published_at < b.published_at ? 1 : -1));
  }

  return { rows, displayTeam };
}
