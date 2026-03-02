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
import { PLAYER_PHOTO_MAP } from "@/lib/constants/player-photos";
import { TEAMS as KBO_TEAMS } from "@/lib/constants/teams";
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


// 동적 배지 (fan-player:playerId:level, fan-team:teamId:level) 해석
function parseDynamicBadge(badgeId: string): BadgeDefinition | null {
  const playerMatch = badgeId.match(/^fan-player:(.+):(\d+)$/);
  if (playerMatch) {
    const [, playerId, level] = playerMatch;
    const playerName = Object.entries(PLAYER_PHOTO_MAP).find(([, id]) => id === playerId)?.[0] || playerId;
    const lvl = parseInt(level);
    const rarity = lvl <= 2 ? "common" : lvl <= 3 ? "rare" : lvl <= 4 ? "epic" : "legendary";
    return { id: badgeId, name: `${playerName} 덕후 Lv.${level}`, icon: "⭐", description: `${playerName} 게시판 활동`, category: "fan", rarity };
  }
  const teamMatch = badgeId.match(/^fan-team:(\d+):(\d+)$/);
  if (teamMatch) {
    const [, teamId, level] = teamMatch;
    const teamName = KBO_TEAMS.find(t => String(t.id) === teamId)?.shortName || teamId;
    const lvl = parseInt(level);
    const rarity = lvl <= 2 ? "common" : lvl <= 3 ? "rare" : lvl <= 4 ? "epic" : "legendary";
    return { id: badgeId, name: `${teamName} 광팬 Lv.${level}`, icon: "🏟️", description: `${teamName} 게시판 활동`, category: "fan", rarity };
  }
  return null;
}

function getBadgeInfo(badgeId: string): BadgeDefinition | null {
  return BADGE_MAP[badgeId] || parseDynamicBadge(badgeId);
}

function InviteTab({ userId, inviteCount }: { userId: string; inviteCount: number }) {
  const [codes, setCodes] = useState<string[]>([]);
  const [friends, setFriends] = useState<{ id: string; nickname: string }[]>([]);
  const [totalInvited, setTotalInvited] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(inviteCount);

  useEffect(() => {
    fetch(`/api/invite?userId=${userId}`)
      .then(r => r.json())
      .then(data => {
        setCodes((data.invitations || []).filter((i: any) => !i.used_at).map((i: any) => i.code));
        setFriends(data.friends || []);
        setTotalInvited(data.totalInvited || 0);
      });
  }, [userId]);

  async function generateCode() {
    if (remaining <= 0) return;
    setGenerating(true);
    const res = await fetch("/api/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    const data = await res.json();
    if (data.code) {
      setCodes(prev => [data.code, ...prev]);
      setRemaining(prev => prev - 1);
    }
    setGenerating(false);
  }

  function copyCode(code: string) {
    navigator.clipboard.writeText(code);
    setCopied(code);
    setTimeout(() => setCopied(null), 2000);
  }

  function shareCode(code: string) {
    const text = `크보 에브리데이에 초대합니다! 🏟️⚾\n\n초대코드: ${code}\n가입하면 파운더 배지를 받아요 👑\n\nhttps://kbo-everyday.vercel.app`;
    if (navigator.share) {
      navigator.share({ title: "크보 에브리데이 초대", text });
    } else {
      navigator.clipboard.writeText(text);
      setCopied(code);
      setTimeout(() => setCopied(null), 2000);
    }
  }

  return (
    <div className="px-5 space-y-4">
      <GlassCard className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-text-primary">🎟️ 초대코드</h3>
          <span className="text-xs px-2 py-1 rounded-full bg-accent/20 text-accent font-bold">
            남은 초대권: {remaining}장
          </span>
        </div>

        {remaining > 0 && (
          <button
            onClick={generateCode}
            disabled={generating}
            className="w-full mb-3 py-2.5 rounded-xl bg-accent/20 text-accent font-bold text-sm hover:bg-accent/30 transition-all disabled:opacity-50"
          >
            {generating ? "생성 중..." : "✨ 초대코드 생성하기"}
          </button>
        )}

        {codes.length > 0 ? (
          <div className="space-y-2">
            {codes.map(code => (
              <div key={code} className="flex items-center gap-2 bg-bg-tertiary rounded-xl px-4 py-3">
                <code className="flex-1 text-sm font-mono text-accent">{code}</code>
                <button onClick={() => copyCode(code)} className="p-1.5">
                  {copied === code ? <Check size={16} className="text-green-400" /> : <Copy size={16} className="text-text-tertiary" />}
                </button>
                <button onClick={() => shareCode(code)} className="p-1.5 text-text-tertiary text-xs">
                  공유
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-text-tertiary text-center py-2">
            초대코드를 생성해서 친구에게 공유하세요!
          </p>
        )}
      </GlassCard>

      <GlassCard className="p-4">
        <h3 className="text-sm font-bold text-text-primary mb-2">
          👥 내가 초대한 친구 ({totalInvited}명)
        </h3>
        {friends.length > 0 ? (
          <div className="space-y-2">
            {friends.map(f => (
              <div key={f.id} className="flex items-center gap-2 text-sm">
                <span className="text-base">🤝</span>
                <span className="text-text-primary">{f.nickname}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-text-tertiary">아직 초대한 친구가 없어요</p>
        )}
      </GlassCard>

      <div className="text-center text-xs text-text-tertiary space-y-1">
        <p>🤝 1명 초대 → 리크루터 Lv.1</p>
        <p>🤝 3명 초대 → 리크루터 Lv.2</p>
        <p>🤝 10명 초대 → 리크루터 Lv.3</p>
        <p>🎪 30명 초대 → <span className="text-amber-400 font-bold">초대왕</span></p>
      </div>
    </div>
  );
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
          {/* 동적 배지 (선수/팀 덕후) */}
          {badges.filter(b => b.badge_id.startsWith("fan-")).length > 0 && (
            <GlassCard className="p-4">
              <h3 className="text-sm font-bold text-text-primary mb-3">⚾ 나의 덕질 배지</h3>
              <div className="grid grid-cols-4 gap-3">
                {badges.filter(b => b.badge_id.startsWith("fan-")).map(b => {
                  const info = getBadgeInfo(b.badge_id);
                  if (!info) return null;
                  return (
                    <motion.div key={b.badge_id} className="text-center p-2 rounded-xl bg-white/5">
                      <span className="text-2xl">{info.icon}</span>
                      <p className="text-[10px] mt-1 font-medium" style={{ color: RARITY_COLORS[info.rarity] }}>
                        {info.name}
                      </p>
                    </motion.div>
                  );
                })}
              </div>
            </GlassCard>
          )}

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
        <InviteTab userId={user!.id} inviteCount={profile.invite_count || 0} />
      )}
    </div>
  );
}
