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

export function extractOgMedia(html: string): OgMedia | null {
  const ogVideo = findOgMeta(html, "og:video");
  if (ogVideo) return { url: ogVideo, type: "video" };

  for (const m of html.matchAll(VIDEO_SOURCE_RE)) {
    return { url: decodeHtmlEntities(m[1]), type: "video" };
  }

  const directVideo = html.match(DIRECT_VIDEO_URL_RE)?.[0];
  if (directVideo) return { url: decodeHtmlEntities(directVideo), type: "video" };

  const ogImage = findOgMeta(html, "og:image");
  if (ogImage && !isGenericMlbparkImage(ogImage)) return { url: ogImage, type: "image" };
  return null;
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
