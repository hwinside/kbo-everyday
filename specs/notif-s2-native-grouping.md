# S2 — 크보팬 P0 알림/위젯 native 본체 (경기별 그룹 + 종료 후 보존)

> **SSOT: 이 스펙 문서 + (추후) Notion 링크 `<Notion SSOT: TBD>`.**
> Branch: `feat/notif-s2-native-grouping` · Base HEAD: `047149a7e87d0c829c21cd8503c900719041ca79`
> 이 PR = **native 본체만**. 서버 축 중 **#894(S1-a, squash f402daa5b)에 실제 포함된 것 = terminal 전용 collapse key 분리 + `w_final` tombstone 뿐**이다.
> ⚠️ 정정(삼순 2차 NO-GO #1): **`n_expires_at`(이벤트 절대 만료)·버전 게이트 3분할 fanout·`terminal=final|cancelled` 필드는 #894에 없다 — 전부 S2 서버 후속**(§③ 서버 파트)이다. 이전 표기에서 `n_expires_at`을 "#894 반영분"으로 묶었던 것은 오류이므로 S2 서버 후속으로 정정한다.
> 이 문서의 "서버 파트"(§③)는 S2 성립을 위해 서버가 **추가로** 해야 할 사항을 명시할 뿐, 여기서 서버 코드를 건드리지 않는다.
> **이 문서는 스펙 초안이다. 앱 코드(.java/.ts) 구현은 후속 슬라이스 PR에서 진행한다.**

## 하린아빠 확정(B안)
"지나간 알림도 트레이에 다 보존"(한참 뒤 폰 여는 유저) = **개별 이벤트 알림을 다 유지 + 경기별로 그룹**. 경기가 종료돼도 **지난 이벤트 알림은 트레이에 남는다** — 종료는 *라이브 카드/위젯의 수렴* 신호일 뿐, 이벤트 알림을 지우는 신호가 아니다.

- **보존 상한 = 6시간**(하린아빠 2026-07-27 확정). 이벤트 child·group summary는 각각 **게시 기준 6h 또는 사용자 dismiss까지** 트레이에 남는다.
- **종료(game_end) 시 하는 일** = ① 잠금 라이브 카드(7001) clear ② 위젯 `FINAL` 수렴 ③ group summary를 **최종 스코어로 idempotent 갱신**. 이벤트 child는 **cancel하지 않는다**.
- **"경기 알림 모두 지우기"** = 자동 정리가 아니라 **summary의 명시적 사용자 액션**(summary 탭/전용 버튼 → 해당 경기 그룹 일괄 cancel). 유저가 원할 때만 비운다.

> ⚠️ 초안 대비 변경(삼순 NO-GO #1): 이전 스펙의 "`game_end → child+summary 일괄 cancel`"은 **B안과 정반대**였다. 본 개정에서 "종료 시 이벤트 일괄 cancel"은 전면 제거하고 "종료 시 라이브/위젯만 수렴 + 이벤트 6h/dismiss 보존"으로 재서술한다.

---

## ① 현 native 구조 요약 (실측)

대상 파일 4개(+봉투/상태 2개)를 실측한 결과.

### (a) 이벤트 배너(안타/홈런/득점)가 지금 그려지는 방식 — **native 미개입**
- native 트리 전체에서 `.notify(...)` 호출은 **단 하나** — `GameNotificationPlugin.post()`의 `NotificationManagerCompat.notify(NOTIFICATION_ID=7001, ...)` (잠금화면 ongoing 라이브 카드).
- `KboMessagingService.onMessageReceived`는 맨 앞에서 `super.onMessageReceived(remoteMessage)`(capawesome `MessagingService`)를 호출한 뒤, `NativeLiveEnvelope.parse`가 **위젯 제어 kind(`game_live`/`game_cancel`/`game_end`)가 아니면 곧바로 `return`**한다.
- 안타/홈런/득점 배너 키워드(`안타`/`홈런`/`득점`/`homerun`/`event_type`/`eventId`)는 native java에 **0건**.
- ⇒ **이벤트 배너는 서버가 FCM `notification` payload로 보내고 시스템(capawesome super)이 그린다.** native는 그룹/tag/id/타임아웃을 전혀 부여하지 않는다.

### (b) `game_end` 수신 시 하는 일
`onMessageReceived`의 `game_end` 분기(현재 APPLIED일 때만):
- `GameNotificationPlugin.clear(this)` → **`cancel(NOTIFICATION_ID 7001)` — 잠금 라이브 카드 하나만 내림.** 이벤트 배너는 손대지 않음.
- `TeamRankWidget.fetchAndRefresh` / `PlayerCardWidget.fetchAndRefresh` (미배치면 no-op).
- `pushGameEndToWatch` (워치 수렴).
- 위젯 자체는 `GameScoreWidget.markFinal`로 **비우지 않고 status만 `FINAL`로** 남긴다(06:00 롤오버용, 주석 명시).

> **P0 근본진단**
> - **③ 이벤트 알림 20개 누적·안 지워짐** = 서버가 배너별 collapse/tag/그룹을 안 줘서 시스템 기본대로 무한 스택. (B안은 "지우기"가 아니라 **경기별 그룹으로 접기 + 6h 보존**이 목표.)
> - **② 종료됐는데 위젯이 9회로 얼어붙음** = `markFinal`이 **fail-closed**(정확한 gid 일치 + 유효 seq 필수, `WidgetUpdatePolicy.decideTerminal`). gid 공백/불일치·`w_ts` 누락이면 terminal을 `STALE`/`NOOP`로 **드롭** → 위젯이 라이브(9회) 상태로 고착. data-only best-effort라 종료 신호 자체가 유실되면 복구 경로가 없음. **또한** terminal side effect가 `APPLIED`에만 묶여 있어 prefs 적용 후 카드 clear/summary 갱신 전 프로세스가 죽으면 재전송이 `NO_CHANGE`로 판정돼 **영구 미복구**(NO-GO #4).
> - **① 위젯 지연** = `game_live` data → prefs → AppWidget 직결이라 지연은 **서버 전송 주기**가 지배(추가 폴링은 삼순 기존 NO-GO). native가 개선 가능한 축은 '정확도'뿐(순서 역전 차단은 이미 구현됨).

### (c) 위젯 갱신/종료 처리
- 갱신: `game_live` data → `NativeLiveState.apply` → prefs 원자 저장 + `RemoteViews` 재렌더. `WidgetUpdatePolicy.decide`가 **seq(=`w_ts`) watermark**로 순서 역전(`STALE`)·중복(`NO_CHANGE`)·모호 동률(`INVALID`)을 가른다.
- 종료: `markFinal` → `KEY_STATUS=FINAL`, `KEY_LAST_SEQ` 전진, `KEY_SIG` 제거, `refresh`. **위젯을 비우지 않음**(스코어·gameId 보존, 06:00 `pastRollover`에서 다음 예정 경기로 전환).

### (d) 과거 seq(`w_ts`) 처리 — 있음
- `NativeLiveEnvelope`: `sourceTs=w_ts`(미전달 -1=가드 비활성), `orderTs = w_source_at → w_ts → 수신시각` 단일 계약.
- `WidgetUpdatePolicy.decide`/`decideTerminal`: seq watermark + terminal retry(`RETRY_ADVANCE_SEQ`)로 "종료 후 저-seq live 차단". **단, 더 높은 seq의 후속 live는 여전히 적용됨** → `w_final` tombstone이 없으면 늦게 온 고-seq live가 FINAL을 되살릴 수 있음(②의 잔여 엣지). S1-a의 `w_final`이 이 구멍을 닫는 전제.

### (e) 알림 group/tag/id 부여 — **없음**
- native가 게시하는 알림은 **고정 `NOTIFICATION_ID=7001` 단 하나**. `setGroup`/`setGroupSummary`/`setTimeoutAfter` 사용처 **0건**. 이벤트 배너는 native를 거치지 않아 그룹 개념 자체가 부재.

### (f) 앱 버전 신호 — **이미 존재 (초안 오류 정정)**
> ⚠️ 초안 대비 정정(삼순 NO-GO #3): 이전 스펙의 "버전 신호 부재"는 **오류**다. 신호는 이미 흐르고 있다.
- `src/lib/native-push.ts` — `App.getInfo().build`를 읽어 `appBuild`(양수 정수, 아니면 null)로 `/api/push/register-device`에 전송(실측 L38·L125~141).
- `src/app/api/push/register-device/route.ts` — `appBuild`를 검증(`Number.isFinite && >0` 아니면 null) 후 `device_push_tokens.app_build`에 **fail-closed 저장**(실측 L15~30).
- ⇒ 서버는 **토큰별 `app_build`를 이미 가지고 있다.** Slice 0은 "신호 발명"이 아니라 **기존 경로 검증 + Android `versionCode` 임계값(min) 고정 + 분기 로직 추가**가 전부.
- 정정 포인트: `app_build`가 **null인 Android**(구버전/등록 실패/미갱신)는 fail-safe로 **구버전 취급**(notification 유지).

### (g) foreground 이중노출 위험 — **실측 확인 (스펙 신규 계약)**
- `src/lib/native-push.ts`의 `FOREGROUND_SUPPRESSED_KINDS` = `{game_live, game_end, game_cancel, la_wake, widget_live}`(실측 L18~24). foreground 수신 시 이 집합의 kind면 JS 인앱 배너를 게시하지 않는다(L226).
- **`game_event`는 이 집합에 없다.** native가 `game_event`를 IMPORTANCE_HIGH로 직접 게시(heads-up)하면서 JS도 인앱 배너를 그리면 **foreground에서 이중 노출**(NO-GO #5). → §S2-6에서 계약 고정.

---

## ② S2 설계 (실측 구조 기반)

### S2-1. 이벤트 배너 data-only 전환 + native 렌더 (경기별 그룹, 6h 보존)
- **서버(파트, ③에 명시)**: 신버전(Android `app_build >= min`) 단말에는 이벤트 배너를 `notification` payload 없이 **data-only**로 전송. data에 최소:
  - `kind="game_event"`, `gameId`, `eventId`(안타/홈런/득점 등 이벤트 고유키), `title`, `body`, `url`(딥링크), `w_ts`
  - **`sub`(구독 namespace)** = `score`/`concede`/`inning-summary`/`fav` 중 하나 — 같은 플레이(raw play id)라도 서로 다른 구독 알림이 서로를 덮지 않도록 알림 identity에 포함(NO-GO #3).
  - **`n_expires_at`**(절대 만료 epoch ms = 이벤트 발생/게시 시각 + 6h) — 수신시각 기준이 아닌 **절대 만료시각**(NO-GO #2).
- **native**: `NativeLiveEnvelope.parse`에 `KIND_EVENT="game_event"`를 **추가**(현재 위젯 3종만 인식하고 나머지는 null 반환하므로 지금은 그냥 빠짐). `onMessageReceived`가 이벤트 kind를 감지하면 위젯 상태머신(`NativeLiveState.apply`)을 타지 않고 **전용 렌더 경로**로 분기.
- **만료 가드(NO-GO #2)**: 렌더 진입 시 `now >= n_expires_at`이면 **drop**(늦게 배달된 stale 이벤트가 유령 summary를 부활시키지 못하게). 유효하면 child에 `setTimeoutAfter(max(0, n_expires_at - now))` 적용(수신시각 + 6h가 아니라 절대 만료까지 남은 시간).
- **summary 수명·유령 생성 계약 확정(삼순 2차 NO-GO #2)**: 초안의 "마지막 수신 이벤트 expiresAt으로 summary timeout 재설정"은 **버그**(최신 child 뒤 늦게 도착한 old child가 summary를 더 일찍 만료시킴). 계약을 다음으로 고정한다:
  - **`active non-expired child >= 1`일 때만 summary가 존재**한다. 자식 0이면 summary는 없어야 한다(생성 금지).
  - **`summary.setTimeoutAfter = max(0, (maxₐ active child.expiresAt) - now)`** — 개별 이벤트 expiresAt이 아니라 **현재 활성 child들의 최대 expiresAt**을 기준. child 추가/및/만료로 registry가 바뀌면 summary timeout도 이 값으로 재산출 갱신.
  - **terminal(종료)은 빈 registry면 no-op/cancel** — registry가 비었거나 전부 dismiss된 경기에서 terminal 갱신이 summary를 **새로 생성/부활시키지 않는다**(§S2-2·§S2-4 계약).
- **개별 swipe 배선(NO-GO #2)**: child마다 **per-child `deleteIntent`(PendingIntent → BroadcastReceiver)** 를 달아, 유저가 개별 스와이프하면 receiver가 registry를 **원자 갱신**(해당 id 제거) → 남은 active child 0이면 **summary cancel까지 실제 배선**. dismiss/만료/prune 세 경로 모두 이 불변을 지킨다.
- **렌더**: 신규 클래스 `EventNotifications`(정적 헬퍼) 또는 `GameNotificationPlugin`에 `postEvent(ctx, gameId, sub, eventId, title, body, path, expiresAt)` 추가. `NotificationCompat.Builder`로:
  - `setGroup("game:" + gameId)` — 경기별 그룹.
  - 개별 알림 id = **`sub + gameId + eventId` 안정 해시**(namespace 포함, 중복 배달 시 동일 id로 덮어써 중복 방지, 서로 다른 이벤트/구독은 각각 트레이 유지). 예: `("evt:"+sub+":"+gameId+":"+eventId).hashCode()`(충돌 우려 시 FNV 등 안정 해시).
  - **그룹 summary 알림**(id = `("grp:"+gameId).hashCode()`, `setGroupSummary(true)` + `InboxStyle`/카운트) 1개를 함께 게시 → 여러 배너가 하나로 접힘(Android 그룹 계약: 자식 2개+summary 필요). summary `setTimeoutAfter = max(0, (maxₐ active child.expiresAt)-now)`(개별 이벤트 아닌 **활성 child 최대 expiresAt** 기준, 위 summary 수명 계약).
  - **그룹 이중 alert 가드(NO-GO #4)**: child 채널이 `IMPORTANCE_HIGH`(heads-up)라 child+summary를 매 이벤트 함께 notify하면 소리/heads-up이 2회 터질 수 있다. → **child와 summary 양쪽에 `setGroupAlertBehavior(GROUP_ALERT_CHILDREN)`** 계약 명시(alert는 child만, summary는 음소거/heads-up 없이 집계만). 같은 event 재전송은 동일 id로 덮어쓰며 `setOnlyAlertOnce(true)`로 추가 alert 0(§S2-5 native 멱등 계약과 정합).
  - **summary의 명시적 "모두 지우기" 액션**: summary에 탭/버튼 액션을 달아 유저가 명시적으로 누르면 해당 경기 그룹 child+summary를 일괄 cancel(§S2-2). 자동 정리 아님.
  - 이벤트 전용 **채널 신설**(`game_event`, `IMPORTANCE_HIGH`, heads-up). 기존 `game_live_card`(ongoing, 7001)와 분리 — 채널 importance/역할 충돌 방지.
- **active registry(NO-GO #2)**: 경기별 활성 이벤트를 prefs(`kbo_event_notif`, key=`gameId`)에 **`{id, postedAt, expiresAt}` 리스트(JSON)** 로 기록(초안의 eventId CSV 폐기). 게시/취소/만료 시 갱신하고, 게시·복귀 등 기회가 있을 때 `now >= expiresAt`인 항목을 **opportunistic prune**(만료 회수 + 자식 0이면 summary도 cancel).
- **효과**: 지나간 안타/홈런/득점이 **각각 트레이에 다 남되(최대 6h)** 경기별 그룹으로 접혀 20개가 벽처럼 쌓이지 않음. 종료돼도 이벤트는 남는다.

### S2-2. 종료 = 라이브/위젯 수렴 (이벤트는 보존)
> ⚠️ NO-GO #1 반영: 초안의 "종료 시 그 경기 그룹 일괄 cancel"은 **삭제**. 종료 분기는 이벤트 child를 건드리지 않는다.
- **terminal 구분(삼순 2차 NO-GO #5)**: #894 공용 clear는 정상·취소 모두 `kind=game_end`(정상만 `w_as`/`w_hs`, 취소는 score 없음). 서버(S2 서버 파트)가 **`terminal=final|cancelled` 명시 필드**를 실어 보내고, native는 이 필드로 분기:
  - `terminal=final` → group summary를 **최종 스코어**(필요 팀명/`w_as`/`w_hs`)로 idempotent 갱신.
  - `terminal=cancelled` → group summary를 **`경기 취소`**로 idempotent 갱신(score 없음). 취소도 child는 **6h 보존**.
  - **공통 가드**: 둘 다 **활성 child가 0이면 summary 생성 금지**(빈 registry면 no-op/cancel — 위 summary 수명 계약·§S2-4).
- `onMessageReceived`의 `game_end` 분기(§S2-4의 idempotent 계약)에서:
  - 잠금 라이브 카드(7001) `clear()` — 유지.
  - 위젯 `markFinal`(FINAL 수렴) + tombstone(§S2-3).
  - **group summary를 terminal 구분(final → 최종 스코어 / cancelled → `경기 취소`)에 따라 idempotent 갱신**(재수신 시 동일 결과 — 내용 불변). **단 활성 child 0이면 생성하지 않고 cancel**. child는 유지.
- **이벤트 child cancel은 세 경로에서만 발생**:
  1. `setTimeoutAfter(max(0, expiresAt-now))` **자동 만료**(6h 절대 상한).
  2. **사용자 dismiss**(개별 스와이프) 또는 **summary의 명시적 "모두 지우기" 액션**(그 경기 그룹 일괄 cancel + summary cancel).
  3. opportunistic prune(만료분 회수).
- **summary 유령 방지**: 자식이 0이 되면(전부 dismiss/만료) summary도 반드시 cancel — **per-child `deleteIntent` receiver · 만료 콜백 · opportunistic prune 세 경로 모두**에서 registry 원자 갱신 후 0개 판정 시 cancel(§S2-1 summary 수명 계약). terminal 갱신도 빈 registry면 summary 부활 금지.

### S2-3. 위젯 종료 잔류(9회 고착) 해소
- **경기별 단일 위젯 상태**는 이미 prefs 단일 슬롯(`kbo_game_widget`)이라 구조 유지. 문제는 **종료 신호 유실 시 복구 부재**.
- `w_final` tombstone(S1-a 서버) 수신 → `markFinal` 적용 후, **같은 경기의 후속 LIVE를 `w_ts`(seq) 무관 무시**하는 게이트 추가. 현재 `decideTerminal`의 `RETRY_ADVANCE_SEQ`는 저-seq만 막으므로, `KEY_FINALIZED_GAME`(tombstoned gameId) prefs를 두고 `decide`/`writeInternal` 진입 시 `gameId==KEY_FINALIZED_GAME`면 `STALE` 조기 반환.
- **복구 경로(핵심, NO-GO #4로 "필수" 승격)**: data-only best-effort 유실 대비 **pull 재수렴**은 완료기준상 **필수**(선택 아님).
  - `MainActivity.onResume`(현재 `onNewIntent`만 존재, `onResume` 미구현) 또는 앱 복귀 시 → 위젯이 라이브 상태로 남아있으면 **서버 최신 경기 상태 재조회**(경량 GET) → FINAL이면 `markFinal` + tombstone.
  - 네트워크 복구 시(ConnectivityManager 콜백) 동일 재조회.
  - **폴링과의 분리(삼순 기존 "추가 폴링 NO-GO" 준수)**: 재조회는 **single-flight + debounce**로 묶어 이벤트성 1회만 발화(앱 복귀/네트워크 복구 각 1회, 동시 중복 발화 억제). 주기 폴링 아님.

### S2-4. 종료 side effect idempotency (false-green 차단, NO-GO #4)
- 초안은 terminal side effect를 `decideTerminal == APPLIED`에만 묶었다. → prefs 전진 후 카드 clear/summary 갱신 전 프로세스가 죽고 재전송이 오면 `decideTerminal == NO_CHANGE`(seq 이미 전진)로 판정돼 **부수효과가 영구히 안 돎**.
- **계약**: 같은 경기의 **valid terminal**(gameId 일치 + 유효)은 `decideTerminal`이 **`APPLIED`이든 `NO_CHANGE`이든** 다음을 **idempotent 실행**:
  - 잠금 라이브 카드(7001) clear
  - 위젯 FINAL 수렴 + `KEY_FINALIZED_GAME` tombstone 기록
  - group summary 갱신 — `terminal=final`면 최종 스코어, `terminal=cancelled`면 `경기 취소`로 idempotent 갱신(재실행해도 동일 결과). **활성 child가 0이면 summary를 생성/부활하지 않는다**(빈 registry no-op/cancel — §S2-1 summary 수명 계약).
- **부수효과 0인 경우**: `STALE`(저-seq)·`INVALID`(모호 동률)·**다른 경기**의 terminal. 이 3종만 아무것도 하지 않는다.
- 네트워크 복구 1회 재조회(§S2-3)는 이 idempotent 종료 처리의 **최종 안전망**이자 완료기준 항목.

### S2-5. 버전 게이트 (기존 신호 검증 + 임계값 고정, NO-GO #3)
> ⚠️ 초안의 "버전 신호 추가"는 폐기(신호는 이미 있음 — §①-f). 아래로 재작성.
- **선결 = 기존 경로 검증**: `native-push.ts` `appBuild` 전송 + `register-device` `app_build` 저장이 실제로 채워지는지 확인(회귀 테스트). 값이 흐르는지 실측 검증만 하면 되고 새 신호는 만들지 않음.
- **Android `versionCode` 임계값 고정**: data-only 이벤트 렌더가 들어간 **첫 릴리즈의 `versionCode`**를 `min`으로 서버 상수 고정.
- **서버 fanout — 토큰별 3분할**:
  - **iOS** → 기존 `notification`(APNs 경로 불변).
  - **Android, `app_build` null 또는 `< min`** → 기존 `notification`(구버전/미상 → fail-safe 시스템 렌더).
  - **Android, `app_build >= min`** → **data-only**(native 렌더).
- **방식 확정(삼순 2차 NO-GO #3)**: 초안의 "각 `(token, eventId, sub)` 조합 exactly-once"는 **구현 불가지** — FCM accepted≠실도달이고(재시도 불가피), collapse key를 범용하면 서로 다른 child 보존과 상충한다. 계약을 다음으로 고정한다:
  - **서버 = at-least-once 재시도**(실패/미확인 bucket 재전송 허용) + **native = at-most-one visible child**. 즉 보이는 child는 (배달이 몇 번 오든) 최대 1개.
  - native가 **안정 key(`sub+gameId+eventId`) registry/dedupe**로 중복 배달을 동일 id로 덮어쓰거나(**duplicate drop**) `setOnlyAlertOnce(true)`로 추가 alert 없이 갱신. → 배너는 1개 유지, 재전송해도 새 트레이 항목/소리 안 늘어남.
  - **collapse key**는 terminal 전용(S1-a 분리)만 쓰고, 이벤트 child 간에는 쓰지 않는다(서로 다른 child 보존).
  - **crash window 회귀 잠금(필수)**: 서버 fanout이 일부 token 발송 후 죽었다가(부분 발송) 재시도하는 시나리오를 **성공/실패 token ledger**로 기록하고, 재시도가 이미 성공한 token을 다시 때려도 native at-most-one으로 보이는 child가 늘지 않음을 **회귀 테스트로 잠그다**.
- 게이트 신호가 없으면(Android app_build null) 서버는 보수적으로 구버전 취급(notification 유지).

### S2-6. foreground 이중노출 계약 (NO-GO #5)
- native 렌더가 활성인 빌드(data-only `game_event`를 native가 heads-up으로 직접 게시)에서는 JS 인앱 배너가 **같은 `game_event`를 다시 그리면 안 된다.**
- **계약 고정**: `native-push.ts`의 `FOREGROUND_SUPPRESSED_KINDS`에 **`game_event` 추가**(native 렌더 활성 빌드 기준) → foreground 수신 시 JS 배너 suppress, native heads-up 한쪽만 표시.
  - 대안(빌드 분기 필요 시): native 렌더 미활성(구버전에서 여전히 JS가 그려야 하는 경우)과 구분해야 하면, "native 렌더 활성" 플래그 조건부 suppress. 단 S2 타깃(신버전)에서는 **native 단일 표시**가 계약.
- 목표: foreground에서 heads-up + 인앱 배너 **이중 노출 0**.

---

## ③ 서버 파트 필요사항 (이 PR 밖, S2 성립 전제)
1. **이벤트 배너 data-only 전환**: Android `app_build >= min` 단말에 `game_event` data-only 전송 — `eventId`/`gameId`/`sub`/`w_ts`/**`n_expires_at`(절대 만료, S2 서버 후속 — #894에 없음)** 포함. (구버전/iOS는 notification 유지.)
2. **버전 게이트 fanout 3분할 + at-least-once/at-most-one 멱등**: §S2-5 — iOS/구Android/신Android 분기. 서버 at-least-once 재시도 + native at-most-one visible child. 성공/실패 token ledger로 crash window 잠금.
2b. **`terminal=final|cancelled` 명시 필드(S2 서버 후속, NO-GO #5)**: #894 공용 `game_end`(정상·취소 모두 같은 kind)에 terminal 구분 필드 추가 — `final`은 필요 팀/점수(`w_as`/`w_hs`), `cancelled`는 score 없음. native가 summary 문구(최종스코어 vs `경기 취소`)를 가르는 데 사용. #894에는 없고 S2 서버에서 추가.
3. **`n_expires_at` + FCM TTL**: 서버가 절대 만료(발생+6h)를 싣고, **FCM TTL도 남은시간(`expiresAt - now`)으로 제한** → 만료 임박 메시지가 뒤늦게 살아 배달되는 것을 전송단에서도 차단.
4. **`w_final` tombstone**(S1-a #894와 정합): `game_end`/별도 terminal에 `w_final` 마킹 → native tombstone 게이트가 후속 live 무시 판단에 사용.
5. **terminal 전용 collapse key 분리**(S1-a): 이벤트/라이브/종료가 서로 collapse로 덮지 않도록. (이벤트 identity는 native에서 `sub` namespace로도 분리.)
6. **재수렴 GET 엔드포인트**: §S2-3의 경량 최신 경기 상태 조회(위젯 복구용). 없으면 서버 파트에 추가.

---

## ④ 리스크
- **구버전 회귀**: 버전 게이트 오분류 시 신 native가 없는 단말에 data-only가 가면 **배너 전멸**. → 게이트는 fail-safe로 "app_build null/<min = 구버전(notification 유지)". 신호 불확실 시 절대 data-only로 보내지 않음.
- **data-only Doze 배달**: data-only FCM은 Doze/앱standby에서 지연·유실 가능(notification 메시지보다 우선순위 낮음). → 이벤트 배너는 `high` priority FCM으로 전송 요청, native 채널 `IMPORTANCE_HIGH`. 정상 상태(화면OFF/Doze)에선 6h 보존 목표 유지, 유실 대비 위젯 축은 §S2-3 재수렴으로 보강.
- **6h 절대 만료 vs 수신시각**: `setTimeoutAfter`를 수신시각+6h로 두면 늦게 배달된 stale 이벤트가 6h 더 살아남아 유령 summary를 만든다. → **절대 만료(`n_expires_at`) 기준 `max(0, expiresAt-now)`** + 만료분 렌더 drop(§S2-1).
- **summary 계약**: 자식 0이 되면 summary도 반드시 cancel(dismiss/만료/prune 경로 모두) — One UI 유령 summary 방지. summary는 최종 스코어로만 idempotent 갱신, 자동 그룹 cancel 안 함.
- **identity 충돌**: 같은 플레이의 다른 구독(score vs concede vs fav)이 서로 덮이면 알림 유실 → identity에 `sub` namespace 포함(§S2-1). 해시 충돌은 `sub+gameId+eventId` 조합 + 필요 시 FNV.
- **fanout 재시도 중복**: 서버 at-least-once 재시도로 같은 event가 여러 번 배달될 수 있음 → native at-most-one visible child(안정 key registry/dedupe + `setOnlyAlertOnce`/duplicate drop)로 보이는 child 1개 유지(§S2-5). 부분발송 후 crash → token ledger 회귀 테스트.
- **그룹 이중 alert(NO-GO #4)**: IMPORTANCE_HIGH child+summary 동시 notify 시 소리/heads-up 2회 → `GROUP_ALERT_CHILDREN`로 alert를 child로만 집중, 같은 event 재전송은 `setOnlyAlertOnce`(§S2-1).
- **취소 terminal(NO-GO #5)**: `game_end` 공용 kind라 취소 경기가 final-score summary로 잘못 갱신될 위험 → 서버 `terminal=final|cancelled` 명시 필드로 분기(final=최종스코어, cancelled=`경기 취소`), 둘 다 활성 child 0이면 summary 생성 금지.
- **active registry 정합**: 게시/취소 사이 프로세스 종료로 registry와 실제 트레이가 어긋날 수 있음 → registry는 `{id,expiresAt}` 기반 opportunistic prune + `setTimeoutAfter`가 최종 회수. 종료는 registry를 지우지 않음(이벤트 보존).

---

## ⑤ 슬라이스 제안 (얇은 수직 슬라이스 — 빅뱅 금지)
1. **Slice 0 (신호 검증 + 임계값)**: 기존 `appBuild`→`app_build` 경로가 실제로 채워지는지 검증(회귀 테스트) + Android `versionCode` `min` 상수 고정 + 서버 3분할 fanout 스켈레톤(멱등키 포함). **새 신호 발명 없음**, 렌더 변경 없음, 회귀 위험 0.
2. **Slice 1 (렌더 + 만료 가드 + summary 수명)**: `KIND_EVENT` 파싱 + `postEvent`(그룹/summary/`sub` namespace id/채널) + `n_expires_at` drop·child `setTimeoutAfter(max(0,expiresAt-now))` + **summary `setTimeoutAfter=maxₐ active child.expiresAt`** + `{id,postedAt,expiresAt}` registry + **per-child `deleteIntent` receiver(swipe→0개면 summary cancel)** + **`GROUP_ALERT_CHILDREN`+`setOnlyAlertOnce` 이중 alert 가드**. **서버는 아직 notification 유지** → 신버전 소수 단말 data-only 테스트 채널로만 검증. 트레이 6h 보존·그룹 접힘·active child 0이면 summary 없음 확인.
3. **Slice 2 (종료 = 수렴, 보존 유지)**: `game_end`(**`terminal=final|cancelled` 분기**) → 라이브 카드 clear + 위젯 FINAL + **summary idempotent 갱신**(final=최종스코어 / cancelled=`경기 취소`, 활성 child 0면 생성 금지, 이벤트 child 유지) + summary "모두 지우기" 명시 액션 + opportunistic prune. **종료(정상·취소) 후에도 이벤트가 남는지** 확인.
4. **Slice 3 (위젯 tombstone + idempotent terminal + 재수렴)**: `w_final` 게이트 + terminal side effect를 `APPLIED`·`NO_CHANGE` 모두 idempotent 실행(STALE/INVALID/타경기 0) + `onResume`/네트워크 복구 single-flight 재수렴. 9회 고착·false-green 해소 확인.
5. **Slice 4 (foreground suppress)**: `FOREGROUND_SUPPRESSED_KINDS`에 `game_event` 추가(native 렌더 활성 빌드). foreground 이중노출 0 확인.
6. **Slice 5 (게이트 전환)**: 서버가 Android `>=min`에 실제 data-only 전환. 구버전/iOS notification 유지 회귀 테스트. 단계적 롤아웃.

각 슬라이스: 구현→유닛(`WidgetUpdatePolicy`/`composeEvent` 순수 함수 테스트 패턴 踏襲)→기기 검증→다음.

---

## ⑥ 완료 기준 / QA (A17 5상태)
5상태 = **화면OFF · Doze · 네트워크 복구 · 프로세스 종료 · 강제중지**. 각 상태에서:

- **위젯/카드 정상 갱신 P95 ≤ 15초** (서버 전송 주기 내, 배달 성공 시).
- **경기 종료 후 15분 내 위젯 라이브 잔류 0** (tombstone + `APPLIED`·`NO_CHANGE` 모두 idempotent 종료 처리 + single-flight 재수렴으로 9회 고착·false-green 해소).
- **이벤트 알림 보존(B안 핵심)**: 안타/홈런/득점이 **경기별 그룹으로 트레이에 전부 보존**되고, **경기 종료 후에도 남는다**. child·summary는 **게시 기준 6h(절대 만료) 또는 사용자 dismiss까지** 유지. 종료 시에는 **라이브 카드 clear + 위젯 FINAL 수렴 + summary 최종스코어 갱신만** 하고 이벤트 child는 **cancel하지 않는다**. ("종료 시 이벤트 0" 완료기준은 **폐기**.)
- **명시적 정리만 비움**: 유저가 개별 dismiss 하거나 summary "모두 지우기"를 누를 때만 그 경기 그룹이 사라진다.
- **6h 절대 만료**: 늦게 배달된 stale 이벤트(`now >= n_expires_at`)는 렌더 drop, 유효분은 `max(0, expiresAt-now)`로만 잔류 → 유령 summary/과잔류 0.
- **버전 게이트 회귀 0**: Android `app_build null/<min` 및 iOS → notification 유지(배너 유실/그룹 미동작 없음).
- **fanout at-most-one visible child(A17)**: **같은 event 재전송(server at-least-once) = 트레이 child 1개 · 소리/heads-up 0회 추가**(dedupe + `setOnlyAlertOnce` + `GROUP_ALERT_CHILDREN`), **새 event = 정확히 1회 alert**. 부분발송 후 crash → token ledger 회귀로 중복 child 0.
- **취소 terminal(A17)**: `terminal=cancelled` 수신 시 summary=`경기 취소`(score 없음) idempotent 갱신, `final`은 최종스코어. 둘 다 활성 child 0이면 summary 생성 안 됨, child는 6h 보존.
- **foreground 이중노출 0**: `game_event` foreground 수신 시 native heads-up 단일 표시(JS 배너 suppress).
- **네트워크 복구(필수)**: 앱 복귀/네트워크 복구 시 single-flight 재조회 1회로 위젯 상태 정합 회복(폴링 아님).
- **강제중지 후(완료기준 명시)**: 강제중지 중에는 Android 제약상 재기동 전 **FCM 수신 자체가 차단** → 완료기준 = **앱 복귀 시 위젯 상태만 1회 수렴(single-flight 재조회)**. **강제중지 중 놓친 개별 이벤트 배너는 미보장**(bounded replay는 비목표 — 비용 대비 엣지). 정상 상태(화면OFF/Doze)에선 6h 이벤트 보존 목표 유지.

> End-User Level QA 원칙(AGENTS.md): 서버 PASS만으로 마감 금지. 실기기 5상태 + 실유저 동선(트레이 육안 — 종료 후에도 이벤트 남는지, 6h 만료, summary 접힘/명시 정리)까지 확인해야 마감.

---

## 불확실 / 결정 필요 지점
1. ~~`setTimeoutAfter` 상한 값~~ → **해결: 6시간(절대 만료 `n_expires_at` 기준).**
2. **재수렴 GET 엔드포인트**: 위젯 복구용 경량 최신 경기 상태 조회 API가 이미 있는지(없으면 서버 파트 추가). single-flight/debounce 파라미터(디바운스 창) 확정 필요.
3. **`sub` namespace 값 집합**: `score/concede/inning-summary/fav`가 서버 구독 종류와 1:1인지 확인(구독 종류 추가 시 identity 규칙 확장).
4. ~~fanout 멱등 구현 방식~~ → **해결(NO-GO #3): 서버 at-least-once 재시도 + native at-most-one visible child**(안정 key registry/dedupe + `setOnlyAlertOnce`/duplicate drop, 성공/실패 token ledger crash-window 회귀). 남은 세부: token ledger 저장소(서버) 구현 기술 선택.
5. **eventId 안정성**: 서버가 이벤트별 안정 `eventId`를 재전송 시 동일값으로 발급하는지 — 없으면 서버 파트에 "안정 eventId 발급" 추가.
6. **foreground suppress 빌드 분기**: `game_event`를 무조건 suppress할지, "native 렌더 활성" 플래그 조건부로 할지(구버전에서 JS가 여전히 그려야 하는 케이스와의 경계).
