/**
 * 게시글(투표글 포함) 편집 권한 판정 — 순수 함수(삼순 3차 NO-GO P1-2).
 *
 * PostDetail 의 게시글 메뉴 "수정" 버튼 노출과 편집 진입은 "작성자 본인"만 허용한다.
 * owner/other 실행형 회귀를 위해 인라인 `post.author_id === user.id` 를 이 순수 함수로
 * 추출해 배선하고, 서버 PATCH(작성자 200 / 타인 403)와 동일한 소유권 계약을 클라이언트
 * 진입점에도 동일하게 강제한다(메뉴는 UX 게이트, 최종 강제는 route+DB 트리거).
 */
export function canEditOwnPost(
  authorId: string | null | undefined,
  userId: string | null | undefined,
): boolean {
  // 비로그인(userId 없음) 또는 작성자 불명이면 편집 불가. 작성자==본인일 때만 true.
  return !!userId && !!authorId && authorId === userId;
}
