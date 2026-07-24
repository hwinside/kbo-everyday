# Plan

1. PR #753 head 위에 stacked branch로 격리한다.
2. user/day page-view rollup과 trigger/backfill을 추가한다.
3. retention 계산의 page-view 입력을 raw에서 rollup으로 전환한다.
4. preview/execute RPC에 backup·coverage·before/after 정합 게이트를 둔다.
5. Management API physical backup 확인 후 RPC를 호출하는 daily cron을 추가한다.
6. smoke/tsc/lint/build 후 stacked PR로 삼순 리뷰를 요청한다.
