"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { getTeamBgColor, type TeamData } from "@/lib/constants/teams";
import { resultToneChipStyle } from "@/lib/ui/result-tone";

interface Move {
  kboPlayerId: string;
  playerName: string;
  moveType: "register" | "deregister";
  moveDate: string;
  href: string | null;
}

interface Props {
  team: TeamData;
}

/** "2026-07-18" → "7월 18일" (하린아빠 표시 스펙 2026-07-18: 1일 기준 날짜 헤더). */
function dateHeader(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${Number(m)}월 ${Number(d)}일`;
}

/** move_date 내림차순 유지한 채 날짜별 그룹핑. 같은 날짜 안에서는 등록 → 말소 순. */
function groupByDate(moves: Move[]): { date: string; items: Move[] }[] {
  const groups: { date: string; items: Move[] }[] = [];
  for (const m of moves) {
    const last = groups[groups.length - 1];
    if (last && last.date === m.moveDate) {
      last.items.push(m);
    } else {
      groups.push({ date: m.moveDate, items: [m] });
    }
  }
  for (const g of groups) {
    g.items.sort((a, b) =>
      a.moveType === b.moveType ? 0 : a.moveType === "register" ? -1 : 1,
    );
  }
  return groups;
}

/** 로딩 / 실패(비정상 응답·fetch reject) / 준비완료(정상 빈 포함)를 분리 표현.
 * 실패와 "정상 0건"을 구분 못 하던 문제(삼순 NO-GO) 방지 — 무효 상태를 표현 불가로 만든다. */
type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; moves: Move[] };

// 기본 노출 개수 — 처음엔 가장 최근 N개만 보여주고 '전체보기'로 시즌 전체를 펼친다
// (2026-07-19 하린아빠 스펙). 조회는 시즌 전체(365일)로 하되 접힘 상태에서 3개로 한정.
const PREVIEW_COUNT = 3;


export default function TeamRosterMovesCard({ team }: Props) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let aborted = false;
    fetch(`/api/roster-moves?teamId=${team.id}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        if (!aborted)
          setState({ status: "ready", moves: Array.isArray(d?.moves) ? d.moves : [] });
      })
      .catch(() => {
        if (!aborted) setState({ status: "error" });
      });
    return () => {
      aborted = true;
    };
  }, [team.id]);

  // 등록/말소 내역이 없어도 카드는 항상 노출한다 (2026-07-19 하린아빠 지시:
  // 유저가 궁금할 때 언제든 찾아볼 수 있는 고정 위치). 빈/로딩 상태는 안내 문구로 대체.
  const bgColor = getTeamBgColor(team);
  // 링크 없는 published 등록은 렌더 제외(삼순 P0 3차 불변식 유지 — href 없는 등록 미노출).
  // 말소는 링크 생략 허용(링크 없는 텍스트 렌더 OK).
  const renderable =
    state.status === "ready"
      ? state.moves.filter((m) => m.moveType !== "register" || Boolean(m.href))
      : [];
  // 접힘 상태 = 가장 최근 PREVIEW_COUNT개(move_date 내림차순)만, 전체보기 = 시즌 전체.
  const visible = expanded ? renderable : renderable.slice(0, PREVIEW_COUNT);
  const groups = groupByDate(visible);
  const hasMore = renderable.length > PREVIEW_COUNT;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="mx-5 mb-4 rounded-2xl p-4"
      style={{
        backgroundColor: `${bgColor}12`,
        border: `1px solid ${bgColor}28`,
      }}
    >
      <p className="text-xs text-text-tertiary mb-3">최근 등록·말소</p>
      {state.status === "loading" ? (
        <p className="text-xs text-text-tertiary">불러오는 중…</p>
      ) : state.status === "error" ? (
        <p className="text-xs text-text-tertiary">등록·말소 내역을 불러오지 못했어요.</p>
      ) : renderable.length === 0 ? (
        <p className="text-xs text-text-tertiary">등록·말소 내역이 없어요.</p>
      ) : (
        <div className="flex flex-col gap-3">
        {groups.map((g) => (
          <div key={g.date}>
            <p className="mb-1.5 text-[11px] font-semibold text-text-secondary">
              {dateHeader(g.date)}
            </p>
            <ul className="flex flex-col gap-2">
              {g.items.map((m, i) => {
                const isRegister = m.moveType === "register";
                const label = isRegister ? "등록" : "말소";
                // 긍부정 색·배경 모두 홈 팀카드 기준 SSOT(@/lib/ui/result-tone) — 화면마다 다시 적지 않는다.
                // ⚠️ 배경을 `${color}1f` 로 파생시키면 SSOT 배경값을 우회한다(삼순 3차 지적).
                const body = (
                  <div className="flex items-center gap-2 py-0.5">
                    <span
                      className="flex-shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold"
                      style={resultToneChipStyle(isRegister ? "positive" : "negative")}
                    >
                      {label}
                    </span>
                    <span className="flex-1 min-w-0 truncate text-sm font-semibold text-text-primary">
                      {m.playerName}
                    </span>
                  </div>
                );
                return (
                  <li key={`${m.moveType}-${m.kboPlayerId}-${m.moveDate}-${i}`}>
                    {m.href ? (
                      <Link href={m.href} className="block active:opacity-70">
                        {body}
                      </Link>
                    ) : (
                      body
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        {hasMore && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-0.5 self-start text-xs font-semibold active:opacity-70"
            style={{ color: bgColor }}
          >
            {expanded ? "접기" : `전체보기 (${renderable.length})`}
          </button>
        )}
        </div>
      )}
    </motion.div>
  );
}
