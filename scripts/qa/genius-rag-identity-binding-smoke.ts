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
import { readFileSync } from "node:fs";
import {
  answerQuestion,
  buildIdentityBlock,
  buildPlayerIdentity,
  detectIdentityConflict,
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

/** 재작성 지시가 **실제 프롬프트 본문**에 실렸는가 — 모델이 볼 수 있는 유일한 표면이다. */
function promptHasRewriteInstruction(extras?: RagLlmExtras): boolean {
  if (!extras) return false;
  const req = buildRagLlmRequest("q", [{
    pageTitle: "t", sectionPath: "s", content: "c",
    canonicalUrl: "https://namu.wiki/w/x", sourceGrade: "tier2",
  } as never], undefined, {
    identityBlock: extras.identityBlock,
    identityConflict: extras.identityConflict,
  });
  return String(req.contents[0].parts[0].text).includes("<재작성 지시");
}

/**
 * 종단 `answerQuestion` 을 태우기 위한 deps 팩토리.
 *
 * 🔴 `answerFor` 를 **호출자가 준다**는 점이 핵심이다 (삼순 2026-08-19 3차).
 *   종전 stub 은 정답을 직접 반환해서 "프롬프트에 실렸다"만 봤다. 실제 사고는 모델이
 *   지시를 어긴 것이므로, 게이트는 **어기는 모델**도 태울 수 있어야 한다.
 *   재생성 호출도 같은 stub 을 다시 부르므로 호출 횟수·응답 변화를 호출자가 통제한다.
 */
function makeDeps(
  subject: PlayerRef,
  answerFor: (extras?: RagLlmExtras) => string,
  onExtras?: (extras: RagLlmExtras | undefined) => void,
): QaDeps {
  const evidenceRow = {
    pageTitle: `${subject.name} 문서`, sectionPath: "개요",
    // 실측 사고 재현: 주인공 문서 안에 **동명이인의 다른 포지션** 서술이 함께 있다.
    content: `${subject.name}. ${subject.team ?? ""} 소속 ${subject.position ?? ""}. 같은 팀에 동명이인인 선수가 있습니다. 데뷔 이후 꾸준히 출전하고 있습니다.`,
    canonicalUrl: "https://namu.wiki/w/test", sourceGrade: "tier2",
  };
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
    callRagLlm: async (_q: string, _ev: unknown, extras?: RagLlmExtras) => {
      onExtras?.(extras);
      return {
        text: JSON.stringify({ status: "GROUNDED", answer: answerFor(extras) }),
        inputTokens: 1, outputTokens: 1,
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
  const evidenceRow = {
    pageTitle: `${target.name} 문서`, sectionPath: "개요",
    content: `${target.name}. ${target.team ?? ""} 소속 ${target.position ?? ""}. 같은 팀에 동명이인인 선수가 있습니다. 데뷔 이후 꾸준히 출전하고 있습니다.`,
    canonicalUrl: "https://namu.wiki/w/test", sourceGrade: "tier2",
  };
  const deps = makeDeps(target, () => `${target.name} 선수는 ${target.team} 소속 ${target.position}입니다.`,
    (extras) => { observed = extras; });

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

  // ── F. 실측 사고 케이스 **양방향** 결속 (삼순 2026-08-19 재리뷰 조건) ──────
  //   53893('04 내야수) ↔ 56840('06 투수) — SSG 같은 팀 동명이인이다.
  //   한 방향만 보면 "항상 투수로 결속" 같은 고정값 버그를 못 잡는다.
  const SSG_PAIR = [
    { id: "56840", counterpart: "53893" },
    { id: "53893", counterpart: "56840" },
  ];
  for (const { id, counterpart } of SSG_PAIR) {
    const row = players.find((p) => p.kboId === id);
    if (!row) {
      // 로스터가 바뀌어 이 쌍이 사라졌으면 조용히 넘어가지 않는다 — 사고 재현 케이스는 명시적으로 갱신해야 한다.
      throw new Error(`F: 실측 사고 케이스 kboId ${id} 가 로스터에 없다 — 픽스처 갱신 필요`);
    }
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

  // ── K. 최장 토큰 우선 — `내야수` 안의 `야수` 가 상위범주로 오인되면 안 된다 ─────
  //   🔴 삼순 4차 확정 false-negative: 토큰마다 includes 를 돌리면 외야수 대상 답변의
  //      "내야수"에서 `[내야수, 야수]` 가 함께 잡히고, `야수` 가 외야수와 호환이라
  //      **충돌이 통과**한다. 부분 문자열이 상위 범주로 오인되는 구조적 결함이다.
  const outfielder = players.find((p) => p.position === "외야수" && p.team)!;
  const infielder = players.find((p) => p.position === "내야수" && p.team)!;
  for (const [subject, wrong] of [[outfielder, "내야수"], [infielder, "외야수"]] as const) {
    const conflictHit = detectIdentityConflict(
      `${subject.name} 선수는 ${subject.team} 소속의 ${wrong}입니다.`,
      buildPlayerIdentity({ entityId: subject.kboId, name: subject.name, team: subject.team }, players),
      players,
    );
    assert.ok(
      conflictHit,
      `K: ${subject.position} 대상에 "${wrong}" 서술이 통과했다 — 부분 문자열(야수) 오인`,
    );
    assert.equal(conflictHit!.mentioned, wrong, `K: 검출 토큰이 "${wrong}" 이 아니다`);
  }
  // 진짜 상위범주(`야수` 등록 선수)는 여전히 통과해야 한다 — 과잉 차단 금지.
  const generic = players.find((p) => p.position === "야수" && p.team);
  if (generic) {
    assert.equal(
      detectIdentityConflict(
        `${generic.name} 선수는 ${generic.team} 소속의 내야수입니다.`,
        buildPlayerIdentity({ entityId: generic.kboId, name: generic.name, team: generic.team }, players),
        players,
      ),
      null,
      "K2: 야수 등록 선수를 내야수로 서술한 것은 모순이 아닌데 충돌로 셌다",
    );
  }
  pass("K 최장 토큰 우선(내야수⊅야수 오인 차단)");

  // ── L. 이름 없는 후속 문장 귀속 (삼순 4차) ────────────────────────────────
  //   `김민준 선수입니다. 포지션은 내야수입니다.` — 다음 문장엔 이름이 없다.
  for (const { id, wrong } of [
    { id: "56840", wrong: "내야수" },
    { id: "53893", wrong: "투수" },
  ]) {
    const row = players.find((p) => p.kboId === id)!;
    const identity = buildPlayerIdentity({ entityId: id, name: row.name, team: row.team }, players);
    assert.ok(
      detectIdentityConflict(`${row.name} 선수입니다. 포지션은 ${wrong}입니다.`, identity, players),
      `L: ${id} 이름 없는 후속 문장의 "${wrong}" 귀속이 미검출`,
    );
  }
  // 후속 문장이라도 **제3자 언급**은 통과해야 한다(조사로 이어지는 형태).
  const pitcherL = players.find((p) => p.position === "투수" && p.team)!;
  assert.equal(
    detectIdentityConflict(
      `${pitcherL.name} 선수입니다. 뒤를 받치는 내야수들의 호수비가 좋았습니다.`,
      buildPlayerIdentity({ entityId: pitcherL.kboId, name: pitcherL.name, team: pitcherL.team }, players),
      players,
    ),
    null,
    "L2: 후속 문장의 제3자 언급을 귀속으로 오판했다",
  );
  pass("L 이름 없는 후속 문장 귀속 + 제3자 통과");

  // ── M. team 오귀속 양방향 종단 ────────────────────────────────────────────
  //   동명이인이 다른 팀이면 소속도 그대로 새어 나온다 — 포지션과 같은 사고 축이다.
  const teamA = players.find((p) => p.team === "SSG" && p.position === "투수")!;
  for (const wrongTeam of ["LG", "두산"]) {
    const hit = detectIdentityConflict(
      `${teamA.name} 선수는 ${wrongTeam} 소속입니다.`,
      buildPlayerIdentity({ entityId: teamA.kboId, name: teamA.name, team: teamA.team }, players),
      players,
    );
    assert.ok(hit, `M: 소속 오귀속("${wrongTeam}")이 미검출`);
    assert.equal(hit!.field, "team", "M: field 가 team 이 아니다");
  }
  // 별칭 표기(에스에스지·랜더스)는 같은 구단이므로 통과해야 한다.
  assert.equal(
    detectIdentityConflict(
      `${teamA.name} 선수는 에스에스지 랜더스 소속입니다.`,
      buildPlayerIdentity({ entityId: teamA.kboId, name: teamA.name, team: teamA.team }, players),
      players,
    ),
    null,
    "M2: 같은 구단의 다른 표기를 오귀속으로 셌다",
  );
  // 🔴 team 표기 변이 — 풀네임(`삼성 라이온즈`)으로 결속돼도 정상 답변이 죽으면 안 된다.
  //   2026-08-19 회귀 실측: 문장 쪽만 정규화하고 identity.team 을 raw 로 비교해
  //   `["삼성"]` vs `"삼성 라이온즈"` 불일치로 **정상 답변이 오귀속 판정**됐다.
  assert.equal(
    detectIdentityConflict(
      `${teamA.name} 선수는 삼성 라이온즈 소속입니다.`,
      { block: "x", kboId: teamA.kboId, name: teamA.name, team: "삼성 라이온즈", position: null },
      players,
    ),
    null,
    "M4: 풀네임 구단 표기를 오귀속으로 셌다 — 한쪽만 정규화한 비교",
  );

  // 🔴 P축: 상대팀·롤모델·과거 상대 구단은 **소속이 아니다** (삼순 2026-08-19 5차 실측 재현).
  //   `김민준 선수는 투수입니다. 두산과의 경기에서 호투했습니다.` 에서 `두산` 을 소속으로
  //   세면 이 정상 답변이 conflict → 재생성 → unsure 로 죽는다. 구단 등장은 정상이고,
  //   소속 판정은 **귀속 표현이 붙은 자리**에서만 해야 한다(포지션을 서술어로 본 것과 같은 축).
  const teamIdentity = buildPlayerIdentity(
    { entityId: teamA.kboId, name: teamA.name, team: teamA.team }, players,
  );
  const NON_AFFILIATION = [
    `${teamA.name} 선수는 투수입니다. 두산과의 경기에서 호투했습니다.`,
    `${teamA.name} 선수는 투수입니다. 롤모델은 롯데의 에이스입니다.`,
    `${teamA.name} 선수는 투수입니다. 한화를 상대로 완봉승을 거뒀습니다.`,
    `${teamA.name} 선수는 투수입니다. LG전에서 데뷔했습니다.`,
  ];
  for (const sentence of NON_AFFILIATION) {
    assert.equal(
      detectIdentityConflict(sentence, teamIdentity, players),
      null,
      `P: 소속이 아닌 구단 언급을 오귀속으로 셌다 — 정상 답변 과잉 차단: ${sentence}`,
    );
  }
  // 반대로 **귀속 표현**이 붙은 잘못된 소속은 반드시 잡아야 한다(양방향).
  const AFFILIATION_WRONG = [
    `${teamA.name} 선수는 두산 소속의 투수입니다.`,
    `${teamA.name} 선수는 투수입니다. 소속은 롯데입니다.`,
    `${teamA.name} 선수는 투수입니다. 현재 KIA에서 뛰고 있습니다.`,
  ];
  for (const sentence of AFFILIATION_WRONG) {
    const hit = detectIdentityConflict(sentence, teamIdentity, players);
    assert.ok(hit, `P2: 귀속 표현이 붙은 잘못된 소속이 미검출: ${sentence}`);
    assert.equal(hit!.field, "team", `P2: field 가 team 이 아니다: ${sentence}`);
  }
  pass("P 상대팀·롤모델 통과 + 귀속 표현 오소속 검출");

  // 종단으로도 닫히는지 본다.
  const teamConflictDeps = makeDeps(teamA, () => `${teamA.name} 선수는 LG 소속의 투수입니다.`);
  const teamResult = await answerQuestion("qa-team", `${teamA.name} 어떤 선수야?`, teamConflictDeps);
  assert.equal(teamResult.source, "unsure", `M3: team 충돌인데 source=${teamResult.source}`);
  pass("M team 오귀속 양방향 + 별칭 통과 + 종단 차단");

  // ── O. 다른 선수 이름이 든 문장은 귀속 대상이 아니다 ────────────────────
  //   "김민준 선수는 투수입니다. 팀 동료 홍길동은 내야수입니다." — 동료 소개가
  //   주인공 오귀속으로 오판되면 정상 답변이 죽는다. 문장 분리가 없으면 이게 샌다.
  const subjectO = players.find((p) => p.position === "투수" && p.team)!;
  const otherO = players.find((p) => p.position === "내야수" && p.name !== subjectO.name)!;
  assert.equal(
    detectIdentityConflict(
      // ⚠️ 주인공 문장에 자기 포지션을 넣으면 안 된다 — 답변 전체를 한 덩어리로 봐도
      //    호환 토큰(투수)이 같이 잡혀 통과해버려서 문장 분리 계약이 관측 불가가 된다.
      `${subjectO.name} 선수는 ${subjectO.team} 소속입니다. 팀 동료 ${otherO.name} 선수는 내야수입니다.`,
      buildPlayerIdentity({ entityId: subjectO.kboId, name: subjectO.name, team: subjectO.team }, players),
      players,
    ),
    null,
    "O: 다른 선수 이름이 든 문장을 주인공 귀속으로 오판했다 — 정상 답변 과잉 차단",
  );
  pass("O 제3자 이름 문장 배제");

  // ── H/I. 종단 오귀속 차단 — stub 이 **틀린 포지션**을 반환해도 서빙되지 않는가 ─────
  //
  //   🔴 삼순 3차 NO-GO 의 핵심: 종전 D축 stub 은 **정답을 직접 반환**했다. 그러면
  //      "프롬프트에 실렸다"만 보고 "모델이 틀렸을 때 막히는가"는 아무것도 증명하지 못한다.
  //      실제 사고는 모델이 지시를 어긴 것이었으므로, 게이트도 **어기는 모델**을 태워야 한다.
  //
  //   재생성 1회 후에도 계속 틀리면 unsure 로 닫혀야 한다(fail-close).
  //   양방향으로 본다 — 56840(투수)에 "내야수", 53893(내야수)에 "투수".
  const CONFLICT_CASES = [
    { id: "56840", wrong: "내야수", label: "H 56840 투수 → 내야수 오귀속" },
    { id: "53893", wrong: "투수", label: "I 53893 내야수 → 투수 오귀속" },
  ];
  for (const { id, wrong, label } of CONFLICT_CASES) {
    const row = players.find((p) => p.kboId === id);
    if (!row) throw new Error(`${label}: kboId ${id} 가 로스터에 없다 — 픽스처 갱신 필요`);

    // 오귀속을 **끝까지 고집하는** stub — 재생성해도 같은 오답을 준다.
    let calls = 0;
    const stubbornDeps = makeDeps(row, () => {
      calls += 1;
      return `${row.name} 선수는 ${row.team} 소속의 ${wrong}입니다. 꾸준히 출전하고 있습니다.`;
    });
    const stubborn = await answerQuestion("qa-conflict", `${row.name} 어떤 선수야?`, stubbornDeps);
    assert.notEqual(
      stubborn.answer.includes(wrong) && stubborn.source === "rag",
      true,
      `${label}: 주인공(${row.position})과 다른 "${wrong}" 서술이 그대로 서빙됐다 — fail-open`,
    );
    assert.equal(
      stubborn.source,
      "unsure",
      `${label}: 충돌이 남았는데 source=${stubborn.source} — unsure 로 닫히지 않았다`,
    );
    // 재생성은 1회만 — 공급자 과금이 무한히 늘어나면 안 된다.
    assert.equal(calls, 2, `${label}: callRagLlm 호출 ${calls}회 — 초기 1 + 재생성 1 이어야 한다`);

    // 재생성에서 고쳐주면 정상 서빙돼야 한다(과잉 차단 금지).
    // 🔴 재생성 신호를 **프롬프트 본문에서 읽고** 고치는 stub.
    //   `extras.identityConflict` 를 직접 보면 안 된다 — 실제 모델은 extras 가 아니라
    //   `buildRagLlmRequest` 가 만든 **프롬프트만** 본다. extras 를 보게 하면 적재 계약을
    //   훼손해도(신호를 프롬프트에 안 실어도) stub 이 고쳐버려 게이트가 GREEN 이 된다.
    const fixableDeps = makeDeps(row, (extras) =>
      promptHasRewriteInstruction(extras)
        ? `${row.name} 선수는 ${row.team} 소속의 ${row.position}입니다.`
        : `${row.name} 선수는 ${row.team} 소속의 ${wrong}입니다.`);
    const fixed = await answerQuestion("qa-conflict-fix", `${row.name} 어떤 선수야?`, fixableDeps);
    assert.equal(
      fixed.source,
      "rag",
      `${label}: 재생성이 고쳤는데도 source=${fixed.source} — 과잉 차단`,
    );
    assert.ok(
      fixed.answer.includes(row.position!),
      `${label}: 재생성 정답(${row.position})이 서빙 답변에 없다`,
    );
    pass(label);
  }

  // ── J. 정상 답변은 막지 않는다 — 다른 포지션 단어가 **주인공 문장 밖**에 있는 경우 ──
  //   투수 서술에 "내야수들의 호수비" 같은 문장은 정상이다. 단어 등장만으로 막으면
  //   멀쩡한 답변이 unsure 로 죽는다(과잉 차단).
  //   ⚠️ 주인공 문장에 진짜 포지션을 같이 넣으면 안 된다 — 그러면 답변 전체를 한 덩어리로
  //      봐도 통과해버려서 "문장 범위" 계약이 관측 불가가 된다(M13 이 GREEN 이 된다).
  const pitcher = players.find((p) => p.position === "투수" && p.team)!;
  const contextualDeps = makeDeps(pitcher, () =>
    `${pitcher.name} 선수는 ${pitcher.team} 소속입니다. 뒤를 받치는 내야수들의 호수비 덕을 봤습니다.`);
  const contextual = await answerQuestion("qa-context", `${pitcher.name} 어떤 선수야?`, contextualDeps);
  assert.equal(
    contextual.source,
    "rag",
    "J: 주인공 문장 밖의 포지션 단어를 충돌로 오판했다 — 정상 답변 과잉 차단",
  );
  pass("J 주인공 문장 밖 포지션 언급은 통과");

  // ── N. server 어댑터 종단 배선 (삼순 4차 P0) ──────────────────────────────
  //   🔴 게이트가 `buildRagLlmRequest` 를 직접 부르면, 실제 전송 경로인 server 어댑터가
  //      extras 를 빠뜨려도 잡지 못한다 — 재생성이 직전과 **같은 프롬프트**가 된다.
  //      실제 Gemini 요청 body 를 가로채 재작성 지시가 실렸는지 본다.
  const serverSource = readFileSync(
    new URL("../../src/lib/baseball-qa/server.ts", import.meta.url), "utf8",
  );
  const adapterStart = serverSource.indexOf("async function callRagLlmWithPrompt");
  const adapterEnd = serverSource.indexOf("async function", adapterStart + 10);
  const adapter = serverSource.slice(adapterStart, adapterEnd);
  assert.ok(
    /identityConflict:\s*extras\?\.identityConflict/.test(adapter),
    "N: server 어댑터가 실제 Gemini 요청에 identityConflict 를 전달하지 않는다 — 재생성이 같은 프롬프트가 된다",
  );
  assert.ok(
    /identityBlock:\s*extras\?\.identityBlock/.test(adapter),
    "N2: server 어댑터가 identityBlock 을 전달하지 않는다",
  );
  pass("N server 어댑터 종단 배선");

  console.log(`\ngenius-rag-identity-binding-smoke PASS (${passed} checks)`);
}

main().catch((error) => {
  console.error(`\ngenius-rag-identity-binding-smoke FAIL: ${(error as Error).message}`);
  process.exit(1);
});
