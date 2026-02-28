# 스탯 인포그래픽 — Spec

## 데이터 모델

### players
| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | serial (PK) | |
| team_id | int (FK → teams) | |
| name | varchar(20) | |
| name_en | varchar(50) | 영문명 |
| number | int | 등번호 |
| position | varchar(10) | 포지션 |
| throws_bats | varchar(10) | 투타 (우투우타) |
| birth_date | date | |
| photo_url | text | |
| is_active | boolean | 현역 여부 |

### player_season_stats
| 컬럼 | 타입 | 설명 |
|------|------|------|
| player_id | int (FK) | |
| season | int | 연도 (2026) |
| games | int | 경기수 |
| -- 타자 -- | | |
| avg | decimal(4,3) | 타율 |
| obp | decimal(4,3) | 출루율 |
| slg | decimal(4,3) | 장타율 |
| ops | decimal(4,3) | OPS |
| hr | int | 홈런 |
| rbi | int | 타점 |
| sb | int | 도루 |
| hits | int | 안타 |
| ab | int | 타수 |
| -- 투수 -- | | |
| era | decimal(5,2) | 평균자책점 |
| whip | decimal(4,2) | WHIP |
| k_per_9 | decimal(4,1) | K/9 |
| wins | int | 승 |
| losses | int | 패 |
| ip | decimal(5,1) | 이닝 |
| so | int | 탈삼진 |

### player_game_stats (경기별 — 추이 차트용)
| 컬럼 | 타입 | 설명 |
|------|------|------|
| player_id | int (FK) | |
| game_id | varchar(20) (FK) | |
| date | date | |
| -- 타자 -- | | |
| ab | int | 타수 |
| hits | int | 안타 |
| hr | int | |
| rbi | int | |
| -- 투수 -- | | |
| ip | decimal(4,1) | |
| er | int | 자책점 |
| so | int | 탈삼진 |

### team_standings
| 컬럼 | 타입 | 설명 |
|------|------|------|
| team_id | int (FK) | |
| season | int | |
| rank | int | |
| wins | int | |
| losses | int | |
| draws | int | |
| pct | decimal(4,3) | 승률 |
| gb | decimal(4,1) | 게임차 |
| streak | varchar(10) | "3연승", "2연패" |
| last_10 | varchar(10) | "7승3패" |

## UI 컴포넌트

### PlayerStatCard (선수 스탯 카드)
```
┌─────────────────────────┐
│ [사진]  #33 오스틴       │
│         LG 트윈스 | OF   │
│                         │
│    ┌─ 레이더 차트 ─┐    │
│    │   타율         │    │  ← Nivo Radar
│    │  /    \        │    │
│    │ 도루    OPS    │    │
│    │  \    /        │    │
│    │   타점  홈런   │    │
│    └───────────────┘    │
│                         │
│ .317  28HR  95RBI  12SB │  ← 핵심 넘버
│ OPS .952                │
│                         │
│ 📈 최근 10경기 추이      │
│ ┌───────────────────┐   │
│ │ ⌇⌇⌇⌇⌇⌇⌇⌇⌇⌇      │   │  ← Recharts Line
│ │ 타율 .380 (↑)     │   │
│ └───────────────────┘   │
└─────────────────────────┘
```
- 레이더 차트: Nivo `@nivo/radar`
  - 타자: 타율, OPS, HR, 타점, 도루 (리그 평균 대비 백분위)
  - 투수: ERA(역), WHIP(역), K/9, 승, 이닝
- 추이 차트: Recharts `LineChart`
  - 타자: 최근 10/30경기 이동평균 타율, OPS
  - 투수: 최근 5/10경기 ERA, WHIP
- 시즌 하이라이트: 시즌 최고 기록 강조 (금색 배지)

### TeamStatDashboard
```
┌─────────────────────────┐
│ LG 트윈스  1위           │
│ 85승 56패 3무  승률 .603 │
│ 최근 10경기: 7승 3패 🔥  │
│                         │
│ 팀 타격      리그 평균   │
│ 타율 .281    .265  (↑)  │
│ OPS  .782    .741  (↑)  │
│ HR   158     142   (↑)  │
│                         │
│ 팀 투수      리그 평균   │
│ ERA  3.84    4.12  (↓)  │
│ WHIP 1.28    1.35  (↓)  │
│                         │
│ [🆚 팀 비교]             │
└─────────────────────────┘
```

### TeamCompare (팀 비교)
```
┌────────────────────────────┐
│ [LG 트윈스] vs [두산 베어스] │
│                            │
│        LG    항목    두산   │
│       .281   타율   .268   │
│       .782   OPS    .745   │
│       3.84   ERA    4.21   │
│        158   HR      142   │
│                            │
│    (나란히 막대 차트)       │  ← Nivo Bar
└────────────────────────────┘
```

### 순위표 (Standings)
```
┌──────────────────────────────────┐
│ 순위  팀     승  패  무  승률  차  │
│  1   LG     85  56  3  .603  -   │
│  2   한화   83  57  4  .593  1.5 │
│  3   SSG    75  64  5  .536  9.5 │
│  ...                              │
└──────────────────────────────────┘
```
- 내 팀 행 하이라이트 (팀 컬러 배경)
- 최근 폼 아이콘 (🔥 3연승+, ❄️ 3연패+)

## 데이터 갱신
- 시즌 스탯: 1일 1회 새벽 크롤링
- 경기별 스탯: 경기 종료 후 자동 업데이트
- 순위표: 경기 종료 시 자동 갱신
