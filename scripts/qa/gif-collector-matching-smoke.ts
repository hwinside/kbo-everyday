/**
 * GIF collector matching engine smoke test.
 *
 * Usage: npx tsx scripts/qa/gif-collector-matching-smoke.ts
 */

import { matchMlbparkPost, type MatchResult } from "@/lib/gif-collector/matching";
import { normalizeTag, resolveTeamFromTags } from "@/lib/gif-collector/team-tag-map";

type Case = {
  name: string;
  post: { tags: string[]; title: string; content: string };
  expect: Partial<MatchResult>;
};

const cases: Case[] = [
  {
    name: "tag LG트윈스 + 본문 오스틴 → player 1.0",
    post: { tags: ["#LG트윈스"], title: "오스틴 멀티홈런 움짤", content: "오스틴이 6타수 3안타 활약" },
    expect: {
      matchedKboId: "53123",
      matchedBoardType: "player",
      matchedBoardId: "53123",
      matchConfidence: 1.0,
    },
  },
  {
    name: "tag LG + 외국인 풀네임 '라클란 웰스' → AQ002",
    post: { tags: ["#LG"], title: "라클란 웰스 7이닝 1실점", content: "오늘 등판 짤" },
    expect: {
      matchedKboId: "AQ002",
      matchedBoardType: "player",
      matchedBoardId: "AQ002",
      matchConfidence: 1.0,
    },
  },
  {
    name: "tag 없음, 본문 '오스틴' 단독 → 0.85 (player, team unconfirmed)",
    post: { tags: [], title: "오스틴 만루홈런", content: "" },
    expect: {
      matchedKboId: "53123",
      matchedBoardType: "player",
      matchConfidence: 0.85,
    },
  },
  {
    name: "tag만 있고 선수명 없음 → team 게시판, 0.6",
    post: { tags: ["#두산"], title: "오늘 경기 하이라이트", content: "두산 승리 짤" },
    expect: {
      matchedKboId: null,
      matchedBoardType: "team",
      matchedBoardId: "2",
      matchConfidence: 0.6,
    },
  },
  {
    name: "tag 2개 (LG + 두산) + 선수명 없음 → ambiguous, no_match (team도 없음)",
    post: { tags: ["#LG", "#두산"], title: "LG vs 두산 경기 하이라이트", content: "" },
    expect: {
      matchedBoardType: null,
      matchedBoardId: null,
      matchConfidence: 0.0,
    },
  },
  {
    name: "본문에 LG 팀 선수 2명 등장 → ambiguous, team 게시판 0.5",
    post: {
      tags: ["#LG"],
      title: "오스틴, 라클란 웰스 활약",
      content: "두 선수 모두 시즌 첫 멀티",
    },
    expect: {
      matchedKboId: null,
      matchedBoardType: "team",
      matchedBoardId: "1",
      matchConfidence: 0.5,
    },
  },
  {
    name: "전혀 매칭 없음 → no_match, 0.0",
    post: { tags: [], title: "그냥 잡담", content: "오늘 날씨 좋네" },
    expect: {
      matchedBoardType: null,
      matchedBoardId: null,
      matchConfidence: 0.0,
    },
  },
  {
    name: "tag 별칭 '엘지' + 선수 → 정상 매칭",
    post: { tags: ["엘지"], title: "오스틴 굿", content: "" },
    expect: {
      matchedKboId: "53123",
      matchedBoardType: "player",
      matchConfidence: 1.0,
    },
  },
  {
    name: "tag normalizeTag 직접 검증 ('#KIA타이거즈' → 'kia타이거즈')",
    post: { tags: [], title: "", content: "" },
    expect: {},
  },
];

let pass = 0;
let fail = 0;

function check(name: string, actual: MatchResult, expect: Partial<MatchResult>): boolean {
  for (const [k, v] of Object.entries(expect)) {
    const got = (actual as unknown as Record<string, unknown>)[k];
    if (got !== v) {
      console.log(`✗ ${name}`);
      console.log(`    ${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got)}`);
      console.log(`    reasons: ${actual.reasons.join(" | ")}`);
      return false;
    }
  }
  console.log(`✓ ${name}`);
  return true;
}

for (const c of cases.slice(0, -1)) {
  const r = matchMlbparkPost(c.post);
  if (check(c.name, r, c.expect)) pass++;
  else fail++;
}

// normalizeTag 직접
const norm = normalizeTag("#KIA타이거즈");
if (norm === "kia타이거즈") {
  console.log(`✓ normalizeTag '#KIA타이거즈' → '${norm}'`);
  pass++;
} else {
  console.log(`✗ normalizeTag '#KIA타이거즈' → '${norm}' (expected 'kia타이거즈')`);
  fail++;
}

const res = resolveTeamFromTags(["#LG", "#두산"]);
if (res.ambiguous && res.teamIds.length === 2 && res.teamIds.includes(1) && res.teamIds.includes(2)) {
  console.log(`✓ resolveTeamFromTags ['#LG','#두산'] → ambiguous=true, teamIds=[1,2]`);
  pass++;
} else {
  console.log(
    `✗ resolveTeamFromTags ['#LG','#두산'] → unexpected: ${JSON.stringify(res)}`,
  );
  fail++;
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
