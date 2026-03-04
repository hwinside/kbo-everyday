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
      document.documentElement.style.setProperty("--accent", team.colorLight);
    };
    update();
    // localStorage 변경 감지 (다른 탭)
    window.addEventListener("storage", update);
    // 커스텀 이벤트 감지 (같은 탭)
    window.addEventListener("team-changed", update);
    return () => {
      window.removeEventListener("storage", update);
      window.removeEventListener("team-changed", update);
    };
  }, []);

  return null;
}
