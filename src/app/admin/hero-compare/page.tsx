"use client";

import { useMemo, useState } from "react";

import { TEAMS } from "@/lib/constants/teams";
import heroApprovedList from "@/lib/constants/hero-approved-kboids.json";
import rosterData from "@/lib/constants/players-roster.json";

interface RosterEntry {
  name: string;
  kboId: string;
  teamId: number;
  position: string;
  backNo: string;
  team: string;
}

interface CompareRow {
  kboId: string;
  name: string;
  teamId: number;
  team: string;
  position: string;
  backNo: string;
}

const rosterByKboId = new Map(
  (rosterData as RosterEntry[]).map((r) => [r.kboId, r])
);

// 현재 사이트에 "적용 중"인 히어로 = 검수 통과(allowlist) 선수 전체.
// 각 행: KBO 공식 헤드샷(/players/{kboId}.jpg, naverncp middle = 가용 최대) vs 현재 AI 히어로(/players-hero/{kboId}.webp)
const ROWS: CompareRow[] = (heroApprovedList as string[])
  .map((kboId) => {
    const r = rosterByKboId.get(kboId);
    return {
      kboId,
      name: r?.name ?? kboId,
      teamId: r?.teamId ?? 0,
      team: r?.team ?? "기타",
      position: r?.position ?? "",
      backNo: r?.backNo ?? "",
    };
  })
  .sort((a, b) => (a.teamId - b.teamId) || a.name.localeCompare(b.name, "ko"));

function CompareCard({ row }: { row: CompareRow }) {
  const [officialOk, setOfficialOk] = useState(true);
  const [heroOk, setHeroOk] = useState(true);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <span className="font-semibold text-white truncate">{row.name}</span>
        <span className="text-xs text-[#8E8E93] shrink-0">
          {row.team}{row.backNo ? ` · #${row.backNo}` : ""}{row.position ? ` · ${row.position}` : ""}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <figure className="m-0">
          <div className="aspect-[3/4] rounded-xl overflow-hidden bg-black/30 flex items-center justify-center">
            {officialOk ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/players/${row.kboId}.jpg`}
                alt={`${row.name} KBO 공식`}
                loading="lazy"
                className="w-full h-full object-cover"
                onError={() => setOfficialOk(false)}
              />
            ) : (
              <span className="text-[11px] text-[#636366]">공식샷 없음</span>
            )}
          </div>
          <figcaption className="mt-1 text-center text-[11px] text-[#8E8E93]">KBO 공식</figcaption>
        </figure>
        <figure className="m-0">
          <div className="aspect-[3/4] rounded-xl overflow-hidden bg-black/30 flex items-center justify-center">
            {heroOk ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/players-hero/${row.kboId}.webp`}
                alt={`${row.name} 현재 히어로`}
                loading="lazy"
                className="w-full h-full object-cover"
                onError={() => setHeroOk(false)}
              />
            ) : (
              <span className="text-[11px] text-[#636366]">히어로 없음</span>
            )}
          </div>
          <figcaption className="mt-1 text-center text-[11px] text-[#6366F1]">현재 히어로(AI)</figcaption>
        </figure>
      </div>
    </div>
  );
}

export default function HeroComparePage() {
  const [teamId, setTeamId] = useState<number | "all">("all");

  const filtered = useMemo(
    () => (teamId === "all" ? ROWS : ROWS.filter((r) => r.teamId === teamId)),
    [teamId]
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-white">히어로샷 비교</h1>
        <p className="text-sm text-[#8E8E93] mt-1">
          선수별 KBO 공식 헤드샷(가용 최대 사이즈) vs 현재 적용 중인 AI 히어로샷. 검수 통과(노출 중) {ROWS.length}명.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setTeamId("all")}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            teamId === "all" ? "bg-[#6366F1] text-white" : "bg-white/5 text-[#8E8E93] hover:text-white"
          }`}
        >
          전체 {ROWS.length}
        </button>
        {TEAMS.map((t) => {
          const count = ROWS.filter((r) => r.teamId === t.id).length;
          return (
            <button
              key={t.id}
              onClick={() => setTeamId(t.id)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                teamId === t.id ? "bg-[#6366F1] text-white" : "bg-white/5 text-[#8E8E93] hover:text-white"
              }`}
            >
              {t.shortName} {count}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
        {filtered.map((row) => (
          <CompareCard key={row.kboId} row={row} />
        ))}
      </div>
    </div>
  );
}
