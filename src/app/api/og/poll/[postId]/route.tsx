import { ImageResponse } from "next/og";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { fetchPollCore } from "@/lib/community/poll";
import { getTeamBySlug } from "@/lib/constants/teams";
import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";

// current SSOT(팀명/선수명) 해석용 — refId 로 현재 이름을 우선, 실패 시 snapshot fallback.
const OG_ROSTER_NAME_BY_KBOID = new Map(
  (PLAYERS_ROSTER as { kboId: string; name: string }[]).map((p) => [String(p.kboId), p.name]),
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/og/poll/[postId] — 투표 전용 OG 카드 (spec §5, §4)
 *
 * 질문 + **작성순(position)** 선지 미리보기 + 진행중/마감 배지 + n명 참여.
 * 득표순 노출 금지(진행중 우회 노출 차단) → 항상 작성순, 수치(vote_count) 미노출.
 *
 * NOTE(S3): 팀/선수 선지의 로고·이름 SSOT(ref_id) 렌더는 S3(목록/OG 마감)에서
 * 태그 렌더러를 붙인다. S1 은 label_snapshot ?? ref_id fallback 텍스트만 표시.
 */
const SIZE = { width: 1200, height: 630 };
const BRAND_BG = "#0A0A0B";
const ACCENT = "#E04050";

function clamp(text: string, max: number): string {
  const t = (text ?? "").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function optionLabel(o: { label: string | null; refId: string | null; kind: string }): string {
  // current SSOT 먼저(팀명/선수명 변경 즉시 반영), 실패 시 snapshot label → refId fallback.
  if (o.kind === "team" && o.refId) {
    const team = getTeamBySlug(o.refId);
    if (team) return team.name;
  } else if (o.kind === "player" && o.refId) {
    const name = OG_ROSTER_NAME_BY_KBOID.get(o.refId);
    if (name) return name;
  }
  return o.label || o.refId || (o.kind === "etc" ? "선택지" : o.kind);
}

export async function GET(_req: Request, { params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;
  const id = Number(postId);
  const admin = getSupabaseAdmin();
  const core = Number.isInteger(id) && id > 0 ? await fetchPollCore(admin, id) : null;

  const title = core ? clamp(core.title, 80) : "투표를 찾을 수 없습니다";
  const previewOptions = core ? core.options.slice(0, 4) : [];
  const moreCount = core ? Math.max(0, core.options.length - previewOptions.length) : 0;
  const badge = core?.closed ? "마감" : "진행중";
  const badgeColor = core?.closed ? "#6B7280" : ACCENT;

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          padding: 64,
          background: BRAND_BG,
          position: "relative",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 8, background: ACCENT }} />

        {/* header: brand + badge */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 32, fontWeight: 700, color: ACCENT }}>
            ⚾ 크보팬 · 투표
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              fontSize: 28,
              fontWeight: 700,
              color: "#fff",
              background: badgeColor,
              borderRadius: 999,
              padding: "8px 24px",
            }}
          >
            {badge}
          </div>
        </div>

        {/* question */}
        <div style={{ display: "flex", marginTop: 36, fontSize: 56, fontWeight: 800, color: "#fff", lineHeight: 1.2 }}>
          {title}
        </div>

        {/* options preview (작성순) */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 36, flex: 1 }}>
          {previewOptions.map((o, i) => (
            <div
              key={o.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 18,
                fontSize: 34,
                fontWeight: 600,
                color: "#fff",
                background: "rgba(255,255,255,0.08)",
                border: "1px solid rgba(255,255,255,0.14)",
                borderRadius: 16,
                padding: "18px 28px",
              }}
            >
              <div style={{ display: "flex", color: ACCENT, fontWeight: 800 }}>{i + 1}</div>
              <div style={{ display: "flex" }}>{clamp(optionLabel(o), 30)}</div>
            </div>
          ))}
          {moreCount > 0 && (
            <div style={{ display: "flex", fontSize: 28, color: "rgba(255,255,255,0.6)", paddingLeft: 8 }}>
              +{moreCount}개 선지 더
            </div>
          )}
        </div>

        {/* footer: n명 참여 */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 32, fontWeight: 700, color: "rgba(255,255,255,0.85)" }}>
          👥 {core?.voterCount ?? 0}명 참여
        </div>
      </div>
    ),
    { ...SIZE },
  );
}
