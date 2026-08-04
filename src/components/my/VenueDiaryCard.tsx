"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronDown, Play, Plus, RefreshCw, Trophy, Pencil, Trash2 } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { getTeamById } from "@/lib/constants/teams";
import {
  gameResultTone,
  resultToneChipStyle,
  resultToneTextStyle,
} from "@/lib/ui/result-tone";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getSafeSession } from "@/lib/supabase/client";
import type {
  VenueAttendanceSummary,
  VenueDiaryItem,
} from "@/lib/venue-attendance/summary";
import {
  applyDiaryThumbUrlRefresh,
  buildDiaryCountsMap,
  buildDiaryHomeGames,
  diaryCountsOwnerKey,
  diaryCountsReady,
  diaryDisplaySummary,
  diaryWinRateScopeCaption,
  DIARY_WIN_RATE_DEFAULT_SCOPE,
  makeDiaryThumbRefresh,
  mergeDiaryMediaPages,
  mergeDiarySummaryPairs,
  shouldFetchNextDiaryPage,
  startDiaryPendingPoll,
  type DiaryAttendanceInput,
  type DiaryHomeGame,
  type DiaryMediaGroupInput,
  type DiarySummaryPair,
  type DiaryWinRateScope,
} from "@/lib/venue-diary/view";
import {
  mintWithTimeout,
  startVenueStoryUrlRefresh,
  VENUE_STORY_URL_MINT_TIMEOUT_MS,
} from "@/lib/venue-stories/refresh-policy";
import { PENDING_POLL_DELAYS_MS } from "@/lib/venue-stories/composer-helpers";
import VenueDiaryAddGameSheet from "@/components/my/VenueDiaryAddGameSheet";
import VenueDiaryUploader, {
  type DiaryUploadGame,
} from "@/components/my/VenueDiaryUploader";
import VenueDiaryViewer, {
  type DiaryViewerHeader,
} from "@/components/my/VenueDiaryViewer";
import {
  isVenueDiaryManualSeason,
  VENUE_DIARY_MANUAL_SEASONS,
  type VenueDiaryManualSeason,
} from "@/lib/venue-diary/manual-upload";

interface AttendanceResponse {
  season: number;
  /** GPS 인증(story_geofence)만 집계 — 인증 직관수·배지 계약. */
  summary: VenueAttendanceSummary;
  /** 직접 추가 포함 전체 집계 — 승률 표시 기본값. */
  overallSummary?: VenueAttendanceSummary;
  diaryGameCount: number;
  games: VenueDiaryItem[];
}

interface MediaListResponse {
  season: number;
  games: DiaryMediaGroupInput[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** 세그먼트: 최신 시즌 · 직전 시즌 · 전체(두 시즌 합산). */
const CURRENT_SEASON = 2026;
const PREV_SEASON = 2025;
type SeasonKey = typeof CURRENT_SEASON | typeof PREV_SEASON | "all";

function teamShort(team: { id: number; name: string } | null): string {
  if (!team) return "";
  return getTeamById(team.id)?.shortName ?? team.name;
}

function formatGameDate(date: string | null): string {
  if (!date) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Seoul",
  })
    .format(new Date(`${date}T12:00:00+09:00`))
    .replace(/\. /g, ".")
    .replace(/\.$/, "");
}

function matchLabel(game: DiaryHomeGame): string {
  const away = teamShort(game.awayTeam);
  const home = teamShort(game.homeTeam);
  if (!away || !home) return "경기 정보 확인 중";
  const as = game.awayTeam?.score;
  const hs = game.homeTeam?.score;
  if (as != null && hs != null) return `${away} ${as} : ${hs} ${home}`;
  return `${away} vs ${home}`;
}

/**
 * A2 목록(keyset)의 30경기/페이지를 hasMore 동안 cursor로 순차 fetch해 전 페이지를 병합한다.
 * shouldFetchNextDiaryPage 가 무한루프 상한을 강제한다(31번째+ 경기 미노출·N/10 0 오표시 방지).
 */
async function fetchDiaryMediaAllPages(
  token: string,
  season: number,
  signal?: AbortSignal,
): Promise<DiaryMediaGroupInput[] | null> {
  const pages: { games: DiaryMediaGroupInput[] }[] = [];
  let cursor: string | null = null;
  for (let page = 0; ; page += 1) {
    const url = `/api/me/venue-diary/media?season=${season}${
      cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
    }`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as MediaListResponse;
    pages.push({ games: data.games ?? [] });
    if (
      !shouldFetchNextDiaryPage({
        hasMore: data.hasMore === true,
        nextCursor: data.nextCursor ?? null,
        pagesFetched: page + 1,
      })
    ) {
      break;
    }
    cursor = data.nextCursor;
  }
  return mergeDiaryMediaPages(pages);
}

/** 상세 GET(active|archived) 에서 해당 경기 미디어 id 집합을 조회 — pending 영상 승급 확인용. */
async function fetchDiaryGameMediaIds(
  token: string,
  gameId: string,
  signal?: AbortSignal,
): Promise<Set<number> | null> {
  const res = await fetch(
    `/api/me/venue-diary/media?gameId=${encodeURIComponent(gameId)}`,
    { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal },
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { media?: { id: number }[] };
  return new Set((data.media ?? []).map((m) => m.id));
}

async function fetchSeason(
  token: string,
  season: number,
): Promise<{ attendance: AttendanceResponse; mediaGroups: DiaryMediaGroupInput[] } | null> {
  const [aRes, mediaGroups] = await Promise.all([
    fetch(`/api/me/venue-attendance?season=${season}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    }),
    fetchDiaryMediaAllPages(token, season),
  ]);
  if (!aRes.ok || mediaGroups == null) return null;
  return { attendance: await aRes.json(), mediaGroups };
}

export default function VenueDiaryCard() {
  const { user, profile } = useAuth();
  const [season, setSeason] = useState<SeasonKey>(CURRENT_SEASON);
  const [loaded, setLoaded] = useState<{
    key: string;
    summaries: DiarySummaryPair;
    diaryGameCount: number;
    attendanceGames: DiaryAttendanceInput[];
    mediaGroups: DiaryMediaGroupInput[];
  } | null>(null);
  // 승률 표시 범위 — 기본 전체(GPS+직접 추가), 토글로 GPS 인증만. 로컬 상태만(서버 저장 없음).
  const [winScope, setWinScope] = useState<DiaryWinRateScope>(
    DIARY_WIN_RATE_DEFAULT_SCOPE,
  );
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attendanceBusyId, setAttendanceBusyId] = useState<number | null>(null);
  const [attendanceMessage, setAttendanceMessage] = useState<string | null>(null);

  // 경기별 기록 리스트는 세로 공간을 크게 먹어 기본 접힘. 유저가 펼칠 때만 렌더한다.
  const [gamesOpen, setGamesOpen] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  /** null 이 아니면 시트가 '경기 변경' 모드 — 고른 경기로 이 원장 행을 옮긴다. */
  const [moveTarget, setMoveTarget] = useState<{
    attendanceId: number;
    gameId: string;
  } | null>(null);
  const [uploadGame, setUploadGame] = useState<DiaryUploadGame | null>(null);
  const [viewer, setViewer] = useState<{ gameId: string; header: DiaryViewerHeader } | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    const key = `${user.id}:${season}`;
    setLoading(true);
    setFailed(false);
    try {
      const session = await getSafeSession();
      const token = session?.access_token;
      if (!token) throw new Error("missing session");
      const seasons = season === "all" ? [CURRENT_SEASON, PREV_SEASON] : [season];
      const results = await Promise.all(seasons.map((s) => fetchSeason(token, s)));
      if (results.some((r) => r == null)) throw new Error("request failed");
      const ok = results.filter((r): r is NonNullable<typeof r> => r != null);

      const summaries = mergeDiarySummaryPairs(
        ok.map((r) => ({
          certified: r.attendance.summary,
          // 구버전 응답(overallSummary 미포함) 폴백: GPS-only 로 표시(과대집계 방지).
          overall: r.attendance.overallSummary ?? r.attendance.summary,
        })),
      );
      const diaryGameCount = ok.reduce((sum, r) => sum + r.attendance.diaryGameCount, 0);
      const attendanceGames = ok.flatMap((r) =>
        r.attendance.games.map((g) => ({
          id: g.id,
          gameId: g.gameId,
          gameDate: g.date,
          stadiumName: g.stadium,
          source: g.source,
          favoriteTeamId: g.favoriteTeamId,
          result: g.result,
          awayTeam: g.awayTeam,
          homeTeam: g.homeTeam,
        })),
      );
      const mediaGroups = ok.flatMap((r) => r.mediaGroups);
      setLoaded({ key, summaries, diaryGameCount, attendanceGames, mediaGroups });
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [user, season]);

  useEffect(() => {
    if (user) void load();
  }, [load, user]);

  // 영상 pending 은 목록(active|archived)에 아직 없다 → POST 반환 id 를 추적해 archived 승급(terminal)
  // 까지 polling. storyId별 poll 소유권(Map)으로 복수 pending 영상을 동시 추적 — 새 영상이 이전
  // poll 을 cancel 해 앞 영상 늦은 승급이 홈/count 에 미반영되는 단일슬롯 뒤섞임을 막는다(Blocker 3).
  const pendingPollsRef = useRef<Map<number, () => void>>(new Map());
  useEffect(
    () => () => {
      pendingPollsRef.current.forEach((cancel) => cancel());
      pendingPollsRef.current.clear();
    },
    [],
  );

  const handleUploaded = useCallback(
    (result?: {
      id?: number | null;
      gameId?: string;
      mediaType?: string;
      status?: string;
    }) => {
      void load();
      if (
        result?.mediaType === "video" &&
        result?.status === "pending" &&
        result.id != null &&
        result.gameId
      ) {
        const storyId = result.id;
        const gameId = result.gameId;
        // 같은 storyId 재업로드면 그 storyId 의 이전 poll 만 취소(다른 영상 poll 은 유지).
        pendingPollsRef.current.get(storyId)?.();
        const cancel = startDiaryPendingPoll({
          delays: PENDING_POLL_DELAYS_MS,
          probe: async (signal) => {
            const session = await getSafeSession();
            const t = session?.access_token;
            if (!t) return null;
            const ids = await fetchDiaryGameMediaIds(t, gameId, signal);
            return ids == null ? null : { found: ids.has(storyId) };
          },
          onTerminal: (terminal) => {
            pendingPollsRef.current.delete(storyId);
            // archived 승급 감지 즉시 홈·count 갱신(timeout 은 홈 미노출 유지).
            if (terminal === "archived") void load();
          },
          setTimer: (fn, ms) => setTimeout(fn, ms),
          clearTimer: (handle) => clearTimeout(handle),
        });
        pendingPollsRef.current.set(storyId, cancel);
      }
    },
    [load],
  );

  // 홈 목록 썸네일 signed URL(5분 만료) 4분 이내 재발급 — 첫 페이지 refetch 후 thumbUrl 만 교체.
  // A1 검증된 순수 루프(startVenueStoryUrlRefresh)를 그대로 쓰고, loaded key(user:season) 소유권 가드로
  // 전환 후 늦게 도착한 응답은 반영하지 않는다(late apply 0).
  const loadedKey = loaded?.key ?? null;
  const loadedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    loadedKeyRef.current = loadedKey;
  }, [loadedKey]);
  const thumbRefreshedRef = useRef<number | null>(null);
  const thumbLastRefreshAtRef = useRef(0);
  useEffect(() => {
    if (!loadedKey || !user) return;
    const seasons = season === "all" ? [CURRENT_SEASON, PREV_SEASON] : [season];
    const token = 1;
    // 초기 load 가 이미 fresh URL 을 주므로 즉시 재발급하지 않고 4분 후부터.
    thumbRefreshedRef.current = token;
    thumbLastRefreshAtRef.current = Date.now();
    return startVenueStoryUrlRefresh({
      storyId: token,
      isCurrentStory: () => loadedKeyRef.current === loadedKey,
      // getSafeSession/fetch 가 non-settle 이면 inFlight 가 영구 고정되므로 전체 mint 를
      // mintWithTimeout(8s, loop controller)로 감싸 반드시 settle→retry 된다(Blocker 1).
      // 전페이지(fetchDiaryMediaAllPages)를 재발급해 31번째+ 썸네일도 갱신한다(Blocker 2).
      refresh: makeDiaryThumbRefresh({
        seasons,
        getToken: async () => (await getSafeSession())?.access_token ?? null,
        fetchAllPages: fetchDiaryMediaAllPages,
        isCurrent: () => loadedKeyRef.current === loadedKey,
        apply: (fresh) =>
          setLoaded((prev) =>
            prev && prev.key === loadedKey
              ? { ...prev, mediaGroups: applyDiaryThumbUrlRefresh(prev.mediaGroups, fresh) }
              : prev,
          ),
        timers: {
          setTimer: (fn, ms) => setTimeout(fn, ms),
          clearTimer: (handle) => clearTimeout(handle),
        },
      }),
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle),
      getPreviousStoryId: () => thumbRefreshedRef.current,
      setPreviousStoryId: (v) => {
        thumbRefreshedRef.current = v;
      },
      getLastRefreshAt: () => thumbLastRefreshAtRef.current,
      setLastRefreshAt: (v) => {
        thumbLastRefreshAtRef.current = v;
      },
    });
  }, [loadedKey, user, season]);

  const homeGames = useMemo(
    () =>
      loaded
        ? buildDiaryHomeGames({
            mediaGroups: loaded.mediaGroups,
            attendanceGames: loaded.attendanceGames,
          })
        : [],
    [loaded],
  );

  // AddGameSheet 시즌은 시트가 아니라 카드가 소유한다 — counts 를 같은 시즌으로 맞춰야 하기 때문.
  // 카드 상단 세그먼트는 "전체"를 포함하지만 직접 추가는 단일 시즌만 가능하므로,
  // "전체" 탭에서 열면 최신 시즌을 기본값으로 쓴다.
  const [addSeason, setAddSeason] = useState<VenueDiaryManualSeason>(
    VENUE_DIARY_MANUAL_SEASONS[0],
  );
  // 선택 시즌 counts 를 그 시즌으로 별도 fetch 한다. 다른 시즌 counts 를 쓰면 기존 10/10 경기가
  // 0/10 으로 오표시되어 상한을 뚚는다(Blocker 4). 확정 전에는 fail-closed(선택 비활성),
  // 실패 시 0 폴백 금지→재시도. open/user/시즌 전환마다 stale counts 를 초기화한다.
  const [addCounts, setAddCounts] = useState<Map<string, number>>(new Map());
  const [addAttendanceGameIds, setAddAttendanceGameIds] = useState<Set<string>>(new Set());
  // countsOwner = 이 counts 가 어느 (userId, openSeq, season) 에 대한 것인지. 렌더 단계에서
  // 현재 key 와 불일치하면 즉시 fail-closed(diaryCountsReady) → 재오픈·유저·시즌 전환 첫 렌더의
  // stale counts 를 차단.
  const [countsOwner, setCountsOwner] = useState<string | null>(null);
  const [countsError, setCountsError] = useState(false);
  const [countsReload, setCountsReload] = useState(0);
  const [openSeq, setOpenSeq] = useState(0);
  const currentCountsKey =
    user && addOpen
      ? diaryCountsOwnerKey(user.id, openSeq, addSeason)
      : null;
  const countsReady = diaryCountsReady(countsOwner, currentCountsKey);
  // 열기 액션에서 counts state 를 동기 초기화한 뒤 open → 같은 커밋에 배칭돼 첫 렌더부터 fail-closed.
  const openAddSheet = useCallback(() => {
    setMoveTarget(null);
    setAddCounts(new Map());
    setAddAttendanceGameIds(new Set());
    setCountsOwner(null);
    setCountsError(false);
    // 시즌 탭이 단일 시즌이면 그 시즌으로, "전체"면 최신 시즌으로 시트를 연다.
    setAddSeason(
      season !== "all" && isVenueDiaryManualSeason(season)
        ? season
        : VENUE_DIARY_MANUAL_SEASONS[0],
    );
    setOpenSeq((s) => s + 1);
    setAddOpen(true);
  }, [season]);
  /** 직접 등록 기록의 경기 자체를 바꾼다 — 같은 경기 선택 시트를 move 모드로 연다. */
  const openMoveSheet = useCallback((game: DiaryHomeGame) => {
    if (game.attendanceId == null || game.attendanceSource !== "diary_manual") return;
    setMoveTarget({ attendanceId: game.attendanceId, gameId: game.gameId });
    setAddCounts(new Map());
    setAddAttendanceGameIds(new Set());
    setCountsOwner(null);
    setCountsError(false);
    // 시즌 탭이 단일 시즌이면 그 시즌으로, "전체"면 최신 시즌으로 시트를 열어 맥락을 이어준다.
    setAddSeason(
      season !== "all" && isVenueDiaryManualSeason(season)
        ? season
        : VENUE_DIARY_MANUAL_SEASONS[0],
    );
    setOpenSeq((s) => s + 1);
    setAddOpen(true);
  }, [season]);
  // 시트 안에서 시즌을 바꿔도 즉시 fail-closed 로 떨어지도록 counts 를 동기 초기화한다.
  const handleAddSeasonChange = useCallback(
    (next: VenueDiaryManualSeason) => {
      setAddSeason((prev) => {
        if (prev === next) return prev;
        setAddCounts(new Map());
        setAddAttendanceGameIds(new Set());
        setCountsOwner(null);
        setCountsError(false);
        return next;
      });
    },
    [],
  );
  useEffect(() => {
    if (!addOpen || !user) return;
    const ownerKey = diaryCountsOwnerKey(user.id, openSeq, addSeason);
    let alive = true;
    const controller = new AbortController();
    setAddCounts(new Map());
    setAddAttendanceGameIds(new Set());
    setCountsOwner(null);
    setCountsError(false);
    (async () => {
      // getSafeSession/fetch/json 이 non-settle 이어도 mintWithTimeout 이 8s 에 abort→settle 시켜
      // '확인 중' 영구정지 대신 countsError(재시도 UI)로 도달한다.
      const result = await mintWithTimeout<{
        groups: DiaryMediaGroupInput[];
        attendanceIds: string[];
      } | null, number>(
        async (signal) => {
          const session = await getSafeSession();
          const token = session?.access_token;
          if (!token) throw new Error("missing session");
          const [groups, attendanceRes] = await Promise.all([
            fetchDiaryMediaAllPages(token, addSeason, signal),
            fetch(`/api/me/venue-attendance?season=${addSeason}`, {
              headers: { Authorization: `Bearer ${token}` },
              cache: "no-store",
              signal,
            }),
          ]);
          if (groups == null || !attendanceRes.ok) return null;
          const attendance = (await attendanceRes.json()) as AttendanceResponse;
          return { groups, attendanceIds: attendance.games.map((game) => game.gameId) };
        },
        null,
        {
          timeoutMs: VENUE_STORY_URL_MINT_TIMEOUT_MS,
          setTimer: (fn, ms) => window.setTimeout(fn, ms),
          clearTimer: (h) => window.clearTimeout(h),
          controller,
        },
      );
      if (!alive || controller.signal.aborted) return;
      if (result == null) {
        setCountsError(true);
        return;
      }
      setAddCounts(buildDiaryCountsMap(result.groups));
      setAddAttendanceGameIds(new Set(result.attendanceIds));
      setCountsOwner(ownerKey);
    })();
    return () => {
      alive = false;
      controller.abort();
    };
  }, [addOpen, user, openSeq, countsReload, addSeason]);

  const favoriteTeamId = profile?.team_id ?? null;

  const requestAttendanceMutation = useCallback(
    async (input: {
      method: "POST" | "PATCH" | "DELETE";
      id?: number;
      body?: Record<string, unknown>;
      successMessage: string;
    }) => {
      setAttendanceBusyId(input.id ?? -1);
      setAttendanceMessage(null);
      try {
        const session = await getSafeSession();
        const token = session?.access_token;
        if (!token) throw new Error("로그인이 필요해요");
        const res = await fetch(
          input.id == null
            ? "/api/me/venue-attendance"
            : `/api/me/venue-attendance/${input.id}`,
          {
            method: input.method,
            headers: {
              Authorization: `Bearer ${token}`,
              ...(input.body ? { "Content-Type": "application/json" } : {}),
            },
            body: input.body ? JSON.stringify(input.body) : undefined,
            cache: "no-store",
          },
        );
        const data = (await res.json()) as { error?: string };
        if (!res.ok) throw new Error(data.error ?? "직관 기록 변경 실패");
        setAttendanceMessage(input.successMessage);
        await load();
        return true;
      } catch (error) {
        setAttendanceMessage(error instanceof Error ? error.message : "직관 기록 변경 실패");
        return false;
      } finally {
        setAttendanceBusyId(null);
      }
    },
    [load],
  );

  const deleteAttendance = useCallback(
    async (game: DiaryHomeGame) => {
      if (game.attendanceId == null) return;
      const kind = game.attendanceSource === "story_geofence" ? "GPS 인증 기록" : "직접 등록 기록";
      if (!window.confirm(`${kind}을 통계에서 삭제할까요? 사진·영상은 그대로 남아요.`)) return;
      await requestAttendanceMutation({
        method: "DELETE",
        id: game.attendanceId,
        successMessage: "직관 기록을 삭제했어요. 통계에 바로 반영됐습니다.",
      });
    },
    [requestAttendanceMutation],
  );

  const switchManualTeam = useCallback(
    async (game: DiaryHomeGame) => {
      if (game.attendanceId == null || game.attendanceSource !== "diary_manual") return;
      const candidates = [game.awayTeam, game.homeTeam].filter(
        (team): team is NonNullable<typeof team> => team != null,
      );
      const next = candidates.find((team) => team.id !== game.favoriteTeamId);
      if (!next) return;
      const label = getTeamById(next.id)?.shortName ?? next.name;
      if (!window.confirm(`응원팀을 ${label}(으)로 변경할까요?`)) return;
      await requestAttendanceMutation({
        method: "PATCH",
        id: game.attendanceId,
        body: { favoriteTeamId: next.id },
        successMessage: "응원팀을 수정했어요. 통계에 바로 반영됐습니다.",
      });
    },
    [requestAttendanceMutation],
  );

  if (!user) return null;

  const data = loaded?.key === `${user.id}:${season}` ? loaded : null;
  const summaries = data?.summaries;
  // 승률·승/패/무는 토글 범위, 인증 직관수는 항상 GPS 인증(certified)만.
  const shown = summaries ? diaryDisplaySummary(summaries, winScope) : null;

  return (
    <>
      <GlassCard className="mt-3 !p-0 overflow-hidden">
        <div className="p-5">
          <div className="flex items-center gap-2">
            <CalendarDays size={19} className="text-accent" />
            <h2 className="text-lg font-bold text-text-primary">직관 다이어리</h2>
          </div>
          <p className="mt-1 text-xs text-text-tertiary">내가 직관한 경기의 기록과 사진·영상</p>

          {/* 나만 보기 안내(1회) */}
          <div className="mt-3 flex items-start gap-1.5 rounded-xl border border-blue-500/25 bg-blue-500/10 px-3 py-2 text-[12px] font-semibold text-blue-700 dark:text-blue-300">
            <span className="shrink-0">🔒</span>
            <span className="leading-snug">
              사진·영상은 나만 볼 수 있고, 공개 피드에는 올라가지 않아요.
            </span>
          </div>

          {/* 시즌 세그먼트 */}
          <div className="mt-3 flex gap-1.5 rounded-xl bg-bg-tertiary p-1">
            {([CURRENT_SEASON, PREV_SEASON, "all"] as const).map((key) => (
              <button
                key={String(key)}
                onClick={() => setSeason(key)}
                className={`flex-1 rounded-lg py-2 text-[13px] font-bold ${
                  season === key
                    ? "bg-accent text-white"
                    : "text-neutral-600 dark:text-neutral-300"
                }`}
              >
                {key === "all" ? "전체" : key}
              </button>
            ))}
          </div>

          {loading && !data ? (
            <div className="mt-4 h-32 animate-pulse rounded-2xl bg-bg-tertiary" />
          ) : failed && !data ? (
            <button
              type="button"
              onClick={() => void load()}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-bg-tertiary py-4 text-sm text-text-secondary"
            >
              <RefreshCw size={15} /> 기록을 불러오지 못했어요 · 다시 시도
            </button>
          ) : data && summaries && shown ? (
            <>
              {/* 직관 요약 카드 — 3열(인증 직관 / 승률 / 다이어리) + 승·패·무 보조줄.
                  승률·승패는 토글 범위(기본 전체), 인증 직관수는 항상 GPS 인증만. */}
              <div className="mt-3.5 rounded-2xl border border-[#33202a] bg-gradient-to-br from-[#20141b] to-[#141417] p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-[11px] font-extrabold text-emerald-400">
                    ✓ GPS 인증 직관
                  </span>
                  {/* 승률 범위 토글: 전체 포함(기본) ↔ GPS 인증만 */}
                  <div className="flex rounded-full bg-white/10 p-0.5">
                    {(
                      [
                        { key: "all", label: "전체 포함" },
                        { key: "gps", label: "GPS 인증만" },
                      ] as const
                    ).map(({ key, label }) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setWinScope(key)}
                        className={`rounded-full px-2.5 py-1 text-[11px] font-extrabold ${
                          winScope === key ? "bg-accent text-white" : "text-white/60"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="mt-3.5 grid grid-cols-3 gap-2">
                  <div className="min-w-0">
                    <p className="whitespace-nowrap text-[21px] font-extrabold tracking-tight text-white min-[390px]:text-2xl">
                      {summaries.certified.attendanceCount}
                    </p>
                    <p className="mt-0.5 text-[11px] font-semibold text-white/55">인증 직관</p>
                  </div>
                  <div className="min-w-0">
                    <p className="whitespace-nowrap text-[21px] font-extrabold tracking-tight text-amber-400 min-[390px]:text-2xl">
                      {shown.winRate == null ? "–" : `${(shown.winRate * 100).toFixed(1)}%`}
                    </p>
                    <p className="mt-0.5 text-[11px] font-semibold text-white/55">승률</p>
                  </div>
                  <div className="min-w-0">
                    <p className="whitespace-nowrap text-[21px] font-extrabold tracking-tight text-white min-[390px]:text-2xl">
                      {data.diaryGameCount}경기
                    </p>
                    <p className="mt-0.5 text-[11px] font-semibold text-white/55">다이어리</p>
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between gap-2 border-t border-[#2c1f27] pt-3">
                  <div className="flex gap-3 text-[13px] font-bold">
                    <span style={resultToneTextStyle("positive")}>{shown.wins}승</span>
                    <span style={resultToneTextStyle("negative")}>{shown.losses}패</span>
                    <span style={resultToneTextStyle("neutral")}>{shown.draws}무</span>
                  </div>
                  <span className="shrink-0 whitespace-nowrap text-[11px] text-white/55">
                    {diaryWinRateScopeCaption(winScope)}
                  </span>
                </div>
              </div>

              {/* 지난 경기 추가하기 */}
              <button
                onClick={openAddSheet}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl bg-accent py-3.5 text-[14.5px] font-extrabold text-white shadow-lg shadow-accent/30"
              >
                <Plus size={18} /> 지난 경기 추가하기
              </button>
              {attendanceMessage && (
                <p className="mt-2 rounded-xl bg-bg-tertiary px-3 py-2 text-center text-xs font-semibold text-text-secondary">
                  {attendanceMessage}
                </p>
              )}
            </>
          ) : null}
        </div>

        {/* 경기별 기록 */}
        {data && (
          <div className="px-5 pb-5">
            <button
              type="button"
              onClick={() => setGamesOpen((v) => !v)}
              aria-expanded={gamesOpen}
              className="mb-2 mt-1 flex min-h-[44px] w-full items-center justify-between gap-2 rounded-2xl border border-border bg-bg-tertiary px-4 py-3 text-left active:opacity-90"
            >
              <span className="text-[13px] font-extrabold text-text-secondary">
                경기별 기록
                <span className="ml-1.5 font-bold text-text-tertiary">{homeGames.length}</span>
              </span>
              <ChevronDown
                size={18}
                className={`shrink-0 text-text-tertiary transition-transform ${gamesOpen ? "rotate-180" : ""}`}
              />
            </button>
            {!gamesOpen ? null : homeGames.length === 0 ? (
              <div className="rounded-2xl border border-border py-8 text-center">
                <Trophy size={22} className="mx-auto text-text-tertiary" />
                <p className="mt-2 text-sm font-medium text-text-secondary">아직 기록이 없어요</p>
                <p className="mt-1 text-xs text-text-tertiary">
                  직관 스토리를 올리거나 지난 경기를 추가해보세요
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {homeGames.map((game) => (
                  <div
                    key={game.gameId}
                    className="rounded-2xl border border-border bg-bg-tertiary p-3"
                  >
                    <button
                      type="button"
                      disabled={game.total === 0}
                      onClick={() =>
                        setViewer({
                          gameId: game.gameId,
                          header: {
                            matchLabel: matchLabel(game),
                            dateLabel: `${formatGameDate(game.gameDate)}${game.stadiumName ? ` · ${game.stadiumName}` : ""}`,
                            result: game.result,
                          },
                        })
                      }
                      className="w-full text-left enabled:active:opacity-90"
                    >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[11.5px] font-bold text-text-tertiary">
                          {formatGameDate(game.gameDate)}
                          {game.stadiumName ? ` · ${game.stadiumName}` : ""}
                        </p>
                        <p className="mt-0.5 flex items-center gap-1.5 text-[15px] font-extrabold text-text-primary">
                          {matchLabel(game)}
                          <span
                            className={`rounded-md px-1.5 py-0.5 text-[10.5px] font-extrabold ${
                              game.label.kind === "gps"
                                ? "bg-emerald-500/15 text-emerald-400"
                                : "bg-white/10 text-text-secondary"
                            }`}
                          >
                            {game.label.text}
                          </span>
                        </p>
                      </div>
                      {game.result && (
                        <span
                          className="shrink-0 rounded-lg px-2 py-0.5 text-[11px] font-extrabold"
                          style={resultToneChipStyle(gameResultTone(game.result))}
                        >
                          {game.result === "W" ? "승" : game.result === "L" ? "패" : "무"}
                        </span>
                      )}
                    </div>

                    {game.thumbnails.length > 0 && (
                      <div className="mt-3 grid grid-cols-4 gap-1.5">
                        {game.thumbnails.map((t) => (
                          <div
                            key={t.id}
                            className="relative aspect-square overflow-hidden rounded-lg bg-bg-secondary"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={t.thumbUrl} alt="" className="h-full w-full object-cover" />
                            {t.mediaType === "video" && (
                              <span className="absolute inset-0 flex items-center justify-center text-white">
                                <Play size={14} fill="currentColor" />
                              </span>
                            )}
                          </div>
                        ))}
                        {game.extraCount > 0 && (
                          <div className="flex aspect-square items-center justify-center rounded-lg bg-bg-secondary text-sm font-extrabold text-text-secondary">
                            +{game.extraCount}
                          </div>
                        )}
                      </div>
                    )}
                    </button>
                    {game.attendanceId != null && (
                      <div className="mt-2.5 flex items-center justify-end gap-2 border-t border-border pt-2.5">
                        {game.attendanceSource === "diary_manual" && (
                          <button
                            type="button"
                            disabled={attendanceBusyId != null}
                            onClick={() => openMoveSheet(game)}
                            className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-bold text-text-secondary disabled:opacity-50"
                          >
                            <CalendarDays size={11} /> 경기 변경
                          </button>
                        )}
                        {game.attendanceSource === "diary_manual" &&
                          game.awayTeam != null &&
                          game.homeTeam != null && (
                            <button
                              type="button"
                              disabled={attendanceBusyId != null}
                              onClick={() => void switchManualTeam(game)}
                              className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-bold text-text-secondary disabled:opacity-50"
                            >
                              <Pencil size={11} /> 응원팀 변경
                            </button>
                          )}
                        <button
                          type="button"
                          disabled={attendanceBusyId != null}
                          onClick={() => void deleteAttendance(game)}
                          className="inline-flex items-center gap-1 rounded-lg border border-red-500/30 px-2.5 py-1.5 text-[11px] font-bold text-red-400 disabled:opacity-50"
                        >
                          <Trash2 size={11} /> 기록 삭제
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </GlassCard>

      <VenueDiaryAddGameSheet
        isOpen={addOpen}
        favoriteTeamId={favoriteTeamId}
        season={addSeason}
        onSeasonChange={handleAddSeasonChange}
        countsByGame={addCounts}
        countsReady={countsReady}
        countsError={countsError}
        activeAttendanceGameIds={addAttendanceGameIds}
        moveMode={moveTarget != null}
        moveFromGameId={moveTarget?.gameId ?? null}
        onRetryCounts={() => setCountsReload((n) => n + 1)}
        onBack={() => setAddOpen(false)}
        onClose={() => setAddOpen(false)}
        onPick={(game) => {
          setAddOpen(false);
          setUploadGame(game);
        }}
        onRecord={(game, selectedTeamId) => {
          const target = moveTarget;
          setAddOpen(false);
          setMoveTarget(null);
          // move 모드면 같은 원장 행을 새 경기로 옮긴다(새 행 생성 아님).
          void requestAttendanceMutation(
            target
              ? {
                  method: "PATCH",
                  id: target.attendanceId,
                  body: { gameId: game.gameId, favoriteTeamId: selectedTeamId },
                  successMessage: "경기를 변경했어요. 통계에 바로 반영됐습니다.",
                }
              : {
                  method: "POST",
                  body: { gameId: game.gameId, favoriteTeamId: selectedTeamId },
                  successMessage: "직관 기록을 추가했어요. 통계에 바로 반영됐습니다.",
                },
          ).then((ok) => {
            if (ok) {
              setAddAttendanceGameIds((prev) => {
                const next = new Set(prev).add(game.gameId);
                if (target) next.delete(target.gameId);
                return next;
              });
            }
          });
        }}
      />

      {uploadGame && (
        <VenueDiaryUploader
          game={uploadGame}
          isOpen={uploadGame != null}
          onBack={() => {
            setUploadGame(null);
            openAddSheet();
          }}
          onClose={() => setUploadGame(null)}
          onUploaded={handleUploaded}
        />
      )}

      {viewer && (
        <VenueDiaryViewer
          gameId={viewer.gameId}
          header={viewer.header}
          isOpen={viewer != null}
          onClose={() => setViewer(null)}
          onChanged={() => void load()}
        />
      )}
    </>
  );
}
