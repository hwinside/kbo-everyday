// 직관 라이브 — private 미디어 서버 발급 signed URL 서빙 + 캐싱 (A안 슬라이스 A1).
//
// A안(하린아빠 승인): venue story 미디어를 처음부터 private(venue-media) 저장하고,
// 공개 트레이/뷰어(active)도 서버가 발급한 signed URL 로 서빙한다. archive 는 DB status 만
// 바꾸면 되므로(객체 이동 0) 공개↔비공개 전환에서 유실 경로가 원천 제거된다.
//
// 서빙 규칙(단일 소스): row.media_bucket 이 private venue 버킷이면 signed URL, 아니면
// 저장된 공개 media_url 을 그대로 반환(A3 이관 전 레거시 public 행 호환).
//
// 발급 폭주 방지: signed URL 은 TTL 1h, 프로세스-로컬 캐시는 50분(만료 10분 여유) 보관해
// 웜 인스턴스 안 다수 요청이 같은 객체를 재발급하지 않게 한다. 배치(createSignedUrls)로
// 한 요청의 모든 미노출 경로를 버킷별 1콜에 묶어 발급 콜 수를 최소화한다.

/** venue story 전용 private 버킷 — 공개 URL 이 없고 signed URL 로만 서빙. */
const PRIVATE_VENUE_BUCKETS = new Set(["venue-media", "venue-staging"]);

export function isPrivateVenueBucket(bucket: string | null | undefined): boolean {
  return typeof bucket === "string" && PRIVATE_VENUE_BUCKETS.has(bucket);
}

// signed URL 유효기간(초) — 뷰어 재생 중 만료되지 않도록 넉넉히.
export const VENUE_SIGNED_URL_TTL_SEC = 3600; // 1h
// 캐시 보관기간(ms) — TTL 보다 10분 짧게 두어 만료 직전 URL 재사용을 배포하지 않는다.
export const VENUE_SIGNED_URL_CACHE_MS = 50 * 60 * 1000; // 50m
// 캐시 무한 증가 방지 상한(간단 FIFO 방출).
const CACHE_MAX = 5000;

export function venueSignCacheKey(bucket: string, path: string): string {
  return `${bucket}\n${path}`;
}

interface CacheEntry {
  url: string;
  expiresAt: number;
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
    // 발급 실패는 호출부가 저장된 media_url 폴백으로 처리(서빙 크래시 금지).
  }
  for (const p of paths) if (!out.has(p)) out.set(p, null);
  return out;
};

export interface SignPrivateRefsOptions {
  now?: number;
  signer?: VenueBatchSigner;
  ttlSec?: number;
  cacheMs?: number;
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
    if (hit && hit.expiresAt > now) {
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
      if (url) {
        if (cache.size >= CACHE_MAX) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(key, { url, expiresAt: now + cacheMs });
      }
    }
  }

  return resolved;
}

/**
 * 서빙 URL 해결: private 버킷이면 signed(없으면 저장 URL 폴백), 아니면 저장된 공개 URL.
 * @param signed signPrivateRefs 결과맵
 */
export function resolveServeUrl(
  ref: VenueMediaRef & { url: string | null },
  signed: Map<string, string | null>,
): string | null {
  if (isPrivateVenueBucket(ref.bucket) && ref.path) {
    const key = venueSignCacheKey(ref.bucket as string, ref.path);
    // 발급 실패 시 저장된 media_url 폴백(비정상 소수 케이스 — 서빙 크래시 방지)
    return signed.get(key) ?? ref.url;
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
