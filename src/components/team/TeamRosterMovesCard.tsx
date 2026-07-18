"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { getTeamBgColor, type TeamData } from "@/lib/constants/teams";

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

/** "2026-07-18" → "7.18" */
function shortDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${Number(m)}.${Number(d)}`;
}

export default function TeamRosterMovesCard({ team }: Props) {
  const [moves, setMoves] = useState<Move[] | null>(null);

  useEffect(() => {
    let aborted = false;
    fetch(`/api/roster-moves?teamId=${team.id}&days=30`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!aborted) setMoves(Array.isArray(d?.moves) ? d.moves : []);
      })
      .catch(() => {
        if (!aborted) setMoves([]);
      });
    return () => {
      aborted = true;
    };
  }, [team.id]);

  // 내역 없으면(또는 로딩/실패) 카드 자체를 숨긴다 — 빈 카드 노출 금지.
  if (!moves || moves.length === 0) return null;

  const bgColor = getTeamBgColor(team);

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
      <ul className="flex flex-col gap-2">
        {moves.map((m, i) => {
          const isRegister = m.moveType === "register";
          const label = isRegister ? "등록" : "말소";
          const labelColor = isRegister ? "#34D399" : "#F87171";
          const body = (
            <div className="flex items-center gap-2 py-0.5">
              <span
                className="flex-shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold"
                style={{ color: labelColor, backgroundColor: `${labelColor}1f` }}
              >
                {label}
              </span>
              <span className="flex-1 min-w-0 truncate text-sm font-semibold text-text-primary">
                {m.playerName}
              </span>
              <span className="flex-shrink-0 text-xs text-text-tertiary">
                {shortDate(m.moveDate)}
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
    </motion.div>
  );
}
