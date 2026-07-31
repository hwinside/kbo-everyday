/**
 * 타이틀 AI분석 프롬프트 회귀 스모크.
 * 실행: npx tsx scripts/qa/title-analysis-orphan-score-smoke.ts  (npm run qa:title-orphan)
 *
 * 배경: 투수 타이틀 분석에 "삼성은 롯데에 9:7로 승리했다"처럼 특정 선수 수치 변동과
 *       무관한 경기 스코어 문장이 orphan으로 삽입되는 사고(#cs 2026-08-01) 재발 방지.
 *       프롬프트가 "인과 연결 없는 경기 스코어 삽입 금지" 제약을 계약으로 유지하는지 고정한다.
 *       (LLM 출력은 비결정적이라, 프롬프트 계약 텍스트 자체를 회귀 고정한다.)
 */
import { buildTitlePrompt } from "../../src/lib/analysis/daily-analysis-core";
import type { TitlesDelta, GameEvent } from "../../src/lib/analysis/daily-delta";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`✗ ${name}`);
  }
}

// 사고 재현 데이터: 세이브 1위 김재윤(삼성) + 삼성 9:7 롯데 경기.
const delta: TitlesDelta = {
  date: "2026-07-31",
  summary: "",
  categories: [
    {
      category: "saves",
      baselineSuppressed: false,
      leaderChanged: false,
      oldLeader: { player_name: "김재윤", team: "삼성", value: 24 },
      newLeader: { player_name: "김재윤", team: "삼성", value: 25 },
      top5: [
        { player_name: "김재윤", team: "삼성", value: 25, rank: 1, rankChange: 0, valueChange: 1 },
      ],
    },
  ],
};

const events: GameEvent[] = [
  {
    gameId: "20260731SSLT0",
    awayTeam: "삼성",
    homeTeam: "롯데",
    awayScore: 9,
    homeScore: 7,
    winPitcher: "",
    losePitcher: "",
    savePitcher: "김재윤",
    isBlowout: false,
    scoreDiff: 2,
  },
];

const pitcherPrompt = buildTitlePrompt(delta, events, "pitcher");
const batterPrompt = buildTitlePrompt({ ...delta, categories: [] }, events, "batter");

// 1) 새 제약(인과 없는 스코어 삽입 금지)이 프롬프트 계약에 존재.
check(
  "pitcher: orphan-score 금지 제약 존재",
  /인과.*연결되지 않는 경기 결과 문장을 삽입하는 것은 절대 금지/.test(pitcherPrompt),
);
check(
  "pitcher: 연결고리 없으면 스코어 미사용 지시 존재",
  pitcherPrompt.includes("연결고리가 없으면 경기 스코어를 아예 쓰지 마세요"),
);
check(
  "batter: 동일 제약 존재(공용 템플릿)",
  batterPrompt.includes("연결고리가 없으면 경기 스코어를 아예 쓰지 마세요"),
);

// 2) 기존의 느슨한 원칙 5번 문구는 제거되어야 함(되돌림 방지).
check(
  "pitcher: 구(旧) 느슨한 원칙 5번 문구 제거됨",
  !pitcherPrompt.includes("경기 결과와 연결해서 왜 수치가 변했는지 설명하세요."),
);

// 3) 경기 결과 섹션 자체는 유지(승수·세이브 등 유의미한 인과용 데이터 제공).
check("pitcher: 경기 결과 섹션 유지", pitcherPrompt.includes("## 경기 결과"));
check("pitcher: 데이터 이벤트 라인 포함", pitcherPrompt.includes("삼성 9:7 롯데"));

console.log(`\n${fail === 0 ? "✅" : "❌"} title-analysis-orphan-score: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
