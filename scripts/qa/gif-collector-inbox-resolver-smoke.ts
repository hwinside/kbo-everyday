/**
 * 움짤콜렉터 인박스 resolver smoke test.
 *
 * Usage: npx tsx scripts/qa/gif-collector-inbox-resolver-smoke.ts
 */

import { resolveInboxFromInput } from "@/lib/gif-collector/inbox-resolver";

type Case = {
  name: string;
  team: string;
  player: string;
  expect:
    | { ok: true; kboId: string; teamId: number }
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

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
