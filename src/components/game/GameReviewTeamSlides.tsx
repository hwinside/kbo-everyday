"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { ReviewTeamIdentity, reviewTeamStyle } from "./GameReviewIdentity";
import { getTeamById } from "@/lib/constants/teams";
import type { ReviewFeed, ReviewRow } from "@/lib/game-reviews/domain";

export type ReviewSlidePage = { rows: ReviewRow[]; next: string | null; best: ReviewRow[] };
const control = "flex min-h-11 min-w-11 items-center justify-center rounded-lg disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-accent";

/** Each team uses the same authenticated ranked endpoint/cursor as the full list.
 * Do not split the overall first page: the other team's first row may be on page 2.
 */
export default function GameReviewTeamSlides({ gameId, teamId, viewerId, request, renderCard, paused, initialPage }: {
  gameId: string; teamId: number; viewerId: string | null;
  request: (path: string) => Promise<{ viewerId: string | null; feed: ReviewFeed | null }>;
  renderCard: (row: ReviewRow, best: boolean) => ReactNode;
  paused: boolean;
  initialPage?: ReviewSlidePage;
}) {
  const [page, setPage] = useState<ReviewSlidePage | null>(initialPage ?? null);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [stopped, setStopped] = useState(false), [reduced, setReduced] = useState(true);
  const [visible, setVisible] = useState(false), [foreground, setForeground] = useState(true);
  const rail = useRef<HTMLDivElement>(null), root = useRef<HTMLDivElement>(null);
  const seeded = useRef(!!initialPage);
  const indexRef = useRef(index); indexRef.current = index;
  const alive = useRef(true), pending = useRef(false);

  const load = useCallback(async (cursor?: string) => {
    if (pending.current) return;
    pending.current = true; setLoading(true); setError("");
    try {
      const query = new URLSearchParams({ team: String(teamId) });
      if (cursor) query.set("cursor", cursor);
      const result = await request(`/api/games/${gameId}/reviews?${query}`);
      if (!alive.current) return;
      if (result.viewerId !== viewerId || !result.feed) throw new Error("로그인 상태가 바뀌었어요");
      const feed = result.feed;
      setPage(previous => ({ rows: cursor && previous
        ? [...previous.rows, ...feed.rows].filter((row, i, rows) => rows.findIndex(r => r.id === row.id) === i)
        : feed.rows, next: feed.next, best: feed.best }));
    } catch {
      if (alive.current) setError("한 줄을 불러오지 못했어요");
    } finally {
      pending.current = false;
      if (alive.current) setLoading(false);
    }
  }, [gameId, teamId, viewerId, request]);

  useEffect(() => { alive.current = true; if (!seeded.current) void load(); return () => { alive.current = false; }; }, [load]);
  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => setReduced(motion.matches);
    const updateVisibility = () => setForeground(!document.hidden);
    updateMotion(); updateVisibility();
    motion.addEventListener("change", updateMotion);
    document.addEventListener("visibilitychange", updateVisibility);
    const observer = new IntersectionObserver(entries => setVisible(entries[0]?.isIntersecting ?? false));
    if (root.current) observer.observe(root.current);
    return () => { motion.removeEventListener("change", updateMotion); document.removeEventListener("visibilitychange", updateVisibility); observer.disconnect(); };
  }, []);

  const move = useCallback((target: number) => {
    const el = rail.current;
    if (el) el.scrollTo({ left: target * el.clientWidth, behavior: reduced ? "instant" : "smooth" });
  }, [reduced]);
  // Fetch the next ranked page before reaching the boundary. Errors require an
  // explicit retry, not a repeated timer-driven request loop.
  useEffect(() => {
    if (page?.next && index >= page.rows.length - 2 && !loading && !error) void load(page.next);
  }, [page, index, loading, error, load]);
  useEffect(() => {
    if (paused || stopped || reduced || !visible || !foreground || loading || error || !page || page.rows.length < 2) return;
    const timer = window.setInterval(() => move(index + 1 < page.rows.length ? index + 1 : 0), 3000);
    return () => window.clearInterval(timer);
  }, [paused, stopped, reduced, visible, foreground, loading, error, page, index, move]);
  useEffect(() => {
    const el = rail.current;
    if (!el) return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      el.scrollTo({ left: indexRef.current * width, behavior: "instant" });
    });
    observer.observe(el); return () => observer.disconnect();
  }, []);

  return <div ref={root} className="flex min-w-0 flex-col" role="region" aria-label={`${getTeamById(teamId)?.shortName ?? "팀"} 팬 한줄평 슬라이드`}>
    <div ref={rail} className="flex flex-1 snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none]"
      onPointerDown={() => setStopped(true)} onFocusCapture={() => setStopped(true)}
      onScroll={e => { const el = e.currentTarget; if (el.clientWidth) setIndex(Math.round(el.scrollLeft / el.clientWidth)); }}>
      {page?.rows.map((row, i) => <div key={row.id} className="w-full min-w-0 shrink-0 snap-start snap-always" inert={i !== index}>
        {renderCard(row, page.best.some(best => best.id === row.id))}
      </div>)}
      {!page?.rows.length && <div className="w-full rounded-2xl border border-border border-t-[3px] bg-bg-secondary p-3 [border-top-color:var(--review-team-color)] dark:[border-top-color:var(--review-team-color-dark)]" style={reviewTeamStyle(teamId)}>
        <ReviewTeamIdentity teamId={teamId} best={false} />
        <p className="mt-3 min-h-24 border-t border-border pt-3 text-xs leading-5 text-text-secondary" role="status">{error || (loading || !page ? "한 줄을 불러오는 중…" : "아직 한 줄이 없어요.")}</p>
      </div>}
    </div>
    {!!page?.rows.length && <div className="mt-1 flex flex-wrap items-center justify-between text-xs text-text-secondary">
      <button className={control} aria-label="이전 한 줄" disabled={index === 0} onClick={() => { setStopped(true); move(index - 1); }}><ChevronLeft size={16}/></button>
      <span>{index + 1} / {page.rows.length}{page.next ? "+" : ""}</span>
      <button className={control} aria-label="다음 한 줄" disabled={index >= page.rows.length - 1} onClick={() => { setStopped(true); move(index + 1); }}><ChevronRight size={16}/></button>
      {!reduced && page.rows.length > 1 && <button className={control} aria-label={stopped ? "자동 넘김 시작" : "자동 넘김 정지"} onClick={() => setStopped(value => !value)}>{stopped ? <Play size={14}/> : <Pause size={14}/>}</button>}
    </div>}
    {error && <button className="min-h-11 text-xs text-text-secondary" onClick={() => void load(page?.next ?? undefined)}>다시 불러오기</button>}
    {loading && !!page?.rows.length && <span role="status" className="text-xs text-text-secondary">다음 한 줄을 불러오는 중…</span>}
  </div>;
}
