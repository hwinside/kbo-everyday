"use client";

import { useState, useCallback } from "react";
import { X, Hash } from "lucide-react";

interface HashtagInputProps {
  autoTags: string[];
  tags: string[];
  onUpdate: (tags: string[]) => void;
}

export default function HashtagInput({ autoTags, tags, onUpdate }: HashtagInputProps) {
  const [input, setInput] = useState("");

  const addTag = useCallback(
    (tag: string) => {
      const cleaned = tag.replace(/^#/, "").trim();
      if (!cleaned) return;
      const full = `#${cleaned}`;
      if (!tags.includes(full)) {
        onUpdate([...tags, full]);
      }
    },
    [tags, onUpdate]
  );

  const removeTag = useCallback(
    (tag: string) => {
      onUpdate(tags.filter((t) => t !== tag));
    },
    [tags, onUpdate]
  );

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      addTag(input);
      setInput("");
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-text-secondary">해시태그</p>

      {/* Auto-suggested tags */}
      {autoTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {autoTags.map((tag) => {
            const isAdded = tags.includes(tag);
            return (
              <button
                key={tag}
                onClick={() => (isAdded ? removeTag(tag) : addTag(tag.replace("#", "")))}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                  isAdded
                    ? "bg-accent/20 text-accent"
                    : "bg-bg-tertiary text-text-secondary"
                }`}
              >
                {tag}
              </button>
            );
          })}
        </div>
      )}

      {/* Current tags */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags
            .filter((t) => !autoTags.includes(t))
            .map((tag) => (
              <span
                key={tag}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-accent/20 text-accent"
              >
                {tag}
                <button onClick={() => removeTag(tag)}>
                  <X size={12} />
                </button>
              </span>
            ))}
        </div>
      )}

      {/* Input */}
      <div className="relative">
        <Hash size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
        <input
          type="text"
          placeholder="태그 입력 후 Enter"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          className="w-full pl-8 pr-3 py-2 rounded-lg bg-bg-tertiary text-sm text-text-primary placeholder:text-text-tertiary outline-none"
        />
      </div>
    </div>
  );
}
