import { readFileSync } from "node:fs";

// Regression guard for the SET-NULL account-deletion change: once a departing
// user's identity columns become nullable, every read path that filtered or
// rendered those ids must tolerate null. PostgREST rejects `col=eq.null` and
// `col=in.(...,null)` with 400/22P02, and `null.slice()` throws in the client.
// This locks the three viewpoints (user, other party, admin) against regressing.

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
const read = (p: string) => readFileSync(p, "utf8");

// ---- User / other-party viewpoint: useDM ----
const useDM = read("src/lib/supabase/useDM.ts");
check(
  "useDM: 대화 상대 id는 null 제외 후 .in() 조회",
  /filter\([^)]*id[^)]*!==\s*null[\s\S]{0,120}?\.in\("id"/.test(useDM) ||
    /\.filter\(\(id\): id is string => id !== null\)/.test(useDM),
);
check(
  "useDM: 미읽음/실시간 sender 는 sender_id.is.null 을 포함(누락 방지)",
  useDM.includes("sender_id.is.null"),
);
check(
  "useDM: sender_id=null 메시지는 profile 조회를 건너뜀(eq.null 금지)",
  /msg\.sender_id\s*\?[\s\S]{0,160}?\.eq\("id", msg\.sender_id\)/.test(useDM),
);

// ---- User viewpoint: conversation page ----
const convPage = read("src/app/(main)/messages/[conversationId]/page.tsx");
check(
  "conversation page: 상대 id 미해결(oid null)이면 탈퇴 사용자로 표기",
  convPage.includes("탈퇴한 사용자"),
);
check(
  "conversation page: 상대 미확정이면 composer 비활성/숨김",
  /otherId \? [\s\S]{0,40}?"hidden"/.test(convPage) ||
    /!otherId/.test(convPage),
);

// ---- Admin viewpoint: reports route + page ----
const reportsRoute = read("src/app/api/admin/reports/route.ts");
check(
  "admin reports route: reporterIds 는 null 제외 후 .in() (in.(null) 400 방지)",
  /rows[\s\S]*?\.filter\(\(id\): id is string => id !== null\)/.test(reportsRoute) &&
    reportsRoute.indexOf("id !== null") < reportsRoute.indexOf('.in("id", reporterIds)'),
);
const reportsPage = read("src/app/admin/reports/page.tsx");
check(
  "admin reports page: reporter_id 는 nullable 타입",
  /reporter_id:\s*string \| null/.test(reportsPage),
);
check(
  "admin reports page: reporter_id.slice 는 null 체크 뒤에서만 호출(null.slice crash 방지)",
  (reportsPage.includes("r.reporter_id === null") ||
    /r\.reporter_id \?\s/.test(reportsPage)) &&
    reportsPage.includes("탈퇴"),
);

// ---- Authenticated RPC boundary ----
const deletionMigration = read("supabase/migrations/20260727_auth_user_delete_cascades.sql");
check(
  "dm_unread_counts: 501개 이상은 오류 없이 empty fail-close",
  /CREATE OR REPLACE FUNCTION public\.dm_unread_counts[\s\S]*?COALESCE\(cardinality\(p_conversation_ids\), 0\) > 500[\s\S]*?THEN\s+RETURN;\s+END IF;[\s\S]*?RETURN QUERY/.test(
    deletionMigration,
  ),
);
const unreadHook = read("src/lib/supabase/useUnreadDMCount.ts");
check(
  "useUnreadDMCount: 최신 대화를 정렬해 실제 500개만 RPC에 전달",
  /\.order\("last_message_at", \{ ascending: false \}\)[\s\S]{0,80}?\.limit\(500\)/.test(
    unreadHook,
  ),
);
const preservationAssert = read(
  "scripts/qa/dm-deletion-preservation.assert.sql",
);
check(
  "dm_unread_counts E2E: 500개 경계는 기존 대화 결과를 허용",
  /ARRAY\[conv\][\s\S]{0,100}?generate_series\(1, 499\)[\s\S]{0,100}?\)\s*=\s*1/.test(
    preservationAssert,
  ),
);
check(
  "dm_unread_counts E2E: 501개는 오류 없이 빈 결과로 차단",
  /ARRAY\[conv\][\s\S]{0,100}?generate_series\(1, 500\)[\s\S]{0,100}?\)\s*=\s*0/.test(
    preservationAssert,
  ),
);

// ---- Admin viewpoint: messages route ----
const adminMsg = read("src/app/api/admin/messages/route.ts");
check(
  "admin messages route: sender 는 null 제외 후 .in() 조회",
  /\.filter\(\(id\): id is string => id !== null\)/.test(adminMsg) &&
    adminMsg.indexOf("id !== null") < adminMsg.indexOf('.in("id", senderIds)'),
);
check(
  "admin messages route: sender_id=null 은 '알 수 없음' 으로 표기",
  adminMsg.includes("알 수 없음"),
);

console.log(`\nNullable DM guards smoke: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exit(1);
