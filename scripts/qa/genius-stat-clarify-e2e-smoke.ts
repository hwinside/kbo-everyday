/**
 * `<X> <지표>` 되묻기(`stat_clarify`) **양방향 종단 게이트** — `answerQuestion()` 실행 결과로 판정한다.
 *
 * ⚠️ 이 게이트가 생긴 이유 (삼순 2026-08-08 NO-GO P0-①·②).
 *
 *   ① 직전 구현은 "잔여에 야구 SSOT 신호가 없으면 bare" 라는 **음성 추론**이어서,
 *      승인된 반대쌍(`친구가 이대호 홈런 영상을 보내줬어` 등 서사·요청 문장)이 전부
 *      `stat_clarify` 로 삼켜졌다. 분류 함수 단위 검증만 있었고 **`answerQuestion()`
 *      양방향 종단 게이트가 없어서** 그 회귀를 코드 리뷰가 아니라 사람이 잡았다.
 *   ② 앞단 혼합형 fail-close 를 넣고도 보고한 실제 종단 3개(혼합형·`LG 팀타율`·
 *      `KIA 팀 타율`)를 고정하는 게이트가 없어 회귀 검출력이 닫히지 않았다.
 *
 * 그래서 이 게이트는 **양방향**을 한 파일에서 못 박는다:
 *   (A) 반대쌍 — `<X> <지표>` 조각을 품었지만 문장이 서사·매체 요청인 8건(평서 4 + 존대 4).
 *       `stat_clarify` 로 끝나면 FAIL. 예외로 죽어도 FAIL.
 *   (B) 되묻기 유지 — bare `<X> <지표>` 요청 6건. `stat_clarify` 가 **아니면** FAIL.
 *       되묻기는 결정론 경로이므로 LLM 0 · cache write 0 도 계약이다.
 *   (C) 실제 종단 3건 — 혼합형은 되묻기로, 구단 수치는 `kbo_structured` 실값으로.
 *
 * 로스터는 실제 배포 로더로 읽는다 — 자체 fixture 는 loader 결함을 GREEN 으로 만든다.
 * 구단 fixture 의 teamId 는 배포 판정기 `teamIdOfCanonical` 로 구한다 — 표를 다시 적으면
 * 매핑이 바뀔 때 게이트만 낡는다.
 *
 * 실행: npm run qa:genius-stat-clarify
 */
import assert from "node:assert/strict";
import {
  answerQuestion,
  teamIdOfCanonical,
  STAT_CLARIFY_ANSWER,
  type GlossaryEntry,
  type PlayerRef,
  type QaDeps,
} from "../../src/lib/baseball-qa/pipeline";
import type { StandingsRow, TeamRecordsPayload } from "../../src/lib/baseball-qa/stats/team-record";
import { loadRosterPlayers } from "../../src/lib/baseball-qa/roster/load-roster-players";

let pass = 0;
function check(name: string, fn: () => void) {
  fn();
  pass += 1;
  console.log(`PASS ${name}`);
}

async function main() {
  const players: PlayerRef[] = await loadRosterPlayers();
  assert.ok(players.length >= 100, `로스터가 ${players.length}명뿐이다 — 로더가 깨졌다`);
  const GLOSSARY: GlossaryEntry[] = [
    { term: "보크", aliases: ["보크"], answer: "투수의 부정 투구 동작이에요." },
  ];

  // 구단 fixture — teamId 는 배포 판정기로 역산한다(표 중복 금지).
  const kiaId = teamIdOfCanonical("KIA");
  const lgId = teamIdOfCanonical("LG");
  assert.ok(kiaId !== null && lgId !== null, "teamIdOfCanonical 이 KIA/LG 를 못 푼다");
  const mkStanding = (teamName: string, teamId: number, ranking: number): StandingsRow => ({
    teamName, teamId, games: 100, wins: 55, losses: 43, draws: 2,
    winRate: 0.561, gamesBehind: 2.5, ranking,
  });
  const STANDINGS: StandingsRow[] = [mkStanding("KIA 타이거즈", kiaId!, 1), mkStanding("LG 트윈스", lgId!, 2)];
  const TEAM_RECORDS: TeamRecordsPayload = {
    season: 2026,
    batting: [
      { teamId: kiaId!, slug: "kia", avg: 0.281 },
      { teamId: lgId!, slug: "lg", avg: 0.276 },
    ],
    pitching: [],
  };

  interface Calls { llm: number; cacheSet: number }
  function makeDeps(): { deps: QaDeps; calls: Calls } {
    const calls: Calls = { llm: 0, cacheSet: 0 };
    const deps = {
      loadGlossary: async () => GLOSSARY,
      loadPlayers: async () => players,
      getCache: async () => null,
      setCache: async () => { calls.cacheSet += 1; },
      callLlm: async () => {
        calls.llm += 1;
        return {
          text: JSON.stringify({ status: "BASEBALL_RULE_TERM", answer: "LLM 생성답입니다." }),
          inputTokens: 1,
          outputTokens: 1,
        };
      },
      reserveDaily: async () => ({ allowed: true, remaining: 19 }),
      log: async () => {},
      fetchTeamRecord: {
        fetchStandings: async () => STANDINGS,
        fetchTeamRecords: async () => TEAM_RECORDS,
      },
    } as unknown as QaDeps;
    return { deps, calls };
  }

  async function ask(question: string) {
    const { deps, calls } = makeDeps();
    const result = await answerQuestion("u-stat-clarify-gate", question, deps);
    return { result, calls };
  }

  // ── (A) 반대쌍 — 서사·매체 요청은 되묻기로 삼키지 않는다 ────────────────────
  const COUNTERPAIRS = [
    "친구가 이대호 홈런 영상을 보내줬어",
    "회사에서 이대호 홈런 얘기가 나왔어",
    "유튜브에서 이대호 홈런 봤어",
    "이대호 홈런 영상 보여줘",
    "친구가 이대호 홈런 영상을 보내주셨어요",
    "회사에서 이대호 홈런 얘기가 나왔어요",
    "유튜브에서 이대호 홈런 봤습니다",
    "이대호 홈런 영상 보여주세요",
  ];
  for (const q of COUNTERPAIRS) {
    const { result } = await ask(q);
    check(`반대쌍 통과 — "${q}" → ${result.source}`, () => {
      assert.notEqual(result.source, "stat_clarify", `서사·요청 문장이 되묻기로 삼켜졌다: ${q}`);
      assert.notEqual(result.answer, STAT_CLARIFY_ANSWER, `답변 문자열이 되묻기 문구다: ${q}`);
    });
  }

  // ── (B) 되묻기 유지 — bare 요청은 여전히 되묻는다. 결정론이므로 LLM·cache 0 ──
  const RETAINED = [
    "이대호 홈런",
    "그럼 이대호 홈런",
    "이대호 홈런 알려주실래요",
    "이대호 홈런 좀 알려주시면 감사하겠습니다",
    "홍길동 타율 부탁드립니다",
    "오타니 홈런이 뭐야",
  ];
  for (const q of RETAINED) {
    const { result, calls } = await ask(q);
    check(`되묻기 유지 — "${q}"`, () => {
      assert.equal(result.source, "stat_clarify", `bare 요청이 되묻기가 아니라 ${result.source} 로 끝났다: ${q}`);
      assert.equal(result.answer, STAT_CLARIFY_ANSWER);
      assert.equal(calls.llm, 0, `결정론 되묻기가 LLM 을 ${calls.llm}회 호출했다`);
      assert.equal(calls.cacheSet, 0, `되묻기를 캐시에 썼다`);
    });
  }

  // ── (C) 보고한 실제 종단 3건 (삼순 2026-08-08 ②) ───────────────────────────
  {
    const { result, calls } = await ask("김도영 홈런과 이대호 홈런 몇개");
    check("혼합형 앞단 fail-close — 김도영 홈런과 이대호 홈런 몇개 → stat_clarify", () => {
      assert.equal(result.source, "stat_clarify");
      assert.equal(calls.llm, 0);
    });
  }
  {
    const { result } = await ask("KIA 팀 타율 알려줘");
    check("대용어 head 결속 — KIA 팀 타율 알려줘 → kbo_structured 실값", () => {
      assert.equal(result.source, "kbo_structured", `구단 수치 질문이 ${result.source} 로 끝났다`);
      assert.ok(/0\.281/.test(result.answer ?? ""), `fixture 팀 타율(0.281)이 답에 없다: ${result.answer}`);
    });
  }
  {
    const { result } = await ask("LG 팀타율");
    check("붙여쓴 팀지표 결속 — LG 팀타율 → kbo_structured 실값", () => {
      assert.equal(result.source, "kbo_structured", `구단 수치 질문이 ${result.source} 로 끝났다`);
      assert.ok(/0\.276/.test(result.answer ?? ""), `fixture 팀 타율(0.276)이 답에 없다: ${result.answer}`);
    });
  }

  console.log(`\n${pass} checks PASS — stat_clarify 양방향 종단 계약 성립`);
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
