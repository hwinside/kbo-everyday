"use client";
import { useEffect, useState } from "react";
import PostseasonOverview from "./PostseasonOverview";
import type { LadderSnapshot } from "@/lib/postseason/ladder";
import { isRegularSeasonFinal } from "@/lib/constants/season";

type Payload = LadderSnapshot & { active: true };
export default function PostseasonLadder() {
  const enabled = isRegularSeasonFinal();
  const [data, setData] = useState<Payload | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!enabled) { setLoading(false); return; }
    let disposed = false;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (document.hidden || disposed) return;
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch("/api/postseason", { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("Schedule unavailable");
        const body = await response.json();
        if (disposed) return;
        if (body.active === false) setData(null);
        else {
          if (!Array.isArray(body.rounds) || body.rounds.length !== 4 || !Number.isFinite(body.fetchedAt) || Date.now()-body.fetchedAt > 120_000 || body.fetchedAt > Date.now()+5000) throw new Error("Invalid schedule");
          setData(body);
        }
        setFailed(false);
      } catch (e) {
        if (!disposed && (e as Error).name !== "AbortError") { setFailed(true); setData(null); }
      } finally {
        if (!disposed) {
          setLoading(false);
          clearTimeout(timer);
          timer = setTimeout(refresh, 60_000);
        }
      }
    };
    const visibility = () => {
      clearTimeout(timer);
      if (document.hidden) controller?.abort();
      else void refresh();
    };
    void refresh();
    document.addEventListener("visibilitychange", visibility);
    return () => { disposed = true; clearTimeout(timer); controller?.abort(); document.removeEventListener("visibilitychange", visibility); };
  }, [enabled]);
  if (!enabled) return null;
  if (loading) return <div className="mb-3 rounded-2xl bg-bg-secondary p-4 text-sm text-text-tertiary" role="status">포스트시즌 일정 확인 중…</div>;
  if (failed) return <div className="mb-3 rounded-2xl bg-bg-secondary p-4 text-sm text-text-tertiary" role="status">포스트시즌 일정을 불러오지 못했어요. 잠시 후 다시 확인할게요.</div>;
  if (!data) return null;
  return <PostseasonOverview data={data} />;
}
