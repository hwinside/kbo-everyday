/**
 * V2 Playground — 토큰/프리미티브 시각 QA (T1.5.1a)
 *
 * Spec: specs/design-v2-migration.md (v0.5)
 * Access: `?v2=1` 쿠키 세팅 후 `/v2/playground` (middleware 가드)
 * Lockdown: 내부자만 접근 가능 (일반 유저는 middleware 가 차단)
 *
 * 이 단계에서는 빈 셸만 — 프리미티브 12~18 종은 T1.4.x 에서 구현 후 여기 렌더.
 */

import { ThemeProvider } from "@/design-v2/theme-provider";
import { TEAMS } from "@/design-v2/TEAMS";
import "@/design-v2/tokens.css";

export const metadata = {
  title: "Design V2 Playground",
  robots: "noindex,nofollow", // 유저 노출 금지
};

export default function PlaygroundPage() {
  const slugs = Object.values(TEAMS).map((t) => t.slug);

  return (
    <ThemeProvider teamSlug="neutral" scoped>
      <div
        style={{
          minHeight: "100vh",
          background: "var(--bg-0)",
          color: "var(--text-1)",
          padding: "24px 16px 80px",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'SF Pro', 'Pretendard', system-ui, sans-serif",
        }}
      >
        <header style={{ marginBottom: 24 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: 1.2,
              color: "var(--text-3)",
              textTransform: "uppercase",
              marginBottom: 4,
            }}
          >
            Design V2 · Playground
          </div>
          <h1
            style={{
              fontSize: 24,
              fontWeight: 900,
              letterSpacing: -0.5,
              margin: 0,
            }}
          >
            Team Theme Matrix
          </h1>
          <p
            style={{
              fontSize: 13,
              color: "var(--text-2)",
              marginTop: 8,
              lineHeight: 1.5,
            }}
          >
            11 teams × primitives (Phase 1 완료 시 전체 렌더).
            <br />
            현재: T1.5.1a 빈 셸. 프리미티브 18종 구현 후 T1.5.1b 에서 채움.
          </p>
        </header>

        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: 12,
          }}
        >
          {slugs.map((slug) => {
            const team = TEAMS[slug as keyof typeof TEAMS];
            return (
              <div
                key={slug}
                data-design="v2"
                data-team={slug}
                style={{
                  background: "var(--bg-2)",
                  border: "1px solid var(--line)",
                  borderRadius: 14,
                  padding: "14px 16px",
                  position: "relative",
                  overflow: "hidden",
                }}
              >
                {/* Team color swatch */}
                <div
                  style={{
                    height: 48,
                    borderRadius: 8,
                    background: "var(--team-primary)",
                    marginBottom: 10,
                    position: "relative",
                  }}
                >
                  <div
                    style={{
                      position: "absolute",
                      right: 6,
                      top: 6,
                      padding: "2px 6px",
                      borderRadius: 4,
                      background: "var(--team-light)",
                      color: "#000",
                      fontSize: 9,
                      fontWeight: 800,
                    }}
                  >
                    light
                  </div>
                </div>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 800,
                    color: "var(--text-1)",
                    letterSpacing: -0.3,
                  }}
                >
                  {team.name}
                </div>
                <div
                  style={{
                    fontSize: 10,
                    color: "var(--text-3)",
                    marginTop: 2,
                    fontFamily: "ui-monospace, monospace",
                  }}
                >
                  {slug} · #{team.id}
                </div>
                <div
                  style={{
                    fontSize: 10,
                    color: "var(--text-3)",
                    marginTop: 6,
                    fontFamily: "ui-monospace, monospace",
                  }}
                >
                  {team.primary}
                  <br />
                  {team.light}
                </div>
              </div>
            );
          })}
        </section>

        <footer
          style={{
            marginTop: 48,
            padding: "16px 0",
            borderTop: "1px solid var(--line)",
            fontSize: 11,
            color: "var(--text-3)",
            lineHeight: 1.6,
          }}
        >
          <div>
            <strong style={{ color: "var(--status-win)" }}>🔒 FROZEN:</strong>{" "}
            tokens.css · team-palette.ts · TEAMS.ts · contrast.ts · ThemeProvider · middleware
          </div>
          <div style={{ marginTop: 4 }}>
            <strong style={{ color: "var(--status-warn)" }}>⏳ TODO:</strong>{" "}
            Primitives 18종 (T1.4.1 ~ T1.4.18) + AdSlot (T1.4.19~20)
          </div>
          <div style={{ marginTop: 4 }}>
            <strong style={{ color: "var(--status-live)" }}>🚨 Lockdown:</strong>{" "}
            Design Freeze Gate 전까지 유저 노출 금지. Admin cohort UI 비활성.
          </div>
        </footer>
      </div>
    </ThemeProvider>
  );
}
