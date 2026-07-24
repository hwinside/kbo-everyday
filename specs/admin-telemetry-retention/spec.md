# Admin telemetry retention

**Status:** REVIEW — 구현·자동 검증 완료, migration 통합 검증/삼순 리뷰 대기
**Owner:** 삼식이
**Dependency:** PR #753 (incremental traffic/dwell rollups)

## 문제

`admin_page_views`와 `admin_page_dwell` raw 원장이 DB 921MB 중 313MB를 차지하고 현재 약 41MB/일 증가한다. 보존정책과 purge가 없어 90일이면 raw만 약 3.7GB가 된다.

## 정책

- raw page view/dwell: 최근 30개 KST 캘린더일 보존
- 집계: 최근 365개 KST 캘린더일 보존
- 기존 PR #753의 일별 PV/UV·app version·dwell session rollup을 집계 SSOT로 사용
- 로그인 유저 리텐션 재계산이 raw purge 후에도 동일하도록 `user_id × day` 활동 rollup을 추가한다.

## 파괴적 실행 게이트

실제 DELETE는 다음을 모두 만족할 때만 허용한다.

1. CRON_SECRET 인증
2. Supabase Management API에서 30시간 이내 `COMPLETED` physical backup 확인
3. raw→rollup coverage mismatch 0
   - page view visitor/day/platform PV
   - user/day page view + game visit
   - raw candidate date의 page-view/user-day rollup-only extra row 포함 양방향 exact match
   - dwell day/platform event count + total dwell
   - dwell platform별 session count
   - raw visitor별 30분 gap 독립 sessionization 후 visitor/session/day/platform dwell 분포 exact match
4. advisory lock으로 동시 purge 차단
5. 삭제 전 후보 수 = 실제 삭제 수. 불일치 시 transaction raise/rollback
6. 실행 결과와 backup ref를 audit table에 기록

수동 `?dryRun=1`은 backup 없이 후보·coverage만 반환하고 DELETE하지 않는다.

## 완료 기준

- policy/backup selection smoke PASS
- retention 기존 smoke PASS
- tsc/lint/build PASS
- migration은 dry-run·prod rollback 통합 검증 후에만 GO
- 같은 event count·총합을 유지한 session dwell 분포 변조도 DELETE 전 차단
- rollup session start/end를 손상해 raw 2세션을 1세션으로 합쳐도 독립 raw sessionization으로 차단
- 하린아빠 머지 승인 전 prod DELETE 0건
