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
  "타율",
  "평균자책",
  "트레이드",
  "드래프트",
];

// 다의어 — 기업·일반 뉴스에도 등장(신입사원 선발, 경기 침체, 잠실 아파트).
// 기업 접미 미결합 독립 `LG` 언급과 결합할 때만 야구 문맥으로 인정(1개면 충분).
// 기업 접미 결합 문서는 몇 개 조합해도 복원 불가 — 2026-07-24 삼순 라운드2:
// weak 2개 조합 기준은 `신입사원 선발 경쟁에서 승리`를 통과시키면서 정상
// `LG 경기 결과`는 차단하는 양방향 결손이라 폐기.
const SHORTS_BASEBALL_CONTEXT_WEAK = [
  "선수",
  "경기",
  "세이브",
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
  "근황",
  "분위기",
  "루키",
];

// `LG` 바로 뒤에 계열사 접미가 결합하면 그 언급은 기업 뉴스 신호 —
// 문서에 독립 LG 언급이 따로 없으면 팀 신호에서 제외한다 (삼순 라운드2 가이드).
const LG_CORPORATE_SUFFIX =
  "(?:lg|엘지)\\s?(?:화학|전자|유플러스|u\\+|에너지솔루션|엔솔|디스플레이|이노텍|생활건강|헬로비전|씨엔에스|cns|전선|상사|하우시스|그룹)";
const LG_CORPORATE_RE = new RegExp(LG_CORPORATE_SUFFIX, "i");
const LG_CORPORATE_RE_G = new RegExp(LG_CORPORATE_SUFFIX, "gi");

// 독립 LG 언급(영문 약칭 단어 경계 또는 한글 `엘지`)
const LG_STANDALONE_RE = /(^|[^A-Za-z0-9])lg(?![A-Za-z0-9])|엘지/i;

// `vs` 결합 긍정 신호 — 상대가 *비기업 구단 별칭*(마스코트명)일 때만 단독 인정.
// `한화/삼성/롯데` 같은 기업명 상대는 `LG 워시타워 vs 삼성 원바디`류 제품 비교도
// 야구로 오인하므로(2026-07-24 삼순 라운드3), 별도 야구 시그널(strong/weak·LG팬)
// 또는 검증 야구채널 신호와 결합해야 통과한다.
const KBO_CLUB_ALIAS_RE =
  /트윈스|이글스|자이언츠|베어스|타이거즈|라이온즈|랜더스|다이노스|위즈|히어로즈/;
const VS_RE = /(?:^|[^a-z0-9])vs\.?(?![a-z0-9])|맞대결/i;
const LG_FAN_RE = /(?:lg|엘지)\s?팬/i;

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

// 한국어는 \b 단어경계가 없어 키워드가 파생어의 부분문자열로 걸린다
// (안타까운→안타, 타자기→타자, 트레이드마크→트레이드). 키워드 *뒤*가
// 문장 끝·비한글이거나, 조사/야구 파생 접미 또는 또 다른 야구 키워드로
// 이어질 때만 매칭으로 인정한다. 앞쪽은 무안타·만루홈런처럼 정상 합성어가
// 많아 제한하지 않는다.
const CONTEXT_ALLOWED_SUFFIXES = [
  // 조사
  "은",
  "는",
  "이",
  "가",
  "을",
  "를",
  "도",
  "만",
  "의",
  "에",
  "로",
  "와",
  "과",
  "랑",
  "서",
  "까지",
  "부터",
  "보다",
  "처럼",
  "마다",
  "조차",
  "마저",
  // 야구 파생 접미 (투수들·홈런왕·투수전·투수진·안타성·홈런쇼·특급·홈런포·
  //  타격력·야구장·KBO리그·역전승·역전패)
  "들",
  "왕",
  "전",
  "진",
  "성",
  "쇼",
  "급",
  "포",
  "력",
  "장",
  "리그",
  "승",
  "패",
];

const HANGUL_CHAR = /[가-힣]/;

function matchesContextKeyword(normalized: string, keyword: string): boolean {
  let idx = normalized.indexOf(keyword);
  while (idx !== -1) {
    const rest = normalized.slice(idx + keyword.length);
    if (
      rest === "" ||
      !HANGUL_CHAR.test(rest[0]) ||
      CONTEXT_ALLOWED_SUFFIXES.some((s) => rest.startsWith(s)) ||
      SHORTS_BASEBALL_CONTEXT_STRONG.some((k) => rest.startsWith(k)) ||
      SHORTS_BASEBALL_CONTEXT_WEAK.some((k) => rest.startsWith(k))
    ) {
      return true;
    }
    idx = normalized.indexOf(keyword, idx + 1);
  }
  return false;
}

/** 제목에 팀 약칭 외의 야구 문맥이 있는지 판정 */
export function hasBaseballShortContext(title: string): boolean {
  let normalized = title.toLowerCase();
  for (const compound of NON_BASEBALL_COMPOUNDS) {
    normalized = normalized.split(compound).join(" ");
  }
  if (SHORTS_BASEBALL_CONTEXT_STRONG.some((k) => matchesContextKeyword(normalized, k)))
    return true;
  if (VS_RE.test(normalized) && KBO_CLUB_ALIAS_RE.test(normalized)) return true;
  if (LG_FAN_RE.test(normalized)) return true;
  return SHORTS_BASEBALL_CONTEXT_WEAK.some((k) => matchesContextKeyword(normalized, k));
}

/**
 * LG 팀 야구 문맥 판정 — 기업 접미 부정 신호 우선 (2026-07-24 삼순 라운드2).
 *
 * `LG화학`·`LG 전자`처럼 기업 접미가 직접 결합한 언급은 팀 신호에서 제외하고,
 * 제거 후 독립 LG 언급이 남지 않으면 어떤 긍정 신호로도 복원 불가
 * (`LG전자 신입사원 선발 경쟁에서 승리` 봉인 — 검증 채널이어도 기업 문서).
 * 독립 LG 언급은 strong 키워드·`vs`+구단 별칭·`LG팬`·weak 1개로 통과
 * (승인 계약: "선수·경기 등 야구 문맥이 함께 있으면 통과").
 *
 * 라운드3(2026-07-24 삼순 A안): `trustedChannel`(검증 야구채널 = channel_pool
 * tier 1 방송사/공식급 또는 team affinity 보유)을 긍정 신호로 인정 —
 * TVING `한화 vs LG` 같은 title-only로는 부족한 정상 야구 숏츠를 채널
 * 신호로 보존하고, 출처 불명 채널의 `LG 워시타워 vs 삼성` 제품 비교는 차단.
 */
export function hasLgBaseballContext(
  title: string,
  options: { trustedChannel?: boolean } = {},
): boolean {
  if (title.includes("트윈스")) return true;
  let target = title;
  if (LG_CORPORATE_RE.test(title)) {
    const stripped = title.replace(LG_CORPORATE_RE_G, " ");
    if (!LG_STANDALONE_RE.test(stripped)) return false;
    target = stripped;
  }
  if (options.trustedChannel) return true;
  return hasBaseballShortContext(target);
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
  options: {
    hasPlayerTag?: boolean;
    isOfficial?: boolean;
    trustedChannel?: boolean;
  } = {},
): boolean {
  if (hasNonBaseballSignal(title)) return false;
  if (teamId !== "LG") return true;
  if (options.hasPlayerTag || options.isOfficial) return true;
  return hasLgBaseballContext(title, { trustedChannel: options.trustedChannel });
}
