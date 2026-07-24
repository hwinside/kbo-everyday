// 선수명 검색 숏츠의 야구 관련성 필터 — videos-shorts 크론(수집)과
// shorts-feed(노출)가 공유하는 단일 SSOT.
//
// 선수 숏츠는 "선수명 + 팀"으로 YouTube를 검색하는데, YouTube는 제목뿐 아니라
// 채널명·설명·태그까지 매칭하므로 동명 비-야구 콘텐츠가 우연히 딸려 들어온다.
// (오스틴=LG 선수 → "하나님의 평가기준…" 종교 영상, 김영우 정치 뉴스가
//  숏츠 피드에 노출, 2026-06-19 #cs 제보). 뉴스의 NON_BASEBALL_NEGATIVE를
//  재사용하되 숏츠에서 자주 새는 정치·종교 stem을 더해 한 곳에서 관리한다.

import { NON_BASEBALL_NEGATIVE } from "@/lib/news-relevance";

// 팀 약칭만으로 team_id가 붙는 커뮤니티 영상은 추가 야구 문맥이 필요하다.
// 특히 `LG`는 LG화학·LG전자 등 계열사 제목에도 흔해서 약칭 단독 매칭을 신뢰할 수 없다.
// 야구 외 문맥에서 거의 안 쓰이는 키워드 — 하나만 있어도 야구 문맥으로 인정.
const SHORTS_BASEBALL_CONTEXT_STRONG = [
  "프로야구",
  "kbo",
  "야구",
  "트윈스",
  "홈런",
  "안타",
  "타점",
  "투수",
  "타자",
  "불펜",
  "마운드",
  "타석",
  "이닝",
  "삼진",
  "볼넷",
  "도루",
  "병살",
  "끝내기",
  "라인업",
  "포수",
  "내야",
  "외야",
  "등판",
  "세이브",
  "타율",
  "평균자책",
  "트레이드",
  "드래프트",
];

// 다의어 — 기업·일반 뉴스에도 흔해(신입사원 선발, 경기 침체, 시장에서 승리,
// 잠실 아파트) 단독으로는 야구 문맥으로 인정하지 않고 2개 이상 조합만 인정.
const SHORTS_BASEBALL_CONTEXT_WEAK = [
  "선수",
  "경기",
  "선발",
  "역전",
  "승리",
  "패배",
  "우승",
  "연승",
  "연패",
  "감독",
  "잠실",
  "하이라이트",
];

// 야구 키워드가 비야구 복합어의 부분문자열로 걸리는 패턴 — 판정 전에 제거.
// ("선수금"의 선수, "경기 침체"의 경기 등)
const NON_BASEBALL_COMPOUNDS = [
  "선수금",
  "경기 침체",
  "경기침체",
  "경기 불황",
  "경기불황",
  "경기 회복",
  "경기회복",
  "경기 부양",
  "경기부양",
  "경기도",
];

/** 제목에 팀 약칭 외의 야구 문맥이 있는지 판정 */
export function hasBaseballShortContext(title: string): boolean {
  let normalized = title.toLowerCase();
  for (const compound of NON_BASEBALL_COMPOUNDS) {
    normalized = normalized.split(compound).join(" ");
  }
  if (SHORTS_BASEBALL_CONTEXT_STRONG.some((k) => normalized.includes(k))) return true;
  const weakHits = SHORTS_BASEBALL_CONTEXT_WEAK.filter((k) => normalized.includes(k));
  return weakHits.length >= 2;
}

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

// 뉴스 negative의 `시장`은 정치(市長)·경제(市場)를 노린 키워드지만, 야구에선
// 'FA 시장·트레이드 시장·외국인 시장' 등 市場이 정상 토픽이라 한글이 겹친다.
// 아래 야구 시장 구문이 제목에 있으면 `시장`만 차단 예외로 둔다(다른 negative는 유지).
const BASEBALL_MARKET_PHRASES = [
  "fa시장",
  "이적시장",
  "트레이드시장",
  "외국인시장",
  "외국인투수시장",
  "스토브시장",
];

/** 제목에 비-야구 negative 키워드가 있으면 차단(노출/수집 공통 2차 필터) */
export function hasNonBaseballSignal(title: string): boolean {
  const compact = title.replace(/\s+/g, "").toLowerCase();
  const isBaseballMarket = BASEBALL_MARKET_PHRASES.some((p) => compact.includes(p));
  return SHORTS_NON_BASEBALL_NEGATIVE.some((n) =>
    n === "시장" && isBaseballMarket ? false : title.includes(n),
  );
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

/**
 * team_id 기반 숏츠 노출 게이트.
 *
 * LG 커뮤니티 영상은 `LG` 약칭만으로는 통과시키지 않는다. 공식 채널·선수 태그가
 * 있거나 제목에 트윈스/KBO/경기 등 야구 문맥이 있을 때만 유지한다. 다른 팀은
 * 기존 동작을 보존하고, 공통 non-baseball negative는 계속 차단한다.
 */
export function isTeamShortRelevant(
  title: string,
  teamId: string | null,
  options: { hasPlayerTag?: boolean; isOfficial?: boolean } = {},
): boolean {
  if (hasNonBaseballSignal(title)) return false;
  if (teamId !== "LG") return true;
  if (options.hasPlayerTag || options.isOfficial) return true;
  return hasBaseballShortContext(title);
}
