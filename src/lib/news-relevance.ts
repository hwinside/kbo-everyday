// 네이버 뉴스 relevance 필터 — 홈 히어로(/api/news/batch)와 팀 뉴스탭
// (/api/news)이 공유하는 단일 SSOT.
//
// 과거엔 같은 로직이 두 라우트에 따로 복제돼 있었고, drift나면서 팀 뉴스탭엔
// negative 가드가 아예 빠져 있었다(유통레이더·생활건강 등 증시/유통 칼럼이
// 팀 뉴스탭에선 그대로 통과). 또 "[A오늘의 유통] …" 같은 칼럼이 본문에서
// 'LG 트윈스'(맥도날드 시구 마케팅 등)를 스쳐 언급하면 마스코트 게이트를
// 통과해 LG 히어로에 노출됐다. 두 라우트가 이 한 파일을 공유하게 해서
// 재발(=negative 키워드 추가 1곳)과 drift를 동시에 막는다.

export const BASEBALL_KEYWORDS = ["프로야구", "KBO", "야구"];

export const TEAM_MASCOTS = [
  "트윈스",
  "베어스",
  "위즈",
  "랜더스",
  "다이노스",
  "타이거즈",
  "자이언츠",
  "라이온즈",
  "이글스",
  "히어로즈",
];

// 제목에 등장하면 야구 기사가 아니라고 보는 키워드(증시/유통/IT/부동산 등).
// 본문에 팀 마스코트를 스쳐 언급하는 비즈니스 칼럼 차단용. 제목 substring만
// 보므로 recall 손실 없이 정밀하게 비-야구 칼럼만 걸러낸다.
// "유통": 증시·유통·마케팅 칼럼이 잠실 맥도날드 '그리머스' 시구 마케팅으로 'LG
// 트윈스'를 본문에 달고 들어오던 케이스(유통레이더→오늘의 유통→유통업계로
// 칼럼명만 바뀌며 3회 재발, 2026-06-11/12 제보). 야구 헤드라인엔 '유통'(소매·
// 물류)이 등장하지 않으므로 stem 하나로 이 family 전체를 recall 손실 없이 차단.
// "핫클릭": 연합뉴스TV "[핫클릭] …外" 같은 화제 묶음 클릭베이트가 본문에 여러
// 토픽을 모아 담으면서 'LG 트윈스'를 스쳐 언급해 마스코트 게이트를 통과하던 케이스
// (헤드라인은 '서산 탈출 늑대개'인데 LG 히어로 노출, 2026-06-25 제보). 묶음기사 고유
// 브랜드 마커라 정상 야구 헤드라인엔 등장하지 않음. 다른 매체 묶음 마커가 같은
// 식으로 새면 여기에 추가한다.
export const NON_BASEBALL_NEGATIVE = [
  "시장",
  "재선",
  "유통",
  "생활건강",
  "디스플레이",
  "갤럭시",
  "5G",
  "통신",
  "자동차",
  "분양",
  "부동산",
  "주가",
  "공시",
  "신제품",
  "핫클릭",
];

// 사진/화보 위주 기사(정보량 적은 포토 기사) 식별 — 사용자 토글(마이페이지)로
// 홈·팀 뉴스에서 on/off. 제목 substring만 보므로 recall 영향 없이 포토데스크
// 기사만 정밀하게 거른다. 바 단어 "사진"은 "사진 공개" 등 일반 기사에도 흔히 등장해
// 오탐이 커서 안 쓰고, 포토 기사 고유 마커("포토/화보/갤러리")만 substring으로 본다.
export const PHOTO_ARTICLE_KEYWORDS = ["포토", "화보", "갤러리"];

// 대괄호 안 "사진" 마커("[사진]", "[현장사진]", "[HD사진]" 등)는 포토데스크 고유라
// "사진 공개" 류 일반기사 오탐 없이 안전하게 포토 기사로 본다.
const PHOTO_BRACKET_RE = /\[[^\]]*사진[^\]]*\]/;

export function isPhotoArticle(title: string): boolean {
  return PHOTO_ARTICLE_KEYWORDS.some((kw) => title.includes(kw)) || PHOTO_BRACKET_RE.test(title);
}

// Naver 뉴스 URL 여부 — 네이버 검색 API `link`는 *등록 기사*만 네이버 뉴스 URL이고,
// 미등록 기사는 언론사 원문 URL(originallink와 동일)로 내려온다. '무조건 네이버'
// 보장을 위해 link host가 naver.com 계열이 아닌 기사는 노출에서 제외하는 데 쓴다.
export function isNaverNewsUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    // dot-boundary 검사 — notnaver.com/fake-naver.com 같은 유사 도메인 오통과 방지
    const host = new URL(url).hostname;
    return host === "naver.com" || host.endsWith(".naver.com");
  } catch {
    return false;
  }
}

// 제목 토큰화 — 대괄호/따옴표/문장부호 제거 후 2자 이상 토큰만. near-dup 판정용.
function storyTokens(title: string): Set<string> {
  return new Set(
    title
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length >= 2)
  );
}

// 같은 사건을 다른 매체/제목으로 올린 near-duplicate 기사 판정.
// 보수적 기준 — 공통 핵심 토큰 ≥3개 AND 짧은 쪽 제목의 80% 이상 겹칠 때만 동일 기사로 본다.
// 0.8 임계값 근거: '프로야구 LG 삼성전 승리' vs '…패배'처럼 결과만 정반대인 짧은
// 헤드라인은 3/4=0.75라 0.7이면 잘못 합쳐짐 → 0.8로 올려 차단(repro 강뉴합창단 쌍은
// 7/8=0.875라 유지). 서로 다른 기사가 일부 단어만 겹치는 경우의 오합침 방지.
export function isSameStoryTitle(a: string, b: string): boolean {
  const ta = storyTokens(a);
  const tb = storyTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  if (inter < 3) return false;
  return inter / Math.min(ta.size, tb.size) >= 0.8;
}

// near-duplicate 기사 제거 — 입력 순서(최신순 정렬 가정)의 첫 항목을 유지한다.
export function dedupeNewsByTitle<T extends { title: string }>(items: T[]): T[] {
  const kept: T[] = [];
  for (const item of items) {
    if (kept.some((k) => isSameStoryTitle(k.title, item.title))) continue;
    kept.push(item);
  }
  return kept;
}

export function hasBaseballSignal(text: string): boolean {
  return (
    BASEBALL_KEYWORDS.some((kw) => text.includes(kw)) ||
    TEAM_MASCOTS.some((m) => text.includes(m))
  );
}

// 선수 뉴스: 제목에 선수명 필수 + 본문/제목에 야구 시그널.
export function isPlayerBaseballRelevant(
  title: string,
  description: string,
  playerName?: string
): boolean {
  if (NON_BASEBALL_NEGATIVE.some((n) => title.includes(n))) return false;
  if (playerName && !title.includes(playerName)) return false;
  return hasBaseballSignal(`${title} ${description}`);
}

// 팀 뉴스: 제목에 non-baseball negative가 없어야 하고, 제목/본문에 마스코트가
// 있어야 통과. 마스코트 매핑이 없는 팀은 기존 baseball signal로 폴백한다.
// (제목 헤드라인을 강제하는 방식은 "고승민 1루·손호영 2루" 같이 선수명만 쓴
//  정상 팀 기사를 떨어뜨려 recall이 무너지므로 쓰지 않는다 — negative 정밀
//  차단이 recall 손실 없이 비-야구 칼럼만 거른다.)
export function isTeamBaseballRelevant(
  title: string,
  description: string,
  mascot?: string | null
): boolean {
  if (NON_BASEBALL_NEGATIVE.some((n) => title.includes(n))) return false;
  if (!mascot) return hasBaseballSignal(`${title} ${description}`);
  return `${title} ${description}`.includes(mascot);
}

// 뉴스클리핑 전용 positive 제목 게이트 — 팀 뉴스탭보다 높은 정밀도 기준.
//
// isTeamBaseballRelevant 는 제목/본문 어디든 마스코트가 있으면 통과시킨다. 그래서
// 여자 골프·연예·정치 등 *다른 토픽* 기사가 본문에 소속 선수(예: 'LG 트윈스 김진성')를
// 스쳐 언급하면 후보에 들고, Gemini가 억지 요약을 만들어 제목·사진(골프)과 요약(야구)이
// 어긋난 카드가 나온다(2026-07-19 하린아빠 제보 — '여자 골프' 기사에 김진성 야구 요약).
//
// 클리핑은 팬에게 매일 발송하는 큐레이션이라 뉴스탭보다 recall을 조금 내주고 정밀도를
// 택한다: 제목에 (1)야구 키워드 (2)팀 식별자 (3)소속 선수명 중 하나라도 있어야 선정.
// 골프 헤드라인은 셋 다 없어 원천 컷되고, "고승민 1루·손호영 2루"처럼 선수명만 쓴 정상
// 팀 기사는 로스터 매칭으로 유지된다. (isOtherTeamTitle·isTeamBaseballRelevant 게이트
// *다음*에 추가로 적용하는 최종 관문.)
//
// rosterNames 는 2자 이름(최정·곽빈 등)도 포함한다 — 아래 titleHasNameToken 이 토큰
// 경계로 매칭해 "김건"→"김건희", "최정"→"최정상" substring 오탐을 차단하므로 recall을
// 위해 이름을 버리지 않는다(2026-07-18 SSG '최정 부상' 등 팀 핵심 이슈 누락 — 삼순 NO-GO).
export function hasClippingTitleSignal(
  title: string,
  teamTokens: string[],
  rosterNames: string[]
): boolean {
  if (BASEBALL_KEYWORDS.some((kw) => title.includes(kw))) return true;
  // 팀 식별자는 case-insensitive — Latin 약칭이 소문자로 쓰인 own-team 헤드라인
  // (예: "nc, 끝내기 승리")도 유지한다. 한글 토큰은 toLowerCase 가 no-op.
  const lowerTitle = title.toLowerCase();
  if (teamTokens.some((t) => t && lowerTitle.includes(t.toLowerCase()))) return true;
  return rosterNames.some((n) => n && titleHasNameToken(title, n));
}

// 완성형 한글 음절 여부 — 이름 토큰 경계 판정용.
function isHangulSyllable(ch: string | undefined): boolean {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return code >= 0xac00 && code <= 0xd7a3;
}

// 제목에서 이름을 토큰 경계로 매칭 — 앞뒤 문자가 한글 음절이 아니어야 한다.
// "최정,"·"최정 부상"·"…최정"=true, "최정상"(단어 일부)·"김건희"(2자 substring 오탐)=false.
function titleHasNameToken(title: string, name: string): boolean {
  for (let from = 0; ; ) {
    const idx = title.indexOf(name, from);
    if (idx === -1) return false;
    if (!isHangulSyllable(title[idx - 1]) && !isHangulSyllable(title[idx + name.length])) {
      return true;
    }
    from = idx + 1;
  }
}
