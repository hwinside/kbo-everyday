"use client";

import { useState, useRef } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Ticket, AlertTriangle, Loader2 } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { getTeamById } from "@/lib/constants/teams";
import TeamBadge from "@/components/ui/TeamBadge";
import DMButton from "@/components/ui/DMButton";
import LoginSheet from "@/components/auth/LoginSheet";
import { useAuth } from "@/lib/supabase/AuthContext";
import { supabase } from "@/lib/supabase/client";
import { useTickets, type TicketTransfer } from "@/lib/supabase/useTickets";
import { canReportTicket, resolveReportSubmitOutcome } from "@/lib/tickets/report-guard";
import { STADIUMS } from "@/lib/constants/stadiums";

function PriceBadge({ price, original }: { price: number; original: number | null }) {
  const isDiscount = original != null && price < original;
  const discountPct = original ? Math.round((1 - price / original) * 100) : 0;
  return (
    <div className="text-right">
      <span className="text-base font-bold text-text-primary">{price.toLocaleString()}원</span>
      {isDiscount ? (
        <div className="text-xs text-blue-400">🏷️ {discountPct}% 할인</div>
      ) : (
        <div className="text-xs text-green-400">✅ 정가 양도</div>
      )}
    </div>
  );
}

function TicketStatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; color: string }> = {
    open: { label: "양도중", color: "bg-green-500/20 text-green-400" },
    reserved: { label: "예약중", color: "bg-yellow-500/20 text-yellow-400" },
    sold: { label: "완료", color: "bg-red-500/20 text-red-400" },
    expired: { label: "만료", color: "bg-gray-500/20 text-gray-400" },
  };
  const c = config[status] || config.expired;
  return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${c.color}`}>{c.label}</span>;
}

function TicketCard({ ticket, currentUserId, onStatusChange }: { ticket: TicketTransfer; currentUserId?: string; onStatusChange?: (id: number, status: string) => Promise<{ error?: string }> }) {
  const [expanded, setExpanded] = useState(false);
  const [reportState, setReportState] = useState<"idle" | "confirm" | "submitting" | "done">("idle");
  const [reportError, setReportError] = useState("");

  async function submitReport() {
    setReportState("submitting");
    setReportError("");
    const { data: { session } } = await supabase.auth.getSession();
    const accessToken = session?.access_token;
    if (!accessToken) {
      setReportError("신고하려면 로그인이 필요합니다");
      setReportState("confirm");
      return;
    }
    try {
      const res = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ targetType: "ticket", targetId: ticket.id, reason: "웃돈 거래" }),
      });
      const data = await res.json().catch(() => ({}));
      // non-2xx는 body 형태와 무관하게 실패 처리(5xx + {} 응답이 완료로 전환되는 것 차단)
      const outcome = resolveReportSubmitOutcome({ ok: res.ok, body: data });
      if (outcome.kind === "error") {
        setReportError(outcome.message);
        setReportState("confirm");
        return;
      }
      setReportState("done");
    } catch {
      setReportError("신고 접수에 실패했어요. 잠시 후 다시 시도해주세요");
      setReportState("confirm");
    }
  }
  const opponent = ticket.opponent_team_id ? getTeamById(ticket.opponent_team_id) : null;
  const team = getTeamById(ticket.team_id);
  const dateStr = new Date(ticket.game_date + "T00:00:00").toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "short" });

  return (
    <GlassCard className="p-4 cursor-pointer" onClick={() => setExpanded(!expanded)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <TicketStatusBadge status={ticket.status} />
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
                <span className="text-xs text-text-tertiary">{ticket.author_nickname ?? "익명"}</span>
                <div className="flex items-center gap-2">
                  {/* 본인 글은 신고 버튼 미노출(자기글 자가신고 차단) */}
                  {canReportTicket({ ticketAuthorId: ticket.author_id, currentUserId }) && (
                    reportState === "done" ? (
                      <span className="text-xs text-text-tertiary">✅ 신고 접수됨</span>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); setReportError(""); setReportState("confirm"); }}
                        className="text-xs text-red-400/70 hover:text-red-400"
                      >
                        🚨 웃돈 신고
                      </button>
                    )
                  )}
                  {ticket.author_id && currentUserId !== ticket.author_id && (
                    <DMButton targetUserId={ticket.author_id} label="쪽지" size="sm" />
                  )}
                </div>
              </div>
              {currentUserId === ticket.author_id && onStatusChange && (
                <div className="flex gap-2 mt-2 pt-2 border-t border-border/50">
                  {ticket.status === "open" && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onStatusChange(ticket.id, "reserved"); }}
                      className="flex-1 py-1.5 rounded-lg bg-yellow-500/15 text-yellow-400 text-xs font-semibold"
                    >
                      예약중으로 변경
                    </button>
                  )}
                  {(ticket.status === "open" || ticket.status === "reserved") && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onStatusChange(ticket.id, "sold"); }}
                      className="flex-1 py-1.5 rounded-lg bg-green-500/15 text-green-400 text-xs font-semibold"
                    >
                      양도 완료
                    </button>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {reportState !== "idle" && reportState !== "done" && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[10000] flex items-center justify-center p-6" onClick={(e) => { e.stopPropagation(); if (reportState === "confirm") setReportState("idle"); }}>
          <div className="absolute inset-0 bg-black/60" />
          <div className="relative w-full max-w-xs bg-bg-secondary rounded-2xl p-5 text-center" onClick={(e) => e.stopPropagation()}>
            <span className="text-3xl">🚨</span>
            <h3 className="text-base font-bold text-text-primary mt-2">웃돈 거래 신고</h3>
            <p className="text-xs text-text-secondary mt-1.5">이 양도글을 웃돈(정가 초과) 거래로 신고할까요?<br/>허위 신고 시 이용이 제한될 수 있습니다.</p>
            {reportError && <p className="text-xs text-red-400 mt-2">{reportError}</p>}
            <div className="flex gap-2 mt-4">
              <button
                onClick={(e) => { e.stopPropagation(); setReportState("idle"); }}
                disabled={reportState === "submitting"}
                className="flex-1 py-2 rounded-lg bg-bg-tertiary text-text-secondary text-sm font-semibold disabled:opacity-50"
              >
                취소
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); submitReport(); }}
                disabled={reportState === "submitting"}
                className="flex-1 py-2 rounded-lg bg-red-500/90 text-white text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-1.5"
              >
                {reportState === "submitting" ? <Loader2 size={14} className="animate-spin" /> : null}
                신고하기
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </GlassCard>
  );
}

interface WriteTicketModalProps {
  isOpen: boolean;
  onClose: () => void;
  venueId: string;
  teamIds: number[];
  onSubmit: (ticket: Partial<TicketTransfer>) => Promise<{ error?: string }>;
}

function WriteTicketModal({ isOpen, onClose, venueId, teamIds, onSubmit }: WriteTicketModalProps) {
  const { user } = useAuth();
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submitRef = useRef(false);
  const [form, setForm] = useState({
    gameDate: "",
    seatArea: "",
    seatDetail: "",
    quantity: "1",
    price: "",
    description: "",
    teamId: teamIds.length === 1 ? teamIds[0] : 0,
  });

  if (!isOpen) return null;

  const handleSubmit = async () => {
    if (submitRef.current) return;
    const priceNum = parseInt(form.price) || 0;
    const qtyNum = parseInt(form.quantity) || 1;
    if (!agreed || !form.gameDate || !form.seatArea || !priceNum || !form.teamId) return;
    submitRef.current = true;
    setSubmitting(true);

    const result = await onSubmit({
      author_id: user!.id,
      team_id: form.teamId,
      venue_id: venueId === "all" ? "" : venueId,
      game_date: form.gameDate,
      seat_area: form.seatArea,
      seat_detail: form.seatDetail || null,
      quantity: qtyNum,
      price: priceNum,
      description: form.description || null,
      contact_method: "dm",
      status: "open",
    });

    setSubmitting(false);
    submitRef.current = false;

    if (result.error) {
      alert(`등록 실패: ${result.error}`);
    } else {
      onClose();
    }
  };

  return (
    <motion.div
      className="fixed inset-0 z-[60] flex items-end justify-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/60" />
      <motion.div
        className="relative w-full max-w-lg bg-bg-secondary rounded-t-2xl border-t border-border max-h-[85vh] flex flex-col"
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Scrollable form area */}
        <div className="flex-1 overflow-y-auto p-5 pb-3">
          <h3 className="text-lg font-bold text-text-primary mb-4">🎫 티켓 양도 등록</h3>

          <div className="space-y-3">
            {teamIds.length > 1 && (
              <div>
                <label className="text-xs text-text-tertiary">팀</label>
                <div className="flex gap-2 mt-1 overflow-x-auto">
                  {teamIds.map(id => {
                    const t = getTeamById(id);
                    if (!t) return null;
                    return (
                      <button key={id} onClick={() => setForm({ ...form, teamId: id })}
                        className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                          form.teamId === id ? "bg-accent text-white" : "bg-bg-tertiary text-text-secondary"
                        }`}>
                        <TeamBadge teamId={id} size="xs" />
                        {t.shortName}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
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
                <input type="text" inputMode="numeric" value={form.quantity} onChange={e => setForm({...form, quantity: e.target.value.replace(/\D/g, "")})}
                  className="w-full mt-1 px-3 py-2 rounded-xl bg-bg-tertiary text-sm text-text-primary outline-none" />
              </div>
              <div className="flex-1">
                <label className="text-xs text-text-tertiary">장당 가격 (원)</label>
                <input type="text" inputMode="numeric" placeholder="예: 17000" value={form.price} onChange={e => setForm({...form, price: e.target.value.replace(/\D/g, "")})}
                  className="w-full mt-1 px-3 py-2 rounded-xl bg-bg-tertiary text-sm text-text-primary placeholder:text-text-tertiary outline-none" />
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
              <p className="text-xs font-bold text-green-300">판매자 정가 이하 양도 원칙에 동의합니다</p>
              <p className="text-[10px] text-green-200/60 mt-0.5">
                실제 보유한 티켓만 정가 이하로 양도하며, 구함/대리구매 요청이나 웃돈 거래 시 이용이 제한될 수 있습니다.
              </p>
            </div>
          </label>

          <p className="mt-3 text-[11px] text-text-tertiary">
            판매자만 글을 등록할 수 있으며, 티켓을 구하시는 분은 등록된 양도 글에서 판매자에게 쪽지로 문의해주세요.
          </p>
        </div>

        {/* Sticky submit button — always visible above tab bar */}
        <div className="flex-shrink-0 px-5 pt-2 pb-[calc(16px+var(--safe-area-inset-bottom, env(safe-area-inset-bottom)))] border-t border-border bg-bg-secondary">
          <button
            onClick={handleSubmit}
            disabled={submitting || !agreed || !form.gameDate || !form.seatArea || !parseInt(form.price) || !form.teamId}
            className="w-full py-3 rounded-xl bg-accent text-white font-bold text-base disabled:opacity-30 transition-all flex items-center justify-center gap-2"
          >
            {submitting && <Loader2 size={16} className="animate-spin" />}
            {submitting ? "등록 중..." : "등록하기"}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

interface Props {
  venueId: string;
  teamIds: number[];
  showPolicyBanner?: boolean;
  showHeader?: boolean;
  onOpenFilters?: () => void;
}

export default function TicketTab({
  venueId,
  teamIds,
  showPolicyBanner = true,
  showHeader = false,
  onOpenFilters,
}: Props) {
  const { user } = useAuth();
  const [filter, setFilter] = useState<"all" | number>("all");
  const [writeOpen, setWriteOpen] = useState(false);
  const [showLogin, setShowLogin] = useState(false);

  const { tickets, loading, createTicket, updateTicketStatus } = useTickets(venueId === "all" ? undefined : venueId);

  const STATUS_ORDER: Record<string, number> = { open: 0, reserved: 1, sold: 2 };
  const filtered = tickets
    .filter(t => filter === "all" || t.team_id === filter)
    .sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const handleFabClick = () => {
    if (!user) {
      setShowLogin(true);
      return;
    }
    setWriteOpen(true);
  };

  return (
    <div className="space-y-3">
      {(showHeader || teamIds.length > 1) && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-text-tertiary">팀</span>
            {teamIds.length > 1 && (
              <span className="text-[11px] text-text-tertiary">필터</span>
            )}
          </div>
          {onOpenFilters && (
            <button
              onClick={onOpenFilters}
              className="text-xs font-semibold text-text-secondary px-3 py-1.5 rounded-full bg-bg-tertiary"
            >
              필터
            </button>
          )}
        </div>
      )}

      {teamIds.length > 1 && (
        <div className="flex gap-2 overflow-x-auto hide-scrollbar pr-2">
          <button
            onClick={() => setFilter("all")}
            className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
              filter === "all"
                ? "bg-accent text-white"
                : "bg-bg-tertiary text-text-secondary"
            }`}
          >
            전체
          </button>
          {teamIds.map((id) => {
            const t = getTeamById(id);
            if (!t) return null;
            return (
              <button
                key={id}
                onClick={() => setFilter(id)}
                className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  filter === id
                    ? "bg-black/8 dark:bg-white/10 text-text-primary"
                    : "bg-bg-tertiary text-text-secondary"
                }`}
              >
                <TeamBadge teamId={t.id} size="xs" />
              </button>
            );
          })}
        </div>
      )}

      {showPolicyBanner && (
        <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-3 flex items-start gap-2">
          <Ticket size={16} className="text-green-400 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-xs font-bold text-green-300">✅ 판매자 정가 이하 양도 원칙</p>
            <p className="text-xs text-green-200/70 mt-0.5">
              크보팬은 실제 보유 티켓의 정가 이하 양도만 허용합니다. 구함/대리구매 요청이나 웃돈 거래 적발 시 이용이 제한됩니다.
            </p>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12">
          <Loader2 size={24} className="mx-auto mb-2 animate-spin text-text-tertiary" />
          <p className="text-xs text-text-tertiary">불러오는 중...</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-text-tertiary">
          <Ticket size={32} className="mx-auto mb-2 opacity-50" />
          <p className="text-sm">아직 양도 글이 없어요</p>
          <p className="text-xs mt-1">첫 번째 양도 글을 올려보세요!</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(t => <TicketCard key={t.id} ticket={t} currentUserId={user?.id} onStatusChange={updateTicketStatus} />)}
        </div>
      )}

      {!writeOpen && (
        <button
          onClick={handleFabClick}
          className="fixed bottom-28 right-5 z-[51] w-14 h-14 rounded-full bg-accent text-white shadow-lg flex items-center justify-center text-2xl"
        >
          🎫
        </button>
      )}

      <AnimatePresence>
        {writeOpen && (
          <WriteTicketModal
            isOpen={writeOpen}
            onClose={() => setWriteOpen(false)}
            venueId={venueId}
            teamIds={teamIds}
            onSubmit={createTicket}
          />
        )}
      </AnimatePresence>

      <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />
    </div>
  );
}
