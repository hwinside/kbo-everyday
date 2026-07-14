/**
 * 움짤콜렉터/짤콜렉터 발행 워커.
 *
 * 단일 큐 행을 받아 *최대 N개*의 미디어를 추출/다운로드/Storage 업로드 후 posts 행으로 발행한다.
 * Webhook이 큐 INSERT 직후 즉시 호출하는 동기 흐름.
 *
 * 영상 우선 분기:
 *   - 영상이 추출되면 → 움짤콜렉터가 video_urls로 발행.
 *   - 영상이 없고 사진이 있으면 → 짤콜렉터가 image_urls(사진글, 캐러셀 여러 장)로 발행.
 *   - 둘 다 없으면 철회.
 *
 * 흐름:
 *   1. queue row 조회 (status='pending')
 *   2. source_url 에서 미디어 목록 추출 (최대 MAX_MEDIA_ITEMS개, 영상/사진 판별)
 *   3. 각 미디어 다운로드 (UA + Referer, 30MB 캡, 15초 timeout) — best-effort
 *   4. Supabase Storage('photos/{gif-collector|jjal-collector}/{queueId}-N.ext') 업로드 — best-effort
 *   5. 최소 한 건이라도 업로드 성공해야 posts INSERT (video_urls / image_urls 배열)
 *   6. queue UPDATE (status='auto_posted', posted_post_id, posted_at)
 *
 * 실패 시: status='rejected' + reviewed_at. error 메시지는 caller가 슬랙으로 전달.
 *
 * Env:
 *   GIF_COLLECTOR_BOT_USER_ID  — 움짤콜렉터(영상) 봇 UUID (`seed-gif-collector-bot.ts`).
 *   JJAL_COLLECTOR_BOT_USER_ID — 짤콜렉터(사진) 봇 UUID (`seed-jjal-collector-bot.ts`).
 */

import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  extractMediaList,
  extractInstagramVideoUrls,
  extractInstagramImageUrls,
  extractThreadsImageUrls,
  extractMlbparkImageUrls,
  inferMediaExt,
  type OgMedia,
} from "./og-media";
import { appendAttribution } from "./attribution";
import { normalizeQueueTextForPost } from "./text-normalizer";
import playersRoster from "@/lib/constants/players-roster.json";
import type { RosterPlayer } from "@/types/api";
import { getTeamBySlug } from "@/lib/constants/teams";

const ROSTER = playersRoster as RosterPlayer[];

const BUCKET = "photos";
const STORAGE_FOLDER = "gif-collector";
const FETCH_TIMEOUT_MS = 15_000;
const MAX_MEDIA_BYTES = 30 * 1024 * 1024;
const MAX_MEDIA_ITEMS = 5; // 사진게시판 첨부 상한(5, #407)과 정합. 4개+ 영상 mlbpark 글에서 일부 누락되던 문제(#cs 2026-06-22).
const FETCH_USER_AGENT = "Mozilla/5.0 (compatible; KeubofanGifCollector/1.0; +https://keubo.fan)";

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// sourceHtml: 원문 페이지 HTML(출처 핸들 추출용). embed로 영상을 찾아도 원문 페이지 HTML을 함께 돌려준다.
async function fetchMediaList(sourceUrl: string): Promise<{ media: OgMedia[]; sourceHtml: string | null }> {
  const html = await fetchPageHtml(sourceUrl);
  if (!html) return { media: [], sourceHtml: null };

  const media = extractMediaList(html, MAX_MEDIA_ITEMS);
  if (media.some((m) => m.type === "video")) return { media, sourceHtml: html };

  // SPA(Threads 등) — embed 페이지에서 한 번 더 시도. 영상 우선(움짤콜렉터) → 없으면 사진(짤콜렉터).
  const threadsEmbedUrl = getThreadsEmbedUrl(sourceUrl);
  if (threadsEmbedUrl) {
    const embedHtml = await fetchPageHtml(threadsEmbedUrl);
    if (embedHtml) {
      const embedMedia = extractMediaList(embedHtml, MAX_MEDIA_ITEMS);
      if (embedMedia.some((m) => m.type === "video")) return { media: embedMedia, sourceHtml: html };
      const thImages = extractThreadsImageUrls(embedHtml, MAX_MEDIA_ITEMS);
      if (thImages.length > 0) return { media: thImages, sourceHtml: html };
    }
  }

  // Instagram reel/p/tv — 본문엔 og:image(썸네일)만 있고, /embed/ 페이지 contextJSON에
  // video_url(영상) 또는 display_url(사진 캐러셀)이 들어있음. 임베드는 한 번만 받아 둘 다 시도.
  // 영상 우선(움짤콜렉터) → 영상이 없으면 캐러셀 이미지(짤콜렉터).
  const instagramEmbedUrl = getInstagramEmbedUrl(sourceUrl);
  if (instagramEmbedUrl) {
    const embedHtml = await fetchPageHtml(instagramEmbedUrl);
    if (embedHtml) {
      const igVideos = extractInstagramVideoUrls(embedHtml, MAX_MEDIA_ITEMS);
      if (igVideos.length > 0) return { media: igVideos, sourceHtml: html };
      const igImages = extractInstagramImageUrls(embedHtml, MAX_MEDIA_ITEMS);
      if (igImages.length > 0) return { media: igImages, sourceHtml: html };
    }
  }

  // MLBPARK 본문(#contentDetail) 사진 여러 장 — og:image 단일 폴백보다 우선. 서버 렌더라 원문 HTML 그대로 사용.
  if (isMlbparkUrl(sourceUrl)) {
    const mlbImages = extractMlbparkImageUrls(html, MAX_MEDIA_ITEMS);
    if (mlbImages.length > 0) return { media: mlbImages, sourceHtml: html };
  }

  return { media, sourceHtml: html };
}

function isMlbparkUrl(sourceUrl: string): boolean {
  try {
    return new URL(sourceUrl).hostname.toLowerCase().endsWith("mlbpark.donga.com");
  } catch {
    return false;
  }
}

async function fetchPageHtml(url: string): Promise<string | null> {
  const res = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": FETCH_USER_AGENT,
    },
  });
  if (!res.ok) return null;
  return res.text();
}

function getThreadsEmbedUrl(sourceUrl: string): string | null {
  try {
    const u = new URL(sourceUrl);
    const host = u.hostname.toLowerCase();
    if (!host.endsWith("threads.com") && !host.endsWith("threads.net")) return null;
    // 공유 URL은 코드 뒤에 한글 슬러그가 붙는 경우가 많음(/@h/post/CODE/kbo-...) — 첫 세그먼트만 캡처.
    const m = u.pathname.match(/^\/(@[^/]+\/post\/[^/]+)/i);
    if (!m) return null;
    return `${u.origin}/${m[1]}/embed`;
  } catch {
    return null;
  }
}

function getInstagramEmbedUrl(sourceUrl: string): string | null {
  try {
    const u = new URL(sourceUrl);
    const host = u.hostname.toLowerCase();
    if (!host.endsWith("instagram.com")) return null;
    // reel / reels / p / tv 의 단축코드 기반 게시물만 — 원본 세그먼트를 유지해 /embed/ 부착
    const m = u.pathname.match(/^\/((?:reel|reels|p|tv)\/[^/]+)/i);
    if (!m) return null;
    return `${u.origin}/${m[1]}/embed/`;
  } catch {
    return null;
  }
}

async function downloadMedia(
  mediaUrl: string,
  refererOrigin: string,
): Promise<{ buf: Buffer; contentType: string; ext: string } | null> {
  const res = await fetchWithTimeout(mediaUrl, {
    headers: {
      "User-Agent": FETCH_USER_AGENT,
      Referer: refererOrigin,
    },
  });
  if (!res.ok) return null;
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  const contentLength = Number(res.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_MEDIA_BYTES) return null;

  const arrayBuf = await res.arrayBuffer();
  const buf = Buffer.from(arrayBuf);
  if (buf.byteLength > MAX_MEDIA_BYTES) return null;
  return { buf, contentType, ext: inferMediaExt(contentType, mediaUrl) };
}

interface QueueRow {
  id: number;
  source_url: string;
  source_title: string;
  source_content: string | null;
  matched_kbo_id: string | null;
  matched_board_type: string | null;
  matched_board_id: string | null;
  match_status: string;
}

export interface PublishResult {
  ok: boolean;
  /** 발행 종류: 영상(움짤콜렉터) / 사진(짤콜렉터). */
  kind?: "video" | "photo";
  postId?: number;
  /** 첫 업로드 URL (단일 미디어 시절과의 호환). */
  publicUrl?: string;
  /** 업로드 성공한 모든 미디어 URL. */
  publicUrls?: string[];
  /** post는 만들어졌지만 queue update가 실패한 부분 성공 시그널. */
  partial?: boolean;
  /** 추출되어 다운로드 시도된 미디어 개수. */
  attempted?: number;
  /** 업로드까지 성공한 미디어 개수. attempted > succeeded면 partial best-effort. */
  succeeded?: number;
  /** 항목별 실패 사유 (다운로드/업로드 실패). best-effort 시 부분실패 안내용. */
  mediaErrors?: string[];
  error?: string;
}

export async function publishQueueItem(queueId: number): Promise<PublishResult> {
  const { data: row, error: getErr } = await supabaseAdmin
    .from("gif_collector_queue")
    .select(
      "id, source_url, source_title, source_content, matched_kbo_id, matched_board_type, matched_board_id, match_status",
    )
    .eq("id", queueId)
    .single<QueueRow>();
  if (getErr || !row) return { ok: false, error: `queue row ${queueId} not found` };
  if (row.match_status !== "pending") {
    return { ok: false, error: `queue row ${queueId} status=${row.match_status}` };
  }
  if (!row.matched_board_type || !row.matched_board_id) {
    return { ok: false, error: `queue row ${queueId} missing board target` };
  }

  let mediaList: OgMedia[];
  let sourceHtml: string | null = null;
  try {
    const fetched = await fetchMediaList(row.source_url);
    mediaList = fetched.media;
    sourceHtml = fetched.sourceHtml;
  } catch (e) {
    return rejectAndReturn(queueId, `og fetch error: ${(e as Error).message}`);
  }
  if (mediaList.length === 0) {
    return rejectAndReturn(queueId, "media not found (og:video / og:image 모두 없음)");
  }

  // 영상 우선 분기: 영상이 있으면 움짤콜렉터가 video_urls로, 영상이 없고 사진이 있으면
  // 짤콜렉터가 image_urls(사진글)로 발행한다. 둘 다 없을 때만 철회.
  const videoMedia = mediaList.filter((m) => m.type === "video");
  const imageMedia = mediaList.filter((m) => m.type === "image");

  let kind: "video" | "photo";
  let selectedMedia: OgMedia[];
  let botUserId: string | undefined;
  if (videoMedia.length > 0) {
    kind = "video";
    selectedMedia = videoMedia;
    botUserId = process.env.GIF_COLLECTOR_BOT_USER_ID;
  } else if (imageMedia.length > 0) {
    kind = "photo";
    selectedMedia = imageMedia;
    botUserId = process.env.JJAL_COLLECTOR_BOT_USER_ID;
  } else {
    return rejectAndReturn(queueId, "영상·사진 추출 실패 (미디어 없음).");
  }
  if (!botUserId) {
    return rejectAndReturn(
      queueId,
      kind === "video"
        ? "GIF_COLLECTOR_BOT_USER_ID env not configured"
        : "JJAL_COLLECTOR_BOT_USER_ID env not configured",
    );
  }

  let refererOrigin: string;
  try {
    refererOrigin = new URL(row.source_url).origin;
  } catch {
    refererOrigin = "";
  }

  // best-effort 다운로드 — 항목별 실패는 mediaErrors에 누적, 0건 성공 시 전체 reject.
  const downloaded: Array<{
    og: OgMedia;
    data: NonNullable<Awaited<ReturnType<typeof downloadMedia>>>;
  }> = [];
  const mediaErrors: string[] = [];
  for (let i = 0; i < selectedMedia.length; i++) {
    const og = selectedMedia[i];
    let data: Awaited<ReturnType<typeof downloadMedia>>;
    try {
      data = await downloadMedia(og.url, refererOrigin);
    } catch (e) {
      mediaErrors.push(`#${i + 1} download error: ${(e as Error).message}`);
      continue;
    }
    if (!data) {
      mediaErrors.push(`#${i + 1} download failed (HTTP or >${MAX_MEDIA_BYTES} bytes): ${og.url}`);
      continue;
    }
    downloaded.push({ og, data });
  }
  if (downloaded.length === 0) {
    return rejectAndReturn(queueId, `all media downloads failed: ${mediaErrors.join("; ")}`);
  }

  // best-effort 업로드 — 실패는 mediaErrors에 누적. 0건 성공 시 reject.
  // 경로는 queueId-N.ext 로 결정적 — 동일 queueId 재시도(status guard로 막혀 있긴 함) 시 upsert.
  const uploaded: Array<{ og: OgMedia; publicUrl: string; path: string }> = [];
  for (let i = 0; i < downloaded.length; i++) {
    const { og, data } = downloaded[i];
    const folder = kind === "photo" ? "jjal-collector" : STORAGE_FOLDER;
    const path = `${folder}/${queueId}-${i + 1}.${data.ext}`;
    const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(path, data.buf, {
      cacheControl: "31536000",
      upsert: true,
      contentType: data.contentType,
    });
    if (upErr) {
      mediaErrors.push(`#${i + 1} upload failed: ${upErr.message}`);
      continue;
    }
    const { data: pub } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);
    uploaded.push({ og, publicUrl: pub.publicUrl, path });
  }
  if (uploaded.length === 0) {
    return rejectAndReturn(queueId, `all media uploads failed: ${mediaErrors.join("; ")}`);
  }

  // 작성자 팀 스냅샷: 매칭된 선수의 team_id를 기록.
  // 봇 profile.team_id가 다른 매칭 글로 추후 바뀌더라도 이 글의 작성자 팀 배지는 유지.
  // team-only 경로 (matched_kbo_id=null + board_type='team')는 slug → team.id 변환.
  let authorTeamIdSnapshot: number | null = null;
  if (row.matched_kbo_id) {
    const matchedPlayer = ROSTER.find((p) => p.kboId === row.matched_kbo_id);
    authorTeamIdSnapshot = matchedPlayer ? Number(matchedPlayer.teamId) : null;
  } else if (row.matched_board_type === "team") {
    const team = getTeamBySlug(row.matched_board_id);
    authorTeamIdSnapshot = team?.id ?? null;
  }

  // content_type='photo' 고정 — 선수 사진탭/전체 사진탭이 'photo'로 필터링하기 때문.
  // 영상(움짤콜렉터)은 video_urls, 사진(짤콜렉터)은 image_urls에 담는다. 둘 다 content_type='photo'.
  const mediaUrls = uploaded.map((u) => u.publicUrl);

  // 출처 자동 표기 — 운영자가 본문에 출처/URL을 직접 안 적었으면 source_url 기반으로 append.
  // "(출처: 인스타 @handle)\n원문URL" — URL은 LinkPreview가 클릭 카드로 렌더.
  const text = normalizeQueueTextForPost(row);
  const content = appendAttribution(text.sourceContent, row.source_url, sourceHtml);

  const postInsert: Record<string, unknown> = {
    author_id: botUserId,
    board_type: row.matched_board_type,
    board_id: row.matched_board_id,
    content_type: "photo",
    title: text.title,
    content,
    author_team_id_snapshot: authorTeamIdSnapshot,
  };
  if (kind === "video") {
    postInsert.video_urls = mediaUrls;
  } else {
    postInsert.image_urls = mediaUrls;
  }

  const { data: post, error: insErr } = await supabaseAdmin
    .from("posts")
    .insert(postInsert)
    .select("id")
    .single<{ id: number }>();
  if (insErr || !post) {
    // Storage orphan 정리: 업로드된 모든 객체 제거.
    const paths = uploaded.map((u) => u.path);
    const { error: rmErr } = await supabaseAdmin.storage.from(BUCKET).remove(paths);
    if (rmErr) {
      console.error(`[gif-collector] storage cleanup failed for ${paths.join(",")}:`, rmErr);
    }
    return { ok: false, error: `posts insert failed: ${insErr?.message ?? "no row"}` };
  }

  const { error: updErr } = await supabaseAdmin
    .from("gif_collector_queue")
    .update({
      match_status: "auto_posted",
      original_media_urls: selectedMedia.map((m) => m.url),
      posted_post_id: post.id,
      posted_at: new Date().toISOString(),
    })
    .eq("id", queueId);
  if (updErr) {
    return {
      ok: false,
      kind,
      postId: post.id,
      publicUrl: uploaded[0].publicUrl,
      publicUrls: uploaded.map((u) => u.publicUrl),
      partial: true,
      attempted: selectedMedia.length,
      succeeded: uploaded.length,
      mediaErrors: mediaErrors.length > 0 ? mediaErrors : undefined,
      error: `queue update failed (post created): ${updErr.message}`,
    };
  }

  return {
    ok: true,
    kind,
    postId: post.id,
    publicUrl: uploaded[0].publicUrl,
    publicUrls: uploaded.map((u) => u.publicUrl),
    attempted: selectedMedia.length,
    succeeded: uploaded.length,
    mediaErrors: mediaErrors.length > 0 ? mediaErrors : undefined,
  };
}

async function rejectAndReturn(queueId: number, error: string): Promise<PublishResult> {
  await supabaseAdmin
    .from("gif_collector_queue")
    .update({ match_status: "rejected", reviewed_at: new Date().toISOString() })
    .eq("id", queueId);
  return { ok: false, error };
}
