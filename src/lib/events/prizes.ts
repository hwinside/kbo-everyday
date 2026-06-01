/**
 * 순위별 상품 SSOT (2026-04-20 얼리멤버 이벤트)
 * Source: docs/marketing/community-activation-event-draft.html (삼순이 관할)
 * 변경 시 event-draft.html과 1:1 동기화 필수
 */

export type PrizeTier = {
  rank: string; // "1등", "2등~4등" 등 표시용
  count: number; // 해당 구간 인원수
  prize: string; // 상품명
  badge: string; // 시즌 한정 뱃지 이름
  badgeId: string; // 시즌 한정 뱃지 ID (badges.ts ALL_BADGES 와 1:1)
  highlight?: boolean; // 1등 강조 여부
};

export const INVITE_PRIZES: PrizeTier[] = [
  {
    rank: "1등",
    count: 1,
    prize: "에어팟 프로 3",
    badge: "초대 챔피언",
    badgeId: "event2026-invite-champion",
    highlight: true,
  },
  {
    rank: "2등~4등",
    count: 3,
    prize: "신세계 상품권 10만원권",
    badge: "초대 마스터",
    badgeId: "event2026-invite-master",
  },
  {
    rank: "5등~9등",
    count: 5,
    prize: "신세계 상품권 5만원권",
    badge: "초대 레전드",
    badgeId: "event2026-invite-legend",
  },
  {
    rank: "10등~19등",
    count: 10,
    prize: "신세계 상품권 3만원권",
    badge: "초대 에이스",
    badgeId: "event2026-invite-ace",
  },
  {
    rank: "20등~39등",
    count: 20,
    prize: "스타벅스 상품권 1만원권",
    badge: "리크루터",
    badgeId: "event2026-invite-recruiter",
  },
  {
    rank: "40등~50등",
    count: 11,
    prize: "스타벅스 상품권 5천원권",
    badge: "커넥터",
    badgeId: "event2026-invite-connector",
  },
];

export const WRITING_PRIZES: PrizeTier[] = [
  {
    rank: "1등",
    count: 1,
    prize: "에어팟 프로 3",
    badge: "단장",
    badgeId: "event2026-writing-director",
    highlight: true,
  },
  {
    rank: "2등~4등",
    count: 3,
    prize: "신세계 상품권 10만원권",
    badge: "운영팀장",
    badgeId: "event2026-writing-manager",
  },
  {
    rank: "5등~9등",
    count: 5,
    prize: "신세계 상품권 5만원권",
    badge: "스카우트",
    badgeId: "event2026-writing-scout",
  },
  {
    rank: "10등~19등",
    count: 10,
    prize: "신세계 상품권 3만원권",
    badge: "해설위원",
    badgeId: "event2026-writing-commentator",
  },
  {
    rank: "20등~39등",
    count: 20,
    prize: "스타벅스 상품권 1만원권",
    badge: "기자단",
    badgeId: "event2026-writing-press",
  },
  {
    rank: "40등~50등",
    count: 11,
    prize: "스타벅스 상품권 5천원권",
    badge: "서포터즈",
    badgeId: "event2026-writing-supporter",
  },
];

export function getPrizesByTrack(track: "invite" | "writing"): PrizeTier[] {
  return track === "invite" ? INVITE_PRIZES : WRITING_PRIZES;
}

/**
 * 주어진 순위가 어느 보상 구간에 속하는지 반환.
 * 51위 이하는 null (상품 없음, 얼리멤버 뱃지 대상 아님).
 */
export function getPrizeTierByRank(
  rank: number,
  track: "invite" | "writing"
): PrizeTier | null {
  if (rank < 1 || rank > 50) return null;
  const prizes = getPrizesByTrack(track);
  if (rank === 1) return prizes[0];
  if (rank <= 4) return prizes[1];
  if (rank <= 9) return prizes[2];
  if (rank <= 19) return prizes[3];
  if (rank <= 39) return prizes[4];
  return prizes[5]; // 40~50
}
