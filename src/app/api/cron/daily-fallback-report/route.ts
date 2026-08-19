/**
 * 일일 API Fallback 리포트 cron
 * 
 * Vercel Cron: 매일 오전 9시 (KST)
 * - 전날 00:00 ~ 23:59 장애 이벤트 집계
 * - 텔레그램으로 요약 리포트 전송
 */

import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { NextRequest, NextResponse } from "next/server";

const CRON_SECRET = process.env.CRON_SECRET || "";

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

    // 전날 장애 이벤트 조회
    const { data: events, error } = await supabase
      .from("api_fallback_events")
      .select("*")
      .gte("timestamp", startDate.toISOString())
      .lt("timestamp", endDate.toISOString())
      .order("timestamp", { ascending: false });

    if (error) {
      console.error("[Daily Report] Query error:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // 이벤트 없으면 알림 스킵
    if (!events || events.length === 0) {
      console.log("[Daily Report] No events yesterday, skipping report");
      return NextResponse.json({ message: "No events yesterday" });
    }

    // 2026-08-20: 1행 = 1발생이 아니다. (api, reason, scope, 1분버킷) 1행 + event_count 합산이므로
    // 리포트의 "N건"은 sum(event_count)로 읽는다. row count로 읽으면 폴링 증폭 차단 이후
    // 장애가 줄어든 것처럼 보이는 오보가 된다. 마이그레이션 이전 행은 event_count null → 1.
    const occurrences = (e: { event_count?: number | null }) => e.event_count ?? 1;
    const totalOccurrences = events.reduce((n, e) => n + occurrences(e), 0);

    // API별 집계
    const byApi = events.reduce((acc, e) => {
      const api = e.api_name;
      if (!acc[api]) {
        acc[api] = { total: 0, reasons: {} as Record<string, number> };
      }
      acc[api].total += occurrences(e);
      acc[api].reasons[e.reason] = (acc[api].reasons[e.reason] || 0) + occurrences(e);
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
    message += `총 이벤트: ${totalOccurrences}건 (기록 ${events.length}행)\n\n`;

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
      return NextResponse.json({ message: "Report sent", events: totalOccurrences, rows: events.length });
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
