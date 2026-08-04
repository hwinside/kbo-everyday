"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { LazyMotion, domAnimation, m, AnimatePresence } from "framer-motion";
import { ChevronRight, MessageCircle } from "lucide-react";
import Link from "next/link";
import PullToRefresh from "@/components/PullToRefresh";
import GlassCard from "@/components/ui/GlassCard";
import OnboardingFlow from "@/components/onboarding/OnboardingFlow";
import PlayerSelectModal from "@/components/onboarding/PlayerSelectModal";
import LoginSheet from "@/components/auth/LoginSheet";
import AppDownloadBanner from "@/components/ui/AppDownloadBanner";
import { TEAMS, getTeamById, isAllStarGameId } from "@/lib/constants/teams";
import { useLiveGame, type LiveGameData } from "@/lib/hooks/useLiveGame";
import { getTeamBorderColorById } from "@/lib/utils/team-border-color";
import { getTeamBgColorById, getTeamColor } from "@/lib/utils/team";
import { useHomeInit, type HomeGame } from "@/hooks/useHomeInit";
import { useUnreadDMCount } from "@/lib/supabase/useUnreadDMCount";
import { useHomeSectionsPref, useHomeSectionsOrder } from "@/hooks/useHomeSectionsPref";
import { useNewsPhotoFilter } from "@/hooks/useNewsPhotoFilter";
import { isPhotoArticle } from "@/lib/news-relevance";
import type { HomeSectionKey } from "@/lib/store/home-sections-pref";
import { setWidgetFavPlayers, setWidgetMyTeam, updateGameWidget } from "@/lib/capacitor/game-notification";
import { writeHomeWidgetSnapshot, type HomeWidgetGame } from "@/lib/native-live-activity";
import { latestRelayLine } from "@/lib/notifications/relay-line";
import HeaderAvatar from "@/components/home/HeaderAvatar";
import OutageNoticeBanner from "@/components/home/OutageNoticeBanner";
import MyTeamHero from "@/components/home/MyTeamHero";
import AllStarGameCard from "@/components/home/AllStarGameCard";
import TeamCard from "@/components/home/TeamCard";
import FavoritePlayersSection from "@/components/home/FavoritePlayersSection";
import TodayGamesSection from "@/components/home/TodayGamesSection";
import LiveGameBanner from "@/components/home/LiveGameBanner";
import AIAnalysis from "@/components/game/AIAnalysis";
import GeniusLaunchPopup from "@/components/home/GeniusLaunchPopup";

// Lazy load heavy sections
import { lazy, Suspense } from "react";
const NewsCarousel = lazy(() => import("@/components/news/NewsCarousel"));
const HomeHighlights = lazy(() => import("@/components/home/HomeHighlights"));
const WhatsNewCard = lazy(() => import("@/components/home/WhatsNewCard"));
const CommunityLatestPosts = lazy(() => import("@/components/home/CommunityLatestPosts"));

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06 } },
};

const item = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35 } },
};

function SectionSkeleton({ height = 120 }: { height?: number }) {
  return (
    <div className="animate-pulse rounded-2xl bg-bg-secondary" style={{ height }} />
  );
}

/** KST 기준 경기 시간대(11~24시)인지 확인 */
function isGameTimeKST(): boolean {
  const kstHour = (new Date().getUTCHours() + 9) % 24;
  return kstHour >= 11;
}

const ID_TO_KBO_CODE: Record<number, string> = {
  1: "LG",
  2: "OB",
  3: "KT",
  4: "SK",
  5: "NC",
  6: "HT",
  7: "LT",
  8: "SS",
  9: "HH",
  10: "WO",
};

interface ApiGameData {
  gameId: string;
  awayTeamId: number;
  homeTeamId: number;
  time: string;
  stadium: string;
  awayScore?: number | null;
  homeScore?: number | null;
  status: HomeGame["status"];
  inning?: number | string | null;
  isTop?: boolean;
  awayStarterName?: string | null;
  homeStarterName?: string | null;
  winPitcher?: string | null;
  losePitcher?: string | null;
  broadcastChannels?: HomeGame["broadcastChannels"];
}

type MyTeamHeroGame = HomeGame & {
  balls: number;
  strikes: number;
  outs: number;
  runner1b: boolean;
  runner2b: boolean;
  runner3b: boolean;
  currentBatter: string | null;
  currentPitcher: string | null;
  isTop: boolean;
  dateLabel?: string | null;
  dateISO?: string;
};

type WidgetGame = HomeGame & {
  balls?: number;
  strikes?: number;
  outs?: number;
  runner1b?: boolean;
  runner2b?: boolean;
  runner3b?: boolean;
  currentBatter?: string | null;
  currentPitcher?: string | null;
  isTop?: boolean;
  dateISO?: string; // 예정 경기 날짜(YYYY-MM-DD) — 위젯에 '6월 7일 (토)' 표기용
};

function formatKSTDateOffset(offsetDays: number): string {
  const base = new Date(Date.now() + 9 * 60 * 60 * 1000);
  base.setUTCDate(base.getUTCDate() + offsetDays);
  return base.toISOString().slice(0, 10);
}

// 'YYYY-MM-DD' → '6월 7일 (토)'. 숫자 요일은 해당 날짜(UTC 자정 기준)로 계산.
function formatKoreanDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return "";
  const wd = ["일", "월", "화", "수", "목", "금", "토"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}월 ${d}일 (${wd})`;
}

function formatApiDate(date: string): string {
  return date.replace(/-/g, "");
}

function mapApiGame(g: ApiGameData): HomeGame {
  return {
    id: g.gameId,
    homeTeamId: g.homeTeamId,
    awayTeamId: g.awayTeamId,
    time: g.time,
    stadium: g.stadium,
    homeScore: g.homeScore ?? 0,
    awayScore: g.awayScore ?? 0,
    status: g.status,
    inning: g.status === "live" && g.inning ? `${g.inning}회${g.isTop ? "초" : "말"}` : null,
    awayStarterName: g.awayStarterName ?? null,
    homeStarterName: g.homeStarterName ?? null,
    winPitcher: g.winPitcher ?? null,
    losePitcher: g.losePitcher ?? null,
    broadcastChannels: g.broadcastChannels,
  };
}

function findWidgetGame(games: HomeGame[], myTeamId: number): HomeGame | undefined {
  return games.find((g) =>
    (g.homeTeamId === myTeamId || g.awayTeamId === myTeamId) &&
    (g.status === "live" || g.status === "scheduled")
  );
}

interface HomeClientShellProps {
  initialGames: HomeGame[];
  initialLiveGames: LiveGameData[];
  initialIsPreseason: boolean;
}

export default function HomeClientShell({ initialGames, initialLiveGames, initialIsPreseason }: HomeClientShellProps) {
  const router = useRouter();
  const unreadDMCount = useUnreadDMCount();
  const [aiGame, setAiGame] = useState<{awayTeamId: number; homeTeamId: number; gameId: string} | null>(null);
  const [showLogin, setShowLogin] = useState(false);
  const [nextWidgetGame, setNextWidgetGame] = useState<WidgetGame | null>(null);
  // iOS 홈 위젯 06:00 자동 전환 타깃 — 현재 위젯 경기가 종료/라이브일 때의 다음 예정 경기.
  const [rolloverNextGame, setRolloverNextGame] = useState<WidgetGame | null>(null);
  // 자정~06:00 동안 노출할 전날 경기(종료). 야구 '하루'=06시 경계.
  const [overnightGame, setOvernightGame] = useState<WidgetGame | null>(null);
  const lastRefreshAtRef = useRef(0);
  // Pull-to-refresh 트리거. 증가하면 클라이언트 페치 섹션(팀카드/커뮤니티/숏츠/최애선수/오늘경기)이 재조회한다.
  const [refreshNonce, setRefreshNonce] = useState(0);

  const {
    user, profile,
    myTeamId, favPlayers,
    showOnboarding, showPlayerSelect, setShowPlayerSelect,
    showPlayerSetupCTA, setShowPlayerSetupCTA,
    welcomeToast,
    todayGames, isPreseason,
    handleOnboardingComplete, handlePlayerSelect,
  } = useHomeInit({ initialGames, initialIsPreseason, refreshNonce });

  // 홈 섹션 표시 여부 (마이페이지 토글, 기기 로컬)
  const sections = useHomeSectionsPref();
  // 홈 섹션 순서 (마이페이지 드래그, 기기 로컬). 팀카드는 배열 밖 최상단 고정.
  const sectionOrder = useHomeSectionsOrder();

  // 사진기사 필터(마이페이지 토글). on이면 포토·화보 위주 기사를 뉴스 카드에서 숨김.
  const photoFilterOn = useNewsPhotoFilter();

  // useHomeNews — lazy import to avoid SSR issues
  const [realNews, setRealNews] = useState<{ id: number; title: string; link: string; pubDate: string; label: string; source: string; sourceUrl: string; ogUrl: string; thumbnailUrl: null; timeAgo: string; teamId: number | null; type: "news" }[]>([]);
  useEffect(() => {
    if (myTeamId === null) return;
    import("@/hooks/useHomeNews").then(({ fetchHomeNews }) => {
      fetchHomeNews(myTeamId).then(setRealNews);
    });
  }, [myTeamId]);

  // 라이브 데이터: 경기시간대만 폴링, 비경기시간은 서버 초기 데이터만 사용
  const gameTime = isGameTimeKST();
  const { games: polledGames, liveGames: polledLiveGames } = useLiveGame(
    undefined,
    gameTime ? 10000 : 0 // 0이면 폴링 안 함
  );
  // 서버 초기 → 클라이언트 폴링으로 점진 교체
  const liveGames = polledLiveGames.length > 0 ? polledLiveGames :
    initialLiveGames.filter(g => g.isLive);

  // Pull-to-refresh: 홈 데이터 갱신.
  // 홈의 실제 카드(팀카드 순위/주간기록/순위그래프, 커뮤니티/숏츠/최애선수, 오늘경기)는
  // 각 컴포넌트 내부 useEffect로 클라이언트 페치하며 mount 시 1회만 돈다.
  // router.refresh()만으로는 그 클라이언트 상태가 갱신되지 않아 "내려도 새로고침 안 됨" 체감.
  // → refreshNonce를 증가시켜 각 섹션 페치 effect를 재실행시킨다.
  const handleRefresh = useCallback(async () => {
    lastRefreshAtRef.current = Date.now();
    // 1) 서버 컴포넌트 revalidation (오늘 경기/라이브 서버 prop)
    router.refresh();
    // 2) 클라이언트 페치 섹션 재조회 트리거
    setRefreshNonce((n) => n + 1);
    // 3) 뉴스 refetch + 스피너가 눈에 보이도록 최소 노출 시간 확보
    const newsRefetch = (async () => {
      if (myTeamId === null) return;
      try {
        const { fetchHomeNews } = await import("@/hooks/useHomeNews");
        const news = await fetchHomeNews(myTeamId);
        setRealNews(news);
      } catch { /* news refresh 실패해도 무시 */ }
    })();
    await Promise.all([
      newsRefetch,
      new Promise((res) => setTimeout(res, 500)),
    ]);
  }, [router, myTeamId]);

  useEffect(() => {
    const maybeRefresh = () => {
      const now = Date.now();
      if (now - lastRefreshAtRef.current < 60_000) return;
      lastRefreshAtRef.current = now;
      router.refresh();
    };

    if (gameTime) {
      maybeRefresh();
    }

    const onFocus = () => maybeRefresh();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") maybeRefresh();
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [router, gameTime]);

  const myTeam = myTeamId ? getTeamById(myTeamId) : null;
  const myTeamGameBase = todayGames.find(g => g.homeTeamId === myTeamId || g.awayTeamId === myTeamId);
  const allLiveData = polledGames.length > 0 ? polledGames :
    (initialLiveGames as LiveGameData[]);
  const myTeamLive = myTeamGameBase ? allLiveData.find(g => g.gameId === myTeamGameBase.id) : undefined;
  const myTeamGame = useMemo<MyTeamHeroGame | undefined>(() => {
    if (!myTeamGameBase) return undefined;
    return {
      ...myTeamGameBase,
      balls: myTeamLive?.balls ?? 0,
      strikes: myTeamLive?.strikes ?? 0,
      outs: myTeamLive?.outs ?? 0,
      runner1b: myTeamLive?.runner1b ?? false,
      runner2b: myTeamLive?.runner2b ?? false,
      runner3b: myTeamLive?.runner3b ?? false,
      currentBatter: myTeamLive?.currentBatter ?? null,
      currentPitcher: myTeamLive?.currentPitcher ?? null,
      isTop: myTeamLive?.isTop ?? true,
      ...(myTeamLive ? {
        homeScore: myTeamLive.homeScore,
        awayScore: myTeamLive.awayScore,
        status: myTeamLive.status ?? (myTeamLive.isLive ? "live" as const : myTeamGameBase.status),
        inning: (myTeamLive.status ?? (myTeamLive.isLive ? "live" : myTeamGameBase.status)) === "live" ? (myTeamLive.currentInning || null) : null,
      } : {}),
    };
  }, [myTeamGameBase, myTeamLive]);
  // 1분마다 현재 시각 갱신 → 홈을 켜둔 채 06:00을 넘겨도 경기카드가 자동 전환됨.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const isOvernight = ((new Date(nowMs).getUTCHours() + 9) % 24) < 6;

  // 위젯 write 소스 = 홈 팀카드(embeddedGame)와 *동일한 06시-resolved 경기 선택자*:
  //  · 자정~06:00(isOvernight): 전날 종료 경기 유지(overnightGame)
  //  · 06:00~: 오늘 경기(종료 당일=결과) 우선, 없으면 다음 예정경기
  // 라이브 디테일(투수/타자/주자)은 그대로 유지 — embeddedGame과 달리 coerce하지 않는다.
  const widgetGame = useMemo<WidgetGame | undefined>(() => {
    if (isOvernight && overnightGame) return overnightGame;
    if (myTeamGame) return myTeamGame;
    return nextWidgetGame ?? undefined;
  }, [myTeamGame, nextWidgetGame, overnightGame, isOvernight]);

  // 팀카드 임베드 경기카드용 — 06시 경계.
  //  · 자정~06:00(isOvernight): 전날 종료 경기 유지(overnightGame)
  //  · 06:00~: 오늘 경기(종료 당일=결과) 우선, 없으면 다음 예정경기
  const embeddedGame = useMemo<MyTeamHeroGame | undefined>(() => {
    const coerce = (g: WidgetGame): MyTeamHeroGame => ({
      ...g,
      balls: 0, strikes: 0, outs: 0,
      runner1b: false, runner2b: false, runner3b: false,
      currentBatter: null, currentPitcher: null, isTop: true,
    });
    // 예정 경기엔 날짜 라벨('7월 12일 (일)') 부착 — 오늘 예정 경기는 dateISO가 없으므로 오늘로 폴백(위젯과 동일 규칙).
    const withDateLabel = (g: MyTeamHeroGame, dateISO?: string): MyTeamHeroGame => {
      const resolvedDate = dateISO ?? formatKSTDateOffset(0);
      return g.status === "scheduled"
        ? { ...g, dateISO: resolvedDate, dateLabel: formatKoreanDate(resolvedDate) }
        : g;
    };
    if (isOvernight && overnightGame) return coerce(overnightGame);
    if (myTeamGame) return withDateLabel(myTeamGame);
    if (nextWidgetGame) return withDateLabel(coerce(nextWidgetGame), nextWidgetGame.dateISO);
    return undefined;
  }, [myTeamGame, nextWidgetGame, overnightGame, isOvernight]);

  // 자정~06:00에만 전날 경기 조회. 06:00 넘어가면 isOvernight=false → 비우고 재계산.
  useEffect(() => {
    if (!isOvernight || !myTeamId) { setOvernightGame(null); return; }
    const teamId = myTeamId;
    let cancelled = false;
    const yday = formatKSTDateOffset(-1);
    fetch(`/api/games?date=${formatApiDate(yday)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        const games = ((d.games ?? []) as ApiGameData[]).map(mapApiGame);
        const g = games.find((x) => (x.homeTeamId === teamId || x.awayTeamId === teamId) && x.status !== "scheduled");
        if (g) setOvernightGame({ ...g, dateISO: yday });
      })
      .catch(() => { /* 전날 경기 조회 실패는 무시 */ });
    return () => { cancelled = true; };
  }, [myTeamId, isOvernight]);

  useEffect(() => {
    if (!myTeamId) {
      setNextWidgetGame(null);
      return;
    }
    const teamId = myTeamId;

    // 오늘 최애팀 경기가 있으면(상태 무관) 그 경기를 표시하므로 미래 경기 탐색 불필요.
    const hasTodayGame = todayGames.some(
      (g) => g.homeTeamId === teamId || g.awayTeamId === teamId,
    );
    if (hasTodayGame) {
      setNextWidgetGame(null);
      return;
    }

    let cancelled = false;

    async function loadNextGame() {
      for (let offset = 1; offset <= 14; offset += 1) {
        const date = formatKSTDateOffset(offset);
        try {
          const res = await fetch(`/api/games?date=${formatApiDate(date)}`);
          if (!res.ok) continue;
          const data = await res.json();
          const games = ((data.games ?? []) as ApiGameData[]).map(mapApiGame);
          const candidate = findWidgetGame(games, teamId);
          if (candidate) {
            // 미래 예정 경기는 날짜(YYYY-MM-DD)를 함께 실어 위젯에 '6월 7일 (토)' 표기.
            if (!cancelled) setNextWidgetGame({ ...candidate, dateISO: date });
            return;
          }
        } catch {
          // 후보 조회 실패는 위젯 fallback만 건너뛴다.
        }
      }
      if (!cancelled) setNextWidgetGame(null);
    }

    void loadNextGame();
    const interval = window.setInterval(loadNextGame, 5 * 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [myTeamId, todayGames]);

  // 최애선수 목록 → 네이티브 prefs 동기화(선수 카드 위젯 config 선택 목록)
  useEffect(() => {
    void setWidgetFavPlayers(favPlayers);
  }, [favPlayers]);

  useEffect(() => {
    if (!myTeamId) return;
    const myTeamCode = ID_TO_KBO_CODE[myTeamId];
    if (!myTeamCode) return;

    void setWidgetMyTeam(myTeamCode);
    if (!widgetGame) return;

    const awayCode = ID_TO_KBO_CODE[widgetGame.awayTeamId];
    const homeCode = ID_TO_KBO_CODE[widgetGame.homeTeamId];
    if (!awayCode || !homeCode) return;

    const isScheduled = widgetGame.status === "scheduled";
    const isFinal = widgetGame.status === "final";
    const isCancelled = widgetGame.status === "cancelled";
    // 라이브 행(투수/타자/아웃/주자)은 라이브 경기에만 표시. 예정/종료/취소는 숨김.
    const hideLive = isScheduled || isFinal || isCancelled;
    // 이닝 라벨 항상 "N회초/말"로 재구성 — inning이 숫자(라이브 폴 갭 시 base 게임의
    // 원시 숫자로 떨어짐)거나 "회" 없는 문자열일 때 bare "LIVE 3"으로 새던 버그 차단.
    const inn = widgetGame.inning;
    const half = widgetGame.isTop ? "초" : "말";
    const inningLabel =
      typeof inn === "number" ? `${inn}회${half}`
      : typeof inn === "string" && inn ? (inn.includes("회") ? inn : `${inn}회${half}`)
      : "";
    // 예정 경기는 날짜를 status에 함께 인코딩(SCHEDULED|시간|날짜라벨) — 위젯이 '6월 7일 (토)' 표기.
    // 오늘 예정 경기는 dateISO가 없으므로 오늘 날짜로 폴백. 경기장(잠실)은 별도 stadium 필드.
    const dateLabel = isScheduled
      ? formatKoreanDate(widgetGame.dateISO ?? formatKSTDateOffset(0))
      : "";
    const status = isScheduled
      ? `SCHEDULED|${widgetGame.time}|${dateLabel}`
      : widgetGame.status === "live"
        ? `LIVE ${inningLabel}`.trim()
        : isFinal
          ? "FINAL"
          : widgetGame.status === "cancelled"
            ? "CANCELLED"
            : "";
    if (!status) return;

    const batterTeam = widgetGame.isTop ? awayCode : homeCode;
    const pitcherTeam = widgetGame.isTop ? homeCode : awayCode;
    // 안드 위젯 06:00 자동 전환 타깃 — 오늘 경기/전날 결과를 쓸 때(=rolloverNextGame 세팅됨)
    // 상태 무관(예정 포함) 다음 예정 경기 첨부. 예정 경기가 백그라운드서 종료로 바뀌어도
    // same-gameId next 보존으로 06:00 롤오버가 유지된다(삼순 ①).
    const androidNext =
      rolloverNextGame
        ? {
            away: ID_TO_KBO_CODE[rolloverNextGame.awayTeamId] ?? "",
            home: ID_TO_KBO_CODE[rolloverNextGame.homeTeamId] ?? "",
            stadium: rolloverNextGame.stadium ?? "",
            time: rolloverNextGame.time,
            date: formatKoreanDate(rolloverNextGame.dateISO ?? formatKSTDateOffset(1)),
            astarter: rolloverNextGame.awayStarterName ?? "",
            hstarter: rolloverNextGame.homeStarterName ?? "",
          }
        : undefined;
    void updateGameWidget({
      myTeam: myTeamCode,
      away: awayCode,
      home: homeCode,
      awayScore: String(widgetGame.awayScore ?? 0),
      homeScore: String(widgetGame.homeScore ?? 0),
      status,
      gameId: widgetGame.id,
      next: androidNext,
      // 예정/종료 경기는 라이브 정보가 없으므로 전부 비워 라이브 행 자체를 숨긴다
      // (빈 다이아몬드 + "O ○○○"가 미시작/종료 경기에 떠서 완성도 떨어져 보이던 문제).
      pitcher: hideLive ? "" : (widgetGame.currentPitcher ?? ""),
      pitcherTeam: !hideLive && widgetGame.currentPitcher ? pitcherTeam : "",
      batter: hideLive ? "" : (widgetGame.currentBatter ?? ""),
      batterTeam: !hideLive && widgetGame.currentBatter ? batterTeam : "",
      outs: hideLive ? "" : (widgetGame.outs === undefined ? "" : String(Math.min(Math.max(widgetGame.outs, 0), 2))),
      diamond: hideLive ? "000" : `${widgetGame.runner1b ? 1 : 0}${widgetGame.runner2b ? 1 : 0}${widgetGame.runner3b ? 1 : 0}`,
      stadium: widgetGame.stadium ?? "",
      // 예고선발 — 예정 경기에서만 표기(라이브/종료는 실투수를 라이브 행에 표시).
      awayStarter: isScheduled ? (widgetGame.awayStarterName ?? "") : "",
      homeStarter: isScheduled ? (widgetGame.homeStarterName ?? "") : "",
    });
  }, [myTeamId, widgetGame, rolloverNextGame]);

  // 홈 위젯 06:00 자동 전환 타깃 로드 — 현재 위젯이 '오늘 경기' 또는 '자정~06시 전날 결과'를
  // 보여줄 때(=rolloverBase), 그 경기의 *다음 예정 경기*를 미리 캐시해 스냅샷에 함께 싣는다.
  // 예정(경기 전) 상태에서 앱을 마지막으로 열고 백그라운드에 둔 흔한 경로에서도 next가 저장돼,
  // 그 경기가 백그라운드에서 종료로 바뀐 뒤 다음날 06:00에 다음 경기로 자동 전환된다(삼순 ①).
  // 위젯이 이미 미래 예정 경기를 보여주는 중이면(rolloverBase 없음) 롤오버 불필요.
  const rolloverBase = (isOvernight && overnightGame) ? overnightGame : myTeamGame;
  useEffect(() => {
    if (!myTeamId || !rolloverBase) {
      setRolloverNextGame(null);
      return;
    }
    const teamId = myTeamId;
    const excludeId = rolloverBase.id;
    let cancelled = false;
    (async () => {
      // offset 0(오늘)부터 스캔 — 전날 결과(overnight) 표시 중엔 오늘 경기가 곧 다음 예정이다.
      for (let offset = 0; offset <= 14; offset += 1) {
        const date = formatKSTDateOffset(offset);
        try {
          const res = await fetch(`/api/games?date=${formatApiDate(date)}`);
          if (!res.ok) continue;
          const data = await res.json();
          const games = ((data.games ?? []) as ApiGameData[]).map(mapApiGame);
          const candidate = games.find(
            (g) => (g.homeTeamId === teamId || g.awayTeamId === teamId) &&
              g.status === "scheduled" && g.id !== excludeId,
          );
          if (candidate) {
            if (!cancelled) setRolloverNextGame({ ...candidate, dateISO: date });
            return;
          }
        } catch {
          /* 다음 경기 조회 실패는 무시 — 롤오버 폴백만 비활성 */
        }
      }
      if (!cancelled) setRolloverNextGame(null);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myTeamId, rolloverBase?.id]);

  // iOS 홈 화면 위젯 — 최애팀 경기(라이브/예정/종료)를 App Group에 기록해 위젯에 표시한다.
  // 라이브 경기가 없을 때 *다음 예정 경기*가 위젯에 뜨게 하는 핵심 fallback 경로.
  // (네이티브 iOS 외엔 no-op.) 스코어/이닝/주자 등 변할 때만 재기록되도록 signature로 dep.
  const widgetSig = widgetGame
    ? `${widgetGame.id}|${widgetGame.status}|${widgetGame.awayScore}|${widgetGame.homeScore}|${widgetGame.inning ?? ""}|${widgetGame.outs ?? ""}|${widgetGame.runner1b ? 1 : 0}${widgetGame.runner2b ? 1 : 0}${widgetGame.runner3b ? 1 : 0}|${widgetGame.currentPitcher ?? ""}|${widgetGame.currentBatter ?? ""}|${widgetGame.awayStarterName ?? ""}|${widgetGame.homeStarterName ?? ""}`
    : "";
  const rolloverSig = rolloverNextGame
    ? `${rolloverNextGame.id}|${rolloverNextGame.dateISO ?? ""}|${rolloverNextGame.time}|${rolloverNextGame.awayStarterName ?? ""}|${rolloverNextGame.homeStarterName ?? ""}`
    : "";
  useEffect(() => {
    if (!widgetGame) return;
    let cancelled = false;
    // 오늘 경기/전날 결과를 쓸 때(rolloverNextGame 세팅됨) 상태 무관 다음 예정 경기를 함께 실어
    // 위젯 06:00 자동 전환을 준비. 예정 스냅샷이 백그라운드서 종료로 바뀌어도 next 보존됨(삼순 ①).
    const rolloverNext: HomeWidgetGame | null =
      rolloverNextGame
        ? {
            gameId: rolloverNextGame.id,
            awayTeamId: rolloverNextGame.awayTeamId,
            homeTeamId: rolloverNextGame.homeTeamId,
            status: "scheduled",
            awayScore: 0,
            homeScore: 0,
            inning: null,
            isTop: true,
            outs: 0,
            runner1b: false,
            runner2b: false,
            runner3b: false,
            currentPitcher: null,
            currentBatter: null,
            stadium: rolloverNextGame.stadium,
            time: rolloverNextGame.time,
            dateText: formatKoreanDate(rolloverNextGame.dateISO ?? formatKSTDateOffset(1)),
            awayStarter: rolloverNextGame.awayStarterName ?? null,
            homeStarter: rolloverNextGame.homeStarterName ?? null,
          }
        : null;
    // 라이브면 문자중계 최근 플레이 한 줄을 붙여 기록(1.0.7+ 홈위젯 large 카드).
    // 잠금 LA·안드 위젯과 동일 소스(latestRelayLine, /api/game-relay). 실패/비라이브면 생략.
    void (async () => {
      let lastPlay = "";
      if (widgetGame.status === "live") {
        try {
          const relay = await fetch(`/api/game-relay?gameId=${widgetGame.id}`).then((r) =>
            r.ok ? r.json() : null,
          );
          lastPlay = latestRelayLine(relay) ?? "";
        } catch {
          /* 위젯 부가 정보 — 실패해도 스냅샷 기록은 진행 */
        }
      }
      if (cancelled) return;
      void writeHomeWidgetSnapshot(myTeamId, {
      gameId: widgetGame.id,
      awayTeamId: widgetGame.awayTeamId,
      homeTeamId: widgetGame.homeTeamId,
      status: widgetGame.status,
      awayScore: widgetGame.awayScore,
      homeScore: widgetGame.homeScore,
      inning: widgetGame.inning ?? null,
      isTop: widgetGame.isTop ?? true,
      outs: widgetGame.outs ?? 0,
      runner1b: widgetGame.runner1b ?? false,
      runner2b: widgetGame.runner2b ?? false,
      runner3b: widgetGame.runner3b ?? false,
      currentPitcher: widgetGame.currentPitcher ?? null,
      currentBatter: widgetGame.currentBatter ?? null,
      stadium: widgetGame.stadium,
      time: widgetGame.time,
      // 예정 경기 날짜 라벨('6월 7일 (토)') — 구장 위 표시. 오늘 예정은 dateISO 없으니 오늘로 폴백.
      dateText:
        widgetGame.status === "scheduled"
          ? formatKoreanDate(widgetGame.dateISO ?? formatKSTDateOffset(0))
          : "",
      awayStarter: widgetGame.status === "scheduled" ? (widgetGame.awayStarterName ?? "") : "",
      homeStarter: widgetGame.status === "scheduled" ? (widgetGame.homeStarterName ?? "") : "",
      lastPlay,
    }, rolloverNext);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myTeamId, widgetSig, rolloverSig]);

  return (
    <PullToRefresh onRefresh={handleRefresh}>
    <LazyMotion features={domAnimation}>
    {/* 환영 토스트 */}
    <AnimatePresence>
      {welcomeToast && (
        <m.div
          initial={{ opacity: 0, y: -40 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -40 }}
          className="fixed top-14 inset-x-0 z-50 flex justify-center px-4 pointer-events-none"
        >
          <div className="max-w-[calc(100vw-2rem)] px-5 py-3 rounded-2xl bg-bg-secondary border border-black/10 dark:border-white/10 shadow-lg">
            <p className="text-sm font-medium text-text-primary text-center break-keep">
              <span className="whitespace-nowrap">👋 {profile?.nickname}님</span>{" "}
              <span className="whitespace-nowrap">환영합니다!</span>
            </p>
          </div>
        </m.div>
      )}
    </AnimatePresence>

    <m.div
      variants={container}
      initial="hidden"
      animate="show"
      className="mx-auto max-w-lg px-5"
    >
      {/* Header — 전역 헤더 규격(sticky·min-h-[44px]·safe-area 상쇄), 로고 축소 */}
      <header
        className="sticky top-0 z-30 -mx-5 px-5 border-b bg-bg-primary mb-2"
        style={{
          borderColor: myTeamId ? getTeamBorderColorById(myTeamId) : 'var(--color-border)',
          paddingTop: "env(safe-area-inset-top, 0px)",
          marginTop: "calc(env(safe-area-inset-top, 0px) * -1)",
        }}
      >
        <div className="flex items-center justify-between min-h-[44px]">
        <div className="flex flex-col">
          <img src="/logo-mark-light.png" alt="크보팬" style={{height: "30px", objectFit: "contain"}} className="-ml-0.5 dark:hidden" />
          <img src="/logo-mark.png" alt="크보팬" style={{height: "30px", objectFit: "contain"}} className="-ml-0.5 hidden dark:block" />
        </div>
        <div className="flex items-center gap-1">
          {user ? (
            <Link href="/messages" aria-label="쪽지" className="relative flex h-11 w-11 items-center justify-center rounded-full text-text-secondary hover:bg-bg-tertiary transition-colors">
              <MessageCircle size={22} />
              {unreadDMCount > 0 && (
                <span className="absolute top-1 right-1 min-w-[16px] h-4 px-1 rounded-full bg-red-500 flex items-center justify-center text-[10px] font-bold text-white leading-none">
                  {unreadDMCount > 9 ? "9+" : unreadDMCount}
                </span>
              )}
            </Link>
          ) : (
            <button
              onClick={() => setShowLogin(true)}
              className="flex h-11 items-center justify-center px-1 transition-transform active:scale-95"
            >
              <span className="flex h-8 items-center rounded-full bg-accent px-3 text-[13px] font-semibold leading-none text-white">
                회원가입
              </span>
            </button>
          )}
          <Link href="/my" aria-label="마이페이지" className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-bg-tertiary transition-colors">
            <HeaderAvatar user={user} profile={profile} />
          </Link>
        </div>
        </div>
      </header>

      <AppDownloadBanner />

      {/* 7/30 장애 안내 배너 — 2026-07-30 23:30 KST까지 노출 후 자동 소멸 */}
      <OutageNoticeBanner />

      {/* 스킵 유저: 최애선수 설정 CTA */}
      {showPlayerSetupCTA && myTeamId && (
        <m.div variants={item} className="mb-3">
          <button
            onClick={() => setShowPlayerSelect(true)}
            className="w-full p-4 rounded-2xl flex items-center gap-3 transition-colors"
            style={{
              background: `${getTeamBgColorById(myTeamId)}12`,
              border: `1px solid ${getTeamColor(myTeamId)}20`,
            }}
          >
            <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: `${getTeamBgColorById(myTeamId)}25` }}>
              <span className="text-lg">⭐</span>
            </div>
            <div className="flex-1 text-left">
              <p className="text-[15px] leading-[22px] font-medium text-text-primary">최애선수 설정하고 홈을 꾸며보세요</p>
              <p className="text-xs leading-[18px] text-text-tertiary mt-0.5">선수 소식/기록을 더 잘 추천해드려요</p>
            </div>
            <ChevronRight size={18} className="text-text-tertiary" />
          </button>
        </m.div>
      )}

      {/* 섹션 순서: 팀카드 → 뉴스 → 최애선수 → 숏츠 → 다른팀실시간 → 전체경기현황.
          각 섹션은 마이페이지 토글(sections.*)로 on/off. 팀카드는 S3에서 삽입. */}

      {/* What's New Card (토글/순서 대상 아님 — 팀카드 바로 위 고정) */}
      <Suspense fallback={null}>
        <WhatsNewCard />
      </Suspense>

      {/* 올스타전 크관 연결 경기카드 — 배포 즉시~경기 종료 전까지 팀카드 위 노출 (목업 v2 승인, 2026-07-11) */}
      {(() => {
        const allStarGame = todayGames.find((g) => isAllStarGameId(g.id));
        if (!allStarGame) return null;
        const allStarLive = allLiveData.find((g) => g.gameId === allStarGame.id);
        return <AllStarGameCard game={allStarGame} live={allStarLive} />;
      })()}

      {/* 팀 카드 (필수, 토글 없음) — 경기카드(MyTeamHero)를 안에 종속 임베드(④=B) */}
      {myTeam && (
        <TeamCard
          team={myTeam}
          gameSlot={embeddedGame ? <MyTeamHero myTeam={myTeam} myTeamGame={embeddedGame} embedded /> : undefined}
          refreshNonce={refreshNonce}
        />
      )}

      {/* 순서 조정 가능한 섹션들. sectionOrder(마이페이지 드래그)대로 렌더.
          각 섹션은 토글(sections.*) off면 숨김. LiveGameBanner는 liveOtherTeams로 독립. */}
      {sectionOrder.map((key: HomeSectionKey) => {
        switch (key) {
          case "news": {
            const newsToShow = photoFilterOn
              ? realNews.filter((n) => !isPhotoArticle(n.title))
              : realNews;
            return sections.news && newsToShow.length > 0 ? (
              <div key={key} className="mb-3">
                <div className="-mx-5">
                  <Suspense fallback={<SectionSkeleton height={180} />}>
                    <NewsCarousel news={newsToShow.slice(0, 10)} />
                  </Suspense>
                </div>
              </div>
            ) : null;
          }
          case "communityLatest":
            return sections.communityLatest ? (
              <div key={key} className="mb-3">
                <Suspense fallback={null}>
                  <CommunityLatestPosts myTeamId={myTeamId} refreshNonce={refreshNonce} />
                </Suspense>
              </div>
            ) : null;
          case "favPlayers":
            return sections.favPlayers ? (
              <div key={key} className="mb-3">
                <FavoritePlayersSection favPlayers={favPlayers} refreshNonce={refreshNonce} />
              </div>
            ) : null;
          case "shorts":
            return sections.shorts ? (
              <div key={key} className="mb-3">
                <Suspense fallback={<SectionSkeleton height={250} />}>
                  <HomeHighlights team={myTeamId ? TEAMS.find(t => t.id === myTeamId)?.shortName || null : null} refreshNonce={refreshNonce} />
                </Suspense>
              </div>
            ) : null;
          case "liveOtherTeams":
            return sections.liveOtherTeams ? (
              <LiveGameBanner key={key} excludeGameId={myTeamGameBase?.id} liveGames={liveGames} />
            ) : null;
          case "allGames":
            return sections.allGames ? (
              <TodayGamesSection key={key} todayGames={todayGames} isPreseason={isPreseason} myTeamId={myTeamId} />
            ) : null;
          default:
            return null;
        }
      })}

      {/* 퀵액션 버튼 */}
      <m.div variants={item} className="flex gap-3 mb-6">
        <Link href="/community/tickets" className="flex-1">
          <GlassCard pressable className="flex items-center gap-3 !p-4">
            <span className="text-lg">🎫</span>
            <span className="text-[15px] leading-[22px] font-medium text-text-primary">티켓양도</span>
          </GlassCard>
        </Link>
        <Link href="/community/stadiums" className="flex-1">
          <GlassCard pressable className="flex items-center gap-3 !p-4">
            <span className="text-lg">🏟️</span>
            <span className="text-[15px] leading-[22px] font-medium text-text-primary">구장가이드</span>
          </GlassCard>
        </Link>
      </m.div>

      <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />
      <div className="h-4" />
    </m.div>

    {showOnboarding && (
      <OnboardingFlow onComplete={handleOnboardingComplete} />
    )}
    <GeniusLaunchPopup enabled={!showOnboarding && !showPlayerSelect} />
    <PlayerSelectModal
      isOpen={showPlayerSelect}
      teamId={myTeamId ?? 1}
      onComplete={handlePlayerSelect}
      onSkip={() => {
        setShowPlayerSelect(false);
        setShowPlayerSetupCTA(false);
      }}
    />

    {aiGame && (
      <AIAnalysis
        isOpen={true}
        onClose={() => setAiGame(null)}
        awayTeamId={aiGame.awayTeamId}
        homeTeamId={aiGame.homeTeamId}
        gameId={aiGame.gameId}
      />
    )}
    </LazyMotion>
    </PullToRefresh>
  );
}
