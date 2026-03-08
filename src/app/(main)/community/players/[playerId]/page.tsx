"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useParams } from "next/navigation";
import { motion } from "framer-motion";
import { ArrowLeft, Heart, MessageCircle, Share2, PenLine } from "lucide-react";
import Link from "next/link";
import GlassCard from "@/components/ui/GlassCard";
import NicheStats from "@/components/player/NicheStats";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getPlayerPhotoUrl, getPlayerPhotoByKboId, PLAYER_PHOTO_MAP } from "@/lib/constants/player-photos";
import { TEAMS } from "@/lib/constants/teams";
import { usePosts, createPost } from "@/lib/supabase/usePosts";
import WritePost from "@/components/community/WritePost";
import { useBadgeCheck } from "@/lib/hooks/useBadgeCheck";
import BadgeToast from "@/components/ui/BadgeToast";
import { useAuth } from "@/lib/supabase/AuthContext";
import LoginSheet from "@/components/auth/LoginSheet";
import CheerSong from "@/components/player/CheerSong";
import PlayerProfile from "@/components/player/PlayerProfile";
import PlayerRadar from "@/components/player/PlayerRadar";
import PlayerNews from "@/components/player/PlayerNews";
import PhotoGallery from "@/components/player/PhotoGallery";

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
      <p className="text-lg font-bold" style={{ color: "#E8E8F0" }}>{value}</p>
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
  const [showLogin, setShowLogin] = useState(false);
  const [statSeason, setStatSeason] = useState<2025 | 2026>(2025);
  const [realStats, setRealStats] = useState<Record<string, string | number> | null>(null);
  const { user } = useAuth();
  const { newBadges, checkBadges, clearBadges } = useBadgeCheck();

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

  // 2025 스탯 로드 (개별 선수)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (statSeason !== 2025 || !player) { setRealStats(null); return; }
    fetch(`/api/player-stats?id=${kboId}&pos=${encodeURIComponent(player.position)}`)
      .then(r => r.json())
      .then(d => { setRealStats(d.stats || null); })
      .catch(() => {});
  }, [statSeason, player, kboId]);

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

  return (
    <div className="min-h-screen bg-bg-primary pb-20">
      {/* Header */}
      <div
        className="sticky top-0 z-30 pt-safe border-b border-border backdrop-blur-xl pt-safe"
        style={{ background: `linear-gradient(135deg, ${teamColor}15, transparent)` }}
      >
        <div className="flex items-center gap-4 px-5 py-4">
          <button onClick={() => router.back()} className="p-1 -ml-1">
            <ArrowLeft className="w-10 h-10 text-text-secondary" />
          </button>
          <PlayerAvatar name={player.name} teamId={player.teamId} photoUrl={getPlayerPhotoUrl(player.name) || getPlayerPhotoUrl(playerName || "") || getPlayerPhotoByKboId(kboId)} number={player.number} size={64} />
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold text-text-primary">{player.name}</h1>
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
              {tab === "stats" ? "기본정보" : tab === "photo" ? "📸 직찍" : tab === "latest" ? "최신" : "인기"}
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

          {statSeason === 2026 ? (
            <div className="glass-card p-6 mb-4 text-center">
              <p className="text-lg mb-1">⚾</p>
              <p className="text-sm font-bold text-text-primary">2026 시즌 개막 후 확인 가능합니다</p>
              <p className="text-xs text-text-tertiary mt-1">개막일: 2026년 3월 28일 (토)</p>
            </div>
          ) : realStats ? (
            <div className="glass-card p-4 mb-4">
              <h3 className="text-sm font-bold text-text-primary mb-3">2025 시즌 기록</h3>
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

      {/* 직찍 갤러리 */}
      {activeTab === "photo" && (
        <div className="py-2">
          <PhotoGallery teamColor={teamColor} />
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
    </div>
  );
}
