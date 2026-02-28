# 뉴스 & 콘텐츠 피드 — Spec

## 데이터 모델

### news_articles
| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | bigserial (PK) | |
| team_id | int (FK, nullable) | 관련 팀 (null=전체) |
| title | varchar(200) | 헤드라인 |
| source | varchar(50) | 출처 (스포츠조선, 일간스포츠 등) |
| source_url | text | 원문 링크 |
| thumbnail_url | text | 썸네일 |
| published_at | timestamptz | 원문 발행일 |
| created_at | timestamptz | 크롤링 시각 |

### youtube_videos
| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | varchar(20) (PK) | YouTube Video ID |
| team_id | int (FK) | |
| title | varchar(200) | |
| thumbnail_url | text | |
| view_count | int | |
| published_at | timestamptz | |
| created_at | timestamptz | |

## 크롤러

### 뉴스
- 네이버 스포츠 KBO 뉴스 RSS/크롤링
- 팀명 키워드 매칭 → team_id 자동 태깅
- 30분 간격 갱신
- 중복 체크: source_url UNIQUE

### 유튜브
- YouTube Data API v3 (`search.list` + `videos.list`)
- 10개 구단 공식 채널 최신 영상
- 1시간 간격 갱신
- 일일 할당량 10,000 유닛 → 충분 (10채널 × 24회 = 240 유닛)

## UI

### 피드 화면
```
┌─────────────────────────┐
│ [뉴스] [영상] [전체]      │
│ [마이팀 ▼] [전체 팀 ▼]   │
├─────────────────────────┤
│ ┌─────────────────────┐ │
│ │ [썸네일]  제목제목... │ │
│ │          스포츠조선   │ │
│ │          2시간 전     │ │
│ └─────────────────────┘ │
│ ┌─────────────────────┐ │
│ │ [▶️ 썸네일]          │ │
│ │ LG Twins TV         │ │
│ │ 오늘의 하이라이트     │ │
│ │ 조회수 12.3만        │ │
│ └─────────────────────┘ │
│ ...                     │
└─────────────────────────┘
```
- 뉴스 카드 탭 → 원문 링크 (인앱 브라우저)
- 영상 카드 탭 → 인앱 YouTube 재생 (iframe embed)
- 무한 스크롤 (Virtual Scrolling)
- 마이팀 우선 표시 (설정 기반)

## 인덱스
- news_articles: (team_id, published_at DESC)
- news_articles: (published_at DESC)
- youtube_videos: (team_id, published_at DESC)
