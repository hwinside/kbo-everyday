"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Search, X, Loader2 } from "lucide-react";
import {
  GIPHY_MIN_QUERY_LENGTH,
  GIPHY_SEARCH_DEBOUNCE_MS,
  getGiphyCooldownRemainingMs,
  getGiphyRequestConfig,
  giphyCooldownMessage,
  trackGiphyEvent,
  hashGiphyQuery,
  normalizeGiphyQuery,
  startGiphyCooldown,
  type GiphyRequestContext,
  type GiphyEndpoint,
} from "@/lib/community/giphy-request";

import { loadPopularGiphyIds } from "@/lib/community/giphy";

const SWIPE_THRESHOLD = 60;

const GIPHY_LIMIT = 24;

interface GiphyImage {
  url: string;
  width: string;
  height: string;
}

interface GiphyGif {
  id: string;
  title: string;
  images: {
    fixed_height: GiphyImage;
    fixed_height_still: GiphyImage;
    original: GiphyImage;
  };
}

interface GifPickerProps {
  context: Extract<GiphyRequestContext, "community_gif" | "game_chat_gif">;
  onSelect: (gifUrl: string, gifId: string) => void;
  onClose: () => void;
}

export default function GifPicker({ context, onSelect, onClose }: GifPickerProps) {
  const [query, setQuery] = useState("");
  const [gifs, setGifs] = useState<GiphyGif[]>([]);
  const [completedQuery, setCompletedQuery] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [listTitle, setListTitle] = useState(context === "game_chat_gif" ? "크보팬 인기 GIF" : "");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const activeRequestRef = useRef<AbortController | null>(null);
  const inFlightKeyRef = useRef<string | null>(null);
  const hasRequestedTrendingRef = useRef(false);
  const dragStartY = useRef(0);

  const fetchGifs = useCallback(async (searchQuery: string) => {
    const normalizedQuery = normalizeGiphyQuery(searchQuery);
    const isPopular = context === "game_chat_gif" && !normalizedQuery;
    const requestKey = `${isPopular ? "popular" : normalizedQuery ? "search" : "trending"}:${normalizedQuery}`;
    const requestConfig = getGiphyRequestConfig(context);
    const apiKey = requestConfig.apiKey;

    if (!apiKey) {
      setLoading(false);
      setErrorMessage("GIF을 불러올 수 없어요");
      return;
    }
    if (inFlightKeyRef.current === requestKey && !activeRequestRef.current?.signal.aborted) return;
    const cooldownMs = getGiphyCooldownRemainingMs(requestConfig);
    if (cooldownMs > 0) {
      setLoading(false);
      setErrorMessage(giphyCooldownMessage(cooldownMs));
      return;
    }

    activeRequestRef.current?.abort();
    const controller = new AbortController();
    activeRequestRef.current = controller;
    inFlightKeyRef.current = requestKey;
    setLoading(true);
    setErrorMessage(null);

    // Every actual provider call has its own telemetry. The first-party ID
    // lookup is not a GIPHY request and never receives its API key.
    const request = async (endpointName: GiphyEndpoint, value = ""): Promise<GiphyGif[] | null> => {
      if (controller.signal.aborted) return null;
      // Another picker/tab may have hit 429 while the ID lookup was pending.
      const remaining = getGiphyCooldownRemainingMs(requestConfig);
      if (remaining > 0) {
        setErrorMessage(giphyCooldownMessage(remaining));
        return null;
      }
      const startedAt = performance.now();
      let responseStatus = 0;
      void hashGiphyQuery(endpointName === "search" ? value : "").then((queryHash) => {
        trackGiphyEvent("giphy_api_request", requestConfig, { endpoint: endpointName, offset: 0, query_hash: queryHash });
      }).catch(() => {
        trackGiphyEvent("giphy_api_request", requestConfig, { endpoint: endpointName, offset: 0 });
      });
      try {
        const params = new URLSearchParams({ api_key: apiKey, rating: "g" });
        if (endpointName === "ids") params.set("ids", value);
        else params.set("limit", String(GIPHY_LIMIT));
        if (endpointName === "search") { params.set("q", value); params.set("lang", "ko"); }
        const path = endpointName === "ids" ? "" : `/${endpointName}`;
        const res = await fetch(`https://api.giphy.com/v1/gifs${path}?${params}`, {
          signal: controller.signal, cache: "no-store",
        });
        responseStatus = res.status;
        if (res.status === 429) {
          const retryMs = startGiphyCooldown(requestConfig, res.headers.get("Retry-After"));
          if (!controller.signal.aborted) setErrorMessage(giphyCooldownMessage(retryMs));
          trackGiphyEvent("giphy_api_result", requestConfig, {
            endpoint: endpointName, offset: 0, status: 429, latency_ms: Math.round(performance.now() - startedAt),
          });
          return null; // No fallback/retry after a provider failure.
        }
        if (!res.ok) throw new Error("GIPHY request failed");
        const json = await res.json();
        if (!Array.isArray(json.data)) throw new Error("Invalid GIPHY response");
        trackGiphyEvent("giphy_api_result", requestConfig, {
          endpoint: endpointName, offset: 0, status: res.status, latency_ms: Math.round(performance.now() - startedAt),
        });
        return controller.signal.aborted ? null : json.data;
      } catch (error) {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return null;
        setErrorMessage("GIF을 불러올 수 없어요");
        trackGiphyEvent("giphy_api_result", requestConfig, {
          endpoint: endpointName, offset: 0, status: responseStatus, latency_ms: Math.round(performance.now() - startedAt),
        });
        return null;
      }
    };

    try {
      let result: GiphyGif[] | null;
      let title = normalizedQuery ? "검색 결과" : "인기 GIF";
      if (isPopular) {
        const ids = await loadPopularGiphyIds(controller.signal);
        if (controller.signal.aborted) return;
        title = "크보팬 인기 GIF";
        result = ids.length ? await request("ids", ids.join(",")) : [];
        if (result) {
          // Only by-ID metadata is arranged in our usage order. Search and
          // Trending responses are never reordered or filtered.
          const resolved = new Map(result.map((gif) => [gif.id, gif]));
          result = ids.flatMap((id) => resolved.has(id) ? [resolved.get(id)!] : []);
        }
        if (result?.length === 0) {
          // No usage yet / removed or rating-restricted IDs. Never manufacture
          // popular results or fetch Trending. Keep Search's returned order.
          title = "야구 GIF";
          result = await request("search", "야구");
        }
      } else {
        result = await request(normalizedQuery ? "search" : "trending", normalizedQuery);
      }
      if (result && !controller.signal.aborted) {
        setGifs(result);
        setListTitle(title);
        setCompletedQuery(normalizedQuery);
      }
    } finally {
      if (activeRequestRef.current === controller) {
        activeRequestRef.current = null;
        inFlightKeyRef.current = null;
        setLoading(false);
      }
    }
  }, [context]);

  // Game chat opens on our usage-derived IDs, not GIPHY Trending.
  // Typing must not cancel the initial catalog/metadata request or auto-search.
  useEffect(() => {
    if (context !== "game_chat_gif") return;
    const timer = setTimeout(() => void fetchGifs(""), 0);
    return () => clearTimeout(timer);
  }, [context, fetchGifs]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (context === "game_chat_gif") return;
    const normalizedQuery = normalizeGiphyQuery(query);
    activeRequestRef.current?.abort();
    setErrorMessage(null);

    if (!normalizedQuery) {
      if (!hasRequestedTrendingRef.current) {
        debounceRef.current = setTimeout(() => {
          hasRequestedTrendingRef.current = true;
          void fetchGifs("");
        }, 0);
      } else {
        setLoading(false);
      }
    } else if (normalizedQuery.length >= GIPHY_MIN_QUERY_LENGTH) {
      debounceRef.current = setTimeout(
        () => void fetchGifs(normalizedQuery),
        GIPHY_SEARCH_DEBOUNCE_MS,
      );
    } else {
      setLoading(false);
    }

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, fetchGifs, context]);

  useEffect(() => () => activeRequestRef.current?.abort(), []);

  return (
    <div className="flex flex-col h-full">
      {/* Header: drag handle (swipe down to dismiss) + close */}
      <div
        className="flex items-center justify-between px-3 pt-2 pb-1 cursor-grab"
        onTouchStart={(e) => { dragStartY.current = e.touches[0].clientY; }}
        onTouchEnd={(e) => {
          const delta = e.changedTouches[0].clientY - dragStartY.current;
          if (delta > SWIPE_THRESHOLD) onClose();
        }}
      >
        <div className="w-8" />
        <div className="w-10 h-1 rounded-full bg-text-tertiary/40" />
        <button onClick={onClose} className="w-8 h-8 flex items-center justify-center text-text-tertiary hover:text-text-primary">
          <X size={18} />
        </button>
      </div>

      {/* Search bar */}
      <div className="flex-none px-3 pb-2">
        <form
          className="flex items-center gap-2 bg-bg-tertiary rounded-lg px-3 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (context === "game_chat_gif" && normalizeGiphyQuery(query).length >= GIPHY_MIN_QUERY_LENGTH) {
              void fetchGifs(query);
            }
          }}
        >
          <Search size={16} className="text-text-tertiary flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              if (context === "game_chat_gif" && inFlightKeyRef.current?.startsWith("search:")) {
                activeRequestRef.current?.abort();
                setLoading(false);
              }
              setQuery(e.target.value);
            }}
            enterKeyHint="search"
            placeholder="GIF 검색..."
            className="min-w-0 flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-tertiary outline-none"
          />
          {query && (
            <button type="button" onClick={() => {
              if (inFlightKeyRef.current?.startsWith("search:")) {
                activeRequestRef.current?.abort();
                setLoading(false);
              }
              setQuery("");
            }} className="text-text-tertiary">
              <X size={14} />
            </button>
          )}
          {context === "game_chat_gif" && (
            <button type="submit" disabled={normalizeGiphyQuery(query).length < GIPHY_MIN_QUERY_LENGTH}
              className="shrink-0 text-sm text-text-primary disabled:opacity-40">검색</button>
          )}
        </form>
        {context === "game_chat_gif" && (
          <button type="button" onClick={() => { setQuery(""); void fetchGifs(""); }}
            className="mt-2 text-xs text-text-secondary">크보팬 인기 GIF</button>
        )}
      </div>

      {context === "game_chat_gif" && (
        <div className="px-3 pb-1 text-xs text-text-tertiary" aria-live="polite">
          {listTitle}{listTitle === "크보팬 인기 GIF" ? " · 최근 30일 경기채팅" : ""}
        </div>
      )}
      {/* Grid */}
      <div className="flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
        {errorMessage && (
          <div className="px-2 py-2 text-center text-xs text-text-tertiary" role="status">
            {errorMessage}
          </div>
        )}
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={24} className="animate-spin text-text-tertiary" />
          </div>
        ) : gifs.length === 0 && !errorMessage ? (
          <div className="flex items-center justify-center py-12 text-sm text-text-tertiary">
            {query && normalizeGiphyQuery(query).length < GIPHY_MIN_QUERY_LENGTH
              ? "두 글자 이상 입력해 주세요"
              : context === "game_chat_gif" && completedQuery !== normalizeGiphyQuery(query)
                ? "검색하거나 인기 GIF를 둘러보세요"
              : query
                ? "검색 결과가 없어요"
                : "표시할 GIF가 없어요. 검색어를 입력해 주세요"}
          </div>
        ) : (
          <div className="columns-2 gap-1.5">
            {gifs.map((gif) => (
              <button
                key={gif.id}
                onClick={() => onSelect(gif.images.fixed_height.url, gif.id)}
                className="block w-full mb-1.5 rounded-lg overflow-hidden hover:opacity-80 transition-opacity break-inside-avoid"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- GIPHY 애니메이션 원본을 그대로 재생한다. */}
                <img
                  src={gif.images.fixed_height.url}
                  alt={gif.title}
                  width={Number(gif.images.fixed_height.width)}
                  height={Number(gif.images.fixed_height.height)}
                  className="w-full h-auto"
                  loading="lazy"
                />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* GIPHY attribution */}
      <div className="flex-none flex items-center justify-center py-1.5 border-t border-border">
        <span className="text-[10px] text-text-tertiary">Powered by GIPHY</span>
      </div>
    </div>
  );
}

/** GIPHY media URL 패턴 감지 */
const GIPHY_URL_RE = /^https:\/\/media\d*\.giphy\.com\/media\/.+/;

/** 댓글 content가 GIF URL인지 판별 */
export function isGifComment(content: string): boolean {
  return GIPHY_URL_RE.test(content.trim());
}
