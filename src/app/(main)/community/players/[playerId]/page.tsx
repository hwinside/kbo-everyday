"use client";

import { useState, useEffect, useCallback } from "react";
import { useSafeBack } from "@/lib/hooks/useSafeBack";
import { useParams, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { ArrowLeft, Share2, PenLine } from "lucide-react";
import Link from "next/link";
import HeaderProfileLink from "@/components/ui/HeaderProfileLink";
import { getTeamBorderColorById } from "@/lib/utils/team-border-color";
import NicheStats from "@/components/player/NicheStats";
import PlayerGameLogs from "@/components/player/PlayerGameLogs";
import PlayerWeeklyTrend from "@/components/player/PlayerWeeklyTrend";
import PlayerHomeAway from "@/components/player/PlayerHomeAway";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { TEAMS } from "@/lib/constants/teams";
import { createPost, toggleLike } from "@/lib/supabase/usePosts";
import type { Post } from "@/lib/supabase/usePosts";
import { supabase } from "@/lib/supabase/client";
import WritePost from "@/components/community/WritePost";
import WritePhotoPost from "@/components/community/WritePhotoPost";
import WritePoll from "@/components/community/WritePoll";
import WriteEntrySheet from "@/components/community/WriteEntrySheet";
import PhotoFeed from "@/components/community/PhotoFeed";
import { useBadgeCheck } from "@/lib/hooks/useBadgeCheck";
import { useAuth } from "@/lib/supabase/AuthContext";
import LoginSheet from "@/components/auth/LoginSheet";
import CheerSong from "@/components/player/CheerSong";
import PlayerProfile from "@/components/player/PlayerProfile";
import PlayerHero, { buildHeroStats, hasHeroImage, type PlayerRanks } from "@/components/player/PlayerHero";
import { batterWarFromStats, calcPitcherSaber } from "@/lib/utils/sabermetrics-calc";
import PlayerRadar from "@/components/player/PlayerRadar";
import PlayerNews from "@/components/player/PlayerNews";
import { formatPlayerTag } from "@/lib/utils/player-tags";
import { resolvePlayerIdentity } from "@/lib/utils/resolve-player";
import { formatBirthDisplay } from "@/lib/utils/birthdate";
import { getPlayerNationality } from "@/lib/utils/player-nationality";
import CountryFlag from "@/components/player/CountryFlag";

// kboId → player 역매핑 (roster 기반 — 전체 선수 커버)
import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";

interface RawPlayerInfo {
  kboId: string;
  name: string;
  teamId: number;
  backNo: string;
  position: string;
  team: string;
}

interface PlayerData {
  name: string;
  teamId: number;
  number: number;
  position: string;
  team: string;
}

function getTeamColor(teamId: number) {
  return TEAMS.find((t) => t.id === teamId)?.colorLight ?? "#888";
}
function getTeamShortName(teamId: number) {
  return TEAMS.find((t) => t.id === teamId)?.shortName ?? "";
}

function StatItem({ label, value }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="bg-bg-tertiary rounded-xl p-3 text-center">
      <p className="text-xs text-text-tertiary mb-1">{label}</p>
      <p className="text-lg font-bold text-text-primary">{value}</p>
    </div>
  );
}

export default function PlayerBoardPage() {
  const { playerId } = useParams();
  const rawId = playerId as string;
  // ID resolve: 레거시 pN, 외국인 숫자 ID, FP/AQ canonical ID를 단일 resolver로 정규화.
  const resolvedPlayer = resolvePlayerIdentity(rawId);
  const kboId = resolvedPlayer?.kboId ?? rawId;
  const numericKboId = resolvedPlayer?.numericId ?? kboId;
  const playerName = resolvedPlayer?.name;
  // 동명이인 대응: roster에서 canonical kboId로 직접 찾기
  const rosterPlayer = PLAYERS_ROSTER.find((p) => p.kboId === kboId);
  // 생년월일 표시 (roster SSOT의 birthDate 기반, 없으면 null → 미표시)
  const birthText = formatBirthDisplay(rosterPlayer?.birthDate);
  // 외국인·아시아쿼터 선수 국적 (국기+국가명). 내국인은 null → 미표시
  const nationality = getPlayerNationality(kboId);

  const [player, setPlayer] = useState<PlayerData | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter(); // 투표 생성 완료 후 이동(WritePoll onCreated). router 선언은 #914 핫픽스가 단일 owner(main 반영됨).
  const goBack = useSafeBack("/community");
  const [activeTab, setActiveTab] = useState<"stats" | "games" | "board">("stats");
  const [showEntry, setShowEntry] = useState(false);
  const [showWrite, setShowWrite] = useState(false);
  const [showPhoto, setShowPhoto] = useState(false);
  const [showPoll, setShowPoll] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [statSeason, setStatSeason] = useState<2025 | 2026>(2026);
  // 통합 피드: 글·사진 한 스트림 (선수 게시판 직접글 + 다른 게시판에서 이 선수 태그된 글).
  const [feedPosts, setFeedPosts] = useState<Post[]>([]);
  const [feedLoading, setFeedLoading] = useState(true);
  const [realStats, setRealStats] = useState<Record<string, string | number> | null>(null);
  const [playerRanks, setPlayerRanks] = useState<PlayerRanks>({});
  const { user } = useAuth();
  const { checkBadges } = useBadgeCheck();

  // 통합 피드 로드: 선수 게시판 직접글(글·사진) + 다른 게시판에서 이 선수 태그된 글(글·사진).
  // content_type 필터 없음 → 글/사진 한 스트림(전체글/팀 통합 피드와 동일 UX).
  const loadFeed = useCallback(async () => {
    if (!playerName) return;
    setFeedLoading(true);
    // team_tags 는 공개범위 라벨(post-scope SSOT)의 입력이다. 빠지면 다팀 글이 이 피드에서만
    // 선수 소속팀 1개로 축소 표시돼 홈·전체·팀 피드와 어긋난다(삼순 NO-GO 2026-08-06).
    const cols = "id, author_id, board_type, board_id, content_type, title, content, image_urls, video_urls, like_count, comment_count, created_at, is_hidden, game_id, player_tags, team_tags, hashtags, author_team_id_snapshot, click_view_count, impression_view_count, profiles(nickname, team_id, grade, points, avatar_url)";

    // 1) 선수 게시판 직접 게시물 (글·사진 모두)
    const boardQuery = supabase
      .from("posts")
      .select(cols)
      .eq("board_type", "player")
      .eq("board_id", kboId)
      .neq("is_hidden", true)
      .order("created_at", { ascending: false })
      .limit(50);

    // 2) 다른 게시판에서 player_tags로 태그된 게시물 (cross-board, 글·사진 모두)
    const tag = formatPlayerTag(kboId, playerName);
    const tagQuery = supabase
      .from("posts")
      .select(cols)
      // player_tags is JSONB. Pass a JSON string so PostgREST sends
      // cs.["69100:구본혁"] instead of the invalid array literal cs.{69100:구본혁}.
      .contains("player_tags", JSON.stringify([tag]))
      .neq("is_hidden", true)
      .neq("board_type", "player") // 선수 게시판 중복 방지
      .order("created_at", { ascending: false })
      .limit(50);

    const [boardResult, tagResult] = await Promise.all([boardQuery, tagQuery]);
    const boardPosts = boardResult.data ?? [];
    const tagPosts = tagResult.data ?? []; // player_tags 콜론 파싱 에러 시 빈 배열 fallback
    // 중복 제거 후 합치기
    const seen = new Set<number>();
    const merged = [...boardPosts, ...tagPosts].filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
    // 시간순 정렬
    merged.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    setFeedPosts(merged.map((p) => {
      const prof = p.profiles as unknown as Record<string, unknown> | null;
      const snap = (p as Record<string, unknown>).author_team_id_snapshot as number | null | undefined;
      return {
        ...p,
        content_type: (p.content_type ?? "general") as "general" | "photo",
        image_urls: (p.image_urls ?? []) as string[],
        video_urls: ((p as Record<string, unknown>).video_urls ?? []) as string[],
        nickname: prof?.nickname as string | undefined,
        team_id: (snap ?? (prof?.team_id as number | undefined)) as number | undefined,
        avatar_url: prof?.avatar_url as string | undefined,
        grade: prof?.grade as string | undefined,
        points: (prof?.points as number) ?? 0,
        click_view_count: ((p as Record<string, unknown>).click_view_count as number | null | undefined) ?? 0,
        impression_view_count: ((p as Record<string, unknown>).impression_view_count as number | null | undefined) ?? 0,
      };
    }));
    setFeedLoading(false);
  }, [kboId, playerName]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) void loadFeed();
    });
    return () => { cancelled = true; };
  }, [loadFeed]);

  const handleFeedLike = async (postId: number) => {
    try { await toggleLike(postId); } catch { /* ignore */ }
  };

  // KBO 검색 API로 선수 정보 로드
  useEffect(() => {
    if (!playerName) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoading(false);
      return;
    }
    // 개별 선수 조회 (이름 기반)
    fetch(`/api/player-teams?name=${encodeURIComponent(playerName)}${rosterPlayer ? `&team=${encodeURIComponent(rosterPlayer.team)}` : ""}`).then(r => r.json()).then(d => {
      // 동명이인: kboId 일치하는 선수 우선, 없으면 팀 일치, 없으면 첫 번째
      const players = d.players || [];
      const found = players.find((p: RawPlayerInfo) => p.kboId === kboId) || players.find((p: RawPlayerInfo) => rosterPlayer && p.team === rosterPlayer.team) || players[0];
      if (found) {
        setPlayer({
          name: found.name,
          teamId: found.teamId,
          number: parseInt(found.backNo) || 0,
          position: found.position || "",
          team: found.team || "",
        });
      } else {
        setPlayer({ name: playerName, teamId: 0, number: 0, position: "", team: "" });
      }
      setLoading(false);
    }).catch(() => {
      setPlayer({ name: playerName, teamId: 0, number: 0, position: "", team: "" });
      setLoading(false);
    });
  }, [playerName, kboId, rosterPlayer]);

  // 시즌별 스탯 로드
  // 2026: KBO 개별 선수 상세 페이지 크롤링 (현재 시즌, 모든 선수 커버)
  // 2025: static JSON 데이터 (확정)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!player) { setRealStats(null); return; }
    if (statSeason === 2026) {
      // KBO 개별 선수 상세 페이지 크롤링 (모든 선수 커버, 상위 30명 제한 없음)
      fetch(`/api/player-stats?id=${kboId}&pos=${encodeURIComponent(player.position)}`)
        .then(r => r.json())
        .then(d => { setRealStats(d.stats || null); })
        .catch(() => { setRealStats(null); });
    } else {
      // 2025: 확정 static JSON
      fetch(`/api/stats?season=2025&type=${player.position === "투수" ? "pitcher" : "batter"}`)
        .then(r => r.json())
        .then(d => {
          const stats = (d.stats || []) as Record<string, string | number>[];
          const found = stats.find((s) => {
            const statId = String(s.kboId || s.playerId);
            return statId === kboId || statId === numericKboId;
          }) || stats.find((s) => s.name === (playerName || player.name));
          setRealStats(found || null);
        })
        .catch(() => { setRealStats(null); });
    }
  }, [statSeason, player, kboId, numericKboId, playerName]);

  // 전체 선수 랭킹: 해당 선수의 종목별 순위 추출 (모든 선수 대상)
  useEffect(() => {
    if (!player || !kboId) {
      void Promise.resolve().then(() => setPlayerRanks({}));
      return;
    }
    const isPitcher = player.position === "투수";
    fetch(`/api/stats?season=2026&type=${isPitcher ? "pitcher" : "batter"}`)
      .then(r => r.json())
      .then(d => {
        const list = (d.stats || []) as Record<string, string | number>[];
        const numOf = (v: string | number | undefined) => {
          if (v == null) return Number.NEGATIVE_INFINITY;
          const n = typeof v === "number" ? v : Number(v);
          return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
        };
        const parseIP = (ip: string | number): number => {
          const s = String(ip).trim();
          const match = s.match(/^(\d+)(?:\s+(\d+)\/(\d+))?$/);
          if (!match) return parseFloat(s) || 0;
          return (parseInt(match[1]) || 0) + (match[2] && match[3] ? parseInt(match[2]) / parseInt(match[3]) : 0);
        };
        // 규정이닝 12+ 필터 (rate stats용)
        const qualified = list.filter(p => parseIP(p.ip || 0) >= 12);
        // 오름차순 (낮을수록 좋은 지표)
        const rankOfAsc = (key: string, pool = qualified): number | undefined => {
          const sorted = [...pool].sort((a, b) => numOf(a[key]) - numOf(b[key]));
          const idx = sorted.findIndex(s => {
            const statId = String(s.kboId || s.playerId);
            return statId === kboId || statId === numericKboId || s.name === player.name;
          });
          return idx === -1 ? undefined : idx + 1;
        };
        // 내림차순 (높을수록 좋은 지표)
        const rankOfDesc = (key: string, pool = list): number | undefined => {
          const sorted = [...pool].sort((a, b) => numOf(b[key]) - numOf(a[key]));
          const idx = sorted.findIndex(s => {
            const statId = String(s.kboId || s.playerId);
            return statId === kboId || statId === numericKboId || s.name === player.name;
          });
          return idx === -1 ? undefined : idx + 1;
        };
        if (isPitcher) {
          // 세이버메트릭스 랭킹: 각 투수의 FIP/WAR/K9 계산 후 순위
          const saberList = qualified.map(p => {
            const saber = calcPitcherSaber({
              era: p.era as string, ip: p.ip as string, so: Number(p.so) || 0,
              bb: Number(p.bb) || 0, hr: Number(p.hr) || 0, hits: Number(p.h) || 0,
              games: Number(p.games) || 0, wins: Number(p.wins) || 0,
              losses: Number(p.losses) || 0, saves: Number(p.saves) || 0,
              whip: p.whip as string,
            });
            return { id: String(p.kboId || p.playerId), name: p.name, ...saber };
          });
          const saberRankAsc = (key: keyof typeof saberList[0]): number | undefined => {
            const sorted = [...saberList].sort((a, b) => (Number(a[key]) || 99) - (Number(b[key]) || 99));
            const idx = sorted.findIndex(s => s.id === kboId || s.id === numericKboId || s.name === player.name);
            return idx === -1 ? undefined : idx + 1;
          };
          const saberRankDesc = (key: keyof typeof saberList[0]): number | undefined => {
            const sorted = [...saberList].sort((a, b) => (Number(b[key]) || -99) - (Number(a[key]) || -99));
            const idx = sorted.findIndex(s => s.id === kboId || s.id === numericKboId || s.name === player.name);
            return idx === -1 ? undefined : idx + 1;
          };
          setPlayerRanks({
            era: rankOfAsc("era"), whip: rankOfAsc("whip"),
            wins: rankOfDesc("wins", list), so: rankOfDesc("so", list),
            saves: rankOfDesc("saves", list), holds: rankOfDesc("holds", list),
            ip: rankOfDesc("ip", qualified),
            fip: saberRankAsc("FIP"), war: saberRankDesc("WAR"), k9: saberRankDesc("K9"),
          });
        } else {
          setPlayerRanks({
            hr: rankOfDesc("hr"), hits: rankOfDesc("hits"), sb: rankOfDesc("sb"),
            avg: rankOfAsc("avg", qualified), rbi: rankOfDesc("rbi"),
          });
        }
      })
      .catch(() => setPlayerRanks({}));
  }, [player, kboId, numericKboId]);

  if (loading) {
    return <div className="flex items-center justify-center h-screen text-text-secondary">로딩 중...</div>;
  }

  if (!player || !playerName) {
    return (
      <div className="flex flex-col items-center justify-center h-screen text-text-secondary gap-2">
        <p>선수를 찾을 수 없습니다</p>
        <Link href="/players" className="text-accent text-sm">선수 목록으로</Link>
      </div>
    );
  }

  const teamColor = getTeamColor(player.teamId);
  const teamBorder = player.teamId ? getTeamBorderColorById(player.teamId) : 'var(--color-border)';

  return (
    <div className="min-h-screen bg-bg-primary pb-20">
      {/* 독립 헤더: 선수 목록과 동일 */}
      <div className="sticky top-0 z-30 bg-bg-primary border-b" style={{ borderColor: teamBorder, paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))", marginTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) * -1)" }}>
        <div className="mx-auto max-w-lg">
          <header className="min-h-[44px] px-5 flex items-center gap-3">
            <button onClick={goBack} aria-label="뒤로가기" className="flex h-11 w-11 items-center justify-center rounded-full text-text-secondary hover:bg-bg-tertiary transition-colors">
              <ArrowLeft size={24} />
            </button>
            <h1 className="text-lg font-bold text-text-primary tracking-tight flex-1">선수</h1>
            <HeaderProfileLink />
          </header>
        </div>
      </div>

      {/* 선수 프로필 헤더 — Hero variant (cutout 있는 선수) 또는 기존 작은 바 */}
      {hasHeroImage(kboId) ? (
        <PlayerHero
          kboId={kboId}
          playerName={player.name}
          teamName={player.team || getTeamShortName(player.teamId) || ""}
          teamBg={teamColor}
          backNo={player.number}
          position={player.position}
          military={(rosterPlayer as { military?: string } | undefined)?.military ?? null}
          birthText={birthText}
          nationality={nationality}
          stats={buildHeroStats(realStats ?? {}, player.position ?? "", playerRanks)}
          showTopBar={false}
        />
      ) : (
        <div
          className="border-b border-border"
          style={{ background: `linear-gradient(135deg, ${teamColor}15, transparent)` }}
        >
          <div className="flex items-center gap-4 px-5 py-4">
            <PlayerAvatar name={player.name} teamId={player.teamId} photoUrl={getPlayerPhotoUrl(player.name, kboId, player.teamId)} number={player.number} size={64} />
            <div className="flex-1">
              <div className="flex items-center gap-3">
                <h1 className="text-lg font-semibold text-text-primary">{player.name}</h1>
                {player.number > 0 && (
                  <span className="text-base px-1.5 py-0.5 rounded-full" style={{ backgroundColor: teamColor + "20", color: teamColor }}>
                    #{player.number}
                  </span>
                )}
              </div>
              <p className="text-base text-text-tertiary">
                {[getTeamShortName(player.teamId) || player.team, player.position].filter(Boolean).join(" · ") || "선수"}
              </p>
              {nationality && (
                <CountryFlag
                  nationality={nationality}
                  size={16}
                  className="mt-0.5 text-sm text-text-tertiary"
                />
              )}
              {birthText && (
                <p className="text-sm text-text-tertiary mt-0.5">{birthText}</p>
              )}
            </div>

            <button onClick={async () => {
              const url = window.location.href;
              if (navigator.share) {
                await navigator.share({ title: `${player.name} - 크보팬`, url });
              } else {
                await navigator.clipboard.writeText(url);
                alert("링크가 복사되었습니다!");
              }
            }}>
              <Share2 className="w-5 h-5 text-text-tertiary" />
            </button>
          </div>
        </div>
      )}

      {/* Tabs (Hero/fallback 공통) */}
      <div className="border-b border-border">
        <div className="flex">
          {((["stats", "games", "board"] as const)).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 py-3 text-base font-medium transition-colors relative ${
                activeTab === tab ? "text-text-primary" : "text-text-tertiary"
              }`}
            >
              {tab === "stats" ? "⚾ 선수정보" : tab === "games" ? "📅 경기별" : "📝 게시판"}
              {activeTab === tab && (
                <motion.div
                  layoutId="board-tab"
                  className="absolute bottom-0 left-0 right-0 h-0.5"
                  style={{ backgroundColor: teamColor }}
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
                />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Stats tab */}
      {activeTab === "stats" && (
        <div className="px-5 py-4">
          <PlayerRadar playerId={kboId} position={player.position} teamColor={teamColor} />
          <PlayerProfile playerName={playerName || player.name} teamColor={teamColor} kboId={kboId} />
          <CheerSong playerName={playerName || player.name} teamColor={teamColor} />

          {/* Season toggle */}
          <div className="flex gap-2 mb-4 mt-2">
            {([2025, 2026] as const).map(y => (
              <button
                key={y}
                onClick={() => setStatSeason(y)}
                className={`px-3 py-1 rounded-full text-sm font-medium transition-all ${
                  statSeason === y ? "bg-accent text-white" : "bg-bg-tertiary text-text-tertiary"
                }`}
              >
                {y}
              </button>
            ))}
          </div>

          {/* 리그 순위 배너 */}
          {statSeason === 2026 && (() => {
            const PITCHER_RANK_CATS = [
              { key: "era", label: "평균자책", asc: true },
              { key: "whip", label: "WHIP", asc: true },
              { key: "wins", label: "승리" },
              { key: "so", label: "탈삼진" },
              { key: "saves", label: "세이브" },
              { key: "holds", label: "홀드" },
              { key: "ip", label: "이닝" },
              { key: "fip", label: "FIP", asc: true },
              { key: "war", label: "WAR" },
              { key: "k9", label: "K/9" },
            ];
            const BATTER_RANK_CATS = [
              { key: "avg", label: "타율" },
              { key: "hr", label: "홈런" },
              { key: "rbi", label: "타점" },
              { key: "hits", label: "안타" },
              { key: "sb", label: "도루" },
            ];
            const cats = player.position === "투수" ? PITCHER_RANK_CATS : BATTER_RANK_CATS;
            const ranks = cats
              .filter(c => playerRanks[c.key as keyof typeof playerRanks] != null && (playerRanks[c.key as keyof typeof playerRanks] ?? 99) <= 20)
              .map(c => ({ ...c, rank: playerRanks[c.key as keyof typeof playerRanks]! }))
              .sort((a, b) => a.rank - b.rank);
            if (ranks.length === 0) return null;
            return (
              <div className="flex gap-2 overflow-x-auto pb-2 mb-3 no-scrollbar">
                {ranks.map(r => (
                  <span
                    key={r.key}
                    className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold ${
                      r.rank <= 3
                        ? "bg-accent/15 text-accent"
                        : "bg-bg-tertiary text-text-secondary"
                    }`}
                  >
                    {r.label} <span className="font-bold">{r.rank}위</span>
                  </span>
                ))}
              </div>
            );
          })()}

          {realStats ? (
            <div className="glass-card p-4 mb-4">
              <h3 className="text-sm font-bold text-text-primary mb-3">{statSeason} 시즌 기록</h3>
              <div className="grid grid-cols-3 gap-3">
                {player.position === "투수" ? (
                  <>
                    <StatItem label="ERA" value={realStats.era} color={teamColor} />
                    <StatItem label="승-패" value={`${realStats.wins}-${realStats.losses}`} color={teamColor} />
                    <StatItem label="이닝" value={realStats.ip} color={teamColor} />
                    <StatItem label="삼진" value={realStats.so} color={teamColor} />
                    <StatItem label="WHIP" value={realStats.whip} color={teamColor} />
                    <StatItem label="피안타" value={realStats.hits} color={teamColor} />
                    <StatItem label="피홈런" value={realStats.hr} color={teamColor} />
                    <StatItem label="볼넷" value={realStats.bb ?? 0} color={teamColor} />
                    <StatItem label="자책" value={realStats.er ?? 0} color={teamColor} />
                    <StatItem label="세이브" value={realStats.saves} color={teamColor} />
                    <StatItem label="홀드" value={realStats.holds ?? 0} color={teamColor} />
                    <StatItem label="경기" value={realStats.games} color={teamColor} />
                    <StatItem label="승률" value={realStats.wpct ?? "-"} color={teamColor} />
                    <StatItem label="완투" value={realStats.cg ?? 0} color={teamColor} />
                    <StatItem label="완봉" value={realStats.sho ?? 0} color={teamColor} />
                  </>
                ) : (
                  <>
                    <StatItem label="타율" value={realStats.avg} color={teamColor} />
                    <StatItem label="홈런" value={realStats.hr} color={teamColor} />
                    <StatItem label="타점" value={realStats.rbi} color={teamColor} />
                    <StatItem label="안타" value={realStats.hits} color={teamColor} />
                    <StatItem label="득점" value={realStats.runs} color={teamColor} />
                    <StatItem label="도루" value={realStats.sb} color={teamColor} />
                    <StatItem label="OPS" value={realStats.ops ?? "-"} color={teamColor} />
                    <StatItem label="볼넷" value={realStats.bb ?? 0} color={teamColor} />
                    <StatItem label="WAR" value={batterWarFromStats(realStats) ?? "-"} color={teamColor} />
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="glass-card p-4 mb-4 text-center text-text-tertiary text-sm">
              {statSeason} 시즌 데이터를 찾을 수 없습니다
            </div>
          )}

          {/* 주간 추이 — 시즌기록 ↔ 세이버메트릭스 사이 (game_logs 2026 한정) */}
          {statSeason === 2026 && (
            <PlayerWeeklyTrend playerId={kboId} position={player.position} teamColor={teamColor} />
          )}

          {/* 홈/원정 — V1.5, game_logs 파생 (2026 한정) */}
          {statSeason === 2026 && (
            <PlayerHomeAway playerId={kboId} position={player.position} teamColor={teamColor} />
          )}

          <NicheStats
            playerId={numericKboId}
            position={player.position}
            teamColor={teamColor}
            playerName={player.name}
            season={statSeason}
            stats={realStats ?? undefined}
          />
          
          {/* 관련 기사 */}
          <div className="px-5">
            <PlayerNews playerName={player.name} teamId={player.teamId} />
          </div>
        </div>
      )}

      {/* 경기별 탭 (선수 스탯 V1 빌드 2) — 2026 시즌 game_logs */}
      {activeTab === "games" && (
        <PlayerGameLogs playerId={kboId} position={player.position} teamColor={teamColor} />
      )}

      {/* 게시판 통합 피드 (글·사진 한 스트림, 최신순 단일) */}
      {activeTab === "board" && (
        <div className="py-2 pb-24">
          <PhotoFeed
            posts={feedPosts}
            loading={feedLoading}
            onLike={handleFeedLike}
            boardType="player"
            // 이 보드 전체가 해당 선수 글 → 작성자 왼쪽 칩을 [(로고)팀 선수명] 단일 칩으로 통일.
            playerLabels={
              player?.teamId && playerName
                ? Object.fromEntries(feedPosts.map((p) => [p.id, { teamId: player.teamId, playerName }]))
                : undefined
            }
          />
        </div>
      )}

      {/* FAB — 게시판 탭에서만 노출 (글·사진 첨부 통합, 밈 에디터/태그는 S5 통합 컴포저로 이관 예정) */}
      {activeTab === "board" && (
      <button
        onClick={() => user ? setShowEntry(true) : setShowLogin(true)}
        className="fixed bottom-24 right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full shadow-lg"
        style={{ backgroundColor: teamColor }}
      >
        <PenLine className="w-9 h-9 text-white" />
      </button>
      )}

      {/* ⑦ 글쓰기 진입: 사진글/일반글 타입 선택 먼저 */}
      <WriteEntrySheet
        isOpen={showEntry}
        onClose={() => setShowEntry(false)}
        onChoosePhoto={() => { setShowEntry(false); setShowPhoto(true); }}
        onChooseText={() => { setShowEntry(false); setShowWrite(true); }}
        onChoosePoll={() => { setShowEntry(false); setShowPoll(true); }}
      />

      <WritePoll
        isOpen={showPoll}
        onClose={() => setShowPoll(false)}
        onCreated={(postId) => { setShowPoll(false); router.push(`/community/free/${postId}`); }}
      />

      <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />
      <WritePost
        isOpen={showWrite}
        onClose={() => setShowWrite(false)}
        enableTags
        defaultTeamSlugs={(() => {
          const s = TEAMS.find((t) => t.id === player.teamId)?.slug;
          return s ? [s] : [];
        })()}
        defaultPlayerTag={{ kboId, name: player.name, teamId: player.teamId }}
        onSubmit={async (title, content, imageUrls, _seatInfo, tags) => {
          // V3 태그 모델: 선수 글은 player_tags(선수 페이지·cross-board) + team_tags(팀 탭) 둘 다 부여.
          // 피커 기본값=현재 선수+소속팀. 사용자가 추가/변경하면 그 값 우선.
          const teamSlug = TEAMS.find((t) => t.id === player.teamId)?.slug;
          const playerTags = tags?.playerTags?.length
            ? tags.playerTags
            : [formatPlayerTag(kboId, player.name)];
          const teamTags = tags?.teamTags?.length
            ? tags.teamTags
            : teamSlug
              ? [teamSlug]
              : [];
          await createPost({
            boardType: "player",
            boardId: kboId,
            title,
            content,
            imageUrls,
            playerTags,
            ...(teamTags.length ? { teamTags } : {}),
          });
          setShowWrite(false);
          if (user) checkBadges(user.id);
          loadFeed();
        }}
        teamName={player.name}
      />

      <WritePhotoPost
        isOpen={showPhoto}
        onClose={() => setShowPhoto(false)}
        teamName={player.name}
        boardType="player"
        boardId={kboId}
        defaultPlayerTag={{ kboId, name: player.name, teamId: player.teamId }}
        defaultTeamSlugs={(() => {
          const s = TEAMS.find((t) => t.id === player.teamId)?.slug;
          return s ? [s] : undefined;
        })()}
        onSuccess={() => { setShowPhoto(false); if (user) checkBadges(user.id); loadFeed(); }}
      />
    </div>
  );
}
