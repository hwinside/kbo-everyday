/**
 * 구단 지명 라우팅 회귀 — 약칭/영문/별칭/붙여쓴 풀네임이 모두 같은 답을 받는가.
 *
 * ⚠️ 이 게이트가 생긴 이유 (2026-08-04 유저 제보 → 실측).
 *
 * 토큰화가 `LG트윈스의` 를 한 덩어리로 만들어 `lg` 와도 `트윈스` 와도 일치하지 않았다.
 * 그래서 **띄어쓰기 하나로 답이 갈렸다**:
 *
 *   "LG 트윈스의 역사"  → history_hold  (앱 기록 탭 안내)
 *   "LG트윈스의 역사"    → blocked       ("야구 룰/용어만 답할 수 있어요")
 *
 * 10개 구단 전부 같은 증상이었고, `KIA` 는 영문 표기 자체가 목록에 없어 별도로 뚫려 있었다.
 * 어느 쪽도 "답을 못 하는" 것은 같지만 **유저가 받는 안내가 틀렸다** — 구단 기록 질문에
 * "룰/용어만 답해요" 는 거짓말이다.
 *
 * 그래서 표기 변형(약칭/영문/별칭/붙여쓰기/띄어쓰기)이 **모두 동일한 라우팅**을 받는지
 * 10개 구단 전수로 고정한다. 한 구단이라도 표기에 따라 갈리면 RED.
 *
 * 실행: npm run qa:team-fullname-routing
 */
import assert from "node:assert/strict";
import {
  routeQuestion,
  type GlossaryEntry,
  type PlayerRef,
} from "../../src/lib/baseball-qa/pipeline";
import playersRoster from "../../src/lib/constants/players-roster.json";

const glossary: GlossaryEntry[] = [];
const players: PlayerRef[] = playersRoster.map(({ name, kboId, team, position, backNo }) => ({
  name,
  kboId,
  team: team ?? null,
  position: position ?? null,
  backNo: backNo ?? null,
}));

const route = (question: string) => routeQuestion(question, glossary, players, false);

let pass = 0;
const failures: string[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    pass += 1;
  } catch (error) {
    failures.push(`${name}: ${(error as Error).message}`);
  }
}

/**
 * 10개 구단 × 표기 변형.
 *
 * `short` 는 로스터 정본 team 값(및 한글 표기), `nick` 은 별칭이다.
 * 조합은 붙여쓰기/띄어쓰기 둘 다 만든다 — 이번 사고의 정확한 축이다.
 */
const TEAMS: Array<{ label: string; shorts: string[]; nick: string }> = [
  { label: "LG", shorts: ["LG", "엘지"], nick: "트윈스" },
  { label: "KIA", shorts: ["KIA", "기아"], nick: "타이거즈" },
  { label: "두산", shorts: ["두산"], nick: "베어스" },
  { label: "롯데", shorts: ["롯데"], nick: "자이언츠" },
  { label: "삼성", shorts: ["삼성"], nick: "라이온즈" },
  { label: "한화", shorts: ["한화"], nick: "이글스" },
  { label: "키움", shorts: ["키움"], nick: "히어로즈" },
  { label: "KT", shorts: ["KT", "kt"], nick: "위즈" },
  { label: "SSG", shorts: ["SSG", "ssg"], nick: "랜더스" },
  { label: "NC", shorts: ["NC", "nc"], nick: "다이노스" },
];

// 기록/역사 질문 — 답할 수 없지만 **기록 질문임은 인정**해야 한다(앱 기록 탭 안내).
for (const { label, shorts, nick } of TEAMS) {
  for (const short of shorts) {
    const variants = [
      `${short}의 역사`,
      `${short} 역사`,
      `${short}${nick}의 역사`, // 붙여쓴 풀네임 — 이번 사고의 정확한 지점
      `${short}${nick} 역사`,
      `${short} ${nick}의 역사`,
      `${nick}의 역사`,
      `${short}${nick} 우승`,
      `${short}${nick} 순위`,
    ];
    for (const question of variants) {
      check(`${label} 기록질문 "${question}"`, () => {
        assert.equal(
          route(question),
          "history_hold",
          `구단 기록 질문인데 다른 경로로 갔다(표기에 따라 답이 갈린다)`,
        );
      });
    }
  }
}

// ── 반대 방향 ①: 룰/용어 질문은 계속 열려야 한다 ─────────────────────────────
// 구단 인식을 넓히면서 룰 질문까지 기록 질문으로 삼켜버리면 그게 더 큰 회귀다.
for (const question of [
  "보크가 뭐야?",
  "잔루만루가 뭔데",
  "순위 결정 규칙 알려줘",
  "야구 순위가 동률이면 어떻게 정해?",
  "만루면",
  "화이트볼이 뭐야",
]) {
  check(`룰 질문 유지 "${question}"`, () => {
    assert.equal(route(question), "baseball_rule_term", "룰/용어 질문이 닫히면 안 된다");
  });
}

// ── 반대 방향 ②: 범위 밖은 계속 닫혀야 한다 ─────────────────────────────────
// 조합 규칙이 느슨하면 `아웃도어`처럼 어휘 밖 잔여물이 다시 샌다.
for (const question of [
  "아웃도어 자켓 어떻게 골라?",
  "도루묵 제철이 언제야?",
  "번트케이크 만드는 법 알려줘",
  "세이프티 교육 받아야 돼?",
]) {
  check(`범위 밖 위임 유지 "${question}"`, () => {
    assert.equal(route(question), "llm_scope_gate", "범위 밖은 LLM 판정 위임 그대로여야 한다");
  });
}
for (const question of ["볼만한 영화 추천해줘", "루이비통 가방 추천해줘"]) {
  check(`범위 밖 차단 유지 "${question}"`, () => {
    assert.equal(route(question), "blocked");
  });
}

// team-bound `누구/언제`(감독·창단연도)는 기록이 아니라 범위 밖 — 앱 기록 탭에 없는 정보다.
for (const question of ["LG트윈스 감독 누구야?", "LG 트윈스 감독 누구야?", "KIA 감독 누구야"]) {
  check(`구단 인물 질문은 blocked "${question}"`, () => {
    assert.equal(route(question), "blocked", "감독·창단연도는 기록 안내 대상이 아니다");
  });
}

// ── 반대 방향 ③: 어휘 밖 잔여물이 붙으면 구단으로 인정하지 않는다 ────────────
// `두산베어스` 는 구단이지만 `두산베어스키핑` 은 아니다. 조합 규칙이 문법 꺼리
// 폐쇄집합으로만 닫히는지 확인한다(느슨하면 아무 합성어나 구단이 된다).
check("어휘 밖 잔여물은 구단 아님", () => {
  const leaked = ["두산베어스키핑", "롯데자이언츠파스타"]
    .filter((word) => route(`${word} 역사`) === "history_hold");
  assert.deepEqual(leaked, [], `어휘 밖 합성어를 구단으로 인정했다: ${leaked.join(", ")}`);
});

// ── 선수/기록 경로 회귀 ─────────────────────────────────────────────────────
for (const question of ["김도영 타율 알려줘", "박해민 도루 몇 개야?", "류현진 방어율 알려줘"]) {
  check(`선수 기록 유지 "${question}"`, () => {
    assert.equal(route(question), "history_hold");
  });
}

if (failures.length > 0) {
  console.error(`❌ team fullname routing: PASS=${pass} FAIL=${failures.length}`);
  for (const failure of failures.slice(0, 15)) console.error(`   ${failure}`);
  if (failures.length > 15) console.error(`   ... 외 ${failures.length - 15}건`);
  process.exit(1);
}
console.log(`✅ team fullname routing: ${pass} PASS (10개 구단 표기 변형 전수 + 반대방향)`);
