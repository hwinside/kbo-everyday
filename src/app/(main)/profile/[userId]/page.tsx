"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { ChevronLeft, Heart, MessageCircle, Settings } from "lucide-react";
import { supabase } from "@/lib/supabase/client";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getTeamById } from "@/lib/constants/teams";
import TeamBadge from "@/components/ui/TeamBadge";
import GlassCard from "@/components/ui/GlassCard";
import { PLAYER_PHOTO_MAP } from "@/lib/constants/player-photos";
import { TEAMS as KBO_TEAMS } from "@/lib/constants/teams";
import type { BadgeDefinition } from "@/lib/constants/badges";
import { getTeamBorderColorById } from "@/lib/utils/team-border-color";
import { getTeamBgColorById } from "@/lib/utils/team";
import InviteTab from "@/components/profile/InviteTab";
import BadgeDetailModal from "@/components/profile/BadgeDetailModal";
import BadgesTab from "@/components/profile/BadgesTab";
import DMButton from "@/components/ui/DMButton";
import LevelBadge from "@/components/ui/LevelBadge";

interface UserProfile {
  id: string;
  nickname: string;
  team_id: number;
  grade: string;
  level: number;
  points: number;
  bio: string;
  is_founder: boolean;
  invite_count: number;
  show_posts: boolean;
  total_posts: number;
  total_comments: number;
  total_likes_received: number;
  joined_at: string;
}

interface UserBadge {
  badge_id: string;
  earned_at: string;
}

interface UserPost {
  id: number;
  title: string;
  board_type: string;
  board_id: string;
  like_count: number;
  comment_count: number;
  created_at: string;
}

export default function ProfilePage() {
  const { userId } = useParams();
  const router = useRouter();
  const { user, profile: myProfile } = useAuth();
  const isOwn = user?.id === userId;

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [badges, setBadges] = useState<UserBadge[]>([]);
  const [posts, setPosts] = useState<UserPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedBadge, setSelectedBadge] = useState<BadgeDefinition | null>(null);
  const [activeTab, setActiveTab] = useState<"badges" | "posts" | "invite">("badges");

  useEffect(() => {
    async function load() {
      const { data: p } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", userId)
        .single();
      if (p) setProfile(p as UserProfile);

      const { data: b } = await supabase
        .from("user_badges")
        .select("badge_id, earned_at")
        .eq("user_id", userId)
        .order("earned_at", { ascending: false });
      if (b) setBadges(b);

      if (p?.show_posts) {
        const { data: posts } = await supabase
          .from("posts")
          .select("id, title, board_type, board_id, like_count, comment_count, created_at")
          .eq("author_id", userId)
          .order("created_at", { ascending: false })
          .limit(20);
        if (posts) setPosts(posts);
      }

      setLoading(false);
    }
    load();
  }, [userId, user]);

  if (loading) return <div className="flex items-center justify-center h-screen text-text-secondary">로딩 중...</div>;
  if (!profile) return <div className="flex items-center justify-center h-screen text-text-secondary">유저를 찾을 수 없습니다</div>;

  const team = getTeamById(profile.team_id);
  const teamColor = team?.colorPrimary ?? "#666";
  const earnedBadgeIds = new Set(badges.map(b => b.badge_id));
  const founderBadge = earnedBadgeIds.has("founder");

  const timeAgo = (date: string) => {
    const d = new Date(date);
    return d.toLocaleDateString("ko-KR");
  };

  return (
    <div className="min-h-screen bg-bg-primary pb-24">
      {/* Header */}
      <div className="sticky top-0 z-30 pt-safe border-b bg-bg-primary/80 backdrop-blur-xl" style={{ borderColor: myProfile?.team_id ? getTeamBorderColorById(myProfile.team_id) : 'var(--color-border)' }}>
        <div className="flex items-center gap-3 px-4 py-3">
          <button onClick={() => router.back()}>
            <ChevronLeft size={24} className="text-text-secondary" />
          </button>
          <span className="text-base font-semibold text-text-primary flex-1">프로필</span>
          {isOwn && (
            <button onClick={() => {}}>
              <Settings size={20} className="text-text-tertiary" />
            </button>
          )}
        </div>
      </div>

      {/* Profile Header — compact, 8pt grid */}
      <div className="px-5 pt-5 pb-4 text-center">
        <div className="relative inline-block">
          <div
            className="w-[72px] h-[72px] rounded-full flex items-center justify-center text-2xl font-bold mx-auto ring-1 ring-white/10"
            style={{ backgroundColor: getTeamBgColorById(profile.team_id), color: "#fff" }}
          >
            {profile.nickname.charAt(0)}
          </div>
          {founderBadge && (
            <span className="absolute -top-1 -right-1 text-xl">👑</span>
          )}
        </div>

        <h1 className="text-lg font-semibold leading-[26px] text-text-primary mt-3">{profile.nickname}</h1>
        <div className="flex items-center justify-center gap-2 mt-1">
          {team && <TeamBadge teamId={team.id} size="sm" />}
          <LevelBadge points={profile.points} showTitle />
          {profile.is_founder && (
            <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-amber-500/20 text-amber-400">FOUNDER</span>
          )}
        </div>
        {profile.bio && (
          <p className="text-sm leading-[22px] text-text-tertiary mt-1.5">{profile.bio}</p>
        )}
        <p className="text-xs leading-[18px] text-text-tertiary mt-1">가입일 {timeAgo(profile.joined_at || profile.id)}</p>
        {!isOwn && (
          <div className="mt-3 flex justify-center">
            <DMButton targetUserId={profile.id} size="md" />
          </div>
        )}
      </div>

      {/* Stats — compact card, tabular-nums */}
      <div className="px-5 mb-4">
        <GlassCard className="p-3">
          <div className="grid grid-cols-3 text-center">
            <div>
              <p className="text-xl font-bold text-text-primary tabular-nums">{profile.total_posts || 0}</p>
              <p className="text-xs leading-[18px] text-text-tertiary mt-0.5">글</p>
            </div>
            <div className="border-x border-border">
              <p className="text-xl font-bold text-text-primary tabular-nums">{profile.total_comments || 0}</p>
              <p className="text-xs leading-[18px] text-text-tertiary mt-0.5">댓글</p>
            </div>
            <div>
              <p className="text-xl font-bold text-text-primary tabular-nums">{profile.total_likes_received || 0}</p>
              <p className="text-xs leading-[18px] text-text-tertiary mt-0.5">❤️</p>
            </div>
          </div>
        </GlassCard>
      </div>

      {/* Tabs — UnderlineTabs */}
      <div className="flex gap-4 mx-5 mb-4 border-b border-border">
        {([
          { id: "badges" as const, label: `🏅 배지 (${badges.length})` },
          { id: "posts" as const, label: "📝 글" },
          ...(isOwn ? [{ id: "invite" as const, label: "🎟️ 초대" }] : []),
        ]).map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`py-3 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.id
                ? "text-text-primary border-accent"
                : "text-text-tertiary border-transparent hover:text-text-secondary"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Badges Tab */}
      {activeTab === "badges" && (
        <BadgesTab badges={badges} earnedBadgeIds={earnedBadgeIds} onSelectBadge={setSelectedBadge} />
      )}

      {/* Posts Tab */}
      {activeTab === "posts" && (
        <div className="px-5 space-y-3">
          {!profile.show_posts && !isOwn ? (
            <div className="text-center py-8 text-text-tertiary text-sm">비공개 프로필입니다</div>
          ) : posts.length === 0 ? (
            <div className="text-center py-8 text-text-tertiary text-sm">아직 작성한 글이 없어요</div>
          ) : (
            posts.map(post => (
              <GlassCard
                key={post.id}
                className="p-3 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5"
                onClick={() => router.push(`/community/players/${post.board_id}/posts/${post.id}`)}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-black/8 dark:bg-white/10 text-text-tertiary">
                    {post.board_type === "player" ? `⚾ ${Object.entries(PLAYER_PHOTO_MAP).find(([, id]) => id === post.board_id)?.[0] || post.board_id}` : post.board_type === "team" ? `🏟️ ${KBO_TEAMS.find(t => String(t.id) === post.board_id)?.shortName || post.board_id}` : "💬 자유"}
                  </span>
                </div>
                <p className="text-sm font-medium text-text-primary">{post.title}</p>
                <div className="flex items-center gap-4 mt-1 text-xs text-text-tertiary">
                  <span>{timeAgo(post.created_at)}</span>
                  <span className="flex items-center gap-1"><Heart size={12} /> {post.like_count}</span>
                  <span className="flex items-center gap-1"><MessageCircle size={12} /> {post.comment_count}</span>
                </div>
              </GlassCard>
            ))
          )}
        </div>
      )}

      {/* Invite Tab (own only) */}
      {activeTab === "invite" && isOwn && (
        <InviteTab userId={user!.id} inviteCount={profile.invite_count || 0} />
      )}

      {/* Badge Detail Popup */}
      <BadgeDetailModal selectedBadge={selectedBadge} earnedBadgeIds={earnedBadgeIds} onClose={() => setSelectedBadge(null)} />
    </div>
  );
}
