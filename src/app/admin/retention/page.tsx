"use client";

import { useState, useEffect } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  Cell,
} from "recharts";
import type { CohortHeatmapRow, FunnelStep, GamedayRetention, VisitDistBucket } from "@/lib/admin/types";
import { addKSTDays } from "@/lib/utils/date-kst";

function getPin(): string {
  if (typeof window === "undefined") return "";
  return sessionStorage.getItem("admin_pin") || "";
}

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    headers: { "x-admin-pin": getPin() },
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

const chartTooltipStyle = {
  contentStyle: {
    background: "#1C1C1F",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: "8px",
  },
  labelStyle: { color: "#8E8E93" },
};

function rateColor(rate: number): string {
  if (rate >= 0.4) return "#22C55E";
  if (rate >= 0.25) return "#84CC16";
  if (rate >= 0.15) return "#EAB308";
  if (rate >= 0.08) return "#F97316";
  return "#EF4444";
}

function rateBg(rate: number): string {
  if (rate >= 0.4) return "rgba(34,197,94,0.15)";
  if (rate >= 0.25) return "rgba(132,204,22,0.15)";
  if (rate >= 0.15) return "rgba(234,179,8,0.15)";
  if (rate >= 0.08) return "rgba(249,115,22,0.15)";
  return "rgba(239,68,68,0.15)";
}

const FUNNEL_COLORS = ["#6366F1", "#8B5CF6", "#A855F7", "#D946EF", "#EC4899"];

const D_OFFSETS: Record<string, number> = {
  d0: 0, d1: 1, d2: 2, d3: 3, d4: 4, d5: 5, d6: 6, d7: 7, d14: 14, d30: 30,
};

/** 히트맵 열 순서 (D0 = 가입 당일) */
const D_KEYS = ["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "d14", "d30"] as const;

/** KBO는 월요일 경기 없음 → 해당일이 타깃이면 리텐션이 자연 저조. targetDay(YYYY-MM-DD)가 월요일인지. */
function isNoGameMonday(dateStr: string): boolean {
  // UTC 정오 기준으로 요일 판정 — 런타임 타임존과 무관하게 캘린더 날짜의 요일 확정
  return new Date(dateStr + "T12:00:00Z").getUTCDay() === 1;
}

/** 미완료일 판정: 미래 + 진행 중인 당일(오늘). 당일은 하루가 안 끝나 값이 과소집계됨. */
function isDayIncomplete(cohortDate: string, dKey: string, targetDate: string): boolean {
  const offset = D_OFFSETS[dKey] ?? 0;
  return addKSTDays(cohortDate, offset) >= targetDate;
}

/** 가장 최근 코호트 중 해당 D-N이 실제로 경과한 값 (헤드라인 카드용). 없으면 null. */
function latestElapsedRate(
  rows: CohortHeatmapRow[],
  key: keyof CohortHeatmapRow,
  notYetFn: (cohortKey: string, dKey: string, targetDate: string) => boolean,
  targetDate: string,
): number | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!notYetFn(rows[i].cohortKey, key as string, targetDate)) {
      return rows[i][key] as number;
    }
  }
  return null;
}

/** ISO week string (e.g. "2026-W16") → 해당 주 월요일 YYYY-MM-DD */
function weekToMonday(weekStr: string): string {
  const [y, w] = weekStr.split("-W").map(Number);
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7;
  const monday = new Date(jan4.getTime() + ((w - 1) * 7 - (dayOfWeek - 1)) * 86400000);
  return monday.toISOString().slice(0, 10);
}

function isWeekNotYet(weekStr: string, dKey: string, targetDate: string): boolean {
  // 주간 코호트는 유저별 '가입일+N일' 기준이라, 주 후반 가입자의 미성숙 관측이 섞이면
  // 최근 주 D-N이 낮게 왜곡됨. 그 주 마지막 가입 가능일(일요일)+N일이 완료돼야 셀 노출
  // → 진행 중인 주는 통째로 숨고, 주가 끝난 뒤 D0부터 하루씩 순차 공개.
  const weekSunday = addKSTDays(weekToMonday(weekStr), 6);
  return isDayIncomplete(weekSunday, dKey, targetDate);
}

interface RetentionData {
  cohort: CohortHeatmapRow[];
  dailyCohort: CohortHeatmapRow[];
  funnel: FunnelStep[];
  gameday: GamedayRetention[];
  visitDist: VisitDistBucket[];
  date: string | null;
}

export default function RetentionPage() {
  const [data, setData] = useState<RetentionData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<RetentionData>("/api/admin/retention")
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400">
        로딩 중...
      </div>
    );
  }

  if (!data?.date) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400">
        아직 집계된 데이터가 없습니다. 크론이 실행된 후 데이터가 표시됩니다.
      </div>
    );
  }

  // D7은 최신 코호트가 아직 D7 미도달 or 당일(미완료)일 수 있으므로, D7이 완전히 경과한(당일 제외) 최신 코호트 값 사용
  const d7Val = latestElapsedRate(data.dailyCohort, "d7", isDayIncomplete, data.date);
  const activationComplete = data.funnel.at(-1);
  const activationRate = activationComplete?.rate ?? 0;
  const latestGd = data.gameday.at(-1);
  const gd1Rate = latestGd?.gd1 ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">리텐션 모니터링</h1>
        <span className="text-sm text-gray-400">
          마지막 집계: {data.date}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="glass-card p-5">
          <p className="text-xs text-gray-400 mb-1">최근 코호트 D7 리텐션</p>
          <p className="text-2xl font-bold tabular-nums" style={{ color: rateColor(d7Val ?? 0) }}>
            {d7Val === null ? "—" : `${(d7Val * 100).toFixed(1)}%`}
          </p>
        </div>
        <div className="glass-card p-5">
          <p className="text-xs text-gray-400 mb-1">Activation 완료율</p>
          <p className="text-2xl font-bold tabular-nums" style={{ color: rateColor(activationRate) }}>
            {(activationRate * 100).toFixed(1)}%
          </p>
        </div>
        <div className="glass-card p-5">
          <p className="text-xs text-gray-400 mb-1">첫 경기일 복귀율</p>
          <p className="text-2xl font-bold tabular-nums" style={{ color: rateColor(gd1Rate) }}>
            {(gd1Rate * 100).toFixed(1)}%
          </p>
        </div>
      </div>

      <div className="glass-card p-5">
        <h2 className="text-sm font-semibold mb-1">주간 코호트 리텐션 히트맵</h2>
        <p className="text-[11px] text-gray-500 mb-4">D0 = 가입 당일 활동. page_view 계측이 온전한 6/26 이후(2026-W27~) 코호트만 표시. 진행 중인 주는 완료 후 D0부터 하루씩 순차 공개(미성숙 관측 왜곡 방지).</p>
        {data.cohort.length === 0 ? (
          <p className="text-gray-500 text-sm">데이터 없음</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400 text-xs">
                  <th className="text-left py-2 pr-4">코호트</th>
                  <th className="text-right py-2 px-3">인원</th>
                  {(D_KEYS).map((k) => (
                    <th key={k} className="text-center py-2 px-2">{k.toUpperCase()}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.cohort.map((row) => (
                  <tr key={row.cohortKey} className="border-t border-white/5">
                    <td className="py-2 pr-4 text-gray-300 font-mono text-xs">
                      {row.cohortKey}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums text-gray-400">
                      {row.cohortSize}
                    </td>
                    {(D_KEYS).map((key) => {
                      const notYet = isWeekNotYet(row.cohortKey, key, data.date!);
                      return (
                        <td
                          key={key}
                          className="py-2 px-2 text-center tabular-nums font-medium text-xs"
                          style={notYet
                            ? { color: "#3A3A3C", background: "rgba(255,255,255,0.03)" }
                            : { color: rateColor(row[key]), background: rateBg(row[key]) }
                          }
                        >
                          {notYet ? "" : row[key] > 0 ? `${(row[key] * 100).toFixed(1)}%` : "—"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="glass-card p-5">
        <h2 className="text-sm font-semibold mb-1">일별 코호트 리텐션</h2>
        <p className="text-[11px] text-gray-500 mb-4">D0 = 가입 당일 활동. page_view 계측이 온전한 6/26 이후 코호트만 (그 전은 눈팅 방문 누락으로 과소집계). 진행 중인 당일은 제외, <span className="text-[#EF4444]">빨간 테두리</span>는 경기 없는 월요일(자연 저조).</p>
        {data.dailyCohort.length === 0 ? (
          <p className="text-gray-500 text-sm">데이터 없음</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400 text-xs">
                  <th className="text-left py-2 pr-4">가입일</th>
                  <th className="text-right py-2 px-3">인원</th>
                  {(D_KEYS).map((k) => (
                    <th key={k} className="text-center py-2 px-2">{k.toUpperCase()}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.dailyCohort.map((row) => (
                  <tr key={row.cohortKey} className="border-t border-white/5">
                    <td className="py-2 pr-4 text-gray-300 font-mono text-xs">
                      {row.cohortKey.slice(5)}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums text-gray-400">
                      {row.cohortSize}
                    </td>
                    {(D_KEYS).map((key) => {
                      const offset = D_OFFSETS[key] ?? 0;
                      const targetDay = addKSTDays(row.cohortKey, offset);
                      // 진행 중인 당일(+미래)은 숨김 — 미완료일이라 값이 자연히 낮게 찍혀 오해 유발
                      const notYet = targetDay >= data.date!;
                      // 경기 없는 월요일 타깃일은 빨간 테두리로 표시 (D0=가입일은 리텐션 아님이라 제외)
                      const noGameMonday = !notYet && offset > 0 && isNoGameMonday(targetDay);
                      return (
                        <td
                          key={key}
                          className="py-2 px-2 text-center tabular-nums font-medium text-xs"
                          style={{
                            ...(notYet
                              ? { color: "#3A3A3C", background: "rgba(255,255,255,0.03)" }
                              : { color: rateColor(row[key]), background: rateBg(row[key]) }),
                            ...(noGameMonday ? { boxShadow: "inset 0 0 0 1.5px #EF4444" } : {}),
                          }}
                        >
                          {notYet ? "" : row[key] > 0 ? `${(row[key] * 100).toFixed(1)}%` : "—"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="glass-card p-5">
        <h2 className="text-sm font-semibold mb-1">Activation Funnel</h2>
        <p className="text-[11px] text-gray-500 mb-4">6/26 이후 가입 코호트 기준 (그 전 초기 유저 제외). 상단 Activation 완료율 = 첫 채팅 도달률.</p>
        {data.funnel.length === 0 ? (
          <p className="text-gray-500 text-sm">데이터 없음</p>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <BarChart
              data={data.funnel}
              layout="vertical"
              margin={{ left: 80, right: 40 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis
                type="number"
                domain={[0, 1]}
                tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
                stroke="#8E8E93"
                fontSize={11}
              />
              <YAxis
                type="category"
                dataKey="label"
                stroke="#8E8E93"
                fontSize={12}
                width={70}
              />
              <Tooltip
                {...chartTooltipStyle}
                formatter={(value) => [`${(Number(value) * 100).toFixed(1)}%`, "전환율"]}
              />
              <Bar dataKey="rate" radius={[0, 4, 4, 0]}>
                {data.funnel.map((_, i) => (
                  <Cell key={i} fill={FUNNEL_COLORS[i % FUNNEL_COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
        {data.funnel.length > 0 && (
          <div className="flex gap-4 mt-3 text-xs text-gray-400">
            {data.funnel.map((s) => (
              <span key={s.step}>
                {s.label}: <span className="text-white font-medium">{s.count.toLocaleString()}</span>명
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="glass-card p-5">
        <h2 className="text-sm font-semibold mb-4">게임데이 리텐션</h2>
        {data.gameday.length === 0 ? (
          <p className="text-gray-500 text-sm">데이터 없음</p>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={data.gameday}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="cohortKey" stroke="#8E8E93" fontSize={11} />
              <YAxis
                domain={[0, 1]}
                tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
                stroke="#8E8E93"
                fontSize={11}
              />
              <Tooltip
                {...chartTooltipStyle}
                formatter={(value, name) => [
                  `${(Number(value) * 100).toFixed(1)}%`,
                  name === "gd1" ? "1st 경기일" : name === "gd2" ? "2nd 경기일" : "3rd 경기일",
                ]}
              />
              <Line type="monotone" dataKey="gd1" stroke="#22D3EE" strokeWidth={2} name="gd1" dot={{ r: 3 }} />
              <Line type="monotone" dataKey="gd2" stroke="#6366F1" strokeWidth={2} name="gd2" dot={{ r: 3 }} />
              <Line type="monotone" dataKey="gd3" stroke="#A855F7" strokeWidth={2} name="gd3" dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="glass-card p-5">
        <h2 className="text-sm font-semibold mb-4">재방문 횟수별 유저 분포 (최근 30일)</h2>
        {data.visitDist.length === 0 ? (
          <p className="text-gray-500 text-sm">데이터 없음 — 다음 크론 실행 후 표시됩니다</p>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={data.visitDist} margin={{ left: 10, right: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis
                dataKey="bucket"
                stroke="#8E8E93"
                fontSize={12}
                label={{ value: "방문 횟수", position: "insideBottom", offset: -5, fill: "#8E8E93", fontSize: 11 }}
              />
              <YAxis stroke="#8E8E93" fontSize={11} />
              <Tooltip
                {...chartTooltipStyle}
                formatter={(value) => [`${Number(value).toLocaleString()}명`, "유저 수"]}
                labelFormatter={(label) => `${label}회 방문`}
              />
              <Bar dataKey="count" fill="#6366F1" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
