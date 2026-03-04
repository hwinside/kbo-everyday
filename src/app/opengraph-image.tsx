import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "크보 에브리데이 — KBO 팬 커뮤니티";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
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

        {/* Logo area */}
        <div style={{ display: "flex", alignItems: "center", gap: "16px", marginBottom: "24px" }}>
          <span style={{ fontSize: "64px" }}>⚾</span>
          <span style={{ fontSize: "56px", fontWeight: 800, color: "white", letterSpacing: "-2px" }}>
            크보 에브리데이
          </span>
        </div>

        {/* Tagline */}
        <p style={{ fontSize: "28px", color: "#999", marginBottom: "40px" }}>
          KBO 팬을 위한 올인원 커뮤니티 플랫폼
        </p>

        {/* Feature pills */}
        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", justifyContent: "center" }}>
          {[
            "⚾ 실시간 스코어",
            "👤 683명 선수 프로필",
            "🔮 승부예측",
            "💬 팬 커뮤니티",
            "🎬 하이라이트",
            "🏟️ 구장가이드",
          ].map((f) => (
            <div
              key={f}
              style={{
                background: "rgba(255,255,255,0.08)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: "24px",
                padding: "10px 20px",
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
          kbo-everyday.vercel.app
        </p>
      </div>
    ),
    { ...size }
  );
}
