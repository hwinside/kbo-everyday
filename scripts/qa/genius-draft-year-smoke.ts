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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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
  { term: "보크", aliases: ["보크"], answer: "투수의 부정 투구 동작입니다." },
];

interface Calls {
  llm: number;
  ragLlm: number;
  cacheRead: number;
  cacheWrite: number;
  seasonRecord: number;
  previousTurn: number;
}

/**
 * 직전 턴 fixture — `answeredAt < currentCreatedAt`, TTL 안.
 *
 * ⚠️ jobSource 기본값은 **실경로 값**이다(삼순 2026-08-09 P0-2). 선수 질문의 실제 직전
 *   답은 서술형이면 `rag`, 기록·입단 직접답이면 `kbo_structured` 다. 종전 smoke 는
 *   `"llm"` 으로 바꿔 끼워서 allowlist 불일치를 못 보는 false-green 이었다.
 */
function previousTurnRow(question: string, jobSource = "rag") {
  const now = Date.now();
  return {
    question,
    answer: "임찬규는 LG 트윈스의 프랜차이즈 투수입니다.",
    jobSource,
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
        text: JSON.stringify({ status: "BASEBALL_RULE_TERM", answer: "아마 2010년쯤일 것입니다." }),
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
        text: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "프랜차이즈 투수입니다." }),
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
        result.answer, /입단했습니다/,
        `입단이 아닌 질문에 입단 답을 줬다: ${result.answer}`,
      );
    });
  }

  // ── ③-b 🔴 2턴 후속: 이름 없는 입단 질문은 직전 턴에서 선수를 받는다 (삼순 P0-2) ──
  // 실경로 소스 2종 — Q1 이 서술형(rag)이든 기록·입단 직접답(kbo_structured)이든 이어져야 한다.
  for (const jobSource of ["rag", "kbo_structured"]) {
    await checkAsync(`입단을 언제 했냐고? (직전 source=${jobSource}) → 직전 턴 선수에 결속돼 2011년`, async () => {
      const { result, logs, calls } = await ask(
        "입단을 언제 했냐고?", undefined, previousTurnRow("임찬규 어떤 선수야", jobSource),
      );
      assert.equal(calls.previousTurn, 1, "직전 턴을 조회하지 않았다 — 후속이 열리지 않았다");
      assert.equal(result.source, "kbo_structured", `source=${result.source}`);
      assert.match(result.answer, /임찬규/, result.answer);
      assert.match(result.answer, /2011년/, result.answer);
      assert.deepEqual(logs, ["kbo_structured"]);
      assert.equal(calls.llm, 0, "generic LLM 이 불렸다");
      assert.equal(calls.ragLlm, 0, "RAG LLM 이 불렸다");
    });
  }

  // draft 전용 allowlist 는 **딱 두 값만** 넓힌다 — team_rag·news_rag·blocked 는 부적격.
  //   (allowlist 확대 mutation 이 이 반례로 RED 가 된다)
  for (const jobSource of ["team_rag", "news_rag", "blocked"]) {
    await checkAsync(`직전 source=${jobSource} 는 입단 후속 자격이 없다 (fail-close)`, async () => {
      const { result, calls } = await ask(
        "입단을 언제 했냐고?", undefined, previousTurnRow("임찬규 어떤 선수야", jobSource),
      );
      assert.equal(calls.previousTurn, 1, "조회는 시도해야 한다");
      assert.notEqual(result.source, "kbo_structured", `부적격 소스로 답했다: ${result.answer}`);
      assert.doesNotMatch(result.answer, /2011년/, `부적격 소스에서 연도가 나왔다: ${result.answer}`);
    });
  }

  // TTL 만료 직전 턴은 자격이 없다 — draft 전용 selector 도 B5 barrier 를 그대로 지킨다.
  await checkAsync("TTL 만료 직전 턴은 입단 후속 자격이 없다", async () => {
    const now = Date.now();
    const stale = {
      ...previousTurnRow("임찬규 어떤 선수야", "rag"),
      answeredAt: new Date(now - 600_001).toISOString(),
      currentCreatedAt: new Date(now).toISOString(),
    };
    const { result } = await ask("입단을 언제 했냐고?", undefined, stale);
    assert.doesNotMatch(result.answer, /2011년/, `만료 맥락으로 답했다: ${result.answer}`);
  });

  // ── 과결속 차단(삼순 2026-08-09): "이름을 못 풀었다" 는 후속의 근거가 아니다 ──
  //   이름 없는 일반 질문·복수 이름·동명이인은 직전 선수로 새면 안 된다.
  for (const question of [
    "KBO 드래프트 언제야?",                    // 무지칭 일반 질문 — 되묻기 문법 없음
    "임찬규랑 김도영 중에 누가 먼저 입단했어?", // 복수 이름 — 명시 엔티티 ≥1
  ]) {
    await checkAsync(`${question} → 직전 선수로 새지 않는다`, async () => {
      const { result, calls } = await ask(
        question, undefined, previousTurnRow("박병호 어떤 선수야", "rag"),
      );
      assert.doesNotMatch(result.answer, /박병호/, `직전 선수로 샜다: ${result.answer}`);
      if (question.startsWith("KBO")) {
        // 2026-08-10 구조 변경: 직전 턴은 **항상** 로드된다(LLM 위임 — 관련성 판단은
        // 프롬프트 몫). 그래서 계약은 "조회 0회"가 아니라 **재결속 0**이다 — 무지칭
        // 일반 질문이 직전 선수의 확정 입단 문장(kbo_structured)으로 새지 않아야 한다.
        assert.equal(calls.previousTurn, 1, "상시 로드 구조에서 조회는 1회다");
        assert.notEqual(result.source, "kbo_structured", `무지칭 질문이 직전 선수로 결속됐다: ${result.answer}`);
      }
    });
  }

  await checkAsync("직전 턴이 없으면 입단 후속에 답하지 않는다 (fail-close)", async () => {
    const { result, calls } = await ask("입단을 언제 했냐고?", undefined, null);
    assert.notEqual(result.source, "kbo_structured", `근거 없이 답했다: ${result.answer}`);
    assert.doesNotMatch(result.answer, /\d{4}년에/, `연도를 지어냈다: ${result.answer}`);
    assert.equal(calls.previousTurn, 1, "조회는 시도해야 한다");
  });

  await checkAsync("직전 턴의 **답변**이 아니라 **질문**에서 선수를 푼다", async () => {
    // 답변에 다른 선수가 섞여 있어도 질문의 선수(김도영)로 결속돼야 한다.
    const turn = previousTurnRow("김도영 어떤 선수야");
    turn.answer = "김도영은 임찬규와 자주 비교되는 타자입니다.";
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
    // ⚠️ "키움에 입단한 건 아니에요" 는 과단정이다(삼순) — draft 필드는 최초 지명만 증명하고
    //   이후 이적 합류를 부정할 수 없다. 확인 불가 범위를 그대로 말해야 한다.
    assert.match(result.answer, /키움 합류 시점은 공식 입단\(최초 지명\) 기록으로는 확인할 수 없습니다/, `구단 불일치 안내가 없다: ${result.answer}`);
    assert.doesNotMatch(result.answer, /입단한 건 아니에요/, `이적 합류까지 부정하는 과단정: ${result.answer}`);
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
    // ⚠️ 순위류 단독은 드래프트가 아니다(삼순 P0-3) — `지금 몇 순위`는 현재 성적 얘기다.
    for (const q of ["임찬규 지금 몇 순위야?", "LG 몇 순위야", "몇 라운드까지 해?", "지명타자 순위 알려줘"]) {
      assert.equal(isDraftQuestion(q), false, `순위류 단독인데 드래프트로 오판: ${q}`);
    }
  });

  // ── 순위류 단독 종단 반례 — 입단 경로로 새지 않는다 ──────────────────────────
  await checkAsync("`임찬규 지금 몇 순위야?` → 입단 답이 아니다", async () => {
    const { result } = await ask("임찬규 지금 몇 순위야?");
    assert.doesNotMatch(result.answer, /입단했습니다/, `현재 순위 질문에 입단 답: ${result.answer}`);
    assert.doesNotMatch(result.answer, /2011년/, `현재 순위 질문에 입단 연도: ${result.answer}`);
  });

  // ── 동명이인은 직전 턴으로도, 추측으로도 새지 않는다 ─────────────────────────
  await checkAsync("동명이인 이름 입단 질문 → 직전 선수로 새지 않는다", async () => {
    const dupPlayers: PlayerRef[] = [
      ...players,
      { kboId: "90001", name: "이승현", team: "삼성", position: "투수", backNo: "1" },
      { kboId: "90002", name: "이승현", team: "롯데", position: "투수", backNo: "2" },
    ];
    // ⚠️ 되묻기 어미(했냐고)를 일부러 싣는다 — 문법 축이 아니라 **명시 이름 차단**이
    //   이 반례의 유일한 방어축이 되게 해서, 그 축 제거 mutation(D-M)이 여기서 RED 가 난다.
    const { result, calls } = await ask(
      "이승현 입단 언제 했냐고?", dupPlayers, previousTurnRow("임찬규 어떤 선수야", "rag"),
    );
    // 명시 이름이 있으므로(모호할 뿐) 직전 선수(임찬규)로 결속되면 안 된다.
    assert.doesNotMatch(result.answer, /임찬규/, `동명이인이 직전 선수로 샜다: ${result.answer}`);
    assert.doesNotMatch(result.answer, /2011년/, result.answer);
  });

  // ── 지속 결속(삼순 2026-08-09): 상시 크롤·신규 온보딩에서 draft 가 살아남는 배선 ──
  //   ① exact key-set — 90% 게이트는 수십 키가 빠져도 GREEN 이라 검출력이 없다.
  //      roster 숫자 kboId 전원이 draft 파일에 **정확히** 있고, 고아 키도 없어야 한다.
  check("exact key-set: roster 숫자 kboId ↔ players-draft.json 키가 정확히 일치", () => {
    const rosterRaw = JSON.parse(readFileSync(join(ROOT, "src/lib/constants/players-roster.json"), "utf8")) as Array<{ kboId: string | number }>;
    const draftRaw = JSON.parse(readFileSync(join(ROOT, "src/lib/constants/players-draft.json"), "utf8")) as Record<string, string>;
    const numericIds = new Set(rosterRaw.map((r) => String(r.kboId)).filter((id) => /^\d+$/.test(id)));
    const draftKeys = new Set(Object.keys(draftRaw));
    const missing = [...numericIds].filter((id) => !draftKeys.has(id));
    const orphan = [...draftKeys].filter((id) => !numericIds.has(id));
    assert.equal(missing.length, 0, `draft 미수집 키 ${missing.length}건: ${missing.slice(0, 5).join(",")}`);
    assert.equal(orphan.length, 0, `roster 에 없는 고아 키 ${orphan.length}건: ${orphan.slice(0, 5).join(",")}`);
    // 값 형태도 계약이다 — undefined 는 이 파일에 존재할 수 없고, 문자열만 허용된다.
    for (const [key, value] of Object.entries(draftRaw)) {
      assert.equal(typeof value, "string", `${key} 값이 문자열이 아니다: ${typeof value}`);
    }
  });

  //   ② 배선 존재 — reconcile 이 신규 선수 draft 를 기록하고, workflow 가 backfill 을 돌리고
  //      allowlist·roster scope 에 draft 파일이 있어야 다음 자동 PR 에서 소실되지 않는다.
  //      (existence 검사지만, 이 배선이 빠지면 exact key-set 이 다음 크롤에서 RED 가 되므로
  //       두 게이트가 서로를 보완한다 — 문구가 아니라 소실 경로를 각각 닫는 축이다.)
  check("지속 배선: reconcile draft 기록 + workflow backfill·allowlist 결속", () => {
    const reconcile = readFileSync(join(ROOT, "scripts/reconcile-roster-from-stats.mjs"), "utf8");
    assert.match(reconcile, /players-draft\.json/, "reconcile 이 draft 파일을 모른다");
    assert.match(reconcile, /draftAdditions\[String\(m\.kboId\)\] = detail\.draft\.trim\(\)/, "reconcile 신규 온보딩 draft 기록이 없다");
    const workflow = readFileSync(join(ROOT, ".github/workflows/update-roster-stats.yml"), "utf8");
    assert.match(workflow, /backfill-roster-draft\.mjs/, "workflow 에 backfill 스텝이 없다");
    const allowlistLine = workflow.split("\n").find((line) => line.includes("ALLOWLIST_RE="));
    assert.ok(allowlistLine?.includes("players-draft\\.json"), "생성 allowlist 에 draft 파일이 없다 — 자동 PR 보류된다");
    const scopeLine = workflow.split("\n").find((line) => line.includes("ROSTER_SCOPE_RE="));
    assert.ok(scopeLine?.includes("players-draft\\.json"), "roster scope 에 draft 파일이 없다 — 자동 머지 보류된다");
    const backfill = readFileSync(join(ROOT, "scripts/backfill-roster-draft.mjs"), "utf8");
    // 주석이 아니라 **코드 실체**에 결속한다 — 문자열만 남고 로직이 죽으면 잡아야 한다.
    assert.match(backfill, /return draft === null \? \{ kind: "markup_drift" \}/, "backfill markup drift fail-close 가 없다");
    assert.doesNotMatch(backfill, /lblDraft"\) \?\? ""/, "selector 미검출을 공식 빈값으로 확정하는 ?? \"\" 가 남아 있다");
  });

  check("렌더 문장은 공식 표기 구단명을 그대로 쓴다", () => {
    // 입단 당시 구단과 현재 구단이 다를 수 있다(이적). 우리 표기로 옮기면 사실이 바뀐다.
    assert.equal(
      renderDraftAnswer("임찬규", { year: 2011, team: "LG", detail: "1라운드 2순위" }),
      "임찬규 선수는 2011년에 LG에 입단했습니다.",
    );
    assert.equal(
      renderDraftAnswer("임찬규", { year: 2011, team: "LG", detail: "1라운드 2순위" }, { wantsDetail: true }),
      "임찬규 선수는 2011년 LG 1라운드 2순위로 입단했습니다.",
    );
    // ⚠️ 과단정 금지(삼순 2026-08-09): draft 필드는 최초 지명만 증명한다 — 이후 이적
    //   합류를 부정하면 안 된다. 확인 불가 범위를 그대로 말한다.
    const mismatch = renderDraftAnswer("박병호", { year: 2005, team: "LG", detail: "1차" }, { askedTeam: "키움" });
    assert.match(mismatch, /키움 합류 시점은 공식 입단\(최초 지명\) 기록으로는 확인할 수 없습니다/);
    assert.doesNotMatch(mismatch, /입단한 것은 아닙니다/);
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
