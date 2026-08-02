"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X, ChevronLeft, Search, Loader2, Lock, RefreshCw, ImagePlus } from "lucide-react";
import { TEAMS, getTeamById } from "@/lib/constants/teams";
import {
  diaryAddSelectDisabled,
  diaryPickCaption,
  diaryPickState,
} from "@/lib/venue-diary/view";
import type { DiaryUploadGame } from "@/components/my/VenueDiaryUploader";

const DIARY_SEASON = 2026;

interface ScheduleDay {
  date: string; // YYYYMMDD
  gameId: string;
  opponent: { id: number; slug: string; shortName: string; name: string };
  home: boolean;
  status: "scheduled" | "live" | "final" | "cancelled";
  result: "W" | "L" | "D" | null;
  score: { for: number | null; against: number | null };
  stadium: string;
}

interface Props {
  isOpen: boolean;
  favoriteTeamId: number | null;
  /** gameId → 이미 올린 미디어 개수(N/10 오버레이). */
  countsByGame: Map<string, number>;
  /** 2026 counts 확정 여부. false 면 선택 fail-closed(로딩/오류). */
  countsReady: boolean;
  /** counts fetch 실패 여부(0 폴백 금지 → 재시도 노출). */
  countsError: boolean;
  activeAttendanceGameIds: Set<string>;
  /** true 면 '경기 변경' 모드 — 기존 기록을 고른 경기로 옮긴다(새 기록 생성 아님). */
  moveMode?: boolean;
  /** 변경 모드에서 지금 옮기는 기록의 원래 경기(자기 자신은 대상에서 제외). */
  moveFromGameId?: string | null;
  onRetryCounts: () => void;
  onBack: () => void;
  onClose: () => void;
  onPick: (game: DiaryUploadGame) => void;
  onRecord: (game: DiaryUploadGame, favoriteTeamId: number) => void;
}

/** 2026 시즌 월(3~11월). */
const SEASON_MONTHS = [3, 4, 5, 6, 7, 8, 9, 10, 11];

function currentKstMonth(): number {
  return Number(
    new Intl.DateTimeFormat("en", { timeZone: "Asia/Seoul", month: "numeric" }).format(new Date()),
  );
}

function formatDateLabel(yyyymmdd: string, stadium: string): string {
  const y = yyyymmdd.slice(0, 4);
  const m = yyyymmdd.slice(4, 6);
  const d = yyyymmdd.slice(6, 8);
  const weekday = new Intl.DateTimeFormat("ko-KR", {
    weekday: "short",
    timeZone: "Asia/Seoul",
  }).format(new Date(`${y}-${m}-${d}T12:00:00+09:00`));
  return `${y}.${m}.${d} (${weekday}) · ${stadium}`;
}

export default function VenueDiaryAddGameSheet({
  isOpen,
  favoriteTeamId,
  countsByGame,
  countsReady,
  countsError,
  activeAttendanceGameIds,
  moveMode = false,
  moveFromGameId = null,
  onRetryCounts,
  onBack,
  onClose,
  onPick,
  onRecord,
}: Props) {
  const initialMonth = Math.min(Math.max(currentKstMonth(), 3), 11);
  const [teamId, setTeamId] = useState<number | null>(favoriteTeamId);
  const [month, setMonth] = useState<number>(initialMonth);
  const [query, setQuery] = useState("");
  const [days, setDays] = useState<ScheduleDay[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (isOpen) setTeamId(favoriteTeamId);
  }, [isOpen, favoriteTeamId]);

  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isOpen]);

  const team = teamId != null ? getTeamById(teamId) : undefined;

  useEffect(() => {
    if (!isOpen || !team) {
      setDays(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setFailed(false);
    const monthStr = `${DIARY_SEASON}-${String(month).padStart(2, "0")}`;
    (async () => {
      try {
        const res = await fetch(
          `/api/team-schedule?team=${encodeURIComponent(team.slug)}&month=${monthStr}`,
        );
        if (!res.ok) throw new Error("request failed");
        const data = (await res.json()) as { days?: ScheduleDay[] };
        if (alive) setDays(Array.isArray(data.days) ? data.days : []);
      } catch {
        if (alive) {
          setDays(null);
          setFailed(true);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [isOpen, team, month]);

  const finalGames = useMemo(() => {
    if (!days) return [];
    const q = query.trim().toLowerCase();
    return days
      .filter((d) => d.status === "final" && d.date.startsWith(String(DIARY_SEASON)))
      .filter((d) => {
        if (!q) return true;
        return (
          d.opponent.shortName.toLowerCase().includes(q) ||
          d.opponent.name.toLowerCase().includes(q) ||
          d.stadium.toLowerCase().includes(q)
        );
      });
  }, [days, query]);

  if (!isOpen || typeof document === "undefined") return null;

  // 우리팀을 맨 앞에 둔 팀 칩 순서
  const orderedTeams = [
    ...TEAMS.filter((t) => t.id === favoriteTeamId),
    ...TEAMS.filter((t) => t.id !== favoriteTeamId),
  ];

  const handlePick = (day: ScheduleDay) => {
    if (!team) return;
    const myShort = team.shortName;
    const matchLabel =
      day.score.for != null && day.score.against != null
        ? `${myShort} ${day.score.for} : ${day.score.against} ${day.opponent.shortName}`
        : `${myShort} vs ${day.opponent.shortName}`;
    onPick({
      gameId: day.gameId,
      dateLabel: formatDateLabel(day.date, day.stadium),
      matchLabel,
      result: day.result,
      existingCount: countsByGame.get(day.gameId) ?? 0,
    });
  };

  return createPortal(
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-[54] flex items-end"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        <div className="absolute inset-0 bg-black/60" onClick={onClose} />
        <motion.div
          className="relative w-full max-w-lg mx-auto bg-bg-secondary rounded-t-3xl max-h-[92dvh] overflow-hidden flex flex-col"
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={{ type: "spring", damping: 26 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <button onClick={onBack} aria-label="뒤로" className="text-text-tertiary">
              <ChevronLeft size={22} />
            </button>
            <span className="text-base font-semibold text-text-primary">
              {moveMode ? "경기 변경" : "지난 경기 추가"}
            </span>
            <button onClick={onClose} aria-label="닫기" className="text-text-tertiary">
              <X size={22} />
            </button>
          </div>

          <div className="px-4 pt-3 shrink-0">
            <p className="text-xs text-text-tertiary">
              {moveMode ? (
                <>
                  이 기록을 옮길 <b className="text-text-secondary">{DIARY_SEASON} 종료 경기</b>를 골라주세요
                </>
              ) : (
                <>
                  직관했던 <b className="text-text-secondary">{DIARY_SEASON} 종료 경기</b>를 기록하거나 사진·영상을 올려요
                </>
              )}
            </p>

            {/* 검색 */}
            <div className="mt-3 flex items-center gap-2 rounded-xl bg-bg-tertiary border border-border px-3 py-2.5">
              <Search size={15} className="text-text-tertiary shrink-0" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="상대팀 · 구장으로 찾기"
                className="flex-1 min-w-0 bg-transparent text-sm text-text-primary placeholder:text-text-tertiary outline-none"
              />
            </div>

            {/* 팀 칩 */}
            <div className="mt-2.5 flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1 no-scrollbar">
              {orderedTeams.map((t) => {
                const on = t.id === teamId;
                const isFav = t.id === favoriteTeamId;
                return (
                  <button
                    key={t.id}
                    onClick={() => setTeamId(t.id)}
                    className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-bold border ${
                      on
                        ? "bg-brand-primary border-brand-primary text-white"
                        : "bg-bg-tertiary border-border text-text-secondary"
                    }`}
                  >
                    {isFav ? `우리팀(${t.shortName})` : t.shortName}
                  </button>
                );
              })}
            </div>

            {/* 월 칩 */}
            <div className="mt-1.5 flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1 no-scrollbar">
              {SEASON_MONTHS.map((m) => {
                const on = m === month;
                return (
                  <button
                    key={m}
                    onClick={() => setMonth(m)}
                    className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-bold border ${
                      on
                        ? "bg-brand-primary border-brand-primary text-white"
                        : "bg-bg-tertiary border-border text-text-secondary"
                    }`}
                  >
                    {m}월
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 pt-3 pb-4 flex flex-col gap-2.5">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-10 text-text-tertiary">
                <Loader2 size={18} className="animate-spin" /> 경기를 불러오는 중…
              </div>
            ) : failed ? (
              <div className="py-10 text-center text-sm text-text-tertiary">
                경기를 불러오지 못했어요
              </div>
            ) : finalGames.length === 0 ? (
              <div className="py-10 text-center text-sm text-text-tertiary">
                이 달에 종료된 경기가 없어요
              </div>
            ) : (
              <>
                {/* fail-closed: 2026 counts 확정 전에는 올린 개수를 불러오는 중(선택 비활성), 실패하면
                    0 폴백 대신 재시도 버튼을 노출한다(Blocker 4). */}
                {!countsReady &&
                  (countsError ? (
                    <button
                      type="button"
                      onClick={onRetryCounts}
                      className="flex items-center justify-center gap-2 rounded-xl border border-border bg-bg-tertiary px-3 py-2.5 text-xs font-bold text-text-secondary"
                    >
                      <RefreshCw size={13} /> 올린 개수를 불러오지 못했어요 · 다시 시도
                    </button>
                  ) : (
                    <div className="flex items-center justify-center gap-2 rounded-xl border border-border bg-bg-tertiary px-3 py-2.5 text-xs font-bold text-text-tertiary">
                      <Loader2 size={13} className="animate-spin" /> 올린 개수 확인 중…
                    </div>
                  ))}
                {finalGames.map((day) => {
                const count = countsByGame.get(day.gameId) ?? 0;
                const pick = diaryPickState(count);
                const selectDisabled = diaryAddSelectDisabled(countsReady, count);
                const caption = diaryPickCaption(pick);
                const resultColor =
                  day.result === "W"
                    ? "text-blue-500"
                    : day.result === "L"
                      ? "text-accent"
                      : "text-text-tertiary";
                return (
                  <div
                    key={day.gameId}
                    className={`flex items-center justify-between rounded-2xl bg-bg-tertiary/60 border px-4 py-3 text-left ${
                      pick.kind === "add" ? "border-accent/40" : "border-border"
                    }`}
                  >
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-[11px] font-bold text-text-tertiary">
                        {formatDateLabel(day.date, day.stadium)}
                      </span>
                      <span className="text-sm font-bold text-text-primary truncate">
                        {day.score.for != null && day.score.against != null
                          ? `${getTeamById(teamId ?? 0)?.shortName ?? ""} ${day.score.for} : ${day.score.against} ${day.opponent.shortName}`
                          : `vs ${day.opponent.shortName}`}
                      </span>
                      <span className={`text-xs font-bold ${caption ? "text-text-tertiary" : resultColor}`}>
                        {caption ?? (day.result ? (day.result === "W" ? "승" : day.result === "L" ? "패" : "무") : "종료")}
                      </span>
                    </div>
                    <div className="ml-2 flex shrink-0 flex-col gap-1.5">
                      <button
                        type="button"
                        disabled={
                          moveMode
                            ? day.gameId === moveFromGameId ||
                              activeAttendanceGameIds.has(day.gameId)
                            : activeAttendanceGameIds.has(day.gameId)
                        }
                        onClick={() => teamId != null && onRecord({
                          gameId: day.gameId,
                          dateLabel: formatDateLabel(day.date, day.stadium),
                          matchLabel:
                            day.score.for != null && day.score.against != null
                              ? `${getTeamById(teamId)?.shortName ?? ""} ${day.score.for} : ${day.score.against} ${day.opponent.shortName}`
                              : `${getTeamById(teamId)?.shortName ?? ""} vs ${day.opponent.shortName}`,
                          result: day.result,
                          existingCount: count,
                        }, teamId)}
                        className="rounded-lg bg-brand-primary px-3 py-1.5 text-[11px] font-bold text-white disabled:bg-bg-secondary disabled:text-text-tertiary"
                      >
                        {moveMode
                          ? day.gameId === moveFromGameId
                            ? "현재 경기"
                            : activeAttendanceGameIds.has(day.gameId)
                              ? "기록됨"
                              : "이 경기로 변경"
                          : activeAttendanceGameIds.has(day.gameId)
                            ? "기록됨"
                            : "기록 추가"}
                      </button>
                      {!moveMode && (
                        <button
                          type="button"
                          onClick={() => !selectDisabled && handlePick(day)}
                          disabled={selectDisabled}
                          className="inline-flex items-center justify-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-[10.5px] font-bold text-text-secondary disabled:text-text-tertiary"
                        >
                          {pick.kind === "locked" ? <Lock size={10} /> : <ImagePlus size={10} />}
                          {!countsReady
                            ? countsError ? "확인 실패" : "확인 중"
                            : pick.kind === "locked"
                              ? `${pick.cap}/${pick.cap}`
                              : pick.kind === "add"
                                ? `${pick.count}/${pick.cap} 추가`
                                : "사진·영상"}
                        </button>
                      )}
                    </div>
                  </div>
                );
                })}
              </>
            )}

            <div className="mt-1 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-[11.5px] leading-relaxed text-amber-300">
              {moveMode ? (
                <>ℹ️ 경기를 바꿔도 <b>사진·영상은 원래 경기에 그대로</b> 남아요. 통계 기록만 옮겨집니다.</>
              ) : (
                <>ℹ️ 직접 추가 기록은 <b>전체 포함 승률·직관 통계</b>에 바로 반영돼요. GPS 인증 수·인증 배지는 별도로 유지됩니다.</>
              )}
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}
