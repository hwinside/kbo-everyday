# YouTube 하이라이트 시스템 스펙

## 현재 구현 (v2 — 2026-03-04)

### 아키텍처
```
유저 → GET /api/highlights?team=LG → 서버 메모리 캐시 확인
                                       ↓ cache miss
                                    YouTube Search API × 2 동시 호출:
                                      ① "{팀} {팀명} 하이라이트" (경기 영상)
                                      ② "{팀} {스타1} {스타2} {스타3}" (개인 영상)
                                       ↓
                                    중복 제거 → 최신순 정렬 → 30개 저장
                                       ↓
                                    4시간 캐시 (같은 팀 전체 유저 공유)
```

### API 엔드포인트
- **경로**: `GET /api/highlights`
- **파라미터**:
  - `?team=LG` — 팀별 최적화 경로 (권장)
  - `?q=커스텀쿼리` — 하위 호환 (비권장, 캐시 효율 낮음)
- **응답**: `{ items: VideoItem[] }`
- **파일**: `src/app/api/highlights/route.ts`

### VideoItem 구조
```ts
{
  id: string;          // YouTube 영상 ID
  title: string;       // 디코딩된 제목
  thumbnail: string;   // 고화질 썸네일 URL
  channel: string;     // 채널명
  publishedAt: string; // ISO 날짜
  label?: string;      // 프론트에서 부여 (선수명 or 팀명)
}
```

### 팀별 고정 쿼리 (TEAM_QUERIES)
| 팀 | 쿼리1 (팀) | 쿼리2 (스타선수) |
|---|---|---|
| LG | LG 트윈스 하이라이트 | LG 박해민 문보경 홍창기 |
| 두산 | 두산 베어스 하이라이트 | 두산 양의지 허경민 박찬호 |
| KT | KT 위즈 하이라이트 | KT 강백호 소형준 쿠에바스 |
| SSG | SSG 랜더스 하이라이트 | SSG 최정 추신수 김광현 |
| NC | NC 다이노스 하이라이트 | NC 박건우 구창모 손아섭 |
| KIA | KIA 타이거즈 하이라이트 | KIA 김도영 나성범 양현종 |
| 삼성 | 삼성 라이온즈 하이라이트 | 삼성 구자욱 김영웅 원태인 |
| 롯데 | 롯데 자이언츠 하이라이트 | 롯데 전준우 한동희 박세웅 |
| 한화 | 한화 이글스 하이라이트 | 한화 노시환 강백호 문동주 |
| 키움 | 키움 히어로즈 하이라이트 | 키움 이형종 안우진 하영민 |

> ⚠️ 스타선수 목록은 시즌 중 성적/인기에 따라 주기적 업데이트 필요

### 프론트엔드
- **파일**: `src/components/home/HomeHighlights.tsx`
- **릴스 뷰어**: `src/components/home/ReelViewer.tsx`
- 프론트는 `?team=` 1회만 호출
- 30개 결과에서 최애선수 이름 제목 매칭 → 레이블 부여 + 우선 정렬
- 썸네일 10개 / 릴스 30개

### 캐시 전략
| 항목 | 값 | 근거 |
|---|---|---|
| 캐시 위치 | 서버 메모리 (Map) | Vercel serverless는 cold start 시 리셋 |
| TTL | 4시간 | 무료 할당량 내 유지 |
| 캐시 키 | 팀명 (10개 고정) | 유저별 분리 없음 |
| 에러 캐시 | ❌ 안 함 | 할당량 초과 시 다음 요청에서 재시도 |

### API 비용 계산
```
YouTube Data API v3 무료 할당량: 10,000 units/일
Search API: 100 units/회

현재: 10팀 × 2쿼리 × 6회/일(4hr캐시) = 120회 = 12,000 units
→ ⚠️ 약간 초과 가능 (Vercel cold start 시 캐시 리셋되면)

실제: cold start 빈도 낮으면 ~6,000~8,000 units 예상
```

### 알려진 제한사항
1. **Vercel serverless cold start**: 메모리 캐시 리셋 → API 재호출
2. **최애선수 개인화 한계**: 고정 스타 3명 외 선수는 제목 매칭 의존
3. **할당량 초과 시**: 빈 배열 반환 (에러 미캐시, 다음 요청에서 재시도)
4. **비시즌**: 하이라이트 영상 생산량 급감 → 빈 결과 가능

---

## 확장 로드맵

### Phase 1: Supabase 캐시 (DAU 100+)
```
Cron (4시간마다) → YouTube API → Supabase `highlights` 테이블
유저 요청 → Supabase 읽기 (API 호출 0)
```
- **장점**: cold start 무관, API 호출 완전 통제
- **테이블 구조**:
  ```sql
  CREATE TABLE highlights (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team TEXT NOT NULL,
    video_id TEXT NOT NULL,
    title TEXT,
    thumbnail TEXT,
    channel TEXT,
    published_at TIMESTAMPTZ,
    fetched_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(team, video_id)
  );
  CREATE INDEX idx_highlights_team ON highlights(team, published_at DESC);
  ```
- **Cron**: OpenClaw cron or Vercel Cron (`/api/cron/highlights`)
- **API 호출**: 10팀 × 2쿼리 × 6회/일 = 120회 (서버에서만, 유저 무관)

### Phase 2: 유저 최애선수 반영 (DAU 1,000+)
- Supabase에 `favorite_highlights` view 추가
- 인기 선수 TOP 50 기준 추가 쿼리 (Cron)
- 총 API: (10팀 + 50선수) × 6회 = 360회 = 36,000 units → 할당량 증가 필요
- **YouTube API 할당량 증가 신청** (무료, 심사 1~2주)

### Phase 3: 자체 영상 인덱싱 (DAU 10,000+)
- YouTube 채널 구독 (RSS 또는 PubSubHubbub webhook)
- 영상 업로드 시 자동 인덱싱 → DB 저장
- API 호출 거의 0
- 채널 목록: KBO 공식, SPOTV, SBS Sports, 각 팀 공식

### Phase 4: 공식 파트너십 (DAU 100,000+)
- KBO/방송사와 파트너십 → 영상 직접 제공
- YouTube API 의존도 0
- 자체 CDN으로 영상 서빙 가능

### YouTube API 키 관리
- **현재**: 1개 키 (harinclaw Google Cloud)
- **백업**: 다른 Google 프로젝트에서 추가 키 발급 가능
- **할당량 증가**: [Google Cloud Console](https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas) → 요청
- **키 환경변수**: `YOUTUBE_API_KEY` (Vercel + 로컬)

### 스타선수 목록 업데이트 주기
- **시즌 시작 전**: 전체 팀 스타 3명 갱신
- **올스타 브레이크**: 전반기 성적 기반 갱신
- **트레이드 데드라인 후**: 이적 선수 반영
- **포스트시즌**: 활약 선수 추가

---

## 변경 이력
| 날짜 | 버전 | 변경 |
|---|---|---|
| 2026-03-02 | v1 | 초기 구현: 유저별 N+1 쿼리, 30분 캐시 |
| 2026-03-04 | v2 | 팀 고정 2쿼리, 4시간 캐시, 프론트 제목 필터링 |
