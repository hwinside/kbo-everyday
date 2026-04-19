/**
 * 닉네임 중복 정리 후 사과 쪽지 발송 (일회성)
 * 작성: 삼식이 / 톤: 삼순이 / 승인: 하린아빠
 *
 * 실행 순서:
 *   1. migrations/2026-04-19-nickname-unique.sql 실행 완료 후
 *   2. profile_nickname_changes 테이블에 오늘 자 변경 이력이 기록된 상태에서
 *   3. npx tsx scripts/send-nickname-apology-dm.ts
 *
 * 동작:
 *   - profile_nickname_changes에서 changed_at >= 오늘 0시(UTC)인 row 조회
 *   - 각 user_id에 대해 운영자(SYSTEM_USER_ID)와 dm_conversation 보장
 *   - dm_messages에 사과쪽지 insert + last_message_at 갱신
 *   - 동일 conversation에 이미 같은 메시지가 있으면 skip (재실행 안전)
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { TEAMS } from "../src/lib/constants/teams";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SYSTEM_USER_ID = process.env.SYSTEM_USER_ID!;

if (!SUPABASE_URL || !SERVICE_ROLE || !SYSTEM_USER_ID) {
  console.error("missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SYSTEM_USER_ID");
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

function teamNameById(teamId: number | null): string | null {
  if (!teamId) return null;
  return TEAMS.find((t) => t.id === teamId)?.name ?? null;
}

function buildMessage(newNickname: string, teamId: number | null): string {
  // 삼순이 최종 추천본 — 짧고 덜 방어적 + 마지막 단락에 문의 안내와 응원을 합친 틀
  const teamName = teamNameById(teamId);
  const cheer = teamName
    ? `즐겁게 크보팬 이용하시길 바랍니다. <${teamName}> 가즈아!! ⚾`
    : "즐겁게 크보팬 이용하시길 바랍니다 ⚾";

  return [
    "안녕하세요, 크보팬 운영팀입니다.",
    `닉네임 중복체크 기능 문제로 동일한 닉네임이 중복 생성된 점을 확인했고,\n그에 따라 회원님의 닉네임을 임시로 *${newNickname}*으로 변경했습니다.`,
    "마이페이지에서 원하시는 닉네임으로 직접 변경하실 수 있습니다.\n이용에 불편을 드려 정말 죄송합니다.",
    `문의가 있으시면 이 쪽지에 답장해주세요.\n${cheer}`,
  ].join("\n\n");
}

async function ensureConversation(userId: string): Promise<string> {
  const [u1, u2] = [SYSTEM_USER_ID, userId].sort();
  const existing = await admin
    .from("dm_conversations")
    .select("id")
    .eq("user1_id", u1)
    .eq("user2_id", u2)
    .maybeSingle();

  if (existing.data) return existing.data.id as string;

  const created = await admin
    .from("dm_conversations")
    .insert({ user1_id: u1, user2_id: u2 })
    .select("id")
    .single();
  if (created.error || !created.data) {
    throw new Error(`conv create failed for ${userId}: ${created.error?.message}`);
  }
  return created.data.id as string;
}

async function alreadySentApology(conversationId: string): Promise<boolean> {
  // 동일 conversation에 운영자가 보낸 "닉네임 중복체크 기능 이상" 시작 메시지가 있으면 skip
  const { data } = await admin
    .from("dm_messages")
    .select("id, content")
    .eq("conversation_id", conversationId)
    .eq("sender_id", SYSTEM_USER_ID)
    .like("content", "%닉네임 중복체크 기능 문제%")
    .limit(1);
  return !!(data && data.length > 0);
}

async function main() {
  // 오늘 변경된 닉네임 row 조회 (UTC 기준 오늘)
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const { data: changes, error } = await admin
    .from("profile_nickname_changes")
    .select("user_id, old_nickname, new_nickname, changed_at")
    .gte("changed_at", todayStart.toISOString())
    .order("changed_at", { ascending: true });

  // team_id는 별도로 profiles에서 조회 (changes에는 team_id 없음)
  const userIds = (changes ?? []).map((c) => c.user_id as string);
  const { data: teamRows } = userIds.length
    ? await admin.from("profiles").select("id, team_id").in("id", userIds)
    : { data: [] as { id: string; team_id: number | null }[] };
  const teamByUser = new Map<string, number | null>();
  for (const r of teamRows ?? []) teamByUser.set(r.id as string, (r.team_id as number | null) ?? null);

  if (error) {
    console.error("fetch changes failed:", error);
    process.exit(1);
  }
  if (!changes || changes.length === 0) {
    console.log("no nickname changes today — nothing to send");
    return;
  }

  console.log(`발송 대상: ${changes.length}명`);
  let sent = 0;
  let skipped = 0;

  for (const ch of changes) {
    const userId = ch.user_id as string;
    const newNick = ch.new_nickname as string;
    try {
      const convId = await ensureConversation(userId);
      if (await alreadySentApology(convId)) {
        console.log(`  [skip] ${userId} (이미 발송됨)`);
        skipped++;
        continue;
      }

      const message = buildMessage(newNick, teamByUser.get(userId) ?? null);
      const msg = await admin
        .from("dm_messages")
        .insert({ conversation_id: convId, sender_id: SYSTEM_USER_ID, content: message });
      if (msg.error) {
        console.error(`  [fail] ${userId}: ${msg.error.message}`);
        continue;
      }

      await admin
        .from("dm_conversations")
        .update({
          last_message: message.substring(0, 100),
          last_message_at: new Date().toISOString(),
        })
        .eq("id", convId);

      console.log(`  [sent] ${userId} (${ch.old_nickname} → ${newNick})`);
      sent++;
    } catch (e: any) {
      console.error(`  [error] ${userId}:`, e?.message ?? e);
    }
  }

  console.log(`\n완료: 발송 ${sent}건 / 스킵 ${skipped}건 / 전체 ${changes.length}건`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
