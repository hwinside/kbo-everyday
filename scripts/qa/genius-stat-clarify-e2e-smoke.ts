/**
 * `<X> <지표>` 미결속 축 **양방향 종단 게이트** — `answerQuestion()` 실행 결과로 판정한다.
 *
 * ## 2026-08-10 재설계 (하린아빠 방향 확정 — 룰 최소화, LLM 위임)
 *
 *   종전 계약은 "bare `<X> <지표>` 는 결정론 되묻기(stat_clarify, LLM 0)"였고, bare 판정을
 *   잔여 룰 문법(요청 어간·감탄사·과거 ㅅㅅ 받침·처소 표지)으로 했다. 그 문법이 회귀마다
 *   자라는 핑퐁 표면이었다(#1139→#1142 에서 확정된 교훈: 열린 자연어는 열거로 닫히지 않는다).
 *
 *   새 계약은 판정 주체를 LLM 으로 옮기고 안전을 기계 게이트로 고정한다:
 *     · 순수 미결속 `<X> <지표>` (서사든 요청이든) → generic LLM 위임 (statNumericGuard 세팅)
 *     · 게이트: 답 숫자 토큰 ⊆ 질문 숫자 토큰 (`numericTokensSubsetOf`, #1142 GENERAL 동일 계약)
 *       위반 → `stat_clarify` fail-close (답변·저장 모두 되묻기로 교체, 캐시 금지)
 *     · 혼합형(결속 절 + 미결속 절)만 앞단 결정론 되묻기 유지 — 판정이 전부 구조(조회)라
 *       열린 언어 판정이 없고, 결속 절을 deterministic 경로가 선점하면 게이트가 볼 기회가 없다.
 *
 * 이 게이트가 못 박는 것:
 *   (A) 반대쌍 — 서사·매체 요청 8건(평서 4 + 존대 4). 하드 되묻기로 삼키면 FAIL.
 *       LLM 이 숫자 없는 답을 주면 그 답이 그대로 나가야 한다.
 *   (B) 환각 차단 — bare `<X> <지표>` 6건. LLM 이 질문에 없는 숫자를 지어내면
 *       유저에게 그 숫자가 **절대 도달하지 않아야** 한다(되묻기로 교체 + 캐시 0).
 *       LLM 이 숫자 없이 되물으면 그 자연 되묻기가 그대로 나간다.
 *   (C) 실제 종단 3건 — 혼합형은 앞단 되묻기(LLM 0), 구단 수치는 `kbo_structured` 실값.
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
  packStoredQaFinal,
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
    { term: "보크", aliases: ["보크"], answer: "투수의 부정 투구 동작입니다." },
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
  /**
   * @param llmAnswer stub LLM 이 돌려줄 답. 게이트 검증을 위해 호출별로 바꾼다.
   *   기본값은 숫자 없는 정상 생성답 — 게이트를 건드리지 않는 경로.
   */
  // ⚠️ stub 답은 배포 프롬프트 계약("첫 문장에 야구 신호")을 지켜야 한다 — 안 지키면
  //   출력측 안전판(`answerInQuestionScope`)이 unsure 로 접어 게이트가 위임 경로를 못 본다.
  function makeDeps(llmAnswer = "야구 이야기로 이해했습니다. 이대호 선수의 어느 시즌 기록인지 알려주시면 확인하겠습니다."): { deps: QaDeps; calls: Calls } {
    const calls: Calls = { llm: 0, cacheSet: 0 };
    const deps = {
      loadGlossary: async () => GLOSSARY,
      loadPlayers: async () => players,
      getCache: async () => null,
      setCache: async () => { calls.cacheSet += 1; },
      callLlm: async () => {
        calls.llm += 1;
        return {
          text: JSON.stringify({ status: "BASEBALL_RULE_TERM", answer: llmAnswer }),
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

  async function ask(question: string, llmAnswer?: string) {
    const { deps, calls } = makeDeps(llmAnswer);
    const result = await answerQuestion("u-stat-clarify-gate", question, deps);
    return { result, calls };
  }

  // 게이트가 잡아야 하는 환각 stub — 질문에 없는 숫자(374·0.312)를 단정한다.
  const FABRICATED = "야구 기록으로 이대호 선수는 통산 홈런 374개, 타율 0.312를 기록했습니다.";

  // ── (A) 반대쌍 — 서사·매체 요청은 하드 되묻기로 삼키지 않는다 ────────────────
  //
  //   재설계 후 이 문장들은 LLM 위임 대상이다. stub 이 숫자 없는 답을 주면 그 답이
  //   그대로 나가야 한다(되묻기 문구로 교체되면 FAIL). 어떤 경로로 답하든
  //   `stat_clarify` 하드 종결만 아니면 계약 성립이다 — 문장 유형 판정은 LLM 몫이다.
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
    const { result, calls } = await ask(q);
    check(`반대쌍 통과 — "${q}" → ${result.source}`, () => {
      assert.notEqual(result.source, "stat_clarify", `서사·요청 문장이 하드 되묻기로 삼켜졌다: ${q}`);
      assert.notEqual(result.answer, STAT_CLARIFY_ANSWER, `답변 문자열이 되묻기 문구다: ${q}`);
      // 위임이 실제로 성립해야 한다 — LLM 까지 가서 숫자 없는 답이 그대로 나가는 것이 계약이다.
      assert.ok(calls.llm > 0, `서사·요청 문장이 LLM 위임 없이 ${result.source} 로 끝났다: ${q}`);
      assert.equal(result.source, "llm", `LLM 답이 ${result.source} 로 접혔다: ${q}`);
    });
  }

  // ── (B) 환각 차단 — 미결속 `<X> <지표>` 는 지어낸 숫자가 유저에게 도달하지 않는다 ──
  //
  //   ①(위험 방향) stub 이 질문에 없는 숫자를 단정 → 게이트가 되묻기로 교체해야 한다.
  //   ②(자연 방향) stub 이 숫자 없이 답/되묻기 → 그대로 나가되, 캐시는 금지다.
  const UNBOUND = [
    "이대호 홈런",
    "그럼 이대호 홈런",
    "이대호 홈런 알려주실래요",
    "이대호 홈런 좀 알려주시면 감사하겠습니다",
    "홍길동 타율 부탁드립니다",
    "오타니 홈런이 뭐야",
  ];
  for (const q of UNBOUND) {
    const { result, calls } = await ask(q, FABRICATED);
    check(`환각 차단 — "${q}" (지어낸 숫자 stub)`, () => {
      // 어느 경로로 끝나든(가드 교체·name_suggest 등) 지어낸 숫자는 절대 나가면 안 된다.
      assert.ok(!/374|0\.312/.test(result.answer ?? ""), `지어낸 숫자가 유저에게 도달했다: ${result.answer}`);
      // LLM 까지 갔다면(위임 성립) 반드시 게이트 교체 문구여야 한다.
      if (calls.llm > 0) {
        assert.equal(result.source, "stat_clarify", `가드가 환각 답을 통과시켰다(${result.source}): ${q}`);
        assert.equal(result.answer, STAT_CLARIFY_ANSWER);
      }
      assert.equal(calls.cacheSet, 0, `미결속 위임 답이 캐시에 쓰였다: ${q}`);
    });
  }
  {
    // 자연 방향 — LLM 이 스스로 숫자 없이 되묻으면 그 문장이 그대로 나간다.
    const q = "이대호 홈런";
    const natural = "야구 기록 질문으로 이해했습니다. 어느 이대호 선수인지 확인이 필요합니다. 현역 KBO 선수인지 알려주시면 확인하겠습니다.";
    const { result, calls } = await ask(q, natural);
    check(`자연 되묻기 통과 — "${q}" (숫자 없는 stub)`, () => {
      if (calls.llm > 0) {
        assert.equal(result.answer, natural, `숫자 없는 LLM 답이 교체됐다: ${result.answer}`);
        assert.equal(result.source, "llm");
      }
      assert.equal(calls.cacheSet, 0, "미결속 위임 답이 캐시에 쓰였다");
    });
  }

  // ── (C) 보고한 실제 종단 3건 (삼순 2026-08-08 ② — 재설계 후에도 유지) ────────
  {
    const { result, calls } = await ask("김도영 홈런과 이대호 홈런 몇개", FABRICATED);
    check("혼합형 앞단 fail-close — 김도영 홈런과 이대호 홈런 몇개 → stat_clarify (LLM 0)", () => {
      assert.equal(result.source, "stat_clarify");
      assert.equal(calls.llm, 0, `혼합형 앞단이 LLM 을 ${calls.llm}회 호출했다`);
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

  // ── (D) #1148 매퍼 합성 우회 차단 (삼순 2026-08-11 재리뷰 P0) ───────────────────
  //
  //   #1148 사전 매퍼는 generic LLM 앞에서 `dictionary` 로 선반환한다. 지표어(`홈런`)가
  //   사전에 있고 매퍼가 그 term 을 (오판으로) 골라버리면, 기록 질문이 종단
  //   statNumericGuard 를 통째로 우회해 용어 정의로 오답한다. 계약:
  //     · 가드 소유 질문에서는 **매퍼 호출 0** (결정론 스킵 — 악의적 매퍼도 무해화)
  //     · 환각 stub 은 여전히 `stat_clarify` 로 교체된다 (우회 경로 부재 증명)
  {
    const HR_GLOSSARY: GlossaryEntry[] = [
      ...GLOSSARY,
      { term: "홈런", aliases: ["홈런"], answer: "타자가 친 공이 담장을 넘어가 한 번에 득점하는 안타입니다." },
    ];
    for (const q of ["이대호 홈런 몇개", "오타니 홈런이 뭐야"]) {
      const { deps, calls } = makeDeps(FABRICATED);
      let mapperCalls = 0;
      const adversarial = {
        ...(deps as unknown as Record<string, unknown>),
        loadGlossary: async () => HR_GLOSSARY,
        // 악의적 매퍼 — 무조건 `홈런`을 고른다. 호출되면 그 자체가 계약 위반이다.
        mapGlossaryDefinition: async () => {
          mapperCalls += 1;
          return { term: "홈런", inputTokens: 1, outputTokens: 1 };
        },
      } as unknown as QaDeps;
      const result = await answerQuestion("u-stat-clarify-gate", q, adversarial);
      check(`매퍼 합성 우회 차단 — "${q}" (악의적 매퍼+홈런 사전) → ${result.source}`, () => {
        assert.equal(mapperCalls, 0, `가드 소유 질문에서 매퍼가 ${mapperCalls}회 호출됐다: ${q}`);
        assert.notEqual(result.source, "dictionary", `기록 질문이 사전 정의로 서빙됐다: ${q}`);
        assert.ok(!/374|0\.312/.test(result.answer ?? ""), `지어낸 숫자가 유저에게 도달했다: ${result.answer}`);
        // LLM 까지 갔다면(위임 성립) 환각 stub 은 반드시 게이트 교체 문구다.
        if (calls.llm > 0) {
          assert.equal(result.source, "stat_clarify", `가드가 환각 답을 통과시켰다(${result.source}): ${q}`);
          assert.equal(result.answer, STAT_CLARIFY_ANSWER);
        }
        assert.equal(calls.cacheSet, 0, `가드 소유 질문 답이 캐시에 쓰였다: ${q}`);
      });
    }
  }

  // ── (E) 숫자 P0 반례 2종 (삼순 2026-08-14 NO-GO) ─────────────────────────────
  //
  //   ① 한글 수사 — `삼백칠십사 개` 는 \p{N} 토큰 0개라 아라비아 subset 만으로는 통과
  //   ② 단위 전용 — 질문 `2024년` 의 `2024` 를 답이 `2024개` 로 쓰면 subset 은 통과
  //   둘 다 수사+단위 쌍 대조(`statQuantityClaimsGroundedIn`)가 반드시 RED 로 잡아야 한다.
  {
    const q = "이대호 홈런 몇개";
    const koreanNumeral = "야구 기록으로 이대호 선수는 통산 홈런 삼백칠십사 개를 기록했습니다.";
    const { result, calls } = await ask(q, koreanNumeral);
    check(`한글 수사 차단 — "삼백칠십사 개" → stat_clarify`, () => {
      assert.ok(calls.llm > 0, "위임이 성립하지 않았다 — 반례가 게이트에 도달 못 함");
      assert.equal(result.source, "stat_clarify", `한글 수사 환각이 통과됐다(${result.source}): ${result.answer}`);
      assert.equal(result.answer, STAT_CLARIFY_ANSWER);
      assert.equal(calls.cacheSet, 0);
    });
  }
  {
    const q = "2024년 이대호 홈런 몇개";
    const unitTransfer = "야구 기록으로 이대호 선수는 홈런 2024개를 기록했습니다.";
    const { result, calls } = await ask(q, unitTransfer);
    check(`단위 전용 차단 — 질문 "2024년" → 답 "2024개" → stat_clarify`, () => {
      assert.ok(calls.llm > 0, "위임이 성립하지 않았다 — 반례가 게이트에 도달 못 함");
      assert.equal(result.source, "stat_clarify", `단위 전용 환각이 통과됐다(${result.source}): ${result.answer}`);
      assert.equal(result.answer, STAT_CLARIFY_ANSWER);
      assert.equal(calls.cacheSet, 0);
    });
  }
  {
    // 반대방향 회귀 — 질문이 준 수치를 같은 단위로 되받은 정상 답은 통과해야 한다.
    const q = "홈런 30개면 많은 거야?";
    const echo = "야구 기록 기준으로 한 시즌 30개는 리그 상위권 수준의 홈런 기록입니다.";
    const { result, calls } = await ask(q, echo);
    check(`되받은 수치 통과 — 질문 "30개" → 답 "30개"`, () => {
      if (calls.llm > 0 && result.source !== "stat_clarify") {
        assert.equal(result.answer, echo, `되받은 수치 답이 교체됐다: ${result.answer}`);
      }
      // 가드 소유가 아니어도(용어 질문 등) 지어낸 수치 없음 — 이 케이스는 과차단 방지 목적이다.
    });
  }

  // ── (F) 재생 P0 — durable stored-final 우회 차단 (삼순 2026-08-14 NO-GO) ────────
  //
  //   게이트 도입 이전에 저장된 `llm/374개` envelope 가 front 재생으로 그대로 나가면
  //   statNumericGuard 가 통째로 우회된다. 재생 경로도 같은 대조를 태워 되묻기로
  //   교체·재저장해야 한다.
  {
    const q = "이대호 홈런 몇개";
    const staleEnvelope = packStoredQaFinal(
      { answer: "야구 기록으로 이대호 선수는 통산 홈런 374개를 기록했습니다.", source: "llm", cacheable: true },
      { text: "", inputTokens: 1, outputTokens: 1 },
    );
    const { deps, calls } = makeDeps();
    const stored: string[] = [];
    const replayDeps = {
      ...(deps as unknown as Record<string, unknown>),
      getLlmState: async () => ({ started: true, result: staleEnvelope, ownerActive: false }),
      acquireLlmStart: async () => { throw new Error("replay 경로에서 새 LLM 획득이 있으면 안 된다"); },
      storeLlm: async (llm: { text: string }) => { stored.push(llm.text); },
    } as unknown as QaDeps;
    const result = await answerQuestion("u-stat-clarify-gate", q, replayDeps);
    check("재생 우회 차단 — 저장된 llm/374개 envelope → stat_clarify 교체+재저장", () => {
      assert.equal(result.source, "stat_clarify", `저장 envelope 가 게이트 없이 재생됐다(${result.source}): ${result.answer}`);
      assert.equal(result.answer, STAT_CLARIFY_ANSWER);
      assert.ok(!/374/.test(result.answer ?? ""), "지어낸 숫자가 재생 경로로 도달했다");
      assert.equal(calls.llm, 0, "재생 경로에서 새 LLM 호출이 발생했다");
      assert.equal(calls.cacheSet, 0, "위반 envelope 의 cacheable 이 캐시로 샐다");
      assert.ok(stored.some((text) => text.includes("stat_clarify")), "되묻기로 재저장되지 않았다 — 다음 재생이 또 우회된다");
    });
  }

  console.log(`\n${pass} checks PASS — 미결속 <X> <지표> LLM 위임 + 기계 숫자 게이트 계약 성립`);
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
