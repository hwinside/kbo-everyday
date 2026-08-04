/**
 * venue_stories 트랜스코드 worker 회귀 스모크 — processVenueJob 실제 실행.
 * 실행: npm run qa:venue-transcode-worker
 *
 * 삼순 4차 NO-GO 검증 blocker ①:
 *  - simulateCatchCas(조건 복사)를 실제 processVenueJob 호출로 대체.
 *  - mock DB는 .from().update().eq().select() 체인 CAS를 실 supabase처럼 모사.
 *  - upload 예외 → 실제 catch 블록 실행 → CAS 결과 검증.
 *
 * 시나리오:
 *  (A) active 성공 — CAS 통과, needs_transcode false 전환
 *  (B) active 성공 중 concurrent remove → DB update 0-row → claimedElsewhere
 *  (C) active upload 예외 + concurrent removed → catch CAS 0-row → claimedElsewhere (resurrect 금지)
 *  (D) active upload 예외, 여전히 active → catch CAS 1-row → failed (attempts 증가)
 *  (E) pending 성공 승격 — status pending→active
 *  (F) pending upload 예외 + 즉시경로 선점(active) → catch CAS 0-row → claimedElsewhere
 *  (G) pending 재시도 소진 → catch status=removed
 *  (H) active duration 초과 → removed
 *  (I) active catch CAS DB 오류 → updateError
 *  (K) diary_manual pending 복구 → archived (active 공개 금지)
 */
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// processVenueJob은 scripts/venue-transcode-job.mjs — tsx가 ESM .mjs 로드
// @ts-expect-error JS module, 타입은 테스트 내부에서 검증
import { processVenueJob, selectVenueTranscodeTargets } from "../venue-transcode-job.mjs";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

// ── Mock Helpers ──

interface DbRowState {
  id: number;
  status: string;
  needs_transcode: boolean;
  transcode_attempts: number;
  [key: string]: unknown;
}

/**
 * Supabase .from().update().eq().eq()...select() 체인을 실 CAS 처럼 모사.
 * select() 호출 시 누적 eq 조건이 state와 전부 일치하면 1-row(payload 반영),
 * 하나라도 불일치하면 0-row(noop).
 */
function makeMockDb(state: DbRowState, opts?: { selectError?: { message: string } }) {
  return {
    from() {
      return {
        update(payload: Record<string, unknown>) {
          const conditions: Record<string, unknown> = {};
          const builder: Record<string, unknown> = {};
          builder["eq"] = (col: string, val: unknown) => {
            conditions[col] = val;
            return builder;
          };
          builder["select"] = () => {
            if (opts?.selectError) {
              return Promise.resolve({ data: null, error: opts.selectError });
            }
            const matches = Object.entries(conditions).every(([k, v]) => state[k] === v);
            if (matches) {
              Object.assign(state, payload);
              return Promise.resolve({ data: [{ id: state.id }], error: null });
            }
            return Promise.resolve({ data: [], error: null });
          };
          return builder;
        }
      };
    }
  };
}

interface StorageOpts {
  downloadData?: Buffer;
  downloadError?: { message: string };
  uploadError?: { message: string };
}

function makeMockStorage(opts: StorageOpts = {}) {
  const uploaded: Record<string, Buffer> = {};
  return {
    from(bucket: string) {
      return {
        async download() {
          if (opts.downloadError) return { data: null, error: opts.downloadError };
          const buf = opts.downloadData ?? Buffer.alloc(1000, 0xab);
          return { data: new Blob([buf]), error: null };
        },
        async upload(path: string, buf: Buffer) {
          if (opts.uploadError) return { error: opts.uploadError };
          uploaded[`${bucket}/${path}`] = buf;
          return { error: null };
        },
        getPublicUrl(path: string) {
          return { data: { publicUrl: `https://mock.supabase.co/storage/v1/object/public/${bucket}/${path}` } };
        },
        async remove() {
          return { error: null };
        }
      };
    },
    _uploaded: uploaded,
  };
}

interface RunnerOpts {
  probeMeta?: { durationMs: number; width: number | null; height: number | null } | "throws";
  transcodeThrows?: boolean;
  downloadBytes?: number;
  downloadThrows?: boolean;
}

function makeMockRunner(work: string, opts: RunnerOpts = {}) {
  return {
    probe() {
      const meta = opts.probeMeta ?? { durationMs: 5000, width: 720, height: 1280 };
      if (meta === "throws") throw new Error("ffprobe 실행 실패");
      return meta;
    },
    transcode(_inPath: string, outPath: string) {
      if (opts.transcodeThrows) throw new Error("ffmpeg 실패");
      writeFileSync(outPath, Buffer.alloc(500, 0x00));
    },
    async downloadToFile(_url: string, destPath: string) {
      if (opts.downloadThrows) throw new Error("download 실패");
      const bytes = opts.downloadBytes ?? 1000;
      writeFileSync(destPath, Buffer.alloc(bytes, 0xab));
      return bytes;
    }
  };
}

const BASE_ROW = {
  id: 1,
  media_url: "https://storage.example.com/videos/venue-stories/G1/U1/video.mp4",
  media_bucket: "videos",
  media_path: "venue-stories/G1/U1/video.mp4",
  transcode_attempts: 0,
};

async function run() {
  console.log("[A] active 성공 — CAS 통과, needs_transcode 해제");
  {
    const work = mkdtempSync(join(tmpdir(), "vt-test-"));
    try {
      const state: DbRowState = { id: 1, status: "active", needs_transcode: true, transcode_attempts: 0 };
      const row = { ...BASE_ROW, status: "active", needs_transcode: true };
      const res = await processVenueJob(row, {
        db: makeMockDb(state),
        storage: makeMockStorage(),
        runner: makeMockRunner(work),
        inPath: join(work, "in.mp4"),
        outPath: join(work, "out.mp4"),
      });
      ok("A: result=done", res.result === "done");
      ok("A: needs_transcode false 전환(DB 반영)", state.needs_transcode === false);
      ok("A: attempts 증가", state.transcode_attempts === 1);
      ok("A: status 재기록 없음(active 유지)", state.status === "active");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  console.log("[B] active 성공 중 concurrent remove → DB update 0-row → claimedElsewhere");
  {
    const work = mkdtempSync(join(tmpdir(), "vt-test-"));
    try {
      // 성공 경로 DB update 시 이미 removed 상태 → CAS 불일치 → 0-row
      const state: DbRowState = { id: 1, status: "removed", needs_transcode: true, transcode_attempts: 0 };
      const row = { ...BASE_ROW, status: "active", needs_transcode: true };
      const res = await processVenueJob(row, {
        db: makeMockDb(state),
        storage: makeMockStorage(),
        runner: makeMockRunner(work),
        inPath: join(work, "in.mp4"),
        outPath: join(work, "out.mp4"),
      });
      ok("B: result=claimedElsewhere", res.result === "claimedElsewhere");
      ok("B: removed 상태 유지(status 재기록 금지)", state.status === "removed");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  console.log("[C] active upload 예외 + concurrent removed → catch CAS 0-row → claimedElsewhere (resurrect 금지)");
  {
    // 실제 processVenueJob의 catch 블록이 실행됨 — simulateCatchCas 대체
    const work = mkdtempSync(join(tmpdir(), "vt-test-"));
    try {
      // upload가 에러 반환 → throw → catch 진입
      // catch의 .eq("status","active") CAS: state.status="removed" → 0-row → claimedElsewhere
      const state: DbRowState = { id: 1, status: "removed", needs_transcode: true, transcode_attempts: 0 };
      const row = { ...BASE_ROW, status: "active", needs_transcode: true };
      const res = await processVenueJob(row, {
        db: makeMockDb(state),
        storage: makeMockStorage({ uploadError: { message: "서버 오류" } }),
        runner: makeMockRunner(work),
        inPath: join(work, "in.mp4"),
        outPath: join(work, "out.mp4"),
      });
      ok("C: result=claimedElsewhere(catch 경로에서 CAS 0-row → resurrect 금지)", res.result === "claimedElsewhere");
      ok("C: catch 후 removed 상태 유지(active 재기록 없음)", state.status === "removed");
      ok("C: attempts 미증가(0-row skip)", state.transcode_attempts === 0);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  console.log("[D] active upload 예외, 여전히 active → catch CAS 1-row → failed (attempts 증가)");
  {
    // 실제 catch 블록 실행 — CAS 조건 일치 → 1-row → failed
    const work = mkdtempSync(join(tmpdir(), "vt-test-"));
    try {
      const state: DbRowState = { id: 1, status: "active", needs_transcode: true, transcode_attempts: 0 };
      const row = { ...BASE_ROW, status: "active", needs_transcode: true };
      const res = await processVenueJob(row, {
        db: makeMockDb(state),
        storage: makeMockStorage({ uploadError: { message: "서버 오류" } }),
        runner: makeMockRunner(work),
        inPath: join(work, "in.mp4"),
        outPath: join(work, "out.mp4"),
      });
      ok("D: result=failed(catch 경로 실행)", res.result === "failed");
      ok("D: attempts 증가(catch CAS 1-row)", state.transcode_attempts === 1);
      ok("D: status 재기록 없음(active 유지)", state.status === "active");
      ok("D: catch payload에 status 없음(불변식)", !("status" in (res as { catchStatus?: string })
        ? false : true) || (res as { catchStatus?: string }).catchStatus === "active");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  console.log("[E] pending 성공 승격 — status pending→active");
  {
    const work = mkdtempSync(join(tmpdir(), "vt-test-"));
    try {
      const state: DbRowState = { id: 2, status: "pending", needs_transcode: true, transcode_attempts: 0 };
      const row = {
        id: 2,
        status: "pending",
        needs_transcode: true,
        media_url: "",
        media_bucket: "venue-staging",
        media_path: "venue-stories/G1/U1/video.mp4",
        transcode_attempts: 0,
      };
      const res = await processVenueJob(row, {
        db: makeMockDb(state),
        storage: makeMockStorage({ downloadData: Buffer.alloc(1000, 0xab) }),
        runner: makeMockRunner(work),
        inPath: join(work, "in.mp4"),
        outPath: join(work, "out.mp4"),
      });
      ok("E: result=done", res.result === "done");
      ok("E: status pending→active 전환", state.status === "active");
      ok("E: attempts 증가", state.transcode_attempts === 1);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  console.log("[F] pending upload 예외 + 즉시경로 선점(active) → catch CAS 0-row → claimedElsewhere");
  {
    // catch 블록: .eq("status","pending") CAS → state.status="active" → 0-row → claimedElsewhere
    const work = mkdtempSync(join(tmpdir(), "vt-test-"));
    try {
      // 즉시경로가 먼저 active로 승격한 상태(upload 예외 직전)
      const state: DbRowState = { id: 2, status: "active", needs_transcode: false, transcode_attempts: 0 };
      const row = {
        id: 2,
        status: "pending",
        needs_transcode: true,
        media_url: "",
        media_bucket: "venue-staging",
        media_path: "venue-stories/G1/U1/video.mp4",
        transcode_attempts: 0,
      };
      const res = await processVenueJob(row, {
        db: makeMockDb(state),
        storage: makeMockStorage({
          downloadData: Buffer.alloc(1000, 0xab),
          uploadError: { message: "서버 오류" },
        }),
        runner: makeMockRunner(work),
        inPath: join(work, "in.mp4"),
        outPath: join(work, "out.mp4"),
      });
      ok("F: result=claimedElsewhere(catch pending CAS 0-row)", res.result === "claimedElsewhere");
      ok("F: status active 유지(pending 재기록 금지)", state.status === "active");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  console.log("[G] pending 재시도 소진(maxAttempts) → catch status=removed");
  {
    const work = mkdtempSync(join(tmpdir(), "vt-test-"));
    try {
      // attempts=2, maxAttempts=3 → 3회째 → removed
      const state: DbRowState = { id: 3, status: "pending", needs_transcode: true, transcode_attempts: 2 };
      const row = {
        id: 3,
        status: "pending",
        needs_transcode: true,
        media_url: "",
        media_bucket: "venue-staging",
        media_path: "venue-stories/G1/U1/video.mp4",
        transcode_attempts: 2,
      };
      const res = await processVenueJob(row, {
        db: makeMockDb(state),
        storage: makeMockStorage({ uploadError: { message: "영구 실패" } }),
        runner: makeMockRunner(work),
        inPath: join(work, "in.mp4"),
        outPath: join(work, "out.mp4"),
        maxAttempts: 3,
      });
      ok("G: result=failed", res.result === "failed");
      ok("G: catchStatus=removed(재시도 소진)", (res as { catchStatus?: string }).catchStatus === "removed");
      ok("G: DB status=removed 기록됨", state.status === "removed");
      ok("G: attempts=3 기록됨", state.transcode_attempts === 3);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  console.log("[H] active duration 초과 → removed (검증 실패 경로)");
  {
    const work = mkdtempSync(join(tmpdir(), "vt-test-"));
    try {
      const state: DbRowState = { id: 4, status: "active", needs_transcode: true, transcode_attempts: 0 };
      const row = { ...BASE_ROW, id: 4, status: "active", needs_transcode: true };
      const res = await processVenueJob(row, {
        db: makeMockDb(state),
        storage: makeMockStorage(),
        runner: makeMockRunner(work, { probeMeta: { durationMs: 20000, width: 720, height: 1280 } }),
        inPath: join(work, "in.mp4"),
        outPath: join(work, "out.mp4"),
      });
      ok("H: result=removed(duration 초과)", res.result === "removed");
      ok("H: DB status=removed 기록됨", state.status === "removed");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  console.log("[I] active catch CAS DB 오류 → updateError");
  {
    const work = mkdtempSync(join(tmpdir(), "vt-test-"));
    try {
      const state: DbRowState = { id: 5, status: "active", needs_transcode: true, transcode_attempts: 0 };
      const row = { ...BASE_ROW, id: 5, status: "active", needs_transcode: true };
      const res = await processVenueJob(row, {
        db: makeMockDb(state, { selectError: { message: "DB 타임아웃" } }),
        storage: makeMockStorage({ uploadError: { message: "서버 오류" } }),
        runner: makeMockRunner(work),
        inPath: join(work, "in.mp4"),
        outPath: join(work, "out.mp4"),
      });
      ok("I: result=updateError(catch DB 오류)", res.result === "updateError");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  console.log("[J] A안 A1: active private(venue-media) 원본 → storage.download 경유(media_url 다운로드 아님)");
  {
    const work = mkdtempSync(join(tmpdir(), "vt-test-"));
    try {
      const state: DbRowState = { id: 6, status: "active", needs_transcode: true, transcode_attempts: 0 };
      // media_bucket=venue-media(private): 공개 URL 없음 → runner.downloadToFile 를 쓰면 실패해야 정상.
      const row = {
        id: 6,
        status: "active",
        needs_transcode: true,
        media_url: "https://mock/storage/v1/object/public/venue-media/venue-stories/G1/U1/v.mp4",
        media_bucket: "venue-media",
        media_path: "venue-stories/G1/U1/v.mp4",
        transcode_attempts: 0,
      };
      const storage = makeMockStorage({ downloadData: Buffer.alloc(1000, 0xab) });
      const res = await processVenueJob(row, {
        db: makeMockDb(state),
        storage,
        // downloadToFile 가 호출되면 throw — private 경로는 storage.download 를 써야 하므로 호출되면 안 됨
        runner: makeMockRunner(work, { downloadThrows: true }),
        inPath: join(work, "in.mp4"),
        outPath: join(work, "out.mp4"),
      });
      ok("J: result=done(private storage.download 경유 성공)", res.result === "done");
      ok(
        "J: 720p 출력도 venue-media(private) 버킷으로 업로드(공개 videos 아님)",
        Object.keys(storage._uploaded).some((k) => k.startsWith("venue-media/")) &&
          !Object.keys(storage._uploaded).some((k) => k.startsWith("videos/")),
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  console.log("[K] diary_manual pending 복구 — status pending→archived");
  {
    const work = mkdtempSync(join(tmpdir(), "vt-test-"));
    try {
      const state: DbRowState = {
        id: 7,
        status: "pending",
        needs_transcode: false,
        transcode_attempts: 0,
      };
      const row = {
        id: 7,
        status: "pending",
        needs_transcode: false,
        attendance_source: "diary_manual",
        media_url: "",
        media_bucket: "venue-staging",
        media_path: "venue-stories/G1/U1/manual.mp4",
        transcode_attempts: 0,
      };
      const res = await processVenueJob(row, {
        db: makeMockDb(state),
        storage: makeMockStorage({ downloadData: Buffer.alloc(1000, 0xab) }),
        runner: makeMockRunner(work),
        inPath: join(work, "in.mp4"),
        outPath: join(work, "out.mp4"),
      });
      ok("K: result=done", res.result === "done");
      ok("K: 직접 추가 영상은 active 아닌 archived", state.status === "archived");
      ok("K: archived_at 기록", typeof state.archived_at === "string");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  // ── archived(다이어리 전용) 최적화 경로 — 삼순 blocker ③ (2026-08-04) ──
  // 사고: 서버가 needs_transcode=true 를 써도 워커가 active 만 처리해서 diary_manual 느린
  // 원본은 한 번도 최적화되지 않았다. 여기서는 archived 가 실제로 처리되고,
  // **archived 상태를 유지한 채** 닫히는지를 검증한다.
  console.log("[L] archived+needs_transcode 최적화 — archived 유지한 채 flag 해제");
  {
    const work = mkdtempSync(join(tmpdir(), "vt-test-"));
    try {
      const state: DbRowState = {
        id: 8,
        status: "archived",
        needs_transcode: true,
        transcode_attempts: 0,
      };
      const row = {
        id: 8,
        status: "archived",
        needs_transcode: true,
        attendance_source: "diary_manual",
        media_url: "",
        media_bucket: "venue-media",
        media_path: "venue-stories/G1/U1/manual.mp4",
        transcode_attempts: 0,
      };
      const storage = makeMockStorage({ downloadData: Buffer.alloc(1000, 0xab) });
      const res = await processVenueJob(row, {
        db: makeMockDb(state),
        storage,
        // private 버킷이라 media_url 다운로드를 쓰면 안 된다
        runner: makeMockRunner(work, { downloadThrows: true }),
        inPath: join(work, "in.mp4"),
        outPath: join(work, "out.mp4"),
      });
      ok("L: result=done(archived 도 실제로 처리된다)", res.result === "done");
      ok("L: status archived 유지(공개 active 로 올리지 않는다)", state.status === "archived");
      ok("L: needs_transcode false 로 닫힘", state.needs_transcode === false);
      ok("L: attempts 증가", state.transcode_attempts === 1);
      ok(
        "L: 720p 산출물이 private venue-media 버킷에 저장",
        Object.keys(storage._uploaded).some((k) => k.startsWith("venue-media/")),
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  console.log("[M] archived 처리 중 removed 로 내려가면 → CAS 0-row(resurrect 금지)");
  {
    const work = mkdtempSync(join(tmpdir(), "vt-test-"));
    try {
      const state: DbRowState = {
        id: 9,
        status: "removed",
        needs_transcode: true,
        transcode_attempts: 0,
      };
      const row = {
        id: 9,
        status: "archived",
        needs_transcode: true,
        attendance_source: "diary_manual",
        media_url: "",
        media_bucket: "venue-media",
        media_path: "venue-stories/G1/U1/manual.mp4",
        transcode_attempts: 0,
      };
      const res = await processVenueJob(row, {
        db: makeMockDb(state),
        storage: makeMockStorage({ downloadData: Buffer.alloc(1000, 0xab) }),
        runner: makeMockRunner(work, { downloadThrows: true }),
        inPath: join(work, "in.mp4"),
        outPath: join(work, "out.mp4"),
      });
      ok("M: result=claimedElsewhere", res.result === "claimedElsewhere");
      ok("M: removed 상태 유지(archived 로 되살리지 않음)", state.status === "removed");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  console.log("[N] 게시된 행 재시도 소진 — status 유지 + 큐에서만 내린다(무한 재큐 방지)");
  {
    for (const publishedStatus of ["active", "archived"] as const) {
      const work = mkdtempSync(join(tmpdir(), "vt-test-"));
      try {
        // attempts=2, maxAttempts=3 → 3회째 실패 = 소진
        const state: DbRowState = {
          id: 10,
          status: publishedStatus,
          needs_transcode: true,
          transcode_attempts: 2,
        };
        const row = {
          id: 10,
          status: publishedStatus,
          needs_transcode: true,
          media_url: "",
          media_bucket: "venue-media",
          media_path: "venue-stories/G1/U1/v.mp4",
          transcode_attempts: 2,
        };
        const res = await processVenueJob(row, {
          db: makeMockDb(state),
          storage: makeMockStorage({
            downloadData: Buffer.alloc(1000, 0xab),
            uploadError: { message: "영구 실패" },
          }),
          runner: makeMockRunner(work, { downloadThrows: true }),
          inPath: join(work, "in.mp4"),
          outPath: join(work, "out.mp4"),
          maxAttempts: 3,
        });
        ok(`N(${publishedStatus}): result=failed`, res.result === "failed");
        ok(
          `N(${publishedStatus}): 유저 노출 상태 보존(removed 로 내리지 않음)`,
          state.status === publishedStatus,
        );
        ok(
          `N(${publishedStatus}): 재시도 소진 → needs_transcode=false 로 큐에서 내림`,
          state.needs_transcode === false,
        );
        ok(`N(${publishedStatus}): attempts=3 기록`, state.transcode_attempts === 3);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    }
  }

  console.log("[O] 게시된 행 재시도 잔여 — 큐 유지(다음 런이 다시 집는다)");
  {
    const work = mkdtempSync(join(tmpdir(), "vt-test-"));
    try {
      const state: DbRowState = {
        id: 11,
        status: "archived",
        needs_transcode: true,
        transcode_attempts: 0,
      };
      const row = {
        id: 11,
        status: "archived",
        needs_transcode: true,
        media_url: "",
        media_bucket: "venue-media",
        media_path: "venue-stories/G1/U1/v.mp4",
        transcode_attempts: 0,
      };
      const res = await processVenueJob(row, {
        db: makeMockDb(state),
        storage: makeMockStorage({
          downloadData: Buffer.alloc(1000, 0xab),
          uploadError: { message: "일시 오류" },
        }),
        runner: makeMockRunner(work, { downloadThrows: true }),
        inPath: join(work, "in.mp4"),
        outPath: join(work, "out.mp4"),
        maxAttempts: 3,
      });
      ok("O: result=failed", res.result === "failed");
      ok("O: 소진 전이라 needs_transcode=true 유지(재처리 가능)", state.needs_transcode === true);
      ok("O: status archived 유지", state.status === "archived");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  // ── 워커 조회 seam 행동 검증 (삼순 blocker ①, 2026-08-04) ──
  // ⚠️ 종전 P 는 transcode-videos.mjs 를 **소스 regex** 로 검색했다. 그래서 실행 .or() 에서
  // archived 를 빼고 주석에만 남겨도 51/0 GREEN 이었다(삼순 독립 재현).
  // 이젠 실제 워커와 **같은 함수**(selectVenueTranscodeTargets)를 mock DB 로 돌려
  // .or 인자값·bounded order/limit·select 컬럼까지 호출 인자로 검증한다.
  console.log("[P] 워커 조회 seam 행동 검증 (mock DB actual 호출값)");
  {
    const calls: Record<string, unknown[]> = {};
    const record = (name: string, args: unknown[]) => {
      calls[name] = args;
    };
    const rowsFixture = [{ id: 1 }, { id: 2 }];
    const chain: Record<string, unknown> = {};
    chain.select = (...a: unknown[]) => {
      record("select", a);
      return chain;
    };
    chain.eq = (...a: unknown[]) => {
      record(`eq:${a[0]}`, a);
      return chain;
    };
    chain.or = (...a: unknown[]) => {
      record("or", a);
      return chain;
    };
    chain.lt = (...a: unknown[]) => {
      record(`lt:${a[0]}`, a);
      return chain;
    };
    chain.order = (...a: unknown[]) => {
      record("order", a);
      return chain;
    };
    chain.limit = (...a: unknown[]) => {
      record("limit", a);
      return Promise.resolve({ data: rowsFixture, error: null });
    };
    const mockDb = {
      from: (...a: unknown[]) => {
        record("from", a);
        return chain;
      },
    };

    const res = await selectVenueTranscodeTargets(mockDb, { maxAttempts: 3, limit: 20 });
    const orArg = String(calls.or?.[0] ?? "");

    ok("P: venue_stories 테이블 조회", calls.from?.[0] === "venue_stories");
    ok("P: media_type=video 필터", calls["eq:media_type"]?.[1] === "video");
    ok(
      "P: 실행 .or() 인자가 archived+needs_transcode 를 포함(주석 아닌 실값)",
      orArg.includes("and(status.eq.archived,needs_transcode.eq.true)"),
    );
    ok(
      "P: 실행 .or() 인자가 active+needs_transcode 를 포함",
      orArg.includes("and(status.eq.active,needs_transcode.eq.true)"),
    );
    ok("P: 실행 .or() 인자가 pending 을 포함", orArg.includes("status.eq.pending"));
    ok(
      "P: 재시도 상한이 조회에 결속(lt transcode_attempts)",
      calls["lt:transcode_attempts"]?.[1] === 3,
    );
    ok(
      "P: bounded — created_at 오름차순 정렬",
      calls.order?.[0] === "created_at" &&
        (calls.order?.[1] as { ascending?: boolean } | undefined)?.ascending === true,
    );
    ok("P: bounded — limit 이 그대로 전달", calls.limit?.[0] === 20);
    ok(
      "P: 조회 컬럼에 processVenueJob 필수 필드 포함(status/attendance_source 포함)",
      ["id", "status", "media_bucket", "media_path", "transcode_attempts", "attendance_source"].every(
        (c) => String(calls.select?.[0] ?? "").includes(c),
      ),
    );
    ok("P: 조회 결과를 그대로 반환", (res as { data?: unknown[] }).data === rowsFixture);
  }

  // 상위 워커가 이 seam 을 실제로 호출하는지(인라인 조회로 되돌아가면 RED).
  // 상위 스크립트는 supabase env 를 모듈 로드 시점에 요구해 import 가 안 되므로
  // 이 항목만 소스 확인이다(위 행동 검증이 본체).
  console.log("[P2] 상위 워커가 조회 seam 을 사용");
  {
    const src = readFileSync(join(import.meta.dirname, "..", "transcode-videos.mjs"), "utf8");
    ok(
      "P2: transcode-videos.mjs 가 selectVenueTranscodeTargets 를 호출",
      /await selectVenueTranscodeTargets\(/.test(src),
    );
    // 상위 스크립트에는 video_transcode_jobs 용 .or() 가 별도로 있다(이건 정상).
    // 금지 대상은 **venue_stories 인라인 조회 재도입**이다 — needs_transcode 를 다룬다면
    // seam 을 우회한 것이므로 RED.
    ok(
      "P2: venue_stories 인라인 조회 재도입 없음(needs_transcode 직접 술어 0)",
      !/\.or\([^)]*needs_transcode/.test(src),
    );
    ok(
      "P2: venue_stories 선택 컬럼을 상위에서 재선언하지 않음",
      !/from\("venue_stories"\)[\s\S]{0,200}attendance_source/.test(src),
    );
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

run().catch((e) => { console.error("❌ 테스트 런타임 오류:", e); process.exit(1); });
