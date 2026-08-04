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
  extractInstagramImageUrlsFromSrcset,
  mergeInstagramImageSlides,
  extractThreadsImageUrls,
  extractMlbparkImageUrls,
  getThreadsEmbedUrl,
  inferMediaExt,
  type OgMedia,
} from "./og-media";
import { appendAttribution } from "./attribution";
import { normalizeQueueTextForPost } from "./text-normalizer";

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
// export: orchestration(resolvedUrl 기반 임베드 재조회 + 영상>사진 우선 + Threads fail-close) 회귀테스트용.
export async function fetchMediaList(sourceUrl: string): Promise<{ media: OgMedia[]; sourceHtml: string | null }> {
  const fetched = await fetchPageHtml(sourceUrl);
  if (!fetched) return { media: [], sourceHtml: null };
  // resolvedUrl: 리다이렉트 최종 URL. Threads 공유 링크(/share/CODE/)는 canonical
  // (@handle/post/CODE)로 리다이렉트되므로, 임베드 URL은 sourceUrl이 아니라 이 최종 URL로
  // 만들어야 한다(공유 링크 자체는 @handle/post 패턴에 안 걸려 임베드 재조회가 통째로 스킵되고,
  // 그러면 원문 og:image=영상 poster만 잡혀 영상이 사진글로 오발행됨 — 하린아빠 제보 2026-07-31).
  const { html, finalUrl: resolvedUrl } = fetched;

  const media = extractMediaList(html, MAX_MEDIA_ITEMS);
  if (media.some((m) => m.type === "video")) return { media, sourceHtml: html };

  // SPA(Threads 등) — embed 페이지에서 한 번 더 시도. 영상 우선(움짤콜렉터) → 없으면 사진(짤콜렉터).
  //
  // fail-close(삼순 NO-GO 반영 2026-07-31): Threads로 식별된 게시물은 원문에 og:image(영상
  // poster)만 있어서, embed 조회가 실패(429/5xx/네트워크)하거나 embed에서 영상/사진 유형을
  // 확정하지 못하면 *아래 최종 return { media }로 떨어져 영상 poster가 사진글로 오발행*된다.
  // 그래서 Threads 경로에 들어오면 이 블록 안에서 확정하거나 빈 배열(→ reject)로 fail-close하고,
  // 절대 원문 og:image poster로 photo 발행하지 않는다.
  const threadsEmbedUrl = getThreadsEmbedUrl(resolvedUrl);
  if (threadsEmbedUrl) {
    const embedHtml = await fetchPageHtml(threadsEmbedUrl);
    // embed 조회 실패(429/5xx/네트워크) → 원문 poster photo 오발행 금지, fail-close.
    if (!embedHtml) return { media: [], sourceHtml: html };
    // http(s) 다운로드 가능한 video만 유효. blob:/data: src는 재생전용 비-다운로드 URL이라
    // 영상 추출 실패로 간주(삼순 게이트: <video> 있으나 mp4 추출 깨짐 → photo 아님 → fail-close).
    const embedVideos = extractMediaList(embedHtml.html, MAX_MEDIA_ITEMS).filter(
      (m) => m.type === "video" && /^https?:\/\//i.test(m.url),
    );
    if (embedVideos.length > 0) return { media: embedVideos, sourceHtml: html };
    // <video>/<source> 태그는 있는데 재생 URL 추출 0 = 영상 추출 실패(사진 아님) → fail-close.
    // (poster/썸네일이 thImages로 잡혀 사진 오발행되는 것을 차단.)
    if (/<(?:video|source)\b/i.test(embedHtml.html)) return { media: [], sourceHtml: html };
    const thImages = extractThreadsImageUrls(embedHtml.html, MAX_MEDIA_ITEMS);
    if (thImages.length > 0) return { media: thImages, sourceHtml: html };
    // Threads로 식별됐으나 embed에서 영상·사진 확정 불가(200 unknown 등) → fail-close.
    return { media: [], sourceHtml: html };
  }
  // Threads 여부와 canonical embed URL 파생 성공은 별개다. /share/ 리다이렉트가
  // canonical로 풀리지 않거나 Meta 경로가 바뀌어도 원문 og:image poster를 사진으로
  // 발행하지 않는다. 실제 사진은 canonical embed에서 사진 증거를 얻은 경우만 허용한다.
  if (isThreadsUrl(sourceUrl) || isThreadsUrl(resolvedUrl)) {
    return { media: [], sourceHtml: html };
  }

  // Instagram reel/p/tv — 본문엔 og:image(썸네일)만 있고, /embed/ 페이지 contextJSON에
  // video_url(영상) 또는 display_url(사진 캐러셀)이 들어있음. 임베드는 한 번만 받아 둘 다 시도.
  // 영상 우선(움짤콜렉터) → 영상이 없으면 캐러셀 이미지(짤콜렉터).
  const instagramEmbedUrl = getInstagramEmbedUrl(resolvedUrl);
  if (instagramEmbedUrl) {
    const embedHtml = await fetchPageHtml(instagramEmbedUrl);
    if (embedHtml) {
      const igVideos = extractInstagramVideoUrls(embedHtml.html, MAX_MEDIA_ITEMS);
      if (igVideos.length > 0) return { media: igVideos, sourceHtml: html };
      // 사진: display_url 캐러셀 slide(최대 5장) 순서를 SSOT로 유지하되, 커버(첫 슬라이드)만
      // 원본 비율 srcset으로 교체/보강한다. contextJSON display_url이 정사각 크롭본을 주는
      // 경우가 있어 cover 사진이 잘림(하린아빠 제보 2026-07-28). display_url이 사라진 단일글은
      // srcset만으로 동작. (srcset을 무조건 1순위로 두면 캐러셀이 1장으로 축소되는 회귀 방지.)
      const igDisplayUrls = extractInstagramImageUrls(embedHtml.html, MAX_MEDIA_ITEMS);
      const igSrcsetCover = extractInstagramImageUrlsFromSrcset(embedHtml.html, 1);
      const igImages = mergeInstagramImageSlides(igDisplayUrls, igSrcsetCover, MAX_MEDIA_ITEMS);
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

function isThreadsUrl(sourceUrl: string): boolean {
  try {
    const host = new URL(sourceUrl).hostname.toLowerCase();
    return host.endsWith("threads.com") || host.endsWith("threads.net");
  } catch {
    return false;
  }
}

// html: 응답 본문. finalUrl: 리다이렉트를 모두 따라간 최종 URL(res.url). 공유 단축 링크가
// canonical로 풀리는 경우 임베드 URL을 이 최종 URL로 만들어야 하므로 함께 반환한다.
async function fetchPageHtml(url: string): Promise<{ html: string; finalUrl: string } | null> {
  const res = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": FETCH_USER_AGENT,
    },
  });
  if (!res.ok) return null;
  const html = await res.text();
  return { html, finalUrl: res.url || url };
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

  // 작성자 팀 스냅샷은 콘텐츠 소속팀이 아니라 실제 봇 프로필의 응원팀을 기록한다.
  // 콘텐츠 팀/선수는 board + tags가 별도 `글 소속` 라벨을 담당한다.
  const { data: botProfile } = await supabaseAdmin
    .from("profiles")
    .select("team_id")
    .eq("id", botUserId)
    .maybeSingle<{ team_id: number | null }>();
  const authorTeamIdSnapshot = botProfile?.team_id ?? null;

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
