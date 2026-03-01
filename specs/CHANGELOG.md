# 크보 에브리데이 — 변경 이력

## 2026-02-28 (Day 1)

### 신규 기능 (기획서 미포함 사항)
- **인기 선수게시판 랭킹** (`/boards/players`) — 게시글 수 기준 선수 인기 순위, 팬 경쟁 유도
- **선수 개별 게시판** (`/boards/players/[playerId]`) — 선수별 전용 게시판 (최신/인기 탭, 글쓰기 FAB)
- **홈 화면 "인기 선수게시판" 섹션** — Top 5 선수, 오늘 게시글 수, 트렌드 표시
- **타자/투수 타이틀 순위** — 순위 페이지에 구단순위 외 타자(타율/홈런/타점/안타/도루), 투수(ERA/다승/탈삼진/세이브/홀드) TOP 5 추가
- **선수 사진 placeholder** — 팀 컬러 원형 + 이름 첫 글자 + 미니 팀 로고 뱃지 (추후 실사진 교체 대비)

### UI/UX 변경
- **다크모드 강제 적용** — `prefers-color-scheme: light` 미디어쿼리 제거, body에 배경색 직접 지정
- **경기 카드 크기 통일** — 200x150px 고정, 예정 경기 점수 "-" 표시
- **스탯 테이블 개선** — sticky header(상단 고정) + sticky left column(선수명 고정), 배경색 #141416
- **구단 로고 적용** — 스탯티즈 SVG 10개, 모든 화면에서 실제 로고 표시

### 인프라
- PWA manifest + Service Worker
- GitHub: https://github.com/hwinside/kbo-everyday
- Vercel: https://kboeveryday.vercel.app/

## Day 2 (2026-03-01)
### 선수 사진 연결
- player-photos.ts: 146명 이름→KBO playerId 매핑
- getPlayerPhotoUrl() → PlayerAvatar 7곳 적용
- 9명 미매핑 (MLB/군복무): 김도영, 이정후, 나성범, 김하성, 안우진, 이의리, 정우영, 고우석, 이승현

### 가독성 대폭 개선 (2차)
- 텍스트: xs→sm, sm→base, base→lg (전체 40파일)
- PlayerAvatar +8px, 팀 로고 한 단계 업, 아이콘 +4px
- 간격/패딩 넉넉하게 (Yahoo Fantasy 참고)

### 새 페이지/기능
- 게시글 상세: /boards/players/[playerId]/posts/[postId] (댓글, 좋아요, 공유)
- 글쓰기 사진 업로드 (최대 5장, 미리보기)
- 순위 테이블 → 팀 페이지 링크

### UI 개선
- 라인업 선수 사진 제거 (답답함 해소)
- 게임 상세 전체 스크롤 (sticky 상단 해제)
- P/AB, 팀명 줄바꿈 방지 (whitespace-nowrap)
- 인기 선수게시판 간격 확대 (space-y-8)
- 게임 카드 높이 160→190px

### 기획
- 수익화 전략 문서 (constitution.md에 추가)
- 다크모드 고정 결정

### 빌드/배포
- Vercel URL 변경: kboeveryday → kbo-everyday
- 빌드 에러 수정 (getTeamColor import)
