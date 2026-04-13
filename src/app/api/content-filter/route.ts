import { NextRequest, NextResponse } from "next/server";

const BLOCKED_WORDS = [
  "시발", "씨발", "좆", "병신", "미친놈", "꺼져",
  "ㅅㅂ", "ㅂㅅ", "ㅈㄹ", "ㅆㅂ", "지랄", "새끼",
];

const SPAM_PATTERNS = [
  /https?:\/\/[^\s]+\.(com|net|kr)\S*/gi, // 링크 과다
  /(\d{3}[-.]?\d{4}[-.]?\d{4})/g, // 전화번호
  /카[카톡].*\d/gi, // 카톡 ID
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

export async function POST(req: NextRequest) {
  const { title, content } = await req.json();
  const text = `${title || ""} ${content || ""}`;
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

  // 스팸 패턴
  const linkCount = (text.match(/https?:\/\//g) || []).length;
  if (linkCount > 3) issues.push("링크가 너무 많습니다");

  // 도배 체크 (짧은 반복)
  if (content && content.length < 5 && title && title.length < 5) {
    issues.push("내용이 너무 짧습니다");
  }

  return NextResponse.json({
    allowed: issues.length === 0,
    issues,
  });
}
