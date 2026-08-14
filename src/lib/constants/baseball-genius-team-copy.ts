/**
 * 야잘알봇 팀별 팬 카피 30종 SSOT (rev2, 2026-08-14).
 *
 * 정본: `state/team-copy-candidates-2026-08-14.md` v4
 *   — 삼순 최종 GO exact `05c166231ce97cae0cc9f373ad504dcda65157c997bc41f70e7ae31338153f23`
 *   — 노션 SSOT `3b4c901b-b372-81b2-af52-e4ab2d89f492` §9 (rev2, 59블록)
 *
 * 계약 (전부 검수 게이트가 강제한다 — `scripts/qa/baseball-genius-team-copy-smoke.ts`):
 *   · 활성 30종 = 10팀 × 3종 exact. 예비(NC-4)는 로테이션에 넣지 않는다.
 *   · 모든 행은 `sourceId` 로 소스 레지스트리(17건)에 개별 결속된다. 섹션 결속 금지.
 *   · 톤 = 합니다체 종결. 절대표현(최고·최강·유일 등) 0. 팀 편향·조롱·연민 0.
 *   · 렌더 규칙: 첫 문장 `{팀명}를 응원하신다니 반갑습니다.` **정확히 1회**, 그 뒤 카피 1종.
 *   · 로테이션은 **결정론**이다 — messageId 를 시드로 쓰므로 durable 재처리(cron drain)가
 *     같은 카피를 재생한다. `Math.random()`·`Date.now()` 금지 (M90 다중 instance 계약).
 *
 * ⚠️ 카피 문구를 여기서 고치지 않는다 — 문서 v4가 정본이고, 수정은
 *   문서 재검수(삼순 GO) → 이 파일 동기화 순서다. 게이트가 개수·결속·톤만 검증하고
 *   문구 자유 수정을 막지는 못하므로, 이 주석이 절차 계약이다.
 */

import { TEAMS } from "@/lib/constants/teams";

export interface TeamFanCopyRow {
  /** 문서 v4의 행 ID (예: `LG-1`). 감사 역추적용. */
  readonly id: string;
  /** 검수 통과 카피 원문. 합니다체·절대표현 0. */
  readonly text: string;
  /** 소스 레지스트리 결속 (`state/team-copy-render-2026-08-14/source-registry.json`). */
  readonly sourceId: string;
}

/** 문서 v4 소스 레지스트리의 source_id 폐쇄집합 (17건). 게이트가 행별 결속을 이 집합으로 검증한다. */
export const TEAM_FAN_COPY_SOURCE_IDS = [
  "LG_HISTORY",
  "KT_MASCOT", "KT_SYMBOL",
  "SS_CHARACTER", "SS_EMBLEM",
  "SG_BI", "SG_MASCOT",
  "NC_VI_MASCOT", "NC_VI_LOGO",
  "KW_BI_MASCOT",
  "HH_INTRO",
  "LT_INTRO", "LT_BI",
  "DS_BRAND", "DS_STADIUM",
  "KA_PRESS_975563", "KA_PRESS_1015529",
] as const;

/** 삼순 최종 GO 문서 exact — 문서와 이 파일의 결속 증거. 게이트·PR 리뷰 대조용. */
export const TEAM_FAN_COPY_DOC_SHA256 =
  "05c166231ce97cae0cc9f373ad504dcda65157c997bc41f70e7ae31338153f23";

/**
 * 팀별 활성 카피 3종. 키 = `TEAMS[].id` (1=LG · 2=두산 · 3=KT · 4=SSG · 5=NC ·
 * 6=KIA · 7=롯데 · 8=삼성 · 9=한화 · 10=키움). 문서 v4의 팀 섹션과 1:1 이다.
 */
export const TEAM_FAN_COPY: Readonly<Record<number, readonly TeamFanCopyRow[]>> = {
  1: [
    { id: "LG-1", text: "LG 트윈스는 1982년 MBC 청룡으로 출발했습니다. 팬과 함께 이어온 시간이 긴 팀입니다.", sourceId: "LG_HISTORY" },
    { id: "LG-2", text: "LG 역사관은 대표 유니폼을 '하나 된 트윈스'의 상징으로 소개합니다.", sourceId: "LG_HISTORY" },
    { id: "LG-3", text: "LG 역사관에서는 영구결번을 '영광의 번호', 배번을 '번호로 남은 이름들'로 기억합니다.", sourceId: "LG_HISTORY" },
  ],
  2: [
    { id: "DS-1", text: "두산 베어스 브랜드는 엠블럼·로고타입·심볼마크·타이포그라피·마스코트로 이뤄져 있습니다.", sourceId: "DS_BRAND" },
    { id: "DS-2", text: "두산은 브랜드 변천을 1982년부터 현재까지 네 시기로 나눠 소개합니다.", sourceId: "DS_BRAND" },
    { id: "DS-3", text: "두산의 홈 구장은 잠실야구장입니다.", sourceId: "DS_STADIUM" },
  ],
  3: [
    { id: "KT-1", text: "kt wiz 마스코트는 빅과 또리입니다. 둘이 함께 있으면 '빅또리', 승리라는 뜻입니다.", sourceId: "KT_MASCOT" },
    { id: "KT-2", text: "빅은 공격형 파워를, 또리는 기동력과 민첩성의 수비를 상징합니다.", sourceId: "KT_MASCOT" },
    { id: "KT-3", text: "kt wiz 심볼의 k와 w는 마법 문장을 연상시키도록 디자인됐습니다.", sourceId: "KT_SYMBOL" },
  ],
  4: [
    { id: "SG-1", text: "SSG 마스코트 랜디는 선수와 팬에게 용기와 사랑, 위로를 주는 친구로 소개됩니다.", sourceId: "SG_MASCOT" },
    { id: "SG-2", text: "랜디 곁에는 발랄 캐릭터 푸리, 그리고 '골수팬' 배티가 함께합니다.", sourceId: "SG_MASCOT" },
    { id: "SG-3", text: "SSG는 구단 BI를 '승리를 부르는 엠블럼과 로고'로 소개합니다.", sourceId: "SG_BI" },
  ],
  5: [
    { id: "NC-1", text: "NC 단디는 '야무지게 해라'라는 경상도 사투리 '단디해라'에서 온 이름입니다.", sourceId: "NC_VI_MASCOT" },
    { id: "NC-2", text: "쎄리는 '치다·때리다'라는 사투리 '쎄리다'에서 온 이름입니다.", sourceId: "NC_VI_MASCOT" },
    { id: "NC-3", text: "NC의 마린 블루는 창원의 푸른 남해 바다를 상징합니다.", sourceId: "NC_VI_LOGO" },
  ],
  6: [
    { id: "KA-1", text: "KIA 호걸이는 '영웅호걸'에서 딴 이름의 무등산 호랑이입니다.", sourceId: "KA_PRESS_975563" },
    { id: "KA-2", text: "호연이는 '호연지기'에서 이름을 따왔고, 호걸이에게 페어플레이와 팬 서비스의 중요성을 일깨워줍니다.", sourceId: "KA_PRESS_975563" },
    { id: "KA-3", text: "아기 백호 하랑이는 무등산에서 챔피언스필드로 찾아와 팬이 됐다는 설정입니다.", sourceId: "KA_PRESS_1015529" },
  ],
  7: [
    { id: "LT-1", text: "롯데 자이언츠는 1975년 창단 이래 팀명·연고지·모그룹이 그대로인 전통의 구단입니다.", sourceId: "LT_INTRO" },
    { id: "LT-2", text: "부산은 야구의 도시 '구도(球都)'라 불립니다. 롯데 팬들의 응원 문화가 그 상징입니다.", sourceId: "LT_INTRO" },
    { id: "LT-3", text: "롯데 엠블럼은 에너지틱 레드와 부산 바다를 담은 헤리티지 블루로 이뤄져 있습니다.", sourceId: "LT_BI" },
  ],
  8: [
    { id: "SS-1", text: "삼성 캐릭터 블레오에게는 블레오 행성에서 온 천재 타자라는 공식 설정이 있습니다.", sourceId: "SS_CHARACTER" },
    { id: "SS-2", text: "삼성의 라이트블루는 생동감을 담은 구단 색으로 적용됐습니다.", sourceId: "SS_EMBLEM" },
    { id: "SS-3", text: "삼성 엠블럼은 워드마크를 쓰기 어려운 자리에서 구단을 대신 나타냅니다.", sourceId: "SS_EMBLEM" },
  ],
  9: [
    { id: "HH-1", text: "한화 이글스는 1985년 제7구단으로 출범해 충청권과 함께해왔습니다.", sourceId: "HH_INTRO" },
    { id: "HH-2", text: "한화의 홈 구장은 대전 한화생명볼파크입니다.", sourceId: "HH_INTRO" },
    { id: "HH-3", text: "한화는 청주야구장을 제2구장으로 두고 충청권 팬과 함께합니다.", sourceId: "HH_INTRO" },
  ],
  10: [
    { id: "KW-1", text: "턱돌이는 히어로즈가 출범한 2008년부터 함께해온 마스코트입니다.", sourceId: "KW_BI_MASCOT" },
    { id: "KW-2", text: "고척돔을 형상화한 수호로봇 돔돔이도 있습니다. 빅사이즈 로봇과 합체하면 슈퍼 돔돔이가 됩니다.", sourceId: "KW_BI_MASCOT" },
    { id: "KW-3", text: "2015년에는 제2마스코트 동글이가 탄생했습니다. 투수와 포수의 복합체입니다.", sourceId: "KW_BI_MASCOT" },
  ],
};

/**
 * 예비 카피 (문서 v4 `(예비) NC-4`). **로테이션에 넣지 않는다** — 삼순 검수 계약이
 * "NC-4 초과분으로 타팀 부족분을 대체할 수 없다"였고, 활성은 10×3 exact 이다.
 * 향후 NC 행 교체가 필요할 때 문서 재검수와 함께 승격한다.
 */
export const TEAM_FAN_COPY_SPARE: TeamFanCopyRow = {
  id: "NC-4",
  text: "단디의 등번호 9번에는 제9구단이라는 의미가 담겨 있습니다.",
  sourceId: "NC_VI_MASCOT",
};

/** 공통 렌더 규칙 첫 문장 — 문서 v4 리터럴 그대로. 정확히 1회만 붙인다. */
export function teamFanGreeting(teamName: string): string {
  return `${teamName}를 응원하신다니 반갑습니다.`;
}

/**
 * 팀 카피 렌더 — 첫 문장(1회) + 결정론 로테이션 카피 1종.
 *
 * @param teamId   `profiles.team_id`. 미설정·미지원 값(0=시스템 등)이면 null 반환(fail-open —
 *                 호출부는 기존 `GREETING_ANSWER` 로 진행한다).
 * @param rotationSeed durable 시드. 야잘알봇에서는 **messageId** 를 쓴다 — job 행에 고정되어
 *                 cron drain 재처리·중복 발송 창에서도 같은 카피가 재생된다.
 */
export function renderTeamFanCopy(teamId: number | null, rotationSeed: number): string | null {
  if (teamId === null || !Number.isFinite(teamId)) return null;
  const rows = TEAM_FAN_COPY[teamId];
  const team = TEAMS.find((t) => t.id === teamId);
  if (!rows || rows.length === 0 || !team) return null;
  // 음수·소수 시드도 안전한 정수 인덱스로 접는다 (결정론 유지).
  const idx = Math.abs(Math.trunc(rotationSeed)) % rows.length;
  const row = rows[idx];
  if (!row) return null;
  return `${teamFanGreeting(team.name)} ${row.text}`;
}
