/**
 * #1275 머지 전 E2E: cron route → 실제 Vercel Edge Config → health 첫 응답.
 *
 * 삼순 3차 요구 반영. Preview 에 스케줄러가 없어도 cron route 자체는 인증 GET 으로
 * 호출 가능하므로, 실제 저장소를 거쳐 health 가 첫 응답에 CPU% 를 채우는지 검증한다.
 * (실제 스케줄러 발화만 배포 후 확인)
 *
 * 실행: npx tsx scripts/qa/cpu-instant-e2e.ts
 * 필요 env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *          SUPABASE_MANAGEMENT_TOKEN, VERCEL_TOKEN, CRON_SECRET(임의 지정 가능), ADMIN_PIN
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

function loadEnvLocal() {
  try {
    const text = readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
    for (const line of text.split("\n")) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!match) continue;
      const key = match[1];
      if (process.env[key] === undefined) process.env[key] = match[2].replace(/^"|"$/g, "");
    }
  } catch {
    // env.local 없으면 프로세스 env 사용
  }
}

loadEnvLocal();
process.env.CRON_SECRET = process.env.CRON_SECRET || "e2e-local-secret";
process.env.ADMIN_PIN = process.env.ADMIN_PIN || "e2e-admin-pin";
delete process.env.ADMIN_PIN_HASH;

const required = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_MANAGEMENT_TOKEN", "VERCEL_TOKEN"];
const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`env 누락: ${missing.join(", ")}`);
  process.exit(2);
}

async function main() {
  const { GET: cronGet } = await import("../../src/app/api/cron/system-metrics-snapshot/route");
  const { GET: healthGet } = await import("../../src/app/api/admin/system-health/route");
  const { loadRecentCpuSnapshots } = await import("../../src/lib/admin/cpu-snapshot-store");

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function runCron(label: string) {
    const response = await cronGet(
      new NextRequest("http://localhost/api/cron/system-metrics-snapshot", {
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
      }),
    );
    const body = await response.json();
    console.log(`[cron ${label}] status=${response.status} body=${JSON.stringify(body)}`);
    assert.equal(response.status, 200, `cron ${label} 은 200 이어야 한다`);
    return body as { ok: boolean; inserted: boolean; capturedAt: string };
  }

  async function runHealth(label: string) {
    const response = await healthGet(
      new NextRequest("http://localhost/api/admin/system-health", {
        headers: { "x-admin-pin": process.env.ADMIN_PIN as string },
      }),
    );
    const body = await response.json();
    const metrics = body.metrics ?? {};
    console.log(
      `[health ${label}] status=${response.status} cpu=${metrics.cpuUsedPercent} window=${metrics.cpuSampleSeconds}s endedAt=${metrics.cpuSampleEndedAt} sourceErrors=${JSON.stringify(body.sourceErrors)}`,
    );
    assert.equal(response.status, 200, `health ${label} 은 200 이어야 한다`);
    return body as {
      metrics: { cpuUsedPercent: number | null; cpuSampleSeconds: number | null; cpuSampleEndedAt: string | null } | null;
    };
  }

  console.log("=== #1275 E2E: cron → 실제 Edge Config → health ===");

  // 1) cron 1회차 — baseline 적재
  await runCron("1st");
  const afterFirst = await loadRecentCpuSnapshots();
  assert.ok(afterFirst && afterFirst.length >= 1, "1회차 후 저장소에 스냅샷이 있어야 한다");
  console.log(`[store] rows=${afterFirst.length} newest=${new Date(afterFirst[0].capturedAtMs).toISOString()}`);

  // 2) Supabase scrape 주기(~60초)를 넘겨 counter 가 전진하도록 대기 후 2회차
  console.log("[wait] scrape 주기 대기 65s …");
  await sleep(65_000);
  await runCron("2nd");
  const afterSecond = await loadRecentCpuSnapshots();
  assert.ok(afterSecond && afterSecond.length >= 2, "2회차 후 스냅샷이 2건 이상이어야 한다");
  assert.ok(
    afterSecond[0].totalSeconds > afterSecond[1].totalSeconds,
    "최신 counter 가 직전보다 전진해 있어야 한다(단조성)",
  );
  console.log(`[store] rows=${afterSecond.length} newest=${new Date(afterSecond[0].capturedAtMs).toISOString()}`);

  // 3) health 첫 응답이 즉시 CPU% 를 채우는지 — 이게 이 PR 의 목적
  const health = await runHealth("first-response");
  const cpu = health.metrics?.cpuUsedPercent ?? null;
  assert.ok(cpu !== null, "health 첫 응답에 CPU% 가 채워져야 한다(측정 중 금지)");
  assert.ok(cpu >= 0 && cpu <= 100, "CPU% 는 0~100 범위여야 한다");
  const endedAt = health.metrics?.cpuSampleEndedAt ? Date.parse(health.metrics.cpuSampleEndedAt) : NaN;
  assert.ok(Number.isFinite(endedAt), "cpuSampleEndedAt 이 있어야 한다");
  const ageSeconds = (Date.now() - endedAt) / 1_000;
  assert.ok(ageSeconds <= 90, `rate 종료 시각이 90초 이내여야 한다 (실측 ${ageSeconds.toFixed(1)}s)`);

  // 4) health 는 저장소에 쓰지 않는다 — 호출 전후 저장소 동일성
  const beforeWriteCheck = await loadRecentCpuSnapshots();
  await runHealth("write-check");
  const afterWriteCheck = await loadRecentCpuSnapshots();
  assert.deepEqual(afterWriteCheck, beforeWriteCheck, "health 경로는 저장소를 변경하면 안 된다(읽기 전용)");

  console.log("\n✅ E2E PASS — cron 적재 → 실제 Edge Config → health 첫 응답 CPU 즉시 표시, health write 0");

}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
