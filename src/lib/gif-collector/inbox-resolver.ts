/**
 * 슬랙 인박스 메시지의 팀/선수 텍스트를 검증하고 roster canonical id로 변환.
 *
 * team: team-tag-map.ALIAS_MAP으로 별칭 정규화 → team_id.
 * player: resolvePlayer({ name, teamId })로 검증 — 외국인 alpha/numeric 변환 자동.
 */

import { ALIAS_MAP, normalizeTag } from "./team-tag-map";
import { resolvePlayer } from "@/lib/utils/resolve-player";

export interface ResolvedInbox {
  teamId: number;
  kboId: string;
  playerCanonicalName: string;
}

export type ResolveInboxResult =
  | { ok: true; value: ResolvedInbox }
  | { ok: false; error: string };

const TEAM_ALIASES =
  "LG/엘지/두산/베어스/KT/위즈/SSG/랜더스/NC/다이노스/KIA/기아/타이거즈/롯데/자이언츠/삼성/라이온즈/한화/이글스/키움/히어로즈";

export function resolveInboxFromInput(
  teamInput: string,
  playerInput: string,
): ResolveInboxResult {
  const teamId = ALIAS_MAP[normalizeTag(teamInput)];
  if (!teamId) {
    return {
      ok: false,
      error: `팀명 '${teamInput}' 인식 실패. 지원 별칭: ${TEAM_ALIASES}`,
    };
  }
  const resolved = resolvePlayer({ name: playerInput, teamId });
  // resolvePlayer는 team 미일치 + 유일한 동명 선수가 있을 때 fallback으로 반환할 수 있다 —
  // 인박스 입력의 명시적 팀 필터를 보존하기 위해 teamId 강제 검증.
  if (!resolved || resolved.teamId !== teamId) {
    return {
      ok: false,
      error: `선수 '${playerInput}' (팀=${teamInput})를 roster에서 찾지 못했어요. 팀과 선수가 일치하는지 확인하세요.`,
    };
  }
  return {
    ok: true,
    value: {
      teamId,
      kboId: resolved.kboId,
      playerCanonicalName: resolved.name,
    },
  };
}
