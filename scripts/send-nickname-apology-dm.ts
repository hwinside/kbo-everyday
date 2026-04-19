/**
 * 닉네임 중복 정리 후 사과 쪽지 발송 (일회성, 화이트리스트 방식)
 * 작성: 삼식이 / 톤: 삼순이 / 승인: 하린아빠
 *
 * ⚠️ 2026-04-19 사고 학습:
 *   초기 버전은 'profile_nickname_changes에서 오늘 자 변경분 전부' 필터를 써서
 *   자발적 닉네임 변경 유저까지 같이 발송됨 (2명 오발송 → 정정 사과로 복구)
 *   → 이후 명시적 user_id 화이트리스트만 받도록 강제
 *
 * 실행:
 *   USER_IDS="uuid1,uuid2,..." npx tsx scripts/send-nickname-apology-dm.ts
 *
 * 동작:
 *   - USER_IDS env로 받은 user_id 화이트리스트만 발송 대상
 *   - 각 user의 현재 nickname + team_id를 profiles에서 join
 *   - 운영자(SYSTEM_USER_ID)와 dm_conversation 보장
 *   - dm_messages insert + last_message_at 갱신
 *   - 동일 conversation에 이미 같은 사과 메시지가 있으면 skip (재실행 안전)
 */

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
  // ⚠️ 화이트리스트 강제 — USER_IDS env 없으면 즉시 abort
  const rawIds = (process.env.USER_IDS ?? "").trim();
  if (!rawIds) {
    console.error('USER_IDS env required, e.g. USER_IDS="uuid1,uuid2" npx tsx ...');
    process.exit(1);
  }
  const userIds = rawIds.split(",").map((s) => s.trim()).filter(Boolean);
  if (userIds.length === 0) {
    console.error("USER_IDS parsed to empty list");
    process.exit(1);
  }

  // 화이트리스트 user들의 현재 nickname + team_id 조회
  const { data: profiles, error } = await admin
    .from("profiles")
    .select("id, nickname, team_id")
    .in("id", userIds);

  if (error) {
    console.error("fetch profiles failed:", error);
    process.exit(1);
  }
  if (!profiles || profiles.length === 0) {
    console.log("no matching profiles — nothing to send");
    return;
  }

  // 누락된 id 경고
  const fetchedIds = new Set(profiles.map((p) => p.id as string));
  for (const id of userIds) {
    if (!fetchedIds.has(id)) console.warn(`  [warn] user ${id} not found in profiles — skipped`);
  }

  console.log(`발송 대상: ${profiles.length}명 (화이트리스트 ${userIds.length}명 중)`);
  let sent = 0;
  let skipped = 0;

  for (const p of profiles) {
    const userId = p.id as string;
    const newNick = p.nickname as string;
    const teamId = (p.team_id as number | null) ?? null;
    try {
      const convId = await ensureConversation(userId);
      if (await alreadySentApology(convId)) {
        console.log(`  [skip] ${userId} (이미 발송됨)`);
        skipped++;
        continue;
      }

      const message = buildMessage(newNick, teamId);
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

      console.log(`  [sent] ${userId} (현재닉: ${newNick})`);
      sent++;
    } catch (e: any) {
      console.error(`  [error] ${userId}:`, e?.message ?? e);
    }
  }

  console.log(`\n완료: 발송 ${sent}건 / 스킵 ${skipped}건 / 매칭 ${profiles.length}건`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
