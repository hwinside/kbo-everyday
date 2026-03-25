"use client";

import { motion } from "framer-motion";
import { useState, useEffect } from "react";
import GlassCard from "@/components/ui/GlassCard";
import { calcBatterSaber, calcPitcherSaber, type CalcBatterSaber, type CalcPitcherSaber } from "@/lib/utils/sabermetrics-calc";
import {
  BATTER_ADVANCED, PITCHER_ADVANCED,
  getDefaultBatterAdvanced, getDefaultPitcherAdvanced,
  type BatterAdvanced, type PitcherAdvanced,
} from "@/lib/constants/sabermetrics";

function HotZone({ zones }: { zones: number[][] }) {
  const getColor = (v: number) => {
    if (v >= 0.8) return "bg-red-500";
    if (v >= 0.6) return "bg-orange-500";
    if (v >= 0.4) return "bg-yellow-500";
    if (v >= 0.2) return "bg-blue-400";
    return "bg-blue-700";
  };
  return (
    <div className="flex flex-col items-center gap-1">
      <p className="text-xs text-text-tertiary mb-1">타격 핫존</p>
      <div className="grid grid-cols-3 gap-1 w-28">
        {zones.flat().map((v, i) => (
          <div key={i} className={`aspect-square rounded-sm ${getColor(v)} flex items-center justify-center`}>
            <span className="text-[10px] font-bold text-white">{(v * 0.4 + 0.1).toFixed(3).slice(1)}</span>
          </div>
        ))}
      </div>
      <div className="flex gap-3 mt-1 text-[10px] text-text-tertiary">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-500" />강</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-yellow-500" />중</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-blue-700" />약</span>
      </div>
    </div>
  );
}

function PitchBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-text-secondary w-14 text-right">{label}</span>
      <div className="flex-1 h-4 bg-bg-tertiary rounded-full overflow-hidden">
        <motion.div initial={{ width: 0 }} animate={{ width: `${(value / max) * 100}%` }} transition={{ duration: 0.6, ease: "easeOut" }} className="h-full rounded-full" style={{ backgroundColor: color }} />
      </div>
      <span className="text-xs font-mono text-text-primary w-10 tabular-nums">{value.toFixed(value >= 1 ? 1 : 3)}</span>
    </div>
  );
}

function StatBox({ label, value, desc }: { label: string; value: string; desc: string }) {
  return (
    <div className="text-center">
      <p className="text-xs text-text-tertiary">{label}</p>
      <p className="text-lg font-bold text-text-primary tabular-nums">{value}</p>
      <p className="text-[10px] text-text-tertiary">{desc}</p>
    </div>
  );
}

function BatterStats({ data, teamColor }: { data: BatterAdvanced; teamColor: string }) {
  return (
    <div className="space-y-4">
      <GlassCard className="p-4">
        <h3 className="text-sm font-bold text-text-primary mb-3">📊 세이버메트릭스</h3>
        <div className="grid grid-cols-4 gap-3">
          <StatBox label="wRC+" value={String(data.wRC)} desc="득점 생산" />
          <StatBox label="OPS" value={data.OPS.toFixed(3)} desc="출루+장타" />
          <StatBox label="wOBA" value={data.wOBA.toFixed(3)} desc="가중 출루" />
          <StatBox label="WAR" value={data.WAR.toFixed(1)} desc="대체 선수 대비" />
          <StatBox label="ISO" value={data.ISO.toFixed(3)} desc="순수 장타력" />
          <StatBox label="BABIP" value={data.BABIP.toFixed(3)} desc="인플레이 타율" />
          <StatBox label="BB%" value={`${data.BB_pct}%`} desc="볼넷 비율" />
          <StatBox label="K%" value={`${data.K_pct}%`} desc="삼진 비율" />
        </div>
      </GlassCard>
      <div className="grid grid-cols-5 gap-3">
        <GlassCard className="col-span-2 p-4 flex items-center justify-center">
          {data.hotZone && <HotZone zones={data.hotZone} />}
        </GlassCard>
        <GlassCard className="col-span-3 p-4">
          <h3 className="text-sm font-bold text-text-primary mb-3">⚾ 구종별 타율</h3>
          <div className="space-y-2">
            {data.pitchStats.map((p) => (
              <PitchBar key={p.type} label={p.type} value={p.avg} max={0.4} color={teamColor} />
            ))}
          </div>
        </GlassCard>
      </div>
      <GlassCard className="p-4 overflow-x-auto">
        <h3 className="text-sm font-bold text-text-primary mb-3">🎯 구종별 상세</h3>
        <table className="w-full text-xs">
          <thead><tr className="text-text-tertiary border-b border-border">
            <th className="text-left py-1.5 pr-2">구종</th><th className="text-right py-1.5 px-2">타율</th><th className="text-right py-1.5 px-2">OPS</th><th className="text-right py-1.5 px-2">스윙%</th><th className="text-right py-1.5 pl-2">헛스윙%</th>
          </tr></thead>
          <tbody>{data.pitchStats.map((p) => (
            <tr key={p.type} className="border-b border-border/50">
              <td className="py-1.5 pr-2 font-medium text-text-primary">{p.type}</td>
              <td className="text-right py-1.5 px-2 tabular-nums text-text-primary">{p.avg.toFixed(3)}</td>
              <td className="text-right py-1.5 px-2 tabular-nums text-text-secondary">{p.ops.toFixed(3)}</td>
              <td className="text-right py-1.5 px-2 tabular-nums text-text-secondary">{p.swing_pct}%</td>
              <td className="text-right py-1.5 pl-2 tabular-nums text-text-secondary">{p.whiff_pct}%</td>
            </tr>
          ))}</tbody>
        </table>
      </GlassCard>
      <GlassCard className="p-4 overflow-x-auto">
        <h3 className="text-sm font-bold text-text-primary mb-3">🔥 상황별 기록</h3>
        <table className="w-full text-xs">
          <thead><tr className="text-text-tertiary border-b border-border">
            <th className="text-left py-1.5 pr-2">상황</th><th className="text-right py-1.5 px-2">타율</th><th className="text-right py-1.5 px-2">타석</th><th className="text-right py-1.5 px-2">홈런</th><th className="text-right py-1.5 pl-2">타점</th>
          </tr></thead>
          <tbody>{data.situational.map((s) => (
            <tr key={s.label} className="border-b border-border/50">
              <td className="py-1.5 pr-2 font-medium text-text-primary whitespace-nowrap">{s.label}</td>
              <td className="text-right py-1.5 px-2 tabular-nums font-semibold" style={{ color: s.avg >= 0.320 ? "#FF3B5C" : undefined }}>{s.avg.toFixed(3)}</td>
              <td className="text-right py-1.5 px-2 tabular-nums text-text-secondary">{s.pa}</td>
              <td className="text-right py-1.5 px-2 tabular-nums text-text-secondary">{s.hr}</td>
              <td className="text-right py-1.5 pl-2 tabular-nums text-text-secondary">{s.rbi}</td>
            </tr>
          ))}</tbody>
        </table>
      </GlassCard>
    </div>
  );
}

function PitcherStats({ data, teamColor }: { data: PitcherAdvanced; teamColor: string }) {
  return (
    <div className="space-y-4">
      <GlassCard className="p-4">
        <h3 className="text-sm font-bold text-text-primary mb-3">📊 세이버메트릭스</h3>
        <div className="grid grid-cols-4 gap-3">
          <StatBox label="FIP" value={data.FIP.toFixed(2)} desc="순수 투구력" />
          <StatBox label="xFIP" value={data.xFIP.toFixed(2)} desc="보정 FIP" />
          <StatBox label="WAR" value={data.WAR.toFixed(1)} desc="대체 선수 대비" />
          <StatBox label="WHIP" value={data.WHIP.toFixed(2)} desc="출루 허용" />
          <StatBox label="K/9" value={data.K9.toFixed(1)} desc="9이닝 삼진" />
          <StatBox label="BB/9" value={data.BB9.toFixed(1)} desc="9이닝 볼넷" />
          <StatBox label="LOB%" value={`${data.LOB_pct}%`} desc="잔루 처리" />
          <StatBox label="GB%" value={`${data.GB_pct}%`} desc="땅볼 비율" />
        </div>
      </GlassCard>
      <GlassCard className="p-4">
        <h3 className="text-sm font-bold text-text-primary mb-3">⚾ 구종 믹스</h3>
        <div className="space-y-2 mb-4">
          {data.pitchMix.map((p) => (
            <PitchBar key={p.type} label={p.type} value={p.pct} max={50} color={teamColor} />
          ))}
        </div>
        <table className="w-full text-xs">
          <thead><tr className="text-text-tertiary border-b border-border">
            <th className="text-left py-1.5 pr-2">구종</th><th className="text-right py-1.5 px-2">비율</th><th className="text-right py-1.5 px-2">구속</th><th className="text-right py-1.5 px-2">회전수</th><th className="text-right py-1.5 pl-2">헛스윙%</th>
          </tr></thead>
          <tbody>{data.pitchMix.map((p) => (
            <tr key={p.type} className="border-b border-border/50">
              <td className="py-1.5 pr-2 font-medium text-text-primary">{p.type}</td>
              <td className="text-right py-1.5 px-2 tabular-nums text-text-secondary">{p.pct}%</td>
              <td className="text-right py-1.5 px-2 tabular-nums text-text-primary font-semibold">{p.velo}km</td>
              <td className="text-right py-1.5 px-2 tabular-nums text-text-secondary">{p.spin}</td>
              <td className="text-right py-1.5 pl-2 tabular-nums text-text-secondary">{p.whiff_pct}%</td>
            </tr>
          ))}</tbody>
        </table>
      </GlassCard>
      <GlassCard className="p-4 overflow-x-auto">
        <h3 className="text-sm font-bold text-text-primary mb-3">🔥 상황별 피안타율</h3>
        <table className="w-full text-xs">
          <thead><tr className="text-text-tertiary border-b border-border">
            <th className="text-left py-1.5 pr-2">상황</th><th className="text-right py-1.5 px-2">피안타율</th><th className="text-right py-1.5 px-2">타석</th><th className="text-right py-1.5 px-2">삼진</th><th className="text-right py-1.5 pl-2">볼넷</th>
          </tr></thead>
          <tbody>{data.situational.map((s) => (
            <tr key={s.label} className="border-b border-border/50">
              <td className="py-1.5 pr-2 font-medium text-text-primary whitespace-nowrap">{s.label}</td>
              <td className="text-right py-1.5 px-2 tabular-nums font-semibold" style={{ color: s.avg <= 0.220 ? "#22c55e" : undefined }}>{s.avg.toFixed(3)}</td>
              <td className="text-right py-1.5 px-2 tabular-nums text-text-secondary">{s.pa}</td>
              <td className="text-right py-1.5 px-2 tabular-nums text-text-secondary">{s.k}</td>
              <td className="text-right py-1.5 pl-2 tabular-nums text-text-secondary">{s.bb}</td>
            </tr>
          ))}</tbody>
        </table>
      </GlassCard>
    </div>
  );
}

export default function NicheStats({ playerId, position, teamColor, playerName, season = 2026 }: { playerId: string; position: string; teamColor: string; playerName?: string; season?: number }) {
  const isPitcher = position === "투수";
  const [realSaber, setRealSaber] = useState<CalcBatterSaber | CalcPitcherSaber | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (season !== 2025 || !playerId) { setRealSaber(null); return; }
    setLoading(true);
    fetch(`/api/player-stats?id=${playerId}&pos=${encodeURIComponent(position)}`)
      .then(r => r.json())
      .then(d => {
        if (d.stats) {
          const saber = isPitcher
            ? calcPitcherSaber({ ...d.stats, so: d.stats.so ?? 0 })
            : calcBatterSaber({ ...d.stats, so: d.stats.so ?? 0 });
          setRealSaber(saber);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [season, playerId, isPitcher, position]);

  if (season === 2025) {
    if (loading) return <div className="text-center py-8 text-text-tertiary text-sm">계산 중...</div>;
    if (!realSaber) return <div className="glass-card p-4 mb-4 text-center text-text-tertiary text-sm">2025 세이버메트릭스 데이터를 찾을 수 없습니다</div>;

    if (isPitcher) {
      const ps = realSaber as CalcPitcherSaber;
      return (
        <div className="space-y-4">
          <GlassCard className="p-4">
            <h3 className="text-sm font-bold text-text-primary mb-3">📊 2025 세이버메트릭스 (실데이터 기반)</h3>
            <div className="grid grid-cols-4 gap-3">
              <StatBox label="FIP" value={ps.FIP.toFixed(2)} desc="순수 투구력" />
              <StatBox label="WHIP" value={typeof ps.WHIP === "number" ? ps.WHIP.toFixed(2) : ps.WHIP} desc="출루 허용" />
              <StatBox label="K/9" value={ps.K9.toFixed(1)} desc="9이닝 삼진" />
              <StatBox label="BB/9" value={ps.BB9.toFixed(1)} desc="9이닝 볼넷" />
              <StatBox label="HR/9" value={ps.HR9.toFixed(1)} desc="9이닝 피홈런" />
              <StatBox label="K%" value={`${ps.K_pct}%`} desc="삼진 비율" />
              <StatBox label="BB%" value={`${ps.BB_pct}%`} desc="볼넷 비율" />
            </div>
            <p className="text-[10px] text-text-tertiary mt-3 text-center">※ KBO 공식 기록 기반 계산값</p>
          </GlassCard>
        </div>
      );
    }

    const bs = realSaber as CalcBatterSaber;
    return (
      <div className="space-y-4">
        <GlassCard className="p-4">
          <h3 className="text-sm font-bold text-text-primary mb-3">📊 2025 세이버메트릭스 (실데이터 기반)</h3>
          <div className="grid grid-cols-4 gap-3">
            <StatBox label="wRC+" value={String(bs.wRC_plus)} desc="득점 생산" />
            <StatBox label="OPS" value={bs.OPS.toFixed(3)} desc="출루+장타" />
            <StatBox label="wOBA" value={bs.wOBA.toFixed(3)} desc="가중 출루" />
            <StatBox label="ISO" value={bs.ISO.toFixed(3)} desc="순수 장타력" />
            <StatBox label="BABIP" value={bs.BABIP.toFixed(3)} desc="인플레이 타율" />
            <StatBox label="BB%" value={`${bs.BB_pct}%`} desc="볼넷 비율" />
            <StatBox label="K%" value={`${bs.K_pct}%`} desc="삼진 비율" />
            <StatBox label="OBP" value={bs.OBP.toFixed(3)} desc="출루율" />
            <StatBox label="WAR" value={bs.WAR.toFixed(1)} desc="대체 선수 대비 (추정)" />
          </div>
          <p className="text-[10px] text-text-tertiary mt-3 text-center">※ KBO 공식 기록 기반 계산값 (WAR는 근사치, 핫존/구종별은 Statiz 연동 예정)</p>
        </GlassCard>
      </div>
    );
  }

  // 2026 — 시즌 개막 전
  return (
    <div className="glass-card p-6 mb-4 text-center">
      <p className="text-lg mb-1">⚾</p>
      <p className="text-sm font-bold text-text-primary">2026 시즌 개막 후 확인 가능합니다</p>
      <p className="text-xs text-text-tertiary mt-1">개막일: 2026년 3월 28일 (토)</p>
    </div>
  );
}
