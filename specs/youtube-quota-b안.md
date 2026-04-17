# B안: YouTube API quota 의존도 제거 & Cloud-native cron

**작성자**: 삼식이
**작성일**: 2026-04-17
**상태**: 스펙 초안 (하린아빠 승인 대기)
**관련 이슈**: 2026-04-16 홈 숏츠 quota 소진 사라짐 사태

---

## 1. 목표

- **런타임 YouTube API 호출 제거** — 유저 요청 시점에 외부 API 호출 0
- **quota 소진 ≠ 서비스 장애** — YouTube quota가 바닥나도 홈 숏츠/공식영상 노출 유지
- **cloud-native cron** — 맥미니 의존성 0 (Vercel Cron만 사용)
- **DB(Supabase) = 영상 SSOT** — 홈/상세 API는 Supabase SELECT만

## 2. 원칙 (하드 조건)

### NO-GO
- ❌ 맥미니 local cron (crontab/launchd)
- ❌ 맥미니 스크립트/파일/인증 의존
- ❌ "맥미니가 켜져 있어야 도는" 구조

### GO
- ✅ Vercel Cron → Next.js API route
- ✅ (대안) Supabase Edge Function + pg_cron
- ✅ 모든 외부 fetch는 서버리스 컨텍스트 내에서 완결

### Quota 사용 범위 (명확화 — 2026-04-17 삼순이 요청 반영)
- **quota 0 범위**: RSS로 커버되는 10개 구단 공식채널 롱폼/숏츠만
- **별도 저quota 옵션**: 범용 "KBO 하이라이트" 검색, 선수 TOP N 확장 검색
  - 기본값: ON (하루 ~3,000 units 예상)
  - 환경변수 `FEATURE_PLAYER_SEARCH=false`로 OFF 가능 (RSS만으로 서비스 유지)
  - 이렇게 분리하면 quota 소진 시에도 핵심 숏츠는 유지됨

## 3. 현재 구조 (As-Is) 문제점

| 영역 | 현재 | 문제 |
|------|------|------|
| `/api/highlights` | mem-cache + 런타임 YouTube 검색 + Supabase fallback | quota 소진 시 fallback만 쓰는데 개인화 불완전 |
| `/api/team-videos` | 런타임 YouTube 검색 + highlights 테이블 fallback | quota 소진 시 롱폼 없음, 썸네일 품질 저하 |
| `/api/cron/highlights` | RSS(10팀) + API(_ALL) 4시간마다 | RSS는 OK, API는 quota 100/회 소비 |
| 모니터링 | `job_runs` 로그만 | 실패 연속 감지/알림 없음 |

## 4. To-Be 아키텍처

```
┌─────────────────────────────────────────────────────────┐
│ Vercel Cron (cloud-native, 맥미니 무관)                  │
│                                                          │
│  ┌──────────────────┐    ┌──────────────────────────┐   │
│  │ cron/videos      │    │ cron/videos-shorts       │   │
│  │ - 10팀 RSS 롱폼   │    │ - 10팀 RSS 숏츠          │   │
│  │ - quota 0         │    │ - 선수 TOP30 YouTube API │   │
│  │ - 6h 간격         │    │ - 4h 간격, degrade 지원   │   │
│  └────────┬─────────┘    └──────────┬───────────────┘   │
│           └─────────────┬──────────┘                     │
│                         ▼                                │
│                  Supabase `videos` 테이블                 │
└─────────────────────────────────────────────────────────┘
                          ▲
                          │ SELECT only
                          │
┌─────────────────────────┴────────────────────────────────┐
│ 런타임 API (YouTube 직접 호출 0)                          │
│                                                           │
│  /api/team-videos  /api/highlights                        │
│  - 2차 필터만 수행 (allowlist)                             │
│  - 랭킹: 최애선수 > 공식채널 > 팀 일반                      │
└───────────────────────────────────────────────────────────┘
```

## 5. DB 스키마: `videos` 테이블 (신규)

```sql
create table videos (
  id bigserial primary key,
  video_id text not null unique,
  team_id text not null,             -- LG/두산/...
  player_id text references players_roster(kbo_id),  -- nullable
  title text not null,
  channel text,
  channel_id text,                   -- 공식채널 구분용
  thumbnail text,
  published_at timestamptz not null,
  duration_seconds int,              -- RSS는 NULL 가능
  source_type text not null,         -- 'official_long' | 'official_short' | 'player' | 'team_search'
  is_short_candidate boolean not null default false,
  noise_flags jsonb default '[]'::jsonb,  -- ['highlight_compilation', 'fancam', 'vlog'] etc
  fetched_at timestamptz not null default now()
);

create index idx_videos_team_source on videos(team_id, source_type, published_at desc);
create index idx_videos_player on videos(player_id, published_at desc) where player_id is not null;
create index idx_videos_shorts on videos(is_short_candidate, published_at desc) where is_short_candidate = true;
```

기존 `highlights` 테이블은 deprecated (마이그레이션 후 drop).

## 6. 필터 2단계

### 1차 필터 (수집 시, cron 내부)
- RSS 썸네일 존재 여부
- YouTube API 결과면 duration ≤ 70s OR 제목에 shorts/숏츠/쇼츠 포함
- `noise_flags` 태깅만 하고 저장은 함 (노출 시 필터링)

### 2차 필터 (노출 시, 런타임 API)
- `noise_flags` 기반 제외: `highlight_compilation`(H/L), `fancam`(직캠), `vlog`, `ceremony`(시구)
- 팀별 allowlist/denylist (추후 확장 포인트)
- 환경변수로 hot-swap 가능

## 7. 홈 랭킹 로직

우선순위:
1. **최애선수 관련** (`player_id = 유저최애`) - 상위 5개
2. **공식채널** (`source_type = 'official_short'`) - 다음 10개
3. **팀 일반** (`source_type = 'team_search'`) - 나머지 채움

규칙:
- 동일 `video_id` 중복 제거
- 개수 부족 시 팀 일반으로 보충 (빈 섹션 hide 최소화)
- 섹션 최소 3개 이하면 다른 팀 인기 영상까지 허용 (optional, 추후)

## 8. Cron 전략

### 스케줄
| Cron | 주기 | quota |
|------|------|-------|
| `/api/cron/videos` (롱폼 RSS) | 6시간마다 | 0 |
| `/api/cron/videos-shorts` (숏츠 RSS + 선수 API) | 4시간마다 | ~3,000/일 (선수 TOP 30 기준) |
| 기존 `/api/cron/highlights` | 제거 예정 | - |

### Degrade 전략 (quota 임계치 근접)
```
if (quotaUsed / quotaLimit > 0.8) {
  // 선수 확장 검색 건너뛰고 공식/팀 RSS만 수집
  skipPlayerQueries = true;
}
```
quota 추적은 Supabase `quota_usage` 테이블에 hourly 적재.

### Vercel 제약 체크
- Pro 플랜: 40 crons/account (현재 6개 + 신규 2개 = 8개, 여유)
- 서버리스 60초 한도: 10팀 RSS 순차 = 2~3초, 선수 API 30쿼리 = ~15초 (안전)
- 메모리 1024MB: RSS XML 파싱 메모리 < 10MB

## 9. 운영 가시성 (Admin Dashboard 확장)

```
/admin/videos
 ├─ 팀별 마지막 수집 시각
 ├─ 팀별 적재 건수 (롱폼/숏츠 분리)
 ├─ quota 사용량 (일별 그래프)
 ├─ 실패 사유 top5
 └─ 0건 팀 알림 (Slack #cs 스레드)
```

자동 알림:
- cron 2회 연속 실패 → Slack `#cs` 스레드
- 0건 팀 2시간 지속 → Slack 알림
- quota 사용률 90% 초과 → 하린아빠 텔레그램

## 10. 마이그레이션

1. **Phase 0 (준비)**: `videos` 테이블 생성 migration
2. **Phase 1 (병행 수집)**: 신규 cron 추가, 기존 `/api/cron/highlights`와 병행
3. **Phase 2 (런타임 전환)**: `/api/highlights`, `/api/team-videos`를 `videos` 테이블로 전환
4. **Phase 3 (정리)**: `/api/cron/highlights` 제거, `highlights` 테이블 drop

각 Phase 사이 배포 분리 — 롤백 용이성 확보.

## 11. QA 기준

- [ ] YouTube API quota 0 상태 시뮬레이션 → 홈 숏츠/공식영상 정상 노출
- [ ] LG 오스틴 최애 설정 시 오스틴 관련 영상이 상단에 노출
- [ ] H/L·직캠·시구·vlog성 영상 비노출
- [ ] 동일 video_id 중복 노출 없음
- [ ] cron 실패 시에도 기존 `videos` 데이터로 서빙 유지
- [ ] 맥미니 종료 상태에서 cron 정상 실행 (Vercel 대시보드 확인)

## 12. 예상 공수

| Phase | 내용 | 공수 |
|-------|------|------|
| 0 | 테이블 migration + 타입 정의 | 0.5일 |
| 1 | 신규 cron 2개 구현 + RSS/API 통합 | 1일 |
| 2 | 런타임 API 전환 + 랭킹 로직 | 1일 |
| 3 | Admin 대시보드 + 알림 + 정리 | 0.5일 |
| **총** | | **3일** |

## 13. 리스크

- **RSS 범위 한계**: 구단 공식 채널만 가능 → "KBO 하이라이트" 범용 검색은 선수 API로 대체
- **실시간성 저하**: 선수별 영상은 최대 4시간 지연 (허용 가능 판단)
- **schema 변경**: `highlights` 테이블 deprecate → 다른 페이지 의존성 사전 스캔 필요 (`/api/highlights` 외 사용처 확인)

## 14. 참고

- [[YouTube-하이라이트]] 위키
- [[아키텍처]] 위키
- 2026-04-16 B안 합의 스레드: Slack #cs 1776308360.041739
