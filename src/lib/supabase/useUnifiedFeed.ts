"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "./client";
import { useAuth } from "./AuthContext";
import { useBlockedIds } from "./useBlock";
import type { Post } from "./usePosts";
import { kboIdsForTeamSlug } from "@/lib/utils/player-roster";
import {
  clearFeedRestore,
  consumeBackNavigation,
  ensurePopStateListener,
  readFeedRestore,
  resolveFeedRestoreIntent,
  type FeedRestoreIntent,
  type FeedRestoreState,
} from "@/lib/community/feed-restore";

/**
 * 팀 피드 OR 조건 파트(순수 함수, 회귀 공유).
 * ① `team_tags.cs.["lg"]` — **board_type 무관**. 투표글(board_type='poll')이 팀 태그되면 이 파트로 도달.
 * ② 레거시 팀보드 글, ③ 레거시/움짤콜렉터 선수보드 글.
 * ①에 board_type 제약을 걸면(예: `and(board_type.eq.team,team_tags...)`) tagged poll이 팀 피드에서
 * 사라지므로, 회귀가 ①의 board_type 무관성을 고정한다.
 */
export function buildTeamFeedOrParts(slug: string, kboIds: string[]): string[] {
  const orParts = [
    `team_tags.cs.${JSON.stringify([slug])}`,
    `and(board_type.eq.team,board_id.eq.${slug})`,
  ];
  if (kboIds.length) {
    orParts.push(`and(board_type.eq.player,board_id.in.(${kboIds.map((id) => `"${id}"`).join(",")}))`);
  }
  return orParts;
}

/** 피드가 바라보는 보드 컨텍스트. 전체글/팀/선수가 같은 훅을 source만 바꿔 재사용. */
export type FeedBoard =
  | { kind: "all" }
  | { kind: "team"; teamId: string }
  | { kind: "player"; kboId: string };

/** PostgREST query builder 중 피드 필터에 쓰는 메서드만 추린 최소 인터페이스(회귀 mock 공유). */
export type FeedFilterQuery<Q> = {
  or(filters: string): Q;
  eq(column: string, value: unknown): Q;
  in(column: string, values: readonly unknown[]): Q;
};

/**
 * 보드별 피드 필터를 query 에 적용(순수 — 회귀 가능). 실제 loadPage 가 이 함수로 전체 조립하므로,
 * '팀 query 밖에 board_type=team 추가' 같은 mutation 도 기록된 메서드로 잡힌다:
 *  - team  : team_tags.cs(board_type 무관) OR 레거시 팀/선수 보드. board_type 제약 없음 → tagged poll 도달.
 *  - player: 선수 보드 직접 글(board_type='player'). cross-board tagged 글은 선수 page 자체 query 담당.
 *  - all   : board_type in [team, player, free, poll] — 투표글 포함(S3).
 */
export function applyBoardFilter<Q extends FeedFilterQuery<Q>>(query: Q, board: FeedBoard): Q {
  if (board.kind === "team") {
    return query.or(buildTeamFeedOrParts(board.teamId, kboIdsForTeamSlug(board.teamId)).join(","));
  }
  if (board.kind === "player") {
    return query.eq("board_type", "player").eq("board_id", board.kboId);
  }
  return query.in("board_type", ["team", "player", "free", "poll"]);
}

/** 피드 공통 select 컬럼(홈 인기글 훅과 공유). */
export const FEED_SELECT =
  "id, author_id, board_type, board_id, content_type, title, content, image_urls, video_urls, like_count, comment_count, created_at, is_hidden, game_id, player_tags, team_tags, hashtags, author_team_id_snapshot, click_view_count, impression_view_count, profiles(nickname, team_id, grade, points, avatar_url)";

export function mapFeedRow(p: Record<string, unknown>): Post {
  const prof = p.profiles as Record<string, unknown> | null;
  const snap = p.author_team_id_snapshot as number | null | undefined;
  return {
    ...(p as unknown as Post),
    content_type: ((p.content_type as string) ?? "general") as "general" | "photo",
    image_urls: (p.image_urls ?? []) as string[],
    video_urls: (p.video_urls ?? []) as string[],
    nickname: prof?.nickname as string | undefined,
    team_id: (snap ?? (prof?.team_id as number | undefined)) as number | undefined,
    grade: prof?.grade as string | undefined,
    avatar_url: prof?.avatar_url as string | undefined,
    points: (prof?.points as number) ?? 0,
    click_view_count: (p.click_view_count as number | null | undefined) ?? 0,
    impression_view_count: (p.impression_view_count as number | null | undefined) ?? 0,
  };
}

function boardKey(board: FeedBoard): string {
  switch (board.kind) {
    case "team":
      return `team:${board.teamId}`;
    case "player":
      return `player:${board.kboId}`;
    case "all":
      return "all";
  }
}

/**
 * 통합 커뮤니티 피드 훅.
 * - content_type 필터 없음 → 글/사진 한 스트림.
 * - 글로벌 serial `id` 기반 keyset 페이징(= created_at 내림차순과 동일 순서).
 * - 보이는 글들의 내 좋아요 상태를 페이지마다 배치 조회해 누적.
 */
/**
 * 피드 복원 옵션. **restorePath 를 준 소비자만** 뒤로가기 복원에 참여한다.
 *
 * 옵션으로 둔 이유: 복원을 쓰지 않는 소비자(과거 홈 '커뮤니티 최신글' 섹션 등)도 이 훅을 쓸 수 있다.
 * 복원을 훅 기본 동작으로 두면 restore 훅이 없는 그 소비자가 뒤로가기 플래그를 대신 소비해
 * 정작 피드는 복원되지 않거나, 반대로 무관한 화면에서 복원 상태가 소모된다.
 */
export type FeedRestoreOptions = {
  /** 이 피드의 라우트 경로(예: `/community/teams/lg`). 뒤로가기 도착지와 대조한다. */
  restorePath: string;
};

export function useUnifiedFeed(
  board: FeedBoard,
  pageSize = 20,
  restore?: FeedRestoreOptions,
) {
  const { user } = useAuth();
  const { blockedIds } = useBlockedIds();
  const [posts, setPosts] = useState<Post[]>([]);
  const [likedIds, setLikedIds] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const key = boardKey(board);
  const cursorRef = useRef<number | null>(null);
  // 동시 페이지 요청 가드 (스크롤 연타 race 방지).
  const fetchingRef = useRef(false);

  const fetchLikedFor = useCallback(
    async (ids: number[]) => {
      if (!user || ids.length === 0) return;
      const { data } = await supabase
        .from("likes")
        .select("post_id")
        .eq("user_id", user.id)
        .in("post_id", ids);
      if (data) {
        setLikedIds((prev) => {
          const next = new Set(prev);
          data.forEach((r: { post_id: number }) => next.add(r.post_id));
          return next;
        });
      }
    },
    [user],
  );

  const loadPage = useCallback(
    async (cursor: number | null): Promise<Post[]> => {
      // query-guard: bounded -- id desc keyset(.lt("id",cursor)) + .limit(pageSize). board_type 목록에
      // 'poll' 추가(S3)는 필터 확장일 뿐 페이지 경계 불변(성장 무한 아님).
      let query = supabase.from("posts").select(FEED_SELECT).neq("is_hidden", true);
      // 태그 기반 조회(V3): 팀탭 = "LG가 태그되거나 LG선수가 태그된 모든 글".
      // team_tags 만 보면 레거시·움짤콜렉터 글(board_type='player'/'team' + board_id, team_tags 빈 값)이
      // 누락되므로 3가지를 OR 로 묶는다:
      //   ① team_tags 에 팀 슬러그 포함 (신규 태그 글)             — jsonb cs.["lg"]
      //   ② 레거시 팀보드 글 (board_type='team' AND board_id=slug)
      //   ③ 레거시/움짤콜렉터 선수보드 글 (board_type='player' AND board_id ∈ 해당 팀 선수 kboId)
      // team_tags 는 JSONB → `cs.["lg"]`(JSON) 형태로 전달(배열 리터럴 `cs.{lg}`는 @> 파싱 에러).
      query = applyBoardFilter(query, board);
      if (cursor !== null) query = query.lt("id", cursor);
      // keyset = id desc 단일 컬럼. id가 BIGSERIAL(삽입=created_at 순 단조증가)이라
      // (created_at,id) 복합 keyset과 동일 순서이면서 tie-break 불필요 → 더 단순·견고. (의도적 선택)
      const { data } = await query.order("id", { ascending: false }).limit(pageSize);
      const rows = (data ?? []).map((r) => mapFeedRow(r as Record<string, unknown>));
      return rows;
    },
    // board는 매 렌더 새 객체라 안정 키(key)로 대체. key가 바뀌면 loadPage 재생성.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, pageSize],
  );

  // 지금까지 로드된 페이지 수 — 뒤로가기 복원 시 같은 분량을 다시 채우기 위해 추적한다.
  // ref 를 함께 두는 이유: 저장은 scroll 핸들러에서 일어나는데 setState 는 비동기라
  // 막 로드된 페이지가 반영되기 전에 저장되면 분량이 적게 복원된다(실측: cards 31 인데 pageCount 2).
  const [pageCount, setPageCount] = useState(1);
  const pageCountRef = useRef(1);
  // 복원 대상 스크롤 위치(뒤로가기로 돌아왔고 저장 상태가 있을 때만 채워짐). 소비형.
  const [pendingScrollY, setPendingScrollY] = useState<number | null>(null);

  // 초기 로드 / 보드 전환.
  // 뒤로가기(popstate)로 돌아온 경우엔 떠날 때 로드돼 있던 페이지 수만큼 이어서 채운 뒤
  // 스크롤을 복원한다. 1페이지만 불러오면 문서가 짧아져 브라우저 스크롤 복원이 잘려버린다.
  const restorePath = restore?.restorePath ?? null;
  // 확정된 복원 의사. auth hydration 등으로 effect 가 재실행돼도 살아남아야 한다.
  const restoreIntentRef = useRef<FeedRestoreIntent | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (restorePath) ensurePopStateListener();
    setLoading(true);
    setPosts([]);
    setLikedIds(new Set());
    cursorRef.current = null;
    setHasMore(true);
    pageCountRef.current = 1;
    setPageCount(1);
    setPendingScrollY(null);

    // 뒤로가기 확정 플래그는 라우트 단위 1회용이라 여기서 소비한다(push 진입이면 false).
    // ⚠️ pop 이 **이 피드 경로로** 도착했을 때만 인정한다. 전역 boolean 으로 두면 무관한 화면에서의
    // 뒤로가기(경기 → 순위 → back)가 남긴 플래그를 그 다음 피드 push 진입이 주워먹는다(삼순 실측).
    //
    // ⚠️⚠️ 소비는 **feed 당 한 번만** 해야 한다. 이 effect 는 dep 에 user?.id 가 있어
    // 로그인 세션의 문서 로드마다 auth hydration(null → user.id)으로 **같은 feed 에서 재실행**된다.
    // 재실행이 1회용 플래그를 다시 소비하려 하면 false 가 되고, 저장값까지 지우면서 첫 복원 load 를
    // cleanup 으로 죽여 원 사고가 그대로 재현된다(삼순 실측 12972 → 1243, cards 31 → 12).
    // 그래서 확정본(intent)을 ref 에 남기고 재실행은 그것을 재사용한다.
    let saved: FeedRestoreState | null = null;
    if (restorePath) {
      const { intent, fresh } = resolveFeedRestoreIntent({
        prev: restoreIntentRef.current,
        feedKey: key,
        consumeBack: () => consumeBackNavigation(restorePath),
        readSaved: () => readFeedRestore(key),
      });
      restoreIntentRef.current = intent;
      saved = intent.state;
      // 복원 대상이 아닌 **최초** 진입(push)에서만 상태를 버린다. 재실행은 아무것도 지우지 않는다.
      // 복원을 쓰지 않는 소비자(홈 최신글)도 남의 상태를 지우면 안 되므로 restorePath 안에서만 한다.
      if (fresh && !saved) clearFeedRestore(key);
    }

    (async () => {
      const rows = await loadPage(null);
      if (cancelled) return;
      let acc = rows;
      let cursor = rows.length ? rows[rows.length - 1].id : null;
      let more = rows.length === pageSize;
      let pages = 1;

      // 저장된 페이지 수까지 순차 복원. 서버 왕복이 늘지만 뒤로가기 1회에 한정된다.
      while (saved && more && pages < saved.pageCount) {
        const next = await loadPage(cursor);
        if (cancelled) return;
        if (!next.length) {
          more = false;
          break;
        }
        const seen = new Set(acc.map((p) => p.id));
        acc = [...acc, ...next.filter((r) => !seen.has(r.id))];
        cursor = next[next.length - 1].id;
        more = next.length === pageSize;
        pages += 1;
      }

      setPosts(acc);
      cursorRef.current = cursor;
      setHasMore(more);
      pageCountRef.current = pages;
      setPageCount(pages);
      setLoading(false);
      fetchLikedFor(acc.map((r) => r.id));
      if (saved) {
        // sessionStorage 는 여기서 비운다(다음 진입에 재사용 금지). 이번 문서 안에서의 재실행은
        // ref 의 intent 로 이어지므로 지워도 복원이 끊기지 않는다.
        clearFeedRestore(key);
        setPendingScrollY(saved.scrollY);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, pageSize, user?.id, restorePath]);

  const loadMore = useCallback(async () => {
    if (fetchingRef.current || !hasMore || loading) return;
    fetchingRef.current = true;
    setLoadingMore(true);
    try {
      const rows = await loadPage(cursorRef.current);
      setPosts((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...rows.filter((r) => !seen.has(r.id))];
      });
      if (rows.length) cursorRef.current = rows[rows.length - 1].id;
      setHasMore(rows.length === pageSize);
      if (rows.length) {
        pageCountRef.current += 1;
        setPageCount(pageCountRef.current);
      }
      fetchLikedFor(rows.map((r) => r.id));
    } finally {
      setLoadingMore(false);
      fetchingRef.current = false;
    }
  }, [hasMore, loading, loadPage, pageSize, fetchLikedFor]);

  const reload = useCallback(async () => {
    setLoading(true);
    cursorRef.current = null;
    const rows = await loadPage(null);
    setPosts(rows);
    cursorRef.current = rows.length ? rows[rows.length - 1].id : null;
    setHasMore(rows.length === pageSize);
    pageCountRef.current = 1;
    setPageCount(1);
    setLikedIds(new Set());
    setLoading(false);
    fetchLikedFor(rows.map((r) => r.id));
  }, [loadPage, pageSize, fetchLikedFor]);

  /** 좋아요 optimistic 토글 — likedIds Set + 해당 post like_count 즉시 반영. */
  const setPostLiked = useCallback((postId: number, liked: boolean) => {
    setLikedIds((prev) => {
      const next = new Set(prev);
      if (liked) next.add(postId);
      else next.delete(postId);
      return next;
    });
    setPosts((prev) =>
      prev.map((p) =>
        p.id === postId
          ? { ...p, like_count: Math.max(0, p.like_count + (liked ? 1 : -1)) }
          : p,
      ),
    );
  }, []);

  return {
    // 차단한 유저의 글은 피드에서 즉시 제외(차단 시 useBlockedIds가 브로드캐스트로 갱신 → 재렌더로 사라짐).
    posts: blockedIds.size ? posts.filter((p) => !blockedIds.has(p.author_id)) : posts,
    likedIds,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    reload,
    setPostLiked,
    /** 피드 식별자 — 복원 상태 저장 키. */
    feedKey: key,
    /** 현재까지 로드된 페이지 수(복원 저장용). */
    pageCount,
    /** 같은 값의 ref — scroll 핸들러처럼 렌더 밖에서 즉시 최신값이 필요한 곳용. */
    pageCountRef,
    /** 복원해야 할 스크롤 위치(1회용). 복원을 수행한 쪽이 consumePendingScroll로 비운다. */
    pendingScrollY,
    consumePendingScroll: useCallback(() => setPendingScrollY(null), []),
  };
}
