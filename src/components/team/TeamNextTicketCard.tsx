"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { getTeamBgColor, type TeamData } from "@/lib/constants/teams";
import { getNextTicketOpen, formatCountdown, formatOpenAt, formatGameDateTime, type NextTicketOpen } from "@/lib/utils/ticket-utils";

interface Props {
  team: TeamData;
}

export default function TeamNextTicketCard({ team }: Props) {
  const [ticketInfo, setTicketInfo] = useState<NextTicketOpen | null>(null);
  const [countdown, setCountdown] = useState("");
  // 오픈 1시간 이내 임박 여부 — tick에서 실시간 잔여로 갱신 (렌더 중 Date.now 호출 회피)
  const [near, setNear] = useState(false);

  useEffect(() => {
    let aborted = false;

    async function fetchUpcomingGames() {
      const now = new Date();

      // 35일 윈도우가 걸치는 달(YYYY-MM)만 모음 — 보통 1~2개(월 경계 최대 3개).
      // 예전엔 일자별 /api/games를 35회 *순차* await 해서 카드가 몇 초 늦게 떴음.
      // 대신 team-schedule(달 단위·캐시 s-maxage=300)로 1~2회만 호출 → 카드 즉시 노출.
      const monthKeys = new Set<string>();
      for (let i = 0; i < 35; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() + i);
        monthKeys.add(
          d.toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 7)
        );
      }

      type SchedDay = {
        date: string;
        time?: string;
        home: boolean;
        status: string;
        opponent?: { id: number; shortName: string };
      };

      // 달 단위 호출을 *병렬*로 — 35회 순차 → 1~2회 병렬(캐시 히트 시 즉시).
      const monthResults = await Promise.all(
        [...monthKeys].map(async (mk) => {
          try {
            const res = await fetch(`/api/team-schedule?team=${team.slug}&month=${mk}`);
            if (!res.ok) return [] as SchedDay[];
            const data = await res.json();
            return (Array.isArray(data.days) ? data.days : []) as SchedDay[];
          } catch {
            return [] as SchedDay[];
          }
        })
      );

      if (aborted) return;

      // 날짜별 그룹 → 우천취소/종료 제외(일정 변경은 다음 유효 경기로 자동 스킵),
      // 같은 날 2건↑이면 더블헤더/변경 경기(uncertain) 표기.
      const byDate = new Map<string, SchedDay[]>();
      for (const g of monthResults.flat()) {
        if (g.status === "cancelled" || g.status === "final") continue;
        const arr = byDate.get(g.date) ?? [];
        arr.push(g);
        byDate.set(g.date, arr);
      }

      // 홈+원정 통틀어 가장 먼저 오픈되는 경기는 getNextTicketOpen이 선택(daysBefore 구단별 상이 안전).
      const upcoming = [...byDate.values()].map((games) => {
        const g = games[0];
        return {
          date: g.date,
          time: g.time ?? "",
          // 예매룰은 주최(홈)팀 기준 — 원정이면 상대(홈)팀 id로 정책 조회.
          homeTeamId: g.home ? team.id : (g.opponent?.id ?? 0),
          opponentName: g.opponent?.shortName ?? "",
          isAway: !g.home,
          uncertain: games.length >= 2,
        };
      });

      // 최신 일정으로 재계산 → 오픈 지난 경기는 다음 fetch에서 다음 대기 경기로 자동 보정
      setTicketInfo(getNextTicketOpen(upcoming));
    }

    fetchUpcomingGames();

    // 카드를 열어둔 사이 우천 연기/더블헤더 추가/취소 등 일정 변경 반영:
    // 가시 상태일 때만 주기 재조회 + 앱/탭 복귀(visibilitychange) 시 재조회
    const REFRESH_MS = 10 * 60 * 1000;
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") fetchUpcomingGames();
    }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") fetchUpcomingGames();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      aborted = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [team.id, team.slug]);

  useEffect(() => {
    if (!ticketInfo || ticketInfo.status !== "countdown") return;

    let timer: ReturnType<typeof setTimeout>;
    function tick() {
      const ms = ticketInfo!.openAt.getTime() - Date.now();
      setCountdown(formatCountdown(ms));
      setNear(ms > 0 && ms < 60 * 60 * 1000);
      // 오픈 시각 지나면 카운트다운 종료('오픈!') — 다음 주기 fetch가 다음 오픈 대기 경기로 자동 갱신
      if (ms <= 0) return;
      // 매 틱마다 남은 시간 기준으로 다음 간격 재계산 → 페이지 열어둔 채 임박(1시간 이내) 구간 진입해도 1초 카운트다운/LIVE로 전환됨
      timer = setTimeout(tick, ms < 60 * 60 * 1000 ? 1000 : 60_000);
    }

    tick();
    return () => clearTimeout(timer);
  }, [ticketInfo]);

  if (!ticketInfo) return null;

  const gameLabel = formatGameDateTime(ticketInfo.gameDate, ticketInfo.gameTime);
  const openLabel = formatOpenAt(ticketInfo.openAt);

  const isNear = ticketInfo.status === "countdown" && near && !ticketInfo.uncertain;
  const bgColor = getTeamBgColor(team);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="mx-5 mb-4 rounded-2xl p-4 flex items-center gap-3"
      style={{
        backgroundColor: `${bgColor}12`,
        border: `1px solid ${bgColor}28`,
      }}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <p className="text-xs text-text-tertiary">다음 예매 오픈</p>
          {isNear && (
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
            </span>
          )}
        </div>
        {ticketInfo.uncertain ? (
          // 더블헤더/일정 변경 경기 — 표준 룰로 확정 표기 금지, 예매처에서 별도 확인 유도
          <p className="text-sm font-bold text-yellow-400">변경 경기 · 예매 일정 별도 확인</p>
        ) : (
          <p className="text-sm font-bold text-text-primary">{countdown}</p>
        )}
        {!ticketInfo.uncertain && (
          <p className="text-xs font-semibold text-text-primary mt-0.5">{openLabel} 예매 오픈</p>
        )}
        <p className="text-xs text-text-secondary mt-0.5">
          {gameLabel}
          {ticketInfo.isAway
            ? `${ticketInfo.opponentName ? ` ${ticketInfo.opponentName}` : ""} 원정경기`
            : `${ticketInfo.opponentName ? ` vs ${ticketInfo.opponentName}` : ""} 홈경기`}
          {" · "}{ticketInfo.provider}
        </p>
        {!ticketInfo.uncertain && (
          <p className="text-[10px] leading-[13px] text-text-tertiary mt-1">
            * 안내된 예매 오픈 시간은 정확하지 않을 수 있어요. 정확한 시간은 예매처에서 확인해주세요.
          </p>
        )}
      </div>
      <a
        href={ticketInfo.buyUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex-shrink-0 px-4 py-2 rounded-xl text-xs font-bold text-white"
        style={{ backgroundColor: bgColor }}
      >
        예매처로 가기
      </a>
    </motion.div>
  );
}
