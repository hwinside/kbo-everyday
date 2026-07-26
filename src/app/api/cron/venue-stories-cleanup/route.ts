import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import {
  VENUE_STORY_SAFETY_CAP_HOURS_AFTER_START,
  VENUE_STORY_STAGING_BUCKET,
} from "@/lib/venue-stories/types";
import {
  shouldDeleteOrphanFile,
  collectReferencedPaths,
  type RefPageRow,
} from "@/lib/venue-stories/cleanup-policy";
import { classifyCleanupRow, resolveCleanupAction } from "@/lib/venue-stories/expiry-policy";

const CRON_SECRET = process.env.CRON_SECRET || "";
// staging 버킷도 orphan 스캔 대상(생성 API 도달 전 이탈한 업로드 잔여 정리)
const BUCKETS = ["videos", "photos", VENUE_STORY_STAGING_BUCKET] as const;
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
  status: string;
  game_ended_at: string | null;
  expires_at: string | null;
  removed_at: string | null;
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
 *  1) 대상 행 분기(resolveCleanupAction):
 *     - archive: 정상 만료(active) → storage/댓글 보존, status='archived'+archived_at(다이어리 보관).
 *     - delete: stale_cap/cleanup_failed/removed(30일 경과·레거시) → storage 먼저 제거 후 행 삭제(실패 시 cleanup_failed 재시도).
 *     - quarantine_keep: removed 30일 미만 / archived → no-op(미노출 격리 및 보관 보호).
 *  2) orphan 스캔: 어떤 행도 참조하지 않는 오래된 venue-stories/ 오브젝트(생성 API 실패 잔여) 제거.
 *     참조 집합은 status 필터 없이 전 행에서 수집하므로 archived 행의 storage 도 참조로 보호된다(orphan 오삭제 없음).
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // ── 1) 대상 행 정리 ──
  // 만료 계약(삼순 09:44 #2): terminal(game_ended_at 확정) 전에는 expiry 삭제 금지.
  //  - expired_after_end(active): 종료 확정 + 종료+24h 경과 → 보관 전환(archive, 다이어리)
  //  - expired_after_end(pending 등 미검증): 누수 방지 삭제(기존 동작)
  //  - stale_cap: 종료 미확정인데 안전상한(시작+72h) 도달 = finalize 장애 → 누수 방지 삭제 + 관제(5xx)
  //  - removed: removed_at 기준 30일 격리 후 삭제(오신고 복구 여지) / cleanup_failed: storage 삭제 재시도
  // 만료 branch 는 active/pending 만 대상 — archived(보관 완료)는 expires_at 이 과거라도
  // 재처리하지 않도록 제외한다(archived 누적 시 limit 500 starvation·재-archive 방지).
  // id 오름차순 정렬로 결정적 배치 — 오래된 후보부터 처리해 장기 backlog starvation 방지(삼순 #868).
  // query-guard: bounded -- cleanup 배치는 실행당 최대 500행만 처리하고 남은 행은 다음 cron 이 이어서 정리(orphan cursor 와 동일 계약)
  const { data: rows, error } = await supabase
    .from("venue_stories")
    .select("id, status, game_ended_at, expires_at, removed_at, media_bucket, media_path, thumb_bucket, thumb_path")
    .or(`and(expires_at.lte.${nowIso},status.in.(active,pending)),status.in.(removed,cleanup_failed)`)
    .order("id", { ascending: true })
    .limit(500);
  if (error) {
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }

  let deleted = 0;
  let archived = 0; // 정상 만료 → 보관 전환(다이어리)
  let retryLater = 0;
  let staleCapDeleted = 0; // finalize 장애 신호 — 0 이 아니면 관제(5xx)
  let faults = 0; // storage/delete/update 오류 — 있으면 최종 5xx 로 관제
  for (const r of (rows ?? []) as Row[]) {
    const cls = classifyCleanupRow({
      status: r.status,
      gameEndedAt: r.game_ended_at,
      expiresAtMs: r.expires_at ? Date.parse(r.expires_at) : null,
      nowMs,
    });
    if (cls === "keep") continue; // terminal 전 — 삭제 금지
    const action = resolveCleanupAction({
      cls,
      status: r.status,
      removedAtMs: r.removed_at ? Date.parse(r.removed_at) : null,
      nowMs,
    });
    if (action === "quarantine_keep") continue; // removed 30일 미만 격리 — 미노출 유지, 삭제 안 함
    if (action === "archive") {
      // 보관 전환: storage 원본/댓글(FK CASCADE) 보존, 행만 status='archived' + archived_at.
      // 공개면은 status='active' 만 노출하므로 archived 는 자동 비공개(=하루 뒤 종료 유지).
      const { error: updErr } = await supabase
        .from("venue_stories")
        .update({ status: "archived", archived_at: nowIso })
        .eq("id", r.id)
        .eq("status", r.status); // CAS — 동시 removed/삭제 전이와 경합 방지
      if (updErr) {
        retryLater++;
        faults++; // 상태갱신 실패 — 다음 실행 재시도 + 관제
      } else {
        archived++;
      }
      continue;
    }
    // action === "delete" — storage 먼저 제거 후 행 삭제(기존 동작).
    const ok = await removeRowObjects(r);
    if (ok) {
      const { error: delErr } = await supabase.from("venue_stories").delete().eq("id", r.id);
      if (delErr) {
        retryLater++;
        faults++;
      } else {
        deleted++;
        if (cls === "stale_cap") staleCapDeleted++;
      }
    } else {
      const { error: updErr } = await supabase
        .from("venue_stories")
        .update({ status: "cleanup_failed" })
        .eq("id", r.id);
      retryLater++;
      faults++; // storage remove 실패(+ 상태갱신 실패 가능)
      if (updErr) { /* 상태갱신까지 실패 — 다음 실행 재시도 */ }
    }
  }

  // ── 2) orphan 스캔 (생성 API 실패로 남은 storage 잔여) ──
  // referenced 집합은 전 행 기준 — **keyset pagination**(id 오름차순, id > lastId).
  // offset(.range) 방식은 동시 insert/update 시 참조행 누락 → orphan 오삭제 위험(삼순 09:44 #3).
  // 조회 오류면 orphan 스캔 자체를 건너뛴다(오탐 삭제 방지).
  const referenced = await collectReferencedPaths(async (afterId, limit) => {
    const { data: page, error: refErr } = await supabase
      .from("venue_stories")
      .select("id, media_bucket, media_path, thumb_bucket, thumb_path")
      .gt("id", afterId)
      .order("id", { ascending: true })
      .limit(limit);
    if (refErr) return null;
    return (page ?? []) as RefPageRow[];
  }, 1000);
  if (referenced == null) {
    // 참조 집합을 완전히 못 만들면 orphan 삭제는 위험(오탐) — 스캔 중단+5xx 관제
    return NextResponse.json(
      { deleted, archived, retryLater, staleCapDeleted, orphanRemoved: 0, orphanSkipped: "ref_query_error" },
      { status: 500 },
    );
  }
  // orphan 은 업로드 직후 실패분이라 넉넉한 버퍼(안전상한+1일)보다 오래된 것만 정리
  const orphanCutoff = nowMs - (VENUE_STORY_SAFETY_CAP_HOURS_AFTER_START + 24) * 3600_000;
  let orphanRemoved = 0;

  // bucket 별 durable cursor — 실행마다 이전 위치(after_name) 이후부터 이어서 스캔.
  // offset=0 고정으로 41번째 이후 폴더가 영구 starvation 되던 문제(삼순 NO-GO #2) 해소.
  for (const bucket of BUCKETS) {
    const { data: cur, error: curReadErr } = await supabase
      .from("venue_cleanup_cursor")
      .select("after_name")
      .eq("bucket", bucket)
      .maybeSingle();
    if (curReadErr) {
      // cursor 조회 fault → afterName 미상이라 처음부터 재스캔 위험 → 즉시 스킵+5xx, 기존 cursor 불변 유지
      return NextResponse.json(
        { deleted, archived, retryLater, orphanRemoved, faults: faults + 1, orphanSkipped: "cursor_read_error" },
        { status: 500 },
      );
    }
    const afterName: string | null = (cur?.after_name as string) ?? null;

    // 이름 정렬로 전체 game 폴더를 페이지네이션하며 cursor 이후만 스캔
    // cursor 는 **fault 없이 완전히 처리된 마지막 폴더**(lastCompletedName)로만 전진한다.
    // list/remove fault 는 cursor 를 실패 지점 이전에 유지하고 5xx 로 관제(삼순 NO-GO #2).
    let scanned = 0;
    let offset = 0;
    let lastCompletedName: string | null = null; // fault 없이 끝난 폴더만
    let reachedEnd = true;
    let bucketFault = false;
    scanLoop: for (;;) {
      const { data: games, error: listErr } = await supabase.storage
        .from(bucket)
        .list("venue-stories", { limit: STORAGE_PAGE, offset, sortBy: { column: "name", order: "asc" } });
      if (listErr) { reachedEnd = false; bucketFault = true; break; } // fault: cursor 미전진
      if (!games || games.length === 0) break;
      offset += games.length;
      for (const gameFolder of games) {
        if (gameFolder.id !== null) continue; // 폴더만
        if (afterName != null && gameFolder.name <= afterName) continue; // cursor 이전은 skip
        if (scanned >= ORPHAN_MAX_GAME_FOLDERS) { reachedEnd = false; break scanLoop; }
        scanned++;
        const gamePrefix = `venue-stories/${gameFolder.name}`;
        const users = await listAll(bucket, gamePrefix);
        if (users == null) { reachedEnd = false; bucketFault = true; break scanLoop; } // fault: cursor 미전진
        let folderFault = false;
        for (const userFolder of users) {
          if (userFolder.id !== null) continue;
          const userPrefix = `${gamePrefix}/${userFolder.name}`;
          const files = await listAll(bucket, userPrefix);
          if (files == null) { folderFault = true; break; } // fault: 이 폴더 미완료
          const toDelete: string[] = [];
          for (const f of files) {
            const fullPath = `${userPrefix}/${f.name}`;
            if (
              shouldDeleteOrphanFile({
                isFolder: f.id === null,
                isReferenced: referenced.has(`${bucket}:${fullPath}`),
                createdAt: f.created_at,
                cutoffMs: orphanCutoff,
              })
            ) {
              toDelete.push(fullPath);
            }
          }
          if (toDelete.length > 0) {
            const { error: rmErr } = await supabase.storage.from(bucket).remove(toDelete);
            if (rmErr) { folderFault = true; break; } // remove fault → 이 폴더 미완료
            orphanRemoved += toDelete.length;
          }
        }
        if (folderFault) { reachedEnd = false; bucketFault = true; break scanLoop; } // cursor 미전진
        lastCompletedName = gameFolder.name; // 이 폴더는 fault 없이 완전 완료
      }
      if (games.length < STORAGE_PAGE) break; // 마지막 페이지
    }

    // cursor 갱신: 완전 처리된 마지막 폴더명으로만 전진. 전 구간 도달했으면 리셋(null).
    const nextAfter = reachedEnd ? null : lastCompletedName;
    if (lastCompletedName != null || reachedEnd) {
      const { error: curErr } = await supabase
        .from("venue_cleanup_cursor")
        .upsert({ bucket, after_name: nextAfter, updated_at: new Date().toISOString() });
      if (curErr) faults++; // cursor 저장 실패도 관제
    }
    if (bucketFault) faults++;
  }

  if (faults > 0 || staleCapDeleted > 0) {
    // staleCapDeleted > 0 = finalize 장애 신호(안전상한 도달) — 삭제는 수행했지만 관제를 위해 5xx
    return NextResponse.json(
      { deleted, archived, retryLater, staleCapDeleted, orphanRemoved, faults },
      { status: 500 },
    );
  }
  return NextResponse.json({ deleted, archived, retryLater, staleCapDeleted, orphanRemoved });
}
