"use client";

import { useState, useEffect } from "react";
import Image from "next/image";

// Match URLs in text (with or without protocol)
const URL_REGEX = /(?:https?:\/\/|www\.)[^\s<>"')\]]+/g;

// Direct image extensions
const IMAGE_EXT_REGEX = /\.(jpg|jpeg|png|gif|webp)(\?[^\s]*)?$/i;

interface OGData {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  url: string;
}

interface LinkPreviewProps {
  text: string;
  maxPreviews?: number;
  /** Set true when rendered inside a clickable parent (e.g. PostCard button) */
  stopPropagation?: boolean;
}

export default function LinkPreview({ text, maxPreviews = 3, stopPropagation = false }: LinkPreviewProps) {
  const handleClick = stopPropagation
    ? (e: React.MouseEvent) => e.stopPropagation()
    : undefined;
  const [previews, setPreviews] = useState<Map<string, OGData | "loading" | "error">>(new Map());

  // Extract URLs from text, normalize www. → https://www.
  const rawUrls = text.match(URL_REGEX) || [];
  const urls = [...new Set(rawUrls.map((u) => (u.startsWith("http") ? u : `https://${u}`)))].slice(0, maxPreviews);

  useEffect(() => {
    if (urls.length === 0) return;

    urls.forEach((url) => {
      // Skip if already loaded
      if (previews.has(url)) return;

      // Direct image URL — no OG fetch needed
      if (IMAGE_EXT_REGEX.test(url)) {
        setPreviews((prev) => new Map(prev).set(url, {
          title: null,
          description: null,
          image: url,
          siteName: null,
          url,
        }));
        return;
      }

      // Mark as loading
      setPreviews((prev) => new Map(prev).set(url, "loading"));

      // Fetch OG metadata
      fetch(`/api/og-meta?url=${encodeURIComponent(url)}`)
        .then((r) => r.ok ? r.json() : Promise.reject())
        .then((data: OGData) => {
          setPreviews((prev) => new Map(prev).set(url, data));
        })
        .catch(() => {
          setPreviews((prev) => new Map(prev).set(url, "error"));
        });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urls.join(",")]);

  if (urls.length === 0) return null;

  return (
    <div className="mt-2 space-y-2">
      {urls.map((url) => {
        const data = previews.get(url);

        // Loading state
        if (data === "loading") {
          return (
            <div key={url} className="rounded-xl bg-bg-tertiary p-3 animate-pulse">
              <div className="h-3 bg-bg-glass rounded w-2/3" />
            </div>
          );
        }

        // Error — show clean link fallback
        if (data === "error" || !data) {
          return (
            <a onClick={handleClick}
              key={url}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded-xl bg-bg-tertiary px-4 py-3 text-sm text-accent truncate hover:bg-bg-glass transition-colors"
            >
              🔗 {cleanUrl(url)}
            </a>
          );
        }

        const isDirectImage = IMAGE_EXT_REGEX.test(url);

        // Direct image — inline thumbnail (max 200px height)
        if (isDirectImage && data.image) {
          return (
            <a onClick={handleClick}
              key={url}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded-xl overflow-hidden bg-bg-tertiary"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={data.image}
                alt="첨부 이미지"
                className="w-full max-h-[200px] object-contain rounded-xl"
                loading="lazy"
              />
            </a>
          );
        }

        // OG card — compact horizontal layout (image left + text right)
        return (
          <a onClick={handleClick}
            key={url}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex rounded-xl bg-bg-tertiary overflow-hidden hover:bg-bg-glass transition-colors border border-white/5 max-w-lg"
          >
            {data.image && (
              <div className="flex-shrink-0 w-20 h-20 bg-bg-glass">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={data.image}
                  alt={data.title || ""}
                  className="w-20 h-20 object-cover"
                  loading="lazy"
                />
              </div>
            )}
            <div className="flex-1 min-w-0 px-3 py-2 flex flex-col justify-center">
              {data.siteName && (
                <p className="text-[11px] text-text-tertiary truncate">{data.siteName}</p>
              )}
              {data.title && (
                <p className="text-sm font-semibold text-text-primary line-clamp-1">{data.title}</p>
              )}
              {data.description && (
                <p className="text-xs text-text-secondary line-clamp-1 mt-0.5">{data.description}</p>
              )}
              {!data.title && !data.image && (
                <p className="text-sm text-accent truncate">🔗 {cleanUrl(url)}</p>
              )}
            </div>
          </a>
        );
      })}
    </div>
  );
}

function cleanUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname !== "/" ? u.pathname : "");
  } catch {
    return url;
  }
}
