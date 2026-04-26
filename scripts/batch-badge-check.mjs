/**
 * 전체 유저 대상 배지 일괄 체크 스크립트
 * Usage: node scripts/batch-badge-check.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

// Parse .env.local manually (no dotenv dependency)
const envFile = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8");
for (const line of envFile.split("\n")) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match && !process.env[match[1].trim()]) {
    process.env[match[1].trim()] = match[2].trim();
  }
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey);

// Badge rules (mirrored from badge-engine.ts)
const BADGE_RULES = [
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
  { id: "inviter-1", check: s => s.inviteCount >= 1 },
  { id: "inviter-5", check: s => s.inviteCount >= 5 },
  { id: "inviter-10", check: s => s.inviteCount >= 10 },
  { id: "inviter-30", check: s => s.inviteCount >= 30 },
  { id: "inviter-50", check: s => s.inviteCount >= 50 },
  { id: "pioneer-2026", check: s => s.inviteCount >= 20 && new Date() <= new Date("2026-07-01T00:00:00+09:00") },
];

async function getUserStats(userId) {
  const { count: postCount } = await supabase
    .from("posts")
    .select("*", { count: "exact", head: true })
    .eq("author_id", userId);

  const { count: commentCount } = await supabase
    .from("comments")
    .select("*", { count: "exact", head: true })
    .eq("author_id", userId);

  const { data: myPosts } = await supabase
    .from("posts")
    .select("like_count")
    .eq("author_id", userId);
  const totalLikes = (myPosts || []).reduce((sum, p) => sum + (p.like_count || 0), 0);

  const { count: inviteCount } = await supabase
    .from("invitations")
    .select("*", { count: "exact", head: true })
    .eq("inviter_id", userId)
    .not("activated_at", "is", null);

  // 선수/팀 활동
  const { data: playerPosts } = await supabase
    .from("posts")
    .select("board_id")
    .eq("author_id", userId)
    .eq("board_type", "player");
  const playerActivity = {};
  (playerPosts || []).forEach(p => {
    playerActivity[p.board_id] = (playerActivity[p.board_id] || 0) + 1;
  });

  const { data: teamPosts } = await supabase
    .from("posts")
    .select("board_id")
    .eq("author_id", userId)
    .eq("board_type", "team");
  const teamActivity = {};
  (teamPosts || []).forEach(p => {
    teamActivity[p.board_id] = (teamActivity[p.board_id] || 0) + 1;
  });

  return {
    totalPosts: postCount || 0,
    totalComments: commentCount || 0,
    totalLikes,
    inviteCount: inviteCount || 0,
    playerActivity,
    teamActivity,
  };
}

function getDynamicBadges(stats) {
  const earned = [];
  const thresholds = [5, 15, 30, 60, 100];
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

async function checkAndAwardBadges(userId) {
  const stats = await getUserStats(userId);
  const { data: existing } = await supabase
    .from("user_badges")
    .select("badge_id")
    .eq("user_id", userId);
  const existingIds = new Set((existing || []).map(b => b.badge_id));

  const earned = [];

  for (const rule of BADGE_RULES) {
    if (!existingIds.has(rule.id) && rule.check(stats)) {
      earned.push(rule.id);
    }
  }

  for (const badgeId of getDynamicBadges(stats)) {
    if (!existingIds.has(badgeId)) {
      earned.push(badgeId);
    }
  }

  if (earned.length > 0) {
    const rows = earned.map(badge_id => ({ user_id: userId, badge_id }));
    await supabase.from("user_badges").insert(rows);

    await supabase.from("profiles").update({
      total_posts: stats.totalPosts,
      total_comments: stats.totalComments,
      total_likes_received: stats.totalLikes,
    }).eq("id", userId);
  }

  return { stats, earned };
}

// Main
async function main() {
  console.log("=== 전체 유저 배지 일괄 체크 시작 ===\n");

  // Supabase default limit은 1000이므로 pagination 필요
  const allUsers = [];
  let from = 0;
  const PAGE_SIZE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, nickname")
      .range(from, from + PAGE_SIZE - 1);
    if (error) { console.error("유저 목록 조회 실패:", error); process.exit(1); }
    if (!data || data.length === 0) break;
    allUsers.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  const users = allUsers;

  if (users.length === 0) {
    console.error("유저 없음");
    process.exit(1);
  }

  console.log(`총 ${users.length}명 유저 대상\n`);

  let totalNew = 0;

  for (const user of users) {
    try {
      const { stats, earned } = await checkAndAwardBadges(user.id);
      if (earned.length > 0) {
        console.log(`✅ ${user.nickname} (${user.id.slice(0, 8)}...)`);
        console.log(`   stats: 글 ${stats.totalPosts} / 댓글 ${stats.totalComments} / 좋아요 ${stats.totalLikes} / 초대 ${stats.inviteCount}`);
        console.log(`   새 배지: ${earned.join(", ")}`);
        totalNew += earned.length;
      }
    } catch (e) {
      console.error(`❌ ${user.nickname} 실패:`, e.message);
    }
  }

  console.log(`\n=== 완료: ${totalNew}개 새 배지 부여 ===`);
}

main().catch(console.error);
