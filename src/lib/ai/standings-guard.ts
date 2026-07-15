// AI 생성물 순위 환각 방지 공통 가드.
// 순위·기록을 다루는 AI 프롬프트(뉴스클리핑·경기 프리뷰 승부예측·경기 결과요약)에
// 공식 순위 데이터(SSOT)를 함께 넣고, 그 값만 근거로 서술하도록 규칙을 강제한다.
//
// 배경(2026-07-15): LG 뉴스클리핑이 삼성의 1위 기록(51승 32패 2무, 0.614)을 KT에
// 오귀속하고 실제 3위 KT를 "선두"로 서술한 사고. 뉴스클리핑은 순위표를 아예 안 넣어
// Gemini가 기사 스니펫만으로 순위를 지어낸 것이 원인. 프리뷰/요약은 이미 순위표를 넣지만
// "순위표를 따르라"는 명시 규칙이 없어 같은 실수 가능 → 공통 규칙으로 통일.

import { buildRankMap, type TeamStanding } from "@/lib/crawler/kbo-api";

/**
 * 공식 순위표 전체를 AI 프롬프트용 텍스트로 포맷.
 * fetchStandings()는 순위 오름차순 정렬된 배열을 반환한다(앱 순위표와 동일 SSOT).
 * 순위는 buildRankMap(원본 ranking 우선 + 승률 competition rank)으로 산정해 공동순위를 보존한다.
 */
export function formatStandingsTable(standings: TeamStanding[]): string {
  const rankByTeam = buildRankMap(standings);
  return standings
    .map((s, i) => {
      const rank = rankByTeam.get(s.teamId) ?? s.ranking ?? i + 1; // map이 전 팀 포함 — 뒤 폴백은 타입 안전용
      const drawsPart = s.draws > 0 ? ` ${s.draws}무` : "";
      // "선두"는 1위에게만 — 2위가 게임차 0(승률차로만 뒤짐)일 수 있어 gamesBehind>0 기준은 오라벨 유발
      const gbPart = rank === 1 ? "선두" : `${s.gamesBehind}게임차`;
      return `${rank}위 ${s.teamName} ${s.wins}승 ${s.losses}패${drawsPart} (승률 ${s.winRate.toFixed(3)}, ${gbPart})`;
    })
    .join("\n");
}

/**
 * 순위·기록 환각 방지 공통 규칙. 공식 순위 데이터를 함께 제공하는 AI 프롬프트에서
 * 순위 데이터 바로 아래에 삽입한다.
 */
export const STANDINGS_ACCURACY_RULES = `[순위 정확성 — 반드시 준수]
- "선두/1위/N위/추격/게임차" 등 순위 관련 서술은 위에 제공된 공식 순위 데이터에 있는 값만 사용하라.
- 기사·스탯 등 다른 정보가 순위 데이터와 상충하면 공식 순위 데이터를 우선하라.
- 순위 데이터에 없는 팀의 순위나, 실제와 다른 순위(예: 실제 3위 팀을 "선두/1위"로)를 특정 팀에 절대 부여하지 마라.`;

/**
 * 순위 데이터를 제공하지 못한 경우(조회 실패 등)의 규칙. 순위 섹션 대신 삽입한다.
 * 근거 없는 순위 서술을 원천 차단 — 발송/생성은 하되 순위 관련 서술만 금지.
 */
export const STANDINGS_UNAVAILABLE_RULES = `[순위 데이터 없음 — 반드시 준수]
- 현재 순위 데이터를 제공하지 못했다. "선두/1위/N위/게임차/추격" 등 순위·순위경쟁 관련 서술을 일절 하지 마라.
- 순위 영향(standingsImpact 등) 필드는 반드시 비워라(null).`;
