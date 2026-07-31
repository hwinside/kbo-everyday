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

/**
 * IG scontent 이미지 URL이 *정사각(중앙/상단) 크롭* 변형인지 판별.
 *
 * IG CDN은 stp 파라미터로 변형을 지정한다. 크롭 변형은 `stp=c<offset>...` (예: `c0.259.2592.2592a_...s1080x1080`)
 * 처럼 c로 시작하는 crop 지정이 붙는다. 원본 비율 변형은 `stp=dst-jpg_e35_tt6`(무크롭) 또는
 * `stp=..._p1080x1080`(p=박스에 맞춰 축소, 비율 보존)처럼 c 크롭 지정이 없다.
 * → stp 값이 `c` + 숫자로 시작하면 정사각 크롭본(짤림)으로 본다.
 */
function isInstagramSquareCropUrl(url: string): boolean {
  const m = url.match(/[?&]stp=([^&]+)/i);
  if (!m) return false;
  return /^c\d/i.test(m[1]);
}

// srcset 항목 `URL 1080w` 의 폭(px). 없으면 0.
function parseSrcsetWidth(descriptor: string): number {
  const m = descriptor.trim().match(/(\d+)w$/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Instagram 임베드(/embed/·/embed/captioned/) 페이지의 `<img srcset=...>` 에서
 * *원본 비율* 이미지를 추출한다.
 *
 * 배경: 기존 extractInstagramImageUrls는 contextJSON의 `display_url` 하나를 집는데,
 * IG가 이 값으로 정사각 크롭본(예: 세로 2592x3110 뉴스카드를 상단 640x640으로 잘라낸 것)을
 * 주는 경우가 있어 사진이 잘려서 저장됐다(하린아빠 제보 2026-07-28). 게다가 IG가 embed
 * 포맷을 바꿔 display_url JSON이 사라진 케이스도 확인됨.
 *
 * embed의 `<img class="EmbeddedMediaImage" srcset="url1 2592w, url2 1080w, ...">`에는
 * 같은 사진의 여러 해상도가 서명(oh/oe) 포함으로 들어있다. 이 중 정사각 크롭(stp=c..)이 아닌
 * *원본 비율* 변형만 골라, 폭 1080 이하 최대(없으면 최소 상위)로 고른다. IG 서명은 URL 전체
 * (stp 포함)로 계산되므로 stp를 임의 변형하면 403 — 반드시 srcset에 실제로 주어진 URL만 쓴다.
 *
 * 주의: 캐러셀(여러 장) 게시물이어도 embed <img>는 커버 한 장만 노출한다. 짤콜렉터가 다루는
 * 뉴스카드는 대부분 단일 이미지라 커버로 충분.
 *
 * 중요: 반드시 본문 미디어(`class="EmbeddedMediaImage"`) img로 스코프한다. embed 페이지 하단에는
 * 같은 계정의 *다른 게시물* 썸네일(srcset 포함)이 썯여 있어, 전체 <img srcset>를 긁으면 엉뚱한
 * 사진까지 수집된다(실데이터 확인 2026-07-28). 클래스가 바뀌면 0건 반환 → 호출부가 display_url/og:image로 안전 폴백.
 * IG가 마크업을 바꾸면 먼저 깨진다.
 */
export function extractInstagramImageUrlsFromSrcset(html: string, max: number): OgMedia[] {
  if (max <= 0) return [];
  const out: OgMedia[] = [];
  const seen = new Set<string>();
  // 본문 커버 이미지만: EmbeddedMediaImage 클래스 + srcset 보유 <img>. 속성 순서 무관하게 금지.
  const imgRe = /<img\b[^>]*>/gi;
  const PREFERRED_MAX_WIDTH = 1080;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(html)) !== null && out.length < max) {
    const tag = m[0];
    if (!/\bclass=["'][^"']*\bEmbeddedMediaImage\b[^"']*["']/i.test(tag)) continue;
    const ssMatch = tag.match(/\bsrcset=["']([^"']+)["']/i);
    if (!ssMatch) continue;
    const srcset = decodeHtmlEntities(ssMatch[1]);
    const candidates = srcset
      .split(",")
      .map((part) => {
        const trimmed = part.trim();
        const sp = trimmed.lastIndexOf(" ");
        const url = sp === -1 ? trimmed : trimmed.slice(0, sp);
        return { url, width: parseSrcsetWidth(trimmed) };
      })
      .filter((c) => /^https?:\/\//i.test(c.url))
      .filter((c) => /(?:cdninstagram\.com|fbcdn\.net)/i.test(c.url))
      .filter((c) => !isMetaProfilePic(c.url))
      .filter((c) => !isInstagramSquareCropUrl(c.url)); // 정사각 크롭본 제외 = 원본 비율만
    if (candidates.length === 0) continue;
    // 폭 1080 이하 중 최대. 그런 게 없으면(전부 1080 초과) 그 중 최소(1080에 가장 근접).
    const within = candidates.filter((c) => c.width > 0 && c.width <= PREFERRED_MAX_WIDTH);
    let best: { url: string; width: number };
    if (within.length > 0) {
      best = within.reduce((a, b) => (b.width > a.width ? b : a));
    } else {
      const positive = candidates.filter((c) => c.width > 0);
      best = positive.length > 0
        ? positive.reduce((a, b) => (b.width < a.width ? b : a))
        : candidates[0];
    }
    const key = best.url.split("?")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: best.url, type: "image" });
  }
  return out;
}

/**
 * IG 사진 최종 선택: display_url 캐러셀 slide 순서·장수를 보존하되 *커버(첫 슬라이드)만*
 * 원본 비율 srcset으로 교체/보강한다.
 *
 * 배경(삼순 NO-GO 2026-07-28): srcset은 embed cover 한 장만 노출하므로 srcset을 무조건
 * 1순위로 두면 기존 다중 이미지(캐러셀 최대 5장) 게시물이 cover 1장으로 축소된다.
 * → display_url slide를 SSOT로 유지하고, 그 첫 장(cover)만 원본비율 srcset으로 교체.
 *   - display_url이 있으면: [srcsetCover 또는 display[0], display[1..]] 순서 유지, max 장.
 *   - display_url이 없으면(단일글·embed 포맷 변경): srcsetCover만.
 * 이때 srcsetCover와 display[0]은 둘 다 첫 슬라이드(cover)라 교체가 안전하다.
 */
export function mergeInstagramImageSlides(
  displayUrls: OgMedia[],
  srcsetCover: OgMedia[],
  max: number,
): OgMedia[] {
  if (max <= 0) return [];
  const cover = srcsetCover[0];
  if (displayUrls.length > 0) {
    const merged = displayUrls.slice(0, max);
    if (cover) merged[0] = cover; // 첫 슬라이드(cover)만 원본비율로 교체, 나머지 slide 그대로.
    return merged;
  }
  return srcsetCover.slice(0, max);
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

/**
 * Threads 게시물 URL → 임베드(/embed) URL. 영상 URL은 원문 SPA 페이지가 아니라
 * 임베드 페이지의 <video>/<source>에 들어있어 이 URL이 있어야 영상을 찾는다.
 *
 * 주의: canonical(@handle/post/CODE) 경로만 인식한다. 공유 단축 링크(/share/CODE/)는
 * @handle/post 패턴이 아니므로 null — 호출부가 리다이렉트 최종 URL(res.url)을 넘겨야
 * 임베드가 생성된다. 이걸 빼먹으면 원문 og:image(영상 poster)만 잡혀 영상이 사진글로
 * 오발행된다(하린아빠 제보 2026-07-31). Meta가 경로 구조를 바꾸면 먼저 깨진다.
 */
export function getThreadsEmbedUrl(sourceUrl: string): string | null {
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
