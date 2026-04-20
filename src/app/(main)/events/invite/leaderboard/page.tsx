"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, Trophy, Users, MessageSquare } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { getTeamById } from "@/lib/constants/teams";
import { useAuth } from "@/lib/supabase/AuthContext";
import { supabase } from "@/lib/supabase/client";

type Track = "invite" | "writing";

interface InviteRow {
  user_id: string;
  nickname: string;
  team_id: number | null;
  invite_count: number;
  last_activated_at: string;
}

interface WritingRow {
  user_id: string;
  nickname: string;
  team_id: number | null;
  total_points: number;
  last_active_day: string;
}

interface MyRank {
  rank: number | null;
  score?: number;
  nickname?: string;
  team_id?: number | null;
  total?: number;
  reason?: string;
}

export default function LeaderboardPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [track, setTrack] = useState<Track>("invite");
  const [rows, setRows] = useState<(InviteRow | WritingRow)[]>([]);
  const [myRank, setMyRank] = useState<MyRank | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const r = await fetch(`/api/leaderboard/${track}?limit=100`, {
          cache: "no-store",
        });
        const j = await r.json();
        if (!cancelled) setRows(j.rows ?? []);
      } catch {
        if (!cancelled) setRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }

      if (user) {
        try {
          const { data: { session } } = await supabase.auth.getSession();
          const token = session?.access_token;
          const r = await fetch(`/api/leaderboard/my-rank?track=${track}`, {
            cache: "no-store",
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          });
          const j = await r.json();
          if (!cancelled) setMyRank(j);
        } catch {
          if (!cancelled) setMyRank(null);
        }
      } else {
        setMyRank(null);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [track, user]);

  return (
    <div className="min-h-screen bg-[#0A0A0B] text-white pb-24">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-[#0A0A0B]/90 backdrop-blur border-b border-white/10">
        <div className="max-w-screen-sm mx-auto px-4 py-3 flex items-center gap-3">
          <button
            onClick={() => router.back()}
            className="p-1 -ml-1"
            aria-label="뒤로"
          >
            <ChevronLeft size={24} />
          </button>
          <h1 className="font-bold text-lg">리더보드</h1>
        </div>
      </div>

      <div className="max-w-screen-sm mx-auto px-4 pt-4">
        {/* Track Tabs */}
        <div className="grid grid-cols-2 gap-2 mb-4">
          <TrackTab
            active={track === "invite"}
            onClick={() => setTrack("invite")}
            icon={<Users size={16} />}
            label="초대 랭킹"
          />
          <TrackTab
            active={track === "writing"}
            onClick={() => setTrack("writing")}
            icon={<MessageSquare size={16} />}
            label="글쓰기 랭킹"
          />
        </div>

        {/* My Rank Sticky */}
        {user && myRank && (
          <MyRankCard myRank={myRank} track={track} />
        )}
        {!user && (
          <GlassCard className="mb-4 p-4 text-center">
            <p className="text-sm text-white/70">
              로그인하면 내 순위를 볼 수 있어요
            </p>
          </GlassCard>
        )}

        {/* Leaderboard list */}
        {loading ? (
          <div className="text-center py-12 text-white/50 text-sm">
            불러오는 중…
          </div>
        ) : rows.length === 0 ? (
          <EmptyState track={track} />
        ) : (
          <div className="space-y-2">
            {rows.map((row, idx) => (
              <RankRow
                key={row.user_id}
                rank={idx + 1}
                row={row}
                track={track}
                isMe={user?.id === row.user_id}
              />
            ))}
          </div>
        )}

        {/* Footer info */}
        <div className="mt-8 text-xs text-white/40 text-center leading-relaxed">
          <p>이벤트 기간: 2026-04-20 ~ 2026-05-31</p>
          <p className="mt-1">
            {track === "invite"
              ? "활성화된 초대만 집계 (팀 선택 + 글/댓글 1건)"
              : "채팅 1pt · 댓글 2pt · 글 3pt · 사진글 5pt · 일 150pt 상한"}
          </p>
        </div>
      </div>
    </div>
  );
}

function TrackTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`py-2.5 rounded-lg border text-sm font-semibold flex items-center justify-center gap-1.5 transition-colors ${
        active
          ? "bg-white text-black border-white"
          : "bg-white/5 text-white/70 border-white/10"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function MyRankCard({ myRank, track }: { myRank: MyRank; track: Track }) {
  const team = myRank.team_id ? getTeamById(myRank.team_id) : null;

  if (myRank.rank === null) {
    return (
      <GlassCard className="mb-4 p-3 border border-white/10">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-white/50">내 순위</p>
            <p className="text-sm text-white/70">
              {track === "invite"
                ? "아직 활성화된 초대가 없어요"
                : "아직 작성한 글/댓글/채팅이 없어요"}
            </p>
          </div>
        </div>
      </GlassCard>
    );
  }

  return (
    <GlassCard className="mb-4 p-3 border border-yellow-400/30 bg-yellow-400/5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="text-2xl font-bold text-yellow-400">
            #{myRank.rank}
          </div>
          <div>
            <p className="text-xs text-white/50">내 순위 · {myRank.total}명 중</p>
            <p className="font-bold flex items-center gap-1.5">
              {myRank.nickname}
              {team && (
                <span
                  className="text-xs px-1.5 py-0.5 rounded"
                  style={{
                    background: `${team.colorPrimary}30`,
                    color: team.colorPrimary,
                  }}
                >
                  {team.shortName}
                </span>
              )}
            </p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-xl font-bold">
            {myRank.score}
            <span className="text-xs font-normal text-white/50 ml-1">
              {track === "invite" ? "명" : "pt"}
            </span>
          </p>
        </div>
      </div>
    </GlassCard>
  );
}

function RankRow({
  rank,
  row,
  track,
  isMe,
}: {
  rank: number;
  row: InviteRow | WritingRow;
  track: Track;
  isMe: boolean;
}) {
  const team = row.team_id ? getTeamById(row.team_id) : null;
  const score = track === "invite"
    ? (row as InviteRow).invite_count
    : (row as WritingRow).total_points;
  const unit = track === "invite" ? "명" : "pt";

  const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : null;

  return (
    <div
      className={`flex items-center justify-between px-3 py-2.5 rounded-lg border ${
        isMe
          ? "bg-yellow-400/5 border-yellow-400/30"
          : "bg-white/5 border-white/5"
      }`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-8 text-center font-bold text-sm shrink-0">
          {medal ?? rank}
        </div>
        <div className="min-w-0">
          <p className="font-semibold truncate flex items-center gap-1.5">
            {row.nickname}
            {team && (
              <span
                className="text-xs px-1.5 py-0.5 rounded shrink-0"
                style={{
                  background: `${team.colorPrimary}30`,
                  color: team.colorPrimary,
                }}
              >
                {team.shortName}
              </span>
            )}
          </p>
        </div>
      </div>
      <div className="font-bold text-sm shrink-0">
        {score}
        <span className="text-xs font-normal text-white/50 ml-0.5">{unit}</span>
      </div>
    </div>
  );
}

function EmptyState({ track }: { track: Track }) {
  return (
    <div className="text-center py-16">
      <Trophy size={48} className="mx-auto mb-4 text-white/20" />
      <p className="text-white/60 font-semibold mb-1">
        {track === "invite" ? "첫 초대자를 기다립니다" : "첫 참가자를 기다립니다"}
      </p>
      <p className="text-xs text-white/40">
        {track === "invite"
          ? "친구를 초대하고 첫 1위가 되어보세요"
          : "채팅 · 댓글 · 글로 점수를 쌓아보세요"}
      </p>
    </div>
  );
}
