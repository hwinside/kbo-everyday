import { NextRequest, NextResponse } from "next/server";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import { triggerLiveActivityStartForUser } from "@/lib/notifications/live-activity";

// 잠금화면 LA — 기존 유저 최애팀 변경 이벤트(마이페이지 팀 변경). 온보딩(/api/setup)과 달리
// 재설치 신호가 아니므로 clientInstallFresh=false — 현재 live/윈도우 최애팀 경기가 있으면
// 즉시 start를 *시도*하되, 카드 생존 증거(update 토큰/현재 device_key 구독/방금 claim)면 skip
// (중복 카드 방지). p2s 토큰이 아직 없으면 pending trigger로 남겨 register-start가 소비.
//
// 서버/원격 JS 범위 — 팀 변경은 profiles가 SSOT라 클라 입력을 신뢰하지 않고 서버가 재조회.
export async function POST(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified?.user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { status } = await triggerLiveActivityStartForUser(verified.user.id, {
      reason: "team_change",
      clientInstallFresh: false,
      eventMs: Date.now(),
    });
    return NextResponse.json({ success: true, status });
  } catch {
    // 부가 기능 — 실패해도 팀 변경 자체엔 영향 없음(다음 cron이 윈도우 내 복구).
    return NextResponse.json({ success: true, status: "failed" });
  }
}
