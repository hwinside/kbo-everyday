"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Loader2 } from "lucide-react";
import { STICKER_CATEGORIES } from "./stickerData";

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


export default function StickerTool({ addSvg, addImage }: StickerToolProps) {
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
        <button
          onClick={() => setTab("giphy")}
          className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-colors ${
            tab === "giphy" ? "bg-accent text-white" : "bg-bg-tertiary text-text-secondary"
          }`}
        >
          GIPHY
        </button>
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
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const lastQueryRef = useRef("");

  const fetchStickers = useCallback(async (searchQuery: string, offset = 0) => {
    const isLoadMore = offset > 0;
    if (isLoadMore) setLoadingMore(true); else setLoading(true);
    try {
      // GIPHY 직접 호출 → 서버 프록시 (키 공유 429 방지, CDN 캐시)
      const params = new URLSearchParams({
        type: "stickers",
        offset: String(offset),
        limit: String(PAGE_SIZE), // hasMore 판정(newData.length === PAGE_SIZE)과 결속
      });
      if (searchQuery) params.set("q", searchQuery);
      const res = await fetch(`/api/community/giphy?${params.toString()}`);
      if (!res.ok) throw new Error(`giphy proxy ${res.status}`);
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
    } catch {
      if (!isLoadMore) setStickers([]);
      setHasMore(false);
    } finally {
      if (isLoadMore) setLoadingMore(false); else setLoading(false);
    }
  }, []);

  // Load trending on mount
  useEffect(() => {
    fetchStickers("");
  }, [fetchStickers]);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query) {
      fetchStickers("");
      return;
    }
    debounceRef.current = setTimeout(() => {
      fetchStickers(query);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, fetchStickers]);

  return (
    <div className="space-y-3">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="스티커 검색..."
        className="w-full px-3 py-2 rounded-xl bg-bg-tertiary text-text-primary placeholder:text-text-tertiary text-sm outline-none focus:ring-2 focus:ring-accent"
      />

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={24} className="animate-spin text-text-tertiary" />
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
