# Live Activity W3 — APNs 백그라운드 푸시 (실시간 갱신 + 자동 시작 + 토글)

> 상태: W3a ✅(#246) · W3c ✅(#259) · **W3b ✅(2026-06-14, this PR)**
> 트리거: 잠금화면 위젯 백그라운드 미갱신(점수 0:0 고정) + "앱 안 들어가도 최애팀 경기 시작 시 자동 표시 + 마이페이지 on/off".

## 1. 아키텍처 — 직접 APNs (FCM 불가)

- ⚠️ Live Activity 푸시는 FCM으로 못 보냄. **직접 APNs**:
  - `apns-push-type: liveactivity`, `apns-topic: fan.keubo.app.push-type.liveactivity`
  - update/end payload: `{ aps: { timestamp, event, "content-state", "dismissal-date"?, "stale-date"? } }`
  - **start(W3b) payload**: 위 + `"attributes-type"`, `"attributes"`(static), `"alert"?`
- 인증: APNs 토큰(JWT ES256) — `.p8` + Key ID + Team ID. env `APNS_KEY_ID`/`APNS_TEAM_ID`/`APNS_P8`/`APNS_ENV`.

## 2. 토큰 종류 (ActivityKit)

- **per-activity push token**(`activity.pushTokenUpdates`): 경기룸 진입 start 시 발급 → `live_activity_tokens`. 그 경기 갱신/종료(W3a).
- **push-to-start token**(`Activity<Attrs>.pushToStartTokenUpdates`, **iOS 17.2+**): 앱 미실행 상태 원격 시작용. 디바이스당 1개 → `live_activity_start_tokens`. 최애팀 경기 시작 시 사용(W3b).

## 3. 슬라이스

### W3a — 실시간 갱신 ✅(#246)
- 클라 `start`에서 `pushType:.token`, `pushTokenUpdates` → `POST /api/live-activity/register`. 서버 `pushLiveActivityUpdates`가 스코어 변화 시 `event:update`, 종료 시 `event:end`+dismissal-date.

### W3b — 자동 시작 (앱 미실행, iOS 17.2+) ✅ 2026-06-14
- **클라**: 앱 부팅 시(NativePushMount → `bootstrapLiveActivityPushToStart`) `pushToStartTokenUpdates` 관찰 → `POST /api/live-activity/register-start`. iOS 17.2 미만 no-op(W2 경기룸 진입 start로 폴백). 비로그인 부팅 후 SIGNED_IN 시 `reregisterPushToStartToken`.
- **서버**: warmup cron `pushLiveActivityStarts(games)` — 라이브 경기를 게임 단위 1회 선점(`live_activity_started` insert)하고, 최애팀(away/home) 팬의 push-to-start 토큰으로 APNs `event:start`(초기 content-state + attributes, myTeamCode=수신자 팀 강조). W3c off·이미 그 경기 활성 토큰 보유 유저 제외. 시작 윈도우(+90분) 밖이면 발송 없이 마킹. 이후 갱신은 W3a.
- **DB**: `live_activity_start_tokens`(user_id PK) + `live_activity_started`(game_id PK 선점 마커).
- **APNs**: `apns.ts` `event:"start"` 지원(`attributes-type`/`attributes`/`alert`).

### W3c — 마이페이지 토글 ✅(#259)
- `notification_prefs.live_activity`(디폴트 on). 클라 off면 토큰 등록 skip + 서버 발송 제외. (W3b 등록 엔드포인트·발송 양쪽 동일 게이트 적용.)

## 4. 비범위 / 한계
- 멀티 디바이스(디바이스당 토큰 1개, 최신 1개만). 다중 라이브 경기 시 push-to-start는 게임별 독립(잠금화면 카드 다수 가능).
- iOS 17.2 미만은 자동 시작 없음(경기룸 진입 시 W2 start로 폴백).
