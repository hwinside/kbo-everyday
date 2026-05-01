"use client";

import { motion } from "framer-motion";
import TeamLogo from "@/components/ui/TeamLogo";
import { getTeamBgColor, type TeamData } from "@/lib/constants/teams";

interface TeamHeroProps {
  team: TeamData;
  standings?: { rank: number; wins: number; losses: number; draws: number; winRate: string; streak: string; gb: string };
  stadiumName?: string;
}

export default function TeamHero({ team, standings, stadiumName }: TeamHeroProps) {
  const teamColor = getTeamBgColor(team);

  return (
    <div className="relative overflow-hidden" style={{ background: `linear-gradient(180deg, ${teamColor}40 0%, ${teamColor}10 60%, transparent 100%)` }}>
      {/* Watermark logo */}
      <div className="absolute -right-8 -top-8 opacity-[0.07]">
        <TeamLogo team={team} size={200} />
      </div>

      <div className="relative px-5 pt-5 pb-4">
        <div className="flex items-center gap-3 mb-4">
          <TeamLogo team={team} size={56} />
          <div>
            <h1 className="text-xl font-bold text-text-primary">{team.name}</h1>
            {stadiumName && <p className="text-sm text-text-tertiary">{stadiumName}</p>}
          </div>
        </div>

        {/* Standings card */}
        {standings && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="grid grid-cols-4 gap-2 rounded-2xl bg-bg-glass/60 backdrop-blur-sm p-4"
          >
            {[
              { label: "순위", value: `${standings.rank}위` },
              { label: "승률", value: standings.winRate },
              { label: "승차", value: standings.gb },
              { label: "연속", value: standings.streak },
            ].map((item) => {
              let valueColor = "text-text-primary";
              if (item.label === "연속" && item.value.includes("승")) valueColor = "text-green-400";
              else if (item.label === "연속" && item.value.includes("패")) valueColor = "text-red-400";
              return (
                <div key={item.label} className="text-center">
                  <p className="text-xs text-text-tertiary mb-0.5">{item.label}</p>
                  <p className={`text-base font-bold ${valueColor}`}>{item.value}</p>
                </div>
              );
            })}
          </motion.div>
        )}
      </div>
    </div>
  );
}
