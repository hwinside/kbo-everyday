// 크관 채팅 비속어 필터 — 규칙 상수 (순수, SSOT)
// 오탐 최소화 원칙: 오탐 위험이 조금이라도 있는 어형(보지/한남/미친 단독 등)은
// HARD 에 넣지 않는다. HARD 는 문맥 없이 100% 욕인 것만.

export type Tier = "hard_legacy" | "hard_new" | "soft";
export type Verdict = "pass" | "hard_legacy" | "hard_new" | "soft";

/**
 * 기존 검증 12어(enforce). 어절 정규화 후 substring 매칭.
 * "새끼"는 어절 경계 규칙(§2.1)으로 별도 처리한다(새끼손가락 오탐 방지).
 */
export const HARD_LEGACY: readonly string[] = [
  "시발", "씨발", "좆", "병신", "미친놈", "꺼져",
  "ㅅㅂ", "ㅂㅅ", "ㅈㄹ", "ㅆㅂ", "지랄",
  // "새끼" 는 SAEKKI_RULE 로 경계 판정
];

/** "새끼" 계열 — 어절 경계 판정 대상. allowlist 로 정상 복합어 면책. */
export const SAEKKI_RULE = "새끼";

/**
 * 신규 HARD(우회 욕설). 배포 시 shadow → 규칙별 게이트 통과 후 enforce.
 * 오탐 위험이 낮은 명백 우회형만.
 */
export const HARD_NEW: readonly string[] = [
  "ㅆ벌", "ㅆ발", "시팔", "시부럴", "ㅅㄲ", "쌔끼", "새끼야", "야랄",
];

/** 위협 어형 — 문맥(대상 지목·명령)에서만 HARD. 긍정 문맥 면책. */
export const THREAT_WORDS: readonly string[] = ["죽어", "닥쳐", "뒤져", "멸종돼라"];

/** 위협어 앞에 오면 응원/감탄으로 간주해 면책하는 긍정 접두 어절. */
export const THREAT_POSITIVE_PREFIX: readonly string[] = [
  "귀여워", "귀엽", "좋아", "이뻐", "예뻐", "사랑", "최고", "잘한다", "멋져",
];

/** 위협어와 결합해도 욕이 아닌 정상 어절(응원 구호·관용). */
export const THREAT_ALLOW_EXACT: readonly string[] = [
  "죽어라", "죽여", "죽여주네", "죽여준다", "죽여줘", "죽겠다", "죽겠네", "죽을것같아",
];

/**
 * 의도적 모음 자모 욕설(ㅗ). 어절이 자모 ㅗ 단독/반복일 때만 HARD.
 * 정상 음절과 결합(해주세ㅗ오 등)이면 오타로 보고 PASS.
 */
export const JAMO_HARD_RE = /^ㅗ+$/;

/**
 * SOFT 문맥어(미친/ㅈㄴ/존나/졸라/개-). shadow(무동작) → 오탐 실측 후 소프트 가림.
 * 유저 차단 아님. "미친놈"은 HARD_LEGACY 가 먼저 잡는다.
 */
export const SOFT_WORDS: readonly string[] = [
  "미친", "ㅈㄴ", "존나", "졸라", "개역겹", "개노답", "개판", "개빡", "개같",
];

/**
 * "미친" 뒤에 오는 감탄/칭찬 어절 — 이 경우 욕이 아니라 강조 감탄이므로 면책(PASS).
 * 예: "미친 레전드", "미친 대박". "미친" 단독은 soft 로 남는다.
 */
export const MICHIN_POSITIVE_SUFFIX: readonly string[] = [
  "레전드", "대박", "최고", "좋", "잘", "킹", "갓", "멋", "미쳤",
];

/** "개-" 강조 접두(개+2글자 이상) 를 soft 후보로 볼 때 제외할 정상 어절. */
export const KAE_PREFIX_ALLOW: readonly string[] = [
  "개막", "개막전", "개시", "개인", "개막일", "개막식",
];

/**
 * allowlist 반례(어절 span 면책). 정규화된 어절이 이 중 하나와 일치하거나,
 * 이 항목을 포함하면 해당 어절의 HARD 후보를 면책한다(전체 PASS 아님 — 그 어절만).
 */
export const ALLOWLIST: readonly string[] = [
  "새끼손가락", "손새끼줄", "새끼발가락", "새끼손",
  "강한남자", "만루에강한남자",
  "못보지", "바보지", "믿어보지", "믿어보지무니", "보지",
  "아니미친", "정신병",
];
