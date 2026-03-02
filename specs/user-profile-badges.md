# 유저 프로필 & 배지 & 초대제 스펙

## 1. Supabase 테이블 추가

### invitations
```sql
CREATE TABLE invitations (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  inviter_id UUID REFERENCES profiles(id),
  invitee_id UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  used_at TIMESTAMPTZ
);
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone reads own" ON invitations FOR SELECT USING (auth.uid() = inviter_id OR auth.uid() = invitee_id);
CREATE POLICY "Auth users create" ON invitations FOR INSERT WITH CHECK (auth.uid() = inviter_id);
CREATE POLICY "Update on use" ON invitations FOR UPDATE USING (true);
```

### user_badges
```sql
CREATE TABLE user_badges (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  badge_id TEXT NOT NULL,
  earned_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, badge_id)
);
ALTER TABLE user_badges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone reads" ON user_badges FOR SELECT USING (true);
CREATE POLICY "System inserts" ON user_badges FOR INSERT WITH CHECK (auth.uid() = user_id);
```

### profiles 컬럼 추가
```sql
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS invited_by UUID REFERENCES profiles(id);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_founder BOOLEAN DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS invite_count INT DEFAULT 3;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS show_posts BOOLEAN DEFAULT true;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT '';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS total_posts INT DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS total_comments INT DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS total_likes_received INT DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ DEFAULT now();
```

## 2. 배지 정의 (badges.ts)

### 팬 활동
| ID | 이름 | 조건 | 아이콘 |
|----|------|------|--------|
| fan-player-1~5 | [선수명] 덕후 Lv.1~5 | 선수 게시판 글+댓글 5/15/30/60/100 | ⭐ |
| fan-team-1~5 | [팀명] 광팬 Lv.1~5 | 팀 게시판 글+댓글 5/15/30/60/100 | 🏟️ |
| photographer-1~3 | 파파라치 Lv.1~3 | 직찍 업로드 5/20/50 | 📸 |

### 예측
| ID | 이름 | 조건 | 아이콘 |
|----|------|------|--------|
| predictor-1~5 | 예언자 Lv.1~5 | 적중 5/15/30/60/100 | 🔮 |
| streak-3/5/10 | 연승 스트릭 | 연속 적중 3/5/10 | 🔥 |
| first-predict | 개막전 선봉대 | 시즌 첫 예측 | 🎯 |

### 커뮤니티
| ID | 이름 | 조건 | 아이콘 |
|----|------|------|--------|
| writer-1~5 | 수다쟁이 Lv.1~5 | 총 글+댓글 10/30/70/150/300 | 💬 |
| popular-1~5 | 인기스타 Lv.1~5 | 받은 좋아요 10/50/100/300/1000 | ❤️ |
| debut | 데뷔전 | 첫 글 작성 | 🎬 |
| attendance-7/30/100 | 개근상 | 연속 출석 7/30/100일 | 📅 |

### 지식
| ID | 이름 | 조건 | 아이콘 |
|----|------|------|--------|
| graduate | 야구학도 | 튜토리얼 전체 완료 | 🎓 |
| analyst | 분석가 | 세이버메트릭스 10회 조회 | 📊 |
| explorer | KBO 탐험가 | 10팀 페이지 모두 방문 | 🗺️ |

### 특별
| ID | 이름 | 조건 | 아이콘 |
|----|------|------|--------|
| founder | 파운더 | 초대제 기간 가입 | 👑 |
| wiki | 위키 기여자 | 선수 프로필 제보 채택 | 📝 |
| bug-hunter | 버그헌터 | 버그 제보 | 🐛 |

### 시즌 한정
| ID | 이름 | 조건 | 아이콘 |
|----|------|------|--------|
| first-pitch-2026 | 2026 퍼스트피치 | 개막전 참여 | ⚾ |
| autumn | 가을야구 생존자 | 포스트시즌 활동 | 🍂 |

## 3. 유저 프로필 페이지

### URL: `/profile/[userId]`

### 레이아웃
```
┌─────────────────────────┐
│  [아바타]  닉네임        │
│  [팀뱃지] Lv.15 골드글러브│
│  "한줄 소개"             │
│  가입일 2026.03.02       │
├─────────────────────────┤
│  📊 활동 통계            │
│  글 23 │ 댓글 89 │ ❤️ 156│
├─────────────────────────┤
│  🏅 배지 진열장          │
│  [👑][🔮][💬][📸]...    │
│  "12개 획득 / 35개 중"   │
├─────────────────────────┤
│  📝 최근 글 (공개 시)    │
│  - 오스틴 오늘 3안타...  │
│  - 잠실 직관 후기...     │
├─────────────────────────┤
│  🎟️ 초대코드 (본인만)   │
│  [ABC123] 복사  남은3장  │
│  초대한 친구: 3명        │
└─────────────────────────┘
```

## 4. 초대제 플로우

1. 비로그인 → 회원가입 시 초대코드 입력 필수
2. 유효한 코드 → 가입 완료 + 파운더 배지 + 초대권 3장
3. 코드 없음 → "대기 명단" (이메일 등록)
4. 하린아빠 계정 = 관리자 (초대권 무한)
