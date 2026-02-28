# 실시간 경기 트래커 — Spec

## 데이터 모델

### games
| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | varchar(20) (PK) | 날짜+팀코드 (20260329-LG-DS) |
| date | date | 경기 날짜 |
| time | time | 경기 시작 시간 |
| home_team_id | int (FK) | 홈팀 |
| away_team_id | int (FK) | 원정팀 |
| status | enum | 'scheduled', 'live', 'final', 'postponed' |
| inning | varchar(10) | 현재 이닝 ("5회말") |
| home_score | int | |
| away_score | int | |
| stadium | varchar(30) | 구장명 |
| updated_at | timestamptz | |

### game_innings
| 컬럼 | 타입 | 설명 |
|------|------|------|
| game_id | varchar(20) (FK) | |
| inning | int | 1~12+ |
| top_score | int | 초 (원정) |
| bottom_score | int | 말 (홈) |

### game_plays (문자 중계)
| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | bigserial (PK) | |
| game_id | varchar(20) (FK) | |
| inning | varchar(10) | "5회말" |
| sequence | int | 이닝 내 순서 |
| description | text | "오스틴 좌전 적시타 (1타점)" |
| is_highlight | boolean | 홈런, 득점, 더블플레이 등 |
| batter | varchar(20) | 타자명 |
| pitcher | varchar(20) | 투수명 |
| created_at | timestamptz | |

### game_state (현재 상태)
| 컬럼 | 타입 | 설명 |
|------|------|------|
| game_id | varchar(20) (PK, FK) | |
| balls | int | 볼 카운트 (0~3) |
| strikes | int | 스트라이크 (0~2) |
| outs | int | 아웃 (0~2) |
| runner_1b | boolean | 1루 주자 |
| runner_2b | boolean | 2루 주자 |
| runner_3b | boolean | 3루 주자 |
| current_batter | varchar(20) | |
| current_pitcher | varchar(20) | |
| updated_at | timestamptz | |

## 크롤러

### 데이터 소스
- 네이버 스포츠 문자 중계 (primary)
- KBO 공식 사이트 (fallback)

### 크롤링 전략
```
경기 없는 날: 비활성
경기일 경기 전: 30분 간격 (라인업 등)
경기 중: 5초 간격
경기 종료: 비활성
```

### 구현
- Supabase Edge Function (Deno) 또는 Vercel Cron
- 경기 상태 변경 시 → Supabase Realtime으로 클라이언트 즉시 갱신

## UI 컴포넌트

### ScoreBoard
```
┌──────────────────────────────────┐
│         1  2  3  4  5  6  7  8  9  R  H  E │
│ LG      0  1  0  0  2  ·  ·  ·  ·  3  7  0 │
│ 두산    0  0  1  1  0  ·  ·  ·  ·  2  5  1 │
└──────────────────────────────────┘
```
- 현재 이닝 하이라이트 (컬러 강조)
- 진행 중인 이닝은 · 표시

### Diamond (비주얼 다이아몬드)
```
        ◆ (2B)
       / \
      /   \
(3B) ◇     ◇ (1B)
      \   /
       \ /
        ◇ (Home)
```
- SVG/Canvas로 구현
- 주자 있으면 ◆ (팀 컬러), 없으면 ◇
- 주자 변경 시 점등/소등 애니메이션 (Framer Motion)
- 팀 컬러 그라데이션 배경

### CountIndicator (볼카운트)
```
B ●●○○  S ●○○  O ●○○
```
- 볼: 초록, 스트라이크: 노랑, 아웃: 빨강
- 카운트 변경 시 펄스 애니메이션

### PlayByPlay (문자 중계)
```
┌─────────────────────────┐
│ 5회말                    │
│ ⚾ 오스틴 좌전안타 (1타점) │ ← 하이라이트 (금색 배경)
│    김현수 볼넷            │
│ 4회말                    │
│    홍길동 삼진            │
│    ...                   │
└─────────────────────────┘
```
- 이닝별 그룹핑
- 하이라이트(홈런/득점) = 금색 배경 + 이모지
- 새 플레이 추가 시 슬라이드인 애니메이션
- 접기/펼치기 토글

### RadioPlayer (라디오 중계)
```
┌─────────────────────────┐
│ 📻 MBC 스포츠 ▶️ ━━━●── 🔊 │
└─────────────────────────┘
```
- 오디오 스트리밍 (HTML5 Audio)
- 라디오 채널 선택 (MBC / SBS)
- 미니 플레이어: 재생/정지 + 볼륨
- 백그라운드 재생 (Capacitor Background Mode)

### 통합 레이아웃 (GameScreen)
```
┌─────────────────────────┐
│ 📻 MBC 스포츠 ▶️ ━━━●── │ ← sticky top
│ LG 3:2 두산  5회말       │ ← sticky
│ ◇◆◇  B2 S1 O1          │ ← sticky
├─────────────────────────┤
│ [중계] [채팅] [라인업]    │ ← 탭
├─────────────────────────┤
│ (탭 콘텐츠 영역)         │ ← 스크롤
│                         │
│                         │
├─────────────────────────┤
│ [메시지 입력...] [전송]   │ ← 채팅 탭일 때
└─────────────────────────┘
```
- 상단 (스코어+다이아몬드+라디오) = sticky 고정
- 탭: 문자 중계 / 실시간 채팅 / 라인업
- 채팅 탭이 기본 활성

## Realtime 구독
```typescript
// 경기 상태 (스코어, 이닝, 카운트)
supabase.channel(`game-state:${gameId}`)
  .on('postgres_changes', {
    event: 'UPDATE',
    table: 'game_state'
  }, handleStateUpdate)

// 문자 중계
supabase.channel(`game-plays:${gameId}`)
  .on('postgres_changes', {
    event: 'INSERT',
    table: 'game_plays'
  }, handleNewPlay)
```

## 인덱스
- games: (date, status)
- game_plays: (game_id, created_at DESC)
- game_innings: (game_id, inning)
