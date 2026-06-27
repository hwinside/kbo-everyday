/**
 * Smoke/regression for 기록실 전체 엔트리 병합 (mergeFullEntry).
 *
 * Why
 * ---
 * full=1 union 구현 중 dedup 버그를 두 번 잡았다. 재발 방지:
 *  1) 외국인 더블카운트 — 라이브=영문ID(FP009)·크롤=숫자ID(56251)로 갈려 같은 선수가
 *     두 번 들어왔다. FOREIGN_NUMERIC_TO_ALPHA 정규화로 1건이어야 한다.
 *  2) 라이브 ID 미해결(빈 kboId, 주로 외국인) + 크롤 숫자ID → id-key가 어긋나 더블.
 *     name::team 보조키로 막아 1건이어야 한다.
 *  3) 서로 다른 숫자ID 동명이인(삼성 이승현 2명 등)은 정규화 대상이 아니라 보존(2건).
 *  4) 크롤 JSON 자체의 동일 ID 중복은 1건으로 접힌다.
 *  5) 라이브 선수는 실시간 행을 유지하고, 크롤 전용 백업만 추가되며 qualifiedRate 기본 0.
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

// 라이브: 규정 리더보드 (실시간 값). 외국인 카메론=영문ID, 스기모토=빈ID(미해결).
const live: FullEntryRow[] = [
  { name: "홍창기", team: "LG", kboId: "60100", avg: ".238", qualifiedRate: 1 },
  { name: "카메론", team: "두산", kboId: "FP009", g: 71, qualifiedRate: 1 }, // 영문ID
  { name: "스기모토", team: "KT", kboId: "", g: 40, qualifiedRate: 1 },        // 미해결(빈)
];

// 크롤: 전체 엔트리(매일). 외국인은 숫자ID. 백업 추가. 동명이인/자기중복 섞임.
const crawled: FullEntryRow[] = [
  { name: "홍창기", team: "LG", kboId: "60100", avg: ".238" },                 // 라이브 중복
  { name: "카메론", team: "두산", kboId: "56251", g: 59 },                     // FP009와 동일인(stale)
  { name: "스기모토", team: "KT", kboId: "56011", g: 30 },                     // 라이브 빈ID와 동일인
  { name: "문보경", team: "LG", kboId: "69102", avg: ".302" },                 // 신규 백업
  { name: "이승현", team: "삼성", kboId: "60146", g: 20 },                     // 동명이인 A
  { name: "이승현", team: "삼성", kboId: "51454", g: 5 },                      // 동명이인 B (보존)
  { name: "안우진", team: "키움", kboId: "68341", g: 8 },                      // 자기중복 1
  { name: "안우진", team: "키움", kboId: "68341", g: 8 },                      // 자기중복 2 (접힘)
];

const merged = mergeFullEntry(live, crawled);

ok("T1 외국인 영문ID/숫자ID 더블 → 1건 (카메론)", rowsFor(merged, "카메론", "두산").length === 1,
  `count=${rowsFor(merged, "카메론", "두산").length}`);
ok("T2 카메론은 라이브(실시간 g71) 유지", rowsFor(merged, "카메론", "두산")[0]?.g === 71,
  `g=${rowsFor(merged, "카메론", "두산")[0]?.g}`);
ok("T3 라이브 빈ID 외국인 + 크롤 숫자ID → 1건 (스기모토)", rowsFor(merged, "스기모토", "KT").length === 1,
  `count=${rowsFor(merged, "스기모토", "KT").length}`);
ok("T4 라이브 중복(홍창기) → 1건", rowsFor(merged, "홍창기", "LG").length === 1,
  `count=${rowsFor(merged, "홍창기", "LG").length}`);
ok("T5 신규 백업(문보경) 추가됨", rowsFor(merged, "문보경", "LG").length === 1);
ok("T6 신규 백업 qualifiedRate 기본 0", rowsFor(merged, "문보경", "LG")[0]?.qualifiedRate === 0,
  `q=${rowsFor(merged, "문보경", "LG")[0]?.qualifiedRate}`);
ok("T7 숫자ID 동명이인(이승현 2명) 보존", rowsFor(merged, "이승현", "삼성").length === 2,
  `count=${rowsFor(merged, "이승현", "삼성").length}`);
ok("T8 크롤 자기중복(안우진) → 1건", rowsFor(merged, "안우진", "키움").length === 1,
  `count=${rowsFor(merged, "안우진", "키움").length}`);
ok("T9 전체 카운트 = 라이브3 + 신규(문보경·이승현x2·안우진) = 7", merged.length === 7,
  `len=${merged.length}`);

console.log(fail === 0 ? "\n✅ ALL PASS" : `\n❌ ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
