/**
 * 직관 라이브 스토리 댓글 스모크 — 입력 검증 / 삭제 권한(RLS 계약) / 댓글 수 집계
 * / 최신 100개 정순 반전(101개 회귀) / 어뷰징 가드 / migration RLS 정책 계약.
 * 실행: npm run qa:venue-story-comments
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  validateCommentContent,
  canDeleteComment,
  countVisibleComments,
  toChronological,
  evaluateCommentRate,
  VENUE_STORY_COMMENT_MAX_LENGTH,
  VENUE_STORY_COMMENT_LIST_LIMIT,
  VENUE_STORY_COMMENT_COOLDOWN_MS,
  VENUE_STORY_COMMENT_WINDOW_MS,
  VENUE_STORY_COMMENT_MAX_IN_WINDOW,
} from "../../src/lib/venue-stories/comments";
import { allowStoryComment } from "../../src/lib/venue-stories/comment-rate-limit";

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

console.log("[최신 100개 정순 반전 — 101개 회귀]");
{
  // DB 동작 모사: 1..101 생성 → created_at DESC 정렬 → LIMIT 100 → 응답에서 정순 반전
  const all = Array.from({ length: 101 }, (_, i) => ({
    id: i + 1,
    created_at: new Date(1700000000000 + (i + 1) * 1000).toISOString(),
  }));
  const descPage = [...all]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, VENUE_STORY_COMMENT_LIST_LIMIT);
  const shown = toChronological(descPage);
  ok("101개 중 100개 노출", shown.length === 100);
  ok("101번째(최신) 댓글 포함", shown.some((r) => r.id === 101));
  ok("가장 오래된 1번 댓글만 밀려남", !shown.some((r) => r.id === 1));
  ok("정순(오래된→최신) 정렬", shown[0].id === 2 && shown[99].id === 101);
  ok("입력 배열 불변(방어적 복사)", descPage[0].id === 101);
  ok("빈 목록 반전 안전", toChronological([]).length === 0);
}

console.log("[어뷰징 가드 — 10초 간격 / 60초 내 3건]");
{
  const t0 = 1_000_000;
  // 순수 판정
  const r1 = evaluateCommentRate([], t0);
  ok("첫 작성 허용", r1.allowed === true);
  const r2 = evaluateCommentRate(r1.timestamps, t0 + 5_000);
  ok("10초 미만 재작성 차단", r2.allowed === false);
  const r3 = evaluateCommentRate(r1.timestamps, t0 + VENUE_STORY_COMMENT_COOLDOWN_MS);
  ok("10초 경과 후 허용", r3.allowed === true);
  const r4 = evaluateCommentRate(r3.timestamps, t0 + 20_000);
  ok("60초 내 3번째 허용", r4.allowed === true);
  const r5 = evaluateCommentRate(r4.timestamps, t0 + 31_000);
  ok("60초 내 4번째 차단(윈도우 초과)", r5.allowed === false);
  const r6 = evaluateCommentRate(r4.timestamps, t0 + VENUE_STORY_COMMENT_WINDOW_MS + 21_000);
  ok("윈도우 만료 후 다시 허용", r6.allowed === true);
  ok("정책 상수 계약(10s/60s/3건) — CommentSheet 클라 가드와 동일",
    VENUE_STORY_COMMENT_COOLDOWN_MS === 10_000 &&
    VENUE_STORY_COMMENT_WINDOW_MS === 60_000 &&
    VENUE_STORY_COMMENT_MAX_IN_WINDOW === 3);
  // 서버 래퍼(유저별 상태) — 다른 유저는 서로 영향 없음
  ok("래퍼: 첫 작성 허용", allowStoryComment("user-a", t0) === true);
  ok("래퍼: 연속 작성 차단", allowStoryComment("user-a", t0 + 1_000) === false);
  ok("래퍼: 타 유저 무관", allowStoryComment("user-b", t0 + 1_000) === true);
}

console.log("[migration RLS 정책 계약 — authenticated UPDATE 부재]");
{
  const sql = readFileSync(
    path.resolve(process.cwd(), "supabase/migrations/20260723_venue_story_comments.sql"),
    "utf8",
  );
  const policies = sql.match(/CREATE POLICY[\s\S]*?;/g) ?? [];
  ok("UPDATE 정책 없음(soft delete 는 service_role API 전담)",
    policies.every((p) => !/FOR\s+UPDATE/i.test(p)));
  ok("DELETE 정책도 없음(물리 삭제 불가 계약)",
    policies.every((p) => !/FOR\s+DELETE/i.test(p)));
  ok("SELECT 정책 존재(미삭제 공개 조회)",
    policies.some((p) => /FOR\s+SELECT/i.test(p) && /deleted_at IS NULL/i.test(p)));
  ok("INSERT 정책 존재(authenticated 본인 명의)",
    policies.some((p) => /FOR\s+INSERT/i.test(p) && /TO authenticated/i.test(p)));
  ok("RLS 활성화 유지", /ENABLE ROW LEVEL SECURITY/.test(sql));
}

console.log("[상수 계약]");
ok("최대 길이 200", VENUE_STORY_COMMENT_MAX_LENGTH === 200);
ok("목록 조회 상한 유한(안전 limit)", Number.isInteger(VENUE_STORY_COMMENT_LIST_LIMIT) && VENUE_STORY_COMMENT_LIST_LIMIT > 0);

console.log(`\n결과: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
