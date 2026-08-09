/**
 * 야잘알봇 **미결속 실명 생성 0** 계약 — `answerQuestion()` 실제 실행 결과로 검증한다.
 *
 * ⚠️ 이 게이트가 생긴 이유 (2026-08-08 하린아빠 제보, Production 실측)
 *
 *     유저: `임창규 어떤 선수야`
 *     봇  : "임창규는 LG 트윈스의 주축 선수로…"
 *
 *   로스터 881명에 `임창규` 는 **없다**(`임찬규` kboId 61101, LG 만 있다).
 *   근거가 0 인 상태에서 generic LLM 이 **존재하지 않는 사람을 실존으로 만들고**
 *   소속·위상까지 붙였다. 수치 환각보다 나쁘다 — 유저는 틀렸다는 걸 알 방법이 없다.
 *
 * ⚠️ **왜 규칙이 아니라 실측 alias map 인가** (삼순 2026-08-09 최종 수렴안)
 *
 *   이 PR 에서 이름 판정 규칙을 여섯 번 바꿨다:
 *     성씨 결속 → 첫 어절 → 담화 표지 → near-miss 무조건 → query-wide anchor
 *     → candidate-local anchor
 *   반례가 하나 나오면 규칙을 하나 더 붙였고, 그때마다 새 반례가 나왔다.
 *
 *   **운영 로그 실측이 이 접근을 끝냈다.** genius_question_logs 3,297행(unique 2,576)
 *   에서 "답변 못 한 질문 × 로스터 이름과 1음절 차이" 를 전수로 뽑으니 69개 토큰이
 *   나왔는데 **실제 사람 이름 오타는 2개뿐**이었다. 나머지 67개는 전부 야구 용어·기능어다:
 *     47회 보크→보스 · 19회 주자→주권 · 19회 삼진→박진 · 5회 해줘→해치 …
 *   near-miss 로 열었다면 `보크가 뭐야` 에 "혹시 보스 선수를?" 이 47번 나갔을 것이다.
 *
 * 그래서 이 게이트는 문자열 존재를 보지 않는다(주석에도 걸린다 — #1127 M15 false-green).
 * **배포 `answerQuestion()` 을 실제로 호출**해서 본다:
 *   (a) 실측 오타에 대해 `llm`·`ragLlm`·`cache` 호출이 **0** 인가 (생성 0)
 *   (b) 유저가 받는 문자열이 **코드가 쓴 문장**인가
 *   (c) 되묻기가 **하루 한도를 깎지 않는가**
 *   (d) map 에 없는 67개 실측 토큰이 **전부 오탐 0** 인가
 *
 * 실행: npm run qa:genius-unbound-name
 */
import assert from "node:assert/strict";
import {
  answerQuestion,
  routeQuestion,
  resolveUnboundName,
  NAME_SUGGEST_ANSWER,
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
 *   assert 가 throw 하면 프로세스가 즉시 죽어서, mutation 이 **목표 축과 무관한 앞쪽
 *   assertion** 에서 먼저 걸린다 — 그러면 "게이트가 이 결함을 잡았다" 를 증명할 수 없다.
 *   전건을 끝까지 돌려 깨진 assertion 을 전부 모은다.
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
 * 외부 의존을 **전부 카운트**한다. 계약이 "생성 경로에 내려보내지 않는다" 이므로,
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
      content: "임찬규는 LG 트윈스의 프랜차이즈 투수로 알려져 있다.",
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

/**
 * **map 에 없는 실측 near-miss 토큰 67종** — `후보 토큰 → near-miss 대상` 쌍만.
 *
 * ⚠️ **원문을 넣지 않는다** (삼순 2026-08-09). 직전 판은 이 자리에 운영 로그
 *   질문 원문 67개를 그대로 커밋했다. 직접 식별자가 안 보여도 **비공개 user-generated
 *   로그를 repo fixture 로 복제하면 안 된다.** 게이트에 필요한 것은 토큰 쌍뿐이고,
 *   N-B mutation(=near-miss 규칙 부활) 검출력도 토큰만으로 그대로 유지된다.
 *
 *   각 쌍은 "규칙으로 열었으면 이 토큰이 저 선수로 오제안됐다" 를 뜻한다.
 *   47회 `보크`→`보스`, 19회 `주자`→`주권`, 19회 `삼진`→`박진` … 대부분 야구 용어다.
 *   map 을 넓힐 때 이 중 하나라도 들어오면 이 게이트가 RED 로 잡는다.
 *
 *   ⚠️ 검사는 **합성 최소 문장**으로 한다. 토큰만 넣으면 실제 질문 모양을 안 태우므로
 *   조사·서술어를 붙인 형태를 코드에서 만들어 돌린다(아래 `SYNTHETIC_FRAMES`).
 */
const MEASURED_NON_NAME_TOKENS: readonly (readonly [string, string])[] = [
  ["보살", "보스"],
  ["인정", "최정"],
  ["주자", "주권"],
  ["해주", "해치"],
  ["해줘", "해치"],
  ["해서", "해치"],
  ["지금", "지현"],
  ["보크", "보스"],
  ["올해", "올러"],
  ["일정", "최정"],
  ["삼진", "박진"],
  ["주루", "주권"],
  ["어디서", "어준서"],
  ["보통", "보스"],
  ["아니라", "아빌라"],
  ["천재니", "천재환"],
  ["보는", "보스"],
  ["원정", "최정"],
  ["제일", "네일"],
  ["불러", "올러"],
  ["포일", "네일"],
  ["섹스", "보스"],
  ["주전", "주권"],
  ["보쿠", "보스"],
  ["이유를", "이유찬"],
  ["해도", "해치"],
  ["위치", "해치"],
  ["네모", "네일"],
  ["양쪽", "양현"],
  ["테일링", "테일러"],
  ["지난", "지현"],
  ["지명", "지현"],
  ["페어", "페덱"],
  ["사진", "박진"],
  ["지역", "지현"],
  ["해야", "해치"],
  ["해결", "해치"],
  ["유령", "유민"],
  ["지식", "지현"],
  ["내일", "네일"],
  ["허허", "허윤"],
  ["한선수", "한준수"],
  ["매일", "네일"],
  ["설정", "최정"],
  ["지면", "지현"],
  ["보면", "보스"],
  ["이유는", "이유찬"],
  ["퀄스", "보스"],
  ["카러스코", "카라스코"],
  ["한경기", "한경빈"],
  ["던진", "박진"],
  ["이해가", "이해승"],
  ["규정", "최정"],
  ["지표", "지현"],
  ["리버스", "리오스"],
  ["달성한", "박성한"],
  ["주는", "주권"],
  ["펜스", "보스"],
  ["강공", "강건"],
  ["재치", "해치"],
  ["이유가", "이유찬"],
  ["세스", "보스"],
  ["부정", "최정"],
  ["판정", "최정"],
  ["유형", "유민"],
  ["강제", "강건"],
  ["주행", "주권"],
];

/**
 * 합성 질문 틀 — 지난 판들이 각각 뚫렸던 형태를 그대로 재현한다.
 * (첫 어절 / 조사형 / 담화 표지 뒤 / 사람 명사 동반 / 평가 술어 / 구단 동반)
 */
const SYNTHETIC_FRAMES: readonly ((token: string) => string)[] = [
  (t) => `${t} 어떤 선수야`,
  (t) => `${t}는 어느 팀이야`,
  (t) => `혹시 ${t} 알려줘`,
  (t) => `${t} 소개해줘`,
  (t) => `${t} 잘해?`,
  (t) => `lg ${t} 주축 맞아?`,
];

async function main() {
  const players = await loadRosterPlayers();
  assert.ok(players.length > 100, `로스터가 ${players.length}명뿐이다 — SSOT 유실`);

  const ask = async (question: string) => {
    const { deps, logs, calls } = makeDeps(players);
    const result = await answerQuestion("u-unbound-name", question, deps);
    return { result, logs, calls };
  };

  // ── ① 실제 사고 재현: 생성 0 + 이름 되묻기 ────────────────────────────────
  //   판정이 alias 조회 하나라 **어투·위치를 보지 않는다**. 그래서 지난 판들이
  //   차례로 놓쳤던 형태(`알려줘`·`혹시 …`·조사형·구단 동반)가 전부 잡힌다.
  for (const [question, label] of [
    ["임창규 어떤 선수야", "하린아빠 제보 원형"],
    ["임창규는 어느 팀이야", "주격조사 — 핵 우선 판정"],
    ["임창규 소개해줘", "서술어"],
    ["임창규 알려줘", "범용어(직전 판들이 놓쳤다)"],
    ["혹시 임창규 어떤 선수야", "담화 표지 뒤 — 첫 어절 아님"],
    ["임창규 lg 주축 맞아?", "구단 동반 — 직전 판의 명시적 손해였다"],
    ["임창규 잘해?", "평가 술어 — 직전 판의 명시적 손해였다"],
    ["임창규 언제 데뷔했어", "합성 — 붙여쓰기·조사 없는 형태"],
  ] as const) {
    await checkAsync(`\`${question}\` → 생성 0 · 임찬규 제안 (${label})`, async () => {
      const { result, logs, calls } = await ask(question);
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
  }

  // ── ①-b 두 번째 실측 오타 ─────────────────────────────────────────────────
  await checkAsync("`기아 양혅종 어떤 선수야` → 생성 0 · 양현종 제안 (두 번째 실측 오타)", async () => {
    const { result, logs, calls } = await ask("기아 양혅종 어떤 선수야");
    assert.equal(result.source, "name_suggest", `source=${result.source}`);
    assert.equal(result.answer, NAME_SUGGEST_ANSWER("양현종"), result.answer);
    assert.deepEqual(logs, ["name_suggest"]);
    assert.equal(calls.llm, 0, "generic LLM 이 불렸다");
  });

  // ── ② 🔴 map 에 없는 실측 토큰 67종 — 전부 오탐 0 ──────────────────────────
  //   이게 이 PR 의 핵심 증거다. 규칙(near-miss·성씨·anchor)으로 열었으면
  //   `보크가 뭐야` 에 "혹시 보스 선수를?" 이 나갔다.
  check("실측 near-miss 67종(map 밖) × 합성 6형태 오탐 0", () => {
    const misfires: string[] = [];
    for (const [token, target] of MEASURED_NON_NAME_TOKENS) {
      for (const frame of SYNTHETIC_FRAMES) {
        const question = frame(token);
        const unbound = resolveUnboundName(question, players);
        if (unbound !== null) misfires.push(`${question} → ${unbound.token}→${unbound.suggestion}(예상 오제안 ${target})`);
      }
    }
    assert.deepEqual(misfires, [], "야구 용어·기능어를 사람 이름으로 오인했다");
  });

  // 전제 확인 — 이 토큰들이 **실제로 near-miss 를 갖는다**(그래서 규칙이면 뚫린다).
  //   이게 없으면 위 테스트는 "애초에 후보가 아니라서" 통과한 것과 구분되지 않는다.
  check("전제: 67종은 로스터와 1음절 차이가 실재한다", () => {
    const swap = (a: string, b: string) => {
      if (a.length !== b.length) return false;
      let diff = 0;
      for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) diff += 1;
      return diff === 1;
    };
    const rosterNames = players.map((p) => p.name);
    const broken = MEASURED_NON_NAME_TOKENS
      .filter(([token, target]) => !swap(token, target) || !rosterNames.includes(target))
      .map(([token, target]) => `${token}→${target}`);
    assert.deepEqual(broken, [], "표본이 낡았다 — 로스터 변경으로 near-miss 관계가 깨졌다");
  });

  // ── ②-b 🔴 **닫지 못한 구멍을 actual 로 고정한다** ─────────────────────────
  //   map 에 없는 이름은 잡지 않는다 — 로스터 밖 실존 인물·완전 허구 포함.
  //   일반화하려면 형태소/NER proper-name 판정이 필요하고 **별도 트랙**이다.
  //   ⚠️ 이 테스트는 "이게 옳다" 가 아니라 **"지금 여기까지다"** 를 고정한다.
  //     나중에 별도 트랙이 붙으면 이 기대값이 깨지고, 그때 의도적으로 고쳐야 한다.
  for (const question of [
    "오타니 어떤 선수야",     // 로스터 밖 실존 인물
    "홍길동 어떤 선수야",     // 완전 허구
    "이승엽 어떤 선수야",     // 은퇴 선수
    "선동열은 어떤 사람이야", // 은퇴 선수(현역에 없는 성씨)
    "이대호 어떤 선수야",     // 은퇴 선수
  ]) {
    await checkAsync(`\`${question}\` → 🔴 아직 막지 못한다 (map 밖 — 별도 트랙)`, async () => {
      const { result } = await ask(question);
      assert.notEqual(result.source, "name_suggest",
        `막혔다 — map 에 없는데 잡혔다면 규칙 추론이 되살아난 것이다: ${result.source}`);
    });
  }

  // ── ③ 교정 대상은 **현 로스터에 있어야** 한다 ──────────────────────────────
  check("교정 대상이 로스터에서 사라지면 되묻지 않는다 (fail-close)", () => {
    const withoutTarget = players.filter((p) => p.name !== "임찬규");
    assert.ok(withoutTarget.length === players.length - 1, "전제 확인 — 임찬규가 로스터에 있다");
    assert.equal(
      resolveUnboundName("임창규 어떤 선수야", withoutTarget), null,
      "없는 선수를 되물었다 — 이 PR 이 고치려던 결함과 같은 종류다",
    );
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
    assert.notEqual(result.source, "name_suggest", `정상 선수를 되물었다: ${result.source}`);
    assert.equal(calls.ragLlm, 1, "선수 RAG 가 안 불렸다");
  });

  await checkAsync("구단 서술 질문은 team_rag 로 간다", async () => {
    const { result } = await ask("LG트윈스 창단 이야기 알려줘");
    assert.notEqual(result.source, "name_suggest",
      `구단 질문이 이름 되묻기로 샜다: ${result.source}`);
  });

  check("룰·일반 문장 오탐 0", () => {
    const NON_NAME_QUESTIONS = [
      "홈런 기준이 뭐야 알려줘",
      "심판 판정 기준 알려줘",
      "우천 취소 기준 알려줘",
      "세이프티 신발 어디서 사?",
      "어디서 뛰는지 알려줘",
      "이야기 좀 알려줘",
      "저번에 어떤 선수 나왔지",
      "우승한 팀 어디야?",
      "우승한 선수 누구야?",
      "우승한 그 선수 누구야?",
      "우승한 어떤 선수야?",
      "우승한 팀 lg트윈스 맞아?",
      "자동차 운전 잘해?",
      "고양이는 잘해?",
      "김치는 어떤 사람이 만들었어?",
      "박수는 언제 쳐?",
      "신인왕 누구야",
      "장타율 어떤 선수가 높아",
      "이야기 어떤 선수야",
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

  // ⚠️ 로스터는 매일 바뀐다 — 오늘의 오타 문자열이 내일 신인 이름일 수 있다.
  //   그때도 되묻으면 이 PR 이 고치려던 결함의 **거울상**이 된다(실존 선수를 물었는데
  //   "혹시 다른 사람?" 이라고 답하는 것). 그 방어를 실제 로스터를 조작해 확인한다.
  check("오타 키가 실존 선수 이름이 되면 되묻지 않는다 (거울상 방어)", () => {
    const withTypoAsRealPlayer = [
      ...players,
      { kboId: 999999, name: "임창규", team: "LG" } as PlayerRef,
    ];
    assert.equal(
      resolveUnboundName("임창규 어떤 선수야", withTypoAsRealPlayer), null,
      "실존 선수를 오타로 취급해 되물었다 — 결함의 거울상이다",
    );
  });

  check("로스터 전원 자기 질문 오탐 0", () => {
    const misfires: string[] = [];
    for (const p of players) {
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
    assert.equal(routeQuestion("기아 양혅종 어떤 선수야", GLOSSARY, players), "name_suggest");
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
