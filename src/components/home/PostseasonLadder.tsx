"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { LadderSnapshot } from "@/lib/postseason/ladder";
import { isRegularSeasonFinal } from "@/lib/constants/season";

type Payload = LadderSnapshot & { active: true };
const states = { waiting: "대진 대기", scheduled: "경기 예정", live: "진행 중", complete: "시리즈 종료", changed: "일정 변경" };
export default function PostseasonLadder() {
  const enabled = isRegularSeasonFinal();
  const [data, setData] = useState<Payload | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
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
  const round = data.rounds.find(r=>r.id === (selected ?? data.currentStage)) ?? data.rounds[0];
  return <section className="mb-3 rounded-2xl border border-black/5 bg-bg-secondary p-4 dark:border-white/10" aria-label={`${data.season} 포스트시즌 대진`}>
    <div className="flex items-center justify-between gap-2">
      <h2 className="text-base font-bold text-text-primary">{data.season} 포스트시즌</h2>
      <span className="text-xs text-text-secondary">{states[round.state]}</span>
    </div>
    <div className="relative mt-4 grid grid-cols-4 gap-1" role="group" aria-label="시리즈 선택">
      {data.rounds.map((r,i)=><div key={r.id} className="min-w-0" style={{paddingTop: `${(3-i)*22}px`}}>
        <button type="button" onClick={()=>setSelected(r.id)} aria-pressed={round.id === r.id} aria-controls="postseason-round-detail"
          className={`min-h-16 w-full rounded-xl border px-1 py-2 text-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${round.id === r.id ? "border-accent bg-accent/10 text-accent" : "border-black/10 text-text-secondary dark:border-white/10"}`}>
          <span className="block text-xs font-bold">{r.label}{i<3 ? " ↗" : ""}</span>
          <span className="mt-1 block break-keep text-[10px] leading-4">{r.participants.length ? r.participants.map(p=>p.name).join(" · ") : r.placeholder}</span>
          {r.id === data.currentStage && <span className="mt-1 block text-[10px]">현재 단계</span>}
        </button>
      </div>)}
    </div>
    <p className="mt-2 text-[11px] text-text-tertiary">WC 4위 어드밴티지는 아래 실제 경기 승수에 포함하지 않아요.</p>
    <div id="postseason-round-detail" className="mt-3 rounded-xl bg-black/[0.03] p-3 dark:bg-white/5" aria-live="polite">
      <h3 className="text-sm font-bold text-text-primary">{round.label} · {states[round.state]}</h3>
      {round.participants.length > 0 && <p className="mt-1 text-sm text-text-secondary">{round.participants.map(p=>`${p.name} ${p.wins}승`).join(" — ")}{round.draws > 0 ? ` · ${round.draws}무` : ""}</p>}
      {round.winnerId && <p className="mt-1 text-sm font-semibold text-accent">{round.participants.find(p=>p.teamId === round.winnerId)?.name} {round.id === "7" ? "우승" : "진출"}</p>}
      {!round.games.length && <p className="mt-2 text-xs text-text-tertiary">{round.placeholder} · 등록된 일정이 없어요. 대진과 일정은 확정 후 표시해요.</p>}
      <ul className="mt-2 space-y-2">
        {round.games.map(g=><li key={g.gameId}>
          {g.notNeeded ? <p className="text-xs text-text-tertiary">{g.displayLabel} · 시리즈 종료로 미개최</p> : <Link href={`/games/${g.gameId}`} className="block rounded-lg p-2 text-xs text-text-secondary hover:bg-black/5 dark:hover:bg-white/5">
            <span className="block font-semibold text-text-primary">{g.displayLabel} · {g.date.slice(4,6)}/{g.date.slice(6,8)} {g.time}　→</span>
            <span className="mt-1 block">{g.awayName} vs {g.homeName} · {g.stadium} · {g.status === "final" ? `${g.awayScore}:${g.homeScore} 종료` : g.status === "live" ? `${g.awayScore}:${g.homeScore} 진행 중` : g.status === "cancelled" ? "취소·재편성 확인 중" : "예정"}</span>
          </Link>}
        </li>)}
      </ul>
    </div>
    <p className="mt-2 text-[10px] text-text-tertiary">등록 일정 기준 · 일정 변경 시 다시 반영돼요.</p>
  </section>;
}
