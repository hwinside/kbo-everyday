import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { verifyAccessToken } from "@/lib/auth/verified-user";
import { PREF_KEYS, DEFAULT_PREFS, type NotificationPrefs } from "@/lib/notifications/prefs";
import { NextRequest, NextResponse } from "next/server";

// PR④ per-user 부트 번들 — 부팅 시 유저별로 각각 나가던
// /api/me + /api/push/prefs (+ /api/game-chat/prefs) 를 1콜로 합친다.
//
// 계약:
// - 인증·프로필 응답은 /api/me 와 동일 셰이프 유지({ profile }) + prefs 추가.
//   기존 /api/me 는 구 클라이언트용으로 그대로 둔다 (제거 금지).
// - prefs 는 ?include=prefs 일 때만 조회 (삼순 NO-GO ② 반영: 네이티브 런타임만
//   요청 — 웹 유저의 notification_prefs DB read/payload 증가 0).
// - prefs 조회 실패는 전체 부트를 죽이지 않는다: prefs=null 로 내리고 소비자는
//   종전 /api/push/prefs GET 으로 폴백한다 (에러를 디폴트 성공처럼 숨기지 않는
//   PR #206 계약은 그 폴백 경로에 보존).
// - game-chat 노출은 profiles.game_chat_enabled 파생이라 별도 필드 불필요 —
//   profile 자체(select *)에 포함되어 클라가 파생한다.

const SELECT_PREF_COLS = PREF_KEYS.join(",");

export async function GET(request: NextRequest) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    return NextResponse.json({ profile: null, prefs: null, error: "missing_config" }, { status: 500 });
  }

  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.replace("Bearer ", "");
  if (!token) {
    return NextResponse.json({ profile: null, prefs: null }, { status: 401 });
  }

  const includePrefs = request.nextUrl.searchParams.get("include") === "prefs";

  try {
    const user = await verifyAccessToken(token);
    if (!user) {
      return NextResponse.json({ profile: null, prefs: null }, { status: 401 });
    }

    const adminClient = getSupabaseAdmin();
    const [profileRes, prefsRes] = await Promise.all([
      adminClient.from("profiles").select("*").eq("id", user.id).maybeSingle(),
      includePrefs
        ? adminClient.from("notification_prefs").select(SELECT_PREF_COLS).eq("user_id", user.id).maybeSingle()
        : Promise.resolve(null),
    ]);

    const profile = profileRes.data ?? null;
    // prefs: 미요청 → null. 조회 에러 → null (부트는 살리고, 소비자가 종전 GET 폴백에서 에러를 그대로 본다)
    const prefs: NotificationPrefs | null = prefsRes && !prefsRes.error
      ? { ...DEFAULT_PREFS, ...((prefsRes.data as Partial<NotificationPrefs> | null) ?? {}) }
      : null;

    return NextResponse.json({ profile, prefs });
  } catch {
    return NextResponse.json({ profile: null, prefs: null, error: "server_error" }, { status: 500 });
  }
}
