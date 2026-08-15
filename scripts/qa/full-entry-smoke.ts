/**
 * Smoke/regression for 기록실 전체 엔트리 병합 (mergeFullEntry).
 *
 * Why
 * ---
 * full=1 union 구현 중 dedup 버그를 두 번 잡았고, #1196 3차에서 identity 계약을
 * **canonical ID-only fail-close** 로 강화했다(삼순 P0-1). 재발 방지:
 *  1) 외국인 더블카운트 — 라이브=영문ID(FP009)·크롤=숫자ID(56251)로 갈려 같은 선수가
 *     두 번 들어왔다. FOREIGN_NUMERIC_TO_ALPHA 정규화로 1건이어야 한다.
 *  2) ID 결손 행은 name::team 보조키 흡수가 아니라 **throw** — 보조키 자체가
 *     동명이인 오염 경로였다. (상류 /api/stats 가 이미 결손을 fail-close 한다.)
 *  3) 서로 다른 숫자ID 동명이인(삼성 이승현 2명 등)은 정규화 대상이 아니라 보존(2건).
 *  4) 같은 소스 내 동일 ID 중복은 조용한 접힘이 아니라 **throw** (소스 오염).
 *  5) 라이브 선수는 실시간 행을 유지하고, 크롤 전용 백업만 추가되며 qualifiedRate 기본 0.
 *  6) live↔크롤 같은 ID 인데 name 이 다르면 식별 충돌 **throw**.
 *
 * 실행: npx tsx scripts/qa/full-entry-smoke.ts  (npm run qa:full-entry)
 */
import { mergeFullEntry, type FullEntryRow } from "@/lib/stats/full-entry";

let fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!cond) fail++;
}
const rowsFor = (rows: FullEntryRow[], name: string, team: string) =>
  rows.filter((r) => r.name === name && r.team === team);

// 라이브: 규정 리더보드 (실시간 값). 외국인 카메론=영문ID. 전원 canonical ID 보유가 계약.
const live: FullEntryRow[] = [
  { name: "홍창기", team: "LG", kboId: "60100", avg: ".238", qualifiedRate: 1 },
  { name: "카메론", team: "두산", kboId: "FP009", g: 71, qualifiedRate: 1 }, // 영문ID
];

// 크롤: 전체 엔트리(매일). 외국인은 숫자ID. 백업 추가. 동명이인 섞임.
const crawled: FullEntryRow[] = [
  { name: "홍창기", team: "LG", kboId: "60100", avg: ".238" },                 // 라이브 중복(정상 dedupe)
  { name: "카메론", team: "두산", kboId: "56251", g: 59 },                     // FP009와 동일인(stale)
  { name: "문보경", team: "LG", kboId: "69102", avg: ".302" },                 // 신규 백업
  { name: "이승현", team: "삼성", kboId: "60146", g: 20 },                     // 동명이인 A
  { name: "이승현", team: "삼성", kboId: "51454", g: 5 },                      // 동명이인 B (보존)
];

const merged = mergeFullEntry(live, crawled);

ok("T1 외국인 영문ID/숫자ID 더블 → 1건 (카메론)", rowsFor(merged, "카메론", "두산").length === 1,
  `count=${rowsFor(merged, "카메론", "두산").length}`);
ok("T2 카메론은 라이브(실시간 g71) 유지", rowsFor(merged, "카메론", "두산")[0]?.g === 71,
  `g=${rowsFor(merged, "카메론", "두산")[0]?.g}`);
ok("T4 라이브 중복(홍창기) → 1건", rowsFor(merged, "홍창기", "LG").length === 1,
  `count=${rowsFor(merged, "홍창기", "LG").length}`);
ok("T5 신규 백업(문보경) 추가됨", rowsFor(merged, "문보경", "LG").length === 1);
ok("T6 신규 백업 qualifiedRate 기본 0", rowsFor(merged, "문보경", "LG")[0]?.qualifiedRate === 0,
  `q=${rowsFor(merged, "문보경", "LG")[0]?.qualifiedRate}`);
ok("T7 숫자ID 동명이인(이승현 2명) 보존", rowsFor(merged, "이승현", "삼성").length === 2,
  `count=${rowsFor(merged, "이승현", "삼성").length}`);
ok("T9 전체 카운트 = 라이브2 + 신규(문보경·이승현x2) = 5", merged.length === 5,
  `len=${merged.length}`);

// ── identity fail-close (삼순 #1196 3차 P0-1) ──
function throwsWith(fn: () => void, re: RegExp): boolean {
  try { fn(); return false; } catch (e) { return re.test((e as Error).message); }
}
ok("T10 크롤 ID 결손 → throw (name::team 보조키 흡수 금지)",
  throwsWith(() => mergeFullEntry(live, [{ name: "무명", team: "KT", kboId: "" }]), /identity missing/));
ok("T11 라이브 ID 결손 → throw",
  throwsWith(() => mergeFullEntry([{ name: "무명", team: "KT", kboId: "" }], []), /identity missing/));
ok("T12 크롤 자기중복 → throw (조용한 접힘 금지)",
  throwsWith(() => mergeFullEntry(live, [
    { name: "안우진", team: "키움", kboId: "68341" },
    { name: "안우진", team: "키움", kboId: "68341" },
  ]), /duplicated \(crawled\)/));
ok("T13 라이브 자기중복 → throw",
  throwsWith(() => mergeFullEntry([
    { name: "홍창기", team: "LG", kboId: "60100" },
    { name: "홍창기", team: "LG", kboId: "60100" },
  ], []), /duplicated \(live\)/));
ok("T14 live↔크롤 같은 ID 다른 name → 식별 충돌 throw",
  throwsWith(() => mergeFullEntry(live, [{ name: "오염된이름", team: "LG", kboId: "60100" }]), /identity conflict/));
ok("T15 이적 당일(team만 다름)은 충돌이 아니라 정상 dedupe",
  !throwsWith(() => mergeFullEntry(live, [{ name: "홍창기", team: "한화", kboId: "60100" }]), /./));

console.log(fail === 0 ? "\n✅ ALL PASS" : `\n❌ ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
