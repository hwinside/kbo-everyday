# 초대 시스템 v2 — Spec

> 확정일: 2026-04-09
> 결정자: 하린아빠 (#product 스레드)
> 상태: SPECIFIED → 구현 대기

---

## 1. 개요

기존 초대 시스템(invitations 테이블 + invite_count)을 확장하여,
**활성화 기준 카운트 + 성과형 리필 + 티어 뱃지 + 시즌 한정 배지**를 추가한다.

### 핵심 변경점
| 항목 | AS-IS | TO-BE |
|------|-------|-------|
| 초기 코드 수 | 3개 | 5개 |
| 카운트 기준 | 가입 (invitee_id 연결) | **활성화** (팀 선택 + 첫 글/댓글) |
| 리필 | 없음 | 소진 시 다음날 +3 (조건: 활성화 초대 ≥1) |
| 뱃지 티어 | 1/3/10/30 | 1/5/10/30/50 |
| 시즌 한정 배지 | 없음 | **초기 개척자** (6월말까지 활성화 20명) |
| 어뷰징 방지 | 없음 | 동일 디바이스 fingerprint/IP 제한 |

---

## 2. 용어 정의

- **초대코드**: `KBO-XXXXXX` 형식, 6자 영숫자
- **활성화**: 초대받은 유저가 ① team_id 설정 + ② 첫 글 또는 댓글 작성 완료
- **활성화 초대 수**: inviter 기준, 활성화된 invitee 수 (뱃지·리필 판정에 사용)
- **리필**: 보유 코드 0개 + 활성화 초대 ≥1 → 다음 00:00 KST에 +3개 지급

---

## 3. DB 변경

### 3.1 invitations 테이블 — 컬럼 추가

```sql
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;
-- invitee가 활성화 조건 충족 시 타임스탬프 기록
```

### 3.2 profiles 테이블 — 기본값 변경

```sql
-- 신규 가입자 초대권 5개 (기존 3 → 5)
ALTER TABLE profiles ALTER COLUMN invite_count SET DEFAULT 5;
```

### 3.3 invite_refill_log 테이블 (신규)

```sql
CREATE TABLE invite_refill_log (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  refilled_count INT NOT NULL DEFAULT 3,
  refilled_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE invite_refill_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own" ON invite_refill_log FOR SELECT USING (auth.uid() = user_id);
CREATE INDEX idx_refill_user ON invite_refill_log(user_id);
```

### 3.4 invite_abuse_check 테이블 (신규, 어뷰징 방지)

```sql
CREATE TABLE invite_abuse_check (
  id BIGSERIAL PRIMARY KEY,
  invitee_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  fingerprint TEXT, -- 디바이스 fingerprint (클라이언트 생성)
  ip_address INET,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE invite_abuse_check ENABLE ROW LEVEL SECURITY;
-- service_role만 insert/read (클라이언트 직접 접근 금지)
CREATE INDEX idx_abuse_fp ON invite_abuse_check(fingerprint);
CREATE INDEX idx_abuse_ip ON invite_abuse_check(ip_address);
```

---

## 4. 활성화 판정 로직

### 트리거 시점
invitee가 **첫 글 또는 댓글을 작성**할 때 (posts INSERT / comments INSERT 트리거)

### 판정 조건
1. `profiles.team_id IS NOT NULL` (팀 선택 완료)
2. `profiles.invited_by IS NOT NULL` (초대코드로 가입)
3. 해당 유저의 글+댓글 합계가 1 이상 (첫 활동)
4. 아직 `invitations.activated_at IS NULL`

### 실행
```
→ invitations.activated_at = now()
→ inviter의 활성화 초대 수 재계산
→ badge-engine 호출 (inviter에 대해)
```

### 구현 방식
Supabase Database Function + Trigger (posts/comments INSERT 후 실행)
또는 Next.js API에서 글/댓글 작성 시 후처리로 호출

---

## 5. 리필 로직

### 조건
- `profiles.invite_count = 0`
- 활성화 초대 수 ≥ 1
- 오늘 리필 이력 없음 (`invite_refill_log`에 오늘 날짜 없음)

### 실행
- Supabase cron (pg_cron) 또는 Vercel cron: 매일 00:05 KST
- 조건 충족 유저에게 `invite_count += 3`, `invite_refill_log` INSERT

### 대안 (Lazy 방식)
API 호출 시 (코드 생성/조회) 리필 조건 체크 → 즉시 리필
→ cron 없이 동작, 단 유저가 접속 안 하면 리필 안 됨 (문제 없음)

**추천: Lazy 방식** (인프라 단순)

---

## 6. 뱃지 변경

### 초대 뱃지 티어 업데이트

| badge_id | AS-IS | TO-BE |
|----------|-------|-------|
| inviter-1 | 1명 | 1명 (유지) |
| inviter-3 | 3명 | **삭제** |
| inviter-5 | - | **신규** 5명 |
| inviter-10 | 10명 | 10명 (유지) |
| inviter-30 | 30명 | 30명 (유지) |
| inviter-50 | - | **신규** 50명 |

### 신규: 초기 개척자 배지

```ts
{
  id: "pioneer-2026",
  name: "초기 개척자",
  icon: "🏴",
  description: "2026년 6월까지 20명 초대 달성",
  category: "season",
  rarity: "legendary"
}
```

- 조건: `activated invite count ≥ 20` AND `earned_at ≤ 2026-06-30 23:59:59 KST`
- badge-engine에서 날짜 체크 포함

### badge-engine.ts 변경
- `inviteCount` 기준을 `activated invite count`로 변경
- `inviter-3` → `inviter-5`, `inviter-50` 추가
- `pioneer-2026` 룰 추가 (날짜 조건 포함)

### badges.ts 상수 변경
- `inviter-3` 제거, `inviter-5` / `inviter-50` / `pioneer-2026` 추가
- `ACTIVE_BADGE_IDS`에 신규 뱃지 추가

---

## 7. 어뷰징 방지

### 원칙: 자동 차단 ❌ → 카운트 보류 + 수동 검토 ✅
완벽 차단은 불가능하고 오탐 리스크가 크므로, 의심 건은 **활성화 카운트 보류** 처리 후 어드민이 검토.

### 가입 시점 체크 (초대코드 사용 시)
1. **fingerprint 중복**: 같은 fingerprint로 이미 초대 가입한 계정이 있으면 → 활성화 카운트 보류 (`invitations.flagged = true`)
2. **IP 제한**: 같은 IP에서 24시간 내 3건 이상 초대 가입 시 → 카운트 보류
3. **자기 초대 차단**: inviter_id = invitee_id 불가 (이미 구조적으로 방지)

보류된 건은 어드민 대시보드에서 승인/거부 처리.

### fingerprint
- 클라이언트: `@fingerprintjs/fingerprintjs` (무료 오픈소스) — 브라우저 canvas/WebGL/폰트 조합으로 device id 생성, 쿠키 삭제해도 유지
- PWA/웹 기반이라 ADID/IDFA는 사용 불가
- 서버: 가입 시 fingerprint + IP를 `invite_abuse_check`에 저장

---

## 8. API 변경

### POST /api/invite (코드 생성)
- 리필 체크 추가 (Lazy 리필)
- `invite_count` 차감 로직 유지

### GET /api/invite (현황 조회)
- 응답에 `activatedCount` 추가
- `invitations`에서 `activated_at IS NOT NULL` 카운트

### POST /api/invite/use (코드 사용 — 가입 시)
- fingerprint + IP 어뷰징 체크
- `invitations.invitee_id` + `profiles.invited_by` 설정

### POST /api/invite/activate (활성화 체크 — 글/댓글 작성 후)
- 또는 기존 글/댓글 작성 API에 후처리로 통합

---

## 9. UI 변경 (참고, 별도 태스크)

- 프로필 > 초대 섹션: 잔여 코드 수, 활성화/미활성화 구분 표시
- 코드 공유 시 "친구가 팀 선택 + 첫 글 작성하면 초대 완료!" 안내
- 초기 개척자 배지: 프로필 뱃지탭 + 초대 섹션에 진행률 표시

---

## 10. 구현 순서

1. DB migration SQL 작성 (3.1~3.4)
2. badge-engine.ts + badges.ts 상수 업데이트 (6)
3. /api/invite 리팩토링 (활성화 기준 + 리필 + 어뷰징) (8)
4. 글/댓글 작성 후 활성화 판정 훅 (4)
5. UI 업데이트 (9)
6. 삼순이 코드리뷰 → 하린아빠 push 승인

---

## 11. 확정 사항 요약

| 항목 | 결정 |
|------|------|
| 초기 코드 | 5개 |
| 카운트 기준 | 활성화 (팀 선택 + 첫 글/댓글) |
| 리필 | 소진 + 활성화 1건+ → 다음날 3개 (Lazy) |
| 뱃지 티어 | 1/5/10/30/50 |
| 초기 개척자 | 6월까지 활성화 20명, legendary |
| 어뷰징 | fingerprint + IP 제한 |
| 활성화에 '예측' 포함 | 제외 (미구현) |
