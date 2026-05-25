/**
 * og:video / og:image 추출 + 미디어 확장자 추론. 외부 의존성 없는 pure 함수.
 * publisher.ts에서 사용 + smoke test 대상.
 */

export interface OgMedia {
  url: string;
  type: "video" | "image";
}

const OG_VIDEO_RE =
  /<meta\s+(?:[^>]*?\s+)?property=["']og:video(?::secure_url|:url)?["']\s+content=["']([^"']+)["']/i;
const OG_IMAGE_RE =
  /<meta\s+(?:[^>]*?\s+)?property=["']og:image(?::secure_url|:url)?["']\s+content=["']([^"']+)["']/i;

export function extractOgMedia(html: string): OgMedia | null {
  const v = html.match(OG_VIDEO_RE);
  if (v) return { url: v[1], type: "video" };
  const i = html.match(OG_IMAGE_RE);
  if (i) return { url: i[1], type: "image" };
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
