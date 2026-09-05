"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Loader2 } from "lucide-react";
import { STICKER_CATEGORIES } from "./stickerData";
import { trackEvent } from "@/lib/analytics";
import {
  GIPHY_MIN_QUERY_LENGTH,
  GIPHY_SEARCH_DEBOUNCE_MS,
  getGiphyApiKey,
  getGiphyCooldownRemainingMs,
  hashGiphyQuery,
  normalizeGiphyQuery,
  startGiphyCooldown,
} from "@/lib/community/giphy-request";

interface GiphyImage {
  url: string;
  width: string;
  height: string;
}

interface GiphySticker {
  id: string;
  title: string;
  images: {
    fixed_width_small: GiphyImage;
    fixed_width_small_still: GiphyImage;
    original_still: GiphyImage;
    original: GiphyImage;
    fixed_width: GiphyImage;
  };
}

interface StickerToolProps {
  addSvg: (svgString: string) => Promise<unknown>;
  addImage: (url: string) => Promise<unknown>;
}

const GIPHY_CONTEXT = "editor_sticker" as const;

export default function StickerTool({ addSvg, addImage }: StickerToolProps) {
  const giphyApiKey = getGiphyApiKey(GIPHY_CONTEXT);
  const [tab, setTab] = useState<"default" | "giphy">("default");
  const [activeCategory, setActiveCategory] = useState(STICKER_CATEGORIES[0].id);

  const category = STICKER_CATEGORIES.find((c) => c.id === activeCategory) || STICKER_CATEGORIES[0];

  return (
    <div className="p-4 space-y-3">
      {/* Top-level tabs */}
      <div className="flex gap-2">
        <button
          onClick={() => setTab("default")}
          className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-colors ${
            tab === "default" ? "bg-accent text-white" : "bg-bg-tertiary text-text-secondary"
          }`}
        >
          기본 스티커
        </button>
        {giphyApiKey && (
          <button
            onClick={() => setTab("giphy")}
            className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-colors ${
              tab === "giphy" ? "bg-accent text-white" : "bg-bg-tertiary text-text-secondary"
            }`}
          >
            GIPHY
          </button>
        )}
      </div>

      {tab === "default" ? (
        <>
          {/* Category tabs */}
          <div className="flex gap-2 overflow-x-auto scrollbar-hide">
            {STICKER_CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(cat.id)}
                className={`flex-shrink-0 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                  activeCategory === cat.id
                    ? "bg-accent text-white"
                    : "bg-bg-tertiary text-text-secondary"
                }`}
              >
                {cat.emoji} {cat.label}
              </button>
            ))}
          </div>

          {/* Sticker grid — SVGs are hardcoded from stickerData.ts, safe to render */}
          <div className="grid grid-cols-4 gap-2">
            {category.items.map((sticker) => (
              <button
                key={sticker.id}
                onClick={() => addSvg(sticker.svg)}
                className="aspect-square rounded-xl bg-bg-tertiary flex flex-col items-center justify-center p-2 active:scale-90 transition-transform hover:bg-bg-secondary"
              >
                {/* SVGs are hardcoded constants from stickerData.ts, not user-supplied content */}
                <div
                  className="w-full h-3/4 flex items-center justify-center"
                  dangerouslySetInnerHTML={{ __html: sticker.svg }}
                />
                <span className="text-[10px] text-text-tertiary mt-1 truncate w-full text-center">
                  {sticker.label}
                </span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <GiphyPanel addImage={addImage} />
      )}
    </div>
  );
}

const PAGE_SIZE = 20;

function GiphyPanel({ addImage }: { addImage: (url: string) => Promise<unknown> }) {
  const [query, setQuery] = useState("");
  const [stickers, setStickers] = useState<GiphySticker[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const lastQueryRef = useRef("");
  const activeRequestRef = useRef<AbortController | null>(null);
  const inFlightKeyRef = useRef<string | null>(null);
  const hasRequestedTrendingRef = useRef(false);

  const fetchStickers = useCallback(async (searchQuery: string, offset = 0) => {
    const apiKey = getGiphyApiKey(GIPHY_CONTEXT);
    if (!apiKey) return;
    const normalizedQuery = normalizeGiphyQuery(searchQuery);
    const endpointName = normalizedQuery ? "search" : "trending";
    const requestKey = `${endpointName}:${normalizedQuery}:${offset}`;
    if (inFlightKeyRef.current === requestKey) return;
    if (getGiphyCooldownRemainingMs(GIPHY_CONTEXT) > 0) {
      setLoading(false);
      setLoadingMore(false);
      setErrorMessage("요청이 많아요. 잠시 후 다시 시도해 주세요");
      return;
    }

    activeRequestRef.current?.abort();
    const controller = new AbortController();
    activeRequestRef.current = controller;
    inFlightKeyRef.current = requestKey;
    const isLoadMore = offset > 0;
    if (isLoadMore) setLoadingMore(true); else setLoading(true);
    setErrorMessage(null);
    const startedAt = performance.now();
    let responseStatus = 0;
    void hashGiphyQuery(normalizedQuery).then((queryHash) => {
      trackEvent("giphy_api_request", {
        context: GIPHY_CONTEXT,
        endpoint: endpointName,
        offset,
        query_hash: queryHash,
      });
    });

    try {
      const base = normalizedQuery
        ? `https://api.giphy.com/v1/stickers/search?api_key=${apiKey}&q=${encodeURIComponent(normalizedQuery)}&limit=${PAGE_SIZE}&offset=${offset}&rating=g`
        : `https://api.giphy.com/v1/stickers/trending?api_key=${apiKey}&limit=${PAGE_SIZE}&offset=${offset}&rating=g`;
      const res = await fetch(base, { signal: controller.signal, cache: "no-store" });
      responseStatus = res.status;
      if (res.status === 429) {
        startGiphyCooldown(GIPHY_CONTEXT, res.headers.get("Retry-After"));
        setErrorMessage("요청이 많아요. 잠시 후 다시 시도해 주세요");
        trackEvent("giphy_api_result", {
          context: GIPHY_CONTEXT,
          endpoint: endpointName,
          offset,
          status: 429,
          latency_ms: Math.round(performance.now() - startedAt),
        });
        return;
      }
      if (!res.ok) throw new Error(`GIPHY request failed: ${res.status}`);

      const json = await res.json();
      const newData: GiphySticker[] = json.data ?? [];
      const total = json.pagination?.total_count ?? 0;
      if (isLoadMore) {
        setStickers((prev) => [...prev, ...newData]);
      } else {
        setStickers(newData);
        lastQueryRef.current = searchQuery;
      }
      setHasMore(offset + newData.length < total && newData.length === PAGE_SIZE);
      trackEvent("giphy_api_result", {
        context: GIPHY_CONTEXT,
        endpoint: endpointName,
        offset,
        status: res.status,
        latency_ms: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setErrorMessage("스티커를 불러올 수 없어요");
      trackEvent("giphy_api_result", {
        context: GIPHY_CONTEXT,
        endpoint: endpointName,
        offset,
        status: responseStatus,
        latency_ms: Math.round(performance.now() - startedAt),
      });
    } finally {
      if (activeRequestRef.current === controller) {
        activeRequestRef.current = null;
        inFlightKeyRef.current = null;
        if (isLoadMore) setLoadingMore(false); else setLoading(false);
      }
    }
  }, []);

  // One initial Trending request, then debounced Search requests only.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    activeRequestRef.current?.abort();
    setErrorMessage(null);
    const normalizedQuery = normalizeGiphyQuery(query);

    if (!normalizedQuery) {
      setLoading(false);
      if (!hasRequestedTrendingRef.current) {
        debounceRef.current = setTimeout(() => {
          hasRequestedTrendingRef.current = true;
          void fetchStickers("");
        }, 0);
      }
    } else if (normalizedQuery.length >= GIPHY_MIN_QUERY_LENGTH) {
      debounceRef.current = setTimeout(() => {
        void fetchStickers(normalizedQuery);
      }, GIPHY_SEARCH_DEBOUNCE_MS);
    } else {
      setLoading(false);
    }

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, fetchStickers]);

  useEffect(() => () => activeRequestRef.current?.abort(), []);

  return (
    <div className="space-y-3">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="스티커 검색..."
        className="w-full px-3 py-2 rounded-xl bg-bg-tertiary text-text-primary placeholder:text-text-tertiary text-sm outline-none focus:ring-2 focus:ring-accent"
      />

      {errorMessage && (
        <div className="text-center text-xs text-text-tertiary" role="status">
          {errorMessage}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={24} className="animate-spin text-text-tertiary" />
        </div>
      ) : stickers.length === 0 && query && normalizeGiphyQuery(query).length < GIPHY_MIN_QUERY_LENGTH ? (
        <div className="flex items-center justify-center py-8 text-sm text-text-tertiary">
          두 글자 이상 입력해 주세요
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-2">
          {stickers.map((sticker) => (
            <button
              key={sticker.id}
              onClick={() => {
                const stillUrl =
                  sticker.images.original_still?.url ||
                  sticker.images.fixed_width_small_still?.url;
                if (stillUrl) addImage(stillUrl);
              }}
              className="aspect-square rounded-xl bg-bg-tertiary flex items-center justify-center p-1 active:scale-90 transition-transform hover:bg-bg-secondary overflow-hidden"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={sticker.images.fixed_width_small_still?.url || sticker.images.fixed_width_small?.url}
                alt={sticker.title}
                className="w-full h-full object-contain"
                loading="lazy"
              />
            </button>
          ))}
        </div>
      )}

      {/* Load more button */}
      {hasMore && !loading && (
        <button
          onClick={() => fetchStickers(lastQueryRef.current, stickers.length)}
          disabled={loadingMore}
          className="w-full py-2.5 rounded-xl bg-bg-tertiary text-text-secondary text-sm font-medium hover:bg-bg-secondary transition-colors disabled:opacity-50"
        >
          {loadingMore ? (
            <Loader2 size={16} className="animate-spin mx-auto" />
          ) : (
            "더보기"
          )}
        </button>
      )}

      {/* GIPHY Attribution */}
      <div className="flex items-center justify-center gap-1.5 py-1 text-text-tertiary text-xs">
        Powered by GIPHY
      </div>
    </div>
  );
}
