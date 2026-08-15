#!/usr/bin/env node
//
// `qa:collector-author-team` 게이트의 **검출력 증명** — 결함주입 runner.
//
// 사고: 2026-08-16 하린아빠 — 콜렉터 계정 글에 최애선수 게시글 알림이 안 온다.
// 원인은 publisher 가 posts INSERT 에 `player_tags` 를 아예 넣지 않은 것. 디스패처
// (`/api/notifications/dispatch` handlePost)는 태그가 비면 그 자리에서 `return []` 하므로
// board_id 가 선수판이어도 푸시 시도 자체가 0건이었다(콜렉터 최근 글 50건 전부 `[]`).
//
// 게이트가 이 결함을 정말 잡는지 증명하려면 "통과한다"로는 부족하다 — 배포 소스를 실제로
// 훼손하고 게이트가 **지정된 assertion 문구**로 RED 나는지 확인한다.
//
// ⚠️ 외부 프로세스는 `npm` 하나만 쓴다 — Vercel 빌드 이미지에 diff/perl 이 없어 bash runner 가
//   통째로 깨진 실측(2026-08-09) 재발 방지.
// ⚠️ exit code 가 아니라 assertion 문구로 판정한다 — 무관한 크래시를 "검출 성공"으로 세지 않는다.
// ⚠️ 앵커가 1회 매치가 아니면 그 자체로 FAIL — 앵커 MISS 를 조용한 무력화로 두지 않는다
//   (2026-08-15 앵커 MISS 5회 실측).
//
// 실행: node scripts/qa/collector-player-tags-mutations.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const TARGETS = [
  "src/lib/gif-collector/publisher.ts",
  "src/lib/gif-collector/collector-team.ts",
  "src/lib/utils/player-roster.ts",
];
for (const t of TARGETS) {
  if (!fs.existsSync(t)) {
    console.error(`❌ ${t} 이 없다 — repo 루트에서 실행해야 한다`);
    process.exit(1);
  }
}
const ORIGINALS = new Map(TARGETS.map((t) => [t, fs.readFileSync(t, "utf8")]));
const restore = () => { for (const [t, src] of ORIGINALS) fs.writeFileSync(t, src); };
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { restore(); process.exit(130); });
}

const MUTATIONS = [
  {
    // 원 사고 그대로: payload 에서 player_tags 를 뺀다. 이게 8/16 이전 production 상태다.
    name: "M1 posts insert 에서 player_tags 제거 (원 사고 재현)",
    file: "src/lib/gif-collector/publisher.ts",
    from: "  if (collectorPlayerTags.length > 0) postInsert.player_tags = collectorPlayerTags;",
    to: "",
    expect: "파생된 태그가 posts insert payload 에 실린다",
  },
  {
    // 파생 호출만 죽여도 알림은 0건이 된다.
    name: "M2 buildCollectorPlayerTags 호출을 빈 배열로 대체 (배선 훼손)",
    file: "src/lib/gif-collector/publisher.ts",
    from: "const collectorPlayerTags = buildCollectorPlayerTags(row.matched_board_type, row.matched_kbo_id);",
    to: "const collectorPlayerTags: string[] = [];",
    expect: "publisher 가 buildCollectorPlayerTags 를 board_type + matched_kbo_id 로 호출",
  },
  {
    // 파생 함수 자체를 항상 빈 배열로 — 행동 검증(사고 재현 케이스)이 잡아야 한다.
    name: "M3 파생 함수가 항상 빈 배열 반환 (행동 RED)",
    file: "src/lib/gif-collector/collector-team.ts",
    from: "  const name = playerNameForKboId(kboId);\n  if (!name) return [];\n  return [formatPlayerTag(kboId, name)];",
    to: "  const name = playerNameForKboId(kboId);\n  if (!name) return [];\n  return [];",
    expect: "사고 재현: matched_kbo_id=52605 → player_tags 비어있지 않다",
  },
  {
    // fail-close 훼손: 이름을 못 찾아도 "52605:" 같은 깨진 태그를 만든다.
    name: "M4 로스터 미등록 시 이름 없는 태그 생성 (fail-close 훼손)",
    file: "src/lib/gif-collector/collector-team.ts",
    from: "  const name = playerNameForKboId(kboId);\n  if (!name) return [];\n  return [formatPlayerTag(kboId, name)];",
    to: "  const name = playerNameForKboId(kboId);\n  return [formatPlayerTag(kboId, name ?? \"\")];",
    expect: "로스터 미등록 kboId → 빈 배열(이름 없는 태그 생성 금지)",
  },
  {
    // board_type 가드 훼손(삼순 2026-08-16 NO-GO 축): matcher 가 실제 생성하는
    // `matchedKboId≠null + boardType='team'` 글에 태그가 붙으면 특정 선수 팬에게 오발송된다.
    name: "M8 board_type 가드 제거 (team 글 오발송 RED)",
    file: "src/lib/gif-collector/collector-team.ts",
    from: '  if (boardType !== "player") return [];',
    to: "",
    expect: "team 글은 matched_kbo_id 가 있어도 태그 없음(오발송 방지)",
  },
  {
    // 포맷 훼손: 디스패처가 tag.split(":") 로 kboId/이름을 복원하지 못하면 알림 제목이 깨진다.
    name: "M5 태그 포맷 훼손 (kboId 만 — 디스패처 파싱 계약 RED)",
    file: "src/lib/gif-collector/collector-team.ts",
    from: "  return [formatPlayerTag(kboId, name)];",
    to: "  return [kboId];",
    expect: 'player_tags 포맷이 커뮤니티 SSOT "kboId:이름" 와 같다',
  },
  {
    // 이름 조회 SSOT 훼손: 다른 선수 이름이 붙으면 알림 제목이 틀린 선수를 가리킨다.
    name: "M6 kboId→이름 매핑 훼손 (로스터 SSOT RED)",
    file: "src/lib/utils/player-roster.ts",
    from: "  return KBO_TO_NAME.get(String(kboId)) ?? null;",
    to: '  return KBO_TO_NAME.get(String(kboId)) ? "알수없음" : null;',
    expect: 'player_tags 포맷이 커뮤니티 SSOT "kboId:이름" 와 같다',
  },
  {
    // 디스패처 전제 훼손: 이 게이트가 검증하는 결함의 전제(태그가 유일 근거)가 유지되는지.
    name: "M7 디스패처 pref 키 변조 (수신 계약 RED)",
    file: "src/app/api/notifications/dispatch/route.ts",
    from: '      prefKey: "fav_player_post",',
    to: '      prefKey: "fav_player_highlight",',
    expect: "최애선수 게시글 알림은 fav_player_post pref 로 나간다",
  },
];

// M7 은 dispatch route 도 훼손하므로 백업 대상에 추가한다.
const DISPATCH = "src/app/api/notifications/dispatch/route.ts";
ORIGINALS.set(DISPATCH, fs.readFileSync(DISPATCH, "utf8"));

let failed = 0;
for (const m of MUTATIONS) {
  const src = ORIGINALS.get(m.file);
  const occurrences = src.split(m.from).length - 1;
  if (occurrences !== 1) {
    console.error(`❌ ${m.name}: 앵커가 ${occurrences}회 매치 (1회 필요) — 패턴이 낡았다`);
    failed++;
    continue;
  }
  fs.writeFileSync(m.file, src.replace(m.from, m.to));
  const run = spawnSync("npx", ["tsx", "scripts/qa/collector-author-team-smoke.ts"], { encoding: "utf8" });
  restore();
  const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  const red = run.status !== 0;
  // assertion 문구가 ✗ 줄에 나와야 한다 — ✓ 로 통과한 같은 문구를 증거로 세지 않는다.
  const evidenced = output.split("\n").some((l) => l.startsWith("✗") && l.includes(m.expect));
  if (red && evidenced) {
    console.log(`PASS 결함주입 RED: ${m.name}`);
  } else {
    failed++;
    console.error(`FAIL 결함주입: ${m.name} — status=${run.status} evidence(${m.expect})=${evidenced}`);
    console.error(output.split("\n").filter((l) => l.startsWith("✗") || l.includes("error TS")).slice(0, 5).join("\n"));
  }
}

restore();
if (failed > 0) {
  console.error(`\nFAIL collector player_tags mutations: ${failed}건`);
  process.exit(1);
}
console.log(`\nPASS collector player_tags mutations: ${MUTATIONS.length}/${MUTATIONS.length} RED`);
