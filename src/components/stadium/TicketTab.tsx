"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Ticket, AlertTriangle } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { getTeamById } from "@/lib/constants/teams";
import TeamBadge from "@/components/ui/TeamBadge";
import { useAuth } from "@/lib/supabase/AuthContext";

interface TicketData {
  id: number;
  team_id: number;
  venue_id: string;
  game_date: string;
  opponent_team_id: number | null;
  seat_area: string;
  seat_detail: string | null;
  quantity: number;
  price: number;
  original_price: number | null;
  status: string;
  contact_method: string;
  contact_info: string | null;
  description: string | null;
  nickname: string;
}

const MOCK_TICKETS: TicketData[] = [
  { id: 1, team_id: 1, venue_id: "jamsil", game_date: "2026-03-28", opponent_team_id: 6, seat_area: "1루 응원석", seat_detail: "블록 108 열 15", quantity: 2, price: 25000, original_price: 20000, status: "open", contact_method: "카톡 오픈채팅", contact_info: "https://open.kakao.com/example", description: "개막전 티켓 2장 양도합니다. 연석이에요!", nickname: "엘지빠" },
  { id: 2, team_id: 1, venue_id: "jamsil", game_date: "2026-03-29", opponent_team_id: 6, seat_area: "테이블석", seat_detail: "T구역 12번", quantity: 4, price: 45000, original_price: 35000, status: "open", contact_method: "댓글", contact_info: null, description: "4인 테이블석 통째로! 치맥하기 최고 자리", nickname: "직관마스터" },
  { id: 3, team_id: 2, venue_id: "jamsil", game_date: "2026-04-01", opponent_team_id: 8, seat_area: "3루 내야", seat_detail: "블록 305 열 8", quantity: 1, price: 18000, original_price: 18000, status: "open", contact_method: "카톡 오픈채팅", contact_info: null, description: "정가 양도합니다. 두산 vs 삼성", nickname: "곰돌이" },
  { id: 4, team_id: 1, venue_id: "jamsil", game_date: "2026-04-05", opponent_team_id: 4, seat_area: "외야 잔디석", seat_detail: null, quantity: 3, price: 15000, original_price: 15000, status: "open", contact_method: "댓글", contact_info: null, description: "잔디석 3자리. 돗자리 별도 준비하세요~", nickname: "잔디러버" },
];

function PriceBadge({ price, original }: { price: number; original: number | null }) {
  if (!original) return <span className="text-base font-bold text-text-primary">{price.toLocaleString()}원</span>;
  const diff = ((price - original) / original) * 100;
  const isOver = diff > 0;
  const isWarning = diff > 50;
  return (
    <div className="text-right">
      <span className="text-base font-bold text-text-primary">{price.toLocaleString()}원</span>
      <div className={`text-xs ${isWarning ? "text-red-400" : isOver ? "text-yellow-400" : "text-green-400"}`}>
        {isWarning && <AlertTriangle size={10} className="inline mr-0.5" />}
        정가 {original.toLocaleString()}원 ({isOver ? "+" : ""}{Math.round(diff)}%)
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; color: string }> = {
    open: { label: "양도중", color: "bg-green-500/20 text-green-400" },
    reserved: { label: "예약중", color: "bg-yellow-500/20 text-yellow-400" },
    sold: { label: "완료", color: "bg-red-500/20 text-red-400" },
    expired: { label: "만료", color: "bg-gray-500/20 text-gray-400" },
  };
  const c = config[status] || config.expired;
  return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${c.color}`}>{c.label}</span>;
}

function TicketCard({ ticket }: { ticket: TicketData }) {
  const [expanded, setExpanded] = useState(false);
  const opponent = ticket.opponent_team_id ? getTeamById(ticket.opponent_team_id) : null;
  const team = getTeamById(ticket.team_id);
  const dateStr = new Date(ticket.game_date + "T00:00:00").toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "short" });

  return (
    <GlassCard className="p-4 cursor-pointer" onClick={() => setExpanded(!expanded)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <StatusBadge status={ticket.status} />
            <span className="text-xs text-text-tertiary">{ticket.quantity}매</span>
          </div>
          <div className="flex items-center gap-1.5 mb-1">
            {team && <TeamBadge teamId={team.id} size="xs" />}
            {opponent && (
              <>
                <span className="text-xs text-text-tertiary">vs</span>
                <TeamBadge teamId={opponent.id} size="xs" />
              </>
            )}
            <span className="text-xs text-text-tertiary ml-1">{dateStr}</span>
          </div>
          <p className="text-sm font-semibold text-text-primary">{ticket.seat_area}</p>
          {ticket.seat_detail && <p className="text-xs text-text-tertiary">{ticket.seat_detail}</p>}
        </div>
        <PriceBadge price={ticket.price} original={ticket.original_price} />
      </div>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="mt-3 pt-3 border-t border-border space-y-2">
              {ticket.description && (
                <p className="text-sm text-text-secondary">{ticket.description}</p>
              )}
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-tertiary">{ticket.nickname} · {ticket.contact_method}</span>
                {ticket.contact_info && (
                  <a href={ticket.contact_info} target="_blank" rel="noopener noreferrer"
                    className="text-xs font-semibold text-accent" onClick={(e) => e.stopPropagation()}>
                    연락하기 →
                  </a>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </GlassCard>
  );
}

interface Props {
  venueId: string;
  teamIds: number[];
}

export default function TicketTab({ venueId, teamIds }: Props) {
  const [filter, setFilter] = useState<"all" | number>("all");
  const tickets = MOCK_TICKETS.filter(t =>
    t.venue_id === venueId && (filter === "all" || t.team_id === filter)
  );

  return (
    <div className="space-y-3">
      {teamIds.length > 1 && (
        <div className="flex gap-2">
          <button onClick={() => setFilter("all")}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${filter === "all" ? "bg-accent text-white" : "bg-bg-tertiary text-text-secondary"}`}>
            전체
          </button>
          {teamIds.map(id => {
            const t = getTeamById(id);
            if (!t) return null;
            return (
              <button key={id} onClick={() => setFilter(id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${filter === id ? "bg-white/10 text-text-primary" : "bg-bg-tertiary text-text-secondary"}`}>
                <TeamBadge teamId={t.id} size="xs" />{t.name}
              </button>
            );
          })}
        </div>
      )}

      <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-3 flex items-start gap-2">
        <AlertTriangle size={16} className="text-yellow-400 mt-0.5 flex-shrink-0" />
        <p className="text-xs text-yellow-200/80">
          크보 에브리데이는 양도 매칭만 제공하며, 거래 책임은 당사자에게 있습니다.
        </p>
      </div>

      {tickets.length === 0 ? (
        <div className="text-center py-12 text-text-tertiary">
          <Ticket size={32} className="mx-auto mb-2 opacity-50" />
          <p className="text-sm">아직 양도 글이 없어요</p>
          <p className="text-xs mt-1">첫 번째 양도 글을 올려보세요!</p>
        </div>
      ) : (
        <div className="space-y-3">
          {tickets.map(t => <TicketCard key={t.id} ticket={t} />)}
        </div>
      )}
    </div>
  );
}
