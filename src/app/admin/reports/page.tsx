"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, ShieldAlert } from "lucide-react";

interface TicketSummary {
  id: number;
  author_id: string;
  seat_area: string;
  price: number;
  status: string;
}

interface ReportRow {
  id: number;
  reporter_id: string | null;
  reporter_nickname: string | null;
  target_type: string;
  target_id: number;
  reason: string;
  detail: string | null;
  created_at: string;
  ticket: TicketSummary | null;
  game_review?: { id: number; game_id?: string; content: string; is_hidden: boolean; deleted_at: string | null } | null;
}

const TYPE_LABELS: Record<string, string> = {
  ticket: "티켓 웃돈",
  post: "게시글",
  comment: "댓글",
  chat: "채팅",
  game_review: "경기 한줄평",
  game_review_comment: "한줄평 댓글",
};

export default function AdminReportsPage() {
  const [items, setItems] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [moderationError, setModerationError] = useState("");
  const [moderating, setModerating] = useState(false);

  async function moderate(item: ReportRow) {
    if (!item.game_review || moderating) return;
    setModerating(true); setModerationError("");
    const hidden = !item.game_review.is_hidden;
    try {
      const res = await fetch("/api/admin/game-reviews", { method: "POST", headers: { "Content-Type": "application/json", "x-admin-pin": getPin() }, body: JSON.stringify({ targetType: item.target_type, targetId: item.target_id, hidden }) });
      if (!res.ok) throw new Error("처리에 실패했습니다. 다시 시도해 주세요.");
      setItems(previous => previous.map(row => row.target_type === item.target_type && row.target_id === item.target_id && row.game_review ? { ...row, game_review: { ...row.game_review, is_hidden: hidden } } : row));
    } catch (e) { setModerationError((e as Error).message); }
    finally { setModerating(false); }
  }

  const getPin = useCallback(() => {
    if (typeof window !== "undefined") {
      return sessionStorage.getItem("admin_pin") || "";
    }
    return "";
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch("/api/admin/reports", {
          headers: { "x-admin-pin": getPin() },
        });
        if (!res.ok) throw new Error("fetch failed");
        const json = await res.json();
        if (!cancelled) setItems(json.data as ReportRow[]);
      } catch {
        if (!cancelled) setItems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [getPin]);

  const filtered = useMemo(
    () => (typeFilter === "all" ? items : items.filter((i) => i.target_type === typeFilter)),
    [items, typeFilter],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="w-8 h-8 animate-spin text-[#6366F1]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {moderationError && <p role="alert">{moderationError}</p>}
      <div className="flex items-center gap-2">
        <ShieldAlert className="w-6 h-6 text-[#FF453A]" />
        <h1 className="text-2xl font-bold">신고 관리</h1>
      </div>

      <div className="glass-card p-5">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h2 className="text-lg font-semibold">신고 목록 (최근 200건)</h2>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-[#6366F1]"
          >
            <option value="all">전체 유형</option>
            {Object.entries(TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>

        {filtered.length === 0 ? (
          <div className="py-16 text-center text-[#8E8E93]">신고 없음</div>
        ) : (
          <div className="space-y-2">
            {filtered.map((r) => (
              <div key={r.id} className="rounded-xl bg-white/3 p-4 text-sm">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="px-2 py-0.5 rounded-full bg-[#FF453A]/15 text-[#FF453A] text-xs font-medium">
                    {TYPE_LABELS[r.target_type] ?? r.target_type}
                  </span>
                  <span className="text-xs text-[#8E8E93]">{r.reason}</span>
                  <span className="text-xs text-[#636366] ml-auto">
                    {new Date(r.created_at).toLocaleString("ko-KR")}
                  </span>
                </div>
                <p className="text-xs text-[#AEAEB2]">
                  대상 #{r.target_id}
                  {r.ticket && (
                    <span className="text-[#8E8E93]">
                      {" "}· {r.ticket.seat_area} · {r.ticket.price.toLocaleString()}원 · {r.ticket.status}
                      {" "}· 작성자 <span className="font-mono">{r.ticket.author_id.slice(0, 8)}</span>
                    </span>
                  )}
                </p>
                <p className="text-[10px] text-[#636366] mt-1">
                  신고자{" "}
                  {r.reporter_id === null ? (
                    <span className="text-[#AEAEB2]">탈퇴한 사용자</span>
                  ) : (
                    <>
                      {r.reporter_nickname && <span className="text-[#AEAEB2] mr-1">{r.reporter_nickname}</span>}
                      <span className="font-mono">{r.reporter_id.slice(0, 8)}</span>
                    </>
                  )}
                </p>
                {r.detail && <p className="text-xs text-[#8E8E93] mt-1">{r.detail}</p>}
                {r.game_review && <div className="mt-3 rounded-lg border border-white/10 p-3 text-sm">
                  {r.game_review.game_id && <a className="underline" href={`/games/${r.game_review.game_id}`}>경기 보기</a>}
                  <p className="my-2 whitespace-pre-wrap break-words">{r.game_review.content}</p>
                  <p>{r.game_review.deleted_at ? "작성자가 삭제함" : r.game_review.is_hidden ? "숨김 상태" : "노출 중"}</p>
                  {!r.game_review.deleted_at && <button className="mt-2 min-h-11 rounded-lg bg-white/10 px-3 disabled:opacity-40" disabled={moderating} onClick={() => void moderate(r)}>{r.game_review.is_hidden ? "숨김 해제" : "운영자 숨김"}</button>}
                </div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
