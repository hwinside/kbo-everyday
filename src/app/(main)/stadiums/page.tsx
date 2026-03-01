"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import Image from "next/image";
import Link from "next/link";
import { MapPin, Star, MessageCircle, UtensilsCrossed, Armchair } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { STADIUMS } from "@/lib/constants/stadiums";
import { getTeamById } from "@/lib/constants/teams";

const container = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } };
const item = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } };

export default function StadiumsPage() {
  return (
    <div className="mx-auto max-w-lg px-5 pb-24">
      <header className="py-5">
        <h1 className="text-xl font-bold text-text-primary">🏟️ 구장 가이드</h1>
        <p className="text-sm text-text-tertiary mt-1">맛집 · 좌석 리뷰 · 직관 꿀팁</p>
      </header>

      <motion.div variants={container} initial="hidden" animate="show" className="space-y-4">
        {STADIUMS.map((stadium) => {
          const teams = stadium.teamIds.map(id => getTeamById(id)!);
          return (
            <motion.div key={stadium.id} variants={item}>
              <Link href={`/stadiums/${stadium.id}`}>
                <GlassCard pressable className="p-4">
                  <div className="flex items-start gap-4">
                    {/* Teams */}
                    <div className="flex -space-x-2">
                      {teams.map(t => (
                        <div key={t.id} className="w-10 h-10 rounded-full bg-white p-1 flex items-center justify-center border-2 border-bg-primary">
                          <Image src={t.logoPath} alt="" width={28} height={28} unoptimized className="object-contain" />
                        </div>
                      ))}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="text-base font-bold text-text-primary">{stadium.name}</h3>
                      <div className="flex items-center gap-2 mt-0.5">
                        <MapPin size={12} className="text-text-tertiary" />
                        <span className="text-xs text-text-tertiary">{stadium.city}</span>
                        <span className="text-xs text-text-tertiary">· {stadium.capacity}석</span>
                      </div>
                      <div className="flex items-center gap-4 mt-2 text-xs">
                        <span className="flex items-center gap-1 text-yellow-400">
                          <Star size={12} fill="currentColor" /> {stadium.rating}
                        </span>
                        <span className="flex items-center gap-1 text-text-tertiary">
                          <MessageCircle size={12} /> 리뷰 {stadium.reviewCount}
                        </span>
                        <span className="flex items-center gap-1 text-text-tertiary">
                          <UtensilsCrossed size={12} /> 맛집 {stadium.foodSpots.length}
                        </span>
                        <span className="flex items-center gap-1 text-text-tertiary">
                          <Armchair size={12} /> 좌석팁 {stadium.seatTips.length}
                        </span>
                      </div>
                    </div>
                  </div>
                </GlassCard>
              </Link>
            </motion.div>
          );
        })}
      </motion.div>
    </div>
  );
}
