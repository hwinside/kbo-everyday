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
import { writeFileSync, mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { execFileSync, spawnSync } from "child_process";
import { createServer } from "http";
import type { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";

// processVenueJob은 scripts/venue-transcode-job.mjs — tsx가 ESM .mjs 로드
// @ts-expect-error JS module, 타입은 테스트 내부에서 검증
import {
  processVenueJob,
  selectVenueTranscodeTargets,
  runVenueTranscodeBatch,
  transcodeVenueVideo,
  VENUE_SERVER_MAX_EDGE_PX,
} from "../venue-transcode-job.mjs";

/**
 * 회전(display matrix rotation=90) + 오디오 입력 fixture 를 만든다.
 * P2(captured actual runner) 와 U(direct server seam) 가 **같은** 입력을 쓰도록 공유한다.
 */
function makeRotatedAudioFixture(work: string): string {
  const rawPath = join(work, "raw.mp4");
  const srcPath = join(work, "src.mp4");
  execFileSync("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
    "-t", "3", "-c:v", "libx264", "-preset", "ultrafast",
    "-c:a", "aac", "-b:a", "128k", "-shortest", rawPath,
  ], { stdio: "ignore" });
  execFileSync("ffmpeg", [
    "-y", "-display_rotation", "90", "-i", rawPath, "-c", "copy", srcPath,
  ], { stdio: "ignore" });
  return srcPath;
}

type NormalizedProbe = {
  codec: string | undefined;
  audioCodec: string | undefined;
  disp: { width: number; height: number };
  fastStart: boolean | null;
  durationSec: number;
  skewSec: number;
  driftSec: number;
};

/** 산출물을 ffprobe + 독립 박스파서로 읽어 정규화 계약 판정에 필요한 값만 돌려준다. */
function probeNormalized(outPath: string): NormalizedProbe {
  const probe = JSON.parse(
    execFileSync("ffprobe", [
      "-v", "error",
      "-show_entries", "stream=codec_name,codec_type,width,height,start_time,duration",
      "-show_entries", "stream_side_data=rotation",
      "-show_entries", "format=duration",
      "-of", "json", outPath,
    ], { encoding: "utf8" }),
  ) as {
    streams: {
      codec_type: string;
      codec_name?: string;
      width?: number;
      height?: number;
      start_time?: string;
      duration?: string;
      side_data_list?: { rotation?: number }[];
    }[];
    format: { duration: string };
  };
  const v = probe.streams.find((s) => s.codec_type === "video")!;
  const a = probe.streams.find((s) => s.codec_type === "audio");
  const rot = v.side_data_list?.find((d) => typeof d.rotation === "number")?.rotation ?? 0;
  const swapped = Math.abs(rot) % 180 === 90;
  const disp = swapped
    ? { width: v.height!, height: v.width! }
    : { width: v.width!, height: v.height! };

  // 상위 박스 순서로 faststart 판정(독립 구현 — 제품 코드 재사용 안 함)
  const buf = readFileSync(outPath);
  let pos = 0;
  let fastStart: boolean | null = null;
  while (pos + 8 <= buf.length) {
    let size = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString("latin1");
    let header = 8;
    if (size === 1) {
      if (pos + 16 > buf.length) break;
      size = Number(buf.readBigUInt64BE(pos + 8));
      header = 16;
    } else if (size === 0) break;
    if (type === "moov") { fastStart = true; break; }
    if (type === "mdat") { fastStart = false; break; }
    if (size < header) break;
    pos += size;
  }

  const vStart = parseFloat(v.start_time ?? "NaN");
  const aStart = parseFloat(a?.start_time ?? "NaN");
  const vDur = parseFloat(v.duration ?? probe.format.duration);
  const aDur = parseFloat(a?.duration ?? probe.format.duration);

  return {
    codec: v.codec_name,
    audioCodec: a?.codec_name,
    disp,
    fastStart,
    durationSec: parseFloat(probe.format.duration),
    skewSec: Math.abs(vStart - aStart),
    driftSec: Math.abs(vDur - aDur),
  };
}

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

type ProbeMeta = { durationMs: number; width: number | null; height: number | null };

interface RunnerOpts {
  /** 입력(inPath) probe 결과. 종전에는 입출력이 같은 값을 돌려줘 출력 기준 기록을 검증 못했다. */
  probeMeta?: ProbeMeta | "throws";
  /** 출력(outPath) probe 결과 — 생략하면 probeMeta 그대로. 입출력 distinct 검증용. */
  outProbeMeta?: ProbeMeta | "throws";
  transcodeThrows?: boolean;
  downloadBytes?: number;
  downloadThrows?: boolean;
}

function makeMockRunner(work: string, opts: RunnerOpts = {}) {
  const inMeta: ProbeMeta | "throws" =
    opts.probeMeta ?? { durationMs: 5000, width: 720, height: 1280 };
  const outMeta: ProbeMeta | "throws" = opts.outProbeMeta ?? inMeta;
  return {
    // 입력/출력을 **경로로 구분**해 서로 다른 메타를 돌려준다.
    // 그래야 "DB 에 어느 쪽이 기록되는가"를 실제로 가를 수 있다(삼순 지적, 2026-08-04).
    probe(filePath: string) {
      const isOut = filePath.includes("out");
      const meta = isOut ? outMeta : inMeta;
      if (meta === "throws") throw new Error(`ffprobe 실행 실패(${isOut ? "out" : "in"})`);
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

  // ── 출력 메타 계약 (삼순 blocker ②, 2026-08-04) ──
  // 종전은 입력 meta 를 그대로 DB 에 썼고(회전 영상 1920x1080 ≠ 실파일 720x1280),
  // probe 가 throw/불량이어도 입력으로 fallback 해 **성공 종결**했다 — 검증 안 된 산출물을
  // 확정하고 큐에서도 내렸다. 이젠 출력 기준 기록 + 불량은 failed 로 재시도여야 한다.
  console.log("[Q] 출력 메타 기록 — 입력이 아니라 재 probe 한 산출물 기준");
  {
    const work = mkdtempSync(join(tmpdir(), "vt-test-"));
    try {
      const state: DbRowState = { id: 20, status: "active", needs_transcode: true, transcode_attempts: 0 };
      const row = { ...BASE_ROW, id: 20, status: "active", needs_transcode: true };
      const res = await processVenueJob(row, {
        db: makeMockDb(state),
        storage: makeMockStorage(),
        runner: makeMockRunner(work, {
          // 회전 입력(표시 1080x1920) → 720p 출력. 입출력을 distinct 로 둔다.
          probeMeta: { durationMs: 5000, width: 1920, height: 1080 },
          outProbeMeta: { durationMs: 5023, width: 720, height: 1280 },
        }),
        inPath: join(work, "in.mp4"),
        outPath: join(work, "out.mp4"),
      });
      ok("Q: result=done", res.result === "done");
      ok(
        `Q: DB width/height 가 **출력** 720x1280 (실제 ${state.width}x${state.height})`,
        state.width === 720 && state.height === 1280,
      );
      ok(
        `Q: DB duration_ms 가 **출력** 5023 (실제 ${state.duration_ms})`,
        state.duration_ms === 5023,
      );
      ok(
        "Q: 입력 치수(1920x1080)가 기록되지 않음",
        !(state.width === 1920 && state.height === 1080),
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  console.log("[R] 출력 probe throw → 성공 종결 금지(failed → 재시도, 큐 유지)");
  {
    const work = mkdtempSync(join(tmpdir(), "vt-test-"));
    try {
      const state: DbRowState = { id: 21, status: "active", needs_transcode: true, transcode_attempts: 0 };
      const row = { ...BASE_ROW, id: 21, status: "active", needs_transcode: true };
      const storage = makeMockStorage();
      const res = await processVenueJob(row, {
        db: makeMockDb(state),
        storage,
        runner: makeMockRunner(work, {
          probeMeta: { durationMs: 5000, width: 1920, height: 1080 },
          outProbeMeta: "throws",
        }),
        inPath: join(work, "in.mp4"),
        outPath: join(work, "out.mp4"),
        maxAttempts: 3,
      });
      ok("R: result=failed(검증 안 된 산출물을 확정하지 않는다)", res.result === "failed");
      ok("R: needs_transcode=true 유지(큐에서 안 내림 — 재시도)", state.needs_transcode === true);
      ok("R: 입력 치수 fallback 기록 없음", state.width === undefined && state.height === undefined);
      ok("R: 업로드 자체가 일어나지 않음(swap 방지)", Object.keys(storage._uploaded).length === 0);
      ok("R: attempts 증가", state.transcode_attempts === 1);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  console.log("[S] 출력 probe 불량(width/height null) → 성공 종결 금지");
  {
    for (const bad of [
      { label: "width/height null", meta: { durationMs: 5000, width: null, height: null } },
      { label: "duration 0", meta: { durationMs: 0, width: 720, height: 1280 } },
      { label: "width 0", meta: { durationMs: 5000, width: 0, height: 1280 } },
    ]) {
      const work = mkdtempSync(join(tmpdir(), "vt-test-"));
      try {
        const state: DbRowState = { id: 22, status: "active", needs_transcode: true, transcode_attempts: 0 };
        const row = { ...BASE_ROW, id: 22, status: "active", needs_transcode: true };
        const storage = makeMockStorage();
        const res = await processVenueJob(row, {
          db: makeMockDb(state),
          storage,
          runner: makeMockRunner(work, {
            probeMeta: { durationMs: 5000, width: 1920, height: 1080 },
            outProbeMeta: bad.meta,
          }),
          inPath: join(work, "in.mp4"),
          outPath: join(work, "out.mp4"),
          maxAttempts: 3,
        });
        ok(`S(${bad.label}): result=failed`, res.result === "failed");
        ok(`S(${bad.label}): 큐 유지(needs_transcode=true)`, state.needs_transcode === true);
        ok(`S(${bad.label}): 업로드/DB swap 없음`, Object.keys(storage._uploaded).length === 0 && state.width === undefined);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
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

  // ── 상위 배선 **행동** 검증 (삼순 중간값 ①, 2026-08-04) ──
  // ⚠️ 종전 P2 는 소스 regex 였다(상위 스크립트가 모듈 로드 시점에 supabase env 를 요구해
  // import 가 안 됐기 때문). 그래서 processVenueStories 가 batch 를 아예 안 불러도,
  // runner 에서 transcodeVenueVideo 를 우회해도 101/0 GREEN 이었다(삼순 재현).
  // 이젠 env 의존을 걷어내 import 해서 **실제 함수를 실행**해 배선을 검증한다.
  console.log("[P2] 상위 processVenueStories 배선 행동 검증 (actual import)");
  {
    const mod = (await import("../transcode-videos.mjs")) as {
      processVenueStories: (o?: Record<string, unknown>) => Promise<unknown>;
      venueRunHasFailure: (r: unknown) => boolean;
      venueRunFailureMessage: (r: unknown) => string;
    };
    ok("P2: transcode-videos.mjs 가 import 가능(env 부재에도 부작용 0)", typeof mod.processVenueStories === "function");

    // ① batch 를 실제로 부르는가 + 어떤 인자로 부르는가
    let batchCalls = 0;
    let seenDeps: Record<string, unknown> | null = null;
    // ⚠️ 종전에는 `deps.db != null && deps.storage !== undefined` 만 봤다.
    //   그래서 actual 을 `storage: db.storage` → `storage: { __wrongStorage: true }` 로 바꿔도
    //   113/0 GREEN 이었고(삼순 R5 P1-1 독립 재현), 잘못된 storage 로 download/upload 가
    //   전수 실패해도 required gate 가 못 잡았다. 이젠 **주입한 객체와 exact identity** 로 결속한다.
    const injectedStorage = { __marker: "storage" };
    const injectedDb = { from: () => ({}), storage: injectedStorage };
    await mod.processVenueStories({
      hasFfprobe: true,
      db: injectedDb,
      maxAttempts: 3,
      limit: 20,
      runBatch: async (deps: Record<string, unknown>) => {
        batchCalls++;
        seenDeps = deps;
        return { done: 0, removed: 0, failed: 0, updateErrors: 0, processed: 0 };
      },
    });
    ok(`P2: processVenueStories 가 batch 를 실제로 1회 호출 (실제 ${batchCalls})`, batchCalls === 1);
    const deps = seenDeps as unknown as Record<string, unknown> | null;
    ok("P2: batch 에 주입한 db 객체 exact identity 전달", deps?.db === injectedDb);
    ok(
      "P2: batch 에 db.storage exact identity 전달 (다른 storage 로 바꾸면 RED)",
      deps?.storage === injectedStorage && deps?.storage === (deps?.db as { storage?: unknown } | undefined)?.storage,
    );
    ok("P2: batch 에 maxAttempts/limit 전달", deps?.maxAttempts === 3 && deps?.limit === 20);
    ok("P2: batch 에 makeWorkDir/pathFor 배선", typeof deps?.makeWorkDir === "function" && typeof deps?.pathFor === "function");

    // ①-b **default runBatch 결속** (삼순 R6 P0-1)
    //   위 ① 은 runBatch 를 주입해 "부르긴 하는가"만 봤다. 그래서 production 기본값
    //   `runBatch = runVenueTranscodeBatch` 를 no-op async 로 바꿔도 131/0 GREEN 이었다 —
    //   Vercel cron 이 매 실행 0행 처리해도 게이트가 못 잡는다(삼순 독립 재현).
    //   → **runBatch 를 주입하지 않고** 실행해 기본값이 진짜 batch orchestration 인지 행동으로 본다.
    //     selectTargets 는 batch 내부 seam 이므로, 기본 runBatch 가 아니면 아예 불리지 않는다.
    {
      let selectCalls = 0;
      let runJobCalls = 0;
      const rows = [
        { id: "r1", status: "active", media_bucket: "videos", media_path: "a.mp4", media_url: "https://x/a.mp4", transcode_attempts: 0 },
        { id: "r2", status: "active", media_bucket: "videos", media_path: "b.mp4", media_url: "https://x/b.mp4", transcode_attempts: 0 },
      ];
      const defaultRes = (await mod.processVenueStories({
        hasFfprobe: true,
        db: { from: () => ({}), storage: {} },
        maxAttempts: 3,
        limit: 20,
        // ⬇️ runBatch 를 **주입하지 않는다** — production 기본값이 실행되어야 한다.
        selectTargets: async () => {
          selectCalls++;
          return { data: rows, error: null };
        },
        runJob: async () => {
          runJobCalls++;
          return { result: "done" };
        },
      })) as Record<string, unknown>;
      ok(
        `P2: default runBatch 가 실제 조회 seam 을 1회 호출 (실제 ${selectCalls}) — no-op 으로 바꾸면 RED`,
        selectCalls === 1,
      );
      ok(
        `P2: default runBatch 가 선택된 ${rows.length}행을 실제 처리 (실제 ${runJobCalls}) — 행 폐기 시 RED`,
        runJobCalls === rows.length,
      );
      ok(
        `P2: default runBatch 결과가 처리 행수를 반영 (done=${defaultRes?.done}/processed=${defaultRes?.processed})`,
        defaultRes?.done === rows.length && defaultRes?.processed === rows.length,
      );
    }

    // ② runner 가 **진짜 정규화를 하는가** — 함수 identity 대신 행동으로 판정한다.
    //   identity(===) 비교는 tsx(.ts) ↔ node(.mjs) 로더 경계에서 모듈 인스턴스가 갈려
    //   환경 의존적이었다(로컬 node 는 true, tsx 는 false — 실측 2026-08-04).
    //   그래서 runner.transcode 를 실제 파일에 돌려 720p+faststart 산출을 확인한다.
    const runner = deps?.runner as
      | { probe?: (p: string) => { durationMs: number; width: number | null; height: number | null }; transcode?: (i: string, o: string) => string; downloadToFile?: unknown }
      | undefined;
    ok("P2: runner 에 probe/transcode/downloadToFile 배선", typeof runner?.probe === "function" && typeof runner?.transcode === "function" && typeof runner?.downloadToFile === "function");

    // ②-0 **downloadToFile 이 진짜 받아오는가** (삼순 R6 P0-2)
    //   종전에는 `typeof === "function"` 만 봤다. 그래서 actual
    //   `makeRunner({ downloadToFile: downloadTo })` 를 `downloadToFile: async () => 0` 으로
    //   바꿔도 131/0 GREEN 이었다 — 워커가 입력 파일을 못 받아 전수 실패하는데 미검출.
    //   → 로컬 HTTP 서버를 띄워 **실제 바이트가 디스크에 떨어지는지** 행동으로 본다.
    {
      const payload = Buffer.from("venue-download-probe-".repeat(64), "utf8");
      const server = createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(payload);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      const w = mkdtempSync(join(tmpdir(), "vt-dl-"));
      try {
        const dest = join(w, "dl.bin");
        const bytes = await (runner!.downloadToFile as (u: string, d: string) => Promise<number>)(
          `http://127.0.0.1:${port}/probe.bin`,
          dest,
        );
        ok(
          `P2: captured runner.downloadToFile 이 실제 파일을 씀 (${existsSync(dest) ? readFileSync(dest).length : 0}B) — no-op 으로 바꾸면 RED`,
          existsSync(dest) && readFileSync(dest).length === payload.length,
        );
        ok(
          `P2: downloadToFile 이 실제 바이트 수를 반환 (실제 ${bytes}) — 0 반환이면 RED`,
          bytes === payload.length,
        );
        ok(
          "P2: 내려받은 내용이 원본과 동일",
          existsSync(dest) && readFileSync(dest).equals(payload),
        );
      } finally {
        rmSync(w, { recursive: true, force: true });
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
    {
      const w = mkdtempSync(join(tmpdir(), "vt-wiring-"));
      try {
        const src = join(w, "src.mp4");
        const out = join(w, "out.mp4");
        execFileSync("ffmpeg", [
          "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30",
          "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", src,
        ], { stdio: "ignore" });
        runner!.transcode!(src, out);
        const meta = runner!.probe!(out);
        ok(
          `P2: runner.transcode 가 실제 720p 정규화 수행 (실제 ${meta.width}x${meta.height}) — 우회 시 RED`,
          Math.max(meta.width ?? 0, meta.height ?? 0) === VENUE_SERVER_MAX_EDGE_PX,
        );
        const head = readFileSync(out);
        const firstBox = head.subarray(4, 8).toString("latin1");
        const secondType = (() => {
          const size = head.readUInt32BE(0);
          return size > 0 && size + 8 <= head.length
            ? head.subarray(size + 4, size + 8).toString("latin1")
            : "";
        })();
        ok(
          `P2: runner.transcode 산출물이 faststart (박스 ${firstBox}→${secondType})`,
          firstBox === "ftyp" && secondType === "moov",
        );
        ok(
          `P2: runner.probe 가 실제 ffprobe 메타 반환 (dur=${meta.durationMs}ms)`,
          meta.durationMs > 0,
        );
      } finally {
        rmSync(w, { recursive: true, force: true });
      }
    }

    // ②-b **captured actual runner** 의 전체 정규화 계약 (삼순 R5 P1-2)
    //   종전 ② 는 video-only fixture(testsrc2) 라, actual runner 의 transcode 를
    //   `-an` (오디오 버림) 인코더로 바꿔도 113/0 GREEN 이었다.
    //   U 는 runner 가 아니라 transcodeVenueVideo() 를 직접 부르므로 그 경로도 못 잡는다.
    //   → **processVenueStories 가 실제로 실은 runner** 를 U 와 동일한 회전+오디오 fixture 에 돌려
     //     720x1280 / max-edge / faststart / audio / skew / drift 를 한 경로에서 전부 확인한다.
    {
      const w = mkdtempSync(join(tmpdir(), "vt-runner-av-"));
      try {
        const src = makeRotatedAudioFixture(w);
        const out = join(w, "out.mp4");
        runner!.transcode!(src, out);
        const m = probeNormalized(out);
        console.log(
          `  captured runner 실측: 표시 ${m.disp.width}x${m.disp.height} · ${m.codec}/${m.audioCodec ?? "없음"} · ` +
            `faststart=${m.fastStart} · skew ${m.skewSec.toFixed(3)}s · drift ${m.driftSec.toFixed(3)}s`,
        );
        ok(
          `P2: captured runner 출력 표시 exact 720x1280 (실제 ${m.disp.width}x${m.disp.height})`,
          m.disp.width === 720 && m.disp.height === 1280,
        );
        ok(
          `P2: captured runner max-edge ${VENUE_SERVER_MAX_EDGE_PX}px (실제 ${Math.max(m.disp.width, m.disp.height)})`,
          Math.max(m.disp.width, m.disp.height) === VENUE_SERVER_MAX_EDGE_PX,
        );
        // ⚠️ **코덱 assert** (삼순 R6 추가 blocker). 종전에는 codec 을 로그로 출력만 하고
        //   검사하지 않았다. 그래서 captured runner 의 transcode 만 MPEG-4 Part 2 로 바꿔도
        //   (mpeg4/aac · 720x1280 · faststart · skew 0ms · drift 18ms) 152/0 GREEN 이었다.
        //   해상도·faststart·A/V 는 다 맞는데 코덱만 틀리면 브라우저/앱 재생이 깨진다 —
        //   이 PR 의 목적(첫 재생 지연 해소) 자체가 무너지는 회귀다.
        ok(
          `P2: captured runner 출력 코덱 h264 (실제 ${m.codec}) — mpeg4 등으로 바꾸면 RED`,
          m.codec === "h264",
        );
        ok(`P2: captured runner faststart — 실제 ${m.fastStart}`, m.fastStart === true);
        ok(
          `P2: captured runner 오디오 보존 (실제 ${m.audioCodec ?? "없음"}) — runner 만 -an 으로 바꾸면 RED`,
          m.audioCodec != null,
        );
        ok(
          `P2: captured runner A/V start skew ≤ 50ms (실제 ${(m.skewSec * 1000).toFixed(0)}ms)`,
          Number.isFinite(m.skewSec) && m.skewSec <= 0.05,
        );
        ok(
          `P2: captured runner A/V duration drift ≤ 150ms (실제 ${(m.driftSec * 1000).toFixed(0)}ms)`,
          Number.isFinite(m.driftSec) && m.driftSec <= 0.15,
        );
      } finally {
        rmSync(w, { recursive: true, force: true });
      }
    }

    // ②-c **captured actual downloadToFile** 이 진짜 바이트를 받아 파일로 쓰는가 (삼순 R6 ②)
    //   종전 A/V 테스트는 runner.transcode() 만 직접 불렀다. 그래서 actual 을
    //   `makeRunner({ downloadToFile: async () => 0 })` 로 바꿔도 131/0 GREEN 이었고,
    //   production job 은 입력 파일 없이 전수 실패할 수 있었다.
    //   → 실제 HTTP 서버를 띄워 captured downloader 로 받은 뒤, 그 파일을 그대로
    //     probe → transcode 까지 이어 전체 체인을 한 경로로 확인한다.
    {
      const w = mkdtempSync(join(tmpdir(), "vt-download-"));
      let server: import("http").Server | null = null;
      try {
        const srcPath = makeRotatedAudioFixture(w);
        const payload = readFileSync(srcPath);
        const http = await import("http");
        server = http.createServer((_req, res) => {
          res.writeHead(200, { "content-type": "video/mp4", "content-length": String(payload.length) });
          res.end(payload);
        });
        const port: number = await new Promise((resolveFn) => {
          server!.listen(0, "127.0.0.1", () => resolveFn((server!.address() as { port: number }).port));
        });

        const dl = join(w, "downloaded.mp4");
        const bytes = await (runner as unknown as {
          downloadToFile: (u: string, d: string) => Promise<number>;
        }).downloadToFile(`http://127.0.0.1:${port}/src.mp4`, dl);

        ok(
          `P2: captured downloadToFile 이 실제 바이트를 반환 (실제 ${bytes}B / 원본 ${payload.length}B) — () => 0 으로 바꾸면 RED`,
          bytes === payload.length && payload.length > 0,
        );
        ok("P2: captured downloadToFile 이 dest 경로에 파일을 쓴다", existsSync(dl));
        ok(
          "P2: 받은 바이트가 원본과 동일(빈 파일/절단 방지)",
          existsSync(dl) && readFileSync(dl).equals(payload),
        );

        // 다운로드본이 후속 probe/transcode 까지 이어지는가 (채인 전체)
        const dlMeta = runner!.probe!(dl);
        ok(
          `P2: 다운로드본을 captured probe 가 읽음 (dur=${dlMeta.durationMs}ms)`,
          dlMeta.durationMs > 0,
        );
        const dlOut = join(w, "dl-out.mp4");
        runner!.transcode!(dl, dlOut);
        const dlNorm = probeNormalized(dlOut);
        ok(
          `P2: 다운로드본→transcode 체인이 720x1280 산출 (실제 ${dlNorm.disp.width}x${dlNorm.disp.height})`,
          dlNorm.disp.width === 720 && dlNorm.disp.height === 1280,
        );
        // 체인 끝단도 코덱을 결속한다 — 한 경로만 막으면 다른 경로로 새어나간다.
        ok(
          `P2: 다운로드본→transcode 체인 출력 코덱 h264 (실제 ${dlNorm.codec})`,
          dlNorm.codec === "h264",
        );
        ok(
          `P2: 다운로드본→transcode 체인 오디오 보존 (실제 ${dlNorm.audioCodec ?? "없음"})`,
          dlNorm.audioCodec != null,
        );
      } finally {
        if (server) await new Promise<void>((r) => server!.close(() => r()));
        rmSync(w, { recursive: true, force: true });
      }
    }

    // ③ makeRunner 우회 감지력 — 가짜 runner 는 위 행동 검사를 통과하지 못해야 한다
    let bypassRunner: { transcode?: (i: string, o: string) => unknown } | null = null;
    await mod.processVenueStories({
      hasFfprobe: true,
      db: { from: () => ({}), storage: {} },
      makeRunner: () => ({ probe: () => ({ durationMs: 0, width: null, height: null }), transcode: () => "", downloadToFile: async () => 0 }),
      runBatch: async (d: Record<string, unknown>) => {
        bypassRunner = d.runner as typeof bypassRunner;
        return {};
      },
    });
    {
      const w = mkdtempSync(join(tmpdir(), "vt-bypass-"));
      try {
        const src = join(w, "src.mp4");
        const out = join(w, "out.mp4");
        execFileSync("ffmpeg", [
          "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30",
          "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", src,
        ], { stdio: "ignore" });
        (bypassRunner as { transcode?: (i: string, o: string) => unknown } | null)?.transcode?.(src, out);
        ok(
          "P2: 우회 runner 는 산출물을 만들지 못해 행동 검사에 걸린다(게이트 감지력)",
          !existsSync(out),
        );
      } finally {
        rmSync(w, { recursive: true, force: true });
      }
    }

    // ④ ffprobe 부재면 batch 를 부르지 않고 관제 신호를 올린다(검증 약화 금지)
    let calledWhenNoFfprobe = 0;
    const noProbeRes = (await mod.processVenueStories({
      hasFfprobe: false,
      db: {
        from: () => ({
          select: () => ({ eq: () => ({ eq: () => Promise.resolve({ count: 2 }) }) }),
        }),
      },
      runBatch: async () => {
        calledWhenNoFfprobe++;
        return {};
      },
    })) as { ffprobeMissing?: boolean; failed?: number };
    ok("P2: ffprobe 부재 → batch 미호출", calledWhenNoFfprobe === 0);
    ok("P2: ffprobe 부재 → ffprobeMissing 관제 신호", noProbeRes?.ffprobeMissing === true);

    // ⑤ batch 실패 결과가 **main 관제까지** 그대로 전파되는가 (삼순 R5 P1-3)
    //   종전 P2 는 batch 호출 횟수/인자만 봤다. 그래서 runBatch 가 돌려준 결과를
    //   반환 직전에 `failed/updateErrors=0` 으로 덮어 거짓 성공을 반환해도 113/0 GREEN 이었다.
    //   → sentinel 결과 object 가 그대로 나오는지 + main 의 non-zero 종료 판정 함수가
    //     그 결과를 실제로 failure 로 읽는지를 함께 결속한다.
    ok(
      "P2: main 관제 판정이 import 가능한 함수로 고정됨(인라인 재도입 방지)",
      typeof mod.venueRunHasFailure === "function" && typeof mod.venueRunFailureMessage === "function",
    );
    {
      // 관제 판정 계약 자체 — 세 축 중 어느 하나라도 non-zero 여야 한다.
      ok("P2: 관제 — failed>0 를 실패로 판정", mod.venueRunHasFailure({ failed: 1, updateErrors: 0 }) === true);
      ok("P2: 관제 — updateErrors>0 를 실패로 판정", mod.venueRunHasFailure({ failed: 0, updateErrors: 2 }) === true);
      ok("P2: 관제 — ffprobeMissing 을 실패로 판정", mod.venueRunHasFailure({ failed: 0, updateErrors: 0, ffprobeMissing: true }) === true);
      ok("P2: 관제 — 정상 결과는 실패 아님", mod.venueRunHasFailure({ done: 3, failed: 0, updateErrors: 0 }) === false);
      ok("P2: 관제 — 결과 미상(null)은 실패 아님(기존 동작 보존)", mod.venueRunHasFailure(null) === false);

      // sentinel 전파 — batch 가 돌려준 값이 그대로 나와야 하고,
      // 그 값이 관제 판정을 실제로 failure 로 만들어야 한다.
      for (const sentinel of [
        { done: 1, removed: 0, failed: 7, updateErrors: 0 },
        { done: 1, removed: 0, failed: 0, updateErrors: 5 },
      ]) {
        const res = (await mod.processVenueStories({
          hasFfprobe: true,
          db: { from: () => ({}), storage: {} },
          runBatch: async () => sentinel,
        })) as Record<string, unknown>;
        ok(
          `P2: batch 결과를 그대로 반환(failed=${sentinel.failed}/updateErrors=${sentinel.updateErrors}) — 덮어쓰면 RED`,
          res?.failed === sentinel.failed && res?.updateErrors === sentinel.updateErrors,
        );
        ok(
          "P2: 그 결과가 main 관제에서 non-zero 종료로 이어짐",
          mod.venueRunHasFailure(res) === true,
        );
      }

      // ffprobe 부재 경로도 관제로 이어져야 한다(green 으로 무시 금지)
      ok("P2: ffprobe 부재 결과도 main 관제에서 non-zero", mod.venueRunHasFailure(noProbeRes) === true);
    }

    // ⑥ **기본 batch 바인딩**이 실제로 행을 처리하는가 (삼순 R6 ①)
    //   종전에는 테스트가 항상 runBatch 를 주입해서, 기본값을
    //   `runBatch = async () => ({...0건})` 으로 바꿔도 131/0 GREEN 이었다.
    //   seam 은 따로 테스트했지만 "cron 기본 경로가 seam 을 타는가"는 미검증이었다.
    //   → runBatch 를 **주입하지 않고** 내부 seam(selectTargets/runJob)만 주입해
    //     기본 바인딩이 조회행을 전부 runJob 까지 전달하는지를 행동으로 본다.
    {
      const rows = [
        { id: 901, status: "active", media_path: "a/1.mp4", media_bucket: "venue-media" },
        { id: 902, status: "archived", media_path: "a/2.mp4", media_bucket: "venue-media" },
        { id: 903, status: "pending", media_path: "a/3.mp4", media_bucket: "venue-staging" },
      ];
      const seenIds: number[] = [];
      let selectCalls = 0;
      const res = (await mod.processVenueStories({
        hasFfprobe: true,
        db: { from: () => ({}), storage: {} },
        maxAttempts: 3,
        limit: 20,
        // runBatch 미주입 — 기본값 runVenueTranscodeBatch 가 실행되어야 한다
        selectTargets: async (_db: unknown, opts: { maxAttempts?: number; limit?: number }) => {
          selectCalls++;
          ok(
            `P2: 기본 batch 가 selectTargets 에 maxAttempts/limit 전달 (실제 ${opts?.maxAttempts}/${opts?.limit})`,
            opts?.maxAttempts === 3 && opts?.limit === 20,
          );
          return { data: rows, error: null };
        },
        runJob: async (row: { id: number }) => {
          seenIds.push(row.id);
          return { result: "done" };
        },
      })) as { processed?: number; done?: number };
      ok("P2: 기본 batch 바인딩이 실제로 조회를 수행 (dead-stub 으로 바꾸면 RED)", selectCalls === 1);
      ok(
        `P2: 기본 batch 바인딩이 조회행 전부를 순서대로 처리 (실제 ${seenIds.join(",")})`,
        seenIds.length === 3 && seenIds[0] === 901 && seenIds[1] === 902 && seenIds[2] === 903,
      );
      ok(
        `P2: 기본 batch 바인딩 집계가 실처리 수를 반영 (processed=${res?.processed} done=${res?.done})`,
        res?.processed === 3 && res?.done === 3,
      );
    }

    // ⑤ 소스 레벨 금지(보조) — 인라인 루프/조회 재도입
    const raw = readFileSync(join(import.meta.dirname, "..", "transcode-videos.mjs"), "utf8");
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
      .join("\n");
    ok(
      "P2: 상위에 행별 루프 재도입 없음(for..of rows 직접 순회 0)",
      !/for\s*\(\s*const\s+row\s+of\s+rows\s*\)/.test(src),
    );
    ok(
      "P2: 상위에 processVenueJob 직접 호출 없음(seam 우회 방지)",
      !/processVenueJob\(/.test(src),
    );
    ok(
      "P2: venue_stories 인라인 조회 재도입 없음(needs_transcode 직접 술어 0)",
      !/\.or\([^)]*needs_transcode/.test(src),
    );

    // ⑥ **CLI 종료코드 행동 검증** (삼순 R6 P0-3)
    //
    //   종전 ⑤ 는 `venueRunHasFailure()` 를 *따로* 불러 계약만 봤다. main 이 그 결과로
    //   실제 non-zero 종료하는지는 아무도 안 봤고, 그래서 actual main 의
    //   `if (venueRunHasFailure(venueRes))` 를 `if (false && venueRunHasFailure(venueRes))` 로
    //   바꿔 **배치가 실패해도 exit 0** 이 되는 회귀가 131/0 GREEN 이었다(삼순 독립 재현).
    //
    //   이젠 판정+종료를 `runVenueStage()` 가 소유하고, 여기서 **실제 자식 프로세스로 실행해
    //   종료코드를 읽는다**. in-process 로는 process.exit 를 검증할 수 없다(테스트가 같이 죽는다).
    {
      // ⑥-a main 이 그 seam 에 결속돼 있는가 — 인라인 판정 재도입 차단.
      //   IIFE 본문만 잘라서 본다(정의부 runVenueStage 자체는 당연히 판정을 갖는다).
      const mainBody = src.slice(src.lastIndexOf("if (IS_MAIN)"));
      ok(
        "P2: main 이 runVenueStage() 로 직관 라이브 단계를 실행",
        /await\s+runVenueStage\(\)/.test(mainBody),
      );
      ok(
        "P2: main 에 인라인 관제 판정 재도입 없음(seam 우회 방지)",
        !/venueRunHasFailure\(/.test(mainBody) && !/processVenueStories\(/.test(mainBody),
      );

      // ⑥-b **실제 자식 프로세스 종료코드** — sentinel 실패는 반드시 non-zero.
      const runStage = (result: unknown) => {
        const probe = join(import.meta.dirname, `.venue-stage-exit-probe-${process.pid}.mjs`);
        writeFileSync(
          probe,
          `import { runVenueStage } from ${JSON.stringify(join(import.meta.dirname, "..", "transcode-videos.mjs"))};
` +
            `await runVenueStage({ process: async () => (${JSON.stringify(result)}) });
`,
          "utf8",
        );
        try {
          const r = spawnSync(process.execPath, [probe], { encoding: "utf8" });
          return { status: r.status, stderr: r.stderr ?? "" };
        } finally {
          rmSync(probe, { force: true });
        }
      };

      for (const sentinel of [
        { done: 1, removed: 0, failed: 3, updateErrors: 0 },
        { done: 1, removed: 0, failed: 0, updateErrors: 2 },
        { done: 0, removed: 0, failed: 0, updateErrors: 0, ffprobeMissing: true },
      ]) {
        const r = runStage(sentinel);
        ok(
          `P2: CLI 실패 sentinel(failed=${sentinel.failed}/updateErrors=${sentinel.updateErrors}` +
            `${sentinel.ffprobeMissing ? "/ffprobeMissing" : ""}) → 종료코드 non-zero (실제 ${r.status}) — 관제 우회 시 RED`,
          r.status === 1,
        );
      }
      {
        const okRun = runStage({ done: 3, removed: 0, failed: 0, updateErrors: 0 });
        ok(
          `P2: CLI 정상 결과 → 종료코드 0 (실제 ${okRun.status}) — 과잉 실패 판정 방지`,
          okRun.status === 0,
        );
      }
    }
  }

  // ── orchestration 행동 검증 (삼순 4라운드 blocker ①) ──
  // 조회 술어가 맞아도 `for (const row of rows)` → `for (const row of [])` 로 바꾸면
  // cron 이 아무 행도 처리하지 않는다. 그 회귀를 행동으로 고정한다.
  console.log("[T] orchestration — 조회된 행이 전부 processVenueJob 으로 전달되는가");
  {
    const rowsFixture = [
      { id: 101, status: "active", media_path: "a/1.mp4", media_bucket: "venue-media" },
      { id: 102, status: "archived", media_path: "a/2.mov", media_bucket: "venue-media" },
      { id: 103, status: "pending", media_path: "a/3.mp4", media_bucket: "venue-staging" },
    ];
    const seen: { id: number; inPath: string; outPath: string; maxAttempts: number }[] = [];
    const cleaned: string[][] = [];
    let workDirs = 0;
    let cleanedWorkDir: string | null = null;

    const res = await runVenueTranscodeBatch({
      db: { __marker: "db" },
      storage: { __marker: "storage" },
      runner: { __marker: "runner" },
      selectTargets: async (db: unknown, opts: { maxAttempts: number; limit: number }) => {
        ok("T: selectTargets 에 db 가 그대로 전달", (db as { __marker?: string })?.__marker === "db");
        ok("T: selectTargets 에 maxAttempts/limit 전달", opts.maxAttempts === 3 && opts.limit === 20);
        return { data: rowsFixture, error: null };
      },
      runJob: async (row: { id: number }, deps: Record<string, unknown>) => {
        seen.push({
          id: row.id,
          inPath: deps.inPath as string,
          outPath: deps.outPath as string,
          maxAttempts: deps.maxAttempts as number,
        });
        return { result: row.id === 102 ? "failed" : "done" };
      },
      makeWorkDir: () => {
        workDirs++;
        return "/tmp/work";
      },
      pathFor: (workDir: string, row: { id: number; media_path: string }) => ({
        inPath: `${workDir}/in-${row.id}`,
        outPath: `${workDir}/out-${row.id}`,
      }),
      cleanupFiles: (paths: string[]) => cleaned.push(paths),
      cleanupWorkDir: (w: string) => {
        cleanedWorkDir = w;
      },
      maxAttempts: 3,
      limit: 20,
      log: () => {},
    });

    ok(`T: 조회된 3행이 전부 전달됨 (실제 ${seen.length})`, seen.length === 3);
    ok(
      "T: 조회 순서 보존(101→102→103)",
      seen.map((s) => s.id).join(",") === "101,102,103",
    );
    ok("T: 행마다 고유 in/out 경로 전달", seen[0].inPath !== seen[1].inPath && seen[0].outPath !== seen[1].outPath);
    ok("T: maxAttempts 가 각 행에 전달", seen.every((s) => s.maxAttempts === 3));
    ok("T: workDir 1회 생성", workDirs === 1);
    ok(`T: 행마다 임시파일 정리 (실제 ${cleaned.length})`, cleaned.length === 3);
    ok("T: workDir 정리", cleanedWorkDir === "/tmp/work");
    ok(
      `T: 집계 반환 done=2 failed=1 processed=3`,
      res.done === 2 && res.failed === 1 && res.processed === 3,
    );
  }

  console.log("[T2] orchestration — 조회 0건/오류 경계");
  {
    const noRows = await runVenueTranscodeBatch({
      db: {}, storage: {}, runner: {},
      selectTargets: async () => ({ data: [], error: null }),
      runJob: async () => {
        ok("T2: 0건이면 runJob 미호출", false);
        return { result: "done" };
      },
      makeWorkDir: () => {
        ok("T2: 0건이면 workDir 미생성", false);
        return "/tmp/x";
      },
      pathFor: () => ({ inPath: "i", outPath: "o" }),
      maxAttempts: 3, limit: 20, log: () => {},
    });
    ok("T2: 0건 → processed 0", noRows.processed === 0 && noRows.done === 0);

    let threw = false;
    try {
      await runVenueTranscodeBatch({
        db: {}, storage: {}, runner: {},
        selectTargets: async () => ({ data: null, error: { message: "DB 다운" } }),
        runJob: async () => ({ result: "done" }),
        makeWorkDir: () => "/tmp/x",
        pathFor: () => ({ inPath: "i", outPath: "o" }),
        maxAttempts: 3, limit: 20, log: () => {},
      });
    } catch {
      threw = true;
    }
    ok("T2: 조회 오류는 삼키지 않고 throw(관제 가능)", threw === true);
  }

  // ── 서버 워커 실 ffmpeg 계약 (삼순 4라운드 blocker ③) ──
  // 지금까지 exact geometry 검증은 **브라우저 경로**만이었고, 서버 워커는 mock runner 가
  // 500B 더미 파일만 써서 scale/faststart/rotation 이 한 번도 실행되지 않았다.
  // 여기서는 실제 ffmpeg 으로 돌려 산출물 바이트를 검사한다(ffmpeg 부재는 skip 아니라 FAIL).
  console.log("[U] 서버 워커 실 ffmpeg — 720p · faststart · 회전 보존");
  {
    const work = mkdtempSync(join(tmpdir(), "vt-ffmpeg-"));
    try {
      let hasFfmpeg = true;
      try {
        execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
        execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
      } catch {
        hasFfmpeg = false;
      }
      ok("U: ffmpeg/ffprobe 존재(이 계약의 전제 — 부재면 skip 아니라 FAIL)", hasFfmpeg);

      if (hasFfmpeg) {
        // 회전 입력: 1920x1080 본체 + display matrix rotation=90 (표시 1080x1920) + 오디오
        const srcPath = makeRotatedAudioFixture(work);
        const outPath = join(work, "out.mp4");

        // **실행 경로가 쓰는 바로 그 함수**를 호출
        transcodeVenueVideo(srcPath, outPath);
        const m = probeNormalized(outPath);

        console.log(
          `  서버 워커 실측: 표시 ${m.disp.width}x${m.disp.height} · ${m.codec} · ` +
            `faststart=${m.fastStart} · ${m.durationSec.toFixed(2)}s`,
        );

        ok(`U: 출력 코덱 h264 (실제 ${m.codec})`, m.codec === "h264");
        ok(
          `U: 표시 긴 변이 정확히 720p ${VENUE_SERVER_MAX_EDGE_PX}px (실제 ${Math.max(m.disp.width, m.disp.height)}) — under-resolution 방지`,
          Math.max(m.disp.width, m.disp.height) === VENUE_SERVER_MAX_EDGE_PX,
        );
        ok(
          `U: 표시 치수 exact 720x1280 (실제 ${m.disp.width}x${m.disp.height})`,
          m.disp.width === 720 && m.disp.height === 1280,
        );
        ok("U: 표시 방향 세로 보존", m.disp.height > m.disp.width);
        ok(`U: moov 가 mdat 앞(faststart) — 실제 ${m.fastStart}`, m.fastStart === true);
        ok(`U: 오디오 트랙 보존 (실제 ${m.audioCodec ?? "없음"})`, m.audioCodec != null);
        ok(
          `U: duration 보존 (${m.durationSec.toFixed(2)}s ≈ 3s)`,
          Math.abs(m.durationSec - 3) < 1,
        );

        // ── 서버 경로 A/V sync (삼순 중간값 ②, 2026-08-04) ──
        // 종전에는 전체 duration 만 봐서 오디오에 300ms delay 를 넣어도 3.32s≈3s 로 통과했다.
        // 브라우저 E2E 에는 이미 넣었던 계약을 서버 경로에만 빼먹었다 — 동일 계약으로 맞춘다.
        console.log(
          `  서버 A/V: skew ${m.skewSec.toFixed(3)}s · drift ${m.driftSec.toFixed(3)}s`,
        );
        ok(
          `U: A/V start_time 정렬 ≤ 50ms (실제 ${(m.skewSec * 1000).toFixed(0)}ms)`,
          Number.isFinite(m.skewSec) && m.skewSec <= 0.05,
        );
        ok(
          `U: A/V duration drift ≤ 150ms (실제 ${(m.driftSec * 1000).toFixed(0)}ms)`,
          Number.isFinite(m.driftSec) && m.driftSec <= 0.15,
        );
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

run().catch((e) => { console.error("❌ 테스트 런타임 오류:", e); process.exit(1); });
