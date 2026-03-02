"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, Pencil } from "lucide-react";
import { getTeamBySlug } from "@/lib/constants/teams";
import GlassCard from "@/components/ui/GlassCard";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getPlayerPhotoUrl, PLAYER_PHOTO_MAP } from "@/lib/constants/player-photos";
import TeamLogo from "@/components/ui/TeamLogo";
import PostList from "@/components/community/PostList";
import WritePost from "@/components/community/WritePost";
import NewsCarousel from "@/components/news/NewsCarousel";
import { MOCK_NEWS } from "@/lib/constants/news";
import {
  ALL_LG_PLAYERS,
  getPositionGroup,
  POSITION_LABELS,
  type PositionGroup,
} from "@/lib/constants/players";
import type { Post } from "@/lib/types";
import { useAuth } from "@/lib/supabase/AuthContext";
import LoginSheet from "@/components/auth/LoginSheet";
import { PLAYER_PROFILES } from "@/lib/constants/player-profiles";
import { usePosts, createPost } from "@/lib/supabase/usePosts";

type PageTab = "board" | "players";
type SortTab = "latest" | "popular";

function generateMockPosts(teamSlug: string): Post[] {
  const team = getTeamBySlug(teamSlug);
  if (!team) return [];

  const titles = [
    "오늘의 선발 라인업 예상",
    "이번 시즌 기대되는 신인 선수",
    "어제 경기 하이라이트 리뷰",
    "연봉 협상 소식 정리",
    "올해 우승 가능성 분석",
    "응원가 새 버전 나왔네요",
    "직관 후기 공유합니다",
    "트레이드 루머 어떻게 생각하시나요?",
    "이번 주 3연전 프리뷰",
    "MVP 후보 토론",
  ];

  const authors = [
    { nickname: "야구광팬", level: 15, title: "골드글러브", myTeamId: team.id, avatarUrl: null },
    { nickname: "직관러", level: 8, title: "레귤러", myTeamId: team.id, avatarUrl: null },
    { nickname: "통계매니아", level: 22, title: "MVP", myTeamId: team.id, avatarUrl: null },
    { nickname: "신입팬", level: 2, title: "루키", myTeamId: team.id, avatarUrl: null },
    { nickname: "올드팬", level: 30, title: "명예의전당", myTeamId: team.id, avatarUrl: null },
  ];

  return titles.map((title, i) => ({
    id: i + 1,
    boardType: "team" as const,
    boardId: teamSlug,
    authorId: `user-${i}`,
    title,
    content: "게시글 내용이 여기에 표시됩니다. 목업 데이터입니다.",
    imageUrls: i % 3 === 0 ? ["/placeholder.jpg"] : [],
    likeCount: Math.floor(Math.random() * 50) + 1,
    commentCount: Math.floor(Math.random() * 30),
    isReported: false,
    createdAt: new Date(Date.now() - i * 3600000 * (i + 1)).toISOString(),
    author: authors[i % authors.length],
  }));
}

const POSITION_ORDER: PositionGroup[] = ["투수", "포수", "내야수", "외야수"];

export default function TeamBoardPage() {
  const params = useParams();
  const teamSlug = params.teamId as string;
  const team = getTeamBySlug(teamSlug);

  const [pageTab, setPageTab] = useState<PageTab>("board");
  const [sortTab, setSortTab] = useState<SortTab>("latest");
  const [writeOpen, setWriteOpen] = useState(false);

  if (!team) {
    return (
      <div className="flex items-center justify-center py-40 text-text-tertiary">
        존재하지 않는 구단입니다
      </div>
    );
  }

  const { user } = useAuth();
  const [showLogin, setShowLogin] = useState(false);
  const [realNews, setRealNews] = useState<any[]>([]);

  useEffect(() => {
    if (!team) return;
    fetch(`/api/news?team=${team.shortName}`)
      .then(r => r.json())
      .then(d => {
        if (d.items?.length) {
          setRealNews(d.items.map((item: any, i: number) => ({
            id: 2000 + i,
            teamId: team.id,
            title: item.title,
            source: (() => { try { return new URL(item.link).hostname.replace("www.", "").replace("m.", ""); } catch { return "뉴스"; } })(),
            sourceUrl: item.link,
            thumbnailUrl: null,
            timeAgo: new Date(item.pubDate).toLocaleDateString("ko-KR"),
            type: "news" as const,
          })));
        }
      })
      .catch(() => {});
  }, [team]);

  const { posts: livePosts, loading: postsLoading, reload } = usePosts("team", teamSlug);
  const realPosts: Post[] = livePosts.map(p => ({
    id: p.id,
    boardType: "team" as any,
    boardId: teamSlug,
    authorId: p.author_id,
    title: p.title,
    content: p.content,
    imageUrls: p.image_urls || [],
    likeCount: p.like_count,
    commentCount: p.comment_count,
    isReported: false,
    createdAt: p.created_at,
    author: { nickname: p.nickname || "익명", avatarUrl: null, myTeamId: p.team_id || team.id, level: 1, title: "" },
  }));
  const mockPosts = generateMockPosts(teamSlug);
  const posts = [...realPosts, ...mockPosts];
  const sortedPosts =
    sortTab === "popular"
      ? [...posts].sort((a, b) => b.likeCount - a.likeCount)
      : posts;

  // 팀 선수 목록 (KBO API에서 로딩)
  const [teamPlayers, setTeamPlayers] = useState<{ name: string; position: string; stats: any }[]>([]);
  useEffect(() => {
    Promise.all([
      fetch("/api/stats?type=batter").then(r => r.json()),
      fetch("/api/stats?type=pitcher").then(r => r.json()),
    ]).then(([b, p]) => {
      const batters = (b.stats || []).filter((s: any) => s.team === team.shortName).map((s: any) => ({ name: s.name, position: "타자", stats: s }));
      const pitchers = (p.stats || []).filter((s: any) => s.team === team.shortName).map((s: any) => ({ name: s.name, position: "투수", stats: s }));
      setTeamPlayers([...batters, ...pitchers]);
    });
  }, [team.shortName]);
  const players = teamPlayers;
  const grouped = POSITION_ORDER.map((group) => ({
    group,
    players: players.filter((p) => getPositionGroup(p.position) === group),
  })).filter((g) => g.players.length > 0);

  return (
    <div className="mx-auto max-w-lg">
      {/* Team gradient header */}
      <div
        className="relative px-5 pb-5 pt-safe"
        style={{
          background: `linear-gradient(180deg, ${team.colorPrimary}33 0%, transparent 100%)`,
        }}
      >
        <div className="flex items-center gap-4 py-5">
          <Link
            href="/teams"
            className="rounded-full p-1 text-text-secondary hover:bg-bg-tertiary/50 transition-colors"
          >
            <ChevronLeft size={24} />
          </Link>
          <div className="flex items-center gap-3">
            <TeamLogo team={team} size={64} />
            <h1 className="text-xl font-bold text-text-primary">{team.name}</h1>
          </div>
        </div>

      </div>

      {/* Team News Carousel */}
      <div className="mb-2">
        <NewsCarousel news={realNews.length > 0 ? realNews.slice(0, 5) : MOCK_NEWS.filter(n => n.teamId === team.id).slice(0, 5)} />
      </div>

      <div className="px-5 pb-5">
        {/* Page tabs: 게시판 / 선수 */}
        <div className="flex gap-3">
          {(["board", "players"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setPageTab(tab)}
              className={`rounded-full px-5 py-2 text-base font-medium transition-colors ${
                pageTab === tab
                  ? "bg-text-primary text-bg-primary"
                  : "bg-bg-glass text-text-secondary"
              }`}
            >
              {tab === "board" ? "게시판" : "선수"}
            </button>
          ))}
        </div>
      </div>

      <AnimatePresence mode="wait">
        {pageTab === "board" ? (
          <motion.div
            key="board"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.2 }}
          >
            {/* Sort tabs */}
            <div className="flex gap-4 px-5 pt-2">
              {(["latest", "popular"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setSortTab(tab)}
                  className={`rounded-full px-4 py-1.5 text-base font-medium transition-colors ${
                    sortTab === tab
                      ? "bg-bg-tertiary text-text-primary"
                      : "text-text-tertiary"
                  }`}
                >
                  {tab === "latest" ? "최신" : "인기"}
                </button>
              ))}
            </div>

            {/* Post list */}
            <div className="px-5 py-4">
              <PostList posts={sortedPosts} />
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="players"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            transition={{ duration: 0.2 }}
            className="px-5 py-4"
          >
            {players.length === 0 ? (
              <div className="py-20 text-center text-base text-text-tertiary">
                선수 데이터 로딩 중...
              </div>
            ) : (
              <div className="space-y-6">
                {grouped.map(({ group, players: groupPlayers }) => (
                  <div key={group}>
                    <h3 className="mb-3 text-base font-semibold text-text-tertiary">{group}</h3>
                    <div className="space-y-2">
                      {groupPlayers.map((player) => {
                        const isPitcher = player.position === "투수";
                        return (
                          <Link
                            key={player.name}
                            href={`/boards/players/${PLAYER_PHOTO_MAP[player.name] || player.name}`}
                          >
                            <GlassCard pressable className="!p-4">
                              <div className="flex items-center gap-4">
                                <PlayerAvatar name={player.name} teamId={team.id} photoUrl={getPlayerPhotoUrl(player.name)} number={0} size={64} showTeamBadge={false} />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-3">
                                    <span className="text-base font-bold text-text-primary">
                                      {player.name}
                                    </span>
                                    <span className="text-base text-text-tertiary">
                                      {player.position}
                                    </span>
                                  </div>
                                  <p className="mt-0.5 text-base tabular-nums text-text-secondary">
                                    {isPitcher
                                      ? `ERA ${player.stats?.era || "-"} · ${player.stats?.w || 0}승${player.stats?.l || 0}패 · WHIP ${player.stats?.whip || "-"}`
                                      : `${player.stats?.avg || "-"} / ${player.stats?.hr || 0}HR / ${player.stats?.rbi || 0}RBI`}
                                  </p>
                                </div>
                              </div>
                            </GlassCard>
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* FAB — Write post (only on board tab) */}
      {pageTab === "board" && (
        <motion.button
          onClick={() => { if (!user) { setShowLogin(true); return; } setWriteOpen(true); }}
          className="fixed bottom-20 right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full shadow-lg"
          style={{ backgroundColor: team.colorPrimary }}
          whileTap={{ scale: 0.9 }}
          whileHover={{ scale: 1.05 }}
        >
          <Pencil size={24} className="text-white" />
        </motion.button>
      )}

      <WritePost
        isOpen={writeOpen}
        onClose={() => setWriteOpen(false)}
        teamName={team.name}
        onSubmit={async (title, content, imageUrls) => {
          await createPost({ boardType: "team", boardId: teamSlug, title, content, imageUrls });
          reload();
          setWriteOpen(false);
        }}
      />
      {showLogin && <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />}
    </div>
  );
}
