# OG metadata stability

**Status:** REVIEW — 구현·자동 검증 완료, 삼순 재리뷰 대기
**Owner:** 삼식이
**Reviewer:** 삼순이

## 문제

홈 뉴스 10건이 각자 `/api/og-meta`를 호출하고, 실패 응답은 캐시하지 않아 같은 원문 장애를 반복 호출한다. 2026-07-21 운영 로그에서 약 3분 동안 502가 100건 이상 발생했다. 화면은 텍스트로 폴백해 사용자 장애는 아니지만 함수 호출량·비용·로그 노이즈가 커진다.

## 요구사항

- 홈 뉴스의 OG 요청은 렌더당 최대 1회 batch 호출로 합친다.
- 같은 URL은 batch 내부와 동시 요청 간에 1회만 upstream fetch한다.
- 성공은 1시간, 실패/빈 OG는 5분 캐시한다. 캐시는 인스턴스당 최대 500개 LRU다.
- upstream 전체 작업은 redirect를 포함해 5초 안에 끝낸다.
- 같은 host의 retryable 실패가 3회 연속이면 2분간 circuit을 열고 즉시 폴백한다.
- OG 실패는 뉴스 텍스트 렌더를 막지 않으며 batch 응답은 개별 실패를 `null`로 반환한다.
- 기존 단건 GET 계약과 SSRF 차단은 유지한다.

## 비범위

- Redis/KV 등 전역 캐시 도입
- 이미지 프록시/CDN
- 뉴스 검색·정렬·카드 UI 변경

## 완료 기준

- 자동 smoke에서 batch URL 중복 제거, 성공/실패 캐시, circuit open이 검증된다.
- TypeScript, lint, production build가 통과한다.
- Preview에서 홈 뉴스 텍스트가 먼저 보이고 OG 실패 시 깨진 카드 없이 폴백한다. (PR 생성 후 검증)
