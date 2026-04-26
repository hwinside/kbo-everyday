import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { isAdminRequest } from "@/lib/admin/pin";

const DEDUP_MESSAGE = "중복 사진 게시물로 확인되어 삭제되었어요. 자세한 문의는 크보팬 운영팀에 남겨 주세요.";

async function sendSystemDM(userId: string) {
  const systemUserId = process.env.SYSTEM_USER_ID;
  if (!systemUserId) return;

  const [u1, u2] = [systemUserId, userId].sort();

  // 기존 conversation 찾거나 생성
  const { data: existing } = await supabase
    .from("dm_conversations")
    .select("id")
    .eq("user1_id", u1)
    .eq("user2_id", u2)
    .maybeSingle();

  let conversationId: string;
  if (existing) {
    conversationId = existing.id;
  } else {
    const { data: newConv } = await supabase
      .from("dm_conversations")
      .insert({ user1_id: u1, user2_id: u2 })
      .select("id")
      .single();
    if (!newConv) return;
    conversationId = newConv.id;
  }

  await supabase.from("dm_messages").insert({
    conversation_id: conversationId,
    sender_id: systemUserId,
    content: DEDUP_MESSAGE,
  });

  await supabase.from("dm_conversations").update({
    last_message: DEDUP_MESSAGE.substring(0, 100),
    last_message_at: new Date().toISOString(),
  }).eq("id", conversationId);
}

/**
 * GET  — 24시간 내 같은 유저가 같은 이미지 해시로 올린 중복 게시물 조회 (dry-run)
 * POST — 중복 게시물 삭제 (가장 먼저 올린 글만 유지)
 */

interface DuplicateGroup {
  author_id: string;
  hash: string;
  posts: { id: number; created_at: string }[];
  keep: number;
  delete: number[];
}

async function findDuplicates(): Promise<DuplicateGroup[]> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: posts, error } = await supabase
    .from("posts")
    .select("id, author_id, image_hashes, created_at")
    .eq("content_type", "photo")
    .gte("created_at", since)
    .not("image_hashes", "eq", "[]")
    .order("created_at", { ascending: true });

  if (error || !posts) return [];

  // 유저별 해시 → 게시물 매핑
  const map = new Map<string, { id: number; created_at: string }[]>();

  for (const post of posts) {
    const hashes = (post.image_hashes as string[]) || [];
    for (const hash of hashes) {
      const key = `${post.author_id}:${hash}`;
      const list = map.get(key) || [];
      list.push({ id: post.id, created_at: post.created_at });
      map.set(key, list);
    }
  }

  const duplicates: DuplicateGroup[] = [];
  for (const [key, items] of map.entries()) {
    if (items.length < 2) continue;
    const [authorId, hash] = key.split(":", 2);
    const sorted = items.sort((a, b) => a.created_at.localeCompare(b.created_at));
    duplicates.push({
      author_id: authorId,
      hash,
      posts: sorted,
      keep: sorted[0].id,
      delete: sorted.slice(1).map((p) => p.id),
    });
  }

  return duplicates;
}

export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const duplicates = await findDuplicates();
  const deleteCount = duplicates.reduce((sum, g) => sum + g.delete.length, 0);

  return NextResponse.json({
    duplicateGroups: duplicates.length,
    postsToDelete: deleteCount,
    groups: duplicates,
  });
}

export async function POST(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const duplicates = await findDuplicates();
  const idsToDelete = duplicates.flatMap((g) => g.delete);

  if (idsToDelete.length === 0) {
    return NextResponse.json({ deleted: 0, message: "중복 게시물 없음" });
  }

  const { error } = await supabase
    .from("posts")
    .delete()
    .in("id", idsToDelete);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // 작성자별 쪽지 발송 (중복 제거)
  const authorIds = [...new Set(duplicates.map((g) => g.author_id))];
  const dmResults = await Promise.allSettled(
    authorIds.map((authorId) => sendSystemDM(authorId))
  );
  const dmSent = dmResults.filter((r) => r.status === "fulfilled").length;

  return NextResponse.json({
    deleted: idsToDelete.length,
    groups: duplicates.length,
    deletedIds: idsToDelete,
    dmSent,
  });
}
