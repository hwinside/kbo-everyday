"use client";

import { useAuth } from "@/lib/supabase/AuthContext";
import LoginSheet from "@/components/auth/LoginSheet";

import { useState } from "react";
import { useParams } from "next/navigation";
import { motion } from "framer-motion";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, Star, MapPin, UtensilsCrossed, Armchair, MessageCircle, Heart, PenLine, Ticket } from "lucide-react";
import TicketTab from "@/components/stadium/TicketTab";
import GlassCard from "@/components/ui/GlassCard";
import { STADIUMS } from "@/lib/constants/stadiums";
import { getTeamById } from "@/lib/constants/teams";

const MOCK_REVIEWS = [
  { id: 1, author: "직관러88", teamId: 1, rating: 5, content: "잠실 치킨거리는 직관 전 필수 코스! 사직동 닭똥집도 맛있지만 여기가 원탑", timeAgo: "2시간 전", likes: 45 },
  { id: 2, author: "야구초보", teamId: 2, rating: 4, content: "처음 직관 갔는데 외야 잔디석 분위기 최고였어요. 다만 경기는 잘 안 보임 ㅋㅋ", timeAgo: "5시간 전", likes: 32 },
  { id: 3, author: "시즌권자", teamId: 1, rating: 4, content: "테이블석 예매가 전쟁이에요... 오픈런 필수. 근데 한번 앉으면 천국", timeAgo: "1일 전", likes: 89 },
  { id: 4, author: "먹방투어", teamId: 2, rating: 5, content: "방이동 먹자골목 새로 생긴 양꼬치집 강추! 경기 끝나고 2차로 최고", timeAgo: "2일 전", likes: 67 },
  { id: 5, author: "아빠랑야구", teamId: 1, rating: 3, content: "아이랑 가기엔 좌석이 좁아요. 그래도 분위기는 좋아서 아이가 좋아함", timeAgo: "3일 전", likes: 28 },
];

export default function StadiumDetailPage() {
  const { stadiumId } = useParams();
  const { user } = useAuth();
  const [showLogin, setShowLogin] = useState(false);
  const [activeTab, setActiveTab] = useState<"food" | "seats" | "tickets" | "reviews">("food");
  const stadium = STADIUMS.find(s => s.id === stadiumId);

  if (!stadium) return <div className="flex items-center justify-center h-screen text-text-secondary">구장을 찾을 수 없습니다</div>;

  const teams = stadium.teamIds.map(id => getTeamById(id)!);
  const primaryTeam = teams[0];

  return (
    <div className="min-h-screen bg-bg-primary pb-24">
      {/* Header */}
      <div
        className="relative px-5 pt-safe pb-5"
        style={{ background: `linear-gradient(135deg, ${primaryTeam.colorPrimary}20, transparent)` }}
      >
        <Link href="/community/stadiums" className="inline-flex items-center gap-1 text-text-secondary mb-3">
          <ArrowLeft size={20} />
          <span className="text-sm">구장 가이드</span>
        </Link>
        <div className="flex items-center gap-3 mb-2">
          {teams.map(t => (
            <div key={t.id} className="w-10 h-10 rounded-full bg-white p-1 flex items-center justify-center">
              <Image src={t.logoPath} alt="" width={28} height={28} unoptimized className="object-contain" />
            </div>
          ))}
        </div>
        <h1 className="text-xl font-bold text-text-primary">{stadium.name}</h1>
        <div className="flex items-center gap-3 mt-1 text-sm text-text-tertiary">
          <span className="flex items-center gap-1"><MapPin size={14} />{stadium.city}</span>
          <span>{stadium.capacity}석</span>
          <span className="flex items-center gap-1 text-yellow-400"><Star size={14} fill="currentColor" />{stadium.rating}</span>
          <span>리뷰 {stadium.reviewCount}</span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border">
        {([
          { id: "food" as const, label: "🍗 맛집", icon: UtensilsCrossed },
          { id: "seats" as const, label: "💺 좌석팁", icon: Armchair },
          { id: "tickets" as const, label: "🎫 양도", icon: Ticket },
          { id: "reviews" as const, label: "💬 후기", icon: MessageCircle },
        ]).map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 py-3 text-sm font-medium relative transition-colors ${activeTab === tab.id ? "text-text-primary" : "text-text-tertiary"}`}
          >
            {tab.label}
            {activeTab === tab.id && (
              <motion.div layoutId="stadium-tab" className="absolute bottom-0 left-0 right-0 h-0.5" style={{ backgroundColor: primaryTeam.colorLight }} />
            )}
          </button>
        ))}
      </div>

      <div className="px-5 py-4">
        {/* 맛집 */}
        {activeTab === "food" && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3">
            {stadium.foodSpots.map((spot, i) => (
              <GlassCard key={i} className="p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-sm font-bold text-text-primary">{spot.name}</h3>
                    <div className="flex items-center gap-2 mt-1 text-xs text-text-tertiary">
                      <span className="px-1.5 py-0.5 rounded-full bg-bg-tertiary">{spot.category}</span>
                      <span>{spot.distance}</span>
                    </div>
                  </div>
                  <span className="flex items-center gap-1 text-yellow-400 text-sm">
                    <Star size={14} fill="currentColor" />{spot.rating}
                  </span>
                </div>
              </GlassCard>
            ))}
          </motion.div>
        )}

        {/* 좌석팁 */}
        {activeTab === "seats" && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3">
            {stadium.seatTips.map((seat, i) => (
              <GlassCard key={i} className="p-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h3 className="text-sm font-bold text-text-primary">{seat.zone}</h3>
                    <p className="text-xs text-text-secondary mt-1">{seat.tip}</p>
                  </div>
                  <span className="flex items-center gap-1 text-yellow-400 text-xs ml-3">
                    <Star size={12} fill="currentColor" />{seat.rating}
                  </span>
                </div>
              </GlassCard>
            ))}
          </motion.div>
        )}

        {/* 후기 */}

        {/* 티켓 양도 */}
        {activeTab === "tickets" && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <TicketTab venueId={stadiumId as string} teamIds={stadium.teamIds} />
          </motion.div>
        )}
        {activeTab === "reviews" && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3">
            {MOCK_REVIEWS.map((review) => {
              const t = getTeamById(review.teamId);
              return (
                <GlassCard key={review.id} className="p-4">
                  <div className="flex items-center gap-2 mb-2">
                    {t && (
                      <div className="w-5 h-5 rounded-full bg-white p-0.5 flex items-center justify-center">
                        <Image src={t.logoPath} alt="" width={14} height={14} unoptimized className="object-contain" />
                      </div>
                    )}
                    <span className="text-sm font-semibold text-text-primary">{review.author}</span>
                    <div className="flex gap-0.5">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Star key={i} size={10} fill={i < review.rating ? "#FBBF24" : "none"} className={i < review.rating ? "text-yellow-400" : "text-text-tertiary"} />
                      ))}
                    </div>
                    <span className="ml-auto text-xs text-text-tertiary">{review.timeAgo}</span>
                  </div>
                  <p className="text-sm text-text-secondary leading-relaxed">{review.content}</p>
                  <div className="mt-2 flex items-center gap-1 text-xs text-text-tertiary">
                    <Heart size={12} /> {review.likes}
                  </div>
                </GlassCard>
              );
            })}
          </motion.div>
        )}
      </div>

      {/* FAB */}
      <button
        onClick={() => { if (!user) { setShowLogin(true); return; } /* TODO: write post */ }}
        className="fixed bottom-24 right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full shadow-lg"
        style={{ backgroundColor: primaryTeam.colorPrimary }}
      >
        <PenLine className="w-6 h-6 text-white" />
      </button>
          <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />
    </div>
  );
}