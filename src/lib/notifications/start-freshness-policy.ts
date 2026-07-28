// 시작 알림 신선도 가드 (2026-07-23 하린아빠 지시: "이미 늦은 시작알림은 발송 안되게 가드까지 넣어").
//
// 예정시각 +90분 윈도우(START_WINDOW_MS)만으로는 cron/파서 장애가 몇십 분 만에 복구될 때
// 이미 한창 진행 중인 경기에도 "⚾ 경기 시작!"이 뒷북으로 나간다(7/23 실사고에서 확인된 갭).
// 경기 진행도(이닝) 기반 가드를 추가한다: 1회초를 지난 경기는 이미 시작한 지 오래 → 발송 금지.
//
// 우천 등 지연 시작 경기는 실제 개시 시점에야 state=2·1회초로 관측되므로 정상 발송된다
// (예정시각 기준 윈도우와 달리 지연 시작을 오탐하지 않는다). 이닝 정보가 없는 개시 직후
// 순간은 신선한 것으로 보고 기존 시간 윈도우가 커버한다.
// scheduled→live 전환 연속 관측 허용 폭: warmup cron은 매분 돌므로 정상이면 마지막 "예정" 관측이
// 1~2분 전이다. 배포/일시 장애로 몇 틱 빠져도 정시성을 잃지 않는 범위로 5분까지 허용.
// 즉 **바로 직전 cron 틱의 "예정" 관측만 연속으로 인정**한다(60s + 실행 jitter 30s = 90s).
// 한 틱이라도 건너뛴 공백은 기본 mark-only. 단, 예정시각 +3분 안이고 아직 1회초 상단이면
// cron 공백 직접 복구 범위로 허용한다(2026-07-26 17:59:15→18:02:46 누락 재발 방지).
// (2026-07-23 삼순 #798 post-merge blocker: 5분 허용은 4분 cron/파서 장애 복구 뒷북을
// 통과시켜 "늦았으면 미발송/정시성" 계약 위반 → 90초로 축소)
// ⚠️ nowMs 계약 (2026-07-24 LG:한화 시작알림 억제 사고): 이 게이트는 "직전 틱 예정 관측 →
// 이번 틱 live 관측"의 연속성 판정이므로, nowMs에는 **이번 틱의 payload 관측(fetch) 시각**을
// 넣어야 한다. 경기별 처리 시점의 Date.now()를 넣으면 같은 틱 안에서 앞 경기 FCM 대량발송
// 지연(실측 ~26초)이 관측 간격에 합산돼, 관측상 76초 연속인 정상 케이스가 102초 stale로
// 오판돼 mark-only 억제된다.
export const SCHEDULED_SEEN_RECENT_MS = 90 * 1000;
/** 정규 scheduled tick이 끊겨도 예정시각 직후 1회초 상단이면 복구를 허용하는 상한. */
export const SCHEDULED_START_RECOVERY_MS = 3 * 60 * 1000;

// (2026-07-28 삼순 조건부 GO) KBO가 state=2(live)로 뒤늦게 넘기면 15초 watchdog이 첫 live를
// 관측한 순간 이미 1번 타자 타석이 끝나 completedPlateAppearances=1로 잡힌다. 이전 게이트는
// "completedPlateAppearances===0"을 발송 전제로 요구해 5경기 전원을 mark-only로 억제했다
// (2026-07-28 실사고). 발송 판정은 "최근 scheduled→live 연속 관측"과 "1회초 상단 AND 0:0"만으로
// 하고, currentBatter/BoxScore 유래 타석 근거는 발송 전제에서 내려 **뒷북 차단 보조**로만 둔다.
// 안전 가드(뒷북 차단): 득점 발생·2회 이상·1회말은 이미 경기가 진행된 것이라 계속 차단한다.

export type StartPlateAppearanceEvidence = {
  /** 원정 1번 타자의 완료 타석 수. authoritative source가 없으면 null. */
  completedPlateAppearances: number | null;
  /** 현재 타자가 원정 1번 타자인지. lineup/current batter 미상이면 null. */
  currentBatterIsLeadoff: boolean | null;
};

// 시작알림 발송 게이트 (2026-07-23 삼순 post-merge blocker 반영):
// "최근 scheduled→live 전환을 연속 관측한 경우만 발송, 첫 관측이 이미 live거나 stale이면 mark-only".
// - lastSeenScheduledAtMs === null: 이 경기를 "예정" 상태로 본 적이 없음 = 첫 관측이 이미 live
//   (장애 복구·재배포·기능 도입 직후) → 발송 금지.
// - 관측이 SCHEDULED_SEEN_RECENT_MS보다 오래됨: 예정시각 +3분·1회초 상단만 제한 복구.
// - 우천 등 지연 시작: cron이 실제 개시 직전까지 계속 "예정"을 관측하므로 정상 발송된다.
// - 이닝 가드(isStartNotificationFresh)는 이중 안전망으로 유지.
export function shouldSendStartNotification(params: {
  lastSeenScheduledAtMs: number | null;
  scheduledStartAtMs?: number | null;
  nowMs: number;
  inningNo: number | null | undefined;
  isTop: boolean | null | undefined;
  /** 경기 스코어 — 득점 발생 시 이미 진행된 경기로 보고 뒷북 차단. 미상이면 0으로 본다. */
  awayScore?: number | null;
  homeScore?: number | null;
  /** 뒷북 차단 보조 신호(선택). 발송 전제가 아니며, 없거나 지연돼도 발송을 막지 않는다. */
  plateAppearance?: StartPlateAppearanceEvidence | null;
}): boolean {
  if (params.lastSeenScheduledAtMs === null) return false;
  if (!isStartNotificationFresh({
    inningNo: params.inningNo,
    isTop: params.isTop,
    awayScore: params.awayScore,
    homeScore: params.homeScore,
    plateAppearance: params.plateAppearance,
  })) return false;
  if (params.nowMs - params.lastSeenScheduledAtMs <= SCHEDULED_SEEN_RECENT_MS) return true;
  if (params.scheduledStartAtMs == null) return false;
  const scheduledLagMs = params.nowMs - params.scheduledStartAtMs;
  return scheduledLagMs >= 0 && scheduledLagMs <= SCHEDULED_START_RECOVERY_MS;
}

// (2026-07-28 삼순 NO-GO 반영) 안전 가드를 `1회초 상단 AND 0:0`으로 strict하게 묶는다.
// 이닝·초말·점수가 미상/누락/blank/malformed면 발송으로 판정할 근거가 없으므로 모두
// fail-close(mark-only). 이전 구현은 미상 점수를 0으로 강등하고 이닝 null을 신선으로 봐서
// `판정 불가여도 발송`(fail-open)이라 승인 기준(1회초 AND 0:0)을 위반했다.
// 타석 근거는 발송 전제가 아니라 뒷북 차단 보조로만 쓴다: 근거 없음/지연/PA1은 허용하고,
// 근거가 있고 completedPlateAppearances>=2면 이미 진행된 것으로 보아 차단한다.
export function isStartNotificationFresh(params: {
  /** KBO GAME_INN_NO — 개시 직후 등 미제공이면 null. 1회여야만 신선. */
  inningNo: number | null | undefined;
  /** GAME_TB_SC === "T" 여부. true(1회초)여야만 신선. 미제공/1회말이면 차단. */
  isTop: boolean | null | undefined;
  /** 경기 스코어. known 0:0이어야만 신선. 미상/누락/malformed면 fail-close. */
  awayScore?: number | null;
  homeScore?: number | null;
  /** 뒷북 차단 보조 신호(선택). 발송 전제가 아니며, 없거나 지연돼도 발송을 막지 않는다. */
  plateAppearance?: StartPlateAppearanceEvidence | null;
}): boolean {
  // 1회초 상단 strict — 미상(null/undefined)·0·2회+·1회말은 모두 차단.
  if (params.inningNo !== 1) return false;
  if (params.isTop !== true) return false;
  // 0:0 strict — known numeric 0:0만 신선. null/blank/NaN 등은 fail-close.
  const away = params.awayScore;
  const home = params.homeScore;
  if (typeof away !== "number" || !Number.isFinite(away) || away !== 0) return false;
  if (typeof home !== "number" || !Number.isFinite(home) || home !== 0) return false;
  // 뒷북 차단 보조: 원정 1번 타자 완료 타석이 known으로 2 이상이면 이미 진행된 것 → 차단.
  // 근거 없음(null)·PA1(이번 사고 케이스)은 발송을 막지 않는다.
  const completedPA = params.plateAppearance?.completedPlateAppearances;
  if (typeof completedPA === "number" && Number.isFinite(completedPA) && completedPA >= 2) return false;
  return true;
}
