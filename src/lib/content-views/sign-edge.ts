import { contentViewKey, newsContentId, type ContentViewType } from "./policy";

/**
 * 콘텐츠 조회수 서명 — Edge 런타임용 (Web Crypto, async). 2026-08-14 삼순 2차.
 *
 * /api/news/batch 는 `runtime = "edge"` 라 node:crypto(sign.ts)를 쓸 수 없다.
 * 같은 비밀키·같은 HMAC-SHA256·같은 절단 규칙으로 sign.ts 와 **동일한 토큰**을
 * 만들어야 하며(교차 검증은 qa:content-views 스모크가 고정), 검증은 node 런타임의
 * /api/content-views/view(sign.ts verifyContentViewToken)가 담당한다.
 */

const TOKEN_BYTES = 16; // sign.ts 와 동일 — hex 32자

function signingSecret(): string | null {
  const base = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base) return null;
  return `content-view-v1:${base}`;
}

/** Edge 호환 서명 발급. env 부재 시 null → 클라는 전송 스킵. */
export async function signContentViewEdge(
  type: ContentViewType,
  id: string,
): Promise<string | null> {
  const secret = signingSecret();
  if (!secret) return null;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(contentViewKey(type, id)));
  const bytes = new Uint8Array(signature).slice(0, TOKEN_BYTES);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 뉴스 목록 응답 공통 종단(Edge) — 항목별 viewToken 부착. sign.ts withNewsViewTokens 와 동일 계약. */
export async function withNewsViewTokensEdge<T extends { link: string; originalLink?: string }>(
  items: T[],
): Promise<(T & { viewToken?: string })[]> {
  return Promise.all(
    items.map(async (item) => {
      const contentId = newsContentId(item.link, item.originalLink);
      const viewToken = contentId ? await signContentViewEdge("news", contentId) : null;
      return viewToken ? { ...item, viewToken } : item;
    }),
  );
}
