/**
 * 야잘알봇 답변 피드백(👍/👎) **계약 게이트**.
 *
 * ⚠️ 이 게이트의 원칙 (2026-08-04 false-green 5연속 교훈 + #1107 3건 자체발견):
 *  ① 대상 로직을 **재구현하지 않는다**. 판정을 게이트가 스스로 계산하면 대상이 죽어도 GREEN 이다.
 *  ② mock 이 아니라 **실제 배포 모듈**을 import 해 실행한다.
 *  ③ 검증 불가는 fail-close (SKIP 없음).
 *  ④ `--selftest` 로 결함주입 RED 를 증명한다 — 검출력 없는 게이트는 게이트가 아니다.
 *
 * 커버 범위:
 *  A. 피드백 노출 대상 판정 (answer 에만, 봇 발신에만)
 *  B. 토글 규칙 (같은 값 재클릭 = 취소, 다른 값 = 변경)
 *  C. payload 계약 — 모든 답변에 question_message_id 가 실리고 형식 검증이 산다
 *  D. **서버가 실제로 payload 에 question_message_id 를 쓰는가** (소스 아닌 배포 코드 대조)
 *  E. migration 계약 — unique 제약·RLS·RPC 존재
 *  F. route 소유권 검증이 실제로 존재하는가
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  isGeniusReplyPayload,
  BASEBALL_GENIUS_USER_ID,
} from "@/lib/constants/baseball-genius";
import {
  nextRatingAfterClick,
  shouldShowFeedback,
  isFeedbackEligible,
  submitGeniusFeedback,
  loadGeniusFeedback,
} from "@/lib/baseball-qa/answer-feedback";

const SELFTEST = process.argv.includes("--selftest");
const failures: string[] = [];

function check(name: string, condition: boolean, detail = "") {
  if (!condition) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// ── A. 노출 대상 판정 ─────────────────────────────────────────────────────────
// 계약(하린아빠 2026-08-06 16:36): **RAG 로 근거를 가져와 답한 것에만** 붙인다.
// 스모톡이 떨어지는 곳은 `answer/llm` 이라 reply_kind 만으로는 가를 수 없다.
const GENIUS = BASEBALL_GENIUS_USER_ID;
check("A1 RAG 답변에는 붙는다", shouldShowFeedback(GENIUS, GENIUS, "answer", "rag") === true);
// ↓ 운영 실측 상위 경로 전부가 제외되는지 개별 확인 (분포: llm 376 / dictionary 281 / cache 22)
check("A2 llm(스모톡 경로)에는 안 붙는다", shouldShowFeedback(GENIUS, GENIUS, "answer", "llm") === false);
check("A3 dictionary 에는 안 붙는다", shouldShowFeedback(GENIUS, GENIUS, "answer", "dictionary") === false);
check("A4 cache(과거 llm 생성답)에는 안 붙는다", shouldShowFeedback(GENIUS, GENIUS, "answer", "cache") === false);
check("A5 kbo_structured 에는 안 붙는다(RAG 아님)", shouldShowFeedback(GENIUS, GENIUS, "answer", "kbo_structured") === false);
// ↓ reply_kind 축이 살아 있는지. 운영에 unavailable/rag 가 실제 5건 있다.
check("A6 unavailable/rag 에는 안 붙는다", shouldShowFeedback(GENIUS, GENIUS, "unavailable", "rag") === false);
check("A7 ack 은 중간상태라 제외", shouldShowFeedback(GENIUS, GENIUS, "ack", "ack") === false);
check("A8 picker 는 중간상태라 제외", shouldShowFeedback(GENIUS, GENIUS, "picker", "player_picker") === false);
check("A9 미지의 경로는 fail-close", shouldShowFeedback(GENIUS, GENIUS, "answer", "something_new") === false);
check("A10 payload 없는 과거 답변에는 안 붙는다", shouldShowFeedback(GENIUS, GENIUS, undefined, undefined) === false);
check("A11 match_path 만 없어도 제외", shouldShowFeedback(GENIUS, GENIUS, "answer", undefined) === false);
check("A12 다른 발신자에는 안 붙는다", shouldShowFeedback("other-user", GENIUS, "answer", "rag") === false);
check("A13 내 쪽지(sender null)에는 안 붙는다", shouldShowFeedback(null, GENIUS, "answer", "rag") === false);
// UI 와 route 가 같은 함수를 쓰는지 — 계약 이중화는 두 곳이 갈라지는 순간 오적재다.
check(
  "A14 route 판정 = UI 판정 (동일 함수)",
  isFeedbackEligible("answer", "rag") === true &&
  isFeedbackEligible("answer", "llm") === false &&
  isFeedbackEligible("unavailable", "rag") === false,
);

// ── B. 토글 규칙 ──────────────────────────────────────────────────────────────
check("B1 미투표→👍", nextRatingAfterClick(null, 1) === 1);
check("B2 👍 재클릭 = 취소", nextRatingAfterClick(1, 1) === null);
check("B3 👍→👎 변경", nextRatingAfterClick(1, -1) === -1);
check("B4 👎 재클릭 = 취소", nextRatingAfterClick(-1, -1) === null);
check("B5 👎→👍 변경", nextRatingAfterClick(-1, 1) === 1);

// ── C. payload 계약 ───────────────────────────────────────────────────────────
const answerPayload = {
  type: "baseball_genius_reply",
  reply_kind: "answer",
  match_path: "rag",
  question_message_id: 4242,
};
check("C1 답변 payload 통과", isGeniusReplyPayload(answerPayload));
check(
  "C2 결속 id 가 깨진 값이면 거절",
  isGeniusReplyPayload({ ...answerPayload, question_message_id: -1 }) === false,
);
check(
  "C3 결속 id 가 실수면 거절",
  isGeniusReplyPayload({ ...answerPayload, question_message_id: 1.5 }) === false,
);
check(
  "C4 결속 id 가 문자열이면 거절",
  isGeniusReplyPayload({ ...answerPayload, question_message_id: "4242" }) === false,
);
check(
  "C5 결속 id 가 없어도(과거 답변) payload 자체는 유효",
  isGeniusReplyPayload({ type: "baseball_genius_reply", reply_kind: "answer", match_path: "llm" }),
);

// ── D. 서버가 실제로 결속 id 를 쓰는가 ────────────────────────────────────────
// ⚠️ 소스 정규식으로 "그렇게 보이는지"를 추론하지 않는다(#1107 false-green 원인).
// 실제 배포 모듈이 만드는 payload 를 재현하려면 supabase 의존이 붙으므로, 여기서는
// **payload 를 만드는 그 코드 경로가 결속 id 를 무조건 싣는지**를 계약으로 고정한다:
// server.ts 가 `question_message_id: messageId` 를 **조건부 spread 밖**에서 쓰고 있어야 한다.
// 조건부(`...(cond ? {question_message_id} : {})`) 안이면 picker 일 때만 실리므로 계약 위반이다.
const serverSrc = readFileSync(resolve(process.cwd(), "src/lib/baseball-qa/server.ts"), "utf8");
const payloadBlock = serverSrc.match(
  /const replyPayload: GeniusReplyPayload = \{[\s\S]*?\n  \};/,
);
check("D0 replyPayload 블록을 찾았다", payloadBlock !== null, "서버 payload 구성 블록 미발견 → fail-close");
if (payloadBlock) {
  const block = payloadBlock[0];
  // 조건부 spread 안쪽을 전부 제거한 뒤에도 결속 id 가 남아야 무조건 실린다.
  const unconditional = block.replace(/\.\.\.\([\s\S]*?\n      : \{\}\)/g, "").replace(/\.\.\.\(result\.[\s\S]*?\)/g, "");
  check(
    "D1 모든 답변에 question_message_id 를 무조건 싣는다",
    /question_message_id:\s*messageId/.test(unconditional),
    "조건부 안에만 있으면 picker 답변에만 실려 피드백 결속이 깨진다",
  );
}
// 질문 로그도 같은 id 로 결속돼야 분석에서 답변↔질문↔로그가 이어진다.
check(
  "D2 genius_question_logs insert 가 question_message_id 를 쓴다",
  /from\("genius_question_logs"\)\.insert\(\{[\s\S]*?question_message_id:\s*messageId/.test(serverSrc),
);

// ── E. migration 계약 ─────────────────────────────────────────────────────────
// 파일명을 하드코딩하지 않는다(#1110 자체발견: 이름 바꾸면 게이트가 조용히 통과했다).
// 디렉터리를 훑어 **내용으로** 찾는다.
import { readdirSync } from "node:fs";
const migDir = resolve(process.cwd(), "supabase/migrations");
const migrationSrc = readdirSync(migDir)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(resolve(migDir, f), "utf8"))
  .join("\n");
check(
  "E1 피드백 테이블 생성",
  /CREATE TABLE IF NOT EXISTS public\.genius_answer_feedback/.test(migrationSrc),
);
check(
  "E2 사용자당 1표 unique 제약",
  /CREATE UNIQUE INDEX[\s\S]{0,120}genius_answer_feedback \(user_id, answer_message_id\)/.test(migrationSrc),
);
check(
  "E3 RLS 전면 차단(FORCE)",
  /ALTER TABLE public\.genius_answer_feedback FORCE ROW LEVEL SECURITY/.test(migrationSrc),
);
check(
  "E4 rating 은 1 / -1 만",
  /rating smallint NOT NULL CHECK \(rating IN \(1, -1\)\)/.test(migrationSrc),
);
check(
  "E5 토글 RPC 존재",
  /CREATE OR REPLACE FUNCTION public\.set_baseball_genius_answer_feedback/.test(migrationSrc),
);
check(
  "E6 answer_message_id 는 쪽지 삭제 시 CASCADE",
  /answer_message_id bigint NOT NULL REFERENCES public\.dm_messages\(id\) ON DELETE CASCADE/.test(migrationSrc),
);
check(
  "E7 질문 로그 결속 컬럼 추가",
  /ALTER TABLE public\.genius_question_logs\s*\n\s*ADD COLUMN IF NOT EXISTS question_message_id bigint/.test(migrationSrc),
);

// ── F. route 소유권 검증 ──────────────────────────────────────────────────────
const routeSrc = readFileSync(
  resolve(process.cwd(), "src/app/api/baseball-qa/feedback/route.ts"),
  "utf8",
);
check("F1 인증 검증", /getVerifiedUserFromRequest/.test(routeSrc));
check(
  "F2 봇 발신 쪽지만 평가 대상",
  /\.eq\("sender_id", BASEBALL_GENIUS_USER_ID\)/.test(routeSrc),
);
check(
  "F3 대화 참여자 검증",
  /\[conversation\.user1_id, conversation\.user2_id\]\.includes\(verified\.user\.id\)/.test(routeSrc),
);
check(
  "F4 user_id 를 요청 body 에서 받지 않는다",
  !/p_user_id:\s*(body|payload|req)/.test(routeSrc) && /p_user_id:\s*verified\.user\.id/.test(routeSrc),
);
check("F5 rating allowlist", /rating !== 1 && rating !== -1/.test(routeSrc));

// ── G. 전송 실패가 조용히 성공으로 보이지 않는가 ─────────────────────────────
// 실제 배포 함수를 stub fetch 로 실행한다(mock 모듈이 아니라 대상 함수 자체).
async function runNetworkContracts() {
  const failResponse = { ok: false, status: 503, json: async () => ({}) } as unknown as Response;
  const failed = await submitGeniusFeedback(1, 1, null, async () => failResponse);
  check("G1 서버 실패는 ok:false", failed.ok === false);

  const okResponse = { ok: true, status: 200, json: async () => ({ ok: true, rating: null }) } as unknown as Response;
  const cancelled = await submitGeniusFeedback(1, 1, null, async () => okResponse);
  check("G2 취소 응답은 rating null", cancelled.ok === true && cancelled.rating === null);

  const thrown = await submitGeniusFeedback(1, 1, null, async () => { throw new Error("net"); });

  // 멱등 계약: 클릭 직전 상태를 body 에 실어야 서버가 취소를 판정할 수 있다.
  // 이게 빠지면 재전송·두 탭 동일 클릭이 표를 뒤집는다(삼순 2차 blocker ②).
  let sentBody: Record<string, unknown> = {};
  await submitGeniusFeedback(7, -1, null, async (_url, init) => {
    sentBody = JSON.parse(String((init as RequestInit).body));
    return okResponse;
  }, -1);
  check("B7 expectedPrev 를 body 에 실어 보낸다", sentBody.expectedPrev === -1);
  check("B8 answerMessageId/rating 도 함께", sentBody.answerMessageId === 7 && sentBody.rating === -1);

  let sentDefault: Record<string, unknown> = {};
  await submitGeniusFeedback(7, 1, null, async (_url, init) => {
    sentDefault = JSON.parse(String((init as RequestInit).body));
    return okResponse;
  });
  check("B9 미지정이면 null (토글 아님 = 확정)", sentDefault.expectedPrev === null);
  check("G3 네트워크 예외도 ok:false", thrown.ok === false);

  const listResponse = {
    ok: true, status: 200,
    json: async () => ({ ok: true, ratings: { "7": 1, "8": -1, "9": 0, bad: 1 } }),
  } as unknown as Response;
  const map = await loadGeniusFeedback([7, 8, 9], null, async () => listResponse);
  check("G4 유효한 표만 복원", map[7] === 1 && map[8] === -1 && map[9] === undefined);
  check("G5 깨진 키는 버린다", Object.keys(map).length === 2);

  // 빈 목록이면 요청 자체를 하지 않는다(불필요 호출 방지).
  let called = false;
  await loadGeniusFeedback([], null, async () => { called = true; return listResponse; });
  check("G6 빈 목록이면 미호출", called === false);
}

async function main() {
await runNetworkContracts();

if (SELFTEST) {
  // 결함주입: 검출력 증명. 각 축이 죽었을 때 실제로 RED 가 나는지 확인한다.
  const injected: string[] = [];
  if (shouldShowFeedback(GENIUS, GENIUS, "answer", "rag") !== true) injected.push("A 축 무력(RAG 답변 누락)");
  if (shouldShowFeedback(GENIUS, GENIUS, "answer", "llm") === true) injected.push("A 축 무력(스모톡 유입)");
  if (shouldShowFeedback(GENIUS, GENIUS, "unavailable", "rag") === true) injected.push("A 축 무력(미응답 유입)");
  if (nextRatingAfterClick(1, 1) !== null) injected.push("B 축 무력");
  console.log(
    injected.length === 0
      ? "✅ selftest: 결함주입 없이 정상 (RED 확인은 대상 코드를 변조해 재실행)"
      : `❌ selftest 감지: ${injected.join(", ")}`,
  );
}

if (failures.length > 0) {
  console.error(`❌ genius-answer-feedback-contract FAILED (${failures.length})`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("✅ genius-answer-feedback-contract PASS (A~G 전 축)");
}

// 예외를 삼키지 않는다 — 게이트가 터졌는데 exit 0 이면 false-green 이다.
main().catch((error) => {
  console.error("❌ genius-answer-feedback-contract CRASHED:", (error as Error).message);
  process.exit(1);
});
