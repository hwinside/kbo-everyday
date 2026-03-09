"use client";

import { useAuth } from "@/lib/supabase/AuthContext";
import LoginSheet from "@/components/auth/LoginSheet";

import { useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import {
  ArrowLeft,
  Star,
  MapPin,
  UtensilsCrossed,
  Armchair,
  MessageCircle,
  Heart,
  PenLine,
  Ticket,
} from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { STADIUMS } from "@/lib/constants/stadiums";
import { getTeamById } from "@/lib/constants/teams";

const MOCK_REVIEWS = [
  {
    id: 1,
    author: "직관러88",
    teamId: 1,
    rating: 5,
    content:
      "잠실 치킨거리는 직관 전 필수 코스! 사직동 닭똥집도 맛있지만 여기가 원탑",
    timeAgo: "2시간 전",
    likes: 45,
  },
  {
    id: 2,
    author: "야구초보",
    teamId: 2,
    rating: 4,
    content:
      "처음 직관 갔는데 외야 잔디석 분위기 최고였어요. 다만 경기는 잘 안 보임 ㅋㅋ",
    timeAgo: "5시간 전",
    likes: 32,
  },
  {
    id: 3,
    author: "시즌권자",
    teamId: 1,
    rating: 4,
    content:
      "테이블석 예매가 전쟁이에요... 오픈런 필수. 근데 한번 앉으면 천국",
    timeAgo: "1일 전",
    likes: 89,
  },
  {
    id: 4,
    author: "먹방투어",
    teamId: 2,
    rating: 5,
    content:
      "방이동 먹자골목 새로 생긴 양꼬치집 강추! 경기 끝나고 2차로 최고",
    timeAgo: "2일 전",
    likes: 67,
  },
  {
    id: 5,
    author: "아빠랑야구",
    teamId: 1,
    rating: 3,
    content:
      "아이랑 가기엔 좌석이 좁아요. 그래도 분위기는 좋아서 아이가 좋아함",
    timeAgo: "3일 전",
    likes: 28,
  },
];

type Section = "food" | "seats" | "reviews";

function SectionChip({
  active,
  onClick,
  label,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-semibold transition-colors " +
        (active
          ? "bg-text-primary text-bg-primary"
          : "bg-bg-tertiary text-text-secondary")
      }
    >
      {icon}
      {label}
    </button>
  );
}

export default function StadiumDetailPage() {
  const { stadiumId } = useParams();
  const { user } = useAuth();
  const [showLogin, setShowLogin] = useState(false);

  const stadium = useMemo(
    () => STADIUMS.find((s) => s.id === stadiumId),
    [stadiumId]
  );

  const foodRef = useRef<HTMLDivElement | null>(null);
  const seatsRef = useRef<HTMLDivElement | null>(null);
  const reviewsRef = useRef<HTMLDivElement | null>(null);

  const [active, setActive] = useState<Section>("food");

  if (!stadium)
    return (
      <div className="flex items-center justify-center h-screen text-text-secondary">
        구장을 찾을 수 없습니다
      </div>
    );

  const teams = stadium.teamIds.map((id) => getTeamById(id)!).filter(Boolean);
  const primaryTeam = teams[0];

  function scrollTo(section: Section) {
    setActive(section);
    const el =
      section === "food"
        ? foodRef.current
        : section === "seats"
          ? seatsRef.current
          : reviewsRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const router = useRouter();

  return (
    <div className="min-h-screen bg-bg-primary pb-24">
      {/* Sticky Header */}
      <div className="sticky top-0 z-30 border-b bg-bg-primary" style={{ borderColor: primaryTeam?.colorPrimary ? `${primaryTeam.colorPrimary}40` : undefined }}>
        <div className="flex items-center gap-3 px-4 py-3">
          <button onClick={() => router.back()}>
            <ChevronLeft size={24} className="text-text-secondary" />
          </button>
          <span className="text-lg font-semibold text-text-primary">구장</span>
        </div>
      </div>

      {/* Stadium Hero */}
      <div
        className="relative px-5 pb-5 pt-4"
        style={{
          background: `linear-gradient(135deg, ${primaryTeam.colorPrimary}20, transparent)`,
        }}
      >
        <div className="flex items-center gap-3 mb-2">
          {teams.map((t) => (
            <div
              key={t.id}
              className="w-10 h-10 rounded-full bg-white p-1 flex items-center justify-center"
            >
              <Image
                src={t.logoPath}
                alt=""
                width={28}
                height={28}
                unoptimized
                className="object-contain"
              />
            </div>
          ))}
        </div>
        <h1 className="text-lg font-semibold text-text-primary">{stadium.name}</h1>
        <div className="flex items-center gap-3 mt-1 text-sm text-text-tertiary">
          <span className="flex items-center gap-1">
            <MapPin size={14} />
            {stadium.city}
          </span>
          <span>{stadium.capacity}석</span>
          <span className="flex items-center gap-1 text-yellow-400">
            <Star size={14} fill="currentColor" />
            {stadium.rating}
          </span>
          <span>리뷰 {stadium.reviewCount}</span>
        </div>

        {/* Ticket CTA */}
        <div className="mt-4">
          <Link
            href={`/community/tickets?venue=${stadium.id}`}
            className="inline-flex items-center gap-2 rounded-full bg-accent/20 text-accent px-4 py-2 text-sm font-semibold"
          >
            <Ticket size={16} />
            티켓 양도 보기 ({stadium.name})
          </Link>
        </div>
      </div>

      {/* Sticky section chips */}
      <div
        className="sticky top-0 z-20 bg-bg-primary/95 backdrop-blur-xl border-b border-border"
        style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        <div className="mx-auto max-w-lg px-5 py-3 flex items-center gap-2 overflow-x-auto hide-scrollbar">
          <SectionChip
            active={active === "food"}
            onClick={() => scrollTo("food")}
            label="맛집"
            icon={<UtensilsCrossed size={14} />}
          />
          <SectionChip
            active={active === "seats"}
            onClick={() => scrollTo("seats")}
            label="좌석팁"
            icon={<Armchair size={14} />}
          />
          <SectionChip
            active={active === "reviews"}
            onClick={() => scrollTo("reviews")}
            label="후기"
            icon={<MessageCircle size={14} />}
          />
        </div>
      </div>

      <div className="px-5 py-4 space-y-10">
        {/* 맛집 */}
        <section ref={foodRef}>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-bold text-text-primary">🍗 맛집</h2>
          </div>
          <div className="space-y-3">
            {stadium.foodSpots.map((spot, i) => (
              <GlassCard key={i} className="p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-sm font-bold text-text-primary">
                      {spot.name}
                    </h3>
                    <div className="flex items-center gap-2 mt-1 text-xs text-text-tertiary">
                      <span className="px-1.5 py-0.5 rounded-full bg-bg-tertiary">
                        {spot.category}
                      </span>
                      <span>{spot.distance}</span>
                    </div>
                  </div>
                  <span className="flex items-center gap-1 text-yellow-400 text-sm">
                    <Star size={14} fill="currentColor" />
                    {spot.rating}
                  </span>
                </div>
              </GlassCard>
            ))}
          </div>
        </section>

        {/* 좌석팁 */}
        <section ref={seatsRef}>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-bold text-text-primary">💺 좌석팁</h2>
          </div>
          <div className="space-y-3">
            {stadium.seatTips.map((seat, i) => (
              <GlassCard key={i} className="p-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h3 className="text-sm font-bold text-text-primary">
                      {seat.zone}
                    </h3>
                    <p className="text-xs text-text-secondary mt-1">
                      {seat.tip}
                    </p>
                  </div>
                  <span className="flex items-center gap-1 text-yellow-400 text-xs ml-3">
                    <Star size={12} fill="currentColor" />
                    {seat.rating}
                  </span>
                </div>
              </GlassCard>
            ))}
          </div>
        </section>

        {/* 후기 */}
        <section ref={reviewsRef}>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-bold text-text-primary">💬 후기</h2>
          </div>
          <div className="space-y-3">
            {MOCK_REVIEWS.map((review) => {
              const t = getTeamById(review.teamId);
              return (
                <GlassCard key={review.id} className="p-4">
                  <div className="flex items-center gap-2 mb-2">
                    {t && (
                      <div className="w-5 h-5 rounded-full bg-white p-0.5 flex items-center justify-center">
                        <Image
                          src={t.logoPath}
                          alt=""
                          width={14}
                          height={14}
                          unoptimized
                          className="object-contain"
                        />
                      </div>
                    )}
                    <span className="text-sm font-semibold text-text-primary">
                      {review.author}
                    </span>
                    <div className="flex gap-0.5">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Star
                          key={i}
                          size={10}
                          fill={i < review.rating ? "#FBBF24" : "none"}
                          className={
                            i < review.rating
                              ? "text-yellow-400"
                              : "text-text-tertiary"
                          }
                        />
                      ))}
                    </div>
                    <span className="ml-auto text-xs text-text-tertiary">
                      {review.timeAgo}
                    </span>
                  </div>
                  <p className="text-sm text-text-secondary leading-relaxed">
                    {review.content}
                  </p>
                  <div className="mt-2 flex items-center gap-1 text-xs text-text-tertiary">
                    <Heart size={12} /> {review.likes}
                  </div>
                </GlassCard>
              );
            })}
          </div>
        </section>
      </div>

      {/* FAB */}
      <button
        onClick={() => {
          if (!user) {
            setShowLogin(true);
            return;
          }
          /* TODO(Phase 2): navigate to write post page with board_type='stadium' and board_id=stadiumId pre-filled */
        }}
        className="fixed bottom-24 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-white shadow-lg shadow-accent/30 transition-transform hover:scale-105 active:scale-95"
      >
        <PenLine className="w-6 h-6" />
      </button>
      <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />
    </div>
  );
}
