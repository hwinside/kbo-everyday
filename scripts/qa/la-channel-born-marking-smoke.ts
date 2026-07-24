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

  // ── ⑤ 재시도 예산 소진(deadline) — 배치당 1회만, 후속 배치 굶김 없음 (삼순 R1 blocker②) ──
  {
    const { sleeps, sleep } = sleepSpy();
    let calls = 0;
    const logs: string[] = [];
    const stats = await markChannelBornGroups({
      gameId: "20260724WOHT0",
      groups: [group(CHANNEL_BORN_BATCH_SIZE * 3)], // 3배치 전부 실패(8s statement timeout 모사)
      updateBatch: async () => {
        calls += 1;
        return { error: { message: "statement timeout" } };
      },
      retryDeadlineMs: 1_000,
      now: () => 5_000, // 이미 예산 소진
      logError: (m) => logs.push(m),
      sleep,
    });
    check("deadline: 예산 소진 시 배치당 첫 시도 1회만(재시도/sleep 0)", { calls, sleeps }, { calls: 3, sleeps: [] });
    check("deadline: 느린 실패 배치가 후속 배치를 안 굶김 — 3배치 모두 시도됨", stats, {
      batches: 3, failedBatches: 3, failedUsers: 600,
    });
    check("deadline: 실제 시도 횟수로 로깅(attempts=1)", logs.every((l) => l.includes("attempts=1")), true);
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

  console.log(`\nla-channel-born-marking-smoke: ${pass} PASS / ${fail} FAIL`);
  if (fail > 0) process.exit(1);
})().catch((e) => {
  console.error("smoke crashed:", e);
  process.exit(1);
});
