"use client";

import { useEffect } from "react";
import { TEAMS } from "@/lib/constants/teams";

/** 팀 accent 색상을 CSS 변수로 동적 적용 */
export default function TeamAccent() {
  useEffect(() => {
    const update = () => {
      const teamId = localStorage.getItem("kbo-my-team");
      if (!teamId) return;
      const team = TEAMS.find(t => t.id === Number(teamId));
      if (!team) return;
      const isDark = document.documentElement.classList.contains("dark");
      document.documentElement.style.setProperty("--accent", isDark ? team.colorLight : team.colorPrimary);
    };
    update();
    // localStorage 변경 감지 (다른 탭)
    window.addEventListener("storage", update);
    // 커스텀 이벤트 감지 (같은 탭)
    window.addEventListener("team-changed", update);
    // 테마 변경 감지
    window.addEventListener("theme-changed", update);
    // MutationObserver: .dark 클래스 변경 감지
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => {
      window.removeEventListener("storage", update);
      window.removeEventListener("team-changed", update);
      window.removeEventListener("theme-changed", update);
      observer.disconnect();
    };
  }, []);

  return null;
}
