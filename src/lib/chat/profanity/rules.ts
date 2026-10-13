// 크관 채팅 비속어 필터 — 규칙 상수 (순수, SSOT)
// 오탐 최소화 원칙: 오탐 위험이 조금이라도 있는 어형(보지/한남/미친 단독 등)은
// HARD 에 넣지 않는다. HARD 는 문맥 없이 100% 욕인 것만.

export type Tier = "hard_legacy" | "hard_new" | "soft";
export type Verdict = "pass" | "hard_legacy" | "hard_new" | "soft";

/**
 * 기존 12어는 현행 substring/flexible 탐지를 유지하고 정상 span만 면책한다.
 * P0는 분류만 반환하며 enforce/shadow 집행은 아직 연결하지 않는다.
 * "새끼"도 같은 탐지를 적용하고 새끼손가락 등 정상 span만 면책한다.
 */
export const HARD_LEGACY: readonly string[] = [
  "시발", "씨발", "좆", "병신", "미친놈", "꺼져",
  "ㅅㅂ", "ㅂㅅ", "ㅈㄹ", "ㅆㅂ", "지랄",
  // "새끼" 는 SAEKKI_RULE 에서 같은 legacy 정책으로 검사
];

/** "새끼" 계열 — legacy 탐지 유지, allowlist로 정상 복합어 span 면책. */
export const SAEKKI_RULE = "새끼";

/** 기존 탐지의 명시적 정상 반례. 동일 rule의 해당 후보 구간만 면책. */
export const LEGACY_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  "시발": ["출시발표", "시발점", "시발역"],
  "씨발": ["씨앗이발아했다"],
  "병신": ["병신년생"],
  "꺼져": ["꺼져요", "꺼져가는", "꺼져있다", "꺼져있어"],
};

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
  "귀여워", "좋아", "이뻐", "예뻐", "멋져", "웃겨", "행복해", "배불러", "힘들어",
];

/** 위협어와 결합해도 욕이 아닌 정상 어절(응원 구호·관용). */
export const THREAT_ALLOW_EXACT: readonly string[] = [
  "죽여", "죽여주네", "죽여준다", "죽여줘", "죽겠다", "죽겠네", "죽을것같아",
];

/**
 * 의도적 모음 자모 욕설(ㅗ). 어절이 자모 ㅗ 단독/반복일 때만 HARD.
 * 정상 음절과 결합(해주세ㅗ오 등)이면 오타로 보고 PASS.
 */
export const JAMO_HARD_RE = /^[\u1169]+$/;

/** 명령형과 상태 서술을 구분한다. 불명확한 활용형은 P0에서 PASS. */
export const THREAT_FORMS: Readonly<Record<string, readonly string[]>> = {
  "죽어": ["죽어", "죽어라", "죽어버려"],
  "닥쳐": ["닥쳐", "닥쳐라"],
  "뒤져": ["뒤져", "뒤져라", "뒤져버려"],
  "멸종돼라": ["멸종돼라"],
};
export const CHEER_NEXT: readonly string[] = ["뛰자", "뛰어", "달리자", "응원하자", "해보자"];
export const STATE_SUBJECTS: readonly string[] = [
  "공이", "공은", "불이", "불은", "전광판이", "전광판은", "화면이", "화면은",
  "배터리가", "기계가", "컴퓨터가", "핸드폰이", "휴대폰이", "생중계가",
];

/** 일반 문자열 중간 매칭 대신 제한된 접두/어미만 인정한다. */
export const HARD_PREFIXES: readonly string[] = ["개", "이", "저", "그", "아", "하", "와", "진짜"];
export const HARD_SUFFIXES: readonly string[] = [
  "아", "야", "들", "들아", "놈", "놈아", "놈들", "놈들아", "년", "년아", "년들",
  "새끼", "새끼야", "이", "이다", "이네", "이냐", "이야", "같네", "같은", "같아",
  "하네", "하냐", "한다", "하지마", "하지마라",
];

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
 * 정상 표현이 덮는 동일 rule 후보 구간만 면책한다.
 * 같은 어절의 다른 위치에 있는 동일 rule은 면책하지 않는다.
 */
export const ALLOWLIST: readonly string[] = [
  "새끼손가락", "손새끼줄", "새끼발가락", "새끼손",
  "강한남자", "만루에강한남자",
  "못보지", "바보지", "믿어보지", "믿어보지무니", "보지",
  "아니미친", "정신병",
  "시발점", "시발역",
];
