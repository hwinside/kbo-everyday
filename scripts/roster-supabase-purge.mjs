#!/usr/bin/env node
/**
 * T5-A (Roster SSOT Fortress Phase 1.5)
 *
 * Supabase `players_roster` 테이블의 모든 레코드 삭제.
 *
 * 이유:
 *   - Phase 1에서 /api/roster merge rule이 Supabase 데이터를 사용하지 않도록 전환됨
 *     ("static only admission, Supabase extension only")
 *   - 현재 142행은 전원 back_no="" 공란 상태인 오염된 데이터
 *   - Phase 2에서 schema 재정의 + FK(kbo_id → static SSOT) 강제 후
 *     extension field(photo_url 등)로 다시 채울 예정
 *
 * 사용법:
 *   node scripts/roster-supabase-purge.mjs --dry-run   # 삭제 대상만 조회
 *   node scripts/roster-supabase-purge.mjs --confirm   # 실제 삭제 실행
 *
 * 안전장치:
 *   - --confirm 플래그 없으면 dry-run 모드
 *   - 삭제 전 row 수 출력 + 샘플 10개 확인
 *   - .env.local 자동 로드
 */

import { createClient } from "/Users/harinclaw/Projects/kbo-everyday/node_modules/@supabase/supabase-js/dist/index.mjs";
import { readFileSync } from "node:fs";

// .env.local 자동 로드
try {
  const envRaw = readFileSync(
    "/Users/harinclaw/Projects/kbo-everyday/.env.local",
    "utf8",
  );
  for (const line of envRaw.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) {
      let v = m[2];
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      if (!process.env[m[1]]) process.env[m[1]] = v;
    }
  }
} catch {
  /* fallback to existing env */
}

const args = process.argv.slice(2);
const DRY_RUN = !args.includes("--confirm");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("❌ missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}

const sb = createClient(url, key);

// 1. 현재 상태 조회
const { data: before, error: e1 } = await sb
  .from("players_roster")
  .select("kbo_id, name, team, back_no")
  .order("name");
if (e1) {
  console.error("❌ select failed:", e1.message);
  process.exit(1);
}

console.log(`\n=== players_roster 현재 상태 ===`);
console.log(`총 ${before.length}행`);
const emptyBackNo = before.filter((p) => !p.back_no || p.back_no === "").length;
console.log(`back_no 공란: ${emptyBackNo}행`);
console.log(`\n샘플 10개:`);
before.slice(0, 10).forEach((p) => {
  console.log(`  ${p.name} (${p.team}) — kbo_id=${p.kbo_id} back_no="${p.back_no}"`);
});

if (DRY_RUN) {
  console.log(`\n[DRY-RUN] 삭제는 실행하지 않았음. 실제 삭제: --confirm 플래그 사용`);
  process.exit(0);
}

// 2. 실제 삭제
console.log(`\n🔥 --confirm 플래그 감지, ${before.length}행 삭제 진행...`);

// kbo_id IS NOT NULL 조건으로 전체 행 매치 (PostgREST는 unconditional delete 차단)
const { error: e2, count } = await sb
  .from("players_roster")
  .delete({ count: "exact" })
  .not("kbo_id", "is", null);

if (e2) {
  console.error("❌ delete failed:", e2.message);
  process.exit(1);
}

console.log(`✅ 삭제 완료: ${count}행`);

// 3. 삭제 후 검증
const { data: after, error: e3 } = await sb
  .from("players_roster")
  .select("kbo_id");
if (e3) {
  console.error("⚠️  post-delete select failed:", e3.message);
  process.exit(1);
}
console.log(`삭제 후 잔존: ${after.length}행 (0이어야 정상)`);

if (after.length > 0) {
  console.error(`❌ 잔존 행 존재. 수동 확인 필요.`);
  process.exit(1);
}

console.log(`\n✅ Supabase players_roster purge 완료`);
