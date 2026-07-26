# 직관 다이어리 — 미디어/댓글 보관 (archive) 스펙

> 상태: 승인됨 (하린아빠 "UI Good" 2026-07-26 / 삼순 정책·화면 정의 GO)
> 담당: 구현 삼식 · 리뷰 삼순 · 머지 승인 하린아빠
> 관련 기존: `직관 다이어리 v1`(venue_attendance = 승·무·패/승률), `직관 라이브`(venue_stories = 스토리)

## 1. 배경 / 문제

현재 `venue-stories-cleanup` cron은 `경기종료+24h`(expires_at) 지난 스토리의 **storage 원본 + DB 행을 실제 삭제**한다.
→ 유저가 직관에서 올린 사진/영상/댓글이 하루 뒤 완전히 사라져 "내 직관 기록"으로 남지 않음.

**요구(하린아빠)**: 공개는 하루 뒤 종료(스토리 성격 유지)하되, **내가 올린 사진/영상 + 그 영상에 달린 댓글**을 삭제하지 않고 보관 → 나중에 **`/my` 직관 다이어리**에서 열람.

## 2. 확정 정책 (삼순 GO)

### 2.1 보관 전환 (정상 만료)
- `classifyCleanupRow` → `expired_after_end`(종료 확정 + 종료+24h 경과) 행은 **삭제하지 않고 `status='archived'`로 전환**.
- storage 원본(media/thumb) **보존**. 댓글은 `venue_story_comments` FK `ON DELETE CASCADE`라 **행을 지우지 않으면 자동 보존**.
- 공개면(경기별 트레이/뷰어)은 `status='active'`만 노출 → archived는 공개에서 자동 제외 = "하루 뒤 비공개" 유지.

### 2.2 삭제 유지 대상 (다이어리 미보관)
- **`removed`(신고 임계/어드민/검증실패)**: 즉시 영구삭제 **금지** → 다이어리 미노출 상태로 **30일 격리 후 삭제**(오신고 복구 여지). `removed_at` 기준.
- **`cleanup_failed` / orphan / `stale_cap`**: 장애 상태 → 격리·재처리. 복구 성공 시 `archived`, **소유불명·영구실패만 TTL 후 삭제**.

### 2.3 보관 기한 / 라이프사이클
- **계정 유지 중 무기한 보관** (하린아빠 명시).
- 삭제 트리거: ①본인 삭제(다이어리 `⋯`) ②계정 탈퇴(auth.users FK CASCADE로 이미 정리) ③법적/운영 삭제.
- **비용 가드**: 월별 저장량·증가율·비용 임계 알림 훅(관제). 출시 조건.

### 2.4 접근 제어
- 다이어리 = **본인 소유만**. `venue_attendance`/신규 미디어 조회 모두 service_role API + `getVerifiedUserFromRequest` 본인 검증(공개 RLS 없음, 기존 계약 유지).
- 댓글 작성자 삭제·운영 삭제는 **다이어리에도 즉시 반영**(soft/hard 삭제 전파).

## 3. 화면 정의 (목업 v2 승인본)

### 3.1 다이어리 목록 (`/my` `VenueDiaryCard` 확장)
- **승·무·패/승률 = 핵심 유지**(기존 그대로). 사진/영상 수는 **보조 지표 한 줄**(📸N·🎬N).
- 상단 **`🔒 나만 보기` 안내 1회**(개별 '보관' 뱃지 없음).
- 경기 row에 **내 미디어 썸네일 최대 6장 + `+N`**. 미디어 없는 경기는 기존과 동일(썸네일 없음).
- 날짜 요일은 `game_date`에서 자동 파생(`ko-KR weekday short`, KST). 예: 7.24 금 · 7.19 일 · 7.11 토.

### 3.2 상세 캐러셀
- 경기 단위 뷰어. **순번(`2/8`) + 좌우 스와이프 + 하단 도트**.
- 사진/영상 구분(영상 ▶·재생), 캡션·직관 인증 뱃지.
- **`⋯` 메뉴에 "이 기록 삭제"**(본인 삭제) — 확인 다이얼로그 → storage+행 hard delete(해당 미디어만).
- **댓글 읽기 전용**: 새 댓글·답글 불가, "지난 기록이라 새 댓글 불가" 안내. 작성자/운영 삭제분은 미노출.

## 4. 데이터 모델 변경

```sql
-- venue_stories.status: 'archived' 추가
ALTER TABLE venue_stories DROP CONSTRAINT ... ; -- status check 재정의
--   CHECK (status IN ('pending','active','removed','cleanup_failed','archived'))
ALTER TABLE venue_stories
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,   -- 공개 종료→보관 전환 시각
  ADD COLUMN IF NOT EXISTS removed_at  TIMESTAMPTZ;   -- removed 격리 시작 시각(30일 TTL)
-- 다이어리 조회 인덱스: 본인 archived+active 미디어 최신순
CREATE INDEX IF NOT EXISTS idx_venue_stories_diary
  ON venue_stories (user_id, game_date DESC)
  WHERE status IN ('active','archived');
```
- report RPC / removed 전이 지점에 `removed_at = now()` 세팅.

## 5. 슬라이스 계획 (얇은 수직, 각 슬라이스 = 삼순 리뷰 게이트)

- **S1 (백엔드 보관 전환)**: migration(status archived·archived_at·removed_at·index) + cleanup route 수정(`expired_after_end`→archived 전환, `removed` 30일 격리, 장애건 격리/재처리) + expiry-policy 분류 확장 + 순수함수 회귀 테스트. **공개면 무변경**(active만 노출이라 자동). DB 변경이라 삼순 리뷰 + 하린아빠 머지 승인 필수.
- **S2 (다이어리 미디어 API)**: `/api/me/venue-attendance` 응답에 경기별 내 미디어(archived+active) 배열 추가 or 신규 `/api/me/venue-diary/media`. 본인 검증·signed URL·경기별 그룹.
- **S3 (UI 목록)**: `VenueDiaryCard`에 보조 지표·`🔒 나만 보기` 1회·경기 row 썸네일 6+N.
- **S4 (UI 상세 캐러셀 + 삭제)**: 캐러셀 뷰어(순번/스와이프/도트) + `⋯` 본인 삭제 + 읽기전용 댓글.
- **S5 (비용 가드/관제)**: 월별 저장량·증가율·임계 알림 훅.

## 6. 검증 기준 (Goal-Driven)
- S1: 순수함수 회귀(expired_after_end→archive / removed 30일 경계 / 장애건 분류) + cleanup 실행 시 원본·댓글 잔존, active만 공개.
- E2E: 실제 로그인 유저가 어제 직관 스토리 올림 → 24h 후 공개 트레이 미노출 + `/my` 다이어리에서 사진/영상/댓글 열람 + 본인 삭제 동작.
- Surgical Changes: 공개 스토리/트레이/업로드 경로 회귀 0.
