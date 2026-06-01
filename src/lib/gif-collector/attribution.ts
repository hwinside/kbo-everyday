/**
 * 움짤콜렉터 출처 자동 표기. 운영자가 본문에 출처를 직접 안 적어도 source_url 기반으로 생성한다.
 *
 * posts.content 렌더러(PostDetail/PostCard)는 markdown 링크를 지원하지 않고,
 * 본문 텍스트에서 URL은 stripUrls로 제거한 뒤 LinkPreview가 클릭 가능한 카드(og 실패 시 🔗 링크)로
 * 렌더한다. 그래서 출처는 "(출처: 인스타 @handle)" 텍스트 + 원문 URL(별도 줄)로 append하면
 * 텍스트는 그대로 보이고 URL은 LinkPreview 카드로 클릭 가능해진다.
 *
 * 외부 의존성 없는 pure 함수 모음 — smoke test 대상.
 */

const META_RE = /<meta\b[^>]*>/gi;

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

/** 플랫폼 한글 라벨. 모르면 호스트명(www. 제거). */
export function getPlatformLabel(sourceUrl: string): string {
  try {
    const host = new URL(sourceUrl).hostname.toLowerCase();
    if (host.endsWith("instagram.com")) return "인스타";
    if (host.endsWith("threads.com") || host.endsWith("threads.net")) return "스레드";
    if (host.endsWith("mlbpark.donga.com")) return "엠팍";
    if (host.endsWith("youtube.com") || host.endsWith("youtu.be")) return "유튜브";
    if (host.endsWith("twitter.com") || host.endsWith("x.com")) return "X";
    return host.replace(/^www\./, "");
  } catch {
    return "출처";
  }
}

/** Threads URL(/@handle/post/...)에서 작성자 핸들 추출. */
export function getThreadsHandle(sourceUrl: string): string | null {
  try {
    const u = new URL(sourceUrl);
    const host = u.hostname.toLowerCase();
    if (!host.endsWith("threads.com") && !host.endsWith("threads.net")) return null;
    const m = u.pathname.match(/^\/@([^/]+)\/post\//i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Instagram reel/p 페이지 og:description에서 작성자 핸들 추출.
 * 예: "7,579 likes, 427 comments - deliciousports on May 31, 2026: ..." → deliciousports
 */
export function extractInstagramHandle(html: string): string | null {
  const metas = html.match(META_RE) ?? [];
  for (const tag of metas) {
    if (!/property=["']og:description["']/i.test(tag)) continue;
    const m = tag.match(/content=["']([^"']*)["']/i);
    if (!m) continue;
    const desc = decodeHtmlEntities(m[1]);
    const h = desc.match(/comments?\s+-\s+([A-Za-z0-9._]+)\s+on\s/i);
    if (h) return h[1];
  }
  return null;
}

/** source_url + (이미 받아둔 source html)로 작성자 핸들 추론. 없으면 null. */
export function resolveHandle(sourceUrl: string, sourceHtml: string | null): string | null {
  const threads = getThreadsHandle(sourceUrl);
  if (threads) return threads;
  try {
    const host = new URL(sourceUrl).hostname.toLowerCase();
    if (host.endsWith("instagram.com") && sourceHtml) {
      return extractInstagramHandle(sourceHtml);
    }
  } catch {
    /* noop */
  }
  return null;
}

/** 본문에 이미 출처 표기나 원문 URL이 들어있는지(운영자 수동 입력) — 중복 방지용. */
export function hasExistingAttribution(content: string, sourceUrl: string): boolean {
  if (/출처/.test(content)) return true;
  if (content.includes(sourceUrl)) return true;
  // 쿼리스트링 제거한 원문 경로가 본문에 있으면(트래킹 파라미터 차이 흡수) 중복으로 간주
  try {
    const u = new URL(sourceUrl);
    const bare = `${u.host}${u.pathname}`.replace(/\/+$/, "");
    if (bare && content.includes(bare)) return true;
  } catch {
    /* noop */
  }
  return false;
}

/**
 * 본문에 출처를 append. 이미 출처/URL이 있으면(운영자 수동) 그대로 둠.
 * "(출처: 인스타 @handle)\n{원문URL}" — URL은 LinkPreview가 카드로 렌더.
 */
export function appendAttribution(
  content: string,
  sourceUrl: string,
  sourceHtml: string | null,
): string {
  const base = content ?? "";
  if (hasExistingAttribution(base, sourceUrl)) return base;

  const label = getPlatformLabel(sourceUrl);
  const handle = resolveHandle(sourceUrl, sourceHtml);
  const who = handle ? `${label} @${handle}` : label;
  const line = `(출처: ${who})\n${sourceUrl}`;

  return base.trim().length > 0 ? `${base.trim()}\n\n${line}` : line;
}

/**
 * appendAttribution가 붙인 "(출처: …)\n{url}" 블록을 본문에서 분리한다.
 * 봇이 자동 생성한 출처(끝에 원문 URL이 따라오는 형태)만 매치 — 렌더러가
 * "(출처: …)" 문구를 원문 하이퍼링크로 그릴 때 사용한다.
 * 운영자가 URL 없이 손으로 적은 "(출처: …)"는 링크 대상이 없으므로 매치하지 않는다.
 */
export function parseAttribution(
  content: string | null | undefined,
): { body: string; source: string; url: string } | null {
  if (!content) return null;
  const m = content.match(/\(출처:\s*([^)]*)\)\s*\n(https?:\/\/\S+)\s*$/);
  if (!m || m.index === undefined) return null;
  return {
    body: content.slice(0, m.index).trim(),
    source: m[1].trim(),
    url: m[2],
  };
}
