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
  channelBorn: number;
  updatable: number;
  gap: number;
  wakeAttempted: number;
  wakeRescued: number;
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
    channelBorn: number;
    wakeAttempted: number;
    wakeRescued: number;
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
              <div className="text-sm text-gray-400 mb-1">시작 요청 기록</div>
              <div className="text-3xl font-bold">{s.cards}</div>
              <div className="text-xs text-gray-500 mt-1">진행중·예정(+상태 미상 fallback) push-to-start 발급</div>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-4">
              <div className="text-sm text-gray-400 mb-1">기기 등록 확인</div>
              <div className="text-3xl font-bold text-green-400">{s.updatable}</div>
              <div className="text-xs text-gray-500 mt-1">
                update 토큰 · 채널 ACK 기준 — 토큰 {s.updateTokens}건 · 채널 {s.channelSubs}대 · 내장 {s.channelBorn}명
              </div>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-4">
              <div className="text-sm text-gray-400 mb-1">기기 확인 없음 (미노출 확정 아님)</div>
              <div className={`text-3xl font-bold ${s.gap > 0 ? "text-red-400" : "text-green-400"}`}>
                {s.gap}
                <span className="text-base font-normal text-gray-500 ml-2">{gapPct}%</span>
              </div>
              <div className="text-xs text-gray-500 mt-1">
                기기 등록 미확인 — 무음 wake 시도 {s.wakeAttempted} · 구제 {s.wakeRescued}
                {s.wakeAttempted > 0 ? ` (${Math.round((s.wakeRescued / s.wakeAttempted) * 100)}%)` : ""}
              </div>
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
                    <th className="text-right py-3 px-4">채널 내장</th>
                    <th className="text-right py-3 px-4">기기 확인</th>
                    <th className="text-right py-3 px-4">기기 미확인</th>
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
                      <td className="py-3 px-4 text-right text-sky-400">{g.channelBorn > 0 ? g.channelBorn : <span className="text-gray-600">—</span>}</td>
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
          <div>• <span className="text-gray-300">시작 요청</span> = 서버 push-to-start가 APNs에 접수된 기록(started_users). 실제 잠금화면 표시를 증명하지 않는다. 경기룸에서 직접 시작한 카드는 update 토큰에만 잡힐 수 있다.</div>
          <div>• <span className="text-gray-300">기기 미확인(gap)</span> = 시작 요청 중 update 토큰이나 현재 채널 ACK가 없는 기록. 미노출·갱신 실패 확정치가 아니다. 현재 채널 시작 요청은 2분 대기 후 무음 복구를 1회 시도하지만, 기기 실행이나 복구 성공을 보장하지 않는다.</div>
          <div>• <span className="text-gray-300">채널 구독</span> = build17+(iOS18) 기기가 현재 active broadcast 채널에 붙었다고 네이티브가 ACK한 기기 수. 채널 재생성 전 stale ACK는 제외하며, 익명 ACK는 유저 매핑 불가라 갱신 수신에서 제외한다.</div>
          <div>• <span className="text-gray-300">채널 내장</span> = p2s payload에 broadcast channelId를 포함해 APNs가 접수한 서버 기록. 실제 기기 구독·표시 확인이 아니므로 이것만으로 기기 등록 확인에 합산하지 않는다.</div>
          <div>• <span className="text-gray-300">무음 wake 성공률</span> = 갱신불가 카드에 무음 푸시를 시도한 후 update 토큰/채널 ACK 등록으로 전환된 비율. 강제종료(스와이프 kill) 기기는 iOS가 안 깨워 구조적으로 실패한다.</div>
          <div>• <span className="text-gray-300">과거 잔존</span> = 오늘 경기 목록에 없는 지난 game_id의 발급 기록 행. iOS가 카드를 ~8시간 내 자동 만료시키므로 실제 좀비 카드가 아니라 서버 기록 잔재{s ? ` (현재 ${s.residualRows}행 / ${s.residualGameCount}경기)` : ""}.</div>
          <div>• <span className="text-gray-300">미상(활성 fallback)</span> = 오늘 game_id인데 KBO 일정 조회 실패나 목록 누락으로 상태를 확정 못한 경우. 요약에는 활성으로 포함해 집계 누락을 막는다.</div>
          <div>• <span className="text-gray-300">기기 등록 확인</span> = 시작 요청 중 update 토큰 보유 또는 현재 active 채널 ACK가 확인된 기록(중복 제거). 실제 화면 노출을 증명하지 않는다. 경기룸 방문으로만 뜬 LA는 전체 update 토큰 수치에만 포함된다.</div>
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
