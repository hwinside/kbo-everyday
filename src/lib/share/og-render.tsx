import { ImageResponse } from "next/og";
import { getTeamColor, getTeamName } from "@/lib/utils/team";
import { sharePostTitle, type SharePost } from "@/lib/share/post-og";

export type OgVariant = "card" | "story";

const SIZES: Record<OgVariant, { width: number; height: number }> = {
  card: { width: 1200, height: 630 },
  story: { width: 1080, height: 1920 },
};

const BRAND_BG = "#0A0A0B";

/**
 * 게시글 OG 이미지를 그린다.
 * - 사진글: 첨부 사진을 풀블리드 배경 + 하단 그라데이션 + 제목
 * - 영상글: 팀/브랜드 배경 + ▶ 배지 + 제목 (OG는 정지 이미지라 프레임 대신 표시)
 * - BG 있는 짧은 일반글: 팀 컬러 배경 + 본문 오버레이 (피드 카드와 동일 톤)
 * - 그 외: 다크 브랜드 배경 + 제목
 */
export function renderPostOgImage(post: SharePost | null, variant: OgVariant = "card"): ImageResponse {
  const size = SIZES[variant];
  const title = sharePostTitle(post);
  const teamId = post?.authorTeamId ?? null;
  const teamColor = teamId ? getTeamColor(teamId) : "#E04050";
  const teamName = teamId ? getTeamName(teamId) : "";
  const author = post?.authorNickname ?? "";

  const photo = post && !post.isHidden ? post.imageUrls[0] : undefined;
  const hasVideo = Boolean(post && !post.isHidden && post.videoUrls.length > 0);
  const isBrandedText =
    Boolean(post) && !post!.isHidden && post!.contentType === "general" && !photo && !hasVideo;

  const footer = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        fontSize: 30,
        color: "#FFFFFF",
        fontWeight: 700,
      }}
    >
      <div style={{ display: "flex", color: teamColor }}>⚾ 크보팬</div>
      {author && <div style={{ display: "flex", color: "rgba(255,255,255,0.75)", fontWeight: 500 }}>· {author}</div>}
    </div>
  );

  let body: React.ReactElement;

  if (photo) {
    body = (
      <div style={{ display: "flex", width: "100%", height: "100%", position: "relative" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={photo} width={size.width} height={size.height} style={{ objectFit: "cover" }} alt="" />
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            display: "flex",
            flexDirection: "column",
            gap: 24,
            padding: 56,
            background: "linear-gradient(to top, rgba(0,0,0,0.85), rgba(0,0,0,0))",
          }}
        >
          <div style={{ display: "flex", fontSize: 52, fontWeight: 800, color: "#fff", lineHeight: 1.2 }}>
            {clamp(title, 70)}
          </div>
          {footer}
        </div>
      </div>
    );
  } else if (isBrandedText) {
    body = (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          width: "100%",
          height: "100%",
          padding: 64,
          background: `linear-gradient(135deg, ${teamColor} 0%, ${BRAND_BG} 100%)`,
        }}
      >
        {teamName ? (
          <div style={{ display: "flex", fontSize: 32, fontWeight: 700, color: "rgba(255,255,255,0.85)" }}>{teamName}</div>
        ) : (
          <div style={{ display: "flex" }} />
        )}
        <div style={{ display: "flex", fontSize: 60, fontWeight: 800, color: "#fff", lineHeight: 1.25 }}>
          {clamp(post!.content?.trim() || title, 90)}
        </div>
        {footer}
      </div>
    );
  } else {
    body = (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          width: "100%",
          height: "100%",
          padding: 64,
          background: BRAND_BG,
          position: "relative",
        }}
      >
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 8, background: teamColor }} />
        {hasVideo ? (
          <div style={{ display: "flex", alignItems: "center", gap: 18, fontSize: 34, color: teamColor, fontWeight: 700 }}>
            <div style={{ display: "flex" }}>▶</div>
            <div style={{ display: "flex", color: "rgba(255,255,255,0.7)" }}>영상</div>
          </div>
        ) : (
          <div style={{ display: "flex" }} />
        )}
        <div style={{ display: "flex", fontSize: 58, fontWeight: 800, color: "#fff", lineHeight: 1.25 }}>
          {clamp(title, 90)}
        </div>
        {footer}
      </div>
    );
  }

  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%", fontFamily: "sans-serif" }}>{body}</div>
    ),
    { ...size }
  );
}

function clamp(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
