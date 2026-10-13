// AI 경기 요약 — 생성 실패 durable 관측 분류 (2026-08-29 인시던트, 삼순 NO-GO ①축 반영).
//
// 두 가지를 분리한다:
//  1) 실패 관측: 꼬리 원인 후보였던 *초기 canonical 실패*(final 인데 소스 미수렴·boxscore
//     불가)까지 포함해 durable 기록한다. 단 not-final(라이브 중 정상 fail-close)과
//     invalid-gameid(호출자 오류)는 기록하지 않는다 — 지연 경기에서 유저 POST 마다 쌓여
//     노이즈가 되고, 그 구간은 frames 로 소급 관측 가능하다.
//  2) 경보 분리: claim-contention/save-superseded 는 동시요청의 *정상* 신호다(single-flight
//     lease 설계의 의도된 backoff). 실패축과 같은 api_name 으로 합치면 유저 몰림만으로
//     임계치(3회/30분)를 넘겨 오경보가 난다 → 별도 api_name + 사실상 비경보 임계치로 기록만.
//
// 순수 모듈(.ts): 라우트와 게이트가 같은 분류 함수를 태운다(production seam 공유).

export type GenerationFailureStage =
  // --- 초기 canonical 실패 (POST 진입 직후, 생성 착수 전) ---
  | "canonical-unavailable"
  | "canonical-not-settled"
  | "canonical-boxscore-unavailable"
  // --- 생성/검증/저장 실패 ---
  | "gemini-api"
  | "gemini-empty"
  | "gemini-parse"
  | "score-mismatch"
  | "winner-mismatch"
  | "consistency-violation"
  | "canonical-race"
  | "save-failed"
  | "generation-exception"
  // --- 백필 재시도 상한 소진 (자동복구 실패 = 즉시 경보) ---
  | "backfill-exhausted"
  // --- 정상 동시요청 신호 (기록만, 비경보) ---
  | "claim-contention"
  | "save-superseded";

/** 실패축 — 반복되면 실제 장애라 경보 대상. */
export const GENERATION_ALERT_API = "game-summary-generation";
/** 동시요청축 — single-flight 설계의 정상 신호라 기록 전용(사실상 비경보 임계치). */
export const GENERATION_CONTENTION_API = "game-summary-contention";

export const BENIGN_CONTENTION_STAGES: ReadonlySet<GenerationFailureStage> = new Set([
  "claim-contention",
  "save-superseded",
]);

export interface GenerationFailureClassification {
  apiName: string;
  reason: "http-error" | "schema-error";
  policy: { windowMinutes: number; threshold: number; cooldownMinutes: number; leaseSeconds: number };
}

export function classifyGenerationFailure(stage: GenerationFailureStage): GenerationFailureClassification {
  if (BENIGN_CONTENTION_STAGES.has(stage)) {
    return {
      apiName: GENERATION_CONTENTION_API,
      reason: "schema-error",
      // 기록 전용: 임계치를 높게 잡아 정상 유저 몰림으로는 경보가 나지 않게 한다.
      // (선행 생성이 계속 실패해 contention 이 병리적으로 반복되는 경우는 실패축
      //  경보(위 GENERATION_ALERT_API)가 원인 stage 로 먼저 울린다.)
      policy: { windowMinutes: 30, threshold: 200, cooldownMinutes: 120, leaseSeconds: 120 },
    };
  }
  if (stage === "backfill-exhausted") {
    // 재시도 상한(10회/~70분) 소진 = 자동복구가 실패한 사건 — 단건이라도 즉시 경보.
    return {
      apiName: GENERATION_ALERT_API,
      reason: "schema-error",
      policy: { windowMinutes: 30, threshold: 1, cooldownMinutes: 60, leaseSeconds: 120 },
    };
  }
  return {
    apiName: GENERATION_ALERT_API,
    reason: stage === "gemini-api" ? "http-error" : "schema-error",
    // 보수적 경보(30분 3회): 일시 플레이크 단건은 기록만 남고, 반복 실패에만 울린다.
    policy: { windowMinutes: 30, threshold: 3, cooldownMinutes: 60, leaseSeconds: 120 },
  };
}

/**
 * POST 진입 canonical 실패 중 durable 기록 대상.
 * not-final = 라이브 중 정상 fail-close(기록 시 지연 경기에서 유저 POST 마다 쌓임) → 제외.
 * invalid-gameid = 호출자 입력 오류 → 제외.
 */
export function canonicalFailureStage(reason: string): GenerationFailureStage | null {
  switch (reason) {
    case "canonical-unavailable":
      return "canonical-unavailable";
    case "canonical-not-settled":
      return "canonical-not-settled";
    case "canonical-boxscore-unavailable":
      return "canonical-boxscore-unavailable";
    default:
      return null;
  }
}
