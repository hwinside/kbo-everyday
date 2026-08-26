import { createHash } from "node:crypto";
import { isKboGameCancelled } from "@/lib/crawler/kbo-status";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { resolveCurrentPlayers } from "@/lib/kbo-player-mapping";
import {
  apnsConfigured,
  getProviderTokenSafe,
  sendLiveActivityPush,
  sendLiveActivityPushToEnv,
  type ApnsResult,
} from "@/lib/notifications/apns";
import {
  decideChannelPush,
  isScoreStateRetreat,
  decideStartReissue,
  scoreStateOf,
  fullStateHashOf,
  isStaleStartToken,
  isWakeWindowOpen,
  markChannelBornGroups,
  createChannelBornMarkBudget,
  runWithChannelBornMarkBudget,
  runStartSendChunks,
  selectWakeGapRows,
  START_SEND_CHUNK_SIZE,
  p2sSendPlan,
  type P2sSendPlan,
  startTokenResultFence,
  decideLegacyTokenUpdate,
  shouldAdvanceFallbackCursor,
  type ChannelPushDecision,
  type ApnsEnvironment,
  type UpdateAttemptOutcome,
} from "@/lib/notifications/live-activity-channel-policy";
import { teamIdByShortName, fansOfTeams } from "@/lib/notifications/game-status";
import { sendFcmToUsers } from "@/lib/notifications/fcm";
import { fetchAllByKeyset } from "@/lib/db/paginate";
import type { KboRawGame } from "@/types/api";

// Live Activity W3a — 백그라운드 실시간 갱신.
// warmup cron(매분)이 라이브 게임 상태를 들고 있으므로, 그 상태로 등록된 Live Activity
// 토큰에 APNs liveactivity 업데이트를 직접 보낸다. 잠금화면(앱 백그라운드)도 갱신됨.
// 종료된 경기는 end 푸시 + 토큰 정리. (APNs 미설정 시 전체 no-op)

/** ContentState — KBOGameAttributes.ContentState(Swift Codable) 키와 정확히 일치. */
// 풀 카드 최소 빌드 — 1.0.7(11)+ 익스텐션만 투수/타자·lastPlay 포함 풀 payload를 받는다.
// 그 미만(1.0.6 이하/미태깅 토큰)은 슬림 payload 유지: 구버전 익스텐션은 풀 라이브 프레임
// 렌더가 예산 초과로 간헐 실패(2026-07-07 인시던트, 옛 프레임+스피너)하기 때문.
export const FULL_CARD_MIN_BUILD = 11;

export function buildLiveActivityContentState(
  g: KboRawGame,
  status: "live" | "final" | "scheduled",
  lastPlay?: string,
  full = false,
): Record<string, unknown> {
  // 경기 전(scheduled) — 스코어/이닝/BSO/주자는 아직 없음. 예정 시각만 표시.
  if (status === "scheduled") {
    // 예고선발(T_PIT_P_NM=원정, B_PIT_P_NM=홈). 미확정이면 빈 문자열 → 카드가 "선발 미정" 폴백.
    return {
      awayScore: 0, homeScore: 0, inning: 1, isTopInning: true,
      balls: 0, strikes: 0, outs: 0,
      onFirst: false, onSecond: false, onThird: false,
      pitcherName: "", batterName: "", stadium: g.S_NM ?? "",
      status: "scheduled",
      // 시각만 전달(예: "18:00"). "경기 예정" 라벨은 카드/DI 뷰가 별도로 그린다(중복 방지).
      startTime: g.G_TM ?? "",
      awayStarter: g.T_PIT_P_NM?.trim() ?? "",
      homeStarter: g.B_PIT_P_NM?.trim() ?? "",
    };
  }
  // full(1.0.7+)일 때만 투수/타자를 실는다 — 슬림은 빈값(카드가 행을 안 그림).
  const players = full
    ? resolveCurrentPlayers({
        tPlayerName: g.T_P_NM,
        bPlayerName: g.B_P_NM,
        gameTbSc: g.GAME_TB_SC,
      })
    : null;
  return {
    awayScore: parseInt(g.T_SCORE_CN) || 0,
    homeScore: parseInt(g.B_SCORE_CN) || 0,
    inning: g.GAME_INN_NO && g.GAME_INN_NO > 0 ? g.GAME_INN_NO : 1,
    isTopInning: g.GAME_TB_SC === "T",
    balls: g.BALL_CN ?? 0,
    strikes: g.STRIKE_CN ?? 0,
    outs: g.OUT_CN ?? 0,
    onFirst: (g.B1_BAT_ORDER_NO ?? 0) > 0,
    onSecond: (g.B2_BAT_ORDER_NO ?? 0) > 0,
    onThird: (g.B3_BAT_ORDER_NO ?? 0) > 0,
    pitcherName: players?.currentPitcher ?? "",
    batterName: players?.currentBatter ?? "",
    stadium: g.S_NM ?? "",
    status,
    // 문자중계 최근 플레이 한 줄 — full(1.0.7+) + live + 값 있을 때만(옵셔널 키:
    // 빈 카드는 행을 안 그림. Swift ContentState.lastPlay와 키 일치).
    ...(full && status === "live" && lastPlay ? { lastPlay } : {}),
  };
}
const buildContentState = buildLiveActivityContentState;

export function liveActivityGameStatus(
  g: KboRawGame,
): "live" | "final" | "scheduled" | "other" {
  if (isKboGameCancelled(g.CANCEL_SC_ID)) return "other";
  if (g.GAME_STATE_SC === "3") return "final";
  if (g.GAME_STATE_SC === "2") return "live";
  if (g.GAME_STATE_SC === "1") return "scheduled";
  return "other";
}
const gameStatus = liveActivityGameStatus;

// ⚠️ staleDate는 의도적으로 보내지 않는다(하린아빠 요구: "어떤 경우에도 스피너 금지").
// iOS는 stale-date를 지난 Live Activity에 시스템 스피너("outdated" 인디케이터)를 얹는데,
// update가 1분 cron·apns-expiration:0(못 꽂히면 폐기)이라 기기가 잠깐 unreachable이면 몇 틱
// 유실 → staleDate 초과 → 스피너. stale-date를 아예 안 실으면 iOS가 stale 판정할 근거가
// 없어 스피너가 원천 차단된다(네이버 라이브 액티비티와 동일 정책). 트레이드오프 = 서버 갱신이
// 완전히 죽으면 카드가 스피너 없이 옛 값으로 남음. 단 정상 종료는 별도 end 푸시로 처리됨.

interface TokenRow {
  id: number;
  user_id: string;
  game_id: string;
  push_token: string;
  app_build: number | null;
  updated_at: string | null;
}

interface ActiveChannelRow {
  game_id: string;
  environment: ApnsEnvironment;
  channel_id: string;
  last_score_state?: string | null;
  last_state_hash?: string | null;
  // 채널 세대 생성/교체 시각 — wake 창 재오픈 기준(isWakeWindowOpen, 삼순 라운드3).
  created_at?: string | null;
}

interface ChannelSubscriptionRow {
  game_id: string;
  user_id: string | null;
  environment: ApnsEnvironment;
  channel_id: string;
  device_key: string;
}

interface StartedUserRow {
  user_id: string;
  game_id: string;
  created_at: string | null;
  // 채널 내장 출생 세대(p2s payload에 channelId 포함 발송 성공한 env+channel_id) —
  // *현재 active 채널과 정확 일치*할 때만 broadcast 수신으로 보고 wake 대상·attempted
  // 기록에서 제외(selectWakeGapRows/isLiveBornChannel, 삼순 라운드2 세대 일치 계약).
  channel_born_environment: string | null;
  channel_born_channel_id: string | null;
}

async function fetchLiveActivityTokens(gameIds: string[]): Promise<TokenRow[]> {
  if (gameIds.length === 0) return [];
  return fetchAllByKeyset(async (cursor, limit) => {
    let query = supabase
      .from("live_activity_tokens")
      .select("id, user_id, game_id, push_token, app_build, updated_at")
      .in("game_id", gameIds)
      .order("id", { ascending: true })
      .limit(limit);
    if (cursor !== null) query = query.gt("id", cursor);
    const { data, error } = await query;
    return { data: data as TokenRow[] | null, error };
  }, (row) => row.id, { label: "live_activity_tokens" });
}

async function fetchStartedUsers(gameIds: string[]): Promise<StartedUserRow[]> {
  const pages = await Promise.all(gameIds.map((gameId) =>
    fetchAllByKeyset(async (cursor, limit) => {
      let query = supabase
        .from("live_activity_started_users")
        .select("user_id, game_id, created_at, channel_born_environment, channel_born_channel_id")
        .eq("game_id", gameId)
        .order("user_id", { ascending: true })
        .limit(limit);
      if (cursor !== null) query = query.gt("user_id", cursor);
      const { data, error } = await query;
      return { data: data as StartedUserRow[] | null, error };
    }, (row) => row.user_id, { label: `live_activity_started_users (${gameId})` }),
  ));
  return pages.flat();
}

async function fetchChannelSubscriptions(
  channels: ActiveChannelRow[],
): Promise<ChannelSubscriptionRow[]> {
  const pages = await Promise.all(channels.map((channel) =>
    fetchAllByKeyset(async (cursor, limit) => {
      let query = supabase
        .from("live_activity_channel_subscriptions")
        .select("game_id, user_id, environment, channel_id, device_key")
        .eq("game_id", channel.game_id)
        .eq("environment", channel.environment)
        .eq("channel_id", channel.channel_id)
        .order("device_key", { ascending: true })
        .limit(limit);
      if (cursor !== null) query = query.gt("device_key", cursor);
      const { data, error } = await query;
      return { data: data as ChannelSubscriptionRow[] | null, error };
    }, (row) => row.device_key, {
      label: `live_activity_channel_subscriptions (${channel.game_id}/${channel.environment})`,
    }),
  ));
  return pages.flat();
}

/**
 * 라이브 게임 → 등록된 Live Activity 토큰에 update 푸시.
 * 종료 게임 → end 푸시 + 토큰 삭제(잔상 15분 후 제거).
 */
export async function pushLiveActivityUpdates(
  games: KboRawGame[],
  lastPlayByGame?: Map<string, string>,
  opts?: {
    /**
     * broadcast 직전에 떬 채널 상태 스냅샷 (삼순 R2 blocker① — 느린 fanout 분리).
     * 제공 시 레거시 skip/priority 판정은 현재 채널 행이 아니라 이 스냅샷을 쓴다 —
     * broadcast가 먼저 hash를 전진시켜도 레거시가 "이미 받음"으로 오인해 영구 skip되지
     * 않는다(구빌드 11~15 카드 프리즈 방지). 스냅샷에 없는 경기의 채널 행은 스냅샷
     * 이후 생성된 것 → 미사용(폴백 테이블/null → p10 발송 쪽으로 안전).
     */
    channelLastStateOverride?: Map<string, { score: string | null; hash: string | null }>;
  },
): Promise<{ pushed: number; ended: number; cleaned: number } | { error: string }> {
  if (!apnsConfigured()) return { pushed: 0, ended: 0, cleaned: 0 };

  // 푸시 대상 = 라이브 + 종료 + 취소 경기. 종료/취소는 토큰 있을 때만 end(반복 방지).
  // 취소(우천 등)는 라이브 전환 없이 끝나므로, end를 안 보내면 "경기 예정" 카드가 잠금화면에
  // 영구히 얼어붙는다(staleDate 미전송이라 iOS가 옛 값 그대로 둠) — final과 동일하게 정리한다.
  const stateByGame = new Map<string, "live" | "final" | "cancelled">();
  for (const g of games) {
    const s = gameStatus(g);
    if (s === "live" || s === "final") stateByGame.set(g.G_ID, s);
    else if (isKboGameCancelled(g.CANCEL_SC_ID) && g.G_ID) stateByGame.set(g.G_ID, "cancelled");
  }
  if (stateByGame.size === 0) return { pushed: 0, ended: 0, cleaned: 0 };

  const gameIds = [...stateByGame.keys()];
  // 틱 시작 시각 — 토큰 fetch *이전*에 고정. 이 값이 이번 틱의 상태 행 updated_at으로
  // 기록된다(발송 완료 후 now()로 쓰면, 토큰 fetch~upsert 사이에 등록된 토큰이 기록
  // 시각보다 과거가 되어 다음 틱 catch-up 판정에서 영영 빠지는 race — 삼순 #664 리뷰).
  const tickStartedAtIso = new Date().toISOString();
  let tokens: TokenRow[];
  try {
    tokens = await fetchLiveActivityTokens(gameIds);
  } catch (error) {
    return { error: (error as Error).message };
  }
  if (tokens.length === 0) return { pushed: 0, ended: 0, cleaned: 0 };

  // W3c 토글: "잠금화면 실시간 중계"를 끈 유저는 update 푸시에서 제외(row 없음/null = 디폴트 on).
  // end 푸시는 허용해 기존 카드/토큰을 정리한다. .in()은 URL 한도 회피 위해 200개 청크.
  const userIds = [...new Set(tokens.map((t) => t.user_id))];
  const optedOut = new Set<string>();
  for (let i = 0; i < userIds.length; i += 200) {
    const { data: prefRows, error: prefError } = await supabase
      .from("notification_prefs")
      .select("user_id, live_activity")
      .in("user_id", userIds.slice(i, i + 200));
    if (prefError) return { error: prefError.message };
    for (const r of (prefRows ?? []) as { user_id: string; live_activity: boolean | null }[]) {
      if (r.live_activity === false) optedOut.add(r.user_id);
    }
  }

  const jwt = await getProviderTokenSafe();
  if (!jwt) return { error: "apns provider token failed" };

  const gameById = new Map(games.map((g) => [g.G_ID, g]));
  const nowSec = Math.floor(Date.now() / 1000);

  // ── 채널 구독 기기 제외 (스펙 v4 — 조건부 GO 정정②) ──
  // 구독 SSOT = live_activity_channel_subscriptions(네이티브 ACK만 기록). 제외 조건 =
  // "그 env의 현재 active 채널과 일치하는 subscription 존재(NOT EXISTS의 여집합)".
  // update 토큰 행엔 env가 없으므로 user 단위로 매칭 — 유효 구독이 있으면 그 유저의 카드는
  // broadcast가 갱신하므로 per-토큰 update를 스킵한다(end는 유지: 잔존 토큰 정리 경로 보존,
  // 채널 end와 이중 수신해도 멱등).
  const { data: chanRows, error: chanError } = await supabase
    .from("live_activity_channels")
    .select("game_id, environment, channel_id, last_score_state, last_state_hash")
    .in("game_id", gameIds)
    .eq("status", "active");
  if (chanError) return { error: chanError.message };
  const activeChanKeys = new Set<string>();
  const lastStateByGame = new Map<string, { score: string | null; hash: string | null }>();
  for (const r of (chanRows ?? []) as {
    game_id: string; environment: string; channel_id: string;
    last_score_state: string | null; last_state_hash: string | null;
  }[]) {
    activeChanKeys.add(`${r.game_id}|${r.environment}|${r.channel_id}`);
    // 레거시 priority 판정용 직전 상태 — production 행 기준(채널 broadcast가 지난 틱에 기록).
    // 스냅샷 override 제공 시 현재 행 값은 무시(broadcast가 이미 전진시켰을 수 있음 — 위 opts 주석).
    if (r.environment === "production" && !opts?.channelLastStateOverride) {
      lastStateByGame.set(r.game_id, { score: r.last_score_state, hash: r.last_state_hash });
    }
  }
  if (opts?.channelLastStateOverride) {
    for (const [gid, st] of opts.channelLastStateOverride) {
      lastStateByGame.set(gid, { score: st.score, hash: st.hash });
    }
  }
  // 채널 행이 없는 경기(Broadcast Capability 미활성/생성 실패)는 경기 단위 폴백 상태를
  // 읽는다 — 없으면 스킵 판정이 영영 못 돌아 매분 priority 10 발송 = 예산 스로틀 재발
  // (2026-07-17 핫픽스). 채널 행(production)이 있으면 그쪽이 우선(위에서 이미 set).
  // updated_at은 전 live 경기에서 읽는다 — "직전 상태 기록 이후 등록된 토큰" catch-up
  // 판정 재료(아래 발송 루프 주석 참조).
  const liveGameIds = gameIds.filter((gid) => stateByGame.get(gid) === "live");
  const lastWriteAtByGame = new Map<string, number>();
  if (liveGameIds.length > 0) {
    const { data: fallbackRows, error: fallbackError } = await supabase
      .from("live_activity_game_push_state")
      .select("game_id, last_score_state, last_state_hash, updated_at")
      .in("game_id", liveGameIds);
    if (fallbackError) return { error: fallbackError.message };
    for (const r of (fallbackRows ?? []) as {
      game_id: string; last_score_state: string | null; last_state_hash: string | null;
      updated_at: string;
    }[]) {
      lastWriteAtByGame.set(r.game_id, new Date(r.updated_at).getTime());
      if (!lastStateByGame.has(r.game_id)) {
        lastStateByGame.set(r.game_id, { score: r.last_score_state, hash: r.last_state_hash });
      }
    }
  }
  const subscribed = new Set<string>(); // `${user_id}|${game_id}`
  if (activeChanKeys.size > 0) {
    let subRows: ChannelSubscriptionRow[];
    try {
      subRows = await fetchChannelSubscriptions((chanRows ?? []) as ActiveChannelRow[]);
    } catch (error) {
      return { error: (error as Error).message };
    }
    for (const s of subRows) {
      if (!s.user_id) continue;
      if (activeChanKeys.has(`${s.game_id}|${s.environment}|${s.channel_id}`)) {
        subscribed.add(`${s.user_id}|${s.game_id}`);
      }
    }
  }

  // ── 레거시 update priority 10/5 믹스 + 무변화 틱 스킵 (스펙 v4 §서버 5) ──
  // 판정은 경기 단위(풀 카드 상태 기준). 직전 상태는 채널 행이 지난 틱에 기록한 값 재사용 —
  // 채널 행이 없으면(전환 전/생성 실패) null → 항상 priority 10 발송 = 기존 동작 그대로.
  const decisionByGame = new Map<string, ChannelPushDecision>();
  // 이번 틱의 상태 문자열 — 발송 성공 시 경기 단위 폴백 테이블에 기록(다음 틱 스킵 판정용).
  const stateStringsByGame = new Map<string, { score: string; hash: string }>();
  for (const [gid, st] of stateByGame) {
    if (st !== "live") continue;
    const g = gameById.get(gid);
    if (!g) continue;
    const cs = buildContentState(g, "live", lastPlayByGame?.get(gid), true);
    const last = lastStateByGame.get(gid);
    const scoreState = scoreStateOf(cs);
    const fullHash = fullStateHashOf(cs);
    stateStringsByGame.set(gid, { score: scoreState, hash: fullHash });
    // 되감기 가드(#1311 삼순 B② 3축 적용): 직전 발송보다 점수/이닝이 뒤로 가는 스냅샷은
    // 발송 skip — Naver→KBO(stale) fallback 틱이 레거시 카드를 8→5로 되감는 걸 막는다.
    decisionByGame.set(gid, isScoreStateRetreat(last?.score ?? null, scoreState)
      ? { send: false }
      : decideChannelPush({
          scoreState,
          fullStateHash: fullHash,
          lastScoreState: last?.score ?? null,
          lastStateHash: last?.hash ?? null,
        }));
  }

  let pushed = 0;
  let ended = 0;
  const invalidTokenIds: { user_id: string; game_id: string }[] = [];
  const endedTokenIds: { user_id: string; game_id: string }[] = [];
  // 이번 틱에 update가 1건이라도 성공한 경기 — 폴백 상태 기록 대상(전패 경기는 미기록 →
  // 다음 틱 재발송).
  const sentUpdateGames = new Set<string>();
  // 경기별 update 대상 발송 결과 — 폴백 커서 전진 판정 재료(#665 재리뷰: mixed-result
  // 영구 누락 방지, shouldAdvanceFallbackCursor 주석 참조).
  const updateOutcomesByGame = new Map<string, UpdateAttemptOutcome[]>();
  function recordUpdateOutcome(gid: string, outcome: UpdateAttemptOutcome) {
    const arr = updateOutcomesByGame.get(gid);
    if (arr) arr.push(outcome);
    else updateOutcomesByGame.set(gid, [outcome]);
  }

  await Promise.all(
    tokens.map(async (t) => {
      const g = gameById.get(t.game_id);
      const status = stateByGame.get(t.game_id);
      if (!g || !status) return;
      const isEnd = status === "final" || status === "cancelled";
      // 토글 off 유저: 실시간 update는 건너뛰고, end(카드/토큰 정리)만 진행.
      if (optedOut.has(t.user_id) && !isEnd) return;
      // 채널 구독 확인 유저: update는 broadcast가 담당 — 스킵(end만 유지).
      if (!isEnd && subscribed.has(`${t.user_id}|${t.game_id}`)) return;
      // 무변화 틱: 레거시도 스킵(예산 절약). end는 판정 무관 발송.
      // catch-up(늦은 토큰 p10 1회) 포함 판정은 순수 함수로 — 매트릭스는
      // qa:la-broadcast 스모크가 고정한다(decideLegacyTokenUpdate 주석 참조).
      const upd = isEnd
        ? null
        : decideLegacyTokenUpdate({
            decision: decisionByGame.get(t.game_id) ?? null,
            tokenUpdatedAtMs: t.updated_at !== null ? new Date(t.updated_at).getTime() : null,
            lastWriteAtMs: lastWriteAtByGame.get(t.game_id) ?? null,
          });
      if (upd && !upd.send) return;
      const res = await sendLiveActivityPush(
        {
          pushToken: t.push_token,
          event: isEnd ? "end" : "update",
          // 취소 경기는 스코어가 없으니 예정(경기 전) 프레임을 마지막으로 실어 즉시 해제.
          // 풀/슬림은 토큰의 app_build로 분기(FULL_CARD_MIN_BUILD 주석 참조).
          contentState: buildContentState(
            g,
            status === "cancelled" ? "scheduled" : status,
            status === "live" ? lastPlayByGame?.get(t.game_id) : undefined,
            (t.app_build ?? 0) >= FULL_CARD_MIN_BUILD,
          ),
          // 종료는 15분 잔상 후 제거(리뷰 시간), 취소는 보여줄 게 없으니 즉시 해제.
          dismissalDate: isEnd ? (status === "cancelled" ? nowSec : nowSec + 15 * 60) : undefined,
          // staleDate 미전송 — 위 주석 참조(스피너 원천 차단).
          // collapse-id = 경기 id: update는 최신 1건만 보관(store-and-forward)되고, end가
          // 대기 중 update를 대체(종료 후 stale update 재생 방지).
          collapseId: t.game_id,
          // 점수/이닝/주자 변화 = 10, 볼카운트/타자만 = 5(예산 미소모). end는 항상 10.
          // catch-up 토큰은 p5/스킵 틱이어도 10으로 승격(예정 프레임 탈출은 즉시 반영 필요).
          priority: upd?.send ? upd.priority : undefined,
        },
        jwt,
      );
      if (res.ok) {
        if (isEnd) {
          ended += 1;
          endedTokenIds.push({ user_id: t.user_id, game_id: t.game_id });
        } else {
          pushed += 1;
          sentUpdateGames.add(t.game_id);
          recordUpdateOutcome(t.game_id, "sent");
        }
      } else if (res.invalidToken) {
        invalidTokenIds.push({ user_id: t.user_id, game_id: t.game_id });
        if (!isEnd) recordUpdateOutcome(t.game_id, "invalidToken");
      } else if (!isEnd) {
        recordUpdateOutcome(t.game_id, "retryableFailure");
      }
    }),
  );

  // 경기 단위 폴백 상태 기록 — 채널 행 유무와 무관하게, 이번 틱 update 성공 경기의
  // 상태 문자열을 upsert(다음 틱 무변화 스킵/priority 5 판정 재료). 채널이 살아나면
  // 읽기는 채널 행이 우선이라 이 테이블이 stale해져도 무해.
  // updated_at = *틱 시작 시각*(발송 후 now() 아님) — 틱 처리 중 등록된 토큰이 기록
  // 시각보다 과거로 밀려 catch-up을 영영 놓치는 race 방지(decideLegacyTokenUpdate 주석).
  // retryable 실패가 하나라도 있으면 전진 보류(shouldAdvanceFallbackCursor 주석 — #665
  // 재리뷰: mixed-result에서 실패 토큰만 다음 틱 catch-up 없이 영구 skip되는 것 방지).
  for (const gid of sentUpdateGames) {
    if (!shouldAdvanceFallbackCursor(updateOutcomesByGame.get(gid) ?? [])) continue;
    const st = stateStringsByGame.get(gid);
    if (!st) continue;
    await supabase
      .from("live_activity_game_push_state")
      .upsert(
        {
          game_id: gid,
          last_score_state: st.score,
          last_state_hash: st.hash,
          updated_at: tickStartedAtIso,
        },
        { onConflict: "game_id" },
      );
  }
  // 종료/취소 경기의 폴백 행 정리 (game_id는 재사용되지 않으므로 잔존해도 무해하나,
  // end 창 동안 매 틱 멱등 삭제로 테이블을 작게 유지).
  const finishedGames = gameIds.filter((gid) => {
    const st = stateByGame.get(gid);
    return st === "final" || st === "cancelled";
  });
  if (finishedGames.length > 0) {
    await supabase
      .from("live_activity_game_push_state")
      .delete()
      .in("game_id", finishedGames);
  }

  // 무효 토큰 + 종료/취소 경기 토큰 정리 + started_users close.
  // ⚠️ started_users도 함께 닫는다(삼순 #530 blocker): 안 하면 같은 warmup 틱에서 이 함수가
  // 토큰을 지운 뒤 pushLiveActivitySilentWakes가 gap(=started_users − tokens)을 계산할 때,
  // 이미 end된(토큰만 사라진) 사용자가 다시 gap으로 잡혀 매 틱 반복 wake된다. 카드가 end됐거나
  // (final/cancelled) 토큰이 무효면 started도 닫아 gap에서 빠지게 한다. 이후 wake로 토큰이 재등록된
  // 사용자도 다음 틱 end 성공 시 started까지 제거돼 반복 wake가 멎는다. (final/cancelled 재start는
  // start 윈도우 밖이라 close해도 재생성 안 됨.)
  const toDelete = [...invalidTokenIds, ...endedTokenIds];
  let cleaned = 0;
  for (const d of toDelete) {
    const { error: delErr } = await supabase
      .from("live_activity_tokens")
      .delete()
      .eq("user_id", d.user_id)
      .eq("game_id", d.game_id);
    if (!delErr) cleaned += 1;
    await supabase
      .from("live_activity_started_users")
      .delete()
      .eq("user_id", d.user_id)
      .eq("game_id", d.game_id);
  }

  return { pushed, ended, cleaned };
}

// ── W3b — push-to-start 자동 시작 ──────────────────────────────────────────
// 최애팀 경기가 라이브로 전환되면, 앱을 안 열어도 잠금화면 Live Activity가 뜨도록
// 등록된 push-to-start 토큰으로 APNs event:start 푸시를 보낸다. 이후 갱신은 W3a.

// 시작 윈도우(game-status.ts와 동일 정책) — 한참 뒤 복구된 cron의 뒷북 자동시작 차단.
const START_WINDOW_MS = 90 * 60 * 1000;

/** G_DT("20260611") + G_TM("18:30", KST) → epoch ms. 파싱 실패 시 null (game-status.ts 동일) */
function scheduledStartMs(gDt: string | undefined, gTm: string | undefined): number | null {
  if (!gDt || !gTm || gDt.length !== 8 || !/^\d{2}:\d{2}$/.test(gTm)) return null;
  const y = +gDt.slice(0, 4), mo = +gDt.slice(4, 6), d = +gDt.slice(6, 8);
  const [hh, mm] = gTm.split(":").map(Number);
  return Date.UTC(y, mo - 1, d, hh - 9, mm);
}

/** 프리게임 리드(경기 30분 전부터 카드/채널 준비) — pushLiveActivityStarts와 동일 정책. */
const PREGAME_LEAD_MS = 30 * 60 * 1000;

/**
 * start 윈도우 판정 — 라이브 또는 [시작 30분 전 ~ 시작 후 90분] 예정 경기.
 * broadcast 채널 생성(ensureLiveActivityChannels)이 p2s/인앱 start보다 먼저
 * 준비돼야 하므로 같은 정책을 공유한다.
 */
export function liveActivityStartWindow(g: KboRawGame): boolean {
  const st = gameStatus(g);
  if (st === "live") return true;
  if (st !== "scheduled") return false;
  const ms = scheduledStartMs(g.G_DT, g.G_TM);
  if (ms === null) return false;
  const delta = ms - Date.now();
  return delta <= PREGAME_LEAD_MS && delta > -START_WINDOW_MS;
}

/**
 * 한 팀 슬롯(away 또는 home)의 팬들에게 push-to-start. myTeamCode = 그 팀 코드(강조용).
 * 반환 failed=true = 인프라 오류(쿼리 실패 / 발송 전부 일시 실패) → 호출부가 선점 해제·재시도.
 * "수신 대상 0명"(legit zero)은 failed=false (선점 유지 — 재시도해도 의미 없음). 삼순 NO-GO ②.
 */
interface StartTokenMeta {
  token: string;
  env: ApnsEnvironment | null;
  appBuild: number | null;
  osMajor: number | null;
  /** 토큰 세대 시각(token_changed_at, ms) — 재설치 재발급 판정용. updated_at(heartbeat)와 별개. */
  generationMs: number | null;
}

async function startForTeamSide(params: {
  gameId: string;
  teamId: number | null;
  myTeamCode: string;
  attributes: Record<string, unknown>;
  contentState: Record<string, unknown>;
  alert?: { title: string; body: string };
  jwt: string;
  /** active broadcast 채널 — key `${env}` (이 경기 것만). 없으면 전원 기존 payload. */
  channelByEnv: Map<ApnsEnvironment, string>;
  /** 이 경기의 유효(active 채널 일치) 구독 user → device_key 집합 — 현재 토큰 일치 구독만 중복 start 제외. */
  subscribedKeysByUser: Map<string, Set<string>>;
  /** 경기 예정 시작(ms) — 늦은 윈도우 per-토큰 게이트용. null = 파싱 불가. */
  gameStartMs: number | null;
  /** 전체 경기 fanout이 공유하는 실제 channel_born 마킹 대기 예산. */
  channelBornMarkBudget: ReturnType<typeof createChannelBornMarkBudget>;
}): Promise<{ sent: number; failed: boolean }> {
  if (params.teamId === null) return { sent: 0, failed: false };
  const fans = await fansOfTeams([params.teamId]);
  if (!fans.ok) return { sent: 0, failed: true }; // 팬 조회 실패 → 재시도
  if (fans.ids.length === 0) return { sent: 0, failed: false };

  // push-to-start 토큰 보유 유저만. .in()은 URL 한도 회피 위해 200개 청크.
  const tokenByUser = new Map<string, StartTokenMeta>();
  for (let i = 0; i < fans.ids.length; i += 200) {
    // query-guard: bounded -- 바깥 루프가 매 조회를 200개 user id 청크로 상한(user_id unique → ≤200행)
    const { data, error } = await supabase
      .from("live_activity_start_tokens")
      .select("user_id, push_to_start_token, apns_environment, app_build, os_major, token_changed_at, updated_at")
      .in("user_id", fans.ids.slice(i, i + 200))
      .limit(200);
    if (error) return { sent: 0, failed: true }; // 토큰 조회 실패 → 재시도
    for (const r of (data ?? []) as {
      user_id: string; push_to_start_token: string;
      apns_environment: ApnsEnvironment | null; app_build: number | null; os_major: number | null;
      token_changed_at: string | null; updated_at: string | null;
    }[]) {
      // ④ stale 발송 제외 — updated_at 30일+ 미갱신 휴면 기기(gap 유저 41% 실측)는 카드만
      // 띄우고 update 토큰 등록이 사실상 안 일어나 갱신불가 카드만 늘린다. 토큰 행은
      // 보존(앱 재실행 시 updated_at 갱신 → 즉시 발송 재개).
      if (isStaleStartToken(r.updated_at, Date.now())) continue;
      const genMs = r.token_changed_at ? Date.parse(r.token_changed_at) : NaN;
      tokenByUser.set(r.user_id, {
        token: r.push_to_start_token,
        env: r.apns_environment,
        appBuild: r.app_build,
        osMajor: r.os_major,
        generationMs: Number.isFinite(genMs) ? genMs : null,
      });
    }
  }
  if (tokenByUser.size === 0) return { sent: 0, failed: false };
  const candidateIds = [...tokenByUser.keys()];

  // W3c off 제외 (row 없음/null = 디폴트 on).
  const optedOut = new Set<string>();
  // 이미 이 경기 활성 토큰 보유(앱에서 직접 start 또는 원격 시작 후 update 토큰 등록) 제외 — 중복 카드 방지.
  const alreadyActive = new Set<string>();
  // 기존 발급 기록(started_users) — 재설치 stale claim 판별용(created_at 포함).
  const claimCreatedAtByUser = new Map<string, number>();
  for (let i = 0; i < candidateIds.length; i += 200) {
    const chunk = candidateIds.slice(i, i + 200);
    const [
      { data: prefRows, error: prefErr },
      { data: activeRows, error: activeErr },
      { data: claimRows, error: claimErr },
    ] = await Promise.all([
      supabase.from("notification_prefs").select("user_id, live_activity").in("user_id", chunk),
      supabase
        .from("live_activity_tokens")
        .select("user_id")
        .eq("game_id", params.gameId)
        .in("user_id", chunk),
      supabase
        .from("live_activity_started_users")
        .select("user_id, created_at")
        .eq("game_id", params.gameId)
        .in("user_id", chunk),
    ]);
    if (prefErr || activeErr || claimErr) return { sent: 0, failed: true }; // 조회 실패 → 재시도
    for (const r of (prefRows ?? []) as { user_id: string; live_activity: boolean | null }[]) {
      if (r.live_activity === false) optedOut.add(r.user_id);
    }
    for (const r of (activeRows ?? []) as { user_id: string }[]) alreadyActive.add(r.user_id);
    for (const r of (claimRows ?? []) as { user_id: string; created_at: string | null }[]) {
      const ms = r.created_at ? Date.parse(r.created_at) : NaN;
      claimCreatedAtByUser.set(r.user_id, Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER);
    }
  }

  // 발송 대상 = 토큰 보유 & opt-out 아님 & 이미 활성 카드 없음 & 재발급 정책(decideStartReissue) 통과.
  // 재설치 등 토큰 교체 감지 시 이전 설치의 claim/구독은 차단 사유에서 제외하고(stale),
  // 늦은 윈도우(시작+90분 경과)엔 경기 시작 이후 등록 토큰만 발송한다.
  const nowMs = Date.now();
  const staleClaimUsers: { userId: string; tokenGenerationMs: number }[] = [];
  const eligible = [...tokenByUser.entries()].filter(([userId, meta]) => {
    if (optedOut.has(userId) || alreadyActive.has(userId)) return false;
    // 구독 identity 정합: 현재 토큰 device_key(sha256)와 정확 일치하는 구독만 차단 사유.
    // 이전 설치 구독(다른 device_key)은 카드가 이미 소멸됐으므로 차단하지 않는다(삼순 NO-GO).
    const deviceKey = createHash("sha256").update(meta.token).digest("hex");
    const d = decideStartReissue({
      tokenGenerationMs: meta.generationMs,
      claimCreatedAtMs: claimCreatedAtByUser.get(userId) ?? null,
      hasCurrentTokenSubscription:
        params.subscribedKeysByUser.get(userId)?.has(deviceKey) ?? false,
      gameStartMs: params.gameStartMs,
      nowMs,
      startWindowMs: START_WINDOW_MS,
    });
    if (!d.eligible) return false;
    if (d.invalidateStaleClaim && meta.generationMs !== null) {
      staleClaimUsers.push({ userId, tokenGenerationMs: meta.generationMs });
    }
    return true;
  });
  if (eligible.length === 0) return { sent: 0, failed: false };

  // R3 (삼순 PR #808 blocker①): channel-capable(iOS18+/build16+) 토큰은 active 채널이
  // 준비된 env가 있어야만 발송 — 없으면 *선점(claim) 전에* 유보하고 다음 틱이 재시도한다.
  // 7/23 사고 입구(채널 부재 시 자동 p2s가 레거시 카드로 태어나 예산 스로틀에 갇힘)의
  // 서버측 차단 — 앱 내 start() deferStart(R2 blocker④)와 대칭. 레거시 토큰은 기존 그대로.
  const channelEnvs = new Set([...params.channelByEnv.keys()]);
  const planByUser = new Map<string, Extract<P2sSendPlan, { kind: "send" }>>();
  const sendable = eligible.filter(([userId, meta]) => {
    const plan = p2sSendPlan(
      { os_major: meta.osMajor, app_build: meta.appBuild, env: meta.env },
      channelEnvs,
    );
    if (plan.kind === "defer") return false; // claim 0 — 다음 틱 재시도(레거시 발송 금지)
    planByUser.set(userId, plan);
    return true;
  });
  if (sendable.length < eligible.length) {
    console.log(
      `[live-activity] p2s deferred (channel not ready): game=${params.gameId} deferred=${eligible.length - sendable.length}`,
    );
  }
  if (sendable.length === 0) return { sent: 0, failed: false };

  // stale claim 무효화 — *현재 토큰 세대 이전에 생성된 행만* 삭제(fence: lt created_at).
  // 병렬 틱이 방금 만든 새 claim(created_at >= token_changed_at)은 건드리지 않는다.
  for (const s of staleClaimUsers) {
    const { error } = await supabase
      .from("live_activity_started_users")
      .delete()
      .eq("game_id", params.gameId)
      .eq("user_id", s.userId)
      .lt("created_at", new Date(s.tokenGenerationMs).toISOString());
    if (error) return { sent: 0, failed: true }; // 무효화 실패 → 재시도(이번 틱은 재선점 불가)
  }

  // 유저 단위 1회 선점 — (game_id, user_id) insert(ON CONFLICT DO NOTHING). 이미 발송한
  // 유저는 충돌로 제외되고 *새로 선점된 유저만* 반환된다. 게임 단위 선점과 달리 윈도우
  // 도중 늦게 등록된 토큰도 그 시점 cron이 처음 선점 → 발송된다.
  const claimed: { user_id: string }[] = [];
  for (let i = 0; i < sendable.length; i += 200) {
    const chunk = sendable.slice(i, i + 200);
    const { data, error } = await supabase
      .from("live_activity_started_users")
      .upsert(
        chunk.map(([userId]) => ({ game_id: params.gameId, user_id: userId })),
        { onConflict: "game_id,user_id", ignoreDuplicates: true },
      )
      .select("user_id");
    if (error) return { sent: 0, failed: true }; // 선점 실패 → 재시도
    claimed.push(...((data ?? []) as { user_id: string }[]));
  }
  if (claimed.length === 0) return { sent: 0, failed: false };
  const claimedSet = new Set(claimed.map((r) => r.user_id));
  const toSend = sendable.filter(([userId]) => claimedSet.has(userId));

  let sent = 0;
  let transientFail = false;
  // 무효 토큰은 (user, 발송한 그 토큰) pair로 보관 — rotation fence용(삼순 재리뷰 blocker②).
  const invalid: { userId: string; token: string }[] = [];
  const releaseRetry: string[] = []; // 일시 실패 → 선점 해제(다음 cron 재시도)
  // ① 집계 교정 — channelId 내장 payload로 발송 성공한 유저의 *채널 세대(env+channelId)*
  // 기록. 이 카드는 앱 wake 없이 broadcast로 갱신을 받으므로 서버가 직접 기록 → 어드민이
  // updatable로 합산(네이티브 ACK만 인정하던 기존 집계의 gap 과대계상 교정, 2026-07-23 실측).
  // boolean이 아니라 세대를 남기는 이유: 출생 채널이 ChannelNotRegistered로 교체되면
  // 그 카드는 새 채널 broadcast를 못 받으므로 세대 불일치 시 gap/wake로 복귀시켜야 한다
  // (삼순 라운드2 blocker). env+channelId 조합별로 묶어 기록한다.
  const channelBornGroups = new Map<string, { env: ApnsEnvironment; channelId: string; users: string[] }>();
  // chunk당 내구 저장(삼순 R1 blocker②) — tail 일괄 마킹은 대용량 cohort(18:02 home 1,827명)
  // 에서 fanout 68s deadline/함수 종료에 통째로 잘려 재시도·로그 0으로 소실됐다.
  // 발송을 START_SEND_CHUNK_SIZE 단위로 나누고 다음 chunk 발송 전에 직전 chunk 성공분을
  // 즉시 마킹 — cutoff 시에도 손실 상한 = 마지막 미완료 chunk 1개. 마킹 전체는 fanout 전역
  // 20초 예산으로 유계하되 쿼리/APNs 시간은 제외하고 실제 마킹 대기만 차감한다. 예산 소진
  // 후엔 새 UPDATE 시작 금지(즉시 skip+로깅, 삼순 R2) — 느린 실패 UPDATE가 뒤 경기 발송을
  // 굶기지 않는다. 마킹 skip은 발송을 막지 않는다(발송·선점 계약 불변).
  // 최종 실패분은 scripts/backfill-channel-born.ts로 구제.
  const persistChunkMarks = async () => {
    if (channelBornGroups.size === 0) return;
    const groups = [...channelBornGroups.values()];
    channelBornGroups.clear();
    await runWithChannelBornMarkBudget(params.channelBornMarkBudget, (retryDeadlineMs) =>
      markChannelBornGroups({
        gameId: params.gameId,
        groups,
        retryDeadlineMs,
        // signal = 남은 전역 마킹 예산으로 유계화된 AbortSignal(헬퍼가 생성) — 운영 8s
        // statement timeout이 예산을 초과 잠식하지 않게 UPDATE 자체를 abort한다.
        updateBatch: (group, userIds, opts) => {
          const q = supabase
            .from("live_activity_started_users")
            .update({
              channel_born_environment: group.env,
              channel_born_channel_id: group.channelId,
            })
            .eq("game_id", params.gameId)
            .in("user_id", userIds);
          return opts.signal ? q.abortSignal(opts.signal) : q;
        },
      }),
    );
  };
  await runStartSendChunks({
    items: toSend,
    chunkSize: START_SEND_CHUNK_SIZE,
    persistChunk: persistChunkMarks,
    sendOne: async ([userId, meta]) => {
      // p2s per-attempt env 쌍 규칙 (스펙 v4): env known = 그 쌍만 / null = prod 쌍 →
      // BadDeviceToken 시 sandbox 쌍 재시도 → 성공 env 저장·고정. 불변식 = 발송 host env ==
      // 포함 channelId env (교차 쌍 금지). 채널 payload는 클라가 os_major>=18 && app_build>=16을
      // *명시 보고*한 토큰만 (iOS17 이하에 input-push-channel이 실리면 start 자체가 실패).
      // R3: attempt 목록은 사전 계산된 plan — channelRequired면 모든 attempt env에 채널이
      // 보장된다(채널 없는 env는 attempt에서 제외, 전부 없으면 위에서 defer 이미 처리).
      const plan = planByUser.get(userId)!;
      let res: ApnsResult = { ok: false, status: 0, invalidToken: false };
      for (const env of plan.attempts) {
        const channelId = plan.channelRequired ? params.channelByEnv.get(env) : undefined;
        res = await sendLiveActivityPushToEnv(
          {
            pushToken: meta.token,
            event: "start",
            attributesType: "KBOGameAttributes",
            attributes: {
              ...params.attributes,
              myTeamCode: params.myTeamCode,
              // channel p2s에만 static marker — 클라 ACK 증명용(스펙 v4 blocker②).
              // 레거시 payload엔 부재 → 클라가 레거시 start를 채널로 오인하지 않음.
              ...(channelId ? { channelId } : {}),
            },
            contentState: params.contentState,
            // staleDate 미전송 — 스피너 원천 차단(파일 상단 주석 참조).
            alert: params.alert,
            ...(channelId ? { inputPushChannel: channelId } : {}),
          },
          env,
          params.jwt,
        );
        if (res.ok) {
          if (channelId) {
            const key = `${env}|${channelId}`;
            if (!channelBornGroups.has(key)) channelBornGroups.set(key, { env, channelId, users: [] });
            channelBornGroups.get(key)!.users.push(userId);
          }
          // 성공 env 기록(이후 그 쌍으로 고정) — null이었거나 바뀐 경우만 update.
          // rotation fence(삼순 재리뷰 blocker②): 발송 중 앱이 토큰을 교체(env null 리셋)
          // 했으면 affected 0 = no-op — 옛 토큰의 in-flight 결과가 새 토큰 env를 덮지 않는다.
          if (meta.env !== env) {
            await supabase
              .from("live_activity_start_tokens")
              .update({ apns_environment: env })
              .match(startTokenResultFence(userId, meta.token));
          }
          break;
        }
        // BadDeviceToken(반대 env 토큰)일 때만 다음 attempt — 그 외 오류는 즉시 종료.
        if (res.reason !== "BadDeviceToken") break;
      }
      if (res.ok) sent += 1;
      else if (res.invalidToken && plan.truncated && res.reason === "BadDeviceToken") {
        // R3: env 미상 토큰의 attempt 쌍이 채널 부재로 잘린 상태의 BadDeviceToken은 "반대 env
        // 토큰인데 그 env 채널이 아직 없음"일 수 있어 무효 확정 불가 — 토큰 보존, 선점만
        // 해제(반대 env 채널 생성 후 다음 틱 재시도). 레거시 발송 fallback 없음.
        releaseRetry.push(userId);
      } else if (res.invalidToken) invalid.push({ userId, token: meta.token });
      else {
        transientFail = true; // 일시 APNs 오류(무효 토큰 아님)
        releaseRetry.push(userId);
      }
    },
  });

  // 무효 push-to-start 토큰 정리 — rotation fence: *발송했던 그 토큰*일 때만 삭제.
  // (발송 중 앱이 새 토큰을 등록했으면 행에는 새 토큰이 있고 affected 0 = 유효 토큰 보존.)
  for (const u of invalid) {
    await supabase
      .from("live_activity_start_tokens")
      .delete()
      .match(startTokenResultFence(u.userId, u.token));
  }
  // 선점 해제 = 일시 실패분 + 무효 토큰분. 일시 실패분은 다음 cron 재발송(영구 누락 방지).
  // 무효 토큰분도 반드시 해제 — 안 그러면 유저가 새 push-to-start 토큰을 재등록해도
  // (game_id,user_id) PK 충돌로 그 경기 start가 영구 skip된다(삼순 NO-GO). 도달분은 선점
  // 유지 → 다음 cron 충돌 제외 + alreadyActive(update 토큰)로 이중 보호 → 중복 카드 없음.
  for (const u of [...releaseRetry, ...invalid.map((i) => i.userId)]) {
    await supabase
      .from("live_activity_started_users")
      .delete()
      .eq("game_id", params.gameId)
      .eq("user_id", u);
  }
  return { sent, failed: transientFail && sent === 0 };
}

/**
 * 라이브 경기 → 최애팀 팬의 push-to-start 토큰으로 자동 시작 푸시.
 * 유저 단위 1회 선점(live_activity_started_users)으로 중복 발송 차단 —
 * 윈도우 도중 늦게 등록된 push-to-start 토큰도 그 시점 cron이 픽업한다.
 */
export async function pushLiveActivityStarts(
  games: KboRawGame[],
): Promise<{ started: number } | { error: string }> {
  if (!apnsConfigured()) return { started: 0 };

  // 시작 대상 = 라이브 경기 + *경기 30분 전~시작* 윈도우의 예정 경기(미리 잠금화면 표시).
  const liveGames = games.filter((g) => g.G_ID && liveActivityStartWindow(g));
  if (liveGames.length === 0) return { started: 0 };

  // jwt를 선점(insert) 전에 확보 — 토큰 발급 실패가 게임 선점을 소진(미발송으로 마킹)하지
  // 않게. 실패 시 아무 게임도 선점 안 하고 다음 cron에서 재시도.
  const jwt = await getProviderTokenSafe();
  if (!jwt) return { error: "apns provider token failed" };

  // active broadcast 채널 + 유효 구독(스펙 v4) — p2s payload 구성·중복 start 제외용.
  // (live-activity-channels 모듈과의 순환 import를 피해 직접 조회.)
  const startGameIds = liveGames.map((g) => g.G_ID as string);
  const channelsByGame = new Map<string, Map<ApnsEnvironment, string>>();
  const activeChanKeySet = new Set<string>();
  let activeChannels: ActiveChannelRow[] = [];
  {
    const { data, error } = await supabase
      .from("live_activity_channels")
      .select("game_id, environment, channel_id")
      .in("game_id", startGameIds)
      .eq("status", "active");
    if (error) return { error: error.message };
    activeChannels = (data ?? []) as ActiveChannelRow[];
    for (const r of activeChannels) {
      if (!channelsByGame.has(r.game_id)) channelsByGame.set(r.game_id, new Map());
      channelsByGame.get(r.game_id)!.set(r.environment, r.channel_id);
      activeChanKeySet.add(`${r.game_id}|${r.environment}|${r.channel_id}`);
    }
  }
  // 유효 구독 = user → device_key 집합. 재설치 판별(decideStartReissue)은 시각 비교가
  // 아니라 *현재 토큰의 device_key(sha256) 정확 일치*로 본다 — 이전 설치 구독(다른
  // device_key)은 카드 소멸 상태라 차단 사유가 아님(삼순 NO-GO: heartbeat 시각 오인 방지).
  const subscribedByGame = new Map<string, Map<string, Set<string>>>();
  if (activeChanKeySet.size > 0) {
    let subscriptions: ChannelSubscriptionRow[];
    try {
      subscriptions = await fetchChannelSubscriptions(activeChannels);
    } catch (error) {
      return { error: (error as Error).message };
    }
    for (const s of subscriptions) {
      if (!s.user_id) continue;
      if (!activeChanKeySet.has(`${s.game_id}|${s.environment}|${s.channel_id}`)) continue;
      if (!subscribedByGame.has(s.game_id)) subscribedByGame.set(s.game_id, new Map());
      const m = subscribedByGame.get(s.game_id)!;
      if (!m.has(s.user_id)) m.set(s.user_id, new Set());
      m.get(s.user_id)!.add(s.device_key);
    }
  }

  let started = 0;
  // 전 경기 합산 실제 마킹 대기만 20초로 제한한다. 쿼리/APNs fanout 경과시간은
  // runWithChannelBornMarkBudget 바깥이므로 예산을 먹지 않고, 느린 한 경기 마킹도
  // 이 전역 상한을 넘겨 뒤 경기 발송을 굶길 수 없다.
  const channelBornMarkBudget = createChannelBornMarkBudget();

  for (const g of liveGames) {
    const gameId = g.G_ID as string;
    const codes = gameId.match(/^\d{8}([A-Z]{2})([A-Z]{2})\d$/);
    if (!codes) continue;

    // 늦은 자동시작 가드 — 게임 단위 skip을 *per-토큰 게이트*로 전환(2026-07-17 재설치 사고).
    // 시작+START_WINDOW_MS 경과 경기도 루프는 계속 돌되, decideStartReissue가 "경기 시작
    // 이후 등록/갱신된 토큰"만 통과시킨다 — 복구된 cron의 뒷북 대량 발송 방지는 유지하면서
    // 경기 중 재설치(토큰 재등록) 유저는 카드를 다시 받는다. 중복 발송 차단은
    // startForTeamSide의 유저 단위 선점(live_activity_started_users) + stale claim fence가 담당.
    const startedAt = scheduledStartMs(g.G_DT, g.G_TM);

    const away = g.AWAY_NM ?? "";
    const home = g.HOME_NM ?? "";
    const awayCode = codes[1];
    const homeCode = codes[2];
    const attributes = {
      gameId,
      awayTeam: away,
      homeTeam: home,
      awayTeamCode: awayCode,
      homeTeamCode: homeCode,
    };
    const isLiveNow = gameStatus(g) === "live";
    // 🚨 인시던트 픽스(2026-07-07): start는 *항상 scheduled 프레임*으로 태어나게 한다.
    // 라이브 프레임을 초기 콘텐츠로 실은 push-to-start는 iOS가 카드를 표시하지 않는 현상을
    // 실기기 3연속 재현(생성·토큰 등록은 되나 미표시). scheduled로 태어난 카드는 정상 표시되고,
    // 라이브 경기는 다음 warmup 틱(≤1분)의 update가 곧바로 live 프레임으로 전환한다.
    // 근본(라이브-start 렌더)은 네이티브에서 조사 후 원복.
    const contentState = buildContentState(g, "scheduled");

    // push-to-start에 alert 동봉 — *무음*(alert 없는) push-to-start는 iOS가 잠금화면 카드를
    // 띄우지 않는다(실기기 확인 2026-06-26: 무음=미표시, alert=표시). 경기 30분 전 예정
    // 카드가 안 뜨던 직접 원인. alert가 표시 트리거 겸 "내 팀 경기 곧 시작" 배너 역할.
    const alert = {
      title: `⚾ ${away} vs ${home}`,
      body: isLiveNow
        ? "실시간 중계가 시작됐어요 — 잠금화면에서 확인하세요"
        : "곧 경기 시작! 잠금화면에서 실시간 중계를 확인하세요",
    };

    // away/home 슬롯을 각자 그 팀 코드로 강조(myTeamCode) — 수신자별 최애팀 반영.
    const channelByEnv = channelsByGame.get(gameId) ?? new Map<ApnsEnvironment, string>();
    const subscribedKeysByUser =
      subscribedByGame.get(gameId) ?? new Map<string, Set<string>>();
    const awaySide = await startForTeamSide({
      gameId, teamId: teamIdByShortName(away), myTeamCode: awayCode,
      attributes, contentState, alert, jwt, channelByEnv, subscribedKeysByUser,
      gameStartMs: startedAt, channelBornMarkBudget,
    });
    const homeSide = await startForTeamSide({
      gameId, teamId: teamIdByShortName(home), myTeamCode: homeCode,
      attributes, contentState, alert, jwt, channelByEnv, subscribedKeysByUser,
      gameStartMs: startedAt, channelBornMarkBudget,
    });
    started += awaySide.sent + homeSide.sent;
    // 일시 실패분은 startForTeamSide에서 유저 단위로 선점 해제됨 → 다음 cron 재시도.
    // (이미 도달한 유저는 선점 유지 + alreadyActive로 이중 제외 → 중복 카드 없음.)
  }

  return { started };
}

// ── Layer 2 — 무음 백그라운드 wake 푸시 ──────────────────────────────────────
// push-to-start로 카드는 떴지만(started_users 있음) update 토큰이 아직 없는
// (live_activity_tokens 없음) 유저의 iOS 기기로 *무음*(content-available) 푸시를 보내
// 앱을 백그라운드로 깨운다 → AppDelegate.didReceiveRemoteNotification이
// rescanActiveActivities() → register-device로 토큰을 등록한다. 앱을 열지 않아도 카드가
// live로 갱신되는 "네이버 수준" 경로. Apple이 무음 푸시를 throttle하므로 best-effort.
// (강제종료(스와이프 kill) 기기는 iOS가 안 깨움 → 구조적 한계, iOS 18 broadcast가 상위해법.)

/** 무음 wake는 *이벤트(카드 발급/live 전환/취소·종료 확정)* 직후 창에서만(스팸/throttle 방지). 이 창 지나 미등록이면 강제종료 등. */
const WAKE_WINDOW_MS = 20 * 60 * 1000;

interface WakeResult { woke: number; failed: number; skipped: number; cleaned: number; ok: boolean }
const EMPTY_WAKE: WakeResult = { woke: 0, failed: 0, skipped: 0, cleaned: 0, ok: true };

/**
 * 토큰 미등록 갭 유저의 iOS 기기를 무음 푸시로 깨워 update 토큰 등록을 유도한다.
 * wake 창은 *예정시각이 아니라 실제 live 전환 시각* 기준(삼순 #514 blocker): warmup에서
 * notifyGameStatusTransitions()가 먼저 돌아 game_notify_state.start_notified/updated_at을
 * 세팅하므로, 그 updated_at(=live 전환 근사시각)에서 WAKE_WINDOW_MS 이내 경기만 대상.
 * → 우천/지연으로 예정시각+20분을 한참 넘겨 live 전환된 경기도 정확히 커버(예정시각 기준이면
 * 스킵됐음). start_notified row가 아직 없으면(막 전환/알림 경로 이슈) 안전하게 포함.
 * 창은 *현재 active 채널 세대의 생성/교체 시각* 기준으로도 재오픈된다(isWakeWindowOpen,
 * 삼순 라운드3): 라이브 도중 채널이 늦게 생성되거나 A→B로 교체되면 그 시점에야
 * 구채널/레거시 카드가 gap으로 복귀하므로, 이벤트 창이 닫혔어도 세대 생성 후
 * WAKE_WINDOW_MS 동안 wake 구제를 허용한다(채널 변경 없으면 기존 마감 유지).
 * 취소(우천 등) 경기도 동일하게 커버(cancel_notified 시각 기준 창) — 토큰 미등록 gap 카드를 깨워
 * 등록 유도 → pushLiveActivityUpdates(cancelled→end)가 정리. (이미 오래된 취소는 창 밖=자동만료.)
 * 종료(final) 경기도 동일하게 커버(end_notified 시각 기준 창) — gap 유저는 end 푸시가 못 닿아
 * 패배 스코어 좀비 카드가 잠금화면에 반영구 잔존(2026-07-08 #cs 제보: 7/7 KIA 2-10 카드).
 * wake → 토큰 등록 → 다음 warmup의 pushLiveActivityUpdates(final→end)가 15분 잔상 후 제거.
 * 예정(scheduled) 카드도 커버 — 단 game_notify_state 이벤트가 아직 없으므로 창은 *유저별
 * started_users.created_at*(=push-to-start 발급 시각, 경기 30분 전) 기준. live 전환 *전에*
 * 토큰을 선등록해 전환 직후 첫 update부터 즉시 반영("경기 예정" 프리즈 완화).
 * FCM만 사용 → APNs 미설정과 무관. 매 warmup 사이클 호출(등록되면 다음 사이클 갭에서 빠짐).
 */
export async function pushLiveActivitySilentWakes(
  games: KboRawGame[],
): Promise<WakeResult | { error: string }> {
  const liveGameIds = games
    .filter((g) => gameStatus(g) === "live" && g.G_ID)
    .map((g) => g.G_ID as string);
  // 취소(우천 등) 경기도 wake 대상 — push-to-start로 뜬 카드가 update 토큰 미등록(gap)이면
  // #529의 end 경로가 못 닿아 "경기 예정"으로 얼어붙는다. 무음 wake로 토큰 등록을 유도하면
  // 다음 warmup의 pushLiveActivityUpdates(cancelled→end)가 그 토큰으로 카드를 정리한다.
  const cancelledGameIds = games
    .filter((g) => isKboGameCancelled(g.CANCEL_SC_ID) && g.G_ID)
    .map((g) => g.G_ID as string);
  // 종료(final) 경기 — end 푸시는 토큰 보유자에게만 가므로 gap 유저의 카드는 좀비로 잔존.
  // end 이벤트 후 WAKE_WINDOW_MS 창에서 깨워 토큰 등록 → 다음 틱 end 경로가 정리.
  const finalGameIds = games
    .filter((g) => gameStatus(g) === "final" && !isKboGameCancelled(g.CANCEL_SC_ID) && g.G_ID)
    .map((g) => g.G_ID as string);
  // 예정(scheduled) 경기 — 30분 전 push-to-start 카드가 발급된 직후부터 토큰 선등록 유도.
  // 게임 단위 이벤트가 없으므로 아래에서 *유저별 started_users.created_at* 기준으로 창 적용.
  const scheduledGameIds = games
    .filter((g) => gameStatus(g) === "scheduled" && !isKboGameCancelled(g.CANCEL_SC_ID) && g.G_ID)
    .map((g) => g.G_ID as string);
  const eventGameIds = [...new Set([...liveGameIds, ...cancelledGameIds, ...finalGameIds])];
  const candidateGameIds = [...new Set([...eventGameIds, ...scheduledGameIds])];
  if (candidateGameIds.length === 0) return EMPTY_WAKE;

  // 이벤트 시각 = game_notify_state.updated_at: live는 start_notified, 취소는 cancel_notified,
  // 종료는 end_notified 기준(모두 notifyGameStatusTransitions가 먼저 세팅 → updated_at이 해당
  // 전환의 근사시각). 이 시각에서 WAKE_WINDOW_MS 이내만(스팸/throttle 방지). 이미 오래된
  // 취소/종료(예: 30분+ 경과)는 창 밖이라 제외 — 앱 오픈/iOS 자동만료(~8h)로 소멸.
  const eventSince = new Map<string, number>();
  if (eventGameIds.length > 0) {
    const { data: nsRows, error: nsErr } = await supabase
      .from("game_notify_state")
      .select("game_id, start_notified, cancel_notified, end_notified, updated_at")
      .in("game_id", eventGameIds);
    if (nsErr) return { error: nsErr.message };
    for (const r of (nsRows ?? []) as { game_id: string; start_notified: boolean | null; cancel_notified: boolean | null; end_notified: boolean | null; updated_at: string | null }[]) {
      if ((r.start_notified || r.cancel_notified || r.end_notified) && r.updated_at) eventSince.set(r.game_id, new Date(r.updated_at).getTime());
    }
  }
  // active 채널 조회를 wake 창 판정 *앞*으로 — created_at(현재 채널 세대의 생성/교체
  // 시각)이 창 재오픈 판정에 필요(삼순 라운드3). 같은 결과를 아래 activeKeys/구독
  // 확인에서 재사용해 채널 쿼리는 종전처럼 1회만 나간다(.in 범위만 candidate로 확장).
  // query-guard: bounded -- PK (game_id, environment)·env 2종 → 행수 ≤ 2×당일 경기수(≤10),
  // .in은 당일 스케줄 game_id로 상한(종전 wakeGameIds 쿼리와 동일 구조, 범위만 candidate)
  const { data: chanRows, error: chanError } = await supabase
    .from("live_activity_channels")
    .select("game_id, environment, channel_id, created_at")
    .in("game_id", candidateGameIds)
    .eq("status", "active");
  if (chanError) return { error: chanError.message };
  const allActiveChannels = (chanRows ?? []) as ActiveChannelRow[];
  // 게임별 현재 채널 세대 생성/교체 시각 — env별 active 행 중 가장 최근 created_at.
  const chanGenAt = new Map<string, number>();
  for (const r of allActiveChannels) {
    if (!r.created_at) continue;
    const t = new Date(r.created_at).getTime();
    if (!Number.isFinite(t)) continue;
    const prev = chanGenAt.get(r.game_id);
    if (prev === undefined || t > prev) chanGenAt.set(r.game_id, t);
  }

  // wake 대상 = 이벤트(live 전환/취소·종료 확정) 후 WAKE_WINDOW_MS 이내, *또는* 현재
  // active 채널 세대가 생성/교체된 지 WAKE_WINDOW_MS 이내(삼순 라운드3 — 라이브 도중
  // 채널 늦은 생성/A→B 교체 시 구채널·레거시 카드 wake 구제 창 재오픈). 이벤트 row
  // 없으면(막 발생 등) 포함(안전). 채널 변경 없이 두 창 모두 지나면 기존대로 마감.
  // 예정 경기는 게임 단위 창 없이 통과 — 유저별 created_at 창으로 아래에서 거른다.
  const nowMs = Date.now();
  const wakeGameIds = [
    ...eventGameIds.filter((id) =>
      isWakeWindowOpen(nowMs, eventSince.get(id), chanGenAt.get(id), WAKE_WINDOW_MS)),
    ...scheduledGameIds,
  ];
  if (wakeGameIds.length === 0) return EMPTY_WAKE;

  // 갭 = started_users(카드 생성) − live_activity_tokens(update 토큰 등록).
  let started: StartedUserRow[];
  let tokenRows: TokenRow[];
  try {
    [started, tokenRows] = await Promise.all([
      fetchStartedUsers(wakeGameIds),
      fetchLiveActivityTokens(wakeGameIds),
    ]);
  } catch (error) {
    return { error: (error as Error).message };
  }
  if (started.length === 0) return EMPTY_WAKE;
  const tokened = new Set(
    tokenRows.map((r) => `${r.user_id}|${r.game_id}`),
  );
  // 채널 구독 확인(active 채널 일치) 유저는 update 토큰이 없어도 gap이 아님 — broadcast가
  // 카드를 갱신하므로 wake 불필요(스펙 v4 §서버 4: gap 계산도 동일 조건으로 제외).
  // activeKeys는 아래 selectWakeGapRows의 채널출생 세대 일치 판정에도 쓴다(단일 기준).
  const activeKeys = new Set<string>();
  {
    const wakeSet = new Set(wakeGameIds);
    const activeChannels = allActiveChannels.filter((r) => wakeSet.has(r.game_id));
    for (const r of activeChannels) {
      activeKeys.add(`${r.game_id}|${r.environment}|${r.channel_id}`);
    }
    if (activeKeys.size > 0) {
      let subRows: ChannelSubscriptionRow[];
      try {
        subRows = await fetchChannelSubscriptions(activeChannels);
      } catch (error) {
        return { error: (error as Error).message };
      }
      for (const s of subRows) {
        if (!s.user_id) continue;
        if (activeKeys.has(`${s.game_id}|${s.environment}|${s.channel_id}`)) {
          tokened.add(`${s.user_id}|${s.game_id}`);
        }
      }
    }
  }
  // 갭 유저 = (user,game) 토큰·유효 ACK 없음 + 유효 채널출생 아님. wake는 기기 단위라 user로 중복 제거.
  // 채널출생 카드는 *출생 세대가 현재 active 채널과 일치*할 때만 broadcast 수신(어드민
  // updatable 합산과 동일 기준 = isLiveBornChannel)으로 보고 wake 대상·wake_attempted_at
  // 기록 모두에서 제외(분모 오염 방지) — selectWakeGapRows가 SSOT. 출생 채널이 교체된
  // 행(세대 불일치)은 gap으로 복귀해 wake로 구제한다(삼순 라운드2 blocker).
  // 예정 경기 row는 카드 발급(created_at) 후 WAKE_WINDOW_MS 이내만 — 그 뒤는 live 전환 창이 백스톱.
  const scheduledSet = new Set(scheduledGameIds);
  const gapRows = selectWakeGapRows(started, tokened, activeKeys, scheduledSet, nowMs, WAKE_WINDOW_MS);
  const gapUsers = [...new Set(gapRows.map((r) => r.user_id))];
  if (gapUsers.length === 0) return EMPTY_WAKE;

  // 옵트아웃(live_activity=false) 제외 — 깨워도 register-device가 skip. .in() 200 청크.
  const optedOut = new Set<string>();
  for (let i = 0; i < gapUsers.length; i += 200) {
    const { data: prefRows, error } = await supabase
      .from("notification_prefs")
      .select("user_id, live_activity")
      .in("user_id", gapUsers.slice(i, i + 200));
    if (error) return { error: error.message };
    for (const r of (prefRows ?? []) as { user_id: string; live_activity: boolean | null }[]) {
      if (r.live_activity === false) optedOut.add(r.user_id);
    }
  }
  const targets = gapUsers.filter((u) => !optedOut.has(u));
  if (targets.length === 0) return EMPTY_WAKE;

  // iOS 기기로만 무음 wake(dataOnly + content-available). Android는 platform 필터로 제외.
  const res = await sendFcmToUsers(
    targets,
    { title: "", body: "", dataOnly: true, apnsBackground: true, data: { kind: "la_wake" } },
    undefined,
    "ios",
  );
  // ③ wake 계측 — 시도한 (game,user) pair에 첫 시도 시각만 기록(wake_attempted_at is null 조건).
  // 이후 그 pair가 update 토큰/채널 ACK로 전환되면 어드민 API가 '구제 성공'으로 집계해
  // wake 성공률을 낸다. best-effort(계측 실패가 wake 경로를 막지 않게 에러 무시) —
  // 새 테이블 없이 기존 선점 행 컴럼 활용(최소 인프라).
  {
    const targetSet = new Set(targets);
    const pairsByGame = new Map<string, string[]>();
    for (const r of gapRows) {
      if (!targetSet.has(r.user_id)) continue;
      if (!pairsByGame.has(r.game_id)) pairsByGame.set(r.game_id, []);
      pairsByGame.get(r.game_id)!.push(r.user_id);
    }
    const nowIso = new Date().toISOString();
    for (const [gid, users] of pairsByGame) {
      for (let i = 0; i < users.length; i += 200) {
        await supabase
          .from("live_activity_started_users")
          .update({ wake_attempted_at: nowIso })
          .eq("game_id", gid)
          .is("wake_attempted_at", null)
          .in("user_id", users.slice(i, i + 200));
      }
    }
  }
  // 운영 관측용 전체 통계 노출(삼순 비블로커) — woke=성공 발송 기기수.
  return { woke: res.sent, failed: res.failed, skipped: res.skipped, cleaned: res.cleaned, ok: res.ok };
}
