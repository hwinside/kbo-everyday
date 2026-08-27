/**
 * 야잘알봇 RAG **주인공 인물 결속** 계약 게이트 — D안 (삼순 2026-08-20 확정).
 *
 * ⚠️ 이 게이트가 생긴 이유 (2026-08-19 Production 실측, UI E2E 5/5 재현)
 *
 *     유저: `김민준 어떤 선수야?` → picker → **SSG 56840**(2006년생 투수) 선택
 *     봇  : "김민준 선수는 에스에스지 소속의 **내야수**입니다…"
 *
 *   근거(evidence)는 56840 본인 문서였고 거기엔 "SSG 랜더스 소속 **우완 투수**"가 있었다.
 *   그런데 같은 문서 본문에 "같은 팀에 동명이인인 **내야수** 김민준이 있다"는 서술이 있어
 *   모델이 그 **제3자 속성**을 주인공에게 끌어다 붙였다. 유저는 틀렸다는 걸 알 방법이 없다.
 *
 * ⚠️ 왜 게이트를 통째로 다시 썼는가 (D안 전환, 2026-08-20 → 2026-08-27 반영)
 *   종전 구조는 `detectIdentityConflict` 라는 **문법 정규식**으로 "그 토큰이 주인공에게
 *   귀속됐는가"를 판정했다. 귀속은 열린 자연어라 반례가 끝나지 않았고(계사→시제→주어→
 *   소유격→명시 마커, 삼순 NO-GO 7~11차 다섯 왕복) 하린아빠도 "또 무한 룰베이스 핑퐁
 *   아니냐"고 지적했다. 그래서 판정을 두 축으로 **분리**했다:
 *
 *     ① 존재판정 = `detectIdentityContradictions` — 코드(룰).
 *        "답변에 roster 와 모순되는 토큰이 **있는가**"만 본다. 입력이 닫힌 집합
 *        (포지션 5종·구단 10개+별칭)이라 룰이 맞다. 귀속은 판정하지 않는다.
 *     ② 귀속판정 = `verifyIdentityAttribution` — 검증 LLM(strict JSON).
 *        "그 토큰이 주인공 본인 것인가"는 열린 자연어라 LLM 에 위임한다.
 *        불명·미배선·예외·timeout·malformed 는 전부 **불명 → unsure**(fail-close).
 *     ③ 신원 첫 문장 = `renderIdentitySentence` — 코드가 roster SSOT 로 직접 조립한다.
 *        LLM 산출물이 아니므로 이 문장의 팀·포지션은 구조적으로 틀릴 수 없다.
 *
 *   그래서 이 게이트는 **①의 존재판정이 닫힌 집합대로 동작하는가**와
 *   **②의 판정 결과가 종단 서빙 결정에 그대로 결속되는가**를 본다.
 *   ①이 귀속까지 판정하려 들면(= 룰 회귀) X1-C 가 RED 를 낸다.
 *
 * 검증 축 (전부 **배포 함수**를 실제로 호출한다 — 문자열 존재 검사 금지):
 *   A/A2/B/E  `buildIdentityBlock` roster 실데이터 결속 · 미결속 null · 허위 경고 금지
 *   C         `buildRagLlmRequest` 가 블록을 **실제 프롬프트 본문**에 싣는다(자료 뒤)
 *   D         종단 `answerQuestion` → `callRagLlm` extras 배선(production seam)
 *   F         실측 사고 쌍 53893↔56840 **양방향** 결속
 *   G         kboId↔이름 불일치는 결속하지 않는다(fail-close)
 *   X1        존재판정 = 닫힌 집합. **귀속은 판정하지 않는다**(비귀속 문장도 후보로 잡힌다)
 *   X2        모순 토큰 0건이면 검증 LLM 을 **부르지 않는다**(비용 계약)
 *   X3        verdict `제3자` → 그대로 서빙(정상 답변 과잉 차단 금지)
 *   X4        verdict `주인공` → 재생성 1회, 고쳐지면 서빙
 *   X5        재생성 후에도 충돌이면 `unsure`, 재생성은 **정확히 1회**
 *   X6~X9     `불명`·미배선·예외·malformed → 전부 `unsure`(fail-close 4종)
 *   X10       검증 LLM 토큰이 **누적**된다(보조판정이 공짜로 보이면 비용 분모가 깨진다)
 *   X11       신원 첫 문장을 코드가 roster 로 렌더한다
 *   N         server 어댑터 종단 배선 + 검증기 프롬프트 인젝션 가드
 *
 * `--selftest`: 이 게이트가 쓰는 **판정 키가 실제로 RED 를 낼 수 있는지** 증명한다.
 *   ⚠️ selftest 통과는 "production 결함을 잡는다"를 증명하지 않는다(M90).
 *      실제 검증력은 소스 변조를 태우는 `qa:genius-rag-identity:mutations` 가 증명한다.
 *
 * 실행: npm run qa:genius-rag-identity
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  answerQuestion,
  buildIdentityBlock,
  buildPlayerIdentity,
  detectIdentityContradictions,
  renderIdentitySentence,
  type IdentityAttributionVerdict,
  type IdentityContradiction,
  type IdentityVerdictResult,
  type PlayerRef,
  type QaDeps,
  type RagLlmExtras,
} from "../../src/lib/baseball-qa/pipeline";
import { buildRagLlmRequest } from "../../src/lib/baseball-qa/rag/retrieve";
// 🔴 순수 모듈을 **그대로 실행**한다 — 소스 정규식이 아니라 산출물을 검사하기 위해서다.
import { buildIdentityVerifierPrompt } from "../../src/lib/baseball-qa/identity-verifier-prompt";
import roster from "../../src/lib/constants/players-roster.json";

const SELFTEST = process.argv.includes("--selftest");
const IDENTITY_HEADING = "<질문 대상";

/** 실제 로스터에서 동명이인 그룹을 뽑는다 — 픽스처를 손으로 적으면 로스터가 변해도 GREEN 이다. */
const players = (roster as PlayerRef[]).map((row) => ({
  name: row.name,
  kboId: String(row.kboId),
  team: row.team ?? null,
  position: row.position ?? null,
  // 🔴 생년·등번호를 버리면 구분 불가 동명이인 축이 무증상이 된다 (삼순 재리뷰 ②).
  //   같은 팀·같은 포지션이라 둔 둘을 가를 수 있는 roster 축은 이 둘뿐이다 —
  //   픽스처가 이걸 떨구면 검증기가 근거를 받는지를 원리적으로 판정할 수 없다.
  birthDate: row.birthDate ?? null,
  backNo: row.backNo ?? null,
}));

function findNamesakePair(): { target: PlayerRef; other: PlayerRef } {
  const byName = new Map<string, PlayerRef[]>();
  for (const p of players) {
    if (!byName.has(p.name)) byName.set(p.name, []);
    byName.get(p.name)!.push(p);
  }
  for (const group of byName.values()) {
    // 같은 이름 + 서로 다른 포지션 = 오귀속이 실제로 관측 가능한 조합
    if (group.length < 2) continue;
    const withPos = group.filter((p) => p.position);
    const distinct = new Set(withPos.map((p) => p.position));
    if (withPos.length >= 2 && distinct.size >= 2) return { target: withPos[0], other: withPos[1] };
  }
  throw new Error("로스터에서 동명이인·이종 포지션 쌍을 찾지 못했다 — 픽스처 전제 붕괴");
}

function rosterRow(kboId: string, axis: string): PlayerRef {
  const row = players.find((p) => p.kboId === kboId);
  // 로스터가 바뀌어 실측 사고 케이스가 사라졌으면 **조용히 넘어가지 않는다.**
  if (!row) throw new Error(`${axis}: 실측 사고 케이스 kboId ${kboId} 가 로스터에 없다 — 픽스처 갱신 필요`);
  return row;
}

/** 재작성 지시가 **실제 프롬프트 본문**에 실렸는가 — 모델이 볼 수 있는 유일한 표면이다. */
function promptHasRewriteInstruction(extras?: RagLlmExtras): boolean {
  if (!extras) return false;
  const req = buildRagLlmRequest("q", [{
    pageTitle: "t", sectionPath: "s", content: "c",
    canonicalUrl: "https://namu.wiki/w/x", sourceGrade: "tier2",
  } as never], undefined, {
    identityBlock: extras.identityBlock,
    identityConflicts: extras.identityConflicts,
  });
  return String(req.contents[0].parts[0].text).includes("<재작성 지시");
}

/** 검증 LLM 스텁 — 호출 횟수·입력을 호출자가 관측한다. */
interface VerifierStub {
  calls: number;
  seen: { answer: string; hitFields: string[]; hitIds: string[] }[];
  fn: NonNullable<QaDeps["verifyIdentityAttribution"]>;
}
function makeVerifier(
  respond: (call: number, hits: IdentityContradiction[]) => IdentityVerdictResult | Promise<IdentityVerdictResult>,
): VerifierStub {
  const stub: VerifierStub = {
    calls: 0,
    seen: [],
    fn: async (input) => {
      stub.calls += 1;
      stub.seen.push({
        answer: input.answer,
        hitFields: input.hits.map((h) => h.field),
        hitIds: input.hits.map((h) => h.id),
      });
      return respond(stub.calls, input.hits);
    },
  };
  return stub;
}
/** 모든 hit 에 같은 verdict 를 주는 응답기 — 계약상 **전수 일치**가 기본이다. */
const allVerdict = (verdict: IdentityAttributionVerdict, tokens?: { inputTokens: number; outputTokens: number }) =>
  (_call: number, hits: IdentityContradiction[]): IdentityVerdictResult => ({
    verdicts: hits.map((hit) => ({ id: hit.id, verdict })),
    ...(tokens ?? {}),
  });

/**
 * 종단 `answerQuestion` 을 태우기 위한 deps 팩토리.
 *
 * 🔴 `answerFor` 를 **호출자가 준다**는 점이 핵심이다 (삼순 2026-08-19 3차).
 *   종전 stub 은 정답을 직접 반환해서 "프롬프트에 실렸다"만 봤다. 실제 사고는 모델이
 *   지시를 어긴 것이므로, 게이트는 **어기는 모델**도 태울 수 있어야 한다.
 *   재생성 호출도 같은 stub 을 다시 부르므로 호출 횟수·응답 변화를 호출자가 통제한다.
 *
 * 🔴 `verifier` 도 호출자가 준다 (D안). 귀속 판정이 LLM 으로 넘어갔으므로, 게이트는
 *   **판정 결과별로 종단 결정이 달라지는가**를 봐야 한다. 미배선(undefined)도 케이스다.
 */
function makeDeps(
  subject: PlayerRef,
  answerFor: (extras?: RagLlmExtras) => string,
  options: {
    verifier?: QaDeps["verifyIdentityAttribution"];
    onExtras?: (extras: RagLlmExtras | undefined) => void;
    onRagCall?: () => void;
    llmTokens?: { inputTokens: number; outputTokens: number };
  } = {},
): QaDeps {
  const evidenceRow = {
    pageTitle: `${subject.name} 문서`, sectionPath: "개요",
    // 실측 사고 재현: 주인공 문서 안에 **동명이인의 다른 포지션** 서술이 함께 있다.
    // 경력 서술도 넣는다 — 같은 팀·같은 포지션 동명이인 축(Y3)은 포지션·구단이 아니라
    // **경력·생년**이 새는 경로라 근거에 그 서술이 있어야 생성이 성립한다.
    content: `${subject.name}. ${subject.team ?? ""} 소속 ${subject.position ?? ""}. 같은 팀에 동명이인인 선수가 있습니다. 신인드래프트에서 지명된 뒤 데뷔 시즌부터 선발로 나섬습니다. 데뷔 이후 꾸준히 출전하고 있습니다.`,
    canonicalUrl: "https://namu.wiki/w/test", sourceGrade: "tier2",
  };
  const tokens = options.llmTokens ?? { inputTokens: 1, outputTokens: 1 };
  return {
    loadGlossary: async () => [],
    loadPlayers: async () => players,
    getCache: async () => null,
    loadPreviousTurn: async () => null,
    setCache: async () => {},
    callLlm: async () => ({ text: "{}", inputTokens: null, outputTokens: null }),
    reserveDaily: async (_u: string, limit: number) => ({ allowed: true, remaining: limit - 1 }),
    log: async () => {},
    now: () => Date.now(),
    enablePlayerRag: true,
    pickedPlayerKboId: subject.kboId,
    searchRag: async () => [evidenceRow],
    verifyIdentityAttribution: options.verifier,
    callRagLlm: async (_q: string, _ev: unknown, extras?: RagLlmExtras) => {
      options.onExtras?.(extras);
      options.onRagCall?.();
      return {
        text: JSON.stringify({ status: "GROUNDED", answer: answerFor(extras) }),
        inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens,
      };
    },
  } as unknown as QaDeps;
}

async function main() {
  let passed = 0;
  const pass = (name: string) => { passed += 1; console.log(`  PASS ${name}`); };

  // ── A. 주인공 블록 생성 ────────────────────────────────────────────────
  const { target, other } = findNamesakePair();
  const block = buildIdentityBlock(
    { entityId: target.kboId, name: target.name, team: target.team },
    players,
  );
  assert.ok(block, "A: 로스터 결속 선수인데 identity 블록이 비었다");
  assert.ok(block!.includes(target.kboId), `A: 블록에 주인공 kboId(${target.kboId})가 없다`);
  assert.ok(block!.includes(target.name), "A: 블록에 주인공 이름이 없다");
  assert.ok(
    !target.position || block!.includes(target.position),
    `A: 블록에 주인공 포지션(${target.position})이 없다 — 오귀속을 막을 축이 사라진다`,
  );
  pass(`A 주인공 블록 생성 (${target.name} ${target.kboId} ${target.position ?? "-"})`);

  // 동명이인이 "주인공 아님"으로 명시돼야 한다 — 이게 제3자 서술 차단의 유일한 신호다.
  assert.ok(
    block!.includes(other.kboId),
    `A2: 동명이인(${other.kboId})이 블록에 명시되지 않았다`,
  );
  pass("A2 동명이인 명시");

  // ── B. 미결속 kboId 는 null (빈 블록 금지) ─────────────────────────────
  const unbound = buildIdentityBlock(
    { entityId: "ZZ_NOT_IN_ROSTER", name: "없는선수", team: null },
    players,
  );
  assert.equal(unbound, null, "B: roster 밖 kboId 인데 블록을 만들었다 — 근거 없는 결속");
  pass("B 미결속 kboId → null");

  // ── E. 동명이인 없는 선수는 동명이인 줄을 만들지 않는다 ─────────────────
  const soloName = players.find((p) => players.filter((q) => q.name === p.name).length === 1);
  assert.ok(soloName, "E: 유일 이름 선수를 찾지 못했다");
  const soloBlock = buildIdentityBlock(
    { entityId: soloName!.kboId, name: soloName!.name, team: soloName!.team },
    players,
  );
  assert.ok(soloBlock, "E: 유일 이름 선수 블록이 비었다");
  assert.ok(
    !soloBlock!.includes("동명이인"),
    "E: 동명이인이 없는데 동명이인 줄을 만들었다 — 허위 경고",
  );
  pass("E 동명이인 없으면 경고 줄 없음");

  // ── C. 프롬프트 본문에 실제로 실리는가 ─────────────────────────────────
  const req = buildRagLlmRequest(
    "김민준 어떤 선수야?",
    [{
      pageTitle: "김민준(2006년 4월)", sectionPath: "개요",
      content: "SSG 랜더스 소속 우완 투수. 같은 팀에 동명이인인 내야수 김민준이 있다.",
      canonicalUrl: "https://namu.wiki/w/x", sourceGrade: "tier2",
    } as never],
    undefined,
    { identityBlock: block! },
  );
  // 🔴 판정은 **user turn 본문**으로만 한다.
  //   이전 판은 `JSON.stringify(req)` 전체를 봤는데, 그 안에는 systemInstruction 이 들어있고
  //   시스템 프롬프트 지시문에도 "<질문 대상> 블록이 주어지면…" 이라는 **같은 문자열**이 있다.
  //   그래서 적재 계약을 통째로 지워도 판정 키가 지시문에 걸려 GREEN 이 됐다(mutation M2 실측).
  //   판정 키는 통과 출력·지시문과 겹치면 안 된다(M90).
  const userText: string = req.contents[0].parts[0].text;
  assert.ok(
    userText.includes(IDENTITY_HEADING),
    "C: identity 블록 구획이 프롬프트에 없다 — extras 를 받고도 안 싣는다",
  );
  assert.ok(userText.includes(target.kboId), "C: 프롬프트 본문에 주인공 kboId 가 없다");
  // 주인공 결속은 자료 뒤에 와야 한다 — 자료가 마지막이면 동명이인 서술이 더 가깝게 읽힌다.
  assert.ok(
    userText.indexOf(IDENTITY_HEADING) > userText.indexOf("<자료 시작"),
    "C2: identity 블록이 자료보다 앞에 있다 — 배치 계약 위반",
  );
  pass("C 프롬프트 본문 적재 + 배치 순서");

  // ── D. production seam: answerQuestion → callRagLlm extras ─────────────
  //   헬퍼만 보면 배선이 끊겨도 GREEN 이다. 종단으로 태워서 extras 를 관측한다.
  let observed: RagLlmExtras | undefined;
  const cleanAnswer = (row: PlayerRef) =>
    `${row.name} 선수는 ${row.team} 소속 ${row.position}입니다. 데뷔 이후 꾸준히 출전하고 있습니다.`;
  // 🔴 검증기를 **배선해 둔다**. 정상 답변이라 모순 후보가 0건이므로 올바른 구현에서는
  //   호출되지 않는다. 그런데 배선을 비워두면 "모순 0건에도 검증을 부르는" 결함이
  //   이 축에서 먼저 `불명 → unsure` 로 터져 X2 의 비용 계약이 관측 불가가 된다.
  const seamVerifier = makeVerifier(allVerdict("제3자"));
  const seamDeps = makeDeps(target, () => cleanAnswer(target), {
    verifier: seamVerifier.fn,
    onExtras: (extras) => { observed = extras; },
  });
  const result = await answerQuestion("qa-identity", `${target.name} 어떤 선수야?`, seamDeps);
  assert.equal(result.source, "rag", `D: RAG 경로를 타지 않았다 (source=${result.source})`);
  const seamBlock = SELFTEST ? undefined : observed?.identityBlock;
  assert.ok(
    seamBlock,
    "D: 종단 answerQuestion 이 callRagLlm 에 identityBlock 을 넘기지 않았다 — 배선 끊김",
  );
  assert.ok(
    seamBlock!.includes(target.kboId),
    "D2: seam 으로 넘어간 블록에 선택된 kboId 가 없다 — 다른 선수로 결속됐다",
  );
  // 검증용 `identity` 도 같은 seam 으로 넘어와야 한다 — 이게 없으면 존재판정 자체가 안 돈다.
  assert.ok(
    observed?.identity && observed.identity.kboId === target.kboId,
    "D3: seam 으로 identity(검증용 roster 사실)가 넘어오지 않았다 — 존재판정 입력 소실",
  );
  pass("D production seam 결속 전달 (block + identity)");

  // ── F. 실측 사고 케이스 **양방향** 결속 (삼순 2026-08-19 재리뷰 조건) ──────
  //   53893('04 내야수) ↔ 56840('06 투수) — SSG 같은 팀 동명이인이다.
  //   한 방향만 보면 "항상 투수로 결속" 같은 고정값 버그를 못 잡는다.
  const SSG_PAIR = [
    { id: "56840", counterpart: "53893" },
    { id: "53893", counterpart: "56840" },
  ];
  for (const { id, counterpart } of SSG_PAIR) {
    const row = rosterRow(id, "F");
    const b = buildIdentityBlock({ entityId: id, name: row.name, team: row.team }, players);
    assert.ok(b, `F: ${id} identity 블록이 비었다`);
    assert.ok(b!.includes(id), `F: ${id} 블록에 본인 kboId 가 없다`);
    assert.ok(
      !row.position || b!.includes(row.position),
      `F: ${id} 블록의 포지션이 roster(${row.position})와 다르다`,
    );
    // 상대방은 "주인공 아님"으로만 등장해야 한다.
    const counterpartRow = players.find((p) => p.kboId === counterpart);
    if (counterpartRow) {
      const namesakeLine = b!.split("\n").find((line) => line.startsWith("동명이인"));
      assert.ok(
        namesakeLine?.includes(counterpart),
        `F: ${id} 블록의 동명이인 줄에 ${counterpart} 이 없다 — 제3자 구분 신호 소실`,
      );
      assert.ok(
        !b!.split("\n")[0].includes(counterpart),
        `F: ${id} 블록 첫 줄(주인공)에 상대방 ${counterpart} 이 섞였다`,
      );
    }
  }
  pass("F 53893/56840 양방향 결속");

  // ── G. 충돌 fail-close — kboId 와 이름이 어긋나면 결속하지 않는다 ────────
  //   손상된 pick payload·상류 버그로 kboId 가 다른 사람을 가리키면, 잘못된 주인공을
  //   당당하게 명시한 블록이 나가 오귀속을 **확정**시킨다 — 막는 장치가 가해자가 된다.
  const conflict = buildIdentityBlock(
    { entityId: target.kboId, name: `${target.name}_다른사람`, team: target.team },
    players,
  );
  assert.equal(
    conflict,
    null,
    "G: kboId↔이름 불일치인데 블록을 만들었다 — 오결속 fail-close 미작동",
  );
  pass("G kboId↔이름 충돌 fail-close");

  // ── X1. 존재판정은 **닫힌 집합**이고, 귀속은 판정하지 않는다 (D안 핵심) ────────
  const pitcher = rosterRow("56840", "X1");          // SSG 투수
  const pitcherIdentity = buildPlayerIdentity(
    { entityId: pitcher.kboId, name: pitcher.name, team: pitcher.team }, players,
  )!;
  assert.ok(pitcherIdentity, "X1: 실측 사고 주인공의 identity 조립 실패");

  // X1-A 포지션 모순 토큰 존재 → 후보 1건
  const posHits = detectIdentityContradictions(
    `${pitcher.name} 선수는 ${pitcher.team} 소속의 내야수입니다.`, pitcherIdentity,
  );
  assert.ok(posHits.some((h) => h.field === "position" && h.mentioned === "내야수"),
    "X1-A: 포지션 모순 토큰(내야수)이 존재판정에서 잡히지 않았다");

  // X1-B 구단 모순 토큰 존재 → 후보 1건
  const teamHits = detectIdentityContradictions(
    `${pitcher.name} 선수는 두산 소속입니다.`, pitcherIdentity,
  );
  assert.ok(teamHits.some((h) => h.field === "team" && h.mentioned === "두산"),
    "X1-B: 구단 모순 토큰(두산)이 존재판정에서 잡히지 않았다");

  // 🔴 X1-C **귀속 판정 금지** — 이 축이 D안의 정체성이다.
  //   `두산과의 경기에서 호투했습니다` 는 상대팀 언급이라 **귀속이 아니다.** 그런데
  //   존재판정은 그걸 구분하지 않고 후보로 올려야 한다(구분은 검증 LLM 의 몫).
  //   여기서 hits 가 비면 = 코드가 다시 귀속을 판정하기 시작했다는 뜻이고, 그게 곧
  //   룰 핑퐁 회귀다. 그래서 이 축은 "잡히는가"가 아니라 **"룰이 판단을 참았는가"**를 본다.
  const nonAttributive = detectIdentityContradictions(
    `${pitcher.name} 선수는 투수입니다. 두산과의 경기에서 호투했습니다.`, pitcherIdentity,
  );
  assert.ok(
    nonAttributive.some((h) => h.field === "team"),
    "X1-C: 비귀속 구단 언급이 후보에서 빠졌다 — 코드가 다시 귀속을 판정하고 있다(룰 회귀)",
  );

  // X1-D 같은 구단의 다른 표기(별칭)는 모순이 아니다 — 닫힌 집합 정규화가 동작해야 한다.
  assert.equal(
    detectIdentityContradictions(
      `${pitcher.name} 선수는 에스에스지 랜더스 소속입니다.`, pitcherIdentity,
    ).filter((h) => h.field === "team").length,
    0,
    "X1-D: 같은 구단의 별칭 표기를 모순으로 셌다",
  );

  // 🔴 X1-D2 **양쪽을 같은 함수로 접어야 한다** (2026-08-19 회귀 실측).
  //   `identity.team` 은 호출자가 준 값이라 `SSG`(roster) 일 수도 `SSG 랜더스`(풀네임)
  //   일 수도 있다. 답변 쪽만 정규화하고 identity 쪽을 raw 로 비교하면 **정상 답변이
  //   오귀속으로** 판정된다. roster 값이 이미 정규 코드라 X1-D 만으로는 관측되지 않는다 —
  //   그래서 풀네임 identity 를 명시적으로 만들어 태운다.
  const fullNameIdentity = {
    ...pitcherIdentity,
    team: `${pitcher.team} 랜더스`,
  };
  assert.equal(
    detectIdentityContradictions(
      `${pitcher.name} 선수는 ${pitcher.team} 소속입니다.`, fullNameIdentity,
    ).filter((h) => h.field === "team").length,
    0,
    "X1-D2: 풀네임 구단 표기를 오귀속으로 셌다 — 한쪽만 정규화한 비교",
  );

  // X1-E 상위 범주(`야수`)는 모순이 아니다 + `내야수` 안의 `야수` 가 상위범주로 오인되면 안 된다.
  const outfielder = players.find((p) => p.position === "외야수" && p.team)!;
  const outfielderIdentity = buildPlayerIdentity(
    { entityId: outfielder.kboId, name: outfielder.name, team: outfielder.team }, players,
  )!;
  for (const [subject, wrong] of [
    [outfielderIdentity, "내야수"],
    [pitcherIdentity, "내야수"],
    [pitcherIdentity, "외야수"],
    [pitcherIdentity, "포수"],
  ] as const) {
    assert.ok(
      detectIdentityContradictions(`${subject.name} 선수는 ${wrong}입니다.`, subject)
        .some((h) => h.field === "position" && h.mentioned === wrong),
      `X1-E: ${subject.position} 대상의 \`${wrong}\` 서술이 통과했다 — 부분 문자열(야수) 상위범주 오인`,
    );
  }
  const generic = players.find((p) => p.position === "야수" && p.team);
  if (generic) {
    const genericIdentity = buildPlayerIdentity(
      { entityId: generic.kboId, name: generic.name, team: generic.team }, players,
    )!;
    assert.equal(
      detectIdentityContradictions(`${generic.name} 선수는 내야수입니다.`, genericIdentity)
        .filter((h) => h.field === "position").length,
      0,
      "X1-E2: `야수` 등록 선수를 `내야수` 로 서술한 것은 모순이 아닌데 후보로 셌다",
    );
  }

  // X1-F 정상 답변은 후보가 0건이어야 한다 — 여기가 비지 않으면 X2 의 비용 계약이 무너진다.
  assert.equal(
    detectIdentityContradictions(cleanAnswer(pitcher), pitcherIdentity).length,
    0,
    "X1-F: 정상 답변인데 모순 후보가 잡혔다 — 모든 답변이 검증 LLM 을 태우게 된다",
  );

  // X1-G identity 가 없으면 판정하지 않는다(근거 없는 모순 생성 금지).
  assert.equal(detectIdentityContradictions("아무 말", null).length, 0,
    "X1-G: identity 없이 모순을 만들어냈다");
  pass("X1 존재판정 닫힌 집합 + 귀속 판정 금지(룰 회귀 차단)");

  // ── X2. 모순 토큰 0건이면 검증 LLM 을 부르지 않는다 (비용 계약) ───────────────
  const quietVerifier = makeVerifier(allVerdict("주인공"));
  const cleanResult = await answerQuestion(
    "qa-clean", `${pitcher.name} 어떤 선수야?`,
    makeDeps(pitcher, () => cleanAnswer(pitcher), { verifier: quietVerifier.fn }),
  );
  assert.equal(cleanResult.source, "rag", `X2: 정상 답변이 서빙되지 않았다 (source=${cleanResult.source})`);
  assert.equal(
    SELFTEST ? 1 : quietVerifier.calls, 0,
    `X2: 모순 0건인데 검증 LLM 을 ${quietVerifier.calls}회 호출했다 — 전 답변 과금`,
  );
  pass("X2 모순 0건 → 검증 LLM 호출 없음");

  // ── X3. verdict `제3자` → 그대로 서빙 (정상 답변 과잉 차단 금지) ──────────────
  //   상대팀·과거 이력·동료 서술은 정상이다. 종전 룰 구조가 다섯 왕복 동안 못 닫은 축이
  //   이제 LLM 판정 한 줄로 닫힌다 — 그 결속이 실제로 살아있는지 종단으로 본다.
  const thirdParty = makeVerifier(allVerdict("제3자"));
  const thirdPartyAnswer = `${pitcher.name} 선수는 투수입니다. 두산과의 경기에서 호투했습니다.`;
  const thirdPartyResult = await answerQuestion(
    "qa-3rd", `${pitcher.name} 어떤 선수야?`,
    makeDeps(pitcher, () => thirdPartyAnswer, { verifier: thirdParty.fn }),
  );
  assert.equal(thirdParty.calls, 1, `X3: 검증 LLM 호출이 ${thirdParty.calls}회 — 모순 후보 1건에 1회여야 한다`);
  assert.ok(thirdParty.seen[0]?.hitFields.includes("team"), "X3: 검증기에 team 후보가 전달되지 않았다");
  assert.equal(
    thirdPartyResult.source, "rag",
    `X3: 제3자 판정인데 source=${thirdPartyResult.source} — 정상 답변 과잉 차단`,
  );
  assert.ok(
    thirdPartyResult.answer.includes("호투"),
    "X3: 제3자 판정 답변 본문이 서빙되지 않았다",
  );
  pass("X3 verdict 제3자 → 서빙");

  // ── X4. verdict `주인공` → 재생성 1회, 고쳐지면 서빙 (과잉 차단 금지) ──────────
  //   🔴 재생성 신호를 **프롬프트 본문에서 읽고** 고치는 stub 을 쓴다.
  //      `extras.identityConflict` 를 직접 보게 하면 적재 계약을 훼손해도(신호를 프롬프트에
  //      안 실어도) stub 이 고쳐버려 게이트가 GREEN 이 된다.
  const fixVerifier = makeVerifier(allVerdict("주인공"));
  let fixCalls = 0;
  const fixed = await answerQuestion(
    "qa-fix", `${pitcher.name} 어떤 선수야?`,
    makeDeps(pitcher, (extras) => {
      fixCalls += 1;
      return promptHasRewriteInstruction(extras)
        ? cleanAnswer(pitcher)
        : `${pitcher.name} 선수는 ${pitcher.team} 소속의 내야수입니다.`;
    }, { verifier: fixVerifier.fn }),
  );
  assert.equal(fixCalls, 2, `X4: callRagLlm ${fixCalls}회 — 초기 1 + 재생성 1 이어야 한다`);
  assert.equal(fixed.source, "rag", `X4: 재생성이 고쳤는데 source=${fixed.source} — 과잉 차단`);
  assert.ok(fixed.answer.includes(pitcher.position!), `X4: 재생성 정답(${pitcher.position})이 답변에 없다`);
  // 재생성 결과에 모순이 없으면 검증기를 **다시 부르지 않는다**(불필요한 2차 과금 금지).
  assert.equal(fixVerifier.calls, 1, `X4-2: 재생성이 깨끗한데 검증 LLM 을 ${fixVerifier.calls}회 호출했다`);
  pass("X4 verdict 주인공 → 재생성 1회 → 고쳐지면 서빙");

  // ── X5. 재생성 후에도 충돌이면 unsure, 재생성은 **정확히 1회** ────────────────
  //   양방향으로 본다 — 56840(투수)에 "내야수", 53893(내야수)에 "투수".
  //   한 방향만 보면 "항상 투수로 판정" 같은 고정값 버그를 못 잡는다.
  for (const { id, wrong, label } of [
    { id: "56840", wrong: "내야수", label: "X5 56840 투수 → 내야수 오귀속" },
    { id: "53893", wrong: "투수", label: "X5 53893 내야수 → 투수 오귀속" },
  ]) {
    const row = rosterRow(id, label);
    const stubbornVerifier = makeVerifier(allVerdict("주인공"));
    let calls = 0;
    const stubborn = await answerQuestion(
      "qa-stubborn", `${row.name} 어떤 선수야?`,
      makeDeps(row, () => {
        calls += 1;
        return `${row.name} 선수는 ${row.team} 소속의 ${wrong}입니다. 꾸준히 출전하고 있습니다.`;
      }, { verifier: stubbornVerifier.fn }),
    );
    assert.equal(
      SELFTEST ? "rag" : stubborn.source, "unsure",
      `${label}: 충돌이 남았는데 source=${stubborn.source} — unsure 로 닫히지 않았다`,
    );
    assert.ok(
      !stubborn.answer.includes(wrong),
      `${label}: 주인공(${row.position})과 다른 "${wrong}" 서술이 그대로 서빙됐다 — fail-open`,
    );
    // 재생성은 1회만 — 공급자 과금이 무한히 늘어나면 안 된다.
    assert.equal(calls, 2, `${label}: callRagLlm ${calls}회 — 초기 1 + 재생성 1 이어야 한다`);
    assert.equal(stubbornVerifier.calls, 2, `${label}: 검증 LLM ${stubbornVerifier.calls}회 — 초기 1 + 재생성 1`);
    pass(label);
  }

  // ── X6~X9. fail-close 4종 — 판정 불능은 절대 서빙하지 않는다 ──────────────────
  //   🔴 이게 D안의 안전 축이다. 귀속 판정을 외부 LLM 에 위임했으므로, 그 LLM 이
  //      대답을 못 하는 모든 형태에서 **닫혀야** 한다. 하나라도 열리면 위임 자체가 위험해진다.
  const wrongAnswer = `${pitcher.name} 선수는 ${pitcher.team} 소속의 내야수입니다.`;
  const FAIL_CLOSE_CASES: { label: string; verifier?: QaDeps["verifyIdentityAttribution"] }[] = [
    {
      label: "X6 verdict 불명 → unsure",
      verifier: makeVerifier(allVerdict("불명")).fn,
    },
    {
      label: "X7 검증기 미배선 → unsure",
      verifier: undefined,
    },
    {
      label: "X8 검증기 예외/timeout → unsure",
      verifier: async () => { throw new Error("timeout"); },
    },
    {
      // strict JSON 밖의 값 — 런타임에 무엇이 오든 "불명"으로 접혀야 한다.
      label: "X9 검증기 malformed verdict → unsure",
      verifier: async ({ hits }) => ({ verdicts: hits.map((h) => ({ id: h.id, verdict: "아마도?" })) } as unknown as IdentityVerdictResult),
    },
    {
      // 🔴 검증기가 **객체가 아닌 것**을 돌려주는 경우. 실제 구현은 외부 JSON 파싱
      //   결과라 `undefined`·`null`·문자열이 올 수 있다. 정규화가 없으면 파이프라인이
      //   `verdict` 를 읽다가 TypeError 로 죽는다 — 유저에겐 500 이다.
      //   `불명 → unsure` 로 접히는 것과 **예외로 죽는 것**은 전혀 다른 결과다.
      label: "X9-2 검증기 non-object verdict → unsure",
      verifier: async () => undefined as unknown as IdentityVerdictResult,
    },
  ];
  for (const { label, verifier } of FAIL_CLOSE_CASES) {
    let res: Awaited<ReturnType<typeof answerQuestion>>;
    try {
      res = await answerQuestion(
        "qa-failclose", `${pitcher.name} 어떤 선수야?`,
        makeDeps(pitcher, () => wrongAnswer, { verifier }),
      );
    } catch (error) {
      // 예외를 그대로 흘리면 판정 문구가 TypeError 가 되어 "게이트가 무엇을 잡았는지"를
      // 알 수 없다(M90: exit code 아니라 assertion 문구로 판정한다).
      assert.fail(
        `${label}: 검증 결과 정규화가 없어 파이프라인이 예외로 죽었다 — ${(error as Error).message}`,
      );
    }
    assert.equal(
      SELFTEST ? "rag" : res.source, "unsure",
      `${label}: 판정 불능인데 source=${res.source} — fail-open`,
    );
    assert.ok(!res.answer.includes("내야수"), `${label}: 오귀속 서술이 서빙됐다`);
    pass(label);
  }

  // ── X10. 검증 LLM 토큰이 누적된다 ─────────────────────────────────────────────
  //   보조판정이 공짜로 보이면 "검증이 얼마나 비싼가"의 분모가 깨진다. 종단 로그로 본다.
  let loggedInput: number | null = null;
  let loggedOutput: number | null = null;
  const costVerifier = makeVerifier(allVerdict("제3자", { inputTokens: 700, outputTokens: 11 }));
  const costDeps = makeDeps(pitcher, () => thirdPartyAnswer, {
    verifier: costVerifier.fn,
    llmTokens: { inputTokens: 100, outputTokens: 20 },
  }) as QaDeps & { log: (e: { inputTokens: number | null; outputTokens: number | null }) => Promise<void> };
  costDeps.log = async (entry) => { loggedInput = entry.inputTokens; loggedOutput = entry.outputTokens; };
  await answerQuestion("qa-cost", `${pitcher.name} 어떤 선수야?`, costDeps);
  assert.equal(costVerifier.calls, 1, "X10: 검증 LLM 이 호출되지 않아 토큰 누적을 관측할 수 없다");
  assert.equal(
    SELFTEST ? 100 : loggedInput, 800,
    `X10: 입력 토큰 누적이 ${loggedInput} — 생성 100 + 검증 700 = 800 이어야 한다`,
  );
  assert.equal(
    loggedOutput, 31,
    `X10-2: 출력 토큰 누적이 ${loggedOutput} — 생성 20 + 검증 11 = 31 이어야 한다`,
  );
  pass("X10 검증 LLM 토큰 누적");

  // ── X11. 신원 첫 문장은 코드가 roster 로 렌더한다 ─────────────────────────────
  //   🔴 룰 핑퐁의 근본 해소책이다 — "판정을 잘하는" 대신 "판정할 문장을 코드가 소유"한다.
  //      이 문장은 LLM 산출물이 아니므로 팀·포지션이 구조적으로 틀릴 수 없다.
  const rendered = renderIdentitySentence(pitcherIdentity);
  assert.ok(rendered, "X11: 신원 문장 렌더가 null 이다");
  assert.ok(rendered!.includes(pitcher.name), "X11: 렌더 문장에 이름이 없다");
  assert.ok(rendered!.includes(pitcher.position!), "X11: 렌더 문장에 roster 포지션이 없다");
  assert.ok(rendered!.includes(pitcher.team!), "X11: 렌더 문장에 roster 구단이 없다");
  // 종단 서빙 답변이 **그 렌더 문장으로 시작**해야 한다 — 배선이 끊기면 LLM 문장이 앞에 온다.
  const renderedServe = await answerQuestion(
    "qa-render", `${pitcher.name} 어떤 선수야?`,
    makeDeps(pitcher, () => "데뷔 이후 꾸준히 출전하고 있습니다.", { verifier: quietVerifier.fn }),
  );
  assert.equal(renderedServe.source, "rag", `X11-2: 정상 답변이 서빙되지 않았다 (${renderedServe.source})`);
  assert.ok(
    renderedServe.answer.startsWith(rendered!),
    "X11-2: 서빙 답변이 코드 렌더 신원 문장으로 시작하지 않는다 — roster SSOT 배선 끊김",
  );
  pass("X11 신원 첫 문장 코드 렌더(roster SSOT)");

  // ── Y1. identity 미결속은 **종단 unsure** (삼순 2026-08-27 ①) ──────────────────
  //   🔴 종전에는 `buildPlayerIdentity` 가 null 을 주면 **빈 extras 로 RAG 를 그대로 탔다**.
  //      그러면 생성 답변 검증도, 코드 렌더 신원문장도 없이 답이 나간다 — 오귀속을 막는
  //      장치가 전부 꺼진 상태로 서빙되는 fail-open 이다. helper 가 null 을 준 것은
  //      "결속할 사실이 없다" 는 뜻이므로 답하지 않는 것이 맞다.
  //   재현: kboId 는 같은데 이름이 다른 행이 섞인 손상 로스터(상류 버그·pick payload 손상).
  //
  //   🔴 **행 순서가 계약이다** (1차 실측에서 이 축이 false-green 이었다).
  //     `buildIdentityBlock` 은 kboId 로 `find` 해 **첫 행**을 잡고 그 이름과 candidate.name 을
  //     비교한다. 둘이 같은 이름이면 fail-close 가 안 돌고, 그런데도 다른 이유로 unsure 가
  //     나오면 게이트는 "잡았다"고 착각한다(종전 결함 주입 M31 이 미검출로 드러냈다).
  //     그래서 `다른이름` 을 **먼저** 두고, 질문은 `결속실패선수`(둘째 행)로 물어
  //     candidate.name ≠ 첫 행 이름 이 되게 한다.
  const corruptedRoster: PlayerRef[] = [
    { name: "다른이름", kboId: "99999", team: "LG", position: "투수" },
    { name: "결속실패선수", kboId: "99999", team: "LG", position: "투수" },
  ] as PlayerRef[];
  {
    // 손상 로스터에서 이름 충돌이 실제로 발생하는지 먼저 고정한다(전제 붕괴 방지).
    assert.equal(
      buildPlayerIdentity({ entityId: "99999", name: "결속실패선수" }, corruptedRoster),
      null,
      "Y1-0: 이름 충돌인데 identity 가 만들어졌다 — 재현 전제 붕괴",
    );
    let ragCalls = 0;
    // 🔴 **searchRag 호출 여부가 유일하게 신뢰할 수 있는 판별자다** (M31 결함주입 실측).
    //   fail-close 를 지우면 unsure 는 여전히 나온다 — 근거가 비어 generic 으로 새고
    //   거기서 또 unsure 가 되기 때문이다. 즉 `source==="unsure"` 만 보면 이 축은
    //   **원인을 구분하지 못하는 false-green** 이다(내 1차 게이트가 정확히 그랬다).
    //   fail-close 는 `answerPlayerDescriptiveQuestion` **진입 전에** 종결하므로
    //   근거 검색 자체가 일어나지 않는다. 그 차이만이 결함을 관측 가능하게 만든다.
    let searchRagCalls = 0;
    const unboundDeps = {
      loadGlossary: async () => [],
      loadPlayers: async () => corruptedRoster,
      getCache: async () => null,
      loadPreviousTurn: async () => null,
      setCache: async () => {},
      callLlm: async () => ({ text: "{}", inputTokens: null, outputTokens: null }),
      reserveDaily: async (_u: string, limit: number) => ({ allowed: true, remaining: limit - 1 }),
      log: async () => {},
      now: () => Date.now(),
      enablePlayerRag: true,
      searchRag: async () => {
        searchRagCalls += 1;
        return [{
          pageTitle: "문서", sectionPath: "개요", content: "LG 소속 투수입니다.",
          canonicalUrl: "https://namu.wiki/w/test", sourceGrade: "tier2",
        }];
      },
      verifyIdentityAttribution: makeVerifier(allVerdict("제3자")).fn,
      callRagLlm: async () => {
        ragCalls += 1;
        return {
          text: JSON.stringify({ status: "GROUNDED", answer: "데뷔 이후 꾸준히 출전하고 있습니다." }),
          inputTokens: 1, outputTokens: 1,
        };
      },
    } as unknown as QaDeps;
    const unboundResult = await answerQuestion("qa-unbound", "결속실패선수 어떤 선수야?", unboundDeps);
    assert.equal(
      SELFTEST ? "rag" : unboundResult.source, "unsure",
      `Y1: identity 미결속인데 source=${unboundResult.source} — 검증·신원문장 없이 서빙(fail-open)`,
    );
    // 결속이 안 됐으면 **생성 자체를 하지 않는다** — 못 쓸 답에 공급자 비용을 쓰지 않는다.
    assert.equal(ragCalls, 0, `Y1-2: identity 미결속인데 callRagLlm 을 ${ragCalls}회 호출했다`);
    // 🔴 원인 판별자 — fail-close 가 없으면 근거 검색까지 들어갔다가 다른 이유로 unsure 가 된다.
    assert.equal(
      SELFTEST ? 1 : searchRagCalls, 0,
      `Y1-3: identity 미결속인데 근거 검색이 ${searchRagCalls}회 일어났다 — 종단 fail-close 가 아니라 다른 경로로 새고 있다`,
    );
  }
  pass("Y1 identity 미결속 → 종단 unsure (RAG 미호출)");

  // ── Y2. 여러 hit 는 **ID별 verdict 완전일치**로 판정한다 (삼순 2026-08-27 ②) ──────
  //   🔴 종전에는 첫 hit 만 보고(`.find`/`break`) 단일 verdict 로 접었다. 그래서
  //      `형은 내야수입니다. 본인은 포수입니다` 에서 첫 hit(내야수)가 제3자로 판정되면
  //      뒤의 **주인공 오귀속(포수)이 그대로 서빙**됐다. 혼합 귀속을 표현할 수가 없었다.
  const MIXED_ANSWER = `${pitcher.name} 선수의 형은 내야수입니다. 본인은 포수입니다.`;
  const mixedHits = detectIdentityContradictions(MIXED_ANSWER, pitcherIdentity);
  assert.ok(
    mixedHits.length >= 2,
    `Y2-0: 혼합 문장에서 hit 가 ${mixedHits.length}건 — 여러 occurrence 를 못 올리고 있다(첫 건만 보는 구조)`,
  );
  assert.equal(
    new Set(mixedHits.map((hit) => hit.id)).size, mixedHits.length,
    "Y2-0b: hit ID 가 중복된다 — ID별 판정이 성립하지 않는다",
  );

  //   Y2-a 첫 hit 제3자 + 뒤 hit 주인공 → **서빙되면 안 된다**.
  {
    let rewriteHitIds: string[] = [];
    const mixedVerifier = makeVerifier((_call, hits) => ({
      // 앞의 `내야수`(형) 는 제3자, 뒤의 `포수`(본인) 는 주인공 — 실제 혼합 귀속 재현.
      verdicts: hits.map((hit) => ({
        id: hit.id,
        verdict: hit.mentioned === "내야수" ? ("제3자" as const) : ("주인공" as const),
      })),
    }));
    const mixed = await answerQuestion(
      "qa-mixed", `${pitcher.name} 어떤 선수야?`,
      makeDeps(pitcher, () => MIXED_ANSWER, {
        verifier: mixedVerifier.fn,
        onExtras: (extras) => {
          if (extras?.identityConflicts) rewriteHitIds = extras.identityConflicts.map((hit) => hit.id);
        },
      }),
    );
    assert.equal(
      SELFTEST ? "rag" : mixed.source, "unsure",
      `Y2-a: 뒤쪽 hit 가 주인공인데 source=${mixed.source} — 첫 hit 판정으로 덮였다(fail-open)`,
    );
    // 재작성 신호에는 **주인공으로 판정된 hit 만, 그리고 전부** 실려야 한다.
    assert.ok(
      rewriteHitIds.length > 0 && rewriteHitIds.every((id) => id !== "position:내야수"),
      `Y2-b: 재작성 신호가 비었거나 제3자 hit 가 섞였다 — ${JSON.stringify(rewriteHitIds)}`,
    );
  }

  //   Y2-c 누락·중복·미지 ID·비정상 verdict 는 **전부 fail-close**.
  //     "7개 중 6개만 판정됐다" 를 부분 신뢰하면 판정 안 된 hit 가 조용히 안전 처리된다.
  const MALFORMED_CASES: { label: string; fn: NonNullable<QaDeps["verifyIdentityAttribution"]> }[] = [
    {
      label: "Y2-c 일부 hit 판정 누락 → unsure",
      fn: async ({ hits }) => ({ verdicts: hits.slice(1).map((h) => ({ id: h.id, verdict: "제3자" as const })) }),
    },
    {
      label: "Y2-d 동일 ID 중복 판정 → unsure",
      fn: async ({ hits }) => ({
        verdicts: [
          { id: hits[0].id, verdict: "제3자" as const },
          { id: hits[0].id, verdict: "제3자" as const },
        ],
      }),
    },
    {
      label: "Y2-e 존재하지 않는 ID 반환 → unsure",
      fn: async ({ hits }) => ({
        verdicts: hits.map((h, index) => ({ id: index === 0 ? "position:없는토큰" : h.id, verdict: "제3자" as const })),
      }),
    },
  ];
  for (const { label, fn } of MALFORMED_CASES) {
    const res = await answerQuestion(
      "qa-verdict-shape", `${pitcher.name} 어떤 선수야?`,
      makeDeps(pitcher, () => MIXED_ANSWER, { verifier: fn }),
    );
    assert.equal(
      SELFTEST ? "rag" : res.source, "unsure",
      `${label}: 판정 계약 위반인데 source=${res.source} — 부분 수용(fail-open)`,
    );
  }
  //   Y2-e 🔴 **같은 토큰**이 비귀속/귀속 문맥에 각각 나오는 경우 (삼순 재리뷰 ①).
  //     종전엔 `seen(token)` 으로 합쳐서 `position:내야수` **1건**으로 접혔다 — 그러면
  //     앞의 비귀속(형) 판정 하나로 뒤의 오귀속(본인)이 다시 가려진다.
  //     ②에서 "전부 올린다" 고 했지만 그건 **토큰 종류**별이었고 occurrence 단위가 아니었다.
  const SAME_TOKEN_ANSWER = `${pitcher.name} 선수의 형도 내야수입니다. 본인도 내야수입니다.`;
  {
    const sameTokenHits = detectIdentityContradictions(SAME_TOKEN_ANSWER, pitcherIdentity);
    const positionHits = sameTokenHits.filter((hit) => hit.mentioned === "내야수");
    assert.equal(
      SELFTEST ? 1 : positionHits.length, 2,
      `Y2-e: 같은 토큰 2회 등장인데 hit 가 ${positionHits.length}건 — occurrence 가 하나로 접혔다(혼합 귀속 표현 불가)`,
    );
    assert.equal(
      new Set(positionHits.map((hit) => hit.id)).size, positionHits.length,
      `Y2-e2: 같은 토큰의 occurrence 들이 같은 ID 를 쓴다 — ID별 판정이 성립 안 한다: ${JSON.stringify(positionHits.map((h) => h.id))}`,
    );
    // 검증기가 둘을 구분하려면 **위치 근거(문장)**가 있어야 한다 — id 만으론 둘 다 같은 단어다.
    const excerpts = positionHits.map((hit) => hit.excerpt);
    assert.ok(
      excerpts.every((text) => text.length > 0) && new Set(excerpts).size === excerpts.length,
      `Y2-e3: occurrence 별 문맥(excerpt)이 없거나 같다 — 검증기가 둘을 구분할 수단이 없다: ${JSON.stringify(excerpts)}`,
    );

    // 종단: 앞의 등장은 제3자(형), 뒤의 등장은 주인공(본인) → 서빙되면 안 된다.
    let rewriteExcerpts: (string | undefined)[] = [];
    const sameTokenVerifier = makeVerifier((_call, hits) => ({
      verdicts: hits.map((hit) => ({
        id: hit.id,
        // 문장으로 가른다 — 검증기가 excerpt 를 받아야만 가능한 판정이다.
        verdict: hit.excerpt.includes("형도") ? ("제3자" as const) : ("주인공" as const),
      })),
    }));
    const sameTokenResult = await answerQuestion(
      "qa-same-token", `${pitcher.name} 어떤 선수야?`,
      makeDeps(pitcher, () => SAME_TOKEN_ANSWER, {
        verifier: sameTokenVerifier.fn,
        onExtras: (extras) => {
          if (extras?.identityConflicts) {
            rewriteExcerpts = extras.identityConflicts.map((hit) => hit.excerpt);
          }
        },
      }),
    );
    assert.equal(
      SELFTEST ? "rag" : sameTokenResult.source, "unsure",
      `Y2-e4: 같은 토큰의 뒤 등장이 오귀속인데 source=${sameTokenResult.source} — 앞 등장 판정으로 덮였다`,
    );
    // 재작성 신호에도 **어느 문장**인지가 실려야 한다 — 없으면 정상 문장까지 고치게 된다.
    assert.ok(
      rewriteExcerpts.length > 0 && rewriteExcerpts.every((text) => (text ?? "").includes("본인도")),
      `Y2-e5: 재작성 신호에 오귀속 문장이 실리지 않았다 — ${JSON.stringify(rewriteExcerpts)}`,
    );
  }

  //   Y2-f 같은 구단이 두 문장에 각각 나오는 경우도 occurrence 별로 올라와야 한다.
  {
    const TEAM_TWICE = `${pitcher.name} 선수는 두산과의 경기에서 호투했습니다. 그는 두산 소속입니다.`;
    const teamHits = detectIdentityContradictions(TEAM_TWICE, pitcherIdentity)
      .filter((hit) => hit.field === "team" && hit.mentioned === "두산");
    assert.equal(
      SELFTEST ? 1 : teamHits.length, 2,
      `Y2-f: 같은 구단 2회 등장인데 hit 가 ${teamHits.length}건 — 팀당 1건으로 접힌다`,
    );
    assert.equal(
      new Set(teamHits.map((hit) => hit.id)).size, teamHits.length,
      "Y2-f2: 같은 구단의 occurrence 들이 같은 ID 를 쓴다",
    );
  }

  //   Y2-g ID 는 **내용에서 파생**된다 — 같은 답변이면 항상 같은 ID 집합이어야 한다.
  //     호출마다 달라지면(예: 전역 카운터) 검증기 응답과 영영 안 맞는다.
  {
    const a = detectIdentityContradictions(SAME_TOKEN_ANSWER, pitcherIdentity).map((hit) => hit.id);
    const b = detectIdentityContradictions(SAME_TOKEN_ANSWER, pitcherIdentity).map((hit) => hit.id);
    assert.deepEqual(a, b, "Y2-g: 같은 입력인데 hit ID 가 호출마다 달라진다 — 전역 상태 오염");
  }
  pass("Y2 occurrence 별 ID + 동일 토큰 혼합 귀속 차단 + 완전일치");

  // ── Y3. 닫힌 집합으로 **구분 불가한** 동명이인 (삼순 2026-08-27 ③) ──────────────
  //   🔴 이름·팀·포지션이 전부 같으면 닫힌 모순 필터가 원리적으로 0건이다. 그러면
  //      검증 LLM 이 한 번도 안 돌고 동명이인의 **경력·생년·기록** 서술이 그대로 서빙된다
  //      (설계상 통과). 실측 3쌍: 69516/56664(김현수 KIA 투수) · 52731/56709(박준영 한화
  //      투수) · 60146/51454(이승현 삼성 투수).
  const twinPairs = players
    .map((row) => ({
      row,
      twins: players.filter((other) => other.kboId !== row.kboId
        && other.name === row.name
        && (other.team ?? null) === (row.team ?? null)
        && (other.position ?? null) === (row.position ?? null)),
    }))
    .filter((entry) => entry.twins.length > 0);
  assert.ok(
    twinPairs.length > 0,
    "Y3-0: 같은 팀·같은 포지션 동명이인이 로스터에 없다 — 픽스처 전제 갱신 필요",
  );
  {
    const { row: twin, twins } = twinPairs[0];
    const twinIdentity = buildPlayerIdentity(
      { entityId: twin.kboId, name: twin.name, team: twin.team }, players,
    )!;
    assert.deepEqual(
      twinIdentity.indistinguishableNamesakes.map((row) => row.kboId).sort(),
      twins.map((t) => t.kboId).sort(),
      "Y3-1: 구분 불가 동명이인 목록이 roster 실측과 다르다",
    );
    // 🔴 **가를 근거가 실어있는가** (삼순 재리뷰 ②).
    //   kboId 만 들고 있으면 검증기는 "이 경력이 누구 것인가" 를 원리적으로 판정할 수 없다.
    //   같은 팀·같은 포지션이라 남는 roster 축은 생년·등번호뿐이다.
    for (const namesake of twinIdentity.indistinguishableNamesakes) {
      const source = twins.find((t) => t.kboId === namesake.kboId)!;
      assert.equal(
        SELFTEST ? "" : namesake.birthDate, source.birthDate ?? null,
        `Y3-1b: 동명이인 ${namesake.kboId} 의 생년이 실리지 않았다 — 검증기가 가를 근거가 없다`,
      );
      assert.equal(
        namesake.backNo, source.backNo ?? null,
        `Y3-1c: 동명이인 ${namesake.kboId} 의 등번호가 실리지 않았다`,
      );
    }
    // 주인공과 동명이인의 생년이 **실제로 다르지** 않으면 근거를 준 의미가 없다.
    assert.ok(
      twinIdentity.birthDate
        && twinIdentity.indistinguishableNamesakes.some((row) => row.birthDate && row.birthDate !== twinIdentity.birthDate),
      "Y3-1d: 주인공·동명이인의 생년이 구분되지 않는다 — 판정 근거가 성립 안 한다",
    );
    // 소속·포지션이 같으니 닫힌 모순은 0건이다 — 그런데도 검증은 반드시 돌아야 한다.
    // ⚠️ 숫자를 쓰지 않는다 — tier2 선수 경로는 근거 밖 숫자를 전면 폐기하므로(`numericTokensGrounded`)
    //   숫자가 섞이면 신원 검증 **이전 단계**에서 죽어 이 축이 관측 불가가 된다(1차 실측 RED).
    const cleanTwinAnswer = `${twin.name} 선수는 신인드래프트에서 지명된 뒤 데뷔 시즌부터 선발로 나섬습니다.`;
    const twinHits = detectIdentityContradictions(cleanTwinAnswer, twinIdentity);
    assert.equal(
      twinHits.filter((hit) => hit.field !== "biography").length, 0,
      "Y3-2: 재현 전제 붕괴 — 닫힌 모순이 0건이어야 이 축이 의미가 있다",
    );
    assert.ok(
      twinHits.some((hit) => hit.field === "biography" && twins.some((t) => t.kboId === hit.mentioned)),
      "Y3-3: 구분 불가 동명이인인데 검증 대상(biography hit)이 만들어지지 않았다 — 설계상 통과",
    );

    // 종단: 동명이인의 경력이 주인공 것으로 서술됐다고 판정되면 서빙되지 않아야 한다.
    const twinVerifier = makeVerifier(allVerdict("주인공"));
    const twinResult = await answerQuestion(
      "qa-twin", `${twin.name} 어떤 선수야?`,
      makeDeps(twin, () => cleanTwinAnswer, { verifier: twinVerifier.fn }),
    );
    assert.ok(
      twinVerifier.calls > 0,
      "Y3-4: 구분 불가 동명이인인데 검증 LLM 이 한 번도 호출되지 않았다 — 경력 오귀속 무검증 통과",
    );
    assert.equal(
      SELFTEST ? "rag" : twinResult.source, "unsure",
      `Y3-5: 경력 오귀속 확정인데 source=${twinResult.source}`,
    );

    // 반대 방향: 제3자(그런 서술 없음) 판정이면 정상 서빙돼야 한다(과잉 차단 금지).
    const twinSafe = await answerQuestion(
      "qa-twin-safe", `${twin.name} 어떤 선수야?`,
      makeDeps(twin, () => cleanTwinAnswer, { verifier: makeVerifier(allVerdict("제3자")).fn }),
    );
    assert.equal(
      twinSafe.source, "rag",
      `Y3-6: 오귀속이 없다고 판정됐는데 source=${twinSafe.source} — 과잉 차단`,
    );
  }
  pass("Y3 구분 불가 동명이인 경력·생년 오귀속 종단 차단");

  // ── N. server 어댑터 종단 배선 + 검증기 계약 (삼순 4차 P0) ────────────────────
  //   🔴 게이트가 `buildRagLlmRequest` 를 직접 부르면, 실제 전송 경로인 server 어댑터가
  //      extras 를 빠뜨려도 잡지 못한다 — 재생성이 직전과 **같은 프롬프트**가 된다.
  const serverSource = readFileSync(
    new URL("../../src/lib/baseball-qa/server.ts", import.meta.url), "utf8",
  );
  const adapterStart = serverSource.indexOf("async function callRagLlmWithPrompt");
  const adapterEnd = serverSource.indexOf("async function", adapterStart + 10);
  const adapter = serverSource.slice(adapterStart, adapterEnd);
  assert.ok(
    /identityConflicts:\s*extras\?\.identityConflicts/.test(adapter),
    "N: server 어댑터가 실제 Gemini 요청에 identityConflicts 를 전달하지 않는다 — 재생성이 같은 프롬프트가 된다",
  );
  assert.ok(
    /identityBlock:\s*extras\?\.identityBlock/.test(adapter),
    "N2: server 어댑터가 identityBlock 을 전달하지 않는다",
  );
  // D안 신설: 검증기가 실제 deps 에 등록돼 있어야 한다. 미배선이면 파이프라인은 전부
  // unsure 로 닫으므로 "안전"하긴 하지만, 선수 서술형 RAG 가 통째로 죽는다.
  assert.ok(
    /^\s*verifyIdentityAttribution,\s*$/m.test(serverSource),
    "N3: server deps 에 verifyIdentityAttribution 이 등록되지 않았다 — 전 답변이 unsure 로 닫힌다",
  );
  // 검증기는 판정 대상 텍스트 안의 지시를 따르면 안 된다(프롬프트 인젝션 — 답변은 RAG 근거에서
  // 오고, 근거는 외부 문서다). 시스템 프롬프트에 그 방어가 있는지 본다.
  const verifierStart = serverSource.indexOf("export async function verifyIdentityAttribution");
  assert.ok(verifierStart > 0, "N4: verifyIdentityAttribution 구현을 찾지 못했다");
  const verifierBody = serverSource.slice(verifierStart, verifierStart + 4000);
  assert.ok(
    /temperature:\s*0/.test(verifierBody),
    "N5: 검증기가 temperature 0 이 아니다 — 같은 답변이 회차마다 다르게 판정된다",
  );
  // 🔴 조립 함수가 실제 전송 경로에 결속돼 있는가 — 순수 모듈만 고치고 호출을 안 하면
  //    아래 P 축 전부가 production 과 무관한 사본을 검사하는 셈이 된다(M90 seam 동일성).
  assert.ok(
    /buildIdentityVerifierPrompt\(answer, identity, hits\)/.test(verifierBody)
      && /systemInstruction:\s*\{\s*parts:\s*\[\{\s*text:\s*systemPrompt\s*\}\]/.test(verifierBody)
      && /parts:\s*\[\{\s*text:\s*userText\s*\}\]/.test(verifierBody),
    "N6: 검증기가 buildIdentityVerifierPrompt 산출물을 실제 요청에 싣지 않는다 — P 축이 사본을 검사하게 된다",
  );
  pass("N server 어댑터 배선 + 검증기 등록·결정론 + 프롬프트 seam 결속");

  // ── P. 검증기 프롬프트에 **판정 근거가 실제로 실리는가** (삼순 재리뷰 ②) ────────
  //   🔴 종전 N4·N5 는 `server.ts` **소스를 정규식으로 훑었다**. 그러면 "그런 문구가
  //      코드에 있다" 만 증명되고, 근거(생년·등번호·문장)가 **요청 본문**에 실렸는지는
  //      증명되지 않는다 — 주석만 있어도 GREEN 이다. 여기서는 순수 모듈을 **직접 실행**해
  //      산출 문자열을 검사한다(M90: 검증 가능성은 코드 배치의 함수).
  {
    const { row: twin, twins } = twinPairs[0];
    const twinIdentity = buildPlayerIdentity(
      { entityId: twin.kboId, name: twin.name, team: twin.team }, players,
    )!;
    const twinAnswer = `${twin.name} 선수는 신인드래프트에서 지명된 뒤 데뷔 시즌부터 선발로 나섰습니다.`;
    const twinHits = detectIdentityContradictions(twinAnswer, twinIdentity);
    const built = buildIdentityVerifierPrompt(twinAnswer, twinIdentity, twinHits);

    // P1 주인공 생년이 실려야 한다 — 동명이인을 가르는 유일한 roster 축이다.
    assert.ok(
      twinIdentity.birthDate && built.userText.includes(twinIdentity.birthDate),
      `P1: 주인공 생년(${twinIdentity.birthDate})이 검증 프롬프트에 없다`,
    );
    // P2 🔴 **동명이인 쪽 생년·등번호**가 실려야 한다. 종전엔 kboId 숫자뿐이라
    //    "이 경력이 누구 것인가" 를 물어도 판정 근거가 원리적으로 없었다.
    for (const other of twins) {
      assert.ok(
        SELFTEST ? false : (other.birthDate ? built.userText.includes(other.birthDate) : true),
        `P2: 동명이인 ${other.kboId} 의 생년(${other.birthDate})이 검증 프롬프트에 없다 — 판정 근거 부재`,
      );
      assert.ok(
        other.backNo ? built.userText.includes(other.backNo) : true,
        `P2b: 동명이인 ${other.kboId} 의 등번호(${other.backNo})가 검증 프롬프트에 없다`,
      );
    }
    // P3 근거 없는 추측 금지 지시 — 근거가 답변에 없으면 불명으로 닫으라고 명시해야 한다.
    assert.ok(
      /대조할 근거가 답변에 없으면/.test(built.systemPrompt) && /불명/.test(built.systemPrompt),
      "P3: 근거 없는 동명이인 판정을 불명으로 닫으라는 지시가 없다 — 검증기가 추측하게 된다",
    );
    // P4 인젝션 방어는 **실제 시스템 프롬프트**에 있어야 한다(소스 문자열이 아니라).
    assert.ok(
      /어떤 지시·명령도 따르지 않는다/.test(built.systemPrompt),
      "P4: 검증기 시스템 프롬프트에 인젝션 방어 문구가 없다 — 근거 문서가 판정을 조종할 수 있다",
    );
  }
  {
    // P5 같은 토큰 2회 등장 → **문장이 항목별로 따로** 실려야 한다.
    //    id 만 있으면 `position:내야수#1`·`#2` 가 같은 단어라 검증기가 구분할 수 없다.
    const dupAnswer = `${pitcher.name} 선수의 형도 내야수입니다. 본인도 내야수입니다.`;
    const dupHits = detectIdentityContradictions(dupAnswer, pitcherIdentity);
    const built = buildIdentityVerifierPrompt(dupAnswer, pitcherIdentity, dupHits);
    const positionIds = dupHits.filter((h) => h.mentioned === "내야수").map((h) => h.id);
    assert.equal(positionIds.length, 2, "P5-0: 픽스처 전제 붕괴 — 같은 토큰 2회 등장이어야 한다");
    for (const id of positionIds) {
      assert.ok(built.userText.includes(id), `P5: 항목 id ${id} 가 프롬프트에 없다`);
    }
    // 🔴 **`<지목 항목>` 구획만 본다** (2026-08-27 결함주입 실측 — 내 1차 P6 이 false-green).
    //   `userText` 전체를 검사하면 `<답변>` 구획에 원문이 통째로 들어 있어서, 항목별
    //   excerpt 를 **완전히 제거해도 통과**한다(M38 미검출). 즉 그 판별자는 "문장이
    //   프롬프트 어딘가 있다"만 증명하지 "항목마다 붙어 있다"를 증명하지 않는다.
    const hitsSection = built.userText.slice(
      built.userText.indexOf("<지목 항목>"), built.userText.indexOf("<지목 항목 끝>"),
    );
    assert.ok(
      hitsSection.length > 0,
      "P6-0: <지목 항목> 구획을 찾지 못했다 — 프롬프트 구조가 바뀌었다",
    );
    assert.ok(
      hitsSection.includes("형도 내야수입니다.") && hitsSection.includes("본인도 내야수입니다."),
      `P6: 같은 토큰의 두 등장 문장이 **항목별로** 실리지 않았다 — 검증기가 둘을 구분할 수단이 없다\n${hitsSection}`,
    );
    assert.ok(
      /등장별로 따로/.test(built.systemPrompt),
      "P7: 같은 토큰을 등장별로 따로 판정하라는 지시가 없다 — 하나로 묶어 판정하게 된다",
    );
  }
  pass("P 검증 프롬프트 종단 적재(동명이인 구분 사실 + occurrence 문장) — 실행 검사");

  console.log(`\ngenius-rag-identity-binding-smoke PASS (${passed} checks)`);
}

/**
 * `--selftest` — 이 게이트가 쓰는 **판정 키가 RED 를 낼 수 있는지** 증명한다.
 *
 * main() 안의 `SELFTEST ? … : …` 지점들이 결함을 주입한다. 결함이 주입됐는데도
 * main() 이 끝까지 통과하면 = 그 판정 키는 아무것도 판정하지 못한다는 뜻이다.
 *
 * ⚠️ 이건 **검증력 증명이 아니다**(M90). 실제 production 결함을 잡는지는
 *    소스를 변조해 태우는 `qa:genius-rag-identity:mutations` 만 증명한다.
 */
async function selftest() {
  let threw: Error | null = null;
  try {
    await main();
  } catch (error) {
    threw = error as Error;
  }
  if (!threw) {
    console.error(
      "\ngenius-rag-identity-binding-smoke SELFTEST FAIL: 결함을 주입했는데 게이트가 통과했다 — 판정 키가 죽어있다",
    );
    process.exit(1);
  }
  console.log(`\ngenius-rag-identity-binding-smoke SELFTEST PASS — 주입 결함 검출: ${threw.message}`);
}

if (SELFTEST) {
  void selftest();
} else {
  main().catch((error) => {
    console.error(`\ngenius-rag-identity-binding-smoke FAIL: ${(error as Error).message}`);
    process.exit(1);
  });
}
