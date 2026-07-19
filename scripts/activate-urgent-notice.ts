// 긴급공지 SSOT 활성화 — urgent_notices upsert(active=true).
// 이 스크립트로 승인된 문안을 심으면: (1) send-urgent-notice.ts 배치 발송의 원본이 되고
// (2) 신규 안드 가입자 자동발송(welcome-dm 훅)이 켜진다. 심사 승인 시 deactivate로 끈다.
//
// 실행: set -a && source .env.local && set +a && \
//   NOTICE_KEY=galaxy-watch-2026-07-19 TARGET=android MESSAGE_FILE=/tmp/urgent-msg.txt \
//   npx tsx scripts/activate-urgent-notice.ts

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error("missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const NOTICE_KEY = (process.env.NOTICE_KEY ?? "").trim();
const TARGET = (process.env.TARGET ?? "android").trim();
const MESSAGE = (process.env.MESSAGE_FILE
  ? readFileSync(process.env.MESSAGE_FILE, "utf8")
  : process.env.MESSAGE ?? "").trim();

if (!NOTICE_KEY) { console.error("NOTICE_KEY env 필요"); process.exit(1); }
if (!["android", "ios", "all"].includes(TARGET)) { console.error("TARGET는 android|ios|all"); process.exit(1); }
if (!MESSAGE) { console.error("MESSAGE_FILE 또는 MESSAGE env 필요"); process.exit(1); }

async function main() {
  const { error } = await admin.from("urgent_notices").upsert(
    { notice_key: NOTICE_KEY, message: MESSAGE, target_platform: TARGET, active: true, deactivated_at: null },
    { onConflict: "notice_key" },
  );
  if (error) { console.error("upsert 실패:", error.message); process.exit(1); }
  console.log(`활성화: notice_key=${NOTICE_KEY} target=${TARGET} (${MESSAGE.length}자) — 신규 안드 가입 자동발송 ON`);
}
main().catch((e) => { console.error(e); process.exit(1); });
