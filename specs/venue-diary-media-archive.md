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
- `classifyCleanupRow` → `expired_after_end`(종료 확정 + 종료+24h 경과) 행은 **삭제하지 않고 private archive로 이동 후 `status='archived'`로 전환**.
- 이동은 `copy byte 검증 → archive_verified_at 기록 + CAS active→archiving → public remove → CAS archiving→archived` 상태머신이다. 중간 실패는 `archiving`으로 다음 cron에서 재개하고, CAS 0행이면 원본을 제거하지 않는다. legacy archived+public 행도 verified_at이 없으면 재검증 전에는 public 객체를 제거하지 않는다.
- storage 원본(media/thumb) **보존**. 댓글은 `venue_story_comments` FK `ON DELETE CASCADE`라 **행을 지우지 않으면 자동 보존**.
- 공개면(경기별 트레이/뷰어)은 `status='active'`만 노출 → archived는 공개에서 자동 제외 = "하루 뒤 비공개" 유지.

### 2.2 삭제 유지 대상 (다이어리 미보관)
- **`removed`(신고 임계/어드민/검증실패)**: 즉시 영구삭제 **금지** → 다이어리 미노출 상태로 **30일 격리 후 삭제**(오신고 복구 여지). `removed_at` 기준.
- **`cleanup_failed` / `stale_cap`**: 장애 상태 → 즉시 자동 archive/delete 금지, 격리+관제.
  - `cleanup_failed`는 `removed_at IS NOT NULL`일 때만 removed 출신으로 확정해 30일 격리 후 삭제를 재시도하고, `cleanup_failed_at`+7일 영구실패 TTL 경과 시 행 삭제를 강제한다.
  - `removed_at IS NULL`은 이전 status가 active/pending 중 무엇인지 `game_ended_at`만으로 구분할 수 없는 **출신 불명**이다. 자동 archive/delete 없이 격리+5xx 관제만 유지한다.
- **orphan S1 예외(재승인됨)**: DB 전 상태 참조가 0건이고 생성 후 96시간이 경과했으며, 참조조회 오류 시 전체 스캔을 건너뛰고 삭제 오류 시 5xx·cursor 미전진을 유지하는 객체만 대상으로 한다. 이 조건의 orphan은 복구 대상 story/소유자가 없는 생성실패 잔여물이므로 **S1은 기존 즉시삭제 유지**하며, 격리·재처리는 별도 슬라이스로 분리한다.

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
-- venue_stories.status: 'archiving', 'archived' 추가
ALTER TABLE venue_stories DROP CONSTRAINT ... ; -- status check 재정의
--   CHECK (status IN ('pending','active','removed','cleanup_failed','archiving','archived'))
ALTER TABLE venue_stories
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,        -- 공개 종료→보관 전환 시각
  ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ,         -- removed 격리 시작 시각(30일 TTL)
  ADD COLUMN IF NOT EXISTS cleanup_failed_at TIMESTAMPTZ, -- 정리 실패 시각(removed 출신 영구실패 TTL)
  ADD COLUMN IF NOT EXISTS archive_verified_at TIMESTAMPTZ; -- private 사본 byte 검증 시각(active→archiving CAS 증거; finalize 재검증 기준)
-- 다이어리 조회 인덱스: 본인 archived+active 미디어 최신순(주 정렬 game_date DESC, 같은 날 보조키 game_id DESC)
CREATE INDEX IF NOT EXISTS idx_venue_stories_diary
  ON venue_stories (user_id, game_date DESC, game_id DESC)
  WHERE status IN ('active','archived');
```
- report RPC / removed 전이 지점에 `removed_at = now()` 세팅.
- `archive_verified_at` 은 보관 이동 상태머신(active→archiving CAS 시 byte 검증 증거)에 기록되며, orphan 스캔은 `archiving` 행의 venue-archive 사본 path 를 참조집합에 합성해 보호하고, finalize 는 archive_verified_at 이 있어도 private 사본 존재를 재검증한다(삼순 재리뷰 Blocker 1).

## 5. 슬라이스 계획 (얇은 수직, 각 슬라이스 = 삼순 리뷰 게이트)

- **S1 (백엔드 보관 전환)**: migration(status archived·archived_at·removed_at·cleanup_failed_at·index) + cleanup route 수정(`expired_after_end`→archived 전환, `removed` 30일 격리, removed 출신 `cleanup_failed` 30일·영구실패 TTL 삭제, 출신불명 cleanup_failed·stale_cap 배치 제외·별도 count 관제) + expiry-policy 분류 확장 + 순수함수 회귀 테스트. **공개면 무변경**(active만 노출이라 자동). **orphan은 §2.2의 96시간·참조 0·오류 fail-closed 조건 아래 기존 즉시삭제 유지**(격리·재처리는 별도 슬라이스). DB 변경이라 삼순 리뷰 + 하린아빠 머지 승인 필수.
- **S2 (다이어리 미디어 API + private 이동 보강)**: 신규 `/api/me/venue-diary/media`. 본인 검증, 경기 keyset/정확 count, story별 댓글 상한+total. archived 객체는 private `venue-archive`만 허용하고 짧은 signed URL로 제공한다. archived+public bucket은 503 fail-closed. cleanup은 `archiving` 중간상태로 private 이동을 멱등 재개한다.
- **S3 (UI 목록)**: `VenueDiaryCard`에 보조 지표·`🔒 나만 보기` 1회·경기 row 썸네일 6+N.
- **S4 (UI 상세 캐러셀 + 삭제)**: 캐러셀 뷰어(순번/스와이프/도트) + `⋯` 본인 삭제 + 읽기전용 댓글.
- **S5 (비용 가드/관제)**: 월별 저장량·증가율·임계 알림 훅.

## 6. 검증 기준 (Goal-Driven)
- S1: 순수함수 회귀(expired_after_end→archive / removed 30일 경계 / 장애건 분류) + cleanup 실행 시 원본·댓글 잔존, active만 공개.
- E2E: 실제 로그인 유저가 어제 직관 스토리 올림 → 24h 후 공개 트레이 미노출 + `/my` 다이어리에서 사진/영상/댓글 열람 + 본인 삭제 동작.
- Surgical Changes: 공개 스토리/트레이/업로드 경로 회귀 0.
