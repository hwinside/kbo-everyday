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
const failures: string[] = [];

/**
 * ⚠️ **첫 실패에서 멈추지 않는다** (2026-08-09 mutation runner 가 드러낸 결손).
 *
 *   종전엔 assert 가 throw 하면 프로세스가 즉시 죽었다. 그러면 mutation 이 **목표 축과
 *   무관한 앞쪽 assertion** 에서 먼저 걸려, "게이트가 이 결함을 잡았다" 를 증명할 수 없다.
 *   실측: 성씨 결속(N-F)을 지웠는데 `임창규` 케이스가 먼저 깨져 죽었다 — 성씨 축이
 *   RED 인지 아닌지 알 수 없는 상태.
 *
 *   그래서 전건을 끝까지 돌려 **깨진 assertion 을 전부 모아** 출력한다. mutation runner 는
 *   그중 **자기가 기대한 문구**가 있는지로 판정한다(nonzero exit 만으로는 부족하다 —
 *   컴파일 오류로 죽은 것과 구분되지 않는다).
 */
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
  //
  // ⚠️ `잘해?`·`주축 맞아?` 형태를 반드시 포함한다 (삼순 2026-08-08 P0-1).
  //   이것들은 `별명`·`어떤 선수` 같은 서술 allowlist 에 없어 직전 구현에서
  //   **그대로 generic LLM 으로 샐다** — 하린아빠 제보와 가장 가까운 형태인데 뚚렸다.
  //   `임창규는 …` 은 조사 붙은 형태로, **같은 제안**이 나와야 한다(P0-2 핵 우선 판정).
  for (const [question, label] of [
    ["임창규 어떤 선수야", "사람 명사 anchor · 하린아빠 제보 원형"],
    ["임창규는 어느 팀이야", "주격조사 anchor · 핵 우선 판정"],
    ["임창규 lg 주축 맞아?", "구단 anchor · 평가 술어(사람 신호 아님)"],
    ["임창규 소개해줘", "사람 명사 anchor"],
    // ⚠️ 담화 표지가 앞에 붙은 형태 — 군말(닫힌 부류)만 건너뛴다.
    //   건너뛰기를 지우면 `혹시` 가 머리를 차지해 그대로 generic LLM 으로 샌다.
    //   문장 전체 스캔으로 대신하면 한국어 용언(`나왔지`·`우승한`)이 이름으로 먹힌다.
    ["혹시 임창규 어떤 선수야", "담화 표지 뒤 · 첫 어절 아님"],
    ["그 임창규 어떤 선수야", "담화 표지(지시관형사) 뒤"],
  ] as const) {
    await checkAsync(`\`${question}\` → 생성 0 · 임찬규 제안 (${label})`, async () => {
      const { result, logs, calls } = await ask(question);
      assert.equal(result.source, "name_suggest", `source=${result.source}`);
      // ⚠️ 조사가 붙어도 **같은 제안**이 나와야 한다(삼순 P0-2).
      //   raw 토큰을 먼저 보던 직전 구현은 `임창규는`(4음절)를 먼저 이름으로 확정해
      //   길이가 달라 1음절 치환이 안 되고, 정확한 제안을 잃었다.
      assert.equal(result.answer, NAME_SUGGEST_ANSWER("임찬규"), result.answer);
      assert.deepEqual(logs, ["name_suggest"]);
      assert.equal(calls.llm, 0, "generic LLM 이 불렸다 — 계약 위반");
      assert.equal(calls.ragLlm, 0, "RAG LLM 이 불렸다");
      assert.equal(calls.cacheRead, 0, "캐시를 읽었다 — 미결속 실명 답을 재사용하면 안 된다");
      assert.equal(calls.cacheWrite, 0, "캐시에 썼다");
      // 유저가 받은 문장에 **없는 사람에 대한 사실**이 하나도 없어야 한다.
      assert.doesNotMatch(result.answer, /주축|선수예요|트윈스의/);
    });
  }

  // ── ①-b 삼순 2026-08-09 필수 양성: 로스터 밖 실존 인물 (near-miss 유일) ────
  //   `김연아`·`신동엽`·`이효리` 는 야구 선수가 아니지만 로스터 이름과 1음절 차이라
  //   **이름 모양이라는 기계적 근거**가 있다. 근거가 있으면 막는다.
  for (const [question, expected] of [
    ["김연아 어떤 선수야", "김연주"],
    ["신동엽 어떤 선수야", "신동건"],
    ["이효리 어떤 선수야", "이의리"],
    // 이름 자체가 조사 음절(`은`)로 끝나는 3음절 — 조사와 구분되지 않지만
    // **첫 음절**이 다른 near-miss 라 근거가 성립한다(삼순 2026-08-09 fail-open 표본).
    ["김하은 어떤 선수야", "서하은"],
  ] as const) {
    await checkAsync(`\`${question}\` → 생성 0 · ${expected} 제안 (로스터 밖 실존 인물)`, async () => {
      const { result, logs, calls } = await ask(question);
      assert.equal(result.source, "name_suggest", `source=${result.source}`);
      assert.equal(result.answer, NAME_SUGGEST_ANSWER(expected), result.answer);
      assert.deepEqual(logs, ["name_suggest"]);
      assert.equal(calls.llm, 0, "generic LLM 이 불렸다");
    });
  }

  // ── ② near-miss 가 **여럿**인 이름 → 아무나 제안하지 않고 모른다고 말한다 ──────
  //   `이승엽`(5명)·`이종범`(4)·`최동원`(4) — 이름 모양 근거는 있지만 하나로 못 좁힌다.
  for (const question of [
    "이승엽 어떤 선수야",
    "이종범 소개해줘",
    "최동원 어떤 선수야",
  ]) {
    await checkAsync(`\`${question}\` → 생성 0 · 모른다고 말한다`, async () => {
      const { result, logs, calls } = await ask(question);
      // ⚠️ 제안할 이웃을 하나로 못 좁히면 **`name_unknown`** 이다 (삼순 2026-08-08 조건 ③).
      //   `name_suggest` 와 한 칸에 두면 제안율의 분모가 오염돼 오제안율을 못 센다.
      assert.equal(result.source, "name_unknown", `source=${result.source}`);
      assert.equal(result.answer, NAME_UNKNOWN_ANSWER, result.answer);
      assert.deepEqual(logs, ["name_unknown"]);
      assert.equal(calls.llm, 0, "generic LLM 이 불렸다 — 이게 바로 삼순 P0 였다");
      assert.equal(calls.ragLlm, 0);
      assert.equal(calls.cacheRead, 0);
      assert.equal(calls.cacheWrite, 0);
    });
  }

  // ── ②-b 🔴 **닫지 못한 구멍을 actual 로 고정한다** ─────────────────────────
  //
  //   로스터에 near-miss 가 **0명**인 이름(`오타니`·`홍길동`·`선동열`)은 여전히 막지
  //   못한다. 이유를 숨기지 않는다 — 그 이름들과 `자동차`·`신인왕`·`치어리`·`떡볶이` 는
  //   **구조가 완전히 같다**(3음절 + 성씨 글자 + 사람 명사 문장, near-miss 전부 0).
  //   구분하려면 형태소/사전/NER 기반 proper-name 판정이 필요하고 그건 별도 트랙이다.
  //   삼순 2026-08-09 (b) 비대칭에 따라 **근거 없으면 기존 경로로 둔다.**
  //
  //   ⚠️ 이 테스트는 "이게 옳다" 가 아니라 **"지금 여기까지다"** 를 고정하는 것이다.
  //     나중에 proper-name 판정을 붙이면 이 기대값이 깨지고, 그때 의도적으로 고쳐야 한다.
  for (const question of [
    "오타니 어떤 선수야",
    "홍길동 어떤 선수야",
    "선동열은 어떤 사람이야",
  ]) {
    await checkAsync(`\`${question}\` → 🔴 아직 막지 못한다 (near-miss 0 · 근거 없음)`, async () => {
      const { result } = await ask(question);
      assert.ok(result.source !== "name_suggest" && result.source !== "name_unknown",
        `막혔다 — 그러면 \`자동차\`·\`신인왕\` 도 같이 막히고 있다는 뜻이다: ${result.source}`);
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
    assert.ok(result.source !== "name_suggest" && result.source !== "name_unknown",
      `정상 선수를 되물었다: ${result.source}`);
    assert.equal(calls.ragLlm, 1, "선수 RAG 가 안 불렸다");
  });

  await checkAsync("구단 서술 질문은 team_rag 로 간다", async () => {
    const { result } = await ask("LG트윈스 창단 이야기 알려줘");
    assert.ok(result.source !== "name_suggest" && result.source !== "name_unknown",
      `구단 질문이 이름 되묻기로 샜다 — \`이야기\`→\`이준기\` 오탐 회귀: ${result.source}`);
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
      // ⚠️ near-miss 가 **0명**인 일반 명사 — `근거 요구`(N-H)가 유일한 방어다.
      //   이 축이 없으면 near-miss 근거 검사를 지워도 GREEN 이다.
      "떡볶이 어떤 선수가 좋아해",
      "짜장면 어떤 선수가 좋아해",
      "쌍둥이 어떤 선수야",
      "튀김옷 어떤 선수가 좋아해",
      "신인왕 누구야",
      "자동차 보험 누구한테 물어봐",

      // ⚠️ 아래 4개는 **near-miss 가 실제로 있는 일반어**다 (로스터 881명 실측).
      //   각 줄이 서로 다른 방어축의 **유일한 증거**다 — 없으면 그 축을 지워도 GREEN 이다.
      //
      //   `우승한`(→우승완) : anchor 요구가 유일한 방어. 사람 명사·주격조사·구단이 전부 없다.
      //                       삼순 2026-08-09 필수 음성 표본.
      "우승한 팀 어디야?",
      //   `우승한` + 평가 술어 : `잘해`·`어때` 를 사람 신호로 되돌리면 바로 뚫린다.
      //                          삼순 2026-08-09 필수 음성 표본(`자동차 운전 잘해?` 축).
      "우승한 팀 잘해?",
      "자동차 운전 잘해?",
      //   `이야기`(→이준기) : 기능어 배제가 유일한 방어. anchor(`선수`)까지 갖췄다.
      //                       이게 뚫리면 구단 서술 질문이 통째로 죽는다.
      "이야기 어떤 선수야",
      //   `장타율`(→장재율) : 지표어 배제가 유일한 방어. anchor(`선수`)까지 갖췄다.
      "장타율 어떤 선수가 높아",
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

  // ⚠️ 삼순 2026-08-08 P0-1: 성씨를 **현역 로스터에서만** 파생하면 현역에 없는 성씨가
  //   통째로 누수된다. `선동열`의 `선` 씨는 현역 881명에 한 명도 없고, 은퇴 선수·레전드는
  //   유저가 제일 많이 물는 이름이다 — 정작 제일 위험한 구멍이었다.
  //   지금은 `KOREAN_SURNAMES` 폐쇄집합과 합치므로 잡힌다. 그 사실을 고정한다.
  // ⚠️ **성씨 결속은 폐기했다** (2026-08-09). 여기 있던 "현역에 없는 성씨도 막는다"
  //   테스트는 성씨 판정을 전제로 한 계약이었는데, 그 판정이 `자동차`(`자` 씨)·
  //   `신인왕`(`신` 씨)·`치어리`(`치` 씨)를 전부 통과시켜 과차단의 원인이었다
  //   (삼순 2026-08-09). 지금은 **로스터 이름과의 1음절 차이**가 근거다.
  //   그래서 판정 근거가 무엇인지를 직접 고정한다.
  check("근거는 성씨가 아니라 **로스터 이름과의 1음절 차이**다", () => {
    const rosterSurnames = new Set(
      players.filter((p) => !/\s/.test(p.name)).map((p) => p.name[0]),
    );
    assert.ok(!rosterSurnames.has("선"), "전제 확인 — `선` 씨는 현역 로스터에 없다");

    // 성씨가 있어도 near-miss 가 0이면 근거가 없다 → 막지 않는다(기존 경로).
    for (const token of ["선동열", "오타니", "홍길동"]) {
      assert.equal(
        resolveUnboundName(`${token} 어떤 선수야`, players), null,
        `${token}: near-miss 0인데 막았다 — 그러면 \`자동차\`·\`신인왕\` 도 막힌다`,
      );
    }
    // 성씨 여부와 무관하게 near-miss 가 있으면 막는다.
    assert.equal(resolveUnboundName("김연아 어떤 선수야", players)?.suggestion, "김연주");
  });

  // ── 삼순 P0-2 반대쌍: 일반명사 + 주제조사 는 이름이 아니다 ────────────
  //   `김치는 어떤 사람이 만들었어?` — `김` 씨 + 주제조사 + `사람`(사람명사)라
  //   세 조건을 전부 만족하는데도 이름이 아니다. 2음절 제외가 이걸 막는다.
  check("일반명사 주어는 이름으로 오인하지 않는다 (삼순 P0-2)", () => {
    const NOUN_SUBJECTS = [
      "김치는 어떤 사람이 만들었어?",
      "박수는 언제 나오는지 알려줘",
      "고말은 어떤 선수가 받았어",
      "안타는 누가 제일 많아",
      "주치는 누가 말했어",
    ];
    const misfires = NOUN_SUBJECTS
      .map((q) => [q, resolveUnboundName(q, players)] as const)
      .filter(([, u]) => u !== null);
    assert.deepEqual(
      misfires.map(([q, u]) => `${q} → ${u?.token}`),
      [],
      "일반명사 주어를 사람 이름으로 오인했다",
    );
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
  check("`name_suggest`·`name_unknown` 은 답변(`answer`)으로 분류되지 않는다", () => {
    // 우리는 아무 사실도 말하지 않았다 — 답변 감사 분자에 들어가면 성공률이 부풀려진다.
    assert.notEqual(MATCH_PATH_REPLY_KIND.name_suggest, "answer");
    assert.notEqual(MATCH_PATH_REPLY_KIND.name_unknown, "answer");
  });

  // ⚠️ **두 라벨이 실제로 갈라지는지**를 본다 (삼순 2026-08-08 조건 ③).
  //   한쪽으로 병합해도 게이트가 GREEN 이면 감사 분리는 말뿐이다.
  check("제안 가능 여부로 `name_suggest` / `name_unknown` 이 갈린다", () => {
    assert.equal(routeQuestion("임창규 어떤 선수야", GLOSSARY, players), "name_suggest");
    // near-miss 가 **여럿**이라 하나로 못 좁히는 경우 → `name_unknown`
    assert.equal(routeQuestion("이승엽 어떤 선수야", GLOSSARY, players), "name_unknown",
      "후보를 못 좁힌 이름이 name_unknown 으로 갈리지 않는다 — 감사 분모가 오염된다");
    assert.equal(routeQuestion("최동원 어떤 선수야", GLOSSARY, players), "name_unknown");
    assert.equal(routeQuestion("김하은 어떤 선수야", GLOSSARY, players), "name_suggest");
  });

  if (failures.length > 0) {
    console.error(`\n❌ genius-unbound-name FAIL (${failures.length}건):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`\n✅ genius-unbound-name PASS (${pass} checks)`);
}

main().catch((error) => {
  console.error("❌ genius-unbound-name FAIL:", error);
  process.exit(1);
});
