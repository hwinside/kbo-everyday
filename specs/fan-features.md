# 팬 특화 기능 스펙 — 하린엄마 제안

> 타겟: 20대 여성 팬, 선수 덕질 문화, 직관 문화

---

## 1. 티켓 양도 게시판 🎫 (P0 — 1순위)

### 왜?
- "이 앱 깔면 양도표 구할 수 있어" = 가장 강력한 설치 동기
- 팀별 카페에서 흩어져있는 양도 정보를 한 곳에
- 구장 가이드와 자연스러운 동선 연결

### 위치
- 구장 가이드 (`/stadium/[venueId]`) 내 "티켓 양도" 탭

### 데이터 모델
```sql
CREATE TABLE ticket_transfers (
  id BIGSERIAL PRIMARY KEY,
  author_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  team_id INT NOT NULL,
  venue_id TEXT NOT NULL,
  game_date DATE NOT NULL,
  opponent_team_id INT,
  seat_area TEXT NOT NULL,        -- "1루 응원석", "외야 자유석" 등
  seat_detail TEXT,               -- "블록 305 열 12"
  quantity INT NOT NULL DEFAULT 1,
  price INT NOT NULL,             -- 원 단위
  original_price INT,             -- 정가 (비교용)
  status TEXT DEFAULT 'open',     -- open, reserved, sold, expired
  contact_method TEXT NOT NULL,   -- "카톡 오픈채팅", "댓글" 등
  contact_info TEXT,              -- 오픈채팅 링크 등
  description TEXT,
  image_urls JSONB DEFAULT '[]',  -- 좌석뷰 사진 등
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ          -- 경기 시작시간
);

ALTER TABLE ticket_transfers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read" ON ticket_transfers FOR SELECT USING (true);
CREATE POLICY "Auth users create" ON ticket_transfers FOR INSERT WITH CHECK (auth.uid() = author_id);
CREATE POLICY "Authors update own" ON ticket_transfers FOR UPDATE USING (auth.uid() = author_id);

CREATE INDEX idx_tickets_team ON ticket_transfers(team_id, game_date DESC);
CREATE INDEX idx_tickets_venue ON ticket_transfers(venue_id, game_date DESC);
```

### UI
- 리스트: 카드형 (경기일 / 상대팀 / 좌석 / 가격 / 상태)
- 필터: 날짜 / 좌석 구역 / 가격대
- 글쓰기: 경기 선택 → 좌석/가격/연락처 입력
- 상태 뱃지: 🟢양도중 / 🟡예약중 / 🔴완료
- 가격 비교: 정가 대비 ↑↓ 표시
- 경기 자동 만료 (경기 시작 후 자동 expired)

### 안전장치
- 로그인 필수 (게시/연락)
- 신고 버튼
- 가격 상한 경고 (정가의 150% 이상 시)
- 거래는 외부 (카톡 등) — 우리는 매칭만

---

## 2. 직찍 게시판 📸 (P1 — 2순위)

### 왜?
- 선수 덕질의 핵심 = 직관에서 찍은 선수 사진 공유
- 콘텐츠 자생산 → 유저가 콘텐츠를 만듦 → 다른 유저가 보러 옴

### 위치
- 선수 게시판 (`/boards/players/[playerId]`) 내 "직찍" 탭
- 또는 독립 갤러리: `/gallery/[playerId]`

### 데이터 모델
```sql
-- posts 테이블 재활용
-- board_type = 'photo'
-- board_id = playerId
-- image_urls 필수 (최소 1장)
-- title 선택적 ("3월 2일 잠실 직관 직찍")
```

### UI
- 그리드 레이아웃 (2~3열, 정사각형 썸네일)
- 탭으로 전환: 글 | 직찍
- 사진 탭: 무한 스크롤 그리드
- 사진 클릭 → 풀스크린 + 좌우 스와이프
- 좋아요 + 댓글 가능
- 워터마크 옵션 ("@ 닉네임" 자동 삽입)

### 규칙
- 사진 필수 (텍스트만은 "글" 탭에)
- 본인 촬영 권장 (타인 직찍 무단 전재 신고)
- 이미지 최적화: 클라이언트에서 리사이즈 후 업로드

---

## 3. 야구 룰 튜토리얼 ⚾ (P2 — 3순위)

### 왜?
- 신규 팬 진입장벽 낮추기
- "야구 처음인데 뭐부터 봐야 해?" → 앱에서 해결
- 시즌 개막 직전 오픈하면 효과 극대

### 위치
- MY 페이지 또는 홈 배너에서 진입
- `/learn` 또는 `/tutorial`

### 콘텐츠 구성

**기초편 (5분)**
1. 야구 경기의 목표 (점수 많이 내면 이김)
2. 이닝이란? (9회, 공수 교대)
3. 타자 vs 투수
4. 스트라이크 / 볼 / 아웃
5. 안타 종류 (1루타 ~ 홈런)

**중급편 (10분)**
6. 포지션 9개 설명 (그라운드 일러스트)
7. 도루 / 희생번트 / 더블플레이
8. ERA, 타율, OPS 뜻
9. 지명타자(DH) 규칙
10. 클린업 트리오, 선발/중계/마무리

**직관편 (5분)**
11. 응원가 문화
12. 치어리더
13. 구장 에티켓
14. 먹거리 추천 (→ 구장 가이드 연결)

### UI
- 카드 슬라이드 (틴더 스타일) 또는 세로 스크롤
- 일러스트 + 짧은 텍스트 (max 3줄)
- 애니메이션 GIF로 동작 설명
- 진행률 바
- "다 배웠어요!" 완료 시 뱃지 부여 (🎓 야구학도)

### 구현
- 정적 콘텐츠 (DB 불필요)
- MDX 또는 하드코딩
- 일러스트: AI 생성 or 무료 소스

---

## 구현 우선순위 & 타임라인

| 순위 | 기능 | 난이도 | 예상 기간 | 시너지 |
|------|------|--------|-----------|--------|
| P0 | 티켓 양도 | 중 | 2-3일 | 설치 동기 #1 |
| P1 | 직찍 갤러리 | 중 | 1-2일 | 콘텐츠 자생산 |
| P2 | 야구 룰 | 하 | 1일 | 신규 유저 확대 |

### 의존성
- 티켓 양도: Supabase 테이블 추가 + 새 UI
- 직찍: 기존 posts 테이블 + board_type='photo' + 그리드 UI
- 야구 룰: 독립 (데이터 불필요)

---

*Spec by 삼식이 + 하린엄마 (2026-03-02)*

---

## 🎴 예측 공유 카드 (Spotify Wrapped 스타일)

### 개요
- 예측 확정 시 "나의 예측" 카드 이미지 생성 → IG 스토리/SNS 공유
- 바이럴 성장 엔진: 유저가 자발적으로 앱 홍보

### Phase 1: 경기별 예측 카드
- 예측 확정 시 1080x1920 카드 생성
- 내용: 팀 로고, 예측 선택, 유저 닉네임, 날짜
- 경기 종료 후: 적중/실패 결과 카드 (🎯 or 💀)
- Web Share API → IG 스토리, 카카오톡, 트위터

### Phase 2: 시즌 Wrapped
- 시즌 종료 시 (또는 월별) 개인 통계 영상/카드
- 내용:
  - 총 예측 수 / 적중률
  - 최장 연속 적중 기록
  - 가장 많이 예측한 팀
  - "당신의 야구 감은 상위 N%"
  - 명예 칭호 부여 ("신들린 예언가" / "역배 매니아")
- 슬라이드 형식 (3-5장) or 애니메이션 영상

### 기술 스택
- `html2canvas` or `@vercel/og` (이미지 생성)
- Canvas API (애니메이션 영상)
- Web Share API (모바일 공유)
- `navigator.share({ files: [blob] })` → IG 스토리 직접

### 우선순위: P1 (시즌 개막 전 경기별 카드, Wrapped는 시즌 중반)
