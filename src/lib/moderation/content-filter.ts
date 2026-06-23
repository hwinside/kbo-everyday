// 유저 작성 콘텐츠(글/사진글/댓글/채팅) 모더레이션 필터 — 서버/클라 공용.
// 작성·전송 *전*에 호출해 불쾌한 콘텐츠(욕설/스팸/도배)를 차단한다.
// (Apple App Review 1.2 "method for filtering objectionable content")

const BLOCKED_WORDS = [
  "시발", "씨발", "좆", "병신", "미친놈", "꺼져",
  "ㅅㅂ", "ㅂㅅ", "ㅈㄹ", "ㅆㅂ", "지랄", "새끼",
];

// 텍스트 전처리: Unicode NFKC 정규화 + 공백/특수문자 제거
function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\s\u200B-\u200F\u2028-\u202F\uFEFF]/g, "") // 공백/제로폭 문자 제거
    .replace(/[^\p{L}\p{N}]/gu, ""); // 문자·숫자만 남김
}

// 금칙어 사이에 공백/특수문자 삽입 우회를 탐지하는 정규식 생성
function buildFlexiblePattern(word: string): RegExp {
  const chars = [...word];
  const pattern = chars.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\S]{0,3}");
  return new RegExp(pattern, "gi");
}

export interface ContentFilterResult {
  allowed: boolean;
  issues: string[];
}

/**
 * 글/댓글/채팅 등 유저 작성 텍스트를 검사한다.
 * title 은 게시글에만 의미가 있고, 댓글/채팅은 content 만 넘기면 된다.
 */
export function checkObjectionableContent(input: { title?: string; content?: string }): ContentFilterResult {
  const title = input.title ?? "";
  const content = input.content ?? "";
  const text = `${title} ${content}`;
  const normalizedText = normalizeText(text);
  const issues: string[] = [];

  // 금칙어 체크: 정규화된 텍스트 + 원본 텍스트 유연 매칭
  for (const word of BLOCKED_WORDS) {
    const normalizedWord = normalizeText(word);
    if (normalizedText.includes(normalizedWord)) {
      issues.push("부적절한 표현이 포함되어 있습니다");
      break;
    }
    if (buildFlexiblePattern(word).test(text)) {
      issues.push("부적절한 표현이 포함되어 있습니다");
      break;
    }
  }

  // 스팸 패턴: 링크 과다
  const linkCount = (text.match(/https?:\/\//g) || []).length;
  if (linkCount > 3) issues.push("링크가 너무 많습니다");

  // 도배 체크 (제목·내용 모두 너무 짧은 반복)
  if (content && content.length < 5 && title && title.length < 5) {
    issues.push("내용이 너무 짧습니다");
  }

  return { allowed: issues.length === 0, issues };
}

/** 차단 시 사용자에게 보여줄 첫 사유. allowed면 null. */
export function firstContentIssue(input: { title?: string; content?: string }): string | null {
  const { allowed, issues } = checkObjectionableContent(input);
  return allowed ? null : issues[0] ?? "부적절한 콘텐츠입니다";
}
