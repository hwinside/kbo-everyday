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
 * 선수 상황별 스플릿 (선수 스탯 보강 V1 — 빌드 4: 투수/타자 스플릿).
 * spec: specs/stats/player-stats-v1.md §5-3
 *
 * GET /api/player-situation?id=<kboId|raw>&pos=<position>
 *   - KBO Pitcher/HitterDetail Situation.aspx 파싱(parseSituation 재사용).
 *   - 투수: vs좌타 / vs우타 / 득점권 (피안타율 AVG + 삼진 SO)
 *   - 타자: vs좌투 / vs우투 / 득점권 (타율 AVG + 홈런 HR + 타점 RBI)
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
    type Row = { label: string; AVG: string; HR: number; RBI?: number; SO: number };
    const pick = (rows: Row[], label: string) => rows.find((r) => r.label === label) ?? null;

    // 손잡이별(Table 4) + 주자상황(Table 0) 득점권. 득점권은 KBO 집계 행 직접 제공.
    // 투수는 상대 손잡이(좌타자/우타자), 타자는 상대 투수 손잡이(좌투수/우투수).
    const handLeft = role === "pitcher" ? "좌타자" : "좌투수";
    const handRight = role === "pitcher" ? "우타자" : "우투수";
    const labelLeft = role === "pitcher" ? "vs좌타" : "vs좌투";
    const labelRight = role === "pitcher" ? "vs우타" : "vs우투";

    const wanted: { label: string; row: Row | null }[] = [
      { label: labelLeft, row: pick(tables.byHand, handLeft) },
      { label: labelRight, row: pick(tables.byHand, handRight) },
      { label: "득점권", row: pick(tables.bases, "득점권") },
    ];

    // 투수=피안타율(avg)+삼진(so), 타자=타율(avg)+홈런(hr)+타점(rbi). 컴포넌트가 role별로 선택.
    const splits = wanted
      .filter((w) => w.row != null)
      .map((w) => ({ label: w.label, avg: w.row!.AVG, hr: w.row!.HR, rbi: w.row!.RBI ?? 0, so: w.row!.SO }));

    return NextResponse.json(
      { splits },
      { headers: { "Cache-Control": "s-maxage=3600, stale-while-revalidate=7200" } },
    );
  } catch (e) {
    return NextResponse.json({ splits: [], error: (e as Error).message });
  }
}
