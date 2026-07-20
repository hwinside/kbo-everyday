import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { VENUE_STORY_EXPIRY_HOURS_AFTER_START } from "@/lib/venue-stories/types";

const CRON_SECRET = process.env.CRON_SECRET || "";
const BUCKETS = ["videos", "photos"] as const;
const ORPHAN_MAX_GAME_FOLDERS = 40; // 실행당 bucket별 orphan 스캔 상한(durable cursor 로 이어짐)
const STORAGE_PAGE = 100; // storage list 페이지 크기

export const maxDuration = 60;

/** 한 prefix 의 전 항목을 페이지네이션으로 전부 수집(fault 시 null). */
async function listAll(
  bucket: string,
  prefix: string,
): Promise<{ name: string; id: string | null; created_at?: string }[] | null> {
  const acc: { name: string; id: string | null; created_at?: string }[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase.storage
      .from(bucket)
      .list(prefix, { limit: STORAGE_PAGE, offset, sortBy: { column: "name", order: "asc" } });
    if (error) return null; // fault 를 빈 목록으로 삼키지 않음
    if (!data || data.length === 0) break;
    acc.push(...(data as typeof acc));
    offset += data.length;
    if (data.length < STORAGE_PAGE) break;
  }
  return acc;
}

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
  // referenced 집합은 전 행 기준 — 전량 페이지네이션. 조회 오류면 orphan 스캔 자체를 건너뛴다(오탐 삭제 방지).
  const referenced = new Set<string>();
  {
    const PAGE = 1000;
    let from = 0;
    for (;;) {
      const { data: allPaths, error: refErr } = await supabase
        .from("venue_stories")
        .select("media_bucket, media_path, thumb_bucket, thumb_path")
        .range(from, from + PAGE - 1);
      if (refErr) {
        // 정리(1)는 이미 수행됨 — orphan 스캔만 스킵하고 다음 실행에서 재시도
        return NextResponse.json({ deleted, retryLater, orphanRemoved: 0, orphanSkipped: "ref_query_error" });
      }
      for (const p of allPaths ?? []) {
        if (p.media_bucket && p.media_path) referenced.add(`${p.media_bucket}:${p.media_path}`);
        if (p.thumb_bucket && p.thumb_path) referenced.add(`${p.thumb_bucket}:${p.thumb_path}`);
      }
      if (!allPaths || allPaths.length < PAGE) break;
      from += PAGE;
    }
  }
  // orphan 은 업로드 직후 실패분이라 넉넉한 버퍼(만료+1일)보다 오래된 것만 정리
  const orphanCutoff = Date.now() - (VENUE_STORY_EXPIRY_HOURS_AFTER_START + 24) * 3600_000;
  let orphanRemoved = 0;

  // bucket 별 durable cursor — 실행마다 이전 위치(after_name) 이후부터 이어서 스캔.
  // offset=0 고정으로 41번째 이후 폴더가 영구 starvation 되던 문제(삼순 NO-GO #2) 해소.
  for (const bucket of BUCKETS) {
    const { data: cur } = await supabase
      .from("venue_cleanup_cursor")
      .select("after_name")
      .eq("bucket", bucket)
      .maybeSingle();
    const afterName: string | null = (cur?.after_name as string) ?? null;

    // 이름 정렬로 전체 game 폴더를 페이지네이션하며 cursor 이후만 스캔
    let scanned = 0;
    let offset = 0;
    let lastScannedName: string | null = null;
    let reachedEnd = true;
    scanLoop: for (;;) {
      const { data: games, error: listErr } = await supabase.storage
        .from(bucket)
        .list("venue-stories", { limit: STORAGE_PAGE, offset, sortBy: { column: "name", order: "asc" } });
      if (listErr) { reachedEnd = false; break; } // fault: cursor 미전진(다음 실행 재시도)
      if (!games || games.length === 0) break;
      offset += games.length;
      for (const gameFolder of games) {
        if (gameFolder.id !== null) continue; // 폴더만
        if (afterName != null && gameFolder.name <= afterName) continue; // cursor 이전은 skip
        if (scanned >= ORPHAN_MAX_GAME_FOLDERS) { reachedEnd = false; break scanLoop; }
        scanned++;
        lastScannedName = gameFolder.name;
        const gamePrefix = `venue-stories/${gameFolder.name}`;
        const users = await listAll(bucket, gamePrefix);
        if (users == null) continue; // fault: 이 폴더 skip(cursor 는 전진해도 다음 회차가 orphan 다시 봄)
        for (const userFolder of users) {
          if (userFolder.id !== null) continue;
          const userPrefix = `${gamePrefix}/${userFolder.name}`;
          const files = await listAll(bucket, userPrefix);
          if (files == null) continue;
          const toDelete: string[] = [];
          for (const f of files) {
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
      if (games.length < STORAGE_PAGE) break; // 마지막 페이지
    }

    // cursor 갱신: 이번에 스캔한 마지막 폴더명으로 전진. 전 구간 도달했으면 리셋(다음 회차 처음부터).
    const nextAfter = reachedEnd ? null : lastScannedName;
    if (lastScannedName != null || reachedEnd) {
      await supabase
        .from("venue_cleanup_cursor")
        .upsert({ bucket, after_name: nextAfter, updated_at: new Date().toISOString() });
    }
  }

  return NextResponse.json({ deleted, retryLater, orphanRemoved });
}
