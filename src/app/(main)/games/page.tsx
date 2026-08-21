"use client";
import { PRESEASON_GAMES, PRESEASON_DATES } from "@/lib/constants/preseason-schedule";
import { useSafeBack } from "@/lib/hooks/useSafeBack";
import { getTeamBorderColorById } from "@/lib/utils/team-border-color";
import { getTeamById } from "@/lib/constants/teams";

import { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { useVisibilityAwareInterval } from "@/lib/hooks/useVisibilityAwareInterval";
import { createRequestCoordinator, type RequestToken } from "@/lib/polling/request-coordinator";
import { getKSTToday } from "@/lib/utils/date-kst";
import { ChevronLeft, RefreshCw, Star } from "lucide-react";
import HeaderProfileLink from "@/components/ui/HeaderProfileLink";
import { getMyTeamId } from "@/lib/store/myteam";
import { pickMyTeamPriorityGame } from "@/lib/utils/pick-myteam-game";
import DateSelector from "@/components/game/DateSelector";
import CompactGameCard from "@/components/game/CompactGameCard";
import EmptyGameState from "@/components/game/EmptyGameState";
import type { BroadcastChannel } from "@/lib/broadcast-channels";
import { pickGameWeather, type StadiumWeatherMap } from "@/lib/weather/stadium-weather";

interface GameData {
  id: string;
  awayTeamId: number;
  homeTeamId: number;
  awayScore: number | null;
  homeScore: number | null;
  status: "scheduled" | "live" | "final" | "cancelled";
  time: string;
  stadium: string;
  inning?: string;
  awayStarter?: string;
  homeStarter?: string;
  broadcastChannels?: BroadcastChannel[];
  // 라이브 상세(잠금화면 LA 패리티) — live 상태에서만 채워진다
  balls?: number;
  strikes?: number;
  outs?: number;
  runnersOn?: { first: boolean; second: boolean; third: boolean };
  currentPitcher?: string;
  currentBatter?: string;
  lastPlay?: string;
  /** 라이브 상세가 실제 KBO 관측값인지(provenance). Naver degrade 는 0/false 를 채우므로 값만으론 구분 불가. */
  liveDetailFromKbo?: boolean;
}

const container = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } };
const item = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0, transition: { duration: 0.3 } } };

function formatDate(dateStr: string): string {
  return dateStr.replace(/-/g, "");
}

// "YYYY-MM-DD" → "7월 26일 (토)" 다음 경기 헤더용
function formatNextGameLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "short" });
}

function buildPreseasonFallback(date: string): GameData[] {
  const dateStr = `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`;
  const TEAM_ID: Record<string, number> = { LG:1, 두산:2, KT:3, SSG:4, NC:5, KIA:6, 롯데:7, 삼성:8, 한화:9, 키움:10 };
  return PRESEASON_GAMES
    .filter(g => g.date === dateStr)
    .map((g, i) => ({
      id: `pre-${dateStr}-${i}`,
      awayTeamId: TEAM_ID[g.away] ?? 0,
      homeTeamId: TEAM_ID[g.home] ?? 0,
      awayScore: 0,
      homeScore: 0,
      status: "scheduled" as const,
      time: "13:00",
      stadium: g.venue,
      inning: undefined,
      awayStarter: "",
      homeStarter: "",
    }));
}

export default function GamesPage() {
  const today = getKSTToday();
  const goBack = useSafeBack("/");
  const [selectedDate, setSelectedDate] = useState(today);
  const [games, setGames] = useState<GameData[]>([]);
  const isPreseason = PRESEASON_DATES.includes(selectedDate);
  const [loading, setLoading] = useState(true);
  const [loadedDate, setLoadedDate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [myTeamId, setMyTeamId] = useState<number | null>(null);
  // MY TEAM 이 오늘 경기가 없을 때 보여줄 다음 경기(날짜 명시)
  const [nextMyGame, setNextMyGame] = useState<{ game: GameData; dateStr: string } | null>(null);
  // 구장 날씨 — key(날짜|구장세트)로 캐시해 날짜 전환 레이스에 이전 데이터가 붙지 않게 한다
  const [weather, setWeather] = useState<{ key: string; map: StadiumWeatherMap } | null>(null);
  const [requestCoordinator] = useState(() => createRequestCoordinator<GameData[]>());

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMyTeamId(getMyTeamId());
  }, []);

  const loadGames = useCallback(async (date: string, token: RequestToken) => {
    if (!requestCoordinator.isCurrent(token)) return;
    setLoading(true);
    setError(null);
    try {
      const result = await requestCoordinator.run(token, async (signal) => {
        const res = await fetch(`/api/games?date=${formatDate(date)}`, { signal });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        const mapped: GameData[] = (data.games ?? []).map((g: { gameId: string; awayTeamId: number; homeTeamId: number; awayScore: number | null; homeScore: number | null; status: "scheduled" | "live" | "final" | "cancelled"; time: string; stadium: string; inning?: string; isTop?: boolean; awayStarterName?: string; homeStarterName?: string; broadcastChannels?: BroadcastChannel[]; balls?: number; strikes?: number; outs?: number; runnersOn?: { first: boolean; second: boolean; third: boolean }; currentPitcher?: string; currentBatter?: string; lastPlay?: string; liveDetailFromKbo?: boolean }) => ({
          id: g.gameId,
          awayTeamId: g.awayTeamId,
          homeTeamId: g.homeTeamId,
          awayScore: g.awayScore,
          homeScore: g.homeScore,
          status: g.status,
          time: g.time,
          stadium: g.stadium,
          inning: g.status === "live" ? `${g.inning}회${g.isTop ? "초" : "말"}` : undefined,
          awayStarter: g.awayStarterName,
          homeStarter: g.homeStarterName,
          broadcastChannels: g.broadcastChannels,
          ...(g.status === "live" ? {
            balls: g.balls,
            strikes: g.strikes,
            outs: g.outs,
            runnersOn: g.runnersOn,
            liveDetailFromKbo: g.liveDetailFromKbo,
            currentPitcher: g.currentPitcher,
            currentBatter: g.currentBatter,
            lastPlay: g.lastPlay,
          } : {}),
        }));
        return mapped.length === 0 ? buildPreseasonFallback(date) : mapped;
      });
      if (result.status === "stale") return;
      setGames(result.value);
    } catch (e: unknown) {
      if (!requestCoordinator.isCurrent(token)) return;
      const preGames = buildPreseasonFallback(date);
      if (preGames.length > 0) {
        setGames(preGames);
        setError(null);
      } else {
        setError((e as Error).message);
        setGames([]);
      }
    }
    if (!requestCoordinator.isCurrent(token)) return;
    setLoadedDate(date);
    setLoading(false);
  }, [requestCoordinator]);

  useEffect(() => {
    const token = requestCoordinator.switchTarget(selectedDate);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadGames(selectedDate, token);
    return () => requestCoordinator.dispose();
  }, [loadGames, requestCoordinator, selectedDate]);

  // 예정/라이브 경기 구장의 날씨 로드 (날씨는 부가 정보 — 실패해도 조용히 무시)
  // 종료·취소 경기는 카드에서 날씨를 렌더하지 않으므로 fetch 대상에서 제외한다
  // (하린아빠 2026-08-15: "종료카드에 날씨가 뜰 필요는 없지").
  useEffect(() => {
    // 날짜 전환 직후엔 games가 아직 이전 날짜 것일 수 있다 — 목록 로드가 끝나
    // games와 selectedDate가 정합일 때만 fetch (이전 구장 세트로 캐시가 잠기는 것 방지)
    if (loading) return;
    const stadiums = [...new Set(
      games.filter(g => g.status === "scheduled" || g.status === "live").map(g => g.stadium)
    )].sort();
    if (stadiums.length === 0) return;
    const key = `${selectedDate}|${stadiums.join(",")}`;
    if (weather?.key === key) return;
    let stale = false;
    fetch(`/api/weather?date=${formatDate(selectedDate)}&stadiums=${encodeURIComponent(stadiums.join(","))}`)
      .then(res => res.json())
      .then(data => {
        if (!stale && data?.stadiums) setWeather({ key, map: data.stadiums });
      })
      .catch(() => {});
    return () => { stale = true; };
  }, [games, selectedDate, weather, loading]);

  // 라이브 경기 있으면 30초마다 자동 새로고침 (백그라운드 탭은 정지, 복귀 시 즉시 갱신)
  const hasLive = games.some(g => g.status === "live");
  const refreshGames = useCallback(() => {
    const token = requestCoordinator.currentToken() ?? requestCoordinator.switchTarget(selectedDate);
    return loadGames(selectedDate, token);
  }, [loadGames, requestCoordinator, selectedDate]);
  useVisibilityAwareInterval(refreshGames, 30000, {
    enabled: hasLive,
    resetKey: selectedDate,
    runImmediately: false,
  });

  // MY TEAM 오늘 경기 유무 — boolean 으로 좁혀 30초 auto-refresh(games 배열 재생성)에
  // 다음 경기 스캔 effect 가 불필요하게 재실행되지 않게 한다.
  const hasMyTeamGameToday =
    myTeamId != null && games.some(g => g.awayTeamId === myTeamId || g.homeTeamId === myTeamId);

  // MY TEAM 이 오늘 경기가 없으면 다음 경기(최대 14일 이내) 탐색 — 오늘 날짜를 볼 때만
  useEffect(() => {
    if (myTeamId == null || selectedDate !== today || hasMyTeamGameToday) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNextMyGame(null);
      return;
    }
    // 최초 선택 날짜 로드가 끝난 뒤 한 번만 스캔한다. 30초 background refresh의
    // loading true/false는 loadedDate를 바꾸지 않으므로 기존 카드·스캔을 유지한다.
    if (loadedDate !== selectedDate) return;
    let stale = false;
    (async () => {
      const [y, m, d] = today.split("-").map(Number);
      for (let i = 1; i <= 14 && !stale; i++) {
        const base = new Date(y, m - 1, d);
        base.setDate(base.getDate() + i);
        const iso = `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, "0")}-${String(base.getDate()).padStart(2, "0")}`;
        try {
          const res = await fetch(`/api/games?date=${formatDate(iso)}`);
          if (!res.ok) continue;
          const data = await res.json();
          const match = (data.games ?? []).find(
            (g: { awayTeamId: number; homeTeamId: number; status: string }) =>
              (g.awayTeamId === myTeamId || g.homeTeamId === myTeamId) && g.status !== "cancelled"
          );
          if (match && !stale) {
            setNextMyGame({
              dateStr: iso,
              game: {
                id: match.gameId,
                awayTeamId: match.awayTeamId,
                homeTeamId: match.homeTeamId,
                awayScore: match.awayScore ?? null,
                homeScore: match.homeScore ?? null,
                status: match.status,
                time: match.time,
                stadium: match.stadium,
                awayStarter: match.awayStarterName,
                homeStarter: match.homeStarterName,
                broadcastChannels: match.broadcastChannels,
              },
            });
            return;
          }
        } catch { /* skip */ }
      }
      if (!stale) setNextMyGame(null);
    })();
    return () => { stale = true; };
  }, [myTeamId, selectedDate, today, hasMyTeamGameToday, loadedDate]);

  const myTeamName = myTeamId != null ? getTeamById(myTeamId)?.shortName : undefined;

  const gameWeather = (g: GameData) =>
    weather?.key.startsWith(`${selectedDate}|`) ? pickGameWeather(weather.map[g.stadium], g, selectedDate) : null;

  // MY TEAM 오늘 경기는 상단 우선 카드 1장으로 노출하고, 아래 목록에서는 중복 제거.
  // 더블헤더면 상태 우선순위(live > scheduled > final > cancelled)로 가장 의미있는 경기를 고른다.
  const myTeamGame = pickMyTeamPriorityGame(games, myTeamId);
  const restGames = myTeamGame ? games.filter(g => g.id !== myTeamGame.id) : games;

  const liveGames = restGames.filter(g => g.status === "live");
  const finalGames = restGames.filter(g => g.status === "final");
  const cancelledGames = restGames.filter(g => g.status === "cancelled");
  const scheduledGames = restGames.filter(g => g.status === "scheduled");

  return (
    <div className="mx-auto max-w-lg">
      <div className="sticky top-0 z-30 border-b bg-bg-primary" style={{ borderColor: myTeamId ? getTeamBorderColorById(myTeamId) : 'var(--color-border)', paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))", marginTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) * -1)" }}>
        <div className="flex items-center gap-3 px-5 min-h-[44px]">
          <button onClick={goBack} aria-label="뒤로가기" className="flex h-11 w-11 items-center justify-center rounded-full text-text-secondary hover:bg-bg-tertiary transition-colors">
            <ChevronLeft size={24} />
          </button>
          <h1 className="text-lg font-bold text-text-primary tracking-tight flex-1">경기</h1>
          <button
            onClick={() => { void refreshGames(); }}
            className="p-2 rounded-full text-text-tertiary hover:bg-bg-tertiary transition-colors"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
          </button>
          <HeaderProfileLink />
        </div>
      </div>

      <div className="mt-1">
        <DateSelector selectedDate={selectedDate} onDateChange={setSelectedDate} />
      </div>

      {loading && games.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <RefreshCw size={24} className="animate-spin text-text-tertiary" />
        </div>
      ) : error ? (
        <div className="px-5 py-20 text-center text-text-tertiary text-sm">
          데이터를 불러올 수 없습니다
          <button onClick={() => { void refreshGames(); }} className="block mx-auto mt-2 text-accent text-xs">다시 시도</button>
        </div>
      ) : games.length === 0 && !nextMyGame ? (
        <EmptyGameState selectedDate={selectedDate} />
      ) : (
        <motion.div variants={container} initial="hidden" animate="show" className="px-5 pb-24 space-y-6">
          {myTeamGame && (
            <div>
              <h2
                className="text-sm font-semibold mb-2 flex items-center gap-1"
                style={{ color: myTeamId ? getTeamBorderColorById(myTeamId) : undefined }}
              >
                <Star size={14} className="fill-current" /> MY TEAM
              </h2>
              <motion.div variants={item}>
                <CompactGameCard game={myTeamGame} isPreseason={isPreseason} myTeamId={myTeamId} weather={gameWeather(myTeamGame)} featured />
              </motion.div>
            </div>
          )}

          {!myTeamGame && nextMyGame && (
            <div>
              <h2 className="text-sm font-semibold text-text-tertiary mb-1 flex items-center gap-1">
                <Star size={14} className="fill-current" /> MY TEAM · 다음 경기 {formatNextGameLabel(nextMyGame.dateStr)}
              </h2>
              {/*
                오늘 화면에 다른 날짜 경기를 얹어 보여주므로, 오늘 경기가 없다는 사실을 먼저 명시한다.
                은/는 조사는 팀명 받침(두산·삼성·키움)에 따라 갈리므로 쓰지 않는다.
              */}
              <p className="text-xs text-text-tertiary mb-2">
                오늘 {myTeamName ? `${myTeamName} ` : ""}경기가 없습니다
              </p>
              <motion.div variants={item}>
                <CompactGameCard
                  game={nextMyGame.game}
                  isPreseason={isPreseason}
                  myTeamId={myTeamId}
                  dateStr={nextMyGame.dateStr}
                  featured
                />
              </motion.div>
            </div>
          )}

          {liveGames.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-red-400 mb-2 flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" /> LIVE
              </h2>
              <div className="space-y-2">
                {liveGames.map(g => (
                  <motion.div key={g.id} variants={item}>
                    <CompactGameCard game={g} isPreseason={isPreseason} myTeamId={myTeamId} weather={gameWeather(g)} />
                  </motion.div>
                ))}
              </div>
            </div>
          )}

          {finalGames.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-text-tertiary mb-2">종료</h2>
              <div className="space-y-2">
                {finalGames.map(g => (
                  <motion.div key={g.id} variants={item}>
                    <CompactGameCard game={g} isPreseason={isPreseason} myTeamId={myTeamId} weather={gameWeather(g)} />
                  </motion.div>
                ))}
              </div>
            </div>
          )}

          {cancelledGames.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-text-tertiary mb-2">취소</h2>
              <div className="space-y-2">
                {cancelledGames.map(g => (
                  <motion.div key={g.id} variants={item}>
                    <CompactGameCard game={g} isPreseason={isPreseason} myTeamId={myTeamId} weather={gameWeather(g)} />
                  </motion.div>
                ))}
              </div>
            </div>
          )}

          {scheduledGames.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-text-tertiary mb-2">예정</h2>
              <div className="space-y-2">
                {scheduledGames.map(g => (
                  <motion.div key={g.id} variants={item}>
                    <CompactGameCard game={g} isPreseason={isPreseason} myTeamId={myTeamId} weather={gameWeather(g)} />
                  </motion.div>
                ))}
              </div>
            </div>
          )}
        </motion.div>
      )}
    </div>
  );
}
