"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Trophy, Gift, ChevronRight } from "lucide-react";
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

// 결과 카드 노출 종료 시점 (이후 전 유저 자동 숨김 — 한시적 시즌 카드)
const RESULT_VISIBLE_UNTIL = new Date("2026-07-01T00:00:00+09:00");
const RESULT_ANNOUNCEMENT_PATH = "/whats-new";

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
 * - 수상자: 트랙별 순위 + 상품 + 뱃지
 * - 비수상(순위권 밖): 종료 안내 + 감사 + 결과공지 동선 (빈 화면 방지)
 * - 노출 종료(RESULT_VISIBLE_UNTIL) 이후 또는 fetch 실패 시 숨김.
 * 공지 CTA(/my#event-result) 진입 시 이 카드로 자동 스크롤.
 */
export default function EventResultCard() {
  const { user } = useAuth();
  // null = 미로딩/숨김, [] = 비수상(로드 완료), [...] = 수상
  const [entries, setEntries] = useState<SnapshotEntry[] | null>(null);
  // 노출 종료 여부 — hydration 안전하게 초기값 1회 계산 (render 중 Date.now 호출 회피)
  const [expired] = useState(() => Date.now() >= RESULT_VISIBLE_UNTIL.getTime());

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

  // 공지 CTA 앵커(/my#event-result) 진입 시 로드 완료된 카드로 스크롤
  useEffect(() => {
    if (entries === null) return;
    if (typeof window === "undefined") return;
    if (window.location.hash !== "#event-result") return;
    document
      .getElementById("event-result")
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [entries]);

  // 노출 종료 후 전 유저 숨김
  if (expired) return null;
  // 로드 전(또는 실패)엔 숨김 — 깜빡임 방지
  if (entries === null) return null;

  // 비수상(순위권 밖) — 빈 마이페이지 대신 종료 안내 카드
  if (entries.length === 0) {
    return (
      <GlassCard className="p-4 space-y-2.5">
        <div className="flex items-center gap-2">
          <Trophy size={18} className="text-yellow-400" />
          <h3 className="text-sm font-bold">얼리멤버 이벤트가 종료됐어요</h3>
        </div>
        <p className="text-xs text-text-secondary leading-snug">
          아쉽게 순위권에는 들지 못했지만, 한 달간 함께해 주셔서 감사합니다 🙏
        </p>
        <Link
          href={RESULT_ANNOUNCEMENT_PATH}
          className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg bg-bg-tertiary/40 border border-white/5"
        >
          <span className="text-sm font-semibold text-text-primary">
            최종 결과 보기
          </span>
          <ChevronRight size={16} className="text-text-tertiary" />
        </Link>
      </GlassCard>
    );
  }

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
