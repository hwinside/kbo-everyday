/**
 * DM Realtime 폴링 폴백 컨트롤러 + 메시지 merge 순수 로직 스모크.
 * 2026-07-28 Realtime 구독풀 타임아웃 동안 DM/안읽음 무증상 유실 방지(슬라이스2) 회귀 고정.
 *
 * 실행: npx tsx scripts/qa/polling-fallback-smoke.ts
 */
import { createPollingFallback } from "../../src/lib/supabase/polling-fallback";
import { mergeDmMessagesById, type DMMessage } from "../../src/lib/supabase/dm-messages";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; }
  else { fail++; console.error(`  ✗ ${name}`); }
}

// ── 폴링 컨트롤러: 주입된 timer/visibility 로 결정론 검증 ──
type FakeTimer = { cb: () => void; cleared: boolean };

function makeHarness(initialVisible = true) {
  const timers: FakeTimer[] = [];
  let visible = initialVisible;
  let loads = 0;
  const controller = createPollingFallback<FakeTimer>({
    load: () => { loads += 1; },
    intervalMs: 30000,
    setInterval: (cb) => { const t: FakeTimer = { cb, cleared: false }; timers.push(t); return t; },
    clearInterval: (t) => { t.cleared = true; },
    isVisible: () => visible,
  });
  const activeTimers = () => timers.filter((t) => !t.cleared);
  return {
    controller,
    timers,
    activeTimers,
    fireLast: () => activeTimers()[activeTimers().length - 1]?.cb(),
    setVisible: (v: boolean) => { visible = v; },
    loads: () => loads,
  };
}

// 1) 정상 구독(healthy=true) → 폴링 0 (steady-state 부하 없음)
{
  const h = makeHarness();
  h.controller.setEnabled(true);
  h.controller.setHealthy(true);
  check("healthy=true 면 폴링 미가동", h.controller.isPolling() === false && h.activeTimers().length === 0);
}

// 2) enabled + unhealthy + visible → 폴링 가동, 즉시 load 는 없음(주기 대기)
{
  const h = makeHarness();
  h.controller.setEnabled(true);
  h.controller.setHealthy(false);
  check("unhealthy+enabled+visible → 폴링 가동", h.controller.isPolling() === true);
  check("가동 직후 즉시 load 는 없음(mount 중복 방지)", h.loads() === 0);
  h.fireLast();
  check("interval tick 시 load 1회", h.loads() === 1);
}

// 3) 정상→비정상 전이(구독이 죽는 순간) → 즉시 catch-up load 1회 + 폴링 가동
{
  const h = makeHarness();
  h.controller.setEnabled(true);
  h.controller.setHealthy(true);   // 정상
  check("정상 구간 폴링 0", h.controller.isPolling() === false && h.loads() === 0);
  h.controller.setHealthy(false);  // 구독 사망
  check("정상→비정상 즉시 catch-up load", h.loads() === 1);
  check("비정상 전이 후 폴링 가동", h.controller.isPolling() === true);
}

// 4) 비정상→정상 복구 → 폴링 정지(타이머 clear)
{
  const h = makeHarness();
  h.controller.setEnabled(true);
  h.controller.setHealthy(false);
  check("비정상 폴링 가동", h.controller.isPolling() === true);
  h.controller.setHealthy(true);
  check("정상 복구 시 폴링 정지", h.controller.isPolling() === false);
  check("정지 시 타이머 clear", h.timers.every((t) => t.cleared) === true);
}

// 5) 숨김 탭 → 폴링 미가동, interval tick 도 load 안 함
{
  const h = makeHarness(false); // 숨김 상태로 시작
  h.controller.setEnabled(true);
  h.controller.setHealthy(false);
  check("숨김이면 폴링 미가동", h.controller.isPolling() === false && h.loads() === 0);
  // 보이게 되면 catch-up + 가동
  h.setVisible(true);
  h.controller.onVisibilityChange();
  check("복귀 시 즉시 catch-up load", h.loads() === 1);
  check("복귀 시 폴링 가동", h.controller.isPolling() === true);
  // 다시 숨기면 정지
  h.setVisible(false);
  h.controller.onVisibilityChange();
  check("재숨김 시 폴링 정지", h.controller.isPolling() === false);
}

// 6) 가동 중 탭이 숨겨지면 tick 은 load 를 건너뜀(방어)
{
  const h = makeHarness();
  h.controller.setEnabled(true);
  h.controller.setHealthy(false);
  const before = h.loads();
  h.setVisible(false);       // onVisibilityChange 없이 숨김 상태만 바뀐 경우
  h.fireLast();              // 잔여 interval tick
  check("tick 시점 숨김이면 load 스킵", h.loads() === before);
}

// 7) disabled → 폴링 미가동
{
  const h = makeHarness();
  h.controller.setEnabled(false);
  h.controller.setHealthy(false);
  check("disabled 면 폴링 미가동", h.controller.isPolling() === false && h.loads() === 0);
}

// 8) stop() → 타이머 정리
{
  const h = makeHarness();
  h.controller.setEnabled(true);
  h.controller.setHealthy(false);
  check("stop 전 폴링 가동", h.controller.isPolling() === true);
  h.controller.stop();
  check("stop 후 폴링 정지", h.controller.isPolling() === false);
}

// ── 메시지 merge: id 기준 병합 + 대화 leak 방지 ──
function msg(id: number, conv: string, content = `m${id}`): DMMessage {
  return { id, conversation_id: conv, sender_id: "u1", content, is_read: false, created_at: new Date(id * 1000).toISOString() };
}

// 9) 신규 메시지 append + id 정렬
{
  const prev = [msg(1, "c1"), msg(2, "c1")];
  const incoming = [msg(2, "c1"), msg(3, "c1")];
  const merged = mergeDmMessagesById(prev, incoming);
  check("merge: id 오름차순 병합", merged.map((m) => m.id).join(",") === "1,2,3");
}

// 10) 같은 id 는 incoming(DB 최신)으로 갱신(예: is_read)
{
  const prev = [{ ...msg(5, "c1"), is_read: false }];
  const incoming = [{ ...msg(5, "c1"), is_read: true }];
  const merged = mergeDmMessagesById(prev, incoming);
  check("merge: 동일 id 는 incoming 값으로 갱신", merged.length === 1 && merged[0].is_read === true);
}

// 11) 대화 전환 leak 방지: 다른 conversation 의 prev 는 버림
{
  const prev = [msg(1, "OLD"), msg(2, "OLD")];
  const incoming = [msg(9, "NEW")];
  const merged = mergeDmMessagesById(prev, incoming);
  check("merge: 다른 대화 prev 는 leak 안 됨", merged.map((m) => `${m.conversation_id}:${m.id}`).join(",") === "NEW:9");
}

// 12) 낙관 append(prev-only) 보존
{
  const prev = [msg(1, "c1"), msg(2, "c1"), { ...msg(3, "c1"), content: "optimistic" }];
  const incoming = [msg(1, "c1"), msg(2, "c1")]; // 아직 3 미반영된 폴링 스냅샷
  const merged = mergeDmMessagesById(prev, incoming);
  check("merge: prev-only(낙관) 메시지 보존", merged.map((m) => m.id).join(",") === "1,2,3");
}

// 13) incoming 비면 prev 유지(일시적 빈 응답에 화면 안 비움)
{
  const prev = [msg(1, "c1")];
  const merged = mergeDmMessagesById(prev, []);
  check("merge: incoming 비면 prev 유지", merged.length === 1 && merged[0].id === 1);
}

console.log(`\npolling-fallback: ${pass}/${pass + fail} pass${fail ? `, ${fail} FAIL` : ""}`);
if (fail) process.exit(1);
