"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Search, X, Loader2 } from "lucide-react";

const SWIPE_THRESHOLD = 60;

const GIPHY_API_KEY = process.env.NEXT_PUBLIC_GIPHY_API_KEY!;
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
  onSelect: (gifUrl: string) => void;
  onClose: () => void;
}

export default function GifPicker({ onSelect, onClose }: GifPickerProps) {
  const [query, setQuery] = useState("");
  const [gifs, setGifs] = useState<GiphyGif[]>([]);
  const [loading, setLoading] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dragStartY = useRef(0);

  const fetchGifs = useCallback(async (searchQuery: string) => {
    setLoading(true);
    try {
      const endpoint = searchQuery.trim()
        ? `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(searchQuery.trim())}&limit=${GIPHY_LIMIT}&rating=g&lang=ko`
        : `https://api.giphy.com/v1/gifs/trending?api_key=${GIPHY_API_KEY}&limit=${GIPHY_LIMIT}&rating=g`;

      const res = await fetch(endpoint);
      const json = await res.json();
      setGifs(json.data ?? []);
    } catch {
      setGifs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load trending on mount (no auto-focus — triggers iOS keyboard/viewport shift)
  useEffect(() => {
    fetchGifs("");
  }, [fetchGifs]);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchGifs(query), 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, fetchGifs]);

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
        <div className="flex items-center gap-2 bg-bg-tertiary rounded-lg px-3 py-2">
          <Search size={16} className="text-text-tertiary flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="GIF 검색..."
            className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-tertiary outline-none"
          />
          {query && (
            <button onClick={() => setQuery("")} className="text-text-tertiary">
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={24} className="animate-spin text-text-tertiary" />
          </div>
        ) : gifs.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-sm text-text-tertiary">
            {query ? "검색 결과가 없어요" : "GIF를 불러올 수 없어요"}
          </div>
        ) : (
          <div className="columns-2 gap-1.5">
            {gifs.map((gif) => (
              <button
                key={gif.id}
                onClick={() => onSelect(gif.images.fixed_height.url)}
                className="block w-full mb-1.5 rounded-lg overflow-hidden hover:opacity-80 transition-opacity break-inside-avoid"
              >
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
