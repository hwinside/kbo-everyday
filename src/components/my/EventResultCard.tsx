"use client";

import { useState, useEffect } from "react";
import { Trophy, Gift } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { useAuth } from "@/lib/supabase/AuthContext";
import { supabase } from "@/lib/supabase/client";
import { getPrizeTierByRank } from "@/lib/events/prizes";

interface SnapshotEntry {
  track: "invite" | "writing";
  rank: number;
  score: number;
  total: number;
}

const TRACK_LABEL: Record<SnapshotEntry["track"], string> = {
  invite: "친구 초대",
  writing: "글쓰기",
};

const SCORE_UNIT: Record<SnapshotEntry["track"], string> = {
  invite: "명 초대",
  writing: "점",
};

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * 얼리멤버 이벤트 최종 결과 카드 (마이페이지)
 * 동결된 스냅샷(event_leaderboard_snapshot) 기준 본인 순위 + 받을 상품 표시.
 * 양 트랙 모두 순위 없으면 렌더 안 함.
 */
export default function EventResultCard() {
  const { user } = useAuth();
  const [entries, setEntries] = useState<SnapshotEntry[] | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const headers = await getAuthHeaders();
        const res = await fetch("/api/leaderboard/my-snapshot", { headers });
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled) setEntries(json.entries ?? []);
      } catch {
        // noop — 결과 카드는 실패 시 조용히 숨김
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (!entries || entries.length === 0) return null;

  const hasPrize = entries.some((e) => getPrizeTierByRank(e.rank, e.track));

  return (
    <GlassCard className="p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Trophy size={18} className="text-yellow-400" />
        <h3 className="text-sm font-bold">얼리멤버 이벤트 최종 결과</h3>
      </div>

      <div className="space-y-2">
        {entries.map((e) => {
          const tier = getPrizeTierByRank(e.rank, e.track);
          return (
            <div
              key={e.track}
              className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg bg-bg-tertiary/40 border border-white/5"
            >
              <div className="flex flex-col">
                <span className="text-xs text-text-tertiary leading-tight">
                  {TRACK_LABEL[e.track]} 부문
                </span>
                <span className="text-sm font-semibold leading-tight">
                  {e.rank}위
                  <span className="text-text-tertiary font-normal">
                    {" "}/ {e.total}명 · {e.score}{SCORE_UNIT[e.track]}
                  </span>
                </span>
              </div>
              <div className="text-right">
                {tier ? (
                  <>
                    <span className="block text-sm font-semibold text-yellow-400 leading-tight">
                      {tier.prize}
                    </span>
                    <span className="block text-[10px] text-text-tertiary leading-tight">
                      🏅 {tier.badge}
                    </span>
                  </>
                ) : (
                  <span className="text-xs text-text-tertiary">순위권 외</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {hasPrize && (
        <p className="flex items-start gap-1.5 text-[11px] text-text-secondary leading-snug">
          <Gift size={13} className="mt-0.5 shrink-0 text-text-tertiary" />
          상품 및 뱃지는 운영자가 쪽지로 개별 안내드립니다. 쪽지를 확인해 주세요.
        </p>
      )}
    </GlassCard>
  );
}
