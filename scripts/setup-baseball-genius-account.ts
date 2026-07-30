// 야잘알봇 고정 DM 시스템 계정 one-off provisioning (idempotent).
// migration과 별개로 auth.users + profiles만 보장하며, 생성된 UUID를 상수에 반영한다.
// lookup은 nickname이 아니라 안정 키(고정 UUID → email)로만 수행한다 —
// 계정명 변경(야구천재 → 야잘알봇)이 새 auth 계정을 만들지 않고 기존 profile을
// rename 하도록 보장한다 (동일 UUID 유지 = 기존 대화 연속성 + 시스템 계정 1개).
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import {
  BASEBALL_GENIUS_NAME,
  BASEBALL_GENIUS_USER_ID,
} from "../src/lib/constants/baseball-genius";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 필요");
  process.exit(1);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const EMAIL = "baseball-genius@keubo.fan";

async function findExistingId(): Promise<string | null> {
  // 1순위: 상수에 고정된 UUID (배포된 시스템 계정의 안정 키)
  const { data: byId, error: idError } = await admin
    .from("profiles")
    .select("id")
    .eq("id", BASEBALL_GENIUS_USER_ID)
    .maybeSingle();
  if (idError) throw idError;
  if (byId) return byId.id;

  // 2순위: 시스템 계정 전용 email (UUID 미확정 환경 대비).
  // setup-urgent-notice-account.ts와 동일 패턴 — perPage 1000 × 최대 30 page로 유한 순회.
  for (let page = 1; page <= 30; page++) {
    // query-guard: bounded-page -- perPage 1000 × 최대 30 page 유한 순회로 시스템 계정 email만 탐색한다.
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    if (!data || data.users.length === 0) return null;
    const hit = data.users.find((candidate) => candidate.email?.toLowerCase() === EMAIL);
    if (hit) return hit.id;
    if (data.users.length < 1000) return null;
  }
  return null;
}

async function main() {
  const existingId = await findExistingId();
  if (existingId) {
    // 계정명 rename은 profile UPDATE로만 수행 — 새 계정을 만들지 않는다.
    const { error: renameError } = await admin
      .from("profiles")
      .upsert(
        { id: existingId, nickname: BASEBALL_GENIUS_NAME, team_id: 0, avatar_url: "/apple-touch-icon.png" },
        { onConflict: "id" },
      );
    if (renameError) throw renameError;
    console.log(`BASEBALL_GENIUS_USER_ID=${existingId} (reused, nickname=${BASEBALL_GENIUS_NAME})`);
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
    nickname: BASEBALL_GENIUS_NAME,
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
