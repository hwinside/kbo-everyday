"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Ticket, AlertTriangle } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { getTeamById } from "@/lib/constants/teams";
import TeamBadge from "@/components/ui/TeamBadge";

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
  { id: 1, team_id: 1, venue_id: "jamsil", game_date: "2026-03-28", opponent_team_id: 6, seat_area: "1루 응원석", seat_detail: "블록 108 열 15", quantity: 2, price: 20000, original_price: 20000, status: "open", contact_method: "카톡 오픈채팅", contact_info: "https://open.kakao.com/example", description: "개막전 티켓 2장 양도합니다. 연석이에요!", nickname: "엘지빠" },
  { id: 2, team_id: 1, venue_id: "jamsil", game_date: "2026-03-29", opponent_team_id: 6, seat_area: "테이블석", seat_detail: "T구역 12번", quantity: 4, price: 35000, original_price: 35000, status: "open", contact_method: "댓글", contact_info: null, description: "4인 테이블석 통째로! 치맥하기 최고 자리", nickname: "직관마스터" },
  { id: 3, team_id: 2, venue_id: "jamsil", game_date: "2026-04-01", opponent_team_id: 8, seat_area: "3루 내야", seat_detail: "블록 305 열 8", quantity: 1, price: 18000, original_price: 18000, status: "open", contact_method: "카톡 오픈채팅", contact_info: null, description: "정가 양도합니다. 두산 vs 삼성", nickname: "곰돌이" },
  { id: 4, team_id: 1, venue_id: "jamsil", game_date: "2026-04-05", opponent_team_id: 4, seat_area: "외야 잔디석", seat_detail: null, quantity: 3, price: 15000, original_price: 15000, status: "open", contact_method: "댓글", contact_info: null, description: "잔디석 3자리. 돗자리 별도 준비하세요~", nickname: "잔디러버" },
];

function PriceBadge({ price, original }: { price: number; original: number | null }) {
  return (
    <div className="text-right">
      <span className="text-base font-bold text-text-primary">{price.toLocaleString()}원</span>
      <div className="text-xs text-green-400">✅ 정가 양도</div>
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
                <button
                  onClick={(e) => { e.stopPropagation(); alert("웃돈 거래 신고가 접수되었습니다. 확인 후 조치하겠습니다."); }}
                  className="text-xs text-red-400/70 hover:text-red-400"
                >
                  🚨 웃돈 신고
                </button>
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

function WriteTicketModal({ isOpen, onClose, venueId }: { isOpen: boolean; onClose: () => void; venueId: string }) {
  const [agreed, setAgreed] = useState(false);
  const [form, setForm] = useState({ gameDate: "", seatArea: "", quantity: 1, price: 0, description: "" });

  if (!isOpen) return null;

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-end justify-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/60" />
      <motion.div
        className="relative w-full max-w-lg bg-bg-secondary rounded-t-2xl border-t border-border p-5 max-h-[85vh] overflow-y-auto"
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-lg font-bold text-text-primary mb-4">🎫 티켓 양도 등록</h3>

        <div className="space-y-3">
          <div>
            <label className="text-xs text-text-tertiary">경기 날짜</label>
            <input type="date" value={form.gameDate} onChange={e => setForm({...form, gameDate: e.target.value})}
              className="w-full mt-1 px-3 py-2 rounded-xl bg-bg-tertiary text-sm text-text-primary outline-none" />
          </div>
          <div>
            <label className="text-xs text-text-tertiary">좌석 구역</label>
            <input type="text" placeholder="예: 1루 응원석 블록 108" value={form.seatArea} onChange={e => setForm({...form, seatArea: e.target.value})}
              className="w-full mt-1 px-3 py-2 rounded-xl bg-bg-tertiary text-sm text-text-primary placeholder:text-text-tertiary outline-none" />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-xs text-text-tertiary">매수</label>
              <input type="number" min={1} max={10} value={form.quantity} onChange={e => setForm({...form, quantity: parseInt(e.target.value) || 1})}
                className="w-full mt-1 px-3 py-2 rounded-xl bg-bg-tertiary text-sm text-text-primary outline-none" />
            </div>
            <div className="flex-1">
              <label className="text-xs text-text-tertiary">장당 가격 (원)</label>
              <input type="number" min={0} step={1000} value={form.price} onChange={e => setForm({...form, price: parseInt(e.target.value) || 0})}
                className="w-full mt-1 px-3 py-2 rounded-xl bg-bg-tertiary text-sm text-text-primary outline-none" />
            </div>
          </div>
          <div>
            <label className="text-xs text-text-tertiary">한마디</label>
            <textarea placeholder="양도 관련 추가 정보를 적어주세요" value={form.description} onChange={e => setForm({...form, description: e.target.value})}
              className="w-full mt-1 px-3 py-2 rounded-xl bg-bg-tertiary text-sm text-text-primary placeholder:text-text-tertiary outline-none h-20 resize-none" />
          </div>
        </div>

        <label className="flex items-start gap-2 mt-4 p-3 rounded-xl bg-green-500/10 border border-green-500/20 cursor-pointer">
          <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)}
            className="mt-0.5 accent-green-500" />
          <div>
            <p className="text-xs font-bold text-green-300">정가 양도 원칙에 동의합니다</p>
            <p className="text-[10px] text-green-200/60 mt-0.5">
              티켓 정가 이하로만 양도하며, 위반 시 이용이 제한될 수 있습니다.
            </p>
          </div>
        </label>

        <button
          onClick={() => { if (!agreed) { alert("정가 양도 원칙에 동의해주세요."); return; } alert("양도 글이 등록되었습니다!"); onClose(); }}
          disabled={!agreed || !form.gameDate || !form.seatArea || !form.price}
          className="w-full mt-4 py-3 rounded-xl bg-accent text-white font-bold text-base disabled:opacity-30 transition-all"
        >
          등록하기
        </button>
      </motion.div>
    </motion.div>
  );
}

export default function TicketTab({ venueId, teamIds }: Props) {
  const [filter, setFilter] = useState<"all" | number>("all");
  const [writeOpen, setWriteOpen] = useState(false);
  const tickets = MOCK_TICKETS.filter(t =>
    String(t.venue_id) === String(venueId) && (filter === "all" || t.team_id === filter)
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
                <TeamBadge teamId={t.id} size="xs" />
              </button>
            );
          })}
        </div>
      )}

      <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-3 flex items-start gap-2">
        <Ticket size={16} className="text-green-400 mt-0.5 flex-shrink-0" />
        <div>
          <p className="text-xs font-bold text-green-300">✅ 정가 양도 원칙</p>
          <p className="text-xs text-green-200/70 mt-0.5">
            크보 에브리데이는 정가 양도만 허용합니다. 웃돈 거래 적발 시 이용이 제한됩니다.
          </p>
        </div>
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
      <button
        onClick={() => setWriteOpen(true)}
        className="fixed bottom-20 right-4 z-40 w-14 h-14 rounded-full bg-accent text-white shadow-lg flex items-center justify-center text-2xl"
      >
        🎫
      </button>

      <AnimatePresence>
        {writeOpen && <WriteTicketModal isOpen={writeOpen} onClose={() => setWriteOpen(false)} venueId={venueId} />}
      </AnimatePresence>
    </div>
  );
}
