import { ImageResponse } from "next/og";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "edge";
export const alt = "크보팬 초대";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OGImage({ params }: { params: Promise<{ code: string }> }) {
  const { code: rawCode } = await params;
  const code = rawCode?.replace(/^KBO-/i, "KEUBO-");

  let inviterNickname: string | null = null;
  try {
    const supabase = getSupabaseAdmin();
    const { data: invitation } = await supabase
      .from("invitations")
      .select("inviter_id")
      .eq("code", code)
      .single();

    if (invitation?.inviter_id) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("nickname")
        .eq("id", invitation.inviter_id)
        .single();
      inviterNickname = profile?.nickname || null;
    }
  } catch {
    // fallback
  }

  const headline = inviterNickname
    ? `${inviterNickname}님이 크보팬에 초대했어요 ⚾`
    : "크보팬에 초대받았어요 ⚾";

  return new ImageResponse(
    (
      <div
        style={{
          background: "#0A0A0B",
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "sans-serif",
          position: "relative",
        }}
      >
        {/* Gradient accent */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: "4px",
            background: "linear-gradient(90deg, #FF6B35, #FF4444, #FF6B35)",
          }}
        />

        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: "16px", marginBottom: "32px" }}>
          <span style={{ fontSize: "72px" }}>⚾</span>
          <span style={{ fontSize: "56px", fontWeight: 800, color: "white", letterSpacing: "-2px" }}>
            크보팬
          </span>
        </div>

        {/* Headline */}
        <p style={{ fontSize: "36px", fontWeight: 700, color: "#fff", marginBottom: "16px", textAlign: "center" }}>
          {headline}
        </p>

        {/* Subtext */}
        <p style={{ fontSize: "24px", color: "#999" }}>
          내 팀 경기, 오늘 할 얘기는 여기서 끝.
        </p>

        {/* Feature pills */}
        <div style={{ display: "flex", gap: "12px", marginTop: "40px" }}>
          {["실시간 스코어", "승부예측", "팬 커뮤니티"].map((f) => (
            <div
              key={f}
              style={{
                background: "rgba(255,255,255,0.08)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: "24px",
                padding: "10px 24px",
                fontSize: "20px",
                color: "#ddd",
              }}
            >
              {f}
            </div>
          ))}
        </div>

        {/* URL */}
        <p style={{ position: "absolute", bottom: "24px", fontSize: "18px", color: "#555" }}>
          keubo.fan
        </p>
      </div>
    ),
    { ...size }
  );
}
