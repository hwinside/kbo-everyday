// 직관 라이브 — 미디어 객체 서버 검증(순수 판정 + fetch 주입 가능). 단위 테스트용으로 분리.
//
// fail-closed 계약:
//  - total 크기를 헤더로 알 수 있고 maxBytes 초과면 body 를 읽지 않고 즉시 거부(메모리 보호).
//  - Range 무시 200 응답도 content-length total 로 선제 차단.
//  - 실제 read 는 매직바이트 판별에 필요한 고정 상한(HEAD_BYTES)까지만 읽고 나머지는 cancel.
//  - 크기 미상 / 매직 판별 실패 / 선언 타입 불일치는 전부 ok=false.

export const PROBE_HEAD_BYTES = 64;

export interface ProbeResult {
  ok: boolean;
  size: number | null;
  reason?: "fetch_error" | "no_size" | "too_large" | "bad_magic" | "type_mismatch";
}

/** 매직 바이트로 실제 파일 형식 판별(클라 지정 Content-Type 불신). */
export function magicMediaType(b: Uint8Array): "image" | "video" | null {
  const has = (off: number, sig: number[]) => sig.every((v, i) => b[off + i] === v);
  // 이미지
  if (has(0, [0xff, 0xd8, 0xff])) return "image"; // JPEG
  if (has(0, [0x89, 0x50, 0x4e, 0x47])) return "image"; // PNG
  if (has(0, [0x47, 0x49, 0x46, 0x38])) return "image"; // GIF8
  if (has(0, [0x52, 0x49, 0x46, 0x46]) && has(8, [0x57, 0x45, 0x42, 0x50])) return "image"; // RIFF....WEBP
  // 영상: ISO-BMFF(mp4/mov)는 offset4 'ftyp'
  if (has(4, [0x66, 0x74, 0x79, 0x70])) return "video"; // ....ftyp
  if (has(0, [0x1a, 0x45, 0xdf, 0xa3])) return "video"; // Matroska/WebM
  return null;
}

/** Range 응답 헤더에서 전체 크기 파싱. 200(Range 무시)+content-length 도 전체로 간주. */
export function parseTotalSize(
  status: number,
  contentRange: string | null,
  contentLength: string | null,
): number | null {
  if (contentRange) {
    const total = contentRange.split("/")[1];
    if (total && total !== "*") {
      const n = parseInt(total, 10);
      return Number.isFinite(n) ? n : null;
    }
  }
  if (status === 200 && contentLength) {
    const n = parseInt(contentLength, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 순수 판정: total/헤드바이트/선언타입/maxBytes 로 최종 결과 도출. */
export function decideProbe(opts: {
  total: number | null;
  head: Uint8Array | null;
  declaredType: "image" | "video";
  maxBytes: number;
}): ProbeResult {
  const { total, head, declaredType, maxBytes } = opts;
  if (total == null || !Number.isFinite(total) || total <= 0) {
    return { ok: false, size: null, reason: "no_size" };
  }
  if (total > maxBytes) {
    return { ok: false, size: total, reason: "too_large" };
  }
  if (!head || head.length === 0) {
    return { ok: false, size: total, reason: "bad_magic" };
  }
  const kind = magicMediaType(head);
  if (kind == null) return { ok: false, size: total, reason: "bad_magic" };
  if (kind !== declaredType) return { ok: false, size: total, reason: "type_mismatch" };
  return { ok: true, size: total };
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  try {
    void body?.cancel().catch(() => {});
  } catch {
    /* noop */
  }
}

/**
 * storage 객체를 Range GET 으로 프로브. total 이 헤더로 판명되고 maxBytes 초과면 body 를
 * 읽지 않고 즉시 cancel+거부. 아니면 PROBE_HEAD_BYTES 까지만 읽고 나머지 cancel.
 */
export async function probeMediaObject(
  url: string,
  declaredType: "image" | "video",
  maxBytes: number,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<ProbeResult> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { Range: `bytes=0-${PROBE_HEAD_BYTES - 1}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, size: null, reason: "fetch_error" };
  }
  if (!res.ok && res.status !== 206) {
    cancelBody(res.body);
    return { ok: false, size: null, reason: "fetch_error" };
  }

  const total = parseTotalSize(
    res.status,
    res.headers.get("content-range"),
    res.headers.get("content-length"),
  );

  // 크기 미상 또는 초과면 body 를 읽지 않고 즉시 취소(대용량 메모리 유입 차단)
  if (total == null || total <= 0 || total > maxBytes) {
    cancelBody(res.body);
    return decideProbe({ total, head: null, declaredType, maxBytes });
  }

  // 여기서만 최대 PROBE_HEAD_BYTES 까지 읽고 나머지 취소(Range 무시 200 대비 하드 상한)
  const head = await readCapped(res, PROBE_HEAD_BYTES);
  return decideProbe({ total, head, declaredType, maxBytes });
}

/** 응답 body 를 최대 limit 바이트까지만 읽고 스트림을 취소. reader 없으면 arrayBuffer 폴백(그때도 slice). */
async function readCapped(res: Response, limit: number): Promise<Uint8Array | null> {
  const reader = res.body?.getReader?.();
  if (!reader) {
    try {
      const buf = new Uint8Array(await res.arrayBuffer());
      return buf.slice(0, limit);
    } catch {
      return null;
    }
  }
  const chunks: Uint8Array[] = [];
  let got = 0;
  try {
    while (got < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        got += value.length;
      }
    }
  } catch {
    return null;
  } finally {
    try {
      void reader.cancel().catch(() => {});
    } catch {
      /* noop */
    }
  }
  const out = new Uint8Array(Math.min(got, limit));
  let off = 0;
  for (const c of chunks) {
    if (off >= limit) break;
    const take = Math.min(c.length, limit - off);
    out.set(c.subarray(0, take), off);
    off += take;
  }
  return out;
}
