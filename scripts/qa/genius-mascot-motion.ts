/**
 * 야잘알봇 마스코트 모션 게이트 (SSOT §7.6 — 2026-08-15 하린아빠 착수 지시 + 삼순 #1197 NO-GO 반영).
 *
 * 계약:
 *  ① 매핑 SSOT: geniusMotionForResult(source, question) — 인사→excited / 감사·칭찬→headspin /
 *     결정론 거절(scope_guide·blocked)→bored / 그 외 없음. answerQuestion 실실행으로 question→source
 *     라우팅까지 결속한다.
 *  ② payload: composeGeniusReplyPayload 실행 + server.ts 가 **단일 지점**에서
 *     `motion: geniusMotionForResult(result.source, question)` 으로 결속(ready 재시도·조기 blocked 포함).
 *  ③ 폐쇄집합: geniusMotionFromPayload 는 3종 밖 값을 null 로 — payload 전체는 생존.
 *  ④ 전체 마스코트 최대 1개 (하린아빠 13:34·13:53 + 삼순 P0): reply·thinking·failed **3종 합산**이
 *     항상 ≤1. 실제 DMChatPage + 실제 Realtime 배달 + 실제 전송(rpc)으로 생각중→답변 교체,
 *     failed 소유권, 역순 Realtime, reload 재진입까지 DOM 실행 검증.
 *  ⑤ 렌더 규격·상시 idle 모션 (2026-08-16 하린아빠 "캐릭터가 너무 작아서 잘 안보임" +
 *     "안움직이는 것 같은데 움직이게 해줘"): 3종 마스코트가 전부 96px 공유 규격으로 렌더되고,
 *     감정 모션이 없는 지식 답변에서도 idle 미세 모션이 돌며, idle 과 감정 모션이 **다른
 *     엘리먼트**에 걸려 transform 이 서로를 죽이지 않는다. DOM 실측 + CSS 실파일 검사.
 *
 * 실행: npm run qa:genius-mascot-motion
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import type * as ReactNamespace from "react";
import type { Root } from "react-dom/client";

/**
 * WebP 프레임 수 — 컨테이너를 직접 읽는다(디코더 의존 없음).
 *
 * 왜 필요한가: 경로 문자열만 검사하면 파일이 없거나 **정지 이미지가 들어있어도** GREEN 이다.
 * 이번 변경의 핵심이 "실제로 움직이는가" 이므로 그걸 게이트가 증명해야 한다.
 * RIFF/WEBP 컨테이너에서 `ANMF`(애니메이션 프레임) 청크 개수를 센다.
 * 정지 WebP 는 ANMF 가 없으므로 1을 돌려준다.
 */
function webpFrameCount(buf: Buffer): number {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") {
    return 0; // WebP 가 아니면 0 — fail-close(호출부가 미달로 판정)
  }
  let off = 12;
  let frames = 0;
  while (off + 8 <= buf.length) {
    const fourcc = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (fourcc === "ANMF") frames += 1;
    off += 8 + size + (size % 2); // 청크는 짝수 정렬
  }
  return frames > 0 ? frames : 1;
}

/**
 * WebP 재생 사양을 컨테이너에서 직접 읽는다 — `loop` / `alpha` / 첫 프레임 지속(ms).
 *
 * 왜 필요한가 (삼순 #1228 P1 + 하린아빠 14:08 "무한루프"):
 *  · 프레임이 2장 이상이어도 `loop=1` 이면 **한 번 재생하고 멈춘다** — 유저 눈에는
 *    "잠깐 움직이다 죽는" 것이고, 이번 지시(무한루프)의 정반대다.
 *  · alpha 가 없으면 배경이 구워진 자산이라 말풍선 옆에 네모가 뜬다.
 *  · duration 이 상수로 박히면 SSOT 타이밍이 바뀌어도 조용히 어긋난다.
 * 셋 다 **파일이 실제로 들고 있는 값**이라, 코드가 아니라 자산을 검사해야 잡힌다.
 */
/**
 * 전 프레임의 duration(ms) 목록. **첫 프레임만 보면 나머지가 어긋나도 통과한다.**
 * 삼순 #1228 4축-① — 재생 속도가 클립마다 다르면 같은 마스코트가 다른 인물처럼 보인다.
 */
function webpFrameDurations(buf: Buffer): number[] {
  const out: number[] = [];
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF") return out;
  let off = 12;
  while (off + 8 <= buf.length) {
    const fourcc = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (fourcc === "ANMF") out.push(buf.readUIntLE(off + 8 + 12, 3));
    off += 8 + size + (size % 2);
  }
  return out;
}

function webpPlayback(buf: Buffer): { loop: number | null; alpha: boolean; durationMs: number | null } {
  const out: { loop: number | null; alpha: boolean; durationMs: number | null } =
    { loop: null, alpha: false, durationMs: null };
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF") return out;
  let off = 12;
  while (off + 8 <= buf.length) {
    const fourcc = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (fourcc === "VP8X") out.alpha = (buf.readUInt8(off + 8) & 0x10) !== 0;
    // ⚠️ **무손실(VP8L) WebP 에는 VP8X 확장 청크가 없다.** poster 를 무손실로 저장하면
    //    이 경로를 탄다 — VP8X 만 보면 "알파 없음"으로 오판한다(실측: 13종 전부 FAIL).
    //    VP8L 비트스트림 헤더에 alpha_is_used 플래그가 들어있다:
    //    signature(0x2f) + width-1(14b) + height-1(14b) + alpha(1b) + version(3b).
    if (fourcc === "VP8L" && buf.readUInt8(off + 8) === 0x2f) {
      const bits = buf.readUInt32LE(off + 9);          // 시그니처 다음 4바이트
      out.alpha = ((bits >>> 28) & 0x1) !== 0;         // 14+14 비트 뒤의 alpha 플래그
    }
    // ANIM: background(4B) + loop_count(2B, LE). loop_count 0 = 무한.
    if (fourcc === "ANIM" && out.loop === null) out.loop = buf.readUInt16LE(off + 12);
    // ANMF: frame header 16B 중 12..15 가 duration(24bit LE).
    if (fourcc === "ANMF" && out.durationMs === null) {
      out.durationMs = buf.readUIntLE(off + 8 + 12, 3);
    }
    off += 8 + size + (size % 2);
  }
  return out;
}

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "***";
process.env.NODE_ENV = "development";

let pass = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(name);
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function partMapping() {
  const pipeline = await import("../../src/lib/baseball-qa/pipeline");
  const {
    answerQuestion, isGreetingPhrase, isAckPhrase, isScopeAskPhrase, geniusMotionForResult, answerTeamIdForResult,
    SMALLTALK_STREAK_LIMIT, SMALLTALK_STREAK_ANSWER,
  } = pipeline;
  check("입력 전제 (판정기 실확인)",
    isGreetingPhrase("안녕") && isAckPhrase("고마워") && isScopeAskPhrase("야구 룰"));
  check("매핑: 인사 → excited", geniusMotionForResult("ack", "안녕") === "excited");
  check("매핑: 감사 → headspin", geniusMotionForResult("ack", "고마워") === "headspin");
  check("매핑: scope_guide 거절 → bored", geniusMotionForResult("scope_guide", "야구 룰") === "bored");
  check("매핑: blocked 거절 → bored (길이 위반·조기 반환 포함 전 경로)",
    geniusMotionForResult("blocked", "주식 추천해줘") === "bored");
  check("매핑: 지식·오류 답변에는 모션 없음",
    geniusMotionForResult("rag", "보크가 뭐야") === undefined && geniusMotionForResult("error", "x") === undefined);
  // question→source 라우팅 실실행 결속 — 매핑 단위검사만으로는 라우팅이 갈라져도 GREEN 이다.
  const deps = () => ({
    loadGlossary: async () => [],
    loadPlayers: async () => [],
    getCache: async () => null,
    setCache: async () => {},
    callLlm: async () => { throw new Error("llm must not be called"); },
    reserveDaily: async () => ({ allowed: true, remaining: 19 }),
    log: async () => {},
  });
  {
    const res = await answerQuestion("u1", "안녕", deps() as never);
    check("실실행: 인사 → source ack (모션 계산 입력 결속)", res.source === "ack", `source=${res.source}`);
  }
  {
    const res = await answerQuestion("u1", "야구 룰", deps() as never);
    check("실실행: 범위 재질문 → source scope_guide", res.source === "scope_guide", `source=${res.source}`);
  }
  // ⚠️ 삼순 #1197 P0: 종전에는 `고마워`만 검사하고 source 를 직접 넣어 **대표 칭찬이
  // deterministic ack 이 아니어도 GREEN** 이었다. 칭찬은 질문문자열로 **실제 라우팅을
  // 태워** payload 까지 headspin 이 나오는지 종단으로 확인한다.
  {
    const { composeGeniusReplyPayload, geniusMotionFromPayload } = await import("../../src/lib/constants/baseball-genius");
    const praises = ["잘했어", "최고야", "대단해", "잘하네", "최고", "대단하네", "똑똑하네", "기특해"];
    const bad: string[] = [];
    for (const praise of praises) {
      const res = await answerQuestion("u1", praise, deps() as never);
      // server 가 하는 것과 **같은 계산**을 그대로 태운다(synthetic source 주입 금지).
      const payload = composeGeniusReplyPayload(
        { ...res, motion: geniusMotionForResult(res.source, praise) } as never, 1,
      );
      if (res.source !== "ack" || geniusMotionFromPayload(payload) !== "headspin") {
        bad.push(`${praise}(source=${res.source}, motion=${geniusMotionFromPayload(payload)})`);
      }
    }
    check(`종단: 대표 칭찬 ${praises.length}종 → actual routing → payload headspin`, bad.length === 0, bad.join(", "));
  }
  {
    // 칭찬을 넣었다고 진짜 질문을 삼키면 안 된다 — 폐쇄집합은 full-string 완전일치다.
    const res = await answerQuestion("u1", "이대호 최고야", deps() as never);
    check("과차단 없음: 대상이 붙은 문장은 ack 이 아니다", res.source !== "ack", `source=${res.source}`);
  }
  // ⚠️ §7.4 모션 30초 1회의 **판정**은 여기서 검사하지 않는다 — 쿨다운은 동시성 계약이라
  //    합성 시각 단위검사로는 SELECT→INSERT race 를 못 잡는다(삼순 #1202 P0).
  //    실 DB 종단은 `npm run qa:genius-motion-cooldown:db` 가 담당한다.
  //    여기서는 "코드가 쿨다운을 판정하지 않는다"(= DB 단일 소유)만 구조로 잠근다.
  {
    const pipelineSrc = readFileSync(resolve(process.cwd(), "src/lib/baseball-qa/pipeline.ts"), "utf8");
    check("순수 매핑: 코드가 쿨다운을 판정하지 않는다(DB 단일 소유)",
      geniusMotionForResult.length === 2 && !/GENIUS_MOTION_COOLDOWN_MS\)\s*return undefined/.test(pipelineSrc));
  }
  // ── §7.4 연속 4회부터 짧은 고정문 (answerQuestion 종단 실실행) ───────────
  {
    const withStreak = (streak: number, extra?: Record<string, unknown>) => ({
      ...deps(), loadSmalltalkStreak: async () => streak, ...extra,
    });
    {
      const res = await answerQuestion("u1", "고마워", withStreak(SMALLTALK_STREAK_LIMIT) as never);
      check("연속: 직전 3연속 ack(=4회째) → 짧은 고정문",
        res.source === "ack" && res.answer === SMALLTALK_STREAK_ANSWER, `answer=${res.answer}`);
    }
    {
      const res = await answerQuestion("u1", "고마워", withStreak(SMALLTALK_STREAK_LIMIT - 1) as never);
      check("연속: 2연속까지는 정상 응답",
        res.source === "ack" && res.answer !== SMALLTALK_STREAK_ANSWER, `answer=${res.answer}`);
    }
    {
      // 고정문이 적용되면 팀 카피·시그니처 둘 다 건너뛴다 — 짧게 유지가 목적이다.
      let copyCalled = false; let endingCalled = false;
      const res = await answerQuestion("u1", "안녕", withStreak(SMALLTALK_STREAK_LIMIT, {
        pickTeamFanCopy: async () => { copyCalled = true; return "LG 트윈스를 응원하신다니 반갑습니다."; },
        claimPositiveEnding: async (a: string) => { endingCalled = true; return `${a}\n승리를 위하여!`; },
      }) as never);
      check("연속: 고정문 적용 시 팀 카피·시그니처 미호출",
        res.answer === SMALLTALK_STREAK_ANSWER && !copyCalled && !endingCalled,
        `copy=${copyCalled} ending=${endingCalled}`);
    }
    {
      // fail-open: 신호 조회가 터져도 인사는 살아야 한다.
      const res = await answerQuestion("u1", "고마워", {
        ...deps(), loadSmalltalkStreak: async () => { throw new Error("db down"); },
      } as never);
      check("연속: 신호 조회 실패 → 정상 응답(fail-open)",
        res.source === "ack" && res.answer !== SMALLTALK_STREAK_ANSWER);
    }
  }
  // 서버 단일 지점 결속 — compose 호출부가 (source, question) 계산을 태우는지.
  // 실행 검증은 supabase 의존이라 여기서는 소스 결속으로 잠그고, 제거 mutation(M6)이 RED 를 증명한다.
  const serverSrc = readFileSync(resolve(process.cwd(), "src/lib/baseball-qa/server.ts"), "utf8");
  check("server 배선: compose 가 DB 가 승인한 motion 을 싣는다",
    /composeGeniusReplyPayload\(\s*\{ \.\.\.result, motion, motionIntent: candidateMotion, answerTeamId, answerPlayerRole \}/
      .test(serverSrc));
  // 응원 자격(답변 대상 구단)도 **같은 단일 지점**에서 결정론 계산해야 한다 —
  // 여기 말고 다른 곳에서 계산하면 durable 재시도에서 값이 소실된다(#1197 계약과 동일 축).
  check("server 배선: 응원 자격 팀 id 를 단일 지점에서 계산한다",
    /const answerTeamId = answerTeamIdForResult\(result\.source, question\);/.test(serverSrc));
  // 선수 역할은 raw question 이 아니라 **실제 답변 대상**에 결속되어야 한다(삼순 #1251 P1):
  // persisted picked_player_kbo_id → picked_normalized_question → raw question. job 행을 안 읽으면
  // picker 선택·교정 승인·ready 재발송에서 동명이인 역할 혼재로 시드 교대가 재발한다.
  check("server 배선: 역할을 실제 답변 대상(job 행 SSOT)에 결속한다",
    /answerPlayerRole = answerPlayerRoleForTarget\(/.test(serverSrc) &&
    serverSrc.includes('.select("picked_player_kbo_id, picked_normalized_question")') &&
    /pickedPlayerKboId: input\.pickedPlayerKboId\s*\?\? \(targetJob\?\.picked_player_kbo_id as string \| null \?\? null\)/.test(serverSrc) &&
    /correctedQuestion: targetJob\?\.picked_normalized_question as string \| null \?\? null/.test(serverSrc) &&
    /await loadRosterPlayers\(\),\s*\);/.test(serverSrc));
  check("server 배선: 쿨다운은 원자 claim RPC 가 정한다(SELECT→INSERT race 차단)",
    serverSrc.includes('.rpc("claim_baseball_genius_motion"') &&
    /p_decided_at: decidedAt/.test(serverSrc) &&
    /p_cooldown_ms: GENIUS_MOTION_COOLDOWN_MS/.test(serverSrc));
  // ⚠️ "RPC 를 호출한다"만으로는 부족하다 — 반환을 **버리고** 후보 모션을 그대로 쓰면
  //    호출은 남은 채 race 가 되살아난다(M12). 그래서 반환 결속 자체를 계약으로 잠근다.
  check("server 배선: payload 모션은 RPC 반환값에서만 나온다(후보 직접 사용 금지)",
    /motion = granted === null \? undefined : \(granted as typeof candidateMotion\)/.test(serverSrc) &&
    !/motion = candidateMotion;/.test(serverSrc.split("let motion = candidateMotion;")[1] ?? ""));
  // 같은 이유로 payload 이월 시각도 **실제 조회 행**에 결속한다 — 키만 있고 null 을 넣으면
  //    배포 직후 첫 답변이 무조건 모션을 받는다(M14).
  check("server 배선: 원장 이전 payload 모션 시각도 넘긴다(배포 직후 무조건 부여 방지)",
    serverSrc.includes('payload->>motion') &&
    /p_payload_last_motion_at: \(lastMotionRow\?\.created_at as string \| undefined\) \?\? null/.test(serverSrc));
  check("server 배선: loadSmalltalkStreak 가 ORDER 명시 로그 조회로 연결된다",
    /loadSmalltalkStreak: signatureUserId \? async \(\) =>/.test(serverSrc) &&
    /order\("created_at", \{ ascending: false \}\)[\s\S]{0,80}?limit\(SMALLTALK_STREAK_LIMIT\)/.test(serverSrc));
  check("server 배선: QaResult 탑재 방식이 아니다(ready 재시도 소실 방지)",
    !/motion\?:/.test(readFileSync(resolve(process.cwd(), "src/lib/baseball-qa/pipeline.ts"), "utf8").split("export interface QaResult")[1]?.split("}")[0] ?? ""));
}

async function partPayload() {
  const {
    composeGeniusReplyPayload, geniusMotionFromPayload, isGeniusReplyPayload,
  } = await import("../../src/lib/constants/baseball-genius");
  {
    const payload = composeGeniusReplyPayload({ source: "ack", motion: "excited" }, 42);
    check("compose: motion 이 payload 에 실린다",
      payload.motion === "excited" && payload.reply_kind === "ack" && payload.question_message_id === 42);
    check("compose 결과가 클라 validator 를 통과한다", isGeniusReplyPayload(payload));
    check("accessor: 유효 모션 → 그대로", geniusMotionFromPayload(payload) === "excited");
  }
  {
    const payload = composeGeniusReplyPayload({ source: "rag", sourceUrl: "https://namu.wiki/w/x" }, 7);
    check("compose: 비모션 경로에는 motion 키 자체가 없다",
      !("motion" in payload) && payload.reply_kind === "answer" && payload.source_url === "https://namu.wiki/w/x");
    check("accessor: motion 없음 → null", geniusMotionFromPayload(payload) === null);
  }
  {
    const payload = composeGeniusReplyPayload({
      source: "player_picker",
      pickerOptions: [{ kboId: "69100", name: "구본혁", team: "LG", position: "내야수", backNo: "2" }],
    }, 9);
    check("compose: picker 매핑 형태 보존(kbo_id·back_no)",
      payload.picker_options?.[0]?.kbo_id === "69100" && payload.picker_options?.[0]?.back_no === "2");
  }
  {
    const foreign = { type: "baseball_genius_reply", reply_kind: "ack", match_path: "ack", question_message_id: 1, motion: "sparkle" };
    check("폐쇄집합: 밖의 값은 payload 를 살리고 모션만 null",
      isGeniusReplyPayload(foreign) && geniusMotionFromPayload(foreign as never) === null);
    const garbage = { ...foreign, motion: 42 };
    check("validator: motion 비문자열은 거부", !isGeniusReplyPayload(garbage));
  }
  // ── 선수 역할 payload 계약 (하린아빠 2026-08-19) ────────────────────────────
  {
    const { geniusAnswerPlayerRoleFromPayload } = await import("../../src/lib/constants/baseball-genius");
    const withRole = composeGeniusReplyPayload({ source: "kbo_structured", answerPlayerRole: "batter" }, 11);
    check("compose: 역할이 payload 에 실린다 + validator 통과",
      withRole.answer_player_role === "batter" && isGeniusReplyPayload(withRole));
    check("accessor: 유효 역할 → 그대로", geniusAnswerPlayerRoleFromPayload(withRole) === "batter");
    const withoutRole = composeGeniusReplyPayload({ source: "kbo_structured", answerPlayerRole: null }, 12);
    check("compose: 역할 미상(null)은 필드 자체를 안 싣는다(legacy 구분 유지)",
      !("answer_player_role" in withoutRole) && geniusAnswerPlayerRoleFromPayload(withoutRole) === null);
    const foreignRole = {
      type: "baseball_genius_reply", reply_kind: "answer", match_path: "kbo_structured",
      question_message_id: 2, answer_player_role: "coach",
    };
    check("폐쇄집합: 밖의 역할 값은 payload 를 살리고 역할만 null (forward-compat)",
      isGeniusReplyPayload(foreignRole) && geniusAnswerPlayerRoleFromPayload(foreignRole as never) === null);
    check("validator: 역할 비문자열은 거부",
      !isGeniusReplyPayload({ ...foreignRole, answer_player_role: 7 }));
  }
}

// ── ④ 실제 DMChatPage DOM — 전체 마스코트(3종 합산) 최대 1개 ────────────────
const GENIUS_ID = "45ae7419-6a9a-4c6b-9101-8d65df7e242e";
const CONVERSATION_ID = "motion-conversation";

type Row = {
  id: number; conversation_id: string; sender_id: string; content: string;
  is_read: boolean; created_at: string; dedup_key?: string; payload?: Record<string, unknown>;
};

async function partDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  const globals = globalThis as Record<string, unknown>;
  globals.window = dom.window;
  globals.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  for (const key of ["HTMLElement", "HTMLTextAreaElement", "Element", "Node", "Event", "MouseEvent", "localStorage", "sessionStorage"]) {
    globals[key] = (dom.window as unknown as Record<string, unknown>)[key];
  }
  const raf = (callback: (time: number) => void) => dom.window.setTimeout(() => callback(Date.now()), 16);
  globals.requestAnimationFrame = raf;
  globals.cancelAnimationFrame = (id: number) => dom.window.clearTimeout(id);
  (dom.window as unknown as Record<string, unknown>).requestAnimationFrame = raf;
  (dom.window as unknown as Record<string, unknown>).cancelAnimationFrame = globals.cancelAnimationFrame;
  (dom.window as unknown as Record<string, unknown>).matchMedia = () => ({
    matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
  (dom.window.Element.prototype as unknown as Record<string, unknown>).scrollIntoView = () => {};
  (globals as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const React = await import("react") as typeof ReactNamespace;
  const { createRoot } = await import("react-dom/client");
  const act = React.act;
  assert.equal(typeof act, "function");
  const { supabase } = await import("../../src/lib/supabase/client");
  const { AuthProvider } = await import("../../src/lib/supabase/AuthContext");
  const { ThemeProvider } = await import("../../src/components/ThemeProvider");
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { PathParamsContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
  const {
    BASEBALL_QA_MAX_ATTEMPTS,
    BASEBALL_QA_OUTBOX_KEY,
  } = await import("../../src/lib/baseball-qa/client-outbox");
  // 렌더 규격은 문자열로 재작성하지 않고 배포 상수를 그대로 읽는다.
  const { GENIUS_MASCOT_IMG_CLASS, geniusMotionClipFor } =
    await import("../../src/lib/constants/baseball-genius");
  const DMChatPage = (await import("../../src/app/(main)/messages/[conversationId]/page")).default;

  const profile = { id: "me", nickname: "테스터", team_id: 1, favorite_players: [], points: 0, grade: "rookie", avatar_url: null, invited_by: null };
  const genius = { ...profile, id: GENIUS_ID, nickname: "야잘알봇", team_id: null };
  const rows: Row[] = [
    { id: 101, conversation_id: CONVERSATION_ID, sender_id: "me", content: "안녕", is_read: true, created_at: "2026-08-15T00:00:01Z" },
    {
      id: 150, conversation_id: CONVERSATION_ID, sender_id: GENIUS_ID, content: "만나서 반갑습니다.",
      is_read: false, created_at: "2026-08-15T00:00:02Z", dedup_key: "baseball-genius:101",
      payload: { type: "baseball_genius_reply", reply_kind: "ack", match_path: "ack", question_message_id: 101, motion: "excited" },
    },
  ];

  type RealtimePayload = { new: Row };
  const realtimeHandlers = new Map<string, (payload: RealtimePayload) => unknown>();
  // 구독 status 콜백을 보관해야 CHANNEL_ERROR 전이(= Realtime 사망 → polling 폴백)를 재현할 수 있다.
  const statusHandlers = new Map<string, (status: string) => void>();
  const deliver = async (row: Row) => {
    rows.push(row);
    const handler = realtimeHandlers.get(`dm:${CONVERSATION_ID}`);
    assert.ok(handler, "실제 대화 Realtime 구독이 있어야 한다");
    await handler({ new: row });
  };

  // 실제 전송 경로 — hook 의 send 성공이 thinking marker 를 찍는다 (pr1102 하니스와 같은 축).
  const QUESTION_IDS = [501, 601, 701];
  const CREATED: Record<number, string> = {
    501: "2026-08-15T00:00:10Z", 601: "2026-08-15T00:00:14Z", 701: "2026-08-15T00:00:18Z",
  };
  let questionIndex = 0;

  const mutable = supabase as unknown as {
    from: (table: string) => unknown; rpc: (fn: string, args: Record<string, unknown>) => unknown;
    channel: (name: string) => unknown; removeChannel: (channel: unknown) => Promise<string>; auth: unknown;
  };
  const original = { from: mutable.from, rpc: mutable.rpc, channel: mutable.channel, removeChannel: mutable.removeChannel, auth: mutable.auth, fetch: globalThis.fetch };
  const thenable = (value: unknown = { data: null, error: null }) => ({
    then(resolve: (value: unknown) => unknown) { return Promise.resolve(value).then(resolve); },
  });
  mutable.from = (table: string) => {
    if (table === "dm_messages") {
      const query = {
        select: () => query, eq: () => query, or: () => query, order: () => query,
        limit: async () => ({ data: [...rows] }),
        update: () => query,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve),
      };
      return query;
    }
    if (table === "dm_conversations") {
      const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: { user1_id: "me", user2_id: GENIUS_ID } }) };
      return query;
    }
    if (table === "profiles") {
      // Realtime 단건 조회가 봇 발신자에게 유저 프로필(team_id=1)을 돌려주면 TeamBadge
      // fallback 을 타버린다 — eq 인자를 보고 실제처럼 분기한다.
      let requestedId: unknown = null;
      const query = {
        select: () => query,
        eq: (_column: string, value: unknown) => { requestedId = value; return query; },
        maybeSingle: async () => ({ data: requestedId === GENIUS_ID ? genius : profile, error: null }),
        in: async () => ({ data: [profile, genius], error: null }),
      };
      return query;
    }
    if (table === "user_blocks") {
      const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: null, error: null }), insert: () => thenable() };
      return query;
    }
    throw new Error(`unexpected table: ${table}`);
  };
  mutable.rpc = (fn, args) => {
    assert.equal(fn, "send_dm_message_atomic");
    const id = QUESTION_IDS[questionIndex];
    questionIndex += 1;
    rows.push({
      id, conversation_id: CONVERSATION_ID, sender_id: "me", content: String(args.p_content),
      is_read: true, created_at: CREATED[id],
    });
    return { single: async () => ({ data: { conversation_id: CONVERSATION_ID, message_id: id }, error: null }) };
  };
  mutable.channel = (name: string) => {
    const channel = {
      on: (_event: string, _filter: unknown, callback: (payload: RealtimePayload) => unknown) => {
        realtimeHandlers.set(name, callback);
        return channel;
      },
      subscribe: (callback?: (status: string) => void) => {
        if (callback) { statusHandlers.set(name, callback); callback("SUBSCRIBED"); }
        return channel;
      },
    };
    return channel;
  };
  mutable.removeChannel = async () => "ok";
  mutable.auth = {
    getSession: async () => ({ data: { session: { user: { id: "me" }, access_token: "***" } } }),
    setSession: async () => ({ data: { session: null } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  };
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes("/api/baseball-qa")) return new Response(null, { status: 202 });
    if (url.includes("/api/profile")) return new Response(JSON.stringify([profile]), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ ratings: {} }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  async function waitFor(assertion: () => void, timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < deadline) {
      try { assertion(); return; } catch (error) { last = error; }
      await act(async () => { await new Promise((resolve) => dom.window.setTimeout(resolve, 5)); });
    }
    throw last;
  }

  function Harness() {
    const router = React.useMemo(() => ({
      back() {}, forward() {}, refresh() {}, push() {}, prefetch() {}, hmrRefresh() {}, replace() {},
    }), []);
    return React.createElement(
      AppRouterContext.Provider, { value: router as never },
      React.createElement(
        PathParamsContext.Provider, { value: { conversationId: CONVERSATION_ID } },
        React.createElement(
          ThemeProvider, null,
          React.createElement(AuthProvider, null, React.createElement(DMChatPage)),
        ),
      ),
    );
  }

  // 3종 합산 총계 — reply·thinking·failed 마스코트가 전부 `/mascot/motion/…` 영상을 쓴다
  // (2026-08-16 전면 교체 전에는 `/mascot/reply/*.png` 정적 이미지였다).
  const totalMascots = (container: HTMLElement) =>
    container.querySelectorAll('img[src*="/mascot/motion/"]').length;
  const replyMascotOf = (container: HTMLElement, messageId: number) =>
    container.querySelector(`[data-message-id="${messageId}"] [data-testid="genius-reply-mascot"]`);
  /** 재생 중인 영상 클립 이름(종전 `data-motion` 을 대체). */
  const clipOf = (container: HTMLElement, messageId: number) =>
    replyMascotOf(container, messageId)?.getAttribute("data-clip") ?? null;
  const thinkingMascots = (container: HTMLElement) =>
    container.querySelectorAll('[data-testid="genius-thinking-mascot"]').length;
  const failedMascots = (container: HTMLElement) =>
    container.querySelectorAll('[data-testid="genius-typing-mascot"]').length;
  // 렌더된 그 마스코트 1개의 실제 표시 계약을 DOM 에서 직접 읽는다.
  //   JSDOM 은 이미지를 디코딩하지 않으므로 "실제로 재생되느냐"는 여기서 증명할 수 없다
  //   — 그건 자산 프레임수 검사(partRenderContract)가 맡는다.
  //   여기서는 "공유 규격·영상 경로·reduced-motion 대체본이 그 엘리먼트에 붙었는가"를 잠근다.
  const renderContractOf = (img: Element | null) => {
    if (!img) return null;
    const picture = img.parentElement;
    const source = picture?.querySelector("source");
    return {
      sized: img.getAttribute("class")?.includes(GENIUS_MASCOT_IMG_CLASS) ?? false,
      animated: (img.getAttribute("src") ?? "").startsWith("/mascot/motion/"),
      // 종전 CSS 모션 클래스가 하나라도 남아 있으면 폐기가 끝난 게 아니다.
      legacyCssMotion: /genius-motion-(idle|excited|headspin|bored)/.test(img.getAttribute("class") ?? ""),
      // reduced-motion 은 CSS 로 못 멈추므로 poster 자산 대체가 붙어야 한다.
      reducedPoster: (source?.getAttribute("srcset") ?? "").includes("-poster.webp") &&
        (source?.getAttribute("media") ?? "").includes("prefers-reduced-motion"),
    };
  };
  const everyRenderedMascotOk = (container: HTMLElement) => {
    const imgs = [...container.querySelectorAll('img[src*="/mascot/motion/"]')];
    if (imgs.length === 0) return false;
    return imgs.every((img) => {
      const c = renderContractOf(img);
      return !!c && c.sized && c.animated && c.reducedPoster && !c.legacyCssMotion;
    });
  };

  const typeAndSend = async (container: HTMLElement, value: string) => {
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(textarea, value);
      textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await waitFor(() => assert.equal((container.querySelector("textarea") as HTMLTextAreaElement).value, value));
    await act(async () => {
      container.querySelector('button[aria-label="쪽지 보내기"]')!
        .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
  };

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  let root: Root = createRoot(container);
  try {
    await act(async () => { root.render(React.createElement(Harness)); });
    await waitFor(() => {
      // ack + §7.6 motion → 의미 클립. payload 의 motion 이 클립을 정한다(4축-②).
      assert.equal(clipOf(container, 150), geniusMotionClipFor("ack", 150, { motion: "excited" }),
        "초기 로드: 인사 답변에 의미 클립(excited)");
      assert.equal(totalMascots(container), 1, "전체 마스코트는 항상 1개");
    });
    check("DOM: 초기 로드 — reply 영상 클립, 전체 마스코트 1개", true);

    // ⑤ 렌더 계약 — 공유 규격 + 영상 경로 + reduced-motion 대체본.
    {
      const contract = renderContractOf(replyMascotOf(container, 150));
      check("렌더: 답변 마스코트가 공유 96px 규격으로 붙는다", contract?.sized === true, JSON.stringify(contract));
      check("렌더: 정적 PNG 가 아니라 영상 클립(/mascot/motion/)을 재생한다",
        contract?.animated === true, JSON.stringify(contract));
      check("렌더: reduced-motion poster 대체본이 함께 붙는다",
        contract?.reducedPoster === true, JSON.stringify(contract));
      check("렌더: 종전 CSS 모션 클래스 잔존 0",
        contract?.legacyCssMotion === false, JSON.stringify(contract));
    }

    await act(async () => {
      await deliver({
        id: 250, conversation_id: CONVERSATION_ID, sender_id: GENIUS_ID, content: "도움이 됐다니 기쁩니다.",
        is_read: false, created_at: "2026-08-15T00:00:04Z", dedup_key: "baseball-genius:201",
        payload: { type: "baseball_genius_reply", reply_kind: "ack", match_path: "ack", question_message_id: 201, motion: "headspin" },
      });
    });
    await waitFor(() => {
      // payload motion=headspin(감사·칭찬) → headspin 클립. 시드 교대가 아니다.
      assert.equal(clipOf(container, 250), geniusMotionClipFor("ack", 250, { motion: "headspin" }));
      assert.equal(replyMascotOf(container, 150) === null, true, "이전 답변은 마스코트 자체가 완전히 사라진다 (13:53 지시)");
      assert.equal(totalMascots(container), 1, "전체 마스코트는 항상 1개");
      assert.match(container.querySelector('[data-message-id="150"]')?.textContent ?? "", /반갑습니다/);
    });
    check("DOM: 새 모션 도착 → 이전 답변 마스코트 완전 제거", true);

    // 역순 Realtime — 더 낮은 id 의 답변이 늦게 도착해도 소유권이 되돌아가지 않는다.
    await act(async () => {
      await deliver({
        id: 240, conversation_id: CONVERSATION_ID, sender_id: GENIUS_ID, content: "늦게 도착한 과거 답변입니다.",
        is_read: false, created_at: "2026-08-15T00:00:03Z", dedup_key: "baseball-genius:199",
        payload: { type: "baseball_genius_reply", reply_kind: "ack", match_path: "ack", question_message_id: 199, motion: "excited" },
      });
    });
    await waitFor(() => {
      assert.match(container.querySelector('[data-message-id="240"]')?.textContent ?? "", /늦게 도착한/);
      assert.equal(replyMascotOf(container, 240) === null, true, "역순 도착한 과거 답변에 마스코트가 붙으면 안 된다");
      assert.equal(clipOf(container, 250), geniusMotionClipFor("ack", 250, { motion: "headspin" }),
        "역순 도착에도 최신 소유권 유지");
      assert.equal(totalMascots(container), 1);
    });
    check("DOM: 역순 Realtime — 소유권 회귀 없음", true);

    await act(async () => {
      await deliver({
        id: 350, conversation_id: CONVERSATION_ID, sender_id: GENIUS_ID, content: "야구 이야기만 답할 수 있습니다.",
        is_read: false, created_at: "2026-08-15T00:00:06Z", dedup_key: "baseball-genius:301",
        payload: { type: "baseball_genius_reply", reply_kind: "unavailable", match_path: "blocked", question_message_id: 301, motion: "bored" },
      });
    });
    await waitFor(() => {
      assert.equal(clipOf(container, 350), "bored", "답하지 못한 답변은 bored 클립");
      assert.equal(totalMascots(container), 1);
    });
    check("DOM: 거절 bored 클립도 같은 소유권 규칙", true);

    // ⑤ 지식 답변 — 하린아빠 캡처의 "안 움직임" 재현 지점이다.
    //   종전 구조에서는 감정 모션이 안 붙어 완전히 정지했고, 8/16 오전에 넣은 CSS idle 도
    //   진폭이 작아 "안 움직인다"로 읽혔다. 이제 야구 동작 영상이 실제로 재생돼야 한다.
    await act(async () => {
      await deliver({
        id: 450, conversation_id: CONVERSATION_ID, sender_id: GENIUS_ID,
        content: "김현수 선수는 두산·볼티모어·LG 를 거쳤습니다.",
        is_read: false, created_at: "2026-08-15T00:00:07Z", dedup_key: "baseball-genius:401",
        payload: { type: "baseball_genius_reply", reply_kind: "answer", match_path: "rag", question_message_id: 401 },
      });
    });
    await waitFor(() => {
      assert.ok(replyMascotOf(container, 450), "지식 답변에도 마스코트는 붙는다");
      assert.equal(clipOf(container, 450), geniusMotionClipFor("answer", 450));
      assert.equal(totalMascots(container), 1);
    });
    {
      const img = replyMascotOf(container, 450)!;
      const contract = renderContractOf(img);
      const clip = clipOf(container, 450);
      check("렌더: 지식 답변이 야구 동작(swing/pitching) 영상을 재생한다 — 캡처 재현 지점",
        clip === "swing" || clip === "pitching", String(clip));
      check("렌더: 지식 답변도 영상 경로 + reduced-motion poster",
        contract?.animated === true && contract?.reducedPoster === true, JSON.stringify(contract));
      check("렌더: 지식 답변 마스코트도 공유 96px 규격", contract?.sized === true);
    }

    // 새 질문 전송 → 생각중 말풍선이 마스코트를 소유한다 (reply 마스코트는 사라진다).
    await typeAndSend(container, "새 질문입니다");
    await waitFor(() => {
      assert.equal(thinkingMascots(container), 1, "생각중 마스코트가 소유권을 가진다");
      assert.equal(replyMascotOf(container, 450) === null, true, "생각중이 뜨면 이전 답변 마스코트는 사라진다");
      assert.equal(totalMascots(container), 1, "전체 마스코트는 항상 1개");
    });
    check("DOM: 새 질문 → thinking 소유권 이동(답변 마스코트 제거)", true);
    check("렌더: 생각중 마스코트도 공유 규격 + idle (대기 중에도 움직임)",
      everyRenderedMascotOk(container));

    // failed — 재시도 버블이 소유권을 가진다.
    // 🔴 원복(하린아빠 2026-08-17 19:46)으로 생각중 말풍선 **자체가 사라진다**.
    //    종전엔 "마스코트만 숨고 문장 기록은 남는다"였는데, 그 잔존 계약이 되돌려졌다.
    const stored = JSON.parse(dom.window.localStorage.getItem(BASEBALL_QA_OUTBOX_KEY) ?? "[]") as Array<Record<string, unknown>>;
    for (const entry of stored) {
      if (entry.messageId === 501) { entry.attempts = BASEBALL_QA_MAX_ATTEMPTS; entry.acknowledged = false; }
    }
    dom.window.localStorage.setItem(BASEBALL_QA_OUTBOX_KEY, JSON.stringify(stored));
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event("online")); });
    await waitFor(() => {
      assert.equal(failedMascots(container), 1, "failed 재시도 버블이 마스코트를 소유한다");
      assert.equal(thinkingMascots(container), 0, "생각중 마스코트가 사라진다");
      assert.equal(container.querySelector('[data-testid="genius-thinking-bubble"]'), null,
        "원복: 실패 시 생각중 말풍선 자체가 사라진다(재시도 버블과 동시 노출 금지)");
      assert.equal(totalMascots(container), 1);
    });
    check("DOM: failed → 재시도 버블 소유권(동일 질문 우선순위 failed>thinking)", true);
    check("렌더: 실패 마스코트도 공유 규격 + idle (3종 전부 동일 계약)",
      everyRenderedMascotOk(container));

    // failed 가 남아 있는 채 두 번째 질문 → 최신 thinking 이 소유. failed 마스코트는 숨는다.
    await typeAndSend(container, "두 번째 질문입니다");
    await waitFor(() => {
      assert.equal(thinkingMascots(container), 1, "최신 질문의 생각중이 소유권을 가진다");
      assert.equal(failedMascots(container), 0, "과거 failed 마스코트는 숨는다(재시도 버튼은 유지)");
      assert.ok(container.querySelector('[data-state="failed"] button'), "재시도 버튼 기능은 남는다");
      assert.equal(totalMascots(container), 1);
    });
    check("DOM: failed 잔존 + 새 질문 → 최신 thinking 소유권", true);

    // ── 🔴 대기 중인데 소유권이 thinking 이 **아닌** 경우 (원복 후 M7 관측 지점) ──────
    //
    // 원복으로 생각중 말풍선이 `pending` 일 때만 렌더되면서, "말풍선은 떠 있는데 마스코트
    // 소유권은 남에게 있는" 조합을 만들 무대가 사라질 뻔했다(그 조합이 없으면
    // `showMascot={true}` 훼손이 화면에 아무 차이를 못 만들어 **검출 불가**가 된다).
    // 그 조합은 여전히 실재한다: **더 큰 id 의 답변이 다른(과거) 질문에 도착**하면
    // 소유권은 reply 로 가고, 현재 질문은 계속 대기 상태다.
    await act(async () => {
      await deliver({
        id: 640, conversation_id: CONVERSATION_ID, sender_id: GENIUS_ID, content: "과거 질문에 대한 답변입니다.",
        is_read: false, created_at: "2026-08-15T00:00:15Z", dedup_key: "baseball-genius:501",
        payload: { type: "baseball_genius_reply", reply_kind: "answer", match_path: "rag", question_message_id: 501 },
      });
    });
    await waitFor(() => {
      assert.ok(container.querySelector('[data-testid="genius-thinking-bubble"]'),
        "선행 조건: 현재 질문(601)은 아직 대기 중이라 말풍선이 떠 있어야 한다");
      assert.ok(replyMascotOf(container, 640), "더 큰 id 답변이 마스코트 소유권을 가져간다");
      assert.equal(thinkingMascots(container), 0,
        "대기 중이어도 소유권이 없으면 생각중 마스코트는 숨는다");
      assert.equal(totalMascots(container), 1, "전체 마스코트는 항상 1개");
    });
    check("DOM: 대기 중 + 타 질문 답변 도착 → 생각중 마스코트는 숨는다(소유권 우선)", true);

    // 답변 도착 → reply 가 소유권을 되찾고 모션이 입혀진다.
    await act(async () => {
      await deliver({
        id: 650, conversation_id: CONVERSATION_ID, sender_id: GENIUS_ID, content: "도움이 됐다니 기쁩니다.",
        is_read: false, created_at: "2026-08-15T00:00:16Z", dedup_key: "baseball-genius:601",
        payload: { type: "baseball_genius_reply", reply_kind: "ack", match_path: "ack", question_message_id: 601, motion: "headspin" },
      });
    });
    await waitFor(() => {
      assert.equal(clipOf(container, 650), geniusMotionClipFor("ack", 650, { motion: "headspin" }),
        "답변 도착 → reply 소유권 복귀 + 클립");
      assert.equal(thinkingMascots(container), 0);
      assert.equal(totalMascots(container), 1);
    });
    check("DOM: 답변 도착 → thinking→reply 교체", true);

    // ── polling 폴백 경로 (삼순 #1197 P1) ───────────────────────────────────
    // Realtime 이 죽은 동안 답변은 `loadMessages("merge")` → `mergeDmMessagesById` 로 들어온다.
    // 이 경로로 들어온 답변도 같은 소유권 규칙을 따라야 한다.
    await typeAndSend(container, "폴링 경로 질문입니다");
    await waitFor(() => {
      assert.equal(thinkingMascots(container), 1, "새 질문 → thinking 소유");
      assert.equal(totalMascots(container), 1);
    });
    // Realtime handler 를 타지 **않고** 저장소에만 답변을 넣는다 — polling 이어야만 보인다.
    rows.push({
      id: 750, conversation_id: CONVERSATION_ID, sender_id: GENIUS_ID, content: "폴링으로 도착한 답변입니다.",
      is_read: false, created_at: "2026-08-15T00:00:20Z", dedup_key: "baseball-genius:701",
      payload: { type: "baseball_genius_reply", reply_kind: "unavailable", match_path: "scope_guide", question_message_id: 701, motion: "bored" },
    });
    // 구독을 죽인다 → healthy=false → catch-up 폴링(jitter ≤1.5s)이 merge 로 재조회한다.
    await act(async () => {
      for (const handler of statusHandlers.values()) handler("CHANNEL_ERROR");
    });
    await waitFor(() => {
      assert.ok(container.querySelector('[data-message-id="750"]'), "polling merge 로 새 답변이 들어와야 한다");
      assert.equal(clipOf(container, 750), "bored", "polling 으로 도착한 답변이 클립 소유권을 가진다");
      assert.equal(thinkingMascots(container), 0, "polling 답변 관측 후 생각중 마스코트가 사라진다");
      assert.equal(replyMascotOf(container, 650) === null, true, "이전 답변 마스코트는 제거된다");
      assert.equal(totalMascots(container), 1, "polling 경로에서도 전체 마스코트는 1개");
    }, 10_000);
    check("DOM: polling merge 경로 — 소유권·모션·총계 동일", true);

    // reload 재진입 — 같은 데이터로 새 인스턴스를 띄워도 최신 1개 그대로다.
    await act(async () => { root.unmount(); });
    container.replaceChildren();
    root = createRoot(container);
    await act(async () => { root.render(React.createElement(Harness)); });
    await waitFor(() => {
      assert.equal(clipOf(container, 750), "bored", "reload 후에도 최신 답변에만");
      assert.equal(totalMascots(container), 1, "reload 후에도 전체 1개");
    });
    check("DOM: reload 재진입 — 최신 1개 불변", true);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    mutable.from = original.from; mutable.rpc = original.rpc; mutable.channel = original.channel;
    mutable.removeChannel = original.removeChannel; mutable.auth = original.auth; globalThis.fetch = original.fetch;
    dom.window.close();
  }
}

// ── ⑤ 렌더 규격 + 상시 idle 모션 CSS 계약 (2026-08-16) ─────────────────────────
async function partRenderContract() {
  const {
    GENIUS_MASCOT_HEIGHT_PX, GENIUS_MASCOT_IMG_CLASS,
    GENIUS_MOTION_CLIPS, geniusMotionClipFor, geniusMotionSrc, geniusMotionPosterSrc, isFavoriteTeamAnswer, isRealTeamId,
  } = await import("../../src/lib/constants/baseball-genius");
  // 응원 자격 계산은 pipeline 소유 — payload 에 실리는 값이라 여기서 직접 태운다.
  const { answerTeamIdForResult } = await import("../../src/lib/baseball-qa/pipeline");
  // 쿨다운 거절 경로는 서버가 두 값(motion·motionIntent)을 다 실어야 성립한다.
  const serverSrc = readFileSync(resolve(process.cwd(), "src/lib/baseball-qa/server.ts"), "utf8");
  const constantsSrc = readFileSync(
    resolve(process.cwd(), "src/lib/constants/baseball-genius.ts"), "utf8");

  // 규격은 상수가 SSOT — 게이트가 문자열을 재구현하면 사용처가 되돌아가도 GREEN 이다
  // (M90 `게이트가 상수를 재구현하면 결함을 못 본다`). 상수 자체를 판정한다.
  check(`규격 SSOT: 마스코트 높이 ${GENIUS_MASCOT_HEIGHT_PX}px (헤더 h-24 동일)`,
    GENIUS_MASCOT_HEIGHT_PX === 96 && /(^|\s)h-24(\s|$)/.test(GENIUS_MASCOT_IMG_CLASS),
    GENIUS_MASCOT_IMG_CLASS);
  check("규격 SSOT: 종전 h-8(32px) 으로 되돌아가지 않는다",
    !/(^|\s)h-8(\s|$)/.test(GENIUS_MASCOT_IMG_CLASS), GENIUS_MASCOT_IMG_CLASS);

  // ── 영상 모션 자산 실재 (2026-08-16 하린아빠 13:48 전면 교체) ──────────────
  // ⚠️ 경로 문자열만 검사하면 파일이 없어도 GREEN 이다(404 마스코트 = 빈 칸).
  //    실제 파일과 **애니메이션임**(프레임 2장 이상)을 딜코더로 확인한다.
  const missing: string[] = [];
  const still: string[] = [];
  const sameFile: string[] = [];
  for (const clip of GENIUS_MOTION_CLIPS) {
    // ⚠️ 역할(본클립/poster)은 **호출한 함수**로 정한다. 경로 문자열에 "-poster" 가
    //    들어있는지로 판정하면, 본클립 함수가 poster 를 돌려주도록 훼손돼도
    //    poster 검사로 넘어가 GREEN 이 된다(false-green — mutation M20 이 실제로 잡아냈다).
    const roles = [
      { role: "clip" as const, path: geniusMotionSrc(clip) },
      { role: "poster" as const, path: geniusMotionPosterSrc(clip) },
    ];
    for (const { role, path: p } of roles) {
      const abs = resolve(process.cwd(), "public", p.replace(/^\//, ""));
      if (!existsSync(abs)) { missing.push(p); continue; }
      const frames = webpFrameCount(readFileSync(abs));
      // 본 클립은 움직여야 하고(ANMF 다수), poster 는 정지여야 한다.
      if (role === "poster") { if (frames > 1) still.push(`${p}(${frames}f)`); }
      else if (frames < 2) still.push(`${p}(${frames}f)`);
    }
    // 본클립과 poster 가 같은 파일을 가리키면 둘 중 하나가 제 역할을 못 한다.
    if (geniusMotionSrc(clip) === geniusMotionPosterSrc(clip)) sameFile.push(clip);
  }
  check(`자산: 영상 모션 ${GENIUS_MOTION_CLIPS.length}종 + poster 가 전부 존재한다`,
    missing.length === 0, missing.join(", "));
  check("자산: 본클립은 실제 애니메이션(≥2프레임)·poster 는 정지(1프레임)",
    still.length === 0, still.join(", "));
  check("자산: 본클립과 poster 가 서로 다른 파일이다(재생 자산이 정지본으로 바뀌지 않음)",
    sameFile.length === 0, sameFile.join(", "));

  // ── 재생 사양 (하린아빠 2026-08-16 14:08 "무한루프" · 삼순 #1228 P1) ────────
  // 프레임 수만 보면 `loop=1`(1회 재생 후 정지)·불투명 배경·엉뚱한 fps 를 전부 놓친다.
  const notLooping: string[] = [];
  const noAlpha: string[] = [];
  const badFps: string[] = [];
  const posterNotFirstFrame: string[] = [];
  for (const clip of GENIUS_MOTION_CLIPS) {
    const clipAbs = resolve(process.cwd(), "public", geniusMotionSrc(clip).replace(/^\//, ""));
    const posterAbs = resolve(process.cwd(), "public", geniusMotionPosterSrc(clip).replace(/^\//, ""));
    if (!existsSync(clipAbs) || !existsSync(posterAbs)) continue;
    const play = webpPlayback(readFileSync(clipAbs));
    if (play.loop !== 0) notLooping.push(`${clip}(loop=${play.loop ?? "없음"})`);
    if (!play.alpha) noAlpha.push(clip);
    // 12fps = 83.33ms/frame → 정수로는 83/84 만 허용한다.
    // ⚠️ 종전엔 60~220ms 로 폭을 넓게 잡았는데, 그건 **false-green** 이었다:
    //    실제 자산 10/13 종이 100~200ms(=5~10fps)였는데도 통과했다(삼순 #1228 4축-①).
    //    "원본 타이밍 보존"이라는 전제 자체가 틀렸다 — SSOT WebP 의 frame duration 은
    //    전 종 0 이라 보존할 타이밍이 애초에 없었다.
    // ⚠️ 첫 프레임만 보면 나머지가 어긋나도 통과한다 — **전 프레임**을 검사한다.
    const durations = webpFrameDurations(readFileSync(clipAbs));
    const offSpec = durations.filter((d) => d !== 83 && d !== 84);
    if (durations.length === 0 || offSpec.length > 0) {
      badFps.push(`${clip}(${[...new Set(offSpec)].join("/") || "없음"}ms · ${offSpec.length}f)`);
    }
    // poster 도 alpha 가 있어야 reduced-motion 에서 네모가 안 뜬다.
    if (!webpPlayback(readFileSync(posterAbs)).alpha) noAlpha.push(`${clip}-poster`);
    // poster 는 "첫 프레임"이어야 한다 — 크기가 다르면 정지 순간 캐릭터가 튄다.
    const clipBuf = readFileSync(clipAbs);
    const posterBuf = readFileSync(posterAbs);
    // 규격은 컨테이너 종류와 무관하게 읽는다 — VP8X(확장) / VP8L(무손실) 둘 다.
    const dim = (b: Buffer) => {
      const kind = b.toString("ascii", 12, 16);
      if (kind === "VP8X") return `${b.readUIntLE(24, 3) + 1}x${b.readUIntLE(27, 3) + 1}`;
      if (kind === "VP8L" && b.readUInt8(20) === 0x2f) {
        const bits = b.readUInt32LE(21);
        return `${(bits & 0x3fff) + 1}x${((bits >>> 14) & 0x3fff) + 1}`;
      }
      return "?";
    };
    if (dim(clipBuf) !== dim(posterBuf)) {
      posterNotFirstFrame.push(`${clip}(${dim(clipBuf)} vs ${dim(posterBuf)})`);
    }
  }
  check("자산: 전 클립이 **무한 루프**다 (loop=0 — 1회 재생 후 정지 아님)",
    notLooping.length === 0, notLooping.join(", "));
  check("자산: 전 클립·poster 가 투명배경이다 (말풍선 옆 네모 방지)",
    noAlpha.length === 0, noAlpha.join(", "));
  check("자산: **전 프레임**이 정확히 12fps(83/84ms)다 — 클립마다 속도가 다르지 않다",
    badFps.length === 0, badFps.join(", "));
  check("자산: poster 규격이 본클립과 같다 (정지 순간 캐릭터가 안 튄다)",
    posterNotFirstFrame.length === 0, posterNotFirstFrame.join(", "));

  // ── 파생 재현성 (삼순 #1228 P1) ────────────────────────────────────────────
  // 파생 자산만 있으면 "어디서 어떻게 나왔는가"를 아무도 재현할 수 없다.
  const genScript = resolve(process.cwd(), "scripts/assets/build-mascot-motion.py");
  check("파생: 빌드 스크립트가 커밋돼 있다(자산 재생성 가능)", existsSync(genScript));
  const derivedPath = resolve(process.cwd(), "public/mascot/motion/DERIVED.json");
  check("파생: manifest 가 커밋돼 있다", existsSync(derivedPath));
  if (existsSync(derivedPath)) {
    const derived = JSON.parse(readFileSync(derivedPath, "utf8")) as {
      clips?: Record<string, { clip_sha256?: string; poster_sha256?: string }>;
    };
    const listed = Object.keys(derived.clips ?? {}).sort();
    check("파생: manifest 가 13종 전부를 기록한다",
      listed.length === GENIUS_MOTION_CLIPS.length &&
      [...GENIUS_MOTION_CLIPS].sort().every((c, i) => listed[i] === c),
      listed.join(", "));
    // 기록된 해시가 **실제 배포 자산과 일치**해야 한다. 아니면 manifest 는 장식이다.
    const drift: string[] = [];
    for (const clip of GENIUS_MOTION_CLIPS) {
      const meta = derived.clips?.[clip];
      if (!meta) continue;
      for (const [field, p] of [
        ["clip_sha256", geniusMotionSrc(clip)] as const,
        ["poster_sha256", geniusMotionPosterSrc(clip)] as const,
      ]) {
        const abs = resolve(process.cwd(), "public", p.replace(/^\//, ""));
        if (!existsSync(abs)) continue;
        const actual = createHash("sha256").update(readFileSync(abs)).digest("hex");
        if (meta[field] !== actual) drift.push(`${clip}.${field}`);
      }
    }
    check("파생: manifest 해시가 배포 자산과 일치한다(수동 교체 감지)",
      drift.length === 0, drift.join(", "));
  }

  // ── 클립 선택 = 결정론 + 13종 전수 도달성 ──────────────────────────
  check("클립 선택은 결정론이다(같은 입력 → 같은 출력)",
    [0, 1, 7, 42, 12345].every((id) =>
      geniusMotionClipFor("answer", id) === geniusMotionClipFor("answer", id) &&
      geniusMotionClipFor("ack", id) === geniusMotionClipFor("ack", id)));
  // ── 응원 자격 계산 함수를 **직접 태운다** (M25 가 검출) ────────────────────
  // 종전 게이트는 `geniusMotionClipFor` 만 태웠는데, 거절/되묻기는 그 함수가 먼저
  // 조기 반환하므로 `answerTeamIdForResult` 가 망가져도 결과가 안 변했다.
  // 자격 계산은 payload 에 실리는 값이므로 **그 함수 자체**를 검사해야 한다.
  {
    const rejecting = ["ack", "scope_guide", "blocked", "unsure", "error", "player_picker",
      "question_correction", "quota", "no_context", "service_redirect", "stat_clarify"];
    const leaked = rejecting.filter((src) => answerTeamIdForResult(src, "LG 순위 알려줘") !== null);
    check("응원 자격: 답하지 못한 경로는 팀 id 를 싣지 않는다(차단인데 응원 방지)",
      leaked.length === 0, leaked.join(","));
    // 실제 답변 경로에서는 구단이 특정될 때만 id 가 나온다.
    check("응원 자격: 답변 경로 + 단일 구단 → 팀 id",
      answerTeamIdForResult("rag", "LG 순위 알려줘") === 1);
    check("응원 자격: 구단 미언급 → null",
      answerTeamIdForResult("rag", "번트가 뭐야?") === null);
    check("응원 자격: 두 구단 이상(비교) → null (기존 구단 결속 SSOT 재사용)",
      answerTeamIdForResult("rag", "LG랑 두산 중 누가 위야?") === null);
    // 표기 변형이 같은 id 로 수렴해야 한다 — 문자열 비교였다면 갈렸을 자리.
    check("응원 자격: 표기 변형(LG/엘지/트윈스)이 같은 id 로 수렴",
      new Set(["LG 승률", "엘지 승률", "트윈스 승률"]
        .map((q) => answerTeamIdForResult("rag", q))).size === 1);
  }

  // ── 선수 역할 계산 함수를 **직접 태운다** (하린아빠 2026-08-19 "박동원은 타자인데 투구모션") ─
  // 응원 자격과 같은 이유: payload 에 실리는 값이므로 그 함수 자체를 검사해야 한다.
  {
    const { answerPlayerRoleForResult } = await import("../../src/lib/baseball-qa/pipeline");
    // 결정론 fixture — 실 로스터 패턴(포수/투수/내야수/미상/동명이인)을 재현한다.
    const roster = [
      { name: "박동원", kboId: "60443", team: "LG", position: "포수" },
      { name: "손주영", kboId: "51350", team: "LG", position: "투수" },
      { name: "문보경", kboId: "52354", team: "LG", position: "내야수" },
      { name: "김철수", kboId: "11111", team: "A", position: "투수" },
      { name: "김철수", kboId: "22222", team: "B", position: "내야수" },
      { name: "이몽룡", kboId: "33333", team: "C", position: "" },
    ] as never;
    const rejecting = ["ack", "scope_guide", "blocked", "unsure", "error", "player_picker",
      "question_correction", "quota", "no_context", "service_redirect", "stat_clarify"];
    const leaked = rejecting.filter((src) =>
      answerPlayerRoleForResult(src as never, "박동원 타율", roster) !== null);
    check("역할: 답하지 못한 경로는 역할을 싣지 않는다(fail-close)",
      leaked.length === 0, leaked.join(","));
    check("역할: 타자(포수) 질문 → batter (박동원 제보 재현)",
      answerPlayerRoleForResult("kbo_structured" as never, "박동원 타율", roster) === "batter");
    check("역할: 투수 질문 → pitcher (8/18 투수→스윙 제보 재현)",
      answerPlayerRoleForResult("kbo_structured" as never, "손주영 평균자책점", roster) === "pitcher");
    check("역할: 투·타 비교 질문 → null (한쪽 역할 확정 금지)",
      answerPlayerRoleForResult("kbo_structured" as never, "손주영이랑 박동원 중 누가 잘해?", roster) === null);
    check("역할: 같은 역할 복수 선수 → 그 역할 (타자 둘 비교 → batter)",
      answerPlayerRoleForResult("kbo_structured" as never, "문보경이랑 박동원 타율 비교", roster) === "batter");
    check("역할: 동명이인 역할 혼재(투수 vs 야수) → null",
      answerPlayerRoleForResult("kbo_structured" as never, "김철수 성적", roster) === null);
    check("역할: position 미상 → null (추측 금지)",
      answerPlayerRoleForResult("kbo_structured" as never, "이몽룡 기록", roster) === null);
    check("역할: 선수 미언급(팀·용어 질문) → null",
      answerPlayerRoleForResult("kbo_structured" as never, "번트가 뭐야?", roster) === null &&
      answerPlayerRoleForResult("kbo_structured" as never, "LG 순위 알려줘", roster) === null);

    // ── 실제 답변 대상 결속 (삼순 #1251 P1) — picker 선택·교정 승인·ready 재시도 종단 ───
    const { answerPlayerRoleForTarget } = await import("../../src/lib/baseball-qa/pipeline");
    // 동명이인 역할 혼재(김철수: 투수 11111 · 내야수 22222) — raw question 만으로는 null 이지만,
    // picker 에서 한 명을 고르면 **그 선수의 역할**이 나와야 한다(야수/투수 각각).
    check("역할 결속: picker 에서 투수를 고르면 pitcher (raw question 은 혼재→null 이어도)",
      answerPlayerRoleForTarget("kbo_structured" as never,
        { pickedPlayerKboId: "11111", question: "김철수 성적" }, roster) === "pitcher");
    check("역할 결속: picker 에서 야수를 고르면 batter",
      answerPlayerRoleForTarget("kbo_structured" as never,
        { pickedPlayerKboId: "22222", question: "김철수 성적" }, roster) === "batter");
    check("역할 결속: picked 가 로스터에 없으면 null (질문 기반으로 내려가지 않는다)",
      answerPlayerRoleForTarget("kbo_structured" as never,
        { pickedPlayerKboId: "99999", question: "손주영 평균자책점" }, roster) === null);
    check("역할 결속: 수락된 교정문이 raw question 보다 우선한다",
      answerPlayerRoleForTarget("kbo_structured" as never,
        { correctedQuestion: "손주영 평균자책점", question: "손주슘 평균자책점" }, roster) === "pitcher");
    check("역할 결속: picked 없으면 질문 기반과 동일 (비회귀)",
      answerPlayerRoleForTarget("kbo_structured" as never,
        { question: "박동원 타율" }, roster) === "batter");
    check("역할 결속: 거절 경로는 picked 가 있어도 null",
      answerPlayerRoleForTarget("blocked" as never,
        { pickedPlayerKboId: "11111", question: "김철수 성적" }, roster) === null);
    // ready 재시도·reload 동일성 — 같은 durable 입력이면 몇 번을 불러도 같은 역할이다.
    check("역할 결속: 같은 durable 입력 → 항상 같은 역할 (ready 재시도·reload 동일성)",
      new Set(Array.from({ length: 5 }, () =>
        answerPlayerRoleForTarget("kbo_structured" as never,
          { pickedPlayerKboId: "11111", question: "김철수 성적" }, roster))).size === 1);
  }

  check("클립 선택: 되묻기(picker/correction) → thinking",
    geniusMotionClipFor("picker", 3) === "thinking" && geniusMotionClipFor("correction", 8) === "thinking");
  check("클립 선택: 답하지 못함(unavailable) → bored",
    geniusMotionClipFor("unavailable", 5) === "bored");
  {
    const answers = new Set(Array.from({ length: 40 }, (_, i) => geniusMotionClipFor("answer", i)));
    check("클립 선택: 정상답변은 야구 동작 2종 교대(같은 동작 반복 없음)",
      answers.size === 2 && [...answers].every((c) => c === "swing" || c === "pitching"),
      [...answers].join(","));
    // ── 선수 역할 확정 답변 (하린아빠 2026-08-19) — 의미 있는 축이므로 시드 교대 금지 ─
    check("역할 클립: 투수 답변 → pitching, 시드와 무관",
      Array.from({ length: 40 }, (_, i) =>
        geniusMotionClipFor("answer", i, { answerPlayerRole: "pitcher" })).every((c) => c === "pitching"));
    check("역할 클립: 타자·야수 답변 → swing, 시드와 무관",
      Array.from({ length: 40 }, (_, i) =>
        geniusMotionClipFor("answer", i, { answerPlayerRole: "batter" })).every((c) => c === "swing"));
    check("역할 클립: 역할 미상(null)은 기존 교대 그대로(legacy 비회귀)",
      new Set(Array.from({ length: 40 }, (_, i) =>
        geniusMotionClipFor("answer", i, { answerPlayerRole: null }))).size === 2);
    // 응원(최애팀)은 "네 팀 얘기다"라는 더 강한 신호 — 역할보다 앞선다(기존 우선순위 유지).
    check("역할 클립: 최애팀 응원이 역할보다 우선한다",
      (GENIUS_MOTION_CLIPS as readonly string[]).includes(
        geniusMotionClipFor("answer", 3,
          { answerPlayerRole: "batter", answerTeamId: 1, favoriteTeamId: 1 })) &&
      geniusMotionClipFor("answer", 3,
        { answerPlayerRole: "batter", answerTeamId: 1, favoriteTeamId: 1 }).startsWith("cheer"));
    // ── §7.6 의미 매핑 (삼순 #1228 4축-②) ─────────────────────────────────────
    // 인사=excited / 감사·칭찬=headspin 은 **의미**다. 시드로 교대시키면
    // "고마워"에 신남이, "안녕"에 헤드스핀이 나온다 — 그게 종전 회귀였다.
    check("의미 매핑: 인사(motion=excited) → excited 클립, 시드와 무관",
      Array.from({ length: 40 }, (_, i) =>
        geniusMotionClipFor("ack", i, { motion: "excited" })).every((c) => c === "excited"));
    check("의미 매핑: 감사·칭찬(motion=headspin) → headspin 클립, 시드와 무관",
      Array.from({ length: 40 }, (_, i) =>
        geniusMotionClipFor("ack", i, { motion: "headspin" })).every((c) => c === "headspin"));
    check("의미 매핑: 거절(motion=bored) → bored 클립 — reply_kind 가 ack(범위 안내)여도",
      Array.from({ length: 40 }, (_, i) =>
        geniusMotionClipFor("ack", i, { motion: "bored" })).every((c) => c === "bored"));
    // 의미가 안 실린 ack(legacy payload) 는 중립 — 무작위면 감사에 신남이 붙는다.
    const acks = new Set(Array.from({ length: 60 }, (_, i) => geniusMotionClipFor("ack", i)));
    check("의미 매핑: motion 미상 ack 는 중립 고정(무작위 금지)",
      acks.size === 1 && acks.has("swing"), [...acks].join(","));
    // 의미 모션은 최애팀보다 **우선**한다 — 인사에 응원이 뜨면 신호가 뒤집힌다.
    check("의미 매핑: 의미 모션이 최애팀 응원보다 우선한다",
      geniusMotionClipFor("ack", 3,
        { motion: "excited", motionIntent: "excited", answerTeamId: 1, favoriteTeamId: 1 })
        === "excited");

    // ── 🔴 쿨다운 거절 = **실경로** (삼순 2026-08-16 P0) ────────────────────────
    //
    // 30초 쿨다운(#1202)이 claim 을 거절하면 서버는 payload 에 motion 을 **안 싣는다**.
    // 종전 게이트는 케이스마다 motion 을 직접 주입해서 이 경로를 한 번도 안 태웠고,
    // 그 결과 "감사"·"인사"·"범위 안내"가 전부 같은 폴백으로 무너지는 걸 못 봤다.
    //
    // 계약: 의미(intent)는 쿨다운과 무관하게 보존되고, 쿨다운은 **감정 클립 재생만** 막는다.
    // ⚠️ **전 의미 공통이다 — bored 도 예외가 아니다** (삼순 2026-08-16 보완).
    //    "범위 안내는 상태 표시니 쿨다운 예외" 로 뒀다가 철회했다. 그 판단이 맞더라도
    //    §7.4 계약을 리뷰 승인 없이 바꾸는 것이었다. 필요하면 §7.4 를 정식으로 고친다.
    check("쿨다운 거절: 범위 안내(intent=bored, 미승인) → 중립. bored 도 예외가 아니다",
      Array.from({ length: 40 }, (_, i) =>
        geniusMotionClipFor("ack", i, { motion: null, motionIntent: "bored" }))
        .every((c) => c === "swing"));
    check("쿨다운 승인: 범위 안내(intent=granted=bored) → bored",
      geniusMotionClipFor("ack", 9, { motion: "bored", motionIntent: "bored" }) === "bored");
    // 답변 불가(reply_kind=unavailable)는 모션이 아니라 **유형**이라 쿨다운과 무관하다.
    check("답변 불가(reply_kind=unavailable)는 쿨다운과 무관하게 bored — 모션이 아니라 유형",
      geniusMotionClipFor("unavailable", 9, { motion: null, motionIntent: null }) === "bored");
    check("쿨다운 거절: 감사(intent=headspin, 미승인) → 중립. 신남으로 바뀌지 않는다",
      Array.from({ length: 40 }, (_, i) =>
        geniusMotionClipFor("ack", i, { motion: null, motionIntent: "headspin" }))
        .every((c) => c === "swing"));
    check("쿨다운 거절: 인사(intent=excited, 미승인) → 중립",
      Array.from({ length: 40 }, (_, i) =>
        geniusMotionClipFor("ack", i, { motion: null, motionIntent: "excited" }))
        .every((c) => c === "swing"));
    check("쿨다운 승인: intent 와 granted 가 같으면 그 감정 클립",
      geniusMotionClipFor("ack", 7, { motion: "headspin", motionIntent: "headspin" }) === "headspin" &&
      geniusMotionClipFor("ack", 7, { motion: "excited", motionIntent: "excited" }) === "excited");
    // 쿨다운 거절 시 **모든 의미가 같은 중립**으로 내려간다 — 오해되는 다른 감정으로
    // 바뀌지 않는 것이 계약이고, 의미를 구분해 보이는 것은 계약이 아니다.
    check("쿨다운 거절: 전 의미가 동일한 중립 클립으로 수렴(오해 유발 감정 0)",
      new Set((["excited", "headspin", "bored"] as const).map((m) =>
        geniusMotionClipFor("ack", 11, { motion: null, motionIntent: m }))).size === 1);
    // intent 가 없는 legacy payload 도 죽지 않는다.
    check("쿨다운 거절: intent 없는 legacy ack 도 중립으로 살아있다",
      geniusMotionClipFor("ack", 5, { motion: null }) === "swing");

    // 🔴 **정직한 한계 기록**: 삼순 보완(전 의미 공통 중립)을 적용하고 나면, 서버가
    //    실제로 만들어내는 조합(reply_kind=ack + motion) 에서는 intent 를 빼도 결과가
    //    같다 — ack 는 intent 가 없으면 어차피 중립이기 때문이다. 즉 intent 의 값은
    //    ①payload 관측(어떤 의미였는지 원장에 남는다)과 ②아래 방어 경로에 있다.
    //    전수 대조 실측: intent 유무로 클립이 달라지는 조합 24건, 전부 비-ack 경로다.
    check("방어: reply_kind 가 answer/legacy 여도 intent 가 있으면 감정 억제를 따른다",
      geniusMotionClipFor("answer", 3, { motion: null, motionIntent: "excited" }) === "swing" &&
      geniusMotionClipFor(null, 3, { motion: null, motionIntent: "headspin" }) === "swing",
      "서버 배선이 바뀌어 answer 경로에 의미가 실려도 응원/시드 교대로 새면 안 된다");
    check("방어: intent 와 granted 가 **다르면** 감정 클립을 쓰지 않는다(불일치 = 미승인)",
      geniusMotionClipFor("ack", 3, { motion: "excited", motionIntent: "headspin" }) === "swing");

    // 서버가 실제로 두 값을 **모두** 싣는지 — 하나라도 빠지면 위 계약이 허공이다.
    check("서버가 motion(부여)과 motionIntent(의미)를 둘 다 payload 에 싣는다",
      /composeGeniusReplyPayload\(\s*\{ \.\.\.result, motion, motionIntent: candidateMotion, answerTeamId, answerPlayerRole \}/
        .test(serverSrc),
      "쿨다운이 거절하면 의미가 사라진다");
    check("payload 계약에 motion_intent 칸이 있다",
      /motion_intent\?: GeniusMascotMotion;/.test(constantsSrc));

    // ── 응원 7종 = 최애팀 결속 (하린아빠 2026-08-16 14:09 · 삼순 #1228 P0) ────
    // "응원세트는 최애팀 관련 답변 이후에 랜덤으로 노출". 응원은 장식이 아니라
    // "이 답변이 당신 팀 얘기다"라는 신호이므로, 그 전제가 증명될 때만 붙어야 한다.
    const MY = 1; // LG
    const cheers = new Set(Array.from({ length: 80 }, (_, i) =>
      geniusMotionClipFor("answer", i, { answerTeamId: MY, favoriteTeamId: MY })));
    check("응원: 최애팀 답변이면 응원 7종이 순환한다",
      cheers.size === 7 && [...cheers].every((c) => c.startsWith("cheer")),
      [...cheers].join(","));
    // fail-close 4축 — 하나라도 뚫리면 엉뚱한 답변에 응원이 붙는다.
    const notCheer = (label: string, teams: Parameters<typeof geniusMotionClipFor>[2]) => {
      const got = new Set(Array.from({ length: 40 }, (_, i) => geniusMotionClipFor("answer", i, teams)));
      return { label, ok: [...got].every((c) => c === "swing" || c === "pitching"), got: [...got].join(",") };
    };
    for (const t of [
      notCheer("다른 팀 답변", { answerTeamId: 2, favoriteTeamId: MY }),
      notCheer("최애팀 미설정", { answerTeamId: MY, favoriteTeamId: null }),
      notCheer("구단 미특정 답변", { answerTeamId: null, favoriteTeamId: MY }),
      notCheer("둘 다 없음(legacy)", undefined),
    ]) {
      check(`응원 fail-close: ${t.label} → 야구 동작`, t.ok, t.got);
    }
    // 거절·되묻기에는 팀이 맞아도 응원이 붙으면 안 된다 — 신호가 뒤집힌다.
    check("응원 fail-close: 답하지 못함/되묻기는 팀이 맞아도 응원 아님",
      geniusMotionClipFor("unavailable", 3, { answerTeamId: MY, favoriteTeamId: MY }) === "bored" &&
      geniusMotionClipFor("picker", 3, { answerTeamId: MY, favoriteTeamId: MY }) === "thinking");
    // 결정론 — 같은 메시지는 reload·재진입에도 같은 응원이 나온다.
    check("응원: 같은 messageId 면 항상 같은 클립(reload 동일성)",
      Array.from({ length: 30 }, (_, i) =>
        geniusMotionClipFor("answer", i, { answerTeamId: MY, favoriteTeamId: MY }) ===
        geniusMotionClipFor("answer", i, { answerTeamId: MY, favoriteTeamId: MY })).every(Boolean));
    // 유효하지 않은 id 는 전부 자격 없음.
    const invalid = [0, -1, NaN, 1.5, 999, 11, undefined, null];
    check("응원 fail-close: 유효하지 않은 팀 id 는 자격 없음(한쪽만 잘못돼도)",
      invalid.every((v) =>
        !isFavoriteTeamAnswer(v as number, MY) && !isFavoriteTeamAnswer(MY, v as number)),
      invalid.join(","));
    // 🔴 **두 값이 똑같이 잘못된 경우**가 진짜 함정이다 (M23 이 검출).
    //    동등 비교만 하면 `0 === 0`·`999 === 999` 가 통과해 존재하지 않는 팀에
    //    응원이 붙는다. 실존 구단 id 인지를 **먼저** 봐야 닫힌다.
    check("응원 fail-close: 두 값이 **똑같이** 잘못돼도 자격 없음(0/0 · 999/999)",
      invalid.every((v) => !isFavoriteTeamAnswer(v as number, v as number)),
      invalid.map((v) => `${String(v)}/${String(v)}`).join(","));
    check("응원 fail-close: 실존 구단 id 만 통과한다(1~10 밖은 거부)",
      [1, 10].every((id) => isRealTeamId(id)) &&
      [0, 11, 999, -1, 1.5, NaN].every((id) => !isRealTeamId(id)));
    // 같은 잘못된 값으로도 응원 클립이 나오면 안 된다 — 종단까지 확인한다.
    check("응원 fail-close: 잘못된 id 쌍으로는 응원 클립이 재생되지 않는다",
      invalid.every((v) => {
        const clip = geniusMotionClipFor("answer", 3, { answerTeamId: v as number, favoriteTeamId: v as number });
        return clip === "swing" || clip === "pitching";
      }));
    // legacy(payload 없는 과거 답변)도 멈춰 있으면 안 된다 — 종전 idle 정지 폴백 대체.
    check("클립 선택: legacy(null/undefined) 도 야구 동작으로 살아있다",
      [null, undefined].every((k) => ["swing", "pitching"].includes(geniusMotionClipFor(k, 9))));
    // 13종 중 하나라도 도달 불가하면 만들어 놓고 안 쓰는 자산이 생긴다.
    const reachable = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      for (const k of ["answer", "ack", "picker", "correction", "unavailable"] as const) {
        reachable.add(geniusMotionClipFor(k, i));
        // 최애팀 답변 경로 — 응원 7종은 이 경로로만 도달한다.
        reachable.add(geniusMotionClipFor(k, i, { answerTeamId: 1, favoriteTeamId: 1 }));
        // §7.6 의미 모션 경로 — headspin 은 이 경로로만 도달한다.
        for (const m of ["excited", "headspin", "bored"] as const) {
          reachable.add(geniusMotionClipFor(k, i, { motion: m }));
        }
      }
    }
    const unreachable = GENIUS_MOTION_CLIPS.filter((c) => !reachable.has(c));
    check(`도달성: 13종 전부 실제로 재생된다(사장 자산 0)`,
      unreachable.length === 0, unreachable.join(","));
  }

  // ── 사용처 복제 차단 + 종전 CSS/PNG 경로 완전 제거 ─────────────────────
  const pageSrc = readFileSync(resolve(process.cwd(), "src/app/(main)/messages/[conversationId]/page.tsx"), "utf8");
  const typingSrc = readFileSync(resolve(process.cwd(), "src/components/dm/GeniusTypingIndicator.tsx"), "utf8");
  const mascotSrc = readFileSync(resolve(process.cwd(), "src/components/dm/GeniusMascotImage.tsx"), "utf8");
  check("단일 지점: 답변·생각중·실패 마스코트가 공유 컴포넌트를 쓴다",
    /<GeniusMascotImage\b/.test(pageSrc) &&
    (typingSrc.match(/<GeniusMascotImage\b/g) ?? []).length === 2);
  check("단일 지점: 사용처에 마스코트 크기 클래스가 복제되지 않는다",
    !/h-8 w-auto/.test(pageSrc) && !/h-8 w-auto/.test(typingSrc) &&
    !/h-24 w-auto/.test(typingSrc));
  check("공유 컴포넌트가 규격·클립 선택 상수를 그대로 소비한다(리터럴 재작성 아님)",
    mascotSrc.includes("GENIUS_MASCOT_IMG_CLASS") &&
    mascotSrc.includes("geniusMotionClipFor") &&
    mascotSrc.includes("geniusMotionSrc"));

  // reduced-motion 은 CSS 로 못 멈춘다 — 자산 교체(<source media>)여야 한다.
  check("reduced-motion: CSS 가 아니라 poster 자산 교체로 멈춘다",
    /<source[\s\S]{0,120}?media="\(prefers-reduced-motion: reduce\)"/.test(mascotSrc) &&
    mascotSrc.includes("geniusMotionPosterSrc"));

  // 종전 구조(정적 PNG + CSS transform)는 **전량 폐기**다(하린아빠 13:48).
  // 클래스만 남기고 keyframes 를 지우는 부분 정리는 "붙는데 아무 일도 안 나는" 조용한
  // 무효화라 더 나쁘다 — 양쪽 모두 없음을 확인한다.
  const css = readFileSync(resolve(process.cwd(), "src/styles/globals.css"), "utf8");
  check("폐기: CSS 마스코트 모션(idle·excited·headspin·bored) 가 전량 사라졌다",
    !/genius-motion-(idle|excited|headspin|bored)/.test(css));
  check("폐기: 사용처·공유컴포넌트에도 종전 CSS 모션 클래스 잔존 0",
    !/genius-motion-(idle|excited|headspin|bored)/.test(pageSrc) &&
    !/genius-motion-(idle|excited|headspin|bored)/.test(typingSrc) &&
    !/genius-motion-(idle|excited|headspin|bored)/.test(mascotSrc));
  check("폐기: 정적 PNG 마스코트(reply/yajalal-*.png) 를 대화창에서 더 쓰지 않는다",
    !mascotSrc.includes("geniusMascotSrc") && !/mascot\/reply\//.test(mascotSrc));
}

async function main() {
  await partMapping();
  await partPayload();
  await partRenderContract();
  await partDom();
  if (failures.length > 0) {
    console.error(`\n❌ genius mascot motion FAIL: ${failures.length}건 — ${failures.join(" | ")}`);
    process.exit(1);
  }
  console.log(`\n✅ genius mascot motion: ${pass} PASS (매핑 SSOT + 단일 지점 배선 + 폐쇄집합 + 전체 마스코트 ≤1 DOM)`);
  process.exit(0);
}

void main().catch((error) => { console.error("❌ genius mascot motion FAIL:", error); process.exit(1); });
