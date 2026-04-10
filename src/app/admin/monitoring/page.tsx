"use client";

import { useState, useEffect } from "react";
import { RefreshCw, AlertTriangle, CheckCircle2 } from "lucide-react";

interface FallbackEvent {
  id: number;
  api_name: string;
  reason: string;
  status_code: number | null;
  error_message: string | null;
  timestamp: string;
  alert_sent: boolean;
}

interface FallbackSummary {
  total: number;
  byApi: Record<
    string,
    {
      total: number;
      reasons: Record<string, number>;
      latestTimestamp: string;
    }
  >;
  period: {
    startDate: string;
    endDate: string;
    days: number;
  };
}

function getPin(): string {
  if (typeof window === "undefined") return "";
  return sessionStorage.getItem("admin_pin") || "";
}

export default function MonitoringPage() {
  const [events, setEvents] = useState<FallbackEvent[]>([]);
  const [summary, setSummary] = useState<FallbackSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/monitoring/fallbacks?days=7", {
        headers: { "x-admin-pin": getPin() },
      });
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const data = await res.json();
      setEvents(data.events.slice(0, 20)); // 최근 20건만
      setSummary(data.summary);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  return (
    <div className="min-h-screen bg-[#0A0A0B] text-white p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">API Fallback 모니터링</h1>
            <p className="text-sm text-gray-400 mt-1">
              외부 API 장애 추적 (최근 7일)
            </p>
          </div>
          <button
            onClick={fetchData}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            새로고침
          </button>
        </div>

        {error && (
          <div className="mb-4 p-4 bg-red-900/20 border border-red-700 rounded-lg text-red-400">
            ❌ {error}
          </div>
        )}

        {/* Summary */}
        {summary && (
          <div className="mb-6 grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-gray-800/50 rounded-lg p-4">
              <div className="text-sm text-gray-400 mb-1">총 이벤트</div>
              <div className="text-3xl font-bold">{summary.total}</div>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-4">
              <div className="text-sm text-gray-400 mb-1">영향받은 API</div>
              <div className="text-3xl font-bold">
                {Object.keys(summary.byApi).length}
              </div>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-4">
              <div className="text-sm text-gray-400 mb-1">기간</div>
              <div className="text-lg font-bold">{summary.period.days}일</div>
            </div>
          </div>
        )}

        {/* API별 통계 */}
        {summary && Object.keys(summary.byApi).length > 0 && (
          <div className="mb-6">
            <h2 className="text-lg font-semibold mb-3">API별 통계</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {Object.entries(summary.byApi).map(([api, stats]) => (
                <div key={api} className="bg-gray-800/30 rounded-lg p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="font-medium">{api}</div>
                    <div className="text-sm text-gray-400">{stats.total}회</div>
                  </div>
                  <div className="text-xs text-gray-500 space-y-1">
                    {Object.entries(stats.reasons).map(([reason, count]) => (
                      <div key={reason} className="flex justify-between">
                        <span>{reason}</span>
                        <span>{count}회</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Events Table */}
        <div>
          <h2 className="text-lg font-semibold mb-3">최근 이벤트 (20건)</h2>
          {loading ? (
            <div className="text-center py-8 text-gray-400">로딩 중...</div>
          ) : events.length === 0 ? (
            <div className="text-center py-8 text-gray-400 flex flex-col items-center gap-2">
              <CheckCircle2 className="w-8 h-8 text-green-500" />
              <div>최근 7일간 장애 없음</div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-700">
                    <th className="text-left py-3 px-4">API</th>
                    <th className="text-left py-3 px-4">원인</th>
                    <th className="text-left py-3 px-4">에러</th>
                    <th className="text-left py-3 px-4">시각</th>
                    <th className="text-center py-3 px-4">알림</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => (
                    <tr
                      key={event.id}
                      className="border-b border-gray-800 hover:bg-gray-800/30"
                    >
                      <td className="py-3 px-4 font-medium">{event.api_name}</td>
                      <td className="py-3 px-4">
                        <span className="px-2 py-1 bg-orange-900/30 text-orange-400 rounded text-xs">
                          {event.reason}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-gray-400 text-xs max-w-xs truncate">
                        {event.error_message || "-"}
                      </td>
                      <td className="py-3 px-4 text-gray-400">
                        {new Date(event.timestamp).toLocaleString("ko-KR", {
                          timeZone: "Asia/Seoul",
                        })}
                      </td>
                      <td className="py-3 px-4 text-center">
                        {event.alert_sent ? (
                          <CheckCircle2 className="w-4 h-4 text-green-500 inline" />
                        ) : (
                          <span className="text-gray-600">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
