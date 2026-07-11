"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { ChevronRight } from "lucide-react";
import { getTeamById, ALLSTAR_NANUM_ID, ALLSTAR_DREAM_ID } from "@/lib/constants/teams";
import { getKSTToday } from "@/lib/utils/date-kst";

/** 노출 시작: 경기 시작 2시간 전 (하린아빠 2026-07-11). */
const SHOW_BEFORE_MS = 2 * 60 * 60 * 1000;

interface AllStarGameBannerProps {
  game: { id: string; time: string; status: "scheduled" | "live" | "final" | "cancelled" };
}

/**
 * 홈 팀카드 위 올스타전 크관 연결 배너.
 * 경기 시작 2시간 전부터 당일 내내 노출(취소 시 숨김). scheduled여도 시간 파싱
 * 실패 시엔 숨기되, live/final은 시간과 무관하게 노출(벨트앤브레이스).
 */
export default function AllStarGameBanner({ game }: AllStarGameBannerProps) {
  // 분 단위 tick — 16:00 이전부터 홈을 열어둔 유저에게도 시각 도달 시 배너가 뜨게.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  if (game.status === "cancelled") return null;

  const withinWindow = (() => {
    if (game.status === "live" || game.status === "final") return true;
    const m = game.time?.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return false;
    const startMs = Date.parse(`${getKSTToday()}T${m[1].padStart(2, "0")}:${m[2]}:00+09:00`);
    if (!Number.isFinite(startMs)) return false;
    return now >= startMs - SHOW_BEFORE_MS;
  })();
  if (!withinWindow) return null;

  const nanum = getTeamById(ALLSTAR_NANUM_ID)!;
  const dream = getTeamById(ALLSTAR_DREAM_ID)!;
  const subtitle =
    game.status === "live"
      ? "LIVE — 크관에서 실시간 중계 보기"
      : game.status === "final"
        ? "경기 종료 — 크관에서 기록 보기"
        : `오늘 ${game.time} — 크관에서 함께 보기`;

  return (
    <Link
      href={`/games/${game.id}`}
      className="p-4 rounded-2xl flex items-center gap-3 transition-colors"
      style={{
        background: `linear-gradient(90deg, ${nanum.colorPrimary}26, ${dream.colorPrimary}26)`,
        border: `1px solid ${dream.colorLight}33`,
      }}
    >
      <div className="flex items-center shrink-0">
        <Image src={nanum.logoPath} alt={nanum.shortName} width={28} height={28} unoptimized className="object-contain" />
        <Image src={dream.logoPath} alt={dream.shortName} width={28} height={28} unoptimized className="object-contain -ml-1.5" />
      </div>
      <div className="flex-1 min-w-0 text-left">
        <p className="text-[15px] leading-[22px] font-semibold text-text-primary">
          ⭐ 올스타전 {nanum.shortName} vs {dream.shortName}
        </p>
        <p className="text-xs leading-[18px] text-text-tertiary mt-0.5 truncate">{subtitle}</p>
      </div>
      {game.status === "live" && (
        <span className="shrink-0 px-2 py-0.5 rounded-full text-[11px] font-bold text-white bg-red-500">LIVE</span>
      )}
      <ChevronRight size={18} className="shrink-0 text-text-tertiary" />
    </Link>
  );
}
