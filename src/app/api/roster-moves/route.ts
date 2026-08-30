import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  checkMoveReadiness,
  moveHref,
  publishedRegisterHref,
  filterVisibleMoves,
} from "@/lib/roster-moves/readiness";
import { notifyRegisterAnomaly, type RegisterAnomaly } from "@/lib/roster-moves/pending-alert";

// 팀별 시즌 등록/말소 조회. 예: /api/roster-moves?teamId=6
// 조회 하한은 rolling window가 아니라 명시적 시즌 시작일(삼순 P0: rolling 365 → 시즌 키).
// 2026 KBO 정규시즌 개막 = 2026-03-28. 시즌이 바뀌면 이 상수(또는 시즌 키 매핑)를 갱신한다.
const SEASON_START = "2026-03-28";
// 노출 계약(2026-07-18 삼순 P0 반영):
// - 등록(register): published만 반환 — 준비(로스터+사진+히어로+상세페이지) 완료 전 미노출.
//   반환되는 등록 항목은 예외 없이 클릭 가능(href 항상 non-null).
// - 말소(deregister): 전부 반환 — readiness는 링크 유무만 결정(미준비 = 링크 생략).
export const dynamic = "force-dynamic";

// CDN 캐시 계약(삼순 승인 스코프, 2026-08-30 Vercel 비용 트랙 PR②):
// 성공 200만 s-maxage=300 — 등록/말소는 하루 단위로 바뀌는 데이터라 5분 지연 허용.
// 인증/쿠키 무관 공용 응답(팀별 동일)이라 공용 캐시 오염 없음. 브라우저는
// max-age=0으로 캐시 금지(클라 재방문 시 CDN만 타게) — swr 없음(추가 노화 방지).
// 실패/에러는 no-store(실패 응답 고착 방지).
const CACHE_OK = "public, max-age=0, s-maxage=300";
const CACHE_NONE = "no-store";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const teamId = Number(searchParams.get("teamId"));
  if (!teamId) {
    return NextResponse.json(
      { error: "teamId required" },
      { status: 400, headers: { "Cache-Control": CACHE_NONE } },
    );
  }

  // rolling window 제거(삼순 P0): 항상 시즌 시작일부터 조회 → "시즌 전체 현황" 계약이
  // 날짜 경과와 무관하게 성립한다(rolling 365는 개막 초반 이력이 시즌 중 잘려나감).
  const sinceStr = SEASON_START;

  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("roster_moves")
    .select("kbo_player_id, player_name, move_type, move_date, status, canonical_id")
    .eq("team_id", teamId)
    .gte("move_date", sinceStr)
    .order("move_date", { ascending: false });

  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500, headers: { "Cache-Control": CACHE_NONE } },
    );
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

  return NextResponse.json(
    { teamId, seasonStart: SEASON_START, moves },
    { headers: { "Cache-Control": CACHE_OK } },
  );
}
