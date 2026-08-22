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

// 격리 staging project ref allowlist. 현재 비어 있음 = 발송형 QA 실행 불가(의도된 상태).
const STAGING_PROJECT_REFS = Object.freeze([]);

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
