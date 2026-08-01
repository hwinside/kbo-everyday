import { NextResponse } from "next/server";
import playersRoster from "@/lib/constants/players-roster.json";

// specs/roster-ssot-fortress.md §3.2 — Prod 런타임 모니터
//
// /api/health/roster
//   - GET: static JSON SSOT의 선수 수 + 팀별 카운트 검증
//   - JSON shape/유일 ID/알려진 팀/팀당 최소 인원/canary를 검증
//   - Slack 알림은 외부 cron(heartbeat)에서 이 엔드포인트를 1시간마다 폴링해 처리
//     (daily heartbeat 체크리스트에 이미 포함: MEMORY.md §재발 방지 3중 안전망)

export const dynamic = "force-dynamic"; // no-cache

const MIN_PER_TEAM = 30;
const KNOWN_TEAMS = [
  "KIA", "두산", "롯데", "삼성", "SSG", "NC", "한화", "키움", "LG", "KT",
];

export async function GET() {
  const roster = playersRoster as Array<{
    team: string;
    kboId: string;
    backNo: string | null;
    name: string;
  }>;

  const total = roster.length;
  const byTeam: Record<string, number> = {};
  for (const p of roster) byTeam[p.team] = (byTeam[p.team] || 0) + 1;

  const issues: string[] = [];

  const ids = new Set<string>();
  for (const player of roster) {
    if (!player.kboId || !player.name || !KNOWN_TEAMS.includes(player.team)) {
      issues.push(`invalid roster row: ${player.kboId || "missing-id"}`);
    }
    if (ids.has(player.kboId)) issues.push(`duplicate kboId: ${player.kboId}`);
    ids.add(player.kboId);
  }

  for (const t of KNOWN_TEAMS) {
    const c = byTeam[t] || 0;
    if (c < MIN_PER_TEAM) {
      issues.push(`team ${t} has only ${c} players (min ${MIN_PER_TEAM})`);
    }
  }

  // 표본 핵심 선수 존재 여부 (자주 사라졌던 선수들을 canary로)
  const CANARIES = ["원태인", "구자욱", "김재윤", "김지찬", "오스틴"];
  const names = new Set(roster.map((p) => p.name));
  for (const name of CANARIES) {
    if (!names.has(name)) {
      issues.push(`canary player missing: ${name}`);
    }
  }

  const status = issues.length === 0 ? "ok" : "fail";
  const body = {
    status,
    total,
    expected: total,
    countContract: "dynamic-roster-ssot",
    byTeam,
    issues,
    checkedAt: new Date().toISOString(),
  };

  return NextResponse.json(body, {
    status: status === "ok" ? 200 : 503,
    headers: {
      "Cache-Control": "no-store, must-revalidate",
    },
  });
}
