import type { KboRawGame } from "@/types/api";
import type { GameEvent } from "@/types/game-events";
import {
  runWidgetFastLoop,
  type FastLoopTick,
  type WidgetSourceTrace,
} from "@/lib/notifications/widget-fast-loop";

// 라이브 fast path 서브틱 오케스트레이션 — warmup cron 1회 호출 내부의 +15/+30/+45초
// 서브틱에서 잠금화면 LA(레거시 per-토큰 → broadcast)·위젯(안드/iOS)·득점 푸시를
// 재실행해 점수 변화→잠금화면 반영 지연을 줄인다.
//
// ── SLO 정의 (삼순 R1 blocker② — "최대 15초" 단일 문구 금지) ──
// 이 루프가 보장하는 것은 **서버 감지→발송 시도 SLO**다: KBO 스코어보드 변화 감지 후
// ≤15초(다음 서브틱) 안에 APNs/FCM 발송을 *시작*한다. broadcast는 No-Message-Stored +
// expiration 0이라 APNs accepted가 단말 수신 확인이 아니므로 **단말 체감은 best-effort**:
// 유실 시 다음 서브틱의 broadcast-only catch-up(아래) + 채널 2분 heartbeat
// (live-activity-channel-policy.ts)로 stale 상한만 건다. 절대 전달 SLA는 구조적으로 불가.
//
// ── DB 부하 근거 (2026-07-22 Supabase conn pool 고갈 장애 재발 방지) ──
// 서브틱은 KBO 스코어보드(무DB) 1회 fetch 후 *diff도 catch-up pending도 없으면* 어떤 DB
// 접근/APNs·FCM 발송도 하지 않는다(cheap early-exit). catch-up은 무변화 첫 서브틱에서
// broadcast-only 1회로 유계(채널 select 1 + 경기당 broadcast 1건 — per-토큰 fanout 없음)라
// 하루 총 DB 작업량은 카드축 diff(타석 단위) 감지 횟수 + 분당 최대 1회 catch-up 수준.
//
// ── 중복 발송 가드 (서브틱 ↔ 본체 ↔ 다음 분 cron) ──
// diff 게이트는 1차 방어일 뿐이고, 각 발송 경로의 기존 선점/dedupe가 서브틱에도 성립한다:
//  - 득점 푸시: notified_score_events(event_id PK) 멱등 claim — 같은 득점 이벤트는 어느
//    틱/인스턴스가 겹쳐도 정확히 1회 발송(claimEvent race-safe).
//  - iOS 홈위젯: ios_widget_push_state 점수 커서 CAS claim — 동시 틱 중 1개만 발송.
//  - LA broadcast: live_activity_channels last_state_hash 비교(무변화 skip) + generation fence.
//  - 레거시 per-토큰 LA: 채널 행/폴백 테이블의 직전 hash 비교로 무변화 skip.
//  - 안드 위젯: in-memory canonical 시그니처 dedupe(dedupeAgainstLast).
//
// ── 시작알림 게이트 비간섭 (#798/#800) ──
// 시작알림(notifyGameStatusTransitions)의 정시-only 게이트는 "분 단위 cron 연속 관측"
// (SCHEDULED_SEEN_RECENT_MS=90s) 판정이라 서브틱에서 실행하면 관측 주기 가정이 깨진다.
// 따라서 시작/종료 알림·순위 변동·이닝 요약·선수 활약·LA autostart·silent wake는 서브틱에서
// *실행하지 않고* 기존 분 단위 본체 경로 그대로 둔다.
//
// ── broadcast 친리티컬 패스 vs 느린 fanout 분리 (삼순 R2 blocker①) ──
// 서브틱 gate가 열려면 되는 조건은 *초기 broadcast 발송 완료*뿐이다. 레거시 per-토큰
// fanout·push-to-start·iOS 위젯 FCM은 대상 유저 수에 비례하는 느린 tail이라, 이들을
// gate에 묶으면 tail>52s에서 서브틱이 0회가 된다(R1 구조의 재발). 따라서:
//  - 친리티컬: relay 한 줄 → 채널 ensure → 레거시용 직전-상태 스냅샷 → broadcast.
//    gate는 이 경로 완료 직후 열린다. stale-overwrite 방지는 *broadcast 축만의* 순서
//    보장(cycle0 broadcast → gate → 서브틱 broadcast 직렬 await)으로 충족.
//  - 느린 fanout(레거시/start/iOS 위젯): LaFanoutQueue에 직렬 enqueue만 하고 서브틱은
//    기다리지 않는다. 큐 직렬화로 per-토큰 발송도 틱 순서대로 나간다(레거시 카드
//    stale-overwrite 방지).
//
// ── 레거시↔broadcast hash 순서 문제 (스냅샷으로 해소) ──
// 레거시 발송 판정은 채널 행의 "직전 틱" last_state_hash를 읽고, broadcast가 그 hash를
// 전진시킨다. R1까지는 "레거시 → broadcast" 실행 순서로 이걸 보장했지만, 그 순서가 느린
// 레거시 fanout을 broadcast 앞에 묶어 gate를 막았다(R2 blocker①). 수정: broadcast *전*에
// 채널 상태 스냅샷(snapshotLegacyState)을 떠서 레거시에 주입 — 레거시가 broadcast 뒤에
// 돌아도 직전-틱 판정이 유지돼 구빌드(11~15) 카드가 얼어붙지 않는다.

/**
 * 점수축 시그니처 — 상태/취소/점수/이닝/초말. 이 축이 바뀐 경우에만 game-events
 * self-fetch + 득점 푸시 경로를 태운다(타석 단위 변화마다 이벤트 생성 fetch가 도는
 * 것을 방지 — KBO 원천 호출은 서브틱당 스코어보드 1회 원칙).
 */
export function scoreAxisSignature(g: KboRawGame): string {
  return [g.GAME_STATE_SC, g.CANCEL_SC_ID, g.T_SCORE_CN, g.B_SCORE_CN, g.GAME_INN_NO, g.GAME_TB_SC]
    .map((v) => String(v ?? ""))
    .join("|");
}

/**
 * 카드축 시그니처 — 점수축 + 아웃/주자/타자/투수. 잠금 LA 카드·위젯이 표시하는 필드
 * 전체라, 이 축의 변화가 있어야만 발송 경로(DB/APNs/FCM)를 시작한다. 무변화 틱 = no-op.
 */
export function liveCardSignature(g: KboRawGame): string {
  return [
    scoreAxisSignature(g),
    // 볼카운트(B/S) — 카드가 표시하는 필드이므로 diff 축에 포함(삼순 R1 blocker③:
    // 볼/스트라이크만 바뀐 서브틱이 no-op으로 스킵되던 누락 수정). 점수축은 아님 —
    // 볼카운트 변화만으로 game-events fetch/득점 푸시가 돌지 않는다.
    g.BALL_CN,
    g.STRIKE_CN,
    g.OUT_CN,
    g.B1_BAT_ORDER_NO,
    g.B2_BAT_ORDER_NO,
    g.B3_BAT_ORDER_NO,
    g.T_P_NM,
    g.B_P_NM,
  ]
    .map((v) => String(v ?? ""))
    .join("|");
}

/** 서브틱 간 직전 스냅샷 — cycle 0(본체가 처리한 초기 fetch)에서 seed, 매 틱 전진. */
export interface LiveFastPathState {
  cardSigByGame: Map<string, string>;
  scoreSigByGame: Map<string, string>;
  /**
   * broadcast 유실 catch-up 대상(삼순 R1 blocker②) — 직전에 변화 broadcast를 발사한
   * 라이브 경기. APNs accepted ≠ 단말 수신이므로, 다음 *무변화* 서브틱에서 1회
   * current-state p10 broadcast를 강제 재발송한 뒤 비운다(유계 — 틱당 최대 1회).
   * seed 시 라이브 경기 전체를 넣어 본체(cycle 0) broadcast 유실도 +15s 안에 커버.
   * broadcast는 최신 상태 멱등이라 중복 무해 — 득점 푸시(FCM)는 이 경로에 절대 미포함.
   */
  catchupGameIds: Set<string>;
}

/**
 * 초기 스냅샷으로 baseline 시그니처를 만든다. 본체(cycle 0)가 이 스냅샷의 발송을 이미
 * 담당하므로, 서브틱은 여기서 *달라진* 것만 처리한다. 초기 fetch 실패(ok:false) 시 빈
 * baseline → 첫 성공 서브틱이 전 경기를 "변화"로 보고 fast path를 1회 태워 그 분을 복구.
 */
export function seedLiveFastPathState(games: KboRawGame[]): LiveFastPathState {
  const state: LiveFastPathState = {
    cardSigByGame: new Map(),
    scoreSigByGame: new Map(),
    catchupGameIds: new Set(),
  };
  for (const g of games) {
    if (!g.G_ID) continue;
    state.cardSigByGame.set(g.G_ID, liveCardSignature(g));
    state.scoreSigByGame.set(g.G_ID, scoreAxisSignature(g));
    // 본체(cycle 0)가 이 스냅샷으로 broadcast를 쏘지만 그 발송이 유실될 수 있다 —
    // 첫 무변화 서브틱이 1회 catch-up 재발송(위 catchupGameIds 주석).
    if (g.GAME_STATE_SC === "2") state.catchupGameIds.add(g.G_ID);
  }
  return state;
}

export interface LiveSnapshotDiff {
  /** 카드축 변화 경기(신규 등장 포함) — 있어야만 발송 경로 시작. */
  changedGameIds: string[];
  /** 점수축 변화 *라이브* 경기 — 득점 푸시(game-events self-fetch) 대상. */
  scoreChangedLiveGameIds: string[];
}

/** 직전 스냅샷과 비교해 변화 경기를 찾고, state를 이번 스냅샷으로 전진시킨다. */
export function diffAndAdvance(state: LiveFastPathState, games: KboRawGame[]): LiveSnapshotDiff {
  const changedGameIds: string[] = [];
  const scoreChangedLiveGameIds: string[] = [];
  for (const g of games) {
    if (!g.G_ID) continue;
    const cardSig = liveCardSignature(g);
    const scoreSig = scoreAxisSignature(g);
    if (state.cardSigByGame.get(g.G_ID) !== cardSig) changedGameIds.push(g.G_ID);
    if (g.GAME_STATE_SC === "2" && state.scoreSigByGame.get(g.G_ID) !== scoreSig) {
      scoreChangedLiveGameIds.push(g.G_ID);
    }
    state.cardSigByGame.set(g.G_ID, cardSig);
    state.scoreSigByGame.set(g.G_ID, scoreSig);
  }
  return { changedGameIds, scoreChangedLiveGameIds };
}

/** 레거시 판정용 직전 채널 상태 스냅샷 항목. */
export interface LegacyLastState {
  score: string | null;
  hash: string | null;
}

/**
 * 느린 LA fanout 직렬 큐 (삼순 R2 blocker①) — 레거시 per-토큰/start/iOS 위젯 등
 * 유저 수 비례 tail을 broadcast 친리티컬 패스 밖으로 빼되, enqueue 순서대로 직렬 실행해
 * 틱 N의 per-토큰 발송이 틱 N+1과 얽히지 않게 한다. 오류는 항목별 격리(큐 지속).
 */
export interface LaFanoutQueue {
  enqueue(label: string, run: () => Promise<unknown>): void;
  /** 모든 enqueue된 항목 완료까지 대기 후 결과 반환(route 응답/관제용). */
  drain(): Promise<{ label: string; result: unknown }[]>;
}

export function createLaFanoutQueue(): LaFanoutQueue {
  const results: { label: string; result: unknown }[] = [];
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue(label, run) {
      tail = tail.then(async () => {
        try {
          results.push({ label, result: await run() });
        } catch (e) {
          results.push({ label, result: { error: (e as Error).message } });
        }
      });
    },
    async drain() {
      await tail;
      return results;
    },
  };
}

/** 주입 의존성 — QA 스모크가 network/supabase/APNs/FCM 없이 게이트·순서를 검증. */
export interface LiveFastPathDeps {
  now(): number;
  /** 라이브 경기 문자중계 최근 한 줄(실패 격리 — 오류 시 빈 Map). */
  fetchRelayLines(liveGameIds: string[]): Promise<Map<string, string>>;
  pushAndroid(games: KboRawGame[], trace: WidgetSourceTrace): Promise<unknown>;
  /** broadcast 직전 채널 상태 스냅샷 — 레거시 판정 주입용(실패 시 빈 Map = 전 경기 p10 쪽 안전). */
  snapshotLegacyState(liveGameIds: string[]): Promise<Map<string, LegacyLastState>>;
  /** 느린 fanout enqueue — 서브틱은 완료를 기다리지 않는다(위 LaFanoutQueue 주석). */
  enqueueLaFanout(label: string, run: () => Promise<unknown>): void;
  pushLegacyLa(
    games: KboRawGame[],
    lastPlayByGame: Map<string, string>,
    channelLastStateOverride: Map<string, LegacyLastState>,
  ): Promise<unknown>;
  pushBroadcast(games: KboRawGame[], lastPlayByGame: Map<string, string>): Promise<unknown>;
  /**
   * broadcast-only catch-up(삼순 R1 blocker②) — gameIds에 대해 무변화여도 p10
   * current-state를 강제 재발송. 채널 hash-skip을 우회하는 force 경로
   * (live-activity-channels.ts forceCurrentStateGameIds). 득점 푸시/레거시/위젯 미포함.
   */
  pushBroadcastCatchup(
    games: KboRawGame[],
    lastPlayByGame: Map<string, string>,
    gameIds: string[],
  ): Promise<unknown>;
  pushIosWidget(games: KboRawGame[], lastPlayByGame: Map<string, string>): Promise<unknown>;
  /** game-events self-fetch(이벤트 생성 diff 경로) — 점수축 변화 라이브 경기만. */
  fetchGameEvents(liveGameIds: string[]): Promise<Map<string, GameEvent[]>>;
  notifyScore(games: KboRawGame[], eventsByGame: Map<string, GameEvent[]>): Promise<unknown>;
}

export type LiveFastPathTickResult =
  | { skipped: "no_diff"; catchup?: { gameIds: string[]; result: unknown } }
  | {
      changedGameIds: string[];
      scoreChangedLiveGameIds: string[];
      android: unknown;
      laBroadcast: unknown;
      /** 느린 fanout(레거시/iOS 위젯)은 큐에 넘겼음 — 결과는 route가 drain에서 회수. */
      laFanout: "queued";
      score: unknown;
      /** KBO 응답 검증 완료(diff 감지 재료 확보) → broadcast/안드/득점 완료까지 ms. */
      detectToSendMs: number;
    };

/**
 * 서브틱 1회 실행. diff 없으면 DB/APNs/FCM 어디에도 접근하지 않고 즉시 반환.
 * 변화 시: relay 한 줄 → 스냅샷 → broadcast(친리티컬, await) + 느린 fanout(레거시→iOS 위젯)은
 * 큐 enqueue만 ∥ 안드 위젯 ∥ 득점 푸시. 실패는 경로별 격리(warmup 본체와 동일 패턴).
 */
export async function runLiveFastPathTick(
  deps: LiveFastPathDeps,
  state: LiveFastPathState,
  games: KboRawGame[],
  trace: WidgetSourceTrace,
): Promise<LiveFastPathTickResult> {
  const guard = async (run: () => Promise<unknown>): Promise<unknown> => {
    try {
      return await run();
    } catch (e) {
      return { error: (e as Error).message };
    }
  };

  const diff = diffAndAdvance(state, games);
  if (diff.changedGameIds.length === 0) {
    // 무변화 틱 — catch-up pending이 있으면 broadcast-only 재발송 1회(삼순 R1 blocker②:
    // APNs accepted였지만 단말이 놓친 첫 발송을 다음 15초 서브틱이 복구). pending까지
    // 없으면 진짜 no-op(DB/APNs/FCM 무접근 — conn pool 보호 불변식 유지).
    const pending = [...state.catchupGameIds].filter((id) =>
      games.some((g) => g.G_ID === id && g.GAME_STATE_SC === "2"),
    );
    state.catchupGameIds.clear();
    if (pending.length === 0) return { skipped: "no_diff" };
    let catchupLastPlay = new Map<string, string>();
    try {
      catchupLastPlay = await deps.fetchRelayLines(pending);
    } catch {
      // relay 실패 → 줄만 안 뜸(발송 경로는 그대로).
    }
    const result = await guard(() => deps.pushBroadcastCatchup(games, catchupLastPlay, pending));
    // 호출 자체 실패(오류 반환/예외) 시 pending 재-arm — clear 후 실패하면 p10 재시도 없이
    // 2분 heartbeat까지 stale로 남는다(삼순 R2 blocker③). 다음 무변화 틱이 재시도(틱당 1회 유계).
    if (result !== null && typeof result === "object" && "error" in result) {
      for (const id of pending) state.catchupGameIds.add(id);
    }
    return { skipped: "no_diff", catchup: { gameIds: pending, result } };
  }

  const liveGameIds = games
    .filter((g) => g.G_ID && g.GAME_STATE_SC === "2")
    .map((g) => g.G_ID as string);
  // 이번에 변화 broadcast를 쏘는 라이브 경기 — 다음 무변화 서브틱의 catch-up 대상으로
  // arm(merge — 직전 pending을 지우지 않아 연속 변화 틱에서도 유실 커버 유지).
  for (const id of diff.changedGameIds) {
    if (liveGameIds.includes(id)) state.catchupGameIds.add(id);
  }

  let lastPlayByGame = new Map<string, string>();
  try {
    lastPlayByGame = await deps.fetchRelayLines(liveGameIds);
  } catch {
    // relay 실패 → 카드에 중계 한 줄만 안 뜸(본체와 동일 격리).
  }

  const [android, laBroadcast, score] = await Promise.all([
    guard(() => deps.pushAndroid(games, trace)),
    (async () => {
      // broadcast 친리티컬 패스(삼순 R2 blocker①): 스냅샷을 broadcast *전*에 떠 레거시에
      // 주입하면 레거시를 broadcast 뒤 큐로 보내도 직전-틱 판정이 유지된다(hash 순서
      // 불변식의 스냅샷 대체). 스냅샷 실패 시 빈 Map — 레거시가 전 경기를 미수신 취급(p10
      // 1회 과발송)하는 쪽이 영구 skip 프리즈보다 안전하다.
      let legacySnapshot = new Map<string, LegacyLastState>();
      try {
        legacySnapshot = await deps.snapshotLegacyState(liveGameIds);
      } catch {
        // 빈 스냅샷 fallback — 위 주석.
      }
      const result = await guard(() => deps.pushBroadcast(games, lastPlayByGame));
      // 느린 fanout — 큐 직렬(틱 순서 보장)만 하고 이 틱은 완료를 기다리지 않는다 —
      // fanout>52s여도 다음 서브틱 broadcast가 굶지 않음(R2 blocker①). iOS 위젯은 자체
      // CAS 커서라 순서 무관하지만 본체 순서(레거시→iOS)를 따른다.
      deps.enqueueLaFanout(`tick:${diff.changedGameIds.join(",")}`, async () => {
        const legacyLa = await guard(() =>
          deps.pushLegacyLa(games, lastPlayByGame, legacySnapshot),
        );
        const iosWidget = await guard(() => deps.pushIosWidget(games, lastPlayByGame));
        return { legacyLa, iosWidget };
      });
      return result;
    })(),
    (async () => {
      if (diff.scoreChangedLiveGameIds.length === 0) return { skipped: "no_score_diff" };
      const eventsByGame = await guard(() => deps.fetchGameEvents(diff.scoreChangedLiveGameIds));
      if (!(eventsByGame instanceof Map)) return eventsByGame; // fetch 오류 — 다음 분 cron이 커버
      return guard(() => deps.notifyScore(games, eventsByGame));
    })(),
  ]);

  return {
    changedGameIds: diff.changedGameIds,
    scoreChangedLiveGameIds: diff.scoreChangedLiveGameIds,
    android,
    laBroadcast,
    laFanout: "queued",
    score,
    detectToSendMs: Math.max(0, deps.now() - trace.fetchedAtMs),
  };
}

/**
 * 서브틱 발송 게이트 — *초기 broadcast 발송 완료*만 기다린다(삼순 R2 blocker①).
 *
 * R1(NO-GO): 게이트가 LA 축 전체(relay→ensure→레거시 전 토큰 fanout→broadcast→start→
 * iOS 위젯 FCM)를 기다려, start/위젯/레거시 tail>52s면 서브틱 0회. 수정: 친리티컬 패스를
 * relay→ensure→스냅샷→broadcast로 좁혀 그 완료 직후 게이트를 연다(느린 fanout은
 * LaFanoutQueue로 분리). stale-overwrite 방지는 broadcast 축만의 순서 보장(cycle0
 * broadcast → gate → 서브틱 broadcast 직렬)으로 충족한다.
 * 대기는 deadline까지 유계 — 초기 broadcast 경로 자체가 deadline을 넘기면
 * initial_broadcast_overrun으로 발송 금지(그 분은 다음 cron이 커버). 한 번 열리면 즉시 통과.
 */
export function gateFastPathOnInitialBroadcast<T>(opts: {
  initialBroadcastDone: Promise<void>;
  deadlineAtMs: number;
  now(): number;
  sleep(ms: number): Promise<void>;
  runTick(games: KboRawGame[], trace: WidgetSourceTrace): Promise<T>;
}): (
  games: KboRawGame[],
  trace: WidgetSourceTrace,
) => Promise<T | { skipped: "initial_broadcast_overrun" }> {
  let opened = false;
  // 즉시 probe — 이미 settle됐으면 sleep 타이머 없이 통과(race 배열 순서상
  // settled promise의 콜백이 먼저 큐잉되어 결정적).
  const probe = () =>
    Promise.race([
      opts.initialBroadcastDone.then(() => true),
      Promise.resolve().then(() => false),
    ]);
  return async (games, trace) => {
    if (!opened) {
      opened = await probe();
      if (!opened) {
        const remainingMs = opts.deadlineAtMs - opts.now();
        if (remainingMs <= 0) return { skipped: "initial_broadcast_overrun" };
        opened = await Promise.race([
          opts.initialBroadcastDone.then(() => true),
          opts.sleep(remainingMs).then(() => false),
        ]);
      }
    }
    if (!opened || opts.now() >= opts.deadlineAtMs) {
      return { skipped: "initial_broadcast_overrun" };
    }
    return opts.runTick(games, trace);
  };
}

// ── route 조립 (삼순 R2 blocker② — 실배선 회귀 대상) ──
// warmup route의 LA 경로 전체(친리티컬 패스 + 게이트 + fanout 큐 + fast loop)를 이
// 함수 하나가 조립한다. route.ts는 실제 구현체를, qa:la-fastpath는 fake clock/지연
// 구현체를 주입해 *동일 조립 코드*를 통과시킨다 — R1처럼 테스트가 gate에 임의 promise를
// 주입해 route 배선 결손을 못 잡는 문제를 제거.

export interface LaOrchestrationDeps extends Omit<LiveFastPathDeps, "enqueueLaFanout"> {
  sleep(ms: number): Promise<void>;
  /** 서브틱용 KBO 재조회(실패 = ok:false, 다음 틱 재시도). */
  fetchLiveGames(): Promise<{ ok: boolean; games: KboRawGame[]; trace?: WidgetSourceTrace }>;
  /** start 윈도우 경기 채널 생성(멱등). */
  ensureChannels(games: KboRawGame[]): Promise<unknown>;
  /** 잠금화면 LA 자동 시작(p2s) — cycle0 느린 fanout 전용(서브틱 미실행). */
  pushStarts(games: KboRawGame[]): Promise<unknown>;
  /** 틱 결과 관측 콜백(route 계측 로그용) — 실패해도 틱에 영향 없음. */
  onTickResult?(tick: LiveFastPathTickResult): void;
}

export interface LaCycle0Result {
  lastPlayByGame: Map<string, string>;
  laChannels: unknown;
  laBroadcast: unknown;
}

export interface LaOrchestration {
  /** 친리티컬 패스(relay→ensure→스냅샷→broadcast) 결과 — route 응답용. */
  criticalPromise: Promise<LaCycle0Result>;
  /** 게이트된 서브틱 fast loop 실행(라이브 0이면 즉시 []). */
  runFastLoop(): Promise<FastLoopTick[]>;
  /** 느린 fanout 큐(cycle0 레거시/start/iOS 위젯 + 서브틱 fanout) 완료 대기·결과 회수. */
  drainFanout(): Promise<{ label: string; result: unknown }[]>;
}

export function startLaOrchestration(
  deps: LaOrchestrationDeps,
  opts: {
    requestStartMs: number;
    deadlineAtMs: number;
    /** 초기 KBO fetch 성공 여부 — 실패 시 빈 baseline(첫 성공 서브틱이 복구). */
    initialFetchOk: boolean;
    games: KboRawGame[];
    liveGameIds: string[];
  },
): LaOrchestration {
  const guard = async (run: () => Promise<unknown>): Promise<unknown> => {
    try {
      return await run();
    } catch (e) {
      return { error: (e as Error).message };
    }
  };
  const state = seedLiveFastPathState(opts.initialFetchOk ? opts.games : []);
  const queue = createLaFanoutQueue();

  // 친리티컬 패스 — 초기 KBO fetch 직후 독립 실행(느린 본체 알림/집계와 무관).
  const critical = (async () => {
    const lastPlayByGame = await deps
      .fetchRelayLines(opts.liveGameIds)
      .catch(() => new Map<string, string>());
    const laChannels = await guard(() => deps.ensureChannels(opts.games));
    // 레거시용 직전-상태 스냅샷 — 반드시 broadcast *전*(ensure 후)에 떬다.
    let legacySnapshot = new Map<string, LegacyLastState>();
    try {
      legacySnapshot = await deps.snapshotLegacyState(opts.liveGameIds);
    } catch {
      // 빈 스냅샷 = 레거시 p10 쪽 안전 fallback(runLiveFastPathTick 주석).
    }
    const laBroadcast = await guard(() => deps.pushBroadcast(opts.games, lastPlayByGame));
    return { lastPlayByGame, laChannels, legacySnapshot, laBroadcast };
  })();
  const initialBroadcastDone: Promise<void> = critical.then(
    () => undefined,
    () => undefined,
  );

  // cycle0 느린 fanout — 큐 선두(서브틱 fanout보다 먼저 직렬 실행, 본체 순서 유지:
  // 레거시 → start → iOS 위젯). 게이트는 이 fanout을 기다리지 않는다.
  queue.enqueue("cycle0", async () => {
    const { lastPlayByGame, legacySnapshot } = await critical;
    const legacyLa = await guard(() =>
      deps.pushLegacyLa(opts.games, lastPlayByGame, legacySnapshot),
    );
    const liveActivityStart = await guard(() => deps.pushStarts(opts.games));
    const iosWidget = await guard(() => deps.pushIosWidget(opts.games, lastPlayByGame));
    return { legacyLa, liveActivityStart, iosWidget };
  });

  const tickDeps: LiveFastPathDeps = {
    now: deps.now,
    fetchRelayLines: deps.fetchRelayLines,
    pushAndroid: deps.pushAndroid,
    snapshotLegacyState: deps.snapshotLegacyState,
    enqueueLaFanout: (label, run) => queue.enqueue(label, run),
    pushLegacyLa: deps.pushLegacyLa,
    pushBroadcast: deps.pushBroadcast,
    pushBroadcastCatchup: deps.pushBroadcastCatchup,
    pushIosWidget: deps.pushIosWidget,
    fetchGameEvents: deps.fetchGameEvents,
    notifyScore: deps.notifyScore,
  };
  const gatedTick = gateFastPathOnInitialBroadcast({
    initialBroadcastDone,
    deadlineAtMs: opts.deadlineAtMs,
    now: deps.now,
    sleep: deps.sleep,
    runTick: async (gs, tr) => {
      const tick = await runLiveFastPathTick(tickDeps, state, gs, tr);
      try {
        deps.onTickResult?.(tick);
      } catch {
        // 계측 콜백 실패는 틱에 무영향.
      }
      return tick;
    },
  });

  // 초기 fetch 실패(재시도 필요) 또는 라이브 있음 → 서브틱 루프 가동.
  const shouldRetryFast = !opts.initialFetchOk || opts.liveGameIds.length > 0;

  return {
    criticalPromise: critical.then(({ lastPlayByGame, laChannels, laBroadcast }) => ({
      lastPlayByGame,
      laChannels,
      laBroadcast,
    })),
    runFastLoop: () =>
      shouldRetryFast
        ? runWidgetFastLoop(
            {
              now: deps.now,
              sleep: deps.sleep,
              fetchLiveGames: deps.fetchLiveGames,
              pushWidgets: gatedTick,
            },
            { requestStartMs: opts.requestStartMs },
          )
        : Promise.resolve([]),
    drainFanout: () => queue.drain(),
  };
}
