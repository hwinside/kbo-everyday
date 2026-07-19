// 긴급공지 배치 발송 — 활성 공지(urgent_notices SSOT)를 기존 안드 앱 유저에게 발송 (승인 후 실행).
// 발신 = URGENT_NOTICE_USER_ID(회신 불가 계정). 쪽지 INSERT → dispatch 웹훅 → 📢 푸시.
//
// ⚠️ 대상 = device_push_tokens.platform='android' 보유 distinct user (안드 앱 유저).
// ⚠️ 문안은 activate-urgent-notice.ts로 심은 urgent_notices(active) 행을 SSOT로 읽는다.
// ⚠️ 기본 DRY-RUN(대상 수·미리보기만). 실제 발송은 CONFIRM=send 필요.
// ⚠️ 멱등 — 같은 notice_key 쪽지가 이미 있는 대화방은 skip (재실행 안전, 신규가입 훅과도 무중복).
//
// 실행(미리보기): set -a && source .env.local && set +a && \
//   NOTICE_KEY=galaxy-watch-2026-07-19 npx tsx scripts/send-urgent-notice.ts
// 실행(발송):    ... CONFIRM=send npx tsx scripts/send-urgent-notice.ts

import { createClient } from "@supabase/supabase-js";
import { sendNoticeToUser } from "../src/lib/urgent-notice/send";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error("missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const NOTICE_KEY = (process.env.NOTICE_KEY ?? "").trim();
const CONFIRM = process.env.CONFIRM === "send";
if (!NOTICE_KEY) { console.error("NOTICE_KEY env 필요 (activate로 심은 키)"); process.exit(1); }

async function androidUserIds(): Promise<string[]> {
  const set = new Set<string>();
  let from = 0;
  const page = 1000;
  for (;;) {
    const { data, error } = await admin
      .from("device_push_tokens").select("user_id").eq("platform", "android").range(from, from + page - 1);
    if (error) throw new Error("token query: " + error.message);
    if (!data || data.length === 0) break;
    for (const r of data) set.add((r as { user_id: string }).user_id);
    if (data.length < page) break;
    from += page;
  }
  return [...set];
}

async function main() {
  const { data: notice, error: nErr } = await admin
    .from("urgent_notices")
    .select("notice_key, message, active, target_platform")
    .eq("notice_key", NOTICE_KEY)
    .maybeSingle();
  if (nErr) { console.error("notice 조회 실패:", nErr.message); process.exit(1); }
  if (!notice) { console.error(`notice 없음 — 먼저 activate-urgent-notice.ts 실행 (key=${NOTICE_KEY})`); process.exit(1); }
  if (!notice.active) { console.error("notice가 비활성(active=false) — 발송 중단"); process.exit(1); }

  const targets = await androidUserIds();
  console.log(`대상(안드 앱 유저): ${targets.length}명 / notice_key=${NOTICE_KEY} / target=${notice.target_platform}`);
  console.log(`--- 문안 미리보기 ---\n${notice.message}\n---------------------`);
  if (!CONFIRM) {
    console.log("DRY-RUN (미발송). 실제 발송하려면 CONFIRM=send 를 지정하세요.");
    return;
  }

  let sent = 0, skipped = 0, failed = 0;
  for (const userId of targets) {
    try {
      const r = await sendNoticeToUser(admin, userId, { notice_key: notice.notice_key, message: notice.message });
      if (r === "sent") { sent++; if (sent % 200 === 0) console.log(`  ...${sent} sent`); }
      else skipped++;
    } catch (e) {
      console.error(`  [error] ${userId}:`, (e as Error).message);
      failed++;
    }
  }
  console.log(`\n완료: 발송 ${sent} / 스킵 ${skipped} / 실패 ${failed} / 대상 ${targets.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
