"use client";

import { useRouter } from "next/navigation";
import TeamLogo from "@/components/ui/TeamLogo";
import { TEAMS, type TeamData } from "@/lib/constants/teams";

interface TeamSwitcherProps {
  currentTeam: TeamData;
}

export default function TeamSwitcher({ currentTeam }: TeamSwitcherProps) {
  const router = useRouter();

  return (
    <div className="flex gap-3 px-5 py-3 overflow-x-auto scrollbar-hide">
      {TEAMS.map((t) => (
        <button
          key={t.id}
          onClick={() => router.push(`/teams/${t.slug}`)}
          className={`flex-shrink-0 rounded-full p-1.5 transition-all ${
            t.id === currentTeam.id
              ? "ring-2 ring-offset-1 ring-offset-bg-primary bg-bg-tertiary"
              : "opacity-50 hover:opacity-80"
          }`}
          style={t.id === currentTeam.id ? { "--tw-ring-color": currentTeam.colorLight } as React.CSSProperties : undefined}
        >
          <TeamLogo team={t} size={32} />
        </button>
      ))}
    </div>
  );
}
