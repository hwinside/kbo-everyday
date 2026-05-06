import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import playersRoster from "@/lib/constants/players-roster.json";

export const revalidate = 300; // 5분 ISR 캐시

// ============================================================================
// Roster SSOT Fortress (specs/roster-ssot-fortress.md v0.2)
// ============================================================================
// 원칙: "Static only roster admission, Supabase extension only"
// - src/lib/constants/players-roster.json = roster SSOT (816명, 단일 진실 소스)
// - Supabase players_roster = extension field only (core field 보호)
// - 신규 선수는 반드시 static JSON PR 경유 (Supabase 단독 추가 불가)
//
// Core field (보호, Supabase override 금지):
//   kboId, name, team, teamId, position, backNo
// Extension field (Supabase override OK):
//   photoUrl (향후 확장 예정)
// ============================================================================

const EXPECTED_ROSTER_COUNT = 816; // specs §3.2: 이 값과 정확히 일치해야 정상

interface RosterPlayer {
  kboId: string;
  name: string;
  team: string;
  teamId: number;
  position: string;
  backNo: string;
}

function staticFallback(): RosterPlayer[] {
  return (playersRoster as Array<{
    kboId: string;
    name: string;
    team: string;
    teamId: number;
    position: string;
    backNo: string;
  }>).map((p) => ({
    kboId: String(p.kboId),
    name: p.name,
    team: p.team,
    teamId: p.teamId,
    position: p.position,
    backNo: p.backNo ?? "",
  }));
}

export async function GET() {
  const staticPlayers = staticFallback();

  // specs §3.2: prod 런타임 모니터 — 선수 수 ≠ EXPECTED_COUNT 시 경고 로그
  // (Sentry/Slack 알림은 별도 미들웨어/헬스체크 엔드포인트에서 처리)
  if (staticPlayers.length !== EXPECTED_ROSTER_COUNT) {
    console.error(
      `[roster-ssot-monitor] static roster count mismatch: expected=${EXPECTED_ROSTER_COUNT} actual=${staticPlayers.length}`,
    );
  }

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("players_roster")
      .select("kbo_id, name, team, team_id, position, back_no")
      .order("name", { ascending: true });

    if (error || !data || data.length === 0) {
      return NextResponse.json(staticPlayers);
    }

    // v0.2 merge rule: Static Base + Supabase Extension Only
    //
    // 1) static JSON을 base로 세팅 (core field 완전성 보장)
    // 2) Supabase는 extension field만 덮어씀 (core field 보호)
    // 3) Supabase 단독 kboId (static에 없는 선수) = 무조건 skip
    //    → 신규 선수는 static JSON PR 경유 필수
    //
    // 결과: Supabase가 공란이든 틀렸든, static JSON이 방패 역할
    const merged = new Map<string, RosterPlayer>();

    // Step 1: static base 고정
    for (const p of staticPlayers) {
      if (p.kboId) merged.set(p.kboId, p);
    }

    // Step 2: Supabase extension만 적용 (현재 extension field는 확장 예정)
    //         static에 존재하는 kboId에 한해서만 update
    for (const sb of data) {
      const kboId = String(sb.kbo_id);
      const base = merged.get(kboId);
      if (!base) {
        // static에 없는 kboId = admission 거부 (static only admission 원칙)
        // 신규 선수(신인/외국인 영입)는 static JSON PR로 먼저 반영되어야 함
        continue;
      }
      // 현재 schema상 Supabase가 가진 extension field는 없음.
      // 향후 photoUrl, height, weight 등 추가 시 아래에 명시적으로 override
      // 절대로 spread(...sb)로 통째 override하지 말 것 — core field 오염 위험
      //
      // 예시 (향후):
      //   merged.set(kboId, {
      //     ...base,                                    // core field 보호
      //     photoUrl: sb.photo_url ?? base.photoUrl,    // extension override
      //   });
      //
      // Phase 1: core field만 있으므로 base 그대로 유지
      void sb; // no-op (linter 억제)
    }

    const out = Array.from(merged.values()).sort((a, b) =>
      a.name.localeCompare(b.name, "ko"),
    );

    return NextResponse.json(out);
  } catch {
    return NextResponse.json(staticPlayers);
  }
}
