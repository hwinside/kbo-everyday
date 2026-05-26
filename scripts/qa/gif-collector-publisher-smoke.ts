/**
 * 움짤콜렉터 publisher 순수 함수 smoke test (외부 fetch/DB 제외).
 *
 * Usage: npx tsx scripts/qa/gif-collector-publisher-smoke.ts
 */

import { extractMediaList, extractOgMedia, inferMediaExt } from "@/lib/gif-collector/og-media";

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

// inferMediaExt
check("content-type image/gif → gif", inferMediaExt("image/gif", "https://x.com/a") === "gif");
check("content-type video/mp4 → mp4", inferMediaExt("video/mp4", "https://x.com/a") === "mp4");
check("content-type image/jpeg → jpg", inferMediaExt("image/jpeg", "https://x.com/a") === "jpg");
check("content-type 없을 때 URL 확장자 fallback (.gif)", inferMediaExt("application/octet-stream", "https://x.com/a.gif?q=1") === "gif");
check("content-type 없고 URL도 확장자 없으면 bin", inferMediaExt("application/octet-stream", "https://x.com/a") === "bin");

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
