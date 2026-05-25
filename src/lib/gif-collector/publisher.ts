/**
 * 움짤콜렉터 발행 워커 (PR4/4).
 *
 * 단일 큐 행을 받아 미디어를 추출/다운로드/Storage 업로드 후 posts 행으로 발행한다.
 * Webhook이 큐 INSERT 직후 즉시 호출하는 동기 흐름 (옵션 A, 2026-05-25 확정).
 *
 * 흐름:
 *   1. queue row 조회 (status='pending')
 *   2. source_url에서 og:video / og:image 추출 (정규식)
 *   3. 미디어 다운로드 (UA + Referer 정직, 30MB 캡, 15초 timeout)
 *   4. Supabase Storage('photos/gif-collector/') 업로드
 *   5. posts INSERT (author_id = 봇 user_id, board_type/board_id = matched_*)
 *   6. queue UPDATE (status='auto_posted', posted_post_id, posted_at)
 *
 * 실패 시: status='rejected' + reviewed_at. error 메시지는 caller가 슬랙으로 전달.
 *
 * Env:
 *   GIF_COLLECTOR_BOT_USER_ID — `seed-gif-collector-bot.ts` 실행 결과 UUID.
 */

import { supabaseAdmin } from "@/lib/supabase/admin";
import { extractOgMedia, inferMediaExt, type OgMedia } from "./og-media";

const BUCKET = "photos";
const STORAGE_FOLDER = "gif-collector";
const FETCH_TIMEOUT_MS = 15_000;
const MAX_MEDIA_BYTES = 30 * 1024 * 1024;

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOgMedia(sourceUrl: string): Promise<OgMedia | null> {
  const res = await fetchWithTimeout(sourceUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; KeubofanGifCollector/1.0; +https://keubo.fan)",
    },
  });
  if (!res.ok) return null;
  const html = await res.text();
  return extractOgMedia(html);
}

async function downloadMedia(
  mediaUrl: string,
  refererOrigin: string,
): Promise<{ buf: Buffer; contentType: string; ext: string } | null> {
  const res = await fetchWithTimeout(mediaUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; KeubofanGifCollector/1.0; +https://keubo.fan)",
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
  postId?: number;
  publicUrl?: string;
  /** post는 만들어졌지만 queue update가 실패한 부분 성공 시그널. caller는 운영자에게 수동 정리 알림 권장. */
  partial?: boolean;
  error?: string;
}

export async function publishQueueItem(queueId: number): Promise<PublishResult> {
  const BOT_USER_ID = process.env.GIF_COLLECTOR_BOT_USER_ID;
  if (!BOT_USER_ID) {
    return { ok: false, error: "GIF_COLLECTOR_BOT_USER_ID env not configured" };
  }

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

  let og: OgMedia | null;
  try {
    og = await fetchOgMedia(row.source_url);
  } catch (e) {
    return rejectAndReturn(queueId, `og fetch error: ${(e as Error).message}`);
  }
  if (!og) {
    return rejectAndReturn(queueId, "media not found (og:video / og:image 모두 없음)");
  }

  let refererOrigin: string;
  try {
    refererOrigin = new URL(row.source_url).origin;
  } catch {
    refererOrigin = "";
  }

  let downloaded: Awaited<ReturnType<typeof downloadMedia>>;
  try {
    downloaded = await downloadMedia(og.url, refererOrigin);
  } catch (e) {
    return rejectAndReturn(queueId, `media download error: ${(e as Error).message}`);
  }
  if (!downloaded) {
    return rejectAndReturn(queueId, `media download failed (HTTP error or >${MAX_MEDIA_BYTES} bytes): ${og.url}`);
  }

  // queueId만으로 deterministic — 재발행 시도 (status guard로 막혀 있긴 함) 시 같은 path,
  // posts insert 실패에 따른 storage 정리도 정확히 한 객체만 지움.
  const path = `${STORAGE_FOLDER}/${queueId}.${downloaded.ext}`;
  const { error: upErr } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(path, downloaded.buf, {
      cacheControl: "31536000",
      upsert: true,
      contentType: downloaded.contentType,
    });
  if (upErr) return { ok: false, error: `storage upload failed: ${upErr.message}` };

  const { data: pub } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);
  const publicUrl = pub.publicUrl;

  // content_type='photo' 고정 — 선수 사진탭/전체 사진탭이 'photo' 필터링하기 때문.
  // 단, 미디어 array는 og.type에 맞춰 분기: og.type=video → video_urls (mp4 등은
  // 비디오 컴포넌트로, image_urls에 넣으면 img 태그 렌더가 깨짐).
  const isVideo = og.type === "video";
  const postInsert: Record<string, unknown> = {
    author_id: BOT_USER_ID,
    board_type: row.matched_board_type,
    board_id: row.matched_board_id,
    content_type: "photo",
    title: row.source_title || `${row.matched_board_id} 움짤`,
    content: row.source_content ?? "",
  };
  if (isVideo) postInsert.video_urls = [publicUrl];
  else postInsert.image_urls = [publicUrl];

  const { data: post, error: insErr } = await supabaseAdmin
    .from("posts")
    .insert(postInsert)
    .select("id")
    .single<{ id: number }>();
  if (insErr || !post) {
    // Storage orphan 정리: posts insert 실패 시 방금 업로드한 객체 제거.
    const { error: rmErr } = await supabaseAdmin.storage.from(BUCKET).remove([path]);
    if (rmErr) {
      console.error(`[gif-collector] storage cleanup failed for ${path}:`, rmErr);
    }
    return { ok: false, error: `posts insert failed: ${insErr?.message ?? "no row"}` };
  }

  const { error: updErr } = await supabaseAdmin
    .from("gif_collector_queue")
    .update({
      match_status: "auto_posted",
      original_media_urls: [og.url],
      posted_post_id: post.id,
      posted_at: new Date().toISOString(),
    })
    .eq("id", queueId);
  if (updErr) {
    // posts INSERT는 끝났지만 queue update 실패 — caller에 ok=false + partial 시그널.
    return {
      ok: false,
      postId: post.id,
      publicUrl,
      partial: true,
      error: `queue update failed (post created): ${updErr.message}`,
    };
  }

  return { ok: true, postId: post.id, publicUrl };
}

async function rejectAndReturn(queueId: number, error: string): Promise<PublishResult> {
  await supabaseAdmin
    .from("gif_collector_queue")
    .update({ match_status: "rejected", reviewed_at: new Date().toISOString() })
    .eq("id", queueId);
  return { ok: false, error };
}
