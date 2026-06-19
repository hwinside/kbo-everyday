// 선수명 검색 숏츠의 야구 관련성 필터 — videos-shorts 크론(수집)과
// shorts-feed(노출)가 공유하는 단일 SSOT.
//
// 선수 숏츠는 "선수명 + 팀"으로 YouTube를 검색하는데, YouTube는 제목뿐 아니라
// 채널명·설명·태그까지 매칭하므로 동명 비-야구 콘텐츠가 우연히 딸려 들어온다.
// (오스틴=LG 선수 → "하나님의 평가기준…" 종교 영상, 김영우 정치 뉴스가
//  숏츠 피드에 노출, 2026-06-19 #cs 제보). 뉴스의 NON_BASEBALL_NEGATIVE를
//  재사용하되 숏츠에서 자주 새는 정치·종교 stem을 더해 한 곳에서 관리한다.

import { NON_BASEBALL_NEGATIVE } from "@/lib/news-relevance";

// 제목에 등장하면 야구 숏츠가 아니라고 보는 키워드. 야구 헤드라인엔 등장하지
// 않는 정치·종교 stem만 골라 recall 손실 없이 비-야구 영상을 차단한다.
export const SHORTS_NON_BASEBALL_NEGATIVE = [
  ...NON_BASEBALL_NEGATIVE,
  // 정치
  "정권",
  "대통령",
  "국회",
  "의원",
  "총선",
  "선거",
  "탄핵",
  // 종교
  "하나님",
  "예수",
  "목사",
  "설교",
  "성경",
  "찬양",
  "교회",
  "불교",
  "법회",
];

/** 제목에 비-야구 negative 키워드가 있으면 차단(노출/수집 공통 2차 필터) */
export function hasNonBaseballSignal(title: string): boolean {
  return SHORTS_NON_BASEBALL_NEGATIVE.some((n) => title.includes(n));
}

// 선수 검색(source_type="player") 결과가 실제 그 선수 영상인지 판정.
//  (1) 제목에 정치·종교 등 비-야구 negative 키워드가 없어야 함
//  (2) 제목에 선수명이 포함돼야 함 — 채널명·설명으로만 우연 매칭된 영상 차단.
//      (공식 채널 하이라이트는 제목에 선수명이 없을 수 있어 호출처에서 예외 처리)
export function isPlayerShortRelevant(title: string, playerName: string): boolean {
  if (hasNonBaseballSignal(title)) return false;
  if (playerName && !title.includes(playerName)) return false;
  return true;
}
