# Leaderboard v1 (초대 + 글쓰기) Spec

> Status: **DRAFT**
> Owner: 삼식이
> Origin: 2026-04-20 #marketing 스레드 `1776644364.098599` (초대권 이벤트)
> Prereq SSOT: `docs/marketing/community-activation-event-draft.html` (event-draft.html)

## 1. 목적

4/20~5/31 커뮤니티 활성화 이벤트의 **순위 가시화** 레이어.
"보상 경쟁이 보이는 판"을 먼저 깔아 `/my` 카드 · 커뮤니티 배너 · 공유 카피가 같은 방향으로 붙도록 한다.

## 2. 정책 (event-draft.html SSOT 반영)

### 2.1 집계 기간
- **전체 누적만** (2026-04-20 00:00 KST ~ 2026-05-31 23:59:59 KST)
- 주간 리더보드 NO-GO (상금 미존재)

### 2.2 트랙 분리 (통합점수 NO-GO)
- 초대 리더보드 (Invite)
- 글쓰기 리더보드 (Writing)

### 2.3 초대 트랙 집계 ✅ 잠김 완료
- **SSOT**: `src/lib/supabase/invite-activation.ts` 재사용 (뱃지 부여 전 동일 훅크)
- **집계 대상**: `invitations.activated_at IS NOT NULL` (활성화 시점 무관 — 기간 전/내 모두 합산)
  - 이유: FAQ(event-draft.html L401) "기존 누적 초대도 인정, 이벤트 기간 중 새로 활성화된 초대도 함산" 정책 반영
  - 활성화 조건 요약 (실코드 `invite-activation.ts` 기준):
    1. 피초대자 `profiles.team_id IS NOT NULL` (팀 선택 완료)
    2. 피초대자 글 + 댓글 합 1건 이상
  - 조건 충족 시 `checkAndActivateInvite()` 가 `activated_at` 기록 + 뱃지 부여
- **리더보드 집계 구조**:
  ```sql
  SELECT inviter_id, COUNT(*) AS invite_count
  FROM invitations
  WHERE activated_at IS NOT NULL
    -- 기간 필터 없음: 기존 누적 + 이벤트 중 활성화 모두 인정 (FAQ 정책 반영)
    AND flagged IS NOT TRUE
    AND inviter_id NOT IN (제외 UUID 7개)
  GROUP BY inviter_id
  ORDER BY invite_count DESC;
  ```
- **동률 타이브레이커**: `MAX(activated_at)` 가 이른 순 우선 (마지막 활성화를 먼저 달성한 사람)
- **어뷰징 가드**: `invitations.flagged = true` 행은 집계 제외 (운영자 수동 플래그)

### 2.4 글쓰기 트랙 집계 (포인트 가중치 · event-draft.html L363~370) ✅ 잠김 완료

| 활동 | 소스 테이블/조건 | pt | 일 상한 |
|------|------------------|----|---------|
| 경기 중계 채팅 | `chat_messages` | 1 | 30 |
| 커뮤니티 댓글 | `comments` | 2 | 40 |
| 커뮤니티 글 | `posts` WHERE `content_type <> 'photo'` | 3 | 30 |
| 사진 게시판 사진글 | `posts` WHERE `content_type = 'photo'` | 5 | 50 |
| **총 일일 상한** | — | — | **150pt** |

- 운영 안전핀 (event-draft.html L372~378)
  - 점수 획득용 도배성 활동은 운영 판단으로 제외
  - 제외 판정 3건 누적 시 리더보드 제외 가능
  - 비정상 패턴 검수 후 집계 제외

### 2.5 내부자 제외 SSOT
- 파일: `src/lib/events/leaderboard-exclusions.ts`
- 상수: `LEADERBOARD_INTERNAL_USER_IDS` (7명, 하린아빠 확정)
- 모든 리더보드 쿼리에서 `NOT IN` 필터 적용

## 3. 화면 구조

### 3.1 페이지 라우트
- **독립 페이지**: `/events/invite/leaderboard`
  - 이벤트 랜딩에서 "리더보드 보기" CTA로 연결
  - 다른 진입점(커뮤니티 배너, `/my` 카드)에서 동일 URL 링크
- **이벤트 페이지 하단 섹션**: `/events/invite` 페이지 하단에 `<LeaderboardPreview>` embed
  - Top 10만 노출 (2개 트랙 탭)
  - "전체 보기" → `/events/invite/leaderboard`

### 3.2 컴포넌트
```
LeaderboardPage
├── TrackTabs (초대 | 글쓰기)
├── LeaderboardTable
│   ├── RankRow (rank · nickname · team badge · score · 뱃지 미리보기)
│   └── MyRankSticky (로그인 유저의 내 순위 고정)
└── ScoreRulesCard (event-draft.html 포인트 룰 요약)
```

### 3.3 내 순위 표시
- 로그인 유저는 리스트 상단에 "내 순위: 23위 · 37pt" 스티키 카드
- 비로그인은 "로그인하고 내 순위 보기" CTA

## 4. 데이터

### 4.1 테이블 (신규 or 뷰)
- **뷰 우선 검토** (신규 테이블 지양):
  - `v_leaderboard_invite`: `profiles.invite_count` 기반 단순 집계
  - `v_leaderboard_writing`: `chat_messages` + `comments` + `posts` 이벤트 기간 window에서 포인트 합산
- 캐싱: `/api/leaderboard/{track}?limit=100` Next.js ISR 60초 or Supabase materialized view 15분 리프레시
- 이벤트 기간 종료 후 snapshot 테이블로 동결 (`leaderboard_final_invite`, `leaderboard_final_writing`)

### 4.2 포인트 계산 쿼리 (스케치)

```sql
-- 글쓰기 트랙: 일일 상한 반영 SUM
WITH daily AS (
  SELECT
    user_id,
    DATE(created_at AT TIME ZONE 'Asia/Seoul') AS day,
    LEAST(COUNT(*) FILTER (WHERE source = 'chat') * 1, 30)
      + LEAST(COUNT(*) FILTER (WHERE source = 'comment') * 2, 40)
      + LEAST(COUNT(*) FILTER (WHERE source = 'post' AND kind <> 'photo') * 3, 30)
      + LEAST(COUNT(*) FILTER (WHERE source = 'post' AND kind = 'photo') * 5, 50)
      AS raw_points
  FROM event_activity_log  -- 통합 뷰 or union
  WHERE created_at BETWEEN '2026-04-20' AND '2026-06-01'
  GROUP BY 1, 2
)
SELECT user_id, SUM(LEAST(raw_points, 150)) AS total_points
FROM daily
WHERE user_id NOT IN (SELECT user_id FROM leaderboard_exclusions)
GROUP BY user_id
ORDER BY total_points DESC
LIMIT 100;
```

> 실제 스키마 매핑은 구현 단계에서 확정. `event_activity_log` 뷰로 추상화 권장.

## 5. API

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/leaderboard/invite?limit=100` | 초대 트랙 Top N |
| GET | `/api/leaderboard/writing?limit=100` | 글쓰기 트랙 Top N |
| GET | `/api/leaderboard/my-rank?track=invite\|writing` | 로그인 유저 본인 순위 |

- `Cache-Control: s-maxage=60, stale-while-revalidate=120`
- 내부자 제외는 **쿼리에서** 적용 (API 응답 후 필터 금지 — 캐시 오염)

## 6. 구현 범위 (MVP)

### IN
1. `leaderboard-exclusions.ts` SSOT (✅ 작성 완료)
2. 글쓰기 포인트 집계 뷰/쿼리
3. 초대 집계 뷰 (invite_count 기반, 뱃지 조건 재사용 확인 필요)
4. `/events/invite/leaderboard` 페이지
5. `/events/invite` 하단 Top 10 프리뷰
6. `/api/leaderboard/*` 3개 엔드포인트
7. 내 순위 스티키 카드

### OUT (후순위)
- 주간 리더보드 (상금 없음)
- 팀별 리더보드 (2차)
- 실시간 WebSocket 업데이트 (ISR 60초로 충분)
- 푸시 알림 "순위 변동"

## 7. 오픈 이슈 — 전부 잠김 ✅ (2026-04-20 실측)

1. **초대 뱃지 부여 조건** ✅
   - `src/lib/supabase/invite-activation.ts`가 이미 SSOT: 팀 선택 + (글 OR 댓글) ≥ 1 → `activated_at` 기록 + 뱃지 부여
   - 리더보드는 `invitations.activated_at IS NOT NULL` 행만 집계 — 조건 재구현 NONE
2. **채팅 event window** ✅
   - `chat_messages(user_id, content, created_at, room_id)` — `created_at` 컴럼 인덱스 확인 후 기간 필터만 적용
   - 현재 전체 row 36건(이벤트 진입 전) → 5/31까지 누적도 큰 부담 없음
3. **사진글 구분** ✅
   - `posts.content_type` 엔서 `'photo'` vs `'general'` 등으로 구분 가능 (샘플 확인 완료)

## 8. 롤아웃 순서 (삼순이 GO 순서 반영)

1. **Task 0 리더보드** ← 본 문서 (이번 세션: Phase A+B)
   - Phase A: API route + UI 기본 페이지
   - Phase B: Supabase view + 인덱스 점검 (집계 신뢰도 핵심)
2. **Task 1** `/my` 상단 카드 (개인화 카운터 + 다음 목표 힌트) — *별도 세션*
3. Task 2 `/community` 상단 1줄 배너
4. Task 3 초대 공유 카피 자동 삽입 + `?from=invite` 랜딩 변주

## 9. 검증 체크리스트 (QA before GO)

- [ ] 내부자 7명 제외 확인 (SQL 수동 검증)
- [ ] 로그인/비로그인 양쪽 본인 순위 UX
- [ ] Mobile 375px 리스트 가독성
- [ ] 일일 상한 150pt cap 실제 적용 (하루에 채팅 100개 + 댓글 50개 시 150pt로 캡)
- [ ] 이벤트 기간 외 활동 (4/19 이전, 6/1 이후) 미집계
- [ ] 삭제된 계정 / 닉네임 변경 계정 정상 표시
