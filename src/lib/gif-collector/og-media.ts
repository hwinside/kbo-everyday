/**
 * og:video / og:image 추출 + 미디어 확장자 추론. 외부 의존성 없는 pure 함수.
 * publisher.ts에서 사용 + smoke test 대상.
 */

export interface OgMedia {
  url: string;
  type: "video" | "image";
}

const META_RE = /<meta\b[^>]*>/gi;
const VIDEO_SOURCE_RE = /<(?:video|source)\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
const DIRECT_VIDEO_URL_RE = /https?:\/\/[^"'<> \t\r\n]+?\.(?:mp4|webm|m3u8)(?:\?[^"'<> \t\r\n]*)?/gi;

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractAttr(tag: string, attrName: string): string | null {
  const re = new RegExp(`\\b${attrName}=["']([^"']+)["']`, "i");
  const m = tag.match(re);
  return m ? decodeHtmlEntities(m[1]) : null;
}

function findOgMeta(html: string, propertyPrefix: "og:video" | "og:image"): string | null {
  const metas = html.match(META_RE) ?? [];
  for (const tag of metas) {
    const property = extractAttr(tag, "property");
    if (!property) continue;
    if (property === propertyPrefix || property === `${propertyPrefix}:secure_url` || property === `${propertyPrefix}:url`) {
      const content = extractAttr(tag, "content");
      if (content) return content;
    }
  }
  return null;
}

function isGenericMlbparkImage(url: string): boolean {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("donga.com")) return false;
    const path = u.pathname.toLowerCase();
    return (
      path.includes("/challenge/mlbpark/images/share_icon") ||
      path.includes("/challenge/mlbpark/images/img_logo") ||
      path.includes("/challenge/mlbpark/images/btn_") ||
      path.includes("/mlbpark/img/btn_")
    );
  } catch {
    return false;
  }
}

/**
 * HTML에서 미디어를 *등장 순서대로* 최대 `max`개 추출.
 *
 * 우선순위 (같은 우선순위 안에선 등장 순서):
 *   1. og:video meta (페이지에 여러 개 있을 수 있음 — 모두 수집)
 *   2. <video>/<source src=...> 본문 임베드
 *   3. 직접 mp4/webm/m3u8 URL (앵커, 본문 등)
 *   4. (위 비디오가 한 건도 없을 때만) og:image fallback — 단일
 *
 * URL dedupe. 비디오가 1건이라도 있으면 이미지는 무시 (영상+썸네일 혼재 시 영상만 의도).
 */
export function extractMediaList(html: string, max: number): OgMedia[] {
  if (max <= 0) return [];
  const results: OgMedia[] = [];
  const seen = new Set<string>();
  const add = (rawUrl: string | null | undefined, type: "video" | "image"): boolean => {
    if (results.length >= max) return false;
    if (!rawUrl) return true;
    const url = decodeHtmlEntities(rawUrl);
    if (seen.has(url)) return true;
    seen.add(url);
    results.push({ url, type });
    return results.length < max;
  };

  const metas = html.match(META_RE) ?? [];
  for (const tag of metas) {
    const prop = extractAttr(tag, "property");
    if (!prop) continue;
    if (prop === "og:video" || prop === "og:video:secure_url" || prop === "og:video:url") {
      const content = extractAttr(tag, "content");
      if (!add(content, "video")) return results;
    }
  }

  for (const m of html.matchAll(VIDEO_SOURCE_RE)) {
    if (!add(m[1], "video")) return results;
  }

  for (const m of html.matchAll(DIRECT_VIDEO_URL_RE)) {
    if (!add(m[0], "video")) return results;
  }

  if (results.length === 0) {
    const ogImage = findOgMeta(html, "og:image");
    if (ogImage && !isGenericMlbparkImage(ogImage)) add(ogImage, "image");
  }

  return results;
}

export function extractOgMedia(html: string): OgMedia | null {
  return extractMediaList(html, 1)[0] ?? null;
}

export function hasVideoMedia(media: OgMedia[]): boolean {
  return media.some((m) => m.type === "video");
}

// JSON 문자열 안에 이스케이프된 URL을 원형으로 복원.
// contextJSON은 이중 인코딩이라 백슬래시가 여러 개 붙을 수 있어(\/ , \\/ ...) 백슬래시 런을 포괄 처리한다.
function unescapeJsonUrl(raw: string): string {
  return raw
    .replace(/\\+u0026/gi, "&")
    .replace(/\\+u003[dD]/g, "=")
    .replace(/\\+\//g, "/");
}

/**
 * Instagram 임베드(/embed/) 페이지의 `contextJSON` 안에 들어있는 동영상 URL 추출.
 *
 * reel/p 본문 페이지엔 og:image(썸네일)만 노출되고 영상 URL이 없다. /embed/ 페이지를
 * 따로 받으면 GraphVideo 데이터의 `"video_url":"https:\/\/...mp4..."` 가 들어있는데,
 * JSON 문자열로 이스케이프(\/ , &)돼 있어 일반 og:video / 직접 mp4 정규식엔 안 걸린다.
 * 그래서 video_url 키를 직접 찾아 언이스케이프한다. 등장 순서대로 최대 max개, URL dedupe.
 */
export function extractInstagramVideoUrls(html: string, max: number): OgMedia[] {
  if (max <= 0) return [];
  const out: OgMedia[] = [];
  const seen = new Set<string>();
  // "video_url" 키(이스케이프 가능) : "https:....mp4..." (escaped sequence 허용) 닫는 따옴표 전까지.
  const re = /"video_url\\?"\s*:\s*\\?"(https:(?:[^"\\]|\\.)*?\.mp4(?:[^"\\]|\\.)*?)\\?"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < max) {
    const url = unescapeJsonUrl(m[1]);
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push({ url, type: "video" });
    }
  }
  return out;
}

export function inferMediaExt(contentType: string, url: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes("gif")) return "gif";
  if (ct.includes("mp4")) return "mp4";
  if (ct.includes("webm")) return "webm";
  if (ct.includes("jpeg")) return "jpg";
  if (ct.includes("png")) return "png";
  const m = url.match(/\.(gif|mp4|webm|jpg|jpeg|png)(?:\?|$|#)/i);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg") : "bin";
}
