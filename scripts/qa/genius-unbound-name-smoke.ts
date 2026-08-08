/**
 * 야잘알봇 **미결속 실명 생성 0** 계약 — `answerQuestion()` 실제 실행 결과로 검증한다.
 *
 * ⚠️ 이 게이트가 생긴 이유 (2026-08-08 하린아빠 제보, Production 실측)
 *
 *     유저: `임창규 어떤 선수야`
 *     봇  : "임창규는 LG 트윈스의 주축 선수로…"
 *
 *   로스터 881명에 `임창규` 는 **없다**(`임찬규` kboId 61101, LG 만 있다).
 *   결속된 근거가 0 인 상태에서 generic LLM 이 받아 **존재하지 않는 사람을 실존으로
 *   만들고** 소속·위상까지 붙였다. 수치 환각보다 나쁘다 — 유저는 틀렸다는 걸 알 방법이 없다.
 *
 * ⚠️ 1차 구현이 틀렸던 지점 (삼순 2026-08-08 NO-GO)
 *   "한 글자만 다른 선수가 정확히 1명" 일 때만 막았다. 그러면 `오타니`·`홍길동`처럼
 *   **이웃이 없는 이름은 그대로 generic LLM 으로 샌다** — 정작 제일 위험한 축(로스터 밖
 *   실존 인물·완전 허구)이 열려 있었다. 그래서 판정을 뒤집었다:
 *     **막는 게 기본, 제안은 후보가 유일할 때만 얹는 편의.**
 *
 * 그래서 이 게이트는 문자열 존재를 보지 않는다(주석에도 걸린다 — #1127 M15 false-green).
 * **배포 `answerQuestion()` 을 실제로 호출**해서 네 가지를 본다:
 *   (a) 미결속 실명에 대해 `llm`·`ragLlm`·`cache` 호출이 **0** 인가 (생성 0)
 *   (b) 유저가 받는 문자열이 **코드가 쓴 두 문장 중 하나**인가 (제안 / 모름)
 *   (c) 되묻기가 **하루 한도를 깎지 않는가** (오타 한 글자에 quota 2개는 부당하다)
 *   (d) 결속된 선수·룰·구단 질문이 **무회귀**인가 (오탐 0)
 *
 * 실행: npm run qa:genius-unbound-name
 */
import assert from "node:assert/strict";
import {
  answerQuestion,
  routeQuestion,
  resolveUnboundName,
  NAME_SUGGEST_ANSWER,
  NAME_UNKNOWN_ANSWER,
  DAILY_LIMIT,
  type GlossaryEntry,
  type PlayerRef,
  type QaDeps,
} from "../../src/lib/baseball-qa/pipeline";
import { RAG_GROUNDED_SENTINEL } from "../../src/lib/baseball-qa/rag/retrieve";
import { MATCH_PATH_REPLY_KIND } from "../../src/lib/constants/baseball-genius";
import { loadRosterPlayers } from "../../src/lib/baseball-qa/roster/load-roster-players";

let pass = 0;
function check(name: string, fn: () => void) {
  fn();
  pass += 1;
  console.log(`PASS ${name}`);
}
async function checkAsync(name: string, fn: () => Promise<void>) {
  await fn();
  pass += 1;
  console.log(`PASS ${name}`);
}

const GLOSSARY: GlossaryEntry[] = [
  { term: "보크", aliases: ["보크"], answer: "투수의 부정 투구 동작이에요." },
];

interface Calls {
  llm: number;
  ragLlm: number;
  teamRagLlm: number;
  cacheRead: number;
  cacheWrite: number;
  quotaReserved: number;
  quotaReleased: number;
}

/**
 * 외부 의존을 **전부 카운트**한다. 이 PR 의 계약이 "생성 경로에 내려보내지 않는다" 이므로,
 * 문구가 맞아도 LLM 을 한 번이라도 부르면 계약 위반이다(토큰·환각·지연 전부).
 *
 * ⚠️ 선수/구단 RAG 를 **켠 채로** 돌린다. 꺼두면 "RAG 가 꺼져서 안 불린 것" 과
 *   "가드가 막아서 안 불린 것" 을 구분할 수 없다 — 게이트가 공허해진다.
 */
function makeDeps(players: PlayerRef[]): { deps: QaDeps; logs: string[]; calls: Calls } {
  const logs: string[] = [];
  const calls: Calls = {
    llm: 0, ragLlm: 0, teamRagLlm: 0,
    cacheRead: 0, cacheWrite: 0, quotaReserved: 0, quotaReleased: 0,
  };
  const deps: QaDeps = {
    loadGlossary: async () => GLOSSARY,
    loadPlayers: async () => players,
    getCache: async () => { calls.cacheRead += 1; return null; },
    setCache: async () => { calls.cacheWrite += 1; },
    callLlm: async () => {
      calls.llm += 1;
      // 실제 사고를 재현한다 — generic LLM 은 근거를 안 보고 없는 사람을 만들어낸다.
      return {
        text: JSON.stringify({
          status: "BASEBALL_RULE_TERM",
          answer: "임창규는 LG 트윈스의 주축 선수예요.",
        }),
        inputTokens: 1, outputTokens: 1,
      };
    },
    enablePlayerRag: true,
    enableTeamRag: true,
    now: () => Date.now(),
    searchRag: async () => [{
      content: "임찬규는 LG 트윈스의 프랜차이즈 투수로 판상 큰 사랑을 받는다고 알려져 있다.",
      pageTitle: "임찬규", canonicalUrl: "https://namu.wiki/w/임찬규",
      revision: "1", sectionPath: "선수 경력", asOf: "2026-01-01", sourceGrade: "tier2",
    }] as never,
    callRagLlm: async () => {
      calls.ragLlm += 1;
      return {
        text: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "프랜차이즈 투수예요." }),
        inputTokens: 1, outputTokens: 1,
      };
    },
    searchTeamRag: async () => [{
      content: "LG 트윈스는 MBC 청룡을 인수해 창단한 서울 연고 구단으로 알려져 있다.",
      pageTitle: "LG 트윈스", canonicalUrl: "https://namu.wiki/w/LG 트윈스",
      revision: "1", sectionPath: "역사", asOf: "2026-01-01", sourceGrade: "tier2",
    }] as never,
    callTeamRagLlm: async () => {
      calls.teamRagLlm += 1;
      return {
        text: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "서울 연고 구단이에요." }),
        inputTokens: 1, outputTokens: 1,
      };
    },
    reserveDaily: async (_userId, limit) => {
      calls.quotaReserved += 1;
      return { allowed: true, remaining: limit - 1 };
    },
    releaseDaily: async () => { calls.quotaReleased += 1; },
    log: async (entry) => { logs.push(entry.matchPath); },
  } as unknown as QaDeps;
  return { deps, logs, calls };
}

async function main() {
  const players = await loadRosterPlayers();
  assert.ok(players.length > 100, `로스터가 ${players.length}명뿐이다 — SSOT 유실`);

  const ask = async (question: string) => {
    const { deps, logs, calls } = makeDeps(players);
    const result = await answerQuestion("u-unbound-name", question, deps);
    return { result, logs, calls };
  };

  // ── ① 실제 사고 재현: 생성 0 + 이름 되묻기 ────────────────────────────────
  await checkAsync("`임창규 어떤 선수야` → 생성 0 · 임찬규 제안", async () => {
    const { result, logs, calls } = await ask("임창규 어떤 선수야");
    assert.equal(result.source, "name_suggest", `source=${result.source}`);
    assert.equal(result.answer, NAME_SUGGEST_ANSWER("임찬규"), result.answer);
    assert.deepEqual(logs, ["name_suggest"]);
    assert.equal(calls.llm, 0, "generic LLM 이 불렸다 — 계약 위반");
    assert.equal(calls.ragLlm, 0, "RAG LLM 이 불렸다");
    assert.equal(calls.cacheRead, 0, "캐시를 읽었다 — 미결속 실명 답을 재사용하면 안 된다");
    assert.equal(calls.cacheWrite, 0, "캐시에 썼다");
    // 유저가 받은 문장에 **없는 사람에 대한 사실**이 하나도 없어야 한다.
    assert.doesNotMatch(result.answer, /주축|선수예요|트윈스의/);
  });

  // ── ② 삼순 P0: 이웃 없는 이름도 생성 0 (1차 구현이 놓친 축) ──────────────
  //   `오타니`(로스터 밖 실존 인물) · `홍길동`(허구) 둘 다 generic LLM 으로 새고 있었다.
  for (const question of [
    "오타니 어떤 선수야",     // 로스터 밖 실존 인물(해외 리그)
    "홍길동 어떤 선수야",     // 완전 허구
    "이승엽 어떤 선수야",     // 은퇴 선수(로스터 없음)
    "이종범 소개해줘",         // 은퇴 선수
    "최동원 어떤 선수야",     // 작고 선수
  ]) {
    await checkAsync(`\`${question}\` → 생성 0 · 모른다고 말한다`, async () => {
      const { result, logs, calls } = await ask(question);
      assert.equal(result.source, "name_suggest", `source=${result.source}`);
      assert.equal(result.answer, NAME_UNKNOWN_ANSWER, result.answer);
      assert.deepEqual(logs, ["name_suggest"]);
      assert.equal(calls.llm, 0, "generic LLM 이 불렸다 — 이게 바로 삼순 P0 였다");
      assert.equal(calls.ragLlm, 0);
      assert.equal(calls.cacheRead, 0);
      assert.equal(calls.cacheWrite, 0);
    });
  }

  // ── ③ 제안은 후보가 **유일**할 때만 ──────────────────────────────────────
  check("`이대호`(후보 3명) 는 아무나 제안하지 않는다", () => {
    const unbound = resolveUnboundName("이대호 어떤 선수야", players);
    assert.notEqual(unbound, null, "미결속 이름으로는 잡혀야 한다(생성은 막는다)");
    assert.equal(unbound?.suggestion, null, `엉뚱한 이름을 제안했다: ${unbound?.suggestion}`);
  });

  // ── ④ quota 반환 — 오타 한 글자에 한도 2개를 물리지 않는다 ────────────────
  await checkAsync("되묻기는 하루 한도를 깎지 않는다", async () => {
    const { result, calls } = await ask("임창규 어떤 선수야");
    assert.equal(calls.quotaReserved, 1, "예약은 일어난다(원자 예약 계약)");
    assert.equal(calls.quotaReleased, 1, "반납이 없다 — 오타에 한도를 물렸다");
    assert.equal(result.remaining, DAILY_LIMIT, `remaining=${result.remaining}`);
  });

  // ── ⑤ 무회귀: 결속된 선수 · 룰 · 구단 ─────────────────────────────────────
  await checkAsync("결속된 선수(`임찬규`)는 그대로 RAG 로 답한다", async () => {
    const { result, calls } = await ask("임찬규 어떤 선수야");
    assert.notEqual(result.source, "name_suggest", "정상 선수를 되물었다");
    assert.equal(calls.ragLlm, 1, "선수 RAG 가 안 불렸다");
  });

  await checkAsync("구단 서술 질문은 team_rag 로 간다", async () => {
    const { result } = await ask("LG트윈스 창단 이야기 알려줘");
    assert.notEqual(result.source, "name_suggest",
      "구단 질문이 이름 되묻기로 샜다 — `이야기`→`이준기` 오탐 회귀");
  });

  check("룰·일반 문장 오탐 0", () => {
    const NON_NAME_QUESTIONS = [
      "홈런 기준이 뭐야 알려줘",
      "심판 판정 기준 알려줘",
      "우천 취소 기준 알려줘",
      "세이프티 신발 어디서 사?",
      "어디서 뛰는지 알려줘",
      "어디서 경기하는지 알려줘",
      "이야기 좀 알려줘",
      "이번 주 일정 알려줘",
      "요즘 어떤 선수 잘해?",
      "무슨 팀이 강해 알려줘",
      "누구 소개해줘",
      "그거 어떤 사람이야",
      "여기 어떤 경기장이야",
      "야구장 어디에 있는지 알려줘",
      "이번에 어떤 규칙 바뀌었어",
      "저번에 어떤 선수 나왔지",
      "우리 팀 어떤 선수 좋아",
      "진짜 어떤 선수가 잘해",
      "그냥 어떤 경기 재밌어",
      "혹시 어떤 규칙인지 알려줘",
    ];
    const misfires = NON_NAME_QUESTIONS
      .map((q) => [q, resolveUnboundName(q, players)] as const)
      .filter(([, u]) => u !== null);
    assert.deepEqual(
      misfires.map(([q, u]) => `${q} → ${u?.token}`),
      [],
      "일반 문장을 사람 이름으로 오인했다",
    );
  });

  // ⚠️ 정직한 한계 — 성씨 결속이라 **현역 로스터에 없는 성씨**는 못 잡는다.
  //   실측: `선동열` — `선` 씨가 현역 881명에 한 명도 없어 이름 후보가 되지 않는다.
  //   이건 게이트가 감추지 않고 **명시해 고정한다** — 나중에 성씨 사전을 별도로 두는
  //   선택을 할 때 이 줄이 근거가 된다(지금 열거하지 않는 이유는 성씨도 열린 부류이기 때문).
  check("한계 명시 — 현역 로스터에 없는 성씨는 못 잡는다", () => {
    const rosterSurnames = new Set(
      players.filter((p) => !/\s/.test(p.name)).map((p) => p.name[0]),
    );
    assert.ok(!rosterSurnames.has("선"), "전제가 바뀌었다 — `선` 씨가 로스터에 생겼다");
    assert.equal(resolveUnboundName("선동열 어떤 선수야", players), null,
      "한계가 변했으면 이 줄을 갱신하고 본문 주석도 고쳐야 한다");
  });

  check("로스터 전원 자기 질문 오탐 0", () => {
    const misfires: string[] = [];
    for (const p of players) {
      if (/\s/.test(p.name)) continue; // 외국인 풀네임은 토큰 비교 대상이 아니다
      const unbound = resolveUnboundName(`${p.name} 어떤 선수야`, players);
      if (unbound !== null) misfires.push(`${p.name} → ${unbound.token}`);
    }
    assert.deepEqual(misfires, [], "로스터에 있는 선수를 미결속으로 판정했다");
  });

  // ── ⑥ 라벨 배선 ──────────────────────────────────────────────────────────
  check("`name_suggest` 는 답변(`answer`)으로 분류되지 않는다", () => {
    // 우리는 아무 사실도 말하지 않았다 — 답변 감사 분자에 들어가면 성공률이 부풀려진다.
    assert.notEqual(MATCH_PATH_REPLY_KIND.name_suggest, "answer");
  });

  check("routeQuestion 이 `name_suggest` 를 돌려준다", () => {
    assert.equal(routeQuestion("임창규 어떤 선수야", GLOSSARY, players), "name_suggest");
    assert.equal(routeQuestion("오타니 어떤 선수야", GLOSSARY, players), "name_suggest");
  });

  console.log(`\n✅ genius-unbound-name PASS (${pass} checks)`);
}

main().catch((error) => {
  console.error("❌ genius-unbound-name FAIL:", error);
  process.exit(1);
});
