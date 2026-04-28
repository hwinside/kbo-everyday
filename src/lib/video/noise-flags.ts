/**
 * 영상 noise_flags 추출 (2차 필터 노출 제외 용도)
 * B안 Phase 1
 */

export type NoiseFlag =
  | "highlight_compilation" // 하이라이트 모음/H/L
  | "fancam"                // 직캠
  | "vlog"                  // vlog/일상
  | "ceremony"              // 시구/시타/행사
  | "preview"               // 예고편/프리뷰
  | "interview"             // 인터뷰
  | "other_sports"          // 농구 등 타 종목
  | "game";                 // 모바일/콘솔 게임 영상

const PATTERNS: Array<{ flag: NoiseFlag; regex: RegExp }> = [
  { flag: "highlight_compilation", regex: /(하이라이트\s*모음|H\/L|HL\s*모음|경기\s*풀\s*영상|풀\s*하이라이트|경기요약)/i },
  { flag: "fancam", regex: /(직캠|fancam|팬캠)/i },
  { flag: "vlog", regex: /(vlog|브이로그|일상)/i },
  { flag: "ceremony", regex: /(시구|시타|응원단|치어리더|팬사인|행사)/i },
  { flag: "preview", regex: /(예고|프리뷰|티저|preview|teaser)/i },
  { flag: "interview", regex: /(인터뷰|interview|기자회견)/i },
  { flag: "other_sports", regex: /(농구|프로농구|kbl|basketball|nba|창원\s*lg\s*세이커스|lg\s*세이커스|세이커스|소노\s*스카이거너스|sk\s*나이츠|삼성\s*썬더스|db\s*프로미|kcc\s*이지스|현대모비스\s*피버스|한국가스공사\s*페가수스|정관장\s*레드부스터스)/i },
  { flag: "game", regex: /(컴투스|컴프야|프로야구H|모바일게임|게임플레이|게임화면|프로스피릿)/i },
];

/** 제목/채널명 기반 noise_flags 추출 */
export function extractNoiseFlags(title: string, channel?: string): NoiseFlag[] {
  const text = `${title} ${channel ?? ""}`;
  const flags: NoiseFlag[] = [];
  for (const { flag, regex } of PATTERNS) {
    if (regex.test(text)) flags.push(flag);
  }
  return flags;
}

/** 숏츠 후보 판정 — duration 없을 때도 제목 힌트로 fallback */
export function isShortCandidate(params: {
  durationSeconds?: number | null;
  title: string;
}): boolean {
  const { durationSeconds, title } = params;
  if (typeof durationSeconds === "number") {
    return durationSeconds > 0 && durationSeconds <= 70;
  }
  // RSS는 duration 없음 → 제목 힌트
  return /#?(shorts|숏츠|쇼츠)/i.test(title);
}

/** 노출 시 2차 필터 — 기본 제외 flag 세트 */
export const DEFAULT_EXCLUDE_FLAGS: ReadonlySet<NoiseFlag> = new Set([
  "highlight_compilation",
  "fancam",
  "vlog",
  "ceremony",
  "preview",
  "other_sports",
  "game",
]);

export function isExcludedByNoise(
  flags: NoiseFlag[] | string[],
  excludeSet: ReadonlySet<string> = DEFAULT_EXCLUDE_FLAGS as ReadonlySet<string>,
): boolean {
  return flags.some((f) => excludeSet.has(f));
}
