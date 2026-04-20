# 크보팬 얼리멤버 커뮤니티 활성화 이벤트 — Spec

> 이벤트 코드명: `opening-season`
> 기간: 2026-04-20 ~ 2026-05-31 (42일)
> 확정일: 2026-04-20
> 결정자: 하린아빠 (#marketing 스레드 `topic_id: 1776644364.098599`)
> 작성: 삼식이 (CTO) / 기획 협업: 삼순이 (CSO)
> 상태: SPECIFIED → 리뷰 대기 → 구현 대기

---

## 0. 컨텍스트 & 목표

### 0.1 배경
- 크보팬 시즌 초 (4/20 기준) 약 DAU 200명대, 초대 활동 부진
- KBO 정규시즌 개막 시즌 초 트래픽·리텐션 부스트 필요
- 얼리멤버에게 "그때 있었다"는 시즌 귀속감을 부여해 장기 리텐션까지 연결

### 0.2 목표 (42일간)
- 신규 가입자 +500명 (초대 트랙 기여)
- DAU 2배 이상 (포인트 리더보드 기여)
- 얼리멤버 뱃지 소유자 100명 이상 확보 (시즌 아이덴티티)

### 0.3 비목표 (Non-goal)
- 수익화 (광고·구독) 연계는 시즌2 이후 검토
- 이벤트 이후 상설 포인트 시스템화는 별도 검토

---

## 1. 개요 & 구조

### 1.1 대외명
`커뮤니티 활성화 이벤트` 또는 `크보팬 얼리멤버 시즌` (랜딩 헤드라인은 "친구 초대하고 응원글 쓰면, 에어팟 프로 3까지 노릴 수 있어요")

### 1.2 2트랙 구조
1. *초대 트랙*: 초대 뱃지 달성 수 기준, *선착순 수량 한정*
2. *글쓰기 트랙*: 포인트 누적 기준 *리더보드 순위*

### 1.3 공통 원칙
- *트랙 간 중복 수상 허용*: 한 유저가 초대 1등 + 글쓰기 1등 동시 수상 가능
- *얼리멤버 prefix*: 모든 뱃지명 앞에 `크보팬 얼리멤버 ·` 고정
- *시즌 귀속*: 뱃지 메타데이터에 `season: "2026-spring"` 저장

---

## 2. 예산 & 상품

### 2.1 총예산: 약 317만원 (하린아빠 승인 2026-04-20, 제세공과금 재계산 반영)

| 항목 | 금액 |
|---|---|
| 초대 트랙 상품 (50명) | 1,445,000 |
| 글쓰기 트랙 상품 (50명) | 1,445,000 |
| 제세공과금 대납 (에어팟 2 + 신세계 10만 6개) | 281,600 |
| *총합* | *3,171,600* |

*변경 이력*: 1차 승인 305만(제세공과금 오계산) → 재계산 후 317만으로 확정.

### 2.2 상품 구성 (트랙 공통)

| 순위 구간 | 상품 | 수량 | 단가 | 소계 |
|---|---|---|---|---|
| 1등 | 에어팟 프로 3 | 1 | 340,000 | 340,000 |
| 2~4등 | 신세계 상품권 10만원권 | 3 | 100,000 | 300,000 |
| 5~9등 | 신세계 상품권 5만원권 | 5 | 50,000 | 250,000 |
| 10~19등 | 신세계 상품권 3만원권 | 10 | 30,000 | 300,000 |
| 20~39등 | 스타벅스 상품권 1만원권 | 20 | 10,000 | 200,000 |
| 40~50등 | 스타벅스 상품권 5천원권 | 11 | 5,000 | 55,000 |
| *트랙 소계* | | *50* | | *1,445,000* |

### 2.3 제세공과금 (크보팬 대납)
- 과세 대상: 단가 5만원 초과 상품 → 시가 22%(기타소득세 20% + 지방소득세 2%)
- 대납 계산:
  - 에어팟 프로 3 × 2개(양 트랙 1등): 340,000 × 22% = 74,800원/개 → *149,600원*
  - 신세계 10만원권 × 6개(양 트랙 2~4등, 각 3개): 100,000 × 22% = 22,000원/개 → *132,000원*
  - *합계: 281,600원*
- 신세계 5만원권: 정확히 5만원은 비과세(5만원 초과가 과세 기준). 대납 불필요
- 원천징수: 당첨자에게 "크보팬이 제세공과금 부담" 사전 안내, 원천징수영수증 발행

### 2.4 상품 지급 방식
- 디지털 상품권 (스타벅스/신세계): 당첨 안내 + 모바일 상품권 링크 발송
- 실물(에어팟): 당첨자 개별 안내 후 택배 배송 (주소·연락처 수집)

---

## 3. 초대 트랙

### 3.1 집계 기준
- 기존 `invitations` 테이블 활용
- *활성화 초대 수* = `activated_at IS NOT NULL` 인 invitee 수 (v2 시스템 그대로)
- *이벤트 기간 내 신규 달성분 + 기존 달성분 모두 포함* (하린아빠 결정)

### 3.2 순위 결정
- 5월 31일 23:59:59 KST 스냅샷 기준
- 활성화 초대 수 내림차순
- *동률 시 먼저 달성한 유저 우선*: 마지막(N번째) 활성화 `activated_at` 시각이 빠른 순

### 3.3 뱃지 — 얼리멤버 (두 트랙 동일, 2026-04-20 하린아빠 통일 지시)

| 순위 | 뱃지명 | 이모지 | 수량 |
|---|---|---|---|
| 1등 | 얼리멤버 · 단장 | 🏆 | 1 |
| 2~4등 | 얼리멤버 · 운영팀장 | 💼 | 3 |
| 5~9등 | 얼리멤버 · 스카우트 | 🔍 | 5 |
| 10~19등 | 얼리멤버 · 해설위원 | 🎙️ | 10 |
| 20~39등 | 얼리멤버 · 기자단 | 📝 | 20 |
| 40~50등 | 얼리멤버 · 서포터즈 | 📣 | 11 |

### 3.4 어뷰징 방지
- 기존 `invite_abuse_check` 테이블(fingerprint + IP) 활용
- 이벤트 기간 동안 활성화율 추적 강화: 수상 직전 수동 검수

---

## 4. 글쓰기 트랙 (포인트 리더보드)

### 4.1 포인트 체계

| 활동 | 포인트 | 일일 상한 (횟수) |
|---|---|---|
| 경기 중계 채팅 (내부명: 크관) | 1점 | 30점 (30회) |
| 커뮤니티 게시판 댓글 | 2점 | 40점 (20회) |
| 커뮤니티 글 게시판 글 작성 | 3점 | 30점 (10회) |
| 커뮤니티 사진 게시판 사진글 작성 | 5점 | 50점 (10회) |
| *하루 총 상한* | | *150점* |

- 42일 × 150점 = *최대 6,300점*

### 4.2 순위 결정
- 5월 31일 23:59:59 KST 포인트 합계 스냅샷
- 포인트 내림차순
- *동률 시*: 더 먼저 누적 도달한 유저 우선 (마지막 해당 점수 도달 시각 빠른 순)

### 4.3 뱃지 — 얼리멤버 (두 트랙 동일)

3.3과 동일한 뱃지 체계 적용. 2026-04-20 하린아빠 지시로 통일. 중복 수상(초대 1등 + 글쓰기 1등) 시 동일 뱃지 2개 부여.

### 4.4 어뷰징 방지
- *점수 적용 제외 판정*:
  - 운영진 판단에 따라 "점수획득 목적 글" 판정 시 해당 글/댓글/채팅 *점수 제외*
  - 판정 제외 3건 이상 누적 시 *해당 계정은 리더보드에서 제외* + 뱃지·상품 수상 대상 제외
- *자동 필터* (1차 방어선):
  - 중복 텍스트 N회 연속 (`dup_count >= 3` & 편집거리 < 5)
  - 초단문 스팸 (< 5자) + 3초 연속 전송
  - AI 생성 의심 (휴리스틱: 유사 문장 패턴)
- *하루 총 상한 150점 초과 분* 자동 누적 차단

---

## 5. DB 스키마

### 5.1 `event_opening_season_points` 테이블 (신규)

```sql
CREATE TABLE event_opening_season_points (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN ('game_chat', 'community_comment', 'community_post', 'community_photo_post')),
  points INT NOT NULL,
  reference_id TEXT, -- 소스 row id (game_chats.id, community_posts.id 등)
  reference_table TEXT, -- 'game_chats' | 'community_posts' | 'community_comments'
  earned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  excluded_by_admin BOOLEAN NOT NULL DEFAULT FALSE,
  excluded_reason TEXT,
  excluded_at TIMESTAMPTZ,
  excluded_by UUID REFERENCES profiles(id)
);

CREATE INDEX idx_event_points_user_earned ON event_opening_season_points(user_id, earned_at);
CREATE INDEX idx_event_points_user_action_earned ON event_opening_season_points(user_id, action_type, earned_at);
CREATE INDEX idx_event_points_excluded ON event_opening_season_points(excluded_by_admin) WHERE excluded_by_admin = FALSE;

ALTER TABLE event_opening_season_points ENABLE ROW LEVEL SECURITY;

-- 유저는 자기 포인트 내역만 조회
CREATE POLICY "Users read own points" ON event_opening_season_points
  FOR SELECT USING (auth.uid() = user_id);

-- INSERT/UPDATE는 service_role만 (서버 API를 통해서만)
```

### 5.2 `event_opening_season_exclusions` 테이블 (신규)

```sql
CREATE TABLE event_opening_season_exclusions (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE UNIQUE,
  exclusion_count INT NOT NULL DEFAULT 0,
  excluded_from_leaderboard BOOLEAN NOT NULL DEFAULT FALSE,
  first_flagged_at TIMESTAMPTZ,
  last_flagged_at TIMESTAMPTZ,
  admin_note TEXT
);

ALTER TABLE event_opening_season_exclusions ENABLE ROW LEVEL SECURITY;
-- 유저 조회 불가(본인도 X). service_role 전용
```

### 5.3 `event_opening_season_awards` 테이블 (신규, 시즌 종료 후 확정)

```sql
CREATE TABLE event_opening_season_awards (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  track TEXT NOT NULL CHECK (track IN ('invite', 'writing')),
  rank INT NOT NULL,
  badge_code TEXT NOT NULL, -- 'writing_danjang', 'invite_champion' 등
  badge_label TEXT NOT NULL, -- '크보팬 얼리멤버 · 단장'
  prize_code TEXT NOT NULL, -- 'airpods_pro_3', 'shinsegae_100k' 등
  prize_label TEXT NOT NULL,
  final_score NUMERIC NOT NULL, -- 초대 활성화 수 또는 포인트
  finalized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'sent', 'received', 'refused', 'canceled')),
  UNIQUE (user_id, track)
);

ALTER TABLE event_opening_season_awards ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own awards" ON event_opening_season_awards
  FOR SELECT USING (auth.uid() = user_id);

CREATE INDEX idx_event_awards_track_rank ON event_opening_season_awards(track, rank);
```

### 5.4 `badges` 테이블 확장 (기존 테이블 재사용 가정)

```sql
-- 기존 badges 테이블이 없다면 추가
-- season: '2026-spring' 메타데이터
-- badge_type: 'event_writing_rank' | 'event_invite_rank'
```

---

## 6. 포인트 적립 로직

### 6.1 적립 트리거 (서버 사이드)

포인트 적립은 *반드시 서버 API에서만* 수행. 클라이언트 직접 쓰기 금지.

대상 이벤트:
- 크관 채팅 전송: `game_chats` INSERT 직후 API에서 `awardPoints('game_chat', 1)`
- 커뮤니티 댓글 작성: `community_comments` INSERT 직후 `awardPoints('community_comment', 2)`
- 커뮤니티 글 작성: `community_posts` INSERT 직후 `awardPoints('community_post', 3)`
- 커뮤니티 사진글 작성: `community_posts` (photo) INSERT 직후 `awardPoints('community_photo_post', 5)`

### 6.2 awardPoints 함수 (의사코드)

```ts
async function awardPoints(userId: string, actionType: ActionType, points: number, refId: string, refTable: string) {
  // 1. 이벤트 기간 체크
  if (now < EVENT_START || now > EVENT_END) return { skipped: 'out_of_period' };

  // 2. 유저 exclusion 체크
  const exclusion = await getExclusion(userId);
  if (exclusion?.excluded_from_leaderboard) return { skipped: 'excluded_user' };

  // 3. 오늘 action_type별 상한 체크
  const todaySum = await getTodayPointsSum(userId, actionType);
  const actionCap = ACTION_DAILY_CAPS[actionType]; // 30 | 40 | 30 | 50
  if (todaySum >= actionCap) return { skipped: 'action_cap' };

  // 4. 오늘 총 상한 체크 (150점)
  const todayTotal = await getTodayTotalPoints(userId);
  if (todayTotal >= DAILY_TOTAL_CAP) return { skipped: 'daily_total_cap' };

  // 5. 부분 지급 (상한 초과 시 일부만 지급)
  const actualPoints = Math.min(
    points,
    actionCap - todaySum,
    DAILY_TOTAL_CAP - todayTotal
  );

  // 6. 삽입
  await db.insert('event_opening_season_points', {
    user_id: userId,
    action_type: actionType,
    points: actualPoints,
    reference_id: refId,
    reference_table: refTable,
  });

  return { awarded: actualPoints };
}
```

### 6.3 운영 제외 (admin)

```ts
async function excludePoints(postOrChatId: string, tableName: string, adminId: string, reason: string) {
  // 1. 해당 포인트 row를 excluded로 마크
  await db.update('event_opening_season_points', {
    excluded_by_admin: true,
    excluded_reason: reason,
    excluded_at: now,
    excluded_by: adminId,
  }, { reference_id: postOrChatId, reference_table: tableName });

  // 2. 해당 유저의 exclusion_count 증가
  const userId = await getUserFromRef(postOrChatId, tableName);
  const exclusion = await upsertExclusion(userId);
  exclusion.exclusion_count += 1;
  if (exclusion.exclusion_count >= 3) {
    exclusion.excluded_from_leaderboard = true;
  }
  await db.save(exclusion);

  return exclusion;
}
```

---

## 7. 페이지 & 라우트

### 7.1 랜딩 페이지
- *경로*: `/event/opening-season`
- *Alias*: `/event` → `/event/opening-season` redirect (이벤트 기간 동안)
- *SSR*: 정적 콘텐츠 + 로그인 유저 한정 개인화 섹션 (내 순위 / 내 포인트 / 초대 수)
- *공개*: 비로그인도 전체 페이지 접근 가능 (CTA에서 로그인 유도)

### 7.2 컴포넌트 구조

```
src/app/(main)/event/
├── opening-season/
│   ├── page.tsx
│   ├── EventHero.tsx
│   ├── EventMyStatus.tsx      // 로그인 유저 개인화
│   ├── EventLeaderboard.tsx   // Top 50 리더보드
│   ├── EventRewardTable.tsx
│   ├── EventBadges.tsx        // 트랙별 뱃지 표
│   ├── EventSteps.tsx
│   ├── EventFAQ.tsx
│   └── EventSafeguards.tsx
└── page.tsx  // redirect to opening-season
```

### 7.3 리더보드 노출 위치 (3곳)
1. */event/opening-season 내 메인 리더보드* — Top 50 전체
2. */my (프로필)* — 내 순위 + 다음 단계까지 N점 카드
3. *홈 하단* — `이벤트 TOP 10` 미니 위젯 (이벤트 기간 한정)

---

## 8. API

### 8.1 `GET /api/event/leaderboard?track=writing|invite`
- 응답: Top 50 순위 (user_id, nickname, avatar_url, team_id, score, rank)
- 캐시: `Cache-Control: s-maxage=60, stale-while-revalidate=120`
- 경기 중 포인트 급변 대비 짧은 캐시

### 8.2 `GET /api/event/me`
- 로그인 유저 전용
- 응답:
  - 초대 트랙: { activated_count, rank, next_tier_at, badge }
  - 글쓰기 트랙: { total_points, rank, today_points, today_remaining, next_tier_at, badge }
  - 제외 상태: { excluded_count, excluded_from_leaderboard }

### 8.3 `GET /api/event/summary`
- 이벤트 전체 통계 (관리자·유저 공통)
- 응답: { total_participants, total_points_earned, total_invites_activated, days_remaining }

### 8.4 `POST /api/admin/event/exclude` (admin only)
- 요청: `{ reference_id, reference_table, reason }`
- 동작: 해당 글/댓글/채팅 포인트 제외 + 유저 exclusion_count +1

### 8.5 `POST /api/cron/event/finalize` (이벤트 종료 시 1회)
- 5/31 자정 후 자동 실행
- 두 트랙 각각 순위 스냅샷 → `event_opening_season_awards` insert
- 수상자 뱃지 부여
- admin 대시보드에 당첨자 리스트 노출

---

## 9. 진입 경로 (3층 IA)

1. *홈 상단 배너* — `HomeEventBanner.tsx`
   - 이벤트 기간 동안 전역 노출
   - 닫기 시 24시간 숨김 (localStorage)
   - CTA: "이벤트 자세히 보기" → `/event/opening-season`
2. *MY/프로필 페이지* — `MyEventCard.tsx`
   - 로그인 유저 한정
   - 초대 N명 / 다음 단계까지 M명
   - 내 포인트 N점 / 순위 N위
   - CTA: "리더보드 보기" + "친구 초대"
3. *경기 중계 채팅 & 커뮤니티 작성 페이지* — `EventPointHint.tsx`
   - 작성 페이지 헤더 또는 전송 버튼 근처
   - 문구: "이 활동은 이벤트 포인트로 집계됩니다 (오늘 +N / 150)"

---

## 10. 카피 & 문구 락

### 10.1 메인 헤드라인
- *H1*: 친구 초대하고 응원글 쓰면, 에어팟 프로 3까지 노릴 수 있어요
- *Sub*: 각 부문 상위 50명은 시즌 한정 얼리멤버 뱃지와 상품을 받고, 1등은 에어팟 프로 3의 주인공이 됩니다

### 10.2 기간
`2026년 4월 20일 ~ 5월 31일 KST`

### 10.3 FAQ 락 문구 (항목)
- Q. 순위권에 들면 어떻게 지급되나요?
  A. 최종 순위에 해당하는 단일 상품 1개만 지급됩니다. 예를 들어 5등이면 신세계 상품권 5만원권 1개를 받으며, 그 아래 순위 구간 상품은 중복 지급되지 않습니다.
- Q. 예전에 이미 초대 뱃지를 달성했는데 이번 이벤트 보상도 받을 수 있나요?
  A. 네, 이번 이벤트는 누적 활성화 초대 수 기준으로 집계되어 기존 달성분도 인정됩니다. 단, 이벤트 기간 중 새로 활성화된 초대도 합산되어 순위 다툼은 42일 동안 계속됩니다.
- Q. 하루에 받을 수 있는 포인트에 한도가 있나요?
  A. 네, 하루 총 150점까지 적립 가능하며, 활동 유형별 상한도 있습니다 (경기 중계 채팅 30점 / 댓글 40점 / 글 30점 / 사진글 50점).
- Q. 어떤 글이 점수 적용에서 제외되나요?
  A. 중복 도배, 초단문 스팸, 점수 획득 목적으로만 작성된 것으로 판단되는 글 등은 운영진 검토 후 점수 적용에서 제외될 수 있습니다. 제외가 3건 이상 누적되면 해당 계정은 순위표에서 제외됩니다.
- Q. 셀프 초대로 여러 계정을 만들면 어떻게 되나요?
  A. 동일 기기·비정상 패턴·수동 검수 결과에 따라 이벤트 집계 및 보상에서 제외될 수 있습니다.
- Q. 에어팟 프로 3는 언제 어떻게 받나요?
  A. 이벤트 종료 후 최종 검수를 거쳐 1주 내 개별 안내 및 배송될 예정입니다. 제세공과금(22%)은 크보팬이 대납합니다.
- Q. 스타벅스·신세계 상품권은 언제 받나요?
  A. 시즌 종료 후 최종 검수를 거쳐 일괄 지급됩니다 (디지털 모바일 상품권).

---

## 11. 타임라인 & 작업 순서

### 11.1 오늘 (2026-04-20) 착수
- [ ] Spec 리뷰 (삼순이 → 하린아빠 승인)
- [ ] DB 스키마 3종 생성 (`event_opening_season_points`, `_exclusions`, `_awards`)
- [ ] 랜딩 페이지 이식 (Next `/event/opening-season`)

### 11.2 내일 (2026-04-21)
- [ ] awardPoints 서버 API + 4개 트리거 포인트 연결
- [ ] `/api/event/leaderboard` + `/api/event/me`
- [ ] MY 카드 + 홈 배너

### 11.3 모레 (2026-04-22)
- [ ] 경기 중계 채팅·커뮤니티 작성 CTA 3층 진입 완성
- [ ] 어드민 제외 처리 UI
- [ ] 런칭 리허설 (테스트 데이터로 스모크 테스트)

### 11.4 시즌 종료 (2026-05-31)
- [ ] 23:59 스냅샷
- [ ] `event-finalize` cron 실행
- [ ] 당첨자 안내 발송 (6월 1주 내)
- [ ] 에어팟 배송

---

## 12. 리스크 & 결정 이슈

### 12.1 Open Issue
- *랜딩 공개 타이밍*: 스펙 확정·개발 완료 후 공개 (4/22 이후 예정) vs 4/20 당일 공개
- *"크관" 용어 통일 완료*: 외부 노출은 `경기 중계 채팅`, 내부 주석·DB 주석에만 `크관` 별칭 유지
- *뱃지 시각 디자인*: 12개 전용 아이콘 필요 (삼순이 디자인 협업)

### 12.2 리스크
- *포인트 어뷰징*: 자동 필터 1차 방어선이 부족하면 운영진 수동 검수 부담 급증 → 런칭 전 룰 튜닝 필수
- *제세공과금 예산 초과*: 에어팟 시가 변동 시 재검토
- *동점자 대량 발생*: 순위 경계선에서 동점자 10명이면 앞쪽 수상자 결정 로직 필요 (마지막 도달 시각 기준)

### 12.3 가드
- *이벤트 중단 권한*: 하린아빠 판단하에 언제든 중단 가능 (환불·당첨 무효 포함)
- *약관 고지*: 랜딩 하단 고정 문구로 노출

---

## 13. 체크리스트 (런칭 직전)

- [ ] DB 3종 스키마 적용 (prod)
- [ ] RLS 정책 검증
- [ ] awardPoints 단위 테스트 (상한·제외·기간 outside)
- [ ] 리더보드 페이지 Lighthouse ≥ 85
- [ ] 모바일 반응형 QA (iPhone, Android)
- [ ] FAQ 7개 전수 리뷰 (법무 관점)
- [ ] 제세공과금 대납 문구 고지
- [ ] 시즌 종료 cron 예약 (5/31 24:00 KST)
- [ ] 어드민 대시보드 연동 (제외 / 수상자 확인)

---

## 14. 참고
- 기존 스펙: `specs/invite-system-v2.md`
- 초대 기존 시스템: `activated_at`, `invite_refill_log`, `invite_abuse_check` 재사용
- 디자인 시스템: `specs/design-system/`
- 대외 커뮤니케이션: Slack `#marketing` 스레드 `topic_id: 1776644364.098599`
