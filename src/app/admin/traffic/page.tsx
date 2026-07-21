"use client";

import { useState, useEffect, useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

type TrafficRow = { day: string; platform: string; pv: number; uv: number };
type TrafficResp = {
  since: string;
  days: number;
  rows: TrafficRow[];
  totals: Record<string, { pv: number; uv: number }>;
  devices: Record<string, number>;
  dwell: Record<string, { sessions: number; avgMs: number; medianMs: number }>;
  versions: Record<string, { version: string; devices: number }[]>;
};
// Store chart rank at view time. rank=null → outside the chart window;
// ChartRank=null → that source fetch failed.
type ChartRank = { rank: number | null; chartSize: number } | null;
type RankingsResp = {
  fetchedAt: string;
  ios: { sports: ChartRank; overall: ChartRank };
  android: { sports: ChartRank; overall: ChartRank };
};
type WatchStat = { todayDevices: number; peakDevices: number; totalHits: number };
type WatchResp = {
  since: string;
  days: number;
  rows: { day: string; platform: string; devices: number; hits: number }[];
  wear: WatchStat;
  apple: WatchStat;
};

// Display order + labels + colors for known platforms. Unknown (pre-tagging
// rows) is shown last and muted so it never reads as real "web" traffic.
const PLATFORMS: { key: string; label: string; color: string }[] = [
  { key: "ios_native", label: "iOS 앱", color: "#0A84FF" },
  { key: "android_native", label: "안드 앱", color: "#3DDC84" },
  { key: "pwa", label: "PWA", color: "#A855F7" },
  { key: "web", label: "웹", color: "#F59E0B" },
  { key: "native", label: "앱(기타)", color: "#64D2FF" },
  { key: "unknown", label: "기록 전", color: "#48484A" },
];

const PERIODS = [
  { days: 1, label: "오늘" },
  { days: 7, label: "7일" },
  { days: 30, label: "30일" },
];

function getPin(): string {
  if (typeof window === "undefined") return "";
  return sessionStorage.getItem("admin_pin") || "";
}

const tooltipStyle = {
  contentStyle: {
    background: "#1C1C1F",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: "8px",
  },
  labelStyle: { color: "#8E8E93" },
};

function fmt(n: number): string {
  return n.toLocaleString("ko-KR");
}

function fmtRank(c: ChartRank): string {
  if (!c) return "조회 실패";
  if (c.rank == null) return `${c.chartSize}위 밖`;
  return `${c.rank}위`;
}

function fmtDur(ms: number): string {
  if (!ms || ms < 1000) return "0초";
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}분 ${sec}초` : `${sec}초`;
}

export default function TrafficPage() {
  const [days, setDays] = useState(7);
  const [resp, setResp] = useState<TrafficResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [watch, setWatch] = useState<WatchResp | null>(null);
  const [rankings, setRankings] = useState<RankingsResp | null>(null);
  const [rankLoading, setRankLoading] = useState(true);
  const [rankRefresh, setRankRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/admin/traffic?days=${days}`, { headers: { "x-admin-pin": getPin() } })
      .then((r) => {
        if (!r.ok) throw new Error(`API ${r.status}`);
        return r.json();
      })
      .then((d: TrafficResp) => {
        if (!cancelled) setResp(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  // 앱스토어 순위 (조회 시점) — Apple RSS·Play 탑차트를 요청 시점에 라이브 조회.
  useEffect(() => {
    let cancelled = false;
    setRankLoading(true);
    fetch(`/api/admin/app-rankings`, { headers: { "x-admin-pin": getPin() } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: RankingsResp | null) => {
        if (!cancelled && d) setRankings(d);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setRankLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rankRefresh]);

  // 워치(갤워치 Wear OS + 애플워치) 앱 사용 계측 — 미들웨어가 UA로 적재한 일자·플랫폼버 집계.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/admin/watch-activity?days=${days}`, { headers: { "x-admin-pin": getPin() } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: WatchResp | null) => {
        if (!cancelled) setWatch(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [days]);

  // Platforms that actually appear in this window, in display order.
  const activePlatforms = useMemo(() => {
    const present = new Set(Object.keys(resp?.totals ?? {}));
    return PLATFORMS.filter((p) => present.has(p.key));
  }, [resp]);

  // Pivot rows → one record per day with a column per platform (for stacked bars).
  const chartData = useMemo(() => {
    if (!resp) return [];
    const byDay: Record<string, Record<string, number>> = {};
    for (const r of resp.rows) {
      const d = (byDay[r.day] ??= {});
      d[r.platform] = Number(r.pv);
    }
    return Object.keys(byDay)
      .sort()
      .map((day) => ({ day: day.slice(5), ...byDay[day] }));
  }, [resp]);

  // Daily active app devices (DAU): per-day DISTINCT visitor_id from native
  // shells. admin_traffic_daily already returns daily uv per platform, so iOS
  // and Android active devices come straight from rows.
  const appDauData = useMemo(() => {
    if (!resp) return [];
    const byDay: Record<string, { ios: number; aos: number }> = {};
    for (const r of resp.rows) {
      if (r.platform === "ios_native") (byDay[r.day] ??= { ios: 0, aos: 0 }).ios += Number(r.uv);
      else if (r.platform === "android_native" || r.platform === "native")
        (byDay[r.day] ??= { ios: 0, aos: 0 }).aos += Number(r.uv);
    }
    return Object.keys(byDay)
      .sort()
      .map((day) => ({ day: day.slice(5), ios: byDay[day].ios, aos: byDay[day].aos }));
  }, [resp]);

  // App version share per native app (active distinct devices per version).
  // Android merges the legacy 'native' bucket; each list sorted by device count.
  const versionsByApp = useMemo(() => {
    const v = resp?.versions ?? {};
    const ios = [...(v.ios_native ?? [])].sort((a, b) => b.devices - a.devices);
    const aosMap: Record<string, number> = {};
    for (const r of [...(v.android_native ?? []), ...(v.native ?? [])]) {
      aosMap[r.version] = (aosMap[r.version] ?? 0) + r.devices;
    }
    const aos = Object.entries(aosMap)
      .map(([version, devices]) => ({ version, devices }))
      .sort((a, b) => b.devices - a.devices);
    return { ios, aos };
  }, [resp]);

  const totalPv = useMemo(
    () => Object.values(resp?.totals ?? {}).reduce((s, t) => s + t.pv, 0),
    [resp],
  );
  const appPv = useMemo(() => {
    const t = resp?.totals ?? {};
    return (t.ios_native?.pv ?? 0) + (t.android_native?.pv ?? 0) + (t.native?.pv ?? 0);
  }, [resp]);
  const appShare = totalPv > 0 ? Math.round((appPv / totalPv) * 100) : 0;

  // Cumulative unique app devices (all-time DISTINCT visitor_id from native shells).
  const dev = resp?.devices ?? {};
  const iosDevices = dev.ios_native ?? 0;
  const aosDevices = (dev.android_native ?? 0) + (dev.native ?? 0);
  const totalDevices = iosDevices + aosDevices;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">트래픽</h1>
          <p className="text-sm text-[#8E8E93] mt-1">플랫폼별 페이지뷰 · 방문자</p>
        </div>
        <div className="flex gap-1 p-1 rounded-xl bg-white/5">
          {PERIODS.map((p) => (
            <button
              key={p.days}
              onClick={() => setDays(p.days)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                days === p.days ? "bg-[#6366F1] text-white" : "text-[#8E8E93] hover:text-white"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="glass-card p-4 text-sm text-red-400">데이터 로드 실패: {error}</div>
      )}

      {/* Store chart rankings at view time (Apple RSS / Play top charts) */}
      <div className="glass-card p-4">
        <div className="flex items-baseline justify-between flex-wrap gap-1">
          <h2 className="text-sm font-semibold">📈 앱스토어 순위 (조회 시점)</h2>
          <button
            onClick={() => setRankRefresh((n) => n + 1)}
            disabled={rankLoading}
            className="text-xs text-[#8E8E93] hover:text-white disabled:opacity-50"
          >
            {rankings
              ? `조회 ${new Date(rankings.fetchedAt).toLocaleTimeString("ko-KR", {
                  hour: "2-digit",
                  minute: "2-digit",
                })} · 새로고침`
              : "새로고침"}
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3 mt-3">
          {(
            [
              { label: "iOS 앱스토어", color: "#0A84FF", data: rankings?.ios },
              { label: "구글 플레이", color: "#3DDC84", data: rankings?.android },
            ] as const
          ).map((os) => (
            <div key={os.label}>
              <p className="text-xs font-medium" style={{ color: os.color }}>
                {os.label}
              </p>
              <div className="mt-2 space-y-1.5">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs text-[#8E8E93]">스포츠</span>
                  <span className="text-xl font-bold">
                    {rankLoading ? "—" : fmtRank(os.data?.sports ?? null)}
                  </span>
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="text-xs text-[#8E8E93]">무료 전체</span>
                  <span className="text-xl font-bold">
                    {rankLoading ? "—" : fmtRank(os.data?.overall ?? null)}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="glass-card p-4">
          <p className="text-xs text-[#8E8E93]">총 페이지뷰</p>
          <p className="text-2xl font-bold mt-1">{loading ? "—" : fmt(totalPv)}</p>
        </div>
        <div className="glass-card p-4">
          <p className="text-xs text-[#8E8E93]">앱 비중</p>
          <p className="text-2xl font-bold mt-1 text-[#0A84FF]">{loading ? "—" : `${appShare}%`}</p>
        </div>
        {PLATFORMS.filter((p) => ["ios_native", "android_native"].includes(p.key)).map((p) => (
          <div key={p.key} className="glass-card p-4">
            <p className="text-xs text-[#8E8E93]">{p.label} PV</p>
            <p className="text-2xl font-bold mt-1" style={{ color: p.color }}>
              {loading ? "—" : fmt(resp?.totals[p.key]?.pv ?? 0)}
            </p>
          </div>
        ))}
      </div>

      {/* Cumulative unique app devices — installed+opened+logged-in devices,
          NOT store downloads (undercounts; visitor_id resets on reinstall). */}
      <div className="glass-card p-4">
        <div className="flex items-baseline justify-between flex-wrap gap-1">
          <h2 className="text-sm font-semibold">앱 고유 기기수 (누적)</h2>
          <p className="text-xs text-[#8E8E93]">앱 실행·로그인 기준 · 스토어 다운로드와 다름</p>
        </div>
        <div className="grid grid-cols-3 gap-3 mt-3">
          <div>
            <p className="text-xs text-[#8E8E93]">전체</p>
            <p className="text-2xl font-bold mt-1">{loading ? "—" : fmt(totalDevices)}</p>
          </div>
          <div>
            <p className="text-xs text-[#8E8E93]">iOS 앱</p>
            <p className="text-2xl font-bold mt-1 text-[#0A84FF]">{loading ? "—" : fmt(iosDevices)}</p>
          </div>
          <div>
            <p className="text-xs text-[#8E8E93]">안드 앱</p>
            <p className="text-2xl font-bold mt-1 text-[#3DDC84]">{loading ? "—" : fmt(aosDevices)}</p>
          </div>
        </div>
      </div>

      {/* 워치(갤워치 Wear OS + 애플워치) 앱 사용 — 미들웨어가 UA(kbo-everyday-wear/watch)로 계측.
          devices = distinct 해시IP(대략의 워치 대수), hits = 워치 API 호출량. */}
      <div className="glass-card p-4">
        <div className="flex items-baseline justify-between flex-wrap gap-1 mb-3">
          <h2 className="text-sm font-semibold">⌚ 워치 활성 (Wear OS · 애플워치)</h2>
          <p className="text-xs text-[#8E8E93]">API 호출 기준 · 대수는 IP 기반 근사치</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {[
            { label: "갤워치 (Wear OS)", color: "#3DDC84", s: watch?.wear },
            { label: "애플워치", color: "#0A84FF", s: watch?.apple },
          ].map((w) => (
            <div key={w.label}>
              <div className="flex items-center gap-2 mb-2">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: w.color }} />
                <span className="text-sm font-medium">{w.label}</span>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <p className="text-xs text-[#8E8E93]">오늘(≈)</p>
                  <p className="text-xl font-bold mt-1" style={{ color: w.color }}>
                    {watch ? fmt(w.s?.todayDevices ?? 0) : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-[#8E8E93]">기간 최대(≈)</p>
                  <p className="text-xl font-bold mt-1">{watch ? fmt(w.s?.peakDevices ?? 0) : "—"}</p>
                </div>
                <div>
                  <p className="text-xs text-[#8E8E93]">총 호출</p>
                  <p className="text-xl font-bold mt-1">{watch ? fmt(w.s?.totalHits ?? 0) : "—"}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
        {watch && watch.rows.length === 0 && (
          <p className="text-xs text-[#8E8E93] mt-3">아직 워치 접속 기록 없음 (배포 후부터 집계)</p>
        )}
      </div>

      {/* App version share per native app (active distinct devices). Forward-
          only: populates as devices re-open the app on a build that reports it. */}
      <div className="glass-card p-4">
        <div className="flex items-baseline justify-between flex-wrap gap-1 mb-3">
          <h2 className="text-sm font-semibold">앱 버전 비중</h2>
          <p className="text-xs text-[#8E8E93]">활성 기기 기준 · 배포 후 앱 재실행부터 집계</p>
        </div>
        {loading ? (
          <p className="text-sm text-[#8E8E93]">불러오는 중…</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {[
              { label: "iOS 앱", color: "#0A84FF", rows: versionsByApp.ios },
              { label: "안드 앱", color: "#3DDC84", rows: versionsByApp.aos },
            ].map((app) => {
              const total = app.rows.reduce((s, v) => s + v.devices, 0);
              return (
                <div key={app.label}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: app.color }} />
                    <span className="text-sm font-medium">{app.label}</span>
                    <span className="text-xs text-[#8E8E93]">기기 {fmt(total)}</span>
                  </div>
                  {app.rows.length === 0 ? (
                    <p className="text-xs text-[#8E8E93]">아직 데이터 없음</p>
                  ) : (
                    <div className="space-y-1.5">
                      {app.rows.map((v) => {
                        const share = total > 0 ? Math.round((v.devices / total) * 100) : 0;
                        return (
                          <div key={v.version} className="flex items-center gap-2">
                            <span className="text-xs tabular-nums w-24 shrink-0 truncate" title={v.version}>
                              {v.version}
                            </span>
                            <div className="flex-1 h-2 rounded-full bg-white/5 overflow-hidden">
                              <div className="h-full rounded-full" style={{ width: `${share}%`, background: app.color }} />
                            </div>
                            <span className="text-xs tabular-nums w-9 text-right">{share}%</span>
                            <span className="text-[11px] text-[#8E8E93] tabular-nums w-12 text-right">{fmt(v.devices)}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Daily active app devices (DAU) — per-day distinct native visitor_id */}
      <div className="glass-card p-4">
        <div className="flex items-baseline justify-between flex-wrap gap-1 mb-4">
          <h2 className="text-sm font-semibold">일별 앱 활성 기기수 (DAU)</h2>
          <p className="text-xs text-[#8E8E93]">하루 동안 앱을 연 고유 기기수</p>
        </div>
        {loading ? (
          <div className="h-60 flex items-center justify-center text-[#8E8E93] text-sm">불러오는 중…</div>
        ) : appDauData.length === 0 ? (
          <div className="h-60 flex items-center justify-center text-[#8E8E93] text-sm">아직 앱 활성 기기가 없어요</div>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={appDauData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="day" stroke="#8E8E93" fontSize={11} />
              <YAxis stroke="#8E8E93" fontSize={11} allowDecimals={false} />
              <Tooltip {...tooltipStyle} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="ios" name="iOS 앱" stackId="dau" fill="#0A84FF" />
              <Bar dataKey="aos" name="안드 앱" stackId="dau" fill="#3DDC84" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Per-platform active dwell time (session time-on-site). Median is the
          headline (avg is skewed by idle-but-visible tails). Populates after
          this build deploys and dwell beacons start landing. */}
      <div className="glass-card p-4">
        <div className="flex items-baseline justify-between flex-wrap gap-1 mb-3">
          <h2 className="text-sm font-semibold">플랫폼별 체류시간</h2>
          <p className="text-xs text-[#8E8E93]">방문당 활성 체류시간 · 중앙값 기준</p>
        </div>
        {loading ? (
          <p className="text-sm text-[#8E8E93]">불러오는 중…</p>
        ) : activePlatforms.length === 0 ? (
          <p className="text-sm text-[#8E8E93]">데이터 없음</p>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {activePlatforms.map((p) => {
              const d = resp?.dwell?.[p.key];
              return (
                <div key={p.key} className="rounded-xl bg-white/5 p-3">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: p.color }} />
                    <span className="text-xs text-[#8E8E93]">{p.label}</span>
                  </div>
                  <p className="text-xl font-bold mt-1" style={{ color: p.color }}>
                    {d && d.sessions > 0 ? fmtDur(d.medianMs) : "—"}
                  </p>
                  <p className="text-[11px] text-[#8E8E93] mt-0.5">
                    {d && d.sessions > 0
                      ? `평균 ${fmtDur(d.avgMs)} · ${fmt(d.sessions)}세션`
                      : "아직 데이터 없음"}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Daily PV by platform (stacked) */}
      <div className="glass-card p-4">
        <h2 className="text-sm font-semibold mb-4">일별 페이지뷰 (플랫폼별)</h2>
        {loading ? (
          <div className="h-72 flex items-center justify-center text-[#8E8E93] text-sm">불러오는 중…</div>
        ) : chartData.length === 0 ? (
          <div className="h-72 flex items-center justify-center text-[#8E8E93] text-sm">데이터 없음</div>
        ) : (
          <ResponsiveContainer width="100%" height={288}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="day" stroke="#8E8E93" fontSize={11} />
              <YAxis stroke="#8E8E93" fontSize={11} />
              <Tooltip {...tooltipStyle} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {activePlatforms.map((p) => (
                <Bar
                  key={p.key}
                  dataKey={p.key}
                  name={p.label}
                  stackId="pv"
                  fill={p.color}
                  radius={p.key === activePlatforms[activePlatforms.length - 1].key ? [4, 4, 0, 0] : undefined}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Per-platform breakdown */}
      <div className="glass-card p-4">
        <h2 className="text-sm font-semibold mb-4">플랫폼별 합계 ({resp?.days ?? days}일)</h2>
        <div className="space-y-2">
          {loading ? (
            <p className="text-sm text-[#8E8E93]">불러오는 중…</p>
          ) : activePlatforms.length === 0 ? (
            <p className="text-sm text-[#8E8E93]">데이터 없음</p>
          ) : (
            activePlatforms.map((p) => {
              const t = resp?.totals[p.key] ?? { pv: 0, uv: 0 };
              const share = totalPv > 0 ? Math.round((t.pv / totalPv) * 100) : 0;
              return (
                <div key={p.key} className="flex items-center gap-3">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: p.color }} />
                  <span className="text-sm w-20 shrink-0">{p.label}</span>
                  <div className="flex-1 h-2 rounded-full bg-white/5 overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${share}%`, background: p.color }} />
                  </div>
                  <span className="text-sm tabular-nums w-14 text-right">{fmt(t.pv)}</span>
                  <span className="text-xs text-[#8E8E93] tabular-nums w-20 text-right">방문자 {fmt(t.uv)}</span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
