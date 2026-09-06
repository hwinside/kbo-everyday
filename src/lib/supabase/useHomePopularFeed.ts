"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./client";
import { useBlockedIds } from "./useBlock";
import type { Post } from "./usePosts";
import { FEED_SELECT, mapFeedRow } from "./useUnifiedFeed";
import { getTeamBySlug, isAllStarTeamId } from "@/lib/constants/teams";
import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";

/** 인기글 집계 창(일). 하린아빠 스펙 2026-09-05: 최근 일주일 인기글. */
export const POPULAR_WINDOW_DAYS = 7;

/** 한 페이지 조회 시간 상한. 넘기면 abort → 오류로 처리(첫 페이지: 섹션 숨김·reload 가능, 더보기: 버튼 유지·재시도). */
export const POPULAR_FETCH_TIMEOUT_MS = 10_000;

/** 홈 인기글이 바라보는 보드 — 최애팀 단독 또는 전체(최애팀 미선택). 선수 보드는 홈에서 쓰지 않는다. */
export type HomePopularBoard = { kind: "team"; teamId: string } | { kind: "all" };

/** 집계 창 시작 시각(ISO). 페이지 간 창이 흔들리지 않도록 마운트 시 1회 고정해 쓴다. */
export function popularWindowStart(now: number = Date.now()): string {
  return new Date(now - POPULAR_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * 최애팀 **단독** 판정의 서버 입력 — 다른 팀 선수의 kboId 목록(올스타 제외).
 *
 * 배지 SSOT(resolvePostScope)는 선수 태그 'kboId:이름' 에서 ID 로 팀을 찾고, 로스터에 없는 ID·올스타는 무시한다.
 * RPC 도 같은 판정을 하려면 "허용 목록(최애팀 로스터)" 이 아니라 **"거부 목록(타팀 로스터)"** 을 넘겨야 한다 —
 * 허용 목록이면 은퇴·미등록 ID 가 섞인 글이 SSOT 와 달리 탈락한다(삼순 #1343 5차 ③ 경계).
 * 이름은 비교하지 않으므로 이름 뒤 공백·표기 차이도 SSOT 와 같이 무시된다.
 */
export function otherTeamsKboIds(slug: string): string[] {
  const teamId = getTeamBySlug(slug)?.id;
  if (teamId == null) return [];
  return (PLAYERS_ROSTER as { kboId: string; teamId: number }[])
    .filter((p) => p.teamId !== teamId && !isAllStarTeamId(p.teamId))
    .map((p) => String(p.kboId));
}

/** 한 페이지 결과 — 서버가 노출 조건을 전부 걸렀으므로 rows 가 곧 화면 글이다. */
export type PopularPage = { rows: Post[]; hasMore: boolean };

/** RPC 인자(순수 함수 — 게이트가 직접 검증). */
export function homePopularRpcArgs(
  board: HomePopularBoard,
  since: string,
  want: number,
  blocked: ReadonlyArray<string>,
  exclude: ReadonlyArray<number>,
) {
  return {
    p_since: since,
    p_limit: want + 1,
    p_team_slug: board.kind === "team" ? board.teamId : null,
    p_other_kbo_ids: board.kind === "team" ? otherTeamsKboIds(board.teamId) : [],
    p_blocked: [...blocked],
    p_exclude: [...exclude],
  };
}

/**
 * 홈 '커뮤니티 인기글' 훅 — 최근 7일 글을 인기도(하트+댓글) 순으로, `initialSize` 개 먼저 보여주고
 * `loadMore()` 마다 `stepSize` 개씩 이어 붙인다(5 → 20 → 35 …). 창 안 글이 소진되면 hasMore=false.
 * 뒤로가기 복원·좋아요 상태는 홈 섹션이 쓰지 않으므로 useUnifiedFeed 대신 얇게 분리했다.
 */
export function useHomePopularFeed(board: HomePopularBoard, initialSize: number, stepSize: number) {
  const { blockedIds } = useBlockedIds();
  return useHomePopularFeedCore(board, initialSize, stepSize, blockedIds);
}

/**
 * 차단 목록을 주입받는 코어(회귀 게이트가 AuthProvider 없이 직접 마운트한다).
 *
 * 설계 A(하린아빠 2026-09-05 15:16, 삼순 #1343 4·5차): **페이지당 RPC 1회, 정확히 5/15개, 정확 소진.**
 *  - 노출 조건(최애팀 단독·타팀 선수 태그·차단·이미 표시된 글)은 전부 `home_popular_posts` RPC(SQL)가 판정한다.
 *  - 다음 페이지 = "화면에 없는 글 중 인기도 최상위 want 개". 인기도 커서가 없으므로 페이지 사이에 순위가
 *    올라간 글도 다음 페이지에 나오고(누락 0), 내려간 글도 다시 나오지 않는다(중복 0)(삼순 5차 ①).
 *  - 소진: `want + 1` 행을 읽어 마지막 1행이 있으면 hasMore. 정확히 5·20·35건이면 즉시 false.
 *  - 응답 세대(genRef): 팀 전환·reload·언마운트마다 +1 하고 **진행 중 요청을 abort** 한다. 옛 응답은 어떤 상태도 못 건드린다.
 *  - 시간 상한: 요청마다 AbortController + timeout. 무응답이어도 잠금이 영구히 남지 않는다(삼순 5차 ②).
 *  - 오류(abort 포함): 첫 페이지는 빈 목록(섹션 숨김·reload 로 재시도), 더보기는 상태 보존(버튼 유지·재시도).
 */
export function useHomePopularFeedCore(
  board: HomePopularBoard,
  initialSize: number,
  stepSize: number,
  blockedIds: ReadonlySet<string>,
  options: { timeoutMs?: number } = {},
) {
  const timeoutMs = options.timeoutMs ?? POPULAR_FETCH_TIMEOUT_MS;
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const key = board.kind === "team" ? `team:${board.teamId}` : "all";
  // 차단 목록은 Set 참조가 매 refresh 바뀌므로 내용 서명으로 안정화 — 내용이 바뀔 때만 첫 페이지를 다시 읽는다.
  const blockedSig = useMemo(() => Array.from(blockedIds).sort().join(","), [blockedIds]);
  const blockedRef = useRef(blockedIds);
  blockedRef.current = blockedIds;

  const fetchingRef = useRef(false);
  // 응답 세대. loadFirst/reload 마다 +1. 요청이 시작될 때의 세대와 다르면 그 응답은 버린다.
  const genRef = useRef(0);
  // 진행 중 요청의 AbortController — 세대 교체·언마운트 때 전부 abort.
  const inflightRef = useRef<Set<AbortController>>(new Set());
  // 창 시작은 페이지 사이에서 고정 — 매 페이지 now() 를 다시 잡으면 경계 글이 빠진다.
  const windowStartRef = useRef<string>(popularWindowStart());

  const abortInflight = useCallback(() => {
    for (const c of inflightRef.current) c.abort();
    inflightRef.current.clear();
  }, []);

  const fetchPage = useCallback(
    async (want: number, exclude: ReadonlyArray<number>): Promise<PopularPage> => {
      const controller = new AbortController();
      inflightRef.current.add(controller);
      // Supabase 2.98.0+ calls getSession() before HTTP — controller.abort() alone only cancels the
      // HTTP layer. Promise.race with an independent timeout catches auth/pre-HTTP hangs too.
      let timerId: ReturnType<typeof setTimeout>;
      const timeoutRace = new Promise<never>((_, reject) => {
        timerId = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error("PopularFetchTimeout"), { name: "AbortError" }));
        }, timeoutMs);
      });
      try {
        // query-guard: bounded -- RPC 내부 limit(want+1, 상한 100) + created_at 7일 창.
        const { data, error } = await Promise.race([
          supabase
            .rpc("home_popular_posts", homePopularRpcArgs(board, windowStartRef.current, want, Array.from(blockedRef.current), exclude))
            // popularity 는 홈 인기글만 쓰는 생성 컬럼 — 공통 FEED_SELECT 에 넣으면 마이그레이션 전 preview 에서
            // 커뮤니티 피드 전체가 400 으로 죽는다. 이 훅에서만 추가 select 한다.
            .select(`${FEED_SELECT}, popularity`)
            .abortSignal(controller.signal),
          timeoutRace,
        ]);
        // 조회 오류(abort·timeout 포함)는 소진이 아니다 — throw 해서 호출자가 상태를 보존하게 한다(삼순 #1343 ②).
        if (error) throw error;
        // rpc().select() 의 타입은 행/배열 union 으로 추론된다 — setof 함수라 항상 배열이다.
        const fetched = ((data ?? []) as unknown as Record<string, unknown>[]).map((r) => mapFeedRow(r));
        return { rows: fetched.slice(0, want), hasMore: fetched.length > want };
      } finally {
        clearTimeout(timerId!);
        inflightRef.current.delete(controller);
      }
    },
    // board 는 매 렌더 새 객체라 안정 키(key)로 대체.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, timeoutMs],
  );

  /** 첫 페이지. 세대를 올리고 진행 중이던 초기 조회·더보기 요청을 abort 해 전부 무효화한다. */
  const loadFirst = useCallback(async () => {
    const gen = ++genRef.current;
    abortInflight();
    // 새 세대는 옛 더보기 잠금과 무관하게 시작한다(삼순 #1343 3차 ②) — 옛 요청의 finally 는 세대가 다르면 잠금을 건드리지 않는다.
    fetchingRef.current = false;
    setLoadingMore(false);
    setLoading(true);
    windowStartRef.current = popularWindowStart();
    let page: PopularPage;
    try {
      page = await fetchPage(initialSize, []);
    } catch {
      if (gen !== genRef.current) return;
      // 첫 조회 실패/시간 초과: 섹션은 비우되 hasMore 는 남겨 pull-to-refresh(reload)가 다시 시도할 수 있게 한다.
      setPosts([]);
      setLoading(false);
      return;
    }
    if (gen !== genRef.current) return; // 옛 세대 응답 폐기(삼순 #1343 ①)
    setPosts(page.rows);
    setHasMore(page.hasMore);
    setLoading(false);
  }, [fetchPage, initialSize, abortInflight]);

  // blockedSig: 차단 목록 내용이 바뀌면(로그인 직후 늦게 도착 포함) 서버 필터가 바뀌므로 첫 페이지를 다시 읽는다.
  useEffect(() => {
    const gen = genRef;
    void loadFirst();
    return () => {
      // 언마운트·키 교체 시 진행 중 요청 abort + 응답 무효화.
      gen.current++;
      abortInflight();
    };
  }, [loadFirst, blockedSig, abortInflight]);

  const loadMore = useCallback(async () => {
    if (fetchingRef.current || !hasMore || loading) return;
    const gen = genRef.current;
    fetchingRef.current = true;
    setLoadingMore(true);
    try {
      // 다음 페이지 = 화면에 없는 글 중 인기도 최상위. 화면 id 는 서버 제외 목록으로(순위 이동 무관, 삼순 5차 ①).
      const page = await fetchPage(stepSize, posts.map((p) => p.id));
      if (gen !== genRef.current) return; // 팀 전환·새로고침이 끼어들었다 → 옛 더보기 응답 폐기(삼순 #1343 ①)
      setPosts((prev) => [...prev, ...page.rows]);
      setHasMore(page.hasMore);
    } catch {
      // 조회 실패/시간 초과: 목록·hasMore 그대로 → 버튼이 남아 재시도할 수 있다(삼순 #1343 ②).
    } finally {
      // 옛 세대의 완료(abort 포함)가 새 세대의 잠금을 풀거나 잠그지 않는다(삼순 #1343 3차 ②).
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
