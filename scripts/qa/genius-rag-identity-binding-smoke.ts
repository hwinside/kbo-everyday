/**
 * 야잘알봇 RAG **주인공 인물 결속** 계약 게이트.
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
 * ⚠️ 왜 근거 선별로 막지 않는가
 *   오귀속 문장은 주인공 본인 문서의 **정당한 일부**다(별명 유래·일화가 같은 문단에 있다).
 *   잘라내면 정상 정보까지 잃는다. 그래서 근거를 자르는 대신 **주인공이 누구인지 명시**해
 *   제3자 서술과 구분하게 한다. 값은 전부 roster SSOT 에서 온다(모델 기억 아님).
 *
 * 검증 축 (전부 **배포 함수**를 실제로 호출한다 — 문자열 존재 검사 금지):
 *   A. `buildIdentityBlock` 이 roster 실데이터로 주인공 kboId·포지션·동명이인을 만든다
 *   B. roster 에 없는 kboId 는 `null` — 빈 블록으로 "결속했다"는 착각을 만들지 않는다
 *   C. `buildRagLlmRequest` 가 그 블록을 **실제 프롬프트 본문**에 싣는다(질문 앞)
 *   D. 종단 `answerQuestion` 이 RAG 경로에서 `callRagLlm` 에 `identityBlock` 을 넘긴다
 *      — 이게 production seam 이다. 헬퍼만 테스트하면 배선이 끊겨도 GREEN 이다.
 *   E. 동명이인이 없는 선수는 동명이인 줄을 만들지 않는다(허위 경고 금지)
 *
 * `--selftest`: 판정 임계를 뒤집어 이 게이트가 RED 를 낼 수 있는지 증명한다.
 *
 * 실행: npm run qa:genius-rag-identity
 */
import assert from "node:assert/strict";
import {
  answerQuestion,
  buildIdentityBlock,
  type PlayerRef,
  type QaDeps,
  type RagLlmExtras,
} from "../../src/lib/baseball-qa/pipeline";
import { buildRagLlmRequest } from "../../src/lib/baseball-qa/rag/retrieve";
import roster from "../../src/lib/constants/players-roster.json";

const SELFTEST = process.argv.includes("--selftest");
const IDENTITY_HEADING = "<질문 대상";

/** 실제 로스터에서 동명이인 그룹을 뽑는다 — 픽스처를 손으로 적으면 로스터가 변해도 GREEN 이다. */
const players = (roster as PlayerRef[]).map((row) => ({
  name: row.name,
  kboId: String(row.kboId),
  team: row.team ?? null,
  position: row.position ?? null,
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
  const evidenceRow = {
    pageTitle: `${target.name} 문서`, sectionPath: "개요",
    content: `${target.name}. ${target.team ?? ""} 소속 ${target.position ?? ""}. 같은 팀에 동명이인인 선수가 있습니다. 데뷔 이후 꾸준히 출전하고 있습니다.`,
    canonicalUrl: "https://namu.wiki/w/test", sourceGrade: "tier2",
  };
  const deps = {
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
    pickedPlayerKboId: target.kboId,
    searchRag: async () => [evidenceRow],
    callRagLlm: async (_q: string, _ev: unknown, extras?: RagLlmExtras) => {
      observed = extras;
      return {
        text: JSON.stringify({ status: "GROUNDED", answer: `${target.name} 선수는 ${target.team} 소속 ${target.position}입니다.` }),
        inputTokens: 1, outputTokens: 1,
      };
    },
  } as unknown as QaDeps;

  const result = await answerQuestion("qa-identity", `${target.name} 어떤 선수야?`, deps);
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
  pass("D production seam 결속 전달");

  console.log(`\ngenius-rag-identity-binding-smoke PASS (${passed} checks)`);
}

main().catch((error) => {
  console.error(`\ngenius-rag-identity-binding-smoke FAIL: ${(error as Error).message}`);
  process.exit(1);
});
