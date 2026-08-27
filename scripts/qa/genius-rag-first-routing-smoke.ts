/**
 * 야잘알봇 **RAG-first 라우팅** 계약 게이트 (하린아빠 2026-08-27 "최대한 RAG을 활용하고
 * LLM을 활용하는 방향으로 전면적으로 수정해줘" — Phase ①).
 *
 * ⚠️ 무엇을 바꿨고 왜 위험한가
 *   종전에는 `isSupportedRuleTermQuestion` 이라는 **닫힌 단어 사전**이 통과시킨 질문만
 *   공식 근거(tier1)를 탈 수 있었다. 사전에 없는 표현은 정본 근거가 있어도 도달조차
 *   못 했고, 7일 실측 1,981건 중 `unsure` 15.6% · `blocked` 15.8% 가 거기서 죽었다
 *   (`세이브 조건`·`포스아웃 상황`·`이닝 교대 조건`·`피치가뭐야` = 공식야구규칙에 정의가 있다).
 *
 *   그래서 게이트를 열었다. 그런데 **여는 것 자체가 위험**하다:
 *     RPC 는 `ORDER BY ... LIMIT n` 뿐이라 무슨 질문이든 n건을 돌려준다. 실측에서
 *     "오늘 점심 뭐 먹지?"·"파이썬 리스트 정렬하는 법" 도 12건을 받았다.
 *     즉 **개수로 근거 유무를 판정하면 100% 통과 = 전 질문 환각 통로**가 된다.
 *
 *   이 게이트는 그 위험이 막혀 있는지를 본다 — 열린 문에 자물쇠가 걸렸는지.
 *
 * 검증 축
 *   A  라우팅이 실제로 열렸다 — 룰 사전에 없는 질문도 공식 RAG 를 **탄다**
 *   B  🔴 근거 판정이 **개수가 아니다** — 거리 임계 상수가 RPC 호출에 실려야 한다
 *   C  🔴 임계는 **낮추는 방향만** 안전하다 — 코드 상수 고정, env 주입 불가
 *   D  🔴 배포 순서 방어 — RPC 시그니처 부재(PGRST202)는 예외가 아니라 **근거 0건**
 *   E  🔴 구 시그니처 재시도 금지 — 재시도는 임계 없는 상태로 되돌아가는 것이다
 *   F  범위 밖(`scopeGate`) 질문은 여전히 공식 RAG 를 타지 않는다(Phase② 이전 계약 유지)
 *   G  근거가 없으면 종전 경로가 그대로 이어진다 — 라우팅을 넓히되 종결을 뺏지 않는다
 *
 * `--selftest`: 판정 키가 RED 를 낼 수 있는지 증명한다(검증력 증명은 mutations 가 한다).
 *
 * 실행: npm run qa:genius-rag-first
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  RAG_DOCUMENT_MAX_DISTANCE,
} from "../../src/lib/baseball-qa/rag/retrieve";

const SELFTEST = process.argv.includes("--selftest");
let passed = 0;
const pass = (name: string) => { passed += 1; console.log(`  PASS ${name}`); };

const src = (rel: string) => readFileSync(new URL(`../../src/lib/baseball-qa/${rel}`, import.meta.url), "utf8");
/** 주석·문서 문면은 blank 처리한다 — 폐기 이력 주석이 assertion 을 만족시키면 false-green 이다(M90). */
const stripComments = (text: string) => text
  .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
  .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));

function main() {
  const pipeline = stripComments(src("pipeline.ts"));
  const server = stripComments(src("server.ts"));

  // ── A. 라우팅이 실제로 열렸는가 ────────────────────────────────────────────
  //   공식 RAG 진입 조건에서 닫힌 단어 사전 판정이 빠져야 한다. 이게 남아 있으면
  //   임계·프롬프트를 아무리 고쳐도 사전 밖 질문은 근거에 **도달조차** 못 한다.
  const officialCall = pipeline.indexOf("answerOfficialDocumentQuestion(userId, question, questionNorm, remaining, deps)");
  assert.ok(officialCall > 0, "A0: 공식 RAG 호출 지점을 찾지 못했다 — 게이트 앵커가 깨졌다");
  const gateBlock = pipeline.slice(Math.max(0, officialCall - 400), officialCall);
  assert.ok(
    SELFTEST ? false : !/isSupportedRuleTermQuestion\s*\(/.test(gateBlock),
    "A: 공식 RAG 진입이 아직 닫힌 단어 사전(isSupportedRuleTermQuestion)에 막혀 있다 — "
    + "사전 밖 질문은 정본 근거가 있어도 도달하지 못한다(라우팅이 안 열렸다)",
  );
  pass("A 라우팅 개방 — 닫힌 단어 사전이 공식 RAG 를 막지 않는다");

  // ── B. 🔴 근거 판정이 개수가 아니라 거리다 ────────────────────────────────
  assert.ok(
    /p_max_distance:\s*RAG_DOCUMENT_MAX_DISTANCE/.test(server),
    "B: RPC 호출에 거리 임계(p_max_distance)가 실리지 않는다 — 개수로만 판정하면 "
    + "무관한 질문도 상한만큼 근거를 받아 100% 통과한다(실측: '오늘 점심 뭐 먹지?' 12건)",
  );
  pass("B 근거 판정 = 거리 임계 (개수 판정 폐기)");

  // ── C. 🔴 임계는 코드 상수여야 한다 — env 로 풀 수 있으면 방어가 아니다 ────
  const retrieveSrc = stripComments(readFileSync(
    new URL("../../src/lib/baseball-qa/rag/retrieve.ts", import.meta.url), "utf8",
  ));
  const decl = /export const RAG_DOCUMENT_MAX_DISTANCE\s*=\s*([0-9.]+)\s*;/.exec(retrieveSrc);
  assert.ok(decl, "C: RAG_DOCUMENT_MAX_DISTANCE 가 리터럴 상수 선언이 아니다");
  assert.ok(
    !/process\.env/.test(decl![0]),
    "C2: 임계가 env 로 주입된다 — 운영에서 임계를 무력화하면 근거 없는 답이 그대로 나간다",
  );
  // 실측 경계(진짜 근거 ≤0.3787 / 무관 ≥0.4281) 안에 있어야 한다. 벗어나면 둘 중 하나가 깨진다.
  const value = Number(decl![1]);
  assert.equal(value, RAG_DOCUMENT_MAX_DISTANCE, "C3: 선언값과 런타임 값이 다르다");
  assert.ok(
    SELFTEST ? value > 99 : (value > 0.3787 && value < 0.4281),
    `C4: 임계 ${value} 가 실측 경계 밖이다 — 0.3787(진짜 근거 최대) < x < 0.4281(무관 최소) `
    + "이어야 한다. 높이면 근거 없는 답이 늘고, 낮추면 정당한 근거가 버려진다",
  );
  pass(`C 임계 코드 상수 고정 (${value}, 실측 경계 내)`);

  // ── D·E. 🔴 배포 순서 방어 + 구 시그니처 재시도 금지 ──────────────────────
  //   이 PR 은 RPC 시그니처를 바꾼다. 앱이 migration 보다 먼저 배포되면 PGRST202 404 다
  //   (실측 확인). throw 하면 공식 RAG 가 통째로 예외가 되어 유저에게 오류가 나간다.
  const fnStart = server.indexOf("export async function searchOfficialRag");
  assert.ok(fnStart > 0, "D0: searchOfficialRag 를 찾지 못했다");
  const fnBody = server.slice(fnStart, fnStart + 2000);
  assert.ok(
    /PGRST202/.test(fnBody) && /return \[\]/.test(fnBody),
    "D: RPC 시그니처 부재(PGRST202)를 근거 0건으로 접지 않는다 — migration 보다 앱이 먼저 "
    + "배포되면 공식 RAG 경로가 통째로 예외가 되어 유저에게 오류가 나간다",
  );
  // 🔴 구 시그니처로 재시도하면 **임계 없는 상태로 되돌아간다** = 이 PR 이 막으려던 결함 그 자체.
  assert.ok(
    !/p_limit[^}]*\}\s*\)\s*;[\s\S]{0,300}supabaseAdmin\.rpc\(\s*"search_baseball_genius_official_chunks"/.test(fnBody),
    "E: 구 시그니처로 재시도한다 — 구 RPC 는 임계가 없어 무슨 질문이든 상한만큼 돌려준다. "
    + "재시도는 '근거 없음을 근거 있음으로 만드는' 결함으로 되돌아가는 것이다",
  );
  pass("D·E 배포 순서 fail-close (PGRST202 → 근거 0건, 구 시그니처 재시도 없음)");

  // ── F. 범위 밖은 여전히 공식 RAG 를 타지 않는다 (Phase② 이전 계약 유지) ────
  assert.ok(
    /!scopeGate\s*&&/.test(pipeline.slice(Math.max(0, officialCall - 400), officialCall)),
    "F: scopeGate 가 풀렸다 — 비야구 질문에 무관한 KBO 조문이 근거로 붙는다(삼순 R1 실측). "
    + "범위 판정을 LLM 으로 옮기는 것은 Phase② 이며, 한 번에 하나씩 바꾼다",
  );
  pass("F 범위 밖(scopeGate) 계약 유지");

  // ── G. 근거가 없으면 종전 경로가 이어진다 ─────────────────────────────────
  //   `if (official) return official;` 형태여야 한다. 무조건 return 이면 근거가 없을 때도
  //   여기서 종결되어 기존 경로(사전·구단 RAG·선수 RAG·LLM)를 전부 뺏는다.
  const afterCall = pipeline.slice(officialCall, officialCall + 200);
  assert.ok(
    /if\s*\(\s*official\s*\)\s*return official\s*;/.test(afterCall),
    "G: 근거가 없어도 공식 RAG 경로에서 종결한다 — 라우팅을 넓히는 게 아니라 "
    + "기존 종결을 빼앗는 것이다(사전·구단·선수 RAG 가 전부 죽는다)",
  );
  pass("G 근거 없으면 종전 경로 유지 (넓히되 뺏지 않는다)");

  console.log(`\ngenius-rag-first-routing-smoke PASS (${passed} checks)`);
}

if (SELFTEST) {
  let threw: Error | null = null;
  try { main(); } catch (e) { threw = e as Error; }
  if (!threw) {
    console.error("\ngenius-rag-first-routing-smoke SELFTEST FAIL: 결함을 주입했는데 통과했다");
    process.exit(1);
  }
  console.log(`\ngenius-rag-first-routing-smoke SELFTEST PASS — 주입 결함 검출: ${threw.message.slice(0, 80)}`);
} else {
  try { main(); } catch (e) {
    console.error(`\ngenius-rag-first-routing-smoke FAIL: ${(e as Error).message}`);
    process.exit(1);
  }
}
