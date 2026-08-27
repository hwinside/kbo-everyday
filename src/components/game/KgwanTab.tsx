"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { ChevronDown, ChevronUp } from "lucide-react";
import { clsx } from "clsx";
import Image from "next/image";
import { getTeamById, isAllStarGame, isAllStarGameId } from "@/lib/constants/teams";
import {
  createSummaryFingerprint,
  shouldHideStaleCache,
  type SummaryFingerprint,
} from "@/lib/game-summary/cache-validation";
import GameChatSlot from "@/components/game/GameChatSlot";
import ContextualStatsBox from "@/components/game/ContextualStatsBox";
import VenueStorySection from "@/components/game/VenueStorySection";
import RelayPlayLine from "@/components/game/RelayPlayLine";
import CurrentAtBatCard from "@/components/game/LivePitchByPitch";
import { useRouter } from "next/navigation";
import type { GameEvent } from "@/types/game-events";
import type { GamePlay } from "@/lib/types";
import type { GameDetailResponse } from "@/app/api/game-detail/route";
import type { GameRelayResponse } from "@/app/api/game-relay/route";
import { resolveCurrentAtBat } from "@/lib/game/current-at-bat";
import { useKgwanAutoFocus } from "@/hooks/useKgwanAutoFocus";
import { cancelReasonDetail } from "@/lib/utils/cancel-reason";

interface KgwanTabProps {
  /** 당겨서 새로고침 epoch — 증가 시 종료 요약(FinalView)이 GET 재조회(오류 카드 stuck 해소). */
  refreshEpoch?: number;
  gameId: string;
  homeTeamId: number;
  awayTeamId: number;
  gameDate?: string | null;
  gameStartTime?: string | null;
  status: "scheduled" | "live" | "final" | "cancelled";
  /**
   * 취소 사유 원문(`우천취소`/`폭염취소`/`그라운드사정` 등). status=cancelled 일 때만 유의미.
   * 미수신(null/undefined)이면 기존 고정 문구로 fallback 한다.
   */
  cancelReason?: string | null;
  gameEvents: GameEvent[];
  plays: GamePlay[];
  teamColor: string;
  boxScore: GameDetailResponse["boxScore"] | null;
  linescore?: {
    away: { innings: (number | null)[]; R: number; H: number; E: number };
    home: { innings: (number | null)[]; R: number; H: number; E: number };
  } | null;
  starterNames?: { away: string; home: string };
  lineupConfirmed?: boolean;
  gameRelay?: GameRelayResponse | null;
  currentPitcher?: string | null;
  currentBatter?: string | null;
  balls?: number;
  strikes?: number;
  outs?: number;
}

/* ===== AI Preview Card (inline in KgwanTab) ===== */
interface PreviewData {
  awayWinPct: number;
  homeWinPct: number;
  prediction: string;
  keyMatchup: string;
}

const GAME_CHAT_OPEN_LEAD_MS = 2 * 60 * 60 * 1000;

function getGameStartAtKst(gameId: string, gameDate?: string | null, gameStartTime?: string | null): Date | null {
  const datePart = gameDate?.match(/^\d{4}-\d{2}-\d{2}$/)?.[0]
    ?? gameId.match(/^(\d{4})(\d{2})(\d{2})/)?.slice(1, 4).join("-");
  const timeMatch = gameStartTime?.match(/(\d{1,2}):(\d{2})/);
  if (!datePart || !timeMatch) return null;

  const [, hour, minute] = timeMatch;
  return new Date(`${datePart}T${hour.padStart(2, "0")}:${minute}:00+09:00`);
}

function formatKstTime(date: Date): string {
  return date.toLocaleTimeString("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "numeric",
    minute: "2-digit",
  });
}

function AIPreviewCard({ gameId, awayTeamId, homeTeamId, starterNames }: {
  gameId: string; awayTeamId: number; homeTeamId: number; starterNames?: { away: string; home: string };
}) {
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fetchedRef = useRef(false);
  const awayTeam = getTeamById(awayTeamId)!;
  const homeTeam = getTeamById(homeTeamId)!;

  useEffect(() => {
    // 올스타전은 팀기반 AI 예측/승부예측 대상 아님 — API 호출·렌더 안 함.
    if (isAllStarGame(awayTeamId, homeTeamId)) { setLoading(false); return; }
    if (fetchedRef.current) return;
    fetchedRef.current = true;

    async function fetchPreview() {
      try {
        // 1) 캐시 확인
        const cacheRes = await fetch(`/api/game-preview?gameId=${gameId}`);
        const cacheData = await cacheRes.json();
        if (cacheData.source === "too_early") {
          setNotice(cacheData.message || "경기 12시간 전부터 AI 경기 예측 조회가 가능합니다.");
          setLoading(false);
          return;
        }
        // 구버전(outdated) 캐시는 렌더하지 않고 재생성 — 새 순위 가드 반영
        if (cacheData.preview && !cacheData.outdated) {
          setPreview(cacheData.preview);
          setLoading(false);
          return;
        }

        // 2) 캐시 없음 or 구버전 → 생성/재생성 요청
        const genRes = await fetch("/api/game-preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            gameId,
            awayTeamId,
            homeTeamId,
            awayStarter: starterNames?.away,
            homeStarter: starterNames?.home,
          }),
        });
        const genData = await genRes.json();
        if (genData.source === "too_early") {
          // 재생성 불가면 구버전 캐시라도 노출 (graceful)
          if (cacheData.preview) setPreview(cacheData.preview);
          else setNotice(genData.message || "경기 12시간 전부터 AI 경기 예측 조회가 가능합니다.");
          return;
        }
        if (genData.preview) {
          setPreview(genData.preview);
        } else if (cacheData.preview) {
          setPreview(cacheData.preview); // 재생성 실패 시 구버전 폴백
        }
      } catch (err) {
        // preview fetch error — silent
      } finally {
        setLoading(false);
      }
    }

    fetchPreview();
  }, [gameId, awayTeamId, homeTeamId, starterNames]);

  // 올스타전은 팀기반 AI 예측/승부예측 미제공 — 카드 자체를 숨긴다.
  if (isAllStarGame(awayTeamId, homeTeamId)) return null;

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="glass-card p-4">
          <div className="flex items-center justify-center gap-2 mb-3">
            <span className="text-base">🤖</span>
            <span className="text-sm font-semibold text-text-primary">AI 경기 예측</span>
          </div>
          <div className="flex items-center justify-center py-6">
            <div className="w-5 h-5 border-2 border-text-tertiary border-t-accent rounded-full animate-spin" />
            <span className="ml-2 text-xs text-text-tertiary">AI가 분석 중...</span>
          </div>
        </div>
      </div>
    );
  }

  if (notice) {
    return (
      <div className="glass-card p-4">
        <p className="text-center text-sm font-medium text-text-secondary">{notice}</p>
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="glass-card p-4">
        <p className="text-center text-xs text-text-tertiary">AI 경기 예측을 준비 중입니다</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Win probability */}
      <div className="glass-card p-4">
        <div className="flex items-center justify-center gap-2 mb-3">
          <span className="text-base">🤖</span>
          <span className="text-sm font-semibold text-text-primary">AI 경기 예측</span>
        </div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5">
            <Image src={awayTeam.logoPath} alt="" width={20} height={20} unoptimized className="object-contain" />
            <span className="text-xs font-bold" style={{ color: awayTeam.colorLight }}>{awayTeam.shortName}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-bold" style={{ color: homeTeam.colorLight }}>{homeTeam.shortName}</span>
            <Image src={homeTeam.logoPath} alt="" width={20} height={20} unoptimized className="object-contain" />
          </div>
        </div>
        <div className="flex h-8 rounded-lg overflow-hidden">
          <div
            className="flex items-center justify-center text-white text-xs font-bold transition-all"
            style={{ width: `${preview.awayWinPct}%`, backgroundColor: awayTeam.colorPrimary }}
          >
            {preview.awayWinPct}%
          </div>
          <div
            className="flex items-center justify-center text-white text-xs font-bold transition-all"
            style={{ width: `${preview.homeWinPct}%`, backgroundColor: homeTeam.colorPrimary }}
          >
            {preview.homeWinPct}%
          </div>
        </div>
        <p className="text-center text-[11px] text-text-tertiary mt-2">
          {preview.prediction}
        </p>
      </div>

      {/* Key matchup summary */}
      <div className="glass-card p-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-sm">🔑</span>
          <span className="text-sm font-semibold text-text-primary">핵심 포인트</span>
        </div>
        <p className="text-xs text-text-secondary leading-relaxed whitespace-pre-line">
          {preview.keyMatchup}
        </p>
      </div>

      <p className="text-center text-[10px] text-text-tertiary">
        ※ AI 분석은 참고용이며 실제 경기 결과와 다를 수 있습니다
      </p>
    </div>
  );
}

/* ===== Scheduled: AI Preview ===== */
function ScheduledView({ gameId, awayTeamId, homeTeamId, gameDate, gameStartTime, starterNames, lineupConfirmed }: {
  gameId: string;
  awayTeamId: number;
  homeTeamId: number;
  gameDate?: string | null;
  gameStartTime?: string | null;
  starterNames?: { away: string; home: string };
  lineupConfirmed?: boolean;
}) {
  const awayTeam = getTeamById(awayTeamId)!;
  const homeTeam = getTeamById(homeTeamId)!;
  const [nowMs, setNowMs] = useState(() => Date.now());
  const gameStartAt = useMemo(() => getGameStartAtKst(gameId, gameDate, gameStartTime), [gameId, gameDate, gameStartTime]);
  const chatOpensAt = gameStartAt ? new Date(gameStartAt.getTime() - GAME_CHAT_OPEN_LEAD_MS) : null;
  // 올스타전은 2시간 게이트 없이 즉시 오픈 — 이벤트 특성상 미리 모여 떠들 수 있게 (하린아빠 2026-07-11).
  const isChatOpen = isAllStarGame(awayTeamId, homeTeamId) || (chatOpensAt ? nowMs >= chatOpensAt.getTime() : false);

  useEffect(() => {
    if (isChatOpen) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [isChatOpen]);

  return (
    <div className="px-4 py-4 space-y-4">
      {/* Starter matchup card */}
      <div className="glass-card p-4">
        <div className="text-xs text-text-tertiary text-center mb-3">선발 투수 매치업</div>
        <div className="flex items-center justify-between">
          <div className="flex flex-col items-center gap-2 flex-1">
            <div className="w-10 h-10 rounded-full bg-white p-1 flex items-center justify-center">
              <Image src={awayTeam.logoPath} alt="" width={28} height={28} unoptimized className="object-contain" />
            </div>
            <span className="text-sm font-bold" style={{ color: awayTeam.colorLight }}>{awayTeam.shortName}</span>
            <span className="text-base font-semibold text-text-primary">{starterNames?.away || "미정"}</span>
          </div>
          <span className="text-text-tertiary text-lg font-bold">VS</span>
          <div className="flex flex-col items-center gap-2 flex-1">
            <div className="w-10 h-10 rounded-full bg-white p-1 flex items-center justify-center">
              <Image src={homeTeam.logoPath} alt="" width={28} height={28} unoptimized className="object-contain" />
            </div>
            <span className="text-sm font-bold" style={{ color: homeTeam.colorLight }}>{homeTeam.shortName}</span>
            <span className="text-base font-semibold text-text-primary">{starterNames?.home || "미정"}</span>
          </div>
        </div>
      </div>

      {/* AI 경기 예측 */}
      <AIPreviewCard gameId={gameId} awayTeamId={awayTeamId} homeTeamId={homeTeamId} starterNames={starterNames} />

      {/* 직관 라이브 — 전체 채팅 바로 위 */}
      <VenueStorySection gameId={gameId} />

      {/* Pre-game chat opens 2 hours before first pitch */}
      {isChatOpen ? (
        <GameChatSlot gameId={gameId} homeTeamId={homeTeamId} awayTeamId={awayTeamId} />
      ) : (
        <div className="glass-card p-4 text-center space-y-1.5">
          <p className="text-sm font-semibold text-text-primary">크관 채팅은 경기 시작 2시간 전부터 열려요</p>
          {chatOpensAt ? (
            <p className="text-xs text-text-tertiary">오픈 예정: {formatKstTime(chatOpensAt)}</p>
          ) : (
            <p className="text-xs text-text-tertiary">경기 시간이 확정되면 오픈 시간이 표시됩니다</p>
          )}
        </div>
      )}
    </div>
  );
}

/* ===== Play type → emoji ===== */
/* ===== Live: Relay + Chat ===== */
function LiveView({
  gameId,
  homeTeamId,
  awayTeamId,
  gameEvents,
  gameRelay,
  currentPitcher,
  currentBatter,
  balls = 0,
  strikes = 0,
  outs = 0,
}: {
  gameId: string;
  homeTeamId: number;
  awayTeamId: number;
  gameEvents: GameEvent[];
  gameRelay?: GameRelayResponse | null;
  currentPitcher?: string | null;
  currentBatter?: string | null;
  balls?: number;
  strikes?: number;
  outs?: number;
}) {
  const [expandedInning, setExpandedInning] = useState<string | null>(null);
  const [showPreviousInnings, setShowPreviousInnings] = useState(false);
  // 자동 포커싱(새 투구 시 현재 타석으로 scrollIntoView) 사용자 설정 — 채팅 카드의
  // "자동 포커싱 끄기" 버튼(GameChat)과 localStorage+이벤트로 동기화된다.
  const { enabled: autoFocusEnabled } = useKgwanAutoFocus();

  // 네이버 relay가 있으면 이닝별 상세 표시, 없으면 diff 이벤트 fallback
  const hasRelay = gameRelay && gameRelay.innings.length > 0;

  // 이닝 시간순 (최신 이닝이 아래 — 채팅과 같은 방향)
  const orderedInnings = useMemo(() => {
    if (!gameRelay) return [];
    return [...gameRelay.innings].sort((a, b) => {
      if (a.inning !== b.inning) return a.inning - b.inning;
      // 같은 이닝이면 초(top) < 말(bottom)
      return a.half === "top" ? -1 : 1;
    });
  }, [gameRelay]);

  // 최신 이닝과 이전 이닝 분리
  const latestInning = orderedInnings.length > 0 ? orderedInnings[orderedInnings.length - 1] : null;
  const previousInnings = orderedInnings.slice(0, -1);
  const currentAtBat = resolveCurrentAtBat({
    hasRelay: Boolean(hasRelay),
    latestInning,
    currentBatter,
  });

  return (
    <div className="flex flex-col h-full">
      {/* Live relay */}
      {hasRelay ? (
        <div className="bg-bg-tertiary border-b border-border max-h-[40vh] overflow-y-auto">
          {/* 이전 이닝 토글 버튼 */}
          {previousInnings.length > 0 && (
            <>
              <button
                onClick={() => setShowPreviousInnings(!showPreviousInnings)}
                className="w-full flex items-center justify-center gap-1.5 px-4 py-2.5 text-text-tertiary hover:bg-black/5 dark:hover:bg-white/5 transition-colors border-b border-border/30"
              >
                {showPreviousInnings ? (
                  <ChevronUp size={14} />
                ) : (
                  <ChevronDown size={14} />
                )}
                <span className="text-[11px] font-medium">
                  {showPreviousInnings ? "이전 이닝 접기" : `이전 이닝 보기 (${previousInnings.length}개)`}
                </span>
              </button>

              {/* 이전 이닝 목록 (토글) */}
              {showPreviousInnings && previousInnings.map((inn) => {
                const inningKey = `${inn.inning}-${inn.half}`;
                const isExpanded = expandedInning === inningKey;
                const halfLabel = inn.half === "top" ? "초" : "말";
                const totalPlays = inn.plays.length;

                return (
                  <div key={inningKey} className="border-b border-border/30 last:border-b-0">
                    <button
                      onClick={() => setExpandedInning(isExpanded ? null : inningKey)}
                      className="w-full flex items-center gap-2 px-4 py-2 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-bold text-accent">{inn.inning}회{halfLabel}</span>
                        <span className="text-[11px] text-text-tertiary">{inn.teamName} 공격</span>
                      </div>
                      <span className="text-[10px] text-text-tertiary ml-auto">{totalPlays}타석</span>
                      {isExpanded ? <ChevronUp size={12} className="text-text-tertiary" /> : <ChevronDown size={12} className="text-text-tertiary" />}
                    </button>

                    {isExpanded && inn.plays.length > 0 && (
                      <div className="px-4 pb-2 space-y-1.5">
                        {inn.plays.map((play, idx) => (
                          <RelayPlayLine key={`${inningKey}-${idx}`} play={play} />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}

          {/* 최신(현재) 이닝 — 항상 펼침 */}
          {latestInning && (() => {
            const inningKey = `${latestInning.inning}-${latestInning.half}`;
            const halfLabel = latestInning.half === "top" ? "초" : "말";
            const totalPlays = latestInning.plays.length;

            return (
              <div key={inningKey} className="border-b border-border/30 last:border-b-0">
                <div className="w-full flex items-center gap-2 px-4 py-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-bold text-accent">{latestInning.inning}회{halfLabel}</span>
                    <span className="text-[11px] text-text-tertiary">{latestInning.teamName} 공격</span>
                  </div>
                  <span className="text-[10px] text-text-tertiary ml-auto">{totalPlays}타석</span>
                </div>

                {/* 시간순 배치: 완료 타석(오래된→최신)을 위에, 현재 타석 카드를 맨
                   아래에 둔다. 위→아래로 타순이 자연스럽게 이어진다(예: 7번→8번→현재
                   9번). scrollOnUpdate 는 최신 투구(맨 아래)로 스크롤되어 자연스럽다. */}
                {latestInning.plays.length > 0 && (
                  <div className="px-4 pb-2">
                    {currentAtBat && (
                      <p className="pb-1 pt-0.5 text-[10px] font-semibold text-text-tertiary">
                        이전 완료 타석 · 눌러서 투구 보기
                      </p>
                    )}
                    {latestInning.plays.map((play, idx) => (
                      <RelayPlayLine key={`${inningKey}-${idx}`} play={play} />
                    ))}
                  </div>
                )}

                {currentAtBat && (
                  <CurrentAtBatCard
                    batterName={currentAtBat.batterName}
                    batOrder={currentAtBat.batOrder}
                    pitcherName={currentPitcher}
                    pitches={currentAtBat.pitches}
                    balls={balls}
                    strikes={strikes}
                    outs={outs}
                    updatedAt={gameRelay?.updatedAt}
                    scrollOnUpdate={autoFocusEnabled}
                  />
                )}
              </div>
            );
          })()}
        </div>
      ) : gameEvents.length > 0 ? (
        /* Fallback: diff 기반 이벤트 (relay 없을 때) */
        <div className="bg-bg-tertiary border-b border-border">
          <div className="flex items-stretch">
            <div className="w-1 bg-red-500 shrink-0 rounded-r" />
            <div className="flex-1 px-3 py-2 space-y-1">
              {gameEvents.slice(-5).map((ev) => (
                <p key={ev.id} className="text-sm text-text-secondary leading-relaxed">
                  <span className="text-text-tertiary mr-1.5">{ev.inning}회{ev.isTop ? "초" : "말"}</span>
                  {ev.text}
                </p>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {/* Contextual stats box — 문자중계와 채팅 사이 상황별 맞춤 스탯 */}
      <ContextualStatsBox gameId={gameId} enabled />

      {/* 직관 라이브 — 상황별 스탯(오지환 vs) 아래, 전체 채팅 바로 위. 업로드는
          VenueStorySection 내부에서 네이티브 런타임+GPS+로그인 게이트, 열람은 익명 허용. */}
      <VenueStorySection gameId={gameId} />

      {/* Chat */}
      <GameChatSlot gameId={gameId} homeTeamId={homeTeamId} awayTeamId={awayTeamId} />
    </div>
  );
}

/* ===== Final: AI Summary + Chat ===== */
function FinalView({ gameId, homeTeamId, awayTeamId, boxScore, linescore, refreshEpoch }: {
  gameId: string;
  homeTeamId: number;
  awayTeamId: number;
  boxScore: GameDetailResponse["boxScore"] | null;
  linescore?: {
    away: { innings: (number | null)[]; R: number; H: number; E: number };
    home: { innings: (number | null)[]; R: number; H: number; E: number };
  } | null;
  refreshEpoch?: number;
}) {
  const homeTeam = getTeamById(homeTeamId)!;
  const awayTeam = getTeamById(awayTeamId)!;
  const isAllStar = isAllStarGameId(gameId);

  // LLM 요약 상태
  const [llmSummary, setLlmSummary] = useState<{
    headline: string;
    gameFlow?: { early: string; mid: string; late: string };
    turningPoint: string;
    mvpBatter: string | { name: string; stats: string; reason: string } | null;
    mvpPitcher: string | { name: string; stats: string; reason: string } | null;
    insight: string;
    seriesContext?: string | null;
    standingsImpact?: string | null;
  } | null>(null);
  const [llmLoading, setLlmLoading] = useState(false);
  const [generationPending, setGenerationPending] = useState(false);
  const [llmError, setLlmError] = useState<"timeout" | "network" | "parse" | null>(null);
  const [retryNonce, setRetryNonce] = useState(0); // manual retry trigger
  const regeneratingRef = useRef(false); // de-dupe: prevent duplicate background POST
  const cachePollStartedAtRef = useRef<number | null>(null); // transient generation failures can still finish into cache

  // BoxScore가 실질적 데이터를 갖고 있는지 확인 (빈 배열이면 무의미)
  const hasRealBoxScore = boxScore &&
    (boxScore.awayBatters.length > 0 || boxScore.homeBatters.length > 0);

  // LLM 요약 fetch — 캐시는 항상 확인, 생성은 boxScore 있을 때만
  // 30초 타임아웃 + 실패 시 에러 상태 유지 (자동 fallback 복귀 절대 금지)
  useEffect(() => {
    if (isAllStar || llmSummary) return;

    const TIMEOUT_MS = 30_000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const fetchLlmSummary = async () => {
      setLlmLoading(true);
      setLlmError(null);
      try {
        // 1. 캐시 확인 (boxScore 없어도 항상 시도)
        const cacheRes = await fetch(`/api/game-summary?gameId=${gameId}`, { signal: controller.signal });
        const cacheData = await cacheRes.json();
        if (cacheData.summary) {
          // final status+score+innings fingerprint가 일치하지 않거나 legacy면 1프레임도 노출하지 않는다.
          const currentFingerprint: SummaryFingerprint | null = linescore
            ? createSummaryFingerprint(
                linescore.away.R,
                linescore.home.R,
                linescore.away.innings,
                linescore.home.innings,
              )
            : null;
          const hideStale = shouldHideStaleCache(
            cacheData.fingerprint as SummaryFingerprint | null | undefined,
            currentFingerprint,
          );
          // outdated도 같은 controller의 재생성 POST가 state cleanup으로 abort되지 않도록 생성 완료 전 숨긴다.
          if (!hideStale && !cacheData.outdated) setLlmSummary(cacheData.summary);
          // outdated(프롬프트 버전) OR stale/legacy(hideStale) → 재생성.
          if ((cacheData.outdated || hideStale) && hasRealBoxScore && boxScore && !regeneratingRef.current) {
            regeneratingRef.current = true; // prevent re-entry on re-render
            // linescore.R 우선, boxScore 합산 fallback (승패 뒤집힘 방지)
            const homeR = linescore?.home.R ?? boxScore.homeBatters.reduce((s, b) => s + b.runs, 0);
            const awayR = linescore?.away.R ?? boxScore.awayBatters.reduce((s, b) => s + b.runs, 0);
            const totalAB = [...boxScore.awayBatters, ...boxScore.homeBatters].reduce((s, b) => s + b.atBats, 0);
            if (totalAB > 0) {
              const payload = {
                gameId,
                awayTeam: awayTeam.shortName,
                homeTeam: homeTeam.shortName,
                awayScore: awayR,
                homeScore: homeR,
                linescore: linescore ? {
                  away: { innings: linescore.away.innings, R: linescore.away.R, H: linescore.away.H, E: linescore.away.E },
                  home: { innings: linescore.home.innings, R: linescore.home.R, H: linescore.home.H, E: linescore.home.E },
                } : undefined,
                awayBatters: boxScore.awayBatters.map(b => ({
                  name: b.name, ab: b.atBats, r: b.runs, h: b.hits,
                  rbi: b.rbi, hr: b.hr, bb: b.bb, so: b.so, avg: b.avg || "",
                })),
                homeBatters: boxScore.homeBatters.map(b => ({
                  name: b.name, ab: b.atBats, r: b.runs, h: b.hits,
                  rbi: b.rbi, hr: b.hr, bb: b.bb, so: b.so, avg: b.avg || "",
                })),
                awayPitchers: boxScore.awayPitchers.map(p => ({
                  name: p.name, ip: p.inningsPitched, h: p.hits, r: p.runs,
                  er: p.earnedRuns, bb: p.walks, so: p.strikeouts, hr: p.hr,
                  np: p.pitchCount, result: p.decision || undefined,
                })),
                homePitchers: boxScore.homePitchers.map(p => ({
                  name: p.name, ip: p.inningsPitched, h: p.hits, r: p.runs,
                  er: p.earnedRuns, bb: p.walks, so: p.strikeouts, hr: p.hr,
                  np: p.pitchCount, result: p.decision || undefined,
                })),
              };
              try {
                const res = await fetch("/api/game-summary", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(payload),
                  signal: controller.signal,
                });
                const data = await res.json();
                if (res.status === 202 && data.source === "generation-in-flight") {
                  setGenerationPending(true);
                  return;
                }
                if (!res.ok || !data.summary) throw new Error("regeneration-failed");
                setGenerationPending(false);
                setLlmSummary(data.summary);
              } finally {
                regeneratingRef.current = false;
              }
            } else {
              regeneratingRef.current = false;
              setLlmError("parse");
            }
          }
          return;
        }

        // 2. 생성 요청 — boxScore 데이터 필수
        if (!hasRealBoxScore || !boxScore) return;

        // linescore.R 우선, boxScore 합산 fallback (승패 뒤집힘 방지)
        const homeR = linescore?.home.R ?? boxScore.homeBatters.reduce((s, b) => s + b.runs, 0);
        const awayR = linescore?.away.R ?? boxScore.awayBatters.reduce((s, b) => s + b.runs, 0);
        const totalAB = [...boxScore.awayBatters, ...boxScore.homeBatters].reduce((s, b) => s + b.atBats, 0);
        if (totalAB === 0) {
          // BoxScore 데이터 미완성 → 생성 건너뜀 (다음 렌더에서 재시도)
          // BoxScore data incomplete (0 AB), skipping summary generation
          return;
        }
        
        const payload = {
          gameId,
          awayTeam: awayTeam.shortName,
          homeTeam: homeTeam.shortName,
          awayScore: awayR,
          homeScore: homeR,
          linescore: linescore ? {
            away: { innings: linescore.away.innings, R: linescore.away.R, H: linescore.away.H, E: linescore.away.E },
            home: { innings: linescore.home.innings, R: linescore.home.R, H: linescore.home.H, E: linescore.home.E },
          } : undefined,
          awayBatters: boxScore.awayBatters.map(b => ({
            name: b.name, ab: b.atBats, r: b.runs, h: b.hits,
            rbi: b.rbi, hr: b.hr, bb: b.bb, so: b.so, avg: b.avg || "",
          })),
          homeBatters: boxScore.homeBatters.map(b => ({
            name: b.name, ab: b.atBats, r: b.runs, h: b.hits,
            rbi: b.rbi, hr: b.hr, bb: b.bb, so: b.so, avg: b.avg || "",
          })),
          awayPitchers: boxScore.awayPitchers.map(p => ({
            name: p.name, ip: p.inningsPitched, h: p.hits, r: p.runs,
            er: p.earnedRuns, bb: p.walks, so: p.strikeouts, hr: p.hr,
            np: p.pitchCount, result: p.decision || undefined,
          })),
          homePitchers: boxScore.homePitchers.map(p => ({
            name: p.name, ip: p.inningsPitched, h: p.hits, r: p.runs,
            er: p.earnedRuns, bb: p.walks, so: p.strikeouts, hr: p.hr,
            np: p.pitchCount, result: p.decision || undefined,
          })),
        };

        const genRes = await fetch("/api/game-summary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!genRes.ok) {
          // 5xx/422 등 → 에러 상태 유지 (자동 fallback 금지)
          setLlmError("network");
          return;
        }
        const genData = await genRes.json();
        if (genRes.status === 202 && genData.source === "generation-in-flight") {
          setGenerationPending(true);
          return;
        }
        if (genData.summary) {
          setGenerationPending(false);
          setLlmSummary(genData.summary);
        } else {
          // summary 필드 없음 → parse 실패로 간주
          setLlmError("parse");
        }
      } catch (err) {
        // AbortError(timeout) vs 네트워크 에러 구분 — 둘 다 수동 재시도 유도
        if (err instanceof Error && err.name === "AbortError") {
          setLlmError("timeout");
        } else {
          setLlmError("network");
        }
      } finally {
        clearTimeout(timeoutId);
        setLlmLoading(false);
      }
    };

    fetchLlmSummary();

    return () => {
      clearTimeout(timeoutId);
      controller.abort();
    };
    // refreshEpoch: 당겨서 새로고침 시 증가 → llmSummary 미로딩(오류/로딩) 상태면 이 이펙트가
    // 재실행되어 setLlmError(null)+GET 재조회. 요약이 이미 로딩됐으면 상단 early-return → 무동작
    // (채팅 등 다른 client state 는 건드리지 않음 — 최소 범위).
  }, [isAllStar, hasRealBoxScore, boxScore, gameId, llmSummary, awayTeam, homeTeam, linescore, retryNonce, refreshEpoch]);

  // 최초 생성이 30초를 넘기거나 일시 실패해도 서버 쪽 생성이 뒤늦게 캐시에 저장될 수 있다.
  // 이 경우 사용자에게 에러 카드로 고정하지 않고 잠시 캐시를 자동 확인한다.
  useEffect(() => {
    if (isAllStar || (!llmError && !generationPending) || llmSummary || !hasRealBoxScore) {
      cachePollStartedAtRef.current = null;
      return;
    }

    if (cachePollStartedAtRef.current == null) {
      cachePollStartedAtRef.current = Date.now();
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const startedAt = cachePollStartedAtRef.current;
    const MAX_POLL_MS = 120_000;

    const pollCache = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/game-summary?gameId=${gameId}`);
        const data = await res.json();
        if (cancelled) return;
        const currentFingerprint: SummaryFingerprint | null = linescore
          ? createSummaryFingerprint(
              linescore.away.R,
              linescore.home.R,
              linescore.away.innings,
              linescore.home.innings,
            )
          : null;
        const currentCache =
          data.summary &&
          !data.outdated &&
          !shouldHideStaleCache(
            data.fingerprint as SummaryFingerprint | null | undefined,
            currentFingerprint,
          );
        if (currentCache) {
          setGenerationPending(false);
          setLlmSummary(data.summary);
          setLlmError(null);
          cachePollStartedAtRef.current = null;
          return;
        }
      } catch {
        // ignore transient poll failures; manual retry button remains available
      }

      if (!cancelled && Date.now() - startedAt < MAX_POLL_MS) {
        timer = setTimeout(pollCache, 5_000);
      } else if (!cancelled && generationPending) {
        setGenerationPending(false);
        setLlmError("timeout");
      }
    };

    timer = setTimeout(pollCache, 3_000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [isAllStar, llmError, generationPending, llmSummary, hasRealBoxScore, gameId, linescore]);


  // LLM 요약만 사용 (fallback/숏버전 폐기)
  const summary = llmSummary
    ? {
        headline: llmSummary.headline,
        gameFlow: llmSummary.gameFlow,
        turningPoint: llmSummary.turningPoint,
        mvpBatterLabel: typeof llmSummary.mvpBatter === "string"
          ? llmSummary.mvpBatter
          : llmSummary.mvpBatter
            ? `${llmSummary.mvpBatter.name} (${llmSummary.mvpBatter.stats})`
            : null,
        mvpBatterReason: typeof llmSummary.mvpBatter === "object" && llmSummary.mvpBatter
          ? llmSummary.mvpBatter.reason
          : null,
        mvpText: typeof llmSummary.mvpBatter === "string"
          ? llmSummary.mvpBatter
          : llmSummary.mvpBatter
            ? `${llmSummary.mvpBatter.name} (${llmSummary.mvpBatter.stats}) — ${llmSummary.mvpBatter.reason}`
            : null,
        pitcherLabel: llmSummary.mvpPitcher == null ? null
          : typeof llmSummary.mvpPitcher === "string" ? llmSummary.mvpPitcher
          : (llmSummary.mvpPitcher.name && llmSummary.mvpPitcher.name !== "null")
            ? `${llmSummary.mvpPitcher.name} (${llmSummary.mvpPitcher.stats})`
            : null,
        pitcherReason: typeof llmSummary.mvpPitcher === "object" && llmSummary.mvpPitcher
          && llmSummary.mvpPitcher.name && llmSummary.mvpPitcher.name !== "null"
          ? llmSummary.mvpPitcher.reason
          : null,
        pitcherHighlight: llmSummary.mvpPitcher == null ? null
          : typeof llmSummary.mvpPitcher === "string" ? llmSummary.mvpPitcher
          : (llmSummary.mvpPitcher.name && llmSummary.mvpPitcher.name !== "null")
            ? `${llmSummary.mvpPitcher.name} (${llmSummary.mvpPitcher.stats}) — ${llmSummary.mvpPitcher.reason}`
            : null,
        insight: llmSummary.insight,
        seriesContext: llmSummary.seriesContext || null,
        standingsImpact: llmSummary.standingsImpact || null,
      }
    : null;

  return (
    <div className="flex flex-col h-full">
      {/* AI Summary Cards */}
      <div className="px-4 py-4">
        {isAllStar ? (
          <div className="glass-card p-5 text-center">
            <p className="text-sm text-text-tertiary">올스타전은 AI 경기 요약을 제공하지 않습니다</p>
          </div>
        ) : summary ? (
          <div className="glass-card p-5 space-y-4">
            {/* AI 라벨 */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs">🤖</span>
              <span className="text-[11px] font-semibold text-accent">AI 경기 요약</span>
            </div>

            {/* 헤드라인 */}
            <p className="text-base font-bold text-text-primary leading-snug">{summary.headline}</p>

            {/* 경기 흐름 (LLM에서만) */}
            {summary.gameFlow && (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-xs">⚾</span>
                  <span className="text-[11px] font-semibold text-text-tertiary">경기 흐름</span>
                </div>
                {[
                  { label: "초반 (1~3회)", text: summary.gameFlow.early },
                  { label: "중반 (4~6회)", text: summary.gameFlow.mid },
                  { label: "후반 (7~9회)", text: summary.gameFlow.late },
                ].map((phase) => (
                  <div key={phase.label}>
                    <span className="text-[10px] font-bold text-accent/70">{phase.label}</span>
                    <p className="text-sm text-text-primary leading-relaxed mt-0.5">{phase.text}</p>
                  </div>
                ))}
              </div>
            )}

            {/* 승부처 */}
            {summary.turningPoint && (
              <div>
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-xs">🔑</span>
                  <span className="text-[11px] font-semibold text-text-tertiary">승부처</span>
                </div>
                <p className="text-sm text-text-primary leading-relaxed">{summary.turningPoint}</p>
              </div>
            )}

            {/* 오늘의 타자 */}
            {summary.mvpBatterLabel && (
              <div>
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-xs">⭐</span>
                  <span className="text-[11px] font-semibold text-text-tertiary">오늘의 타자</span>
                </div>
                <p className="text-sm text-text-primary leading-relaxed">
                  <span className="font-semibold text-text-primary">{summary.mvpBatterLabel}</span>
                  {summary.mvpBatterReason && (
                    <span className="font-normal" style={{ color: "var(--text-readable)" }}> — {summary.mvpBatterReason}</span>
                  )}
                </p>
              </div>
            )}

            {/* 오늘의 투수 */}
            {summary.pitcherLabel && (
              <div>
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-xs">🔥</span>
                  <span className="text-[11px] font-semibold text-text-tertiary">오늘의 투수</span>
                </div>
                <p className="text-sm text-text-primary leading-relaxed">
                  <span className="font-semibold text-text-primary">{summary.pitcherLabel}</span>
                  {summary.pitcherReason && (
                    <span className="font-normal" style={{ color: "var(--text-readable)" }}> — {summary.pitcherReason}</span>
                  )}
                </p>
              </div>
            )}

            {/* 경기 분석 */}
            {summary.insight && (
              <div>
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-xs">📊</span>
                  <span className="text-[11px] font-semibold text-text-tertiary">경기 분석</span>
                </div>
                <p className="text-sm text-text-primary leading-relaxed">{summary.insight}</p>
              </div>
            )}

            {/* 시리즈 맥락 + 순위 영향 */}
            {(summary.seriesContext || summary.standingsImpact) && (
              <div className="space-y-2">
                {summary.seriesContext && (
                  <div>
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="text-xs">⚾</span>
                      <span className="text-[11px] font-semibold text-text-tertiary">시리즈</span>
                    </div>
                    <p className="text-sm text-text-primary leading-relaxed">{summary.seriesContext}</p>
                  </div>
                )}
                {summary.standingsImpact && (
                  <div>
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="text-xs">🏆</span>
                      <span className="text-[11px] font-semibold text-text-tertiary">순위 영향</span>
                    </div>
                    <p className="text-sm text-text-primary leading-relaxed">{summary.standingsImpact}</p>
                  </div>
                )}
              </div>
            )}

            <p className="text-center text-[10px] text-text-tertiary pt-1 border-t border-border/30">
              박스스코어 기반 자동 생성 · 실제와 다를 수 있습니다
            </p>
          </div>
        ) : (
          <div className="glass-card p-5 text-center">
            {/* 상태 우선순위: 생성중 > 에러(수동재시도) > 데이터없음(집계중) */}
            {llmLoading || generationPending ? (
              <div className="flex flex-col items-center gap-3 py-4">
                <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                <div>
                  <p className="text-sm font-medium text-text-primary">🤖 AI 경기 요약 생성 중...</p>
                  <p className="text-xs text-text-tertiary mt-1">박스스코어 기반으로 분석하고 있어요 (최대 30초)</p>
                </div>
              </div>
            ) : llmError ? (
              <div className="flex flex-col items-center gap-3 py-4">
                <div className="text-2xl">⚠️</div>
                <div>
                  <p className="text-sm font-medium text-text-primary">
                    {llmError === "timeout" ? "분석이 조금 지연되고 있어요" : "분석을 다시 확인하고 있어요"}
                  </p>
                  <p className="text-xs text-text-tertiary mt-1">
                    완료되면 자동으로 표시됩니다. 급하면 다시 시도해 주세요
                  </p>
                </div>
                <button
                  onClick={() => {
                    setGenerationPending(false);
                    setLlmError(null);
                    setRetryNonce(n => n + 1);
                  }}
                  className="mt-1 px-4 py-1.5 rounded-full text-xs font-semibold bg-accent/20 text-accent hover:bg-accent/30 transition-colors"
                >
                  🔄 다시 시도
                </button>
              </div>
            ) : hasRealBoxScore ? (
              <div className="py-4">
                <p className="text-sm text-text-tertiary">AI 요약 준비 중...</p>
                <p className="text-xs text-text-tertiary/60 mt-1">곧 분석이 완료됩니다</p>
              </div>
            ) : (
              <div className="py-4">
                <p className="text-sm text-text-tertiary">경기 기록 집계 중...</p>
                <p className="text-xs text-text-tertiary/60 mt-1">박스스코어가 준비되면 AI 분석이 시작됩니다</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 직관 라이브 — 전체 채팅 바로 위 */}
      <VenueStorySection gameId={gameId} />

      {/* Post-game chat */}
      <GameChatSlot gameId={gameId} homeTeamId={homeTeamId} awayTeamId={awayTeamId} />
    </div>
  );
}

function CancelledView({ cancelReason }: { cancelReason?: string | null }) {
  // 사유를 받았을 때만 원문 노출. 받지 못했으면(폴백 경로) 기존 고정 문구 —
  // 부재를 "사유 없음"으로 단정하지 않는다(provenance 계약).
  const detail = cancelReasonDetail(cancelReason);
  return (
    <div className="px-4 py-6">
      <div className="glass-card p-5 text-center space-y-3">
        <p className="text-base font-bold text-text-primary">경기가 취소되었습니다</p>
        <p className="text-sm text-text-tertiary">{detail ?? "우천 등 경기 운영 사유로 취소된 경기입니다."}</p>
      </div>
    </div>
  );
}

/* 올스타전 안내 — 잠금화면/위젯 실시간 중계 미지원 고지(네이티브 미대응). 크관 상단 상시 노출. */
function AllStarKgwanNotice() {
  return (
    <div className="glass-card p-3 mb-3 flex items-start gap-2">
      <span className="text-base leading-none mt-0.5">ℹ️</span>
      <p className="text-xs leading-relaxed text-text-secondary">
        올스타전은 <span className="font-medium text-text-primary">잠금화면·위젯 실시간 중계</span>를 지원하지 않아요.
        실시간 중계는 이곳 크관에서 확인해 주세요.
      </p>
    </div>
  );
}

/* ===== Main KgwanTab ===== */
export default function KgwanTab({
  gameId,
  homeTeamId,
  awayTeamId,
  gameDate,
  gameStartTime,
  status,
  cancelReason,
  gameEvents,
  teamColor: _teamColor,
  plays: _plays,
  boxScore,
  linescore,
  starterNames,
  lineupConfirmed,
  gameRelay,
  currentPitcher,
  currentBatter,
  balls,
  strikes,
  outs,
  refreshEpoch,
}: KgwanTabProps) {
  // 올스타전은 잠금/위젯 실시간 중계 미지원(네이티브 미대응) → 크관 상단 상시 안내.
  // 정규경기는 null이라 프래그먼트 출력이 기존과 동일(회귀 없음).
  const allStarNotice = isAllStarGame(awayTeamId, homeTeamId) ? <AllStarKgwanNotice /> : null;

  if (status === "scheduled") {
    return (
      <>
        {allStarNotice}
        <ScheduledView gameId={gameId} awayTeamId={awayTeamId} homeTeamId={homeTeamId} gameDate={gameDate} gameStartTime={gameStartTime} starterNames={starterNames} lineupConfirmed={lineupConfirmed} />
      </>
    );
  }

  if (status === "live") {
    return (
      <>
        {allStarNotice}
        <LiveView
          gameId={gameId}
          homeTeamId={homeTeamId}
          awayTeamId={awayTeamId}
          gameEvents={gameEvents}
          gameRelay={gameRelay}
          currentPitcher={currentPitcher}
          currentBatter={currentBatter}
          balls={balls}
          strikes={strikes}
          outs={outs}
        />
      </>
    );
  }

  if (status === "cancelled") {
    return (
      <>
        {allStarNotice}
        <CancelledView cancelReason={cancelReason} />
      </>
    );
  }

  // final
  return (
    <>
      {allStarNotice}
      <FinalView gameId={gameId} homeTeamId={homeTeamId} awayTeamId={awayTeamId} boxScore={boxScore} linescore={linescore} refreshEpoch={refreshEpoch} />
    </>
  );
}
