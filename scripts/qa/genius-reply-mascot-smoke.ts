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
check("정상 답변 3경로(사전·캐시·LLM)는 answering", () => {
  for (const p of ["dictionary", "cache", "llm"]) {
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
check("서버 MatchPath 전체가 매핑에 덮여 있다(pending 제외)", () => {
  const pipeline = read("src/lib/baseball-qa/pipeline.ts");
  const m = pipeline.match(/export type MatchPath =([\s\S]*?);/);
  assert.ok(m, "MatchPath union 을 찾지 못함");
  const paths = [...m[1].matchAll(/\|\s*"([a-z_]+)"/g)].map((x) => x[1]);
  assert.ok(paths.length >= 10, `MatchPath 파싱 실패(${paths.length}개만 찾음)`);
  // pending 은 다른 worker 가 이기고 이 worker 는 물러나는 경우라 쪽지 자체가 발송되지 않는다.
  const uncovered = paths.filter((p) =>
    p !== "pending" && !["answer", "ack", "unavailable"].includes(replyKindForMatchPath(p)));
  assert.deepEqual(uncovered, [], `reply_kind 누락: ${uncovered.join(", ")}`);
});

// --- (B) 자산 ---
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
  assert.match(server, /type:\s*"baseball_genius_reply"/, "payload type 없음");
  assert.match(server, /reply_kind:\s*replyKindForMatchPath\(result\.source\)/, "의미 분류 reply_kind 없음");
  assert.match(server, /match_path:\s*result\.source/, "실제 유형 대신 고정값을 쓰고 있음");
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
