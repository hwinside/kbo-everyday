/**
 * 일일 API Fallback 리포트 cron
 *
 * Vercel Cron: 매일 오전 9시 (KST)
 * - 전날 00:00 ~ 23:59 장애 이벤트 집계
 * - 텔레그램으로 요약 리포트 전송
 *
 * 2026-08-20 (삼순 blocker 3): 종전엔 `.select("*")` 무페이지 조회라 Supabase 기본 1,000행
 * cap 에 조용히 잘렸다. 경기일엔 분당 버킷도 하루 1,000행을 넘을 수 있어 "N건"이 오보가 된다.
 * → 집계를 DB 로 내린다. 발생 횟수는 sum(event_count) 다 — row count 로 읽으면 폴링 증폭
 *   차단 이후 장애가 줄어든 것처럼 보이는 오보가 된다.
 */

import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { NextRequest, NextResponse } from "next/server";

const CRON_SECRET = process.env.CRON_SECRET || "";

interface FallbackSummaryRow {
  api_name: string;
  reason: string;
  occurrences: number;
  rows_stored: number;
  latest_at: string;
  latest_message: string | null;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    // 전날 00:00 ~ 23:59 (KST)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    const today = new Date(yesterday);
    today.setDate(today.getDate() + 1);

    // UTC로 변환 (KST - 9시간)
    const startDate = new Date(yesterday.getTime() - 9 * 60 * 60 * 1000);
    const endDate = new Date(today.getTime() - 9 * 60 * 60 * 1000);

    // query-guard: bounded -- summarize_api_fallbacks 는 서버에서 group by 한 집계만 반환한다.
    // 행 수 상한 = (api_name × reason) 카디널리티로 관제 대상 API 수(수십)에 묶인다.
    const { data, error } = await supabase.rpc("summarize_api_fallbacks", {
      p_since: startDate.toISOString(),
      p_until: endDate.toISOString(),
      p_api_name: null,
    });

    if (error) {
      console.error("[Daily Report] Query error:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const rows = (data ?? []) as FallbackSummaryRow[];

    // 이벤트 없으면 알림 스킵
    if (rows.length === 0) {
      console.log("[Daily Report] No events yesterday, skipping report");
      return NextResponse.json({ message: "No events yesterday" });
    }

    const totalOccurrences = rows.reduce((n, r) => n + Number(r.occurrences), 0);
    const totalRows = rows.reduce((n, r) => n + Number(r.rows_stored), 0);

    // API별 집계
    const byApi = rows.reduce((acc, r) => {
      const api = r.api_name;
      if (!acc[api]) {
        acc[api] = { total: 0, reasons: {} as Record<string, number> };
      }
      acc[api].total += Number(r.occurrences);
      acc[api].reasons[r.reason] = (acc[api].reasons[r.reason] || 0) + Number(r.occurrences);
      return acc;
    }, {} as Record<string, { total: number; reasons: Record<string, number> }>);

    // 리포트 메시지 생성
    const dateStr = yesterday.toLocaleDateString("ko-KR", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "Asia/Seoul",
    });

    let message = `📊 *API 장애 일일 리포트*\n\n`;
    message += `날짜: ${dateStr}\n`;
    message += `총 이벤트: ${totalOccurrences}건 (기록 ${totalRows}행)\n\n`;

    // API별 상세
    message += `*API별 장애 내역*\n`;
    const sortedApis = (Object.entries(byApi) as [string, { total: number; reasons: Record<string, number> }][]).sort(
      (a, b) => b[1].total - a[1].total
    );

    for (const [api, stats] of sortedApis) {
      message += `\n• *${api}*: ${stats.total}건\n`;
      for (const [reason, count] of Object.entries(stats.reasons)) {
        message += `  - ${reason}: ${count}회\n`;
      }
    }

    // 가장 많이 실패한 API
    const topApi = sortedApis[0];
    if (topApi) {
      message += `\n⚠️ 최다 장애: *${topApi[0]}* (${topApi[1].total}건)`;
    }

    // 텔레그램 전송
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = "6796048731"; // 하린아빠

    if (!botToken) {
      console.warn("[Daily Report] TELEGRAM_BOT_TOKEN not set");
      return NextResponse.json({ message: "Report generated but not sent (no token)" });
    }

    const telegramRes = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: "Markdown",
        }),
      }
    );

    const telegramData = await telegramRes.json();

    if (telegramData.ok) {
      console.log("[Daily Report] Sent successfully");
      return NextResponse.json({ message: "Report sent", events: totalOccurrences, rows: totalRows });
    } else {
      console.error("[Daily Report] Telegram send failed:", telegramData);
      return NextResponse.json(
        { error: "Telegram send failed", details: telegramData },
        { status: 500 }
      );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Daily Report] Unexpected error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
