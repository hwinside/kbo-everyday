"use client";

import { useState } from "react";
import { useGameRelay } from "@/lib/hooks/useGameRelay";

export default function HookFixture() {
  const [status, setStatus] = useState<"live" | "final">("live");
  const [gameId, setGameId] = useState("qa-game-a");
  const { data } = useGameRelay(gameId, status === "live", 60_000, 0, status === "final");

  return (
    <main>
      <button data-qa="finish-game" onClick={() => setStatus("final")}>경기 종료</button>
      <button data-qa="switch-game" onClick={() => setGameId("qa-game-b")}>경기 전환</button>
      <span data-qa="relay-status">{status}</span>
      <span data-qa="relay-updated">{data?.updatedAt ?? "none"}</span>
      <span data-qa="relay-game">{data?.gameId ?? "none"}</span>
    </main>
  );
}
