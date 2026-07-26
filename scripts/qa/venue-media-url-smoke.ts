/**
 * 직관 라이브 A안 A1 — private 미디어 signed URL 서빙/캐싱 순수 회귀.
 * 실행: npm run qa:venue-media-url
 * 검증:
 *  1) private 버킷(venue-media/venue-staging) ref 만 서명, 레거시 공개(videos/photos)는 미서명 그대로.
 *  2) 배치 발급 — 한 요청의 여러 경로를 버킷별 1콜로 묶는다(발급 콜 수 최소화).
 *  3) 캐시 재사용 — TTL 안 재요청은 서명자를 다시 호출하지 않는다(발급 폭주 방지).
 *  4) 캐시 만료 — cacheMs 경과 후에는 재발급한다.
 *  5) resolveServeUrl — private→signed, 레거시 공개→저장 URL, 발급 실패→저장 URL 폴백.
 */
import {
  signPrivateRefs,
  resolveServeUrl,
  isPrivateVenueBucket,
  venueSignCacheKey,
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
  const calls: Array<{ bucket: string; paths: string[] }> = [];
  const signer: VenueBatchSigner = async (bucket, paths, ttlSec) => {
    calls.push({ bucket, paths: [...paths] });
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

  console.log("[resolveServeUrl]");
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
    // 발급 실패(맵에 null) → 저장 URL 폴백
    const failMap = new Map<string, string | null>([[venueSignCacheKey("venue-media", P), null]]);
    ok(
      "발급 실패 → 저장 URL 폴백",
      resolveServeUrl({ bucket: "venue-media", path: P, url: "fallback://stored" }, failMap) === "fallback://stored",
    );
    ok("thumb 없음(url null) → null", resolveServeUrl({ bucket: "venue-media", path: P, url: null }, failMap) === null);
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main();
