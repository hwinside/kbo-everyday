import { NextRequest, NextResponse } from "next/server";
import { resolvePlayer } from "@/lib/utils/resolve-player";
import { parseSituation, looksLikeAspNetError } from "@/lib/contextual-stats/situation-parser";

export const dynamic = "force-dynamic";

const KBO_PLAYER = "https://www.koreabaseball.com/Record/Player";
// KBO는 Referer가 koreabaseball.com이 아니면 IE 분기 HTML을 반환 (2026-05-20 referer drift).
const KBO_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
  Referer: "https://www.koreabaseball.com",
};

/**
 * 선수 상황별 스플릿 (선수 스탯 보강 V1 — 빌드 4: 투수 스플릿).
 * spec: specs/stats/player-stats-v1.md §5-3
 *
 * GET /api/player-situation?id=<kboId|raw>&pos=<position>
 *   - KBO PitcherDetail/Situation.aspx 파싱(parseSituation 재사용).
 *   - 투수: vs좌타 / vs우타 / 2아웃의 피안타율(AVG) + 삼진(SO) 반환.
 *   - 데이터 없으면 splits:[] (fail-closed — 화면은 살아남음).
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const rawId = searchParams.get("id");
  const pos = searchParams.get("pos") ?? "";
  if (!rawId) return NextResponse.json({ error: "id required" }, { status: 400 });

  const resolved = resolvePlayer(rawId);
  const numericId = resolved?.numericId ?? rawId;
  const role = pos === "투수" ? "pitcher" : "batter";

  try {
    const url = `${KBO_PLAYER}/${role === "batter" ? "HitterDetail" : "PitcherDetail"}/Situation.aspx?playerId=${numericId}`;
    const res = await fetch(url, { headers: KBO_HEADERS, cache: "no-store" });
    if (!res.ok) return NextResponse.json({ splits: [] });
    const html = await res.text();
    if (looksLikeAspNetError(html)) return NextResponse.json({ splits: [] });

    const tables = parseSituation(html, role);
    const pick = (rows: { label: string; AVG: string; SO: number }[], label: string) =>
      rows.find((r) => r.label === label) ?? null;

    // 투수: 손잡이별(Table 4) 좌타자/우타자 + 주자상황(Table 0) 득점권
    // (득점권은 KBO가 집계 행으로 직접 제공 — 만루보다 표본 안정적)
    const wanted: { label: string; row: { AVG: string; SO: number } | null }[] = [
      { label: "vs좌타", row: pick(tables.byHand, "좌타자") },
      { label: "vs우타", row: pick(tables.byHand, "우타자") },
      { label: "득점권", row: pick(tables.bases, "득점권") },
    ];

    const splits = wanted
      .filter((w) => w.row != null)
      .map((w) => ({ label: w.label, avg: w.row!.AVG, so: w.row!.SO }));

    return NextResponse.json(
      { splits },
      { headers: { "Cache-Control": "s-maxage=3600, stale-while-revalidate=7200" } },
    );
  } catch (e) {
    return NextResponse.json({ splits: [], error: (e as Error).message });
  }
}
