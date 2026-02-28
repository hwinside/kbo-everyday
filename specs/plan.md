# 크보 에브리데이 — Implementation Plan

## 📁 프로젝트 구조

```
kbo-everyday/
├── specs/                          # 스펙 문서 (현재)
├── src/
│   ├── app/                        # Next.js App Router
│   │   ├── layout.tsx              # 루트 레이아웃 (다크모드, 폰트, 메타)
│   │   ├── page.tsx                # 홈 화면
│   │   ├── (auth)/
│   │   │   ├── login/page.tsx      # 로그인
│   │   │   └── onboarding/page.tsx # 온보딩 (닉네임→마이팀→프로필)
│   │   ├── (main)/                 # 탭 바 레이아웃 그룹
│   │   │   ├── layout.tsx          # 하단 탭 바
│   │   │   ├── page.tsx            # 🏠 홈
│   │   │   ├── games/
│   │   │   │   ├── page.tsx        # ⚾ 오늘의 경기 목록
│   │   │   │   └── [gameId]/
│   │   │   │       └── page.tsx    # 경기 트래커 + 실시간 채팅
│   │   │   ├── standings/
│   │   │   │   └── page.tsx        # 📊 순위표
│   │   │   ├── teams/
│   │   │   │   ├── [teamId]/
│   │   │   │   │   ├── page.tsx    # 구단 게시판
│   │   │   │   │   └── players/
│   │   │   │   │       └── [playerId]/
│   │   │   │   │           └── page.tsx  # 선수 게시판 + 스탯
│   │   │   ├── predict/
│   │   │   │   ├── page.tsx        # 승부예측 목록
│   │   │   │   └── leaderboard/
│   │   │   │       └── page.tsx    # 리더보드
│   │   │   ├── news/
│   │   │   │   └── page.tsx        # 뉴스 & 콘텐츠 피드
│   │   │   └── my/
│   │   │       └── page.tsx        # 👤 마이페이지
│   │   └── api/                    # API Routes (필요 시)
│   │       └── cron/
│   │           ├── crawl-games/route.ts
│   │           ├── crawl-news/route.ts
│   │           └── crawl-stats/route.ts
│   ├── components/
│   │   ├── ui/                     # 공통 UI
│   │   │   ├── GlassCard.tsx
│   │   │   ├── TeamBadge.tsx
│   │   │   ├── LevelBadge.tsx
│   │   │   ├── TabBar.tsx
│   │   │   ├── SkeletonCard.tsx
│   │   │   ├── PullToRefresh.tsx
│   │   │   └── EmptyState.tsx
│   │   ├── game/                   # 경기 트래커
│   │   │   ├── ScoreBoard.tsx
│   │   │   ├── Diamond.tsx
│   │   │   ├── CountIndicator.tsx
│   │   │   ├── PlayByPlay.tsx
│   │   │   ├── RadioPlayer.tsx
│   │   │   └── GameChat.tsx
│   │   ├── stats/                  # 스탯 인포그래픽
│   │   │   ├── PlayerStatCard.tsx
│   │   │   ├── RadarChart.tsx
│   │   │   ├── TrendChart.tsx
│   │   │   ├── TeamDashboard.tsx
│   │   │   └── TeamCompare.tsx
│   │   ├── community/              # 게시판
│   │   │   ├── PostList.tsx
│   │   │   ├── PostCard.tsx
│   │   │   ├── PostDetail.tsx
│   │   │   ├── CommentList.tsx
│   │   │   ├── WritePost.tsx
│   │   │   └── ChatMessage.tsx
│   │   ├── prediction/             # 승부예측
│   │   │   ├── PredictionCard.tsx
│   │   │   ├── PredictionResult.tsx
│   │   │   └── Leaderboard.tsx
│   │   ├── news/                   # 뉴스 피드
│   │   │   ├── NewsFeed.tsx
│   │   │   ├── NewsCard.tsx
│   │   │   └── VideoCard.tsx
│   │   └── auth/                   # 인증
│   │       ├── LoginButtons.tsx
│   │       └── OnboardingSteps.tsx
│   ├── lib/
│   │   ├── supabase/
│   │   │   ├── client.ts           # 브라우저 클라이언트
│   │   │   ├── server.ts           # 서버 클라이언트
│   │   │   └── middleware.ts       # Auth 미들웨어
│   │   ├── crawlers/
│   │   │   ├── game-crawler.ts     # 경기 데이터 크롤링
│   │   │   ├── news-crawler.ts     # 뉴스 크롤링
│   │   │   ├── stats-crawler.ts    # 스탯 크롤링
│   │   │   └── youtube.ts          # YouTube API
│   │   ├── constants/
│   │   │   ├── teams.ts            # 10개 구단 데이터
│   │   │   └── levels.ts           # 레벨/칭호/포인트
│   │   ├── hooks/
│   │   │   ├── useRealtimeChat.ts
│   │   │   ├── useGameState.ts
│   │   │   ├── useAuth.ts
│   │   │   └── usePrediction.ts
│   │   ├── utils/
│   │   │   ├── date.ts
│   │   │   ├── points.ts           # 포인트 계산
│   │   │   └── format.ts
│   │   └── types/
│   │       └── index.ts            # 전체 타입 정의
│   └── styles/
│       └── globals.css             # Tailwind + CSS 변수 + 폰트
├── public/
│   ├── logos/                      # 팀 로고 (10개)
│   ├── icons/                      # 야구 테마 아이콘
│   └── fonts/                      # Pretendard
├── supabase/
│   ├── migrations/                 # DB 마이그레이션
│   │   ├── 001_teams.sql
│   │   ├── 002_users.sql
│   │   ├── 003_players.sql
│   │   ├── 004_posts_comments.sql
│   │   ├── 005_games.sql
│   │   ├── 006_predictions.sql
│   │   └── 007_news.sql
│   └── seed.sql                    # 10개 구단 + 선수 초기 데이터
├── capacitor.config.ts             # Capacitor 설정
├── next.config.ts
├── tailwind.config.ts
├── package.json
└── tsconfig.json
```

## 🔄 구현 순서

### M1: 기반 셋업 (2~3일)

**Day 1: 프로젝트 초기화 + Supabase + Auth**
1. `npx create-next-app@latest` (App Router, TypeScript, Tailwind)
2. Supabase 프로젝트 생성 + 환경변수
3. DB 마이그레이션 실행 (teams, users, players)
4. 팀 데이터 시드 (10개 구단 + 컬러 + 로고)
5. Supabase Auth 설정 (카카오, 구글, 애플 provider)
6. 로그인 페이지 + 온보딩 플로우
7. Auth 미들웨어 (보호된 라우트)

**Day 2: 디자인 시스템 + 레이아웃**
1. globals.css: CSS 변수, 다크/라이트 모드
2. Pretendard 폰트 설정
3. 공통 컴포넌트: GlassCard, TeamBadge, LevelBadge, TabBar
4. 하단 탭 바 레이아웃 (홈/경기/순위/MY)
5. 홈 화면 스켈레톤

**Day 3: 구단별 게시판**
1. DB 마이그레이션 (posts, comments, likes, reports)
2. RLS 정책 설정
3. 구단 목록 → 구단 게시판 페이지
4. PostList, PostCard, PostDetail, CommentList
5. 글쓰기 (WritePost) + 이미지 업로드 (Supabase Storage)
6. 좋아요 + 신고 기능
7. 인기글/최신글 정렬

### M2: 선수 + 스탯 (2~3일)

**Day 4: 선수 데이터 + 선수별 게시판**
1. 선수 데이터 크롤링 + DB 시드 (10개 구단 전 로스터)
2. 선수 프로필 카드 컴포넌트
3. 팀 → 선수 목록 → 선수 게시판 라우팅
4. 선수별 게시판 (상단 프로필 카드 고정)

**Day 5: 스탯 인포그래픽**
1. player_season_stats, player_game_stats 크롤링
2. Nivo 레이더 차트 (선수 능력치)
3. Recharts 라인 차트 (최근 추이)
4. 팀 스탯 대시보드
5. 팀 비교 기능
6. 순위표 페이지

### M3: 실시간 경기 (3~4일)

**Day 6: 경기 데이터 + 트래커 UI**
1. games, game_innings, game_plays, game_state 마이그레이션
2. 경기 크롤러 구현 (네이버 스포츠)
3. 오늘의 경기 목록 페이지
4. ScoreBoard 컴포넌트 (이닝별 점수)
5. Diamond 컴포넌트 (SVG 비주얼 다이아몬드)
6. CountIndicator 컴포넌트

**Day 7: 문자 중계 + 라디오 + 실시간**
1. PlayByPlay 컴포넌트 (문자 중계)
2. RadioPlayer 컴포넌트 (오디오 스트리밍)
3. Supabase Realtime 연동 (game_state, game_plays)
4. 경기 트래커 통합 레이아웃

**Day 8: 실시간 채팅**
1. GameChat 컴포넌트 (실시간 채팅형 게시판)
2. Supabase Realtime 채팅 구독
3. 팀 플레어 표시
4. 도배 방지 (3초 쿨타임)
5. 통합 테스트: 트래커 + 중계 + 채팅

### M4: 승부예측 + 뉴스 + 광고 (2~3일)

**Day 9: 승부예측**
1. predictions, prediction_summary, user_streaks 마이그레이션
2. PredictionCard (예측 투표 UI)
3. 예측 비율 실시간 업데이트
4. 정산 로직 (Edge Function / Cron)
5. PredictionResult (결과 + 포인트)
6. 레벨 시스템 + 뱃지
7. Leaderboard 페이지

**Day 10: 뉴스 피드**
1. news_articles, youtube_videos 마이그레이션
2. 뉴스 크롤러 (네이버 스포츠)
3. YouTube API 연동
4. NewsFeed, NewsCard, VideoCard 컴포넌트
5. 팀 필터 + 마이팀 우선

**Day 11: 광고 + 홈 화면 완성**
1. AdSense 연동 (웹)
2. 광고 컴포넌트 (피드 사이 네이티브 광고)
3. 홈 화면 조립: 오늘의 경기 + 승부예측 + 뉴스 + 인기글
4. 전체 모션/애니메이션 적용
5. View Transitions 적용

### M5: PWA + 앱 + 배포 (1~2일)

**Day 12: PWA + Capacitor**
1. PWA manifest + Service Worker
2. Capacitor 초기화 + 플러그인
3. iOS 빌드 테스트
4. Android 빌드 테스트
5. 푸시 알림 설정 (Capacitor Push Notifications)

**Day 13: 배포 + QA**
1. Vercel 배포 설정
2. Vercel Cron 설정 (크롤러 스케줄)
3. 도메인 연결 (Cloudflare)
4. 전체 QA: 모바일/PC/앱
5. Core Web Vitals 체크
6. 베타 출시 🚀

## 🔗 의존성 그래프

```
M1 (기반)
 ├── Auth ← 모든 기능의 전제
 ├── 디자인 시스템 ← 모든 UI의 전제
 └── 게시판 기본 ← M2, M3 채팅의 기반
      │
M2 (선수+스탯) ← M1 완료 후
 ├── 선수 데이터 ← 선수별 게시판, 스탯의 전제
 └── 스탯 차트 ← 독립적
      │
M3 (실시간) ← M1 게시판 기반 필요
 ├── 크롤러 ← 트래커, 채팅의 전제
 ├── 트래커 UI ← 독립적
 └── 채팅 ← 게시판 구조 재사용
      │
M4 (예측+뉴스+광고) ← M1 Auth 필요
 ├── 승부예측 ← 경기 데이터 (M3)
 ├── 뉴스 ← 독립적
 └── 광고 ← 독립적
      │
M5 (배포) ← 전체 완료 후
```

## 🤖 서브에이전트 병렬화 전략

동시에 작업 가능한 부분:
- **Agent A** (프론트): 디자인 시스템 + UI 컴포넌트
- **Agent B** (백엔드): Supabase 마이그레이션 + Auth + RLS
- **Agent C** (데이터): 크롤러 + 시드 데이터

M3 이후에는:
- **Agent A**: 트래커 UI + 채팅 UI
- **Agent B**: Realtime 구독 + 크롤러 스케줄
- **Agent C**: 승부예측 로직 + 뉴스 크롤러

## ✅ 완료 기준
- [ ] 소셜 로그인 + 온보딩 정상 동작
- [ ] 10개 구단 게시판 CRUD
- [ ] 전 선수 게시판 + 프로필 카드 + 스탯 차트
- [ ] 실시간 경기 트래커 (스코어+다이아몬드+문자중계+라디오)
- [ ] 실시간 채팅 (WebSocket)
- [ ] 승부예측 + 포인트 + 레벨 + 리더보드
- [ ] 뉴스/유튜브 피드
- [ ] 광고 연동
- [ ] PWA + iOS/Android 빌드
- [ ] Vercel 배포 + 도메인
- [ ] Core Web Vitals 통과


## Day 1 추가 구현 (기획서 외)

### 선수게시판 랭킹 시스템
- `/boards/players` — 게시글 수 기준 인기 선수 랭킹 (금/은/동, 오늘 글 수, 총 글 수, 트렌드)
- `/boards/players/[playerId]` — 선수별 전용 게시판 (최신/인기 탭, 팀 컬러 테마)
- 홈 화면 "인기 선수게시판" 섹션 (Top 5 + 전체보기 링크)
- 팬 경쟁 유도: 누가 더 많이 쓰는지 시각화

### 타자/투수 타이틀 순위
- 순위 페이지 3탭: 구단 순위 | 타자 타이틀 | 투수 타이틀
- 타자: 타율, 홈런, 타점, 안타, 도루 (각 TOP 5)
- 투수: 평균자책, 다승, 탈삼진, 세이브, 홀드 (각 TOP 5)
- 선수 사진 placeholder (팀 컬러 + 이름 첫 글자 + 미니 팀 로고)

### UI/UX 개선
- 다크모드 강제 적용 (시스템 설정 무시)
- 경기 카드 크기 통일 (200x150px)
- 스탯 테이블 sticky header + sticky column
- 10개 구단 공식 SVG 로고 적용
