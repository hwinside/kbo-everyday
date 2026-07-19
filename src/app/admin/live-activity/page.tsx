"use client";

import { useState, useEffect, useCallback } from "react";
import { RefreshCw, CheckCircle2 } from "lucide-react";

interface GameRow {
  gameId: string;
  label: string;
  status: string;
  started: number;
  tokens: number;
  channelSubs: number;
  updatable: number;
  gap: number;
  isStale: boolean;
}

interface LaStatus {
  pushToStart: { total: number; fresh24h: number; fresh7d: number };
  summary: {
    cards: number;
    updatable: number;
    gap: number;
    updateTokens: number;
    channelSubs: number;
    residualRows: number;
    residualGameCount: number;
    kboStatusAvailable: boolean;
    unknownActiveCount: number;
    rowsTruncated: boolean;
  };
  games: GameRow[];
  generatedAt: string;
}

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  live: { text: "진행중", cls: "bg-red-900/30 text-red-400" },
  final: { text: "종료", cls: "bg-gray-800 text-gray-400" },
  scheduled: { text: "예정", cls: "bg-blue-900/30 text-blue-400" },
  cancelled: { text: "취소", cls: "bg-orange-900/30 text-orange-400" },
  stale: { text: "과거 잔존", cls: "bg-red-900/40 text-red-300 border border-red-700" },
  unknown: { text: "미상(활성 fallback)", cls: "bg-yellow-900/30 text-yellow-400" },
};

function getPin(): string {
  if (typeof window === "undefined") return "";
  return sessionStorage.getItem("admin_pin") || "";
}

export default function LiveActivityMonitorPage() {
  const [data, setData] = useState<LaStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/live-activity", {
        headers: { "x-admin-pin": getPin() },
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`API error ${res.status}`);
      setData(await res.json());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    // update 푸시가 1분 cron이라 같은 주기로 자동 갱신하면 라이브 관제에 충분.
    const id = setInterval(fetchData, 60_000);
    return () => clearInterval(id);
  }, [fetchData]);

  const s = data?.summary;
  const p2s = data?.pushToStart;
  const gapPct = s && s.cards > 0 ? Math.round((s.gap / s.cards) * 100) : 0;

  return (
    <div className="min-h-screen bg-[#0A0A0B] text-white p-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">잠금화면 Live Activity 현황</h1>
            <p className="text-sm text-gray-400 mt-1">
              push-to-start 토큰 · 떠있는 카드 · 갱신 불가(gap) 관제 — 1분 자동 갱신
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

        {s && !s.kboStatusAvailable && (
          <div className="mb-4 p-3 bg-yellow-900/20 border border-yellow-700 rounded-lg text-yellow-400 text-sm">
            ⚠️ KBO 일정 조회 실패 — 오늘 경기 상태를 확인할 수 없어 상태 미상(unknown) 경기도 활성으로 fallback 집계 중입니다.
          </div>
        )}
        {s && s.kboStatusAvailable && s.unknownActiveCount > 0 && (
          <div className="mb-4 p-3 bg-yellow-900/20 border border-yellow-700 rounded-lg text-yellow-400 text-sm">
            ⚠️ 오늘 game_id {s.unknownActiveCount}건이 KBO 목록에서 상태 미상 — 활성으로 fallback 집계했습니다.
          </div>
        )}
        {s && s.rowsTruncated && (
          <div className="mb-4 p-3 bg-orange-900/20 border border-orange-700 rounded-lg text-orange-400 text-sm">
            ⚠️ 잔존 기록 행이 페이지 상한에 도달해 일부가 집계에서 잘렸습니다(과거 잔존 통계만 영향, 오늘 활성 수치는 정렬상 항상 우선 포함).
          </div>
        )}

        {s && p2s && (
          <div className="mb-6 grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-gray-800/50 rounded-lg p-4">
              <div className="text-sm text-gray-400 mb-1">떠있는 잠금화면 카드</div>
              <div className="text-3xl font-bold">{s.cards}</div>
              <div className="text-xs text-gray-500 mt-1">진행중·예정(+상태 미상 fallback) push-to-start 발급</div>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-4">
              <div className="text-sm text-gray-400 mb-1">자동발급 카드 중 갱신 수신</div>
              <div className="text-3xl font-bold text-green-400">{s.updatable}</div>
              <div className="text-xs text-gray-500 mt-1">
                update 토큰 또는 채널 구독(build17+) · 토큰 {s.updateTokens}건 · 채널 {s.channelSubs}대
              </div>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-4">
              <div className="text-sm text-gray-400 mb-1">갱신 불가 (gap)</div>
              <div className={`text-3xl font-bold ${s.gap > 0 ? "text-red-400" : "text-green-400"}`}>
                {s.gap}
                <span className="text-base font-normal text-gray-500 ml-2">{gapPct}%</span>
              </div>
              <div className="text-xs text-gray-500 mt-1">토큰 미등록 — 무음 wake 대상</div>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-4">
              <div className="text-sm text-gray-400 mb-1">push-to-start 기기</div>
              <div className="text-3xl font-bold">{p2s.total}</div>
              <div className="text-xs text-gray-500 mt-1">
                24h 활성 {p2s.fresh24h} · 7일 {p2s.fresh7d}
              </div>
            </div>
          </div>
        )}

        <div>
          <h2 className="text-lg font-semibold mb-3">경기별 현황</h2>
          {loading && !data ? (
            <div className="text-center py-8 text-gray-400">로딩 중...</div>
          ) : !data || data.games.length === 0 ? (
            <div className="text-center py-8 text-gray-400 flex flex-col items-center gap-2">
              <CheckCircle2 className="w-8 h-8 text-green-500" />
              <div>활성 Live Activity 없음 (경기 없는 시간대 정상)</div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-700">
                    <th className="text-left py-3 px-4">경기</th>
                    <th className="text-left py-3 px-4">상태</th>
                    <th className="text-right py-3 px-4">카드</th>
                    <th className="text-right py-3 px-4">update 토큰</th>
                    <th className="text-right py-3 px-4">채널 구독</th>
                    <th className="text-right py-3 px-4">갱신 수신</th>
                    <th className="text-right py-3 px-4">갱신 불가</th>
                  </tr>
                </thead>
                <tbody>
                  {data.games.map(g => (
                    <tr key={g.gameId} className="border-b border-gray-800 hover:bg-gray-800/30">
                      <td className="py-3 px-4">
                        <div className="font-medium">{g.label}</div>
                        <div className="text-xs text-gray-500">{g.gameId}</div>
                      </td>
                      <td className="py-3 px-4">
                        <span className={`px-2 py-1 rounded text-xs ${(STATUS_LABEL[g.status] ?? STATUS_LABEL.unknown).cls}`}>
                          {(STATUS_LABEL[g.status] ?? STATUS_LABEL.unknown).text}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right font-medium">{g.started}</td>
                      <td className="py-3 px-4 text-right text-gray-400">{g.tokens}</td>
                      <td className="py-3 px-4 text-right text-sky-400">{g.channelSubs > 0 ? g.channelSubs : <span className="text-gray-600">—</span>}</td>
                      <td className="py-3 px-4 text-right text-green-400">{g.updatable}</td>
                      <td className="py-3 px-4 text-right">
                        {g.status === "live" || g.status === "scheduled" || g.status === "unknown" ? (
                          <span className={g.gap > 0 ? "text-red-400 font-medium" : "text-gray-500"}>{g.gap}</span>
                        ) : g.tokens > 0 ? (
                          <span className="text-orange-400 text-xs">end 미처리 의심</span>
                        ) : (
                          <span className="text-gray-600">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="mt-6 text-xs text-gray-500 space-y-1 bg-gray-900/40 rounded-lg p-4">
          <div>• <span className="text-gray-300">카드</span> = 서버 push-to-start로 잠금화면에 뜬 Live Activity (started_users). 경기룸 방문으로 포그라운드에서 뜬 카드는 update 토큰에만 잡힌다.</div>
          <div>• <span className="text-gray-300">갱신 불가(gap)</span> = 카드는 떴는데 update 토큰 미등록·채널 미구독 → 점수 갱신·종료 정리를 못 받는 상태. 발급/종료 후 20분 창의 무음 wake가 자동 구제하고, 그래도 남으면 앱 오픈 시 등록된다.</div>
          <div>• <span className="text-gray-300">채널 구독</span> = build17+(iOS18) 기기가 현재 active broadcast 채널에 붙었다고 네이티브가 ACK한 기기 수. 채널 재생성 전 stale ACK는 제외하며, 익명 ACK는 유저 매핑 불가라 갱신 수신에서 제외한다.</div>
          <div>• <span className="text-gray-300">과거 잔존</span> = 오늘 경기 목록에 없는 지난 game_id의 발급 기록 행. iOS가 카드를 ~8시간 내 자동 만료시키므로 실제 좀비 카드가 아니라 서버 기록 잔재{s ? ` (현재 ${s.residualRows}행 / ${s.residualGameCount}경기)` : ""}.</div>
          <div>• <span className="text-gray-300">미상(활성 fallback)</span> = 오늘 game_id인데 KBO 일정 조회 실패나 목록 누락으로 상태를 확정 못한 경우. 요약에는 활성으로 포함해 집계 누락을 막는다.</div>
          <div>• <span className="text-gray-300">자동발급 카드 중 갱신 수신</span> = push-to-start 카드 중 update 토큰 보유 또는 현재 active 채널 구독이 확인된 카드(중복 제거). 경기룸 방문으로만 뜬 LA는 전체 update 토큰 수치에만 포함된다.</div>
          <div>• 종료/취소 경기는 end 푸시 후 update 토큰이 정상 삭제된다. 종료 경기에 토큰이 남아 있으면 <span className="text-orange-400">end 미처리 의심</span>으로 표시.</div>
        </div>

        {data && (
          <div className="mt-3 text-xs text-gray-600">
            집계 시각: {new Date(data.generatedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
          </div>
        )}
      </div>
    </div>
  );
}
