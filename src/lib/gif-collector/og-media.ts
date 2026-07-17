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

// JSON 문자열 안에 이스케이프된 URL을 원형으로 복원.
// contextJSON은 이중 인코딩이라 백슬래시가 여러 개 붙을 수 있어(\/ , \\/ ...) 백슬래시 런을 포괄 처리한다.
// \uXXXX 유니코드 이스케이프는 일괄 디코드 — &(u0026)·=(u003d)뿐 아니라 %(u0025) 등도 나온다.
// (실데이터: IG 캐러셀 display_url의 ig_cache_key 값 %(퍼센트)가 raw JSON에선 %로 인코딩됨.)
function unescapeJsonUrl(raw: string): string {
  return raw
    .replace(/\\+\//g, "/")
    .replace(/\\+u([0-9a-fA-F]{4})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
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

/**
 * Instagram 임베드(/embed/) 페이지 contextJSON 안의 사진(캐러셀) 이미지 URL 추출.
 *
 * 사진 전용 게시물(단일/캐러셀)은 video_url 없이 `"display_url":"https:\/\/...jpg..."` 로
 * 슬라이드별 이미지가 들어있다(GraphSidecar → edge_sidecar_to_children). 커버가 첫 슬라이드와
 * 동일 URL로 한 번 더 등장하는데 URL dedupe로 자연 흡수된다. 등장 순서대로 최대 max개.
 *
 * 영상 전용 함수(extractInstagramVideoUrls)와 대칭 — video_url 대신 display_url,
 * .mp4 앵커 없이 닫는 따옴표 전까지. Meta가 embed/contextJSON 포맷을 바꾸면 먼저 깨진다.
 */
export function extractInstagramImageUrls(html: string, max: number): OgMedia[] {
  if (max <= 0) return [];
  const out: OgMedia[] = [];
  const seen = new Set<string>();
  const re = /"display_url\\?"\s*:\s*\\?"(https:(?:[^"\\]|\\.)*?)\\?"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < max) {
    const url = unescapeJsonUrl(m[1]);
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push({ url, type: "image" });
    }
  }
  return out;
}

function isMlbparkEmoticon(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname.endsWith("donga.com") && u.pathname.toLowerCase().includes("/editor/img/emotions/");
  } catch {
    return false;
  }
}

/**
 * MLBPARK 본문(id="contentDetail") 안의 사진 여러 장 추출.
 *
 * 주의: 사이드바 '핫이슈' 썸네일도 본문 이미지와 같은 simg.donga.com/ugc/MLBPARK/Board CDN을 쓴다.
 * 그래서 반드시 본문 컨테이너(#contentDetail)로 스코프한 뒤 그 안의 <img>만 수집해야 오염이 없다.
 * 광고 박스(#adstream_box)/댓글존 이전까지로 자르고, 이모티콘/공용 UI 이미지는 제외. 등장 순서대로 max개.
 */
export function extractMlbparkImageUrls(html: string, max: number): OgMedia[] {
  if (max <= 0) return [];
  const startM = html.match(/id=['"]contentDetail['"]/i);
  if (!startM || startM.index === undefined) return [];
  const rest = html.slice(startM.index);

  // 본문 종료 경계: 광고 박스 / 댓글존 중 먼저 오는 지점(없으면 넉넉히 200KB로 캡).
  let end = rest.length;
  for (const rx of [/id=['"]adstream_box['"]/i, /class="[^"]*reply_zone/i, /class="[^"]*view_suggest/i]) {
    const mm = rest.match(rx);
    if (mm && mm.index !== undefined && mm.index < end) end = mm.index;
  }
  const body = rest.slice(0, Math.min(end, 200_000));

  const out: OgMedia[] = [];
  const seen = new Set<string>();
  const imgRe = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(body)) !== null && out.length < max) {
    const url = decodeHtmlEntities(m[1]);
    if (!/^https?:\/\//i.test(url)) continue; // 상대경로/템플릿 변수 제외
    if (isMlbparkEmoticon(url) || isGenericMlbparkImage(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, type: "image" });
  }
  return out;
}

// Threads/IG 프로필 사진(작성자 아바타) 판별 — 본문 이미지에서 제외용.
// 프로필은 미디어타입 t51.*-19 / 소형 정사각 stp(_s100x100·_s150x150) / efg의 profile_pic 태그로 식별.
function isMetaProfilePic(url: string): boolean {
  return (
    /\/t51\.[0-9]+-19\//.test(url) ||
    /stp=[^&]*_s(?:100x100|150x150)/.test(url) ||
    /profile_pic/.test(url)
  );
}

/**
 * Threads 임베드(/embed) 페이지 본문의 사진 여러 장 추출.
 *
 * IG 임베드와 달리 display_url JSON이 아니라 `<img src="https://scontent....cdninstagram.com/...">`
 * 태그로 들어있다(HTML 엔티티 &amp; 인코딩). 작성자 아바타(t51.*-19 프로필 사진)가 섞여 있으므로
 * isMetaProfilePic로 제외하고, 파일명(쿼리 제외) 기준 dedupe. 등장 순서대로 max개.
 * Meta가 embed 마크업을 바꾸면 먼저 깨진다.
 */
export function extractThreadsImageUrls(html: string, max: number): OgMedia[] {
  if (max <= 0) return [];
  const out: OgMedia[] = [];
  const seen = new Set<string>();
  const imgRe = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(html)) !== null && out.length < max) {
    const url = decodeHtmlEntities(m[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    if (!/(?:cdninstagram\.com|fbcdn\.net)/i.test(url)) continue; // Meta 미디어 CDN만
    if (isMetaProfilePic(url)) continue;
    const key = url.split("?")[0]; // 파일명(쿼리 제외) — 해상도/서명 변형 흡수
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url, type: "image" });
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
  if (ct.includes("webp")) return "webp";
  const m = url.match(/\.(gif|mp4|webm|jpg|jpeg|png|webp)(?:\?|$|#)/i);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg") : "bin";
}
