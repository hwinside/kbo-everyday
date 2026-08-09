/**
 * 야잘알봇 **입단 연도 결정론 응답** 계약 — 배포 `answerQuestion()` 실행 결과로 검증한다.
 *
 * ⚠️ 이 게이트가 생긴 이유 (2026-08-09 하린아빠 제보, Production 재현)
 *
 *     유저: `임찬규는 LG에 언제 입단했어?`
 *     봇  : (연도를 못 말하고 겉도는 답)
 *
 *   근거에 `2011년 입단` 이 있는데도 못 답했다. 선수 tier2(나무위키) 경로는 숫자 전면
 *   HOLD 이기 때문이다 — 그 HOLD 자체는 옳다(#1110 에서 13커밋 쌓았다 지운 자리).
 *
 * ⚠️ 그래서 **tier2 를 열지 않는다** (삼순 2026-08-09 설계 정정)
 *   KBO 공식 프로필의 `lblDraft`(`11 LG 1라운드 2순위`)는 뜻이 하나뿐인 **구조화 필드**라
 *   "같은 chunk 안 다른 연도(데뷔·이적·FA)와 구분 못 한다" 는 반대가설이 성립하지 않는다.
 *   문장 파싱이 아니라 필드 조회다.
 *
 * 그래서 이 게이트가 보는 것:
 *   (a) 입단 질문에 **공식값 연도**가 나가는가
 *   (b) 그 경로가 `llm`·`ragLlm`·`cache` 를 **한 번도** 부르지 않는가 (생성 0)
 *   (c) 공식값이 없으면 **지어내지 않고** 구체적으로 없다고 말하는가 (fail-close)
 *   (d) 후속 턴(`입단을 언제 했냐고?`)도 직전 선수에 결속돼 같은 값을 주는가
 *   (e) 입단이 **아닌** 질문(데뷔·이적·기록)이 이 경로로 새지 않는가
 *
 * 실행: npm run qa:genius-draft-year
 */
import assert from "node:assert/strict";
import {
  answerQuestion,
  type GlossaryEntry,
  type PlayerRef,
  type QaDeps,
} from "../../src/lib/baseball-qa/pipeline";
import {
  isDraftQuestion,
  parseDraftLabel,
  renderDraftAnswer,
  renderDraftUnavailable,
} from "../../src/lib/baseball-qa/roster/draft";
import { RAG_GROUNDED_SENTINEL } from "../../src/lib/baseball-qa/rag/retrieve";
import { loadRosterPlayers } from "../../src/lib/baseball-qa/roster/load-roster-players";

let pass = 0;
const failures: string[] = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(`${name} :: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`FAIL ${name} :: ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(`${name} :: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`FAIL ${name} :: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const GLOSSARY: GlossaryEntry[] = [
  { term: "보크", aliases: ["보크"], answer: "투수의 부정 투구 동작이에요." },
];

interface Calls {
  llm: number;
  ragLlm: number;
  cacheRead: number;
  cacheWrite: number;
  seasonRecord: number;
}

/**
 * 외부 의존을 전부 카운트한다. 계약이 "공식 필드로 코드가 답한다" 이므로
 * 문구가 맞아도 LLM·RAG·캐시를 한 번이라도 부르면 위반이다.
 *
 * ⚠️ 선수 RAG 를 **켠 채로** 돌린다. 꺼두면 "RAG 가 꺼져서 안 불린 것" 과
 *   "입단 경로가 먼저 종결해서 안 불린 것" 을 구분할 수 없다.
 */
function makeDeps(players: PlayerRef[]): { deps: QaDeps; logs: string[]; calls: Calls } {
  const logs: string[] = [];
  const calls: Calls = { llm: 0, ragLlm: 0, cacheRead: 0, cacheWrite: 0, seasonRecord: 0 };
  const deps = {
    loadGlossary: async () => GLOSSARY,
    loadPlayers: async () => players,
    getCache: async () => { calls.cacheRead += 1; return null; },
    setCache: async () => { calls.cacheWrite += 1; },
    callLlm: async () => {
      calls.llm += 1;
      return {
        text: JSON.stringify({ status: "BASEBALL_RULE_TERM", answer: "아마 2010년쯤일 거예요." }),
        inputTokens: 1, outputTokens: 1,
      };
    },
    enablePlayerRag: true,
    enableTeamRag: true,
    now: () => Date.now(),
    searchRag: async () => [{
      // ⚠️ 근거에 **다른 연도**를 일부러 섞어 둔다. 공식 필드가 아니라 이 문장을 읽으면
      //   틀린 연도가 나가고, 그게 이 PR 이 피하려는 실패다.
      content: "임찬규는 2010년 청소년 대표를 거쳐 프로에 왔고 2015년 선발로 자리잡았다고 알려져 있다.",
      pageTitle: "임찬규", canonicalUrl: "https://namu.wiki/w/임찬규",
      revision: "1", sectionPath: "선수 경력", asOf: "2026-01-01", sourceGrade: "tier2",
    }],
    callRagLlm: async () => {
      calls.ragLlm += 1;
      return {
        text: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "프랜차이즈 투수예요." }),
        inputTokens: 1, outputTokens: 1,
      };
    },
    // ⚠️ 계약상 **배열**이다. null 을 주면 파이프라인이 터져 게이트가 '결함'이 아니라
    //   '하네스 버그'로 죽는다(실측). 빈 배열 = 기록 없음.
    fetchSeasonRecord: async () => { calls.seasonRecord += 1; return []; },
    reserveDaily: async (_userId: string, limit: number) => ({ allowed: true, remaining: limit - 1 }),
    releaseDaily: async () => {},
    log: async (entry: { matchPath: string }) => { logs.push(entry.matchPath); },
  } as unknown as QaDeps;
  return { deps, logs, calls };
}

async function main() {
  const players = await loadRosterPlayers();
  assert.ok(players.length > 100, `로스터가 ${players.length}명뿐이다 — SSOT 유실`);

  const ask = async (question: string, override?: PlayerRef[]) => {
    const { deps, logs, calls } = makeDeps(override ?? players);
    const result = await answerQuestion("u-draft", question, deps);
    return { result, logs, calls };
  };

  // ── 전제: 공식값이 실제로 로스터에 실려 있다 ─────────────────────────────────
  //   이게 없으면 아래 테스트는 "값이 없어서" 통과하는 것과 구분되지 않는다.
  const chanGyu = players.find((player) => player.kboId === "61101");
  check("전제: 임찬규(61101) 공식 입단 정보가 로스터에 있다", () => {
    assert.ok(chanGyu, "임찬규가 로스터에 없다");
    const draft = parseDraftLabel(chanGyu?.draft);
    assert.ok(draft, `입단 정보가 파싱되지 않는다: ${JSON.stringify(chanGyu?.draft)}`);
    assert.equal(draft?.year, 2011, `연도=${draft?.year}`);
    assert.equal(draft?.team, "LG", `구단=${draft?.team}`);
  });

  check("로스터 전체 입단 정보 적재율 — 국내 선수 대부분에 값이 있다", () => {
    const domestic = players.filter((player) => /^\d+$/.test(player.kboId));
    const withValue = domestic.filter((player) => parseDraftLabel(player.draft) !== null);
    // 실측 846/847. 배선이 끊기면 이 수치가 급락하므로 하한을 둔다.
    assert.ok(
      withValue.length >= domestic.length * 0.9,
      `적재율이 낮다: ${withValue.length}/${domestic.length} — 백필/배선이 끊겼다`,
    );
  });

  // ── ① 직접 질문 → 공식 연도, 생성 0 ─────────────────────────────────────────
  for (const question of [
    "임찬규는 LG에 언제 입단했어?",
    "임찬규 입단 연도 알려줘",
    "임찬규 몇 라운드 지명이야?",
  ]) {
    await checkAsync(`\`${question}\` → 2011년 · 생성 0`, async () => {
      const { result, logs, calls } = await ask(question);
      assert.equal(result.source, "kbo_structured", `source=${result.source}`);
      assert.match(result.answer, /2011년/, result.answer);
      assert.match(result.answer, /LG/, result.answer);
      assert.deepEqual(logs, ["kbo_structured"]);
      assert.equal(calls.llm, 0, "generic LLM 이 불렸다 — 공식값 경로가 아니다");
      assert.equal(calls.ragLlm, 0, "RAG LLM 이 불렸다 — tier2 문장을 읽으면 안 된다");
      assert.equal(calls.cacheRead, 0, "캐시를 읽었다");
      assert.equal(calls.cacheWrite, 0, "캐시에 썼다");
      // 근거에 섞어둔 다른 연도가 새어나오면 안 된다.
      assert.doesNotMatch(result.answer, /2010년|2015년/, `tier2 연도가 새어나왔다: ${result.answer}`);
    });
  }

  // ── ② 공식값이 없으면 지어내지 않는다 (fail-close) ──────────────────────────
  await checkAsync("공식 입단 정보가 없으면 구체적으로 없다고 말한다", async () => {
    const stripped = players.map((player) =>
      player.kboId === "61101" ? { ...player, draft: "" } : player
    );
    const { result, logs, calls } = await ask("임찬규는 LG에 언제 입단했어?", stripped);
    assert.equal(result.source, "blocked", `source=${result.source}`);
    assert.equal(result.answer, renderDraftUnavailable("임찬규"), result.answer);
    assert.deepEqual(logs, ["blocked"]);
    assert.equal(calls.llm, 0, "값이 없다고 LLM 에 물으면 그게 환각 경로다");
    assert.equal(calls.ragLlm, 0);
    // 연도를 한 글자도 말하면 안 된다.
    assert.doesNotMatch(result.answer, /\d{4}년/, `없는 연도를 말했다: ${result.answer}`);
  });

  await checkAsync("아직 안 긁은 선수(undefined)도 같은 fail-close", async () => {
    const stripped = players.map((player) => {
      if (player.kboId !== "61101") return player;
      const copy = { ...player };
      delete (copy as { draft?: string }).draft;
      return copy;
    });
    const { result, calls } = await ask("임찬규 입단 연도 알려줘", stripped);
    assert.equal(result.source, "blocked", `source=${result.source}`);
    assert.doesNotMatch(result.answer, /\d{4}년/);
    assert.equal(calls.llm, 0);
  });

  // ── ③ 입단이 아닌 질문은 이 경로로 새지 않는다 ──────────────────────────────
  //   `lblDraft` 는 데뷔·이적·FA 를 담지 않는다. 그 질문에 입단 연도를 주면 오답이다.
  for (const question of [
    "임찬규 언제 데뷔했어?",
    "임찬규 어떤 선수야",
    "임찬규 올해 방어율 얼마야",
  ]) {
    await checkAsync(`\`${question}\` → 입단 경로로 새지 않는다`, async () => {
      const { result } = await ask(question);
      assert.doesNotMatch(
        result.answer, /입단했어요/,
        `입단이 아닌 질문에 입단 답을 줬다: ${result.answer}`,
      );
    });
  }

  // ── ④ 파서 단위 계약 ───────────────────────────────────────────────────────
  check("공식 표기 실측 3종을 정확히 읽는다", () => {
    assert.deepEqual(parseDraftLabel("11 LG 1라운드 2순위"), { year: 2011, team: "LG" });
    assert.deepEqual(parseDraftLabel("22 KIA 1차"), { year: 2022, team: "KIA" });
    assert.deepEqual(parseDraftLabel("13 NC 특별 20순위"), { year: 2013, team: "NC" });
  });

  check("형식을 벗어나면 null — 부분 성공을 만들지 않는다", () => {
    for (const raw of ["", "   ", "자유선발", "9 두산 2차", "LG 1라운드", null, undefined]) {
      assert.equal(parseDraftLabel(raw), null, `null 이어야 한다: ${JSON.stringify(raw)}`);
    }
  });

  check("두 자리 연도는 KBO 출범(1982) 기준으로 유일하게 결정된다", () => {
    // 82~99 = 19xx, 00~81 = 20xx. 겹치는 해가 없다.
    assert.equal(parseDraftLabel("82 삼성 1차")?.year, 1982);
    assert.equal(parseDraftLabel("99 두산 2차")?.year, 1999);
    assert.equal(parseDraftLabel("00 LG 1차")?.year, 2000);
    assert.equal(parseDraftLabel("26 한화 2라운드 13순위")?.year, 2026);
  });

  check("입단 질문 판정은 좁게 — 데뷔·이적·FA 는 아니다", () => {
    for (const q of ["임찬규 입단 연도", "몇 라운드 지명이야", "드래프트 언제야", "지명순위 알려줘"]) {
      assert.equal(isDraftQuestion(q), true, q);
    }
    for (const q of ["임찬규 언제 데뷔했어", "임찬규 이적했어?", "임찬규 FA 언제야", "임찬규 방어율"]) {
      assert.equal(isDraftQuestion(q), false, `입단 질문이 아닌데 true: ${q}`);
    }
  });

  check("렌더 문장은 공식 표기 구단명을 그대로 쓴다", () => {
    // 입단 당시 구단과 현재 구단이 다를 수 있다(이적). 우리 표기로 옮기면 사실이 바뀐다.
    assert.equal(
      renderDraftAnswer("임찬규", { year: 2011, team: "LG" }),
      "임찬규 선수는 2011년에 LG에 입단했어요.",
    );
  });

  if (failures.length > 0) {
    console.error(`\n❌ genius-draft-year FAIL (${failures.length}건):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`\n✅ genius-draft-year PASS (${pass} checks)`);
}

main().catch((error) => {
  console.error("❌ genius-draft-year FAIL:", error);
  process.exit(1);
});
