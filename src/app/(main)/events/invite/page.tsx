"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSafeBack } from "@/lib/hooks/useSafeBack";
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
import { getTeamById, getTeamBgColor } from "@/lib/constants/teams";
import { useAuth } from "@/lib/supabase/AuthContext";
import { useTheme } from "@/components/ThemeProvider";

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
 * SSOT: PDF "크보팬 얼리멤버 커뮤니티 활성화 이벤트.pdf"
 * (2026-04-20 #marketing 스레드 1776644364.098599에서 하린아빠 공유)
 */
// 이벤트 종료(KST 6/1 00:00) 후엔 라이브 리더보드 대신 결과공지로 보냄
const EVENT_END_MS = new Date("2026-06-01T00:00:00+09:00").getTime();
const RESULT_PATH = "/whats-new";

export default function EventInvitePage() {
  const router = useRouter();
  const goBack = useSafeBack("/");
  const { user } = useAuth();
  const eventEnded = Date.now() >= EVENT_END_MS;
  const [topInvite, setTopInvite] = useState<InviteRow[]>([]);
  const [topWriting, setTopWriting] = useState<WritingRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (eventEnded) router.replace(RESULT_PATH);
  }, [eventEnded, router]);

  useEffect(() => {
    if (eventEnded) return;
    let cancelled = false;
    async function load() {
      try {
        const [inviteRes, writingRes] = await Promise.all([
          fetch("/api/leaderboard/invite?limit=10"),
          fetch("/api/leaderboard/writing?limit=10"),
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
  }, [eventEnded]);

  if (eventEnded) {
    return <div className="min-h-screen" aria-hidden />;
  }

  return (
    <div className="min-h-screen text-gray-900 dark:text-white">
      <div className="sticky top-0 z-30 border-b border-border bg-bg-primary" style={{ paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))", marginTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) * -1)" }}>
      <div className="max-w-screen-sm mx-auto px-5 min-h-[44px] flex items-center gap-2">
        <button
          onClick={goBack}
          className="flex h-11 w-11 items-center justify-center -ml-2.5 rounded-lg hover:bg-gray-900/5 dark:bg-white/5"
          aria-label="뒤로"
        >
          <ChevronLeft size={20} />
        </button>
        <h1 className="font-bold">얼리멤버 이벤트</h1>
      </div>
      </div>

      <div className="max-w-screen-sm mx-auto px-5 pt-2 pb-24">
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
          <p className="text-sm text-gray-900/70 dark:text-white/70 leading-relaxed mb-4">
            각 부문 상위 50명은 시즌 한정 얼리멤버 뱃지와 상품을 받고, 1등은
            에어팟 프로 3의 주인공이 됩니다.
          </p>

          {/* 에어팟 프로 3 이미지만 — 박스/라벨 없이 */}
          <div className="flex items-center justify-center py-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/event-airpods-v3.png"
              alt="1등 경품 — 에어팟 프로 3"
              className="w-full max-w-[280px] h-auto"
            />
          </div>
          <p className="mt-2 text-center text-xs text-gray-900/60 dark:text-white/60">
            <span className="font-bold text-yellow-400">1등 경품 · 에어팟 프로 3</span>
            <br />
            Apple 공식가 ₩369,000 · 이벤트별 1대씩 · 총 2대
          </p>
        </div>

        {/* 2이벤트 상세 — PDF SSOT 원문 bullet 그대로 */}
        <div className="mt-4 space-y-3">
          {/* 초대 이벤트 */}
          <div className="rounded-2xl p-4 bg-gray-900/5 dark:bg-white/5 border border-gray-900/10 dark:border-white/10">
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-500/15 text-blue-700 dark:text-blue-300 text-xs font-bold mb-3">
              💎 초대 이벤트
            </div>
            <h3 className="text-lg font-black mb-3">친구 초대하고 순위 올리기</h3>
            <ul className="space-y-2 text-xs text-gray-900/80 dark:text-white/80 leading-relaxed">
              <li className="flex gap-2">
                <span className="text-blue-400 shrink-0">•</span>
                <span>초대가 실적으로 인정되려면, 피초대자가 <span className="font-bold text-gray-900 dark:text-white">팀을 선택하고 글 또는 댓글을 1건 이상 작성</span>해야 합니다</span>
              </li>
              <li className="flex gap-2">
                <span className="text-blue-400 shrink-0">•</span>
                <span>친구가 내 초대 코드를 입력·등록하면 초대 실적으로 집계됩니다</span>
              </li>
              <li className="flex gap-2">
                <span className="text-blue-400 shrink-0">•</span>
                <span>카카오톡이나 공유 링크로 가입하면 초대 코드가 자동 등록됩니다</span>
              </li>
              <li className="flex gap-2">
                <span className="text-blue-400 shrink-0">•</span>
                <span>한 친구는 한 명에게만 귀속되며, 먼저 등록한 초대자에게 카운트됩니다</span>
              </li>
              <li className="flex gap-2">
                <span className="text-blue-400 shrink-0">•</span>
                <span>본인 초대코드 입력, 동일 디바이스 또는 동일 IP 반복 가입 등 어뷰징 징후는 검수에서 제외될 수 있습니다</span>
              </li>
              <li className="flex gap-2">
                <span className="text-blue-400 shrink-0">•</span>
                <span>최종 순위에 따라 상품 1개와 시즌 한정 뱃지가 지급되며, 최종 집계는 <span className="font-bold text-gray-900 dark:text-white">5월 31일</span> 기준으로 확정됩니다</span>
              </li>
            </ul>
          </div>

          {/* 글쓰기 이벤트 */}
          <div className="rounded-2xl p-4 bg-gray-900/5 dark:bg-white/5 border border-gray-900/10 dark:border-white/10">
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-yellow-500/20 text-yellow-800 dark:text-yellow-300 text-xs font-bold mb-3">
              🌾 글쓰기 이벤트
            </div>
            <h3 className="text-lg font-black mb-3">활동 포인트로 순위 올리기</h3>
            <ul className="space-y-2 text-xs text-gray-900/80 dark:text-white/80 leading-relaxed">
              <li className="flex gap-2">
                <span className="text-yellow-400 shrink-0">•</span>
                <span><span className="font-bold text-gray-900 dark:text-white">경기 중계 채팅 1점, 댓글 2점, 글 3점, 사진글 5점</span></span>
              </li>
              <li className="flex gap-2">
                <span className="text-yellow-400 shrink-0">•</span>
                <span>정보성 게시물 보너스: <span className="font-bold text-gray-900 dark:text-white">구장 좌석팁 +10점(일 20점), 티켓 양도 +30점(일 30점)</span></span>
              </li>
              <li className="flex gap-2">
                <span className="text-yellow-400 shrink-0">•</span>
                <span>하루 총 상한 <span className="font-bold text-gray-900 dark:text-white">200점</span>, 활동별 상한 별도 적용</span>
              </li>
              <li className="flex gap-2">
                <span className="text-yellow-400 shrink-0">•</span>
                <span>최종 순위에 따라 상품 1개와 시즌 한정 뱃지 지급</span>
              </li>
              <li className="flex gap-2">
                <span className="text-yellow-400 shrink-0">•</span>
                <span>점수용 도배나 어뷰징은 운영 판단으로 제외</span>
              </li>
            </ul>
          </div>
        </div>

        <p className="text-[11px] text-gray-900/50 dark:text-white/50 mt-3 leading-relaxed">
          ※ 두 이벤트 중복 수상 가능 · 초대 1등 + 글쓰기 1등 동시 수상 OK
        </p>

        {/* 경품 표 — 이벤트 공통 (인원·상품 동일) */}
        <div className="mt-5 rounded-2xl bg-gray-900/5 dark:bg-white/5 border border-gray-900/10 dark:border-white/10 overflow-hidden">
          <div className="px-4 py-3 bg-gray-900/5 dark:bg-white/5 border-b border-gray-900/10 dark:border-white/10 flex items-center gap-1.5">
            <Gift size={14} className="text-yellow-400" />
            <p className="text-sm font-bold">상위 50명 경품 — 이벤트별 동일</p>
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-900/50 dark:text-white/50 bg-gray-900/[0.02] dark:bg-white/[0.02]">
                <th className="text-left px-3 py-2 font-semibold">순위</th>
                <th className="text-left px-3 py-2 font-semibold">인원</th>
                <th className="text-left px-3 py-2 font-semibold">상품</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-900/5 dark:divide-white/5">
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
          <div className="px-3 py-2.5 text-[10px] text-gray-900/40 dark:text-white/40 bg-gray-900/[0.02] dark:bg-white/[0.02] border-t border-gray-900/5 dark:border-white/5 leading-relaxed">
            ※ 최종 순위에 해당하는 단일 상품만 지급 (중복 지급 없음)
            <br />※ 5만원 초과 경품의 제세공과금(22%)은 크보팬 대납
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

        <Link
          href="/events/invite/leaderboard"
          className="mt-4 block w-full rounded-xl py-3 bg-gray-900/10 dark:bg-white/10 hover:bg-gray-900/15 dark:bg-white/15 text-center text-sm font-semibold border border-gray-900/10 dark:border-white/10 transition-colors"
        >
          전체 리더보드 보기
        </Link>

        {/* 뱃지 — 초대 이벤트 (PDF SSOT 기준) */}
        <div className="mt-6">
          <h3 className="text-sm font-bold mb-3 flex items-center gap-1.5">
            <Users size={14} className="text-blue-400" />
            초대 이벤트 뱃지 — 크보팬 얼리멤버
          </h3>
          <div className="space-y-2">
            <BadgeCard emoji="🏆" title="초대 챔피언" rank="1등 · 1명" tone="gold" />
            <BadgeCard emoji="🥈" title="초대 마스터" rank="2~4등 · 3명" tone="gold" />
            <BadgeCard emoji="🎖️" title="초대 레전드" rank="5~9등 · 5명" tone="silver" />
            <BadgeCard emoji="⭐" title="초대 에이스" rank="10~19등 · 10명" tone="silver" />
            <BadgeCard emoji="🤝" title="리크루터" rank="20~39등 · 20명" tone="bronze" />
            <BadgeCard emoji="🔗" title="커넥터" rank="40~50등 · 11명" tone="bronze" />
          </div>
        </div>

        {/* 뱃지 — 글쓰기 이벤트 (PDF SSOT 기준) */}
        <div className="mt-5">
          <h3 className="text-sm font-bold mb-3 flex items-center gap-1.5">
            <MessageSquare size={14} className="text-green-400" />
            글쓰기 이벤트 뱃지 — 크보팬 얼리멤버
          </h3>
          <div className="space-y-2">
            <BadgeCard emoji="🏆" title="단장" rank="1등 · 1명" tone="gold" />
            <BadgeCard emoji="🥈" title="운영팀장" rank="2~4등 · 3명" tone="gold" />
            <BadgeCard emoji="🎖️" title="스카우트" rank="5~9등 · 5명" tone="silver" />
            <BadgeCard emoji="⭐" title="해설위원" rank="10~19등 · 10명" tone="silver" />
            <BadgeCard emoji="💬" title="기자단" rank="20~39등 · 20명" tone="bronze" />
            <BadgeCard emoji="📢" title="서포터즈" rank="40~50등 · 11명" tone="bronze" />
          </div>
          <p className="text-[11px] text-gray-900/50 dark:text-white/50 mt-2">
            ※ 시즌 한정 뱃지 · 프로필 상시 표시 · 2026 시즌 종료까지 유지 · 중복 수상 시 두 뱃지 모두 부여
          </p>
        </div>

        {/* 참여 방법 4단계 (PDF SSOT) */}
        <div className="mt-6">
          <h3 className="text-sm font-bold mb-3 flex items-center gap-1.5">
            <Calendar size={14} className="text-yellow-400" />
            참여 방법
          </h3>
          <div className="space-y-2">
            <StepCard
              num={1}
              title="이벤트 확인"
              desc="랜딩 페이지에서 초대와 글쓰기 두 이벤트의 보상 구조를 확인해요."
            />
            <StepCard
              num={2}
              title="활동 시작"
              desc="친구를 초대하거나 경기 중계 채팅·댓글·글 작성으로 포인트를 쌓아요."
            />
            <StepCard
              num={3}
              title="리더보드 확인"
              desc="내 순위와 남은 기간을 보면서 상위 50위 진입을 노려요."
            />
            <StepCard
              num={4}
              title="검수 후 지급"
              desc="이벤트 종료 후 최종 검수와 함께 상품과 시즌 한정 뱃지가 지급돼요."
            />
          </div>
          <p className="text-[11px] text-gray-900/50 dark:text-white/50 mt-2 leading-relaxed">
            초대는 <span className="text-gray-900 dark:text-white">/my → 친구 초대 카드 → 공유</span> 3단계로 참여할 수 있어요.
          </p>
        </div>

        {/* 글쓰기 이벤트 포인트 체계 (PDF SSOT) */}
        <GlassCard className="mt-5 p-4">
          <div className="flex items-center gap-1.5 mb-3">
            <MessageSquare size={14} className="text-green-400" />
            <p className="text-sm font-bold">글쓰기 이벤트 포인트 체계</p>
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-900/50 dark:text-white/50 border-b border-gray-900/10 dark:border-white/10">
                <th className="text-left py-2 font-semibold">활동</th>
                <th className="text-right py-2 font-semibold">점수</th>
                <th className="text-right py-2 font-semibold">일일 상한</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-900/5 dark:divide-white/5">
              <tr>
                <td className="py-2">경기 중계 채팅</td>
                <td className="text-right py-2">1점</td>
                <td className="text-right py-2 text-gray-900/60 dark:text-white/60">30점</td>
              </tr>
              <tr>
                <td className="py-2">커뮤니티 댓글</td>
                <td className="text-right py-2">2점</td>
                <td className="text-right py-2 text-gray-900/60 dark:text-white/60">40점</td>
              </tr>
              <tr>
                <td className="py-2">커뮤니티 글</td>
                <td className="text-right py-2">3점</td>
                <td className="text-right py-2 text-gray-900/60 dark:text-white/60">30점</td>
              </tr>
              <tr>
                <td className="py-2">사진 게시판 사진글</td>
                <td className="text-right py-2">5점</td>
                <td className="text-right py-2 text-gray-900/60 dark:text-white/60">50점</td>
              </tr>
              <tr>
                <td className="py-2">구장 좌석팁 보너스</td>
                <td className="text-right py-2">+10점</td>
                <td className="text-right py-2 text-gray-900/60 dark:text-white/60">20점</td>
              </tr>
              <tr>
                <td className="py-2">티켓 양도 보너스</td>
                <td className="text-right py-2">+30점</td>
                <td className="text-right py-2 text-gray-900/60 dark:text-white/60">30점</td>
              </tr>
              <tr className="font-bold text-yellow-400">
                <td className="py-2">하루 총 상한</td>
                <td className="text-right py-2">—</td>
                <td className="text-right py-2">200점</td>
              </tr>
            </tbody>
          </table>
        </GlassCard>

        {/* 초대 이벤트 집계 기준 (PDF SSOT) */}
        <GlassCard className="mt-4 p-4">
          <div className="flex items-center gap-1.5 mb-2">
            <Users size={14} className="text-blue-400" />
            <p className="text-sm font-bold">초대 이벤트 집계 기준</p>
          </div>
          <ul className="space-y-1.5 text-xs text-gray-900/70 dark:text-white/70 leading-relaxed">
            <li>• 초대 인정 조건: <span className="text-gray-900 dark:text-white">피초대자가 팀을 선택하고 글 또는 댓글을 1건 이상 작성</span></li>
            <li>• 카카오톡·공유 링크로 가입하면 초대 코드가 자동 등록</li>
            <li>• 한 친구는 한 명에게만 귀속, 먼저 등록한 초대자에게 카운트</li>
            <li>• <span className="text-gray-900 dark:text-white">기존 누적 초대 + 이벤트 기간 신규 분</span> 모두 합산</li>
            <li>• 최종 집계는 5월 31일 기준으로 확정</li>
          </ul>
        </GlassCard>

        {/* FAQ — PDF SSOT 4개 그대로 */}
        <div className="mt-6">
          <h3 className="text-sm font-bold mb-3 flex items-center gap-1.5">
            <Trophy size={14} className="text-yellow-400" />
            자주 묻는 질문
          </h3>
          <div className="space-y-2">
            <FaqItem
              q="순위권에 들면 어떻게 지급되나요?"
              a="최종 순위에 해당하는 단일 상품 1개만 지급됩니다. 예를 들어 5등이면 신세계 상품권 5만원권 1개를 받으며, 그 아래 순위 구간 상품은 중복 지급되지 않아요."
            />
            <FaqItem
              q="예전에 이미 초대 뱃지를 달성했는데 이번 이벤트 보상도 받을 수 있나요?"
              a="네. 기존 누적 초대도 인정되며, 이벤트 기간 중 새로 활성화된 초대도 함께 합산돼요. 단, 모두 피초대자가 팀을 선택하고 글 또는 댓글을 1건 이상 작성해 활성화 조건을 충족한 건만 인정됩니다."
            />
            <FaqItem
              q="어떤 활동이 점수 적용에서 제외되나요?"
              a="복붙, 도배, 의미 없는 반복 활동, 점수 획득만을 위한 글은 운영진 판단으로 점수 적용에서 제외될 수 있어요."
            />
            <FaqItem
              q="에어팟 프로 3는 언제 어떻게 받나요?"
              a="이벤트 종료 후 최종 검수를 거쳐 개별 안내 및 배송될 예정이며, 5만원 초과 경품의 제세공과금은 크보팬이 대납해요."
            />
          </div>
        </div>

        {/* 운영 참고사항 — PDF SSOT 독립 카드 */}
        <div className="mt-5 rounded-2xl p-5 bg-gray-900/[0.04] dark:bg-white/[0.04] border border-gray-900/10 dark:border-white/10">
          <h3 className="text-base font-black mb-3">운영 참고사항</h3>
          <ul className="space-y-2.5 text-sm text-gray-900/80 dark:text-white/80 leading-relaxed">
            <li className="flex gap-2">
              <span className="text-red-400 shrink-0">•</span>
              <span>최종 순위 기준으로 1인당 단일 상품 1개만 지급</span>
            </li>
            <li className="flex gap-2">
              <span className="text-red-400 shrink-0">•</span>
              <span>점수 획득만을 위한 글이나 도배성 활동은 운영 판단에 따라 집계에서 제외</span>
            </li>
            <li className="flex gap-2">
              <span className="text-red-400 shrink-0">•</span>
              <span>제외 판정이 3회 이상 누적되면 리더보드에서 제외</span>
            </li>
            <li className="flex gap-2">
              <span className="text-red-400 shrink-0">•</span>
              <span>셀프 초대, 비정상 패턴은 검수 후 집계에서 제외</span>
            </li>
          </ul>
        </div>

        {/* Footer */}
        <p className="mt-6 text-[10px] text-gray-900/30 dark:text-white/30 text-center leading-relaxed">
          이벤트 기간 2026.04.20 ~ 2026.05.31 · 마감 2026-05-31 23:59 KST
          <br />
          최종 집계는 5월 31일 기준 · 당첨자 안내는 종료 후 개별 진행
          <br />
          5만원 초과 경품의 제세공과금(22%) 크보팬 대납
        </p>
      </div>
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
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const theme: "dark" | "light" = mounted ? resolvedTheme : "dark";
  return (
    <div className="mt-5">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-sm font-bold">
          {icon}
          {title}
        </div>
        <Link
          href="/events/invite/leaderboard"
          className="text-xs text-gray-900/50 dark:text-white/50 flex items-center gap-0.5"
        >
          전체 보기
          <ChevronRight size={13} />
        </Link>
      </div>
      {loading ? (
        <div className="text-xs text-gray-900/40 dark:text-white/40 text-center py-6 bg-gray-900/5 dark:bg-white/5 rounded-lg">
          불러오는 중…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl p-5 bg-gradient-to-br from-yellow-400/10 to-orange-400/5 border border-yellow-400/20 text-center">
          <div className="text-3xl mb-2">🏁</div>
          <p className="text-sm font-bold mb-1">
            {track === "invite"
              ? "첫 초대 챔피언을 노려보세요!"
              : "첫 점수 획득을 노려보세요!"}
          </p>
          <p className="text-xs text-gray-900/60 dark:text-white/60 leading-relaxed mb-3">
            {track === "invite"
              ? "이벤트가 방금 시작됐어요. 친구 1명만 데려와도 1등!"
              : "이벤트가 방금 시작됐어요. 채팅 한 마디에도 순위권!"}
          </p>
          <p className="text-[11px] text-gray-900/50 dark:text-white/50">
            {track === "invite"
              ? "친구가 팀 선택 + 글/댓글 1건 작성 시 인정"
              : "채팅 1점 · 댓글 2점 · 글 3점 · 사진글 5점 · 좌석팁/티켓양도 보너스"}
          </p>
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
                    : "bg-gray-900/5 dark:bg-white/5 border-gray-900/5 dark:border-white/5"
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="w-6 text-center font-bold shrink-0 text-xs">
                    {medal ?? idx + 1}
                  </span>
                  <span className="truncate font-semibold">{row.nickname}</span>
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
                </div>
                <span className="font-bold text-sm shrink-0">
                  {score}
                  <span className="text-xs font-normal text-gray-900/50 dark:text-white/50 ml-0.5">
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

function StepCard({ num, title, desc }: { num: number; title: string; desc: string }) {
  return (
    <div className="rounded-xl p-3 bg-gray-900/5 dark:bg-white/5 border border-gray-900/10 dark:border-white/10 flex items-start gap-3">
      <div className="w-8 h-8 rounded-full bg-yellow-400/20 text-yellow-400 font-black text-sm flex items-center justify-center shrink-0">
        {num}
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-bold text-sm">{title}</p>
        <p className="text-xs text-gray-900/60 dark:text-white/60 mt-0.5 leading-relaxed">{desc}</p>
      </div>
    </div>
  );
}

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
    <div className={`rounded-xl p-3 bg-gradient-to-br ${bg} border flex items-center gap-3`}>
      <div className="w-11 h-11 rounded-xl bg-gray-900/10 dark:bg-white/10 border border-gray-900/10 dark:border-white/10 flex items-center justify-center text-2xl shrink-0">
        {emoji}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[10px] text-gray-900/50 dark:text-white/50 mb-0.5">{rank}</p>
        <p className="font-bold text-sm">{title}</p>
        <p className="text-[11px] text-gray-900/60 dark:text-white/60 mt-0.5">크보팬 얼리멤버</p>
      </div>
    </div>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  return (
    <div className="rounded-xl p-3.5 bg-gray-900/5 dark:bg-white/5 border border-gray-900/10 dark:border-white/10">
      <p className="font-bold text-sm mb-1.5">Q. {q}</p>
      <p className="text-xs text-gray-900/70 dark:text-white/70 leading-relaxed">{a}</p>
    </div>
  );
}
