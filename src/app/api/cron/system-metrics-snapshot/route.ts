import { NextRequest, NextResponse } from "next/server";
import { extractCpuCounterSnapshot } from "@/lib/admin/system-health";
import {
  counterAdvanced,
  loadRecentCpuSnapshots,
  replaceCpuSnapshots,
} from "@/lib/admin/cpu-snapshot-store";

const CRON_SECRET = process.env.CRON_SECRET || "";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * CPU counter 스냅샷 적재 cron (1분 주기, 2026-08-21 · 삼순 NO-GO 반영 v2).
 *
 * 목적: 어드민 대시보드가 열리는 즉시 CPU busy%를 보여주려면 최근(≤90초) baseline이
 * 항상 저장소에 있어야 한다. Supabase 메트릭 scrape가 ~60초 주기라 브라우저 단독
 * 측정은 첫 ~60초가 "측정 중"이 된다(#1275 스레드 — 다급한 상황에서 1분 대기 불가).
 *
 * 저장소: Vercel Edge Config — 감시 대상 Supabase DB 밖(순환 의존 제거).
 * 작성자: 이 cron 하나뿐(단일 작성자). 전체 배열 단일 upsert = 원자적 교체라
 * read→insert race가 없다. health 경로는 읽기 전용.
 *
 * 실패 계약: 어떤 실패든 5xx로 노출해 Vercel cron 실패 집계에 잡히게 한다.
 * cron이 죽으면 baseline이 90초를 넘겨 즉시값이 자연 소멸(stale fail-close)하고,
 * 대시보드는 기존 클라이언트 60초 경로로 동작한다.
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

  const now = Date.now();
  const stored = await loadRecentCpuSnapshots();
  if (stored === null) {
    return NextResponse.json({ error: "snapshot store 조회 실패" }, { status: 500 });
  }

  if (!counterAdvanced(counter, stored[0] ?? null)) {
    // 같은 scrape tick — 적재 불필요 (성공으로 종료)
    return NextResponse.json({ ok: true, inserted: false, capturedAt: new Date(now).toISOString() });
  }

  const next = [
    {
      capturedAtMs: now,
      seriesFingerprint: counter.seriesFingerprint,
      totalSeconds: counter.totalSeconds,
      idleSeconds: counter.idleSeconds,
    },
    ...stored,
  ];
  const replaced = await replaceCpuSnapshots(next);
  if (!replaced) {
    return NextResponse.json({ error: "snapshot 적재 실패" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, inserted: true, capturedAt: new Date(now).toISOString() });
}
