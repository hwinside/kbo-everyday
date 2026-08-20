/**
 * 폴백 delta 버퍼 계약 게이트 — **DB 쓰기 횟수**가 실제로 줄었는지 고정한다.
 *
 * Why
 * ---
 * 2026-08-20 삼순 blocker 1: 1차 설계는 이벤트마다 `UPSERT count+1` 이라 행 수만 줄고
 * 쓰기 횟수·WAL 은 그대로였다. 오히려 같은 행을 계속 갱신해 HOT 이 막히고 hot-row lock 이 생긴다.
 * 그래서 이 게이트가 세는 것은 **행 수가 아니라 flush(=RPC 호출) 횟수**다.
 *
 * ⚠️ 이전 게이트의 `rowCount = DB 쓰기량` 전제가 틀렸다는 지적을 그대로 반영한 것이다.
 *
 * 실행: npx tsx scripts/qa/fallback-buffer-smoke.ts  (npm run qa:fallback-buffer)
 */
import {
  FLUSH_INTERVAL_MS,
  MAX_PENDING_KEYS,
  __resetBufferForTest,
  __setClockForTest,
  ackFallbackFlush,
  fingerprintOf,
  inFlightKeyCountForTest,
  observeFallback,
  pendingKeyCountForTest,
  requeueFallbackFlush,
  takeFallbackBuffer,
  type FallbackDelta,
  type FallbackObservation,
} from "@/lib/monitoring/fallback-buffer";

/**
 * 성공한 flush 1회 = take → ack. 프로덕션 경로와 같은 순서로 태운다.
 *
 * ⚠️ 삼순 2차 blocker 3: 예전 게이트는 flushOk() 하나만 부르고 "보존됨"이라
 *    적었다. take 만으로는 아무것도 확정되지 않는다 — ack 를 부르는 것이 flush 의 성공이다.
 */
function flushOk(): FallbackDelta[] {
  const deltas = takeFallbackBuffer();
  ackFallbackFlush(deltas);
  return deltas;
}

let fail = 0;
function ok(name: string, cond: boolean) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) fail++;
}

let clock = 1_000_000;
__setClockForTest(() => clock);

const POLICY = { windowMinutes: 5, threshold: 3, cooldownMinutes: 30, leaseSeconds: 120 };

function obs(overrides: Partial<FallbackObservation> = {}): FallbackObservation {
  return {
    apiName: "kbo-game-detail",
    reason: "schema-error",
    errorMessage: "20260819HTHH0: bounded game-detail fallback",
    scope: "20260819HTHH0",
    policy: POLICY,
    ...overrides,
  };
}

/** 관측 N건을 흘리며 실제 flush 횟수와 총 delta 합을 센다(= DB 왕복 횟수). */
function simulate(
  observations: FallbackObservation[],
  advanceMsPerObs = 0,
): { flushes: number; totalCounted: number; deltaRows: number } {
  let flushes = 0;
  let totalCounted = 0;
  let deltaRows = 0;
  for (const o of observations) {
    const should = observeFallback(o);
    if (should) {
      const deltas = flushOk();
      if (deltas.length > 0) {
        flushes++;
        deltaRows += deltas.length;
        for (const d of deltas) totalCounted += d.count;
      }
    }
    clock += advanceMsPerObs;
  }
  // 남은 잔여분은 프로세스 종료 시 유실된다 — 여기서는 세지 않는다(정직하게).
  return { flushes, totalCounted, deltaRows };
}

// ── 1) 핵심 계약: 버스트가 쓰기 폭주를 만들지 않는다 ─────────────────────
{
  __resetBufferForTest();
  clock = 1_000_000;
  // 라이브 경기 재현: 같은 gameId·같은 사유 5,000건이 30초 안에 몰린다.
  const burst = Array.from({ length: 5000 }, () => obs());
  const r = simulate(burst, 0); // 시간 정지 = 최악(주기 flush 기회 없음)
  // ⚠️ 삼순 2차 blocker 2 반영으로 계약이 바뀌었다: **임계치까지는 즉시 durable**.
  //    threshold=3 이므로 앞 3건은 각각 즉시 flush 되고, 그 뒤부터 batch 로 모인다.
  //    (임계 3건이 2초 안에 오고 멈추면 경보가 안 나가는 구멍을 없애기 위한 대가다.)
  ok(
    `버스트 5,000건 → RPC 호출은 임계(${POLICY.threshold})회뿐 (실측 ${r.flushes})`,
    r.flushes === POLICY.threshold,
  );
  ok(
    `임계 초과분은 단 1회도 개별 write 하지 않는다 (5000 대비 ${Math.round(5000 / r.flushes)}배 감소)`,
    r.flushes * 100 <= 5000,
  );
  ok("첫 관측은 즉시 나간다(경보 임계 지연 없음)", r.totalCounted >= 1);
  ok(`임계까지 durable 확정 ${POLICY.threshold}건`, r.totalCounted === POLICY.threshold);
  ok(`잔여는 버퍼에 누적 (pending ${pendingKeyCountForTest()})`, pendingKeyCountForTest() === 1);
  // 잔여를 flush 하면 나머지가 1행 1회로 나간다.
  const rest = flushOk();
  ok("잔여 flush 는 1행", rest.length === 1);
  ok(
    `잔여 count 가 ${5000 - POLICY.threshold} (실측 ${rest[0]?.count})`,
    rest[0]?.count === 5000 - POLICY.threshold,
  );
  ok("총 발생 횟수 5,000 보존", r.totalCounted + (rest[0]?.count ?? 0) === 5000);
}

// ── 2) 시간이 흐르면 주기적으로 flush 된다 ────────────────────────────────
{
  __resetBufferForTest();
  clock = 1_000_000;
  // 30초 간격으로 10건 → 첫 1회 + 이후 주기 flush
  const r = simulate(Array.from({ length: 10 }, () => obs()), FLUSH_INTERVAL_MS);
  ok(`30초 간격 10건 → flush 10회 이하 (실측 ${r.flushes})`, r.flushes <= 10);
  ok("주기 flush 가 최소 2회는 발생", r.flushes >= 2);
}
{
  __resetBufferForTest();
  clock = 1_000_000;
  // 1초 간격 300건(5분) → 첫 1회 + 30초마다 ≈ 10회 수준. 300회가 아니어야 한다.
  const r = simulate(Array.from({ length: 300 }, () => obs()), 1_000);
  ok(`1초 간격 300건 → flush ≤ 12회 (실측 ${r.flushes})`, r.flushes <= 12);
  ok("같은 300건을 개별 write 했다면 300회 — 25배 이상 감소", r.flushes * 25 <= 300);
}

// ── 3) 서로 다른 키는 분리 관측된다(뭉개지지 않는다) ─────────────────────
{
  __resetBufferForTest();
  clock = 1_000_000;
  observeFallback(obs({ scope: "gameA" }));
  flushOk();
  observeFallback(obs({ scope: "gameB" }));
  const deltas = flushOk();
  ok("다른 scope 는 별도 delta", deltas.length === 1 && deltas[0].scope === "gameB");
}
{
  __resetBufferForTest();
  clock = 1_000_000;
  observeFallback(obs({ reason: "timeout" }));
  flushOk();
  observeFallback(obs({ reason: "http-error" }));
  const deltas = flushOk();
  ok("다른 reason 은 별도 delta", deltas.length === 1 && deltas[0].reason === "http-error");
}

// ── 4) fingerprint — coarse reason 만으로 뭉개지 않는다 (삼순 blocker 4) ──
{
  ok(
    "같은 형태 다른 gameId 는 같은 지문",
    fingerprintOf("20260819HTHH0: bounded game-detail fallback") ===
      fingerprintOf("20260819SKSS0: bounded game-detail fallback"),
  );
  ok(
    "다른 형태는 다른 지문",
    fingerprintOf("20260819HTHH0: bounded game-detail fallback") !==
      fingerprintOf("upstream returned malformed inning array"),
  );
  ok("null 메시지는 null 지문", fingerprintOf(null) === null);
  ok("숫자만 다른 메시지는 같은 지문", fingerprintOf("failed after 3 retries") === fingerprintOf("failed after 47 retries"));
}
{
  __resetBufferForTest();
  clock = 1_000_000;
  // ⚠️ 관측 가능성: 중간에 drain 하면 버퍼가 비어 "뜽금지는가"를 볼 수 없다(무조건 별도 행).
  //    fingerprint 계약은 **같은 버퍼 안에 둘이 공존할 때**만 관측된다.
  //    같은 api·reason·scope 인데 서로 다른 오류 → delta 2개여야 한다.
  observeFallback(obs({ errorMessage: "connection reset by peer" }));
  observeFallback(obs({ errorMessage: "malformed inning array" }));
  const deltas = flushOk();
  ok("같은 reason·scope 라도 다른 오류는 별도 delta 2개", deltas.length === 2);
  const prints = deltas.map((d) => d.fingerprint).sort();
  const expected = [
    fingerprintOf("connection reset by peer"),
    fingerprintOf("malformed inning array"),
  ].sort();
  ok("두 지문이 각각 보존됨", JSON.stringify(prints) === JSON.stringify(expected));
  ok(
    "메시지도 각각 보존됨(마지막 것으로 덮이지 않음)",
    deltas.some((d) => d.error_message === "connection reset by peer") &&
      deltas.some((d) => d.error_message === "malformed inning array"),
  );
}
{
  __resetBufferForTest();
  clock = 1_000_000;
  // 반대 방향: 같은 지문(gameId 만 다름)은 하나로 묶여야 한다 — 이게 증폭 차단의 본체다.
  observeFallback(obs({ errorMessage: "20260819HTHH0: bounded game-detail fallback" }));
  observeFallback(obs({ errorMessage: "20260819SKSS0: bounded game-detail fallback" }));
  const deltas = flushOk();
  ok("같은 지문·같은 scope 는 1개 delta 로 합산", deltas.length === 1 && deltas[0].count === 2);
}

// ── 5) 버퍼 폭주 방어 ────────────────────────────────────────────────────
{
  __resetBufferForTest();
  clock = 1_000_000;
  const keyCount = MAX_PENDING_KEYS + 50;

  // ⚠️ 관측 가능성: 상한 분기는 앞선 두 분기(임계 즉시 durable, 신규 키)가 먼저 true 를
  //    돌려주면 **원리적으로 도달 불가**하다(훼손해도 결과가 같다).
  //    → threshold=1 정책으로 "이미 durable 확정된 키가 주기 안에 다시 쌓이는" 무대를 만든다.
  const capPolicy = { windowMinutes: 5, threshold: 1, cooldownMinutes: 30, leaseSeconds: 120 };
  for (let i = 0; i < keyCount; i++) {
    observeFallback(obs({ scope: `game-${i}`, policy: capPolicy }));
  }
  flushOk(); // 모든 키가 durable 확정 + lastFlushedAt 을 갖게 된다
  ok("flush 후 버퍼는 비어있다", pendingKeyCountForTest() === 0);

  // 2회차 관측 — 임계를 이미 넘겼고 주기 안이므로 원래는 false(누적만). 상한에 닿으면 true.
  let maxObservedPending = 0;
  let capTriggered = false;
  for (let i = 0; i < keyCount; i++) {
    const should = observeFallback(obs({ scope: `game-${i}`, policy: capPolicy }));
    maxObservedPending = Math.max(maxObservedPending, pendingKeyCountForTest());
    if (should) {
      capTriggered = true;
      flushOk();
    }
  }
  ok(`상한 도달 시 flush 신호가 나온다 (max pending ${maxObservedPending})`, capTriggered);
  ok(
    `pending 이 상한을 넘지 않는다 (${maxObservedPending} <= ${MAX_PENDING_KEYS})`,
    maxObservedPending <= MAX_PENDING_KEYS,
  );
}
{
  __resetBufferForTest();
  clock = 1_000_000;
  // 신규 키는 항상 즉시 반영된다(경보 누락 없음).
  let flushed = 0;
  for (let i = 0; i < 10; i++) {
    if (observeFallback(obs({ scope: `fresh-${i}` }))) {
      flushOk();
      flushed++;
    }
  }
  ok("신규 키 10개 → 10회 즉시 반영", flushed === 10);
}
{
  __resetBufferForTest();
  clock = 1_000_000;
  // flush 신호를 호출부가 흘려도(예: I/O 실패로 못 보냄) 다음 관측이 계속 신호를 준다.
  // 이 분기가 죽으면 "한 번 놓친 키는 주기가 올 때까지 갇힌다".
  const p1 = { windowMinutes: 5, threshold: 1, cooldownMinutes: 30, leaseSeconds: 120 };
  observeFallback(obs({ scope: "stuck", policy: p1 })); // true (임계 이내) — 무시한다
  const second = observeFallback(obs({ scope: "stuck", policy: p1 }));
  ok("flush 신호를 무시해도 다음 관측이 다시 신호를 준다(갇힘 방지)", second === true);
}

// ── 6) delta 는 정책을 함께 실어 보낸다(서버가 임계 판정에 쓴다) ──────────
{
  __resetBufferForTest();
  clock = 1_000_000;
  observeFallback(obs());
  const deltas = flushOk();
  const d = deltas[0];
  ok("window_minutes 전달", d.window_minutes === POLICY.windowMinutes);
  ok("threshold 전달", d.threshold === POLICY.threshold);
  ok("cooldown_minutes 전달", d.cooldown_minutes === POLICY.cooldownMinutes);
  ok("lease_seconds 전달", d.lease_seconds === POLICY.leaseSeconds);
  ok("scope 전달", d.scope === "20260819HTHH0");
  ok("count 는 최소 1", d.count >= 1);
}

// ── 7) 빈 버퍼 drain 은 빈 배열(불필요 RPC 안 만든다) ─────────────────────
{
  __resetBufferForTest();
  ok("빈 버퍼 drain → 빈 배열", flushOk().length === 0);
}

// ── 8) take → ack / requeue (삼순 2차 blocker 3) ──────────────────────────
// 종전 drainFallbackBuffer() 는 pending 을 지우고 lastFlushedAt 까지 갱신했다.
// RPC 가 실패하면 첫 관측을 포함한 delta 가 그대로 증발했고, "방금 보냈다"고 기록돼
// 다음 30초 동안 재시도도 막혔다. 이제 take 는 in-flight 로 옮기기만 한다.
{
  __resetBufferForTest();
  clock = 1_000_000;
  observeFallback(obs());
  observeFallback(obs());
  const taken = takeFallbackBuffer();
  ok("take 는 delta 를 꺼낸다", taken.length === 1 && taken[0].count === 2);
  ok("take 후 pending 은 비고", pendingKeyCountForTest() === 0);
  ok("take 후 in-flight 에 남는다(아직 확정 아님)", inFlightKeyCountForTest() === 1);

  // RPC 실패 → requeue: delta 가 pending 으로 복원된다.
  requeueFallbackFlush(taken);
  ok("requeue 후 in-flight 는 빈다", inFlightKeyCountForTest() === 0);
  ok("requeue 로 pending 복원", pendingKeyCountForTest() === 1);
  const again = takeFallbackBuffer();
  ok(`실패한 delta 의 count 가 보존된다 (실측 ${again[0]?.count})`, again[0]?.count === 2);
  ackFallbackFlush(again);
  ok("ack 후 in-flight 는 빈다", inFlightKeyCountForTest() === 0);
}
{
  __resetBufferForTest();
  clock = 1_000_000;
  // 실패했는데 "방금 보냈다"고 기록하면 다음 주기까지 재시도가 막힌다.
  observeFallback(obs());
  const taken = takeFallbackBuffer();
  requeueFallbackFlush(taken);
  clock += 1_000; // 주기(30초) 훨씬 이내
  const should = observeFallback(obs());
  ok("RPC 실패 후에는 주기를 기다리지 않고 즉시 재시도한다", should === true);
}
{
  __resetBufferForTest();
  clock = 1_000_000;
  // in-flight 중 같은 키에 새 관측이 들어오면, 나중 take 가 그 delta 를 별도로 가져간다.
  // (in-flight 를 pending 에 합치지 않으므로 중복 전송이 생기지 않는다.)
  observeFallback(obs());
  const first = takeFallbackBuffer();
  observeFallback(obs());
  const second = takeFallbackBuffer();
  ackFallbackFlush(first);
  ackFallbackFlush(second);
  const total = first.reduce((a, d) => a + d.count, 0) + second.reduce((a, d) => a + d.count, 0);
  ok(`in-flight 중 유입분도 정확히 1회씩 전달 (합 ${total})`, total === 2);
  ok("모두 ack 되면 in-flight 는 빈다", inFlightKeyCountForTest() === 0);
}
{
  __resetBufferForTest();
  clock = 1_000_000;
  // ack 는 durable 확정 카운트를 올린다 — 이게 "임계까지 즉시" 판정의 기준이다.
  // 안 올리면 영원히 임계 미달로 읽혀 매 관측이 즉시 flush 된다(쓰기 감소가 무효화).
  const p = { windowMinutes: 5, threshold: 2, cooldownMinutes: 30, leaseSeconds: 120 };
  for (let i = 0; i < 5; i++) {
    if (observeFallback(obs({ scope: "ackcnt", policy: p }))) flushOk();
  }
  const shouldAfter = observeFallback(obs({ scope: "ackcnt", policy: p }));
  ok("임계를 넘긴 뒤에는 즉시 flush 하지 않는다(ack 가 durable 카운트를 올렸다)", shouldAfter === false);
}

__setClockForTest(null);
console.log(`\nfallback buffer: ${fail === 0 ? "PASS" : `${fail} FAILED`}`);
if (fail > 0) process.exit(1);
