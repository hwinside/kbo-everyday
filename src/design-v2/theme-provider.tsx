/**
 * Design V2 Theme Provider (T1.2.1~T1.2.2)
 *
 * Spec: specs/design-v2-migration.md (v0.5)
 * Reference: specs/design-v2-reference/redesign/shared/shell.jsx (FROZEN)
 *
 * 역할:
 *   - `<html>` 또는 내부 wrapper 에 `data-design="v2"` + `data-team="..."` 세팅
 *   - tokens.css 의 CSS 변수가 자동으로 팀별로 오버라이드됨
 *   - useTeamTheme() 훅으로 현재 팀 slug + palette 제공
 */

"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import {
  TEAMS,
  type TeamMeta,
  type TeamSlug,
  getTeamBySlug,
} from "./TEAMS";
import { teamPalette, type TeamPalette } from "./team-palette";

interface ThemeContextValue {
  team: TeamMeta;
  palette: TeamPalette;
  slug: TeamSlug;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
  /** 팀 slug. null/undefined → neutral (KBO 블루) */
  teamSlug?: string | null;
  /** 팀 accent 강도 (0~10, 기본 6) */
  intensity?: number;
  /** 특정 요소에만 적용하고 싶을 때 scoped=true */
  scoped?: boolean;
  children: ReactNode;
}

/**
 * V2 디자인 시스템 Provider.
 *
 * 사용 예 (app-level):
 *   <html data-design="v2">  <-- SSR 에서 직접 세팅 (FOUC 방지, T1.2.3)
 *     <body>
 *       <ThemeProvider teamSlug={profile?.favorite_team}>...</ThemeProvider>
 *     </body>
 *   </html>
 *
 * scoped=true 면 `<div data-design="v2" data-team="...">` 로 감싸 scope 를 제한.
 */
export function ThemeProvider({
  teamSlug,
  intensity = 6,
  scoped = false,
  children,
}: ThemeProviderProps) {
  const team = getTeamBySlug(teamSlug);
  const palette = useMemo(() => teamPalette(team, intensity), [team, intensity]);

  // SSR cookie + CSR 초기 렌더 이후 document.documentElement 에 data-team 동기화
  // (scoped=false 일 때만)
  useEffect(() => {
    if (scoped) return;
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    root.setAttribute("data-design", "v2");
    root.setAttribute("data-team", team.slug);
    return () => {
      // cleanup 시 neutral 로 복귀 (SPA 라우트 전환 대비)
      root.setAttribute("data-team", "neutral");
    };
  }, [team.slug, scoped]);

  const ctx: ThemeContextValue = { team, palette, slug: team.slug };

  if (scoped) {
    return (
      <div data-design="v2" data-team={team.slug}>
        <ThemeContext.Provider value={ctx}>{children}</ThemeContext.Provider>
      </div>
    );
  }

  return <ThemeContext.Provider value={ctx}>{children}</ThemeContext.Provider>;
}

/** 현재 팀 테마 정보 (team + palette + slug) 반환. Provider 밖에선 neutral. */
export function useTeamTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx) return ctx;
  // Fallback: provider 없어도 crash 하지 않음
  const team = TEAMS.neutral;
  return { team, palette: teamPalette(team), slug: "neutral" };
}
