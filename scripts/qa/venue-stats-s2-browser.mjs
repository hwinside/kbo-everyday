#!/usr/bin/env node
/**
 * S2 실제 컴포넌트 390px 브라우저 스모크.
 * API fixture는 전체/GPS 값을 의도적으로 다르게 두어 범위 토글 오배선을 탐지한다.
 */
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import playwright from "playwright";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// CI(VENUE_STATS_S2_REQUIRE_BROWSER=1)에선 fail-closed: chromium이 없으면 exit 1.
// 그 외(로컬/Vercel prebuild)에선 chromium 미설치 시 graceful skip(exit 0)로 배포를 깨지 않는다.
const REQUIRE_BROWSER = process.env.VENUE_STATS_S2_REQUIRE_BROWSER === "1";
let chromiumPath = null;
try {
  chromiumPath = playwright.chromium.executablePath();
} catch {
  chromiumPath = null;
}
if (!chromiumPath || !existsSync(chromiumPath)) {
  const detail = chromiumPath ? `not found at ${chromiumPath}` : "executablePath unavailable";
  if (REQUIRE_BROWSER) {
    console.error(`FAIL: playwright chromium 사용 불가(fail-closed) — ${detail}`);
    process.exit(1);
  }
  console.log(`SKIP: playwright chromium 사용 불가 — ${detail}`);
  process.exit(0);
}

const ROOT = process.cwd();
const GEN = mkdtempSync(resolve(tmpdir(), "venue-stats-s2-"));
const SHOT = resolve(ROOT, "tmp/qa-screenshots/venue-stats-s2-390.png");
mkdirSync(resolve(ROOT, "tmp/qa-screenshots"), { recursive: true });

const myPagePath = resolve(ROOT, "src/app/(main)/my/page.tsx");
const entryMarkup = "      <VenueStatsEntryCard />";
const myPageSourceRaw = readFileSync(myPagePath, "utf8");
const myPageSource = process.env.VENUE_STATS_S2_MUTATE_MY_ENTRY === "1"
  ? myPageSourceRaw.replace(entryMarkup, "      {/* injected entry-removal mutation */}")
  : myPageSourceRaw;
const entryMarkupCount = myPageSource.split(entryMarkup).length - 1;
if (entryMarkupCount !== 1) {
  throw new Error(`MyPage venue stats entry wiring must be unique, got ${entryMarkupCount}`);
}
writeFileSync(
  resolve(GEN, "my-page-mutated.tsx"),
  myPageSource.replace(entryMarkup, "      {/* mutation: venue stats entry removed */}"),
);

const dashboardPath = resolve(ROOT, "src/components/my/VenueStatsDashboard.tsx");
const crossRoleSelection = "return candidateOrder < selectedOrder ? candidate : selected;";
const dashboardSourceRaw = readFileSync(dashboardPath, "utf8");
let dashboardEntryPath = dashboardPath;
if (process.env.VENUE_STATS_S2_MUTATE_CROSS_ROLE_SORT === "1") {
  const selectionCount = dashboardSourceRaw.split(crossRoleSelection).length - 1;
  if (selectionCount !== 1) {
    throw new Error(`cross-role selection mutation target must be unique, got ${selectionCount}`);
  }
  dashboardEntryPath = resolve(GEN, "VenueStatsDashboard-mutated.tsx");
  writeFileSync(
    dashboardEntryPath,
    dashboardSourceRaw.replace(
      crossRoleSelection,
      "return candidate.boostPct > selected.boostPct ? candidate : selected;",
    ),
  );
}

writeFileSync(resolve(GEN, "auth.jsx"), `
// 실제 AuthContext 처럼 매 렌더마다 새 객체를 만들지 않는 안정 참조.
const AUTH={
  user:{id:"qa",email:"venue-stats-qa@example.invalid"},
  profile:{favorite_players:[
    {playerId:"53123",name:"오스틴",teamId:1,position:"내야수"},
    {playerId:"p2",name:"이최애",teamId:9,position:"투수"},
    {playerId:"p3",name:"김최애",teamId:1,position:"외야수"},
    {playerId:"p4",name:"박최애",teamId:1,position:"내야수"},
    {playerId:"p5",name:"최최애",teamId:1,position:"투수"}
  ],team_id:1,nickname:"QA",avatar_url:null},
  loading:false,
  refreshProfile:async()=>{},
  signOut:async()=>{}
};
const ANON={user:null,profile:null,loading:false};
export const useAuth=()=>new URLSearchParams(window.location.search).has("anonymous")?ANON:AUTH;`);
writeFileSync(resolve(GEN, "client.js"), `
export async function getSafeSession(){return {access_token:"qa"};}
export const supabase={auth:{getSession:async()=>({data:{session:null}})}};`);
writeFileSync(resolve(GEN, "back.js"), `
export const useSafeBack=()=>()=>{};`);
writeFileSync(resolve(GEN, "image.jsx"), `
export default function Image(p){return <img {...p}/>;}`);
writeFileSync(resolve(GEN, "link.jsx"), `
export default function Link({href,children,...props}){return <a href={href} {...props}>{children}</a>;}`);
writeFileSync(resolve(GEN, "navigation.js"), `
export const useRouter=()=>({push:(href)=>window.location.assign(href)});`);
writeFileSync(resolve(GEN, "motion.jsx"), `
export const motion={div:({children,initial,animate,transition,...props})=><div {...props}>{children}</div>};`);
writeFileSync(resolve(GEN, "empty.jsx"), `
export default function Empty(){return null;}`);
writeFileSync(resolve(GEN, "pass.jsx"), `
export default function Pass({children}){return children;}`);
writeFileSync(resolve(GEN, "favorites.js"), `
export const getFavoritePlayers=()=>[];
export const setFavoritePlayers=()=>{};`);
writeFileSync(resolve(GEN, "myteam.js"), `
export const getMyTeamId=()=>1;
export const setMyTeamId=()=>{};`);
writeFileSync(resolve(GEN, "profile-auth.js"), `
export const updateProfile=async()=>{};`);
writeFileSync(resolve(GEN, "game-notification.js"), `
export const setWidgetMyTeam=async()=>{};`);
writeFileSync(resolve(GEN, "native-live.js"), `
export const ID_TO_KBO_CODE={1:"LG"};`);
writeFileSync(resolve(GEN, "entry.jsx"), `
import React from "react";
import {createRoot} from "react-dom/client";
import VenueStatsDashboard from "@/components/my/VenueStatsDashboard";
import MyPage from "@/app/(main)/my/page";
import MutatedMyPage from "./my-page-mutated";
import VenueStatsPage from "@/app/(main)/my/venue-stats/page";
const path=window.location.pathname;
const App=path==="/my"?MyPage:path==="/my-mutation"?MutatedMyPage:path==="/my/venue-stats"?VenueStatsPage:VenueStatsDashboard;
createRoot(document.getElementById("root")).render(<App/>);`);

await build({
  entryPoints: [resolve(GEN, "entry.jsx")],
  bundle: true,
  format: "iife",
  outfile: resolve(GEN, "bundle.js"),
  jsx: "automatic",
  absWorkingDir: ROOT,
  nodePaths: [resolve(ROOT, "node_modules")],
  tsconfig: resolve(ROOT, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"' },
  alias: {
    "@/lib/supabase/AuthContext": resolve(GEN, "auth.jsx"),
    "@/lib/supabase/client": resolve(GEN, "client.js"),
    "@/lib/supabase/auth": resolve(GEN, "profile-auth.js"),
    "@/lib/hooks/useSafeBack": resolve(GEN, "back.js"),
    "@/lib/store/favorites": resolve(GEN, "favorites.js"),
    "@/lib/store/myteam": resolve(GEN, "myteam.js"),
    "@/lib/capacitor/game-notification": resolve(GEN, "game-notification.js"),
    "@/lib/native-live-activity": resolve(GEN, "native-live.js"),
    "@/components/my/VenueStatsDashboard": dashboardEntryPath,
    "@/components/onboarding/TeamSelectModal": resolve(GEN, "empty.jsx"),
    "@/components/onboarding/PlayerSelectModal": resolve(GEN, "empty.jsx"),
    "@/components/auth/LoginSheet": resolve(GEN, "empty.jsx"),
    "@/components/profile/AvatarSelectSheet": resolve(GEN, "empty.jsx"),
    "@/components/profile/NicknameEditSheet": resolve(GEN, "empty.jsx"),
    "@/components/my/ProfileCard": resolve(GEN, "empty.jsx"),
    "@/components/my/InviteSection": resolve(GEN, "empty.jsx"),
    "@/components/my/FavoritePlayersCard": resolve(GEN, "empty.jsx"),
    "@/components/my/MenuSection": resolve(GEN, "empty.jsx"),
    "@/components/feedback/FeedbackSheet": resolve(GEN, "empty.jsx"),
    "@/components/my/VenueDiaryCard": resolve(GEN, "empty.jsx"),
    "@/components/admin/AdminOnly": resolve(GEN, "pass.jsx"),
    "next/image": resolve(GEN, "image.jsx"),
    "next/link": resolve(GEN, "link.jsx"),
    "next/navigation": resolve(GEN, "navigation.js"),
    "framer-motion": resolve(GEN, "motion.jsx"),
  },
  logLevel: "error",
});

const metricIds = [
  "A1","A2","A3","A4","A5","A6","B1","B2","B3","B4",
  "C1","C2","C4","C5","C6","D1","D5","D6","E1","E2","E3","E4",
];
const envelope = (id, value, denominator = { finalGames: 8 }) => ({
  id, state: "ready", value, n: 8, denominator, coverage: {},
});
// qualityAvg = 경기 질 평균(하린아빠 2026-08-02: 대승·박빙패가 긍정 기여).
// 요정 지수 v2 는 순수 승률이 아니라 5축 합성이라, fixture 도 비교 근거(deltaPp)와
// 경기 질을 갖춰야 실제 지수가 산출된다.
const scope = (name, wins, rate, excessWin = .18, excessMargin = 1.4) => {
  const metrics = Object.fromEntries(metricIds.map((id) => [id, envelope(id, null)]));
  // 팀별 승률 리프트(%p) — 경기수 가중 평균이 (rate-.5)×100 이 되도록 대칭 분배.
  const liftPp = (rate - .5) * 100;
  metrics.A1 = {
    ...envelope("A1", {
      attendance: { w: wins, l: 8 - wins, d: 0, rate },
      teamComparable: null,
      deltaPp: null,
    }),
    state: "mixed_team",
    items: [
      { key:"1", state:"ready", value:{attendance:{w:3,l:1,d:0,rate:.75},teamComparable:null,deltaPp:liftPp + 5}, n:4, denominator:{} },
      { key:"9", state:"ready", value:{attendance:{w:2,l:2,d:0,rate:.5},teamComparable:null,deltaPp:liftPp - 5}, n:4, denominator:{} },
    ],
  };
  // 요정 지수 본체 = pregame 기대치 대비 초과성과(승률 아님).
  metrics.A1.value.excess = { winExcess: excessWin, marginExcess: excessMargin, games: 8 };
  const teamValues = {
    "1": {
      B1:{attendanceAvg:.286,seasonAvg:.263,delta:.023},
      B2:{attendanceEra:3.42,seasonEra:4.01,delta:-.59},
      B3:{runsPerGame:5.2,seasonRunsPerGame:4.6,delta:.6,totalRuns:21},
      B4:{hr:{attendancePerGame:1.3,seasonPerGame:1.0,delta:.3},hitsAllowed:null},
    },
    "9": {
      B1:{attendanceAvg:.251,seasonAvg:.244,delta:.007},
      B2:{attendanceEra:4.18,seasonEra:4.31,delta:-.13},
      B3:{runsPerGame:4.1,seasonRunsPerGame:4.4,delta:-.3,totalRuns:16},
      B4:{hr:{attendancePerGame:.8,seasonPerGame:.7,delta:.1},hitsAllowed:null},
    },
  };
  for (const id of ["B1","B2","B3","B4"]) {
    metrics[id] = {...envelope(id, null),state:"mixed_team",items:[
      {key:"1",state:"ready",value:teamValues["1"][id],n:4,denominator:{}},
      {key:"9",state:"ready",value:teamValues["9"][id],n:4,denominator:{}},
    ]};
  }
  metrics.C1 = envelope("C1", [
    {playerId:"53123",attendanceAvg:.333,seasonAvg:.278,deltaAvg:.055,attendanceHrPerGame:.2,seasonHrPerGame:.1,attendanceRbiPerGame:1,seasonRbiPerGame:.7,appearances:6,ab:21},
    {playerId:"p3",attendanceAvg:.310,seasonAvg:.270,deltaAvg:.040,attendanceHrPerGame:.1,seasonHrPerGame:.1,attendanceRbiPerGame:.8,seasonRbiPerGame:.6,appearances:5,ab:20},
    {playerId:"p4",attendanceAvg:.230,seasonAvg:.260,deltaAvg:-.030,attendanceHrPerGame:0,seasonHrPerGame:.1,attendanceRbiPerGame:.3,seasonRbiPerGame:.5,appearances:5,ab:20},
  ], {attendanceAB:61});
  metrics.C2 = envelope("C2", [
    {playerId:"p2",attendanceEra:2.71,seasonEra:3.88,eraImprovement:1.17,attendanceK9:9.2,seasonK9:8.1,k9Delta:1.1,appearances:4,outs:40},
    {playerId:"p5",attendanceEra:3.20,seasonEra:3.75,eraImprovement:.55,attendanceK9:8.7,seasonK9:8.0,k9Delta:.7,appearances:4,outs:36},
  ], {attendanceOuts:76});
  metrics.C4 = envelope("C4", [
    {playerId:"53123",homeRuns:2,appearanceGames:6,batter:{hits:9,rbi:7,homeRuns:2},pitcher:null},
    {playerId:"p2",homeRuns:0,appearanceGames:4,batter:null,pitcher:{strikeouts:12,zeroEarnedRunGames:2}},
    {playerId:"p3",homeRuns:1,appearanceGames:5,batter:{hits:6,rbi:4,homeRuns:1},pitcher:null},
    {playerId:"p4",homeRuns:0,appearanceGames:5,batter:{hits:5,rbi:3,homeRuns:0},pitcher:null},
    {playerId:"p5",homeRuns:0,appearanceGames:4,batter:null,pitcher:{strikeouts:9,zeroEarnedRunGames:1}},
  ]);
  metrics.C5 = envelope("C5", [{playerId:"53123",batterTop:{gameId:"g",date:"2026-07-12",ab:4,h:3,hr:1,rbi:3,bb:1}}]);
  metrics.C6 = envelope("C6", {
    batterRanking:[
      {playerId:"53123",boostPct:.1978417266},
      {playerId:"p3",boostPct:.1481481481},
      {playerId:"p4",boostPct:.1153846154},
    ],
    pitcherRanking:[
      {playerId:"p2",boostPct:.3015463918},
      {playerId:"p5",boostPct:.1466666667},
    ],
  });
  // 경기 질 q 평균: 대승 2 · 박빙패 2 섞인 여름상의 “볼 만했다” 분포.
  metrics.D1 = envelope("D1", {avgRunDiff:1.4,closeGameRate:.25,closeGames:2});
  metrics.D5 = envelope("D5", {cancelledCount:1});
  metrics.D6 = envelope("D6", {maxTeamRuns:{gameId:"g",date:"2026-07-12",runs:9},maxMarginWin:null});
  metrics.E1 = envelope("E1", {current:3,longest:5,perTeam:[]});
  metrics.E2 = envelope("E2", {seasonCount:8,monthly:[],avgPerActiveMonth:2});
  metrics.E3 = envelope("E3", {firstAttendanceDate:"2024-04-01",daysSinceFirst:842,totalGames:17});
  metrics.E4 = envelope("E4", {topStadium:{name:"잠실",count:6},mostSeenFavorites:[]});
  metrics.A2 = envelope("A2", [{opponentTeamId:2,w:3,l:1,d:0,rate:.75}]);
  // 원정 찐팬 태그 검증용 — 홈 잠실 + 원정 2개 구장 3경기(하린아빠 2026-08-02).
  metrics.A3 = envelope("A3", [
    {stadium:"잠실",homeAway:"home",w:3,l:2,d:0,rate:.6},
    {stadium:"대구",homeAway:"away",w:1,l:1,d:0,rate:.5},
    {stadium:"문학",homeAway:"away",w:1,l:0,d:0,rate:1},
  ]);
  metrics.A4 = envelope("A4", [{weekday:6,w:3,l:1,d:0,rate:.75}]);
  metrics.A5 = {
    ...envelope("A5", [{dayNight:"night",w:4,l:2,d:0,rate:.667},{dayNight:"day",w:2,l:0,d:0,rate:1}]),
    // 낮경기 "기회 대비 참석" 근거 — baseline 정상(시즌 낮경기 20/200 = 10%).
    coverage: { dayGameOpportunity: { attendanceDayGames: 2, attendanceTotal: 8, seasonDayGames: 20, seasonTotal: 200 } },
  };
  metrics.A6 = envelope("A6", [{month:7,w:3,l:1,d:0,rate:.75}]);
  return {
    state:"ready",
    filter:{scope:name,sources:name==="gps"?["story_geofence"]:["story_geofence","diary_manual"]},
    coverage:{attendanceGames:8,finalGames:8,cancelledGames:1,unavailableGames:0,dedupedRows:0,incompleteFinalGames:0,invalidSnapshot:[]},
    metrics,
  };
};
// 지수 sentinel 은 v2 산식 실측값(아래 주석) — 시즌/스코프 간 구분이 되어야 stale 검출이 가능하다.
// ⚠️ 하린아빠 2026-08-02 "신뢰도 구간은 경기수 기준을 너무 높게 잡지 마" 반영으로
//    수축 k=3 → k=1 로 낮아지면서 sentinel 이 이동했다(보정이 덜 깎으므로 양수는 ↑, 음수는 ↓).
//   overall 2026: 초과성과 win +.18 · margin +1.4 → 71
//   gps    2026: 초과성과 win -.12 · margin -1.1 → 37
//   overall 2025: 초과성과 win -.30 · margin -2.6 → 17
const payload = {
  season:2026,
  seasonSupport:{status:"supported",supportedSeason:2026},
  overall:scope("overall",5,.625,.18,1.4),
  gps:scope("gps",3,.375,-.12,-1.1),
};
const stalePayload = {
  season:2025,
  seasonSupport:{status:"attendance_only",supportedSeason:2026},
  overall:scope("overall",2,.25,-.3,-2.6),
  gps:scope("gps",1,.125,-.3,-2.6),
};

// 혼합팀 표본 미달(2팀 × 1경기 = 총 2경기 < MIN_FINAL_GAMES).
// 서버 계약대로 시즌 baseline·delta 는 이미 null 로 내려오고, UI 는
// 사실값 노출 + 파생 점수 `–` + amber `표본 부족(참고용)` 이어야 한다.
const sampleLimitedScope = (name) => {
  const base = scope(name, 2, 1);
  base.metrics.A1 = {
    ...base.metrics.A1,
    n: 2,
    value: { attendance: { w: 2, l: 0, d: 0, rate: 1 }, teamComparable: null, deltaPp: null },
    items: [
      { key:"1", state:"sample_limited", value:{attendance:{w:1,l:0,d:0,rate:1},teamComparable:null,deltaPp:null}, n:1, denominator:{} },
      { key:"9", state:"sample_limited", value:{attendance:{w:1,l:0,d:0,rate:1},teamComparable:null,deltaPp:null}, n:1, denominator:{} },
    ],
  };
  const limited = {
    "1": {
      B1:{attendanceAvg:.286,seasonAvg:null,delta:null},
      B2:{attendanceEra:3.42,seasonEra:null,delta:null},
      B3:{runsPerGame:5.2,seasonRunsPerGame:null,delta:null,totalRuns:5},
      B4:{hr:{attendancePerGame:1.3,seasonPerGame:null,delta:null},hitsAllowed:null},
    },
    "9": {
      B1:{attendanceAvg:.251,seasonAvg:null,delta:null},
      B2:{attendanceEra:4.18,seasonEra:null,delta:null},
      B3:{runsPerGame:4.1,seasonRunsPerGame:null,delta:null,totalRuns:4},
      B4:{hr:{attendancePerGame:.8,seasonPerGame:null,delta:null},hitsAllowed:null},
    },
  };
  for (const id of ["B1","B2","B3","B4"]) {
    base.metrics[id] = {...base.metrics[id],items:[
      {key:"1",state:"sample_limited",value:limited["1"][id],n:1,denominator:{}},
      {key:"9",state:"sample_limited",value:limited["9"][id],n:1,denominator:{}},
    ]};
  }
  // A2~A6 production shape: 표본 미달 cell 은 top-level value 에서 빠지고 items 에만 사실값이 남는다.
  // UI 가 top-level 만 읽으면 이 경로가 `표시할 기록이 없어요` 로 죽는다(삼순 P0-2).
  const splitItems = {
    A2: [
      {key:"2",value:{opponentTeamId:2,w:1,l:0,d:0,rate:1}},
      {key:"9",value:{opponentTeamId:9,w:1,l:0,d:0,rate:1}},
    ],
    A3: [
      {key:"잠실:home",value:{stadium:"잠실",homeAway:"home",w:1,l:0,d:0,rate:1}},
      {key:"대전:away",value:{stadium:"대전",homeAway:"away",w:1,l:0,d:0,rate:1}},
    ],
    A4: [
      {key:"6",value:{weekday:6,w:1,l:0,d:0,rate:1}},
      {key:"3",value:{weekday:3,w:1,l:0,d:0,rate:1}},
    ],
    A5: [
      {key:"night",value:{dayNight:"night",w:2,l:0,d:0,rate:1}},
    ],
    A6: [
      {key:"7",value:{month:7,w:2,l:0,d:0,rate:1}},
    ],
  };
  for (const [id, items] of Object.entries(splitItems)) {
    base.metrics[id] = {
      ...base.metrics[id],
      state:"sample_limited",
      value:[],
      n:2,
      denominator:{finalGames:2},
      items: items.map(({key,value}) => ({key,state:"sample_limited",value,n:1,denominator:{finalGames:1}})),
    };
  }
  // production aggregate: C1/C2 sample_limited item은 value=null이고 C4 사실형만 남는다.
  base.metrics.C1 = { ...base.metrics.C1, state:"sample_limited", value:[], items:[] };
  base.metrics.C2 = { ...base.metrics.C2, state:"sample_limited", value:[], items:[] };
  return base;
};
const sampleLimitedPayload = {
  season:2026,
  seasonSupport:{status:"supported",supportedSeason:2026},
  overall:sampleLimitedScope("overall"),
  gps:sampleLimitedScope("gps"),
};

// attendance_only(비교 소스 없는 시즌) 2경기 — 판정 사다리에서 sample_limited 보다 먼저 확정되어
// 표본 미달이 state 에 가려지던 경계. 사실값은 노출하되 파생 지수는 `–` 이어야 한다.
const attendanceOnlyScope = (name) => {
  const base = sampleLimitedScope(name);
  base.metrics.A1 = {
    ...base.metrics.A1,
    state: "attendance_only",
    n: 2,
    denominator: { attendanceFinalGames: 2, teamSeasonGames: 0 },
    value: { attendance: { w: 2, l: 0, d: 0, rate: 1 }, teamComparable: null, deltaPp: null },
    items: [],
    reasons: ["season_not_supported"],
  };
  base.metrics.D5 = envelope("D5", { cancelledCount: 0 });
  base.metrics.D6 = envelope("D6", { maxTeamRuns: null, maxMarginWin: null });
  base.metrics.D1 = envelope("D1", { avgRunDiff: null, closeGameRate: null, closeGames: 0 });
  base.metrics.E1 = envelope("E1", { current: 0, longest: 0, perTeam: [] });
  return base;
};
const attendanceOnlyPayload = {
  season:2026,
  seasonSupport:{status:"supported",supportedSeason:2026},
  overall:attendanceOnlyScope("overall"),
  gps:attendanceOnlyScope("gps"),
};

// 직관 경기 원장은 complete지만 시즌 baseline만 partial인 운영 경계.
// 직관 사실값과 C4/C5 사실형 카드는 유지하고 시즌 비교만 `–`로 감춘다.
const partialBaselineScope = (name) => {
  const base = scope(name, 5, .625);
  base.state = "partial_data";
  base.coverage.incompleteFinalGames = 1;
  base.metrics.A1 = envelope("A1", {
    attendance: { w: 5, l: 3, d: 0, rate: .625 },
    teamComparable: null,
    deltaPp: null,
  });
  base.metrics.B1 = { ...envelope("B1", { attendanceAvg:.286, seasonAvg:null, delta:null }), state:"partial_data" };
  base.metrics.B2 = { ...envelope("B2", { attendanceEra:3.42, seasonEra:null, delta:null }), state:"partial_data" };
  base.metrics.B3 = envelope("B3", { runsPerGame:5.2, seasonRunsPerGame:4.6, delta:.6, totalRuns:42 });
  base.metrics.B4 = { ...envelope("B4", { hr:{attendancePerGame:1.3,seasonPerGame:null,delta:null}, hitsAllowed:null }), state:"partial_data" };
  base.metrics.C1 = {
    ...envelope("C1", [{playerId:"53123",attendanceAvg:.333,seasonAvg:null,deltaAvg:null,attendanceHrPerGame:.2,seasonHrPerGame:null,attendanceRbiPerGame:1,seasonRbiPerGame:null,appearances:6,ab:21}], {attendanceAB:21}),
    state:"partial_data",
  };
  base.metrics.C2 = {
    ...envelope("C2", [{playerId:"p2",attendanceEra:2.71,seasonEra:null,eraImprovement:null,attendanceK9:9.2,seasonK9:null,k9Delta:null,appearances:4,outs:40}], {attendanceOuts:40}),
    state:"partial_data",
  };
  base.metrics.C4 = envelope("C4", [
    {playerId:"53123",homeRuns:2,appearanceGames:6,batter:{hits:9,rbi:7,homeRuns:2},pitcher:null},
    {playerId:"p2",homeRuns:0,appearanceGames:4,batter:null,pitcher:{strikeouts:12,zeroEarnedRunGames:2}},
  ]);
  base.metrics.C5 = envelope("C5", [{playerId:"53123",batterTop:{gameId:"g",date:"2026-07-12",ab:4,h:3,hr:1,rbi:3,bb:1}}]);
  return base;
};
// 삼순 P1 (2026-08-02) — 초과성과·팀 delta 가 전부 0인 중립 화면.
// 예전 구현은 `score >= 50` 을 positive 로 보고 normalized 0 축까지 `우세` 라고 적어
// `50점 / 기대 대비 승리 우세가 높은 이유예요` 라는 모순 문장을 렌더했다.
const neutralScoreScope = (name) => {
  const base = scope(name, 4, .5, 0, 0);
  base.metrics.B1 = envelope("B1", { attendanceAvg:.263, seasonAvg:.263, delta:0 });
  base.metrics.B2 = envelope("B2", { attendanceEra:3.88, seasonEra:3.88, delta:0 });
  base.metrics.B3 = envelope("B3", { runsPerGame:4.6, seasonRunsPerGame:4.6, delta:0, totalRuns:37 });
  base.metrics.B4 = envelope("B4", {
    hr:{attendancePerGame:.9,seasonPerGame:.9,delta:0},
    hitsAllowed:{attendancePerGame:8.1,seasonPerGame:8.1,delta:0},
  });
  return base;
};
const neutralScorePayload = {
  season:2026,
  seasonSupport:{status:"supported",supportedSeason:2026},
  overall:neutralScoreScope("overall"),
  gps:neutralScoreScope("gps"),
};

const partialBaselinePayload = {
  season:2026,
  seasonSupport:{status:"supported",supportedSeason:2026},
  overall:partialBaselineScope("overall"),
  gps:partialBaselineScope("gps"),
};

// 삼순 P1 (2026-08-02) — 패배 스플릿 mutation RED용 payload.
// 표본은 충족하지만 야간·7월이 전부 패배인 실제 fixture — 예전엔 이 상태에서도
// `야간 경기 체질 0승 · 0%`, `7월의 승요 0승 · 0%` 같은 긍정 태그가 렌더됐다.
const losingSplitScope = (name) => {
  const base = scope(name, 5, .625);
  // 성적 태그 RED 는 "0승이면 승요류가 하나도 없어야 한다" 계약이다.
  // 기본 fixture 의 원정 승리가 새어 들어오면 계약이 무력화되므로 A3 도 0승으로 덮는다.
  base.metrics.A3 = envelope("A3", [
    {stadium:"잠실",homeAway:"home",w:0,l:2,d:0,rate:0},
    {stadium:"대구",homeAway:"away",w:0,l:1,d:0,rate:0},
  ]);
  base.metrics.A5 = {
    ...envelope("A5", [{dayNight:"night",w:0,l:3,d:0,rate:0},{dayNight:"day",w:0,l:3,d:0,rate:0}]),
    // 삼순 P1 재현 — 시즌 낮경기 기회 0인데 참석 1 → 예전엔 `평균의 Infinity배`가 렌더됐다.
    coverage: { dayGameOpportunity: { attendanceDayGames: 1, attendanceTotal: 3, seasonDayGames: 0, seasonTotal: 100 } },
  };
  base.metrics.A6 = envelope("A6", [{month:7,w:0,l:3,d:0,rate:0}]);
  return base;
};
const losingSplitPayload = {
  season:2026,
  seasonSupport:{status:"supported",supportedSeason:2026},
  overall:losingSplitScope("overall"),
  gps:losingSplitScope("gps"),
};

const css = await postcss([tailwind]).process(
  readFileSync(resolve(ROOT, "src/styles/globals.css"), "utf8"),
  { from: resolve(ROOT, "src/styles/globals.css") },
);
const bundle = readFileSync(resolve(GEN, "bundle.js"), "utf8");
let initial2026Served = false;
let fail2025 = false;
let serveSampleLimited = false;
let serveAttendanceOnly = false;
let servePartialBaseline = false;
let serveLosingSplits = false;
let breakFavoritePhoto = false;
let serveNeutralScore = false;
const server = createServer((req, res) => {
  if (req.url?.startsWith("/api/me/venue-stats")) {
    const requestedSeason = new URL(req.url, "http://127.0.0.1").searchParams.get("season");
    const body = requestedSeason === "2025"
      ? stalePayload
      : serveNeutralScore ? neutralScorePayload
      : serveLosingSplits ? losingSplitPayload
      : servePartialBaseline ? partialBaselinePayload
      : serveAttendanceOnly ? attendanceOnlyPayload
      : serveSampleLimited ? sampleLimitedPayload
      : payload;
    const delay = requestedSeason === "2025" ? 300 : initial2026Served ? 10 : 0;
    if (requestedSeason === "2026") initial2026Served = true;
    return setTimeout(() => {
      if (res.destroyed) return;
      if (requestedSeason === "2025" && fail2025) {
        res.writeHead(503, {"content-type":"application/json"}).end('{"error":"injected"}');
        return;
      }
      res.writeHead(200, {"content-type":"application/json"}).end(JSON.stringify(body));
    }, delay);
  }
  if (req.url === "/app.css") return res.writeHead(200, {"content-type":"text/css"}).end(css.css);
  if (req.url === "/bundle.js") return res.writeHead(200, {"content-type":"text/javascript"}).end(bundle);
  // 팀 로고 — 사진 폴백이 "실제로 로드되는지"까지 보려면 정적 SVG 를 실제로 서빙해야 한다.
  if (req.url?.startsWith("/logos/") && req.url.endsWith(".svg")) {
    const logoPath = resolve(ROOT, `public${req.url}`);
    if (existsSync(logoPath)) {
      return res.writeHead(200, {"content-type":"image/svg+xml"}).end(readFileSync(logoPath));
    }
    return res.writeHead(404).end();
  }
  if (req.url === "/players/53123.jpg") {
    // 삼순 P1 — runtime 로드 실패(404) 주입해 onError 팀 로고 폴백을 실제로 검증한다.
    if (breakFavoritePhoto) return res.writeHead(404).end();
    return res.writeHead(200, {"content-type":"image/jpeg"})
      .end(readFileSync(resolve(ROOT, "public/players/53123.jpg")));
  }
  res.writeHead(200, {"content-type":"text/html"}).end(
    '<!doctype html><html class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/app.css"></head><body style="margin:0"><div id="root"></div><script src="/bundle.js"></script></body></html>',
  );
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;
let browser;
try {
  browser = await playwright.chromium.launch();
} catch (error) {
  const line = String(error?.message ?? error).split("\n")[0];
  server.close();
  rmSync(GEN, { recursive: true, force: true });
  if (REQUIRE_BROWSER) {
    console.error(`FAIL: playwright chromium launch 실패(fail-closed) — ${line}`);
    process.exit(1);
  }
  console.log(`SKIP: playwright chromium launch 불가 — ${line}`);
  process.exit(0);
}
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
page.on("pageerror", (error) => console.log(`  [pageerror] ${error.message}`));

try {
  // 일반 로그인 사용자의 실제 진입 DOM → 클릭 → 실제 대시보드 DOM.
  await page.goto(`http://127.0.0.1:${port}/my`, { waitUntil: "domcontentloaded" });
  const entry = page.getByTestId("venue-stats-entry");
  await entry.waitFor();
  await entry.click();
  await page.waitForURL(`http://127.0.0.1:${port}/my/venue-stats`);
  await page.locator('[data-testid="venue-stats-dashboard"]').waitFor();

  // 실제 MyPage에서 진입 배선을 제거한 mutation은 링크를 0개로 만든다.
  await page.goto(`http://127.0.0.1:${port}/my-mutation`, { waitUntil: "domcontentloaded" });
  if (await page.getByTestId("venue-stats-entry").count()) {
    throw new Error("MyPage entry-removal mutation did not remove the venue stats entry");
  }

  // 익명 직접 URL은 빈 화면/데이터 호출이 아니라 명시적 로그인 유도로 차단한다.
  await page.goto(`http://127.0.0.1:${port}/my/venue-stats?anonymous=1`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("venue-stats-login-required").waitFor();
  if (await page.locator('[data-testid="venue-stats-dashboard"]').count()) {
    throw new Error("anonymous direct URL rendered venue stats dashboard");
  }

  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "domcontentloaded" });
  await page.getByText("71", { exact: true }).waitFor();
  const lgSegment = page.getByText("LG 응원 구간", { exact: true }).first().locator("../..");
  const hanwhaSegment = page.getByText("한화 응원 구간", { exact: true }).first().locator("../..");
  const lgText = await lgSegment.innerText();
  const hanwhaText = await hanwhaSegment.innerText();
  if (![".286", "3.42", "5.2", "1.3"].every((value) => lgText.includes(value))) {
    throw new Error(`mixed-team LG B1~B4 actual payload mismatch: ${lgText}`);
  }
  if (![".251", "4.18", "4.1", "0.8"].every((value) => hanwhaText.includes(value))) {
    throw new Error(`mixed-team 한화 B1~B4 actual payload mismatch: ${hanwhaText}`);
  }
  const body = await page.locator("body").innerText();
  if (!body.includes("LG 응원 구간") || !body.includes("한화 응원 구간")) throw new Error("mixed-team segments missing");
  if ((await page.evaluate(() => document.documentElement.scrollWidth)) > 390) throw new Error("horizontal overflow");
  const interestingFacts = page.getByTestId("venue-interesting-fact");
  if (await interestingFacts.count() !== 6) {
    throw new Error(`compact novelty facts must cap at 6, got ${await interestingFacts.count()}`);
  }
  for (const fact of await interestingFacts.allInnerTexts()) {
    if (fact.includes("–") || /\b0(?:회|경기|개)/.test(fact)) {
      throw new Error(`irrelevant novelty fact must be omitted: ${fact}`);
    }
  }
  const primaryInsights = page.getByTestId("venue-primary-insights");
  if (await primaryInsights.count() !== 1) throw new Error("primary opponent/weekday/stadium insights missing");
  const primaryText = await primaryInsights.innerText();
  for (const phrase of ["두산 킬러", "토요일의 승요", "잠실 강자"]) {
    if (!primaryText.includes(phrase)) throw new Error(`primary insight missing: ${phrase}`);
  }
  const tagToggle = page.getByRole("button", { name: /태그 .*개 더 보기/ });
  await tagToggle.click();
  if (await interestingFacts.count() <= 6) throw new Error("all character tags did not expand beyond representative six");

  // ── 원정 찐팬 태그 사용자 배선 RED (삼순 P1 2026-08-02) ──────────────────
  // 함수 단위 회귀만 있으면 `awayTag` push 블록을 통째로 지워도 PASS 한다(삼순 mutation 실증).
  // 여기서는 actual DOM 에 라벨+근거가 실제로 렌더되는지를 본다.
  // fixture: 홈 잠실 5경기 + 원정 대구 2 · 문학 1 = 원정 3경기 · 2구장 → tier4 `원정대장`.
  // 확장 렌더가 안정될 때까지 폴링 — 클릭 직후 allInnerTexts 는 이전 스냅샷을 볼 수 있다.
  let expandedFacts = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    expandedFacts = await interestingFacts.allInnerTexts();
    if (expandedFacts.length > 6) break;
    await page.waitForTimeout(50);
  }
  if (expandedFacts.length <= 6) {
    throw new Error(`태그 펼침이 안정화되지 않음: ${JSON.stringify(expandedFacts)}`);
  }
  const expandedText = expandedFacts.join("\n");
  if (!expandedText.includes("원정대장")) {
    throw new Error(`원정 3경기·2구장이면 '원정대장' 태그가 화면에 있어야 함: ${expandedText}`);
  }
  if (!expandedText.includes("원정 3경기 · 2개 구장")) {
    throw new Error(`원정 태그 근거 문자열이 정확해야 함: ${expandedText}`);
  }
  for (const lowerTier of ["첫 원정", "원정러", "전국구 팬"]) {
    if (expandedText.includes(lowerTier)) {
      throw new Error(`상위 등급 도달 시 하위 등급이 함께 뜨면 안 됨: ${lowerTier} / ${expandedText}`);
    }
  }

  await page.getByRole("button", { name: "태그 접기" }).click();
  const compactHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  if (compactHeight > 1500) throw new Error(`compact dashboard exceeded 1500px before details: ${compactHeight}px`);

  // 최애 5명 actual DOM(타자 3 + 투수 2): 역할별 1위 후보의 boostPct는
  // 투수(.3015) > 타자(.1978)이지만, 역할 간 숫자 비교 없이 최애 등록순 첫 후보(오스틴)를 메인으로 둔다.
  const favoriteCards = page.getByTestId("venue-favorite-card");
  const mainFavoriteText = await favoriteCards.first().innerText();
  if (await favoriteCards.count() !== 1 || !mainFavoriteText.includes("오스틴")) {
    throw new Error("cross-role boost values must not override favorite registration order");
  }
  if (!mainFavoriteText.includes("타자 부스트 1위") || mainFavoriteText.includes("투수 부스트 1위")) {
    throw new Error(`main favorite role label mismatch: ${mainFavoriteText}`);
  }
  if (!mainFavoriteText.includes("성적 궁합") || !mainFavoriteText.includes("▲")) {
    throw new Error(`favorite compatibility/direction hierarchy missing: ${mainFavoriteText}`);
  }
  if (await page.getByTestId("venue-compatibility-score").count() !== 1) {
    throw new Error("collapsed favorite view must show one compatibility score");
  }
  const favoritesToggle = page.getByRole("button", { name: "다른 최애 4명 보기" });
  await favoritesToggle.click();
  if (await favoriteCards.count() !== 5) {
    throw new Error(`five-favorite expanded view must show 5 cards, got ${await favoriteCards.count()}`);
  }
  if (await page.getByTestId("venue-compatibility-score").count() !== 5) {
    throw new Error("every sufficiently sampled favorite must show a 100-point compatibility score");
  }
  const positiveFavorite = page.getByText("오스틴", { exact: true })
    .locator('xpath=ancestor::*[@data-testid="venue-favorite-card"][1]');
  const negativeFavorite = page.getByText("박최애", { exact: true })
    .locator('xpath=ancestor::*[@data-testid="venue-favorite-card"][1]');
  const [positiveTrendText, negativeTrendText, positiveTrendColor, negativeTrendColor] = await Promise.all([
    positiveFavorite.getByTestId("venue-favorite-trend").innerText(),
    negativeFavorite.getByTestId("venue-favorite-trend").innerText(),
    positiveFavorite.getByTestId("venue-favorite-trend").evaluate((element) => getComputedStyle(element).color),
    negativeFavorite.getByTestId("venue-favorite-trend").evaluate((element) => getComputedStyle(element).color),
  ]);
  if (!positiveTrendText.includes("▲") || !negativeTrendText.includes("▼") || positiveTrendColor === negativeTrendColor) {
    throw new Error(`positive/negative boost contrast missing: ${positiveTrendText}/${positiveTrendColor}, ${negativeTrendText}/${negativeTrendColor}`);
  }
  const pitcherLeaderText = await page.getByText("이최애", { exact: true })
    .locator('xpath=ancestor::*[@data-testid="venue-favorite-card"][1]')
    .innerText();
  if (!pitcherLeaderText.includes("투수 부스트 1위")) {
    throw new Error(`pitcher role leader label missing: ${pitcherLeaderText}`);
  }

  // 최애 사진 회귀: 실제 사진 ID는 정적 JPEG를 로드하고, 사진 없는 ID는 종전 팀 로고를 유지한다.
  const favoritePhoto = page.locator('img[src="/players/53123.jpg"]');
  if (await favoritePhoto.count() !== 1) throw new Error("favorite photo must render exactly once");
  const photoLoaded = await favoritePhoto.evaluate((img) => img.complete && img.naturalWidth > 0);
  if (!photoLoaded) throw new Error("favorite photo did not load a valid image");
  const fallbackRow = page.getByText("이최애", { exact: true })
    .locator('xpath=ancestor::*[@data-testid="venue-favorite-card"][1]');
  const fallbackImages = fallbackRow.locator("img");
  if (await fallbackImages.count() !== 1) throw new Error("photo-less favorite must keep exactly one team-logo fallback");
  const fallbackSrc = await fallbackImages.first().getAttribute("src");
  if (!fallbackSrc || fallbackSrc.includes("/players/")) {
    throw new Error(`photo-less favorite rendered invalid photo instead of team logo: ${fallbackSrc}`);
  }

  // 삼순 P1 (2026-08-02) — 사진 URL 이 runtime 에 실패(404)하면 팀 로고로 폴백해야 한다.
  // 예전엔 `photoUrl` 이 있으면 Image 만 렌더해 깨진 이미지가 그대로 남았다.
  breakFavoritePhoto = true;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("venue-favorite-card").first().waitFor({ timeout: 4000 });
  const brokenSlot = page.getByTestId("venue-favorite-photo").first();
  await brokenSlot.locator('img[src*="/logos/"], img:not([src*="/players/"])').first()
    .waitFor({ timeout: 4000 })
    .catch(() => {});
  const photoState = await brokenSlot.getAttribute("data-photo-state");
  if (photoState !== "team-logo") {
    throw new Error(`404 사진은 팀 로고로 폴백해야 함(actual: ${photoState})`);
  }
  const brokenImgs = brokenSlot.locator("img");
  if (await brokenImgs.count() !== 1) {
    throw new Error("폴백 후에도 이미지는 정확히 1개여야 함");
  }
  const brokenSrc = await brokenImgs.first().getAttribute("src");
  if (!brokenSrc || brokenSrc.includes("/players/")) {
    throw new Error(`폴백이 여전히 깨진 선수 사진을 가리킴: ${brokenSrc}`);
  }
  const fallbackLoaded = await brokenImgs.first()
    .evaluate((img) => img.complete && img.naturalWidth > 0);
  if (!fallbackLoaded) throw new Error("팀 로고 폴백 이미지가 실제로 로드되지 않음");
  breakFavoritePhoto = false;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("venue-favorite-card").first().waitFor({ timeout: 4000 });
  const restoredState = await page.getByTestId("venue-favorite-photo").first()
    .getAttribute("data-photo-state");
  if (restoredState !== "photo") {
    throw new Error(`사진 정상화 후에는 다시 사진이어야 함(actual: ${restoredState})`);
  }
  // reload 로 최애 목록이 접힌 상태로 돌아왔으므로 이후 계약을 위해 다시 펼친다.
  await page.getByRole("button", { name: /다른 최애 .*명 보기/ }).click();
  if (await favoriteCards.count() !== 5) {
    throw new Error("사진 폴백 검증 후 최애 펼침 상태를 복원하지 못했습니다");
  }
  await page.getByRole("button", { name: "최애 접기" }).click();
  if (await favoriteCards.count() !== 1) throw new Error("five-favorite collapse did not return to one card");

  const staleRequest = page.waitForRequest((request) => request.url().includes("season=2025"));
  await page.locator("select").selectOption("2025");
  await staleRequest;
  await page.locator("select").selectOption("2026");
  await page.getByText("71", { exact: true }).waitFor();
  await page.waitForTimeout(400);
  if ((await page.locator("select").inputValue()) !== "2026") throw new Error("season selection rolled back");
  if (await page.getByText("17", { exact: true }).isVisible()) throw new Error("stale 2025 response overwrote 2026");

  // 결함주입: 선택 시즌(2025) 요청이 503으로 실패할 때
  // 로딩 중·실패 후 모두 이전 시즌(2026) 수치가 남지 않고 retry UI가 떠야 한다.
  fail2025 = true;
  const failedResponse = page
    .waitForResponse((response) => response.url().includes("season=2025") && response.status() === 503)
    .catch(() => null);
  await page.locator("select").selectOption("2025");
  await page.waitForTimeout(50);
  if ((await page.getByText("71", { exact: true }).count()) > 0) {
    throw new Error("stale previous-season value visible while selected season is loading");
  }
  await failedResponse;
  await page.getByRole("button", { name: /통계를 불러오지 못했어요/ }).waitFor({ timeout: 4000 });
  if ((await page.getByText("71", { exact: true }).count()) > 0) {
    throw new Error("stale previous-season value visible after selected season failed");
  }
  if ((await page.locator("select").inputValue()) !== "2025") throw new Error("failed season selection rolled back");

  fail2025 = false;
  await page.locator("select").selectOption("2026");
  await page.getByText("71", { exact: true }).waitFor();

  // 실패했던 시즌을 다시 고를 때, 이전 실패 UI가 새 요청 로딩 전에 한 프레임이라도 재노출되면 안 된다.
  // MutationObserver 로 DOM 변경마다 retry 버튼 존재를 샘플링해 1-frame flash 까지 잡는다.
  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="venue-stats-dashboard"]');
    window.__retryFlash = 0;
    const hasRetry = () =>
      [...root.querySelectorAll("button")].some((button) =>
        (button.textContent ?? "").includes("통계를 불러오지 못했어요"));
    window.__retryObserver = new MutationObserver(() => {
      if (hasRetry()) window.__retryFlash += 1;
    });
    window.__retryObserver.observe(root, { childList: true, subtree: true, characterData: true });
    if (hasRetry()) window.__retryFlash += 1;
  });
  await page.locator("select").selectOption("2025");
  const immediateRetry = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="venue-stats-dashboard"]');
    return [...root.querySelectorAll("button")].some((button) =>
      (button.textContent ?? "").includes("통계를 불러오지 못했어요"));
  });
  if (immediateRetry) {
    throw new Error("previous failure retry UI visible immediately after reselecting failed season");
  }
  await page.getByText("17", { exact: true }).waitFor();
  const retryFlash = await page.evaluate(() => {
    window.__retryObserver.disconnect();
    return window.__retryFlash;
  });
  if (retryFlash > 0) {
    throw new Error(`stale retry UI flashed ${retryFlash} time(s) when reselecting previously failed season`);
  }

  await page.locator("select").selectOption("2026");
  await page.getByText("71", { exact: true }).waitFor();

  await page.getByRole("button", { name: "GPS 인증만" }).click();
  await page.getByText("37", { exact: true }).waitFor();
  await page.getByRole("button", { name: "상대·구장·요일 상세 통계" }).click();

  const contrast = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    const rgba = (value) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "rgba(0,0,0,0)";
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const data = context.getImageData(0, 0, 1, 1).data;
      return { rgb: [data[0], data[1], data[2]], alpha: data[3] / 255 };
    };
    const over = (foreground, background) =>
      foreground.rgb.map((channel, index) =>
        Math.round(channel * foreground.alpha + background[index] * (1 - foreground.alpha)));
    const gradientAverage = (image) => {
      const colors = image.match(/rgba?\([^)]+\)/g)?.map(rgba).filter((color) => color.alpha > 0.01) ?? [];
      if (colors.length === 0) return null;
      return [0, 1, 2].map((index) =>
        Math.round(colors.reduce((sum, color) => sum + color.rgb[index], 0) / colors.length));
    };
    const effectiveBackground = (element) => {
      const chain = [];
      for (let current = element; current && current !== document.documentElement; current = current.parentElement) {
        chain.push(current);
      }
      chain.push(document.documentElement);
      let background = [255, 255, 255];
      for (let index = chain.length - 1; index >= 0; index -= 1) {
        const style = getComputedStyle(chain[index]);
        const color = rgba(style.backgroundColor);
        if (color.alpha > 0.001) background = over(color, background);
        if (style.backgroundImage !== "none") {
          const gradient = gradientAverage(style.backgroundImage);
          if (gradient) background = gradient;
        }
      }
      return background;
    };
    const luminance = (rgb) => {
      const channels = rgb.map((value) => {
        const normalized = value / 255;
        return normalized <= 0.03928
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const ratio = (foreground, background) => {
      const first = luminance(foreground);
      const second = luminance(background);
      return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
    };
    const probe = (element) => {
      const background = effectiveBackground(element);
      const foreground = over(rgba(getComputedStyle(element).color), background);
      return ratio(foreground, background);
    };
    const root = document.querySelector('[data-testid="venue-stats-dashboard"]');
    const candidates = [...root.querySelectorAll("*")].filter((element) => {
      const directText = [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? "")
        .join("")
        .trim();
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return directText.length > 0 && rect.width > 0 && rect.height > 0 &&
        style.display !== "none" && style.visibility !== "hidden";
    });
    const measured = candidates.map((element) => ({
      text: [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? "")
        .join("")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 60),
      ratio: probe(element),
    }));
    const mutationTarget = document.createElement("span");
    mutationTarget.textContent = "contrast mutation";
    mutationTarget.style.cssText = "display:block;color:rgb(21,21,25);background:rgb(21,21,25)";
    root.appendChild(mutationTarget);
    const mutationRatio = probe(mutationTarget);
    mutationTarget.remove();
    return {
      count: measured.length,
      minimum: Math.min(...measured.map((entry) => entry.ratio)),
      failures: measured.filter((entry) => entry.ratio < 4.5),
      mutationRatio,
    };
  });
  if (contrast.failures.length > 0) {
    throw new Error(`Dashboard AA contrast failures: ${JSON.stringify(contrast.failures.slice(0, 8))}`);
  }
  if (contrast.mutationRatio >= 4.5) throw new Error("Dashboard AA mutation guard did not fail");

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: SHOT, fullPage: true });

  // ── 혼합팀 표본 미달(2팀 × 1경기) actual DOM 계약 ────────────────────────────
  // 사실값(W/L/D·승률·B1~B4)은 보이고, 파생 요정 지수는 `–`, 배지는 amber `표본 부족(참고용)`,
  // 시즌 baseline/delta 비교 문구는 0건이어야 한다.
  serveSampleLimited = true;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("표본 부족(참고용)", { exact: true }).first().waitFor({ timeout: 4000 });

  const heroBlock = page.locator('[data-testid="venue-stats-dashboard"]').first();
  const heroText = await heroBlock.innerText();
  for (const fact of ["2승", "0패", "0무", "100.0%"]) {
    if (!heroText.includes(fact)) throw new Error(`sample-limited hero fact missing: ${fact}`);
  }
  if (/\b100점\b/.test(heroText) || heroText.includes("승률 요정")) {
    throw new Error(`sample-limited hero exposed derived score/badge: ${heroText.slice(0, 200)}`);
  }
  // 파생 지수는 hero 숫자 slot(54px) 에만 렌더된다 — 해당 슬롯을 직접 집어 값을 확인한다.
  const scoreText = await page
    .locator('[data-testid="venue-stats-dashboard"] span.text-\\[54px\\]')
    .first()
    .innerText();
  if (scoreText.trim() !== "–") throw new Error(`sample-limited derived score must be dash, got ${scoreText}`);

  const limitedLg = await page.getByText("LG 응원 구간", { exact: true }).first().locator("../..").innerText();
  const limitedHanwha = await page.getByText("한화 응원 구간", { exact: true }).first().locator("../..").innerText();
  if (![".286", "3.42", "5.2", "1.3"].every((value) => limitedLg.includes(value))) {
    throw new Error(`sample-limited mixed LG facts missing: ${limitedLg}`);
  }
  if (![".251", "4.18", "4.1", "0.8"].every((value) => limitedHanwha.includes(value))) {
    throw new Error(`sample-limited mixed 한화 facts missing: ${limitedHanwha}`);
  }
  const baselinePhrases = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="venue-stats-dashboard"]');
    return [...root.querySelectorAll("*")]
      .map((element) => [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? "").join("").trim())
      .filter((text) => /^시즌 /.test(text) || text.includes("시즌 경기당"));
  });
  if (baselinePhrases.length > 0) {
    throw new Error(`sample-limited must not render season baseline: ${JSON.stringify(baselinePhrases.slice(0, 5))}`);
  }
  // 배지는 기본 '승률 요정'(핑크 #ff9aa5)과 다른 경고색(amber)이어야 한다.
  // Tailwind v4 는 oklch 를 내보내므로 문자열 접두사 대신 실제 픽셀 RGB 로 판정한다.
  // A2~A6 상세: top-level value=[] 이어도 items 사실값이 실제 행으로 렌더되어야 한다.
  await page.getByRole("button", { name: "상대·구장·요일 상세 통계" }).click();
  const opponentCard = page.getByText("상대팀별", { exact: true }).locator("..");
  const opponentText = await opponentCard.innerText();
  if (opponentText.includes("표시할 기록이 없어요")) {
    throw new Error(`sample-limited split rows dropped (items ignored): ${opponentText}`);
  }
  for (const fact of ["두산전", "1승 0패 0무 · 100.0%"]) {
    if (!opponentText.includes(fact)) throw new Error(`sample-limited split fact missing: ${fact} / ${opponentText}`);
  }
  for (const [title, fact] of [["구장별", "잠실 · 홈"], ["요일별", "토요일"], ["낮·밤", "야간 경기"], ["월별", "7월"]]) {
    const text = await page.getByText(title, { exact: true }).locator("..").innerText();
    if (text.includes("표시할 기록이 없어요") || !text.includes(fact)) {
      throw new Error(`sample-limited split "${title}" missing ${fact}: ${text}`);
    }
  }
  // 행 단위 참고용 배지도 실제로 붙어야 한다.
  if ((await opponentCard.getByText("참고용", { exact: true }).count()) < 1) {
    throw new Error("sample-limited split rows missing 참고용 badge");
  }

  // 표본 미달 사실은 상세의 `참고용` 행에만 남기고, 확정형 요약 pill에는 올리지 않는다.
  if (await page.getByTestId("venue-interesting-fact").count()) {
    throw new Error("sample-limited facts must be omitted from confident novelty summary pills");
  }

  const badgeRgb = await page.getByText("표본 부족(참고용)", { exact: true }).first()
    .evaluate((element) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d");
      context.fillStyle = getComputedStyle(element).color;
      context.fillRect(0, 0, 1, 1);
      const data = context.getImageData(0, 0, 1, 1).data;
      return [data[0], data[1], data[2]];
    });
  const [br, bg, bb] = badgeRgb;
  if (!(br > 200 && bg > 150 && bb < 140)) {
    throw new Error(`sample-limited badge must be amber warning tone, got rgb(${badgeRgb.join(",")})`);
  }

  // ── attendance_only 2경기 actual DOM 계약 ─────────────────────────────────
  // 비교 소스가 없는 시즌은 attendance_only 가 sample_limited 보다 먼저 확정되므로
  // state 열거로 막으면 다시 뚫린다 — 사실값은 남기고 파생 지수만 비워야 한다.
  serveAttendanceOnly = true;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("표본 부족(참고용)", { exact: true }).first().waitFor({ timeout: 4000 });

  const aoText = await page.locator('[data-testid="venue-stats-dashboard"]').first().innerText();
  for (const fact of ["2승", "0패", "0무", "100.0%"]) {
    if (!aoText.includes(fact)) throw new Error(`attendance_only hero fact missing: ${fact}`);
  }
  if (aoText.includes("승률 요정")) {
    throw new Error(`attendance_only 2 games must not show confident badge: ${aoText.slice(0, 200)}`);
  }
  const aoScore = await page
    .locator('[data-testid="venue-stats-dashboard"] span.text-\\[54px\\]')
    .first()
    .innerText();
  if (aoScore.trim() !== "–") {
    throw new Error(`attendance_only 2 games derived score must be dash, got ${aoScore}`);
  }
  const aoBadgeRgb = await page.getByText("표본 부족(참고용)", { exact: true }).first()
    .evaluate((element) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d");
      context.fillStyle = getComputedStyle(element).color;
      context.fillRect(0, 0, 1, 1);
      const data = context.getImageData(0, 0, 1, 1).data;
      return [data[0], data[1], data[2]];
    });
  if (!(aoBadgeRgb[0] > 200 && aoBadgeRgb[1] > 150 && aoBadgeRgb[2] < 140)) {
    throw new Error(`attendance_only badge must be amber, got rgb(${aoBadgeRgb.join(",")})`);
  }
  const sparseFactText = await page.getByTestId("venue-interesting-fact").allInnerTexts();
  for (const omitted of ["우천·취소", "연속 직관", "최다 득점", "1점차 승부"]) {
    if (sparseFactText.some((text) => text.includes(omitted))) {
      throw new Error(`inapplicable novelty fact must be omitted: ${omitted}`);
    }
  }

  // mutation RED: 가드가 실제로 살아있는지 — 점수 slot 을 강제로 채우면 검사가 실패해야 한다.
  const mutationDetected = await page.evaluate(() => {
    const slot = document.querySelector('[data-testid="venue-stats-dashboard"] span.text-\\[54px\\]');
    const original = slot.textContent;
    slot.textContent = "100";
    const leaked = slot.textContent.trim() !== "–";
    slot.textContent = original;
    return leaked;
  });
  if (!mutationDetected) throw new Error("attendance_only score mutation guard did not trip");

  // ── 시즌 baseline만 partial인 실제 390px DOM 계약 ─────────────────────────
  // C1/C2 직관 사실값과 attendance-only C4/C5는 유지하고 시즌 수치만 감춘다.
  servePartialBaseline = true;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText(".333", { exact: true }).waitFor({ timeout: 4000 });

  // 단일팀 B1~B4는 네 개의 독립 카드가 아니라 divider를 둔 하나의 2×2 카드다.
  const teamMetrics = page.getByTestId("venue-team-metrics");
  if (await teamMetrics.count() !== 1 || await teamMetrics.locator(":scope > div").count() !== 4) {
    throw new Error("single-team metrics must render as one combined 2x2 card with four cells");
  }
  await page.getByRole("button", { name: /다른 최애 .*명 보기/ }).click();

  const partialText = await page.locator('[data-testid="venue-stats-dashboard"]').first().innerText();
  for (const fact of [".286", "3.42", "1.3", "시즌 4.6", "▲ +0.6", ".333", "2.71", "9안타", "7타점 · 2홈런", "12K", "2경기 0자책", "최애 최고의 직관 경기"]) {
    if (!partialText.includes(fact)) throw new Error(`partial-baseline attendance fact/card missing: ${fact}`);
  }
  if (!partialText.includes("일부 기록 확인 중")) {
    throw new Error("partial-baseline honest partial state label missing");
  }
  if (partialText.includes(".278") || partialText.includes("3.88")) {
    throw new Error(`partial-baseline leaked season comparison: ${partialText}`);
  }
  for (const favorite of ["오스틴", "이최애"]) {
    const cardText = await page.getByText(favorite, { exact: true })
      .locator('xpath=ancestor::div[contains(@class,"rounded-2xl")][1]')
      .innerText();
    if (cardText.includes("시즌") || cardText.includes("–")) {
      throw new Error(`partial-baseline ${favorite} unavailable season comparison must be omitted: ${cardText}`);
    }
  }
  if ((await page.evaluate(() => document.documentElement.scrollWidth)) > 390) {
    throw new Error("partial-baseline horizontal overflow");
  }

  // ── 50점 중립 문구 RED (삼순 P1 2026-08-02) ──────────────────────────
  // 초과성과·팀 delta 가 전부 0이면 점수는 정확히 50이고, 화면 계약은 `50 = 평소`다.
  // 예전 구현은 `score >= 50` 을 positive 로 보고 normalized 0 축까지 `우세`라고 적어
  // `50점 / 기대 대비 승리 우세가 높은 이유예요` 라는 모순을 렌더했다.
  servePartialBaseline = false;
  serveNeutralScore = true;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("50", { exact: true }).waitFor({ timeout: 6000 });
  const neutralBasis = await page.getByTestId("venue-score-basis").innerText();
  if (!neutralBasis.includes("기대와 비슷했어요")) {
    throw new Error(`중립(50점) 근거는 중립 문구여야 함: ${neutralBasis}`);
  }
  for (const contradiction of ["우세가 높은", "열세가 낮은", "우세가 낮은", "열세가 높은"]) {
    if (neutralBasis.includes(contradiction)) {
      throw new Error(`모든 축이 0인데 방향을 단정함: ${contradiction} / ${neutralBasis}`);
    }
  }
  const neutralBadge = await page.locator('[data-testid="venue-stats-dashboard"]').first().innerText();
  if (!neutralBadge.includes("평소와 비슷")) {
    throw new Error(`50점 배지는 '평소와 비슷' 이어야 함: ${neutralBadge.slice(0, 200)}`);
  }
  serveNeutralScore = false;

  // ── 패배 스플릿 mutation RED (삼순 2026-08-02 P1) ────────────────────
  // 야간 0승3패·7월 0승3패인 actual DOM에서 긍정 캐릭터 태그가 붙으면 FAIL.
  servePartialBaseline = false;
  serveLosingSplits = true;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("venue-interesting-fact").first().waitFor({ timeout: 4000 });
  await page.getByRole("button", { name: /태그 .*개 더 보기/ }).click();
  const losingFacts = await page.getByTestId("venue-interesting-fact").allInnerTexts();
  const losingText = losingFacts.join("\n");
  // 야간/낮 "체질" 태그는 폐기됐다 — 야간이 기본값이라 정보가 없다(하린아빠 2026-08-02).
  for (const phrase of ["야간 경기 체질", "낮 경기 체질", "야간 경기 인내형", "7월의 승요"]) {
    if (losingText.includes(phrase)) {
      throw new Error(`폐기/긍정 태그가 0승 스플릿에 붙음: ${phrase} / ${losingText}`);
    }
  }
  // 성적 태그는 승률이 실제 플러스일 때만 — 0승이면 승요류가 하나도 없어야 한다.
  for (const phrase of ["낮경기 승요", "원정 승요"]) {
    if (losingText.includes(phrase)) {
      throw new Error(`0승인데 성적 태그가 붙음: ${phrase} / ${losingText}`);
    }
  }
  if (!losingText.includes("7월 인내형")) {
    throw new Error(`0승 스플릿은 정직한 인내형 문구로 바뀌어야 함: ${losingText}`);
  }
  if (!losingText.includes("0승 3패")) {
    throw new Error(`0승 스플릿은 승·패를 함께 보여줘야 함: ${losingText}`);
  }
  // 삼순 P1 — baseline 0(낮경기 기회 0)에서 `평균의 Infinity배` 가 렌더되면 FAIL.
  const dashboardText = await page.locator('[data-testid="venue-stats-dashboard"]').first().innerText();
  for (const bad of ["Infinity", "NaN", "undefined"]) {
    if (dashboardText.includes(bad)) {
      throw new Error(`비정상 수치 문자열이 화면에 노출됨: ${bad}`);
    }
  }
  if (/햇살 직관러|낮경기 수집가/.test(losingText)) {
    throw new Error(`낮경기 기회 baseline 0이면 성향 태그를 붙이면 안 됨: ${losingText}`);
  }

  console.log(
    `venue stats S2 browser: PASS (390px, compact<=1500px, novelty<=6+inapplicable omitted, 5-favorite batter3+pitcher2 role-leader candidate + registration-order main + role labels + collapse/expand, mixed B1~B4 actual payload, season abort/generation, selected-season 503 fail-closed(no stale value + retry UI), sample-limited facts detail-only+dash score+amber badge+0 baseline, attendance_only 2-game facts+dash score+amber badge+mutation RED, single-team 2x2 card, partial-baseline B/C attendance facts+C4/C5 visible+season hidden, AA ${contrast.minimum.toFixed(2)}:1 across ${contrast.count} texts)\nshot: ${SHOT}`,
  );
} finally {
  await browser.close();
  server.close();
  rmSync(GEN, { recursive: true, force: true });
}
