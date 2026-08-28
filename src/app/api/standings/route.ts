import { NextResponse } from "next/server";
import { fetchStandings } from "@/lib/crawler/kbo-api";

export async function GET() {
  try {
    const standings = await fetchStandings();
    return NextResponse.json({
      count: standings.length,
      standings,
      /**
       * upstream(Naver/KBO)에서 **실제로 받은** 시각(ISO).
       *
       * 🔴 왜 본문에 싣는가 (삼순 2026-08-28 P0-③): 이 응답은 CDN 이 최대 15분
       *   (`s-maxage=300` + `stale-while-revalidate=600`) 캐시한다. 소비자가 "응답을
       *   받은 시각"을 신선도로 쓰면 캐시된 15분 전 값이 방금 값이 된다 — 200 은
       *   신선도의 증거가 아니다. 그래서 신선도를 **본문(데이터)에 결속**해 내보낸다.
       *   본문에 실으면 CDN 이 통째로 캐시해도 원래 생성 시각이 함께 굳는다.
       */
      fetchedAt: new Date().toISOString(),
    }, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" },
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
