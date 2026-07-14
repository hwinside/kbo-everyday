/**
 * 짤콜렉터 봇 계정 seed (idempotent).
 *
 * 움짤콜렉터(영상)와 짝을 이루는 사진 전용 봇. 사진만 있는 게시물 링크를 넣으면
 * 짤콜렉터가 사진글(image_urls)로 발행한다. author_id로 이 UUID를 사용.
 *
 * Usage:
 *   npx tsx scripts/seed-jjal-collector-bot.ts
 *
 * Env:
 *   SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY (필수)
 *
 * 출력의 JJAL_COLLECTOR_BOT_ID=<uuid>를 Vercel env JJAL_COLLECTOR_BOT_USER_ID에 저장.
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}

const BOT_EMAIL = "jjal-collector-bot@keubo.fan";
const BOT_NICKNAME = "짤콜렉터";
const BOT_TEAM_ID = 1; // profiles.team_id NOT NULL 충족. 봇은 팀 무관이므로 임의값.

const supa = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  // listUsers는 perPage 1000 + page loop로 전수 순회 — 단일 페이지로는 1k+ 유저 환경에서 못 찾아
  // createUser가 "email already registered"로 깨짐 (2026-04-21 회귀 사고).
  let user:
    | Awaited<ReturnType<typeof supa.auth.admin.listUsers>>["data"]["users"][number]
    | undefined;

  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supa.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    user = data.users.find((u) => u.email?.toLowerCase() === BOT_EMAIL.toLowerCase());
    if (user) break;
    if (data.users.length < 1000) break;
  }

  if (!user) {
    const { data, error } = await supa.auth.admin.createUser({
      email: BOT_EMAIL,
      email_confirm: true,
      user_metadata: { is_bot: true, bot_kind: "jjal_collector" },
    });
    if (error) throw error;
    user = data.user!;
    console.log(`✓ Created auth.users row for ${BOT_EMAIL} (id=${user.id})`);
  } else {
    console.log(`✓ Auth user exists for ${BOT_EMAIL} (id=${user.id})`);
  }

  const { error: profileErr } = await supa.from("profiles").upsert(
    {
      id: user.id,
      nickname: BOT_NICKNAME,
      team_id: BOT_TEAM_ID,
      is_bot: true,
    },
    { onConflict: "id" },
  );
  if (profileErr) throw profileErr;
  console.log(`✓ Profile upserted: nickname="${BOT_NICKNAME}", is_bot=true`);

  console.log(`\nJJAL_COLLECTOR_BOT_ID=${user.id}`);
  console.log("위 ID를 Vercel env JJAL_COLLECTOR_BOT_USER_ID에 저장 후 재배포.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
