// 긴급공지 게이트 OFF — 심사 승인(갤워치앱 사용 가능) 시 실행. 신규 가입 자동발송 즉시 중단.
// 기존에 발송된 쪽지는 그대로 남는다(회수 아님). 재활성은 activate로.
//
// 실행: set -a && source .env.local && set +a && \
//   NOTICE_KEY=galaxy-watch-2026-07-19 npx tsx scripts/deactivate-urgent-notice.ts

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error("missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const NOTICE_KEY = (process.env.NOTICE_KEY ?? "").trim();
if (!NOTICE_KEY) { console.error("NOTICE_KEY env 필요"); process.exit(1); }

async function main() {
  const { data, error } = await admin
    .from("urgent_notices")
    .update({ active: false, deactivated_at: new Date().toISOString() })
    .eq("notice_key", NOTICE_KEY)
    .select("notice_key, active");
  if (error) { console.error("update 실패:", error.message); process.exit(1); }
  if (!data || data.length === 0) { console.error(`notice 없음 (key=${NOTICE_KEY})`); process.exit(1); }
  console.log(`게이트 OFF: notice_key=${NOTICE_KEY} active=false — 신규 가입 자동발송 중단`);
}
main().catch((e) => { console.error(e); process.exit(1); });
