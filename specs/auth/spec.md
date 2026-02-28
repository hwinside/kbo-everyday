# 유저 시스템 — Spec

## 데이터 모델

### users
| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | uuid (PK) | Supabase Auth UID |
| nickname | varchar(20) | 닉네임 (unique) |
| avatar_url | text | 프로필 이미지 URL |
| my_team_id | int (FK → teams) | 마이팀 |
| level | int | 레벨 (default: 1) |
| points | int | 누적 포인트 (default: 0) |
| title | varchar(30) | 칭호 (루키, 레귤러...) |
| created_at | timestamptz | 가입일 |
| updated_at | timestamptz | 수정일 |

### teams
| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | serial (PK) | |
| name | varchar(20) | 팀명 (LG 트윈스) |
| short_name | varchar(10) | 약칭 (LG) |
| color_primary | varchar(7) | 메인 컬러 (#C60C30) |
| color_secondary | varchar(7) | 서브 컬러 |
| logo_url | text | 로고 이미지 |
| youtube_channel_id | varchar(30) | 유튜브 채널 ID |

## 인증 플로우

### 소셜 로그인
1. 카카오 / 구글 / 애플 선택
2. Supabase Auth → OAuth 리다이렉트
3. 첫 로그인 시 → 온보딩 화면
   - 닉네임 입력 (중복 체크, 2~12자, 한글/영문/숫자)
   - 마이팀 선택 (10개 구단 그리드, 팀 컬러 카드)
   - 프로필 이미지 (선택, 기본 아바타 제공)
4. 완료 → 홈으로 이동

### 세션 관리
- Supabase Auth 세션 (JWT)
- 앱 재시작 시 자동 로그인
- 토큰 만료 시 리프레시

## UI 화면

### 온보딩 (3스텝)
```
[Step 1] 닉네임
┌─────────────────────┐
│  크보 에브리데이에    │
│  오신 걸 환영합니다!  │
│                     │
│  닉네임을 정해주세요  │
│  [_______________]  │
│                     │
│  [다음 →]           │
└─────────────────────┘

[Step 2] 마이팀 선택
┌─────────────────────┐
│  응원하는 팀은?      │
│                     │
│  [LG] [두산] [KT]   │
│  [SSG] [NC] [KIA]  │
│  [롯데] [삼성] [한화]│
│  [키움]             │
│                     │
│  [다음 →]           │
└─────────────────────┘

[Step 3] 프로필 사진 (선택)
┌─────────────────────┐
│  프로필 사진         │
│     [📷]            │
│                     │
│  [건너뛰기] [완료]   │
└─────────────────────┘
```

### 마이페이지
- 프로필 카드 (아바타 + 닉네임 + 팀 플레어 + 레벨 뱃지)
- 내 활동: 내가 쓴 글 / 댓글 / 좋아요한 글
- 예측 전적: 적중률, 연속 적중, 랭킹
- 설정: 닉네임 변경, 마이팀 변경, 알림 설정, 로그아웃

## API (Supabase RPC / Edge Functions)

### POST /auth/onboarding
```json
{
  "nickname": "엘지골드",
  "my_team_id": 1,
  "avatar_url": "optional"
}
```
- 닉네임 중복 체크
- users 테이블 업데이트

### GET /users/:id/profile
- 프로필 + 활동 요약 + 예측 전적

### PATCH /users/:id
- 닉네임/마이팀/아바타 변경

## RLS (Row Level Security)
- users: 본인만 수정 가능, 프로필은 모두 조회 가능
- 닉네임/레벨/팀은 게시글/댓글에서 join으로 표시
