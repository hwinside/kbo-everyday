"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useSafeBack } from "@/lib/hooks/useSafeBack";
import { ChevronLeft, Trophy } from "lucide-react";
import { clsx } from "clsx";
import GlassCard from "@/components/ui/GlassCard";
import TeamBadge from "@/components/ui/TeamBadge";
import LevelBadge from "@/components/ui/LevelBadge";
import { getNextLevel } from "@/lib/constants/levels";
import { getTeamBorderColorById } from "@/lib/utils/team-border-color";
import { useAuth } from "@/lib/supabase/AuthContext";
import { supabase } from "@/lib/supabase/client";

type Tab = "monthly" | "cumulative" | "invite";

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

interface InviteRow {
  user_id: string;
  nickname: string;
  team_id: number | null;
  invite_count: number;
  last_activated_at: string;
}

type Row = MonthlyRow | CumulativeRow | InviteRow;

interface MyRank {
  rank: number | null;
  score?: number;
  nickname?: string;
  team_id?: number | null;
  total?: number;
  reason?: string;
  month?: string | null;
}

interface RowsResult {
  requestKey: string;
  rows: Row[];
}

interface RankResult {
  requestKey: string;
  rank: MyRank | null;
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
  const goBack = useSafeBack("/my");
  const { user, profile } = useAuth();
  const months = monthRange();

  const [tab, setTab] = useState<Tab>("monthly");
  const [month, setMonth] = useState<string>(() => currentMonthKST());
  const listRequestKey = tab === "monthly" ? `${tab}:${month}` : tab;
  const userId = user?.id ?? null;
  const rankRequestKey = `${listRequestKey}:${userId ?? "guest"}`;
  const listUrl =
    tab === "monthly"
      ? `/api/leaderboard/monthly?month=${month}&limit=100`
      : tab === "cumulative"
        ? `/api/leaderboard/writing?limit=100`
        : `/api/leaderboard/invite?limit=100`;
  const rankUrl =
    tab === "monthly"
      ? `/api/leaderboard/my-rank?track=writing&month=${month}`
      : tab === "cumulative"
        ? `/api/leaderboard/my-rank?track=writing`
        : `/api/leaderboard/my-rank?track=invite`;
  const [rowsResult, setRowsResult] = useState<RowsResult>({ requestKey: "", rows: [] });
  const [rankResult, setRankResult] = useState<RankResult>({ requestKey: "", rank: null });
  // 탭/월/유저가 바뀐 첫 렌더부터 이전 응답을 숨겨 pt→명 등 stale 단위 오표시를 막는다.
  const rows = rowsResult.requestKey === listRequestKey ? rowsResult.rows : [];
  const loading = rowsResult.requestKey !== listRequestKey;
  const activeRank = rankResult.requestKey === rankRequestKey ? rankResult.rank : null;
  // 레벨/다음 레벨은 누적(lifetime) 점수 기준 — 월별 탭에서도 동일.
  const [levelScore, setLevelScore] = useState<number | null>(null);

  // 목록과 내 순위는 별도 effect로 같은 렌더에서 병렬 시작한다.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    async function loadRows() {
      try {
        const r = await fetch(listUrl, { cache: "no-store", signal: controller.signal });
        const j = await r.json();
        if (!cancelled) setRowsResult({ requestKey: listRequestKey, rows: j.rows ?? [] });
      } catch {
        if (!cancelled) setRowsResult({ requestKey: listRequestKey, rows: [] });
      }
    }
    void loadRows();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [listRequestKey, listUrl]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    async function loadRank() {
      if (!userId) {
        setRankResult({ requestKey: rankRequestKey, rank: null });
        return;
      }
      const headers = await getAuthHeaders();
      if (cancelled) return;
      try {
        const r = await fetch(rankUrl, {
          cache: "no-store",
          headers,
          signal: controller.signal,
        });
        const j = await r.json();
        if (!cancelled) setRankResult({ requestKey: rankRequestKey, rank: j });
      } catch {
        if (!cancelled) setRankResult({ requestKey: rankRequestKey, rank: null });
      }
    }
    void loadRank();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [rankRequestKey, rankUrl, userId]);

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
        className="sticky top-0 z-30 border-b -mx-5 px-5 bg-bg-primary"
        style={{
          borderColor: profile?.team_id
            ? getTeamBorderColorById(profile.team_id)
            : "var(--color-border)",
          paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))",
          marginTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) * -1)",
        }}
      >
        <header className="min-h-[44px] flex items-center gap-3">
          <button
            onClick={goBack}
            className="flex h-11 w-11 items-center justify-center rounded-full text-text-secondary hover:bg-bg-tertiary transition-colors -ml-2.5"
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
      <div className="mt-5 grid grid-cols-3 gap-2">
        <TabButton active={tab === "monthly"} onClick={() => setTab("monthly")} label="이번 달 랭킹" />
        <TabButton active={tab === "cumulative"} onClick={() => setTab("cumulative")} label="누적 랭킹" />
        <TabButton active={tab === "invite"} onClick={() => setTab("invite")} label="초대 랭킹" />
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
        {tab === "invite" ? (
          <p>친구가 팀 선택 + 첫 글/댓글을 완료하면 1명 반영</p>
        ) : (
          <>
            <p>채팅 1pt · 댓글 2pt · 글 3pt · 사진글 5pt · 일 최대 200pt</p>
            <p className="mt-1">
              {tab === "monthly"
                ? "매월 1일 0시(KST) 기준으로 새 달이 시작돼요"
                : "가입 이후 전체 누적 점수로 레벨이 정해져요"}
            </p>
          </>
        )}
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
  const showLevel = tab !== "invite" && levelScore !== null;
  const nextLevel = showLevel ? getNextLevel(levelScore) : null;
  const remaining = nextLevel ? Math.max(0, nextLevel.requiredPoints - (levelScore ?? 0)) : 0;
  const periodLabel =
    tab === "monthly" ? `${monthLabel(month)} · 내 순위` : tab === "cumulative" ? "누적 · 내 순위" : "초대 · 내 순위";
  const unit = tab === "invite" ? "명" : "pt";

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
              {tab === "monthly"
                ? "이 달엔 아직 활동 기록이 없어요"
                : tab === "cumulative"
                  ? "아직 집계된 점수가 없어요"
                  : "아직 반영된 친구 초대가 없어요"}
            </p>
          )}
        </div>
        <div className="shrink-0 text-right">
          {ranked && (
            <p className="text-lg font-bold text-text-primary">
              {rank!.score}
              <span className="ml-0.5 text-xs font-normal text-text-tertiary">{unit}</span>
            </p>
          )}
          {showLevel && (
            <div className="mt-0.5 flex items-center justify-end">
              <LevelBadge points={levelScore!} showTitle />
            </div>
          )}
        </div>
      </div>
      {showLevel && (
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
  const score =
    tab === "monthly"
      ? (row as MonthlyRow).monthly_points
      : tab === "cumulative"
        ? (row as CumulativeRow).total_points
        : (row as InviteRow).invite_count;
  const unit = tab === "invite" ? "명" : "pt";
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
          <Link
            href={`/profile/${row.user_id}`}
            className="-my-1 truncate rounded-sm py-1 font-semibold text-text-primary transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 active:text-accent"
          >
            {row.nickname}
          </Link>
          {row.team_id != null && <TeamBadge teamId={row.team_id} size="xs" />}
          {tab === "cumulative" && <LevelBadge points={(row as CumulativeRow).total_points} />}
        </div>
      </div>
      <div className="shrink-0 text-sm font-bold text-text-primary">
        {score}
        <span className="ml-0.5 text-xs font-normal text-text-tertiary">{unit}</span>
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
            {tab === "monthly"
              ? "이 달엔 아직 집계된 점수가 없어요"
              : tab === "cumulative"
                ? "아직 집계된 점수가 없어요"
                : "아직 반영된 친구 초대가 없어요"}
          </p>
          <p className="mt-0.5 text-xs text-text-tertiary">
            {tab === "invite"
              ? "친구가 팀 선택과 첫 글 또는 댓글 작성을 완료하면 반영돼요"
              : "채팅 · 댓글 · 글 · 사진으로 점수를 쌓아보세요"}
          </p>
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
