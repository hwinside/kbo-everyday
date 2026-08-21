import { NextRequest, NextResponse } from "next/server";
import { extractCpuCounterSnapshot } from "@/lib/admin/system-health";
import {
  loadRecentCpuSnapshots,
  pruneCpuSnapshots,
  storeCpuSnapshotIfAdvanced,
} from "@/lib/admin/cpu-snapshot-store";

const CRON_SECRET = process.env.CRON_SECRET || "";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * CPU counter 스냅샷 적재 cron (1분 주기, 2026-08-21).
 *
 * 목적: 어드민 대시보드가 열리는 즉시 CPU busy%를 보여주려면 최근(≤~2분) baseline이
 * 항상 원장에 있어야 한다. Supabase 메트릭 scrape가 ~60초 주기라 브라우저 단독 측정은
 * 첫 ~60초가 "측정 중"이 된다(#1270 스레드 하린아빠 지적 — 다급한 상황에서 1분 대기 불가).
 *
 * 동작: 메트릭 fetch → counter 전진 시에만 insert(중복 scrape tick 미적재) → 보존기간 초과분 정리.
 * 실패 계약: 어떤 실패든 5xx로 노출해 Vercel cron 실패 집계에 잡히게 한다 (조용한 결손 금지).
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const ref = url.match(/^https:\/\/([^.]+)\./)?.[1] ?? null;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!ref || !serviceRole) {
    return NextResponse.json({ error: "Supabase env 미설정" }, { status: 503 });
  }

  const auth = Buffer.from(`service_role:${serviceRole}`).toString("base64");
  let text: string;
  try {
    const response = await fetch(`https://${ref}.supabase.co/customer/v1/privileged/metrics`, {
      headers: { Authorization: `Basic ${auth}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Metrics HTTP ${response.status}`);
    text = await response.text();
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "metrics fetch failed" },
      { status: 502 },
    );
  }

  const counter = extractCpuCounterSnapshot(text);
  if (!counter) {
    return NextResponse.json({ error: "node_cpu_seconds_total 없음" }, { status: 502 });
  }

  const now = new Date();
  const stored = await loadRecentCpuSnapshots(1);
  if (stored === null) {
    return NextResponse.json({ error: "snapshot ledger 조회 실패" }, { status: 500 });
  }
  const inserted = await storeCpuSnapshotIfAdvanced(counter, stored[0] ?? null, now);
  const advanced =
    !stored[0] ||
    stored[0].seriesFingerprint !== counter.seriesFingerprint ||
    stored[0].totalSeconds !== counter.totalSeconds ||
    stored[0].idleSeconds !== counter.idleSeconds;
  if (advanced && !inserted) {
    return NextResponse.json({ error: "snapshot insert 실패" }, { status: 500 });
  }
  const pruned = await pruneCpuSnapshots(now);
  if (!pruned) {
    return NextResponse.json({ error: "snapshot prune 실패" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, inserted, capturedAt: now.toISOString() });
}
