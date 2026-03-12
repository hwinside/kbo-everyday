"use client";
import Link from "next/link";

import { clsx } from "clsx";
import { type TeamData } from "@/lib/constants/teams";
import type { GameLineup } from "@/lib/constants/games";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";

interface LineupTabProps {
  lineup: GameLineup;
  awayTeam: TeamData;
  homeTeam: TeamData;
}

function PitcherCard({
  name,
  era,
  teamColor,
  label,
}: {
  name: string;
  era: string;
  teamColor: string;
  label: string;
}) {
  return (
    <div className="text-center">
      <div className="text-base text-text-tertiary mb-1">{label}</div>
      <div
        className="inline-flex items-center gap-4 px-4 py-1.5 rounded-full text-white text-base font-semibold"
        style={{ backgroundColor: teamColor }}
      >
        <span>SP</span>
        <span>{name}</span>
      </div>
      <div className="text-base text-text-secondary mt-1 tabular-nums">
        ERA {era}
      </div>
    </div>
  );
}

export default function LineupTab({
  lineup,
  awayTeam,
  homeTeam,
}: LineupTabProps) {
  return (
    <div className="px-4 py-4 space-y-5 overflow-y-auto">
      {/* Starting pitchers */}
      <div className="flex items-start justify-around">
        <PitcherCard
          name={lineup.away.startingPitcher.name}
          era={lineup.away.startingPitcher.era}
          teamColor={awayTeam.colorPrimary}
          label={awayTeam.shortName}
        />
        <div className="text-text-tertiary text-base mt-4">VS</div>
        <PitcherCard
          name={lineup.home.startingPitcher.name}
          era={lineup.home.startingPitcher.era}
          teamColor={homeTeam.colorPrimary}
          label={homeTeam.shortName}
        />
      </div>

      {/* Lineup table */}
      <div className="glass-card p-5 overflow-hidden">
        <table className="w-full text-base">
          <thead>
            <tr className="text-text-tertiary border-b border-border">
              <th className="py-2 text-left font-medium w-6">#</th>
              <th className="py-2 text-left font-medium">
                <span style={{ color: awayTeam.colorLight }}>
                  {awayTeam.shortName}
                </span>
              </th>
              <th className="py-2 text-center font-medium w-8">타율</th>
              <th className="py-2 w-4" />
              <th className="py-2 text-center font-medium w-8">타율</th>
              <th className="py-2 text-right font-medium">
                <span style={{ color: homeTeam.colorLight }}>
                  {homeTeam.shortName}
                </span>
              </th>
              <th className="py-2 text-right font-medium w-6">#</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 9 }, (_, i) => {
              const away = lineup.away.batters[i];
              const home = lineup.home.batters[i];
              const awayHref = away.kboId
                ? `/community/players/${away.kboId}`
                : `/community/players/${away.name}`;
              const homeHref = home.kboId
                ? `/community/players/${home.kboId}`
                : `/community/players/${home.name}`;
              return (
                <tr
                  key={i}
                  className={clsx(
                    "border-b border-border/50",
                    i % 2 === 0 && "bg-bg-glass/30"
                  )}
                >
                  <td className="py-2 text-text-tertiary tabular-nums">
                    {away.order}
                  </td>
                  <td className="py-2">
                    <Link href={awayHref} className="flex items-center gap-1.5 hover:opacity-80">
                      <PlayerAvatar
                        name={away.name}
                        teamId={away.teamId}
                        photoUrl={getPlayerPhotoUrl(away.name, away.kboId)}
                        size={24}
                        showTeamBadge={false}
                      />
                      <span className="text-xs text-text-tertiary w-6 text-center shrink-0">
                        {away.position}
                      </span>
                      <span className="text-sm text-text-primary font-medium whitespace-nowrap">
                        {away.name}
                      </span>
                    </Link>
                  </td>
                  <td className="py-2 text-center text-xs text-text-secondary tabular-nums">
                    {away.avg}
                  </td>
                  <td className="py-2 text-center">
                    <div className="w-px h-4 bg-border mx-auto" />
                  </td>
                  <td className="py-2 text-center text-xs text-text-secondary tabular-nums">
                    {home.avg}
                  </td>
                  <td className="py-2 text-right">
                    <Link href={homeHref} className="flex items-center justify-end gap-1.5 hover:opacity-80">
                      <span className="text-sm text-text-primary font-medium whitespace-nowrap">
                        {home.name}
                      </span>
                      <span className="text-xs text-text-tertiary w-6 text-center shrink-0">
                        {home.position}
                      </span>
                      <PlayerAvatar
                        name={home.name}
                        teamId={home.teamId}
                        photoUrl={getPlayerPhotoUrl(home.name, home.kboId)}
                        size={24}
                        showTeamBadge={false}
                      />
                    </Link>
                  </td>
                  <td className="py-2 text-right text-text-tertiary tabular-nums">
                    {home.order}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
