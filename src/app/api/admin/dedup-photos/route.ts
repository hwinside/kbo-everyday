import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { isAdminRequest } from "@/lib/admin/pin";

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

  return NextResponse.json({
    deleted: idsToDelete.length,
    groups: duplicates.length,
    deletedIds: idsToDelete,
  });
}
