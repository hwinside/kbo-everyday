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
  asksDraftDetail,
  draftUnavailableReason,
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
  previousTurn: number;
}

/** 직전 턴 fixture — `answeredAt < currentCreatedAt`, TTL 안, source allowlist 안. */
function previousTurnRow(question: string) {
  const now = Date.now();
  return {
    question,
    answer: "임찬규는 LG 트윈스의 프랜차이즈 투수예요.",
    jobSource: "llm",
    answeredAt: new Date(now - 5_000).toISOString(),
    currentCreatedAt: new Date(now).toISOString(),
  };
}

/**
 * 외부 의존을 전부 카운트한다. 계약이 "공식 필드로 코드가 답한다" 이므로
 * 문구가 맞아도 LLM·RAG·캐시를 한 번이라도 부르면 위반이다.
 *
 * ⚠️ 선수 RAG 를 **켠 채로** 돌린다. 꺼두면 "RAG 가 꺼져서 안 불린 것" 과
 *   "입단 경로가 먼저 종결해서 안 불린 것" 을 구분할 수 없다.
 */
function makeDeps(
  players: PlayerRef[],
  previousTurn: ReturnType<typeof previousTurnRow> | null = null,
): { deps: QaDeps; logs: string[]; calls: Calls } {
  const logs: string[] = [];
  const calls: Calls = {
    llm: 0, ragLlm: 0, cacheRead: 0, cacheWrite: 0, seasonRecord: 0, previousTurn: 0,
  };
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
    loadPreviousTurn: async () => { calls.previousTurn += 1; return previousTurn; },
    reserveDaily: async (_userId: string, limit: number) => ({ allowed: true, remaining: limit - 1 }),
    releaseDaily: async () => {},
    log: async (entry: { matchPath: string }) => { logs.push(entry.matchPath); },
  } as unknown as QaDeps;
  return { deps, logs, calls };
}

async function main() {
  const players = await loadRosterPlayers();
  assert.ok(players.length > 100, `로스터가 ${players.length}명뿐이다 — SSOT 유실`);

  const ask = async (
    question: string,
    override?: PlayerRef[],
    previousTurn: ReturnType<typeof previousTurnRow> | null = null,
  ) => {
    const { deps, logs, calls } = makeDeps(override ?? players, previousTurn);
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
    // `""` = 공식이 빈값으로 준 것 → "공식에 등록 없음"
    assert.equal(result.answer, renderDraftUnavailable("임찬규", "not_registered"), result.answer);
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
    // ⚠️ `undefined`(우리가 아직 안 긁음)를 "공식에 없다" 고 하면 우리 수집 누락을
    //   KBO 탓으로 돌리는 거짓 진술이 된다(삼순 2026-08-09).
    assert.equal(result.answer, renderDraftUnavailable("임찬규", "not_collected"), result.answer);
    assert.doesNotMatch(result.answer, /공식 기록에 등록돼 있지 않아/, result.answer);
    assert.doesNotMatch(result.answer, /\d{4}년/);
    assert.equal(calls.llm, 0);
  });

  // ── ②-c 🔴 미래 연도는 데이터 오류다 — 확정 문장으로 내보내지 않는다 ─────────
  check("미래 연도는 받지 않는다 (현재 연도 + 1 까지)", () => {
    const now = new Date("2026-08-09T00:00:00.000Z");
    // 신인 드래프트는 전년도 가을에 열려 이듬해 입단으로 표기된다 — +1 은 정상.
    assert.equal(parseDraftLabel("26 한화 2라운드 13순위", now)?.year, 2026);
    assert.equal(parseDraftLabel("27 한화 2라운드", now)?.year, 2027);
    // 그 너머는 오류다.
    for (const raw of ["28 한화 1차", "55 LG 1차", "81 두산 1차"]) {
      assert.equal(parseDraftLabel(raw, now), null, `미래 연도를 받았다: ${raw}`);
    }
    // 1982 미만도 없다 (KBO 출범 전).
    assert.equal(parseDraftLabel("81 삼성 1차", now), null);
    assert.equal(parseDraftLabel("82 삼성 1차", now)?.year, 1982);
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

  // ── ③-b 🔴 2턴 후속: 이름 없는 입단 질문은 직전 턴에서 선수를 받는다 (삼순 P0-2) ──
  await checkAsync("`입단을 언제 했냐고?` → 직전 턴 선수에 결속돼 2011년", async () => {
    const { result, logs, calls } = await ask(
      "입단을 언제 했냐고?", undefined, previousTurnRow("임찬규 어떤 선수야"),
    );
    assert.equal(calls.previousTurn, 1, "직전 턴을 조회하지 않았다 — 후속이 열리지 않았다");
    assert.equal(result.source, "kbo_structured", `source=${result.source}`);
    assert.match(result.answer, /임찬규/, result.answer);
    assert.match(result.answer, /2011년/, result.answer);
    assert.deepEqual(logs, ["kbo_structured"]);
    assert.equal(calls.llm, 0, "generic LLM 이 불렸다");
    assert.equal(calls.ragLlm, 0, "RAG LLM 이 불렸다");
  });

  await checkAsync("직전 턴이 없으면 입단 후속에 답하지 않는다 (fail-close)", async () => {
    const { result, calls } = await ask("입단을 언제 했냐고?", undefined, null);
    assert.notEqual(result.source, "kbo_structured", `근거 없이 답했다: ${result.answer}`);
    assert.doesNotMatch(result.answer, /\d{4}년에/, `연도를 지어냈다: ${result.answer}`);
    assert.equal(calls.previousTurn, 1, "조회는 시도해야 한다");
  });

  await checkAsync("직전 턴의 **답변**이 아니라 **질문**에서 선수를 푼다", async () => {
    // 답변에 다른 선수가 섞여 있어도 질문의 선수(김도영)로 결속돼야 한다.
    const turn = previousTurnRow("김도영 어떤 선수야");
    turn.answer = "김도영은 임찬규와 자주 비교되는 타자예요.";
    const { result } = await ask("입단을 언제 했냐고?", undefined, turn);
    assert.match(result.answer, /김도영/, `엉뚱한 선수로 결속됐다: ${result.answer}`);
    assert.doesNotMatch(result.answer, /임찬규/, result.answer);
  });

  // ── ③-c 🔴 질의 구단 ≠ 입단 구단이면 오해를 남기지 않는다 (삼순 P0-3) ────────
  await checkAsync("`박병호는 키움에 언제 입단?` → LG 입단 사실 + 키움 아님 명시", async () => {
    const { result } = await ask("박병호는 키움에 언제 입단했어?");
    assert.match(result.answer, /2005년/, result.answer);
    assert.match(result.answer, /LG/, result.answer);
    // 이 문장이 없으면 유저는 "키움에 2005년 입단" 으로 읽는다.
    assert.match(result.answer, /키움에 입단한 건 아니에요/, `구단 불일치를 숨겼다: ${result.answer}`);
  });

  await checkAsync("질의 구단과 입단 구단이 같으면 군더더기를 붙이지 않는다", async () => {
    const { result } = await ask("임찬규는 LG에 언제 입단했어?");
    assert.doesNotMatch(result.answer, /아니에요/, result.answer);
  });

  // ── ③-d 🔴 순번을 물으면 순번을 답한다 (연도만 주면 동문서답) ────────────────
  await checkAsync("`몇 라운드 지명이야?` → 라운드·순위가 답에 있다", async () => {
    const { result } = await ask("임찬규 몇 라운드 지명이야?");
    assert.equal(result.source, "kbo_structured", `source=${result.source}`);
    assert.match(result.answer, /1라운드/, `라운드를 답하지 않았다: ${result.answer}`);
    assert.match(result.answer, /2순위/, `순위를 답하지 않았다: ${result.answer}`);
  });

  await checkAsync("연도만 물으면 순번을 덧붙이지 않는다", async () => {
    const { result } = await ask("임찬규 입단 연도 알려줘");
    assert.doesNotMatch(result.answer, /라운드/, result.answer);
  });

  // ── ④ 파서 단위 계약 ───────────────────────────────────────────────────────
  check("공식 표기 실측 3종을 정확히 읽는다", () => {
    assert.deepEqual(parseDraftLabel("11 LG 1라운드 2순위"), { year: 2011, team: "LG", detail: "1라운드 2순위" });
    assert.deepEqual(parseDraftLabel("22 KIA 1차"), { year: 2022, team: "KIA", detail: "1차" });
    assert.deepEqual(parseDraftLabel("13 NC 특별 20순위"), { year: 2013, team: "NC", detail: "특별 20순위" });
    assert.deepEqual(parseDraftLabel("24 두산 육성선수"), { year: 2024, team: "두산", detail: "육성선수" });
  });

  check("형식을 벗어나면 null — 부분 성공을 만들지 않는다", () => {
    // ⚠️ `05`·`05 ` 는 **구단 없이 연도만** 있는 형태다. 이걸 받으면 "2005년에 에
    //   입단했어요" 같은 반쪽 문장이 나간다 — 부분 성공 금지의 유일한 증거다.
    for (const raw of ["", "   ", "자유선발", "9 두산 2차", "LG 1라운드", "05", "05 ", "05 1라운드", null, undefined]) {
      assert.equal(parseDraftLabel(raw), null, `null 이어야 한다: ${JSON.stringify(raw)}`);
    }
  });

  check("두 자리 연도는 KBO 출범(1982) 기준으로 유일하게 결정된다", () => {
    // 82~99 = 19xx, 00~81 = 20xx. 겹치는 해가 없다.
    const now = new Date("2026-08-09T00:00:00.000Z");
    assert.equal(parseDraftLabel("82 삼성 1차", now)?.year, 1982);
    assert.equal(parseDraftLabel("99 두산 2차", now)?.year, 1999);
    assert.equal(parseDraftLabel("00 LG 1차", now)?.year, 2000);
    assert.equal(parseDraftLabel("26 한화 2라운드 13순위", now)?.year, 2026);
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
      renderDraftAnswer("임찬규", { year: 2011, team: "LG", detail: "1라운드 2순위" }),
      "임찬규 선수는 2011년에 LG에 입단했어요.",
    );
    assert.equal(
      renderDraftAnswer("임찬규", { year: 2011, team: "LG", detail: "1라운드 2순위" }, { wantsDetail: true }),
      "임찬규 선수는 2011년 LG 1라운드 2순위로 입단했어요.",
    );
    assert.match(
      renderDraftAnswer("박병호", { year: 2005, team: "LG", detail: "1차" }, { askedTeam: "키움" }),
      /키움에 입단한 건 아니에요/,
    );
  });

  check("순번 질문 판정", () => {
    for (const q of ["몇 라운드야", "지명순위 알려줘", "몇 순위로 뽑혔어", "몇 번째 지명"]) {
      assert.equal(asksDraftDetail(q), true, q);
    }
    for (const q of ["입단 연도 알려줘", "언제 입단했어"]) {
      assert.equal(asksDraftDetail(q), false, `순번 질문이 아닌데 true: ${q}`);
    }
  });

  check("미수집(undefined)과 미등록(\"\")을 구분한다", () => {
    assert.equal(draftUnavailableReason(undefined), "not_collected");
    assert.equal(draftUnavailableReason(null), "not_collected");
    assert.equal(draftUnavailableReason(""), "not_registered");
    assert.equal(draftUnavailableReason("11 LG 1차"), "not_registered");
    assert.notEqual(
      renderDraftUnavailable("X", "not_collected"),
      renderDraftUnavailable("X", "not_registered"),
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
