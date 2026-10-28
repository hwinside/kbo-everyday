import type { KboGame } from "@/lib/crawler/kbo-api";
import type { Seed } from "@/lib/postseason/ladder";
import { postseasonGameLabel } from "@/lib/crawler/game-series";
import { isPostseason, normalizeSeriesId } from "@/lib/crawler/game-series";

/** Only positively identified regular/preseason games may describe a standings race.
 * Unknown identity (including schedule outages) must not leak stale PS narratives.
 */
export function usesRegularPreviewContext(srId: unknown): boolean {
  const id = normalizeSeriesId(srId);
  return id === "0" || id === "1";
}

export function guardPreviewContext(summary: Record<string, unknown>, srId: unknown): Record<string, unknown> {
  if (usesRegularPreviewContext(srId)) return summary;
  return { ...summary, seriesContext: null, standingsImpact: null };
}

export function previewVersion(srId: unknown): number {
  return isPostseason(srId) ? 9 : 8;
}

export function previewSeriesInstructions(srId: unknown): string {
  if (usesRegularPreviewContext(srId)) return "";
  const stage = ({
    "4": "와일드카드 결정전. 정규시즌 4위는 1승 어드밴티지를 갖고 1승 또는 1무승부로 준플레이오프에 진출한다. 5위는 두 경기 모두 이겨야 진출한다.",
    "3": "준플레이오프. 5전 3선승제로 플레이오프 진출팀을 가린다.",
    "5": "플레이오프. 5전 3선승제로 한국시리즈 진출팀을 가린다.",
    "7": "한국시리즈. 7전 4선승제로 우승팀을 가린다.",
  } as Record<string, string>)[String(srId)];
  return `
## 경기 구분 및 최우선 제약
${stage ?? "공식 경기 구분을 확인하지 못했다. 시리즈 단계와 진출 조건을 추측하지 않는다."}
정규시즌 순위 경쟁·승차 추격·순위 변동으로 경기 의미를 설명하지 않는다.
정규시즌 상대전적·최근 경기 기록은 전력 참고 자료일 뿐 현재 시리즈 전적이 아니다.
어드밴티지를 실제 경기 승수에 합산하지 않는다. 홈/원정만으로 시드나 진출 조건을 특정 팀에 배정하지 않는다.
아래 확정 정보에 명시된 팀별 시드·차전만 사용한다. 현재 시리즈 승수는 제공되지 않았으므로 추측하지 않는다.
seriesContext와 standingsImpact는 반드시 null로 반환한다. 다른 필드에도 순위 경쟁 문구를 넣지 않는다.
`;
}

/** Bind seed facts to the official matchup; never infer seeding from home/away. */
export function previewPostseasonFacts(
  game: Pick<KboGame, "srId" | "gameLabel" | "status" | "awayTeamId" | "homeTeamId">,
  seeds: Seed[],
): string {
  if (!isPostseason(game.srId)) return "";
  const facts = [`공식 경기: ${postseasonGameLabel(game.srId, game.gameLabel, game.status)}`];
  const ids = [game.awayTeamId, game.homeTeamId];
  const validSeeds = seeds.length === 5 && new Set(seeds.map(s => s.rank)).size === 5
    && new Set(seeds.map(s => s.teamId)).size === 5
    && seeds.every(s => Number.isInteger(s.rank) && s.rank >= 1 && s.rank <= 5);
  const participants = validSeeds ? seeds.filter(s => ids.includes(s.teamId)) : [];
  if (participants.length === 2) {
    facts.push(...participants.map(s => `${s.name}: 정규시즌 최종 ${s.rank}위 (고정 시드, 현재 순위 경쟁 아님)`));
    if (game.srId === "4") {
      const fourth = participants.find(s => s.rank === 4);
      const fifth = participants.find(s => s.rank === 5);
      if (fourth && fifth) {
        facts.push(`${fourth.name}: 1승 어드밴티지를 갖는다. 시리즈에서 1승 또는 1무승부를 거두면 준플레이오프에 진출한다.`);
        facts.push(`${fifth.name}: 와일드카드 두 경기 모두 승리해야 준플레이오프에 진출한다. 2차전은 5위 팀이 1차전에서 승리했을 때만 필요하다.`);
      } else facts.push("WC 대진과 시드가 일치하지 않음: 팀별 어드밴티지·진출 조건을 서술하지 않는다.");
    }
  } else facts.push("최종 시드 확인 불가: 팀별 순위·어드밴티지·진출 조건을 추정하지 않는다.");
  facts.push("현재 시리즈의 실제 승패·무승부 누적은 미제공. 정규시즌 상대전적을 시리즈 전적으로 대체하지 않는다.");
  return `\n## 공식 포스트시즌 확정 정보\n${facts.join("\n")}\n`;
}
