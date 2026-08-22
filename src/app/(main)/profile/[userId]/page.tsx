"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSafeBack } from "@/lib/hooks/useSafeBack";
import { ChevronLeft } from "lucide-react";
import HeaderProfileLink from "@/components/ui/HeaderProfileLink";
import { supabase } from "@/lib/supabase/client";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getTeamById } from "@/lib/constants/teams";
import TeamBadge from "@/components/ui/TeamBadge";
import GlassCard from "@/components/ui/GlassCard";
import type { BadgeDefinition } from "@/lib/constants/badges";
import { getTeamBorderColorById } from "@/lib/utils/team-border-color";
import { getAvatarPath } from "@/lib/constants/avatars";
import { getTeamBgColorById } from "@/lib/utils/team";
import InviteTab from "@/components/profile/InviteTab";
import BadgeDetailModal from "@/components/profile/BadgeDetailModal";
import BadgesTab from "@/components/profile/BadgesTab";
import DMButton from "@/components/ui/DMButton";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import CommunityProfilePostRow, { type CommunityProfilePost } from "@/components/profile/CommunityProfilePostRow";
import { nextProfilePostsPage, profilePostsRange, splitProfilePostsPage } from "@/lib/utils/profile-posts-page";

interface UserProfile {
  id: string;
  nickname: string;
  avatar_url?: string | null;
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
  favorite_players?: { playerId: string; name: string; teamId: number; number: number }[];
}

interface UserBadge {
  badge_id: string;
  earned_at: string;
}

type UserPost = CommunityProfilePost;

/**
 * 프로필 작성글 목록 한 페이지.
 *
 * 2026-08-22 이전에는 `.limit(20)` 하나로 끝나 21번째 글부터는 **어떤 경로로도 도달할 수 없었다**
 * (하린아빠 #cs 제보 "최근 글만 보이고 예전 글이 안 보인다"). 헤더 카운트는 `count: exact` 라
 * 숫자와 목록이 서로 어긋나 보이기까지 했다. 그래서 range 페이저로 바꾼다.
 *
 * 정렬은 `created_at desc, id desc` — created_at 단독은 유니크가 아니라 같은 초에 쓴 글이
 * 페이지 경계에서 중복·누락될 수 있다(query-pagination-guard 의 non_unique_pagination 계약).
 */
async function fetchProfilePostsPage(authorId: string, page: number): Promise<{ rows: UserPost[]; hasMore: boolean }> {
  const { from, to } = profilePostsRange(page);
  // query-guard: bounded-page -- 프로필 글 탭 더보기 페이저(한 페이지 20건, 유니크 정렬 created_at+id)
  const { data, error } = await supabase
    .from("posts")
    .select("id, title, content, board_type, board_id, content_type, image_urls, like_count, comment_count, created_at, team_tags, player_tags")
    .eq("author_id", authorId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to);
  // 조회 실패를 빈 페이지로 삼키면 "글이 없다"로 오독된다 — 더보기는 남겨두고 rows 만 비운다.
  if (error || !data) return { rows: [], hasMore: page > 0 };
  return splitProfilePostsPage(data as UserPost[]);
}

export default function ProfilePage() {
  const { userId } = useParams();
  const router = useRouter();
  const goBack = useSafeBack("/");
  const { user } = useAuth();
  const isOwn = user?.id === userId;

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [badges, setBadges] = useState<UserBadge[]>([]);
  const [posts, setPosts] = useState<UserPost[]>([]);
  const [postsHasMore, setPostsHasMore] = useState(false);
  const [postsLoadingMore, setPostsLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedBadge, setSelectedBadge] = useState<BadgeDefinition | null>(null);
  const [activeTab, setActiveTab] = useState<"badges" | "posts" | "invite">("badges");

  useEffect(() => {
    async function load() {
      const { data: p } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", userId)
        .maybeSingle();
      if (p) {
        // 실시간 카운트 조회 (캐시 컬럼이 0일 수 있으므로)
        const [postsCount, commentsCount, likesCount] = await Promise.all([
          supabase.from("posts").select("id", { count: "exact", head: true }).eq("author_id", userId),
          supabase.from("comments").select("id", { count: "exact", head: true }).eq("author_id", userId),
          supabase.from("posts").select("like_count", { count: "exact", head: false }).eq("author_id", userId),
        ]);
        // 받은 좋아요 = 내 글들의 like_count 합산
        const totalLikes = likesCount.data?.reduce((sum: number, p: { like_count: number }) => sum + (p.like_count || 0), 0) ?? 0;
        setProfile({
          ...p,
          total_posts: postsCount.count ?? p.total_posts ?? 0,
          total_comments: commentsCount.count ?? p.total_comments ?? 0,
          total_likes_received: totalLikes,
        } as UserProfile);
      }

      const { data: b } = await supabase
        .from("user_badges")
        .select("badge_id, earned_at")
        .eq("user_id", userId)
        .order("earned_at", { ascending: false });
      if (b) setBadges(b);

      // 본인 프로필이면 배지 체크 트리거 (새 배지 자동 부여)
      if (user?.id === userId) {
        fetch("/api/badges", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId }),
        })
          .then(res => res.json())
          .then(data => {
            if (data.newBadges?.length > 0) {
              // 새 배지가 부여되면 배지 목록 새로고침
              supabase
                .from("user_badges")
                .select("badge_id, earned_at")
                .eq("user_id", userId)
                .order("earned_at", { ascending: false })
                .then(({ data: refreshed }) => {
                  if (refreshed) setBadges(refreshed);
                });
            }
          })
          .catch(() => {});
      }

      if (p?.show_posts) {
        const first = await fetchProfilePostsPage(String(userId), 0);
        setPosts(first.rows);
        setPostsHasMore(first.hasMore);
      }

      setLoading(false);
    }
    load();
  }, [userId, user]);

  // 더보기 — page 상태 대신 이미 받은 개수로 다음 페이지를 유도한다(중복 클릭 시 같은 페이지 재요청 방지).
  async function loadMorePosts() {
    if (postsLoadingMore || !postsHasMore) return;
    setPostsLoadingMore(true);
    try {
      const next = await fetchProfilePostsPage(String(userId), nextProfilePostsPage(posts.length));
      setPosts(prev => {
        // 같은 글이 두 번 들어오면 React key 가 충돌한다 — id 기준으로 합친다.
        const seen = new Set(prev.map(p => p.id));
        return [...prev, ...next.rows.filter(p => !seen.has(p.id))];
      });
      setPostsHasMore(next.hasMore);
    } finally {
      setPostsLoadingMore(false);
    }
  }

  if (loading) return <div className="flex items-center justify-center h-screen text-text-secondary">로딩 중...</div>;
  if (!profile) return <div className="flex items-center justify-center h-screen text-text-secondary">유저를 찾을 수 없습니다</div>;

  const team = getTeamById(profile.team_id);
  const earnedBadgeIds = new Set(badges.map(b => b.badge_id));
  const founderBadge = earnedBadgeIds.has("founder");
  const chairmanBadge = earnedBadgeIds.has("chairman");
  const singerBadge = earnedBadgeIds.has("keubo-singer");
  const chairmanSpouseBadge = earnedBadgeIds.has("chairman-spouse");

  const timeAgo = (date: string) => {
    const d = new Date(date);
    return d.toLocaleDateString("ko-KR");
  };

  return (
    <div className="mx-auto min-h-screen max-w-lg bg-bg-primary px-5 pb-24">
      {/* Header */}
      <div className="sticky top-0 z-30 border-b -mx-5 px-5 bg-bg-primary" style={{ borderColor: profile?.team_id ? getTeamBorderColorById(profile.team_id) : 'var(--color-border)', paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))", marginTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) * -1)" }}>
        <div className="flex items-center gap-3 min-h-[44px]">
          <button onClick={goBack} aria-label="뒤로가기" className="flex h-11 w-11 items-center justify-center rounded-full text-text-secondary hover:bg-bg-tertiary transition-colors">
            <ChevronLeft size={24} />
          </button>
          <span className="text-lg font-semibold leading-[26px] text-text-primary flex-1">프로필</span>
          <HeaderProfileLink />
        </div>
      </div>

      {/* Profile Header */}
      <div className="pt-6 pb-4 text-center">
        <div className="relative inline-block">
          <div className="mx-auto h-24 w-24 overflow-hidden rounded-full ring-1 ring-white/10">
            {profile.avatar_url && getAvatarPath(profile.avatar_url) ? (
              <img src={getAvatarPath(profile.avatar_url)!} alt="" className="h-full w-full object-cover" />
            ) : (
              <div
                className="flex h-full w-full items-center justify-center text-3xl font-bold"
                style={{ backgroundColor: getTeamBgColorById(profile.team_id), color: "#fff" }}
              >
                {profile.nickname.charAt(0)}
              </div>
            )}
          </div>
          {founderBadge && (
            <span className="absolute -top-1 -right-1 text-xl" aria-label="파운더">👑</span>
          )}
        </div>

        <h1 className="mt-4 text-2xl font-bold tracking-tight text-text-primary">{profile.nickname}</h1>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          {team && <TeamBadge teamId={team.id} size="sm" />}
          {chairmanBadge && (
            <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-amber-500/25 text-amber-300 ring-1 ring-amber-400/50">🏛️ 크보팬 회장</span>
          )}
          {chairmanSpouseBadge && (
            <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-amber-500/25 text-amber-300 ring-1 ring-amber-400/50">🎩 크보팬 회장남편</span>
          )}
          {singerBadge && (
            <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-amber-500/25 text-amber-300 ring-1 ring-amber-400/50">🎤 크보팬 전속가수</span>
          )}
          {profile.is_founder && (
            <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-amber-500/20 text-amber-400">FOUNDER</span>
          )}
        </div>
        {profile.bio && (
          <p className="mt-2 text-sm leading-[22px] text-text-tertiary">{profile.bio}</p>
        )}
        <p className="mt-1 text-xs leading-[18px] text-text-tertiary">가입일 {timeAgo(profile.joined_at || profile.id)}</p>
        {!isOwn && (
          <div className="mt-4 flex justify-center">
            <DMButton targetUserId={profile.id} size="md" />
          </div>
        )}
      </div>

      {/* Stats — compact card, tabular-nums */}
      <div className="mb-4">
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

      {/* 관심 선수 */}
      {profile.favorite_players && profile.favorite_players.length > 0 && (
        <div className="mb-4">
          <p className="text-sm font-medium text-text-secondary mb-2">관심 선수</p>
          <div className="flex justify-between">
            {profile.favorite_players.map((p) => (
              <button
                key={p.playerId}
                onClick={() => router.push(`/community/players/${p.playerId}`)}
                className="flex flex-col items-center gap-1 flex-1 min-w-0"
              >
                <PlayerAvatar
                  name={p.name}
                  teamId={p.teamId}
                  photoUrl={getPlayerPhotoUrl(p.name, p.playerId)}
                  number={0}
                  size={48}
                />
                <span className="text-[11px] text-text-secondary truncate w-full text-center">{p.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Tabs — UnderlineTabs */}
      <div className="flex gap-4 mb-4 border-b border-border">
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
        <div className="space-y-3">
          {!profile.show_posts && !isOwn ? (
            <div className="text-center py-8 text-text-tertiary text-sm">비공개 프로필입니다</div>
          ) : posts.length === 0 ? (
            <div className="text-center py-8 text-text-tertiary text-sm">아직 작성한 글이 없어요</div>
          ) : (
            <>
              {posts.map(post => (
                <CommunityProfilePostRow
                  key={post.id}
                  post={post}
                  timeLabel={timeAgo(post.created_at)}
                  onNavigate={(href) => router.push(href)}
                />
              ))}
              {/* 더보기 — 이게 없으면 21번째 글은 영영 도달 불가능하다(2026-08-22 제보). */}
              {postsHasMore && (
                <button
                  type="button"
                  data-profile-posts-load-more
                  onClick={loadMorePosts}
                  disabled={postsLoadingMore}
                  className="w-full rounded-xl border border-border py-3 text-sm font-medium text-text-secondary transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
                >
                  {postsLoadingMore ? "불러오는 중..." : "더보기"}
                </button>
              )}
            </>
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
