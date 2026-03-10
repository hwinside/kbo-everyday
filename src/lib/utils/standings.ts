import { TEAMS } from "@/lib/constants/teams";

export function getTeam(id: number) {
  return TEAMS.find((t) => t.id === id)!;
}

export function getTeamColor(id: number) {
  return TEAMS.find((t) => t.id === id)?.colorLight ?? "#999";
}

export function getStreakIcon(streak: string) {
  const num = parseInt(streak);
  if (streak.includes("연승") && num >= 3) return "🔥";
  if (streak.includes("연패") && num >= 3) return "❄️";
  return "";
}

export function hexToRgba(hex: string, alpha: number): string {
  const c = hex.replace("#", "");
  const full = c.length === 3 ? c.split("").map((ch) => ch + ch).join("") : c;
  return `rgba(${parseInt(full.slice(0, 2), 16)}, ${parseInt(full.slice(2, 4), 16)}, ${parseInt(full.slice(4, 6), 16)}, ${alpha})`;
}
