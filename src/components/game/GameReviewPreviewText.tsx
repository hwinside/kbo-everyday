"use client";

import { useEffect, useRef, useState } from "react";

/** Reserve a compact two-line text slot, but only offer expansion for clipped text. */
export default function GameReviewPreviewText({ content, onExpand }: { content: string; onExpand: () => void }) {
  const text = useRef<HTMLParagraphElement>(null);
  const [clipped, setClipped] = useState(false);
  useEffect(() => {
    const el = text.current;
    if (!el) return;
    let active = true;
    const measure = () => {
      if (active) setClipped(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // Font loading can change wrapping without changing the reserved block size.
    void document.fonts?.ready.then(measure);
    return () => { active = false; observer.disconnect(); };
  }, [content]);

  return <div className="my-1 flex min-w-0 items-center gap-2">
    <p ref={text} className="h-12 min-w-0 flex-1 line-clamp-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm leading-6">{content}</p>
    <div className="w-14 shrink-0">
      {clipped && <button className="min-h-11 rounded-xl text-sm font-semibold text-text-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" onClick={onExpand}>전문 보기</button>}
    </div>
  </div>;
}
