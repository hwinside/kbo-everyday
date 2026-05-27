/**
 * 움짤콜렉터 인박스 resolver smoke test.
 *
 * Usage: npx tsx scripts/qa/gif-collector-inbox-resolver-smoke.ts
 */

import {
  resolveInboxFromInput,
  resolveInboxTeamOnly,
} from "@/lib/gif-collector/inbox-resolver";

type Case = {
  name: string;
  team: string;
  player: string;
  expect:
    | { ok: true; kboId: string; teamId: number }
    | { ok: false; errorIncludes?: string };
};

type TeamOnlyCase = {
  name: string;
  team: string;
  expect:
    | { ok: true; teamId: number; teamSlug: string; teamShortName: string }
    | { ok: false; errorIncludes?: string };
};

const cases: Case[] = [
  {
    name: "LG 오스틴 → kboId=53123 (정상)",
    team: "LG",
    player: "오스틴",
    expect: { ok: true, kboId: "53123", teamId: 1 },
  },
  {
    name: "엘지 별칭 → 동일 매칭",
    team: "엘지",
    player: "오스틴",
    expect: { ok: true, kboId: "53123", teamId: 1 },
  },
  {
    name: "외국인 풀네임 (LG 라클란 웰스)",
    team: "LG",
    player: "라클란 웰스",
    expect: { ok: true, kboId: "AQ002", teamId: 1 },
  },
  {
    name: "외국인 짧은 등록명 (LG 웰스)",
    team: "LG",
    player: "웰스",
    expect: { ok: true, kboId: "AQ002", teamId: 1 },
  },
  {
    name: "키움 박병호",
    team: "키움",
    player: "박병호",
    expect: { ok: true, kboId: "75125", teamId: 10 },
  },
  {
    name: "cross-team: LG 박병호 → 선수 검증 실패 (박병호는 키움)",
    team: "LG",
    player: "박병호",
    expect: { ok: false, errorIncludes: "찾지 못했" },
  },
  {
    name: "알 수 없는 팀 (XYZ) → 에러",
    team: "XYZ",
    player: "오스틴",
    expect: { ok: false, errorIncludes: "팀명" },
  },
  {
    name: "알 수 없는 선수 (LG 김존재안함) → 에러",
    team: "LG",
    player: "김존재안함",
    expect: { ok: false, errorIncludes: "찾지 못했" },
  },
];

let pass = 0;
let fail = 0;

for (const c of cases) {
  const r = resolveInboxFromInput(c.team, c.player);
  if (c.expect.ok) {
    if (!r.ok) {
      console.log(`✗ ${c.name} — expected ok, got error: ${r.error}`);
      fail++;
      continue;
    }
    if (r.value.kboId !== c.expect.kboId || r.value.teamId !== c.expect.teamId) {
      console.log(
        `✗ ${c.name} — expected kboId=${c.expect.kboId} teamId=${c.expect.teamId}, got ${r.value.kboId} ${r.value.teamId}`,
      );
      fail++;
      continue;
    }
    console.log(`✓ ${c.name}`);
    pass++;
  } else {
    if (r.ok) {
      console.log(`✗ ${c.name} — expected error, got ok`);
      fail++;
      continue;
    }
    if (c.expect.errorIncludes && !r.error.includes(c.expect.errorIncludes)) {
      console.log(`✗ ${c.name} — error '${r.error}' lacks '${c.expect.errorIncludes}'`);
      fail++;
      continue;
    }
    console.log(`✓ ${c.name}`);
    pass++;
  }
}

// ---- resolveInboxTeamOnly ----
const teamOnlyCases: TeamOnlyCase[] = [
  {
    name: "한화 → teamId=9 / slug=hanwha",
    team: "한화",
    expect: { ok: true, teamId: 9, teamSlug: "hanwha", teamShortName: "한화" },
  },
  {
    name: "이글스 (별칭) → 한화 매핑",
    team: "이글스",
    expect: { ok: true, teamId: 9, teamSlug: "hanwha", teamShortName: "한화" },
  },
  {
    name: "LG → teamId=1 / slug=lg",
    team: "LG",
    expect: { ok: true, teamId: 1, teamSlug: "lg", teamShortName: "LG" },
  },
  {
    name: "키움히어로즈 (붙여쓰기 별칭) → kiwoom",
    team: "키움히어로즈",
    expect: { ok: true, teamId: 10, teamSlug: "kiwoom", teamShortName: "키움" },
  },
  {
    name: "알 수 없는 팀 → 에러",
    team: "XYZ",
    expect: { ok: false, errorIncludes: "팀명" },
  },
];

for (const c of teamOnlyCases) {
  const r = resolveInboxTeamOnly(c.team);
  if (c.expect.ok) {
    if (!r.ok) {
      console.log(`✗ [team-only] ${c.name} — expected ok, got error: ${r.error}`);
      fail++;
      continue;
    }
    if (
      r.value.teamId !== c.expect.teamId ||
      r.value.teamSlug !== c.expect.teamSlug ||
      r.value.teamShortName !== c.expect.teamShortName
    ) {
      console.log(
        `✗ [team-only] ${c.name} — expected ${JSON.stringify(c.expect)}, got ${JSON.stringify(r.value)}`,
      );
      fail++;
      continue;
    }
    console.log(`✓ [team-only] ${c.name}`);
    pass++;
  } else {
    if (r.ok) {
      console.log(`✗ [team-only] ${c.name} — expected error, got ok`);
      fail++;
      continue;
    }
    if (c.expect.errorIncludes && !r.error.includes(c.expect.errorIncludes)) {
      console.log(
        `✗ [team-only] ${c.name} — error '${r.error}' lacks '${c.expect.errorIncludes}'`,
      );
      fail++;
      continue;
    }
    console.log(`✓ [team-only] ${c.name}`);
    pass++;
  }
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
