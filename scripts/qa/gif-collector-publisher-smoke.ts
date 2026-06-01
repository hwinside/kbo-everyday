/**
 * 움짤콜렉터 publisher 순수 함수 smoke test (외부 fetch/DB 제외).
 *
 * Usage: npx tsx scripts/qa/gif-collector-publisher-smoke.ts
 */

import {
  extractMediaList,
  extractOgMedia,
  extractInstagramVideoUrls,
  inferMediaExt,
} from "@/lib/gif-collector/og-media";

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

// extractOgMedia
{
  const html = `<html><head>
    <meta property="og:image" content="https://cdn.example.com/abc.gif">
    <meta property="og:video" content="https://cdn.example.com/abc.mp4">
  </head></html>`;
  const r = extractOgMedia(html);
  check(
    "og:video > og:image 우선",
    r?.type === "video" && r?.url === "https://cdn.example.com/abc.mp4",
    `got ${JSON.stringify(r)}`,
  );
}
{
  const html = `<meta property="og:image" content="https://cdn.example.com/only.gif">`;
  const r = extractOgMedia(html);
  check(
    "og:image만 있으면 image",
    r?.type === "image" && r?.url === "https://cdn.example.com/only.gif",
    `got ${JSON.stringify(r)}`,
  );
}
{
  const r = extractOgMedia(`<html><head><title>no meta</title></head></html>`);
  check("og 메타 없으면 null", r === null);
}
{
  const html = `<html><head>
    <meta property="og:image" content="https://image.donga.com/challenge/mlbpark/images/share_icon.png" />
  </head><body>
    <source src="https://simg.donga.com/ugc/MLBPARK/Board/17/79/70/65/1779706555516.mp4" type="video/mp4">
  </body></html>`;
  const r = extractOgMedia(html);
  check(
    "MLBPARK 본문 mp4가 공용 og:image보다 우선",
    r?.type === "video" && r?.url === "https://simg.donga.com/ugc/MLBPARK/Board/17/79/70/65/1779706555516.mp4",
    `got ${JSON.stringify(r)}`,
  );
}
{
  const html = `<meta property="og:image" content="https://image.donga.com/challenge/mlbpark/images/share_icon.png" />`;
  const r = extractOgMedia(html);
  check("MLBPARK 공용 share_icon만 있으면 null", r === null, `got ${JSON.stringify(r)}`);
}
{
  const html = `<meta property="og:video:secure_url" content="https://cdn.example.com/a.mp4">`;
  const r = extractOgMedia(html);
  check(
    "og:video:secure_url 변형 인식",
    r?.type === "video" && r?.url === "https://cdn.example.com/a.mp4",
    `got ${JSON.stringify(r)}`,
  );
}
{
  // 속성 순서 뒤바뀐 케이스
  const html = `<meta content="https://cdn.example.com/x.gif" property="og:image">`;
  const r = extractOgMedia(html);
  check(
    "속성 순서 뒤바뀐 og:image 인식",
    r?.type === "image" && r?.url === "https://cdn.example.com/x.gif",
    `got ${JSON.stringify(r)}`,
  );
}

// extractMediaList (multi)
{
  const html = `<html><body>
    <source src="https://cdn.example.com/v1.mp4" type="video/mp4">
    <video src="https://cdn.example.com/v2.mp4"></video>
    <a href="https://cdn.example.com/v3.mp4">v3</a>
  </body></html>`;
  const r = extractMediaList(html, 3);
  check(
    "video/source + 직접 mp4 URL 3개 모두 수집",
    r.length === 3 && r.every((m) => m.type === "video") && r.map((m) => m.url).join(",") === "https://cdn.example.com/v1.mp4,https://cdn.example.com/v2.mp4,https://cdn.example.com/v3.mp4",
    `got ${JSON.stringify(r)}`,
  );
}
{
  const html = `<html><body>
    <source src="https://cdn.example.com/dup.mp4">
    <video src="https://cdn.example.com/dup.mp4"></video>
    <a href="https://cdn.example.com/dup.mp4">d</a>
  </body></html>`;
  const r = extractMediaList(html, 3);
  check("동일 URL은 dedupe", r.length === 1 && r[0].url === "https://cdn.example.com/dup.mp4", `got ${JSON.stringify(r)}`);
}
{
  const html = `<html><body>
    <source src="https://cdn.example.com/a.mp4">
    <source src="https://cdn.example.com/b.mp4">
    <source src="https://cdn.example.com/c.mp4">
    <source src="https://cdn.example.com/d.mp4">
  </body></html>`;
  const r = extractMediaList(html, 3);
  check("max=3 cap 정확히 3개까지만", r.length === 3 && r[2].url === "https://cdn.example.com/c.mp4", `got ${JSON.stringify(r)}`);
}
{
  const html = `<html><head>
    <meta property="og:image" content="https://cdn.example.com/thumb.gif">
  </head><body>
    <source src="https://cdn.example.com/v.mp4">
  </body></html>`;
  const r = extractMediaList(html, 3);
  check(
    "비디오 있으면 이미지 무시 (혼합 X)",
    r.length === 1 && r[0].type === "video",
    `got ${JSON.stringify(r)}`,
  );
}
{
  const html = `<meta property="og:image" content="https://cdn.example.com/only.gif">`;
  const r = extractMediaList(html, 3);
  check("비디오 0건이면 og:image fallback (단일)", r.length === 1 && r[0].type === "image", `got ${JSON.stringify(r)}`);
}
{
  const r = extractMediaList(`<html></html>`, 3);
  check("미디어 없으면 빈 배열", r.length === 0);
}
{
  const html = `<source src="https://cdn.example.com/a.mp4">`;
  const r = extractMediaList(html, 0);
  check("max=0이면 빈 배열", r.length === 0);
}

// Threads /embed 추출 회귀 가드 — 실데이터(threads.com /embed) 구조 기반.
// embed 페이지의 <video> 태그엔 src가 없고, cdninstagram mp4가 HTML 엔티티 인코딩된
// 서명 URL로 본문에 들어있다. Meta가 embed 포맷 바꾸면 이 케이스가 먼저 깨진다.
{
  const html = `<html><body>
    <video controls="1" loop="1" class=""></video>
    <script>{"playable_url":"https://scontent-icn2-1.cdninstagram.com/o1/v/t16/f2/m84/AQMbdRn.mp4?_nc_cat=106&amp;_nc_ohc=rqhAm0&amp;oh=00_Af7suA&amp;oe=6A1CC356"}</script>
  </body></html>`;
  const r = extractMediaList(html, 3);
  check(
    "Threads embed: src 없는 video 태그 + 엔티티 인코딩 cdninstagram mp4 → 단일 video 추출",
    r.length === 1 &&
      r[0].type === "video" &&
      r[0].url === "https://scontent-icn2-1.cdninstagram.com/o1/v/t16/f2/m84/AQMbdRn.mp4?_nc_cat=106&_nc_ohc=rqhAm0&oh=00_Af7suA&oe=6A1CC356",
    `got ${JSON.stringify(r)}`,
  );
}
{
  const html = `<a href="https://scontent.cdninstagram.com/v/x.mp4?ccb=17-1&amp;oh=00_SIG&amp;oe=6A1CC356">v</a>`;
  const r = extractMediaList(html, 1);
  check(
    "Threads 서명 mp4의 &amp; 쿼리 구분자가 & 로 디코딩 (서명 파라미터 보존)",
    r.length === 1 && !r[0].url.includes("&amp;") && r[0].url.endsWith("&oe=6A1CC356"),
    `got ${JSON.stringify(r)}`,
  );
}

// Instagram /embed 추출 회귀 가드 — 실데이터(instagram.com /embed) 구조 기반.
// reel/p 본문엔 og:image(썸네일)만 있고, /embed/ 페이지 contextJSON 안에 video_url이
// 이중 인코딩(\\/ , \\u0026)된 채 들어있다. Meta가 embed/contextJSON 포맷 바꾸면 먼저 깨진다.
{
  // 실제 IG embed의 이중 이스케이프 형태(\\\/, \\u0026). String.raw로 원형 바이트 그대로 표현.
  const html = String.raw`<script>{"is_video":true,"video_url":"https:\\\/\\\/scontent-icn2-1.cdninstagram.com\\\/o1\\\/v\\\/t2\\\/AQabc.mp4?_nc_cat=106\\u0026_nc_sid=5e9851\\u0026oe=6A23A572","width":720}</script>`;
  const r = extractInstagramVideoUrls(html, 3);
  check(
    "IG embed: 이중 이스케이프 video_url → 단일 video 추출 + 언이스케이프",
    r.length === 1 &&
      r[0].type === "video" &&
      r[0].url ===
        "https://scontent-icn2-1.cdninstagram.com/o1/v/t2/AQabc.mp4?_nc_cat=106&_nc_sid=5e9851&oe=6A23A572",
    `got ${JSON.stringify(r)}`,
  );
}
{
  // 단일 이스케이프(\/) 형태도 동일하게 처리
  const html = String.raw`{"video_url":"https:\/\/cdn.example.com\/v.mp4?a=1&b=2"}`;
  const r = extractInstagramVideoUrls(html, 1);
  check(
    "IG embed: 단일 이스케이프 video_url + \\u0026 → & 디코딩",
    r.length === 1 && r[0].url === "https://cdn.example.com/v.mp4?a=1&b=2",
    `got ${JSON.stringify(r)}`,
  );
}
{
  const html = `<html><head><meta property="og:image" content="https://cdn.example.com/thumb.jpg"></head></html>`;
  const r = extractInstagramVideoUrls(html, 3);
  check("IG embed: video_url 없으면 빈 배열 (썸네일 fallback은 호출부 책임)", r.length === 0, `got ${JSON.stringify(r)}`);
}

// inferMediaExt
check("content-type image/gif → gif", inferMediaExt("image/gif", "https://x.com/a") === "gif");
check("content-type video/mp4 → mp4", inferMediaExt("video/mp4", "https://x.com/a") === "mp4");
check("content-type image/jpeg → jpg", inferMediaExt("image/jpeg", "https://x.com/a") === "jpg");
check("content-type 없을 때 URL 확장자 fallback (.gif)", inferMediaExt("application/octet-stream", "https://x.com/a.gif?q=1") === "gif");
check("content-type 없고 URL도 확장자 없으면 bin", inferMediaExt("application/octet-stream", "https://x.com/a") === "bin");

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
