"use client";

import { useRef, useState } from "react";
import { useAuth } from "@/lib/supabase/AuthContext";
import { unblockUserById, useBlockList } from "@/lib/supabase/useBlock";
import TeamBadge from "@/components/ui/TeamBadge";

export default function BlockManagement() {
  const { user } = useAuth();
  const { blockedUsers, loading, error, refresh } = useBlockList();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [failed, setFailed] = useState(false);
  const [visibleCount, setVisibleCount] = useState(20);
  const busy = useRef(false);

  async function handleUnblock(id: string, nickname: string) {
    if (!user || busy.current) return;
    if (!window.confirm(`${nickname}님의 차단을 해제할까요?\n이 유저의 글과 쪽지가 다시 표시될 수 있어요.`)) return;
    busy.current = true;
    setPendingId(id);
    setNotice("");
    const ok = await unblockUserById(user.id, id);
    setFailed(!ok);
    setNotice(ok ? `${nickname}님의 차단을 해제했어요.` : "차단을 해제하지 못했어요. 다시 시도해 주세요.");
    setPendingId(null);
    busy.current = false;
  }

  return (
    <section aria-label="차단한 유저 목록" className="space-y-3">
      <p className="text-sm text-text-secondary">차단한 유저를 확인하고 차단을 해제할 수 있어요.</p>
      {notice && <p role={failed ? "alert" : "status"} className="text-sm text-text-primary">{notice}</p>}
      {loading ? <p role="status" className="py-8 text-center text-sm text-text-tertiary">불러오는 중...</p> : error ? (
        <div className="py-6 text-center">
          <p role="alert" className="text-sm text-text-secondary">{error}</p>
          <button onClick={() => void refresh()} className="mt-3 min-h-11 rounded-xl bg-bg-tertiary px-4 text-sm text-text-primary">다시 시도</button>
        </div>
      ) : blockedUsers.length === 0 ? (
        <p className="py-8 text-center text-sm text-text-tertiary">차단한 유저가 없습니다</p>
      ) : (
        <>
          <ul className="space-y-3">
            {blockedUsers.slice(0, visibleCount).map((blocked) => (
              <li key={blocked.id} className="flex items-center gap-3 rounded-xl bg-bg-tertiary p-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="break-words text-sm font-semibold text-text-primary">{blocked.nickname}</p>
                  {blocked.team_id ? <TeamBadge teamId={blocked.team_id} size="xs" /> : <p className="text-xs text-text-tertiary">응원 구단 미설정</p>}
                  <p className="text-xs text-text-tertiary">차단일 {new Date(blocked.created_at).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })}</p>
                </div>
                <button
                  onClick={() => void handleUnblock(blocked.blocked_id, blocked.nickname)}
                  disabled={pendingId !== null}
                  aria-label={`${blocked.nickname}님 차단 해제`}
                  className="min-h-11 shrink-0 rounded-xl border border-border bg-bg-secondary px-3 text-sm font-semibold text-text-primary disabled:opacity-50"
                >{pendingId === blocked.blocked_id ? "해제 중..." : "해제"}</button>
              </li>
            ))}
          </ul>
          {visibleCount < blockedUsers.length && <button onClick={() => setVisibleCount((count) => count + 20)} className="min-h-11 w-full rounded-xl bg-bg-tertiary text-sm text-text-primary">더 보기</button>}
        </>
      )}
    </section>
  );
}
