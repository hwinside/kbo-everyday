import { NextRequest } from "next/server";
import {
  loadPlayerAliases,
  matchPlayers,
  type PlayerAlias,
} from "@/lib/video/player-tagger";
import { revalidateStoredPlayerTags } from "@/lib/video/shorts-player-gate";
import {
  getPlayerTagChannels,
  type PlayerTagChannel,
} from "@/lib/video/team-channels";

let handleShortsFeedGET: typeof import("@/app/api/shorts-feed/route").handleShortsFeedGET;

let pass = 0;
let fail = 0;
function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`✓ ${label}`);
    pass++;
  } else {
    console.error(`✗ ${label}`);
    fail++;
  }
}

const players: PlayerAlias[] = [
  { kbo_id: "52605", name: "김도영", team: "KIA", aliases: [] },
  { kbo_id: "53554", name: "김민석", team: "두산", aliases: [] },
  { kbo_id: "54097", name: "김민석", team: "KT", aliases: [] },
  { kbo_id: "68043", name: "김민", team: "SSG", aliases: [] },
  { kbo_id: "77532", name: "손아섭", team: "NC", aliases: [] },
];
const activeT3: PlayerTagChannel = {
  channel_id: "news-t3",
  channel_name: "News T3",
  tier: 3,
  team_affinity: null,
  is_active: true,
};
const inactiveT3: PlayerTagChannel = { ...activeT3, is_active: false };

type VideoRow = {
  video_id: string;
  title: string;
  thumbnail: string;
  channel: string;
  channel_id: string | null;
  published_at: string;
  source_type: string;
  player_id: string | null;
  player_ids: string[];
  noise_flags: string[];
  team_id: string | null;
};

function videoRow(overrides: Partial<VideoRow>): VideoRow {
  return {
    video_id: "fixture-video",
    title: "두산 김민석 끝내기 안타",
    thumbnail: "https://example.com/thumb.jpg",
    channel: "News T3",
    channel_id: activeT3.channel_id,
    published_at: "2026-08-02T12:00:00.000Z",
    source_type: "community_short",
    player_id: "53554",
    player_ids: ["53554", "54097", "68043"],
    noise_flags: [],
    team_id: "두산",
    ...overrides,
  };
}

function videoSupabase(rows: VideoRow[]) {
  return {
    from(table: string) {
      if (table !== "videos") throw new Error(`unexpected table: ${table}`);
      let selected = [...rows];
      const query: any = {
        select: () => query,
        // team 쿼리의 eq(team_id)를 실제 필터링 — no-op이면 타팀 scalar 행이
        // 팀 쿼리로도 들어와 선수 union 쿼리가 깨져도 PASS하는 false-positive가
        // 된다 (2026-08-13 삼순 2차 NO-GO #1).
        eq: (column: string, value: unknown) => {
          if (column === "team_id") {
            selected = selected.filter((row) => row.team_id === value);
          }
          return query;
        },
        neq: (column: string, value: unknown) => {
          if (column === "team_id") {
            selected = selected.filter((row) => row.team_id !== value);
          }
          return query;
        },
        or: (expr: string) => {
          // 최애선수 union 필터(player_id scalar + player_ids 배열)만 실제 필터링.
          // 그 외(LG 제목 역조회 title.ilike)는 no-op 유지.
          const m = expr.match(/player_id\.in\.\(([^)]*)\)/);
          if (m) {
            const ids = m[1].split(",").filter(Boolean);
            selected = selected.filter(
              (row) =>
                (row.player_id !== null && ids.includes(row.player_id)) ||
                row.player_ids.some((id) => ids.includes(id)),
            );
          }
          return query;
        },
        overlaps: (_column: string, ids: string[]) => {
          selected = selected.filter((row) =>
            row.player_ids.some((id) => ids.includes(id)),
          );
          return query;
        },
        gte: () => query,
        order: () => query,
        limit: (count: number) => {
          selected = selected.slice(0, count);
          return query;
        },
        then: (
          resolve: (value: { data: VideoRow[]; error: null }) => unknown,
        ) => Promise.resolve({ data: selected, error: null }).then(resolve),
      };
      return query;
    },
  };
}

function routeFor(rows: VideoRow[], channels: PlayerTagChannel[] = [activeT3]) {
  return (request: NextRequest) =>
    handleShortsFeedGET(request, {
      supabase: videoSupabase(rows) as never,
      loadAliases: async () => players,
      loadChannels: async () => channels,
      now: () => new Date("2026-08-02T18:00:00.000Z").getTime(),
    });
}

async function favoriteItems(
  rows: VideoRow[],
  favoriteId: string,
  channels: PlayerTagChannel[] = [activeT3],
) {
  const response = await routeFor(
    rows,
    channels,
  )(
    new NextRequest(
      `http://localhost/api/shorts-feed?scope=favorite_players&player_ids=${favoriteId}&limit=30`,
    ),
  );
  check("actual GET status 200", response.status === 200);
  const body = await response.json();
  return body.items as Array<{
    id: string;
    playerIds: string[];
    teamId: string | null;
  }>;
}

const reportedRow = {
  title: "김민석, 연설 중 돌연 고성 지르더니 무슨 말? / KNN",
  channel_id: activeT3.channel_id,
  source_type: "community_short",
  player_id: "53554",
  player_ids: ["53554", "54097", "68043"],
  team_id: "두산",
};

check(
  "원 제보 legacy row 차단",
  !revalidateStoredPlayerTags(reportedRow, players, activeT3).allowed,
);
check(
  "inactive channel도 tier 계약으로 차단",
  !revalidateStoredPlayerTags(reportedRow, players, inactiveT3).allowed,
);
check(
  "inactive channel은 정상형 제목도 fail-close",
  !revalidateStoredPlayerTags(
    { ...reportedRow, title: "두산 김민석 끕내기 안타", player_ids: ["53554"] },
    players,
    inactiveT3,
    new Set(["53554"]),
  ).allowed,
);
check(
  "inactive tier1 채널의 고유 선수명도 fail-close",
  !revalidateStoredPlayerTags(
    {
      ...reportedRow,
      title: "#손아섭응원가 오늘도 뜨겁다",
      player_id: "77532",
      player_ids: ["77532"],
      team_id: "NC",
    },
    players,
    { ...inactiveT3, tier: 1 },
    new Set(["77532"]),
  ).allowed,
);
check(
  "동일 채널이 active면 정상형 제목은 보존(over-block 방지)",
  revalidateStoredPlayerTags(
    { ...reportedRow, title: "두산 김민석 끕내기 안타", player_ids: ["53554"] },
    players,
    activeT3,
    new Set(["53554"]),
  ).allowed,
);
check(
  "missing channel metadata fail-close",
  !revalidateStoredPlayerTags(reportedRow, players, null).allowed,
);
check(
  "missing alias identity fail-close",
  !revalidateStoredPlayerTags(reportedRow, [], activeT3).allowed,
);
check(
  "legacy scalar player_id만 남은 행도 fail-close 재검증",
  !revalidateStoredPlayerTags(
    { ...reportedRow, player_ids: [], player_id: "53554" },
    players,
    activeT3,
  ).allowed,
);
check(
  "무관한 삼성 팀 토큰으로 legacy tag 복원 불가",
  !revalidateStoredPlayerTags(
    { ...reportedRow, title: "삼성 김민석 발언" },
    players,
    activeT3,
  ).allowed,
);

const doosanRow = { ...reportedRow, title: "두산 김민석 끝내기 안타" };
const doosanResult = revalidateStoredPlayerTags(doosanRow, players, activeT3);
check(
  "후보팀 교집합으로 두산 김민석 하나만 복원",
  doosanResult.allowed &&
    doosanResult.playerIds.join(",") === "53554" &&
    doosanResult.teamId === "두산",
);
check(
  "요청 최애선수가 KT 김민석이면 두산 영상 차단",
  !revalidateStoredPlayerTags(doosanRow, players, activeT3, new Set(["54097"]))
    .allowed,
);
check(
  "요청 최애선수가 두산 김민석이면 정상 통과",
  revalidateStoredPlayerTags(doosanRow, players, activeT3, new Set(["53554"]))
    .allowed,
);

const sonRow = {
  ...reportedRow,
  title: "#손아섭응원가 오늘도 뜨겁다",
  player_id: "77532",
  player_ids: ["77532"],
  team_id: "NC",
};
check(
  "Production 붙임말 정상 태그 보존",
  revalidateStoredPlayerTags(sonRow, players, activeT3, new Set(["77532"]))
    .allowed,
);
check(
  "longest roster name만 매칭하고 김민 prefix 제거",
  matchPlayers("김민석 홈런", players, null, 1).sort().join(",") ===
    "53554,54097",
);

async function finishAsyncChecks() {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://127.0.0.1:54321";
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= "shorts-route-smoke-key";
  ({ handleShortsFeedGET } = await import("@/app/api/shorts-feed/route"));

  const aliasFailureSupabase = {
    from: () => ({
      select: async () => ({ data: null, error: { message: "alias boom" } }),
    }),
  };
  let aliasFailedClosed = false;
  try {
    await loadPlayerAliases(aliasFailureSupabase);
  } catch {
    aliasFailedClosed = true;
  }
  check("alias lookup error fail-close", aliasFailedClosed);

  const channelFailureSupabase = {
    from: () => ({
      select: () => ({
        order: async () => ({ data: null, error: { message: "channel boom" } }),
      }),
    }),
  };
  let channelFailedClosed = false;
  try {
    await getPlayerTagChannels(channelFailureSupabase);
  } catch {
    channelFailedClosed = true;
  }
  check("channel lookup error fail-close", channelFailedClosed);

  const actualRows = [
    videoRow({
      video_id: "reported-political",
      title: reportedRow.title,
    }),
    videoRow({
      video_id: "correct-doosan",
    }),
    videoRow({
      video_id: "missing-channel",
      channel_id: "missing-channel-id",
    }),
  ];
  const doosanItems = await favoriteItems(actualRows, "53554");
  check(
    "actual GET 원 제보·missing channel 제거, 정상 두산 영상만 응답",
    doosanItems.map((item) => item.id).join(",") === "correct-doosan",
  );
  check(
    "actual GET 저장된 동명이인 태그를 두산 김민석 하나로 정규화",
    doosanItems[0]?.playerIds.join(",") === "53554" &&
      doosanItems[0]?.teamId === "두산",
  );

  const ktItems = await favoriteItems(actualRows, "54097");
  check(
    "actual GET KT 김민석 최애에는 두산·정치 영상 0건",
    ktItems.length === 0,
  );

  const inactiveItems = await favoriteItems(
    [videoRow({ video_id: "inactive-political", title: reportedRow.title })],
    "53554",
    [inactiveT3],
  );
  check(
    "actual GET inactive channel legacy 오태그 제거",
    inactiveItems.length === 0,
  );

  const inactiveNormalItems = await favoriteItems(
    [
      videoRow({
        video_id: "inactive-normal-title",
        title: "두산 김민석 끕내기 안타",
        player_id: "53554",
        player_ids: ["53554"],
      }),
    ],
    "53554",
    [inactiveT3],
  );
  check(
    "actual GET inactive channel 정상형 제목도 제거",
    inactiveNormalItems.length === 0,
  );

  const activeNormalItems = await favoriteItems(
    [
      videoRow({
        video_id: "active-normal-title",
        title: "두산 김민석 끕내기 안타",
        player_id: "53554",
        player_ids: ["53554"],
      }),
    ],
    "53554",
    [activeT3],
  );
  check(
    "actual GET active channel 정상형 제목은 보존",
    activeNormalItems.map((item) => item.id).join(",") === "active-normal-title",
  );

  const sonItems = await favoriteItems(
    [
      videoRow({
        video_id: "son-cheer-song",
        title: "#손아섭응원가 오늘도 뜨겁다",
        player_id: "77532",
        player_ids: ["77532"],
        team_id: "NC",
      }),
    ],
    "77532",
  );
  check(
    "actual GET 붙임말 정상 선수 영상 보존",
    sonItems[0]?.id === "son-cheer-song",
  );

  const aliasFailingGET = (request: NextRequest) =>
    handleShortsFeedGET(request, {
      supabase: videoSupabase(actualRows) as never,
      loadAliases: async () => {
        throw new Error("alias boom");
      },
      loadChannels: async () => [activeT3],
    });
  let routeAliasFailedClosed = false;
  try {
    await aliasFailingGET(
      new NextRequest(
        "http://localhost/api/shorts-feed?scope=favorite_players&player_ids=53554",
      ),
    );
  } catch {
    routeAliasFailedClosed = true;
  }
  check("actual GET alias lookup error fail-close", routeAliasFailedClosed);

  const channelFailingGET = (request: NextRequest) =>
    handleShortsFeedGET(request, {
      supabase: videoSupabase(actualRows) as never,
      loadAliases: async () => players,
      loadChannels: async () => {
        throw new Error("channel boom");
      },
    });
  let routeChannelFailedClosed = false;
  try {
    await channelFailingGET(
      new NextRequest(
        "http://localhost/api/shorts-feed?scope=favorite_players&player_ids=53554",
      ),
    );
  } catch {
    routeChannelFailedClosed = true;
  }
  check("actual GET channel lookup error fail-close", routeChannelFailedClosed);

  // --- scope=all = 마이팀+최애선수 병합 (2026-08-13 삼순 NO-GO 회귀) ---
  // 최애 매칭은 scalar player_id와 배열 player_ids union: source_type=player의
  // scalar 단일 태깅(playerId="77532", playerIds=[]) 타팀 영상이 포함돼야 하고,
  // 일반 ETC 뉴스는 제외, 양쪽 쿼리 중복은 1건으로 dedupe되어야 한다.
  const allScopeRows = [
    videoRow({
      video_id: "kia-team",
      team_id: "KIA",
      title: "KIA 타이거즈 끝내기 홈런",
      source_type: "official_short",
      player_id: null,
      player_ids: [],
    }),
    videoRow({
      video_id: "nc-son-scalar",
      team_id: "NC",
      title: "손아섭 멀티히트",
      source_type: "player",
      player_id: "77532",
      player_ids: [],
    }),
    videoRow({
      video_id: "kia-son-dupe",
      team_id: "KIA",
      title: "KIA전 손아섭 활약",
      source_type: "player",
      player_id: "77532",
      player_ids: [],
    }),
    videoRow({
      video_id: "etc-news",
      team_id: "ETC",
      title: "정치 뉴스 현장 발언 #shorts",
      source_type: "community_short",
      player_id: null,
      player_ids: [],
    }),
  ];
  const allScopeResponse = await routeFor(allScopeRows)(
    new NextRequest(
      "http://localhost/api/shorts-feed?scope=all&team=KIA&player_ids=77532&limit=30",
    ),
  );
  check("actual GET scope=all status 200", allScopeResponse.status === 200);
  const allScopeItems = (await allScopeResponse.json()).items as Array<{
    id: string;
  }>;
  const allScopeIds = allScopeItems.map((item) => item.id);
  check(
    "scope=all 마이팀 영상 포함",
    allScopeIds.includes("kia-team"),
  );
  check(
    "scope=all 타팀 scalar 최애선수 영상 포함 (player_id union)",
    allScopeIds.includes("nc-son-scalar"),
  );
  check(
    "scope=all 일반 ETC 뉴스 제외",
    !allScopeIds.includes("etc-news"),
  );
  check(
    "scope=all 양쪽 쿼리 중복 1건 dedupe",
    allScopeIds.filter((id) => id === "kia-son-dupe").length === 1,
  );
  check(
    "scope=all 응답 = 정확히 마이팀∪최애 3건",
    allScopeIds.length === 3,
  );

  // 최애 미설정 시 전체 = 마이팀만
  const allTeamOnlyResponse = await routeFor(allScopeRows)(
    new NextRequest("http://localhost/api/shorts-feed?scope=all&team=KIA&limit=30"),
  );
  const allTeamOnlyIds = (
    (await allTeamOnlyResponse.json()).items as Array<{ id: string }>
  ).map((item) => item.id);
  check(
    "scope=all 최애 미설정 → 마이팀만 (ETC·타팀 제외)",
    allTeamOnlyIds.sort().join(",") === "kia-son-dupe,kia-team",
  );

  // --- 외부 입력 sanitize 회귀 (삼순 2차 NO-GO #2) ---
  // malformed/주입 시도 토큰은 버려지고 숫자 canonical ID만 쿼리에 도달해야 한다.
  const malformedResponse = await routeFor(allScopeRows)(
    new NextRequest(
      "http://localhost/api/shorts-feed?scope=all&team=KIA&limit=30&player_ids=" +
        encodeURIComponent(
          "77532,77532, 77532 ,abc,or(,player_ids.ov.{x},77532);--,",
        ),
    ),
  );
  check("malformed player_ids에도 200", malformedResponse.status === 200);
  const malformedIds = (
    (await malformedResponse.json()).items as Array<{ id: string }>
  ).map((item) => item.id);
  check(
    "malformed 토큰 필터링 후 숫자 ID만 적용 (결과 = 정상 union과 동일)",
    malformedIds.sort().join(",") === "kia-son-dupe,kia-team,nc-son-scalar",
  );

  // 최대 5개 제한: 6번째 ID(77532)는 잘려 scalar 최애 행이 빠져야 한다.
  const overCapResponse = await routeFor(allScopeRows)(
    new NextRequest(
      "http://localhost/api/shorts-feed?scope=all&team=KIA&limit=30&player_ids=1,2,3,4,5,77532",
    ),
  );
  const overCapIds = (
    (await overCapResponse.json()).items as Array<{ id: string }>
  ).map((item) => item.id);
  check(
    "player_ids 6개 입력 시 앞 5개만 적용 (77532 제외 확인)",
    !overCapIds.includes("nc-son-scalar"),
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

finishAsyncChecks().catch((error) => {
  console.error(error);
  process.exit(1);
});
