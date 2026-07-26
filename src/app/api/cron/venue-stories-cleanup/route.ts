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
import {
  classifyCleanupRow,
  resolveCleanupAction,
  VENUE_STORY_REMOVED_QUARANTINE_DAYS,
} from "@/lib/venue-stories/expiry-policy";

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
  cleanup_failed_at: string | null;
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
 *  1) 대상 행 분기(resolveCleanupAction, 스펙 §2.2):
 *     - archive: 정상 만료(active) 또는 cleanup_failed 정상만료 출신 복구 → storage/댓글 보존, status='archived'+archived_at(다이어리 보관).
 *     - delete: 정상만료 미검증(pending)/격리 30일 경과 removed/cleanup_failed removed출신 → storage 제거 후 행 삭제(실패 시 cleanup_failed).
 *     - force_delete: cleanup_failed removed출신이 영구실패 TTL(cleanup_failed_at+7일) 경과 → storage 성공 무관 행 강제 삭제(무한 재시도 중단).
 *     - quarantine_keep: removed 30일 미만·removed_at 미상 / stale_cap(장애) / cleanup_failed stale출신 / archived → no-op(미노출 격리 및 보관 보호).
 *       ※ stale_cap(active/pending) 은 처리 배치에서 제외하고 별도 count(head)로 staleCap 을 세워 5xx 관제한다.
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
  //  - stale_cap: 종료 미확정인데 안전상한(시작+72h) 도달 = finalize 장애 → 즉시삭제 금지, 격리 + 관제(5xx)
  //  - removed: removed_at 기준 30일 격리 후에만 삭제(오신고/검증실패 복구 여지) / cleanup_failed: storage 재삭제 재시도
  //
  // ⚠️ starvation 방지(삼순 NO-GO blocker 1): 조회(WHERE) 단계에서 "이번 실행에 실제 처리 가능한 행"만 뽑는다.
  //   30일 미만·removed_at 미상 removed 는 이번 실행 no-op(격리 유지)이므로 애초에 SELECT 에서 제외 —
  //   그렇지 않으면 저-id 격리 removed 500건이 limit 을 점유해 뒤의 archive/cleanup_failed/30일경과 removed 가
  //   최대 30일 굶는다. archived 도 제외(보관 완료, 재-archive 금지).
  //   ⚠️ stale_cap 배제(삼순 재리뷰 blocker 1): active/pending·expires_at 경과라도 game_ended_at 이 NULL 이면
  //     stale_cap(finalize 장애 안전상한 도달)이라 quarantine_keep no-op → limit 을 점유해 뒤 후보를 굶긴다.
  //     그래서 `game_ended_at.not.is.null`(종료 확정)만 처리 배치에 넣고, stale_cap 관제는 아래 별도 count(head)로 분리한다.
  //   이 필터 경계 = isCleanupActionable(expiry-policy) 와 동일 SSOT(회귀 qa:venue-cleanup-action 로 고정).
  //     ① active/pending + expires_at ≤ now + game_ended_at 확정  (정상 만료 archive)
  //     ② cleanup_failed                     (출신 분기: archived 복구 / TTL 삭제 / 격리)
  //     ③ removed + removed_at ≤ now-30d      (격리 만료 delete; null/30일미만은 lte 불일치로 자동 제외)
  // id 오름차순 정렬로 결정적 배치 — 오래된 후보부터 처리해 장기 backlog starvation 방지(삼순 #868).
  const quarantineCutoffIso = new Date(
    nowMs - VENUE_STORY_REMOVED_QUARANTINE_DAYS * 86400_000,
  ).toISOString();
  // query-guard: bounded -- cleanup 배치는 실행당 최대 500행만 처리하고 남은 행은 다음 cron 이 이어서 정리(orphan cursor 와 동일 계약)
  const { data: rows, error } = await supabase
    .from("venue_stories")
    .select("id, status, game_ended_at, expires_at, removed_at, cleanup_failed_at, media_bucket, media_path, thumb_bucket, thumb_path")
    .or(
      `and(status.in.(active,pending),expires_at.lte.${nowIso},game_ended_at.not.is.null),status.eq.cleanup_failed,and(status.eq.removed,removed_at.lte.${quarantineCutoffIso})`,
    )
    .order("id", { ascending: true })
    .limit(500);
  if (error) {
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }

  let deleted = 0;
  let archived = 0; // 정상 만료 → 보관 전환(다이어리)
  let retryLater = 0;
  let staleCap = 0; // finalize 장애 신호(안전상한 도달 격리) — 0 이 아니면 관제(5xx)
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
      gameEndedAtMs: r.game_ended_at ? Date.parse(r.game_ended_at) : null,
      cleanupFailedAtMs: r.cleanup_failed_at ? Date.parse(r.cleanup_failed_at) : null,
      nowMs,
    });
    // stale_cap 관제는 배치와 분리(아래 별도 count) — stale_cap active/pending 는 이제 조회에서 제외되어 여기 오지 않는다.
    if (action === "quarantine_keep") continue; // removed 30일 미만 / cleanup_failed stale출신 / archived — 미노출 격리 유지, 삭제 안 함
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
    if (action === "force_delete") {
      // 영구실패 TTL(cleanup_failed_at+7일) 경과: storage remove 를 시도하되 성공 여부와 무관하게 행을 삭제해
      // 무한 재시도를 끊는다. 잔여 오브젝트는 orphan 스캔이 후속 정리(blocker 2).
      await removeRowObjects(r); // best-effort
      const { error: delErr } = await supabase.from("venue_stories").delete().eq("id", r.id);
      if (delErr) {
        retryLater++;
        faults++;
      } else {
        deleted++;
      }
      continue;
    }
    // action === "delete"(정상만료 미검증 pending / 격리 30일 경과 removed / cleanup_failed removed출신 TTL미경과 재시도)
    //   — storage 먼저 제거 후 행 삭제. 실패 시 cleanup_failed 로 남겨 다음 실행이 재시도(영구삭제 금지).
    const ok = await removeRowObjects(r);
    if (ok) {
      const { error: delErr } = await supabase.from("venue_stories").delete().eq("id", r.id);
      if (delErr) {
        retryLater++;
        faults++;
      } else {
        deleted++;
      }
    } else {
      // storage remove 실패 → cleanup_failed 로 남겨 다음 실행 재시도. 최초 전이 시에만 cleanup_failed_at 기록(영구실패 TTL 시계 시작, 이미 있으면 유지).
      const upd: { status: string; cleanup_failed_at?: string } = { status: "cleanup_failed" };
      if (r.status !== "cleanup_failed") upd.cleanup_failed_at = nowIso;
      const { error: updErr } = await supabase
        .from("venue_stories")
        .update(upd)
        .eq("id", r.id);
      retryLater++;
      faults++; // storage remove 실패(+ 상태갱신 실패 가능)
      if (updErr) { /* 상태갱신까지 실패 — 다음 실행 재시도 */ }
    }
  }

  // ── stale_cap 관제(처리 배치와 분리, 삼순 blocker 1) ──
  // stale_cap(active/pending·game_ended_at 미확정·expires_at 경과 = finalize 장애 안전상한 도달)은
  // quarantine_keep(no-op)이라 처리 배치에서 제외했다. 존재 자체는 별도 bounded count(head:true, 행 미조회)로
  // 세어 5xx 관제만 유지한다 — 삭제/전이는 하지 않는다.
  // query-guard: bounded -- head:true count 전용(행 미조회), stale_cap 관제 신호 유지용
  const { count: staleCapCount, error: staleCapErr } = await supabase
    .from("venue_stories")
    .select("id", { count: "exact", head: true })
    .in("status", ["active", "pending"])
    .is("game_ended_at", null)
    .lte("expires_at", nowIso);
  if (staleCapErr) {
    faults++; // 관제 카운트 조회 실패도 fault(5xx)
  } else {
    staleCap = staleCapCount ?? 0;
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
      { deleted, archived, retryLater, staleCap, orphanRemoved: 0, orphanSkipped: "ref_query_error" },
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

  if (faults > 0 || staleCap > 0) {
    // staleCap > 0 = finalize 장애 신호(안전상한 도달) — 즉시삭제는 하지 않고 격리하되 관제를 위해 5xx
    return NextResponse.json(
      { deleted, archived, retryLater, staleCap, orphanRemoved, faults },
      { status: 500 },
    );
  }
  return NextResponse.json({ deleted, archived, retryLater, staleCap, orphanRemoved });
}
