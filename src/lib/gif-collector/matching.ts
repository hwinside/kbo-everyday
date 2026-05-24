/**
 * 움짤콜렉터: 엠팍 글 → KBO 선수/팀 매칭 엔진.
 *
 * 입력: 엠팍 글의 tags + title + content.
 * 출력: matched_kbo_id / matched_board_type / matched_board_id / confidence.
 *
 * 매칭 단계 (스펙 §4):
 *   1. 태그(팀명) → team_id 추출 (1차 disambig).
 *   2. title/content에서 roster의 선수명을 substring 검색.
 *      team_id가 잡혔으면 그 팀 선수로 후보 한정.
 *   3. confidence 산출:
 *      - 정확히 1명 + 같은 팀: 1.0
 *      - 정확히 1명, 팀 무관 (태그에서 team 못 잡음): 0.85
 *      - 같은 팀에 2명+ 후보: 0.5  (team 게시판으로만)
 *      - 후보 0명 + 팀만 잡힘: 0.6 (team 게시판)
 *      - 후보 0명 + 팀도 없음: 0.0 (no match)
 *
 * confidence ≥ 0.8은 PR4 발행 단계에서 자동 게시, 그 미만은 review queue.
 *
 * 외국인 선수는 `resolvePlayer`가 처리하는 alpha/numeric 변환을 활용 — roster의
 * canonical kboId(예: AQ002)를 그대로 matched_kbo_id로 저장한다.
 */

import playersRoster from "@/lib/constants/players-roster.json";
import type { RosterPlayer } from "@/types/api";
import { resolveTeamFromTags } from "./team-tag-map";

const ROSTER = playersRoster as RosterPlayer[];

/** 1글자 한국 성씨 매칭은 false positive 폭발 → 최소 2글자. */
const MIN_PLAYER_NAME_LEN = 2;

export interface MlbparkPost {
  tags: string[];
  title: string;
  content: string;
}

export interface MatchResult {
  matchedKboId: string | null;
  matchedBoardType: "player" | "team" | null;
  matchedBoardId: string | null;
  matchConfidence: number;
  reasons: string[];
}

function findCandidates(text: string, teamId: number | null): RosterPlayer[] {
  const out: RosterPlayer[] = [];
  for (const p of ROSTER) {
    if (p.name.length < MIN_PLAYER_NAME_LEN) continue;
    if (!text.includes(p.name)) continue;
    if (teamId !== null && Number(p.teamId) !== teamId) continue;
    out.push(p);
  }
  return out;
}

export function matchMlbparkPost(post: MlbparkPost): MatchResult {
  const reasons: string[] = [];
  const text = `${post.title}\n${post.content}`;

  const { teamIds, ambiguous } = resolveTeamFromTags(post.tags);
  const teamId = teamIds.length === 1 ? teamIds[0] : null;
  if (teamId) {
    reasons.push(`team_from_tag=${teamId}`);
  } else if (ambiguous) {
    reasons.push(`team_ambiguous(${teamIds.length})`);
  } else {
    reasons.push("team_not_in_tags");
  }

  let candidates = teamId !== null ? findCandidates(text, teamId) : [];
  if (candidates.length === 0 && teamId !== null) {
    const fallback = findCandidates(text, null);
    if (fallback.length > 0) {
      reasons.push("fallback_team_unconstrained");
      candidates = fallback;
    }
  } else if (teamId === null) {
    candidates = findCandidates(text, null);
  }

  if (candidates.length === 1) {
    const p = candidates[0];
    const sameTeam = teamId !== null && Number(p.teamId) === teamId;
    const confidence = sameTeam ? 1.0 : 0.85;
    reasons.push(`player=${p.name}(${p.kboId}) sameTeam=${sameTeam}`);
    return {
      matchedKboId: p.kboId,
      matchedBoardType: "player",
      matchedBoardId: p.kboId,
      matchConfidence: confidence,
      reasons,
    };
  }

  if (candidates.length > 1) {
    reasons.push(
      `player_ambiguous(${candidates.length}): ${candidates.map((c) => c.name).join(",")}`,
    );
    if (teamId !== null) {
      return {
        matchedKboId: null,
        matchedBoardType: "team",
        matchedBoardId: String(teamId),
        matchConfidence: 0.5,
        reasons,
      };
    }
    return {
      matchedKboId: null,
      matchedBoardType: null,
      matchedBoardId: null,
      matchConfidence: 0.3,
      reasons,
    };
  }

  if (teamId !== null) {
    reasons.push("team_only");
    return {
      matchedKboId: null,
      matchedBoardType: "team",
      matchedBoardId: String(teamId),
      matchConfidence: 0.6,
      reasons,
    };
  }

  reasons.push("no_match");
  return {
    matchedKboId: null,
    matchedBoardType: null,
    matchedBoardId: null,
    matchConfidence: 0.0,
    reasons,
  };
}
