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
    answerQuestion, isGreetingPhrase, isAckPhrase, isScopeAskPhrase, geniusMotionForResult,
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
    /composeGeniusReplyPayload\(\s*\{ \.\.\.result, motion \}/.test(serverSrc));
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
      // ack(인사) → 긍정반응 9종 순환. 어느 클립인지는 (reply_kind, messageId) 결정론.
      assert.equal(clipOf(container, 150), geniusMotionClipFor("ack", 150),
        "초기 로드: 인사 답변에 결정론 클립");
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
      assert.equal(clipOf(container, 250), geniusMotionClipFor("ack", 250));
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
      assert.equal(clipOf(container, 250), geniusMotionClipFor("ack", 250), "역순 도착에도 최신 소유권 유지");
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

    // failed — 같은 질문의 재시도 버블이 소유권을 가진다(생각중 말풍선 마스코트는 숨는다).
    const stored = JSON.parse(dom.window.localStorage.getItem(BASEBALL_QA_OUTBOX_KEY) ?? "[]") as Array<Record<string, unknown>>;
    for (const entry of stored) {
      if (entry.messageId === 501) { entry.attempts = BASEBALL_QA_MAX_ATTEMPTS; entry.acknowledged = false; }
    }
    dom.window.localStorage.setItem(BASEBALL_QA_OUTBOX_KEY, JSON.stringify(stored));
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event("online")); });
    await waitFor(() => {
      assert.equal(failedMascots(container), 1, "failed 재시도 버블이 마스코트를 소유한다");
      assert.equal(thinkingMascots(container), 0, "같은 질문의 생각중 마스코트는 숨는다(문장은 유지)");
      assert.ok(container.querySelector('[data-testid="genius-thinking-bubble"]'), "생각중 문장 기록은 남는다");
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

    // 답변 도착 → reply 가 소유권을 되찾고 모션이 입혀진다.
    await act(async () => {
      await deliver({
        id: 650, conversation_id: CONVERSATION_ID, sender_id: GENIUS_ID, content: "도움이 됐다니 기쁩니다.",
        is_read: false, created_at: "2026-08-15T00:00:16Z", dedup_key: "baseball-genius:601",
        payload: { type: "baseball_genius_reply", reply_kind: "ack", match_path: "ack", question_message_id: 601, motion: "headspin" },
      });
    });
    await waitFor(() => {
      assert.equal(clipOf(container, 650), geniusMotionClipFor("ack", 650), "답변 도착 → reply 소유권 복귀 + 클립");
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
    GENIUS_MOTION_CLIPS, geniusMotionClipFor, geniusMotionSrc, geniusMotionPosterSrc,
  } = await import("../../src/lib/constants/baseball-genius");

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

  // ── 클립 선택 = 결정론 + 13종 전수 도달성 ──────────────────────────
  check("클립 선택은 결정론이다(같은 입력 → 같은 출력)",
    [0, 1, 7, 42, 12345].every((id) =>
      geniusMotionClipFor("answer", id) === geniusMotionClipFor("answer", id) &&
      geniusMotionClipFor("ack", id) === geniusMotionClipFor("ack", id)));
  check("클립 선택: 되묻기(picker/correction) → thinking",
    geniusMotionClipFor("picker", 3) === "thinking" && geniusMotionClipFor("correction", 8) === "thinking");
  check("클립 선택: 답하지 못함(unavailable) → bored",
    geniusMotionClipFor("unavailable", 5) === "bored");
  {
    const answers = new Set(Array.from({ length: 40 }, (_, i) => geniusMotionClipFor("answer", i)));
    check("클립 선택: 정상답변은 야구 동작 2종 교대(같은 동작 반복 없음)",
      answers.size === 2 && [...answers].every((c) => c === "swing" || c === "pitching"),
      [...answers].join(","));
    const acks = new Set(Array.from({ length: 60 }, (_, i) => geniusMotionClipFor("ack", i)));
    check("클립 선택: 긍정반응은 응원 7종 포함 9종 순환", acks.size === 9, [...acks].join(","));
    // legacy(payload 없는 과거 답변)도 멈춰 있으면 안 된다 — 종전 idle 정지 폴백 대체.
    check("클립 선택: legacy(null/undefined) 도 야구 동작으로 살아있다",
      [null, undefined].every((k) => ["swing", "pitching"].includes(geniusMotionClipFor(k, 9))));
    // 13종 중 하나라도 도달 불가하면 만들어 놓고 안 쓰는 자산이 생긴다.
    const reachable = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      for (const k of ["answer", "ack", "picker", "correction", "unavailable"] as const) {
        reachable.add(geniusMotionClipFor(k, i));
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
