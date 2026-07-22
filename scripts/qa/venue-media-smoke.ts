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
import { VENUE_STORY_MAX_BYTES } from "../../src/lib/venue-stories/types";

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

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

run();
