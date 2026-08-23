import { NextRequest, NextResponse } from "next/server";

/**
 * GIPHY 프록시 (#cs 8/23 "GIF를 불러올 수 없어요" 429 대응)
 *
 * 기존에는 클라이언트가 NEXT_PUBLIC_GIPHY_API_KEY로 GIPHY를 직접 호출해
 * 전 유저가 키 1개의 rate limit을 공유했다 (DAU 규모에서 상시 429).
 * 이 라우트는 서버에서 GIPHY를 호출하고 CDN 캐시(s-maxage)를 걸어
 * 동일 쿼리의 GIPHY 실호출을 캐시 TTL당 1회로 줄인다.
 *
 * GET /api/community/giphy?type=gifs|stickers&q=<검색어>&offset=<n>&limit=<n>
 * 응답: { data: GiphyItem[], pagination: { total_count: number } }
 */

const ALLOWED_TYPES = new Set(["gifs", "stickers"] as const);
type GiphyType = "gifs" | "stickers";

const MAX_QUERY_LEN = 80;
const MAX_OFFSET = 200;
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 50;

// CDN 캐시 TTL(초). 트렌딩은 변화가 느려 길게, 검색은 짧게.
const TRENDING_SMAXAGE = 600;
const SEARCH_SMAXAGE = 300;

interface GiphyImageSlim {
  url: string;
  width: string;
  height: string;
}

/** 소비처(GifPicker·StickerTool)가 읽는 이미지 렌디션 전부. */
const IMAGE_KEYS = [
  "fixed_height", // GifPicker: 목록 렌더·선택
  "fixed_height_still", // GifPicker 인터페이스 계약
  "original", // GifPicker 선택 / StickerTool 추가 폴백
  "original_still", // StickerTool: addImage 1순위
  "fixed_width_small", // StickerTool: 목록 src 폴백
  "fixed_width_small_still", // StickerTool: 목록 src 1순위, addImage 폴백
] as const;
type ImageKey = (typeof IMAGE_KEYS)[number];

/** 타입별 필수 렌디션 — 없으면 소비처 렌더가 깨지므로 그 아이템은 제외. */
const REQUIRED_KEYS: Record<GiphyType, ImageKey[]> = {
  gifs: ["fixed_height", "original"], // GifPicker는 non-optional 접근
  stickers: [], // StickerTool은 전부 optional chaining + 폴백 체인
};

function slimImage(raw: unknown): GiphyImageSlim | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.url !== "string" || r.url.length === 0) return null;
  return {
    url: r.url,
    width: typeof r.width === "string" ? r.width : "",
    height: typeof r.height === "string" ? r.height : "",
  };
}

/** GIPHY 원본 아이템에서 소비처가 쓰는 필드만 남긴다 (payload 축소 + 스키마 고정). */
function slimItem(raw: unknown, type: GiphyType): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.images || typeof r.images !== "object") return null;
  const rawImages = r.images as Record<string, unknown>;

  const images: Partial<Record<ImageKey, GiphyImageSlim>> = {};
  for (const key of IMAGE_KEYS) {
    const slim = slimImage(rawImages[key]);
    if (slim) images[key] = slim;
  }

  for (const key of REQUIRED_KEYS[type]) {
    if (!images[key]) return null;
  }
  // 렌더 가능한 렌디션이 하나도 없으면 제외
  if (Object.keys(images).length === 0) return null;

  return {
    id: r.id,
    title: typeof r.title === "string" ? r.title : "",
    images,
  };
}

export async function GET(request: NextRequest) {
  const apiKey = process.env.GIPHY_API_KEY ?? process.env.NEXT_PUBLIC_GIPHY_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "giphy_not_configured" }, { status: 503 });
  }

  const { searchParams } = new URL(request.url);

  const typeParam = searchParams.get("type") ?? "gifs";
  if (!ALLOWED_TYPES.has(typeParam as GiphyType)) {
    return NextResponse.json({ error: "invalid_type" }, { status: 400 });
  }
  const type = typeParam as GiphyType;

  const q = (searchParams.get("q") ?? "").trim().slice(0, MAX_QUERY_LEN);

  const offsetRaw = Number.parseInt(searchParams.get("offset") ?? "0", 10);
  const offset = Number.isFinite(offsetRaw)
    ? Math.min(Math.max(offsetRaw, 0), MAX_OFFSET)
    : 0;

  // 소비처별 페이지 크기 유지 (GifPicker 24, StickerTool 20) — hasMore 판정이
  // `newData.length === PAGE_SIZE`에 결속돼 있어 limit을 그대로 전달해야 한다.
  const limitRaw = Number.parseInt(searchParams.get("limit") ?? String(DEFAULT_LIMIT), 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const upstream = new URL(
    q
      ? `https://api.giphy.com/v1/${type}/search`
      : `https://api.giphy.com/v1/${type}/trending`
  );
  upstream.searchParams.set("api_key", apiKey);
  if (q) {
    upstream.searchParams.set("q", q);
    upstream.searchParams.set("lang", "ko");
  }
  upstream.searchParams.set("limit", String(limit));
  upstream.searchParams.set("offset", String(offset));
  upstream.searchParams.set("rating", "g");

  const smaxage = q ? SEARCH_SMAXAGE : TRENDING_SMAXAGE;

  try {
    const res = await fetch(upstream, {
      // 같은 서버리스 인스턴스 내 중복 호출 억제 (CDN 캐시와 이중 방어)
      next: { revalidate: smaxage },
    });

    if (!res.ok) {
      // 429 포함 upstream 실패 — 짧게만 캐시해 GIPHY 회복 시 바로 풀리게
      return NextResponse.json(
        { error: "giphy_upstream", status: res.status },
        { status: 502, headers: { "Cache-Control": "public, s-maxage=30" } }
      );
    }

    const json: unknown = await res.json();
    const rawData =
      json && typeof json === "object" && Array.isArray((json as { data?: unknown }).data)
        ? ((json as { data: unknown[] }).data)
        : [];
    const data = rawData
      .map((item) => slimItem(item, type))
      .filter((item): item is Record<string, unknown> => item !== null);
    const totalCount =
      json && typeof json === "object"
        ? Number(
            (json as { pagination?: { total_count?: unknown } }).pagination?.total_count ?? 0
          ) || 0
        : 0;

    return NextResponse.json(
      { data, pagination: { total_count: totalCount } },
      {
        headers: {
          "Cache-Control": `public, s-maxage=${smaxage}, stale-while-revalidate=${smaxage * 2}`,
        },
      }
    );
  } catch {
    return NextResponse.json({ error: "giphy_fetch_failed" }, { status: 502 });
  }
}
