import { NextRequest, NextResponse } from "next/server";
import { fetchGamesUserFacing } from "@/lib/crawler/games-user-facing";
import { latestRelayLine } from "@/lib/notifications/relay-line";

// 라이브 경기 문자중계 한 줄(lastPlay) 수집 예산 — 잠금 LA·홈위젯과 동일 소스(/api/game-relay →
// latestRelayLine). 부가 정보이므로 짧은 예산으로 끊고, 실패는 해당 경기 줄만 안 뜨게 격리한다.
// /api/games 는 s-maxage=30 엣지 캐시 뒤에 있어 이 self-fetch 는 캐시 미스 시에만(분당 ~2회/날짜),
// 라이브 경기 수만큼만 발생한다.
const RELAY_LINE_TIMEOUT_MS = 2_000;

async function fetchLastPlays(origin: string, liveGameIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (liveGameIds.length === 0) return out;
  const settled = await Promise.allSettled(
    liveGameIds.map(async (gameId) => {
      const r = await fetch(`${origin}/api/game-relay?gameId=${encodeURIComponent(gameId)}`, {
        cache: "no-store",
        headers: { "User-Agent": "kbo-everyday-games-api/1.0" },
        signal: AbortSignal.timeout(RELAY_LINE_TIMEOUT_MS),
      });
      if (!r.ok) return null;
      const j = await r.json().catch(() => null);
      const line = latestRelayLine(j);
      return line ? { gameId, line } : null;
    }),
  );
  for (const s of settled) {
    if (s.status === "fulfilled" && s.value) out.set(s.value.gameId, s.value.line);
  }
  return out;
}

export async function GET(request: NextRequest) {
  const date = request.nextUrl.searchParams.get("date");
  if (!date || !/^\d{8}$/.test(date)) {
    return NextResponse.json({ error: "date param required (YYYYMMDD)" }, { status: 400 });
  }

  try {
    // user-facing 하이브리드: Naver primary(스코어/이닝/상태) + KBO enrich(BSO/주자/투타) 병렬 병합.
    const games = await fetchGamesUserFacing(date);
    // 경기탭 라이브 카드 문자중계 한 줄(잠금화면 LA 패리티) — 실패해도 목록 응답은 그대로.
    const lastPlays = await fetchLastPlays(
      request.nextUrl.origin,
      games.filter((g) => g.status === "live").map((g) => g.gameId),
    ).catch(() => new Map<string, string>());
    const gamesWithLastPlay = games.map((g) =>
      g.status === "live" && lastPlays.has(g.gameId) ? { ...g, lastPlay: lastPlays.get(g.gameId) } : g,
    );
    return NextResponse.json({
      date,
      count: gamesWithLastPlay.length,
      games: gamesWithLastPlay,
    }, {
      headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" },
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
