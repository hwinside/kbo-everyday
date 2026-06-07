"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, Trophy } from "lucide-react";
import { clsx } from "clsx";
import GlassCard from "@/components/ui/GlassCard";
import TeamBadge from "@/components/ui/TeamBadge";
import LevelBadge from "@/components/ui/LevelBadge";
import { getNextLevel } from "@/lib/constants/levels";
import { getTeamBorderColorById } from "@/lib/utils/team-border-color";
import { useAuth } from "@/lib/supabase/AuthContext";
import { supabase } from "@/lib/supabase/client";

type Tab = "monthly" | "cumulative";

interface MonthlyRow {
  user_id: string;
  nickname: string;
  team_id: number | null;
  monthly_points: number;
  last_active_day: string;
}

interface CumulativeRow {
  user_id: string;
  nickname: string;
  team_id: number | null;
  total_points: number;
  last_active_day: string;
}

type Row = MonthlyRow | CumulativeRow;

interface MyRank {
  rank: number | null;
  score?: number;
  nickname?: string;
  team_id?: number | null;
  total?: number;
  reason?: string;
  month?: string | null;
}

// 크보팬 글쓰기 집계 시작 월(KST). 아카이브 드롭다운 하한.
const LAUNCH_MONTH = "2026-04";

/** 현재 월(KST) "YYYY-MM" — monthly API 의 currentMonthKST 와 동일 규칙 */
function currentMonthKST(): string {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** LAUNCH_MONTH ~ 현재 월 (최신순) */
function monthRange(): string[] {
  const [ly, lm] = LAUNCH_MONTH.split("-").map(Number);
  const [cy, cm] = currentMonthKST().split("-").map(Number);
  const out: string[] = [];
  let y = cy;
  let m = cm;
  while (y > ly || (y === ly && m >= lm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return out;
}

function monthLabel(month: string): string {
  const [y, mo] = month.split("-");
  return `${y}년 ${Number(mo)}월`;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default function HallOfFamePage() {
  const router = useRouter();
  const { user, profile } = useAuth();
  const months = monthRange();

  const [tab, setTab] = useState<Tab>("monthly");
  const [month, setMonth] = useState<string>(() => currentMonthKST());
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeRank, setActiveRank] = useState<MyRank | null>(null);
  // 레벨/다음 레벨은 누적(lifetime) 점수 기준 — 월별 탭에서도 동일.
  const [levelScore, setLevelScore] = useState<number | null>(null);

  // 리스트 + 활성 탭 기준 내 순위
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const listUrl =
        tab === "monthly"
          ? `/api/leaderboard/monthly?month=${month}&limit=100`
          : `/api/leaderboard/writing?limit=100`;
      try {
        const r = await fetch(listUrl, { cache: "no-store" });
        const j = await r.json();
        if (!cancelled) setRows(j.rows ?? []);
      } catch {
        if (!cancelled) setRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }

      if (!user) {
        if (!cancelled) setActiveRank(null);
        return;
      }
      const headers = await getAuthHeaders();
      const rankUrl =
        tab === "monthly"
          ? `/api/leaderboard/my-rank?track=writing&month=${month}`
          : `/api/leaderboard/my-rank?track=writing`;
      try {
        const r = await fetch(rankUrl, { cache: "no-store", headers });
        const j = await r.json();
        if (!cancelled) setActiveRank(j);
      } catch {
        if (!cancelled) setActiveRank(null);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [tab, month, user]);

  // 누적 점수(레벨 산정) — 탭/월과 무관, 유저 변경 시에만 재조회
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLevelScore(null);
      if (!user) return;
      const headers = await getAuthHeaders();
      if (!headers.Authorization) return; // 토큰 없음 → null 유지(0 확정 금지)
      try {
        const r = await fetch(`/api/leaderboard/my-rank?track=writing`, {
          cache: "no-store",
          headers,
        });
        if (!r.ok) return;
        const j = await r.json();
        if (cancelled) return;
        setLevelScore(typeof j.score === "number" ? j.score : 0);
      } catch {
        // 네트워크/파싱 실패 → null 유지
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [user]);

  return (
    <div className="mx-auto max-w-lg px-5 pb-24">
      {/* Header */}
      <div
        className="border-b -mx-5 px-5"
        style={{
          borderColor: profile?.team_id
            ? getTeamBorderColorById(profile.team_id)
            : "var(--color-border)",
        }}
      >
        <header className="py-3 flex items-center gap-3">
          <button
            onClick={() => router.back()}
            className="rounded-full p-1 text-text-secondary hover:bg-bg-tertiary transition-colors"
            aria-label="뒤로"
          >
            <ChevronLeft size={24} />
          </button>
          <h1 className="text-lg font-semibold leading-[26px] text-text-primary flex-1">
            🏆 명예의 전당
          </h1>
        </header>
      </div>

      {/* Tabs */}
      <div className="mt-5 grid grid-cols-2 gap-2">
        <TabButton active={tab === "monthly"} onClick={() => setTab("monthly")} label="이번 달 랭킹" />
        <TabButton active={tab === "cumulative"} onClick={() => setTab("cumulative")} label="누적 랭킹" />
      </div>

      {/* 월 아카이브 (월별 탭만) */}
      {tab === "monthly" && (
        <div className="mt-3 flex justify-end">
          <select
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="rounded-lg border border-[var(--color-border)] bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary"
            aria-label="조회 월 선택"
          >
            {months.map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* 내 순위 헤더 */}
      {user ? (
        <MyRankHeader rank={activeRank} levelScore={levelScore} tab={tab} month={month} />
      ) : (
        <GlassCard className="mt-4 p-4 text-center">
          <p className="text-sm text-text-tertiary">로그인하면 내 순위를 볼 수 있어요</p>
        </GlassCard>
      )}

      {/* 랭킹 리스트 */}
      {loading ? (
        <div className="mt-4 py-12 text-center text-sm text-text-tertiary">불러오는 중…</div>
      ) : rows.length === 0 ? (
        <EmptyState tab={tab} />
      ) : (
        <div className="mt-4 space-y-2">
          {rows.map((row, idx) => (
            <RankRow
              key={row.user_id}
              rank={idx + 1}
              row={row}
              tab={tab}
              isMe={user?.id === row.user_id}
            />
          ))}
        </div>
      )}

      {/* Footer */}
      <div className="mt-8 text-center text-xs leading-relaxed text-text-tertiary">
        <p>채팅 1pt · 댓글 2pt · 글 3pt · 사진글 5pt · 일 최대 200pt</p>
        <p className="mt-1">
          {tab === "monthly"
            ? "매월 1일 0시(KST) 기준으로 새 달이 시작돼요"
            : "가입 이후 전체 누적 점수로 레벨이 정해져요"}
        </p>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "rounded-xl py-2.5 text-sm font-semibold transition-colors",
        active ? "bg-accent text-white" : "bg-bg-tertiary text-text-secondary",
      )}
    >
      {label}
    </button>
  );
}

function MyRankHeader({
  rank,
  levelScore,
  tab,
  month,
}: {
  rank: MyRank | null;
  levelScore: number | null;
  tab: Tab;
  month: string;
}) {
  const ranked = !!rank && rank.rank !== null;
  const nextLevel = levelScore !== null ? getNextLevel(levelScore) : null;
  const remaining = nextLevel ? Math.max(0, nextLevel.requiredPoints - (levelScore ?? 0)) : 0;
  const periodLabel = tab === "monthly" ? `${monthLabel(month)} · 내 순위` : "누적 · 내 순위";

  return (
    <GlassCard className="mt-4 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-text-tertiary">{periodLabel}</p>
          {ranked ? (
            <p className="text-xl font-bold text-text-primary">
              #{rank!.rank}
              <span className="ml-1 text-xs font-normal text-text-tertiary">/ {rank!.total}명</span>
            </p>
          ) : (
            <p className="mt-0.5 text-sm text-text-secondary">
              {tab === "monthly" ? "이 달엔 아직 활동 기록이 없어요" : "아직 집계된 점수가 없어요"}
            </p>
          )}
        </div>
        <div className="shrink-0 text-right">
          {ranked && (
            <p className="text-lg font-bold text-text-primary">
              {rank!.score}
              <span className="ml-0.5 text-xs font-normal text-text-tertiary">pt</span>
            </p>
          )}
          {levelScore !== null && (
            <div className="mt-0.5 flex items-center justify-end">
              <LevelBadge points={levelScore} showTitle />
            </div>
          )}
        </div>
      </div>
      {levelScore !== null && (
        <p className="mt-2 text-xs text-text-tertiary">
          {nextLevel ? `다음 레벨(${nextLevel.title})까지 ${remaining}점` : "최고 레벨 달성 🎉"}
        </p>
      )}
    </GlassCard>
  );
}

function RankRow({
  rank,
  row,
  tab,
  isMe,
}: {
  rank: number;
  row: Row;
  tab: Tab;
  isMe: boolean;
}) {
  const score = tab === "monthly" ? (row as MonthlyRow).monthly_points : (row as CumulativeRow).total_points;
  const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : null;

  return (
    <div
      className={clsx(
        "flex items-center justify-between rounded-xl border px-3 py-2.5",
        isMe ? "border-accent/40 bg-accent/5" : "border-[var(--color-border)] bg-bg-secondary",
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="w-7 shrink-0 text-center text-sm font-bold text-text-primary">
          {medal ?? rank}
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-semibold text-text-primary">{row.nickname}</span>
          {row.team_id != null && <TeamBadge teamId={row.team_id} size="xs" />}
          {tab === "cumulative" && <LevelBadge points={(row as CumulativeRow).total_points} />}
        </div>
      </div>
      <div className="shrink-0 text-sm font-bold text-text-primary">
        {score}
        <span className="ml-0.5 text-xs font-normal text-text-tertiary">pt</span>
      </div>
    </div>
  );
}

/**
 * EmptyState — 순위표 프레임을 유지한 채 "아직 없음" 안내 (이벤트 리더보드 패턴 차용)
 */
function EmptyState({ tab }: { tab: Tab }) {
  return (
    <div className="mt-4 space-y-2">
      <div className="flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-bg-secondary px-3 py-3.5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-tertiary">
          <Trophy size={16} className="text-text-tertiary" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text-secondary">
            {tab === "monthly" ? "이 달엔 아직 집계된 점수가 없어요" : "아직 집계된 점수가 없어요"}
          </p>
          <p className="mt-0.5 text-xs text-text-tertiary">채팅 · 댓글 · 글 · 사진으로 점수를 쌓아보세요</p>
        </div>
      </div>
      {[1, 2, 3].map((n) => (
        <div
          key={n}
          className="flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-bg-secondary/50 px-3 py-3"
        >
          <span className="w-6 text-center text-sm font-bold text-text-tertiary">{n}</span>
          <span className="flex-1 text-sm text-text-tertiary">-</span>
          <span className="text-xs text-text-tertiary">-</span>
        </div>
      ))}
    </div>
  );
}
