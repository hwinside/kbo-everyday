#!/usr/bin/env node
/**
 * QA: videos-rss playlistItems.list fallback 검증
 *
 * 용도:
 *   - 머지 전 fetchChannelUploadsViaApi (UC→UU 스왑 + playlistItems.list)
 *     실제 응답을 라이브 호출로 확인. cron route는 동일 함수를 그대로 부른다.
 *
 * 검증 시나리오 (실제 YouTube API에 요청):
 *   1. 정상 채널 (LG Twins 공식, UCL6QZZxb-HR4hCh_eFAnQWA)
 *      → snippet+contentDetails로 채워진 RssVideoEntry[] 반환 기대
 *   2. UC 아닌 ID
 *      → null (조기 가드)
 *   3. UC 포맷이지만 존재하지 않는 채널
 *      → [] (404 → 빈 배열 처리)
 *
 * 사용법:
 *   node scripts/qa/qa-videos-rss-fallback.mjs
 *
 * exit 0 = 모든 케이스 PASS, 1 = 하나라도 FAIL
 */
import "./_env.mjs";

const API_KEY = process.env.YOUTUBE_API_KEY;

if (!API_KEY) {
  console.error("[qa] YOUTUBE_API_KEY 가 .env.local에 없음 — 검증 불가");
  process.exit(1);
}

// Mirrors src/lib/video/youtube-api.ts → fetchChannelUploadsViaApi.
// Kept inline so the QA script has no TS toolchain dependency.
async function fetchChannelUploadsViaApi(channelId, maxResults = 5) {
  if (!API_KEY) return null;
  if (!channelId.startsWith("UC")) return null;
  const playlistId = `UU${channelId.slice(2)}`;
  const limit = Math.min(Math.max(maxResults, 1), 50);

  try {
    const url =
      `https://www.googleapis.com/youtube/v3/playlistItems` +
      `?part=snippet,contentDetails&playlistId=${playlistId}` +
      `&maxResults=${limit}&key=${API_KEY}`;
    const res = await fetch(url);
    if (res.status === 403) return null;
    if (res.status === 404) return [];
    if (!res.ok) return null;
    const data = await res.json();
    const items = data.items ?? [];
    const out = [];
    for (const it of items) {
      const videoId = it.contentDetails?.videoId;
      const publishedAt =
        it.contentDetails?.videoPublishedAt ?? it.snippet?.publishedAt;
      if (!videoId || !publishedAt) continue;
      const t = it.snippet?.thumbnails;
      const thumbnail =
        t?.maxres?.url ??
        t?.high?.url ??
        t?.medium?.url ??
        t?.default?.url ??
        "";
      out.push({
        video_id: videoId,
        title: it.snippet?.title ?? "",
        thumbnail,
        channel: it.snippet?.channelTitle ?? "",
        channel_id: channelId,
        published_at: publishedAt,
      });
    }
    return out;
  } catch {
    return null;
  }
}

function fmt(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return `Array(${v.length})`;
  return JSON.stringify(v).slice(0, 120);
}

let failed = 0;
async function check(label, fn, predicate, evidenceFn) {
  process.stdout.write(`• ${label} ... `);
  let value;
  try {
    value = await fn();
  } catch (e) {
    console.log(`FAIL (threw: ${e.message})`);
    failed++;
    return;
  }
  if (predicate(value)) {
    console.log(`PASS  ${evidenceFn ? `→ ${evidenceFn(value)}` : ""}`);
  } else {
    console.log(`FAIL  → got ${fmt(value)}`);
    failed++;
  }
}

console.log("[qa] videos-rss fallback (playlistItems.list) 검증\n");
console.log("single API key configured: yes\n");

// 1) 정상 채널
await check(
  "LG Twins 공식(UCL6QZZxb-HR4hCh_eFAnQWA) → 비어있지 않은 RssVideoEntry[]",
  () => fetchChannelUploadsViaApi("UCL6QZZxb-HR4hCh_eFAnQWA", 5),
  (v) =>
    Array.isArray(v) &&
    v.length > 0 &&
    v.every(
      (e) =>
        typeof e.video_id === "string" &&
        e.video_id.length === 11 &&
        typeof e.title === "string" &&
        typeof e.published_at === "string" &&
        e.channel_id === "UCL6QZZxb-HR4hCh_eFAnQWA",
    ),
  (v) =>
    `${v.length}rows, latest=${v[0].published_at.slice(0, 10)} "${v[0].title.slice(0, 40)}…"`,
);

// 2) UC 포맷 아닌 ID → 조기 null
await check(
  "non-UC id ('NOTACHANNEL') → null",
  () => fetchChannelUploadsViaApi("NOTACHANNEL"),
  (v) => v === null,
);

// 3) UC 포맷이지만 존재하지 않는 채널 → 404 → []
await check(
  "valid UC format but non-existent → []",
  () => fetchChannelUploadsViaApi("UC_QA_NONEXISTENT_999999"),
  (v) => Array.isArray(v) && v.length === 0,
);

console.log();
if (failed === 0) {
  console.log("✓ ALL PASS — fallback fetcher 동작 OK");
  process.exit(0);
} else {
  console.log(`✗ ${failed} case FAIL`);
  process.exit(1);
}
