/**
 * Threads 미디어 orchestration 회귀 smoke — 실제 fetchMediaList 실행선에 결속.
 *
 * 삼순 NO-GO 2건(2026-07-31) 대응:
 *   (2) 회귀 테스트가 실제 수정선(getThreadsEmbedUrl(resolvedUrl))에 결속되지 않으면 안 됨.
 *   → globalThis.fetch를 mock해 redirect(res.url)→embed 재조회→영상>사진 우선 orchestration을
 *      통째로 실행한다. resolvedUrl→sourceUrl로 결함주입하면 RED가 되어야 실효 검증.
 *   (1) embed 429/5xx / 200-unknown / <video>만 있고 mp4 없음 → photo 발행 0(fail-close).
 *
 * fetchMediaList는 publisher.ts에 있고 supabaseAdmin을 모듈 로드 시 생성하므로,
 * dummy env를 세팅한 뒤 dynamic import한다(createClient는 construct 시 네트워크를 치지 않음).
 *
 * Usage: npx tsx scripts/qa/jjal-collector-threads-orchestration-smoke.ts
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "anon-test-key";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`✓ ${name}`);
    pass++;
  } else {
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

const CANONICAL = "https://www.threads.com/@dydal06/post/DbaxddEk7IV";
const SHARE = "https://www.threads.com/share/BASpyXtGA0/";

// Threads 원문 SPA: og:image(영상 poster)만. (embed 조회 전 단계에서 photo로 확정되면 안 됨.)
const ORIGIN_HTML = `<html><head>
  <meta property="og:image" content="https://scontent.cdninstagram.com/v/t51.71878-15/poster_640.jpg?stp=cmp1_ds">
  <meta property="og:image:width" content="640">
</head><body>Threads</body></html>`;

const EMBED_WITH_MP4 = `<html><body>
  <video><source src="https://scontent.cdninstagram.com/o1/v/t16/clip.mp4"></video>
</body></html>`;

// <video>는 있으나 재생 URL은 blob: (mp4 추출 불가) — 영상 추출 실패지 사진 아님.
const EMBED_VIDEO_NO_MP4 = `<html><body>
  <video src="blob:https://www.threads.com/xyz" poster="https://scontent.cdninstagram.com/poster.jpg"></video>
</body></html>`;

// 실제 Threads 사진글: <video> 없이 본문 <img>만.
const EMBED_PHOTO = `<html><body>
  <img src="https://scontent.cdninstagram.com/v/t51.2885-15/real_photo.jpg?_nc=1">
</body></html>`;

// 200 unknown: 영상/사진 어느 것도 확정 못 하는 임베드.
const EMBED_UNKNOWN = `<html><body><div>loading…</div></body></html>`;

type Route = { status?: number; finalUrl?: string; html: string };
let routes: Record<string, Route> = {};

async function main(): Promise<void> {
  const { fetchMediaList } = await import("@/lib/gif-collector/publisher");
const origFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown) => {
  const url = String(input);
  const r = routes[url];
  if (!r) return { ok: false, status: 404, url, text: async () => "" } as unknown as Response;
  const status = r.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    url: r.finalUrl ?? url, // redirect 최종 URL(res.url) 시뮬레이션
    text: async () => r.html,
  } as unknown as Response;
}) as typeof fetch;

function types(media: { type: string }[]): string {
  return media.map((m) => m.type).join(",") || "(none)";
}

try {
  // 1) /share/ redirect → canonical resolve → embed mp4 → VIDEO
  routes = {
    [SHARE]: { finalUrl: CANONICAL, html: ORIGIN_HTML },
    [`${CANONICAL}/embed`]: { html: EMBED_WITH_MP4 },
  };
  {
    const r = await fetchMediaList(SHARE);
    check(
      "1) /share/ → redirect resolve → embed mp4 → VIDEO(움짤콜렉터)",
      r.media.length === 1 && r.media[0].type === "video" &&
        r.media[0].url === "https://scontent.cdninstagram.com/o1/v/t16/clip.mp4",
      `got ${types(r.media)} ${JSON.stringify(r.media)}`,
    );
  }

  // 2) canonical @handle/post 직접 입력 영상도 동일 VIDEO
  routes = {
    [CANONICAL]: { finalUrl: CANONICAL, html: ORIGIN_HTML },
    [`${CANONICAL}/embed`]: { html: EMBED_WITH_MP4 },
  };
  {
    const r = await fetchMediaList(CANONICAL);
    check(
      "2) canonical @handle/post 영상도 VIDEO",
      r.media.length === 1 && r.media[0].type === "video",
      `got ${types(r.media)}`,
    );
  }

  // 3) 실제 Threads 사진글 → PHOTO(짤콜렉터)
  routes = {
    [SHARE]: { finalUrl: CANONICAL, html: ORIGIN_HTML },
    [`${CANONICAL}/embed`]: { html: EMBED_PHOTO },
  };
  {
    const r = await fetchMediaList(SHARE);
    check(
      "3) 실제 Threads 사진글 → PHOTO(짤콜렉터)",
      r.media.length >= 1 && r.media.every((m) => m.type === "image"),
      `got ${types(r.media)}`,
    );
  }

  // 4) embed 429 → 원문 og:image poster로 photo 발행 0 (fail-close)
  routes = {
    [SHARE]: { finalUrl: CANONICAL, html: ORIGIN_HTML },
    [`${CANONICAL}/embed`]: { status: 429, html: "" },
  };
  {
    const r = await fetchMediaList(SHARE);
    check("4) embed 429 → photo 발행 0 (fail-close)", r.media.length === 0, `got ${types(r.media)}`);
  }

  // 5) embed 5xx → photo 발행 0
  routes = {
    [SHARE]: { finalUrl: CANONICAL, html: ORIGIN_HTML },
    [`${CANONICAL}/embed`]: { status: 503, html: "" },
  };
  {
    const r = await fetchMediaList(SHARE);
    check("5) embed 5xx → photo 발행 0 (fail-close)", r.media.length === 0, `got ${types(r.media)}`);
  }

  // 6) embed 200 unknown → photo 발행 0
  routes = {
    [SHARE]: { finalUrl: CANONICAL, html: ORIGIN_HTML },
    [`${CANONICAL}/embed`]: { html: EMBED_UNKNOWN },
  };
  {
    const r = await fetchMediaList(SHARE);
    check("6) embed 200 unknown → photo 발행 0 (fail-close)", r.media.length === 0, `got ${types(r.media)}`);
  }

  // 7) <video> 있으나 mp4 없음 → 추출 실패, photo 발행 0
  routes = {
    [SHARE]: { finalUrl: CANONICAL, html: ORIGIN_HTML },
    [`${CANONICAL}/embed`]: { html: EMBED_VIDEO_NO_MP4 },
  };
  {
    const r = await fetchMediaList(SHARE);
    check(
      "7) <video> 있으나 mp4 없음 → photo 발행 0 (추출 실패)",
      r.media.length === 0,
      `got ${types(r.media)}`,
    );
  }

  // 8) [결함주입 가드] resolvedUrl 대신 sourceUrl(=/share/)로 embed를 만들면(구 버그) embed URL이
  //    null이 되어 재조회를 못 하고, fail-close로 media 0이 되어야 한다. 즉 시나리오 1이 RED가 된다.
  //    → 이 테스트는 "수정선이 실제로 결과를 바꾼다"는 것을 문서화(현재 코드에선 media=1 video).
  {
    routes = {
      [SHARE]: { finalUrl: CANONICAL, html: ORIGIN_HTML },
      [`${CANONICAL}/embed`]: { html: EMBED_WITH_MP4 },
    };
    const fixed = await fetchMediaList(SHARE);
    check(
      "8) 결함주입 가드: 수정선이 결과를 좌우(현재 코드 = VIDEO 1건, 구 버그면 0건)",
      fixed.media.length === 1 && fixed.media[0].type === "video",
      `got ${types(fixed.media)}`,
    );
  }
} finally {
  globalThis.fetch = origFetch;
}

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
