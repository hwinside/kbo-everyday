/**
 * 타이틀(타자/투수) AI 분석 프롬프트 빌더 — side-effect 없는 순수 모듈.
 *
 * daily-analysis-core.ts는 import 시 supabaseAdmin을 즉시 생성하므로, 이 빌더를
 * core에서 분리해 비밀값 없이(clean env) 단독 테스트가 가능하게 한다.
 * core는 이 함수를 re-export 한다.
 */
import { titleCategoriesForNarrative, type TitlesDelta, type GameEvent } from "@/lib/analysis/daily-delta";

/**
 * 타이틀 분석 프롬프트를 생성한다.
 *
 * 경기 결과 라인에는 팀 스코어뿐 아니라 **직접 기록 투수(승/패/세이브)**를 함께 내보낸다.
 * 이 필드가 있어야 모델이 "타이틀 보유 선수가 그 경기서 직접 기록을 냈는지"를 판별해
 * 인과 없는 경기 스코어(orphan) 삽입 금지 원칙을 지킬 수 있다(#cs 2026-08-01).
 */
export function buildTitlePrompt(
  delta: TitlesDelta,
  events: GameEvent[],
  type: "batter" | "pitcher",
): string {
  const label = type === "batter" ? "타자 타이틀" : "투수 타이틀";
  const cats = type === "batter"
    ? ["avg", "hr", "rbi", "sb"]
    : ["era", "wins", "k", "saves", "whip"];
  const catNames: Record<string, string> = {
    avg: "타율", hr: "홈런", rbi: "타점", sb: "도루",
    era: "평균자책점", wins: "승수", k: "탈삼진", saves: "세이브", whip: "WHIP",
  };

  // 승/패/세이브 투수를 라인에 명시 → 모델이 타이틀 보유 선수의 직접 기록 여부를 판별 가능.
  const eventLines = events.map((e) => {
    const credits: string[] = [];
    if (e.winPitcher) credits.push(`승: ${e.winPitcher}`);
    if (e.losePitcher) credits.push(`패: ${e.losePitcher}`);
    if (e.savePitcher) credits.push(`세이브: ${e.savePitcher}`);
    const creditText = credits.length > 0 ? ` (${credits.join(", ")})` : "";
    return `${e.awayTeam} ${e.awayScore}:${e.homeScore} ${e.homeTeam}${creditText}`;
  }).join("\n");

  const catData = titleCategoriesForNarrative(delta)
    .filter((c) => cats.includes(c.category))
    .map((c) => {
      const name = catNames[c.category] || c.category;
      // 공동 1위 감지: top5 중 rank === 1 인 모든 선수
      const coLeaders = c.top5.filter((p) => p.rank === 1);
      let leader: string;
      if (coLeaders.length > 1) {
        const names = coLeaders.map((p) => `${p.player_name}(${p.team})`).join(", ");
        leader = `공동 1위 (${coLeaders.length}명, ${c.newLeader.value}): ${names}`;
      } else if (c.leaderChanged) {
        leader = `1위 교체: ${c.oldLeader?.player_name}(${c.oldLeader?.team}) → ${c.newLeader.player_name}(${c.newLeader.team})`;
      } else {
        leader = `1위 유지: ${c.newLeader.player_name}(${c.newLeader.team}, ${c.newLeader.value})`;
      }
      const top5 = c.top5.map((p) => {
        const rc = p.rankChange > 0 ? `↑${p.rankChange}` : p.rankChange < 0 ? `↓${Math.abs(p.rankChange)}` : "-";
        return `  ${p.rank}위 ${p.player_name}(${p.team}) ${p.value} [순위변동: ${rc}]`;
      }).join("\n");
      return `### ${name}\n${leader}\n${top5}`;
    }).join("\n\n");

  return `당신은 KBO 프로야구 전문 데이터 분석 기자입니다.
아래 데이터를 바탕으로 최근 경기 기준 ${label} 변동을 기사체 반말(~다)로 작성하세요.

## 핵심 원칙
0. 존댓말(~습니다/~합니다) 절대 금지. 기사체 반말(~했다/~됐다/~있다)로만 작성하세요.
1. 제공된 데이터 외의 정보를 사용하지 마세요.
2. 시점 표현 규칙: "오늘", "어제" 등 시점 부사를 본문에 절대 쓰지 마세요. 경기 날짜는 화면에 별도로 표기되므로 본문에는 시점어 없이 사건만 서술하세요. "4월 17일" 등 구체적 날짜도 금지.
2-1. 금지 도입부 예시: "어제 타자 타이틀은~", "오늘 투수 타이틀은~". 도입부는 시점어 없이 바로 사건부터 시작하세요.
3. 마크다운/HTML 문법 금지. ##, **, *, - 등 서식 없이 순수 텍스트로만 작성하세요.
4. 각 카테고리별 변동을 서술하되, 1위 교체가 있으면 중점적으로 다루세요.
5. 경기 스코어(예: "9:7")는 해당 타이틀 보유 선수가 그 경기에서 직접 기록을 냈을 때만, 그 인과를 한 문장 안에 명시해서 언급하세요. "직접 기록"이란 위 '경기 결과' 라인에 그 선수가 승/패/세이브 투수로 명시되어 있는 경우를 말합니다(탈삼진·타점 등도 해당 선수가 그 경기 기록임이 데이터로 확인될 때만). 단순한 팀 승패 스코어를 근거 없이 나열하거나, 특정 선수의 수치 변동과 연결되지 않는 경기 결과 문장을 삽입하는 것은 절대 금지입니다. 연결고리가 없으면 경기 스코어를 아예 쓰지 마세요.
6. 구체적 수치를 자연스럽게 녹여 서술하세요.
7. 동률 처리 필수: 데이터에 순위가 명시되어 있으므로 그대로 따르세요. 같은 순위(예: 1위 여러 명)는 반드시 "공동 1위"로 묶어서 한 문장으로 서술하고, 절대 1위/2위/3위로 임의 서열화하지 마세요. 예: 홈런 5개 공동 1위 3명 → "오스틴, 장성우, 레이예스가 나란히 홈런 5개로 공동 1위에 올랐다".
8. 공동 N위가 여러 카테고리에 걸쳐 나오면 각각 동일 규칙 적용. 순위 숫자 앞에 "공동"을 반드시 붙이세요.

## 경기 결과
${eventLines || "경기 없음"}

## ${label} 변동
${catData}

## 출력 형식 (JSON 객체 하나만 출력)
{ "content": "${label} 변동 기사 본문 (시점어 없이, 150~250자, 마크다운 금지, 날짜 언급 금지)" }`;
}
