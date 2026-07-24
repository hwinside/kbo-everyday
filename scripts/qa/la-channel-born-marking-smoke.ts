/**
 * 채널 출생 세대 마킹 견고화 — 재시도/부분실패 격리 스모크 (2026-07-24 WOHT0 사고 회귀).
 * 실행: npx tsx scripts/qa/la-channel-born-marking-smoke.ts  (npm run qa:la-born-marking)
 */
import {
  markChannelBornGroups,
  runStartSendChunks,
  CHANNEL_BORN_BATCH_SIZE,
  CHANNEL_BORN_MAX_ATTEMPTS,
  CHANNEL_BORN_RETRY_BASE_MS,
  type ChannelBornGroup,
} from "../../src/lib/notifications/live-activity-channel-policy";

let pass = 0;
let fail = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass++;
  } else {
    fail++;
    console.error(`✗ ${name}\n  got:  ${g}\n  want: ${w}`);
  }
}

const users = (n: number, prefix = "u") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const group = (n: number, channelId = "chan-A"): ChannelBornGroup => ({
  env: "production",
  channelId,
  users: users(n),
});
const sleepSpy = () => {
  const sleeps: number[] = [];
  return { sleeps, sleep: async (ms: number) => void sleeps.push(ms) };
};

(async () => {
  // ── ① 전량 성공 — 배치 분할/슬라이스 정확성 ──
  {
    const calls: string[][] = [];
    const stats = await markChannelBornGroups({
      gameId: "20260724WOHT0",
      groups: [group(CHANNEL_BORN_BATCH_SIZE * 2 + 17)],
      updateBatch: async (_g, ids) => { calls.push(ids); return { error: null }; },
      sleep: async () => {},
    });
    check("성공: 배치 수(417명 → 200+200+17)", calls.map((c) => c.length), [200, 200, 17]);
    check("성공: stats", stats, { batches: 3, failedBatches: 0, failedUsers: 0 });
    check("성공: 유저 누락/중복 없음", calls.flat().sort().join(","), users(417).sort().join(","));
  }

  // ── ② 일시 실패 → 백오프 재시도로 회복 ──
  {
    let attempts = 0;
    const { sleeps, sleep } = sleepSpy();
    const stats = await markChannelBornGroups({
      gameId: "20260724WOHT0",
      groups: [group(10)],
      updateBatch: async () => {
        attempts += 1;
        return attempts < 3 ? { error: { message: "statement timeout" } } : { error: null };
      },
      sleep,
    });
    check("재시도: 3번째 시도에서 성공", { attempts, stats }, {
      attempts: 3,
      stats: { batches: 1, failedBatches: 0, failedUsers: 0 },
    });
    check("재시도: 지수 백오프(500, 1000)", sleeps,
      [CHANNEL_BORN_RETRY_BASE_MS, CHANNEL_BORN_RETRY_BASE_MS * 2]);
  }

  // ── ③ 한 배치 최종 실패 — 명시 로깅 + 나머지 배치 계속(부분실패 격리) ──
  {
    const logs: string[] = [];
    const done: string[][] = [];
    const g = group(CHANNEL_BORN_BATCH_SIZE * 3); // 3배치
    const stats = await markChannelBornGroups({
      gameId: "20260724WOHT0",
      groups: [g],
      updateBatch: async (_g, ids) => {
        if (ids[0] === g.users[CHANNEL_BORN_BATCH_SIZE]) {
          // 2번째 배치만 전 시도 실패
          return { error: { message: "canceling statement due to statement timeout" } };
        }
        done.push(ids);
        return { error: null };
      },
      logError: (m) => logs.push(m),
      sleep: async () => {},
    });
    check("부분실패: 실패 배치 이후에도 계속 진행(1,3번째 성공)", done.length, 2);
    check("부분실패: stats", stats, { batches: 3, failedBatches: 1, failedUsers: 200 });
    check("부분실패: 로그 1건 + 경기ID/배치/건수/에러 포함",
      logs.length === 1 &&
        logs[0].includes("game=20260724WOHT0") &&
        logs[0].includes("batch=1") &&
        logs[0].includes("users=200") &&
        logs[0].includes(`attempts=${CHANNEL_BORN_MAX_ATTEMPTS}`) &&
        logs[0].includes("statement timeout"),
      true);
  }

  // ── ④ updateBatch throw(네트워크 예외) — 실패 처리 후 다음 그룹 계속 ──
  {
    const logs: string[] = [];
    const done: string[] = [];
    const stats = await markChannelBornGroups({
      gameId: "20260724WOHT0",
      groups: [group(5, "chan-A"), group(5, "chan-B")],
      updateBatch: async (g) => {
        if (g.channelId === "chan-A") throw new Error("fetch failed");
        done.push(g.channelId);
        return { error: null };
      },
      logError: (m) => logs.push(m),
      sleep: async () => {},
    });
    check("throw: 예외도 실패로 격리, 다음 그룹 진행", { stats, done }, {
      stats: { batches: 2, failedBatches: 1, failedUsers: 5 },
      done: ["chan-B"],
    });
    check("throw: 에러 메시지 로깅", logs.length === 1 && logs[0].includes("fetch failed"), true);
  }

  // ── ⑤ 예산 소진(deadline) — 새 UPDATE 시작 자체 금지: 첫 시도 포함 즉시 skip (삼순 R2) ──
  {
    const { sleeps, sleep } = sleepSpy();
    let calls = 0;
    const logs: string[] = [];
    const stats = await markChannelBornGroups({
      gameId: "20260724WOHT0",
      groups: [group(CHANNEL_BORN_BATCH_SIZE * 3)], // 3배치 — 전부 시작 전 skip되어야 함
      updateBatch: async () => {
        calls += 1;
        return { error: { message: "statement timeout" } };
      },
      retryDeadlineMs: 1_000,
      now: () => 5_000, // 이미 예산 소진
      logError: (m) => logs.push(m),
      sleep,
    });
    check("deadline: 예산 소진 시 새 UPDATE 시작 0회(직렬 대기 없음)", { calls, sleeps }, { calls: 0, sleeps: [] });
    check("deadline: skip된 배치도 실패로 집계(backfill 대상)", stats, {
      batches: 3, failedBatches: 3, failedUsers: 600,
    });
    check("deadline: skip 로깅(attempts=0 + 사유)",
      logs.length === 3 &&
        logs.every((l) => l.includes("attempts=0") && l.includes("deadline exceeded (batch skipped)")),
      true);
  }

  // ── ⑤b 삼순 R2 실측 재현: deadline+10ms, 느린 실패 120ms×6 주입 → 직렬 대기 없이 즉시 skip ──
  {
    let calls = 0;
    const slowFail = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 120));
      return { error: { message: "statement timeout" } };
    };
    const t0 = Date.now();
    const stats = await markChannelBornGroups({
      gameId: "20260724WOHT0",
      groups: users(6).map((_, i) => group(CHANNEL_BORN_BATCH_SIZE, `chan-${i}`)), // 6배치
      updateBatch: slowFail,
      retryDeadlineMs: Date.now() - 10, // deadline+10ms 경과 상태
      logError: () => {},
    });
    const elapsed = Date.now() - t0;
    check("R2 재현: 느린 실패 UPDATE 호출 0회", calls, 0);
    check("R2 재현: 6배치 전부 즉시 skip 집계", stats, { batches: 6, failedBatches: 6, failedUsers: 1200 });
    check(`R2 재현: wall-clock 유계(<100ms, 실측 ${elapsed}ms — 종전 731ms 직렬 대기)`, elapsed < 100, true);
  }

  // ── ⑤c 진행 중 UPDATE 유계화 — 남은 예산으로 AbortSignal 전달(8s timeout 잠식 방지) ──
  {
    // 예산 150ms 남은 상태에서 UPDATE가 8s를 끓 수 있어도 signal abort로 예산 내 종료.
    const t0 = Date.now();
    const stats = await markChannelBornGroups({
      gameId: "20260724WOHT0",
      groups: [group(10)],
      updateBatch: (_g, _ids, opts) =>
        new Promise((resolve) => {
          // 8s statement timeout 모사 — signal abort 시에만 실패 반환(supabase 동작 동형).
          const t = setTimeout(() => resolve({ error: { message: "8s timeout" } }), 8_000);
          opts.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            resolve({ error: { message: "AbortError: aborted" } });
          });
        }),
      retryDeadlineMs: Date.now() + 150,
      logError: () => {},
      sleep: async () => {},
    });
    const elapsed = Date.now() - t0;
    check("abort 유계: 실패 집계(예산 내 abort)", stats, { batches: 1, failedBatches: 1, failedUsers: 10 });
    check(`abort 유계: wall-clock ≈예산(150ms), 8s 잠식 없음(실측 ${elapsed}ms < 1000ms)`, elapsed < 1_000, true);
  }

  // ── ⑥ 예산 남았으면 기존 재시도 그대로 (deadline 미도달 회귀) ──
  {
    let attempts = 0;
    const stats = await markChannelBornGroups({
      gameId: "20260724WOHT0",
      groups: [group(10)],
      updateBatch: async () => {
        attempts += 1;
        return attempts < 3 ? { error: { message: "transient" } } : { error: null };
      },
      retryDeadlineMs: 10_000,
      now: () => 0,
      sleep: async () => {},
    });
    check("deadline 미도달: 재시도로 회복", { attempts, stats }, {
      attempts: 3,
      stats: { batches: 1, failedBatches: 0, failedUsers: 0 },
    });
  }

  // ── ⑦ 실배선 회귀: chunk당 즉시 내구 저장 — cutoff에도 앞 chunk 마킹 잔존 (삼순 R1 blocker②) ──
  {
    const events: string[] = [];
    let persisted = 0;
    await runStartSendChunks({
      items: [0, 1, 2, 3, 4, 5],
      chunkSize: 2,
      sendOne: async (i) => {
        // 3번째 chunk 발송 중 함수 cutoff(68s fanout deadline/종료) 모사 — 이후 코드 미실행.
        if (i === 4) throw new Error("fanout deadline cutoff");
        events.push(`send:${i}`);
      },
      persistChunk: async () => {
        persisted += 1;
        events.push(`persist:${persisted}`);
      },
    }).catch(() => {});
    check("cutoff: 앞 2개 chunk 마킹은 이미 내구 저장(손실 상한 = 마지막 chunk 1개)", persisted, 2);
    check("cutoff: 다음 chunk 발송 전 직전 chunk persist 선행(내구 순서 불변식)",
      events, ["send:0", "send:1", "persist:1", "send:2", "send:3", "persist:2", "send:5"]);
  }

  // ── ⑧ 실조립 회귀(삼순 R2 핵심): runStartSendChunks → persistChunk에 느린 실패 UPDATE 주입 ──
  // 실배선(live-activity.ts persistChunkMarks) 동형 조립: chunk당 마킹이 공유 deadline을
  // 넘어서는 순간부터 새 UPDATE를 시작하지 않아 — 후속 chunk *발송*(사용자 처리)은 굶지 않고
  // 계속되며, 전체 wall-clock이 예산 내 유계임을 실측 assert. 마킹 skip분은 실패 집계로
  // backfill 계약 유지(발송·선점은 안 건드림 — 재발송 중복 없음).
  {
    const items = users(600); // 6 chunks × 100 (KIA 1,827명 = 19 chunks의 축소 모델)
    const sent: string[] = [];
    let updateCalls = 0;
    let markedFailedUsers = 0;
    let pending: string[] = [];
    const markRetryDeadlineMs = Date.now() + 100; // 공유 예산 100ms — 첫 1–2 chunk 마킹 후 소진
    const slowFailingUpdate = async () => {
      updateCalls += 1;
      await new Promise((r) => setTimeout(r, 120)); // 느린 실패 120ms(삼순 실측 시나리오)
      return { error: { message: "statement timeout" } };
    };
    const t0 = Date.now();
    await runStartSendChunks({
      items,
      chunkSize: 100,
      sendOne: async (u) => {
        sent.push(u);
        pending.push(u);
      },
      persistChunk: async () => {
        if (pending.length === 0) return;
        const flush = pending;
        pending = [];
        const stats = await markChannelBornGroups({
          gameId: "20260724WOHT0",
          groups: [{ env: "production" as const, channelId: "chan-A", users: flush }],
          retryDeadlineMs: markRetryDeadlineMs,
          updateBatch: slowFailingUpdate,
          logError: () => {},
          sleep: async () => {},
        });
        markedFailedUsers += stats.failedUsers;
      },
    });
    const elapsed = Date.now() - t0;
    check("조립: 느린 마킹 실패에도 후속 chunk 사용자 발송 전수 진행(600/600)", sent.length, 600);
    check("조립: 예산 소진 후 새 UPDATE 미시작 — 호출 수 유계(≤2: 19×8s 직렬 경로 제거)", updateCalls <= 2, true);
    check("조립: skip된 마킹은 실패 집계로 backfill 계약 유지(조용한 소실 아님)",
      markedFailedUsers >= 400, true);
    check(`조립: 전체 wall-clock 유계 — 예산+슬럿(<1s, 실측 ${elapsed}ms; 종전 최악 19×8s=152s)`, elapsed < 1_000, true);
  }

  console.log(`\nla-channel-born-marking-smoke: ${pass} PASS / ${fail} FAIL`);
  if (fail > 0) process.exit(1);
})().catch((e) => {
  console.error("smoke crashed:", e);
  process.exit(1);
});
