"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSafeBack } from "@/lib/hooks/useSafeBack";
import { ChevronLeft, Trophy, Users, MessageSquare, Gift, Crown } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { getTeamById, getTeamBgColor } from "@/lib/constants/teams";
import { useAuth } from "@/lib/supabase/AuthContext";
import { useTheme } from "@/components/ThemeProvider";
import { supabase } from "@/lib/supabase/client";
import { getPrizesByTrack, PrizeTier } from "@/lib/events/prizes";

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

// 이벤트 종료(KST 6/1 00:00) 후엔 라이브 리더보드 대신 결과공지로 보냄
const EVENT_END_MS = new Date("2026-06-01T00:00:00+09:00").getTime();
const RESULT_PATH = "/whats-new";

export default function LeaderboardPage() {
  const router = useRouter();
  const goBack = useSafeBack("/events/invite");
  const { user } = useAuth();
  const eventEnded = Date.now() >= EVENT_END_MS;
  // 2026-04-20 삼순이/하린아빠 합의: 기본 탭은 글쓰기 — 데이터 더 풍부한 쪽을 먼저 노출
  const [track, setTrack] = useState<Track>("writing");
  const [rows, setRows] = useState<(InviteRow | WritingRow)[]>([]);
  const [myRank, setMyRank] = useState<MyRank | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (eventEnded) router.replace(RESULT_PATH);
  }, [eventEnded, router]);

  useEffect(() => {
    if (eventEnded) return;
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
  }, [track, user, eventEnded]);

  if (eventEnded) {
    return <div className="min-h-screen bg-[#0A0A0B]" aria-hidden />;
  }

  return (
    <div className="min-h-screen bg-[#0A0A0B] text-white pb-24">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-[#0A0A0B]/90 backdrop-blur border-b border-white/10" style={{ paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))", marginTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) * -1)" }}>
        <div className="max-w-screen-sm mx-auto px-5 min-h-[44px] flex items-center gap-3">
          <button
            onClick={goBack}
            className="flex h-11 w-11 items-center justify-center -ml-2.5"
            aria-label="뒤로가기"
          >
            <ChevronLeft size={24} />
          </button>
          <h1 className="font-bold text-lg">리더보드</h1>
        </div>
      </div>

      <div className="max-w-screen-sm mx-auto px-5 pt-4">
        {/* Track Tabs — 2026-04-20 하린아빠 지시: 글쓰기가 좌측(기본) */}
        <div className="grid grid-cols-2 gap-2 mb-4">
          <TrackTab
            active={track === "writing"}
            onClick={() => setTrack("writing")}
            icon={<MessageSquare size={16} />}
            label="글쓰기 랭킹"
          />
          <TrackTab
            active={track === "invite"}
            onClick={() => setTrack("invite")}
            icon={<Users size={16} />}
            label="초대 랭킹"
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
          <p>이벤트 기간: 2026-04-20 ~ 2026-05-31 (전체 누적 집계)</p>
          <p className="mt-1">
            {track === "invite"
              ? "활성화된 초대만 집계 (팀 선택 + 글/댓글 1건)"
              : "채팅 1pt · 댓글 2pt · 글 3pt · 사진글 5pt · 일 150pt 상한"}
          </p>
        </div>

        {/* 순위별 상품 표 — 2026-04-20 하린아빠/삼순이 추가 지시 */}
        <PrizeTable track={track} />

        <div className="h-20" />
      </div>
    </div>
  );
}

function PrizeTable({ track }: { track: Track }) {
  const prizes = getPrizesByTrack(track);
  const trackLabel = track === "invite" ? "초대 이벤트" : "글쓰기 이벤트";

  return (
    <div className="mt-8">
      <div className="flex items-center gap-2 mb-3 px-1">
        <Gift size={16} className="text-yellow-400/80" />
        <h2 className="font-bold text-sm text-white/90">
          {trackLabel} 순위별 상품
        </h2>
      </div>
      <div className="space-y-1.5">
        {prizes.map((tier) => (
          <PrizeRow key={tier.rank} tier={tier} />
        ))}
      </div>
      <p className="mt-3 text-[11px] text-white/40 text-center leading-relaxed">
        · 상위 50명에게 시즌 한정 얼리멤버 뱃지와 상품 1개 지급
        <br />
        · 최종 순위는 5월 31일 기준으로 확정
      </p>
    </div>
  );
}

function PrizeRow({ tier }: { tier: PrizeTier }) {
  return (
    <div
      className={`flex items-center gap-3 px-3 py-3 rounded-xl ${
        tier.highlight
          ? "bg-gradient-to-r from-yellow-500/15 to-yellow-500/5 border border-yellow-500/30"
          : "bg-white/5 border border-white/10"
      }`}
    >
      <div className="w-14 shrink-0 flex items-center gap-1">
        {tier.highlight && <Crown size={13} className="text-yellow-400" />}
        <span
          className={`text-xs font-bold ${
            tier.highlight ? "text-yellow-300" : "text-white/80"
          }`}
        >
          {tier.rank}
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <p
          className={`text-sm font-semibold ${
            tier.highlight ? "text-yellow-200" : "text-white/90"
          }`}
        >
          {tier.prize}
        </p>
        <p className="text-[11px] text-white/50 mt-0.5">
          {tier.count}명 · 시즌 한정 뱃지 · <span className="text-white/70">{tier.badge}</span>
        </p>
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
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const theme: "dark" | "light" = mounted ? resolvedTheme : "dark";

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
              {team && (() => {
                const bg = getTeamBgColor(team, theme);
                return (
                  <span
                    className="text-xs px-1.5 py-0.5 rounded"
                    style={{
                      background: `${bg}30`,
                      color: bg,
                    }}
                  >
                    {team.shortName}
                  </span>
                );
              })()}
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
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const theme: "dark" | "light" = mounted ? resolvedTheme : "dark";
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
            {team && (() => {
              const bg = getTeamBgColor(team, theme);
              return (
                <span
                  className="text-xs px-1.5 py-0.5 rounded shrink-0"
                  style={{
                    background: `${bg}30`,
                    color: bg,
                  }}
                >
                  {team.shortName}
                </span>
              );
            })()}
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

/**
 * EmptyState — 순위표 프레임을 유지한 채 "아직 없음" 안내 렌더
 * 2026-04-20 하린아빠 지시: "공백화면" 제거, 남이 보는 것과 동일한 순위표 레이아웃 + 안내 메시지
 */
function EmptyState({ track }: { track: Track }) {
  const message =
    track === "invite"
      ? "아직 완료된 초대가 없습니다"
      : "아직 집계된 글쓰기 점수가 없습니다";
  const hint =
    track === "invite"
      ? "초대한 친구가 팀을 선택하고 글/댓글 1건을 작성하면 자동으로 등장해요"
      : "채팅 · 댓글 · 글로 점수를 쌓아보세요";

  return (
    <div className="space-y-2">
      {/* 상단 안내 카드 */}
      <div className="flex items-center gap-3 px-3 py-3.5 rounded-xl bg-white/5 border border-white/10">
        <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center shrink-0">
          <Trophy size={16} className="text-white/40" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white/80">{message}</p>
          <p className="text-xs text-white/50 mt-0.5 leading-relaxed">{hint}</p>
        </div>
      </div>
      {/* 1/2/3위 슬롯 — 랭킹 프레임은 그대로, row 값은 `-` 처리 (삼순이 권장) */}
      {[1, 2, 3].map((n) => (
        <div
          key={n}
          className="flex items-center gap-3 px-3 py-3 rounded-xl bg-white/[0.03] border border-white/[0.06]"
        >
          <span className="w-6 text-center font-bold text-sm text-white/40">
            {n}
          </span>
          <span className="flex-1 text-sm text-white/30">-</span>
          <span className="text-xs text-white/30">-</span>
        </div>
      ))}
    </div>
  );
}
