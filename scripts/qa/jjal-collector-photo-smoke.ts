/**
 * 짤콜렉터(사진) 경로 순수 함수 smoke test — IG/Threads/MLBPARK 사진(캐러셀) 이미지 추출.
 *
 * 실데이터 구조 기반:
 *   - Instagram /embed/ contextJSON display_url (video_url 추출과 대칭)
 *   - Threads /embed <img> 본문 사진 (작성자 아바타 제외)
 *   - MLBPARK #contentDetail 본문 <img> (사이드바 썸네일 제외)
 * Meta가 embed 포맷을, 엠팍이 본문 구조를 바꾸면 각 케이스가 먼저 깨진다.
 *
 * Usage: npx tsx scripts/qa/jjal-collector-photo-smoke.ts
 */

import {
  extractInstagramImageUrls,
  extractInstagramVideoUrls,
  extractThreadsImageUrls,
  extractMlbparkImageUrls,
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

// 1) 실 IG embed 형태(이중 이스케이프 \\\/, \\u0026) display_url → 단일 image 추출 + 언이스케이프.
{
  const html = String.raw`<script>{"is_video":false,"display_url":"https:\\\/\\\/scontent-icn2-1.cdninstagram.com\\\/v\\\/t51.82787-15\\\/744870779_n.jpg?stp=dst-jpg_e35\\u0026_nc_ht=scontent-icn2-1\\u0026oe=6A1CC356","width":1080}</script>`;
  const r = extractInstagramImageUrls(html, 5);
  check(
    "IG embed: 이중 이스케이프 display_url → 단일 image 추출 + 언이스케이프",
    r.length === 1 &&
      r[0].type === "image" &&
      r[0].url ===
        "https://scontent-icn2-1.cdninstagram.com/v/t51.82787-15/744870779_n.jpg?stp=dst-jpg_e35&_nc_ht=scontent-icn2-1&oe=6A1CC356",
    `got ${JSON.stringify(r)}`,
  );
}

// 2) 캐러셀: 커버가 첫 슬라이드와 동일 URL로 한 번 더 등장 → URL dedupe로 흡수, 순서 보존.
{
  const html = String.raw`{"display_url":"https:\/\/cdn.ig.com\/cover.jpg?s=1"},"edge_sidecar_to_children":[{"display_url":"https:\/\/cdn.ig.com\/cover.jpg?s=1"},{"display_url":"https:\/\/cdn.ig.com\/two.jpg?s=1"},{"display_url":"https:\/\/cdn.ig.com\/three.jpg?s=1"}]`;
  const r = extractInstagramImageUrls(html, 5);
  check(
    "IG embed: 캐러셀 커버 중복 dedupe + 등장 순서 유지",
    r.length === 3 &&
      r.map((m) => m.url).join(",") ===
        "https://cdn.ig.com/cover.jpg?s=1,https://cdn.ig.com/two.jpg?s=1,https://cdn.ig.com/three.jpg?s=1",
    `got ${JSON.stringify(r)}`,
  );
}

// 3) max cap: 5장 중 max=2까지만.
{
  const html = String.raw`{"display_url":"https:\/\/cdn.ig.com\/a.jpg"}{"display_url":"https:\/\/cdn.ig.com\/b.jpg"}{"display_url":"https:\/\/cdn.ig.com\/c.jpg"}{"display_url":"https:\/\/cdn.ig.com\/d.jpg"}{"display_url":"https:\/\/cdn.ig.com\/e.jpg"}`;
  const r = extractInstagramImageUrls(html, 2);
  check(
    "IG embed: max=2 cap 정확히 2장",
    r.length === 2 && r[1].url === "https://cdn.ig.com/b.jpg",
    `got ${JSON.stringify(r)}`,
  );
}

// 4) display_url 없으면 빈 배열 (og:image fallback은 호출부 책임).
{
  const html = `<html><head><meta property="og:image" content="https://cdn.ig.com/thumb.jpg"></head></html>`;
  const r = extractInstagramImageUrls(html, 5);
  check("IG embed: display_url 없으면 빈 배열", r.length === 0, `got ${JSON.stringify(r)}`);
}

// 5) max=0이면 빈 배열.
{
  const html = String.raw`{"display_url":"https:\/\/cdn.ig.com\/a.jpg"}`;
  check("max=0이면 빈 배열", extractInstagramImageUrls(html, 0).length === 0);
}

// 6) 사진 전용 embed(video_url 0건)에서 영상 추출기는 빈 배열 — 영상/사진 경로 비간섭.
{
  const html = String.raw`{"is_video":false,"display_url":"https:\/\/cdn.ig.com\/a.jpg"}`;
  check(
    "사진 전용 embed: extractInstagramVideoUrls는 빈 배열 (영상 오탐 없음)",
    extractInstagramVideoUrls(html, 5).length === 0,
    `got ${JSON.stringify(extractInstagramVideoUrls(html, 5))}`,
  );
}

// 7) 실데이터 회귀: display_url query의 %(%) 이스케이프 디코드 (ig_cache_key %3D%3D 보존).
{
  const html = String.raw`{"display_url":"https:\\\/\\\/scontent.cdninstagram.com\\\/a.jpg?ig_cache_key=Mzk\\u00253D\\u00253D.3-ccb7-5\\u0026oe=6A5C1CB6"}`;
  const r = extractInstagramImageUrls(html, 1);
  check(
    "IG embed: \\u0025(%) 디코드 — ig_cache_key %3D%3D 원형 복원",
    r.length === 1 &&
      r[0].url ===
        "https://scontent.cdninstagram.com/a.jpg?ig_cache_key=Mzk%3D%3D.3-ccb7-5&oe=6A5C1CB6",
    `got ${JSON.stringify(r)}`,
  );
}

// 8) Threads embed: <img> 본문 사진 추출 + 작성자 아바타(t51.*-19·s100x100) 제외 + 파일명 dedupe + &amp; 디코드.
{
  const html = `<div>
    <img src="https://scontent.cdninstagram.com/v/t51.82787-19/avatar_n.jpg?stp=dst-jpg_s100x100&amp;oe=1">
    <img src="https://scontent.cdninstagram.com/v/t51.75761-15/111_1790_a_n.jpg?stp=dst-jpg_e35&amp;oe=2">
    <img src="https://scontent.cdninstagram.com/v/t51.75761-15/222_1790_b_n.jpg?stp=dst-jpg_e35&amp;oe=3">
    <img src="https://scontent.cdninstagram.com/v/t51.75761-15/222_1790_b_n.jpg?stp=dst-jpg_e35&amp;oe=9">
  </div>`;
  const r = extractThreadsImageUrls(html, 5);
  check(
    "Threads: 본문 img 2장(아바타 제외·중복 파일명 dedupe) + &amp; 디코드",
    r.length === 2 &&
      r[0].url === "https://scontent.cdninstagram.com/v/t51.75761-15/111_1790_a_n.jpg?stp=dst-jpg_e35&oe=2" &&
      r[1].url.includes("222_1790_b") &&
      !r[0].url.includes("&amp;"),
    `got ${JSON.stringify(r)}`,
  );
}

// 9) Threads: non-Meta 호스트/프로필 efg는 제외.
{
  const html = `<img src="https://example.com/x.jpg"><img src="https://scontent.cdninstagram.com/v/t51.75761-15/1_2_a_n.jpg?efg=profile_pic">`;
  check(
    "Threads: 비-Meta 호스트 + profile_pic efg 제외 → 빈 배열",
    extractThreadsImageUrls(html, 5).length === 0,
    `got ${JSON.stringify(extractThreadsImageUrls(html, 5))}`,
  );
}

// 10) mlbpark: #contentDetail 본문 img만 (사이드바/이모티콘/광고박스 이후 제외) + 등장 순서.
{
  const html = `<div class="hotissue"><a><img src="https://simg.donga.com/ugc/MLBPARK/Board/99/99/99/99/sidebar_thumb.jpg"></a></div>
    <div id='contentDetail'>
      <img src='https://simg.donga.com/ugc/MLBPARK/Board/17/00/00/01/content_a.jpeg'>
      본문 텍스트 <img src='https://imgpark.donga.com/mbs/editor/img/emotions/01.gif'>
      <img src="https://simg.donga.com/ugc/MLBPARK/Board/17/00/00/02/content_b.jpg">
    </div>
    <div id='adstream_box'><img src="https://simg.donga.com/ugc/MLBPARK/Board/88/88/88/88/ad_after.jpg"></div>`;
  const r = extractMlbparkImageUrls(html, 5);
  check(
    "mlbpark: 본문 2장만 (사이드바 前·이모티콘·광고박스 後 제외) + 순서 유지",
    r.length === 2 && r[0].url.includes("content_a") && r[1].url.includes("content_b"),
    `got ${JSON.stringify(r)}`,
  );
}

// 11) mlbpark: 본문 컨테이너 없으면 빈 배열 (og:image 폴백은 호출부 책임).
{
  check(
    "mlbpark: #contentDetail 없으면 빈 배열",
    extractMlbparkImageUrls(`<html><body><img src="https://simg.donga.com/ugc/MLBPARK/Board/1/2/3/4/x.jpg"></body></html>`, 5).length === 0,
  );
}

// 12) inferMediaExt: webp 지원 (IG가 webp로 내려줄 때 .bin 방지).
check("content-type image/webp → webp", inferMediaExt("image/webp", "https://x.com/a") === "webp");
check(
  "URL 확장자 .webp fallback",
  inferMediaExt("application/octet-stream", "https://x.com/a.webp?q=1") === "webp",
);
check("content-type image/jpeg → jpg (회귀)", inferMediaExt("image/jpeg", "https://x.com/a") === "jpg");

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
