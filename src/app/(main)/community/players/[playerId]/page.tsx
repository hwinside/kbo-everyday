"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useParams } from "next/navigation";
import { motion } from "framer-motion";
import { ArrowLeft, Heart, MessageCircle, Share2, PenLine } from "lucide-react";
import Link from "next/link";
import HeaderProfileLink from "@/components/ui/HeaderProfileLink";
import { getTeamBorderColorById } from "@/lib/utils/team-border-color";
import GlassCard from "@/components/ui/GlassCard";
import NicheStats from "@/components/player/NicheStats";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getPlayerPhotoUrl, PLAYER_PHOTO_MAP } from "@/lib/constants/player-photos";
import { TEAMS } from "@/lib/constants/teams";
import { FOREIGN_NUMERIC_TO_ALPHA } from "@/lib/constants/foreign-id-map";
import { usePosts, createPost, toggleLike } from "@/lib/supabase/usePosts";
import type { Post } from "@/lib/supabase/usePosts";
import { supabase } from "@/lib/supabase/client";
import WritePost from "@/components/community/WritePost";
import WritePhotoPost from "@/components/community/WritePhotoPost";
import PhotoFeed from "@/components/community/PhotoFeed";
import { useBadgeCheck } from "@/lib/hooks/useBadgeCheck";
import BadgeToast from "@/components/ui/BadgeToast";
import { useAuth } from "@/lib/supabase/AuthContext";
import LoginSheet from "@/components/auth/LoginSheet";
import CheerSong from "@/components/player/CheerSong";
import PlayerProfile from "@/components/player/PlayerProfile";
import PlayerRadar from "@/components/player/PlayerRadar";
import PlayerNews from "@/components/player/PlayerNews";
import { formatPlayerTag } from "@/lib/utils/player-tags";

// kboId → name 역매핑 (roster 기반 — 전체 선수 커버)
import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";
const ID_TO_NAME: Record<string, string> = {};
for (const p of PLAYERS_ROSTER) {
  ID_TO_NAME[p.kboId] = p.name;
}
// photo map에서도 추가 (혹시 roster에 없는 경우)
for (const [name, id] of Object.entries(PLAYER_PHOTO_MAP)) {
  if (!ID_TO_NAME[id]) ID_TO_NAME[id] = name;
}

// 레거시 pN → kboId 매핑 (기존 링크 호환)
const LEGACY_MAP: Record<string, string> = {
  p1: "67430", p2: "77162", p3: "62404", p4: "69650", p5: "68571",
  p6: "64643", p7: "63905", p8: "61478", p9: "75003", p10: "67100",
  p11: "55500", p12: "68300", p13: "69200", p14: "67800", p15: "65400",
  // 외국인 선수 숫자→영문 ID 매핑은 shared constant 사용
  ...FOREIGN_NUMERIC_TO_ALPHA,
};

const TEAM_SHORT_MAP: Record<string, number> = {
  LG: 1, OB: 2, KT: 3, SK: 4, NC: 5, HT: 6, LT: 7, SS: 8, HH: 9, WO: 10,
  "두산": 2, SSG: 4, KIA: 6, "롯데": 7, "삼성": 8, "한화": 9, "키움": 10,
};

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
  // 레거시 pN ID 처리
  const kboId = LEGACY_MAP[rawId] || rawId;
  const playerName = ID_TO_NAME[kboId];
  // 동명이인 대응: roster에서 kboId로 직접 찾기
  const rosterPlayer = PLAYERS_ROSTER.find((p) => p.kboId === kboId);
  
  const [player, setPlayer] = useState<PlayerData | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<"stats" | "photo" | "latest" | "hot">("stats");
  const { posts: livePosts, loading: postsLoading, reload } = usePosts("player", rawId);
  const [showWrite, setShowWrite] = useState(false);
  const [showPhotoWrite, setShowPhotoWrite] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [statSeason, setStatSeason] = useState<2025 | 2026>(2026);
  const [photoPosts, setPhotoPosts] = useState<Post[]>([]);
  const [photoLoading, setPhotoLoading] = useState(true);
  const [realStats, setRealStats] = useState<Record<string, string | number> | null>(null);
  const { user } = useAuth();
  const { newBadges, checkBadges, clearBadges } = useBadgeCheck();

  const loadPhotoPosts = useCallback(async () => {
    if (!playerName) return;
    setPhotoLoading(true);
    const cols = "id, author_id, board_type, board_id, content_type, title, content, image_urls, video_urls, like_count, comment_count, created_at, is_hidden, game_id, player_tags, hashtags, profiles(nickname, team_id, grade, points)";

    // 1) 선수 게시판 직접 게시물
    const boardQuery = supabase
      .from("posts")
      .select(cols)
      .eq("board_type", "player")
      .eq("board_id", kboId)
      .neq("is_hidden", true)
      .order("created_at", { ascending: false })
      .limit(50);

    // 2) 다른 게시판에서 player_tags로 태그된 게시물 (cross-board)
    const tag = formatPlayerTag(kboId, playerName);
    const tagQuery = supabase
      .from("posts")
      .select(cols)
      .contains("player_tags", [tag])
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

    setPhotoPosts(merged.map((p) => ({
      ...p,
      content_type: (p.content_type ?? "general") as "general" | "photo",
      image_urls: (p.image_urls ?? []) as string[],
      video_urls: ((p as Record<string, unknown>).video_urls ?? []) as string[],
      nickname: (p.profiles as unknown as Record<string, unknown> | null)?.nickname as string | undefined,
      team_id: (p.profiles as unknown as Record<string, unknown> | null)?.team_id as number | undefined,
      grade: (p.profiles as unknown as Record<string, unknown> | null)?.grade as string | undefined,
      points: ((p.profiles as unknown as Record<string, unknown> | null)?.points as number) ?? 0,
    })));
    setPhotoLoading(false);
  }, [kboId, playerName]);

  useEffect(() => { loadPhotoPosts(); }, [loadPhotoPosts]);

  const handlePhotoLike = async (postId: number) => {
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
  }, [playerName]);

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
          const found = stats.find((s) => String(s.kboId || s.playerId) === kboId) || stats.find((s) => s.name === (playerName || player.name));
          setRealStats(found || null);
        })
        .catch(() => { setRealStats(null); });
    }
  }, [statSeason, player, kboId, playerName]);

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
      <div className="bg-bg-primary border-b" style={{ borderColor: teamBorder }}>
        <div className="mx-auto max-w-lg">
          <header className="py-3 px-5 flex items-center gap-3">
            <button onClick={() => router.back()} className="rounded-full p-1 text-text-secondary hover:bg-bg-tertiary transition-colors" aria-label="뒤로가기">
              <ArrowLeft size={24} />
            </button>
            <h1 className="text-2xl font-bold text-text-primary tracking-tight flex-1">선수</h1>
            <HeaderProfileLink />
          </header>
        </div>
      </div>

      {/* 선수 프로필 헤더 */}
      <div
        className="border-b border-border"
        style={{ background: `linear-gradient(135deg, ${teamColor}15, transparent)` }}
      >
        <div className="flex items-center gap-4 px-5 py-4">
          <PlayerAvatar name={player.name} teamId={player.teamId} photoUrl={getPlayerPhotoUrl(player.name, kboId)} number={player.number} size={64} />
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

        {/* Tabs */}
        <div className="flex border-t border-border">
          {((["stats", "photo", "latest", "hot"] as const)).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 py-3 text-base font-medium transition-colors relative ${
                activeTab === tab ? "text-text-primary" : "text-text-tertiary"
              }`}
            >
              {tab === "stats" ? "⚾ 선수정보" : tab === "photo" ? "📸 사진" : tab === "latest" ? "📝 최신글" : "🔥 인기글"}
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
          <PlayerRadar playerId={rawId} position={player.position} teamColor={teamColor} />
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

          {realStats ? (
            <div className="glass-card p-4 mb-4">
              <h3 className="text-sm font-bold text-text-primary mb-3">{statSeason} 시즌 기록</h3>
              <div className="grid grid-cols-3 gap-3">
                {player.position === "투수" ? (
                  <>
                    <StatItem label="ERA" value={realStats.era} color={teamColor} />
                    <StatItem label="승-패" value={`${realStats.wins}-${realStats.losses}`} color={teamColor} />
                    <StatItem label="세이브" value={realStats.saves} color={teamColor} />
                    <StatItem label="홀드" value={realStats.holds ?? 0} color={teamColor} />
                    <StatItem label="이닝" value={realStats.ip} color={teamColor} />
                    <StatItem label="경기" value={realStats.games} color={teamColor} />
                    <StatItem label="삼진" value={realStats.so} color={teamColor} />
                    <StatItem label="볼넷" value={realStats.bb ?? 0} color={teamColor} />
                    <StatItem label="WHIP" value={realStats.whip} color={teamColor} />
                    <StatItem label="승률" value={realStats.wpct ?? "-"} color={teamColor} />
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
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="glass-card p-4 mb-4 text-center text-text-tertiary text-sm">
              2025 시즌 데이터를 찾을 수 없습니다
            </div>
          )}

          <NicheStats playerId={rawId} position={player.position} teamColor={teamColor} playerName={player.name} season={statSeason} />
          
          {/* 관련 기사 */}
          <div className="px-5">
            <PlayerNews playerName={player.name} teamId={player.teamId} />
          </div>
        </div>
      )}

      {/* 직찍 피드 */}
      {activeTab === "photo" && (
        <div className="py-2">
          <PhotoFeed
            posts={photoPosts}
            loading={photoLoading}
            onLike={handlePhotoLike}
            boardType="player"
          />
        </div>
      )}

      {/* Posts */}
      {activeTab !== "stats" && activeTab !== "photo" && <div className="px-5 py-4 space-y-5">
        {(livePosts.length === 0 && !postsLoading) ? (
          <div className="text-center py-12 text-text-tertiary">
            <p className="text-sm">아직 게시글이 없어요</p>
            <p className="text-xs mt-1">첫 번째 글을 작성해보세요!</p>
          </div>
        ) : livePosts.map((post, i) => (
          <motion.div
            key={post.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.03 }}
          >
            <Link href={`/community/players/${rawId}/posts/${post.id}`}><GlassCard pressable className="p-4">
              <p className="text-base font-medium text-text-primary">{post.title}</p>
              <div className="mt-2 flex items-center justify-between text-base text-text-tertiary">
                <div className="flex items-center">
                  <span>{post.nickname || "익명"}</span>
                  {post.grade === 'staff' && (
                    <span className='ml-1 px-1.5 py-0.5 text-[10px] font-bold bg-accent/20 text-accent rounded-full'>운영팀</span>
                  )}
                  <span className="ml-1">· {new Date(post.created_at).toLocaleDateString("ko-KR")}</span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="flex items-center gap-1"><Heart size={22} /> {post.like_count}</span>
                  <span className="flex items-center gap-1"><MessageCircle size={22} /> {post.comment_count}</span>
                </div>
              </div>
            </GlassCard></Link>
          </motion.div>
        ))}
      </div>}

      {/* FAB */}

      {(activeTab === "latest" || activeTab === "hot") && (
      <button
        onClick={() => user ? setShowWrite(true) : setShowLogin(true)}
        className="fixed bottom-24 right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full shadow-lg"
        style={{ backgroundColor: teamColor }}
      >
        <PenLine className="w-9 h-9 text-white" />
      </button>
      )}

      {activeTab === "photo" && (
      <button
        onClick={() => user ? setShowPhotoWrite(true) : setShowLogin(true)}
        className="fixed bottom-24 right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full shadow-lg"
        style={{ backgroundColor: teamColor }}
      >
        <PenLine className="w-9 h-9 text-white" />
      </button>
      )}

      <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />
      <WritePost
        isOpen={showWrite}
        onClose={() => setShowWrite(false)}
        onSubmit={async (title, content, imageUrls) => {
          await createPost({ boardType: "player", boardId: rawId, title, content, imageUrls });
          setShowWrite(false);
          if (user) checkBadges(user.id);
          reload();
        }}
        teamName={player.name}
      />
      <WritePhotoPost
        isOpen={showPhotoWrite}
        onClose={() => setShowPhotoWrite(false)}
        teamName={player.name}
        boardType="player"
        boardId={kboId}
        defaultPlayerTag={player ? { kboId, name: player.name, teamId: player.teamId } : undefined}
        onSuccess={() => loadPhotoPosts()}
      />
    </div>
  );
}
