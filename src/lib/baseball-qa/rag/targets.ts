/**
 * S2b 얇은 수직 슬라이스 대상 선수 (16명).
 *
 * 선정 근거 — `genius_question_logs` 1,160건 전수 스캔에서 **실제 유저가 이름을 언급한 선수**만
 * 뽑았다. 즉 이 목록은 추정이 아니라 관측된 수요다. 로스터 878명 중 언급이 있던 선수는 19명이고,
 * 그중 아래 3건을 제외해 16명이 남았다:
 *   - 양현종: 로스터에 동명이인 2건(77637 KIA / 55370 키움) → 스펙 §12 동명이인 격리 계약에 따라
 *     이름 단독 연결 금지. 이번 슬라이스에서 제외한다.
 *   - 양현(61268): "양현종 선수가 야구협회장이야?" 질문의 부분문자열로만 잡힌 오탐이다.
 *   - 보스(56402): "보스만룰"(룰 질문)의 부분문자열 오탐이다.
 *
 * 문보경(69102)은 하린아빠 제보 케이스라 반드시 포함한다(2026-08-01 08:11 `blocked` 로그 실측).
 */

export interface RagTargetPlayer {
  kboId: string;
  name: string;
  team: string;
  /** 관측된 질문 언급 횟수 (genius_question_logs 전수 스캔 기준). */
  mentions: number;
}

export const S2B_TARGET_PLAYERS: RagTargetPlayer[] = [
  { kboId: "69102", name: "문보경", team: "LG", mentions: 1 },
  { kboId: "54640", name: "네일", team: "KIA", mentions: 3 },
  { kboId: "68050", name: "강백호", team: "한화", mentions: 2 },
  { kboId: "52001", name: "안현민", team: "KT", mentions: 1 },
  { kboId: "79240", name: "허경민", team: "KT", mentions: 1 },
  { kboId: "69205", name: "이교훈", team: "한화", mentions: 1 },
  { kboId: "55420", name: "김백산", team: "삼성", mentions: 1 },
  { kboId: "68700", name: "이원석", team: "한화", mentions: 1 },
  { kboId: "51417", name: "김현준", team: "삼성", mentions: 1 },
  { kboId: "55636", name: "박재현", team: "KIA", mentions: 1 },
  { kboId: "68525", name: "한동희", team: "롯데", mentions: 1 },
  { kboId: "51648", name: "이의리", team: "KIA", mentions: 1 },
  { kboId: "62404", name: "구자욱", team: "삼성", mentions: 1 },
  { kboId: "69100", name: "구본혁", team: "LG", mentions: 1 },
  { kboId: "68220", name: "곽빈", team: "두산", mentions: 1 },
  { kboId: "55268", name: "최민석", team: "두산", mentions: 1 },
];

export const S2B_TARGET_SOURCE_KEYS: string[] = S2B_TARGET_PLAYERS.map(
  ({ kboId }) => `namu:player:${kboId}`,
);

/**
 * 위키피디아 source_key (R3). tier2 **기본 소스**는 위키피디아이고 나무위키는 보조다.
 * 두 소스는 같은 entity를 가리키되 source_key 접두로 구분된다 — 그래야 provenance/재수집이 독립적이다.
 */
export const S2B_TARGET_WIKIPEDIA_SOURCE_KEYS: string[] = S2B_TARGET_PLAYERS.map(
  ({ kboId }) => `wikipedia:player:${kboId}`,
);

export function isS2bTargetSourceKey(sourceKey: string): boolean {
  return (
    S2B_TARGET_SOURCE_KEYS.includes(sourceKey)
    || S2B_TARGET_WIKIPEDIA_SOURCE_KEYS.includes(sourceKey)
  );
}
