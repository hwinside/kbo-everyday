/**
 * 직관 라이브 스토리 댓글 스모크 — 입력 검증 / 삭제 권한(RLS 계약) / 댓글 수 집계.
 * 실행: npm run qa:venue-story-comments
 */
import {
  validateCommentContent,
  canDeleteComment,
  countVisibleComments,
  VENUE_STORY_COMMENT_MAX_LENGTH,
  VENUE_STORY_COMMENT_LIST_LIMIT,
} from "../../src/lib/venue-stories/comments";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

const ME = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

console.log("[입력 검증]");
ok("정상 댓글 통과 + trim", (() => {
  const r = validateCommentContent("  오늘 직관 최고!  ");
  return r.ok && r.content === "오늘 직관 최고!";
})());
ok("빈 문자열 거부", validateCommentContent("").ok === false);
ok("공백만 거부", validateCommentContent("   \n  ").ok === false);
ok("문자열 아님(undefined) 거부", validateCommentContent(undefined).ok === false);
ok("문자열 아님(숫자) 거부", validateCommentContent(123).ok === false);
ok(`정확히 ${VENUE_STORY_COMMENT_MAX_LENGTH}자 통과`,
  validateCommentContent("가".repeat(VENUE_STORY_COMMENT_MAX_LENGTH)).ok === true);
ok(`${VENUE_STORY_COMMENT_MAX_LENGTH + 1}자 거부`,
  validateCommentContent("가".repeat(VENUE_STORY_COMMENT_MAX_LENGTH + 1)).ok === false);
ok("trim 후 상한 재계산(공백 패딩으로 우회 불가 아님 — trim 후 200자면 통과)", (() => {
  const r = validateCommentContent("  " + "가".repeat(VENUE_STORY_COMMENT_MAX_LENGTH) + "  ");
  return r.ok === true;
})());

console.log("[삭제 권한 계약 (RLS/API 공용)]");
ok("본인 댓글 삭제 허용", canDeleteComment(ME, ME, false) === true);
ok("타인 댓글 삭제 거부", canDeleteComment(ME, OTHER, false) === false);
ok("비로그인 삭제 거부", canDeleteComment(ME, null, false) === false);
ok("관리자는 타인 댓글 삭제 허용", canDeleteComment(ME, OTHER, true) === true);
ok("관리자 + 비로그인 id 조합도 허용(service_role 경로)", canDeleteComment(ME, null, true) === true);

console.log("[댓글 수 집계 — soft delete 제외]");
ok("미삭제만 집계", countVisibleComments([
  { deleted_at: null },
  { deleted_at: "2026-07-23T12:00:00Z" },
  { deleted_at: null },
]) === 2);
ok("빈 목록 0", countVisibleComments([]) === 0);
ok("전부 삭제면 0", countVisibleComments([{ deleted_at: "2026-07-23T12:00:00Z" }]) === 0);

console.log("[상수 계약]");
ok("최대 길이 200", VENUE_STORY_COMMENT_MAX_LENGTH === 200);
ok("목록 조회 상한 유한(안전 limit)", Number.isInteger(VENUE_STORY_COMMENT_LIST_LIMIT) && VENUE_STORY_COMMENT_LIST_LIMIT > 0);

console.log(`\n결과: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
