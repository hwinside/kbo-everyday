# 피드백 시스템 스펙

> 유저 피드백을 인앱 폼으로 수집 → Supabase DB 적재 → 유형별 자동화 처리

## 1. 목표

- 서비스/콘텐츠/데이터 오류 및 개선 요구사항을 **구조화된 형태**로 수집
- 이메일·카톡 대신 **인앱 폼** → 유저 진입장벽 최소화
- **에이전트(삼식이) 자동 분류 + 처리** → 운영 비용 ≈ 0
- 처리 상태 투명 공개 → 유저 참여 동기 부여

---

## 2. 피드백 유형

| 코드 | 유형 | 설명 | 자동화 수준 |
|------|------|------|------------|
| `bug` | 🐛 버그/오류 | 화면 깨짐, 크래시, 동작 이상 | TODO 자동등록 + 알림 |
| `data` | 📊 데이터 수정 | 선수 프로필/사진/응원가/스탯 오류 | 검증 후 자동 반영 가능 |
| `feature` | 💡 기능 제안 | 새 기능, UX 개선 | 중복 집계 + 투표 |
| `content` | 📝 콘텐츠 제보 | 뉴스, 하이라이트, 직찍 등 | 큐 적재 |
| `other` | 💬 기타 | 위에 해당 안 되는 모든 것 | 수동 확인 |

---

## 3. DB 스키마

### `feedback` 테이블

```sql
CREATE TABLE feedback (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  type TEXT NOT NULL CHECK (type IN ('bug', 'data', 'feature', 'content', 'other')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'reviewing', 'in_progress', 'resolved', 'rejected', 'duplicate')),
  title TEXT NOT NULL,
  body TEXT,
  metadata JSONB DEFAULT '{}',
  page_url TEXT,
  device_info TEXT,
  vote_count INT DEFAULT 0,
  admin_note TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_feedback_type ON feedback(type);
CREATE INDEX idx_feedback_status ON feedback(status);
CREATE INDEX idx_feedback_user ON feedback(user_id);
CREATE INDEX idx_feedback_created ON feedback(created_at DESC);
```

### `feedback_votes` 테이블

```sql
CREATE TABLE feedback_votes (
  feedback_id UUID REFERENCES feedback(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (feedback_id, user_id)
);
```

### RLS 정책

```sql
ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;

-- 읽기: 본인 피드백 + 처리완료 건 전체 공개
CREATE POLICY "feedback_read" ON feedback FOR SELECT USING (
  user_id = auth.uid()
  OR status IN ('resolved', 'rejected', 'duplicate')
);

-- 쓰기: 로그인 유저만
CREATE POLICY "feedback_insert" ON feedback FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "feedback_vote_insert" ON feedback_votes FOR INSERT
  WITH CHECK (user_id = auth.uid());
```

### `metadata` JSONB 구조 (유형별)

```jsonc
// bug
{ "steps": "재현 방법", "expected": "기대 결과", "actual": "실제 결과" }

// data
{ "player_id": "52605", "player_name": "김도영", "field": "profile.bio", "current": "...", "correct": "..." }

// feature
{ "screen": "player_detail", "mockup_url": null }

// content
{ "content_type": "cheer_song", "player_id": "52605", "source_url": "https://..." }
```

---

## 4. 인앱 UI

### 4-1. 진입점

| 위치 | 형태 |
|------|------|
| MY 페이지 | "📮 피드백 보내기" 메뉴 |
| 선수 프로필 하단 | "정보가 잘못됐나요?" 링크 (type=data 프리필) |
| 설정/앱 정보 | "버그 신고" 링크 (type=bug 프리필) |
| 커뮤니티 | "💡 건의함" 배너 |

### 4-2. 제출 폼 (`FeedbackSheet.tsx`)

바텀시트 형태. 기존 LoginSheet 패턴 재활용.

```
┌─────────────────────────────┐
│  📮 피드백 보내기            │
│                             │
│  유형 선택 (pill toggle)     │
│  [🐛 버그] [📊 데이터] [💡 제안] [💬 기타]  │
│                             │
│  제목 (필수)                 │
│  ┌─────────────────────┐    │
│  │                     │    │
│  └─────────────────────┘    │
│                             │
│  상세 설명 (선택)            │
│  ┌─────────────────────┐    │
│  │                     │    │
│  └─────────────────────┘    │
│                             │
│  [스크린샷 첨부 📷] (선택)   │
│                             │
│  ┌─────────────────────┐    │
│  │     보내기 ✉️        │    │
│  └─────────────────────┘    │
│                             │
│  * 처리 상태 알림을 받을 수 있어요 │
└─────────────────────────────┘
```

- **type=data**: 선수 검색 필드 추가 (PlayerSelectModal 재활용)
- **type=bug**: 현재 페이지 URL 자동 첨부
- 제출 후 토스트: "소중한 의견 감사합니다! 🙏"
- 스크린샷: 1장, Supabase Storage `feedback/` 버킷

### 4-3. 내 피드백 목록 (`/my/feedback`)

MY 페이지에서 접근. 본인 피드백 + 상태 확인.

상태 뱃지:
- `pending` → ⚪ 접수됨
- `reviewing` → 🟡 확인중
- `in_progress` → 🔵 처리중
- `resolved` → 🟢 반영완료
- `rejected` → ⚫ 반려
- `duplicate` → 🔘 중복

---

## 5. 자동화 파이프라인

### 5-1. 트리거

```
Vercel Cron (매 2시간) → /api/cron/feedback → 새 피드백 확인 → 처리
```

### 5-2. 유형별 자동 처리

#### 🐛 버그 (`bug`)
1. `memory/kbo-master-todo.md`에 자동 등록
2. 심각도 판단 (키워드: "크래시", "안 됨", "흰 화면" → 긴급)
3. 긴급 → 하린아빠 텔레그램 즉시 알림
4. 일반 → 주간 리포트에 포함

#### 📊 데이터 수정 (`data`)
1. `metadata.player_id` + `metadata.field`로 해당 데이터 조회
2. 팩트 체크 가능한 것 (등번호, 생년월일, 포지션) → **자동 수정**
3. 주관적인 것 (프로필 문구, TMI) → `reviewing` + 하린아빠 확인
4. 반영 시 → `resolved` + 유저 알림

#### 💡 기능 제안 (`feature`)
1. 기존 피드백 유사도 체크 (제목 키워드)
2. 유사 → `duplicate` + 원본 vote_count++
3. vote_count ≥ 5 → "인기 제안" 알림
4. 주간 Top 5 리포트

#### 📝 콘텐츠 제보 (`content`)
1. source_url 유효성 체크
2. content_type별 큐 적재 (응원가 → 크롤 큐, 직찍 → 갤러리 큐)

### 5-3. 주간 리포트 (토요일 오전)

```
📮 이번 주 피드백 요약
━━━━━━━━━━━━━━━━━━
접수: 23건 | 처리: 18건 | 미처리: 5건

🐛 버그 (8건) — 해결 6, 확인중 2
📊 데이터 (7건) — 자동 반영 5, 수동 2

💡 인기 제안 Top 3
  1. 구단별 승률 그래프 (투표 12)
  2. 선수 비교 기능 (투표 8)  
  3. 경기 알림 기능 (투표 6)
```

---

## 6. 뱃지 연동

| 뱃지 | 조건 | 아이콘 |
|------|------|--------|
| 첫 피드백 | 피드백 1회 제출 | 📮 |
| 피드백 히어로 | 피드백 5회 제출 | 🦸 |
| 데이터 수호자 | data 유형 3회 resolved | 🛡️ |
| 아이디어뱅크 | feature + vote_count ≥ 10 | 💡 |

---

## 7. 구현 순서

### Phase 1 — MVP (Day 1-2)
- [ ] Supabase `feedback` + `feedback_votes` 테이블
- [ ] `FeedbackSheet.tsx` 바텀시트 UI
- [ ] MY 페이지 "피드백 보내기" 진입점
- [ ] `/api/feedback` POST 엔드포인트
- [ ] 제출 성공 토스트

### Phase 2 — 자동화 (Day 3-4)
- [ ] Vercel Cron `/api/cron/feedback` (2시간 주기)
- [ ] 삼식이 자동 분류 + TODO 등록
- [ ] 긴급 버그 텔레그램 알림
- [ ] 데이터 수정 자동 검증 로직

### Phase 3 — 유저 경험 (Day 5-6)
- [ ] `/my/feedback` 내 피드백 목록
- [ ] 상태 변경 알림
- [ ] 선수 프로필 하단 "정보 수정 요청" 링크
- [ ] 기능 제안 투표
- [ ] 뱃지 연동

### Phase 4 — 고도화
- [ ] 스크린샷 첨부
- [ ] 주간 리포트 자동 발송
- [ ] 데이터 수정 자동 반영 파이프라인
- [ ] 공개 로드맵 페이지

---

## 8. 보안

- 로그인 필수 (auth.uid() NOT NULL), rate limit 유저당 10건/일
- 스팸 방지: 기존 AI content-filter 재활용
- 개인정보 피드백 → RLS로 본인만 열람
- admin_note → 서버 사이드에서만 수정
