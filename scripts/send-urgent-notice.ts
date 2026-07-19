// 긴급공지 계정으로 안드로이드 앱 유저에게 공지 쪽지 발송 (승인 후 실행).
// 발신 = URGENT_NOTICE_USER_ID (회신 불가 계정). 쪽지 INSERT → dispatch 웹훅 → 📢 푸시.
//
// ⚠️ 대상 = device_push_tokens.platform='android' 보유 distinct user_id (안드 앱 유저).
// ⚠️ 기본은 DRY-RUN(대상 수·미리보기만). 실제 발송은 CONFIRM=send 필요.
// ⚠️ 멱등 — 같은 NOTICE_KEY 쪽지가 이미 있는 대화방은 skip (재실행 안전).
//
// 실행(미리보기): set -a && source .env.local && set +a && \
//   NOTICE_KEY=galaxy-watch-2026-07-19 MESSAGE_FILE=/tmp/urgent-msg.txt \
//   npx tsx scripts/send-urgent-notice.ts
// 실행(발송):    ... CONFIRM=send npx tsx scripts/send-urgent-notice.ts

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { URGENT_NOTICE_USER_ID } from "../src/lib/constants/urgent-notice";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error("missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const NOTICE_KEY = (process.env.NOTICE_KEY ?? "").trim();
const CONFIRM = process.env.CONFIRM === "send";
const MESSAGE = (process.env.MESSAGE_FILE
  ? readFileSync(process.env.MESSAGE_FILE, "utf8")
  : process.env.MESSAGE ?? "").trim();

if (!NOTICE_KEY) {
  console.error("NOTICE_KEY env 필요 (멱등 키, 예: galaxy-watch-2026-07-19)");
  process.exit(1);
}
if (!MESSAGE) {
  console.error("MESSAGE_FILE 또는 MESSAGE env 필요 (발송 문안)");
  process.exit(1);
}

async function androidUserIds(): Promise<string[]> {
  const set = new Set<string>();
  let from = 0;
  const page = 1000;
  for (;;) {
    const { data, error } = await admin
      .from("device_push_tokens")
      .select("user_id")
      .eq("platform", "android")
      .range(from, from + page - 1);
    if (error) throw new Error("token query: " + error.message);
    if (!data || data.length === 0) break;
    for (const r of data) set.add((r as { user_id: string }).user_id);
    if (data.length < page) break;
    from += page;
  }
  return [...set];
}

async function ensureConversation(userId: string): Promise<string> {
  const [u1, u2] = [URGENT_NOTICE_USER_ID, userId].sort();
  const { data: existing } = await admin
    .from("dm_conversations").select("id").eq("user1_id", u1).eq("user2_id", u2).maybeSingle();
  if (existing) return existing.id as string;
  const { data: created, error } = await admin
    .from("dm_conversations").insert({ user1_id: u1, user2_id: u2 }).select("id").single();
  if (error || !created) throw new Error(`conv create ${userId}: ${error?.message}`);
  return created.id as string;
}

async function alreadySent(conversationId: string): Promise<boolean> {
  const { data } = await admin
    .from("dm_messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("sender_id", URGENT_NOTICE_USER_ID)
    .eq("payload->>notice_key", NOTICE_KEY)
    .limit(1);
  return !!(data && data.length > 0);
}

async function main() {
  const targets = await androidUserIds();
  // 발신 계정 자신은 제외
  const recipients = targets.filter((id) => id !== URGENT_NOTICE_USER_ID);
  console.log(`대상(안드 앱 유저): ${recipients.length}명 / NOTICE_KEY=${NOTICE_KEY}`);
  console.log(`--- 문안 미리보기 ---\n${MESSAGE}\n---------------------`);
  if (!CONFIRM) {
    console.log("DRY-RUN (미발송). 실제 발송하려면 CONFIRM=send 를 지정하세요.");
    return;
  }

  let sent = 0, skipped = 0, failed = 0;
  for (const userId of recipients) {
    try {
      const convId = await ensureConversation(userId);
      if (await alreadySent(convId)) { skipped++; continue; }
      const { error: msgErr } = await admin.from("dm_messages").insert({
        conversation_id: convId,
        sender_id: URGENT_NOTICE_USER_ID,
        content: MESSAGE,
        payload: { type: "urgent_notice", notice_key: NOTICE_KEY },
      });
      if (msgErr) { console.error(`  [fail] ${userId}: ${msgErr.message}`); failed++; continue; }
      await admin.from("dm_conversations")
        .update({ last_message: MESSAGE.slice(0, 100), last_message_at: new Date().toISOString() })
        .eq("id", convId);
      sent++;
      if (sent % 200 === 0) console.log(`  ...${sent} sent`);
    } catch (e) {
      console.error(`  [error] ${userId}:`, (e as Error).message);
      failed++;
    }
  }
  console.log(`\n완료: 발송 ${sent} / 스킵 ${skipped} / 실패 ${failed} / 대상 ${recipients.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
