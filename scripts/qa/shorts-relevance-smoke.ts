// 숏츠 야구 관련성 필터 회귀 가드.
// 2026-06-19 #cs 제보: 오스틴(LG) 검색에 종교 영상, 김영우 정치 뉴스가 숏츠에 노출.
import {
  hasBaseballShortContext,
  hasLgBaseballContext,
  hasNonBaseballSignal,
  isPlayerShortRelevant,
  isTeamShortRelevant,
} from "@/lib/video/shorts-relevance";
import {
  detectAllTeamsFromTitle,
  detectTeamFromTitle,
} from "@/lib/video/team-detector";
import { entriesToRows } from "@/lib/video/entries-to-rows";
import { joinLgFeedRows, type ShortsRow } from "@/lib/video/shorts-feed-merge";
import {
  hasRequiredPlayerContext,
  matchPlayers,
  titleIncludesPlayerName,
  type PlayerAlias,
} from "@/lib/video/player-tagger";
import type { PoolChannel } from "@/lib/video/team-channels";
import type { RssVideoEntry } from "@/lib/video/rss-parser";

let pass = 0,
  fail = 0;
function check(label: string, actual: boolean, expected: boolean) {
  if (actual === expected) {
    console.log(`✓ ${label} → ${actual}`);
    pass++;
  } else {
    console.log(`✗ ${label} → expected ${expected}, got ${actual}`);
    fail++;
  }
}

// --- 실제 제보된 누수 케이스 (전부 차단돼야 함) ---
check(
  "religious leak (제목에 선수명 없음)",
  isPlayerShortRelevant("하나님의 평가기준! 하나님의 관심은 어디인가?", "오스틴"),
  false,
);
check(
  "political leak (선수명 있어도 정치 negative)",
  isPlayerShortRelevant("김영우 '정권 찔어' 발언으로 명령, 이미 루비콘 강 건너", "김영우"),
  false,
);
check("hasNonBaseballSignal 종교", hasNonBaseballSignal("하나님의 평가기준!"), true);
check("hasNonBaseballSignal 정치", hasNonBaseballSignal("정권 찔어 발언"), true);
check("hasNonBaseballSignal 증시(상속)", hasNonBaseballSignal("LG전자 주가 급등"), true);

// --- 동명이인 선수 태깅: 일반 채널(T2+)은 팀명+선수명 필수 ---
const KIM_MINSEOK_PLAYERS: PlayerAlias[] = [
  { kbo_id: "53554", name: "김민석", team: "두산", aliases: [] },
  { kbo_id: "54097", name: "김민석", team: "KT", aliases: [] },
  { kbo_id: "68043", name: "김민", team: "SSG", aliases: [] },
];
check(
  "선수명 prefix 차단: 김민 ≠ 김민석",
  titleIncludesPlayerName("김민석 연설", "김민", ["김민", "김민석"]),
  false,
);
check("선수명 조사 허용: 김민석은", titleIncludesPlayerName("김민석은 홈런", "김민석"), true);
check("고유 선수 붙임말 보존: 손아섭응원가", titleIncludesPlayerName("#손아섭응원가", "손아섭"), true);
check("고유 선수 붙임말 보존: 손아섭홈런", titleIncludesPlayerName("#손아섭홈런", "손아섭"), true);
check(
  "동명이인 차단: T3 정치 영상은 선수 태그 없음",
  matchPlayers(
    "김민석, 연설 중 돌연 고성 지르더니 무슨 말? / KNN",
    KIM_MINSEOK_PLAYERS,
    null,
    3,
  ).length === 0,
  true,
);
check(
  "동명이인 통과: T3 두산+김민석은 두산 선수만 태그",
  matchPlayers("두산 김민석 끝내기 안타", KIM_MINSEOK_PLAYERS, null, 3).join(",") === "53554",
  true,
);
check(
  "동명이인 차단: 무관한 삼성 팀명은 후보팀 교집합 없음",
  matchPlayers("삼성 김민석 발언", KIM_MINSEOK_PLAYERS, null, 3).length === 0,
  true,
);
check(
  "T1 기존 계약: 무팀명 김민석 제목 허용",
  matchPlayers("김민석 끝내기 안타", KIM_MINSEOK_PLAYERS, null, 1).length === 2,
  true,
);
check(
  "기존 저장행 차단: T3 무팀명 player tag 재검증",
  hasRequiredPlayerContext("김민석, 연설 중 돌연 고성 지르더니 무슨 말? / KNN", null, 3, true),
  false,
);
check(
  "고유 선수명 보존: T3 무팀명 영상 허용",
  hasRequiredPlayerContext("원태인 완벽투", null, 3, false),
  true,
);

// --- 정상 선수 숏츠 (전부 통과돼야 함 — recall 보존) ---
check("정상: 오스틴 홈런", isPlayerShortRelevant("오스틴 끝내기 만루홈런 폭발!", "오스틴"), true);
check("정상: 문동주 호투", isPlayerShortRelevant("문동주 시즌 10승 무실점 호투", "문동주"), true);
check(
  "정상: 야구 키워드 없어도 선수명만 있으면 통과",
  isPlayerShortRelevant("오스틴 4타수 3안타 1타점", "오스틴"),
  true,
);
check("정상 케이스 negative 없음", hasNonBaseballSignal("오스틴 결승 적시타"), false);

// --- '시장' allowlist: 야구 市場은 통과, 정치 市長은 차단 (삼순 조건부 GO) ---
check("정상: FA 시장 (공백)", hasNonBaseballSignal("LG 최대어 FA 시장 큰손 등판"), false);
check("정상: FA시장 (붙임)", hasNonBaseballSignal("올겨울 FA시장 전망"), false);
check("정상: 트레이드 시장", hasNonBaseballSignal("마감 임박 트레이드 시장 정리"), false);
check("정상: 외국인 투수 시장", hasNonBaseballSignal("외국인 투수 시장 매물 분석"), false);
check("차단 유지: 정치 시장(市長) 후보", hasNonBaseballSignal("OO 시장 후보 유세 현장"), true);

// --- 우연 매칭 차단 (선수명이 제목에 없음) ---
check(
  "선수명 없는 일반 영상 차단",
  isPlayerShortRelevant("오늘의 홈런 모음 베스트", "오스틴"),
  false,
);

// --- LG 약칭 오탐 차단 (#cs 2026-07-22 실제 제보) ---
const LG_CHEMICAL_TITLE = "LG화학 나주공장, 또 생산라인 축소...가소제 라인";
check("LG화학: 야구 문맥 없음", hasBaseballShortContext(LG_CHEMICAL_TITLE), false);
check("LG화학: 수집 team_id ETC", detectTeamFromTitle(LG_CHEMICAL_TITLE) === "ETC", true);
check(
  "LG화학: 전체 팀 감지에서도 LG 제외",
  detectAllTeamsFromTitle(LG_CHEMICAL_TITLE).includes("LG"),
  false,
);
check(
  "LG화학: 기존 LG 오분류 행도 노출 차단",
  isTeamShortRelevant(LG_CHEMICAL_TITLE, "LG"),
  false,
);
check(
  "정상: LG + 트윈스 문맥",
  isTeamShortRelevant("LG 트윈스 끝내기 승리", "LG"),
  true,
);
check(
  "정상: LG + 경기 문맥",
  detectTeamFromTitle("LG 경기 하이라이트") === "LG",
  true,
);
check(
  "정상: LG 선수 태그가 있는 커뮤니티 영상",
  isTeamShortRelevant("LG 오스틴 결승타", "LG", { hasPlayerTag: true }),
  true,
);
check(
  "정상: LG 공식 채널 영상",
  isTeamShortRelevant("드디어 돌아왔다", "LG", { isOfficial: true }),
  true,
);
check(
  "회귀: 다른 팀 기존 동작 유지",
  isTeamShortRelevant("삼성 멋진 장면", "삼성"),
  true,
);

// --- LG 계열사 다의어/부분문자열 오탐 (2026-07-24 삼순 리뷰 반례) ---
for (const title of [
  "LG화학 신입사원 선발",
  "LG유플러스 선수금 지급",
  "LG전자 경기 침체에도 승리",
]) {
  check(`계열사 오탐: 야구 문맥 아님 (${title})`, hasLgBaseballContext(title), false);
  check(`계열사 오탐: 수집 team_id ETC (${title})`, detectTeamFromTitle(title) === "ETC", true);
  check(
    `계열사 오탐: 기존 LG 행 노출 차단 (${title})`,
    isTeamShortRelevant(title, "LG"),
    false,
  );
}
check(
  "정상: 다의어 2개 조합은 야구 문맥 (LG 잠실 역전승)",
  detectTeamFromTitle("LG 잠실서 짜릿한 역전승") === "LG",
  true,
);

// --- 강한 시그널 부분문자열/파생어 오탐 (2026-07-24 삼순 라운드2 반례) ---
for (const title of [
  "LG전자 안타까운 소식", // 안타까운 → 안타 파생어
  "LG전자 타자기 역사", // 타자기 → 타자 파생어
  "LG전자 에너지 세이브 캠페인", // 일반어 세이브 단독
]) {
  check(`파생어 오탐: 야구 문맥 아님 (${title})`, hasLgBaseballContext(title), false);
  check(`파생어 오탐: 수집 team_id ETC (${title})`, detectTeamFromTitle(title) === "ETC", true);
  check(
    `파생어 오탐: 기존 LG 행 노출 차단 (${title})`,
    isTeamShortRelevant(title, "LG"),
    false,
  );
}

// --- 경계 강화 후에도 정상 야구 제목은 통과 (recall 보존) ---
check("정상: LG 안타 3개", detectTeamFromTitle("LG 안타 3개 몰아치기") === "LG", true);
check("정상: LG 선발 타자", isTeamShortRelevant("LG 선발 타자 공개", "LG"), true);
check("정상: 조사 결합 (안타를)", hasBaseballShortContext("LG 안타를 몰아친 날"), true);
check("정상: 복합어 무안타", hasBaseballShortContext("LG 상대로 무안타 행진"), true);
check("정상: 야구선수 연속 복합어", hasBaseballShortContext("LG 야구선수 근황"), true);
check("정상: 투수들 파생 접미", hasBaseballShortContext("LG 투수들 무더위 속 호투"), true);
check("정상: 홈런포 파생 접미", hasBaseballShortContext("LG 대포번지 홈런포 가동"), true);
check("정상: KBO리그 복합어", hasBaseballShortContext("KBO리그 LG 근황"), true);

// --- 라운드3: 기업 접미 부정 신호 (2026-07-24 삼순 라운드2 반례 — weak 조합 복원 불가) ---
for (const title of [
  "LG전자 신입사원 선발 경쟁에서 승리",
  "LG유플러스 잠실 우승 기념 행사",
  "LG 전자 신제품 공개 하이라이트",
]) {
  check(`기업 접미: 야구 문맥 아님 (${title})`, hasLgBaseballContext(title), false);
  check(`기업 접미: 수집 team_id ETC (${title})`, detectTeamFromTitle(title) === "ETC", true);
  check(
    `기업 접미: 기존 LG 행 노출 차단 (${title})`,
    isTeamShortRelevant(title, "LG"),
    false,
  );
}

// --- 라운드3: 정상 야구 보존 (2026-07-24 삼순 prod 과차단 13건 계열 — recall 회귀) ---
for (const title of [
  "3위로 추락한 LG 근황",
  "LG팬 전현무에 빨친 삼성팬",
  "LG 팀 분위기의 비결..?",
]) {
  check(`과차단 회귀: 수집 team_id LG (${title})`, detectTeamFromTitle(title) === "LG", true);
  check(`과차단 회귀: 기존 LG 행 노출 유지 (${title})`, isTeamShortRelevant(title, "LG"), true);
}
// TVING 팬덤중계류 — title-only `vs+기업명 구단`은 더 이상 단독 인정 안 되고,
// 검증 야구채널(tier 1) 신호로 보존된다 (2026-07-24 삼순 라운드3 A안).
for (const title of ["한화 vs LG 팬덤중계", "LG vs 롯데 팬덤중계"]) {
  check(
    `과차단 회귀: 검증 채널 신호로 수집 team_id LG (${title})`,
    detectTeamFromTitle(title, { trustedChannel: true }) === "LG",
    true,
  );
  check(
    `과차단 회귀: 검증 채널 신호로 노출 유지 (${title})`,
    isTeamShortRelevant(title, "LG", { trustedChannel: true }),
    true,
  );
}

// --- 라운드3: title-only `vs+기업명 구단` 단독 인정 금지 (2026-07-24 삼순 반례) ---
const WASHTOWER_TITLE =
  "LG 워시타워 vs 삼성 원바디 핵심 비교! 어떤 걸 사야 할까?";
for (const title of [
  WASHTOWER_TITLE, // 실제 Shorts -UIQfhSHLjg (삼순 라운드3 반례)
  "LG OLED vs 삼성 QLED 화질 비교", // 제품명 blocklist로 못 닫는 동일 family
  "LG vs 삼성 주가 전망",
]) {
  check(`vs 기업명 단독: 야구 문맥 아님 (${title})`, hasLgBaseballContext(title), false);
  check(`vs 기업명 단독: 수집 team_id LG 아님 (${title})`, detectTeamFromTitle(title) !== "LG", true);
  check(
    `vs 기업명 단독: 기존 LG 행 노출 차단 (${title})`,
    isTeamShortRelevant(title, "LG"),
    false,
  );
}
// `vs`도 구단 *별칭* 또는 별도 야구 시그널과 결합하면 여전히 통과
check("정상: vs+구단 별칭 (LG vs 라이온즈)", detectTeamFromTitle("LG vs 라이온즈 명승부") === "LG", true);
check("정상: vs+구단 별칭 노출 유지", isTeamShortRelevant("LG vs 라이온즈 명승부", "LG"), true);
check("정상: vs+기업명이어도 야구 시그널 동반 (한화 vs LG 하이라이트)", isTeamShortRelevant("한화 vs LG 하이라이트", "LG"), true);
check("정상: vs+기업명+야구 시그널 수집 LG", detectTeamFromTitle("한화 vs LG 하이라이트") === "LG", true);
// 검증 채널 신호가 있어도 기업 접미 부정 신호가 우선한다
check(
  "검증 채널이어도 기업 접미는 차단 (LG전자 신제품)",
  isTeamShortRelevant("LG전자 신제품 공개 하이라이트", "LG", { trustedChannel: true }),
  false,
);
for (const title of [
  "LG 경기 결과",
  "LG 선수 인터뷰",
  "LG 선발 공개",
  "LG 감독 인터뷰",
  "LG 하이라이트",
  'LG를 무너뜨리는 "슈퍼 루키" 오재원', // prod 재현에서 발견한 과차단 사례
]) {
  check(`과차단 회귀: 단일 weak 통과 (${title})`, isTeamShortRelevant(title, "LG"), true);
}

// --- 라운드4: 운영 실케이스 79W-OwErIEA — 비-LG affinity 채널 선확정 false negative ---
// 채널 `히어로북`(tier=3, team_affinity=["키움"])의 명시적 LG 야구 제목.
// 수집 계약(channelTeam 선확정 → team_id 키움)은 유지하면서, shorts-feed의
// 다중 팀 노출 게이트(detectAllTeamsFromTitle ∋ LG)로 LG 피드에 합류해야 한다.
const HEROBOOK_CHANNEL: PoolChannel = {
  channel_id: "UC_herobook_fixture",
  channel_name: "히어로북",
  tier: 3,
  team_affinity: ["키움"],
};
const HEROBOOK_ENTRY: RssVideoEntry = {
  video_id: "79W-OwErIEA",
  title: "한화 앞에서 선보인 LG의 행복수비☠️💔",
  thumbnail: "",
  channel: "히어로북",
  channel_id: "UC_herobook_fixture",
  published_at: "2026-07-20T00:00:00.000Z",
};
const [herobookRow] = entriesToRows([HEROBOOK_ENTRY], HEROBOOK_CHANNEL, []);
check(
  "운영케이스: 수집 계약 유지 — channelTeam 키움 선확정",
  herobookRow.team_id === "키움",
  true,
);
check(
  "운영케이스: LG 피드 다중 팀 노출 게이트 통과 (trusted 아니어도)",
  detectAllTeamsFromTitle(herobookRow.title).includes("LG"),
  true,
);
check(
  "운영케이스: 노출 단계 negative/노이즈 게이트 통과 (team_id=키움 그대로)",
  isTeamShortRelevant(herobookRow.title, herobookRow.team_id),
  true,
);
check(
  "운영케이스: 수비 키워드 야구 문맥 인정 (파생 이모지 경계)",
  hasLgBaseballContext(herobookRow.title),
  true,
);

// --- 라운드4 NO-GO #2: 합류 행 노출 라벨 override (route→merge→response→카드) ---
// 저장 team_id=키움 운영행이 team=LG 피드 조회 시 LG 라벨로 표시되는지.
const HEROBOOK_STORED_ROW: ShortsRow = {
  video_id: "79W-OwErIEA",
  title: "한화 앞에서 선보인 LG의 행복수비☠️💔",
  team_id: "키움", // 수집 계약(channelTeam 선확정) 그대로
  channel_id: "UC_herobook_fixture",
  published_at: "2026-07-20T00:00:00.000Z",
};
const joinResult = joinLgFeedRows([], [HEROBOOK_STORED_ROW], new Set());
check(
  "합류: 비-LG 저장행이 LG 피드에 합류",
  joinResult.rows.some((r) => r.video_id === "79W-OwErIEA"),
  true,
);
check(
  "합류: 저장 team_id는 키움 유지 (수집 계약 불변)",
  HEROBOOK_STORED_ROW.team_id === "키움",
  true,
);
check(
  "합류: 노출 라벨 override = LG",
  joinResult.displayTeam.get("79W-OwErIEA") === "LG",
  true,
);
// route의 items 맵과 동일한 override로 카드 라벨 검증
const cardTeamId =
  joinResult.displayTeam.get(HEROBOOK_STORED_ROW.video_id) ??
  HEROBOOK_STORED_ROW.team_id;
check("합류: 홈 카드 라벨 LG로 표시 (키움 배지 아님)", cardTeamId === "LG", true);
// 반대 방향: 이미 LG 1차 조회에 있는 행은 중복 합류·override 안 함
const dupBase: ShortsRow = { ...HEROBOOK_STORED_ROW, team_id: "LG" };
const dupResult = joinLgFeedRows([dupBase], [HEROBOOK_STORED_ROW], new Set());
check(
  "합류: 중복 video_id는 override 안 함 (원본 team_id 유지)",
  !dupResult.displayTeam.has("79W-OwErIEA") && dupResult.rows.length === 1,
  true,
);

// 반대 방향 보존: 다중 팀 노출 게이트가 비-야구 LG 제목까지 LG 피드로 끓어오면 안 된다
for (const title of [
  "LG전자 세탁기 신제품 리뷰", // 기업 접미 → 차단
  "LG 워시타워 vs 삼성 원바디 핵심 비교! 어떤 걸 사야 할까?", // vs 기업명 단독 → 차단
  "SLG 1위 타자 분석", // ilike %lg% 과포집 — 독립 LG 언급 아님 → 차단
]) {
  check(
    `다중 노출 게이트 차단 (${title})`,
    detectAllTeamsFromTitle(title).includes("LG"),
    false,
  );
}
// 수비 키워드 추가가 기업 문맥을 열지 않는지 (접미 경계 + 기업 접미 부정 유지)
check("수비 파생어 차단 (수비드)", hasLgBaseballContext("LG 수비드 쿠커 출시"), false);

// 라운드4 전수 재검증에서 나온 추가 false negative 계열 (prod 실제 제목)
check(
  "전수검증 회귀: LG전 토큰 (힐리어드 LG전 xwOBA)",
  detectAllTeamsFromTitle("힐리어드 LG전 xwOBA 0.606 | 7/19 KT LG 데이터 예측 #Shorts").includes("LG"),
  true,
);
check(
  "전수검증 회귀: 으로 조사 경계 (만루홈런으로)",
  detectAllTeamsFromTitle("힐리어드 만루홈런으로 KT가 LG를 6대1로 잡았다 #Shorts").includes("LG"),
  true,
);
check(
  "전수검증 회귀: 방망이 (강백호의 방망이, 1위 엘지를 흔든 그 밤)",
  detectAllTeamsFromTitle("강백호의 방망이, 1위 엘지를 흔든 그 밤").includes("LG"),
  true,
);
// LG전 토큰이 기업 복합어로 샐지 않는지 (접미 경계 + 기업 접미 부정 유지)
check("LG전자는 여전히 차단", hasLgBaseballContext("LG전자 신제품 공개"), false);
check("LG전선도 차단", hasLgBaseballContext("LG전선 수주 공시"), false);
check(
  "기업 접미 우선 유지 (LG전자 수비 무상수리)",
  hasLgBaseballContext("LG전자 수비 무상수리 안내"),
  false,
);

// --- 라운드4 NO-GO #1: `LG전` 축약형이 기업/경제 문맥과 결합한 오탐 (2026-07-24 삼순) ---
// `LG전`은 `LG전자`의 부분문자열 — 뒤가 비야구 한글/숫자 기업 문맥이면
// 같이 있는 weak(선발·승리)로도 복원 불가 (기업 접미 부정신호 우선).
for (const title of [
  "LG전 신입사원 선발 경쟁에서 승리", // 선발·승리 weak가 있어도 차단
  "LG전 2분기 영업이익 역대 최대",
  "LG전 고객 서비스 만족도 1위",
]) {
  check(`LG전 기업문맥: 야구 문맥 아님 (${title})`, hasLgBaseballContext(title), false);
  check(`LG전 기업문맥: 수집 team_id ETC (${title})`, detectTeamFromTitle(title) === "ETC", true);
  check(
    `LG전 기업문맥: 보조쿼리 합류 게이트 차단 (${title})`,
    detectAllTeamsFromTitle(title).includes("LG"),
    false,
  );
  check(
    `LG전 기업문맥: 기존 LG 행 노출 차단 (${title})`,
    isTeamShortRelevant(title, "LG"),
    false,
  );
}
// 야구 `LG전`(=LG와의 경기)은 뒤가 야구 키워드/문장끝이면 보존된다.
for (const title of ["LG전 승리", "KIA LG전 하이라이트"]) {
  check(`야구 LG전 보존: 수집 team_id LG (${title})`, detectTeamFromTitle(title) === "LG", true);
  check(`야구 LG전 보존: 노출 유지 (${title})`, isTeamShortRelevant(title, "LG"), true);
}

// --- 라운드5 NO-GO: `LG전` 뒤 조사/구두점 경계 누수 (2026-07-24 삼순) ---
// 공백형만 닫혀 있었고 `LG전은`·`LG전의`·`LG전,`처럼 조사/구두점이
// 바로 붙으면 그 뒤 비야구 토큰(신입사원)을 못 보고 통과했다.
for (const title of [
  "LG전은 신입사원 선발 경쟁에서 승리",
  "LG전의 신입사원 선발 경쟁에서 승리",
  "LG전, 신입사원 선발 경쟁에서 승리",
]) {
  check(`LG전 조사/구두점: 야구 문맥 아님 (${title})`, hasLgBaseballContext(title), false);
  check(`LG전 조사/구두점: 수집 team_id ETC (${title})`, detectTeamFromTitle(title) === "ETC", true);
  check(
    `LG전 조사/구두점: 보조쿼리 합류 게이트 차단 (${title})`,
    detectAllTeamsFromTitle(title).includes("LG"),
    false,
  );
  check(
    `LG전 조사/구두점: 기존 LG 행 노출 차단 (${title})`,
    isTeamShortRelevant(title, "LG"),
    false,
  );
}
// 조사 뒤가 야구 문맥이면(`LG전은 승리`·`LG전의 하이라이트`) 과차단 없이 보존한다.
for (const title of ["LG전은 승리", "LG전의 하이라이트"]) {
  check(`야구 LG전 조사 보존: 수집 team_id LG (${title})`, detectTeamFromTitle(title) === "LG", true);
  check(`야구 LG전 조사 보존: 노출 유지 (${title})`, isTeamShortRelevant(title, "LG"), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
