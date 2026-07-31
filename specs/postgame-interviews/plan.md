# 구현 계획

1. 순수 정책 모듈에 재탐색 간격, 제목 날짜 판정, 고신뢰 경기 매핑을 둔다.
2. `postgame_interview_jobs`에 종료 감지·다음 탐색·24시간 만료 상태를 저장한다.
3. 5분 크론이 due job만 공식 채널 RSS로 훑고, 실제 탐색 간격은 정책 모듈이 제어한다.
4. 매핑된 원본 영상은 `postgame_interviews`에 멱등 upsert한다.
5. 공개 조회 API와 종료 경기 상세의 조건부 카드를 연결한다.
6. 순수 정책 smoke, lint, build로 검증한다.
