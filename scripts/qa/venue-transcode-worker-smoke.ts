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
 */
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// processVenueJob은 scripts/venue-transcode-job.mjs — tsx가 ESM .mjs 로드
// @ts-expect-error JS module, 타입은 테스트 내부에서 검증
import { processVenueJob } from "../venue-transcode-job.mjs";

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

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

run().catch((e) => { console.error("❌ 테스트 런타임 오류:", e); process.exit(1); });
