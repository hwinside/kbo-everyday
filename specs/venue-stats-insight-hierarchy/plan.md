# 구현 계획

1. 시즌 경기 검증 객체에 공식 최종 스코어와 팀 ID를 보존하고 B3 시즌 평균 득점을 계산한다.
2. `venue-stats/ui.ts`에 의미 방향, 최고 스플릿, 궁합점수, 태그 생성 순수 함수를 추가한다.
3. 대시보드를 결론 우선 구조로 재배치한다.
   - 핵심 증감 카드
   - 상대/요일/구장 문장형 인사이트
   - 최애 궁합점수
   - 다중 태그 칩
   - 접힌 상세 원자료/데이터 기준
4. aggregate/UI/browser 회귀를 보강하고 전체 필수 게이트를 실행한다.

## 변경 범위

- `src/lib/venue-stats/types.ts`
- `src/lib/venue-stats/aggregate.ts`
- `src/lib/venue-stats/ui.ts`
- `src/app/api/me/venue-stats/route.ts`
- `src/components/my/VenueStatsDashboard.tsx`
- 직관 통계 QA 스크립트

## 롤백

단일 PR revert. DB 스키마 및 저장 데이터 변경 없음.
