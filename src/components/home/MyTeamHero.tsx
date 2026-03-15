import Link from "next/link";
import Image from "next/image";
import { getTeamBgColor } from "@/lib/constants/teams";
import { getTeamShortName, getTeamLogo } from "@/lib/utils/team";
import { getTeamById } from "@/lib/constants/teams";
import Diamond from "@/components/game/Diamond";
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
  balls: number;
  strikes: number;
  outs: number;
  runner1b: boolean;
  runner2b: boolean;
  runner3b: boolean;
  currentBatter: string | null;
  currentPitcher: string | null;
  isTop: boolean;
}

export default function MyTeamHero({ myTeam, myTeamGame }: { myTeam: TeamData; myTeamGame: HomeGame }) {
  return (
    <div className="mb-3">
      <Link href={`/games/${myTeamGame.id}`}>
        <div
          className="relative rounded-2xl p-5 overflow-hidden border border-white/10 myteam-card"
          style={{ ['--team-bg' as string]: getTeamBgColor(myTeam) }}
        >
          {/* Team logo watermark */}
          <div className="absolute right-3 top-3 opacity-15">
            <Image src={myTeam.logoPath} alt="" width={72} height={72} unoptimized className="object-contain" />
          </div>

          <div className="flex items-center gap-2 mb-3">
            <div className="w-7 h-7 rounded-full bg-white p-0.5 flex items-center justify-center">
              <Image src={myTeam.logoPath} alt="" width={20} height={20} unoptimized className="object-contain" />
            </div>
            <span className="text-xs leading-[18px] font-semibold tracking-wide text-accent">MY TEAM</span>
          </div>

          {/* Score */}
          <div className="flex items-center justify-between">
            <div className="flex flex-col items-center gap-1">
              <div className="w-12 h-12 rounded-full bg-white p-1 flex items-center justify-center">
                <Image src={getTeamLogo(myTeamGame.awayTeamId)} alt="" width={32} height={32} unoptimized className="object-contain" />
              </div>
              <span className="text-sm font-bold" style={{ color: getTeamById(myTeamGame.awayTeamId)?.colorLight ?? '#fff' }}>{getTeamShortName(myTeamGame.awayTeamId)}</span>
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
              <span className="text-sm font-bold" style={{ color: getTeamById(myTeamGame.homeTeamId)?.colorLight ?? '#fff' }}>{getTeamShortName(myTeamGame.homeTeamId)}</span>
            </div>
          </div>

          {/* Live details: BSO + Diamond + Pitcher/Batter */}
          {myTeamGame.status === "live" && (
            <div className="mt-3 pt-3 border-t border-white/10">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 text-[11px] font-mono">
                  <span>B <span className="text-green-400">{"●".repeat(myTeamGame.balls)}{"○".repeat(4 - myTeamGame.balls)}</span></span>
                  <span>S <span className="text-yellow-400">{"●".repeat(myTeamGame.strikes)}{"○".repeat(3 - myTeamGame.strikes)}</span></span>
                  <span>O <span className="text-red-400">{"●".repeat(myTeamGame.outs)}{"○".repeat(3 - myTeamGame.outs)}</span></span>
                </div>
                <Diamond
                  runner1b={myTeamGame.runner1b}
                  runner2b={myTeamGame.runner2b}
                  runner3b={myTeamGame.runner3b}
                  teamColor={myTeamGame.isTop ? (getTeamById(myTeamGame.awayTeamId)?.colorLight ?? '#fff') : (getTeamById(myTeamGame.homeTeamId)?.colorLight ?? '#fff')}
                />
              </div>
              {(myTeamGame.currentPitcher || myTeamGame.currentBatter) && (
                <div className="mt-2 text-xs text-text-tertiary truncate">
                  {myTeamGame.currentPitcher && <span>P {myTeamGame.currentPitcher}</span>}
                  {myTeamGame.currentBatter && <span className="ml-3">AB {myTeamGame.currentBatter}</span>}
                </div>
              )}
            </div>
          )}
        </div>
      </Link>
    </div>
  );
}
