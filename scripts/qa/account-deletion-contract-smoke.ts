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
  "supabase/migrations/20260727_auth_user_delete_cascades.sql",
  "utf8",
);
const route = readFileSync("src/app/api/auth/delete-account/route.ts", "utf8");

for (const constraint of [
  "dm_conversations_user1_id_fkey",
  "dm_conversations_user2_id_fkey",
  "dm_messages_sender_id_fkey",
  "dm_reports_reporter_id_fkey",
  "dm_reports_reported_user_id_fkey",
  "feedback_user_id_fkey",
  "feedback_votes_user_id_fkey",
  "user_blocks_blocker_id_fkey",
  "user_blocks_blocked_id_fkey",
]) {
  const definition = new RegExp(
    `ADD CONSTRAINT ${constraint}[\\s\\S]*?ON DELETE CASCADE`,
  );
  check(`${constraint} cascades`, definition.test(migration));
}

check(
  "telemetry is anonymized instead of blocking deletion",
  /admin_page_views_user_id_fkey[\s\S]*?ON DELETE SET NULL/.test(migration),
);
for (const constraint of [
  "invitations_invitee_id_fkey",
  "invitations_inviter_id_fkey",
  "profiles_invited_by_fkey",
  "reports_reporter_id_fkey",
]) {
  const definition = new RegExp(
    `ADD CONSTRAINT ${constraint}[\\s\\S]*?ON DELETE SET NULL`,
  );
  check(`${constraint} anonymizes`, definition.test(migration));
}
check(
  "route does not delete profile before auth user",
  !route.includes('.from("profiles").delete()'),
);
check(
  "route deletes the auth root once",
  (route.match(/admin\.auth\.admin\.deleteUser/g) || []).length === 1,
);

console.log(`\nAccount deletion contract smoke: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exit(1);
