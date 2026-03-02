import { supabase } from "./client";

interface BadgeRule {
  id: string;
  check: (stats: UserStats) => boolean;
}

interface UserStats {
  totalPosts: number;
  totalComments: number;
  totalLikes: number;
  totalPhotos: number;
  predictCorrect: number;
  predictStreak: number;
  attendanceDays: number;
  inviteCount: number;
  tutorialComplete: boolean;
  teamsVisited: number;
  saberViews: number;
  // per-player/team
  playerActivity: Record<string, number>; // playerId → post+comment count
  teamActivity: Record<string, number>;   // teamId → post+comment count
}

const BADGE_RULES: BadgeRule[] = [
  // 커뮤니티
  { id: "debut", check: s => s.totalPosts >= 1 },
  { id: "writer-1", check: s => s.totalPosts + s.totalComments >= 10 },
  { id: "writer-2", check: s => s.totalPosts + s.totalComments >= 30 },
  { id: "writer-3", check: s => s.totalPosts + s.totalComments >= 70 },
  { id: "writer-4", check: s => s.totalPosts + s.totalComments >= 150 },
  { id: "writer-5", check: s => s.totalPosts + s.totalComments >= 300 },
  { id: "popular-1", check: s => s.totalLikes >= 10 },
  { id: "popular-2", check: s => s.totalLikes >= 50 },
  { id: "popular-3", check: s => s.totalLikes >= 100 },
  { id: "popular-4", check: s => s.totalLikes >= 300 },
  { id: "popular-5", check: s => s.totalLikes >= 1000 },
  { id: "attendance-7", check: s => s.attendanceDays >= 7 },
  { id: "attendance-30", check: s => s.attendanceDays >= 30 },
  { id: "attendance-100", check: s => s.attendanceDays >= 100 },

  // 예측
  { id: "predictor-1", check: s => s.predictCorrect >= 5 },
  { id: "predictor-2", check: s => s.predictCorrect >= 15 },
  { id: "predictor-3", check: s => s.predictCorrect >= 30 },
  { id: "predictor-4", check: s => s.predictCorrect >= 60 },
  { id: "predictor-5", check: s => s.predictCorrect >= 100 },
  { id: "streak-3", check: s => s.predictStreak >= 3 },
  { id: "streak-5", check: s => s.predictStreak >= 5 },
  { id: "streak-10", check: s => s.predictStreak >= 10 },

  // 팬 활동
  { id: "photographer-1", check: s => s.totalPhotos >= 5 },
  { id: "photographer-2", check: s => s.totalPhotos >= 20 },
  { id: "photographer-3", check: s => s.totalPhotos >= 50 },

  // 초대
  { id: "inviter-1", check: s => s.inviteCount >= 1 },
  { id: "inviter-3", check: s => s.inviteCount >= 3 },
  { id: "inviter-10", check: s => s.inviteCount >= 10 },
  { id: "inviter-30", check: s => s.inviteCount >= 30 },

  // 지식
  { id: "graduate", check: s => s.tutorialComplete },
  { id: "explorer", check: s => s.teamsVisited >= 10 },
  { id: "analyst", check: s => s.saberViews >= 10 },
];

// 선수/팀 배지 동적 생성
function getDynamicBadges(stats: UserStats): string[] {
  const earned: string[] = [];
  const thresholds = [5, 15, 30, 60, 100];

  // fan-player:{playerId}:1~5, fan-team:{teamId}:1~5
  for (const [playerId, count] of Object.entries(stats.playerActivity)) {
    for (let i = 0; i < thresholds.length; i++) {
      if (count >= thresholds[i]) earned.push(`fan-player:${playerId}:${i + 1}`);
    }
  }
  for (const [teamId, count] of Object.entries(stats.teamActivity)) {
    for (let i = 0; i < thresholds.length; i++) {
      if (count >= thresholds[i]) earned.push(`fan-team:${teamId}:${i + 1}`);
    }
  }
  return earned;
}

// 유저 통계 수집
async function getUserStats(userId: string): Promise<UserStats> {
  // 글 수
  const { count: postCount } = await supabase
    .from("posts")
    .select("*", { count: "exact", head: true })
    .eq("author_id", userId);

  // 댓글 수
  const { count: commentCount } = await supabase
    .from("comments")
    .select("*", { count: "exact", head: true })
    .eq("author_id", userId);

  // 받은 좋아요
  const { data: myPosts } = await supabase
    .from("posts")
    .select("like_count")
    .eq("author_id", userId);
  const totalLikes = (myPosts || []).reduce((sum, p) => sum + (p.like_count || 0), 0);

  // 초대 수
  const { count: inviteCount } = await supabase
    .from("invitations")
    .select("*", { count: "exact", head: true })
    .eq("inviter_id", userId)
    .not("used_at", "is", null);

  // 선수 게시판 활동 (board_type = 'player')
  const { data: playerPosts } = await supabase
    .from("posts")
    .select("board_id")
    .eq("author_id", userId)
    .eq("board_type", "player");
  const playerActivity: Record<string, number> = {};
  (playerPosts || []).forEach(p => {
    playerActivity[p.board_id] = (playerActivity[p.board_id] || 0) + 1;
  });

  // 팀 게시판 활동
  const { data: teamPosts } = await supabase
    .from("posts")
    .select("board_id")
    .eq("author_id", userId)
    .eq("board_type", "team");
  const teamActivity: Record<string, number> = {};
  (teamPosts || []).forEach(p => {
    teamActivity[p.board_id] = (teamActivity[p.board_id] || 0) + 1;
  });

  return {
    totalPosts: postCount || 0,
    totalComments: commentCount || 0,
    totalLikes,
    totalPhotos: 0, // TODO: photo gallery count
    predictCorrect: 0, // TODO: after season ends
    predictStreak: 0,
    attendanceDays: 0, // TODO: login tracking
    inviteCount: inviteCount || 0,
    tutorialComplete: false, // TODO: localStorage check
    teamsVisited: 0,
    saberViews: 0,
    playerActivity,
    teamActivity,
  };
}

// 메인 엔진: 유저의 배지 체크 + 새 배지 부여
export async function checkAndAwardBadges(userId: string): Promise<string[]> {
  const stats = await getUserStats(userId);

  // 기존 배지 조회
  const { data: existing } = await supabase
    .from("user_badges")
    .select("badge_id")
    .eq("user_id", userId);
  const existingIds = new Set((existing || []).map(b => b.badge_id));

  // 새로 얻을 배지 계산
  const earned: string[] = [];

  // 정적 규칙
  for (const rule of BADGE_RULES) {
    if (!existingIds.has(rule.id) && rule.check(stats)) {
      earned.push(rule.id);
    }
  }

  // 동적 배지 (선수/팀)
  for (const badgeId of getDynamicBadges(stats)) {
    if (!existingIds.has(badgeId)) {
      earned.push(badgeId);
    }
  }

  // DB에 저장
  if (earned.length > 0) {
    const rows = earned.map(badge_id => ({ user_id: userId, badge_id }));
    await supabase.from("user_badges").insert(rows);

    // profiles 통계 업데이트
    await supabase
      .from("profiles")
      .update({
        total_posts: stats.totalPosts,
        total_comments: stats.totalComments,
        total_likes_received: stats.totalLikes,
      })
      .eq("id", userId);
  }

  return earned;
}
