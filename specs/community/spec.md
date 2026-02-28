# 커뮤니티 (게시판) — Spec

## 데이터 모델

### posts
| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | bigserial (PK) | |
| board_type | enum | 'team', 'player', 'game' |
| board_id | varchar(50) | 팀ID / 선수ID / 경기ID |
| author_id | uuid (FK → users) | 작성자 |
| title | varchar(100) | 제목 (game 타입은 null) |
| content | text | 본문 (game 타입은 채팅 메시지) |
| image_urls | text[] | 첨부 이미지 (최대 5장) |
| like_count | int | 좋아요 수 (default: 0) |
| comment_count | int | 댓글 수 (default: 0) |
| is_reported | boolean | 신고 여부 |
| created_at | timestamptz | |

### comments
| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | bigserial (PK) | |
| post_id | bigint (FK → posts) | |
| author_id | uuid (FK → users) | |
| content | text | 최대 500자 |
| like_count | int | |
| created_at | timestamptz | |

### likes
| 컬럼 | 타입 | 설명 |
|------|------|------|
| user_id | uuid (FK) | |
| target_type | enum | 'post', 'comment' |
| target_id | bigint | |
| created_at | timestamptz | |
| PK: (user_id, target_type, target_id) |

### reports
| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | bigserial | |
| reporter_id | uuid | |
| target_type | enum | 'post', 'comment' |
| target_id | bigint | |
| reason | varchar(200) | |
| created_at | timestamptz | |

## 게시판 종류

### 1. 구단별 게시판 (board_type: 'team')
- 10개 구단 × 1개 = 10개 게시판
- 일반 게시판 형태 (제목 + 본문)
- 정렬: 최신순 / 인기순 (좋아요+댓글 가중치)
- 인기글: 24시간 내 좋아요 10+ → 인기 탭

### 2. 선수별 게시판 (board_type: 'player')
- 구단 → 선수 목록 → 선수 게시판
- 선수 프로필 카드가 상단 고정
- 일반 게시판 형태

### 3. 경기별 실시간 게시판 (board_type: 'game')
- 채팅형 (제목 없음, 짧은 메시지)
- Supabase Realtime으로 실시간 수신
- 팀 플레어가 메시지 옆에 표시
- 최대 200자 제한
- 도배 방지: 같은 유저 3초 쿨타임

## UI 화면

### 구단별 게시판
```
┌─────────────────────────┐
│ [←] LG 트윈스 게시판     │
│ ─────────────────────── │
│ [최신] [인기]            │
│                         │
│ 📌 오늘의 선발 라인업     │
│    엘지골드 · 5분 전 · ❤️12 💬8 │
│ ─────────────────────── │
│ 오스틴 연봉 협상 어떻게 될까 │
│    트윈스매니아 · 23분 전 · ❤️5 💬15 │
│ ─────────────────────── │
│ ...                     │
│                         │
│           [✏️ 글쓰기]    │
└─────────────────────────┘
```

### 선수별 게시판
```
┌─────────────────────────┐
│ [←] 오스틴               │
│ ┌─────────────────────┐ │
│ │ [사진] #33 오스틴     │ │
│ │ .317 / 28HR / 95RBI │ │  ← 선수 프로필 카드
│ │ 최근5G: ████░ 4할   │ │
│ └─────────────────────┘ │
│ ─────────────────────── │
│ [글목록...]              │
│           [✏️ 글쓰기]    │
└─────────────────────────┘
```

### 경기별 실시간 채팅
```
┌─────────────────────────┐
│ (경기 트래커 영역)        │
├─────────────────────────┤
│ 💬 실시간 채팅 (142명)    │
│                         │
│ [LG] 엘지골드: 오스틴 미쳤다 │
│ [두산] 곰팬: 투수 왜 안바꿈 │
│ [LG] 야구조아: ㅋㅋㅋㅋ  │
│ [두산] 베어스: 아 진짜..  │
│                         │
│ [메시지 입력...] [전송]   │
└─────────────────────────┘
```

### 글쓰기
```
┌─────────────────────────┐
│ [×] 글쓰기               │
│                         │
│ 제목                    │
│ [___________________]   │
│                         │
│ 내용                    │
│ [                    ]  │
│ [                    ]  │
│ [                    ]  │
│                         │
│ [📷 사진] (최대 5장)     │
│                         │
│        [등록]            │
└─────────────────────────┘
```

## Realtime (경기 채팅)
```typescript
// Supabase Realtime channel
const channel = supabase.channel(`game:${gameId}`)
channel.on('postgres_changes', {
  event: 'INSERT',
  schema: 'public',
  table: 'posts',
  filter: `board_type=eq.game&board_id=eq.${gameId}`
}, (payload) => {
  // 새 메시지 추가
})
```

## 인덱스
- posts: (board_type, board_id, created_at DESC)
- posts: (board_type, board_id, like_count DESC) — 인기순
- comments: (post_id, created_at)
- likes: (user_id, target_type, target_id) UNIQUE

## RLS
- posts: 누구나 읽기, 로그인 유저만 쓰기, 본인만 수정/삭제
- comments: 동일
- likes: 본인만 생성/삭제
- reports: 로그인 유저만 생성, 본인 글 신고 불가
