/**
 * 직관 다이어리 보관(archive) 상태머신 — **실행형** 회귀 스모크 (삼순 재리뷰 Blocker 2).
 * 실행: npm run qa:venue-archive-machine
 *
 * route 문자열 등장 순서가 아니라, production copy/CAS/remove/finalize helper(archiveStoryObjects)를
 * in-memory mock storage/db 로 **실제 호출**해 상태 전이·부작용(공개 원본 제거 시점, private 사본 보존)을 assert 한다.
 * 실패행렬:
 *   A  copy byte mismatch → 재복사, verified 전 원본 remove 0회 / A2 copy 영구실패 → 원본 remove 0
 *   B  claim CAS 0행 → public remove 0회(동시 active→removed 원본 즉시삭제 차단)
 *   C  public remove 실패 → status=archiving 유지, 다음 실행 재개
 *   D  finalize 실패 → private 사본 보존, 다음 실행 완료
 *   E  archiving + verified + private 사본 orphan 삭제(96h) → 재검증 재copy → finalize → signed object 존재 (Blocker 1)
 *   E2 archive+원본 모두 소실 → finalize 금지(유실 방지, 재시도+fault)
 *   E3 collectReferencedPaths 가 archiving 행의 venue-archive 사본 path 를 참조로 합성(orphan 보호)
 *   F  archiving 500 → 실제 처리(archived 로 배출) → 후보 starvation 방지
 */
import {
  archiveStoryObjects,
  type ArchiveRow,
  type ArchiveDeps,
  type ArchiveStorageDeps,
  type ArchiveDbDeps,
} from "../../src/lib/venue-stories/archive-machine";
import {
  collectReferencedPaths,
  shouldDeleteOrphanFile,
  type RefPageRow,
} from "../../src/lib/venue-stories/cleanup-policy";
import { isCleanupActionable } from "../../src/lib/venue-stories/expiry-policy";
import { VENUE_STORY_ARCHIVE_BUCKET } from "../../src/lib/venue-stories/types";

const ARCHIVE = VENUE_STORY_ARCHIVE_BUCKET;
const NOW = "2026-07-26T10:00:00Z";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

// ── mock storage ───────────────────────────────────────────────────────
function createStorage(initial: Record<string, number> = {}) {
  const objects = new Map<string, number>(Object.entries(initial));
  const log = { copy: [] as string[], removeArchive: [] as string[], removePublic: [] as { bucket: string; path: string }[][] };
  const faults = { removeArchive: false, removePublic: false };
  // path → 다음 copy 들이 기록할 size 큐(멀티 시나리오: byte mismatch 재현). 없으면 원본 byte 그대로.
  const copyScript = new Map<string, number[]>();
  const storage: ArchiveStorageDeps = {
    async objectSize(bucket, path) {
      const v = objects.get(`${bucket}:${path}`);
      return v == null ? null : v;
    },
    async copyToArchive(sourceBucket, path) {
      log.copy.push(path);
      const src = objects.get(`${sourceBucket}:${path}`);
      if (src == null) return; // 원본 소실 → archive 불변(present 검증에서 걸림)
      const q = copyScript.get(path);
      const size = q && q.length ? q.shift()! : src;
      objects.set(`${ARCHIVE}:${path}`, size);
    },
    async removeArchive(path) {
      log.removeArchive.push(path);
      if (faults.removeArchive) return false;
      objects.delete(`${ARCHIVE}:${path}`);
      return true;
    },
    async removePublic(items) {
      log.removePublic.push(items);
      if (faults.removePublic) return false;
      for (const it of items) objects.delete(`${it.bucket}:${it.path}`);
      return true;
    },
  };
  return { storage, objects, log, faults, copyScript };
}

// ── mock db (단일 행 CAS) ────────────────────────────────────────────────
function createDb(row: ArchiveRow) {
  const log = { claim: 0, verify: 0, finalize: 0 };
  const faults = { claim: false, verify: false, finalize: false, claimZero: false };
  const db: ArchiveDbDeps = {
    async claimArchiving() {
      log.claim++;
      if (faults.claim) return { claimed: false, error: true };
      if (faults.claimZero || row.status !== "active") return { claimed: false, error: false };
      row.status = "archiving";
      row.archive_verified_at = NOW;
      return { claimed: true, error: false };
    },
    async markVerified() {
      log.verify++;
      if (faults.verify) return { ok: false, error: true };
      if (row.status !== "archiving" || row.archive_verified_at != null) return { ok: false, error: false };
      row.archive_verified_at = NOW;
      return { ok: true, error: false };
    },
    async finalize(_id, mediaBucket, thumbBucket) {
      log.finalize++;
      if (faults.finalize) return { ok: false, error: true };
      if (row.status !== "archiving") return { ok: false, error: false };
      row.status = "archived";
      row.media_bucket = mediaBucket;
      row.thumb_bucket = thumbBucket;
      return { ok: true, error: false };
    },
  };
  return { db, log, faults };
}

function mkRow(o: Partial<ArchiveRow> & { id: number; status: string }): ArchiveRow {
  return {
    archive_verified_at: null,
    media_bucket: "videos",
    media_path: "venue-stories/G/u/v.mp4",
    thumb_bucket: null,
    thumb_path: null,
    ...o,
  };
}
function deps(s: ReturnType<typeof createStorage>, d: ReturnType<typeof createDb>): ArchiveDeps {
  return { ...s.storage, ...d.db };
}

(async () => {
  // ── A: copy byte mismatch → 재복사 후 성공, 원본 remove 는 claim(verified) 이후 1회 ──
  {
    const row = mkRow({ id: 1, status: "active" });
    const s = createStorage({ "videos:venue-stories/G/u/v.mp4": 100 });
    s.copyScript.set("venue-stories/G/u/v.mp4", [90]); // 1차 truncated 90 → 2차 원본 100
    const d = createDb(row);
    const res = await archiveStoryObjects(deps(s, d), row);
    ok("A archived", res.outcome === "archived");
    ok("A 재복사 발생(copy 2회)", s.log.copy.length === 2);
    ok("A 불완전 사본 교체(removeArchive 1회)", s.log.removeArchive.length === 1);
    ok("A verified 전 원본 remove 0회 → public remove 정확히 1회(claim 이후)", s.log.removePublic.length === 1 && d.log.claim === 1);
    ok("A private 사본 byte=원본(100) 존재", s.objects.get(`${ARCHIVE}:venue-stories/G/u/v.mp4`) === 100);
    ok("A 공개 원본 제거됨", s.objects.get("videos:venue-stories/G/u/v.mp4") == null);
    ok("A row archived + media_bucket=venue-archive", row.status === "archived" && row.media_bucket === ARCHIVE);
  }

  // ── A2: copy 가 영구 mismatch → copyRow 실패 → claim/remove 0, 원본 보존 ──
  {
    const row = mkRow({ id: 2, status: "active" });
    const s = createStorage({ "videos:venue-stories/G/u/v.mp4": 100 });
    s.copyScript.set("venue-stories/G/u/v.mp4", [90, 90]); // 항상 90 → 검증 영구 실패
    const d = createDb(row);
    const res = await archiveStoryObjects(deps(s, d), row);
    ok("A2 retry + fault(copy 검증 실패)", res.outcome === "retry" && res.fault === true);
    ok("A2 claim 0회(원본 CAS 미시도)", d.log.claim === 0);
    ok("A2 public remove 0회(원본 보존)", s.log.removePublic.length === 0 && s.objects.get("videos:venue-stories/G/u/v.mp4") === 100);
    ok("A2 row active 유지", row.status === "active");
  }

  // ── B: claim CAS 0행(동시 active→removed) → public remove 0, 원본/DB 불변 ──
  {
    const row = mkRow({ id: 3, status: "active" });
    const s = createStorage({ "videos:venue-stories/G/u/v.mp4": 100 });
    const d = createDb(row);
    d.faults.claimZero = true; // 경합으로 0행
    const res = await archiveStoryObjects(deps(s, d), row);
    ok("B retry + fault=false(정상 경합)", res.outcome === "retry" && res.fault === false);
    ok("B public remove 0회(30일 격리 원본 즉시삭제 차단)", s.log.removePublic.length === 0);
    ok("B 공개 원본 보존", s.objects.get("videos:venue-stories/G/u/v.mp4") === 100);
    ok("B row active 유지(DB 불변)", row.status === "active" && row.media_bucket === "videos");
  }

  // ── C: public remove 실패 → archiving 유지, 다음 실행 재개 완료 ──
  {
    const row = mkRow({ id: 4, status: "archiving", archive_verified_at: NOW });
    const s = createStorage({ "videos:venue-stories/G/u/v.mp4": 100, [`${ARCHIVE}:venue-stories/G/u/v.mp4`]: 100 });
    const d = createDb(row);
    s.faults.removePublic = true;
    const r1 = await archiveStoryObjects(deps(s, d), row);
    ok("C1 retry + fault(public remove 실패)", r1.outcome === "retry" && r1.fault === true);
    ok("C1 finalize 미호출", d.log.finalize === 0);
    ok("C1 status=archiving 유지", row.status === "archiving");
    ok("C1 공개 원본·private 사본 모두 보존", s.objects.get("videos:venue-stories/G/u/v.mp4") === 100 && s.objects.get(`${ARCHIVE}:venue-stories/G/u/v.mp4`) === 100);
    // 다음 실행: 장애 해소
    s.faults.removePublic = false;
    const r2 = await archiveStoryObjects(deps(s, d), row);
    ok("C2 재개 → archived", r2.outcome === "archived" && row.status === "archived");
    ok("C2 공개 원본 제거·private 사본 존재", s.objects.get("videos:venue-stories/G/u/v.mp4") == null && s.objects.get(`${ARCHIVE}:venue-stories/G/u/v.mp4`) === 100);
  }

  // ── D: finalize 실패 → private 사본 보존, 다음 실행 완료 ──
  {
    const row = mkRow({ id: 5, status: "archiving", archive_verified_at: NOW });
    const s = createStorage({ "videos:venue-stories/G/u/v.mp4": 100, [`${ARCHIVE}:venue-stories/G/u/v.mp4`]: 100 });
    const d = createDb(row);
    d.faults.finalize = true;
    const r1 = await archiveStoryObjects(deps(s, d), row);
    ok("D1 retry + fault(finalize 실패)", r1.outcome === "retry" && r1.fault === true);
    ok("D1 status=archiving 유지", row.status === "archiving");
    ok("D1 private 사본 보존(원본은 remove 됨)", s.objects.get(`${ARCHIVE}:venue-stories/G/u/v.mp4`) === 100 && s.objects.get("videos:venue-stories/G/u/v.mp4") == null);
    // 다음 실행: finalize 정상 — 원본 소실 상태에서도 present 사본으로 완료(Blocker 1 B)
    d.faults.finalize = false;
    const r2 = await archiveStoryObjects(deps(s, d), row);
    ok("D2 재개 → archived(원본 없어도 private 사본으로 완료)", r2.outcome === "archived" && row.status === "archived");
    ok("D2 media_bucket=venue-archive", row.media_bucket === ARCHIVE);
  }

  // ── E: archiving + verified + private 사본 orphan 삭제(96h) → 재검증 재copy → finalize → 사본 존재 (Blocker 1) ──
  {
    const row = mkRow({ id: 6, status: "archiving", archive_verified_at: NOW });
    // 공개 원본은 아직 남아있고(=public remove 전), private 사본이 orphan 으로 삭제된 상태
    const s = createStorage({ "videos:venue-stories/G/u/v.mp4": 100 });
    const d = createDb(row);
    const res = await archiveStoryObjects(deps(s, d), row);
    ok("E archived(재검증 후 완료)", res.outcome === "archived");
    ok("E archive_verified_at 맹신 없이 재copy 발생", s.log.copy.includes("venue-stories/G/u/v.mp4"));
    ok("E finalize 후 private 사본(signed 대상) 존재", s.objects.get(`${ARCHIVE}:venue-stories/G/u/v.mp4`) === 100);
    ok("E 공개 원본 제거됨", s.objects.get("videos:venue-stories/G/u/v.mp4") == null);
  }

  // ── E2: archive + 공개 원본 모두 소실 → finalize 금지(유실 방지) ──
  {
    const row = mkRow({ id: 7, status: "archiving", archive_verified_at: NOW });
    const s = createStorage({}); // 둘 다 없음
    const d = createDb(row);
    const res = await archiveStoryObjects(deps(s, d), row);
    ok("E2 retry + fault(재검증 실패)", res.outcome === "retry" && res.fault === true);
    ok("E2 finalize 미호출(유실 finalize 차단)", d.log.finalize === 0);
    ok("E2 public remove 미호출", s.log.removePublic.length === 0);
    ok("E2 status=archiving 유지(다음 실행 재시도 + 5xx 관제)", row.status === "archiving");
  }

  // ── E3: collectReferencedPaths 가 archiving 행의 venue-archive 사본 path 를 참조로 합성 ──
  {
    const archivingRow: RefPageRow = {
      id: 1, status: "archiving",
      media_bucket: "videos", media_path: "venue-stories/G/u/v.mp4",
      thumb_bucket: "photos", thumb_path: "venue-stories/G/u/v.jpg",
    };
    const activeRow: RefPageRow = {
      id: 2, status: "active",
      media_bucket: "videos", media_path: "venue-stories/G/u/a.mp4",
      thumb_bucket: null, thumb_path: null,
    };
    const table = [archivingRow, activeRow];
    const set = await collectReferencedPaths(
      async (afterId, limit) => table.filter((r) => r.id > afterId).sort((a, b) => a.id - b.id).slice(0, limit),
      1000,
    );
    ok("E3 참조 수집 성공", set != null);
    ok("E3 archiving media 사본(venue-archive) 참조 합성", set!.has(`${ARCHIVE}:venue-stories/G/u/v.mp4`));
    ok("E3 archiving thumb 사본(venue-archive) 참조 합성", set!.has(`${ARCHIVE}:venue-stories/G/u/v.jpg`));
    ok("E3 archiving 공개 원본도 참조(source 보호)", set!.has("videos:venue-stories/G/u/v.mp4") && set!.has("photos:venue-stories/G/u/v.jpg"));
    ok("E3 active 행은 venue-archive 합성 안 함(하위호환)", !set!.has(`${ARCHIVE}:venue-stories/G/u/a.mp4`));
    // orphan 판정: 참조된 archive 사본은 96h 경과여도 삭제 금지
    ok(
      "E3 archiving private 사본은 96h 경과여도 orphan 삭제 금지",
      shouldDeleteOrphanFile({
        isFolder: false,
        isReferenced: set!.has(`${ARCHIVE}:venue-stories/G/u/v.mp4`),
        createdAt: "2020-01-01T00:00:00Z",
        cutoffMs: Date.parse(NOW),
      }) === false,
    );
  }

  // ── F: archiving 500건 → 실제 처리(archived 로 배출) → 후보 starvation 방지 ──
  {
    const nowMs = Date.parse(NOW);
    ok("F archiving 은 만료값과 무관하게 actionable(중간실패 재개)", isCleanupActionable({ status: "archiving", expiresAtMs: null, gameEndedAtMs: null, removedAtMs: null, nowMs }) === true);
    let archivedCount = 0;
    let stillActionableAfter = 0;
    for (let i = 0; i < 500; i++) {
      const row = mkRow({ id: 10_000 + i, status: "archiving", archive_verified_at: NOW });
      const s = createStorage({ "videos:venue-stories/G/u/v.mp4": 100, [`${ARCHIVE}:venue-stories/G/u/v.mp4`]: 100 });
      const d = createDb(row);
      const res = await archiveStoryObjects(deps(s, d), row);
      if (res.outcome === "archived") archivedCount++;
      if (isCleanupActionable({ status: row.status, expiresAtMs: null, gameEndedAtMs: null, removedAtMs: null, nowMs })) stillActionableAfter++;
    }
    ok("F 500 archiving 모두 archived 로 배출(no-op 아님)", archivedCount === 500);
    ok("F 처리 후 재-actionable 0(batch 배출 → 후보 starvation 방지)", stillActionableAfter === 0);
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
})();
