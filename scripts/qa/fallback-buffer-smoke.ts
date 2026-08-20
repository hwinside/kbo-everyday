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
  drainFallbackBuffer,
  fingerprintOf,
  observeFallback,
  pendingKeyCountForTest,
  type FallbackObservation,
} from "@/lib/monitoring/fallback-buffer";

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
      const deltas = drainFallbackBuffer();
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
  ok(`버스트 5,000건 → RPC 호출 1회 (실측 ${r.flushes})`, r.flushes === 1);
  ok("첫 관측은 즉시 나간다(경보 임계 지연 없음)", r.totalCounted >= 1);
  ok(`잔여는 버퍼에 누적 (pending ${pendingKeyCountForTest()})`, pendingKeyCountForTest() === 1);
  // 잔여를 flush 하면 나머지가 1행 1회로 나간다.
  const rest = drainFallbackBuffer();
  ok("잔여 flush 는 1행", rest.length === 1);
  ok(`잔여 count 가 4,999 (실측 ${rest[0]?.count})`, rest[0]?.count === 4999);
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
  drainFallbackBuffer();
  observeFallback(obs({ scope: "gameB" }));
  const deltas = drainFallbackBuffer();
  ok("다른 scope 는 별도 delta", deltas.length === 1 && deltas[0].scope === "gameB");
}
{
  __resetBufferForTest();
  clock = 1_000_000;
  observeFallback(obs({ reason: "timeout" }));
  drainFallbackBuffer();
  observeFallback(obs({ reason: "http-error" }));
  const deltas = drainFallbackBuffer();
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
  const deltas = drainFallbackBuffer();
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
  const deltas = drainFallbackBuffer();
  ok("같은 지문·같은 scope 는 1개 delta 로 합산", deltas.length === 1 && deltas[0].count === 2);
}

// ── 5) 버퍼 폭주 방어 ────────────────────────────────────────────────────
{
  __resetBufferForTest();
  clock = 1_000_000;
  const keyCount = MAX_PENDING_KEYS + 50;

  // ⚠️ 관측 가능성: 신규 키는 "첫 관측" 분기에서 이미 true 를 돌려주므로, 매번 drain 하면
  //    상한 방어 분기가 **원리적으로 도달 불가**하다(훼손해도 결과가 같다).
  //    상한은 "이미 한 번 flush 된 키들이 주기 안에 다시 쌓일 때" 의미가 있다 → 무대를 만든다.
  for (let i = 0; i < keyCount; i++) observeFallback(obs({ scope: `game-${i}` }));
  drainFallbackBuffer(); // 모든 키가 lastFlushedAt 을 갖게 된다
  ok("drain 후 버퍼는 비어있다", pendingKeyCountForTest() === 0);

  // 이제 2회차 관측 — 주기 안이므로 원래는 계속 false(누적만 됨). 상한에 닿으면 true 가 나와야 한다.
  let maxObservedPending = 0;
  let capTriggered = false;
  for (let i = 0; i < keyCount; i++) {
    const should = observeFallback(obs({ scope: `game-${i}` }));
    maxObservedPending = Math.max(maxObservedPending, pendingKeyCountForTest());
    if (should) {
      capTriggered = true;
      drainFallbackBuffer();
    }
  }
  ok(`상한 도달 시 flush 신호가 나온다 (max pending ${maxObservedPending})`, capTriggered);
  ok(
    `pending 이 상한을 크게 넘지 않는다 (${maxObservedPending} <= ${MAX_PENDING_KEYS})`,
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
      drainFallbackBuffer();
      flushed++;
    }
  }
  ok("신규 키 10개 → 10회 즉시 반영", flushed === 10);
}

// ── 6) delta 는 정책을 함께 실어 보낸다(서버가 임계 판정에 쓴다) ──────────
{
  __resetBufferForTest();
  clock = 1_000_000;
  observeFallback(obs());
  const deltas = drainFallbackBuffer();
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
  ok("빈 버퍼 drain → 빈 배열", drainFallbackBuffer().length === 0);
}

__setClockForTest(null);
console.log(`\nfallback buffer: ${fail === 0 ? "PASS" : `${fail} FAILED`}`);
if (fail > 0) process.exit(1);
