import { NextRequest, NextResponse } from "next/server";
import { resolvePlayer } from "@/lib/utils/resolve-player";
import { parsePlayerStats, type PlayerDetailStats } from "@/lib/kbo/player-stats-parser";

const KBO_BASE = "https://www.koreabaseball.com";

async function fetchPlayerStats(playerId: string, position: string) {
  const isPitcher = position === "투수";
  const url = isPitcher
    ? `${KBO_BASE}/Record/Player/PitcherDetail/Basic.aspx?playerId=${playerId}`
    : `${KBO_BASE}/Record/Player/HitterDetail/Basic.aspx?playerId=${playerId}`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Referer: KBO_BASE },
    next: { revalidate: 3600 },
  });
  // 업스트림 장애(403/5xx)는 throw → 500 no-store. '기록 없음'과 구분(삼순 NO-GO #3).
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const html = await res.text();
  // 파서는 부분/비정상 HTML(테이블·필수 열 미달)을 throw로 fail-close 한다(qa:player-stats-parser 실행 검증).
  return parsePlayerStats(html, isPitcher);
}

const cache: Record<string, { data: PlayerDetailStats; ts: number }> = {};

export async function GET(req: NextRequest) {
  const rawId = req.nextUrl.searchParams.get("id");
  const pos = req.nextUrl.searchParams.get("pos") || "타자";
  if (!rawId) return NextResponse.json({ error: "id required" }, { status: 400 });

  // KBO 공식 사이트는 숫자 ID만 인식 → resolvePlayer가 외국인 alpha→numeric 변환 처리
  const id = resolvePlayer(rawId)?.numericId || rawId;

  const cacheKey = `player-${id}-${pos}`;
  // 엣지 s-maxage=60 상한 — upstream revalidate(1h)+인메모리(1h)+엣지 누적을 막는다(삼순 NO-GO #2, 30~60s 상한안).
  // SWR 미사용, 장애 응답 캐시 금지.
  const OK_HEADERS = { "Cache-Control": "public, s-maxage=60" } as const;
  const cached = cache[cacheKey];
  if (cached && Date.now() - cached.ts < 3600000) {
    return NextResponse.json({ stats: cached.data, cached: true }, { headers: OK_HEADERS });
  }

  try {
    const stats = await fetchPlayerStats(id, pos);
    if (stats) cache[cacheKey] = { data: stats, ts: Date.now() };
    // stats null = 명시적 '기록이 없습니다.'만 도달(장애는 throw) — 동일 60초 캐시.
    return NextResponse.json({ stats, cached: false }, { headers: OK_HEADERS });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message, stats: null }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
