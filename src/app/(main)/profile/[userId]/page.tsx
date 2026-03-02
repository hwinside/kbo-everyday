"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { ChevronLeft, Copy, Check, Heart, MessageCircle, Settings } from "lucide-react";
import { supabase } from "@/lib/supabase/client";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getTeamById } from "@/lib/constants/teams";
import TeamBadge from "@/components/ui/TeamBadge";
import GlassCard from "@/components/ui/GlassCard";
import { BADGES, BADGE_MAP, RARITY_COLORS, CATEGORY_LABELS } from "@/lib/constants/badges";
import type { BadgeDefinition } from "@/lib/constants/badges";

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
  const { user } = useAuth();
  const isOwn = user?.id === userId;

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [badges, setBadges] = useState<UserBadge[]>([]);
  const [posts, setPosts] = useState<UserPost[]>([]);
  const [inviteCodes, setInviteCodes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"badges" | "posts" | "invite">("badges");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    async function load() {
      // Profile
      const { data: p } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", userId)
        .single();
      if (p) setProfile(p as UserProfile);

      // Badges
      const { data: b } = await supabase
        .from("user_badges")
        .select("badge_id, earned_at")
        .eq("user_id", userId)
        .order("earned_at", { ascending: false });
      if (b) setBadges(b);

      // Posts (if public)
      if (p?.show_posts) {
        const { data: posts } = await supabase
          .from("posts")
          .select("id, title, board_type, board_id, like_count, comment_count, created_at")
          .eq("author_id", userId)
          .order("created_at", { ascending: false })
          .limit(20);
        if (posts) setPosts(posts);
      }

      // Invite codes (own only)
      if (user?.id === userId) {
        const { data: inv } = await supabase
          .from("invitations")
          .select("code, used_at")
          .eq("inviter_id", userId)
          .is("used_at", null);
        if (inv) setInviteCodes(inv.map(i => i.code));
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

  const categories = Object.entries(CATEGORY_LABELS);

  function copyCode(code: string) {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const timeAgo = (date: string) => {
    const d = new Date(date);
    return d.toLocaleDateString("ko-KR");
  };

  return (
    <div className="min-h-screen bg-bg-primary pb-24">
      {/* Header */}
      <div className="sticky top-0 z-30 border-b border-border bg-bg-primary/80 backdrop-blur-xl">
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

      {/* Profile Header */}
      <div className="px-5 py-6 text-center">
        <div className="relative inline-block">
          <div
            className="w-20 h-20 rounded-full flex items-center justify-center text-3xl font-bold mx-auto"
            style={{ backgroundColor: teamColor + "30", color: teamColor }}
          >
            {profile.nickname.charAt(0)}
          </div>
          {founderBadge && (
            <span className="absolute -top-1 -right-1 text-2xl">👑</span>
          )}
        </div>

        <h1 className="text-xl font-bold text-text-primary mt-3">{profile.nickname}</h1>
        <div className="flex items-center justify-center gap-2 mt-1">
          {team && <TeamBadge teamId={team.id} size="sm" />}
          <span className="text-sm text-text-secondary">Lv.{profile.level} {profile.grade}</span>
          {profile.is_founder && (
            <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-amber-500/20 text-amber-400">FOUNDER</span>
          )}
        </div>
        {profile.bio && (
          <p className="text-sm text-text-tertiary mt-2">{profile.bio}</p>
        )}
        <p className="text-xs text-text-tertiary mt-1">가입일 {timeAgo(profile.joined_at || profile.id)}</p>
      </div>

      {/* Stats */}
      <div className="px-5 mb-4">
        <GlassCard className="p-4">
          <div className="grid grid-cols-3 text-center">
            <div>
              <p className="text-lg font-bold text-text-primary">{profile.total_posts || 0}</p>
              <p className="text-xs text-text-tertiary">글</p>
            </div>
            <div className="border-x border-border">
              <p className="text-lg font-bold text-text-primary">{profile.total_comments || 0}</p>
              <p className="text-xs text-text-tertiary">댓글</p>
            </div>
            <div>
              <p className="text-lg font-bold text-text-primary">{profile.total_likes_received || 0}</p>
              <p className="text-xs text-text-tertiary">❤️</p>
            </div>
          </div>
        </GlassCard>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mx-5 mb-4 bg-bg-tertiary rounded-lg p-1">
        {([
          { id: "badges" as const, label: `🏅 배지 (${badges.length})` },
          { id: "posts" as const, label: "📝 글" },
          ...(isOwn ? [{ id: "invite" as const, label: "🎟️ 초대" }] : []),
        ]).map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 py-2 rounded-md text-sm font-medium transition-all ${
              activeTab === tab.id ? "bg-white/10 text-text-primary" : "text-text-tertiary"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Badges Tab */}
      {activeTab === "badges" && (
        <div className="px-5 space-y-4">
          {categories.map(([catId, catLabel]) => {
            const catBadges = BADGES.filter(b => b.category === catId);
            if (catBadges.length === 0) return null;
            return (
              <GlassCard key={catId} className="p-4">
                <h3 className="text-sm font-bold text-text-primary mb-3">{catLabel}</h3>
                <div className="grid grid-cols-4 gap-3">
                  {catBadges.map(badge => {
                    const earned = earnedBadgeIds.has(badge.id);
                    return (
                      <motion.div
                        key={badge.id}
                        whileTap={{ scale: 0.95 }}
                        className={`text-center p-2 rounded-xl transition-all ${
                          earned ? "bg-white/5" : "opacity-30"
                        }`}
                      >
                        <span className={`text-2xl ${earned ? "" : "grayscale"}`}>{badge.icon}</span>
                        <p className="text-[10px] mt-1 font-medium" style={{ color: earned ? RARITY_COLORS[badge.rarity] : "#666" }}>
                          {badge.name}
                        </p>
                      </motion.div>
                    );
                  })}
                </div>
              </GlassCard>
            );
          })}
          <p className="text-center text-xs text-text-tertiary">
            {badges.length}개 획득 / {BADGES.length}개 중
          </p>
        </div>
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
                className="p-3 cursor-pointer hover:bg-white/5"
                onClick={() => router.push(`/boards/players/${post.board_id}/posts/${post.id}`)}
              >
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
        <div className="px-5 space-y-4">
          <GlassCard className="p-4">
            <h3 className="text-sm font-bold text-text-primary mb-2">🎟️ 나의 초대코드</h3>
            <p className="text-xs text-text-tertiary mb-3">
              친구를 초대하면 파운더 배지를 드려요! 남은 초대권: {profile.invite_count || 0}장
            </p>
            {inviteCodes.length > 0 ? (
              <div className="space-y-2">
                {inviteCodes.map(code => (
                  <div key={code} className="flex items-center gap-2 bg-bg-tertiary rounded-xl px-4 py-3">
                    <code className="flex-1 text-sm font-mono text-accent">{code}</code>
                    <button onClick={() => copyCode(code)}>
                      {copied ? <Check size={18} className="text-green-400" /> : <Copy size={18} className="text-text-tertiary" />}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-text-tertiary text-center py-4">
                {(profile.invite_count || 0) > 0 ? "초대코드를 생성해보세요!" : "초대권을 모두 사용했어요"}
              </p>
            )}
          </GlassCard>

          <GlassCard className="p-4">
            <h3 className="text-sm font-bold text-text-primary mb-2">👥 내가 초대한 친구</h3>
            <p className="text-xs text-text-tertiary">
              초대한 친구가 활동할수록 나도 포인트를 받아요!
            </p>
          </GlassCard>
        </div>
      )}
    </div>
  );
}
