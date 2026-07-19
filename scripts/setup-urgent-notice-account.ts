// 긴급공지 발신 계정 생성 (one-off, idempotent).
// 회신 불가(자동 발송 전용) 시스템 계정 — 뉴스클리퍼처럼 운영팀 CS 인입함과 분리해
// 유저가 공지에 답장해도 CS 릴레이/인입함을 오염시키지 않게 한다 (2026-07-19 하린아빠 지시).
//
// 실행: set -a && source .env.local && set +a && npx tsx scripts/setup-urgent-notice-account.ts
// 출력: URGENT_NOTICE_USER_ID (src/lib/constants/urgent-notice.ts에 반영)
//
// - auth.users: email urgent-notice@keubo.fan, email_confirm, 랜덤 비밀번호(로그인 미사용)
// - profiles: nickname "긴급공지", team_id 0(운영팀 관례), avatar_url=앱 아이콘
// - 재실행 시 nickname/email로 기존 계정을 찾아 재사용 (중복 생성 없음)

import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 필요");
  process.exit(1);
}
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

const NICKNAME = "긴급공지";
const EMAIL = "urgent-notice@keubo.fan";
const AVATAR = "/app-icon.png";
const TEAM_ID = 0; // 운영팀(시스템) 계정 관례

async function findAuthUserByEmail(email: string): Promise<string | null> {
  for (let page = 1; page <= 30; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error("listUsers: " + error.message);
    if (!data || data.users.length === 0) return null;
    const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit.id;
    if (data.users.length < 1000) return null;
  }
  return null;
}

async function main() {
  // idempotency 1 — 닉네임 기준 기존 프로필 재사용
  const { data: byNick } = await admin
    .from("profiles").select("id").eq("nickname", NICKNAME).maybeSingle();
  if (byNick) {
    console.log(`URGENT_NOTICE_USER_ID=${byNick.id} (reused by nickname)`);
    return;
  }

  // idempotency 2 — auth 유저는 있으나 프로필만 없는 경우 프로필만 보강
  let userId = await findAuthUserByEmail(EMAIL);
  if (!userId) {
    const { data: created, error: userErr } = await admin.auth.admin.createUser({
      email: EMAIL,
      email_confirm: true,
      password: randomBytes(24).toString("base64url"),
      user_metadata: { role: "urgent_notice" },
    });
    if (userErr || !created?.user) {
      console.error("auth 생성 실패:", userErr?.message);
      process.exit(1);
    }
    userId = created.user.id;
  }

  const { error: profErr } = await admin.from("profiles").insert({
    id: userId,
    nickname: NICKNAME,
    team_id: TEAM_ID,
    avatar_url: AVATAR,
  });
  if (profErr) {
    console.error("profiles 생성 실패:", profErr.message);
    process.exit(1);
  }
  console.log(`URGENT_NOTICE_USER_ID=${userId} (created)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
