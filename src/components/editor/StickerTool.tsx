"use client";

import { useState } from "react";
import { STICKER_CATEGORIES } from "./stickerData";

interface StickerToolProps {
  addSvg: (svgString: string) => Promise<unknown>;
}

export default function StickerTool({ addSvg }: StickerToolProps) {
  const [activeCategory, setActiveCategory] = useState(STICKER_CATEGORIES[0].id);

  const category = STICKER_CATEGORIES.find((c) => c.id === activeCategory) || STICKER_CATEGORIES[0];

  return (
    <div className="p-4 space-y-3">
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
    </div>
  );
}
