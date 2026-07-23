import type { KboRawGame } from "@/types/api";
import type { GameEvent } from "@/types/game-events";
import type { WidgetSourceTrace } from "@/lib/notifications/widget-fast-loop";

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
// ── 레거시 per-토큰 LA를 서브틱에 포함하는 이유 (순서 불변식) ──
// 레거시 발송 판정은 채널 행의 "직전 틱" last_state_hash를 읽고, broadcast가 그 hash를
// 전진시킨다(본체와 동일하게 레거시 → broadcast 순서 필수). broadcast만 서브틱에서 돌리면
// 다음 분 레거시가 이미 전진된 hash를 보고 영구 skip → 구빌드(11~15) 카드가 얼어붙는다.

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

/** 주입 의존성 — QA 스모크가 network/supabase/APNs/FCM 없이 게이트·순서를 검증. */
export interface LiveFastPathDeps {
  now(): number;
  /** 라이브 경기 문자중계 최근 한 줄(실패 격리 — 오류 시 빈 Map). */
  fetchRelayLines(liveGameIds: string[]): Promise<Map<string, string>>;
  pushAndroid(games: KboRawGame[], trace: WidgetSourceTrace): Promise<unknown>;
  pushLegacyLa(games: KboRawGame[], lastPlayByGame: Map<string, string>): Promise<unknown>;
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
      legacyLa: unknown;
      laBroadcast: unknown;
      iosWidget: unknown;
      score: unknown;
      /** KBO 응답 검증 완료(diff 감지 재료 확보) → 전 발송 완료까지 ms — 배포 후 효과 실측용. */
      detectToSendMs: number;
    };

/**
 * 서브틱 1회 실행. diff 없으면 DB/APNs/FCM 어디에도 접근하지 않고 즉시 반환.
 * 변화 시: relay 한 줄 수집 → [안드 위젯 ∥ (레거시 LA → broadcast → iOS 위젯) ∥ 득점] 발사.
 * 실패는 경로별로 격리(한 경로 오류가 다른 경로를 막지 않음 — warmup 본체와 동일 패턴).
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

  const [android, laSeq, score] = await Promise.all([
    guard(() => deps.pushAndroid(games, trace)),
    (async () => {
      // 순서 불변식: 레거시 per-토큰이 채널 행의 직전 hash를 읽은 *뒤에* broadcast가
      // 그 hash를 전진시킨다(본체와 동일). iOS 위젯은 자체 CAS 커서라 순서 무관하지만
      // 본체 순서를 그대로 따른다.
      const legacyLa = await guard(() => deps.pushLegacyLa(games, lastPlayByGame));
      const laBroadcast = await guard(() => deps.pushBroadcast(games, lastPlayByGame));
      const iosWidget = await guard(() => deps.pushIosWidget(games, lastPlayByGame));
      return { legacyLa, laBroadcast, iosWidget };
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
    legacyLa: laSeq.legacyLa,
    laBroadcast: laSeq.laBroadcast,
    iosWidget: laSeq.iosWidget,
    score,
    detectToSendMs: Math.max(0, deps.now() - trace.fetchedAtMs),
  };
}

/**
 * 서브틱 발송 게이트 — *LA 발송 축*의 완료만 기다린다(삼순 R1 blocker①).
 *
 * 기존(NO-GO): 서브틱이 warmup 본체 전체(game-events self-fetch/시작·순위·득점·요약·활약
 * 알림 등)를 기다려, 본체가 52s deadline을 넘기면(운영 60s 504 재현) 서브틱 0회 실행.
 * 수정: route가 LA 축(중계 한 줄 → 채널 ensure → 레거시 → broadcast → start → iOS 위젯)을
 * 초기 KBO fetch 직후 독립 실행하고, 서브틱은 그 축의 완료 promise만 기다린다. 느린 본체
 * (알림/집계)는 LA 상태를 건드리지 않으므로 stale-overwrite 방지는 LA 축 직렬화로 충분.
 * 대기는 deadline까지 유계 — LA 축 자체가 deadline을 넘기면 la_axis_overrun으로 발송 금지
 * (그 분은 다음 cron이 커버). 게이트가 한 번 열리면 이후 틱은 즉시 통과.
 */
export function gateFastPathOnLaAxis<T>(opts: {
  laAxisDone: Promise<void>;
  deadlineAtMs: number;
  now(): number;
  sleep(ms: number): Promise<void>;
  runTick(games: KboRawGame[], trace: WidgetSourceTrace): Promise<T>;
}): (games: KboRawGame[], trace: WidgetSourceTrace) => Promise<T | { skipped: "la_axis_overrun" }> {
  let opened = false;
  // 즉시 probe — laAxisDone이 이미 settle됐으면 sleep 타이머 없이 통과(race 배열 순서상
  // settled promise의 콜백이 먼저 큐잉되어 결정적).
  const probe = () =>
    Promise.race([opts.laAxisDone.then(() => true), Promise.resolve().then(() => false)]);
  return async (games, trace) => {
    if (!opened) {
      opened = await probe();
      if (!opened) {
        const remainingMs = opts.deadlineAtMs - opts.now();
        if (remainingMs <= 0) return { skipped: "la_axis_overrun" };
        opened = await Promise.race([
          opts.laAxisDone.then(() => true),
          opts.sleep(remainingMs).then(() => false),
        ]);
      }
    }
    if (!opened || opts.now() >= opts.deadlineAtMs) return { skipped: "la_axis_overrun" };
    return opts.runTick(games, trace);
  };
}
