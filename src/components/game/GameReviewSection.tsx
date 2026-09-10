"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Heart, MessageCircle, X, ArrowLeft, Flag, Pencil, Trash2, RefreshCw } from "lucide-react";
import GameReviewTeamSlides from "@/components/game/GameReviewTeamSlides";
import GameReviewCommentSheet from "@/components/game/GameReviewCommentSheet";
import LoginSheet from "@/components/auth/LoginSheet";
import TeamLogo from "@/components/ui/TeamLogo";
import GameReviewIdentity, { ReviewTeamIdentity, reviewTeamStyle } from "@/components/game/GameReviewIdentity";
import GameReviewNominee from "@/components/game/GameReviewNominee";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getSafeSession, supabase } from "@/lib/supabase/client";
import { blockUserById } from "@/lib/supabase/useBlock";
import { createReviewTokenReader } from "@/lib/game-reviews/session-token";
import { reviewDeletionMessage } from "@/lib/game-reviews/policy";
import { getTeamById } from "@/lib/constants/teams";
import { canEdit, COMMENT_LIMIT, EDIT_WINDOW_MS, REPORT_REASONS, textLength, validateText, type ReviewContext, type ReviewFeed, type ReviewRow } from "@/lib/game-reviews/domain";

type Comment = { id: number; author_id: string; nickname: string; avatar_url?: string | null; content: string; created_at: string; team_id: number | null };
type Sheet = { kind: "list" } | { kind: "compose"; review?: ReviewRow } | { kind: "comments"; review: ReviewRow } | { kind: "full"; review: ReviewRow }
  | { kind: "report" | "reported"; target: number; targetType: "game_review" | "game_review_comment" }
  | { kind: "delete"; review: ReviewRow; comment?: Comment } | { kind: "comment_edit"; review: ReviewRow; comment: Comment };
const button = "min-h-11 rounded-xl px-3 text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const primary = `${button} bg-[#FF453A] text-[#160706]`;
const surface = "rounded-2xl border border-border bg-bg-secondary";
const teamBorder = "border-t-[3px] [border-top-color:var(--review-team-color)] dark:[border-top-color:var(--review-team-color-dark)]";
const teamName = (id: number | null) => id ? getTeamById(id)?.shortName ?? getTeamById(id)?.name ?? "팬" : "팬";

export default function GameReviewSection({ gameId }: { gameId: string }) {
  const { user, profile } = useAuth();
  const scope = `${gameId}:${user?.id ?? "guest"}`;
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const [data, setData] = useState<{ scope: string; context: ReviewContext; feed: ReviewFeed } | null>(null);
  const [slideRevision, setSlideRevision] = useState(0);
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [sheet, setSheet] = useState<Sheet | null>(null), [history, setHistory] = useState<Sheet[]>([]);
  const [login, setLogin] = useState(false), [busy, setBusy] = useState(false);
  const [content, setContent] = useState(""), [playerKey, setPlayerKey] = useState("");
  const [formError, setFormError] = useState(""), [notice, setNotice] = useState("");
  const [reason, setReason] = useState<string>(REPORT_REASONS[0]);
  const [commentsLoading, setCommentsLoading] = useState(false), [commentsError, setCommentsError] = useState("");
  const [focused, setFocused] = useState<ReviewRow | null>(null);
  const [filter, setFilter] = useState<number | null>(null), filterRef = useRef<number | null>(null);
  const [now, setNow] = useState(Date.now()), offset = useRef(0);
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const feedRequest = useRef(0), commentRequest = useRef(0);
  const active = data?.scope === scope ? data : null;
  const feed = active?.feed, context = active?.context;
  const policy = feed?.policy;
  const deletionMessage = reviewDeletionMessage(!!policy?.allowRecreateAfterDelete);
  const sheetOpen = !!sheet && sheet.kind !== "comments";

  const tokenReader = useMemo(() => createReviewTokenReader(user?.id ?? null, getSafeSession), [user?.id]);
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => tokenReader.update(session));
    return () => { subscription.unsubscribe(); tokenReader.update(null); };
  }, [tokenReader]);
  const request = useCallback(async (path: string, body?: unknown) => {
    const token = await tokenReader.read();
    const res = await fetch(path, { method: body ? "POST" : "GET", cache: "no-store",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (res.status === 401) tokenReader.update(null);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "불러오지 못했어요. 다시 시도해 주세요");
    return json;
  }, [tokenReader]);
  const reload = useCallback(async (before?: string, team = filterRef.current) => {
    const sequence = ++feedRequest.current;
    setLoading(true); setError("");
    try {
      const query = new URLSearchParams(); if (before) query.set("cursor", before); if (team) query.set("team", String(team));
      const json = await request(`/api/games/${gameId}/reviews?${query}`);
      if (scopeRef.current !== scope || sequence !== feedRequest.current) return;
      if (json.viewerId !== (user?.id ?? null)) { setData(null); throw new Error("로그인 상태가 바뀌었어요. 다시 시도해 주세요"); }
      if (!json.feed) { setData(null); return; }
      if (!before) setSlideRevision(v => v + 1);
      offset.current = Date.parse(json.feed.server_now) - Date.now();
      setData(previous => ({ scope, context: json.context, feed: { ...json.feed,
        rows: before && previous?.scope === scope ? [...previous.feed.rows, ...json.feed.rows].filter((row, index, all) => all.findIndex(r => r.id === row.id) === index) : json.feed.rows } }));
    } catch (e) { if (scopeRef.current === scope && sequence === feedRequest.current) setError((e as Error).message); }
    finally { if (scopeRef.current === scope && sequence === feedRequest.current) setLoading(false); }
  }, [gameId, request, scope, user?.id]);
  useEffect(() => {
    // Auth/game changes must never retain another viewer's private state.
    setSheet(null); setHistory([]); setFocused(null); setContent(""); setNotice("");
    setFilter(null); filterRef.current = null; void reload();
    const refresh = () => { setSheet(null); setHistory([]); setFocused(null); commentRequest.current++; setSlideRevision(v => v + 1); void reload(); };
    window.addEventListener("kbo:block-changed", refresh);
    return () => { window.removeEventListener("kbo:block-changed", refresh); };
  }, [reload]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() + offset.current), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!sheetOpen || !dialog.current) return;
    const el = dialog.current, old = document.body.style.overflow;
    el.showModal(); document.body.style.overflow = "hidden";
    return () => { el.close(); document.body.style.overflow = old; };
  }, [sheetOpen]);
  useEffect(() => { if (sheet) heading.current?.focus(); }, [sheet]);

  function close() { setSheet(null); setHistory([]); setFocused(null); commentRequest.current++; }
  function open(next: Sheet) { if (next.kind === "list") void reload(); if (sheet) setHistory(h => [...h, sheet]); setSheet(next); setFormError(""); setContent(""); }
  function back() { const previous = history.at(-1); setHistory(h => h.slice(0, -1)); setSheet(previous ?? null); setContent(""); setFormError(""); }
  function requireLogin() { if (user) return true; close(); setLogin(true); return false; }
  function compose(review?: ReviewRow) { if (!requireLogin()) return; open({ kind: "compose", review }); setContent(review?.content ?? ""); setPlayerKey(policy?.nominationMode === "disabled" ? "" : review?.player_key ?? ""); }
  async function loadComments(review: ReviewRow, before?: number) {
    const sequence = ++commentRequest.current;
    setCommentsLoading(true); setCommentsError("");
    try {
      const json = await request(`/api/games/${gameId}/reviews?review=${review.id}${before ? `&before=${before}` : ""}`);
      if (scopeRef.current !== scope || sequence !== commentRequest.current) return;
      if (json.viewerId !== (user?.id ?? null) || !json.feed?.review) throw new Error("현재 댓글을 볼 수 없어요");
      setFocused(json.feed.review);
    } catch (e) { if (scopeRef.current === scope && sequence === commentRequest.current) { setCommentsError((e as Error).message); setFocused(null); } }
    finally { if (scopeRef.current === scope && sequence === commentRequest.current) setCommentsLoading(false); }
  }
  function showFull(review: ReviewRow) { open({ kind: "full", review }); setFocused(null); void loadComments(review); }
  function showComments(review: ReviewRow) { setFocused(null); open({ kind: "comments", review }); }
  async function mutate(body: unknown, done?: () => void) {
    if (busy || !requireLogin()) return;
    setBusy(true); setFormError("");
    try {
      await request(`/api/games/${gameId}/reviews`, body);
      if (scopeRef.current !== scope) return;
      done?.(); await reload();
    } catch (e) { if (scopeRef.current === scope) setFormError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function like(review: ReviewRow) {
    if (busy || !requireLogin()) return;
    const previous = data, previousFocused = focused;
    const patch = (r: ReviewRow) => r.id === review.id ? { ...r, liked: !review.liked, like_count: r.like_count + (review.liked ? -1 : 1) } : r;
    setData(d => d ? { ...d, feed: { ...d.feed, rows: d.feed.rows.map(patch), best: d.feed.best.map(patch), ownReview: d.feed.ownReview ? patch(d.feed.ownReview) : null } } : d);
    setFocused(r => r ? patch(r) : r);
    setBusy(true); setNotice("");
    try { await request(`/api/games/${gameId}/reviews`, { op: "like", reviewId: review.id, liked: !review.liked }); if (scopeRef.current === scope) { await reload(); if (sheet?.kind === "full" || sheet?.kind === "comments") await loadComments(sheet.review); } }
    catch { if (scopeRef.current === scope) { setData(previous); setFocused(previousFocused); setNotice("좋아요를 원래 상태로 되돌렸어요. 다시 눌러 주세요"); } }
    finally { setBusy(false); }
  }
  function currentReview(row: ReviewRow) { return (focused?.id === row.id ? focused : null) ?? feed?.rows.find(r => r.id === row.id) ?? feed?.best.find(r => r.id === row.id) ?? (feed?.ownReview?.id === row.id ? feed.ownReview : row); }
  function card(source: ReviewRow, preview = false, commentContext = false, best = true) {
    const row = currentReview(source), own = row.author_id === user?.id;
    return <article key={row.id} className={`${surface} ${teamBorder} flex min-w-0 flex-col p-3 ${preview ? "h-full" : ""}`} style={reviewTeamStyle(row.team_id)}>
      {preview && row.team_id && <div className="mb-3 border-b border-border pb-2"><ReviewTeamIdentity teamId={row.team_id} best={best} /></div>}
      <div className="flex min-w-0 items-center gap-2"><div className="min-w-0 flex-1"><GameReviewIdentity authorId={row.author_id} nickname={row.nickname} teamId={row.team_id} avatarUrl={row.avatar_url} compact={preview} onNavigate={close} /></div>{own && !preview && <span className="shrink-0 rounded bg-[var(--primary-weak-bg)] px-2 py-1 text-xs text-text-primary">내 글</span>}</div>
      <p className={`my-3 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm leading-6 ${preview ? "line-clamp-4" : ""}`}>{row.content}</p>
      {preview && <button className={`${button} self-start px-0 text-text-secondary`} onClick={() => showFull(row)}>전문 보기</button>}
      {row.player_name && <GameReviewNominee name={row.player_name} teamId={row.team_id} playerKey={row.player_key} onNavigate={close} />}
      <div className={`${preview ? "mt-auto pt-2" : "mt-2"} flex flex-wrap items-center gap-1`}>
        <button className={`${button} flex items-center gap-1 px-2 ${row.liked ? "text-[#B42318] dark:text-accent" : "text-text-secondary"}`} aria-label={own ? "내 글 좋아요는 누를 수 없어요" : `좋아요 ${row.like_count}`} aria-pressed={row.liked} disabled={busy || own} onClick={() => void like(row)}><Heart size={16} fill={row.liked ? "currentColor" : "none"} />{row.like_count}</button>
        {!commentContext && <button className={`${button} flex items-center gap-1 px-2 text-text-secondary`} onClick={() => showComments(row)} aria-label={`댓글 ${row.comment_count}개 보기`}><MessageCircle size={16}/>{row.comment_count}</button>}
        {!preview && (own ? <><button className={button} disabled={!canEdit(row.created_at, row.edit_count, now)} onClick={() => compose(row)}><Pencil size={16}/><span className="sr-only">수정</span></button><button className={button} onClick={() => open({ kind: "delete", review: row })}><Trash2 size={16}/><span className="sr-only">삭제</span></button></> : <button className={button} onClick={() => { if (requireLogin()) open({ kind: "report", target: row.id, targetType: "game_review" }); }}><Flag size={16}/><span className="sr-only">신고</span></button>)}
      </div>
      {!preview && own && <p className="text-xs text-text-secondary">{row.edit_count ? "1회 수정을 사용했어요" : canEdit(row.created_at, row.edit_count, now) ? `수정 가능 ${Math.max(0, Math.ceil((Date.parse(row.created_at) + EDIT_WINDOW_MS - now) / 1000))}초` : "수정 가능 시간이 지났어요"}</p>}
      {!preview && !own && user && <button className={`${button} self-start text-xs text-text-secondary`} onClick={async () => { if (!window.confirm("이 팬을 차단할까요? 서로의 글을 볼 수 없어요.")) return; if (await blockUserById(user.id, row.author_id)) { close(); await reload(); } else setNotice("차단하지 못했어요. 다시 시도해 주세요"); }}>이 팬 차단</button>}
    </article>;
  }
  const eligible = !!context && !!profile?.team_id && [context.awayTeamId, context.homeTeamId].includes(profile.team_id);
  const writing = sheet?.kind === "compose", editingComment = sheet?.kind === "comment_edit";
  const limit = writing ? 100 : COMMENT_LIMIT;
  let inputIssue = "";
  if (content) { try { validateText(content, limit); } catch (e) { inputIssue = (e as Error).message; } }
  const needsPlayer = writing && policy?.nominationMode === "required_winner_participant" && (sheet.review?.team_id ?? profile?.team_id) === context?.winnerTeamId && !playerKey;
  const composeExpired = writing && !!sheet.review && !canEdit(sheet.review.created_at, sheet.review.edit_count, now);
  const title = sheet?.kind === "list" ? "팬들의 한 줄" : writing ? sheet.review ? "내 한 줄 수정" : "내 한 줄 남기기" : sheet?.kind === "comments" ? "댓글" : sheet?.kind === "full" ? "한 줄 전문" : sheet?.kind === "report" ? "신고하기" : sheet?.kind === "reported" ? "신고 접수 완료" : sheet?.kind === "delete" ? "삭제할까요?" : "댓글 수정";
  function entry() {
    if (!user) return <button className={`${primary} w-full`} onClick={() => { close(); setLogin(true); }}>로그인하고 함께하기</button>;
    if (feed?.own?.hidden && !feed.own.deleted) return <div className="text-sm text-text-secondary">운영 정책 위반으로 숨겨진 내 글이 있어요. 다른 팬에게 보이지 않고 베스트에서 제외돼요.<button className={button} disabled={busy} onClick={() => { if (window.confirm("숨겨진 내 글을 삭제할까요? " + deletionMessage)) void mutate({ op: "delete", reviewId: feed.own!.id }); }}>내 글 삭제</button></div>;
    if (feed?.own?.deleted && !policy?.allowRecreateAfterDelete) return <p className="text-sm text-text-secondary">내 한 줄을 삭제했어요. 이 경기에는 다시 등록할 수 없어요.</p>;
    if (feed?.ownReview) return <button className={`${button} w-full border border-border`} onClick={() => showFull(feed.ownReview!)}>✓ 내 한 줄 보기</button>;
    if (!profile?.team_id) return <Link className={`${primary} flex items-center justify-center`} href="/my">최애팀 설정하고 한 줄 남기기</Link>;
    if (!eligible) return <p className="text-sm text-text-secondary">한 줄 작성은 {context && `${teamName(context.awayTeamId)}·${teamName(context.homeTeamId)}`} 팬만 가능해요. 댓글·좋아요는 모든 로그인 유저가 참여할 수 있어요.</p>;
    return <button className={`${primary} w-full`} onClick={() => compose()}>내 한 줄 남기기</button>;
  }
  if (!loading && !active && !error) return null;
  return <section aria-label="경기 한줄평" className="mx-4 mb-5 rounded-2xl border border-border p-4">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-x-2 gap-y-1"><h2 className="min-w-0 font-bold">경기는 끝나도, 한 줄은 남아</h2><div className="flex shrink-0 items-center"><button className={`${button} px-2`} disabled={loading || busy} aria-label="한줄평 새로고침" onClick={() => void reload()}><RefreshCw size={16}/></button><button className={`${button} px-2`} disabled={!feed} onClick={() => open({ kind: "list" })}>전체 {feed?.total ?? ""} ›</button></div></div>
    {loading && !active && <div role="status" aria-label="한줄평 불러오는 중" className="h-36 animate-pulse rounded-xl bg-bg-tertiary"/>}
    {error && <div role="alert" className="text-sm text-text-secondary">{error}<button className={button} onClick={() => void reload()}>다시 시도</button></div>}
    {feed && context && <><div className="mb-3 grid grid-cols-2 gap-2">{[context.awayTeamId, context.homeTeamId].map(team => {
      return <GameReviewTeamSlides key={`${scope}:${team}:${slideRevision}`} gameId={gameId} teamId={team}
        viewerId={user?.id ?? null} request={request} paused={!!sheet || busy}
        renderCard={(row, best) => card(row, true, false, best)} />;
    })}</div>{entry()}</>}
    {notice && <p role="status" className="mt-2 text-sm text-text-secondary">{notice}</p>}
    {sheet?.kind === "comments" && <GameReviewCommentSheet
      key={`${scope}:${sheet.review.id}`}
      gameId={gameId} reviewId={sheet.review.id} viewerId={user?.id ?? null} teamId={sheet.review.team_id}
      context={<details className="rounded-xl border border-border p-3">
        <summary className="cursor-pointer text-xs text-text-secondary">{context && `${teamName(context.awayTeamId)} ${context.score} ${teamName(context.homeTeamId)} · 종료`} · 원글 보기</summary>
        <div className="mt-3">{card(sheet.review, false, true)}</div>
      </details>}
      request={request} onClose={back} onNavigate={close} onChanged={() => { void reload(); }}
      onReport={id => open({ kind: "report", target: id, targetType: "game_review_comment" })}
    />}
    <LoginSheet isOpen={login} onClose={() => setLogin(false)}/>
    <dialog ref={dialog} aria-labelledby="game-review-title" onCancel={e => { e.preventDefault(); if (!busy) close(); }} className="fixed inset-x-0 bottom-0 top-auto m-0 mx-auto w-full max-w-lg max-h-[90dvh] rounded-t-3xl border border-border bg-bg-primary p-0 pb-[var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px))] text-text-primary backdrop:bg-black/60">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-bg-primary px-3 py-2">{history.length ? <button className={button} disabled={busy} aria-label="이전 화면" onClick={back}><ArrowLeft size={20}/></button> : <span className="w-11"/>}<h2 ref={heading} tabIndex={-1} id="game-review-title" className="font-bold outline-none">{title}</h2><button className={button} disabled={busy} aria-label="닫기" onClick={close}><X size={20}/></button></header>
      <div className="space-y-4 p-4 pb-6">
        {context && <p className="text-xs text-text-secondary">{teamName(context.awayTeamId)} {context.score} {teamName(context.homeTeamId)} · 종료</p>}
        {formError && <p role="alert" className="text-sm text-red-400">{formError}</p>}
        {sheet?.kind === "list" && feed && <><div className="flex gap-2">{[null, context?.awayTeamId, context?.homeTeamId].map((team, i) => <button key={i} aria-pressed={filter === team} className={`${button} flex items-center gap-1.5 border ${filter === team ? "border-[var(--primary-weak-border)] bg-[var(--primary-weak-bg)] text-text-primary" : "border-transparent text-text-secondary"}`} onClick={() => { setFilter(team ?? null); filterRef.current = team ?? null; void reload(); }}>{team && getTeamById(team) && <TeamLogo team={getTeamById(team)!} size={20} />}{team ? `${teamName(team)} 팬` : "전체"}</button>)}</div><p className="text-xs text-text-secondary">좋아요순 · 동점은 최신순 · 팬들의 한 줄 {feed.total}개</p>{feed.rows.filter(r => !filter || r.team_id === filter).map(r => card(r))}{!feed.total && <p className="py-8 text-center text-text-secondary">아직 한 줄이 없어요. 첫 한 줄을 남겨 주세요.</p>}{feed.next && <button className={`${button} w-full`} disabled={loading} onClick={() => void reload(feed.next!)}>더 보기</button>}{entry()}</>}
        {sheet?.kind === "full" && <>{focused?.id === sheet.review.id && card(focused)}{commentsLoading && <p role="status">한 줄을 불러오는 중이에요</p>}{commentsError && <p role="alert">{commentsError}<button className={button} onClick={() => void loadComments(sheet.review)}>다시 시도</button></p>}</>}
        {(writing || editingComment) && <form className="space-y-3" onSubmit={e => { e.preventDefault(); if (writing) void mutate({ op: sheet.review ? "edit" : "create", reviewId: sheet.review?.id, content, playerKey }, () => { setNotice("내 한 줄을 남겼어요"); if (sheet.review) void loadComments(sheet.review); back(); }); else if (editingComment) void mutate({ op: "comment_edit", reviewId: sheet.review.id, commentId: sheet.comment.id, content }, () => { back(); void loadComments(sheet.review); }); }}>
          {writing && <p className="text-sm">{teamName(sheet.review?.team_id ?? profile?.team_id ?? null)} 팬으로 남겨요</p>}
          <label className="block text-sm">{writing ? "한줄평" : "댓글"}<textarea autoFocus value={content} onChange={e => setContent(e.target.value)} rows={4} aria-describedby="game-review-input-help" className="mt-2 w-full resize-y rounded-xl border border-border bg-bg-secondary p-3 text-base"/></label>
          <p id="game-review-input-help" className={`text-xs ${inputIssue ? "text-red-400" : "text-text-secondary"}`}>{inputIssue || (composeExpired ? "수정 가능 시간이 지났거나 1회 수정을 사용했어요" : writing ? "작성 후 10분 안에 1회 수정할 수 있어요" : "모든 로그인 유저가 댓글로 함께할 수 있어요")} · {textLength(content.trim())}/{limit}</p>
          {writing && policy?.nominationMode !== "disabled" && context && (sheet.review?.team_id ?? profile?.team_id) === context.winnerTeamId && <label className="block text-sm">나의 수훈선수 ({policy?.nominationMode === "required_winner_participant" ? "필수" : "선택"})<select className="mt-2 min-h-11 w-full rounded-xl bg-bg-secondary px-3" value={playerKey} onChange={e => setPlayerKey(e.target.value)}><option value="">{policy?.nominationMode === "required_winner_participant" ? "선수를 선택해 주세요" : "지정하지 않기"}</option>{context.players.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}</select>{!context.players.length && <span className="text-xs text-text-secondary">{policy?.nominationMode === "required_winner_participant" ? "출전 선수 정보를 불러오지 못했어요. 새로고침 후 다시 시도해 주세요." : "출전 선수 정보를 준비 중이에요. 선수 지정 없이 남길 수 있어요."}</span>}</label>}
          {writing && policy?.nominationMode !== "disabled" && context && (sheet.review?.team_id ?? profile?.team_id) !== context.winnerTeamId && <p className="text-xs text-text-secondary">{context.winnerTeamId ? "수훈선수는 승리팀 팬만 지정할 수 있어요" : "무승부 경기에는 수훈선수를 지정하지 않아요"}</p>}
          <button className={`${primary} w-full`} disabled={busy || !content.trim() || !!inputIssue || composeExpired || needsPlayer}>{busy ? "저장 중…" : "등록"}</button>
        </form>}
        {sheet?.kind === "delete" && <><p className="text-sm leading-6">{sheet.comment ? "이 댓글을 삭제할까요? 삭제 후 복구할 수 없어요." : deletionMessage}</p><button className={`${primary} w-full`} disabled={busy} onClick={() => void mutate({ op: sheet.comment ? "comment_delete" : "delete", reviewId: sheet.review.id, commentId: sheet.comment?.id }, () => { if (sheet.comment) { back(); void loadComments(sheet.review); } else close(); })}>삭제하기</button></>}
        {sheet?.kind === "report" && <form className="space-y-3" onSubmit={async e => { e.preventDefault(); if (busy || !requireLogin()) return; setBusy(true); setFormError(""); try { await request("/api/report", { targetType: sheet.targetType, targetId: sheet.target, reason }); setSheet({ ...sheet, kind: "reported" }); await reload(); } catch (e) { setFormError((e as Error).message); } finally { setBusy(false); } }}><fieldset><legend className="mb-2 text-sm">신고 사유</legend>{REPORT_REASONS.map(r => <label key={r} className="flex min-h-11 items-center gap-3 text-sm"><input type="radio" name="review-report-reason" checked={reason === r} onChange={() => setReason(r)}/>{r}</label>)}</fieldset><p className="text-xs text-text-secondary">신고한 사람 정보는 상대에게 비공개예요</p><button className={`${primary} w-full`} disabled={busy}>신고 접수</button></form>}
        {sheet?.kind === "reported" && <><p>신고를 접수했어요</p><p className="text-sm text-text-secondary">신고 1건만으로 바로 숨겨지지는 않아요. 서로 다른 사용자 3명이 신고하면 자동으로 숨겨지고, 이후 운영진이 검토해요.</p><button className={`${button} w-full`} onClick={close}>확인</button></>}
      </div>
    </dialog>
  </section>;
}
