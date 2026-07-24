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
import type { CohortHeatmapRow, RollingRetentionRow, FunnelStep, GamedayRetention, VisitDistBucket } from "@/lib/admin/types";
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

/** 정규 경기 없는 브레이크 기간(양끝 포함). 2026 올스타 브레이크 = 7/10~7/15
 *  (정규 마지막 7/9, 재개 7/16 — 실측 /api/games 기준. 7/11 올스타전은 정규 경기 아님이라 포함). */
const NO_GAME_BREAKS: Array<[string, string]> = [["2026-07-10", "2026-07-15"]];

/** 정규 경기 없는 날 = 월요일 or 브레이크 기간 → 리텐션 자연 저조 표기 대상. */
function isNoGameDay(dateStr: string): boolean {
  return isNoGameMonday(dateStr) || NO_GAME_BREAKS.some(([from, to]) => dateStr >= from && dateStr <= to);
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
  // 집계(computeCohortRetention)가 '오늘(미완료일)'을 eligible에서 제외해 오늘 row를 안 만든다.
  // 표시단도 동일 기준(>=)으로 오늘·미완료 칸을 blank 처리 → route 기본값 0이 '—'로 뜨는 것 방지.
  return isDayIncomplete(weekToMonday(weekStr), dKey, targetDate);
}

/** 롤링 윈도우 윈도우 마지막 날 offset (eligibility 판정용) */
const ROLLING_WINDOW_END: Record<string, number> = { w1: 7, w2: 14, w3: 21, w4: 28 };
const ROLLING_KEYS = ["w1", "w2", "w3", "w4"] as const;
const ROLLING_LABELS: Record<string, string> = {
  w1: "1주차(1~7일)", w2: "2주차(8~14일)", w3: "3주차(15~21일)", w4: "4주차(22~28일)",
};

/** 롤링 윈도우도 윈도우 마지막 날이 오늘 이상이면(미완료) 숨김 — exact-day와 동일 기준(>=). */
function isRollingNotYet(weekStr: string, wKey: string, targetDate: string): boolean {
  const end = ROLLING_WINDOW_END[wKey] ?? 0;
  return addKSTDays(weekToMonday(weekStr), end) >= targetDate;
}

interface RetentionData {
  cohort: CohortHeatmapRow[];
  dailyCohort: CohortHeatmapRow[];
  rolling: RollingRetentionRow[];
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

  // 완료된 관측이 하나도 없는 주(전 셀 blank, 예: 갓 시작한 주)는 행 자체를 숨긴다.
  const visibleWeekly = data.cohort.filter((row) =>
    D_KEYS.some((k) => !isWeekNotYet(row.cohortKey, k, data.date!) && Number(row[k]) > 0),
  );

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
          <p className="text-[10px] text-gray-500 mt-1">최애팀 + 최애선수 1명 + 경기 1개+ 방문</p>
        </div>
        <div className="glass-card p-5">
          <p className="text-xs text-gray-400 mb-1">첫 경기일 복귀율</p>
          <p className="text-2xl font-bold tabular-nums" style={{ color: rateColor(gd1Rate) }}>
            {(gd1Rate * 100).toFixed(1)}%
          </p>
        </div>
      </div>

      <div className="glass-card p-5">
        <h2 className="text-sm font-semibold mb-1">주차 롤링 윈도우 리텐션 <span className="text-[10px] font-normal text-emerald-400">셀링자료용</span></h2>
        <p className="text-[11px] text-gray-500 mb-4">각 주차 구간 중 <span className="text-gray-300">1회 이상 활동</span>한 비율 (W1=가입 후 1~7일, W2=8~14일, W3=15~21일, W4=22~28일). 위 히트맵의 exact single-day(‘그 하루’)와 달리 구간 누적이라 <span className="text-gray-300">무경기일·올스타 브레이크 노이즈를 흡수</span>한 단조감소 곡선. 완전히 경과한 윈도우만 집계.</p>
        {(() => {
          const chartData = ROLLING_KEYS.map((k) => {
            const pt: Record<string, number | string> = { window: ROLLING_LABELS[k] };
            for (const row of data.rolling) {
              if (isRollingNotYet(row.cohortKey, k, data.date!)) continue;
              pt[row.cohortKey] = row[k];
            }
            return pt;
          });
          const cohortKeys = data.rolling.map((r) => r.cohortKey);
          const lineColors = ["#22D3EE", "#6366F1", "#A855F7", "#EC4899", "#F59E0B", "#10B981"];
          return data.rolling.length === 0 ? (
            <p className="text-gray-500 text-sm">완료된 윈도우가 있는 코호트가 아직 없습니다.</p>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={chartData} margin={{ left: 10, right: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis dataKey="window" stroke="#8E8E93" fontSize={11} />
                <YAxis domain={[0, 1]} tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`} stroke="#8E8E93" fontSize={11} />
                <Tooltip {...chartTooltipStyle} formatter={(value, name) => [`${(Number(value) * 100).toFixed(1)}%`, name as string]} />
                {cohortKeys.map((ck, i) => (
                  <Line key={ck} type="monotone" dataKey={ck} stroke={lineColors[i % lineColors.length]} strokeWidth={2} name={ck} dot={{ r: 3 }} connectNulls />
                ))}
              </LineChart>
            </ResponsiveContainer>
          );
        })()}
      </div>

      <div className="glass-card p-5">
        <h2 className="text-sm font-semibold mb-1">주간 코호트 리텐션 히트맵 <span className="text-[10px] font-normal text-amber-400">exact single-day</span></h2>
        <p className="text-[11px] text-gray-500 mb-4"><span className="text-amber-400">⚠ 각 칸은 ‘가입+정확히 N일째 그 하루’의 활동율(누적/윈도우 아님)</span> — D14는 ‘14일 이내’가 아니라 14일째 당일. 그래서 무경기일(올스타 브레이크 등)이 끼면 D7가 구조적으로 저조해 D14{">"}D7 역전이 나타남 → 상단 롤링 윈도우 뷰 참고. D0 = 가입일 기준선(100%). page_view 계측이 온전한 6/26 이후(2026-W27~) 코호트만 표시. 각 셀은 완료된 날 관측만 집계(진행 중인 오늘은 제외).</p>
        {visibleWeekly.length === 0 ? (
          <p className="text-gray-500 text-sm">완료된 관측이 있는 주가 아직 없습니다. 진행 중인 주는 완료되는 대로 표시됩니다.</p>
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
                {visibleWeekly.map((row) => (
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
        <p className="text-[11px] text-gray-500 mb-4">D0 = 가입일 기준선(100%), D1~ = 재방문율. page_view 계측이 온전한 6/26 이후 코호트만 (그 전은 눈팅 방문 누락으로 과소집계). 진행 중인 당일은 제외, <span className="text-[#EF4444]">빨간 테두리</span>는 정규 경기 없는 날 — 월요일·올스타 브레이크(자연 저조).</p>
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
                      // 정규 경기 없는 날(월요일·올스타 브레이크)은 빨간 테두리로 표시 (D0=가입일은 리텐션 아님이라 제외)
                      const noGameDay = !notYet && offset > 0 && isNoGameDay(targetDay);
                      return (
                        <td
                          key={key}
                          className="py-2 px-2 text-center tabular-nums font-medium text-xs"
                          style={{
                            ...(notYet
                              ? { color: "#3A3A3C", background: "rgba(255,255,255,0.03)" }
                              : { color: rateColor(row[key]), background: rateBg(row[key]) }),
                            ...(noGameDay ? { boxShadow: "inset 0 0 0 1.5px #EF4444" } : {}),
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
        <p className="text-[11px] text-gray-500 mb-4">6/26 이후 가입 코호트 기준. <span className="text-gray-300">활성화 완료 = ①최애팀 지정 + ②최애선수 1명 이상 + ③서로 다른 경기 1개 이상 방문 (3조건 모두 충족)</span>. 상단 Activation 완료율 = 이 완료 비율.</p>
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
