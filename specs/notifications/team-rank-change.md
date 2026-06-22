# 팀 순위 변동 알림 (team_rank_change)

상태: 구현 (2026-06-22, 하린아빠 요청 #dev 스레드)

## 목적
최애팀의 KBO 팀 순위가 바뀌면 푸시로 알린다. 앱 재유입 + 순위 경쟁의 재미 강화.

## 발화 정책 — 옵션 A (하린아빠 확정: "A로 가자")
KBO 순위는 경기가 final 될 때만 바뀐다(라이브 중엔 불변). 순위가 실제 바뀐 *그 순간* 즉시 발화한다.
- warmup cron이 매분 standings를 보고, team별 마지막 *발송* 순위와 다르면 즉시 발송.
- "확정된 순간" = 경기 종료로 순위가 바뀐 시점.
- 트레이드오프(허용): 저녁에 게임이 하나씩 끝나며 같은 팀이 두 번 바뀌면 두 번 발송(되돌림) 가능.
  시즌 중후반 변동 빈도가 낮고, 알림이 유입을 drive하는 게 목표라 A 채택(하린아빠 판단).
- B안(그날 종료 후 최종순위 1회)은 채택하지 않음.

## 수신 / 문구
- 대상: 해당 팀을 최애팀으로 둔 유저(`profiles.team_id`).
- 토글: `team_rank_change` (notification_prefs, 기본 ON). row 없음 = 기본값.
- 제목: `🚀 {팀}  순위 상승` / `〽️ {팀} 순위 하락` (팀 = shortName, 예: LG)
- 본문: `{팀}의 팀 순위가 {N}단계 {상승|하락}하여 {순위}위가 되었습니다`
- 딥링크: `/standings`

## 순위 산정 (4/11 공동순위 핫픽스 001bf82c와 동일)
- 네이버 API 원본 `ranking`(공동순위 반영)이 있으면 그대로 사용.
- 없으면 승률 내림차순 competition ranking — 동률은 같은 순위(1,2,2,4…).
- ⚠️ winRate-sort+index+1 단순 방식은 공동순위를 깨므로 쓰지 않음(삼순 #406 NO-GO 반영).

## 구현
- `src/lib/notifications/team-rank-message.ts` — `buildRankChangeMessage()` 순수 함수(문구).
- `src/lib/notifications/team-rank.ts` — `notifyTeamRankChanges(games)` 오케스트레이터.
- `src/app/api/cron/game-events-warmup/route.ts` — 매분 warmup cron에서 호출(별도 cron 불필요 →
  vercel cron 등록 변경 없음). 실패해도 warmup 본연 동작 무영향(try/catch).
- `supabase/migrations/20260622_team_rank_notify.sql` — 토글 컬럼 + `team_rank_notify_state` 테이블.

### dedup / seed
- `team_rank_notify_state(team_id PK, rank, updated_at)` — team별 마지막 *발송* 순위.
- 현재 순위 == 마지막 발송 순위면 무발송(변동 없음).
- 최초 도입/팀 첫 기록은 발송 없이 baseline만 seed → 배포 직후 과거 변동 일괄 발송 차단.
- 발송 성공 시에만 baseline 전진 — 인프라 실패는 다음 run 재시도(중복 < 누락).

## 회귀
`npm run qa:team-rank` — 문구 빌더 5케이스(상승/하락/1단계/변동없음 null).

## v1 한계 (삼순 리뷰 포인트)
- standings API가 경기 종료 직후 잠깐 stale/부분 응답이면 잘못된 순위로 1회 발송 후 다음 run에 정정
  (또 1회) 가능. KBO 순위는 종료와 거의 동시 갱신이라 위험 작음.
- 같은 팀이 저녁에 두 번 순위 바뀌면 두 번 발송(되돌림) — 정책 A의 의도된 트레이드오프.
- 정확 동률(같은 winRate) 순위는 winRate-position 기준(team-card와 동일). 공동순위 세부 타이브레이크 미반영.
