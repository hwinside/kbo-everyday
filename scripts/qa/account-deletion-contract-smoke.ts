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
const useDM = readFileSync("src/lib/supabase/useDM.ts", "utf8");
const unreadDM = readFileSync("src/lib/supabase/useUnreadDMCount.ts", "utf8");
const conversationPage = readFileSync(
  "src/app/(main)/messages/[conversationId]/page.tsx",
  "utf8",
);
const adminMessagesRoute = readFileSync(
  "src/app/api/admin/messages/route.ts",
  "utf8",
);

// Own, non-evidence rows cascade: a departed user's feedback and block edges
// carry no shared/other-party record, so removing them on deletion is correct.
for (const constraint of [
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

// SHARED evidence must survive one party's deletion — anonymize (SET NULL),
// never CASCADE. A user leaving must not erase the other participant's DM
// history or destroy abuse-report evidence.
for (const constraint of [
  "dm_conversations_user1_id_fkey",
  "dm_conversations_user2_id_fkey",
  "dm_messages_sender_id_fkey",
  "dm_reports_reporter_id_fkey",
  "dm_reports_reported_user_id_fkey",
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

// SET NULL requires the identity columns to be nullable. They were NOT NULL,
// so the migration must relax them first or the anonymizing FK cannot fire.
for (const relaxed of [
  /ALTER COLUMN user1_id DROP NOT NULL/,
  /ALTER COLUMN user2_id DROP NOT NULL/,
  /ALTER COLUMN sender_id DROP NOT NULL/,
  /ALTER COLUMN reporter_id DROP NOT NULL/,
  /ALTER COLUMN reported_user_id DROP NOT NULL/,
]) {
  check(`identity relaxed to nullable: ${relaxed.source}`, relaxed.test(migration));
}

// Guard against regressing DM/report evidence back to CASCADE.
for (const forbidden of [
  "dm_conversations_user1_id_fkey",
  "dm_conversations_user2_id_fkey",
  "dm_messages_sender_id_fkey",
  "dm_reports_reporter_id_fkey",
  "dm_reports_reported_user_id_fkey",
]) {
  // Constrain the scan to the FK's own definition (up to the next ADD/ALTER/;)
  // so an unrelated CASCADE elsewhere can't false-match.
  const cascades = new RegExp(
    `ADD CONSTRAINT ${forbidden}[^;]*?ON DELETE CASCADE`,
  );
  check(`${forbidden} does NOT cascade`, !cascades.test(migration));
}
check(
  "route does not delete profile before auth user",
  !route.includes('.from("profiles").delete()'),
);
check(
  "route deletes the auth root once",
  (route.match(/admin\.auth\.admin\.deleteUser/g) || []).length === 1,
);
check(
  "dm_reports keeps its conversation evidence link",
  !migration.includes("DROP CONSTRAINT dm_reports_conversation_id_fkey"),
);
check(
  "RLS blocks new messages after either participant departs",
  /CREATE POLICY dm_msg_insert[\s\S]*?conversation\.user1_id IS NOT NULL[\s\S]*?conversation\.user2_id IS NOT NULL/.test(
    migration,
  ),
);
check(
  "RLS proves message sender belongs to the conversation",
  /CREATE POLICY dm_msg_insert[\s\S]*?conversation\.user1_id = auth\.uid\(\)[\s\S]*?conversation\.user2_id = auth\.uid\(\)/.test(
    migration,
  ),
);
check(
  "admin unread SQL counts NULL sender as not-system",
  (migration.match(/sender_id IS DISTINCT FROM p_system_user_id/g) || []).length >= 4,
);
check(
  "DM client excludes NULL ids from profile batch lookup",
  useDM.includes('.filter((id): id is string => id !== null)'),
);
check(
  "DM client labels anonymized participants",
  useDM.includes('"탈퇴한 사용자"'),
);
check(
  "DM unread queries include anonymized senders",
  useDM.includes('"dm_unread_counts"') &&
    unreadDM.includes('"dm_unread_counts"') &&
    migration.includes("message.sender_id IS DISTINCT FROM auth.uid()"),
);
check(
  "conversation page guards NULL before profile lookup",
  conversationPage.includes('if (!oid) {') &&
    conversationPage.includes('setOtherName("탈퇴한 사용자")'),
);
check(
  "admin reply rejects departed recipient",
  adminMessagesRoute.includes('"recipient_deleted"'),
);

console.log(`\nAccount deletion contract smoke: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exit(1);
