"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Bell, ChevronRight, Crosshair, Flame, User, Users } from "lucide-react";
import Link from "next/link";
import Image from "next/image";
import GlassCard from "@/components/ui/GlassCard";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import AIAnalysis from "@/components/game/AIAnalysis";
import OnboardingFlow from "@/components/onboarding/OnboardingFlow";
import PlayerSelectModal from "@/components/onboarding/PlayerSelectModal";
import { useAuth } from "@/lib/supabase/AuthContext";
import { updateProfile } from "@/lib/supabase/auth";
import LoginSheet from "@/components/auth/LoginSheet";
import { PRESEASON_GAMES, PRESEASON_DATES } from "@/lib/constants/preseason-schedule";
import { getFavoritePlayers, setFavoritePlayers, type FavoritePlayer } from "@/lib/store/favorites";
import { getMyTeamId, setMyTeamId as saveMyTeamId } from "@/lib/store/myteam";
import { getOnboardingStatus, isOnboardingDone, needsPlayerSetup, setOnboardingStatus } from "@/lib/store/onboarding";
import { trackEvent, OnboardingEvents } from "@/lib/analytics";
import NewsCarousel from "@/components/news/NewsCarousel";
import HomeHighlights from "@/components/home/HomeHighlights";
import HomeOfficialVideos from "@/components/home/HomeOfficialVideos";
import LiveGameBanner from "@/components/home/LiveGameBanner";
import PWAInstallBanner from "@/components/ui/PWAInstallBanner";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import TeamBadge from "@/components/ui/TeamBadge";
import { TEAMS, getTeamById } from "@/lib/constants/teams";
import { getAvatarPath } from "@/lib/constants/avatars";
import { MOCK_NEWS } from "@/lib/constants/news";
import type { User as SupabaseUser } from "@supabase/supabase-js";
import { getTeamBorderColorById } from "@/lib/utils/team-border-color";

interface AuthProfile {
  nickname: string;
  team_id: number;
  favorite_players: FavoritePlayer[];
  points: number;
  grade: string;
  avatar_url: string | null;
}

interface NewsItem {
  title: string;
  link: string;
  pubDate: string;
  _label?: string;
}

interface RawGameData {
  gameId: string;
  homeTeamId: number;
  awayTeamId: number;
  time: string;
  stadium: string;
  homeScore?: number;
  awayScore?: number;
  status: string;
  inning?: string;
  isTop?: boolean;
}

interface HomeGame {
  id: string;
  homeTeamId: number;
  awayTeamId: number;
  time: string;
  stadium: string;
  homeScore: number;
  awayScore: number;
  status: "scheduled" | "live" | "final";
  inning: string | null;
}

interface HomeNewsItem {
  id: number;
  title: string;
  link: string;
  pubDate: string;
  label: string;
  source: string;
  sourceUrl: string;
  thumbnailUrl: null;
  timeAgo: string;
  teamId: number | null;
  type: "news";
}

interface PlayerMockStats {
  avg: string;
  recent: string;
  trend: string;
  hr: number;
  rbi: number;
  era?: string;
  wins?: number;
}

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

function HeaderAvatar({ user, profile }: { user: SupabaseUser | null; profile: AuthProfile | null }) {
  if (!user || !profile) {
    return <User size={22} className="text-text-secondary" />;
  }

  const avatarPath = getAvatarPath(profile.avatar_url);
  const initial = profile.nickname?.charAt(0) || '?';
  const bgColor = profile.team_id ? (TEAMS.find(t => t.id === profile.team_id)?.colorPrimary ?? '#6366f1') : '#6366f1';

  if (avatarPath) {
    return (
      <img
        src={avatarPath}
        alt=""
        className="w-[22px] h-[22px] rounded-full object-cover"
      />
    );
  }

  return (
    <div
      className="w-[22px] h-[22px] rounded-full flex items-center justify-center text-[11px] font-bold text-white"
      style={{ backgroundColor: bgColor }}
    >
      {initial}
    </div>
  );
}

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

/** Section heading: 18/26/600 — 절대 변경 금지 (design-tokens-v0.md 참고) */
function SectionHeader({ title, href, icon }: { title: string; href?: string; icon?: string }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="flex items-center gap-2 text-lg leading-[26px] font-semibold text-text-primary">
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


// 시범경기/정규시즌 날짜 기준
const REGULAR_SEASON_START = new Date("2026-03-28");
const PRESEASON_START = new Date("2026-03-12");

export default function HomePage() {
  const [aiGame, setAiGame] = useState<{awayTeamId: number; homeTeamId: number} | null>(null);
  const [myTeamId, setMyTeam] = useState<number | null>(null);
  const [realNews, setRealNews] = useState<HomeNewsItem[]>([]);

  useEffect(() => {
    const team = myTeamId ? TEAMS.find(t => t.id === myTeamId)?.shortName : "";
    let favPlayers = getFavoritePlayers().slice(0, 5);
    
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
            items: (d.items || []).map((item: NewsItem) => ({ ...item, _label: team })),
          }))
        : Promise.resolve({ items: [] }),
      ...favPlayers.map(p => {
        const pTeam = TEAMS.find(t => t.id === p.teamId);
        const pTeamName = pTeam ? `${pTeam.shortName} ${pTeam.name}` : "";
        return fetch(`/api/news?q=${encodeURIComponent(`${pTeamName} ${p.name}`)}`).then(r => r.json()).then(d => ({
          items: (d.items || []).map((item: NewsItem) => ({ ...item, _label: p.name })),
        }));
      })
    ];
    
    Promise.all(queries).then(results => {
      const teamItems = results[0]?.items || [];
      const playerResults = results.slice(1);
      
      // 선수별 균등 분배 (각 2개씩 먼저, 남은 슬롯은 라운드로빈)
      const seen = new Set();
      const dedupArr = (items: NewsItem[]) => items.filter((item: NewsItem) => {
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
      unique.sort((a: NewsItem, b: NewsItem) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());

      if (unique.length) {
          setRealNews(unique.map((item: NewsItem, i: number) => ({
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
            thumbnailUrl: null,
            type: "news" as const,
            teamId: myTeamId || null,
          })));
        }
      }).catch(console.error);
  }, [myTeamId]);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showPlayerSelect, setShowPlayerSelect] = useState(false);
  const [showPlayerSetupCTA, setShowPlayerSetupCTA] = useState(false);
  const { user, profile, loading } = useAuth();
  const [welcomeToast, setWelcomeToast] = useState(false);

  // 로그인 후 1회 환영 토스트
  useEffect(() => {
    if (user && profile?.nickname) {
      const key = `welcome_shown_${user.id}`;
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, '1');
        setWelcomeToast(true);
        setTimeout(() => setWelcomeToast(false), 3000);
      }
    }
  }, [user, profile]);

  // 오늘의 경기 (API + 시범경기 fallback)
  const [todayGames, setTodayGames] = useState<HomeGame[]>([]);
  const [isPreseason, setIsPreseason] = useState(false);
  useEffect(() => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;
    const yyyymmdd = dateStr.replace(/-/g, "");
    
    fetch(`/api/games?date=${yyyymmdd}`)
      .then(r => r.json())
      .then(data => {
        const games: HomeGame[] = (data.games ?? []).map((g: RawGameData) => ({
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
    // auth/session 로딩이 끝난 뒤에만 홈 초기화
    if (loading) return;

    // 매번 CTA 상태를 먼저 초기화하고, 필요한 케이스에서만 다시 켠다.
    setShowPlayerSetupCTA(false);

    // 로그인 유저 + DB에 팀 있음 → localStorage 상태와 무관하게 온보딩 스킵 (PWA 재설치 대응)
    if (profile && profile.team_id) {
      const dbFavs = Array.isArray(profile.favorite_players) ? profile.favorite_players : [];
      setMyTeam(profile.team_id);
      setFavPlayers(dbFavs);
      setOnboardingStatus(dbFavs.length ? "completed" : "skipped");
      setShowOnboarding(false);
      if (dbFavs.length === 0) {
        setShowPlayerSetupCTA(true);
      }
      return;
    }

    const saved = getMyTeamId();
    const savedFavs = getFavoritePlayers();
    const rawStatus = typeof window !== "undefined" ? localStorage.getItem("kbo-onboarding-status") : null;
    const status = getOnboardingStatus();

    if (saved && (status === "completed" || status === "skipped")) {
      // 온보딩 완료/스킵 → 정상 홈
      setMyTeam(saved);
      setFavPlayers(savedFavs);
      setShowOnboarding(false);
      if (status === "skipped" || savedFavs.length === 0) {
        setShowPlayerSetupCTA(true);
      }
      return;
    }

    if (saved && status === "team_selected") {
      // 팀 선택 후 이탈 → 온보딩 이어하기 (선수 선택부터)
      setMyTeam(saved);
      setFavPlayers(savedFavs);
      setShowOnboarding(true);
      return;
    }

    if (saved && rawStatus === null) {
      // 기존 유저/스토리지 유실 복구: 팀은 있는데 onboarding key만 없는 경우
      setMyTeam(saved);
      setFavPlayers(savedFavs);
      const recoveredStatus = savedFavs.length > 0 ? "completed" : "skipped";
      setOnboardingStatus(recoveredStatus);
      setShowOnboarding(false);
      if (savedFavs.length === 0) {
        setShowPlayerSetupCTA(true);
      }
      return;
    }

    if (user && !profile) {
      // 로그인은 살아있지만 프로필 로드/생성이 아직 안 된 상태.
      // ProfileSetupWrapper가 모달을 띄우므로 홈 온보딩은 열지 않는다.
      setShowOnboarding(false);
      return;
    }

    // 비로그인 첫 방문 → 온보딩 시작
    setShowOnboarding(true);
  }, [loading, user, profile]);

  function handleOnboardingComplete(teamId: number, players: FavoritePlayer[]) {
    setMyTeam(teamId);
    setFavPlayers(players);
    setShowOnboarding(false);
    if (players.length === 0) {
      setShowPlayerSetupCTA(true);
    }
  }

  function handlePlayerSelect(players: FavoritePlayer[]) {
    setFavoritePlayers(players);
    setFavPlayers(players);
    setShowPlayerSelect(false);
    setShowPlayerSetupCTA(false);
    setOnboardingStatus("completed");
    // 로그인 상태면 DB에도 동기화
    if (user) {
      updateProfile(user.id, { favorite_players: players });
    }
    trackEvent(OnboardingEvents.PLAYER_SELECTED, {
      player_count: players.length,
      player_ids: players.map(p => p.playerId),
    });
    trackEvent(OnboardingEvents.ONBOARDING_COMPLETE, {
      team_id: myTeamId,
      player_count: players.length,
      upgraded_from_skip: true,
    });
  }

  const myTeam = myTeamId ? getTeamById(myTeamId) : null;
  const myTeamGame = todayGames.find(g => g.homeTeamId === myTeamId || g.awayTeamId === myTeamId);
  // Show first 3 news
  const previewNews = MOCK_NEWS.slice(0, 3);

  return (
    <>
    {/* 환영 토스트 */}
    <AnimatePresence>
      {welcomeToast && (
        <motion.div
          initial={{ opacity: 0, y: -40 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -40 }}
          className="fixed top-14 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-2xl bg-bg-secondary border border-white/10 shadow-lg"
        >
          <p className="text-sm font-medium text-text-primary">👋 {profile?.nickname}님 환영합니다!</p>
        </motion.div>
      )}
    </AnimatePresence>

    <motion.div
      variants={container}
      initial="hidden"
      animate="show"
      className="mx-auto max-w-lg px-5"
    >
      {/* Header */}
      <motion.header variants={item} className="flex items-center justify-between py-3 border-b mb-2" style={{ borderColor: myTeamId ? getTeamBorderColorById(myTeamId) : 'var(--color-border)' }}>
        <div className="flex flex-col">
          <img src="/logo-mark.png" alt="크보팬" style={{height: "44px", objectFit: "contain"}} className="-ml-0.5" />
        </div>
        <div className="flex items-center gap-1">
          <button className="rounded-full p-2 text-text-secondary hover:bg-bg-tertiary transition-colors">
            <Bell size={22} />
          </button>
          <Link href="/my" className="rounded-full p-2 hover:bg-bg-tertiary transition-colors">
            <HeaderAvatar user={user} profile={profile} />
          </Link>
        </div>
      </motion.header>

      {/* PWA 설치 배너 (인라인, 홈에서만) */}
      <PWAInstallBanner />

      {/* 스킵 유저: 최애선수 설정 CTA (헤더 바로 아래) */}
      {showPlayerSetupCTA && myTeamId && (
        <motion.div variants={item} className="mb-3">
          <button
            onClick={() => setShowPlayerSelect(true)}
            className="w-full p-4 rounded-2xl flex items-center gap-3 transition-colors"
            style={{ 
              background: `${getTeamBgColor(myTeamId)}12`,
              border: `1px solid ${getTeamColor(myTeamId)}20`,
            }}
          >
            <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: `${getTeamBgColor(myTeamId)}25` }}>
              <span className="text-lg">⭐</span>
            </div>
            <div className="flex-1 text-left">
              <p className="text-[15px] leading-[22px] font-medium text-text-primary">최애선수 설정하고 홈을 꾸며보세요</p>
              <p className="text-xs leading-[18px] text-text-tertiary mt-0.5">선수 소식/기록을 더 잘 추천해드려요</p>
            </div>
            <ChevronRight size={18} className="text-text-tertiary" />
          </button>
        </motion.div>
      )}

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
                <span className="text-xs leading-[18px] font-semibold tracking-wide" style={{ color: myTeam.colorLight }}>MY TEAM</span>
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

        <h2 className="text-lg leading-[26px] font-semibold text-text-primary mb-3">📰 내 팀, 최애선수 관련 뉴스</h2>
        <div className="-mx-5"><NewsCarousel news={realNews.length > 0 ? realNews.slice(0, 10) : (myTeamId ? [...MOCK_NEWS.filter(n => n.teamId === myTeamId), ...MOCK_NEWS.filter(n => n.teamId !== myTeamId)].slice(0, 10) : MOCK_NEWS)} /></div>

      {/* 최애선수 카드 (뉴스 아래, 숏츠 위) */}
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
              } as Record<string, PlayerMockStats>;
              /* eslint-disable react-hooks/purity */
              const stats = mockTrend[player.playerId] ?? {
                avg: (0.260 + Math.random() * 0.06).toFixed(3),
                recent: "5경기 활약 중",
                trend: Math.random() > 0.5 ? "🔥" : "→",
                hr: Math.floor(Math.random() * 25) + 5,
                rbi: Math.floor(Math.random() * 60) + 20,
              };
              /* eslint-enable react-hooks/purity */
              const isPitcher = player.position === "투수";
              return (
                <Link key={player.playerId} href={`/community/players/${player.playerId}`}>
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
                      <p className="text-[15px] leading-[22px] font-medium text-text-primary">{player.name}</p>
                      <p className="text-xs leading-[18px] text-text-tertiary">#{player.number} {player.position}</p>
                    </div>
                    <div className="w-full space-y-1">
                      {isPitcher ? (
                        <>
                          <div className="flex justify-between text-xs leading-[18px]">
                            <span className="text-text-tertiary">ERA</span>
                            <span className="font-medium tabular-nums text-text-primary">{stats.era ?? "3.20"}</span>
                          </div>
                          <div className="flex justify-between text-xs leading-[18px]">
                            <span className="text-text-tertiary">승</span>
                            <span className="font-medium tabular-nums text-text-primary">{stats.wins ?? 10}</span>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="flex justify-between text-xs leading-[18px]">
                            <span className="text-text-tertiary">타율</span>
                            <span className="font-medium tabular-nums text-text-primary">{stats.avg}</span>
                          </div>
                          <div className="flex justify-between text-xs leading-[18px]">
                            <span className="text-text-tertiary">HR/RBI</span>
                            <span className="font-medium tabular-nums text-text-primary">{stats.hr}/{stats.rbi}</span>
                          </div>
                        </>
                      )}
                    </div>
                    <div className="text-xs leading-[18px] text-text-tertiary text-center">
                      {stats.trend} {stats.recent}
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}

        {/* 하이라이트 영상 */}
        <HomeHighlights team={myTeamId ? TEAMS.find(t => t.id === myTeamId)?.shortName || null : null} />
        <HomeOfficialVideos team={myTeamId ? TEAMS.find(t => t.id === myTeamId)?.shortName || null : null} />

            </div>

      {/* ===== 1. Today's Games (퀵버튼 위 — fold 안에 노출) ===== */}
      <motion.section variants={item} className="mb-6">
        <SectionHeader title={isPreseason ? "오늘의 시범경기" : "오늘의 경기"} href="/games" icon="⚾" />
        {todayGames.length > 0 && !todayGames[0]?.id?.startsWith("placeholder") ? (
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
        ) : (
          <GlassCard className="p-6 text-center">
            <p className="text-2xl mb-2">⚾</p>
            {/* eslint-disable react-hooks/purity */}
            {new Date() < PRESEASON_START ? (
              <>
                <p className="text-[15px] font-medium text-text-primary">시범경기 D-{Math.ceil((PRESEASON_START.getTime() - Date.now()) / 86400000)}</p>
                <p className="text-xs text-text-tertiary mt-1">3월 12일 시범경기 시작!</p>
              </>
            ) : new Date() < REGULAR_SEASON_START ? (
              <>
                <p className="text-[15px] font-medium text-text-primary">오늘은 경기가 없습니다</p>
                <p className="text-xs text-text-tertiary mt-1">시범경기 진행중 · 개막 D-{Math.ceil((REGULAR_SEASON_START.getTime() - Date.now()) / 86400000)}</p>
              </>
            ) : (
              <>
                <p className="text-[15px] font-medium text-text-primary">오늘은 경기가 없습니다</p>
                <p className="text-xs text-text-tertiary mt-1">내일 경기를 기대해주세요!</p>
              </>
            )}
            {/* eslint-enable react-hooks/purity */}
          </GlassCard>
        )}
      </motion.section>

      {/* 퀵액션 버튼 */}
      <motion.div variants={item} className="flex gap-3 mb-6">
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
      </motion.div>

      {/* ===== 2. Prediction Entry Cards (목데이터 — 실데이터 연결 후 복원) ===== */}
      {/* <motion.section variants={item} className="mb-6">
        <Link href="/predict">
          <div className="flex h-20 items-center rounded-2xl bg-gradient-to-r from-accent/20 to-accent/5 px-5 mb-4">
            <div className="flex-1">
              <p className="text-[15px] leading-[22px] font-medium text-text-primary">🏆 2026 시즌예측</p>
              <p className="text-xs leading-[18px] text-text-tertiary">MVP, 우승팀을 예측하세요!</p>
            </div>
            <ChevronRight size={20} className="text-text-tertiary" />
          </div>
        </Link>
        <Link href="/predict/daily">
          <GlassCard pressable className="p-4">
            <div className="flex items-center gap-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10">
                <Crosshair size={22} className="text-accent" />
              </div>
              <div className="flex-1">
                <p className="text-[15px] leading-[22px] font-medium text-text-primary">적중률 68% · 12승 6패</p>
                <p className="text-xs leading-[18px] text-text-tertiary">승부예측 하러가기 →</p>
              </div>
            </div>
          </GlassCard>
        </Link>
      </motion.section> */}

      {/* ===== 4. Popular Posts (목데이터 — 실데이터 연결 후 복원) ===== */}
      {/* <motion.section variants={item} className="mb-6">
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
      </motion.section> */}



      {/* ===== 4.5 My Favorite Players ===== */}
      {/* ===== 5. Hot Player Boards (목데이터 — 실데이터 연결 후 복원) ===== */}
      {/* <motion.section variants={item} className="mb-6">
        <SectionHeader title="인기 선수게시판" href="/players" icon="⭐" />
        <GlassCard className="p-4">
          <div className="space-y-8">
            {MOCK_HOT_PLAYER_BOARDS.map((player, i) => (
              <Link key={player.playerId} href={`/community/players/${player.playerId}`}><div className="flex items-center gap-4">
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
                  <span className="text-[15px] leading-[22px] font-medium text-text-primary">{player.name}</span>
                  <span className="ml-1.5 text-xs leading-[18px] text-text-tertiary">{player.teamName}</span>
                </div>
                <div className="text-right">
                  <div className="text-sm font-medium tabular-nums text-accent">오늘 {player.postsToday}글</div>
                  <div className="text-xs leading-[18px] text-text-tertiary">총 {player.totalPosts.toLocaleString()}글</div>
                </div>
                <span className="text-base">
                  {player.trend === "up" ? "🔥" : player.trend === "down" ? "📉" : "➖"}
                </span>
              </div></Link>
            ))}
          </div>
        </GlassCard>
      </motion.section> */}
                <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />
      {/* Bottom spacer */}
      <div className="h-4" />
    </motion.div>

      {/* Onboarding Flow */}
      {showOnboarding && (
        <OnboardingFlow onComplete={handleOnboardingComplete} />
      )}
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
        />
      )}
    </>
  );
}
