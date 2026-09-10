"use client";

import { useEffect, useRef, useState } from "react";

/** Reserve the same text/action slots, but only offer expansion for clipped text. */
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

  return <>
    <p ref={text} className="my-3 h-24 shrink-0 line-clamp-4 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm leading-6">{content}</p>
    <div className="h-11 shrink-0">
      {clipped && <button className="min-h-11 rounded-xl text-sm font-semibold text-text-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" onClick={onExpand}>전문 보기</button>}
    </div>
  </>;
}
