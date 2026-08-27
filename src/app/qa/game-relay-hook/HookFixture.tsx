"use client";

import { useEffect, useState } from "react";
import { useGameRelay } from "@/lib/hooks/useGameRelay";

function frameUpdatedAt(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "none";
  const updatedAt = (payload as { updatedAt?: unknown }).updatedAt;
  return typeof updatedAt === "string" ? updatedAt : "none";
}

export default function HookFixture() {
  const [status, setStatus] = useState<"live" | "final">("live");
  const [gameId, setGameId] = useState("qa-game-prime");
  const [liveFrameCount, setLiveFrameCount] = useState(0);
  const [detailFrameCount, setDetailFrameCount] = useState(0);
  const [liveFrameUpdated, setLiveFrameUpdated] = useState("none");
  const [detailFrameUpdated, setDetailFrameUpdated] = useState("none");
  const { data, events } = useGameRelay(gameId, status === "live", 3000, 0, status === "final", {
    onLiveFrame: (payload) => {
      setLiveFrameCount((count) => count + 1);
      setLiveFrameUpdated(frameUpdatedAt(payload));
    },
    onDetailFrame: (payload) => {
      setDetailFrameCount((count) => count + 1);
      setDetailFrameUpdated(frameUpdatedAt(payload));
    },
  });

  useEffect(() => {
    setGameId("qa-game-a");
  }, []);

  return (
    <main>
      <button data-qa="finish-game" onClick={() => setStatus("final")}>경기 종료</button>
      <button data-qa="switch-game" onClick={() => setGameId("qa-game-b")}>경기 전환</button>
      <span data-qa="relay-status">{status}</span>
      <span data-qa="relay-updated">{data?.updatedAt ?? "none"}</span>
      <span data-qa="relay-game">{data?.gameId ?? "none"}</span>
      <span data-qa="event-count">{events.length}</span>
      <span data-qa="live-frame-count">{liveFrameCount}</span>
      <span data-qa="detail-frame-count">{detailFrameCount}</span>
      <span data-qa="live-frame-updated">{liveFrameUpdated}</span>
      <span data-qa="detail-frame-updated">{detailFrameUpdated}</span>
    </main>
  );
}
