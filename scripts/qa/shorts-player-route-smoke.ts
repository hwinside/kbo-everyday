import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  doosanResult.allowed && doosanResult.playerIds.join(",") === "53554" && doosanResult.teamId === "두산",
);
check(
  "요청 최애선수가 KT 김민석이면 두산 영상 차단",
  !revalidateStoredPlayerTags(doosanRow, players, activeT3, new Set(["54097"])).allowed,
);
check(
  "요청 최애선수가 두산 김민석이면 정상 통과",
  revalidateStoredPlayerTags(doosanRow, players, activeT3, new Set(["53554"])).allowed,
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
  revalidateStoredPlayerTags(sonRow, players, activeT3, new Set(["77532"])).allowed,
);
check(
  "longest roster name만 매칭하고 김민 prefix 제거",
  matchPlayers("김민석 홈런", players, null, 1).sort().join(",") === "53554,54097",
);

async function finishAsyncChecks() {
  const aliasFailureSupabase = {
    from: () => ({ select: async () => ({ data: null, error: { message: "alias boom" } }) }),
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

  function routeHasPlayerGate(source: string): boolean {
    return source.includes("const checked = revalidateStoredPlayerTags(") &&
      source.includes("_playerTagAllowed: checked.allowed") &&
      source.includes("if (v._playerTagAllowed === false) return false");
  }
  const routePath = join(process.cwd(), "src/app/api/shorts-feed/route.ts");
  const routeSource = readFileSync(routePath, "utf8");
  check("actual shorts-feed route에 player gate 결속", routeHasPlayerGate(routeSource));
  const removalMutation = routeSource.replace(
    "const checked = revalidateStoredPlayerTags(",
    "const checked = removedPlayerGate(",
  );
  check("fault-removal mutation RED", !routeHasPlayerGate(removalMutation));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

finishAsyncChecks().catch((error) => {
  console.error(error);
  process.exit(1);
});
