/**
 * 직관 라이브 미디어 프로브 + cleanup orphan 정책 순수 스모크.
 * 실행: npm run qa:venue-media
 * 배경: PR #689 삼순 3차 NO-GO — Range 무시 200 대용량 선제 차단, magic mismatch,
 *       cleanup timestamp 불명 fail-open 방지.
 */
import {
  parseTotalSize,
  decideProbe,
  magicMediaType,
  probeMediaObject,
  PROBE_HEAD_BYTES,
} from "../../src/lib/venue-stories/media-probe";
import { shouldDeleteOrphanFile } from "../../src/lib/venue-stories/cleanup-policy";
import {
  checkVenueMediaLimits,
  VENUE_VIDEO_TOO_LONG_MSG,
  VENUE_VIDEO_TOO_HEAVY_MSG,
  VENUE_IMAGE_TOO_HEAVY_MSG,
} from "../../src/lib/venue-stories/media-limits";
import {
  VENUE_STORY_MAX_BYTES,
  VENUE_STORY_PUBLIC_VIDEO_MAX_BYTES,
  VENUE_STORY_MAX_DURATION_MS,
  VENUE_STORY_DURATION_TOLERANCE_MS,
} from "../../src/lib/venue-stories/types";
import {
  shouldAutoCompressVideo,
  computeTargetVideoBitrate,
  computeRetryBitrate,
  computeScaledDimensions,
  computeNegativeStartTrim,
  executeWithDeadline,
  VENUE_VIDEO_COMPRESS_TARGET_BYTES,
  VENUE_VIDEO_AUDIO_RESERVE_BPS,
  VENUE_VIDEO_MAX_BITRATE_BPS,
  VENUE_VIDEO_MIN_BITRATE_BPS,
} from "../../src/lib/venue-stories/video-compress";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

const MAX = VENUE_STORY_MAX_BYTES;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GARBAGE = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);

console.log("[magicMediaType]");
ok("JPEG → image", magicMediaType(JPEG) === "image");
ok("PNG → image", magicMediaType(PNG) === "image");
ok("MP4 ftyp → video", magicMediaType(MP4) === "video");
ok("garbage → null", magicMediaType(GARBAGE) === null);

console.log("[parseTotalSize]");
ok("206 content-range → total", parseTotalSize(206, "bytes 0-63/12345", null) === 12345);
ok("206 content-range '*' → null", parseTotalSize(206, "bytes 0-63/*", null) === null);
ok("200 + content-length(Range 무시) → total", parseTotalSize(200, null, "999999") === 999999);
ok("206 without range header + content-length → null(부분크기 오인 방지)", parseTotalSize(206, null, "64") === null);
ok("헤더 없음 → null", parseTotalSize(200, null, null) === null);

console.log("[decideProbe]");
ok("정상 image → ok", decideProbe({ total: 1000, head: JPEG, declaredType: "image", maxBytes: MAX }).ok === true);
ok("total 미상 → no_size", decideProbe({ total: null, head: JPEG, declaredType: "image", maxBytes: MAX }).reason === "no_size");
ok("total 0 → no_size", decideProbe({ total: 0, head: JPEG, declaredType: "image", maxBytes: MAX }).reason === "no_size");
ok("초과 → too_large", decideProbe({ total: MAX + 1, head: JPEG, declaredType: "image", maxBytes: MAX }).reason === "too_large");
ok("head 없음 → bad_magic", decideProbe({ total: 1000, head: null, declaredType: "image", maxBytes: MAX }).reason === "bad_magic");
ok("garbage magic → bad_magic", decideProbe({ total: 1000, head: GARBAGE, declaredType: "image", maxBytes: MAX }).reason === "bad_magic");
ok("declared video인데 실제 image → type_mismatch", decideProbe({ total: 1000, head: JPEG, declaredType: "video", maxBytes: MAX }).reason === "type_mismatch");
ok("declared image인데 실제 video → type_mismatch", decideProbe({ total: 1000, head: MP4, declaredType: "image", maxBytes: MAX }).reason === "type_mismatch");

// 영상 제한은 시간(15초)이 1차 기준, 50MB는 내부 백스톱 (하린아빠 2026-07-24 스펙)
console.log("[checkVenueMediaLimits — 영상 duration 먼저 → bytes 백스톱]");
const OVER_MS = VENUE_STORY_MAX_DURATION_MS + VENUE_STORY_DURATION_TOLERANCE_MS + 1;
ok("영상 15초 이하 + 50MB 이하 → 통과",
  checkVenueMediaLimits({ kind: "video", sizeBytes: MAX, durationMs: 10_000 }) === null);
ok("영상 tolerance 이내(16초) → 통과",
  checkVenueMediaLimits({ kind: "video", sizeBytes: 1_000, durationMs: VENUE_STORY_MAX_DURATION_MS + VENUE_STORY_DURATION_TOLERANCE_MS }) === null);
ok("영상 15초 초과 → 길이 문구",
  checkVenueMediaLimits({ kind: "video", sizeBytes: 1_000, durationMs: OVER_MS }) === VENUE_VIDEO_TOO_LONG_MSG);
ok("영상 15초 초과 + 50MB 초과 → 길이 문구 우선(게이트 순서)",
  checkVenueMediaLimits({ kind: "video", sizeBytes: MAX + 1, durationMs: OVER_MS }) === VENUE_VIDEO_TOO_LONG_MSG);
ok("영상 15초 이하인데 50MB 초과 → 화질 문구(백스톱)",
  checkVenueMediaLimits({ kind: "video", sizeBytes: MAX + 1, durationMs: 10_000 }) === VENUE_VIDEO_TOO_HEAVY_MSG);
ok("영상 유저 문구에 MB 미노출",
  !VENUE_VIDEO_TOO_LONG_MSG.includes("MB") && !VENUE_VIDEO_TOO_HEAVY_MSG.includes("MB"));
ok("영상 probe 실패(durationMs null) + 50MB 초과 → 픽 게이트 fail-open(다음 단계 fail-close)",
  checkVenueMediaLimits({ kind: "video", sizeBytes: MAX + 1, durationMs: null }) === null);
ok("사진 50MB 초과 → 사진 문구(바이트 캡 유지)",
  checkVenueMediaLimits({ kind: "image", sizeBytes: MAX + 1, durationMs: null }) === VENUE_IMAGE_TOO_HEAVY_MSG);
ok("사진 50MB 이하 → 통과(자동압축 경로)",
  checkVenueMediaLimits({ kind: "image", sizeBytes: MAX, durationMs: null }) === null);

console.log("[영상 자동압축 정책 — video-compress]");
ok("자동압축 가능 환경이면 cap 초과 영상 픽 게이트 통과",
  checkVenueMediaLimits({ kind: "video", sizeBytes: MAX + 1, durationMs: 10_000, videoAutoCompressAvailable: true }) === null);
ok("자동압축 가능해도 15초 초과는 여전히 차단",
  checkVenueMediaLimits({ kind: "video", sizeBytes: MAX + 1, durationMs: OVER_MS, videoAutoCompressAvailable: true }) === VENUE_VIDEO_TOO_LONG_MSG);
ok("사진에는 플래그 무의미(바이트 캡 유지)",
  checkVenueMediaLimits({ kind: "image", sizeBytes: MAX + 1, durationMs: null, videoAutoCompressAvailable: true }) === VENUE_IMAGE_TOO_HEAVY_MSG);
ok("압축 대상: 공개 버킷(20MiB) 초과 + duration 확인됨",
  shouldAutoCompressVideo({ sizeBytes: VENUE_STORY_PUBLIC_VIDEO_MAX_BYTES + 1, durationMs: 10_000 }) === true);
ok("압축 비대상: 공개 버킷 상한 이하",
  shouldAutoCompressVideo({ sizeBytes: VENUE_STORY_PUBLIC_VIDEO_MAX_BYTES, durationMs: 10_000 }) === false);
ok("압축 비대상: duration 미상(null) — 서버 검증으로 fail-close",
  shouldAutoCompressVideo({ sizeBytes: VENUE_STORY_PUBLIC_VIDEO_MAX_BYTES + 1, durationMs: null }) === false);

// 목표 비트레이트: 목표바이트*8/duration - 오디오 예약, [MIN,MAX] clamp
{
  const t15 = computeTargetVideoBitrate(15_000);
  const raw15 = (VENUE_VIDEO_COMPRESS_TARGET_BYTES * 8 * 1000) / 15_000 - VENUE_VIDEO_AUDIO_RESERVE_BPS;
  ok("15초 → raw 계산값이 clamp 범위 안이면 그대로 사용", raw15 < VENUE_VIDEO_MAX_BITRATE_BPS && t15 === Math.round(raw15));
  ok("15초 목표 비트레이트 + 오디오 예약이면 목표바이트 근처(cap 보장)",
    ((t15 + VENUE_VIDEO_AUDIO_RESERVE_BPS) * 15) / 8 <= VENUE_VIDEO_COMPRESS_TARGET_BYTES + 1);
  const tLong = computeTargetVideoBitrate(600_000); // 비정상 긴 duration 이라도 화질 바닥 방어
  ok("극단 duration → MIN 바닥 clamp", tLong === VENUE_VIDEO_MIN_BITRATE_BPS);
}

// 재시도: 실측 초과율 기반 감축, 바닥이면 포기(null → fallback 문구)
{
  const prev = 10_000_000;
  const retry = computeRetryBitrate(prev, VENUE_VIDEO_COMPRESS_TARGET_BYTES * 1.2);
  ok("초과 시 재시도 비트레이트 감축", retry != null && retry < prev);
  ok("재시도도 MIN 바닥 이상", retry != null && retry >= VENUE_VIDEO_MIN_BITRATE_BPS);
  ok("이미 MIN 이였으면 재시도 포기 → fallback 분기",
    computeRetryBitrate(VENUE_VIDEO_MIN_BITRATE_BPS, VENUE_VIDEO_COMPRESS_TARGET_BYTES * 2) === null);
  ok("actualBytes 0(비정상) → 재시도 포기", computeRetryBitrate(prev, 0) === null);
}

// 해상도 상한: 긴 변 1920, 짝수 정렬, 이하면 null(리사이즈 없음)
{
  ok("1080x1920 세로 → 리사이즈 불필요", computeScaledDimensions(1080, 1920) === null);
  const d4k = computeScaledDimensions(2160, 3840);
  ok("4K 세로 → 긴 변 1920으로 축소", d4k != null && d4k.height === 1920 && d4k.width === 1080);
  const dOdd = computeScaledDimensions(1079, 2000);
  ok("축소 치수 짝수 정렬(인코더 호환)", dOdd != null && dOdd.width % 2 === 0 && dOdd.height % 2 === 0);
  ok("해상도 미상(0) → null(리사이즈 생략)", computeScaledDimensions(0, 0) === null);
}

// ── fake-fetch 로 probeMediaObject 계약 검증 ──
function makeRes(opts: {
  status: number;
  headers: Record<string, string>;
  bytes?: Uint8Array;
  cancelSpy?: { cancelled: boolean };
  cancelHangs?: boolean;
}): Response {
  const { status, headers, bytes, cancelSpy, cancelHangs } = opts;
  let readOffset = 0;
  const body = bytes
    ? ({
        getReader() {
          return {
            async read() {
              if (readOffset >= bytes.length) return { done: true, value: undefined };
              const chunk = bytes.subarray(readOffset, readOffset + 16);
              readOffset += chunk.length;
              return { done: false, value: chunk };
            },
            async cancel() {
              if (cancelSpy) cancelSpy.cancelled = true;
              if (cancelHangs) await new Promise(() => {});
            },
          };
        },
        async cancel() {
          if (cancelSpy) cancelSpy.cancelled = true;
          if (cancelHangs) await new Promise(() => {});
        },
      } as unknown as ReadableStream<Uint8Array>)
    : null;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    body,
    async arrayBuffer() { return (bytes ?? new Uint8Array()).buffer; },
  } as unknown as Response;
}

async function run() {
  console.log("[probeMediaObject — fake fetch]");

  // 206 정상 image
  let r = await probeMediaObject("u", "image", MAX, async () =>
    makeRes({ status: 206, headers: { "content-range": "bytes 0-63/1000" }, bytes: JPEG }));
  ok("206 정상 image → ok", r.ok === true && r.size === 1000);

  // Range 무시 200 + 초과 → body 안 읽고 too_large + cancel
  const spy = { cancelled: false };
  r = await probeMediaObject("u", "video", MAX, async () =>
    makeRes({ status: 200, headers: { "content-length": String(MAX + 5) }, bytes: MP4, cancelSpy: spy }));
  ok("Range 무시 200 초과 → too_large", r.reason === "too_large");
  ok("초과 시 body cancel 호출됨(대용량 메모리 유입 차단)", spy.cancelled === true);

  const hangingCancel = await Promise.race([
    probeMediaObject("u", "video", MAX, async () =>
      makeRes({
        status: 200,
        headers: { "content-length": String(MAX + 5) },
        bytes: MP4,
        cancelHangs: true,
      })).then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
  ok("Storage cancel 지연이 probe 응답을 막지 않음", hangingCancel === true);

  // unknown length(206 '*') → no_size + cancel
  const spy2 = { cancelled: false };
  r = await probeMediaObject("u", "image", MAX, async () =>
    makeRes({ status: 206, headers: { "content-range": "bytes 0-63/*" }, bytes: JPEG, cancelSpy: spy2 }));
  ok("206 unknown length(*) → no_size", r.reason === "no_size");
  ok("크기 미상 시 body cancel", spy2.cancelled === true);

  // magic mismatch: declared image, actual mp4
  r = await probeMediaObject("u", "image", MAX, async () =>
    makeRes({ status: 206, headers: { "content-range": "bytes 0-63/500" }, bytes: MP4 }));
  ok("declared image + 실제 mp4 → type_mismatch", r.reason === "type_mismatch");

  // 4xx → fetch_error
  r = await probeMediaObject("u", "image", MAX, async () =>
    makeRes({ status: 404, headers: {} }));
  ok("404 → fetch_error", r.reason === "fetch_error");

  // fetch throw → fetch_error
  r = await probeMediaObject("u", "image", MAX, async () => { throw new Error("net"); });
  ok("fetch throw → fetch_error", r.reason === "fetch_error");

  // 읽기 상한: PROBE_HEAD_BYTES 초과 body 여도 매직만으로 판정
  const big = new Uint8Array(PROBE_HEAD_BYTES + 500);
  big.set(JPEG, 0);
  r = await probeMediaObject("u", "image", MAX, async () =>
    makeRes({ status: 200, headers: { "content-length": "600" }, bytes: big }));
  ok("정상범위 200 + 큰 body → head만 읽어 ok", r.ok === true);

  console.log("[shouldDeleteOrphanFile]");
  const cutoff = Date.now() - 100_000;
  ok("폴더는 삭제 안 함", shouldDeleteOrphanFile({ isFolder: true, isReferenced: false, createdAt: "2020-01-01T00:00:00Z", cutoffMs: cutoff }) === false);
  ok("참조 중이면 보존", shouldDeleteOrphanFile({ isFolder: false, isReferenced: true, createdAt: "2020-01-01T00:00:00Z", cutoffMs: cutoff }) === false);
  ok("오래된 미참조 → 삭제", shouldDeleteOrphanFile({ isFolder: false, isReferenced: false, createdAt: "2020-01-01T00:00:00Z", cutoffMs: cutoff }) === true);
  ok("최근(미래) → 보존", shouldDeleteOrphanFile({ isFolder: false, isReferenced: false, createdAt: new Date(Date.now() + 1000).toISOString(), cutoffMs: cutoff }) === false);
  ok("created_at 누락(null) → 삭제 안 함(fail-open 방지)", shouldDeleteOrphanFile({ isFolder: false, isReferenced: false, createdAt: null, cutoffMs: cutoff }) === false);
  ok("created_at 파싱 실패 → 삭제 안 함", shouldDeleteOrphanFile({ isFolder: false, isReferenced: false, createdAt: "not-a-date", cutoffMs: cutoff }) === false);

  // 삼순 #813 blocker 회귀 — metadata/error 미발화 fake video 에서 픽 probe 가 무한대기하면 안 된다.
  console.log("[probeVideoDurationMs — timeout/cleanup]");
  // upload.ts 는 supabase browser client 를 모듈 스코프에서 생성 — 더미 env 후 dynamic import
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://smoke.invalid";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "smoke-anon-key";
  const { probeVideoDurationMs } = await import("../../src/lib/venue-stories/upload");
  type FakeMode = "silent" | "metadata" | "error" | "late-metadata";
  class FakeVideo {
    preload = "";
    muted = false;
    onloadedmetadata: (() => void) | null = null;
    onerror: (() => void) | null = null;
    duration: number;
    removedSrc = false;
    loaded = false;
    private _src = "";
    constructor(private mode: FakeMode, duration = 0) { this.duration = duration; }
    get src() { return this._src; }
    set src(v: string) {
      this._src = v;
      if (this.mode === "metadata") queueMicrotask(() => this.onloadedmetadata?.());
      if (this.mode === "error") queueMicrotask(() => this.onerror?.());
      if (this.mode === "late-metadata") setTimeout(() => this.onloadedmetadata?.(), 60);
      // silent: loadedmetadata/error 모두 미발화 — 삼순 독립 재현 케이스
    }
    removeAttribute(name: string) { if (name === "src") this.removedSrc = true; }
    load() { this.loaded = true; }
  }
  const fakeFile = new File([new Uint8Array(8)], "fake.mp4", { type: "video/mp4" });
  const revokes: string[] = [];
  const deps = (video: FakeVideo, timeoutMs: number) => ({
    timeoutMs,
    createVideo: () => video,
    createObjectURL: () => "blob:fake",
    revokeObjectURL: (u: string) => { revokes.push(u); },
  });

  const silent = new FakeVideo("silent");
  const silentStart = Date.now();
  const silentResult = await probeVideoDurationMs(fakeFile, deps(silent, 30));
  ok("미발화 fake video → timeout 내 null settle(무한대기 없음)",
    silentResult === null && Date.now() - silentStart < 5_000);
  ok("timeout 후 이벤트 핸들러 cleanup", silent.onloadedmetadata === null && silent.onerror === null);
  ok("timeout 후 src 해제 + load() 회수", silent.removedSrc === true && silent.loaded === true);
  ok("timeout 후 objectURL revoke", revokes.length === 1);

  const meta = new FakeVideo("metadata", 12.34);
  ok("정상 metadata → duration(ms) 반환",
    (await probeVideoDurationMs(fakeFile, deps(meta, 5_000))) === 12_340);
  ok("성공 경로도 objectURL revoke", revokes.length === 2);

  const errored = new FakeVideo("error");
  ok("error 발화 → null(fail-open 계약 유지)",
    (await probeVideoDurationMs(fakeFile, deps(errored, 5_000))) === null);

  const late = new FakeVideo("late-metadata", 9);
  const lateResult = await probeVideoDurationMs(fakeFile, deps(late, 20));
  await new Promise((r) => setTimeout(r, 80)); // 늦은 loadedmetadata 발화 이후까지 대기
  ok("timeout 이후 late metadata → 이미 null settle + 중복 revoke 없음",
    lateResult === null && revokes.length === 4);

  // iOS 오디오 보존 회귀 — 음수 first timestamp(AAC priming)면 trim 으로 보정해
  // 패킷 복사 fast path 를 보장(실기기 discard reason=undecodable_source_codec 재발 방지).
  console.log("[computeNegativeStartTrim — iOS 오디오 패킷 복사 보정]");
  ok("음수 first ts(AAC priming -23ms) → 최소 ts 로 trim",
    computeNegativeStartTrim([0, -0.023])?.start === -0.023);
  ok("모두 0 이상 → trim 없음(기본 동작 유지)", computeNegativeStartTrim([0, 0.01]) === null);
  ok("트랙 없음 → trim 없음", computeNegativeStartTrim([]) === null);
  ok("비정상 ts(-Infinity) → trim 없음(fail-safe)",
    computeNegativeStartTrim([-Infinity, 0]) === null);

  // 삼순 #814 blocker 회귀 — 압축 실행은 deadline 안에서만 기다리고 초과 시 실제 cancel 한다.
  console.log("[executeWithDeadline — 압축 실행 상한/취소]");
  const hung = { cancelled: false,
    execute: () => new Promise<void>(() => { /* settle 안 함 — 모바일 encoder fault 재현 */ }),
    cancel: async () => { hung.cancelled = true; } };
  const hungStart = Date.now();
  const hungCompleted = await executeWithDeadline(hung, 30);
  ok("미settle execute → deadline 초과로 false(화면 잠김 없음)",
    hungCompleted === false && Date.now() - hungStart < 5_000);
  ok("deadline 초과 시 conversion.cancel() 실제 호출(좀비 인코딩 방지)", hung.cancelled === true);

  const fine = { cancelled: false,
    execute: async () => undefined,
    cancel: async () => { fine.cancelled = true; } };
  ok("정상 완료 → true + cancel 미호출",
    (await executeWithDeadline(fine, 5_000)) === true && fine.cancelled === false);

  const failing = {
    execute: async () => { throw new Error("encoder fault"); },
    cancel: async () => undefined };
  const threw = await executeWithDeadline(failing, 5_000).then(() => false, () => true);
  ok("execute reject → 그대로 throw(호출부 catch 가 fallback 처리)", threw === true);

  // 삼순 라운드2 blocker 회귀 — execute 와 cancel 이 *둘 다* settle 안 해도(encoder fault 시
  // mediabunny cancel() 이 custom encoder close() 를 큐 뒤에서 영원히 기다리는 재현)
  // deadline 후 fallback 으로 즉시 settle 해야 한다(삼순 독립 재현: 20ms deadline 이
  // 200ms 뒤에도 still-pending 이었던 경로).
  const doubleHung = {
    cancelStarted: false,
    execute: () => new Promise<void>(() => { /* settle 안 함 */ }),
    cancel: () => {
      doubleHung.cancelStarted = true;
      return new Promise<void>(() => { /* cancel 도 settle 안 함 */ });
    },
  };
  const doubleOutcome = await Promise.race([
    executeWithDeadline(doubleHung, 20).then((v) => ({ settled: true as const, value: v })),
    new Promise<{ settled: false }>((r) => setTimeout(() => r({ settled: false as const }), 200)),
  ]);
  ok("execute+cancel 모두 미settle → 200ms 안에 false 로 settle(UI 재잠김 없음)",
    doubleOutcome.settled === true && doubleOutcome.value === false);
  ok("미settle cancel 도 호출 자체는 됨(fire-and-forget — 좀비 인코딩 중단 시도 유지)",
    doubleHung.cancelStarted === true);

  // cancel 이 동기 throw 해도 fallback 은 그대로(false) — fire-and-forget 래핑 검증
  const syncThrowCancel = {
    execute: () => new Promise<void>(() => { /* settle 안 함 */ }),
    cancel: (): Promise<unknown> => { throw new Error("cancel sync fault"); },
  };
  ok("cancel 동기 throw → 삼켜지고 false 반환(fallback 유지)",
    (await executeWithDeadline(syncThrowCancel, 20)) === false);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

run();
