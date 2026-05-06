# 팀 뉴스탭 썸네일 (og:image) 적용

**Slack thread:** #product 1778054850.099459 (2026-05-06)
**Branch:** `feature/team-news-thumbnails`
**Status:** 1차 구현 완료 (`39fc65ce`) → 보강/QA/PR 단계
**Owner:** 삼식이

## 배경

네이버 뉴스 검색 API는 썸네일 URL을 주지 않는다. 핏차픽처럼 큰 썸네일 카드형 피드를 만들기 위해 기사 원문 og:image를 서버에서 추출해 응답에 머지한다.

스코프: 팀 뉴스탭(`/teams/[teamId]/news`) **만**. 홈 `NewsCarousel`은 안정화 후 2단계로 분리.

## 1차 구현 (이미 들어감, `39fc65ce`)

**`src/app/api/news/route.ts`**
- `attachThumbnails()` 추가: 응답 상위 N건 og:image 추출 → 머지 (N = `THUMBNAIL_FETCH_LIMIT`)
- `extractMetaImage()`: og:image / twitter:image / twitter:image:src / image / image_src 5단계 fallback
- `fetchThumbnailUrl()`: SSRF 가드(localhost/사설망 차단), 2.5s timeout, 300KB body cap, text/html만 허용
- `mapWithConcurrency()`: 동시성 4, 인덱스 보존
- `cleanHtml()`로 HTML entity decode 통합 (중복 제거)

**`src/app/(main)/teams/[teamId]/news/page.tsx`**
- `NewsItem.thumbnailUrl?: string | null`
- 카드 레이아웃 변경: 16:9 큰 썸네일 + 텍스트 본문 (썸네일 있을 때만 노출)
- `referrerPolicy="no-referrer"` + `onError` 시 썸네일 영역 숨김

## 보강 항목 (이번 세션에서 처리)

### B1. og 캐시 분리 (P0)
**현재 문제**: og 결과는 전체 news 응답 캐시(1h)에만 들어감. og 추출 실패해도 1h 동안 빈 thumbnailUrl이 굳음.

**수정**:
- og:image URL 단위 별도 in-memory 캐시 (`Map<articleUrl, {thumb, ts}>`)
- 성공 TTL: 24h, 실패 TTL: 10분 (실패 폭주 방지)
- 캐시 사이즈 가드: 500개 LRU eviction (`/api/og-meta` 패턴 차용)

**B1 후속 보강 (삼순이 코드리뷰 P0, 2026-05-06)**: URL 단위 캐시만으로는 부족. 1시간 응답 캐시가 `thumbnailUrl` 포함된 최종 응답을 통째로 저장하면, og 일시 실패가 응답 캐시에 굳어 실패 TTL 10분이 무력화됨.
- 응답 캐시는 _썸네일 없는 raw items_만 저장
- 캐시 hit/miss 양쪽에서 매 요청마다 `attachThumbnails(items)`를 다시 태움 → URL 단위 TTL이 항상 적용

### B2. 실패 시 UI fallback 명시 (P0)
**현재**: 썸네일 없으면 텍스트만 보임 (16:9 영역 자체 비노출).

**판단**: 그대로 OK. 텍스트 카드도 충분히 가독성 있음. 별도 placeholder 추가하지 않음.
(만약 하린아빠가 placeholder 원하면 팀컬러 그라데이션 + 신문 아이콘으로 보강.)

### B3. 자동화 QA 게이트 (P0 — 머지 게이트)
- `scripts/qa/news-thumbnail.mjs`: `/api/news?team={LG,KIA,두산,KT,SSG,NC,롯데,삼성,한화,키움}` 10팀 전수
- 각 팀당 응답에서 thumbnailUrl 채움률 측정 (목표: ≥60%, P1: 30~60%, NO-GO: <30%)
- 실패 시 어떤 도메인이 og 추출 실패하는지 로그 (`originallink` host별 success/fail 카운트)
- 결과 JSON `e2e/screenshots/news-thumbnail-report.json`에 저장

### B4. 홈 NewsCarousel 미적용 명시 (P0 — 회귀 방지)
**확인사항**: `NewsCarousel.tsx` / `NewsFeed.tsx`가 같은 `/api/news`를 호출하는가?
- YES → API에서 og 추출이 항상 돌아 홈에도 영향. 캐시는 공유되니 비용은 동일하지만 UI는 안 바뀜 (NewsCarousel이 thumbnailUrl 안 읽으면).
- 차후 NewsCarousel 적용은 별도 PR/spec.

### B5. og 추출 실패 도메인 분석 (P1)
B3 QA 결과 기반: 자주 실패하는 언론사 도메인 식별 → 별도 추출 로직 필요한지 판단 (예: 네이버 뉴스 본문, 다음 뉴스 등). 별도 PR 후보.

### B6. 썸네일 부착 게이트 + IPv6 SSRF (P1, 삼순이 코드리뷰 2026-05-06)
- `/api/news`는 `PlayerNews`(`q=`)에서도 호출됨. 팀 뉴스탭(`team=`) 외에서는 og fetch 비용을 피하기 위해 썸네일 부착 안 함.
- 게이트: `team` 파라미터가 있거나 명시적 `includeThumbnail=1`인 경우에만 `attachThumbnails` 호출.
- SSRF 가드 추가: IPv6 ULA `fc00::/7` (`^f[cd][0-9a-f]{2}:`), 링크로컬 `fe80::/10` (`^fe[89ab][0-9a-f]:`).
- WHATWG `URL.hostname`은 IPv6를 `[::1]`처럼 대괄호 포함해서 반환하므로 매칭 전에 strip 처리.

### B7. 응답 카드 전수 커버 (P0, 하린아빠 실기 회귀 2026-05-06)
**문제**: `THUMBNAIL_FETCH_LIMIT = 12`였으나 Naver 응답은 `display=20`이라 13~20번째 카드는 `thumbnailUrl` 없이 텍스트만. 스크롤 후 갑자기 빈 카드 → UX 일관성 깨짐.
**또 한 가지 — QA 갭**: `scripts/qa/news-thumbnail.mjs`도 `FETCH_LIMIT=12` 기본값이라 자기충족적 측정. 13~20 미커버.
**수정**:
- `THUMBNAIL_FETCH_LIMIT = 20` (Naver display와 동일)
- QA 스크립트 `FETCH_LIMIT` 기본값도 20
- _trade-off_: 첫 캐시 미스 응답 시간 ↑ (12 → 20개 og fetch). concurrency=4 유지. 캐시 차면 정상화.

## NOT-DOING (스코프 외)

- 홈 `NewsCarousel` 적용
- 이미지 proxy/CDN (hotlink 차단 회피) — `referrerPolicy="no-referrer"`로 1차 대응. 깨짐 다발 시 별도 PR.
- og 추출 실패 도메인 보강 (B5는 분석만)
- 선수 뉴스 페이지 적용 — 같은 API 쓰지만 UI 변경 없음 (자동 적용)

## QA 게이트 (머지 조건)

1. ✅ 자동화 (`scripts/qa/news-thumbnail.mjs`): 10팀 평균 thumbnailUrl 채움률 ≥60%
2. ✅ TypeScript: `pnpm tsc --noEmit` 통과
3. ✅ Build: `pnpm build` 통과
4. ✅ Lint: `pnpm lint` 통과 (existing eslint-disable 유지)
5. ⏳ 실기기 확인은 머지 게이트 아님 (자동화 통과 시 PR 가능)

## 작업 순서

1. spec 컨펌 (이 문서)
2. B1 og 캐시 분리 구현
3. B3 QA 자동화 스크립트 작성
4. B4 홈 NewsCarousel 영향 확인
5. tsc/build/lint
6. push 승인 요청 → PR
