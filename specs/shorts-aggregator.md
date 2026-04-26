# 선수별 숏츠 어그리게이터

**작성자**: 삼식이
**작성일**: 2026-04-26
**상태**: 기획 초안
**관련 스레드**: #product 유튜브 영상 소싱 관련 스레드 (2026-04-26)

---

## 1. 목표

> "최애선수 관련 최신 숏츠는 유튜브가 아니라 크보팬에서 다 해결한다"

### 핵심 문제
- 현재 숏츠 소싱: 10개 구단 공식채널만 → 다양성 극히 부족
- 유튜브에 "박해민 숏츠"만 검색해도 팬채널·방송사·유튜버 콘텐츠가 넘침
- 공식영상 피드에 숏폼이 중복 노출됨

### 성공 기준
- 선수당 하루 5개 이상의 숏츠가 피드에 노출 (인기 선수 기준)
- 공식채널 외 비공식 채널 비율 50% 이상
- 유저가 유튜브 앱 열지 않고도 "내 선수 숏츠" 다 볼 수 있다고 느끼는 상태

---

## 2. 현재 구조 (AS-IS)

```
[채널 풀: 공식 10개] → RSS (quota 0) + YouTube Search API (quota 高)
                    → videos 테이블 (B안 Phase 1)
                    → 홈 숏츠 캐러셀
```

### 한계
| 항목 | 현재 |
|---|---|
| 채널 수 | 10 (공식만) |
| 비공식 채널 | 0 |
| 선수 태깅 | API search 기반 (quota 소모) |
| 갱신 주기 | 6시간 |
| 공식영상 숏폼 중복 | 미처리 |

---

## 3. 목표 구조 (TO-BE)

```
[채널 풀: 공식 10 + 비공식 200+]
    ↓
RSS 수집 (quota 0, 15분 간격)
    ↓
선수 자동 태깅 (제목·설명 → 선수명/별명 매칭)
    ↓
videos 테이블 (source_type 구분)
    ↓
홈: "내 팀, 최애선수 숏츠" (선수 우선, 다양성 보장)
```

---

## 4. 구현 단계

### Phase 1: 채널 풀 구축 (1회성)

**목표**: KBO 관련 활발한 숏츠 채널 200개+ 발굴

**방법**:
1. YouTube Search API로 팀·선수별 숏츠 검색 (1회 batch)
2. 결과에서 channel_id 추출 → 중복 제거
3. 채널별 메타데이터 수집: 구독자 수, 최근 업로드 빈도, KBO 관련도
4. 신뢰도 기준으로 tier 분류:
   - **Tier 1**: 방송사 (MBC SPORTS+, SBS Sports, SPOTV 등)
   - **Tier 2**: 인기 야구 유튜버 (야구왕, 끝까지간다, 생야구, 크보톡, 1분크보 등)
   - **Tier 3**: 팬채널·밈채널 (그냥만드는거좋아함, 제욱볶음, 엘트 등)
   - **Tier 4**: 기타 (선수 개인, 비정기 업로더)

**저장**: `channel_pool` 테이블 (Supabase)
```sql
create table channel_pool (
  channel_id text primary key,
  channel_name text not null,
  tier int not null default 3,        -- 1~4
  subscriber_count int,
  is_active boolean default true,
  team_affinity text[],               -- 연관 팀 (nullable)
  last_video_at timestamptz,
  created_at timestamptz default now()
);
```

**Quota 비용**: 초기 1회 ~2,000~5,000 units (이후 0)

---

### Phase 2: RSS 수집 확장

**현재 cron**: `/api/cron/videos` — 공식 10채널 RSS

**변경**:
- `channel_pool` 테이블에서 `is_active = true` 채널 목록 조회
- 전체 채널 RSS 수집 (배치 처리, 15분 간격)
- `source_type` 구분: `official_short`, `official_long`, `community_short`, `community_long`
- 비공식 채널 영상은 `community_short`/`community_long`으로 태깅

**새 cron 스케줄**: `*/15 * * * *` (15분마다, Vercel Cron Pro 또는 Supabase pg_cron)

**주의**: 200개 채널 RSS fetch를 Vercel 서버리스 10초 안에 처리하려면
- 병렬 fetch (Promise.allSettled, concurrency 20)
- 실패한 채널은 skip & 다음 cycle에 재시도
- 또는 채널을 4그룹으로 나눠 4개 cron (그룹A: 0,15,30,45분 / 그룹B: 3,18,33,48분 등)

---

### Phase 3: 선수 자동 태깅 강화

**현재**: `videos-shorts` cron에서 YouTube Search API로 선수 검색 → `player_id` 부여

**변경**: RSS 수집 시 제목+설명 텍스트에서 자동 태깅

```typescript
// 선수 사전 (players 테이블에서 로드)
const PLAYER_ALIASES: Record<string, string[]> = {
  'p_park_haemin': ['박해민', '행장님', '해미니', '행장', 'Park Hae-min'],
  'p_kim_doyoung': ['김도영', '도영이', '킹도영'],
  // ... 등록 선수 전체
};

function tagPlayers(title: string, description: string): string[] {
  // 제목 + 설명에서 매칭되는 player_id 배열 반환
}
```

- `videos` 테이블에 `player_ids text[]` 컬럼 추가 (다중 선수 태깅)
- 매칭 실패한 영상도 팀 수준 태깅은 유지 (`channel_pool.team_affinity` 기반)

---

### Phase 4: 공식영상 숏폼 중복 제거

**규칙**:
- 공식채널 영상 중 `is_short_candidate = true`인 건 → `source_type = 'official_short'`
- 홈 "공식영상" 섹션: `official_long`만 노출
- 홈 "숏츠" 섹션: `official_short` + `community_short` 합산 노출
- 중복 판정: 같은 `video_id`는 1건만 (현재도 PK로 보장)

---

### Phase 5: 피드 랭킹 & 다양성

**숏츠 피드 정렬 기준**:
1. 유저 최애선수 매칭 (최우선)
2. 유저 팀 매칭
3. 신선도 (업로드 시간)
4. 채널 tier (높을수록 신뢰)
5. **다양성 보정**: 같은 채널에서 연속 3개 이상 노출 방지

**페이지네이션**: 30개씩 로드 (현재 ReelViewer와 동일)

---

## 5. Quota 영향

| 단계 | API 호출 | Quota 비용 |
|---|---|---|
| Phase 1 (채널 발굴) | search.list × ~50회 | ~5,000 units (1회) |
| Phase 2 (RSS 수집) | 0 | 0 |
| Phase 3 (선수 태깅) | 0 (텍스트 매칭) | 0 |
| Phase 4 (중복 제거) | 0 | 0 |
| Phase 5 (랭킹) | 0 | 0 |
| **일상 운영** | **0** | **0** |

→ B안 Phase 2 완료 후 런타임 quota도 0이 되면, **전체 quota 사용 = 0/day**

---

## 6. 리스크

| 리스크 | 대응 |
|---|---|
| RSS 15분 갱신 = 유튜브 대비 최대 15분 딜레이 | 허용 범위. 실시간 필요 없음 |
| 비공식 채널 노이즈 (무관 영상, 저품질) | noise_flags 확장 + tier 기반 필터 |
| 선수 별명 사전 관리 부담 | 초기 인기 50선수만 → 점진 확장 |
| Vercel Cron 15분 제한 (무료 플랜: 일 1회) | Pro 플랜 또는 Supabase pg_cron 전환 |
| 채널 풀 노후화 (비활성 채널 누적) | 월 1회 `last_video_at` 기준 비활성 처리 |

---

## 7. 우선순위 제안

1. **Phase 4** (공식영상 숏폼 중복 제거) — 가장 빠르게 체감, 코드만 수정
2. **Phase 1** (채널 풀 구축) — 1회성 batch, 기반 작업
3. **Phase 2** (RSS 수집 확장) — 채널 풀 완성 후 바로 적용
4. **Phase 3** (선수 태깅 강화) — 별명 사전 구축 필요
5. **Phase 5** (피드 랭킹) — 데이터 쌓인 후 튜닝

Phase 1~3이 완료되면 "최애선수 숏츠 = 크보팬" 목표 달성.

---

## 8. B안과의 관계

이 스펙은 B안을 **확장**합니다:
- B안 Phase 1 (cron 수집) → 채널 풀 확장으로 자연 확장
- B안 Phase 2 (런타임 전환) → 이 스펙과 독립적으로 진행 가능
- 이 스펙의 Phase 2가 B안 `/api/cron/videos`를 대체/확장
