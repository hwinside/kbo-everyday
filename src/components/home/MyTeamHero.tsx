import Link from "next/link";
import Image from "next/image";
import { getTeamBgColor } from "@/lib/constants/teams";
import { getTeamShortName, getTeamColor, getTeamLogo } from "@/lib/utils/team";
import type { TeamData } from "@/lib/constants/teams";

interface HomeGame {
  id: string;
  homeTeamId: number;
  awayTeamId: number;
  time: string;
  stadium: string;
  homeScore: number;
  awayScore: number;
  status: "scheduled" | "live" | "final";
  inning: string | null;
}

export default function MyTeamHero({ myTeam, myTeamGame }: { myTeam: TeamData; myTeamGame: HomeGame }) {
  return (
    <div className="mb-3">
      <Link href={`/games/${myTeamGame.id}`}>
        <div
          className="relative rounded-2xl p-5 overflow-hidden border border-white/10 bg-bg-secondary"
          style={{ background: `linear-gradient(135deg, ${getTeamBgColor(myTeam)}50 0%, #1a1a1d 100%)` }}
        >
          {/* Team logo watermark */}
          <div className="absolute right-3 top-3 opacity-15">
            <Image src={myTeam.logoPath} alt="" width={72} height={72} unoptimized className="object-contain" />
          </div>

          <div className="flex items-center gap-2 mb-3">
            <div className="w-7 h-7 rounded-full bg-white p-0.5 flex items-center justify-center">
              <Image src={myTeam.logoPath} alt="" width={20} height={20} unoptimized className="object-contain" />
            </div>
            <span className="text-xs leading-[18px] font-semibold tracking-wide" style={{ color: myTeam.colorLight }}>MY TEAM</span>
          </div>

          {/* Score */}
          <div className="flex items-center justify-between">
            <div className="flex flex-col items-center gap-1">
              <div className="w-12 h-12 rounded-full bg-white p-1 flex items-center justify-center">
                <Image src={getTeamLogo(myTeamGame.awayTeamId)} alt="" width={32} height={32} unoptimized className="object-contain" />
              </div>
              <span className="text-sm font-bold" style={{ color: getTeamColor(myTeamGame.awayTeamId) }}>{getTeamShortName(myTeamGame.awayTeamId)}</span>
            </div>
            <div className="text-center">
              <div className="flex items-center gap-3">
                <span className="text-2xl font-black tabular-nums text-text-primary">{myTeamGame.status === "scheduled" ? "-" : myTeamGame.awayScore}</span>
                <span className="text-sm text-text-tertiary">:</span>
                <span className="text-2xl font-black tabular-nums text-text-primary">{myTeamGame.status === "scheduled" ? "-" : myTeamGame.homeScore}</span>
              </div>
              <span className={`text-xs font-semibold mt-1 px-2 py-0.5 rounded-full ${
                myTeamGame.status === "live" ? "bg-red-500/20 text-red-400 animate-pulse" :
                myTeamGame.status === "final" ? "bg-text-tertiary/20 text-text-tertiary" :
                "bg-accent/20 text-accent"
              }`}>
                {myTeamGame.status === "live" ? `LIVE ${myTeamGame.inning}` : myTeamGame.status === "final" ? "경기 종료" : myTeamGame.time}
              </span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <div className="w-12 h-12 rounded-full bg-white p-1 flex items-center justify-center">
                <Image src={getTeamLogo(myTeamGame.homeTeamId)} alt="" width={32} height={32} unoptimized className="object-contain" />
              </div>
              <span className="text-sm font-bold" style={{ color: getTeamColor(myTeamGame.homeTeamId) }}>{getTeamShortName(myTeamGame.homeTeamId)}</span>
            </div>
          </div>
        </div>
      </Link>
    </div>
  );
}
