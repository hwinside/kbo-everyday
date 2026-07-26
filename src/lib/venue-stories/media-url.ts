// 직관 라이브 — private 미디어 서버 발급 signed URL 서빙 + 캐싱 (A안 슬라이스 A1).
//
// A안(하린아빠 승인): venue story 미디어를 처음부터 private(venue-media) 저장하고,
// 공개 트레이/뷰어(active)도 서버가 발급한 signed URL 로 서빙한다. archive 는 DB status 만
// 바꾸면 되므로(객체 이동 0) 공개↔비공개 전환에서 유실 경로가 원천 제거된다.
//
// 서빙 규칙(단일 소스): row.media_bucket 이 private venue 버킷이면 signed URL(발급 실패 시
// null = fail-closed, 저장 경로로 절대 폴백하지 않음), 아니면 저장된 공개 media_url 을 그대로
// 반환(A3 이관 전 레거시 public 행 호환).
//
// 공개 서빙(트레이/뷰어) mint 는 venue-media 만 허용한다. venue-staging 은 서버 ffprobe 검증
// 전 스테이징이라 공개 서빙 대상이 아니다 → 공개 경로에서는 mint 하지 않고 제외(fail-closed).
// admin 모더레이션은 검증 전 원본 미리보기가 필요하므로 venue-staging signed 도 허용한다.
//
// 발급 폭주 방지: 프로세스-로컬 캐시로 웜 인스턴스 안 다수 요청이 같은 객체를 재발급하지 않게
// 한다(캐시 보관은 항상 signed TTL 보다 짧게 둔다). 배치(createSignedUrls)로 한 요청의 모든
// 미노출 경로를 버킷별 1콜에 묶어 발급 콜 수를 최소화한다.

/** venue story 전용 private 버킷 — 공개 URL 이 없고 signed URL 로만 서빙. */
const PRIVATE_VENUE_BUCKETS = new Set(["venue-media", "venue-staging"]);
// 공개 트레이/뷰어(active) 로 signed URL mint 가 허용되는 private 버킷. venue-staging 은
// 미검증 스테이징이라 공개 서빙 금지(active 오염이 있어도 절대 공개 mint 안 함, 삼순 blocker 1).
const PUBLIC_SERVABLE_PRIVATE_BUCKETS = new Set(["venue-media"]);

export function isPrivateVenueBucket(bucket: string | null | undefined): boolean {
  return typeof bucket === "string" && PRIVATE_VENUE_BUCKETS.has(bucket);
}

/** 공개 트레이/뷰어로 signed URL 을 발급해도 되는 private 버킷인가(venue-media 만). */
export function isPublicServablePrivateBucket(bucket: string | null | undefined): boolean {
  return typeof bucket === "string" && PUBLIC_SERVABLE_PRIVATE_BUCKETS.has(bucket);
}

// signed URL 유효기간(초) — admin 모더레이션·검증 read-url 등 비공개 서버 경로 기본값.
export const VENUE_SIGNED_URL_TTL_SEC = 3600; // 1h
// 캐시 보관기간(ms) — TTL 보다 10분 짧게 두어 만료 직전 URL 재사용을 배포하지 않는다.
export const VENUE_SIGNED_URL_CACHE_MS = 50 * 60 * 1000; // 50m

// ── 공개(active) 트레이/뷰어 전용 짧은 TTL(삼순 blocker 2) ──
// 공개 종료·removed 반영 후 signed URL 잔존 노출창을 최소화한다. 발급 TTL 은 5분 상한이되
// 행의 expires_at 잔여시간 이하로 cap 하고, 캐시는 effective TTL 보다 짧게 둔다.
export const VENUE_ACTIVE_SIGNED_URL_TTL_SEC = 300; // 5m 상한
export const VENUE_ACTIVE_SIGNED_URL_CACHE_MS = 4 * 60 * 1000; // 4m 상한
// 캐시가 signed URL 만료를 넘겨 재사용되지 않도록 두는 안전 여유(초).
const VENUE_ACTIVE_CACHE_BUFFER_SEC = 30;

/**
 * 공개(active) 서빙용 effective TTL/cache 산출(삼순 blocker 2, 순수·회귀 가능).
 * @param minRemainingMs 응답에 포함된 active 행들의 expires_at 잔여시간 최소값(ms).
 * @returns ttlSec = min(5m, 잔여시간), cacheMs = min(4m, ttl-30s)(음수면 0=캐시 안 함).
 *   전 URL 이 어떤 행의 expires_at 도 넘기지 않도록 batch 를 최소 잔여시간으로 cap 한다.
 */
export function venueActiveSignWindow(minRemainingMs: number): {
  ttlSec: number;
  cacheMs: number;
} {
  const remSec = Math.floor(minRemainingMs / 1000);
  const ttlSec = Math.max(1, Math.min(VENUE_ACTIVE_SIGNED_URL_TTL_SEC, remSec));
  const cacheMs = Math.max(
    0,
    Math.min(VENUE_ACTIVE_SIGNED_URL_CACHE_MS, (ttlSec - VENUE_ACTIVE_CACHE_BUFFER_SEC) * 1000),
  );
  return { ttlSec, cacheMs };
}
// 캐시 무한 증가 방지 상한(간단 FIFO 방출).
const CACHE_MAX = 5000;

export function venueSignCacheKey(bucket: string, path: string): string {
  return `${bucket}\n${path}`;
}

interface CacheEntry {
  url: string;
  expiresAt: number;
  signedExpiresAt: number;
}

// 웜 인스턴스 재사용용 프로세스-로컬 캐시(서버리스 인스턴스별). 발급 폭주 방지.
const moduleCache = new Map<string, CacheEntry>();

export interface VenueMediaRef {
  bucket: string | null | undefined;
  path: string | null | undefined;
}

/**
 * 배치 서명자 — bucket + paths 를 받아 path→signedUrl(실패 null) 맵을 반환.
 * 순수 회귀 테스트에서 주입 가능(deps 경계).
 */
export type VenueBatchSigner = (
  bucket: string,
  paths: string[],
  ttlSec: number,
) => Promise<Map<string, string | null>>;

const realBatchSigner: VenueBatchSigner = async (bucket, paths, ttlSec) => {
  const out = new Map<string, string | null>();
  try {
    // 동적 import — 순수 헬퍼(캐싱·해석)를 admin 클라이언트(env 필요) import 에서 분리(회귀 테스트 가능).
    const { supabaseAdmin } = await import("@/lib/supabase/admin");
    const { data, error } = await supabaseAdmin.storage
      .from(bucket)
      .createSignedUrls(paths, ttlSec);
    if (error || !data) {
      for (const p of paths) out.set(p, null);
      return out;
    }
    for (const r of data) {
      if (r.path) out.set(r.path, r.error ? null : (r.signedUrl ?? null));
    }
  } catch {
    // 발급 실패는 null 로 남겨 호출부가 fail-closed 처리(private 는 저장 경로로 절대 폴백 금지).
  }
  for (const p of paths) if (!out.has(p)) out.set(p, null);
  return out;
};

export interface SignPrivateRefsOptions {
  now?: number;
  signer?: VenueBatchSigner;
  ttlSec?: number;
  cacheMs?: number;
  // 이 시각 이후까지 유효한 기존 signed URL 은 재사용하지 않는다(expires_at cap 보장).
  notAfterMs?: number;
  cache?: Map<string, CacheEntry>;
}

/**
 * private venue 버킷 참조들(refs)만 골라 캐시 우선으로 signed URL 을 해결한다.
 * 반환: cacheKey(bucket,path) → signedUrl|null. private 가 아닌 ref 는 포함하지 않는다.
 *
 * 캐시 히트는 서명자를 호출하지 않는다. 미스만 버킷별로 묶어 배치 발급 후 캐시에 적재한다.
 */
export async function signPrivateRefs(
  refs: VenueMediaRef[],
  opts: SignPrivateRefsOptions = {},
): Promise<Map<string, string | null>> {
  const now = opts.now ?? Date.now();
  const signer = opts.signer ?? realBatchSigner;
  const ttlSec = opts.ttlSec ?? VENUE_SIGNED_URL_TTL_SEC;
  const cacheMs = opts.cacheMs ?? VENUE_SIGNED_URL_CACHE_MS;
  const notAfterMs = opts.notAfterMs;
  const maxSignedExpiresAt = Math.min(
    notAfterMs ?? Number.POSITIVE_INFINITY,
    now + ttlSec * 1000,
  );
  const cache = opts.cache ?? moduleCache;

  const resolved = new Map<string, string | null>();
  // 미스 경로를 버킷별로 수집(중복 제거).
  const missByBucket = new Map<string, Set<string>>();

  for (const ref of refs) {
    if (!ref || !isPrivateVenueBucket(ref.bucket) || !ref.path) continue;
    const bucket = ref.bucket as string;
    const path = ref.path;
    const key = venueSignCacheKey(bucket, path);
    if (resolved.has(key)) continue;
    const hit = cache.get(key);
    if (
      hit &&
      hit.expiresAt > now &&
      hit.signedExpiresAt <= maxSignedExpiresAt
    ) {
      resolved.set(key, hit.url);
      continue;
    }
    const set = missByBucket.get(bucket) ?? new Set<string>();
    set.add(path);
    missByBucket.set(bucket, set);
  }

  for (const [bucket, paths] of missByBucket) {
    const signedMap = await signer(bucket, [...paths], ttlSec);
    for (const path of paths) {
      const url = signedMap.get(path) ?? null;
      const key = venueSignCacheKey(bucket, path);
      resolved.set(key, url);
      if (url && cacheMs > 0) {
        if (cache.size >= CACHE_MAX) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(key, {
          url,
          expiresAt: now + cacheMs,
          signedExpiresAt: now + ttlSec * 1000,
        });
      }
    }
  }

  return resolved;
}

export interface VenueActiveMediaRef extends VenueMediaRef {
  expiresAt: string | null | undefined;
}

/**
 * 공개 active 전용 서명:
 * - venue-media만 mint(venue-staging 차단)
 * - 각 행 expires_at 이하 TTL, 최대 5분
 * - 같은 effective TTL은 배치하고 더 긴 기존 캐시는 재사용하지 않음
 */
export async function signActivePrivateRefs(
  refs: VenueActiveMediaRef[],
  opts: Pick<SignPrivateRefsOptions, "now" | "signer" | "cache"> = {},
): Promise<Map<string, string | null>> {
  const now = opts.now ?? Date.now();
  const groups = new Map<
    string,
    {
      refs: VenueMediaRef[];
      ttlSec: number;
      cacheMs: number;
      notAfterMs: number;
    }
  >();

  for (const ref of refs) {
    if (!isPublicServablePrivateBucket(ref.bucket) || !ref.path) continue;
    const notAfterMs = ref.expiresAt ? Date.parse(ref.expiresAt) : NaN;
    if (!Number.isFinite(notAfterMs) || notAfterMs <= now) continue;
    const { ttlSec, cacheMs } = venueActiveSignWindow(notAfterMs - now);
    const key = `${ttlSec}:${cacheMs}`;
    const group = groups.get(key) ?? { refs: [], ttlSec, cacheMs, notAfterMs };
    group.refs.push({ bucket: ref.bucket, path: ref.path });
    group.notAfterMs = Math.min(group.notAfterMs, notAfterMs);
    groups.set(key, group);
  }

  const signed = new Map<string, string | null>();
  for (const group of groups.values()) {
    const groupSigned = await signPrivateRefs(group.refs, {
      now,
      signer: opts.signer,
      cache: opts.cache,
      ttlSec: group.ttlSec,
      cacheMs: group.cacheMs,
      notAfterMs: group.notAfterMs,
    });
    for (const [key, url] of groupSigned) signed.set(key, url);
  }
  return signed;
}

export interface ResolveServeOptions {
  // 공개 트레이/뷰어 경로면 true — venue-media 만 mint 하고 venue-staging 등은 차단(null).
  // admin 모더레이션은 false(기본) — venue-staging signed 미리보기도 허용.
  publicServe?: boolean;
}

/**
 * 서빙 URL 해결(fail-closed): private 버킷이면 signed URL, 발급 실패면 **null**(저장 경로로
 * 절대 폴백하지 않음 — 유출 방지). 레거시 공개 버킷(videos/photos)은 저장된 공개 URL.
 * publicServe=true 면 venue-media 가 아닌 private 버킷(venue-staging)은 mint 하지 않고 null.
 * @param signed signPrivateRefs 결과맵
 */
export function resolveServeUrl(
  ref: VenueMediaRef & { url: string | null },
  signed: Map<string, string | null>,
  opts: ResolveServeOptions = {},
): string | null {
  if (isPrivateVenueBucket(ref.bucket)) {
    // 공개 서빙은 venue-media 만 mint 허용 — venue-staging 등 미검증 버킷은 차단(null).
    if (opts.publicServe && !isPublicServablePrivateBucket(ref.bucket)) return null;
    if (!ref.path) return null;
    const key = venueSignCacheKey(ref.bucket as string, ref.path);
    // fail-closed: 발급 실패(null/미존)면 null — 저장된 media_url(공개 접근 가능 형태) 폴백 금지.
    return signed.get(key) ?? null;
  }
  return ref.url;
}

/** 단건 signed URL(검증 read-url 등 배치가 불필요한 경로용). 실패 시 null. */
export async function signVenueObject(
  bucket: string,
  path: string,
  opts: SignPrivateRefsOptions = {},
): Promise<string | null> {
  const map = await signPrivateRefs([{ bucket, path }], opts);
  return map.get(venueSignCacheKey(bucket, path)) ?? null;
}

/** 테스트 전용 — 모듈 캐시 초기화. */
export function __clearVenueSignCacheForTest(): void {
  moduleCache.clear();
}
