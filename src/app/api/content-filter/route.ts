import { NextRequest, NextResponse } from "next/server";

const BLOCKED_WORDS = [
  "시발", "씨발", "좆", "병신", "미친놈", "꺼져", "죽어",
  "ㅅㅂ", "ㅂㅅ", "ㅈㄹ", "ㅆㅂ", "지랄", "새끼",
];

const SPAM_PATTERNS = [
  /https?:\/\/[^\s]+\.(com|net|kr)\S*/gi, // 링크 과다
  /(\d{3}[-.]?\d{4}[-.]?\d{4})/g, // 전화번호
  /카[카톡].*\d/gi, // 카톡 ID
];

export async function POST(req: NextRequest) {
  const { title, content } = await req.json();
  const text = `${title || ""} ${content || ""}`;
  const issues: string[] = [];

  // 금칙어
  for (const word of BLOCKED_WORDS) {
    if (text.includes(word)) {
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
