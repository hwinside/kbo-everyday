import { NextRequest, NextResponse } from "next/server";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { resolveGameVenue } from "@/lib/venue-stories/venue-resolve";
import {
  decideManualAttendanceTeam,
  decideManualDiaryGame,
} from "@/lib/venue-diary/manual-upload";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface AttendanceMutationRow {
  id: number;
  user_id: string;
  game_id: string;
  source: "story_geofence" | "diary_manual";
  deleted_at: string | null;
}

async function loadOwnedRow(idParam: string, userId: string) {
  const id = Number(idParam);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return { response: NextResponse.json({ error: "id 형식 오류" }, { status: 400 }) };
  }
  const { data, error } = await supabase
    .from("venue_attendance")
    .select("id, user_id, game_id, source, deleted_at")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    return { response: NextResponse.json({ error: "직관 기록 조회 실패" }, { status: 500 }) };
  }
  if (!data) {
    return { response: NextResponse.json({ error: "직관 기록을 찾을 수 없어요" }, { status: 404 }) };
  }
  const row = data as AttendanceMutationRow;
  if (row.user_id !== userId) {
    return { response: NextResponse.json({ error: "수정 권한이 없습니다" }, { status: 403 }) };
  }
  return { id, row };
}

const MOVE_ERROR_RESPONSE: Record<string, { status: number; error: string }> = {
  not_found: { status: 404, error: "직관 기록을 찾을 수 없어요" },
  forbidden: { status: 403, error: "수정 권한이 없습니다" },
  source_immutable: { status: 403, error: "GPS 인증 기록은 수정할 수 없어요" },
  deleted: { status: 409, error: "삭제된 기록은 다시 등록한 뒤 수정해주세요" },
  target_duplicate: { status: 409, error: "이미 기록한 경기예요" },
  target_gps_conflict: { status: 409, error: "GPS 인증 기록이 있는 경기로는 옮길 수 없어요" },
  conflict: { status: 409, error: "직관 기록이 변경되어 다시 시도해주세요" },
};

/**
 * 직접 등록 기록 수정 — 경기 자체(gameId) 변경과 응원팀 변경을 모두 지원한다.
 * GPS 인증 기록은 어느 쪽도 수정할 수 없다(삭제만 허용).
 */
export async function PATCH(req: NextRequest, context: RouteContext) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }
  const owned = await loadOwnedRow((await context.params).id, verified.user.id);
  if ("response" in owned) return owned.response;
  if (owned.row.source !== "diary_manual") {
    return NextResponse.json(
      { error: "GPS 인증 기록은 수정할 수 없어요" },
      { status: 403 },
    );
  }
  if (owned.row.deleted_at != null) {
    return NextResponse.json(
      { error: "삭제된 기록은 다시 등록한 뒤 수정해주세요" },
      { status: 409 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청" }, { status: 400 });
  }
  // 경기 변경은 서버가 대상 경기를 다시 해석한다 — 클라이언트가 보낸 날짜·구장은 쓰지 않는다.
  const rawGameId = typeof body.gameId === "string" ? body.gameId.trim() : "";
  if (rawGameId !== "" && !/^\d{8}[A-Za-z0-9]+$/.test(rawGameId)) {
    return NextResponse.json({ error: "gameId 형식 오류" }, { status: 400 });
  }
  const targetGameId = rawGameId === "" ? owned.row.game_id : rawGameId;

  const venue = await resolveGameVenue(targetGameId);
  const gameDecision = decideManualDiaryGame(venue);
  if (!gameDecision.ok) {
    return NextResponse.json(
      { error: gameDecision.error },
      { status: gameDecision.status },
    );
  }
  // 응원팀은 항상 **이동 후** 경기의 참가팀 기준으로 검증한다(출처/팀 위조 차단).
  const teamDecision = decideManualAttendanceTeam(body.favoriteTeamId, venue);
  if (!teamDecision.ok) {
    return NextResponse.json(
      { error: teamDecision.error },
      { status: teamDecision.status },
    );
  }

  if (targetGameId !== owned.row.game_id) {
    // query-guard: bounded -- 본인 원장 한 행을 이동하고 id/status JSON만 반환
    const { data: moved, error: moveError } = await supabase.rpc(
      "move_venue_attendance_manual_game",
      {
        p_user_id: verified.user.id,
        p_id: owned.id,
        p_game_id: targetGameId,
        p_game_date: venue.gameDate,
        p_favorite_team_id: teamDecision.favoriteTeamId,
        p_stadium_name: venue.stadiumName,
      },
    );
    if (moveError) {
      return NextResponse.json({ error: "직관 기록 수정 실패" }, { status: 500 });
    }
    const result = (moved ?? {}) as { ok?: boolean; id?: number; error?: string };
    if (result.ok !== true) {
      const mapped = result.error ? MOVE_ERROR_RESPONSE[result.error] : undefined;
      if (mapped) {
        return NextResponse.json({ error: mapped.error }, { status: mapped.status });
      }
      return NextResponse.json({ error: "직관 기록 수정 실패" }, { status: 500 });
    }
    return NextResponse.json(
      { success: true, id: owned.id, gameId: targetGameId },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }

  const { data, error } = await supabase
    .from("venue_attendance")
    .update({
      favorite_team_id_snapshot: teamDecision.favoriteTeamId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", owned.id)
    .eq("user_id", verified.user.id)
    .eq("source", "diary_manual")
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: "직관 기록 수정 실패" }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "직관 기록이 변경되어 다시 시도해주세요" }, { status: 409 });
  }
  return NextResponse.json(
    { success: true, id: owned.id, gameId: targetGameId },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

/** GPS/직접 등록 원장만 삭제한다. venue_stories와 storage 미디어는 건드리지 않는다. */
export async function DELETE(req: NextRequest, context: RouteContext) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }
  const owned = await loadOwnedRow((await context.params).id, verified.user.id);
  if ("response" in owned) return owned.response;
  if (owned.row.deleted_at == null) {
    const now = new Date().toISOString();
    const { error } = await supabase
      .from("venue_attendance")
      .update({ deleted_at: now, updated_at: now })
      .eq("id", owned.id)
      .eq("user_id", verified.user.id)
      .is("deleted_at", null);
    if (error) {
      return NextResponse.json({ error: "직관 기록 삭제 실패" }, { status: 500 });
    }
  }
  return NextResponse.json(
    { success: true, id: owned.id },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
