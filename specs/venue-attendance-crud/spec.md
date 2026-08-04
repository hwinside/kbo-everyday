# 직관 기록 CRUD — Spec

## 범위

- GPS 인증 기록: 조회·본인 삭제. 사진·영상은 유지하고 수정은 금지한다.
- 직접 등록 기록: 종료 경기 등록, 조회, 응원팀 수정, 삭제, 삭제 후 재등록.
- 변경 성공 뒤 직관 다이어리 요약과 직관 통계 API를 다시 조회하면 즉시 변경값을 반환한다.

## 데이터 계약

- `venue_attendance.deleted_at`으로 기록만 비활성화한다. 원본 행을 남겨 기존 GPS 스토리 트리거가 삭제 기록을 다시 생성하지 못하게 한다.
- 활성 조회는 항상 `deleted_at IS NULL`을 적용한다.
- 직접 등록 재등록은 기존 `diary_manual` 행의 `deleted_at`을 해제한다.
- 삭제된 GPS 행은 직접 등록으로 복원하거나 출처를 바꿀 수 없다.

## API

- `POST /api/me/venue-attendance`: `{ gameId, favoriteTeamId }` 직접 등록/재등록.
- `PATCH /api/me/venue-attendance/:id`: `{ favoriteTeamId }` 직접 등록 응원팀 수정.
- `DELETE /api/me/venue-attendance/:id`: GPS/직접 등록 기록만 소프트 삭제.
- 기존 `GET /api/me/venue-attendance`와 `GET /api/me/venue-stats`는 활성 기록만 반환한다.

## 보안·무결성

- 서버가 실제 경기 존재·2026 시즌·종료 상태·응원팀 참가 여부를 재검증한다.
- 동일 유저·경기는 활성 기록 한 건만 유지한다.
- GPS↔직접 등록 출처 변경은 DB RPC와 API 양쪽에서 차단한다.
- 미디어 테이블·스토리지는 CRUD 대상이 아니다.
