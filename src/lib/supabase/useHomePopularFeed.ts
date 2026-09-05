"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./client";
import { useBlockedIds } from "./useBlock";
import type { Post } from "./usePosts";
import { applyBoardFilter, FEED_SELECT, mapFeedRow, type FeedBoard } from "./useUnifiedFeed";
import { kboIdsForTeamSlug, playerNameForKboId } from "@/lib/utils/player-roster";

/** 인기글 집계 창(일). 하린아빠 스펙 2026-09-05: 최근 일주일 인기글. */
export const POPULAR_WINDOW_DAYS = 7;

/** 인기도 keyset 커서 — (popularity desc, id desc) 순서의 마지막 행. */
export type PopularCursor = { popularity: number; id: number };

/** 집계 창 시작 시각(ISO). 페이지 간 창이 흔들리지 않도록 마운트 시 1회 고정해 쓴다. */
export function popularWindowStart(now: number = Date.now()): string {
  return new Date(now - POPULAR_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * (popularity desc, id desc) keyset 의 "커서 다음" 조건을 PostgREST `or=` 문자열로.
 *   popularity < c.popularity  OR  (popularity = c.popularity AND id < c.id)
 * 보드 필터도 `.or()` 를 쓰지만 PostgREST 는 `or=` 파라미터 여러 개를 AND 로 묶으므로 충돌 없음.
 */
export function popularCursorFilter(c: PopularCursor): string {
  return `popularity.lt.${c.popularity},and(popularity.eq.${c.popularity},id.lt.${c.id})`;
}

/**
 * 최애팀 **단독** 공개 글의 team_tags 값 — PostgREST jsonb `eq` 비교용 (`team_tags=eq.["lg"]`).
 *
 * 하린아빠 스펙 2026-09-05: "공개범위가 최애팀까지 포함인 건 제외하고 only 최애팀인 것만".
 * 팀 피드의 `cs`(포함) 필터는 전체구단 공개(10팀)·다팀 글까지 잡으므로 홈 인기글엔 쓰지 않는다.
 * 실측(prod 9/5, LG 7일): cs 294건 = 10팀 261 + 2~9팀 17 + LG 단독 16.
 * 레거시 무태그 글은 고려하지 않는다 — 2026-08-07 DB 트리거 이후 모든 글이 canonical 태그 1개 이상이라
 * 7일 창 안에는 존재할 수 없다.
 */
export function teamOnlyTagsValue(slug: string): string {
  return JSON.stringify([slug]);
}

/**
 * 최애팀 단독 판정의 나머지 반쪽 — 선수 태그가 **전부 최애팀 로스터**여야 한다(PostgREST jsonb `cd`, contained-by).
 * team_tags 가 [최애팀] 이어도 다른 팀 선수 태그가 섞이면 배지 SSOT(resolvePostScope)는 2팀으로 뜬다.
 * 그 경우를 클라이언트에서 걸러내면 페이지가 부분 채움되므로(삼순 #1343 4차, 하린아빠 A 선택) 서버에서 거른다.
 *
 * 값 = 로스터의 `kboId:이름` 태그 전체(쓰기 화면 formatPlayerTag 와 같은 형식). 빈 배열([])은 `cd` 에 항상 포함된다.
 * 실측(prod 9/5, LG 단독 378건): 타팀 선수 태그 0 · 로스터 이름 불일치 0 · player_tags null 0 → 이 필터로 유실 0.
 */
export function teamOnlyPlayerTagsValue(slug: string): string {
  return JSON.stringify(kboIdsForTeamSlug(slug).map((kboId) => `${kboId}:${playerNameForKboId(kboId) ?? ""}`));
}

/** PostgREST `not.in.(…)` 값. 문자열(uuid)은 큰따옴표로 감싼다. */
export function notInListValue(values: ReadonlyArray<string | number>): string {
  return `(${values.map((v) => (typeof v === "number" ? String(v) : `"${v}"`)).join(",")})`;
}

/** 행 → 커서. 생성 컬럼이 select 에 없거나 null 이면(마이그레이션 전) 카운터 합으로 대체. */
export function cursorOf(post: Post): PopularCursor {
  const popularity = post.popularity ?? (post.like_count ?? 0) + (post.comment_count ?? 0);
  return { popularity, id: post.id };
}

/** 한 페이지 결과 — 서버가 이미 노출 조건을 전부 걸렀으므로 rows 가 곧 화면 글이다. */
export type PopularPage = { rows: Post[]; hasMore: boolean };

/**
 * 홈 '커뮤니티 인기글' 훅 — 최근 7일 글을 인기도(하트+댓글) 순으로, `initialSize` 개 먼저 보여주고
 * `loadMore()` 마다 `stepSize` 개씩 이어 붙인다(5 → 20 → 35 …). 창 안 글이 소진되면 hasMore=false.
 * 뒤로가기 복원·좋아요 상태는 홈 섹션이 쓰지 않으므로 useUnifiedFeed 대신 얇게 분리했다.
 */
export function useHomePopularFeed(board: FeedBoard, initialSize: number, stepSize: number) {
  const { blockedIds } = useBlockedIds();
  return useHomePopularFeedCore(board, initialSize, stepSize, blockedIds);
}

/**
 * 차단 목록을 주입받는 코어(회귀 게이트가 AuthProvider 없이 직접 마운트한다).
 *
 * 설계 A(하린아빠 2026-09-05 15:16 선택, 삼순 #1343 4차): **페이지당 서버 조회 1회, 정확히 5/15개, 정확 소진.**
 * 노출 조건은 전부 서버 필터로 건다 — 클라이언트에서 걸러내는 행이 없으므로 부분 채움·보충 조회·무한 보충이 없다.
 *  - 최애팀 단독: team_tags = [최애팀] AND player_tags ⊆ 최애팀 로스터 태그(`cd`)
 *  - 차단 작성자: author_id not.in (차단 목록) — 목록이 늦게 도착하면 첫 페이지를 다시 읽는다
 *  - 순위 이동 재등장: id not.in (화면에 있는 id) — 더보기에서만
 *  - 소진: `want + 1` 행을 읽어 마지막 1행이 있으면 hasMore. 정확히 5·20·35건이면 즉시 false
 *  - 응답 세대(genRef): 팀 전환·reload·언마운트마다 +1, 옛 응답은 posts/cursor/hasMore/loading 을 못 건드린다
 *  - 오류: throw 로 올려 cursor/hasMore 보존(버튼 유지·같은 커서로 재시도)
 */
export function useHomePopularFeedCore(
  board: FeedBoard,
  initialSize: number,
  stepSize: number,
  blockedIds: ReadonlySet<string>,
) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const key = board.kind === "team" ? `team:${board.teamId}` : board.kind === "player" ? `player:${board.kboId}` : "all";
  // 차단 목록은 Set 참조가 매 refresh 바뀌므로 내용 서명으로 안정화 — 내용이 바뀔 때만 첫 페이지를 다시 읽는다.
  const blockedSig = useMemo(() => Array.from(blockedIds).sort().join(","), [blockedIds]);
  const blockedRef = useRef(blockedIds);
  blockedRef.current = blockedIds;

  const cursorRef = useRef<PopularCursor | null>(null);
  const fetchingRef = useRef(false);
  // 응답 세대. loadFirst/reload 마다 +1. 요청이 시작될 때의 세대와 다르면 그 응답은 버린다.
  const genRef = useRef(0);
  // 창 시작은 페이지 사이에서 고정 — 매 페이지 now() 를 다시 잡으면 경계 글이 빠지며 keyset 이 어긋난다.
  const windowStartRef = useRef<string>(popularWindowStart());

  const fetchPage = useCallback(
    async (cursor: PopularCursor | null, want: number, seenIds: ReadonlyArray<number>): Promise<PopularPage> => {
      // query-guard: bounded -- (popularity,id) keyset + .limit(want+1) + created_at 7일 창.
      let query = supabase
        .from("posts")
        // popularity 는 홈 인기글만 쓰는 생성 컬럼 — 공통 FEED_SELECT 에 넣으면 마이그레이션 전 preview 에서
        // 커뮤니티 피드 전체가 400 으로 죽는다. 이 훅에서만 추가 select 한다.
        .select(`${FEED_SELECT}, popularity`)
        .neq("is_hidden", true)
        .gte("created_at", windowStartRef.current);
      if (board.kind === "team") {
        // 최애팀 **단독** 공개 글만: team_tags 가 정확히 [최애팀] AND 선수 태그가 전부 최애팀 로스터.
        // 팀 피드의 포함(cs) 필터인 applyBoardFilter 는 전체구단 공개·다팀 글까지 잡아 스펙과 어긋난다.
        query = query
          .filter("team_tags", "eq", teamOnlyTagsValue(board.teamId))
          .filter("player_tags", "cd", teamOnlyPlayerTagsValue(board.teamId));
      } else {
        query = applyBoardFilter(query, board);
      }
      const blocked = Array.from(blockedRef.current);
      if (blocked.length) query = query.not("author_id", "in", notInListValue(blocked));
      if (seenIds.length) query = query.not("id", "in", notInListValue(seenIds));
      if (cursor) query = query.or(popularCursorFilter(cursor));
      const { data, error } = await query
        .order("popularity", { ascending: false })
        .order("id", { ascending: false })
        .limit(want + 1);
      // 조회 오류는 소진이 아니다 — throw 해서 호출자가 커서/hasMore 를 보존하게 한다(삼순 #1343 ②).
      if (error) throw error;
      const fetched = (data ?? []).map((r) => mapFeedRow(r as Record<string, unknown>));
      return { rows: fetched.slice(0, want), hasMore: fetched.length > want };
    },
    // board 는 매 렌더 새 객체라 안정 키(key)로 대체.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  /** 첫 페이지. 세대를 올려 진행 중이던 초기 조회·더보기 응답을 전부 무효화한다. */
  const loadFirst = useCallback(async () => {
    const gen = ++genRef.current;
    // 새 세대는 옛 더보기 잠금과 무관하게 시작한다(삼순 #1343 3차 ②) — 옛 요청의 finally 는 세대가 다르면 잠금을 건드리지 않는다.
    fetchingRef.current = false;
    setLoadingMore(false);
    setLoading(true);
    windowStartRef.current = popularWindowStart();
    let page: PopularPage;
    try {
      page = await fetchPage(null, initialSize, []);
    } catch {
      if (gen !== genRef.current) return;
      // 첫 조회 실패: 섹션은 비우되 hasMore 는 남겨 pull-to-refresh(reload)가 다시 시도할 수 있게 한다.
      cursorRef.current = null;
      setPosts([]);
      setLoading(false);
      return;
    }
    if (gen !== genRef.current) return; // 옛 세대 응답 폐기(삼순 #1343 ①)
    cursorRef.current = page.rows.length ? cursorOf(page.rows[page.rows.length - 1]) : null;
    setPosts(page.rows);
    setHasMore(page.hasMore);
    setLoading(false);
  }, [fetchPage, initialSize]);

  // blockedSig: 차단 목록 내용이 바뀌면(로그인 직후 늦게 도착 포함) 서버 필터를 바꿔 첫 페이지를 다시 읽는다.
  useEffect(() => {
    const gen = genRef;
    void loadFirst();
    return () => {
      // 언마운트·키 교체 시 진행 중 응답 무효화.
      gen.current++;
    };
  }, [loadFirst, blockedSig]);

  const loadMore = useCallback(async () => {
    if (fetchingRef.current || !hasMore || loading) return;
    const gen = genRef.current;
    fetchingRef.current = true;
    setLoadingMore(true);
    try {
      // 인기도는 실시간으로 바뀌므로 페이지 사이에 순위가 내려간 글이 커서 뒤에 재등장할 수 있다 → 화면 id 는 서버에서 제외.
      const page = await fetchPage(cursorRef.current, stepSize, posts.map((p) => p.id));
      if (gen !== genRef.current) return; // 팀 전환·새로고침이 끼어들었다 → 옛 더보기 응답 폐기(삼순 #1343 ①)
      if (page.rows.length) cursorRef.current = cursorOf(page.rows[page.rows.length - 1]);
      setPosts((prev) => [...prev, ...page.rows]);
      setHasMore(page.hasMore);
    } catch {
      // 조회 실패: cursor/hasMore 그대로 → 버튼이 남아 재시도할 수 있다(삼순 #1343 ②).
    } finally {
      // 옛 세대의 완료가 새 세대의 잠금을 풀거나 잠그지 않는다(삼순 #1343 3차 ②).
      if (gen === genRef.current) {
        fetchingRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [hasMore, loading, posts, fetchPage, stepSize]);

  return {
    posts,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    reload: loadFirst,
  };
}
