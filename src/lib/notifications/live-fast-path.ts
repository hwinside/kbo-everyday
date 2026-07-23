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
// ── broadcast 친리티컬 패스 vs 느린 fanout 분리 (삼순 R2 blocker① → R3 blocker①) ──
// 서브틱 gate가 열려면 되는 조건은 *초기 broadcast 발송 완료*뿐이다. 레거시 per-토큰
// fanout·push-to-start·iOS 위젯 FCM은 대상 유저 수에 비례하는 느린 tail이라, 이들을
// gate에 묶으면 tail>52s에서 서브틱이 0회가 된다(R1 구조의 재발). 나아가 R3에서:
// Android 위젯 FCM·득점 푸시(self-fetch→FCM)도 유저 수/원천 지연에 비례하는 tail이라,
// 서브틱 자체(Promise.all)에 묶으면 +15s 틱의 tail이 +30/+45s broadcast를 굶긴다
// (삼순 R3 blocker① — 독립 재현됨). 따라서 축을 완전 분리한다:
//  - broadcast 축(서브틱이 유일하게 await): relay 한 줄 → 스냅샷 → broadcast.
//    stale-overwrite 방지는 *이 축만의* 직렬 순서(cycle0 broadcast → gate → 서브틱
//    broadcast 직렬 await)로만 보장한다.
//  - la fanout 축(레거시/start/iOS 위젯): 직렬 큐 enqueue만 — per-토큰 발송도 틱
//    순서대로 나간다(레거시 카드 stale-overwrite 방지).
//  - android 축: 직렬 큐 enqueue만 — in-memory canonical 시그니처 dedupe가 순서
//    의존이라 자체 축 안에서 직렬(틱 순서) 유지.
//  - score 축: 직렬 큐 enqueue만 — notified_score_events PK claim이 멱등이라 순서
//    무관하지만, 같은 틱의 fetch→notify 쌍은 축 안에서 직렬로 유지.
// 축끼리는 서로 독립 — 어느 축의 영구 미완료도 다른 축(특히 다음 서브틱 broadcast)을
// 막지 않는다. 미완료 축 잔여분은 route의 deadline-유계 drain(아래) + 다음 분 cron의
// 멱등 재발송(DB 선점/CAS/hash dedupe)이 수습한다.
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
 * route가 fanout 큐 drain에 쓸 수 있는 최대 시각(요청 진입 기준 ms) — maxDuration(75s)
 * 이전에 반드시 명시적 partial 응답으로 종료해 504가 구조적으로 불가능하게 한다(삼순 R3
 * blocker③). 마지막 서브틱(+45s)의 broadcast 축 tail(relay 10s cap + APNs 자체 timeout)
 * 이후에도 여유가 있도록 68s로 두고, 응답 직렬화 마진 7s를 남긴다. deadline에 걸려
 * 미완료로 남은 fanout은 다음 분 cron이 멱등 재발송(DB 선점/CAS/hash dedupe)으로 수습.
 */
export const LA_FANOUT_DRAIN_DEADLINE_MS = 68_000;

/**
 * broadcast 축(친리티컬 패스) 자체의 요청-절대 deadline(ms) — 삼순 R4 blocker②.
 * pushLiveActivityChannelBroadcasts는 채널별 APNs http2 8s timeout을 직렬 await하므로
 * 5경기×2 env 전부 timeout이면 80s — maxDuration(75s) 504가 구조적으로 가능했다.
 * route가 이 절대 deadline을 broadcast/catch-up/ensure 호출에 주입하면, pass는 매 행
 * 처리 전 검사해 초과 시 새 발송을 시작하지 않고 명시 종료한다(마지막으로 시작된 send
 * 1건만 최대 8s 초과 가능 → 상한 60+8=68s = drain deadline, 응답 마진 7s). 미발송
 * 라이브 경기는 failedGameIds로 보고돼 이 모듈이 catch-up pending으로 재-arm한다.
 */
export const LA_BROADCAST_DEADLINE_MS = 60_000;

/** 느린 fanout 실행 축 — 축 안에서는 직렬(틱 순서), 축끼리는 완전 독립. */
export type LaFanoutAxis = "la" | "android" | "score";

export interface LaFanoutDrainResult {
  /** deadline 안에 완료된 항목 결과(enqueue 순서). */
  results: { label: string; result: unknown }[];
  /** deadline 도달로 미완료 항목을 남기고 잘렸는지. */
  timedOut: boolean;
  /** drain 종료 시점의 미완료 항목 수. */
  pendingCount: number;
}

/**
 * 느린 LA fanout 직렬 큐 (삼순 R2 blocker①) — 레거시 per-토큰/start/iOS 위젯 등
 * 유저 수 비례 tail을 broadcast 친리티컬 패스 밖으로 빼되, enqueue 순서대로 직렬 실행해
 * 틱 N의 per-토큰 발송이 틱 N+1과 얽히지 않게 한다. 오류는 항목별 격리(큐 지속).
 */
export interface LaFanoutQueue {
  enqueue(label: string, run: () => Promise<unknown>): void;
  /**
   * enqueue된 항목 완료까지 대기 후 결과 반환(route 응답/관제용). deadline 지정 시
   * *유계 대기* — deadline 도달이면 완료분만 partial로 반환하고 timedOut을 표시한다
   * (삼순 R3 blocker③: 무제한 drain → 75s 504 차단). 미지정이면 완료까지 대기(QA용).
   */
  drain(opts?: {
    deadlineAtMs: number;
    now(): number;
    sleep(ms: number): Promise<void>;
  }): Promise<LaFanoutDrainResult>;
}

export function createLaFanoutQueue(): LaFanoutQueue {
  const results: { label: string; result: unknown }[] = [];
  let pending = 0;
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue(label, run) {
      pending += 1;
      tail = tail.then(async () => {
        try {
          results.push({ label, result: await run() });
        } catch (e) {
          results.push({ label, result: { error: (e as Error).message } });
        } finally {
          pending -= 1;
        }
      });
    },
    async drain(opts) {
      // drain 중 새 enqueue(마지막 서브틱의 fanout 등)도 수용해야 하므로 tail을 루프마다
      // 다시 잡는다. deadline이 있으면 각 대기를 남은 예산으로 race — 초과 시 partial 반환.
      while (pending > 0) {
        const t = tail;
        if (!opts) {
          await t;
          continue;
        }
        const remainingMs = opts.deadlineAtMs - opts.now();
        if (remainingMs <= 0) {
          return { results: [...results], timedOut: true, pendingCount: pending };
        }
        await Promise.race([t, opts.sleep(remainingMs)]);
        if (pending > 0 && opts.now() >= opts.deadlineAtMs) {
          return { results: [...results], timedOut: true, pendingCount: pending };
        }
      }
      return { results: [...results], timedOut: false, pendingCount: 0 };
    },
  };
}

/**
 * broadcast 결과에서 개별 실패 경기 추출(삼순 R3 blocker②) —
 * pushLiveActivityChannelBroadcasts가 채워주는 failedGameIds(transient APNs 실패)만
 * 인정. 형태가 다르면 빈 배열(top-level error는 호출측이 별도 처리).
 */
function extractFailedGameIds(result: unknown): string[] {
  if (result === null || typeof result !== "object") return [];
  const ids = (result as { failedGameIds?: unknown }).failedGameIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter((v): v is string => typeof v === "string");
}

/** 주입 의존성 — QA 스모크가 network/supabase/APNs/FCM 없이 게이트·순서를 검증. */
export interface LiveFastPathDeps {
  now(): number;
  /** 라이브 경기 문자중계 최근 한 줄(실패 격리 — 오류 시 빈 Map). */
  fetchRelayLines(liveGameIds: string[]): Promise<Map<string, string>>;
  pushAndroid(games: KboRawGame[], trace: WidgetSourceTrace): Promise<unknown>;
  /** broadcast 직전 채널 상태 스냅샷 — 레거시 판정 주입용(실패 시 빈 Map = 전 경기 p10 쪽 안전). */
  snapshotLegacyState(liveGameIds: string[]): Promise<Map<string, LegacyLastState>>;
  /**
   * 느린 fanout enqueue — 서브틱은 어느 축의 완료도 기다리지 않는다(삼순 R3 blocker①).
   * 축(axis)별 독립 큐 — la(레거시/start/iOS 위젯)·android·score가 서로를 막지 않고,
   * 각 축 안에서만 틱 순서 직렬(위 LaFanoutQueue 주석).
   */
  enqueueFanout(axis: LaFanoutAxis, label: string, run: () => Promise<unknown>): void;
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
  | { skipped: "no_diff"; catchup?: { gameIds: string[]; result: unknown; rearmedGameIds: string[] } }
  | {
      changedGameIds: string[];
      scoreChangedLiveGameIds: string[];
      /** 안드 위젯은 android 축 큐에 넘겼음(삼순 R3①) — 결과는 route가 drain에서 회수. */
      android: "queued";
      laBroadcast: unknown;
      /** 느린 fanout(레거시/iOS 위젯)은 la 축 큐에 넘겼음 — 결과는 route가 drain에서 회수. */
      laFanout: "queued";
      /** 득점 푸시(fetch→notify)는 score 축 큐에 넘겼음(점수축 변화 없으면 skipped). */
      score: "queued" | { skipped: "no_score_diff" };
      /** 개별 APNs 실패로 catch-up pending에 재-arm된 경기(삼순 R3② — 관제용). */
      broadcastFailedGameIds: string[];
      /** KBO 응답 검증 완료(diff 감지 재료 확보) → broadcast 축(친리티컬) 완료까지 ms. */
      detectToSendMs: number;
    };

/**
 * 서브틱 1회 실행. diff 없으면 DB/APNs/FCM 어디에도 접근하지 않고 즉시 반환.
 * 변화 시: relay 한 줄 → 스냅샷 → broadcast(친리티컬 — 유일한 await 대상). 안드 위젯·득점
 * 푸시·느린 LA fanout(레거시→iOS 위젯)은 각자의 축 큐에 enqueue만 하고 틱은 끝난다
 * (삼순 R3 blocker① — +15s 틱의 안드/득점 tail이 +30/+45s broadcast를 못 막게).
 * 실패는 경로별 격리(warmup 본체와 동일 패턴).
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
    // 재-arm 판정(삼순 R2③ + R3②, 틈당 1회 유계 불변):
    //  - 호출 자체 실패(top-level error/예외) → pending 전체 재-arm.
    //  - 호출은 성공했지만 개별 경기 APNs transient 실패(failedGameIds) → *실패 경기만*
    //    재-arm(성공 경기는 clear 유지). 이게 없으면 APNs 5xx/timeout 시 updates=0이어도
    //    pending이 비워져 2분 heartbeat까지 stale로 남는다.
    let rearmedGameIds: string[];
    if (result !== null && typeof result === "object" && "error" in result) {
      rearmedGameIds = pending;
    } else {
      const failed = new Set(extractFailedGameIds(result));
      rearmedGameIds = pending.filter((id) => failed.has(id));
    }
    for (const id of rearmedGameIds) state.catchupGameIds.add(id);
    return { skipped: "no_diff", catchup: { gameIds: pending, result, rearmedGameIds } };
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

  const tickLabel = `tick:${diff.changedGameIds.join(",")}`;

  // 안드 축 — enqueue만(삼순 R3 blocker①: 안드 FCM tail이 다음 서브틱 broadcast를 못 막게).
  // in-memory canonical dedupe는 순서 의존 → android 축 큐의 직렬이 틱 순서를 보장.
  deps.enqueueFanout("android", tickLabel, () => guard(() => deps.pushAndroid(games, trace)));

  // 득점 축 — 점수축 변화 시에만 enqueue. 발송 dedupe는 notified_score_events PK claim이
  // 보장(어느 틱/인스턴스가 겹쳌도 정확히 1회) — 축 분리로 변하지 않는 불변식.
  const score: "queued" | { skipped: "no_score_diff" } =
    diff.scoreChangedLiveGameIds.length === 0 ? { skipped: "no_score_diff" } : "queued";
  if (score === "queued") {
    const scoreChanged = diff.scoreChangedLiveGameIds;
    deps.enqueueFanout("score", tickLabel, async () => {
      const eventsByGame = await guard(() => deps.fetchGameEvents(scoreChanged));
      if (!(eventsByGame instanceof Map)) return eventsByGame; // fetch 오류 — 다음 분 cron이 커버
      return guard(() => deps.notifyScore(games, eventsByGame));
    });
  }

  // broadcast 축(친리티컬 — 이 틱이 유일하게 await하는 발송 경로): 스냅샷을 broadcast
  // *전*에 떠 레거시에 주입하면 레거시를 broadcast 뒤 큐로 보내도 직전-틱 판정이
  // 유지된다(hash 순서 불변식의 스냅샷 대체). 스냅샷 실패 시 빈 Map — 레거시가 전
  // 경기를 미수신 취급(p10 1회 과발송)하는 쪽이 영구 skip 프리즈보다 안전하다.
  let legacySnapshot = new Map<string, LegacyLastState>();
  try {
    legacySnapshot = await deps.snapshotLegacyState(liveGameIds);
  } catch {
    // 빈 스냅샷 fallback — 위 주석.
  }
  const laBroadcast = await guard(() => deps.pushBroadcast(games, lastPlayByGame));
  // 개별 APNs transient 실패 경기 재-arm(삼순 R3 blocker②) — 변화 경기는 이미 위에서
  // arm됐지만, heartbeat 등 비변화 경기의 실패도 다음 무변화 틱 p10으로 수습(라이브
  // 경기 수로 유계 — Set 멱등).
  const broadcastFailedGameIds = extractFailedGameIds(laBroadcast).filter((id) =>
    liveGameIds.includes(id),
  );
  for (const id of broadcastFailedGameIds) state.catchupGameIds.add(id);
  // 느린 LA fanout — la 축 큐 직렬(틱 순서 보장)만 하고 이 틱은 완료를 기다리지 않는다 —
  // fanout>52s여도 다음 서브틱 broadcast가 굶지 않음(R2 blocker①). iOS 위젯은 자체
  // CAS 커서라 순서 무관하지만 본체 순서(레거시→iOS)를 따른다.
  deps.enqueueFanout("la", tickLabel, async () => {
    const legacyLa = await guard(() => deps.pushLegacyLa(games, lastPlayByGame, legacySnapshot));
    const iosWidget = await guard(() => deps.pushIosWidget(games, lastPlayByGame));
    return { legacyLa, iosWidget };
  });

  return {
    changedGameIds: diff.changedGameIds,
    scoreChangedLiveGameIds: diff.scoreChangedLiveGameIds,
    android: "queued",
    laBroadcast,
    laFanout: "queued",
    score,
    broadcastFailedGameIds,
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

export interface LaOrchestrationDeps extends Omit<LiveFastPathDeps, "enqueueFanout"> {
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
  /**
   * 느린 fanout 축 3개(la: cycle0 레거시/start/iOS 위젯 + 서브틱 레거시/iOS, android,
   * score) 완료 대기·결과 회수. deadline 지정 시 *유계 대기* — 남은 예산 안에서만
   * 대기하고 초과 시 partial(timedOut=true)로 즉시 반환해 route가 504 전에 명시적으로
   * 종료하게 한다(삼순 R3 blocker③). 미지정(QA)이면 전체 완료까지 대기.
   *
   * ⚠️ route-순서 계약(삼순 R4 blocker①): route는 drain을 fast loop와 *동시에* 시작한다.
   * 그래서 drain은 먼저 fast loop의 enqueue 종료(seal — runFastLoop settle)를 기다린 뒤
   * pending을 검사한다. seal 이전에 pending이 순간 0이어도 종료하지 않으므로, +15/+30/
   * +45스 틱이 뒤늦게 enqueue한 tail을 놓치고 laFanoutPending=0으로 오기록하는 race가
   * 없다. seal 자체도 공동 deadline 안에서만 대기(초과 시 partial·timedOut).
   */
  drainFanout(opts?: {
    deadlineAtMs: number;
    now(): number;
    sleep(ms: number): Promise<void>;
  }): Promise<LaFanoutDrainResult>;
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
  // 축(axis)별 독립 큐 — la·android·score가 서로를 막지 않게(삼순 R3 blocker①). 각 축
  // 안에서만 틱 순서 직렬(레거시 카드/안드 canonical dedupe 순서 보장).
  const queues: Record<LaFanoutAxis, LaFanoutQueue> = {
    la: createLaFanoutQueue(),
    android: createLaFanoutQueue(),
    score: createLaFanoutQueue(),
  };

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

  // cycle0 느린 fanout — la 축 큐 선두(서브틱 la fanout보다 먼저 직렬 실행, 본체
  // 순서 유지: 레거시 → start → iOS 위젯). 게이트는 이 fanout을 기다리지 않는다.
  queues.la.enqueue("cycle0", async () => {
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
    enqueueFanout: (axis, label, run) => queues[axis].enqueue(label, run),
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

  // fanout enqueue 종료(seal) — fast loop가 settle하면 더 이상 어느 축에도 새 항목이
  // 들어오지 않는다(enqueue 원천 = cycle0 1회 + 서브틱들). drain은 이 seal을 먼저
  // 기다려야 "이미 끝난 drain이 뒤늦은 틱 tail을 누락"하는 race가 없다(삼순 R4 ①).
  // ⚠️ route는 반드시 runFastLoop를 호출한다(라이브 0이어도 즉시 [] → 즉시 seal).
  let fanoutSealed = false;
  let sealFanout!: () => void;
  const fanoutSealedPromise = new Promise<void>((resolve) => {
    sealFanout = () => {
      fanoutSealed = true;
      resolve();
    };
  });

  return {
    criticalPromise: critical.then(({ lastPlayByGame, laChannels, laBroadcast }) => ({
      lastPlayByGame,
      laChannels,
      laBroadcast,
    })),
    runFastLoop: () => {
      const loop = shouldRetryFast
        ? runWidgetFastLoop(
            {
              now: deps.now,
              sleep: deps.sleep,
              fetchLiveGames: deps.fetchLiveGames,
              pushWidgets: gatedTick,
            },
            { requestStartMs: opts.requestStartMs },
          )
        : Promise.resolve([] as FastLoopTick[]);
      // 성공/실패 무관 settle = enqueue 종료(반환 promise의 reject는 그대로 전파).
      void loop.then(sealFanout, sealFanout);
      return loop;
    },
    drainFanout: async (drainOpts) => {
      // ① seal 대기 — fast loop의 enqueue가 끝나기 전에는 pending 순간-0을 완료로 보지
      // 않는다(route가 drain을 fast loop와 동시 시작하는 실순서 재현 — 삼순 R4 ①).
      // 이미 seal끬이면 아무것도 대기하지 않는다(fake-clock QA에서 sleep 부작용 방지).
      if (!fanoutSealed) {
        if (drainOpts) {
          const remainingMs = drainOpts.deadlineAtMs - drainOpts.now();
          if (remainingMs > 0) {
            await Promise.race([fanoutSealedPromise, drainOpts.sleep(remainingMs)]);
          }
        } else {
          await fanoutSealedPromise;
        }
      }
      // ② 축끼리를 병렬로 drain — 각자 남은 공동 deadline 예산 안에서 유계 대기.
      const drained = await Promise.all([
        queues.la.drain(drainOpts),
        queues.android.drain(drainOpts),
        queues.score.drain(drainOpts),
      ]);
      return {
        results: drained.flatMap((d) => d.results),
        // seal 전 deadline 도달(= fast loop가 아직 enqueue 중일 수 있음)도 partial로 표시.
        timedOut: drained.some((d) => d.timedOut) || !fanoutSealed,
        pendingCount: drained.reduce((n, d) => n + d.pendingCount, 0),
      };
    },
  };
}
