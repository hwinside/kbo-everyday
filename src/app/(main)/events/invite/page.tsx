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
  Shield,
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
 * 크보팬 얼리멤버 커뮤니티 활성화 이벤트 랜딩
 * 2026-04-20 ~ 2026-05-31
 *
 * 본 페이지 내용은 specs/event-opening-season.md에 락됨.
 * 카피·경품·뱃지·포인트 규칙 변경 시 스펙 먼저 수정.
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
        const [inviteRes, writingRes] = await Promise.all([
          fetch("/api/event/leaderboard?track=invite&limit=10"),
          fetch("/api/event/leaderboard?track=writing&limit=10"),
        ]);
        const [inviteData, writingData] = await Promise.all([
          inviteRes.ok ? inviteRes.json() : { rows: [] },
          writingRes.ok ? writingRes.json() : { rows: [] },
        ]);
        if (cancelled) return;
        setTopInvite(inviteData.rows || []);
        setTopWriting(writingData.rows || []);
      } catch (e) {
        console.error("[event] leaderboard fetch failed", e);
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
    <div className="min-h-screen text-white">
      <div className="max-w-screen-sm mx-auto px-4 py-4 flex items-center gap-2">
        <button
          onClick={() => router.back()}
          className="p-2 -ml-2 rounded-lg hover:bg-white/5"
          aria-label="뒤로"
        >
          <ChevronLeft size={20} />
        </button>
        <h1 className="font-bold">얼리멤버 이벤트</h1>
      </div>

      <div className="max-w-screen-sm mx-auto px-4 pt-2">
        {/* Hero */}
        <div className="rounded-2xl p-5 bg-gradient-to-br from-yellow-400/15 via-orange-400/10 to-red-400/10 border border-yellow-400/20">
          <div className="flex items-center gap-1.5 text-xs text-yellow-400 font-semibold mb-2">
            <Calendar size={13} />
            2026.04.20 ~ 2026.05.31 (42일간)
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

          {/* 에어팟 프로 3 이미지 — 라벨 이미 이미지에 포함 */}
          <div className="rounded-2xl bg-white/90 p-6 flex items-center justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/event-airpods.png"
              alt="1등 경품 — 에어팟 프로 3 (트랙별 1대씩, 총 2대)"
              className="w-full max-w-[260px] h-auto"
            />
          </div>
        </div>

        {/* 2트랙 구조 */}
        <div className="grid grid-cols-2 gap-2 mt-4">
          <TrackCard
            icon={<Users size={18} />}
            title="초대 트랙"
            desc="활성화 초대 수 기준 순위"
            accent="text-blue-400"
            bg="from-blue-500/10 to-indigo-500/5 border-blue-500/20"
          />
          <TrackCard
            icon={<MessageSquare size={18} />}
            title="글쓰기 트랙"
            desc="포인트 누적 리더보드"
            accent="text-green-400"
            bg="from-green-500/10 to-emerald-500/5 border-green-500/20"
          />
        </div>
        <p className="text-[11px] text-white/50 mt-2 leading-relaxed">
          ※ 두 트랙 중복 수상 가능 · 초대 1등 + 글쓰기 1등 동시 수상 OK
        </p>

        {/* 경품 표 — 트랙별 동일, specs/event-opening-season.md 2.2 기준 */}
        <div className="mt-5 rounded-2xl bg-white/5 border border-white/10 overflow-hidden">
          <div className="px-4 py-3 bg-white/5 border-b border-white/10 flex items-center gap-1.5">
            <Gift size={14} className="text-yellow-400" />
            <p className="text-sm font-bold">상위 50명 경품 — 트랙별 동일</p>
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-white/50 bg-white/[0.02]">
                <th className="text-left px-3 py-2 font-semibold">순위</th>
                <th className="text-left px-3 py-2 font-semibold">인원</th>
                <th className="text-left px-3 py-2 font-semibold">상품</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              <tr className="text-yellow-400 font-bold">
                <td className="px-3 py-2.5">1등</td>
                <td className="px-3 py-2.5">1명</td>
                <td className="px-3 py-2.5">에어팟 프로 3</td>
              </tr>
              <tr>
                <td className="px-3 py-2.5">2~4등</td>
                <td className="px-3 py-2.5">3명</td>
                <td className="px-3 py-2.5">신세계 상품권 10만원권</td>
              </tr>
              <tr>
                <td className="px-3 py-2.5">5~9등</td>
                <td className="px-3 py-2.5">5명</td>
                <td className="px-3 py-2.5">신세계 상품권 5만원권</td>
              </tr>
              <tr>
                <td className="px-3 py-2.5">10~19등</td>
                <td className="px-3 py-2.5">10명</td>
                <td className="px-3 py-2.5">신세계 상품권 3만원권</td>
              </tr>
              <tr>
                <td className="px-3 py-2.5">20~39등</td>
                <td className="px-3 py-2.5">20명</td>
                <td className="px-3 py-2.5">스타벅스 상품권 1만원권</td>
              </tr>
              <tr>
                <td className="px-3 py-2.5">40~50등</td>
                <td className="px-3 py-2.5">11명</td>
                <td className="px-3 py-2.5">스타벅스 상품권 5천원권</td>
              </tr>
            </tbody>
          </table>
          <div className="px-3 py-2.5 text-[10px] text-white/40 bg-white/[0.02] border-t border-white/5 leading-relaxed">
            ※ 최종 순위에 해당하는 단일 상품만 지급 (중복 지급 없음)
            <br />※ 에어팟·신세계 10만원권 제세공과금 22%는 크보팬 대납
          </div>
        </div>

        {/* Top 10 프리뷰 — 글쓰기 */}
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
          className="mt-4 block w-full rounded-xl py-3 bg-white/10 hover:bg-white/15 text-center text-sm font-semibold border border-white/10 transition-colors"
        >
          전체 리더보드 보기
        </Link>

        {/* 뱃지 — 초대 트랙, 얼리멤버 · 커뮤니티 리크루터 */}
        <div className="mt-6">
          <h3 className="text-sm font-bold mb-3 flex items-center gap-1.5">
            <Users size={14} className="text-blue-400" />
            초대 트랙 뱃지 — 크보팬 얼리멤버
          </h3>
          <div className="grid grid-cols-2 gap-2">
            <BadgeCard emoji="🏆" title="초대 챔피언" rank="1등" tone="gold" />
            <BadgeCard emoji="👑" title="초대 마스터" rank="2~4등" tone="gold" />
            <BadgeCard emoji="🏅" title="초대 레전드" rank="5~9등" tone="silver" />
            <BadgeCard emoji="⭐" title="초대 에이스" rank="10~19등" tone="silver" />
            <BadgeCard emoji="🤝" title="리크루터" rank="20~39등" tone="bronze" />
            <BadgeCard emoji="🔗" title="커넥터" rank="40~50등" tone="bronze" />
          </div>
        </div>

        {/* 뱃지 — 글쓰기 트랙, 야구단 프런트 컨셉 */}
        <div className="mt-5">
          <h3 className="text-sm font-bold mb-3 flex items-center gap-1.5">
            <MessageSquare size={14} className="text-green-400" />
            글쓰기 트랙 뱃지 — 크보팬 얼리멤버 · 야구단 프런트
          </h3>
          <div className="grid grid-cols-2 gap-2">
            <BadgeCard emoji="🏆" title="단장" rank="1등" tone="gold" />
            <BadgeCard emoji="💼" title="운영팀장" rank="2~4등" tone="gold" />
            <BadgeCard emoji="🔍" title="스카우트" rank="5~9등" tone="silver" />
            <BadgeCard emoji="🎙️" title="해설위원" rank="10~19등" tone="silver" />
            <BadgeCard emoji="📝" title="기자단" rank="20~39등" tone="bronze" />
            <BadgeCard emoji="📣" title="서포터즈" rank="40~50등" tone="bronze" />
          </div>
          <p className="text-[11px] text-white/50 mt-2">
            ※ 시즌 한정 뱃지 · 프로필 상시 표시 · 2026 시즌 종료까지 유지
          </p>
        </div>

        {/* 참여 방법 4단계 */}
        <div className="mt-6">
          <h3 className="text-sm font-bold mb-3 flex items-center gap-1.5">
            <Calendar size={14} className="text-yellow-400" />
            참여 방법
          </h3>
          <div className="grid grid-cols-2 gap-2">
            <StepCard
              num={1}
              title="로그인 + 팀 설정"
              desc="크보팬 계정으로 로그인하고 내 팀을 선택합니다."
            />
            <StepCard
              num={2}
              title="초대 또는 글쓰기"
              desc="친구 초대 링크를 공유하거나, 경기 채팅·댓글·글·사진글로 포인트를 쌓습니다."
            />
            <StepCard
              num={3}
              title="실적 누적"
              desc="활성화 초대 수(초대 트랙) · 누적 포인트(글쓰기 트랙)가 실시간 랭킹에 반영됩니다."
            />
            <StepCard
              num={4}
              title="5/31 자정 스냅샷"
              desc="트랙별 상위 50명에게 뱃지와 경품 지급. 당첨자 개별 안내."
            />
          </div>
        </div>

        {/* 포인트 체계 — 글쓰기 트랙 */}
        <GlassCard className="mt-5 p-4">
          <div className="flex items-center gap-1.5 mb-3">
            <MessageSquare size={14} className="text-green-400" />
            <p className="text-sm font-bold">글쓰기 트랙 포인트 체계</p>
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-white/50 border-b border-white/10">
                <th className="text-left py-2 font-semibold">활동</th>
                <th className="text-right py-2 font-semibold">점수</th>
                <th className="text-right py-2 font-semibold">일일 상한</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              <tr>
                <td className="py-2">경기 중계 채팅</td>
                <td className="text-right py-2">1점</td>
                <td className="text-right py-2 text-white/60">30점 (30회)</td>
              </tr>
              <tr>
                <td className="py-2">커뮤니티 댓글</td>
                <td className="text-right py-2">2점</td>
                <td className="text-right py-2 text-white/60">40점 (20회)</td>
              </tr>
              <tr>
                <td className="py-2">커뮤니티 글</td>
                <td className="text-right py-2">3점</td>
                <td className="text-right py-2 text-white/60">30점 (10회)</td>
              </tr>
              <tr>
                <td className="py-2">커뮤니티 사진글</td>
                <td className="text-right py-2">5점</td>
                <td className="text-right py-2 text-white/60">50점 (10회)</td>
              </tr>
              <tr className="font-bold text-yellow-400">
                <td className="py-2">하루 총 상한</td>
                <td className="text-right py-2">—</td>
                <td className="text-right py-2">150점</td>
              </tr>
            </tbody>
          </table>
          <p className="text-[10px] text-white/40 mt-3 leading-relaxed">
            ※ 42일 최대 6,300점 · 초과 분은 자동 차단
          </p>
        </GlassCard>

        {/* 초대 트랙 집계 기준 */}
        <GlassCard className="mt-4 p-4">
          <div className="flex items-center gap-1.5 mb-2">
            <Users size={14} className="text-blue-400" />
            <p className="text-sm font-bold">초대 트랙 집계 기준</p>
          </div>
          <ul className="space-y-1.5 text-xs text-white/70 leading-relaxed">
            <li>• 피초대자가 가입 + 팀 선택 + 글/댓글 1건 작성 시 <span className="text-white">활성화 초대 1건</span> 인정</li>
            <li>• <span className="text-white">기존 달성분 + 이벤트 기간 신규 분</span> 모두 합산</li>
            <li>• 동률 시 마지막 활성화 시각이 빠른 유저 우선</li>
          </ul>
        </GlassCard>

        {/* FAQ — specs 10.3 락 기준 */}
        <div className="mt-6">
          <h3 className="text-sm font-bold mb-3 flex items-center gap-1.5">
            <Trophy size={14} className="text-yellow-400" />
            자주 묻는 질문
          </h3>
          <div className="space-y-2">
            <FaqItem
              q="순위권에 들면 어떻게 지급되나요?"
              a="최종 순위에 해당하는 단일 상품 1개만 지급됩니다. 예를 들어 5등이면 신세계 상품권 5만원권 1개를 받으며, 그 아래 순위 구간 상품은 중복 지급되지 않습니다."
            />
            <FaqItem
              q="예전에 이미 초대 뱃지를 달성했는데 이번 이벤트 보상도 받을 수 있나요?"
              a="네, 이번 이벤트는 누적 활성화 초대 수 기준으로 집계되어 기존 달성분도 인정됩니다. 단, 이벤트 기간 중 새로 활성화된 초대도 합산되어 순위 다툼은 42일 동안 계속됩니다."
            />
            <FaqItem
              q="하루에 받을 수 있는 포인트에 한도가 있나요?"
              a="네, 하루 총 150점까지 적립 가능하며, 활동 유형별 상한도 있습니다 (경기 중계 채팅 30점 / 댓글 40점 / 글 30점 / 사진글 50점)."
            />
            <FaqItem
              q="어떤 글이 점수 적용에서 제외되나요?"
              a="중복 도배, 초단문 스팸, 점수 획득 목적으로만 작성된 것으로 판단되는 글 등은 운영진 검토 후 점수 적용에서 제외될 수 있습니다. 제외가 3건 이상 누적되면 해당 계정은 순위표에서 제외됩니다."
            />
            <FaqItem
              q="셀프 초대로 여러 계정을 만들면 어떻게 되나요?"
              a="동일 기기·비정상 패턴·수동 검수 결과에 따라 이벤트 집계 및 보상에서 제외될 수 있습니다."
            />
            <FaqItem
              q="에어팟 프로 3는 언제 어떻게 받나요?"
              a="이벤트 종료 후 최종 검수를 거쳐 1주 내 개별 안내 및 배송될 예정입니다. 제세공과금(22%)은 크보팬이 대납합니다."
            />
            <FaqItem
              q="스타벅스·신세계 상품권은 언제 받나요?"
              a="시즌 종료 후 최종 검수를 거쳐 일괄 지급됩니다 (디지털 모바일 상품권)."
            />
          </div>
        </div>

        {/* 어뷰징 방지 안내 */}
        <div className="mt-5 rounded-xl p-4 bg-red-500/5 border border-red-500/15">
          <div className="flex items-center gap-1.5 mb-2">
            <Shield size={14} className="text-red-400" />
            <p className="text-sm font-bold text-red-400">건전한 커뮤니티를 위한 안내</p>
          </div>
          <ul className="space-y-1.5 text-[11px] text-white/70 leading-relaxed">
            <li>• 중복 도배 / 초단문 스팸 / AI 생성 의심 글은 자동 필터 + 운영진 검수로 점수 제외</li>
            <li>• 점수 제외 3건 누적 시 해당 계정은 리더보드·수상 대상에서 제외</li>
            <li>• 셀프 초대·부계정·비정상 패턴은 fingerprint/IP 기반으로 탐지</li>
            <li>• 이벤트 중단 권한: 크보팬 운영자 판단 하에 언제든 중단 가능 (환불·당첨 무효 포함)</li>
          </ul>
        </div>

        {/* Footer note */}
        <p className="mt-6 text-[10px] text-white/30 text-center leading-relaxed">
          이벤트 기간 2026.04.20 ~ 2026.05.31 · 마감 2026-05-31 23:59 KST
          <br />
          당첨자 발표 6월 1주 내 · 상품 배송·발송 일괄 진행
          <br />
          제세공과금(과세 대상 상품) 22% 크보팬 대납 · 원천징수영수증 별도 제공
        </p>
      </div>
    </div>
  );
}

// 트랙 소개 카드
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

// Top 10 프리뷰
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
          <div className="flex items-center gap-2.5 px-3 py-3 rounded-lg bg-white/5 border border-white/5">
            <div className="w-6 h-6 rounded-full bg-white/5 flex items-center justify-center shrink-0">
              <Trophy size={12} className="text-white/30" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-white/70">
                {track === "invite"
                  ? "아직 활성화 초대가 없습니다"
                  : "아직 집계된 점수가 없습니다"}
              </p>
              <p className="text-[10px] text-white/40 mt-0.5 leading-relaxed">
                {track === "invite"
                  ? "친구가 팀 선택 + 글/댓글 1건 작성 시 등장"
                  : "채팅·댓글·글·사진글로 포인트를 쌓아보세요"}
              </p>
            </div>
          </div>
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

// 참여 방법 단계 카드
function StepCard({ num, title, desc }: { num: number; title: string; desc: string }) {
  return (
    <div className="rounded-xl p-3 bg-white/5 border border-white/10">
      <div className="w-7 h-7 rounded-full bg-yellow-400/20 text-yellow-400 font-black text-xs flex items-center justify-center mb-2">
        {num}
      </div>
      <p className="font-bold text-sm">{title}</p>
      <p className="text-[11px] text-white/60 mt-1 leading-relaxed">{desc}</p>
    </div>
  );
}

// 얼리멤버 뱃지 카드
function BadgeCard({
  emoji,
  title,
  rank,
  tone,
}: {
  emoji: string;
  title: string;
  rank: string;
  tone: "gold" | "silver" | "bronze";
}) {
  const bg =
    tone === "gold"
      ? "from-yellow-400/15 to-orange-400/10 border-yellow-400/30"
      : tone === "silver"
      ? "from-gray-300/10 to-gray-400/5 border-gray-300/20"
      : "from-orange-500/10 to-amber-600/5 border-orange-500/20";

  return (
    <div className={`rounded-xl p-3 bg-gradient-to-br ${bg} border`}>
      <div className="w-11 h-11 rounded-xl bg-white/10 border border-white/10 flex items-center justify-center text-2xl mb-2">
        {emoji}
      </div>
      <p className="text-[10px] text-white/50 mb-0.5">{rank}</p>
      <p className="font-bold text-sm">크보팬 얼리멤버</p>
      <p className="text-xs text-white/80 mt-0.5">· {title}</p>
    </div>
  );
}

// FAQ 아이템
function FaqItem({ q, a }: { q: string; a: string }) {
  return (
    <div className="rounded-xl p-3.5 bg-white/5 border border-white/10">
      <p className="font-bold text-sm mb-1.5">Q. {q}</p>
      <p className="text-xs text-white/70 leading-relaxed">{a}</p>
    </div>
  );
}
