/**
 * 타이틀 AI분석 프롬프트 회귀 스모크.
 * 실행: npx tsx scripts/qa/title-analysis-orphan-score-smoke.ts  (npm run qa:title-orphan)
 *
 * 배경: 투수 타이틀 분석에 "삼성은 롯데에 9:7로 승리했다"처럼 특정 선수 수치 변동과
 *       무관한 경기 스코어 문장이 orphan으로 삽입되는 사고(#cs 2026-08-01) 재발 방지.
 *
 * 계약(삼순 NO-GO 반영):
 *  1) 프롬프트 제약 텍스트가 "인과 없는 스코어 삽입 금지"를 유지한다.
 *  2) **입력 데이터 결속**: 경기 결과 라인에 승/패/세이브 투수가 실제로 반영되어,
 *     타이틀 보유 선수가 직접 기록을 낸 경기(linked)와 아닌 경기(unlinked)가
 *     서로 다른 프롬프트를 만든다. (fixture가 unused false-green이 아님을 증명)
 *  3) side-effect 없는 순수 모듈(daily-analysis-title-prompt)에서 import하므로
 *     Supabase 등 비밀값 없이 clean 환경에서 자립 실행된다.
 */
import { buildTitlePrompt } from "../../src/lib/analysis/daily-analysis-title-prompt";
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

// 세이브 1위 김재윤(삼성).
const savesDelta: TitlesDelta = {
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

// linked: 김재윤이 이 경기서 세이브를 올림 → 인과 있는 언급 허용
const linkedEvent: GameEvent = {
  gameId: "20260731SSLT0",
  awayTeam: "삼성",
  homeTeam: "롯데",
  awayScore: 9,
  homeScore: 7,
  winPitcher: "원태인",
  losePitcher: "박세웅",
  savePitcher: "김재윤",
  isBlowout: false,
  scoreDiff: 2,
};

// unlinked: 같은 스코어지만 세이브 투수가 다른 선수 → orphan(언급 금지) 대상
const unlinkedEvent: GameEvent = { ...linkedEvent, savePitcher: "정해영" };

const linkedPrompt = buildTitlePrompt(savesDelta, [linkedEvent], "pitcher");
const unlinkedPrompt = buildTitlePrompt(savesDelta, [unlinkedEvent], "pitcher");
const batterPrompt = buildTitlePrompt({ ...savesDelta, categories: [] }, [linkedEvent], "batter");

// 1) 제약 텍스트 존재/구(舊) 느슨한 문구 제거.
check(
  "pitcher: orphan-score 금지 제약 존재",
  /인과.*연결되지 않는 경기 결과 문장을 삽입하는 것은 절대 금지/.test(linkedPrompt),
);
check(
  "pitcher: 연결고리 없으면 스코어 미사용 지시 존재",
  linkedPrompt.includes("연결고리가 없으면 경기 스코어를 아예 쓰지 마세요"),
);
check(
  "pitcher: 구(舊) 느슨한 원칙 5번 문구 제거됨",
  !linkedPrompt.includes("경기 결과와 연결해서 왜 수치가 변했는지 설명하세요."),
);
check(
  "batter: 동일 제약 존재(공용 템플릿)",
  batterPrompt.includes("연결고리가 없으면 경기 스코어를 아예 쓰지 마세요"),
);

// 2) 입력 결속: 승/패/세이브 투수가 실제 라인에 반영됨(fixture가 실사용됨).
check("pitcher: 경기 결과 섹션 유지", linkedPrompt.includes("## 경기 결과"));
check("pitcher: 세이브 투수(김재윤) 라인에 결속", linkedPrompt.includes("세이브: 김재윤"));
check("pitcher: 승리투수(원태인) 라인에 결속", linkedPrompt.includes("승: 원태인"));
// linked와 unlinked는 세이브 투수만 다르므로 프롬프트가 반드시 달라야 한다(구현 전엔 동일 = false-green).
check("pitcher: linked/unlinked 프롬프트가 실제로 다름", linkedPrompt !== unlinkedPrompt);
check("pitcher: unlinked엔 김재윤 세이브 결속 없음", !unlinkedPrompt.includes("세이브: 김재윤"));

console.log(`\n${fail === 0 ? "✅" : "❌"} title-analysis-orphan-score: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
