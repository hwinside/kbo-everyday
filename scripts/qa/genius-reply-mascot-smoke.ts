// 답변 유형별 마스코트 매핑 회귀 (2026-08-02 하린아빠 지시, A안).
//
// 요구: "design채널에서 제작한 야잘알봇 캐릭터를 답변 유형에 따라 매핑해서 답변 시 함께 노출"
//
// A안 = 서버가 답변 저장 시점에 유형(MatchPath)을 dm_messages.payload 에 기록하고
// 클라가 그 값으로 마스코트를 고른다. 검증 축 4개:
//   (A) 매핑 순수 함수 — 유형별 상태, 미지값 폴백
//   (B) 자산 실존 — 매핑이 가리키는 파일이 실제로 있고, 5상태가 서로 다른 이미지인가
//   (C) 서버 배선 — 답변 발송이 payload 를 실제로 넘기는가 (RPC 파라미터까지)
//   (D) 클라 배선 — 봇 발신일 때만 신뢰하고, 대기중에도 마스코트를 띄우는가
//
// (B)(C)(D) 를 넣는 이유: 매핑 함수만 맞고 자산이 없거나(404) 서버가 payload 를
// 안 넘기면 화면에는 항상 같은 표정만 뜬다 — 순수 함수 테스트로는 안 잡힌다.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  BASEBALL_GENIUS_USER_ID,
  GENIUS_MASCOT_STATES,
  MATCH_PATH_REPLY_KIND,
  geniusMascotSrc,
  isGeniusReplyPayload,
  mascotStateForReplyKind,
  replyKindForMatchPath,
} from "../../src/lib/constants/baseball-genius";

let pass = 0;
const failures: string[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    pass++;
  } catch (e) {
    failures.push(`${name}: ${(e as Error).message}`);
  }
}

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

// --- (A) 매핑 ---
check("정상 답변 4경로(사전·캐시·LLM·선수RAG)는 answering", () => {
  // `rag` = 선수 서술형 질문을 수집 문서 근거로 답한 경로. 2026-08-04 운영 실측에서
  // 이 경로가 `unavailable` 로 떨어져 정상 답변에 "모르겠어요" 표정이 붙었다.
  for (const p of ["dictionary", "cache", "llm", "rag"]) {
    assert.equal(replyKindForMatchPath(p), "answer", p);
    assert.equal(mascotStateForReplyKind(replyKindForMatchPath(p)), "answering", p);
  }
});
check("감사 인사 응답은 praised", () => {
  assert.equal(replyKindForMatchPath("ack"), "ack");
  assert.equal(mascotStateForReplyKind("ack"), "praised");
});
check("답하지 못한 경로는 전부 unknown", () => {
  for (const p of [
    "unsure",
    "blocked",
    "context_missing",
    "service_redirect",
    "history_hold",
    "limited",
    "error",
  ]) {
    assert.equal(replyKindForMatchPath(p), "unavailable", p);
    assert.equal(mascotStateForReplyKind("unavailable"), "unknown", p);
  }
});
check("payload 없는 과거 답변·미지 유형은 idle 폴백(오류/빈칸 금지)", () => {
  assert.equal(mascotStateForReplyKind(null), "idle");
  assert.equal(mascotStateForReplyKind(undefined), "idle");
});

// 서버가 실제로 내보내는 MatchPath 전체가 매핑에 덮여 있는가.
// pipeline.ts 의 union 을 직접 읽는다 — 새 유형이 추가되면 여기서 잡힌다.
// ⚠️ 종전 게이트는 `replyKindForMatchPath(p)` 결과가 3종 중 하나인지만 봤다.
// 그 함수는 모르는 값도 `unavailable` 로 폴백하므로 **미분류가 항상 통과**했다.
// `rag` 사고가 이 false-green 을 그대로 통과한 이유다.
// 이제 union 을 명시 열거 테이블(MATCH_PATH_REPLY_KIND)의 키와 직접 대조한다.
check("서버 MatchPath 전체가 명시 분류돼 있다(pending 제외, 폴백 흡수 금지)", () => {
  const pipeline = read("src/lib/baseball-qa/pipeline.ts");
  const m = pipeline.match(/export type MatchPath =([\s\S]*?);/);
  assert.ok(m, "MatchPath union 을 찾지 못함");
  const paths = [...m[1].matchAll(/\|\s*"([a-z_]+)"/g)].map((x) => x[1]);
  assert.ok(paths.length >= 10, `MatchPath 파싱 실패(${paths.length}개만 찾음)`);
  // pending 은 다른 worker 가 이기고 이 worker 는 물러나는 경우라 쪽지 자체가 발송되지 않는다.
  const declared = paths.filter((p) => p !== "pending");
  // ⚠️ `in` 이 아니라 **own-key** 로 판정한다(삼순 6차 P1). `in` 은 프로토타입 체인까지
  // 훑기 때문에 `constructor`·`toString` 같은 이름이 union 에 생기면 테이블에 없어도
  // "덮여 있다"고 통과한다 — 이 게이트 자체가 false-green 이 된다.
  const uncovered = declared.filter(
    (p) => !Object.prototype.hasOwnProperty.call(MATCH_PATH_REPLY_KIND, p),
  );
  assert.deepEqual(uncovered, [], `MATCH_PATH_REPLY_KIND 에 미분류: ${uncovered.join(", ")}`);
  // 반대 방향 — 테이블에만 있고 서버 union 에 없는 죽은 키도 잡는다.
  const stale = Object.keys(MATCH_PATH_REPLY_KIND).filter((p) => !declared.includes(p));
  assert.deepEqual(stale, [], `서버 union 에 없는 죽은 분류: ${stale.join(", ")}`);
});

// 프로토타입 키가 분류를 뚫고 나오면 안 된다(삼순 6차 P1).
//
// `match_path` 는 서버 payload 로 들어오는 **외부 문자열**이다. 테이블을 그냥 인덱싱하면
// `constructor` 는 `Object` 함수를, `__proto__` 는 프로토타입 객체를 돌려준다. 두 값 모두
// `?? "unavailable"` 폴백에 안 걸리고 그대로 반환돼, `mascotStateForReplyKind()` 의 어느
// 분기에도 안 걸려 `idle` 로 떨어진다 — "모르는 값은 unknown 표정"이라는 계약 위반이다.
check("프로토타입 키를 match_path 로 받아도 unavailable/unknown 으로 fail-close 한다", () => {
  for (const hostile of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    const kind = replyKindForMatchPath(hostile);
    assert.equal(kind, "unavailable", `${hostile} → unavailable 이어야 한다 (실제: ${String(kind)})`);
    assert.equal(mascotStateForReplyKind(kind), "unknown",
      `${hostile} 은 unknown 표정이어야 한다`);
  }
});

// 질문에 **실제로 답한** 경로가 `unavailable`(=모르겠어요 표정)로 분류되면 RED.
//
// 판정은 소스 텍스트가 아니라 **런타임 값**으로 한다. pipeline 이 export 하는 고정
// 문구 상수(`*_ANSWER`) 집합을 실제로 import 해서 "답이 아닌 문구"의 정답 집합을 만들고,
// 로그로 실려나가는 answer 표현이 그 상수를 가리키는지 본다.
//
// ⚠️ 이 게이트가 종전에 두 번 뚫렸다:
//  1) `answer: <expr>` 만 매칭해 shorthand `answer,` 를 쓰는 rag 경로를 통째로 놓쳤다.
//  2) `/^[A-Z][A-Z0-9_]*$/` 로 대문자 식별자를 전부 거절 상수 취급해, 그 이름에 실제
//     생성 답변을 담으면 오분류가 GREEN 이었다(삼순 반대가설 `SYNTHETIC_UPPER_ANSWER`).
// 그래서 이름이 아니라 **실제 export 값**으로 판정하고, 어느 쪽으로도 확정할 수 없는
// 표현은 추정하지 않고 fail-close 한다.
check("질문에 실제로 답한 경로는 unavailable 로 분류되지 않는다(미지 표현 fail-close)", () => {
  const pipeline = read("src/lib/baseball-qa/pipeline.ts");
  // pipeline 이 실제로 export 하는 고정 문구 상수 이름 = 답이 아닌 문구.
  // 고정 문구 상수는 pipeline 과 그 의존 모듈이 **export 하는 것만** 인정한다.
  // 이름 패턴만 보고 판정하면 그 이름에 생성 답변을 담는 순간 뚫린다(삼순 반대가설).
  const seasonRecord = read("src/lib/baseball-qa/stats/season-record.ts");
  const canned = new Set([
    ...[...pipeline.matchAll(/export const ([A-Z][A-Z0-9_]*_ANSWER)\s*=\s*\n?\s*"/g)].map((m) => m[1]),
    // 백틱 템플릿 리터럴도 고정 문구다(보간은 상수 시즌값뿐).
    ...[...seasonRecord.matchAll(/export const ([A-Z][A-Z0-9_]*_ANSWER)\s*=\s*\n?\s*["`]/g)].map((m) => m[1]),
    // 값이 다른 상수를 재수출하는 경우(문자열 리터럴이 아님) — 원본이 고정 문구다.
    ...[...pipeline.matchAll(/export const ([A-Z][A-Z0-9_]*_ANSWER)\s*=\s*([A-Z][A-Z0-9_]*)\s*;/g)].map((m) => m[1]),
  ]);
  assert.ok(canned.size >= 8, `고정 문구 상수 수집 실패(${canned.size}개): ${[...canned].join(", ")}`);
  // 생성/조회된 실제 답변을 싣는 표현. 지역 `answer` 는 경로마다 의미가 달라
  // (rag=생성값, blocked=고정문구 삼항식) 단독으로 신뢰하지 않고 아래에서 따로 판정한다.
  // `mappedEntry.answer` = 사전 정의 LLM 매핑(②-z)이 서빙하는 검수 사전 답변 — `hit.answer` 와
  // 같은 dictionary 답변이다 (2026-08-11 C 질문 정규화).
  const GENERATED = new Set(["hit.answer", "cached", "validated.answer", "mappedEntry.answer"]);
  // matchPath 가 리터럴이 아닌 호출부(`route`)와 지역 `answer` 를 쓰는 호출부는
  // 등록제로 둔다. 새로 생기면 RED 로 세워 사람이 분류를 명시하게 한다.
  const LOCAL_ANSWER_PATHS = new Map<string, "generated" | "canned">([
    ["rag", "generated"],          // composeRagAnswer(...) 결과
    // 구단 서술형 RAG. `rag` 와 같은 `composeRagAnswer(...)` 결과라 분류도 같다.
    // 경로를 나눈 이유는 **감사 대상 분리**이지 화면 취급이 달라서가 아니다(2026-08-07).
    ["team_rag", "generated"],
    // 최근 기사 RAG. 역시 `composeRagAnswer(...)` 결과라 분류는 같다.
    // 경로를 나눈 이유는 근거 수명(30일)이 달라 감사 축을 분리해야 하기 때문이다(2026-08-08).
    ["news_rag", "generated"],
    ["blocked", "canned"],         // UNSUPPORTED_SEASON/UNTRUSTED_METRIC 삼항식
    ["kbo_structured", "generated"], // 운영 DB 원값 렌더 결과
  ]);
  const NON_LITERAL = new Set(["route"]);

  const answering = new Set<string>();
  const unknown: string[] = [];
  for (const call of pipeline.matchAll(
    /matchPath:\s*(?:"([a-z_]+)"|([A-Za-z_$][\w$]*))\s*,\s*answer(?::\s*([^,]+))?\s*,/g,
  )) {
    const literal = call[1];
    const identifier = call[2];
    const expr = (call[3] ?? "answer").trim();
    if (!literal) {
      if (!NON_LITERAL.has(identifier)) unknown.push(`(비리터럴 matchPath) ${identifier}: ${expr}`);
      continue;
    }
    if (expr === "null") continue;
    if (canned.has(expr)) continue;
    if (GENERATED.has(expr)) { answering.add(literal); continue; }
    if (expr === "answer") {
      const kind = LOCAL_ANSWER_PATHS.get(literal);
      if (!kind) { unknown.push(`${literal}: 지역 answer(분류 미등록)`); continue; }
      if (kind === "generated") answering.add(literal);
      continue;
    }
    unknown.push(`${literal}: ${expr}`);
  }

  // `settle(answer, "kbo_structured", ...)` 처럼 log 를 헬퍼로 감싼 호출부도 같은 계약이다.
  // 이 형태를 안 보면 실답변 경로가 통째로 게이트 밖으로 빠진다(실제로 kbo_structured 가 그랬다).
  for (const call of pipeline.matchAll(/settle\(\s*([A-Za-z_$][\w$.]*)\s*,\s*"([a-z_]+)"/g)) {
    const expr = call[1];
    const path = call[2];
    if (canned.has(expr)) continue;
    if (expr === "answer" || GENERATED.has(expr)) { answering.add(path); continue; }
    unknown.push(`${path}: settle(${expr})`);
  }

  assert.deepEqual(unknown, [],
    `분류되지 않은 answer 표현(등록 필요): ${unknown.join(" | ")}`);

  // 되묻기는 answer 도 unavailable 도 아닌 `picker` 여야 한다. `unavailable` 로 떨어지면
  // 유저는 "어느 선수?" 질문을 받으면서 동시에 "모르겠어요" 표정을 보게 된다.
  assert.equal(replyKindForMatchPath("player_picker"), "picker",
    "player_picker 는 picker 로 분류돼야 한다");
  assert.ok(answering.size >= 4, `실답변 경로 파싱 실패(${answering.size}개): ${[...answering].join(", ")}`);
  const misclassified = [...answering].filter((p) => replyKindForMatchPath(p) === "unavailable");
  assert.deepEqual(misclassified, [],
    `답변을 내보내는데 '모르겠어요' 로 분류됨: ${misclassified.join(", ")}`);
});// --- (B) 자산 ---
const digests = new Map<string, string>();
check("매핑이 가리키는 자산이 실제로 존재한다", () => {
  for (const s of GENIUS_MASCOT_STATES) {
    const rel = geniusMascotSrc(s).replace(/^\//, "");
    const abs = path.join(process.cwd(), "public", rel);
    assert.ok(existsSync(abs), `없음: public/${rel}`);
    digests.set(s, createHash("sha256").update(readFileSync(abs)).digest("hex"));
  }
});
check("5상태가 서로 다른 이미지다(같은 파일 복사 아님)", () => {
  assert.equal(digests.size, GENIUS_MASCOT_STATES.length, "자산 로드 실패");
  const uniq = new Set(digests.values());
  assert.equal(uniq.size, digests.size, "동일한 이미지가 여러 상태에 쓰임");
});
check("5상태 자산 크기가 동일하다(상태 전환 시 캐릭터가 안 튄다)", () => {
  // PNG IHDR: 16..20 width, 20..24 height
  const dims = GENIUS_MASCOT_STATES.map((s) => {
    const rel = geniusMascotSrc(s).replace(/^\//, "");
    const b = readFileSync(path.join(process.cwd(), "public", rel));
    return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
  });
  assert.equal(new Set(dims).size, 1, `크기 불일치: ${dims.join(", ")}`);
});

// --- (C) 서버 배선 ---
const server = read("src/lib/baseball-qa/server.ts");
const sendOps = read("src/lib/cs/send-ops-message.ts");
const migration = read("supabase/migrations/20260802_ops_message_payload.sql");

check("답변 발송이 실제 유형(result.source)을 payload 로 넘긴다", () => {
  // payload 조립은 composeGeniusReplyPayload 로 추출됐다(2026-08-15 모션 매핑 PR —
  // 인라인이면 게이트가 실제 조립 경로를 못 태운다). 조립 내용은 constants 의 그 함수에,
  // server 에는 소비 배선이 있어야 한다. 실행 검증은 qa:genius-mascot-motion 이 담당한다.
  const constants = read("src/lib/constants/baseball-genius.ts");
  assert.match(constants, /type:\s*"baseball_genius_reply"/, "payload type 없음");
  assert.match(constants, /reply_kind:\s*replyKindForMatchPath\(result\.source\)/, "의미 분류 reply_kind 없음");
  assert.match(constants, /match_path:\s*result\.source/, "실제 유형 대신 고정값을 쓰고 있음");
  assert.match(server, /composeGeniusReplyPayload\(result,\s*messageId\)/, "server 가 조립 함수를 소비하지 않음");
  // payload 를 만들어놓고 sendOpsMessageToUser 에 안 넘기면 화면은 영원히 idle 이다.
  const call = server.slice(server.indexOf("const sent = await sendOpsMessageToUser("));
  assert.ok(call.indexOf("replyPayload") > 0 && call.indexOf("replyPayload") < 400, "발송 호출에 payload 미전달");
});
check("send-ops helper 가 payload 를 RPC 파라미터로 전달한다", () => {
  assert.match(sendOps, /p_payload:\s*payload\s*\?\?\s*null/, "p_payload 전달 없음");
});
check("migration 이 payload 를 dm_messages 에 INSERT 한다", () => {
  assert.match(migration, /p_payload JSONB DEFAULT NULL/, "파라미터 없음");
  // dedup_key 유무 두 분기 모두에 payload 가 들어가야 한다.
  const inserts = [...migration.matchAll(/INSERT INTO public\.dm_messages \(([^)]+)\)/g)].map((m) => m[1]);
  assert.equal(inserts.length, 2, `INSERT 분기 ${inserts.length}개(2개 기대)`);
  for (const cols of inserts) assert.ok(/payload/.test(cols), `payload 누락: ${cols}`);
});
check("멱등 판정은 payload까지 동일해야 한다(NULL legacy 포함)", () => {
  const dedupBlock = migration.slice(
    migration.indexOf("EXCEPTION WHEN unique_violation"),
    migration.indexOf("v_deduped := true"),
  );
  assert.ok(dedupBlock.length > 0, "멱등 블록을 찾지 못함");
  assert.match(dedupBlock, /m\.payload\s+IS NOT DISTINCT FROM\s+p_payload/);
  assert.match(sendOps, /isDeepStrictEqual\(actualPayload, expectedPayload\)/);
  assert.match(sendOps, /payload\s*\?\?\s*null/);
});

// --- (D) 클라 배선 ---
const chat = read("src/app/(main)/messages/[conversationId]/page.tsx");
const typing = read("src/components/dm/GeniusTypingIndicator.tsx");

check("payload 판정 함수가 위조를 거른다", () => {
  assert.equal(isGeniusReplyPayload({
    type: "baseball_genius_reply", reply_kind: "answer", match_path: "llm",
  }), true);
  assert.equal(isGeniusReplyPayload({ type: "news_clipping", articles: [1] }), false);
  assert.equal(isGeniusReplyPayload({ type: "baseball_genius_reply", match_path: "llm" }), false);
  assert.equal(isGeniusReplyPayload({
    type: "baseball_genius_reply", reply_kind: "bogus", match_path: "llm",
  }), false);
  assert.equal(isGeniusReplyPayload(null), false);
  assert.equal(isGeniusReplyPayload("baseball_genius_reply"), false);
});
check("말풍선 마스코트는 봇 발신일 때만 붙는다", () => {
  // 유저가 payload 를 흉내내도 마스코트가 붙으면 안 된다(뉴스클리핑 trustedSender 와 같은 이유).
  assert.match(
    chat,
    /msg\.sender_id === BASEBALL_GENIUS_USER_ID && isGeniusReplyPayload\(msg\.payload\)/,
    "발신자 검증 없이 payload 만 보고 있음",
  );
  assert.ok(BASEBALL_GENIUS_USER_ID.length === 36, "봇 ID 상수 이상");
});
check("말풍선이 매핑 결과로 자산을 고른다(고정 src 아님)", () => {
  assert.match(chat, /geniusMascotSrc\(mascotState\)/, "동적 src 아님");
  assert.match(chat, /mascotStateForReplyKind\(geniusReply\?\.reply_kind\)/, "의미 분류 매핑 미사용");
});
check("대기·실패 인디케이터도 마스코트를 띄운다", () => {
  assert.match(typing, /geniusMascotSrc\(STATE_TO_MASCOT\[state\]\)/, "인디케이터 마스코트 없음");
  assert.match(typing, /waiting:\s*"thinking"/, "대기 상태 매핑 없음");
  assert.match(typing, /failed:\s*"unknown"/, "실패 상태 매핑 없음");
  // 종전 ⚾ 이모지가 남아 있으면 표정이 안 바뀐다.
  assert.ok(!/⚾/.test(typing), "구 ⚾ 이모지 잔존");
});

if (failures.length > 0) {
  console.error(`FAIL ${failures.length}`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`✅ genius reply mascot: PASS=${pass} FAIL=0`);
