import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  checkMoveReadiness,
  moveHref,
  publishedRegisterHref,
  filterVisibleMoves,
} from "@/lib/roster-moves/readiness";
import { notifyRegisterAnomaly, type RegisterAnomaly } from "@/lib/roster-moves/pending-alert";

// 팀별 최근 등록/말소 조회. 예: /api/roster-moves?teamId=6&days=30
// 노출 계약(2026-07-18 삼순 P0 반영):
// - 등록(register): published만 반환 — 준비(로스터+사진+히어로+상세페이지) 완료 전 미노출.
//   반환되는 등록 항목은 예외 없이 클릭 가능(href 항상 non-null).
// - 말소(deregister): 전부 반환 — readiness는 링크 유무만 결정(미준비 = 링크 생략).
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const teamId = Number(searchParams.get("teamId"));
  // days 상한 366 — 카드 '전체보기'가 시즌 전체 등록·말소를 조회하기 위해 90→366 상향(2026-07-19).
  const days = Math.min(Math.max(Number(searchParams.get("days")) || 30, 1), 366);
  if (!teamId) {
    return NextResponse.json({ error: "teamId required" }, { status: 400 });
  }

  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });

  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("roster_moves")
    .select("kbo_player_id, player_name, move_type, move_date, status, canonical_id")
    .eq("team_id", teamId)
    .gte("move_date", sinceStr)
    .order("move_date", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const visible = filterVisibleMoves(
    (data ?? []).map((m) => ({ ...m, moveType: m.move_type as "register" | "deregister" })),
  );

  const moves: {
    kboPlayerId: string;
    playerName: string;
    moveType: "register" | "deregister";
    moveDate: string;
    href: string | null;
  }[] = [];
  // published 등록 링크 불변식(삼순 P0 3차): 저장된 canonical_id로 href를 만들 수 없는
  // published 등록은 사용자에게 렌더하지 않고(fail-closed) 운영 알림으로 표면화한다.
  const anomalies: RegisterAnomaly[] = [];

  for (const m of visible) {
    if (m.moveType === "register") {
      // 등록(published만 도달): 저장된 canonical_id 기반 href — 항상 non-null이어야 한다.
      const href = publishedRegisterHref(m.canonical_id ?? null);
      if (!href) {
        // 링크 없는 published 등록 = 계약 위반 → 미노출(fail-closed) + 알림.
        anomalies.push({
          playerName: m.player_name,
          teamId,
          moveDate: m.move_date,
          kboPlayerId: m.kbo_player_id,
          canonicalId: m.canonical_id ?? null,
        });
        continue;
      }
      moves.push({
        kboPlayerId: m.kbo_player_id,
        playerName: m.player_name,
        moveType: m.moveType,
        moveDate: m.move_date,
        href,
      });
    } else {
      // 말소: readiness 따라 링크 생략 가능(링크 없는 텍스트 렌더 허용).
      moves.push({
        kboPlayerId: m.kbo_player_id,
        playerName: m.player_name,
        moveType: m.moveType,
        moveDate: m.move_date,
        href: moveHref(checkMoveReadiness(m.kbo_player_id)),
      });
    }
  }

  if (anomalies.length > 0) {
    console.error(
      `[roster-moves] published 등록 링크 불변식 위반 ${anomalies.length}건 — fail-closed(미반환): ` +
        anomalies.map((a) => `${a.playerName}(${a.kboPlayerId}/canonical=${a.canonicalId ?? "null"})`).join(", "),
    );
    // 드물게 발생하는 무결성 위반만 await(정상 요청은 anomalies=0이라 await 없음).
    await notifyRegisterAnomaly(anomalies);
  }

  return NextResponse.json({ teamId, days, moves });
}
