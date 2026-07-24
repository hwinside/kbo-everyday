import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { isAdminAuthedRequest } from "@/lib/admin/pin";

// 운영자 신고 조회 (2026-07-25) — reports 테이블은 그간 조회 UI가 없어 조용히 누적됐다.
// ticket 웃돈 신고는 auto_blind 트리거(post/comment/chat 전용) 대상이 아니라 여기서만 확인 가능.
export async function GET(req: NextRequest) {
  if (!isAdminAuthedRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const targetType = req.nextUrl.searchParams.get("targetType");

  // query-guard: bounded -- 운영 조회 전용, created_at desc 정렬 + 고정 200건 상한(페이지네이션 없음).
  let query = supabase
    .from("reports")
    .select("id, reporter_id, target_type, target_id, reason, detail, created_at")
    .order("created_at", { ascending: false })
    .limit(200);

  if (targetType) query = query.eq("target_type", targetType);

  const { data, error } = await query;
  if (error) return supabaseErrorResponse(error);

  const rows = data ?? [];

  // 신고자 닉네임 보강
  const reporterIds = [...new Set(rows.map((r) => r.reporter_id))];
  // query-guard: bounded -- rows≤200의 distinct reporter_id(≤200) unique-key(id) 조회.
  const { data: profiles } = reporterIds.length > 0
    ? await supabase.from("profiles").select("id, nickname").in("id", reporterIds)
    : { data: [] };
  const nicknameMap = new Map(
    (profiles ?? []).map((p: { id: string; nickname: string }) => [p.id, p.nickname]),
  );

  // ticket 신고는 양도글 요약(좌석/작성자) 보강
  const ticketIds = [
    ...new Set(rows.filter((r) => r.target_type === "ticket").map((r) => r.target_id)),
  ];
  // query-guard: bounded -- rows≤200의 distinct ticket target_id(≤200) unique-key(id) 조회.
  const { data: tickets } = ticketIds.length > 0
    ? await supabase
        .from("ticket_transfers")
        .select("id, author_id, seat_area, price, status")
        .in("id", ticketIds)
    : { data: [] };
  const ticketMap = new Map(
    (tickets ?? []).map((t: { id: number; author_id: string; seat_area: string; price: number; status: string }) => [t.id, t]),
  );

  const enriched = rows.map((r) => {
    const t = r.target_type === "ticket" ? ticketMap.get(r.target_id) ?? null : null;
    return {
      ...r,
      reporter_nickname: nicknameMap.get(r.reporter_id) ?? null,
      ticket: t,
    };
  });

  return NextResponse.json({ data: enriched });
}
