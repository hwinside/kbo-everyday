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
