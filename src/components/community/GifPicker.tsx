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
} from "@/lib/community/giphy-request";

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
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const activeRequestRef = useRef<AbortController | null>(null);
  const inFlightKeyRef = useRef<string | null>(null);
  const hasRequestedTrendingRef = useRef(false);
  const dragStartY = useRef(0);

  const fetchGifs = useCallback(async (searchQuery: string) => {
    const normalizedQuery = normalizeGiphyQuery(searchQuery);
    const endpointName = normalizedQuery ? "search" : "trending";
    const requestKey = `${endpointName}:${normalizedQuery}`;
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
    const startedAt = performance.now();
    let responseStatus = 0;
    void hashGiphyQuery(normalizedQuery).then((queryHash) => {
      trackGiphyEvent("giphy_api_request", requestConfig, {
        endpoint: endpointName,
        offset: 0,
        query_hash: queryHash,
      });
    }).catch(() => {
      // A failed optional hash must not make a real request disappear from telemetry.
      trackGiphyEvent("giphy_api_request", requestConfig, { endpoint: endpointName, offset: 0 });
    });

    try {
      const endpoint = normalizedQuery
        ? `https://api.giphy.com/v1/gifs/search?api_key=${apiKey}&q=${encodeURIComponent(normalizedQuery)}&limit=${GIPHY_LIMIT}&rating=g&lang=ko`
        : `https://api.giphy.com/v1/gifs/trending?api_key=${apiKey}&limit=${GIPHY_LIMIT}&rating=g`;

      const res = await fetch(endpoint, { signal: controller.signal, cache: "no-store" });
      responseStatus = res.status;
      if (res.status === 429) {
        const retryMs = startGiphyCooldown(requestConfig, res.headers.get("Retry-After"));
        if (!controller.signal.aborted) setErrorMessage(giphyCooldownMessage(retryMs));
        trackGiphyEvent("giphy_api_result", requestConfig, {
          endpoint: endpointName,
          offset: 0,
          status: 429,
          latency_ms: Math.round(performance.now() - startedAt),
        });
        return;
      }
      if (!res.ok) throw new Error(`GIPHY request failed: ${res.status}`);

      const json = await res.json();
      if (!controller.signal.aborted) {
        setGifs(json.data ?? []);
        setCompletedQuery(normalizedQuery);
      }
      trackGiphyEvent("giphy_api_result", requestConfig, {
        endpoint: endpointName,
        offset: 0,
        status: res.status,
        latency_ms: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      setErrorMessage("GIF을 불러올 수 없어요");
      trackGiphyEvent("giphy_api_result", requestConfig, {
        endpoint: endpointName,
        offset: 0,
        status: responseStatus,
        latency_ms: Math.round(performance.now() - startedAt),
      });
    } finally {
      if (activeRequestRef.current === controller) {
        activeRequestRef.current = null;
        inFlightKeyRef.current = null;
        setLoading(false);
      }
    }
  }, [context]);

  // Every picker opens with one Trending request so GIFs need no extra click.
  // Game-chat searches remain explicit; typing must not spend additional quota.
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
            className="mt-2 text-xs text-text-secondary">인기 GIF 보기</button>
        )}
      </div>

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
                : context === "game_chat_gif" ? "검색하거나 인기 GIF를 둘러보세요" : "GIF를 불러올 수 없어요"}
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
