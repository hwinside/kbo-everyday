"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Filter, X, Ticket, ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import TicketTab from "@/components/stadium/TicketTab";
import { STADIUMS } from "@/lib/constants/stadiums";
import { TEAMS } from "@/lib/constants/teams";

export default function TicketBoardPage() {
  const router = useRouter();
  const [venue, setVenue] = useState<string | null>(null);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);

  useEffect(() => {
    const v =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("venue")
        : null;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVenue(v);
  }, []);

  const stadium = useMemo(() => {
    if (!venue) return null;
    return STADIUMS.find((s) => s.id === venue) || null;
  }, [venue]);

  const venueId = stadium ? stadium.id : "all";
  const teamIds = stadium ? stadium.teamIds : TEAMS.map((t) => t.id);

  return (
    <div className="mx-auto max-w-lg pb-24 overflow-x-hidden">
      {/* Banner (slim) */}
      <div className="mx-5 mt-4 mb-4">
        <div className="rounded-2xl bg-accent/10 p-4">
          <div className="flex items-center gap-3">
            <Ticket size={20} className="text-accent flex-shrink-0" />
            <p className="text-sm text-text-secondary">
              실제 보유한 티켓을 정가 이하로 양도하는 판매자만 글을 올릴 수 있습니다. 티켓을 구하시는 분은 등록된 양도 글에서 판매자에게 쪽지로 문의해주세요.
            </p>
          </div>

          <button
            onClick={() => setPolicyOpen((v) => !v)}
            className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-text-secondary"
          >
            ✅ 정가 이하 양도 원칙 {policyOpen ? "접기" : "보기"}
            <ChevronDown
              size={14}
              className={"transition-transform " + (policyOpen ? "rotate-180" : "")}
            />
          </button>
          <AnimatePresence initial={false}>
            {policyOpen && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                <p className="mt-2 text-xs text-text-tertiary leading-relaxed">
                  크보팬은 판매자의 정가 이하 양도만 허용합니다. 티켓 구함/대리구매 요청,
                  정가보다 비싼 웃돈 거래 적발 시 이용이 제한될 수 있습니다.
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {stadium && (
          <div className="mt-3 flex items-center gap-2">
            <div className="inline-flex items-center gap-2 rounded-full bg-bg-tertiary px-3 py-1.5 text-xs text-text-secondary">
              <span className="font-semibold text-text-primary">{stadium.name}</span>
              <span className="text-text-tertiary">필터 적용됨</span>
              <button
                onClick={() => {
                  setVenue(null);
                  if (typeof window !== "undefined") {
                    window.history.replaceState({}, "", "/community/tickets");
                  }
                  router.replace("/community/tickets");
                }}
                className="ml-1 rounded-full p-1 hover:bg-black/8 dark:hover:bg-white/10"
                aria-label="필터 해제"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="mx-5">
        <TicketTab
          venueId={venueId}
          teamIds={teamIds}
          showPolicyBanner={false}
          showHeader
          onOpenFilters={() => setFilterOpen(true)}
        />
      </div>

      <AnimatePresence>
        {filterOpen && (
          <motion.div
            className="fixed inset-0 z-50 flex items-end justify-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setFilterOpen(false)}
          >
            <div className="absolute inset-0 bg-black/60" />
            <motion.div
              className="relative w-full max-w-lg bg-bg-secondary rounded-t-2xl border-t border-border p-5 pb-safe max-h-[85vh] overflow-y-auto"
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold text-text-primary flex items-center gap-2">
                  <Filter size={18} /> 필터
                </h3>
                <button
                  onClick={() => setFilterOpen(false)}
                  className="rounded-full p-2 hover:bg-bg-tertiary"
                  aria-label="닫기"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="space-y-3">
                <div>
                  <p className="text-xs font-bold text-text-tertiary mb-2">구장</p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => {
                        setVenue(null);
                        if (typeof window !== "undefined") {
                          window.history.replaceState({}, "", "/community/tickets");
                        }
                        router.replace("/community/tickets");
                        setFilterOpen(false);
                      }}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                        !stadium
                          ? "bg-accent text-white"
                          : "bg-bg-tertiary text-text-secondary"
                      }`}
                    >
                      전체
                    </button>
                    {STADIUMS.map((s) => (
                      <button
                        key={s.id}
                        onClick={() => {
                          setVenue(s.id);
                          const url = `/community/tickets?venue=${s.id}`;
                          if (typeof window !== "undefined") {
                            window.history.replaceState({}, "", url);
                          }
                          router.replace(url);
                          setFilterOpen(false);
                        }}
                        className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                          stadium?.id === s.id
                            ? "bg-accent text-white"
                            : "bg-bg-tertiary text-text-secondary"
                        }`}
                      >
                        {s.name}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="text-xs text-text-tertiary">
                  날짜 필터는 다음 업데이트에서 추가할게요.
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
