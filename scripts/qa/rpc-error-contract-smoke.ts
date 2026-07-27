import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;

function check(name: string, condition: boolean) {
  if (condition) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.error("  ✗", name);
  }
}

const migration = readFileSync(
  "supabase/migrations/20260727_rpc_error_fixes.sql",
  "utf8",
);

check(
  "rollup delete satisfies the safe-update guard",
  migration.includes("DELETE FROM public.leaderboard_writing_rollup WHERE TRUE"),
);

const naverInsert = migration.match(
  /INSERT INTO auth\.identities \(([\s\S]*?)\)\s*VALUES/,
)?.[1] ?? "";
check("Naver identity insert omits generated email", !/\bemail\b/.test(naverInsert));
check("Naver identity insert uses the id default", !/(^|\W)id(\W|$)/.test(naverInsert));
check(
  "Naver identity RPC remains service-role only",
  /GRANT EXECUTE ON FUNCTION public\.upsert_naver_identity[\s\S]*?TO service_role/.test(
    migration,
  ),
);

console.log(`\nRPC error contract smoke: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exit(1);
