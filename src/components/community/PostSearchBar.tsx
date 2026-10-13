"use client";

import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";

/** 디바운스 간격(ms). 타이핑 중 요청 폭주 방지 — 조합 종료·지우기·Enter 는 즉시 반영. */
export const SEARCH_DEBOUNCE_MS = 300;

/**
 * 커뮤니티 전체글 검색 입력.
 *
 *  - 입력 텍스트는 이 컴포넌트가 들고, 확정된 검색어만 `onCommit` 으로 올린다(300ms 디바운스).
 *  - 원문을 그대로 넘긴다 — trim·길이 가드·이스케이프는 상위(훅/RPC)가 담당(삼순 리뷰 ①).
 *  - iOS/안드 한글 IME: `compositionstart`~`compositionend` 사이(조합 중)에는 디바운스를 걸지 않고,
 *    조합이 끝난 시점에 반영한다. 조합 중간 음절("ㅈ", "지", "직")마다 요청이 나가는 것을 막는다(삼순 리뷰 ④).
 *    ⚠️ 일부 브라우저는 compositionend 뒤에 마지막 input 이벤트가 오므로 두 경로 모두 커밋을 예약한다.
 *  - auto-focus 없음(iOS fixed 요소 viewport 점프 룰).
 */
export default function PostSearchBar({
  initialValue = "",
  onCommit,
  placeholder = "제목, 본문 검색",
}: {
  initialValue?: string;
  onCommit: (raw: string) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState(initialValue);
  const composingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCommittedRef = useRef(initialValue);

  const commit = (value: string) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (lastCommittedRef.current === value) return;
    lastCommittedRef.current = value;
    onCommit(value);
  };

  const schedule = (value: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => commit(value), SEARCH_DEBOUNCE_MS);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-text-tertiary" />
      <input
        type="search"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        aria-label="게시글 검색"
        data-testid="post-search-input"
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          // 조합 중이면 확정 음절이 아니다 — compositionend 에서 예약한다.
          if (composingRef.current || (e.nativeEvent as InputEvent).isComposing) return;
          // 전부 지웠으면 즉시 일반 피드로 복귀(디바운스 대기 없음).
          if (v === "") commit("");
          else schedule(v);
        }}
        onCompositionStart={() => {
          composingRef.current = true;
          if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }
        }}
        onCompositionEnd={(e) => {
          composingRef.current = false;
          schedule((e.target as HTMLInputElement).value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !composingRef.current) {
            e.preventDefault();
            commit((e.target as HTMLInputElement).value);
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="w-full rounded-xl bg-bg-secondary py-3 pl-10 pr-10 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent [&::-webkit-search-cancel-button]:hidden"
      />
      {text !== "" && (
        <button
          type="button"
          aria-label="검색어 지우기"
          data-testid="post-search-clear"
          onClick={() => {
            setText("");
            commit("");
          }}
          className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-text-tertiary hover:bg-bg-tertiary active:scale-95"
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
}
