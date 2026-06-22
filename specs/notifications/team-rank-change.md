# 팀 순위 변동 알림 (team_rank_change)

상태: 구현 (2026-06-22, 하린아빠 요청 #dev 스레드)

## 목적
최애팀의 KBO 팀 순위가 바뀌면 푸시로 알린다. 앱 재유입 + 순위 경쟁의 재미 강화.

## 발화 정책 — 옵션 B (하린아빠 확정: "B로 가자")
KBO 순위는 저녁 내내 출렁인다(한 팀이 안 뛰어도 타 팀 경기 종료로 상대순위 변동). "확정된 순간"마다
발화하면 같은 날 상승→하락 되돌림 알림이 갈 수 있다. 따라서:

- **그날(KST) 경기가 전부 종료/취소된 뒤 최종순위가 확정될 때 1회만** 발화.
- 전일(마지막 확정) 순위 대비 변동이 있는 팀에만 발송. 변동 없으면 미발송.
- A안(매 변동 즉시)은 채택하지 않음.

## 수신 / 문구
- 대상: 해당 팀을 최애팀으로 둔 유저(`profiles.team_id`).
- 토글: `team_rank_change` (notification_prefs, 기본 ON). row 없음 = 기본값.
- 제목: `🚀 {팀}  순위 상승` / `〽️ {팀} 순위 하락` (팀 = shortName, 예: LG)
- 본문: `{팀}의 팀 순위가 {N}단계 {상승|하락}하여 {순위}위가 되었습니다`
- 딥링크: `/standings`

## 순위 산정
`fetchStandings()` 결과를 winRate 내림차순 정렬한 위치(index+1) = 순위.
team-card route(`rank: idx+1`)와 동일 기준이라 사용자가 보는 순위표와 일치.

## 구현
- `src/lib/notifications/team-rank-message.ts` — `buildRankChangeMessage()` 순수 함수(문구).
- `src/lib/notifications/team-rank.ts` — `notifyTeamRankChanges(games)` 오케스트레이터.
- `src/app/api/cron/game-events-warmup/route.ts` — 매분 warmup cron에서 호출(별도 cron 불필요 →
  vercel cron 등록 변경 없음). 실패해도 warmup 본연 동작 무영향(try/catch).
- `supabase/migrations/20260622_team_rank_notify.sql` — 토글 컬럼 + `team_rank_notify_state` 테이블.

### dedup / seed
- `team_rank_notify_state(team_id PK, rank, settled_date, updated_at)` — team별 마지막 확정 순위.
- 오늘 settle 여부 = state에 `settled_date = 오늘`인 행 존재. 있으면 재발화 안 함.
- 최초 도입/팀 첫 기록은 발송 없이 baseline만 seed → 배포 직후 과거 변동 일괄 발송 차단.

## 회귀
`npm run qa:team-rank` — 문구 빌더 5케이스(상승/하락/1단계/변동없음 null).

## v1 한계 (삼순 리뷰 포인트)
- standings API가 종료 직후 지연되면 settle 순간 직전 순위를 읽을 수 있음(date dedup으로 재평가 안 함).
  실측상 KBO 순위는 경기 종료와 거의 동시 갱신이라 위험 작음. 필요 시 settle 지연 가드 추가 가능.
- 발송 실패 팀도 baseline은 전진 → 드물게 1회 누락 가능(저빈도·일 1회라 허용).
- 정확 동률(같은 winRate) 순위는 winRate-position 기준(team-card와 동일). 공동순위 세부 타이브레이크 미반영.
