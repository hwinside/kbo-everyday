import type { KboRawGame } from "@/types/api";
import type { GameEvent } from "@/types/game-events";
import type { WidgetSourceTrace } from "@/lib/notifications/widget-fast-loop";

// 라이브 fast path 서브틱 오케스트레이션 — warmup cron 1회 호출 내부의 +15/+30/+45초
// 서브틱에서 잠금화면 LA(레거시 per-토큰 → broadcast)·위젯(안드/iOS)·득점 푸시를
// 재실행해 점수 변화→잠금화면 반영 지연을 평균 ~30초 → ~7초로 줄인다.
//
// ── DB 부하 근거 (2026-07-22 Supabase conn pool 고갈 장애 재발 방지) ──
// 서브틱은 KBO 스코어보드(무DB) 1회 fetch 후 *diff 없으면 어떤 DB 접근/APNs·FCM 발송도
// 하지 않는다(cheap early-exit). 즉 DB 접근 횟수는 "분당 4회"가 아니라 "경기 상태가 실제로
// 바뀐 틱 수"만큼만 늘어난다 — 어차피 다음 분 cron이 했을 작업을 앞당겨 실행하는 것이라
// 하루 총 DB 작업량은 카드축 diff(타석 단위) 감지 횟수 수준으로 유지된다.
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
}

/**
 * 초기 스냅샷으로 baseline 시그니처를 만든다. 본체(cycle 0)가 이 스냅샷의 발송을 이미
 * 담당하므로, 서브틱은 여기서 *달라진* 것만 처리한다. 초기 fetch 실패(ok:false) 시 빈
 * baseline → 첫 성공 서브틱이 전 경기를 "변화"로 보고 fast path를 1회 태워 그 분을 복구.
 */
export function seedLiveFastPathState(games: KboRawGame[]): LiveFastPathState {
  const state: LiveFastPathState = { cardSigByGame: new Map(), scoreSigByGame: new Map() };
  for (const g of games) {
    if (!g.G_ID) continue;
    state.cardSigByGame.set(g.G_ID, liveCardSignature(g));
    state.scoreSigByGame.set(g.G_ID, scoreAxisSignature(g));
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
  pushIosWidget(games: KboRawGame[], lastPlayByGame: Map<string, string>): Promise<unknown>;
  /** game-events self-fetch(이벤트 생성 diff 경로) — 점수축 변화 라이브 경기만. */
  fetchGameEvents(liveGameIds: string[]): Promise<Map<string, GameEvent[]>>;
  notifyScore(games: KboRawGame[], eventsByGame: Map<string, GameEvent[]>): Promise<unknown>;
}

export type LiveFastPathTickResult =
  | { skipped: "no_diff" }
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
  const diff = diffAndAdvance(state, games);
  if (diff.changedGameIds.length === 0) return { skipped: "no_diff" };

  const liveGameIds = games
    .filter((g) => g.G_ID && g.GAME_STATE_SC === "2")
    .map((g) => g.G_ID as string);

  let lastPlayByGame = new Map<string, string>();
  try {
    lastPlayByGame = await deps.fetchRelayLines(liveGameIds);
  } catch {
    // relay 실패 → 카드에 중계 한 줄만 안 뜸(본체와 동일 격리).
  }

  const guard = async (run: () => Promise<unknown>): Promise<unknown> => {
    try {
      return await run();
    } catch (e) {
      return { error: (e as Error).message };
    }
  };

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
