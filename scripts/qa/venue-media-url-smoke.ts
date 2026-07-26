/**
 * 직관 라이브 A안 A1 — private 미디어 signed URL 서빙/캐싱 순수 회귀.
 * 실행: npm run qa:venue-media-url
 * 검증:
 *  1) private 버킷(venue-media/venue-staging) ref 만 서명, 레거시 공개(videos/photos)는 미서명 그대로.
 *  2) 배치 발급 — 한 요청의 여러 경로를 버킷별 1콜로 묶는다(발급 콜 수 최소화).
 *  3) 캐시 재사용 — TTL 안 재요청은 서명자를 다시 호출하지 않는다(발급 폭주 방지).
 *  4) 캐시 만료 — cacheMs 경과 후에는 재발급한다.
 *  5) resolveServeUrl — private→signed, 레거시 공개→저장 URL, **발급 실패→null(fail-closed)**.
 *  6) 공개 서빙(publicServe) — venue-media 만 mint, venue-staging 은 차단(null).
 *  7) venueActiveSignWindow — 5m 상한 + expires_at 잔여시간 cap + 캐시<TTL.
 */
import {
  signPrivateRefs,
  signActivePrivateRefs,
  resolveServeUrl,
  isPrivateVenueBucket,
  isPublicServablePrivateBucket,
  venueSignCacheKey,
  venueActiveSignWindow,
  VENUE_ACTIVE_SIGNED_URL_TTL_SEC,
  VENUE_ACTIVE_SIGNED_URL_CACHE_MS,
  type VenueBatchSigner,
} from "../../src/lib/venue-stories/media-url";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

/** 호출 카운트를 추적하는 배치 서명자(경로별 결정적 signed URL). */
function makeSigner() {
  const calls: Array<{ bucket: string; paths: string[]; ttlSec: number }> = [];
  const signer: VenueBatchSigner = async (bucket, paths, ttlSec) => {
    calls.push({ bucket, paths: [...paths], ttlSec });
    const out = new Map<string, string | null>();
    for (const p of paths) out.set(p, `signed://${bucket}/${p}?ttl=${ttlSec}`);
    return out;
  };
  return { signer, calls };
}

const P = "venue-stories/G1/U1/a.jpg";
const P2 = "venue-stories/G1/U1/b.mp4";

async function main() {
  console.log("[isPrivateVenueBucket]");
  ok("venue-media = private", isPrivateVenueBucket("venue-media"));
  ok("venue-staging = private", isPrivateVenueBucket("venue-staging"));
  ok("videos = 공개(레거시)", !isPrivateVenueBucket("videos"));
  ok("photos = 공개(레거시)", !isPrivateVenueBucket("photos"));
  ok("null = 비private", !isPrivateVenueBucket(null));

  console.log("[private 만 서명 + 레거시 미포함]");
  {
    const { signer, calls } = makeSigner();
    const cache = new Map();
    const signed = await signPrivateRefs(
      [
        { bucket: "venue-media", path: P },
        { bucket: "videos", path: "venue-stories/G1/U1/legacy.mp4" },
        { bucket: "photos", path: "venue-stories/G1/U1/legacy.jpg" },
      ],
      { signer, cache },
    );
    ok("private ref 서명됨", signed.get(venueSignCacheKey("venue-media", P))?.startsWith("signed://") === true);
    ok("레거시 공개 ref 는 맵에 없음", !signed.has(venueSignCacheKey("videos", "venue-stories/G1/U1/legacy.mp4")));
    ok("발급 콜 1회(private 1건)", calls.length === 1);
  }

  console.log("[버킷별 배치 — 같은 버킷 다수 경로 1콜]");
  {
    const { signer, calls } = makeSigner();
    const cache = new Map();
    await signPrivateRefs(
      [
        { bucket: "venue-media", path: P },
        { bucket: "venue-media", path: P2 },
        { bucket: "venue-staging", path: P2 },
      ],
      { signer, cache },
    );
    ok("버킷 2종 → 콜 2회", calls.length === 2);
    const vm = calls.find((c) => c.bucket === "venue-media");
    ok("venue-media 콜은 경로 2개 배치", vm?.paths.length === 2);
  }

  console.log("[캐시 재사용 — TTL 안 재요청은 재서명 안 함]");
  {
    const { signer, calls } = makeSigner();
    const cache = new Map();
    const now = 1_000_000;
    const a = await signPrivateRefs([{ bucket: "venue-media", path: P }], { signer, cache, now });
    const b = await signPrivateRefs([{ bucket: "venue-media", path: P }], { signer, cache, now: now + 60_000 });
    ok("두 요청 같은 URL", a.get(venueSignCacheKey("venue-media", P)) === b.get(venueSignCacheKey("venue-media", P)));
    ok("서명자 총 1회만 호출(캐시 히트)", calls.length === 1);
  }

  console.log("[캐시 만료 — cacheMs 경과 후 재발급]");
  {
    const { signer, calls } = makeSigner();
    const cache = new Map();
    const now = 1_000_000;
    await signPrivateRefs([{ bucket: "venue-media", path: P }], { signer, cache, now, cacheMs: 1000 });
    await signPrivateRefs([{ bucket: "venue-media", path: P }], { signer, cache, now: now + 2000, cacheMs: 1000 });
    ok("만료 후 재발급(콜 2회)", calls.length === 2);
  }

  console.log("[resolveServeUrl — fail-closed]");
  {
    const { signer, cache } = { ...makeSigner(), cache: new Map() };
    const signed = await signPrivateRefs([{ bucket: "venue-media", path: P }], { signer, cache });
    ok(
      "private → signed URL",
      resolveServeUrl({ bucket: "venue-media", path: P, url: "https://x/public/venue-media/" + P }, signed)?.startsWith("signed://") === true,
    );
    ok(
      "레거시 공개 → 저장 URL 그대로",
      resolveServeUrl({ bucket: "videos", path: "p", url: "https://cdn/videos/p.mp4" }, signed) === "https://cdn/videos/p.mp4",
    );
    // 발급 실패(맵에 null) → **null**(raw 저장 경로 폴백 금지 = 유출 방지)
    const failMap = new Map<string, string | null>([[venueSignCacheKey("venue-media", P), null]]);
    ok(
      "발급 실패 → null(fail-closed, 저장 경로 폴백 안 함)",
      resolveServeUrl({ bucket: "venue-media", path: P, url: "fallback://stored" }, failMap) === null,
    );
    // 맵에 키 자체가 없어도(미서명) → null(raw 폴백 금지)
    ok(
      "맵 미존(미서명) → null(fail-closed)",
      resolveServeUrl({ bucket: "venue-media", path: P, url: "fallback://stored" }, new Map()) === null,
    );
    ok(
      "private path 누락 → null(fail-closed)",
      resolveServeUrl({ bucket: "venue-media", path: null, url: "fallback://stored" }, new Map()) === null,
    );
    ok("thumb 없음(url null) → null", resolveServeUrl({ bucket: "venue-media", path: P, url: null }, failMap) === null);
  }

  console.log("[공개 서빙 — venue-media 만 mint, venue-staging 차단]");
  {
    ok("venue-media = 공개 서빙 허용", isPublicServablePrivateBucket("venue-media"));
    ok("venue-staging = 공개 서빙 불가", !isPublicServablePrivateBucket("venue-staging"));
    ok("videos = 공개 서빙가능 private 아님", !isPublicServablePrivateBucket("videos"));
    const { signer, cache } = { ...makeSigner(), cache: new Map() };
    // venue-staging 도 signPrivateRefs 는 서명하지만, 공개 서빙에서는 mint 금지.
    const signed = await signPrivateRefs(
      [
        { bucket: "venue-media", path: P },
        { bucket: "venue-staging", path: P2 },
      ],
      { signer, cache },
    );
    ok(
      "publicServe: venue-media → signed",
      resolveServeUrl({ bucket: "venue-media", path: P, url: "x" }, signed, { publicServe: true })?.startsWith("signed://") === true,
    );
    ok(
      "publicServe: venue-staging → null(공개 mint 차단)",
      resolveServeUrl({ bucket: "venue-staging", path: P2, url: "x" }, signed, { publicServe: true }) === null,
    );
    // admin(publicServe 기본 false)은 venue-staging signed 미리보기 허용
    ok(
      "admin(기본): venue-staging → signed 허용",
      resolveServeUrl({ bucket: "venue-staging", path: P2, url: "x" }, signed)?.startsWith("signed://") === true,
    );
  }

  console.log("[venueActiveSignWindow — 5m 상한 + expires_at cap + 캐시<TTL]");
  {
    // 잔여시간 충분(1h) → 5m 상한으로 cap
    const w1 = venueActiveSignWindow(60 * 60 * 1000);
    ok("잔여 1h → ttl 300s(5m 상한)", w1.ttlSec === VENUE_ACTIVE_SIGNED_URL_TTL_SEC && w1.ttlSec === 300);
    ok("잔여 1h → cache ≤ 4m 상한", w1.cacheMs === VENUE_ACTIVE_SIGNED_URL_CACHE_MS && w1.cacheMs === 4 * 60 * 1000);
    ok("cache < ttl(만료 전 재사용 금지)", w1.cacheMs < w1.ttlSec * 1000);
    // 잔여시간이 5m 미만(90s) → 90s 로 cap
    const w2 = venueActiveSignWindow(90 * 1000);
    ok("잔여 90s → ttl 90s(expires_at cap)", w2.ttlSec === 90);
    ok("잔여 90s → cache = 60s(ttl-30s)", w2.cacheMs === 60 * 1000 && w2.cacheMs < w2.ttlSec * 1000);
    // 잔여시간이 30s 이하 → 캐시 0(재사용 금지)
    const w3 = venueActiveSignWindow(20 * 1000);
    ok("잔여 20s → ttl 20s, cache 0(캐시 안 함)", w3.ttlSec === 20 && w3.cacheMs === 0);
    // 이미 만료(음수) → ttl 최소 1s, cache 0
    const w4 = venueActiveSignWindow(-5000);
    ok("이미 만료 → ttl 1s(최소), cache 0", w4.ttlSec === 1 && w4.cacheMs === 0);
  }

  console.log("[expires_at cap — 긴 TTL 캐시 재사용 차단]");
  {
    const { signer, calls } = makeSigner();
    const cache = new Map();
    const now = 1_000_000;
    await signPrivateRefs([{ bucket: "venue-media", path: P }], {
      signer,
      cache,
      now,
      ttlSec: 300,
      cacheMs: 240_000,
      notAfterMs: now + 600_000,
    });
    const capped = await signPrivateRefs([{ bucket: "venue-media", path: P }], {
      signer,
      cache,
      now: now + 1_000,
      ttlSec: 89,
      cacheMs: 59_000,
      notAfterMs: now + 90_000,
    });
    ok("expires_at을 넘는 기존 5m URL은 캐시 미사용", calls.length === 2);
    ok("재발급 TTL이 잔여시간 이하", calls[1]?.ttlSec === 89);
    ok(
      "새 capped URL 반환",
      capped.get(venueSignCacheKey("venue-media", P))?.includes("ttl=89") === true,
    );
  }

  console.log("[공개 active 실제 발급 — staging 차단 + 행별 expires_at cap]");
  {
    const { signer, calls } = makeSigner();
    const now = 1_000_000;
    const signed = await signActivePrivateRefs(
      [
        { bucket: "venue-media", path: P, expiresAt: new Date(now + 60 * 60_000).toISOString() },
        { bucket: "venue-media", path: P2, expiresAt: new Date(now + 90_000).toISOString() },
        {
          bucket: "venue-staging",
          path: "venue-stories/G1/U1/unverified.mp4",
          expiresAt: new Date(now + 60 * 60_000).toISOString(),
        },
      ],
      { signer, cache: new Map(), now },
    );
    ok("공개 발급 signer는 venue-media만 호출", calls.every((call) => call.bucket === "venue-media"));
    ok("venue-staging은 signed map에도 없음", !signed.has(venueSignCacheKey("venue-staging", "venue-stories/G1/U1/unverified.mp4")));
    ok("잔여 1h 행은 300s로 발급", calls.some((call) => call.paths.includes(P) && call.ttlSec === 300));
    ok("잔여 90s 행은 90s로 발급", calls.some((call) => call.paths.includes(P2) && call.ttlSec === 90));
  }

  console.log("[공개 5m cap — admin 1h 캐시 재사용 차단]");
  {
    const { signer, calls } = makeSigner();
    const cache = new Map();
    const now = 1_000_000;
    await signPrivateRefs([{ bucket: "venue-media", path: P }], {
      signer,
      cache,
      now,
      ttlSec: 3600,
      cacheMs: 50 * 60_000,
    });
    await signActivePrivateRefs(
      [{
        bucket: "venue-media",
        path: P,
        expiresAt: new Date(now + 2 * 60 * 60_000).toISOString(),
      }],
      { signer, cache, now: now + 1_000 },
    );
    ok("admin 1h URL을 공개 캐시로 재사용하지 않음", calls.length === 2);
    ok("공개 재발급은 300s 상한", calls[1]?.ttlSec === 300);
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main();
