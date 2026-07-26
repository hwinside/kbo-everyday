// 직관 다이어리 보관(archive) 이동 상태머신 — DI 가능한 단위(삼순 재리뷰 Blocker 2).
//
// route.ts 는 supabase storage/db 를 이 포트(ArchiveDeps)로 주입하고, 회귀 스모크는 in-memory mock
// storage/db 로 실패행렬을 **실제 실행**해 상태 전이·부작용을 assert 한다(문자열 등장 순서 검사 대체).
//
// 계약(스펙 §2.1):
//   active:   ① byte 검증 copy → ② CAS active→archiving(+archive_verified_at). CAS 0행이면 원본/DB 불변.
//   archiving:③ (finalize 직전) private 사본 존재 재검증 → ④ public remove → ⑤ CAS archiving→archived + bucket 전환.
// 어느 단계 실패도 archiving 으로 남아 다음 cron 이 재개하므로 공개 원본이 방치되거나 데이터가 유실되지 않는다.

import { VENUE_STORY_ARCHIVE_BUCKET } from "./types";

/** 상태머신이 다루는 행의 최소 필드. */
export interface ArchiveRow {
  id: number;
  status: string;
  archive_verified_at: string | null;
  media_bucket: string | null;
  media_path: string | null;
  thumb_bucket: string | null;
  thumb_path: string | null;
}

/** storage 포트(원본 videos/photos ↔ private venue-archive). */
export interface ArchiveStorageDeps {
  /** 정확 key 저장 byte 수. 미존재/미상은 null(fail-closed). */
  objectSize(bucket: string, path: string): Promise<number | null>;
  /** 원본 버킷의 같은 key 를 venue-archive 로 copy(멱등). */
  copyToArchive(sourceBucket: string, path: string): Promise<void>;
  /** venue-archive 의 불완전 사본 제거(교체용). 실패 시 false. */
  removeArchive(path: string): Promise<boolean>;
  /** 공개 버킷(videos/photos) 원본 제거. 전부 성공 시 true. */
  removePublic(items: { bucket: "videos" | "photos"; path: string }[]): Promise<boolean>;
}

/** db 포트(CAS 전이). error=true 는 쿼리 오류(fault, 5xx 관제), claimed/ok=false 는 0행(정상 경합). */
export interface ArchiveDbDeps {
  /** CAS active→archiving (+archive_verified_at 기록). */
  claimArchiving(id: number): Promise<{ claimed: boolean; error: boolean }>;
  /** CAS: archive_verified_at 이 null 인 archiving 행에만 검증 시각 기록(legacy 재검증 증거). */
  markVerified(id: number): Promise<{ ok: boolean; error: boolean }>;
  /** CAS archiving→archived (+bucket 을 venue-archive 로 전환). */
  finalize(
    id: number,
    mediaBucket: string | null,
    thumbBucket: string | null,
  ): Promise<{ ok: boolean; error: boolean }>;
}

export type ArchiveDeps = ArchiveStorageDeps & ArchiveDbDeps;

export type ArchiveOutcome = "archived" | "retry";
export interface ArchiveStepResult {
  outcome: ArchiveOutcome;
  /** fault=true 면 route 가 faults++(5xx 관제). 정상 경합(CAS 0행)은 fault=false. */
  fault: boolean;
}

const retry = (fault: boolean): ArchiveStepResult => ({ outcome: "retry", fault });

/**
 * 원본→venue-archive 같은 key copy 후 byte 일치 검증(멱등). 원본/사본 byte 가 정확히 같을 때만 성공.
 * 같은 key 의 불완전/다른 byte 사본은 remove 후 재copy 로 교체한다(active→archiving CAS 전에만 호출).
 */
async function copyAndVerify(
  s: ArchiveStorageDeps,
  sourceBucket: string,
  path: string,
): Promise<boolean> {
  if (sourceBucket === VENUE_STORY_ARCHIVE_BUCKET) return false;
  const sourceSize = await s.objectSize(sourceBucket, path);
  if (sourceSize == null) return false;
  await s.copyToArchive(sourceBucket, path);
  let archiveSize = await s.objectSize(VENUE_STORY_ARCHIVE_BUCKET, path);
  if (archiveSize != null && archiveSize === sourceSize) return true;
  // 불완전/다른 byte 사본 교체.
  if (archiveSize != null) {
    if (!(await s.removeArchive(path))) return false;
  }
  await s.copyToArchive(sourceBucket, path);
  archiveSize = await s.objectSize(VENUE_STORY_ARCHIVE_BUCKET, path);
  return archiveSize != null && archiveSize === sourceSize;
}

/**
 * finalize 직전 재검증(삼순 Blocker 1 수정 B): private 사본이 이미 존재하면 성공(원본이 이전 부분실행에서
 * 이미 제거됐을 수 있으므로 원본 부재를 실패로 보지 않는다). 사본이 없으면(orphan 삭제 등) 원본에서 재copy·byte 검증.
 * 원본마저 없으면 false → finalize 하지 않고 다음 실행 재시도(유실 방지). archive_verified_at 을 맹신하지 않는다.
 */
async function ensureArchivePresent(
  s: ArchiveStorageDeps,
  sourceBucket: string,
  path: string,
): Promise<boolean> {
  const existing = await s.objectSize(VENUE_STORY_ARCHIVE_BUCKET, path);
  if (existing != null) return true;
  return copyAndVerify(s, sourceBucket, path);
}

/** 행의 media/thumb 를 venue-archive 로 copy·검증(active 단계). 존재 객체 전부 성공 시 true. */
async function copyRow(s: ArchiveStorageDeps, r: ArchiveRow): Promise<boolean> {
  if (r.media_bucket && r.media_path) {
    if (!(await copyAndVerify(s, r.media_bucket, r.media_path))) return false;
  }
  if (r.thumb_bucket && r.thumb_path) {
    if (!(await copyAndVerify(s, r.thumb_bucket, r.thumb_path))) return false;
  }
  return true;
}

/** 행의 media/thumb private 사본을 finalize 직전 재검증(존재하면 OK, 없으면 재copy). 전부 확보 시 true. */
async function ensureRowArchivePresent(s: ArchiveStorageDeps, r: ArchiveRow): Promise<boolean> {
  if (r.media_bucket && r.media_path) {
    if (!(await ensureArchivePresent(s, r.media_bucket, r.media_path))) return false;
  }
  if (r.thumb_bucket && r.thumb_path) {
    if (!(await ensureArchivePresent(s, r.thumb_bucket, r.thumb_path))) return false;
  }
  return true;
}

/** archive 전환 중 제거할 공개(videos/photos) 원본만 수집. private 사본은 절대 포함하지 않는다. */
function collectPublicItems(r: ArchiveRow): { bucket: "videos" | "photos"; path: string }[] {
  const items: { bucket: "videos" | "photos"; path: string }[] = [];
  const push = (b: string | null, p: string | null) => {
    if ((b === "videos" || b === "photos") && p) items.push({ bucket: b, path: p });
  };
  push(r.media_bucket, r.media_path);
  push(r.thumb_bucket, r.thumb_path);
  return items;
}

/**
 * 한 행을 archive(보관 이동) 상태머신으로 한 스텝 진행. 부분실패·동시전이에 내성:
 *  - active:  copy·byte 검증 실패 → retry(fault). CAS 0행(경합) → retry(원본/DB 불변, no fault).
 *  - archiving(재개 or 방금 claim): private 사본 재검증(없으면 재copy, 원본도 없으면 유실방지 retry+fault) →
 *      legacy(verified_at null)면 CAS 검증기록 → public remove 실패 시 archiving 유지(retry+fault) →
 *      CAS archiving→archived+bucket 전환 실패 시 retry(fault), 사본은 보존되어 다음 실행 완료.
 */
export async function archiveStoryObjects(
  deps: ArchiveDeps,
  row: ArchiveRow,
): Promise<ArchiveStepResult> {
  let verified = row.archive_verified_at != null;

  if (row.status === "active") {
    if (!(await copyRow(deps, row))) return retry(true);
    const { claimed, error } = await deps.claimArchiving(row.id);
    if (error) return retry(true);
    if (!claimed) return retry(false); // 동시 active→removed/delete 경합 — 원본/DB 불변, public remove 금지
    verified = true; // claim 이 archive_verified_at 세팅
  } else if (row.status !== "archiving") {
    return retry(true); // 정책/쿼리 불일치 방어 — archive 액션은 active/archiving 외 storage 무접촉
  }

  // status archiving(재개 or 방금 claim). finalize 직전 private 사본 존재 재검증(Blocker 1 수정 B).
  if (!(await ensureRowArchivePresent(deps, row))) return retry(true);
  if (!verified) {
    const { ok, error } = await deps.markVerified(row.id);
    if (!ok) return retry(error);
  }

  if (!(await deps.removePublic(collectPublicItems(row)))) return retry(true);

  const { ok, error } = await deps.finalize(
    row.id,
    row.media_bucket && row.media_path ? VENUE_STORY_ARCHIVE_BUCKET : row.media_bucket,
    row.thumb_bucket && row.thumb_path ? VENUE_STORY_ARCHIVE_BUCKET : row.thumb_bucket,
  );
  if (!ok) return retry(error);
  return { outcome: "archived", fault: false };
}
