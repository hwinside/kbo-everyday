import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { verifyAccessToken } from "@/lib/auth/verified-user";
import { PREF_KEYS, DEFAULT_PREFS, type NotificationPrefs } from "@/lib/notifications/prefs";
import { NextRequest, NextResponse } from "next/server";

// PR④ per-user 부트 번들 — 부팅 시 유저별로 각각 나가던
// /api/me + /api/push/prefs + /api/game-chat/prefs 3콜을 1콜로 합친다.
// (before 실측: /api/me 218K/24h — client-dedupe.ts 주석, observability 8/19)
//
// 계약:
// - 인증·프로필 응답은 /api/me 와 동일 셰이프 유지({ profile }) + prefs/gameChatVisible 추가.
//   기존 /api/me 는 구 클라이언트용으로 그대로 둔다 (제거 금지).
// - prefs 조회 실패는 전체 부트를 죽이지 않는다: prefs=null 로 내리고 소비자는
//   종전 /api/push/prefs GET 으로 폴백한다 (에러를 디폴트 성공처럼 숨기지 않는
//   PR #206 계약은 그 폴백 경로가 그대로 보존).
// - gameChatVisible 은 profiles.game_chat_enabled 파생 — 별도 쿼리 불필요.
//   profile 이 없으면 null (소비자 폴백).

const SELECT_PREF_COLS = PREF_KEYS.join(",");

export async function GET(request: NextRequest) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    return NextResponse.json({ profile: null, prefs: null, gameChatVisible: null, error: "missing_config" }, { status: 500 });
  }

  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.replace("Bearer ", "");
  if (!token) {
    return NextResponse.json({ profile: null, prefs: null, gameChatVisible: null }, { status: 401 });
  }

  try {
    const user = await verifyAccessToken(token);
    if (!user) {
      return NextResponse.json({ profile: null, prefs: null, gameChatVisible: null }, { status: 401 });
    }

    const adminClient = getSupabaseAdmin();
    const [profileRes, prefsRes] = await Promise.all([
      adminClient.from("profiles").select("*").eq("id", user.id).maybeSingle(),
      adminClient.from("notification_prefs").select(SELECT_PREF_COLS).eq("user_id", user.id).maybeSingle(),
    ]);

    const profile = (profileRes.data as { game_chat_enabled?: boolean | null } | null) ?? null;
    // prefs 에러 → null (부트는 살리고, 소비자가 종전 GET 폴백에서 에러를 그대로 본다)
    const prefs: NotificationPrefs | null = prefsRes.error
      ? null
      : { ...DEFAULT_PREFS, ...((prefsRes.data as Partial<NotificationPrefs> | null) ?? {}) };
    const gameChatVisible = profile ? profile.game_chat_enabled !== false : null;

    return NextResponse.json({ profile, prefs, gameChatVisible });
  } catch {
    return NextResponse.json({ profile: null, prefs: null, gameChatVisible: null, error: "server_error" }, { status: 500 });
  }
}
