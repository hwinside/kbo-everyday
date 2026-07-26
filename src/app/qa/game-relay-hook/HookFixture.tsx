"use client";

import { useState } from "react";
import { useGameRelay } from "@/lib/hooks/useGameRelay";

export default function HookFixture() {
  const [status, setStatus] = useState<"live" | "final">("live");
  const { data } = useGameRelay("qa-game", status === "live", 60_000, 0, status === "final");

  return (
    <main>
      <button data-qa="finish-game" onClick={() => setStatus("final")}>경기 종료</button>
      <span data-qa="relay-status">{status}</span>
      <span data-qa="relay-updated">{data?.updatedAt ?? "none"}</span>
    </main>
  );
}
