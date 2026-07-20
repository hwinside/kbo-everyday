import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { VENUE_STORY_EXPIRY_HOURS_AFTER_START } from "@/lib/venue-stories/types";

const CRON_SECRET = process.env.CRON_SECRET || "";
const BUCKETS = ["videos", "photos"] as const;
const ORPHAN_MAX_GAME_FOLDERS = 40; // 실행당 orphan 스캔 상한(자기 이어짐)

export const maxDuration = 60;

interface Row {
  id: number;
  media_bucket: string | null;
  media_path: string | null;
  thumb_bucket: string | null;
  thumb_path: string | null;
}

/** 한 행의 storage 오브젝트 제거. 전부 성공 시 true. */
async function removeRowObjects(r: Row): Promise<boolean> {
  const byBucket = new Map<string, string[]>();
  const push = (b?: string | null, p?: string | null) => {
    if (!b || !p) return;
    const arr = byBucket.get(b) ?? [];
    arr.push(p);
    byBucket.set(b, arr);
  };
  push(r.media_bucket, r.media_path);
  push(r.thumb_bucket, r.thumb_path);
  let ok = true;
  for (const [bucket, paths] of byBucket) {
    const { error } = await supabase.storage.from(bucket).remove(paths);
    if (error) ok = false;
  }
  return ok;
}

/**
 * 직관 스토리 정리 cron:
 *  1) 만료·removed·cleanup_failed 행 → storage 먼저 제거 후 행 삭제. storage 실패 시 cleanup_failed 로 남겨 재시도.
 *  2) orphan 스캔: 어떤 행도 참조하지 않는 오래된 venue-stories/ 오브젝트(생성 API 실패 잔여) 제거.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const nowIso = new Date().toISOString();

  // ── 1) 대상 행 정리 ──
  const { data: rows, error } = await supabase
    .from("venue_stories")
    .select("id, media_bucket, media_path, thumb_bucket, thumb_path")
    .or(`expires_at.lte.${nowIso},status.in.(removed,cleanup_failed)`)
    .limit(500);
  if (error) {
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }

  let deleted = 0;
  let retryLater = 0;
  for (const r of (rows ?? []) as Row[]) {
    const ok = await removeRowObjects(r);
    if (ok) {
      const { error: delErr } = await supabase.from("venue_stories").delete().eq("id", r.id);
      if (delErr) {
        retryLater++;
      } else {
        deleted++;
      }
    } else {
      await supabase.from("venue_stories").update({ status: "cleanup_failed" }).eq("id", r.id);
      retryLater++;
    }
  }

  // ── 2) orphan 스캔 (생성 API 실패로 남은 storage 잔여) ──
  // referenced 집합은 전 행 기준. 조회 오류면 orphan 스캔 자체를 건너뛴다(오탐 삭제 방지).
  const { data: allPaths, error: refErr } = await supabase
    .from("venue_stories")
    .select("media_bucket, media_path, thumb_bucket, thumb_path");
  if (refErr) {
    // 정리(1)는 이미 수행됨 — orphan 스캔만 스킵하고 다음 실행에서 재시도
    return NextResponse.json({ deleted, retryLater, orphanRemoved: 0, orphanSkipped: "ref_query_error" });
  }
  const referenced = new Set<string>();
  for (const p of allPaths ?? []) {
    if (p.media_bucket && p.media_path) referenced.add(`${p.media_bucket}:${p.media_path}`);
    if (p.thumb_bucket && p.thumb_path) referenced.add(`${p.thumb_bucket}:${p.thumb_path}`);
  }
  // orphan 은 업로드 직후 실패분이라 넉넉한 버퍼(만료+1일)보다 오래된 것만 정리
  const orphanCutoff = Date.now() - (VENUE_STORY_EXPIRY_HOURS_AFTER_START + 24) * 3600_000;
  let orphanRemoved = 0;

  // bucket 별 독립 예산 + offset 페이지네이션 — 앞 bucket 이 예산을 다 써서 뒤 bucket/폴더가
  // 영구 starvation 되던 문제(공유 scanned 카운터, 첫 40개 고정) 해소(삼순 NO-GO #4).
  for (const bucket of BUCKETS) {
    let scanned = 0; // bucket 마다 리셋
    let offset = 0;
    scanLoop: while (scanned < ORPHAN_MAX_GAME_FOLDERS) {
      const { data: games, error: listErr } = await supabase.storage
        .from(bucket)
        .list("venue-stories", { limit: 100, offset });
      if (listErr || !games || games.length === 0) break;
      offset += games.length;
      for (const gameFolder of games) {
        if (scanned >= ORPHAN_MAX_GAME_FOLDERS) break scanLoop;
        if (gameFolder.id !== null) continue; // 파일이 아니라 폴더만
        scanned++;
        const gamePrefix = `venue-stories/${gameFolder.name}`;
        const { data: users } = await supabase.storage.from(bucket).list(gamePrefix, { limit: 200 });
        for (const userFolder of users ?? []) {
          if (userFolder.id !== null) continue;
          const userPrefix = `${gamePrefix}/${userFolder.name}`;
          const { data: files } = await supabase.storage.from(bucket).list(userPrefix, { limit: 200 });
          const toDelete: string[] = [];
          for (const f of files ?? []) {
            if (f.id === null) continue; // 폴더 skip
            const fullPath = `${userPrefix}/${f.name}`;
            if (referenced.has(`${bucket}:${fullPath}`)) continue;
            const ts = f.created_at ? Date.parse(f.created_at) : 0;
            if (ts && ts > orphanCutoff) continue; // 아직 최근이면 두고 다음 실행에
            toDelete.push(fullPath);
          }
          if (toDelete.length > 0) {
            const { error: rmErr } = await supabase.storage.from(bucket).remove(toDelete);
            if (!rmErr) orphanRemoved += toDelete.length;
          }
        }
      }
      if (games.length < 100) break; // 마지막 페이지
    }
  }

  return NextResponse.json({ deleted, retryLater, orphanRemoved });
}
