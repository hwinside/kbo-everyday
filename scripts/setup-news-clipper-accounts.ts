// 팀별 뉴스클리퍼 발신 계정 10개 생성 (one-off, idempotent).
// 클리핑 쪽지를 운영팀 계정과 분리해 CS 인입함 오염을 막는다 (2026-07-11 하린아빠 지시).
//
// 실행: set -a && source .env.local && set +a && npx tsx scripts/setup-news-clipper-accounts.ts
// 출력: teamId → userId 매핑 (src/lib/constants/news-clippers.ts에 반영)
//
// - auth.users: email clipper-{slug}@keubo.fan, email_confirm, 랜덤 비밀번호(로그인 미사용)
// - profiles: nickname "{shortName} 뉴스클리퍼", team_id, avatar_url=팀 로고
// - 재실행 시 nickname으로 기존 계정을 찾아 재사용 (중복 생성 없음)

import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";
import { TEAMS } from "../src/lib/constants/teams";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 필요");
  process.exit(1);
}
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

function clipperNickname(shortName: string): string {
  return `${shortName} 뉴스클리퍼`;
}

async function main() {
  const mapping: Record<number, string> = {};

  for (const team of TEAMS) {
    const nickname = clipperNickname(team.shortName);

    // idempotency — 닉네임 unique 제약 기준으로 기존 계정 재사용
    const { data: existing } = await admin
      .from("profiles")
      .select("id")
      .eq("nickname", nickname)
      .maybeSingle();
    if (existing) {
      mapping[team.id] = existing.id;
      console.log(`재사용: ${nickname} → ${existing.id}`);
      continue;
    }

    const email = `clipper-${team.slug}@keubo.fan`;
    const { data: created, error: userErr } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      password: randomBytes(24).toString("base64url"),
      user_metadata: { role: "news_clipper", team_id: team.id },
    });
    if (userErr || !created?.user) {
      console.error(`auth 생성 실패 (${nickname}):`, userErr?.message);
      process.exit(1);
    }

    const { error: profErr } = await admin.from("profiles").insert({
      id: created.user.id,
      nickname,
      team_id: team.id,
      avatar_url: team.logoPath,
    });
    if (profErr) {
      console.error(`profiles 생성 실패 (${nickname}):`, profErr.message);
      process.exit(1);
    }
    mapping[team.id] = created.user.id;
    console.log(`생성: ${nickname} → ${created.user.id}`);
  }

  console.log("\n// src/lib/constants/news-clippers.ts NEWS_CLIPPER_BY_TEAM:");
  console.log(JSON.stringify(mapping, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
