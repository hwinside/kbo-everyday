import heroApprovedList from "@/lib/constants/hero-approved-kboids.json";
import rosterData from "@/lib/constants/players-roster.json";
import { getPlayerPhotoByKboId } from "@/lib/constants/player-photos";
import { resolvePlayerIdentity } from "@/lib/utils/resolve-player";
import type { RosterPlayer } from "@/types/api";
import HeroShotReviewClient, { type HeroShotReviewPlayer } from "./HeroShotReviewClient";

const KBO_CDN_BASE = "https://6ptotvmi5753.edge.naverncp.com/KBO_IMAGE/person/middle/2026";

function getKboDetailHref(player: RosterPlayer, numericId: string): string {
  const path = player.position === "투수" ? "PitcherDetail" : "HitterDetail";
  return `https://www.koreabaseball.com/Record/Player/${path}/Basic.aspx?playerId=${numericId}`;
}

export default function AdminHeroShotsPage() {
  const approved = new Set(heroApprovedList as string[]);
  const players: HeroShotReviewPlayer[] = (rosterData as RosterPlayer[])
    .map((player) => {
      const resolved = resolvePlayerIdentity(player.kboId);
      const numericId = resolved?.numericId ?? player.kboId;
      const localOfficialSrc = getPlayerPhotoByKboId(player.kboId);
      const hasNumericOfficial = /^\d+$/.test(numericId);
      const officialSrc = hasNumericOfficial ? `${KBO_CDN_BASE}/${numericId}.jpg` : localOfficialSrc;
      return {
        kboId: player.kboId,
        numericId,
        name: player.name,
        team: player.team,
        teamId: Number(player.teamId),
        position: player.position,
        backNo: player.backNo,
        officialSrc,
        officialFallbackSrc: localOfficialSrc,
        heroSrc: approved.has(player.kboId) ? `/players-hero/${player.kboId}.webp` : null,
        profileHref: `/community/players/${player.kboId}`,
        kboHref: getKboDetailHref(player, numericId),
      };
    })
    .sort((a, b) => a.teamId - b.teamId || a.name.localeCompare(b.name, "ko"));

  return <HeroShotReviewClient players={players} />;
}
