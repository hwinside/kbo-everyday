"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ChevronLeft,
  Trophy,
  Users,
  MessageSquare,
  Gift,
  ChevronRight,
  Calendar,
} from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { getTeamById } from "@/lib/constants/teams";
import { useAuth } from "@/lib/supabase/AuthContext";

type Track = "invite" | "writing";

interface InviteRow {
  user_id: string;
  nickname: string;
  team_id: number | null;
  invite_count: number;
}
interface WritingRow {
  user_id: string;
  nickname: string;
  team_id: number | null;
  total_points: number;
}

/**
 * 이벤트 랜딩 페이지 — 크보팬 얼리멤버 커뮤니티 활성화 이벤트
 * 2026-04-20 ~ 2026-05-31
 *
 * 하단에 초대/글쓰기 Top 10 프리뷰 + 리더보드 전체 보기 CTA
 */
export default function EventInvitePage() {
  const router = useRouter();
  const { user } = useAuth();
  const [topInvite, setTopInvite] = useState<InviteRow[]>([]);
  const [topWriting, setTopWriting] = useState<WritingRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [a, b] = await Promise.all([
          fetch("/api/leaderboard/invite?limit=10", { cache: "no-store" }),
          fetch("/api/leaderboard/writing?limit=10", { cache: "no-store" }),
        ]);
        const [ja, jb] = await Promise.all([a.json(), b.json()]);
        if (cancelled) return;
        setTopInvite(ja.rows ?? []);
        setTopWriting(jb.rows ?? []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

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
          <h1 className="font-bold text-lg">얼리멤버 이벤트</h1>
        </div>
      </div>

      <div className="max-w-screen-sm mx-auto px-4 pt-5">
        {/* Hero — event-draft.html 시안 기반 */}
        <div className="rounded-2xl p-5 bg-gradient-to-br from-yellow-400/15 via-orange-400/10 to-red-400/10 border border-yellow-400/20">
          <div className="flex items-center gap-1.5 text-xs text-yellow-400 font-semibold mb-2">
            <Calendar size={13} />
            2026.04.20 ~ 2026.05.31
          </div>
          <h2 className="text-2xl font-black leading-tight mb-2">
            친구 초대하고 응원글 쓰면,
            <br />
            <span className="text-yellow-400">에어팟 프로 3</span>까지 노릴 수 있어요
          </h2>
          <p className="text-sm text-white/70 leading-relaxed mb-4">
            각 부문 상위 50명은 시즌 한정 얼리멤버 뱃지와 상품을 받고, 1등은
            에어팟 프로 3의 주인공이 됩니다.
          </p>
          {/* 에어팟 프로 3 이미지 */}
          <div className="rounded-2xl bg-white/90 p-4 flex items-center justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/event-airpods.png"
              alt="1등 경품 — 에어팟 프로 3"
              className="w-full max-w-[200px] h-auto"
            />
          </div>
          <div className="mt-3 text-center">
            <p className="text-xs text-white/60">1등 통합 대표 경품</p>
            <p className="text-lg font-black text-yellow-400">에어팟 프로 3</p>
            <p className="text-xs text-white/50">트랙별 1대씩, 총 2대 지급</p>
          </div>
        </div>

        {/* 경품 표 — event-draft.html 시안 기반 */}
        <div className="mt-4 rounded-2xl bg-white/5 border border-white/10 overflow-hidden">
          <div className="px-4 py-3 bg-white/5 border-b border-white/10">
            <p className="text-sm font-bold">상위 50명 경품 — 트랙별 동일</p>
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-white/50 bg-white/[0.02]">
                <th className="text-left px-3 py-2 font-semibold">순위</th>
                <th className="text-left px-3 py-2 font-semibold">인원</th>
                <th className="text-left px-3 py-2 font-semibold">경품</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              <tr className="text-yellow-400 font-bold">
                <td className="px-3 py-2.5">1등</td>
                <td className="px-3 py-2.5">1명</td>
                <td className="px-3 py-2.5">에어팟 프로 3</td>
              </tr>
              <tr>
                <td className="px-3 py-2.5">2~5등</td>
                <td className="px-3 py-2.5">4명</td>
                <td className="px-3 py-2.5">스타벅스 기프티콘 10만원</td>
              </tr>
              <tr>
                <td className="px-3 py-2.5">6~15등</td>
                <td className="px-3 py-2.5">10명</td>
                <td className="px-3 py-2.5">KBO 구단별 굿즈</td>
              </tr>
              <tr>
                <td className="px-3 py-2.5">16~50등</td>
                <td className="px-3 py-2.5">35명</td>
                <td className="px-3 py-2.5">얼리멤버 한정 뱃지 + 크보팬 리워드</td>
              </tr>
            </tbody>
          </table>
          <div className="px-3 py-2.5 text-[10px] text-white/40 bg-white/[0.02] border-t border-white/5">
            ※ 초대/글쓰기 2개 트랙에 동일 적용 · 총 100명 경품 수상
          </div>
        </div>

        {/* 2트랙 설명 */}
        <div className="grid grid-cols-2 gap-2 mt-4">
          <TrackCard
            icon={<Users size={18} />}
            title="초대 트랙"
            desc="친구를 초대하고 활성화시킨 만큼"
            accent="text-blue-400"
            bg="from-blue-500/10 to-indigo-500/5 border-blue-500/20"
          />
          <TrackCard
            icon={<MessageSquare size={18} />}
            title="글쓰기 트랙"
            desc="채팅/댓글/글로 포인트 획득"
            accent="text-green-400"
            bg="from-green-500/10 to-emerald-500/5 border-green-500/20"
          />
        </div>

        {/* Top 10 프리뷰 — 글쓰기를 먼저 (데이터 더 풍부, 2026-04-20 합의) */}
        <TopPreview
          title="글쓰기 랭킹 TOP 10"
          icon={<MessageSquare size={16} />}
          rows={topWriting}
          track="writing"
          loading={loading}
          currentUserId={user?.id}
        />

        {/* Top 10 프리뷰 — 초대 */}
        <TopPreview
          title="초대 랭킹 TOP 10"
          icon={<Users size={16} />}
          rows={topInvite}
          track="invite"
          loading={loading}
          currentUserId={user?.id}
        />

        {/* 전체 리더보드 CTA */}
        <Link
          href="/events/invite/leaderboard"
          className="mt-5 flex items-center justify-center gap-2 w-full py-3.5 rounded-xl bg-gradient-to-r from-yellow-400 to-orange-400 text-black font-bold"
        >
          <Trophy size={18} />
          전체 리더보드 보기
          <ChevronRight size={18} />
        </Link>

        {/* 상세 규정 안내 */}
        <GlassCard className="mt-4 p-4">
          <div className="flex items-center gap-1.5 mb-2">
            <Gift size={14} className="text-yellow-400" />
            <p className="text-xs font-bold">점수 & 집계 규칙</p>
          </div>
          <ul className="text-xs text-white/70 leading-relaxed space-y-1 pl-0">
            <li>
              초대가 실적으로 인정되려면, 피초대자가 <strong>팀을 선택하고 글 또는 댓글을 1건 이상</strong> 작성해야 합니다
            </li>
            <li>글쓰기 점수: 채팅 1pt · 댓글 2pt · 글 3pt · 사진글 5pt</li>
            <li>일일 상한: 채팅 30pt · 댓글 40pt · 글 30pt · 사진글 50pt · 총 150pt</li>
            <li>운영자/테스트 계정은 집계 제외</li>
            <li>셀프 초대·비정상 패턴은 검수 후 집계 제외될 수 있습니다</li>
          </ul>
        </GlassCard>
      </div>
    </div>
  );
}

function TrackCard({
  icon,
  title,
  desc,
  accent,
  bg,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  accent: string;
  bg: string;
}) {
  return (
    <div className={`rounded-xl p-3 bg-gradient-to-br ${bg} border`}>
      <div className={`${accent} mb-1.5`}>{icon}</div>
      <p className="font-bold text-sm">{title}</p>
      <p className="text-xs text-white/60 mt-0.5">{desc}</p>
    </div>
  );
}

function TopPreview({
  title,
  icon,
  rows,
  track,
  loading,
  currentUserId,
}: {
  title: string;
  icon: React.ReactNode;
  rows: (InviteRow | WritingRow)[];
  track: Track;
  loading: boolean;
  currentUserId?: string;
}) {
  return (
    <div className="mt-5">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-sm font-bold">
          {icon}
          {title}
        </div>
        <Link
          href="/events/invite/leaderboard"
          className="text-xs text-white/50 flex items-center gap-0.5"
        >
          전체 보기
          <ChevronRight size={13} />
        </Link>
      </div>
      {loading ? (
        <div className="text-xs text-white/40 text-center py-6 bg-white/5 rounded-lg">
          불러오는 중…
        </div>
      ) : rows.length === 0 ? (
        <div className="space-y-1.5">
          {/* 순위표 프레임 유지 — 안내 방식 */}
          <div className="flex items-center gap-2.5 px-3 py-3 rounded-lg bg-white/5 border border-white/5">
            <div className="w-6 h-6 rounded-full bg-white/5 flex items-center justify-center shrink-0">
              <Trophy size={12} className="text-white/30" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-white/70">
                {track === "invite"
                  ? "아직 완료된 초대가 없습니다"
                  : "아직 집계된 점수가 없습니다"}
              </p>
              <p className="text-[10px] text-white/40 mt-0.5 leading-relaxed">
                {track === "invite"
                  ? "친구가 팀 선택 + 글/댓글 1건 작성 시 등장"
                  : "채팅·댓글·글로 점수를 쌓아보세요"}
              </p>
            </div>
          </div>
          {/* 1/2/3위 슬롯 — row 값은 `-` 처리 */}
          {[1, 2, 3].map((n) => (
            <div
              key={n}
              className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-white/[0.03] border border-white/[0.06]"
            >
              <span className="w-6 text-center font-bold text-xs text-white/40">
                {n}
              </span>
              <span className="flex-1 text-xs text-white/30">-</span>
              <span className="text-[10px] text-white/30">-</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-1.5">
          {rows.map((row, idx) => {
            const team = row.team_id ? getTeamById(row.team_id) : null;
            const score =
              track === "invite"
                ? (row as InviteRow).invite_count
                : (row as WritingRow).total_points;
            const unit = track === "invite" ? "명" : "pt";
            const medal =
              idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : null;
            const isMe = currentUserId === row.user_id;

            return (
              <div
                key={row.user_id}
                className={`flex items-center justify-between px-3 py-2 rounded-lg border text-sm ${
                  isMe
                    ? "bg-yellow-400/5 border-yellow-400/30"
                    : "bg-white/5 border-white/5"
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="w-6 text-center font-bold shrink-0 text-xs">
                    {medal ?? idx + 1}
                  </span>
                  <span className="truncate font-semibold">{row.nickname}</span>
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
                </div>
                <span className="font-bold text-sm shrink-0">
                  {score}
                  <span className="text-xs font-normal text-white/50 ml-0.5">
                    {unit}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
