/**
 * QA fixture — 경기 헤더 스코어보드 레이아웃 회귀 (PR #820)
 *
 * 용도: scripts/qa/ui-smoke-score-layout.mjs 가 320/360/390px 뷰포트에서
 *       ScoreBar/NonLiveScoreDisplay DOM 실측(clientWidth/scrollWidth/x/right)에 사용.
 * 접근: dev 전용 — production 빌드에서는 404 (유저 노출 금지).
 * 예시: /qa/score-layout?away=14&home=10
 */
import { notFound } from "next/navigation";
import ScoreBar from "@/components/game/ScoreBar";
import NonLiveScoreDisplay from "@/components/game/NonLiveScoreDisplay";
import { TEAMS } from "@/lib/constants/teams";

export const metadata = { robots: "noindex,nofollow" };

export default async function ScoreLayoutQaPage({
  searchParams,
}: {
  searchParams: Promise<{ away?: string; home?: string }>;
}) {
  if (process.env.NODE_ENV === "production") notFound();

  const params = await searchParams;
  const awayScore = Number.parseInt(params.away ?? "0", 10) || 0;
  const homeScore = Number.parseInt(params.home ?? "0", 10) || 0;

  // 최악 케이스 고정: 팀명 3글자(SSG) vs 2글자(삼성)
  const awayTeam = TEAMS.find((t) => t.shortName === "SSG") ?? TEAMS[0];
  const homeTeam = TEAMS.find((t) => t.shortName === "삼성") ?? TEAMS[1];

  return (
    <div className="min-h-screen bg-black">
      <div data-qa="scorebar">
        <ScoreBar
          awayTeam={awayTeam}
          homeTeam={homeTeam}
          awayScore={awayScore}
          homeScore={homeScore}
          currentInning="7회말"
        />
      </div>
      <div data-qa="nonlive" className="mt-8">
        <NonLiveScoreDisplay
          awayTeam={awayTeam}
          homeTeam={homeTeam}
          awayScore={awayScore}
          homeScore={homeScore}
        />
      </div>
    </div>
  );
}
