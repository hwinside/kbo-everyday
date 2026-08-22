/**
 * 공용 발송 경계 가드 — 실유저 공간 write 영구 차단 (fail-close).
 *
 * 배경: 2026-08-21 #1274 p95 실측 하니스가 라이브 경기 방 2곳에 QA 메시지를
 * 노출시킨 사고. realtime 은 insert 전파 순간 노출이 확정되므로 사후 삭제로
 * 되돌릴 수 없다. 따라서 "발송 전에 죽는 것"만이 유일한 방어다.
 *
 * 계약 (삼순 리뷰 2026-08-21/22):
 *   1. Production Supabase project ref 면 경기 날짜와 무관하게 즉시 RED.
 *      (종료된 과거 경기방도 허용하지 않는다 — 유저가 볼 수 있는 방은 전부 금지.)
 *   2. 허용은 staging project ref allowlist AND 비공개 fixture room 패턴이
 *      둘 다 맞을 때만.
 *   3. 우회 플래그 0. 환경변수·인자로 가드를 끌 수 있는 경로를 두지 않는다.
 *   4. 판정 불능(ref 파싱 실패 등)은 통과가 아니라 즉시 중단.
 *   5. hostname 은 URL 파서 + 전체 일치로만 판정한다 — `abc.supabase.co.evil`
 *      같은 suffix 위장 호스트는 ref 로 인정하지 않는다(REF_UNRESOLVED).
 *
 * 구조: 판정은 순수 evaluator `evaluateSend()` 가 reason code 로 반환하고,
 * 런타임 진입점 `assertSendAllowed()` 는 frozen 상수만 써서 exit 한다 —
 * 테스트용 주입 seam(opts.stagingRefs)은 런타임 진입점에 노출되지 않는다.
 */

// 크보팬 Production project ref — 영구 차단 목록. 절대 allowlist 로 옮기지 않는다.
const PRODUCTION_PROJECT_REFS = Object.freeze(["lbmbdjgsnenqjwjotoei"]);

// 격리 staging project ref allowlist — keubo-qa-staging (2026-08-22 신설, 실유저 0,
// Production 과 조직 내 별개 프로젝트). 등재 커밋은 삼순 리뷰 대상이라는 계약에 따라
// 이 변경 자체가 리뷰 라인에 올라간다. Production ref 는 절대 여기 못 들어온다
// (PRODUCTION_PROJECT_REFS 차단이 allowlist 보다 먼저 평가된다).
const STAGING_PROJECT_REFS = Object.freeze(["kygfpcvtszkwdxdspjnv"]);

// 비공개 fixture room 만 허용. 실제 경기 방(`game:<gameId>`) 은 패턴상 매치되지 않는다.
const PRIVATE_FIXTURE_ROOM = /^qa-fixture:[a-z0-9-]{4,}$/;

/** 판정 사유 코드 — 각 RED 축이 독립적으로 식별된다. */
export const REASONS = Object.freeze({
  OK: "OK",
  REF_UNRESOLVED: "REF_UNRESOLVED",
  PRODUCTION_REF: "PRODUCTION_REF",
  REF_NOT_ALLOWLISTED: "REF_NOT_ALLOWLISTED",
  ROOM_MISSING: "ROOM_MISSING",
  ROOM_NOT_FIXTURE: "ROOM_NOT_FIXTURE",
});

/** strict hostname 파싱 — https + hostname 전체 일치만 인정. */
export function projectRefOf(supabaseUrl) {
  let u;
  try {
    u = new URL(String(supabaseUrl ?? ""));
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const m = u.hostname.match(/^([a-z0-9]+)\.supabase\.(co|in)$/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * 순수 evaluator — 부수효과 0. 판정 순서: ref 불명 → production → allowlist
 * 미등재 → room 누락 → fixture 불일치.
 * @param {{supabaseUrl?: string, roomId?: string}} ctx
 * @param {{stagingRefs?: readonly string[]}} [opts] 테스트 전용 주입 seam.
 * @returns {{allowed: boolean, reason: string, detail: string}}
 */
export function evaluateSend(ctx = {}, opts = {}) {
  const { supabaseUrl, roomId } = ctx;
  const stagingRefs = opts.stagingRefs ?? STAGING_PROJECT_REFS;

  const ref = projectRefOf(supabaseUrl);
  if (!ref) {
    return {
      allowed: false,
      reason: REASONS.REF_UNRESOLVED,
      detail: `Supabase project ref 판정 불능 (url=${supabaseUrl ? "set" : "unset"}) — 판정할 수 없으면 통과가 아니라 중단이다.`,
    };
  }
  if (PRODUCTION_PROJECT_REFS.includes(ref)) {
    return {
      allowed: false,
      reason: REASONS.PRODUCTION_REF,
      detail: `Production project ref '${ref}' — 유저가 볼 수 있는 모든 방(라이브·종료 경기방 포함)에 발송형 QA 영구 금지. realtime 은 insert 순간 노출 확정, 사후 삭제로 되돌릴 수 없다.`,
    };
  }
  if (!stagingRefs.includes(ref)) {
    return {
      allowed: false,
      reason: REASONS.REF_NOT_ALLOWLISTED,
      detail:
        `project ref '${ref}' 는 staging allowlist 에 없다. ` +
        (stagingRefs.length === 0
          ? "현재 allowlist 는 비어 있다 = 발송형 QA 는 실행 불가 상태(의도됨)."
          : `등재된 staging: ${stagingRefs.join(", ")}`),
    };
  }
  if (!roomId) {
    return {
      allowed: false,
      reason: REASONS.ROOM_MISSING,
      detail: "roomId 누락 — 발송 대상 room 이 특정되지 않으면 중단.",
    };
  }
  if (!PRIVATE_FIXTURE_ROOM.test(roomId)) {
    return {
      allowed: false,
      reason: REASONS.ROOM_NOT_FIXTURE,
      detail: `room '${roomId}' 은 비공개 fixture 가 아니다. 허용 패턴: qa-fixture:<slug> (실제 경기 방 'game:*' 은 영구 불가)`,
    };
  }
  return { allowed: true, reason: REASONS.OK, detail: `staging ref='${ref}', fixture room='${roomId}'` };
}

/**
 * 발송형 QA 의 유일한 런타임 진입 관문. 어떤 write 보다 먼저 호출한다.
 * allowlist 주입 경로 없음 — frozen 상수만 사용(우회 0).
 */
export function assertSendAllowed(ctx = {}) {
  const { supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL, roomId, purpose = "send-type QA" } = ctx;
  const verdict = evaluateSend({ supabaseUrl, roomId });
  if (!verdict.allowed) {
    console.error(`[SEND GUARD] RED ${verdict.reason} — ${purpose} 중단.`);
    console.error(`[SEND GUARD] ${verdict.detail}`);
    console.error(`[SEND GUARD] 격리 staging project + 비공개 fixture room 에서만 실행하라. 우회 플래그는 없다.`);
    process.exit(3);
  }
  console.log(`[SEND GUARD] OK — ${verdict.detail}`);
}

/**
 * 자기검증 케이스 — GREEN 1(주입 staging + qa-fixture) + RED 축별 정확한
 * reason code 독립 검증. 런타임 allowlist(STAGING_PROJECT_REFS)는 계속 빈 상태.
 */
export function selftestCases() {
  const injected = Object.freeze(["qastaginginjected"]);
  return [
    { name: "GREEN: 주입 staging + 비공개 fixture", ctx: { supabaseUrl: "https://qastaginginjected.supabase.co", roomId: "qa-fixture:abcd" }, opts: { stagingRefs: injected }, expect: REASONS.OK },
    { name: "RED: production ref (fixture room 이어도 차단)", ctx: { supabaseUrl: "https://lbmbdjgsnenqjwjotoei.supabase.co", roomId: "qa-fixture:abcd" }, opts: { stagingRefs: injected }, expect: REASONS.PRODUCTION_REF },
    { name: "RED: production ref + 과거 경기방", ctx: { supabaseUrl: "https://lbmbdjgsnenqjwjotoei.supabase.co", roomId: "game:20260101LGHH0" }, opts: { stagingRefs: injected }, expect: REASONS.PRODUCTION_REF },
    { name: "RED: suffix 위장 호스트 (supabase.co.evil)", ctx: { supabaseUrl: "https://lbmbdjgsnenqjwjotoei.supabase.co.evil", roomId: "qa-fixture:abcd" }, opts: { stagingRefs: injected }, expect: REASONS.REF_UNRESOLVED },
    { name: "RED: 위장 서브도메인 (evil.example 하위)", ctx: { supabaseUrl: "https://x.supabase.co.attacker.example", roomId: "qa-fixture:abcd" }, opts: { stagingRefs: injected }, expect: REASONS.REF_UNRESOLVED },
    { name: "RED: allowlist 미등재 ref", ctx: { supabaseUrl: "https://someotherproject.supabase.co", roomId: "qa-fixture:abcd" }, opts: { stagingRefs: injected }, expect: REASONS.REF_NOT_ALLOWLISTED },
    { name: "RED: ref 판정 불능 (localhost)", ctx: { supabaseUrl: "http://localhost:54321", roomId: "qa-fixture:abcd" }, opts: { stagingRefs: injected }, expect: REASONS.REF_UNRESOLVED },
    { name: "RED: 실제 경기방 (staging 이어도 차단)", ctx: { supabaseUrl: "https://qastaginginjected.supabase.co", roomId: "game:20260821LGHH0" }, opts: { stagingRefs: injected }, expect: REASONS.ROOM_NOT_FIXTURE },
    { name: "RED: room 누락", ctx: { supabaseUrl: "https://qastaginginjected.supabase.co", roomId: undefined }, opts: { stagingRefs: injected }, expect: REASONS.ROOM_MISSING },
    { name: "RED: 런타임 allowlist 는 빈 상태 (주입 없으면 staging URL 도 차단)", ctx: { supabaseUrl: "https://qastaginginjected.supabase.co", roomId: "qa-fixture:abcd" }, opts: {}, expect: REASONS.REF_NOT_ALLOWLISTED },
  ];
}

/* ── 실제 write target 단일 결속 (삼순 9차) ──────────────────────────────
 * guard 가 승인한 room 과 브라우저가 실제로 write 하는 room 이 분리될 수 있던
 * 간극(guard/query/cleanup 은 QA_FIXTURE_ROOM, GameChat 은 game:${gameId})을
 * 네트워크 경계에서 닫는다: chat_messages POST 의 body.room_id 가 guarded room 과
 * 정확히 일치하지 않으면 요청 자체를 abort 한다(fail-close).
 */

export const WRITE_REASONS = Object.freeze({
  OK: "OK",
  GUARD_ROOM_MISSING: "GUARD_ROOM_MISSING", // 결속할 guarded room 자체가 없음
  BODY_ROOM_UNRESOLVED: "BODY_ROOM_UNRESOLVED", // POST body 에서 room_id 판정 불능
  WRITE_TARGET_MISMATCH: "WRITE_TARGET_MISMATCH", // 실제 write room ≠ guarded room
  GUARD_REF_MISSING: "GUARD_REF_MISSING", // 결속할 expected staging ref 자체가 없음
  URL_REF_UNRESOLVED: "URL_REF_UNRESOLVED", // 요청 URL 에서 project ref 판정 불능
  PRODUCTION_WRITE_TARGET: "PRODUCTION_WRITE_TARGET", // 요청이 Production ref 로 향함
  REF_MISMATCH: "REF_MISMATCH", // 요청 ref ≠ expected staging ref
});

/**
 * 순수 evaluator — 부수효과 0. 두 축을 모두 요구한다(삼순 10차):
 *   room 축: body.room_id == guarded room 완전 일치
 *   ref 축: 요청 URL 의 project ref == expected staging ref 완전 일치
 *           (staging env + production page + qa-fixture body 조합의
 *            Production POST 통과 경로를 차단 — production ref 는 별도 사유로 RED)
 */
export function evaluateChatWrite(bodyRoomId, guardedRoomId, requestUrl = undefined, expectedRef = undefined) {
  if (!guardedRoomId) {
    return { allowed: false, reason: WRITE_REASONS.GUARD_ROOM_MISSING, detail: "guarded room 부재 — 결속 대상이 없으면 모든 write 차단." };
  }
  if (requestUrl !== undefined || expectedRef !== undefined) {
    if (!expectedRef) {
      return { allowed: false, reason: WRITE_REASONS.GUARD_REF_MISSING, detail: "expected staging ref 부재 — ref 결속 대상이 없으면 모든 write 차단." };
    }
    const urlRef = projectRefOf(requestUrl);
    if (!urlRef) {
      return { allowed: false, reason: WRITE_REASONS.URL_REF_UNRESOLVED, detail: `요청 URL 의 project ref 판정 불능 (url=${requestUrl ? "set" : "unset"}) — 차단.` };
    }
    if (PRODUCTION_PROJECT_REFS.includes(urlRef)) {
      return { allowed: false, reason: WRITE_REASONS.PRODUCTION_WRITE_TARGET, detail: `요청이 Production ref '${urlRef}' 로 향한다 — 영구 차단.` };
    }
    if (urlRef !== expectedRef) {
      return { allowed: false, reason: WRITE_REASONS.REF_MISMATCH, detail: `요청 ref '${urlRef}' ≠ expected staging ref '${expectedRef}' — 단일 결속 위반.` };
    }
  }
  if (typeof bodyRoomId !== "string" || bodyRoomId.length === 0) {
    return { allowed: false, reason: WRITE_REASONS.BODY_ROOM_UNRESOLVED, detail: "write body 의 room_id 판정 불능 — 판정할 수 없으면 차단." };
  }
  if (bodyRoomId !== guardedRoomId) {
    return { allowed: false, reason: WRITE_REASONS.WRITE_TARGET_MISMATCH, detail: `write room '${bodyRoomId}' ≠ guarded room '${guardedRoomId}' — 단일 결속 위반.` };
  }
  return { allowed: true, reason: WRITE_REASONS.OK, detail: `write room == guarded room '${guardedRoomId}'` };
}

/** POST body(단건 객체 또는 배열)에서 room_id 를 추출한다. 판정 불능은 null. */
export function roomIdOfChatInsertBody(postData) {
  try {
    const body = JSON.parse(postData ?? "null");
    if (Array.isArray(body)) {
      const rooms = [...new Set(body.map((r) => r?.room_id))];
      return rooms.length === 1 && typeof rooms[0] === "string" ? rooms[0] : null;
    }
    return typeof body?.room_id === "string" ? body.room_id : null;
  } catch {
    return null;
  }
}

/**
 * Playwright BrowserContext 에 chat_messages write 인터셉터를 설치한다.
 * 발송형 하니스는 컨텍스트 생성 직후 반드시 호출한다 — 이것이 guard 승인 room 과
 * 실제 브라우저 write 를 잇는 유일한 결속점이다.
 */
export async function installChatWriteInterceptor(context, guardedRoomId, onBlocked = null, expectedRef = undefined) {
  // expectedRef 미지정 시 assertSendAllowed 와 동일한 env 에서 유도한다 — 단, 유도
  // 실패(null)여도 ref 축은 GUARD_REF_MISSING 으로 fail-close 된다(우회 아님).
  const boundRef = expectedRef ?? projectRefOf(process.env.NEXT_PUBLIC_SUPABASE_URL);
  await context.route("**/rest/v1/chat_messages*", (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.continue();
    const bodyRoom = roomIdOfChatInsertBody(req.postData());
    const v = evaluateChatWrite(bodyRoom, guardedRoomId, req.url(), boundRef);
    if (!v.allowed) {
      console.error(`[SEND GUARD] chat write ABORT ${v.reason} — ${v.detail}`);
      if (onBlocked) onBlocked({ reason: v.reason, bodyRoom });
      return route.abort("blockedbyclient");
    }
    // 허용 경로는 fallback 으로 체인한다 — 뒤에 등록된 다른 route(테스트 mock 포함)를
    // 건너뛰지 않고, 남은 핸들러가 없으면 네트워크로 간다(실사용 동작 동일).
    // continue() 는 mock 을 우회해 GREEN 증거를 네트워크 실패와 구분 불가하게 만든다.
    return route.fallback();
  });
}

/**
 * 하니스측 fixture 라우팅 (앱 코드 무변경 — `chat transport untouched` 계약 유지).
 * 브라우저가 실경기방(`game:*`)으로 보내는 chat insert 의 body.room_id 를 격리 fixture
 * room 으로 재작성한다. 반드시 installChatWriteInterceptor **뒤에** 설치해야 한다:
 * Playwright 는 마지막 등록 핸들러부터 실행하므로 rewrite 가 먼저 돌고, fallback 으로
 * 넘어간 guard 가 **재작성된 최종 body** 를 검증한다(= 실제 write target 을 검증).
 */
export async function installFixtureRoomRewrite(context, fixtureRoom) {
  if (!/^qa-fixture:[a-z0-9-]{4,}$/.test(String(fixtureRoom ?? ""))) {
    throw new Error(`[SEND GUARD] fixture room 패턴 위반: ${fixtureRoom}`);
  }
  await context.route("**/rest/v1/chat_messages*", (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.fallback();
    let body;
    try { body = JSON.parse(req.postData() ?? "null"); } catch { return route.fallback(); }
    const rewrite = (r) => (r && typeof r === "object" ? { ...r, room_id: fixtureRoom } : r);
    const next = Array.isArray(body) ? body.map(rewrite) : rewrite(body);
    return route.fallback({ postData: JSON.stringify(next) });
  });
}
