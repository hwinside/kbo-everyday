# 직관 다이어리 v1 — Implementation Plan

1. `venue_attendance` 마이그레이션과 순수 집계/선수 비교 모듈을 추가한다.
2. 직관 스토리가 `active`가 되는 DB trigger에서 실제 GPS 인증 경기만 멱등 기록한다.
3. 인증 전용 `/api/me/venue-attendance`가 공식 경기 결과·이전 평균 대비 최애선수 활약을 조합한다.
4. `/my`에 요약 카드·경기 목록·최애선수 상세 펼침을 구현한다.
5. 순수 회귀·기존 venue 스모크·tsc·lint·End-User QA로 검증한다.

## 변경 경계

- 기존 스토리 미디어 만료·검증·모더레이션 계약은 변경하지 않는다.
- 신규 DB는 API 전용이며 클라이언트 Supabase 직접 쿼리를 추가하지 않는다.
- 최애선수 비교는 이미 적재되는 `player_game_logs`를 SSOT로 재사용하며, 현재·미래 경기는 평균에서 제외한다.
