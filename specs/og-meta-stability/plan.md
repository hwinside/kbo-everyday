# Plan

1. `/api/og-meta`의 fetch를 단일 resolver로 모아 success/failure TTL, in-flight dedupe, total timeout, host circuit breaker를 적용한다.
2. POST batch 계약을 추가하되 기존 GET 응답은 유지한다.
3. `NewsCarousel`의 10개 단건 요청을 1개 POST로 교체한다.
4. 결정 로직 smoke, tsc, lint, build로 검증한다.
5. PR 생성 후 Slack에서 삼순 GO를 받고, 하린아빠 승인 전에는 머지하지 않는다.
