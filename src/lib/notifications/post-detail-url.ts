// 글 상세 딥링크 — 게시판 종류별 실제 상세 라우트 (2026-08-16, 움짤/짤콜렉터 게시물 알림).
//
// 종전에는 dispatch handlePost 가 /community/free/{id} 를 하드코딩했는데,
// 움짤/짤콜렉터 글은 board_type='player'|'team' 이라 그 URL 이 존재하지 않는다
// (자유게시판 상세는 해당 id 글을 못 찾는다). 알림을 눌렀는데 엉뚱한 화면이
// 뜨는 결함이므로 board_type 기준으로 분기한다. 미지의 board_type 은 기존
// free 경로 유지(기존 자유게시판 알림과 동일 동작).
//
// 순수 함수 — 게이트가 실행 환경 없이 직접 호출한다.

export function postDetailUrl(
  record: { board_type?: unknown; board_id?: unknown },
  postId: number,
): string {
  const boardType = typeof record.board_type === "string" ? record.board_type : null;
  const boardId = typeof record.board_id === "string" && record.board_id ? record.board_id : null;
  if (boardType === "player" && boardId) return `/community/players/${boardId}/posts/${postId}`;
  if (boardType === "team" && boardId) return `/community/teams/${boardId}/posts/${postId}`;
  return `/community/free/${postId}`;
}
