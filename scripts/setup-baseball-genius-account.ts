// 야구천재 고정 DM 시스템 계정 one-off provisioning (idempotent).
// migration과 별개로 auth.users + profiles만 보장하며, 생성된 UUID를 상수에 반영한다.
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 필요");
  process.exit(1);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const NICKNAME = "야구천재";
const EMAIL = "baseball-genius@keubo.fan";

async function main() {
  const { data: existing, error: lookupError } = await admin
    .from("profiles")
    .select("id")
    .eq("nickname", NICKNAME)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (existing) {
    console.log(`BASEBALL_GENIUS_USER_ID=${existing.id} (reused)`);
    return;
  }

  const { data: created, error: userError } = await admin.auth.admin.createUser({
    email: EMAIL,
    email_confirm: true,
    password: randomBytes(24).toString("base64url"),
    user_metadata: { role: "baseball_genius" },
  });
  if (userError || !created.user) throw userError ?? new Error("auth user missing");

  const { error: profileError } = await admin.from("profiles").insert({
    id: created.user.id,
    nickname: NICKNAME,
    team_id: 0,
    avatar_url: "/apple-touch-icon.png",
  });
  if (profileError) {
    await admin.auth.admin.deleteUser(created.user.id);
    throw profileError;
  }
  console.log(`BASEBALL_GENIUS_USER_ID=${created.user.id} (created)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
