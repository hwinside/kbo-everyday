// 직관 라이브 스토리 댓글 어뷰징 가드 — 서버리스 인스턴스 단위 best-effort.
// 판정 로직(10초 간격 / 60초 내 3건)은 comments.ts 의 순수 함수 evaluateCommentRate 가 소유하고
// (CommentSheet 클라 가드와 동일 정책 상수), 여기서는 유저별 상태(Map)만 관리한다.
// 키 상한 정리 패턴은 news/discussion-rate-limit.ts 와 동일.
import { evaluateCommentRate } from "./comments";

const MAX_KEYS = 5000;
const attempts = new Map<string, number[]>();

/** 허용 시 작성 시각을 소비(기록)하고 true, 차단 시 false. */
export function allowStoryComment(userId: string, now = Date.now()): boolean {
  const result = evaluateCommentRate(attempts.get(userId) ?? [], now);
  attempts.set(userId, result.timestamps);

  if (attempts.size > MAX_KEYS) {
    const oldestKeys = [...attempts.keys()].slice(0, Math.floor(MAX_KEYS / 2));
    for (const oldKey of oldestKeys) attempts.delete(oldKey);
  }
  return result.allowed;
}
