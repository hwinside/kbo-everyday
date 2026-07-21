# 기사별 댓글 — 구현 계획

## 아키텍처 선택

기존 `comments` 테이블과 `CommentSheet`를 재사용하기 위해 기사마다 숨김 `posts` 행을 브리지로 둔다. 새 댓글 테이블과 UI를 복제하는 방식보다 기존 답글·좋아요·미디어·운영자 권한·블라인드 로직을 그대로 상속해 변경 면적과 정책 불일치를 줄인다.

## 구현 순서

1. URL 정규화 및 입력 검증 순수 함수를 추가하고 단위 테스트를 작성한다.
2. `news_discussions` 테이블, 인덱스, RLS, 브리지 포스트 통계 제외 마이그레이션을 추가한다.
3. 멱등 get-or-create API, 홈 댓글 수 배치 조회 API와 rate limit을 구현한다.
4. 공용 `NewsCommentButton`을 만들고 기존 `CommentSheet`를 연결한다.
5. 홈은 최대 10건 댓글 수를 단일 요청으로 불러와 카드에 표시하고 작성·삭제 시 즉시 동기화한다.
6. 팀·선수·뉴스클리핑·공용 뉴스 카드에 버튼을 적용하고 원문 클릭과 이벤트를 분리한다.
7. 타입체크·lint·단위/통합 테스트·빌드·실사용자 UI QA를 수행한다.

## 예상 변경 파일

- `supabase/migrations/*_news_article_discussions.sql`
- `src/lib/news/discussion.ts`
- `src/lib/news/discussion.test.ts`
- `src/app/api/news/discussion/route.ts`
- `src/components/news/NewsCommentButton.tsx`
- `src/components/news/NewsCard.tsx`
- `src/components/news/NewsCarousel.tsx`
- `src/app/(main)/teams/[teamId]/news/page.tsx`
- `src/components/player/PlayerNews.tsx`
- `src/components/dm/NewsClippingCard.tsx`
- `src/types/news-clipping.ts`, `src/lib/news-clipping.ts` (향후 클리핑 payload에 원문 canonical URL 보존)
- 필요 시 관리자 콘텐츠 통계 쿼리의 브리지 포스트 제외 조건

## 위험과 대응

- 동시 요청으로 브리지 중복 생성: `article_key` PK + 충돌 시 승자 재조회/고아 포스트 삭제.
- 외부 호출로 DB 행 남용: 엄격한 입력 검증 + IP rate limit + 서비스 키 없는 환경 fail closed.
- 홈 댓글 수 N+1 요청: 최대 10개 article key를 한 번에 조회하고 없는 댓글방은 0으로 반환.
- 같은 기사 키 불일치: 원문 URL 우선 및 추적 파라미터 제거 규칙을 순수 함수로 고정.
- 카드 클릭 회귀: interactive element 중첩 제거와 원문/댓글 동작별 UI 테스트.
- 기존 댓글 정책 이탈: 별도 댓글 CRUD를 만들지 않고 `CommentSheet`/`comments`를 직접 재사용.

## 롤백

- UI 버튼과 API를 제거하면 기존 원문 열기 기능은 즉시 원복된다.
- `news_discussions`와 숨김 브리지 포스트는 사용자 피드에 노출되지 않는다.
- 데이터 삭제가 필요할 때는 별도 승인된 후속 마이그레이션으로만 수행한다.
