"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import { ExternalLink, ImageOff, Search } from "lucide-react";
import { TEAMS } from "@/lib/constants/teams";

export interface HeroShotReviewPlayer {
  kboId: string;
  numericId: string;
  name: string;
  team: string;
  teamId: number;
  position: string;
  backNo: string;
  officialSrc: string | null;
  officialFallbackSrc: string | null;
  heroSrc: string | null;
  profileHref: string;
  kboHref: string;
}

interface ReviewImageProps {
  src: string | null;
  fallbackSrc?: string | null;
  alt: string;
  label: string;
  variant: "official" | "hero";
  teamColor?: string;
}

function ReviewImage({ src, fallbackSrc, alt, label, variant, teamColor }: ReviewImageProps) {
  const [failedPrimary, setFailedPrimary] = useState(false);
  const [failedFallback, setFailedFallback] = useState(false);
  const imageSrc =
    src && !failedPrimary
      ? src
      : fallbackSrc && !failedFallback
        ? fallbackSrc
        : null;

  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-[#C7C7CC]">{label}</p>
        {imageSrc && (
          <a
            href={imageSrc}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-[#8E8E93] hover:text-white"
          >
            원본 <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
      <div
        className={`relative flex h-[320px] items-center justify-center overflow-hidden rounded-lg border ${
          variant === "official" ? "border-[#D1D1D6] bg-white" : "border-white/10 bg-[#111113]"
        }`}
        style={
          variant === "hero"
            ? { background: `linear-gradient(155deg, ${teamColor ?? "#2A2A2E"} 0%, #111113 58%)` }
            : undefined
        }
      >
        {imageSrc ? (
          <Image
            src={imageSrc}
            alt={alt}
            fill
            sizes="(min-width: 1280px) 360px, (min-width: 768px) 50vw, 100vw"
            unoptimized
            className={`${variant === "official" ? "object-contain p-4" : "object-contain"}`}
            onError={() => {
              if (imageSrc === src) {
                setFailedPrimary(true);
              } else {
                setFailedFallback(true);
              }
            }}
          />
        ) : (
          <div className="flex flex-col items-center gap-2 text-[#8E8E93]">
            <ImageOff className="h-8 w-8" />
            <span className="text-xs">이미지 없음</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default function HeroShotReviewClient({ players }: { players: HeroShotReviewPlayer[] }) {
  const [query, setQuery] = useState("");
  const [teamId, setTeamId] = useState<number | "all">("all");
  const [mode, setMode] = useState<"hero" | "all" | "missingOfficial">("hero");

  const filteredPlayers = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return players.filter((player) => {
      if (teamId !== "all" && player.teamId !== teamId) return false;
      if (mode === "hero" && !player.heroSrc) return false;
      if (mode === "missingOfficial" && (player.officialSrc || player.officialFallbackSrc)) return false;
      if (!normalizedQuery) return true;
      const haystack = `${player.name} ${player.team} ${player.position} ${player.kboId} ${player.numericId}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [mode, players, query, teamId]);

  const heroCount = players.filter((player) => player.heroSrc).length;
  const missingOfficialCount = players.filter((player) => !player.officialSrc && !player.officialFallbackSrc).length;

  return (
    <div className="space-y-6 text-white">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <p className="text-sm font-medium text-[#8E8E93]">선수 이미지 검수</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">히어로샷 비교</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[#8E8E93]">
            KBO 공식 선수 사진과 현재 선수 페이지 히어로샷을 나란히 비교합니다.
            공식샷은 KBO CDN 2026 `middle` 원본을 우선 사용하고, 실패 시 현재 로컬 공식샷으로 대체합니다.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center sm:w-[420px]">
          <div className="rounded-lg border border-white/8 bg-white/[0.04] px-3 py-2">
            <p className="text-[11px] text-[#8E8E93]">전체 선수</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{players.length}</p>
          </div>
          <div className="rounded-lg border border-white/8 bg-white/[0.04] px-3 py-2">
            <p className="text-[11px] text-[#8E8E93]">히어로 적용</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{heroCount}</p>
          </div>
          <div className="rounded-lg border border-white/8 bg-white/[0.04] px-3 py-2">
            <p className="text-[11px] text-[#8E8E93]">공식샷 없음</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{missingOfficialCount}</p>
          </div>
        </div>
      </div>

      <div className="sticky top-0 z-30 -mx-4 border-y border-white/8 bg-[#0A0A0B]/95 px-4 py-3 backdrop-blur lg:top-0 lg:-mx-8 lg:px-8">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
          <label className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#636366]" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="선수명, 팀, 포지션, KBO ID 검색"
              className="h-11 w-full rounded-lg border border-white/10 bg-white/[0.04] pl-10 pr-3 text-sm outline-none transition-colors placeholder:text-[#636366] focus:border-[#6366F1]"
            />
          </label>
          <select
            value={teamId}
            onChange={(event) => setTeamId(event.target.value === "all" ? "all" : Number(event.target.value))}
            className="h-11 rounded-lg border border-white/10 bg-[#151518] px-3 text-sm outline-none focus:border-[#6366F1]"
          >
            <option value="all">전체 팀</option>
            {TEAMS.map((team) => (
              <option key={team.id} value={team.id}>{team.shortName}</option>
            ))}
          </select>
          <div className="grid grid-cols-3 rounded-lg border border-white/10 bg-white/[0.04] p-1 text-xs font-medium">
            {[
              ["hero", "히어로 적용"],
              ["all", "전체"],
              ["missingOfficial", "공식샷 없음"],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value as typeof mode)}
                className={`h-9 rounded-md px-3 transition-colors ${
                  mode === value ? "bg-[#6366F1] text-white" : "text-[#8E8E93] hover:text-white"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <p className="mt-2 text-xs text-[#636366]">
          표시 중: <span className="text-[#C7C7CC]">{filteredPlayers.length.toLocaleString()}</span>명
        </p>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        {filteredPlayers.map((player) => {
          const team = TEAMS.find((item) => item.id === player.teamId);
          return (
            <article key={player.kboId} className="rounded-xl border border-white/8 bg-[#151518] p-4">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-semibold">{player.name}</h2>
                    <span className="rounded-full px-2 py-0.5 text-xs font-semibold" style={{ backgroundColor: `${team?.colorPrimary ?? "#6366F1"}33`, color: team?.colorLight ?? "#C7C7CC" }}>
                      {player.team}
                    </span>
                    <span className="text-xs text-[#8E8E93]">#{player.backNo || "-"} · {player.position}</span>
                  </div>
                  <p className="mt-1 text-xs text-[#636366]">KBO ID {player.kboId} · 공식 ID {player.numericId}</p>
                </div>
                <div className="flex gap-2 text-xs">
                  <a
                    href={player.profileHref}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-8 items-center gap-1 rounded-md border border-white/10 px-2 text-[#C7C7CC] hover:bg-white/8"
                  >
                    선수 페이지 <ExternalLink className="h-3 w-3" />
                  </a>
                  <a
                    href={player.kboHref}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-8 items-center gap-1 rounded-md border border-white/10 px-2 text-[#C7C7CC] hover:bg-white/8"
                  >
                    KBO <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <ReviewImage
                  src={player.officialSrc}
                  fallbackSrc={player.officialFallbackSrc}
                  alt={`${player.name} KBO 공식샷`}
                  label="KBO 공식샷"
                  variant="official"
                />
                <ReviewImage
                  src={player.heroSrc}
                  alt={`${player.name} 현재 히어로샷`}
                  label="현재 히어로샷"
                  variant="hero"
                  teamColor={team?.colorPrimary}
                />
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
