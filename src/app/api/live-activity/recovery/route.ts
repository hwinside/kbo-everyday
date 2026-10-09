import { createHash } from "node:crypto";
import { sendRecoveryWithReceipt } from "@/lib/notifications/live-activity-recovery-receipt";
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getProviderTokenSafe, sendLiveActivityPushToEnv } from "@/lib/notifications/apns";

// Protocol 1 exists only in the new native implementation (not a JS/app-build guess).
// No broadcast start, account fanout or fallback token/environment is permitted here.
export async function POST(req: NextRequest) {
  let body;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const { pushToStartToken, environment, protocol, action, gameId, channelId, challenge, noCard } = body ?? {};
  if (protocol !== 1 || typeof pushToStartToken !== "string" || !/^[a-f0-9]{32,1024}$/i.test(pushToStartToken) ||
      (environment !== "production" && environment !== "sandbox") ||
      (action !== "challenges" && action !== "claim")) {
    return NextResponse.json({ error: "unsupported recovery" }, { status: 400 });
  }
  if (action === "claim" && (noCard !== true || typeof gameId !== "string" || !/^\d{8}[A-Z]{4}\d$/.test(gameId) ||
      typeof channelId !== "string" || channelId.length > 256 || typeof challenge !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(challenge))) {
    return NextResponse.json({ error: "fresh no-card report required" }, { status: 400 });
  }
  // Resolve provider before consuming the durable attempt. Ambiguous delivery never releases it.
  const jwt = action === "claim" ? await getProviderTokenSafe() : null;
  if (action === "claim" && !jwt) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const { data, error } = await supabaseAdmin.rpc("live_activity_recovery_step", {
    p_action: action, p_token: pushToStartToken, p_environment: environment,
    p_game: action === "claim" ? gameId : null,
    p_channel: action === "claim" ? channelId : null,
    p_challenge: action === "claim" ? challenge : null,
  });
  if (error) return NextResponse.json({ error: "recovery unavailable" }, { status: 503 });
  if (action === "challenges") return NextResponse.json({ challenges: data?.challenges ?? [] });
  if (!data?.claimed) return NextResponse.json({ accepted: false });
  const result = await sendRecoveryWithReceipt(() => sendLiveActivityPushToEnv({
    pushToken: pushToStartToken,
    event: "start", attributesType: "KBOGameAttributes",
    attributes: { ...data.attributes, channelId: data.channelId, recoveryAttempt: data.attempt },
    contentState: data.contentState,
    inputPushChannel: data.channelId,
    alert: { title: "크보팬", body: "잠금화면 실시간 중계를 시작합니다" },
  }, environment, jwt!), async (receipt) => {
    // Exact token + channel generation + successful claim. First result wins.
    // ACK may race this UPDATE; do not read or overwrite ACK/claim fields.
    const { data: saved, error: saveError } = await supabaseAdmin
      .from("live_activity_device_recovery")
      .update(receipt)
      .eq("game_id", gameId)
      .eq("device_key", createHash("sha256").update(pushToStartToken).digest("hex"))
      .eq("environment", environment)
      .eq("channel_id", data.channelId)
      .eq("challenge", data.attempt)
      .not("restart_at", "is", null)
      .is("restart_apns_recorded_at", null)
      .select("game_id")
      .abortSignal(AbortSignal.timeout(2000));
    if (saveError || saved?.length !== 1) throw new Error("receipt not persisted");
  });
  // APNs receipt is NOT proof of a displayed card. The native survivor must ACK.
  return NextResponse.json({ accepted: result.ok });
}
