"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Bell, ChevronRight, Flame, User, Users } from "lucide-react";
import Link from "next/link";
import Image from "next/image";
import GlassCard from "@/components/ui/GlassCard";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import AIAnalysis from "@/components/game/AIAnalysis";
import TeamSelectModal from "@/components/onboarding/TeamSelectModal";
import PlayerSelectModal from "@/components/onboarding/PlayerSelectModal";
import { useAuth } from "@/lib/supabase/AuthContext";
import LoginSheet from "@/components/auth/LoginSheet";
import { PRESEASON_GAMES, PRESEASON_DATES } from "@/lib/constants/preseason-schedule";
import { getFavoritePlayers, setFavoritePlayers, type FavoritePlayer } from "@/lib/store/favorites";
import { getMyTeamId, setMyTeamId as saveMyTeamId } from "@/lib/store/myteam";
import NewsCarousel from "@/components/news/NewsCarousel";
import HomeHighlights from "@/components/home/HomeHighlights";
import LiveGameBanner from "@/components/home/LiveGameBanner";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import TeamBadge from "@/components/ui/TeamBadge";
import { TEAMS, getTeamById } from "@/lib/constants/teams";
import { MOCK_PREDICTIONS } from "@/lib/constants/predictions";
import { MOCK_NEWS } from "@/lib/constants/news";

/* ===== Mock Data ===== */
const MOCK_GAMES = [
  { id: "20260328-LG-DS", homeTeamId: 2, awayTeamId: 1, time: "18:30", stadium: "잠실", homeScore: 20, awayScore: 5, status: "live" as const, inning: "6회말" },
  { id: "20260328-SSG-HW", homeTeamId: 4, awayTeamId: 9, time: "18:30", stadium: "인천", homeScore: 0, awayScore: 0, status: "scheduled" as const, inning: null },
  { id: "20260328-KT-NC", homeTeamId: 3, awayTeamId: 5, time: "18:30", stadium: "수원", homeScore: 2, awayScore: 1, status: "live" as const, inning: "4회초" },
  { id: "20260328-KIA-LT", homeTeamId: 6, awayTeamId: 7, time: "14:00", stadium: "광주", homeScore: 7, awayScore: 3, status: "final" as const, inning: "종료" },
  { id: "20260328-SS-KW", homeTeamId: 8, awayTeamId: 10, time: "18:30", stadium: "대구", homeScore: 1, awayScore: 1, status: "live" as const, inning: "3회초" },
];


const MOCK_HOT_PLAYER_BOARDS = [
  { playerId: "53123", name: "오스틴 딘", teamId: 1, teamName: "LG", postsToday: 47, totalPosts: 1284, trend: "up" as const },
  { playerId: "77637", name: "양현종", teamId: 6, teamName: "KIA", postsToday: 38, totalPosts: 956, trend: "up" as const },
  { playerId: "62404", name: "구자욱", teamId: 8, teamName: "삼성", postsToday: 35, totalPosts: 1102, trend: "same" as const },
  { playerId: "52605", name: "김도영", teamId: 6, teamName: "KIA", postsToday: 33, totalPosts: 2341, trend: "up" as const },
  { playerId: "52701", name: "문동주", teamId: 9, teamName: "한화", postsToday: 28, totalPosts: 876, trend: "down" as const },
];

const MOCK_POPULAR_POSTS = [
  { id: 1, title: "오늘의 선발 라인업 예상", boardId: "lg", author: "엘지골드", likeCount: 42, commentCount: 18, teamId: 1 },
  { id: 2, title: "올해 우승은 반드시 우리가 한다", boardId: "kia", author: "타이거팬", likeCount: 38, commentCount: 24, teamId: 6 },
  { id: 3, title: "신인 드래프트 1순위 분석", boardId: "samsung", author: "야구박사", likeCount: 31, commentCount: 12, teamId: 8 },
];



  const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06 } },
};

const item = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35 } },
};

function getTeamShortName(teamId: number) {
  return TEAMS.find((t) => t.id === teamId)?.shortName ?? "";
}

function getTeamColor(teamId: number) {
  return TEAMS.find((t) => t.id === teamId)?.colorLight ?? "#999";
}
function getTeamBgColor(teamId: number) {
  return TEAMS.find((t) => t.id === teamId)?.colorPrimary ?? "#666";
}

function getTeamLogo(teamId: number) {
  return TEAMS.find((t) => t.id === teamId)?.logoPath ?? "";
}

function getTeamName(teamId: number) {
  return TEAMS.find((t) => t.id === teamId)?.name ?? "";
}

function StatusBadge({ status, inning }: { status: string; inning: string | null }) {
  if (status === "live") {
    return (
      <span className="flex items-center gap-1 text-sm font-semibold text-accent-green">
        <span className="h-1.5 w-1.5 rounded-full bg-accent-green animate-pulse" />
        {inning}
      </span>
    );
  }
  if (status === "final") {
    return <span className="text-sm text-text-secondary">종료</span>;
  }
  return <span className="text-sm text-text-secondary">예정</span>;
}

function SectionHeader({ title, href, icon }: { title: string; href?: string; icon?: string }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="flex items-center gap-2 text-lg font-bold text-text-primary">
        {icon && <span>{icon}</span>} {title}
      </h2>
      {href && (
        <Link
          href={href}
          className="flex items-center text-xs text-text-tertiary hover:text-text-primary transition-colors"
        >
          전체보기 <ChevronRight size={20} />
        </Link>
      )}
    </div>
  );
}

export default function HomePage() {
  const [aiGame, setAiGame] = useState<{awayTeamId: number; homeTeamId: number} | null>(null);
  const [myTeamId, setMyTeam] = useState<number | null>(null);
  const [realNews, setRealNews] = useState<any[]>([]);

  useEffect(() => {
    const team = myTeamId ? TEAMS.find(t => t.id === myTeamId)?.shortName : "";
    let favPlayers = getFavoritePlayers().slice(0, 3);
    
    // 최애선수 미설정 시 팀의 대표 선수 3명으로 fallback
    if (favPlayers.length === 0 && team) {
      const defaultPlayers: Record<string, string[]> = {
        "LG": ["오스틴", "문보경", "홍창기"],
        "두산": ["양의지", "허경민", "곽빈"],
        "KT": ["강백호", "로하스", "소형준"],
        "SSG": ["최정", "추신수", "김광현"],
        "NC": ["손아섭", "박건우", "에릭"],
        "KIA": ["김도영", "나성범", "양현종"],
        "삼성": ["구자욱", "김영웅", "원태인"],
        "롯데": ["전준우", "레이예스", "윌커슨"],
        "한화": ["노시환", "이범호", "주현상"],
        "키움": ["이정후", "김하성", "송성문"],
      };
      const names = defaultPlayers[team] || [];
      const teamObj = TEAMS.find(t => t.shortName === team);
      favPlayers = names.map(name => ({ playerId: "", name, teamId: teamObj?.id || 0, position: "", number: 0 }));
    }
    
    // 팀 뉴스 + 최애선수 뉴스 병렬 호출
    const queries = [
      team 
        ? fetch(`/api/news?q=${encodeURIComponent(`프로야구 ${team}`)}`).then(r => r.json()).then(d => ({
            items: (d.items || []).map((item: any) => ({ ...item, _label: team })),
          }))
        : Promise.resolve({ items: [] }),
      ...favPlayers.map(p => {
        const pTeam = TEAMS.find(t => t.id === p.teamId);
        const pTeamName = pTeam ? `${pTeam.shortName} ${pTeam.name}` : "";
        return fetch(`/api/news?q=${encodeURIComponent(`${pTeamName} ${p.name}`)}`).then(r => r.json()).then(d => ({
          items: (d.items || []).map((item: any) => ({ ...item, _label: p.name })),
        }));
      })
    ];
    
    Promise.all(queries).then(results => {
      const teamItems = results[0]?.items || [];
      const playerResults = results.slice(1);
      
      // 선수별 균등 분배 (각 2개씩 먼저, 남은 슬롯은 라운드로빈)
      const seen = new Set();
      const dedupArr = (items: any[]) => items.filter((item: any) => {
        if (seen.has(item.link)) return false;
        seen.add(item.link);
        return true;
      });
      
      // 선수별 각 2개씩
      const perPlayer = playerResults.map(d => dedupArr((d.items || []).slice(0, 3)));
      const playerNews = perPlayer.flat();
      
      // 팀 기사로 나머지 채우기
      const uniqueTeam = dedupArr(teamItems).slice(0, Math.max(10 - playerNews.length, 2));
      const unique = [...playerNews, ...uniqueTeam];
      
      // 최신순 정렬
      unique.sort((a: any, b: any) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());
      
      if (unique.length) {
          setRealNews(unique.map((item: any, i: number) => ({
            id: 1000 + i,
            title: item.title,
            link: item.link,
            pubDate: item.pubDate,
            label: item._label || "",
            source: (() => { try { return new URL(item.link).hostname.replace("www.", "").replace("m.", ""); } catch { return "뉴스"; } })(),
            sourceUrl: item.link,
            timeAgo: (() => {
              const diff = Date.now() - new Date(item.pubDate).getTime();
              const hours = Math.floor(diff / (1000 * 60 * 60));
              if (hours < 1) return "방금";
              if (hours < 24) return `${hours}시간 전`;
              const days = Math.floor(hours / 24);
              return `${days}일 전`;
            })(),
            teamId: myTeamId || null,
          })));
        }
      }).catch(console.error);
  }, [myTeamId]);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showPlayerSelect, setShowPlayerSelect] = useState(false);
  const { user } = useAuth();

  // 오늘의 경기 (API + 시범경기 fallback)
  const [todayGames, setTodayGames] = useState<any[]>(MOCK_GAMES);
  const [isPreseason, setIsPreseason] = useState(false);
  useEffect(() => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;
    const yyyymmdd = dateStr.replace(/-/g, "");
    
    // 3/12 이전이면 API 호출 스킵 (경기 없음)
    if (yyyymmdd < "20260312") { setLoading && 0; return; }
    fetch(`/api/games?date=${yyyymmdd}`)
      .then(r => r.json())
      .then(data => {
        const games = (data.games ?? []).map((g: any) => ({
          id: g.gameId,
          homeTeamId: g.homeTeamId,
          awayTeamId: g.awayTeamId,
          time: g.time,
          stadium: g.stadium,
          homeScore: g.homeScore ?? 0,
          awayScore: g.awayScore ?? 0,
          status: g.status === "cancelled" ? "final" as const : g.status,
          inning: g.status === "live" ? `${g.inning}회${g.isTop ? "초" : "말"}` : null,
        }));
        if (games.length > 0) {
          setTodayGames(games);
          setIsPreseason(PRESEASON_DATES.includes(dateStr));
        } else if (PRESEASON_DATES.includes(dateStr)) {
          const TEAM_ID: Record<string, number> = { LG:1, "두산":2, KT:3, SSG:4, NC:5, KIA:6, "롯데":7, "삼성":8, "한화":9, "키움":10 };
          const preGames = PRESEASON_GAMES
            .filter(g => g.date === dateStr)
            .map((g, i) => ({
              id: `pre-${dateStr}-${i}`,
              homeTeamId: TEAM_ID[g.home] ?? 0,
              awayTeamId: TEAM_ID[g.away] ?? 0,
              time: "13:00",
              stadium: g.venue,
              homeScore: 0,
              awayScore: 0,
              status: "scheduled" as const,
              inning: null,
            }));
          setTodayGames(preGames);
          setIsPreseason(true);
        }
      })
      .catch(() => {});
  }, []);


  const [showLogin, setShowLogin] = useState(false);
  const [favPlayers, setFavPlayers] = useState<FavoritePlayer[]>([]);

  useEffect(() => {
    const saved = getMyTeamId();
    if (saved) {
      setMyTeam(saved);
      setFavPlayers(getFavoritePlayers());
    } else {
      setShowOnboarding(true);
    }
  }, []);

  function handleTeamSelect(teamId: number) {
    saveMyTeamId(teamId);
    setMyTeam(teamId);
    setShowOnboarding(false);
    // 최애 선수 선택으로 넘어가기
    if (getFavoritePlayers().length === 0) {
      setShowPlayerSelect(true);
    }
  }

  function handlePlayerSelect(players: FavoritePlayer[]) {
    setFavoritePlayers(players);
    setFavPlayers(players);
    setShowPlayerSelect(false);
  }

  const myTeam = myTeamId ? getTeamById(myTeamId) : null;
  const myTeamGame = todayGames.find(g => g.homeTeamId === myTeamId || g.awayTeamId === myTeamId);
  // Show first 2 predictions for preview
  const previewPredictions = MOCK_PREDICTIONS.filter((p) => p.status === "open").slice(0, 2);
  // Show first 3 news
  const previewNews = MOCK_NEWS.slice(0, 3);

  return (
    <>
    <motion.div
      variants={container}
      initial="hidden"
      animate="show"
      className="mx-auto max-w-lg px-5"
    >
      {/* Header */}
      <motion.header variants={item} className="flex items-end justify-between pb-0 pt-0">
        <img src="/logo.png" alt="크보 에브리데이" style={{height: "120px", objectFit: "contain"}} />
        <div className="flex items-center gap-1 mb-6">
          <button className="rounded-full p-2 text-text-secondary hover:bg-bg-tertiary transition-colors">
            <Bell size={22} />
          </button>
          <Link href="/my" className="rounded-full p-2 hover:bg-bg-tertiary transition-colors">
            <User size={22} className="text-text-secondary" />
          </Link>
        </div>
      </motion.header>

      {/* ===== My Team Hero ===== */}
      {myTeam && myTeamGame && (
        <div className="mb-3">
          <Link href={`/games/${myTeamGame.id}`}>
            <div
              className="relative rounded-2xl p-5 overflow-hidden border border-white/10 bg-bg-secondary"
              style={{ background: `linear-gradient(135deg, ${myTeam.colorPrimary}50 0%, #1a1a1d 100%)` }}
            >
              {/* Team logo watermark */}
              <div className="absolute right-3 top-3 opacity-15">
                <Image src={myTeam.logoPath} alt="" width={72} height={72} unoptimized className="object-contain" />
              </div>

              <div className="flex items-center gap-2 mb-3">
                <div className="w-7 h-7 rounded-full bg-white p-0.5 flex items-center justify-center">
                  <Image src={myTeam.logoPath} alt="" width={20} height={20} unoptimized className="object-contain" />
                </div>
                <span className="text-sm font-bold" style={{ color: myTeam.colorLight }}>MY TEAM</span>
              </div>

              {/* Score */}
              <div className="flex items-center justify-between">
                <div className="flex flex-col items-center gap-1">
                  <div className="w-12 h-12 rounded-full bg-white p-1 flex items-center justify-center">
                    <Image src={getTeamLogo(myTeamGame.awayTeamId)} alt="" width={32} height={32} unoptimized className="object-contain" />
                  </div>
                  <span className="text-sm font-bold" style={{ color: getTeamColor(myTeamGame.awayTeamId) }}>{getTeamShortName(myTeamGame.awayTeamId)}</span>
                </div>
                <div className="text-center">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl font-black tabular-nums text-text-primary">{myTeamGame.status === "scheduled" ? "-" : myTeamGame.awayScore}</span>
                    <span className="text-sm text-text-tertiary">:</span>
                    <span className="text-2xl font-black tabular-nums text-text-primary">{myTeamGame.status === "scheduled" ? "-" : myTeamGame.homeScore}</span>
                  </div>
                  <span className={`text-xs font-semibold mt-1 px-2 py-0.5 rounded-full ${
                    myTeamGame.status === "live" ? "bg-red-500/20 text-red-400 animate-pulse" :
                    myTeamGame.status === "final" ? "bg-text-tertiary/20 text-text-tertiary" :
                    "bg-accent/20 text-accent"
                  }`}>
                    {myTeamGame.status === "live" ? `LIVE ${myTeamGame.inning}` : myTeamGame.status === "final" ? "경기 종료" : myTeamGame.time}
                  </span>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <div className="w-12 h-12 rounded-full bg-white p-1 flex items-center justify-center">
                    <Image src={getTeamLogo(myTeamGame.homeTeamId)} alt="" width={32} height={32} unoptimized className="object-contain" />
                  </div>
                  <span className="text-sm font-bold" style={{ color: getTeamColor(myTeamGame.homeTeamId) }}>{getTeamShortName(myTeamGame.homeTeamId)}</span>
                </div>
              </div>
            </div>
          </Link>
        </div>
      )}

      {/* ===== News Carousel ===== */}
      <div className="mb-3">
        <LiveGameBanner />

        <h2 className="text-lg font-bold text-text-primary mb-3">📰 내 팀 뉴스</h2>
        <div className="-mx-5"><NewsCarousel news={realNews.length > 0 ? realNews.slice(0, 10) : (myTeamId ? [...MOCK_NEWS.filter(n => n.teamId === myTeamId), ...MOCK_NEWS.filter(n => n.teamId !== myTeamId)].slice(0, 10) : MOCK_NEWS)} /></div>

        {/* 하이라이트 영상 */}
        <HomeHighlights team={myTeamId ? TEAMS.find(t => t.id === myTeamId)?.shortName || null : null} />

      {favPlayers.length > 0 && (
        <div>
          <SectionHeader title="⭐ 나의 최애 선수" />
          <div className="flex gap-3 overflow-x-auto hide-scrollbar pb-2">
            {favPlayers.map((player) => {
              const team = getTeamById(player.teamId);
              // Mock 최근 스탯 추이
              const mockTrend = {
                p1: { avg: ".312", recent: "5경기 8타수 4안타", trend: "🔥", hr: 32, rbi: 85 },
                p4: { avg: ".334", recent: "5경기 9타수 5안타", trend: "🔥🔥", hr: 36, rbi: 100 },
                p10: { avg: ".298", recent: "5경기 7타수 2안타", trend: "📉", hr: 20, rbi: 68 },
                p2: { avg: "", recent: "최근 7이닝 1실점", trend: "🔥", hr: 0, rbi: 0, era: "2.89", wins: 17 },
                p5: { avg: "", recent: "최근 8이닝 무실점", trend: "🔥🔥", hr: 0, rbi: 0, era: "2.45", wins: 14 },
              } as Record<string, any>;
              const stats = mockTrend[player.playerId] ?? {
                avg: (0.260 + Math.random() * 0.06).toFixed(3),
                recent: "5경기 활약 중",
                trend: Math.random() > 0.5 ? "🔥" : "→",
                hr: Math.floor(Math.random() * 25) + 5,
                rbi: Math.floor(Math.random() * 60) + 20,
              };
              const isPitcher = player.position === "투수";
              return (
                <Link key={player.playerId} href={`/boards/players/${player.playerId}`}>
                  <div
                    className="min-w-[160px] rounded-2xl p-3 flex flex-col items-center gap-2"
                    style={{ background: `linear-gradient(135deg, ${team?.colorPrimary}20, ${team?.colorPrimary}08)` }}
                  >
                    <PlayerAvatar
                      name={player.name}
                      teamId={player.teamId}
                      photoUrl={getPlayerPhotoUrl(player.name)}
                      number={player.number}
                      size={56}
                    />
                    <div className="text-center">
                      <p className="text-sm font-bold text-text-primary">{player.name}</p>
                      <p className="text-[10px] text-text-tertiary">#{player.number} {player.position}</p>
                    </div>
                    <div className="w-full space-y-1">
                      {isPitcher ? (
                        <>
                          <div className="flex justify-between text-xs">
                            <span className="text-text-tertiary">ERA</span>
                            <span className="font-bold text-text-primary">{stats.era ?? "3.20"}</span>
                          </div>
                          <div className="flex justify-between text-xs">
                            <span className="text-text-tertiary">승</span>
                            <span className="font-bold text-text-primary">{stats.wins ?? 10}</span>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="flex justify-between text-xs">
                            <span className="text-text-tertiary">타율</span>
                            <span className="font-bold text-text-primary">{stats.avg}</span>
                          </div>
                          <div className="flex justify-between text-xs">
                            <span className="text-text-tertiary">HR/RBI</span>
                            <span className="font-bold text-text-primary">{stats.hr}/{stats.rbi}</span>
                          </div>
                        </>
                      )}
                    </div>
                    <div className="text-[10px] text-text-tertiary text-center">
                      {stats.trend} {stats.recent}
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}

            </div>

      {/* ===== 1. Today's Games — horizontal scroll with snap ===== */}
      <motion.section variants={item} className="mb-6">
        <SectionHeader title={isPreseason ? "오늘의 시범경기" : "오늘의 경기"} href="/games" icon="⚾" />
        <div className="flex snap-x snap-mandatory gap-4 overflow-x-auto hide-scrollbar -mx-5 px-5">
          {todayGames.map((game) => (
            <Link key={game.id} href={`/games/${game.id}`}>
              <GlassCard pressable className="w-[220px] h-[190px] flex-shrink-0 snap-start p-5 flex flex-col justify-between">
                <StatusBadge status={game.status} inning={game.inning} />
                <div className="flex items-center justify-between flex-1">
                  <div className="flex flex-col items-center gap-1 flex-1">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white p-1">
                      <Image src={getTeamLogo(game.awayTeamId)} alt={getTeamName(game.awayTeamId)} width={24} height={24} unoptimized className="object-contain" />
                    </div>
                    <span className="text-sm font-bold" style={{ color: getTeamColor(game.awayTeamId) }}>
                      {getTeamShortName(game.awayTeamId)}
                    </span>
                    <span className="text-lg font-bold tabular-nums text-text-primary">{game.status === "scheduled" ? "-" : game.awayScore}</span>
                  </div>
                  <span className="text-xs text-text-tertiary">vs</span>
                  <div className="flex flex-col items-center gap-1 flex-1">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white p-1">
                      <Image src={getTeamLogo(game.homeTeamId)} alt={getTeamName(game.homeTeamId)} width={24} height={24} unoptimized className="object-contain" />
                    </div>
                    <span className="text-sm font-bold" style={{ color: getTeamColor(game.homeTeamId) }}>
                      {getTeamShortName(game.homeTeamId)}
                    </span>
                    <span className="text-lg font-bold tabular-nums text-text-primary">{game.status === "scheduled" ? "-" : game.homeScore}</span>
                  </div>
                </div>
                <p className="text-center text-xs text-text-tertiary">
                  {isPreseason && <span className="text-yellow-500 font-medium">시범 · </span>}{game.time} · {game.stadium}
                </p>

              </GlassCard>
            </Link>
          ))}
        </div>
      </motion.section>

      {/* ===== 2. Prediction Preview ===== */}
      <motion.section variants={item} className="mb-6">
        <SectionHeader title="승부예측" href="/predict/daily" icon="🔮" />
        <div className="space-y-4">
          {previewPredictions.map((pred) => (
            <Link key={pred.gameId} href={`/games/${pred.gameId}/predict`}>
              <GlassCard pressable className="p-4">
                <div className="flex items-center justify-between text-sm font-semibold">
                  <span className="flex items-center gap-2" style={{ color: getTeamColor(pred.awayTeamId) }}>
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white p-0.5">
                      <Image src={getTeamLogo(pred.awayTeamId)} alt={getTeamName(pred.awayTeamId)} width={22} height={22} unoptimized className="object-contain" />
                    </span>
                    {getTeamShortName(pred.awayTeamId)}
                  </span>
                  <span className="text-xs text-text-tertiary">vs</span>
                  <span className="flex items-center gap-2" style={{ color: getTeamColor(pred.homeTeamId) }}>
                    {getTeamShortName(pred.homeTeamId)}
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white p-0.5">
                      <Image src={getTeamLogo(pred.homeTeamId)} alt={getTeamName(pred.homeTeamId)} width={22} height={22} unoptimized className="object-contain" />
                    </span>
                  </span>
                </div>
                {/* Prediction bar */}
                <div className="mt-2 flex h-2.5 overflow-hidden rounded-full">
                  <motion.div
                    className="rounded-l-full"
                    initial={{ width: 0 }}
                    animate={{ width: `${pred.awayPercent}%` }}
                    transition={{ duration: 0.8, ease: "easeOut" }}
                    style={{ backgroundColor: getTeamBgColor(pred.awayTeamId) }}
                  />
                  <motion.div
                    className="rounded-r-full"
                    initial={{ width: 0 }}
                    animate={{ width: `${pred.homePercent}%` }}
                    transition={{ duration: 0.8, ease: "easeOut", delay: 0.1 }}
                    style={{ backgroundColor: getTeamBgColor(pred.homeTeamId) }}
                  />
                </div>
                <div className="mt-1.5 flex justify-between text-xs text-text-tertiary">
                  <span className="font-semibold" style={{ color: getTeamColor(pred.awayTeamId) }}>
                    {getTeamShortName(pred.awayTeamId)} {pred.awayPercent}%
                  </span>
                  <span className="flex items-center gap-1">
                    <Users size={20} />
                    {pred.totalVotes.toLocaleString()}명
                  </span>
                  <span className="font-semibold" style={{ color: getTeamColor(pred.homeTeamId) }}>
                    {pred.homePercent}% {getTeamShortName(pred.homeTeamId)}
                  </span>
                </div>
              </GlassCard>

            </Link>
          ))}
        </div>
      </motion.section>

      {/* ===== 4. Popular Posts ===== */}
      <motion.section variants={item} className="mb-6">
        <SectionHeader title="인기글" href="/teams" icon="🔥" />
        <div className="space-y-3">
          {MOCK_POPULAR_POSTS.map((post, i) => (
            <GlassCard key={post.id} pressable className="p-4">
              <div className="flex items-center gap-3">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent/10 text-sm font-bold text-accent">
                  {i + 1}
                </span>
                <TeamBadge teamId={post.teamId} size="xs" />
                <span className="flex-1 truncate text-sm text-text-primary">{post.title}</span>
              </div>
              <div className="mt-1 flex items-center gap-4 pl-9 text-xs text-text-tertiary">
                <span>{post.author}</span>
                <span>❤️ {post.likeCount}</span>
                <span>💬 {post.commentCount}</span>
              </div>
            </GlassCard>
          ))}
        </div>
      </motion.section>



      {/* ===== 4.5 My Favorite Players ===== */}
            {/* ===== 5. Hot Player Boards ===== */}
      <motion.section variants={item} className="mb-6">
        <SectionHeader title="인기 선수게시판" href="/players" icon="⭐" />
        <GlassCard className="p-4">
          <div className="space-y-8">
            {MOCK_HOT_PLAYER_BOARDS.map((player, i) => (
              <Link key={player.playerId} href={`/boards/players/${player.playerId}`}><div className="flex items-center gap-4">
                <span className={`flex h-7 w-7 items-center justify-center rounded-full text-sm font-bold ${
                  i === 0 ? "bg-yellow-500/20 text-yellow-400" :
                  i === 1 ? "bg-gray-400/20 text-gray-300" :
                  i === 2 ? "bg-amber-700/20 text-amber-600" :
                  "bg-bg-tertiary text-text-tertiary"
                }`}>
                  {i + 1}
                </span>
                <PlayerAvatar name={player.name} teamId={player.teamId} photoUrl={getPlayerPhotoUrl(player.name)} size={64} />
                <div className="flex-1 min-w-0 whitespace-nowrap">
                  <span className="text-sm font-semibold text-text-primary">{player.name}</span>
                  <span className="ml-1.5 text-xs text-text-tertiary">{player.teamName}</span>
                </div>
                <div className="text-right">
                  <div className="text-sm font-bold text-accent">오늘 {player.postsToday}글</div>
                  <div className="text-xs text-text-tertiary">총 {player.totalPosts.toLocaleString()}글</div>
                </div>
                <span className="text-base">
                  {player.trend === "up" ? "🔥" : player.trend === "down" ? "📉" : "➖"}
                </span>
              </div></Link>
            ))}
                <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />
    </div>
        </GlassCard>
      </motion.section>
      {/* Bottom spacer */}
      <div className="h-4" />
    </motion.div>

      {/* AI Analysis Modal */}
      <TeamSelectModal isOpen={showOnboarding} onSelect={handleTeamSelect} />
      <PlayerSelectModal
        isOpen={showPlayerSelect}
        teamId={myTeamId ?? 1}
        onComplete={handlePlayerSelect}
        onSkip={() => setShowPlayerSelect(false)}
      />

      {aiGame && (
        <AIAnalysis
          isOpen={true}
          onClose={() => setAiGame(null)}
          awayTeamId={aiGame.awayTeamId}
          homeTeamId={aiGame.homeTeamId}
        />
      )}
    </>
  );
}
