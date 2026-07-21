// 직관 라이브 — Storage 공개 URL 파싱 + 소유권 바인딩(canonicalization 우회 방지, 단위 테스트 가능).
//
// 소유권 취약점(삼순 P0): raw prefix slice + startsWith 만 보면
// `venue-stories/{gameId}/{attacker}/../{victim}/clip.mp4` 나 `%2e%2e`, `%2f`, `..\` 로
// owns=true 지만 fetch/worker 는 victim 경로로 정규화한다 → 타인 객체 probe/삭제 경계 위험.
// → WHATWG URL 로 canonicalize 후 exact key 규격 매칭 + percent/backslash 전면 거부.
//
// percent 봉인(삼순 09:44 #3): double-encoded `%252f` 는 1회 decode 후 `%2f` 로 남아
// exact 매칭을 우회했고, malformed `%zz` 는 decodeURIComponent 가 URIError 를 throw 했다.
// → raw/decoded 양쪽에서 `%` 자체를 전면 거부(우리 업로더 파일명은 strict allowlist 라 percent 불필요)
//   + decode 는 try/catch 로 감싸 URIError 를 거부(null)로 처리.

export const VENUE_ALLOWED_BUCKETS = new Set(["videos", "photos"]);

// 업로더 key 규격: venue-stories/{gameId}/{uuid}/{filename} — filename 은 strict allowlist
const VENUE_KEY_RE = /^venue-stories\/([A-Za-z0-9_-]+)\/([0-9a-fA-F-]{36})\/[A-Za-z0-9._-]+$/;

/**
 * Supabase storage 공개 URL 을 canonical bucket/path 로 파싱. 우회 시도는 전부 null.
 * @param baseUrl NEXT_PUBLIC_SUPABASE_URL
 */
export function parseStoragePublicUrl(
  url: string,
  baseUrl: string | undefined,
): { bucket: string; path: string } | null {
  if (!baseUrl || typeof url !== "string") return null;
  const prefix = `${baseUrl}/storage/v1/object/public/`;
  if (!url.startsWith(prefix)) return null;
  // 파싱 전 raw 에 percent 시퀀스·backslash 가 있으면 전면 거부(canonicalization/double-encode 우회 차단)
  const rawRest = url.slice(prefix.length).split("?")[0].split("#")[0];
  if (rawRest.includes("%") || rawRest.includes("\\")) return null;
  // WHATWG URL 로 origin/pathname 정규화 — fetch 가 실제 보는 canonical 경로로 검증
  let u: URL;
  let base: URL;
  try {
    u = new URL(url);
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  if (u.origin !== base.origin) return null;
  const canonPrefix = "/storage/v1/object/public/";
  if (!u.pathname.startsWith(canonPrefix)) return null;
  const canonRest = u.pathname.slice(canonPrefix.length);
  const slash = canonRest.indexOf("/");
  if (slash <= 0) return null;
  const bucket = canonRest.slice(0, slash);
  // URL 정규화가 만든 encoding 도 malformed 일 수 있다 → URIError 는 거부로 처리
  let path: string;
  try {
    path = decodeURIComponent(canonRest.slice(slash + 1));
  } catch {
    return null;
  }
  if (!VENUE_ALLOWED_BUCKETS.has(bucket) || !path) return null;
  // decode 후에도 percent 가 남으면(double-encode) 거부 — 우리 key 규격에 % 는 없다
  if (path.includes("%") || path.includes("\\")) return null;
  // 정규화 후에도 dot segment / 빈 세그먼트가 남으면 거부
  const segs = path.split("/");
  if (segs.some((s) => s === "." || s === ".." || s === "")) return null;
  return { bucket, path };
}

/** 소유권 바인딩: canonical path 가 venue-stories/{gameId}/{userId}/{파일} 규격이고 gameId/userId 일치. */
export function ownsPath(path: string, gameId: string, userId: string): boolean {
  if (typeof path !== "string" || path.length > 512) return false;
  const m = VENUE_KEY_RE.exec(path);
  if (!m) return false;
  return m[1] === gameId && m[2].toLowerCase() === userId.toLowerCase();
}
