"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { getTeamById, ALLSTAR_NANUM_ID, ALLSTAR_DREAM_ID } from "@/lib/constants/teams";
import { getTeamLogo, getTeamShortName } from "@/lib/utils/team";
import { getKSTToday } from "@/lib/utils/date-kst";

// 2026 올스타 리그 구성 (KBO 발표명단 기준). 팀명 아래 소속 구단 미니 로고로 노출 —
// 유저가 자기 팀이 어느 올스타팀인지 바로 인지(하린아빠 2026-07-11).
const NANUM_MEMBER_TEAM_IDS = [1, 6, 9, 5, 10]; // LG·KIA·한화·NC·키움
const DREAM_MEMBER_TEAM_IDS = [2, 8, 4, 3, 7]; // 두산·삼성·SSG·KT·롯데

interface AllStarGameCardProps {
  game: {
    id: string;
    time: string;
    stadium: string;
    status: "scheduled" | "live" | "final" | "cancelled";
    awayScore: number;
    homeScore: number;
  };
  live?: { awayScore: number; homeScore: number; currentInning: string; status?: "scheduled" | "live" | "final" | "cancelled"; isLive: boolean };
}

function MemberLogos({ teamIds }: { teamIds: number[] }) {
  return (
    <div className="flex gap-[3px] mt-px">
      {teamIds.map((id) => (
        <div key={id} className="w-4 h-4 rounded-full bg-white flex items-center justify-center">
          <Image src={getTeamLogo(id)} alt={getTeamShortName(id)} width={11} height={11} unoptimized className="object-contain" />
        </div>
      ))}
    </div>
  );
}

/**
 * 홈 팀카드 위 올스타전 크관 연결 경기카드 (목업 v2 승인, 2026-07-11).
 * 노출 = 배포 즉시 ~ 당일 자정(00시)까지 (하린아빠 13:11 — 종료 후에도 최종
 * 스코어로 유지, 00시 제거). cancelled만 숨김.
 */
export default function AllStarGameCard({ game, live }: AllStarGameCardProps) {
  // 00시 제거: gameId 앞 8자리(경기 날짜) ≠ KST 오늘이면 숨김. 새 페이지 로드는
  // todayGames 날짜 fetch로 자연 소멸하지만, 앱을 켜둔 채 자정을 넘긴 세션도
  // 분 단위 tick으로 커버.
  const [todayYmd, setTodayYmd] = useState(() => getKSTToday().replace(/-/g, ""));
  useEffect(() => {
    const t = window.setInterval(() => setTodayYmd(getKSTToday().replace(/-/g, "")), 60_000);
    return () => window.clearInterval(t);
  }, []);
  if (game.id.slice(0, 8) !== todayYmd) return null;

  // 라이브 폴링이 status를 앞서 알면 그걸 우선 (홈 myTeamGame과 동일 규칙).
  const effStatus = live?.status ?? (live?.isLive ? "live" : game.status);
  if (effStatus === "cancelled") return null;
  const isLive = effStatus === "live";
  const isFinal = effStatus === "final";

  const nanum = getTeamById(ALLSTAR_NANUM_ID)!;
  const dream = getTeamById(ALLSTAR_DREAM_ID)!;
  const awayScore = live?.awayScore ?? game.awayScore ?? 0;
  const homeScore = live?.homeScore ?? game.homeScore ?? 0;

  return (
    <Link prefetch={false}
      href={`/games/${game.id}`}
      className="relative block rounded-2xl p-3.5 overflow-hidden mb-3"
      style={{
        // 알파를 높게(90%/72%) — 라이트 테마에서도 카드가 자체 네이비 배경을 유지해
        // 흰 글자 대비가 깨지지 않게 (다크/라이트 공용, 목업 v2 톤 유지).
        background: `linear-gradient(100deg, ${nanum.colorPrimary}E6, ${dream.colorPrimary}B8)`,
        border: `1px solid ${dream.colorPrimary}59`,
      }}
    >
      <span aria-hidden className="absolute -right-1.5 -top-2 text-[64px] leading-none opacity-[0.07]">⭐</span>

      <div className="flex items-center justify-between mb-2.5">
        <span className="text-[12.5px] font-extrabold tracking-wide" style={{ color: dream.colorLight }}>
          ⭐ 2026 올스타전
        </span>
        <span className="text-[10.5px] text-white/55">🏟 {game.stadium}</span>
      </div>

      <div className="flex items-start justify-between">
        <div className="flex flex-col items-center gap-1.5 flex-1">
          <div className="w-[34px] h-[34px] rounded-full bg-white flex items-center justify-center">
            <Image src={nanum.logoPath} alt={nanum.shortName} width={22} height={22} unoptimized className="object-contain" />
          </div>
          <span className="text-[13.5px] font-bold text-white">{nanum.shortName}</span>
          <MemberLogos teamIds={NANUM_MEMBER_TEAM_IDS} />
        </div>

        <div className="flex flex-col items-center gap-1.5 flex-1 pt-1">
          {isLive || isFinal ? (
            <>
              <span className="text-[22px] font-extrabold tracking-[2px] text-white">
                {awayScore} : {homeScore}
              </span>
              {isLive ? (
                <span className="px-3.5 py-1 rounded-full bg-[#FF3B30] text-white text-[13px] font-extrabold tracking-wide">
                  LIVE {live?.currentInning ?? ""}
                </span>
              ) : (
                <span className="px-3.5 py-1 rounded-full bg-white/10 text-[13px] font-semibold text-white/80">
                  경기 종료
                </span>
              )}
            </>
          ) : (
            <>
              <span className="px-3.5 py-1 rounded-full bg-white/10 text-[13px] font-semibold text-white">
                오늘 {game.time}
              </span>
              <span className="text-[10.5px] text-white/55">경기 예정</span>
            </>
          )}
        </div>

        <div className="flex flex-col items-center gap-1.5 flex-1">
          <div className="w-[34px] h-[34px] rounded-full bg-white flex items-center justify-center">
            <Image src={dream.logoPath} alt={dream.shortName} width={22} height={22} unoptimized className="object-contain" />
          </div>
          <span className="text-[13.5px] font-bold text-white">{dream.shortName}</span>
          <MemberLogos teamIds={DREAM_MEMBER_TEAM_IDS} />
        </div>
      </div>

      <div className="mt-2.5 text-center text-xs font-semibold" style={{ color: dream.colorLight }}>
        {isLive ? "크관에서 실시간 중계 보기 ›" : isFinal ? "크관에서 결과·기록 보기 ›" : "크관에서 함께 보기 ›"}
      </div>
    </Link>
  );
}
