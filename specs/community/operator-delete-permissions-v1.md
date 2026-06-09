# 운영자 삭제 권한 V1 — Spec

> 작성: 삼식이 (2026-06-09) · 스레드: #marketing 1780746516.324069
> 요청: 하린아빠 — 하린아빠/하린엄마/윤연률에게 모든 글·댓글·채팅 삭제(모더레이션) 권한

## 1. 배경 / 현황 (prod 실측)

- `profiles.is_operator BOOLEAN` 컬럼은 prod에 존재 (2026-05-30 댓글 운영자삭제 작업 때 추가).
- **댓글**: `"Operators delete any comments"` DELETE RLS 정책 prod 존재. 단 이를 쓰는 UI는 PR #145(`hotfix/operator-comment-delete`, 미머지)에 있음.
- **글(posts)**: 운영자 삭제 정책 없음 (본인 삭제만).
- **채팅(chat)**: DELETE 정책 없음. soft-delete는 `delete_own_chat_message` RPC(본인만).

→ "권한 부여"는 플래그 flip이 아니라 *글/채팅 운영자 삭제 신설 + 댓글 UI 머지 + 대상 grant* 빌드.

## 2. 스코프 (락)

- 대상 3명: 하린아빠 / 하린엄마 / 윤연률. (정배현우·김현우 제외)
- 범위: 모든 글/댓글/채팅 *삭제*(모더레이션). 수정은 작성자 한정 유지.
- 식별: `profiles.is_operator = true` per-user 플래그.

## 3. 성공 기준 (Goal-Driven)

| # | 기준 | 검증 |
|---|------|------|
| G1 | is_operator 운영자가 *타인 글* 삭제 가능, 비운영자는 불가 | RLS 테스트 (운영자/비운영자 세션) |
| G2 | 운영자가 *타인 댓글* 삭제 가능 | PR #145 머지 후 동일 |
| G3 | 운영자가 *타인 채팅* soft-delete 가능, 비운영자 RPC 거부 | RPC 테스트 |
| G4 | 일반 유저 권한 무변동 (본인 것만 삭제) | 회귀 테스트 |
| G5 | 운영자 삭제 UI 노출은 is_operator=true 에게만 | 실유저 QA |

## 4. 슬라이스

- **S1 (본 PR) DB 토대** — `20260609_operator_delete_permissions.sql`:
  - posts `"Operators delete any posts"` DELETE 정책 (comments 정책 미러).
  - `delete_any_chat_message(p_message_id)` SECURITY DEFINER RPC (is_operator 게이트, soft-delete 마스킹).
  - 3명 `is_operator = true` 멱등 grant.
- **S2 댓글 UI** — PR #145(`hotfix/operator-comment-delete`) 마무리: AuthContext `is_operator` 노출 + CommentSheet/PostDetail 운영자 삭제 버튼. (이미 MERGEABLE — 삼순 재리뷰 후 머지)
- **S3 글 삭제 UI** — `deletePost(postId, {canDeleteAny})` 시그니처(운영자면 author_id 필터 생략) + PostDetail/피드 메뉴에 운영자 삭제 노출.
- **S4 채팅 삭제 UI** — `useChat`이 운영자면 `delete_any_chat_message` RPC 호출 + 채팅 메시지 운영자 삭제 버튼.

## 5. 보안 / 주의

- 운영자 식별은 **항상 서버측**(RLS/RPC가 auth.uid() → profiles.is_operator 확인). 클라 `is_operator`는 UI 노출용일 뿐, 우회 불가.
- chat은 hard-delete 아닌 soft-delete(마스킹) 유지 — 기존 본인삭제와 동일 UX.
- posts는 기존 본인삭제가 hard-delete(.delete())라 운영자도 hard-delete. (향후 soft-delete 전환은 별건)
- 권한 변경이라 삼순이 슬라이스별 + 머지 전 재리뷰. End-User QA는 운영자/비운영자 실세션 둘 다.

## 6. 범위 밖

- 운영자 액션 audit log / 되돌리기 — 별건.
- 어드민 대시보드 모더레이션 탭 — 별건(기존 /admin PIN 경로).
- 게시글 soft-delete 전환 — 별건.
