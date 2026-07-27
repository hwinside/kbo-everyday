# S2 — 크보팬 P0 알림/위젯 native 본체 (경기별 그룹 + 종료 일괄 정리)

> Branch: `feat/notif-s2-native-grouping` · Base HEAD: `047149a7e87d0c829c21cd8503c900719041ca79`
> 이 PR = **native 본체만**. 서버 축(terminal collapse key 분리 + `w_final` tombstone)은 별도 PR #894(S1-a). 이 문서의 "서버 파트"는 S2 성립을 위해 서버가 **추가로** 해야 할 사항을 명시할 뿐, 여기서 서버 코드를 건드리지 않는다.
> **이 문서는 스펙 초안이다. 앱 코드(.java) 구현은 후속 슬라이스 PR에서 진행한다.**

## 하린아빠 확정(B안)
"지나간 알림도 트레이에 다 보존"(한참 뒤 폰 여는 유저) = **개별 이벤트 알림을 다 유지 + 경기별로 그룹 + 경기 종료 시 그 경기 그룹을 한 번에 정리**. (교체·collapse가 아니라 그룹핑.)

---

## ① 현 native 구조 요약 (실측)

대상 파일 4개(+봉투/상태 2개)를 실측한 결과.

### (a) 이벤트 배너(안타/홈런/득점)가 지금 그려지는 방식 — **native 미개입**
- native 트리 전체에서 `.notify(...)` 호출은 **단 하나** — `GameNotificationPlugin.post()`의 `NotificationManagerCompat.notify(NOTIFICATION_ID=7001, ...)` (잠금화면 ongoing 라이브 카드).
- `KboMessagingService.onMessageReceived`는 맨 앞에서 `super.onMessageReceived(remoteMessage)`(capawesome `MessagingService`)를 호출한 뒤, `NativeLiveEnvelope.parse`가 **위젯 제어 kind(`game_live`/`game_cancel`/`game_end`)가 아니면 곧바로 `return`**한다.
- 안타/홈런/득점 배너 키워드(`안타`/`홈런`/`득점`/`homerun`/`event_type`/`eventId`)는 native java에 **0건**.
- ⇒ **이벤트 배너는 서버가 FCM `notification` payload로 보내고 시스템(capawesome super)이 그린다.** native는 그룹/tag/id/타임아웃을 전혀 부여하지 않는다.

### (b) `game_end` 수신 시 하는 일
`onMessageReceived`의 `game_end` 분기(APPLIED일 때만):
- `GameNotificationPlugin.clear(this)` → **`cancel(NOTIFICATION_ID 7001)` — 잠금 라이브 카드 하나만 내림.** 이벤트 배너는 손대지 않음.
- `TeamRankWidget.fetchAndRefresh` / `PlayerCardWidget.fetchAndRefresh` (미배치면 no-op).
- `pushGameEndToWatch` (워치 수렴).
- 위젯 자체는 `GameScoreWidget.markFinal`로 **비우지 않고 status만 `FINAL`로** 남긴다(06:00 롤오버용, 주석 명시).

> **P0 근본진단**
> - **③ 이벤트 알림 20개 누적·안 지워짐** = `clear()`가 7001만 cancel하고 **이벤트 배너에는 아무 정리 훅이 없다.** 서버가 배너별 collapse/tag를 안 주면 시스템 기본대로 무한 스택.
> - **② 종료됐는데 위젯이 9회로 얼어붙음** = `markFinal`이 **fail-closed**(정확한 gid 일치 + 유효 seq 필수, `WidgetUpdatePolicy.decideTerminal`). gid 공백/불일치·`w_ts` 누락이면 terminal을 `STALE`/`NOOP`로 **드롭** → 위젯이 라이브(9회) 상태로 고착. data-only best-effort라 종료 신호 자체가 유실되면 복구 경로가 없음.
> - **① 위젯 지연** = `game_live` data → prefs → AppWidget 직결이라 지연은 **서버 전송 주기**가 지배(추가 폴링은 삼순 기존 NO-GO). native가 개선 가능한 축은 '정확도'뿐(순서 역전 차단은 이미 구현됨).

### (c) 위젯 갱신/종료 처리
- 갱신: `game_live` data → `NativeLiveState.apply` → prefs 원자 저장 + `RemoteViews` 재렌더. `WidgetUpdatePolicy.decide`가 **seq(=`w_ts`) watermark**로 순서 역전(`STALE`)·중복(`NO_CHANGE`)·모호 동률(`INVALID`)을 가른다.
- 종료: `markFinal` → `KEY_STATUS=FINAL`, `KEY_LAST_SEQ` 전진, `KEY_SIG` 제거, `refresh`. **위젯을 비우지 않음**(스코어·gameId 보존, 06:00 `pastRollover`에서 다음 예정 경기로 전환).

### (d) 과거 seq(`w_ts`) 처리 — 있음
- `NativeLiveEnvelope`: `sourceTs=w_ts`(미전달 -1=가드 비활성), `orderTs = w_source_at → w_ts → 수신시각` 단일 계약.
- `WidgetUpdatePolicy.decide`/`decideTerminal`: seq watermark + terminal retry(`RETRY_ADVANCE_SEQ`)로 "종료 후 저-seq live 차단". **단, 더 높은 seq의 후속 live는 여전히 적용됨** → `w_final` tombstone이 없으면 늦게 온 고-seq live가 FINAL을 되살릴 수 있음(②의 잔여 엣지). S1-a의 `w_final`이 이 구멍을 닫는 전제.

### (e) 알림 group/tag/id 부여 — **없음**
- native가 게시하는 알림은 **고정 `NOTIFICATION_ID=7001` 단 하나**. `setGroup`/`setGroupSummary`/`setTimeoutAfter` 사용처 **0건**. 이벤트 배너는 native를 거치지 않아 그룹 개념 자체가 부재.

### (f) 앱 버전 신호 — **부재 (스펙 신규 항목)**
- native java에 `versionName`/`versionCode`/`BuildConfig.*`/`app_version`/`appVersion` **0건**. 토큰 등록 경로에 앱 버전 저장 흔적 없음(capawesome 기본 등록 사용 추정).
- ⇒ **현재 서버는 단말 앱 버전으로 분기할 신호가 없다.** 버전 게이트(항목 4)의 선결 조건 = "버전 신호 추가"가 필수 작업 항목.

---

## ② S2 설계 (실측 구조 기반)

### S2-1. 이벤트 배너 data-only 전환 + native 렌더 (경기별 그룹)
- **서버(파트, ③에 명시)**: 신버전 단말에는 이벤트 배너를 `notification` payload 없이 **data-only**로 전송. data에 최소 `kind="game_event"`, `gameId`, `eventId`(안타/홈런/득점 등 이벤트 고유키), `title`, `body`, `url`(딥링크), `w_ts` 포함.
- **native**: `NativeLiveEnvelope.parse`에 `KIND_EVENT="game_event"`를 **추가**(현재 위젯 3종만 인식하고 나머지는 null 반환하므로 지금은 그냥 빠짐). `onMessageReceived`가 이벤트 kind를 감지하면 위젯 상태머신(`NativeLiveState.apply`)을 타지 않고 **전용 렌더 경로**로 분기.
- **렌더**: 신규 클래스 `EventNotifications`(정적 헬퍼) 또는 `GameNotificationPlugin`에 `postEvent(ctx, gameId, eventId, title, body, path)` 추가. `NotificationCompat.Builder`로:
  - `setGroup("game:" + gameId)` — 경기별 그룹.
  - 개별 알림 id = **`eventId` 안정 해시**(경기별 유니크, 중복 배달 시 동일 id로 덮어써 중복 방지, 서로 다른 이벤트는 각각 트레이 유지). 예: `("evt:"+gameId+":"+eventId).hashCode()`.
  - **그룹 summary 알림**(id = `("grp:"+gameId).hashCode()`, `setGroupSummary(true)` + `InboxStyle`/카운트) 1개를 함께 게시 → 여러 배너가 하나로 접힘(Android 그룹 계약: 자식 2개+summary 필요).
  - 이벤트 전용 **채널 신설**(`game_event`, `IMPORTANCE_HIGH`, heads-up). 기존 `game_live_card`(ongoing, 7001)와 분리 — 채널 importance/역할 충돌 방지.
  - 개별 이벤트에 `setTimeoutAfter(...)`(예: 경기 자연 길이 상한, 6h)로 **최후 보루 자동만료**(종료 신호 유실 시에도 무한 잔류 방지). 단 하린아빠 정책상 "지나간 알림 다 보존"이 우선 → timeout은 종료 정리의 백업일 뿐 짧게 잡지 않는다.
- **효과**: 지나간 안타/홈런/득점이 **각각 트레이에 다 남되** 경기별 그룹으로 접혀 20개가 벽처럼 쌓이지 않음.

### S2-2. 종료 시 그 경기 그룹 일괄 cancel
- `onMessageReceived`의 `game_end` 분기(APPLIED)에 추가: `EventNotifications.cancelGroup(ctx, gameId)` →
  - 해당 경기의 **개별 이벤트 id 전부 cancel + summary(`grp:gameId`) cancel**.
  - 개별 id를 알아야 하므로, 게시 시 경기별 **활성 eventId 집합을 prefs**(`kbo_event_notif`, key=`gameId` → CSV/JSON of eventId)에 기록하고, 종료 시 그 집합을 읽어 각 `cancel(hash(eventId))` 후 집합 삭제. (Android은 그룹 일괄 cancel API가 없어 자식 id를 알아야 함.)
- 잠금 라이브 카드(7001)는 기존 `clear()` 유지.
- **자동만료 백업**은 S2-1의 `setTimeoutAfter` — game_end 유실 시에도 상한 후 소멸.

### S2-3. 위젯 종료 잔류(9회 고착) 해소
- **경기별 단일 위젯 상태**는 이미 prefs 단일 슬롯(`kbo_game_widget`)이라 구조 유지. 문제는 **종료 신호 유실 시 복구 부재**.
- `w_final` tombstone(S1-a 서버) 수신 → `markFinal` 적용 후, **같은 경기의 후속 LIVE를 `w_ts`(seq) 무관 무시**하는 게이트 추가. 현재 `decideTerminal`의 `RETRY_ADVANCE_SEQ`는 저-seq만 막으므로, `KEY_FINALIZED_GAME`(tombstoned gameId) prefs를 두고 `decide`/`writeInternal` 진입 시 `gameId==KEY_FINALIZED_GAME`면 `STALE` 조기 반환.
- **복구 경로(핵심)**: data-only best-effort 유실 대비 **pull 재수렴** 추가.
  - `MainActivity.onResume`(현재 `onNewIntent`만 존재, `onResume` 미구현) 또는 앱 복귀 시 → 위젯이 라이브 상태로 남아있으면 **서버 최신 경기 상태 재조회**(경량 GET) → FINAL이면 `markFinal`.
  - 네트워크 복구 시(선택, ConnectivityManager 콜백) 동일 재조회. **주의**: 배터리/삼순 기존 "추가 폴링 NO-GO"와 충돌하지 않게 — **이벤트성(앱 복귀/네트워크 복구) 1회 재조회만**, 주기 폴링 아님.

### S2-4. 버전 게이트 (필수)
- **선결(부재 실측)**: 토큰 등록에 앱 버전 미저장 → **버전 신호 추가**가 먼저.
  - native: 토큰 등록/갱신 시 `BuildConfig.VERSION_CODE`(또는 기능 플래그 `supports_data_only_events=true`)를 서버에 함께 전송. capawesome 토큰 이벤트를 감싸 JS→서버 등록 API에 필드 추가하거나, native에서 별도 등록 훅.
- **분기**: 서버가 토큰별 저장된 버전/플래그로:
  - **신버전(data-only 지원)** → 이벤트 배너 **data-only** 전송(native 렌더).
  - **구버전(1.0.16 등, 미지원)** → 기존 `notification` payload 유지(시스템 렌더) → **알림 유실 회귀 방지**.
- 게이트 신호가 없으면 서버는 보수적으로 구버전 취급(notification 유지).

### S2-5. 완료 기준(A17 5상태 QA) — ⑥에 상술.

---

## ③ 서버 파트 필요사항 (이 PR 밖, S2 성립 전제)
1. **이벤트 배너 data-only 전환**: 신버전 단말에 `game_event` data-only 전송, `eventId`/`gameId`/`w_ts` 포함. (구버전은 notification 유지.)
2. **버전 게이트**: 토큰 레코드에 앱 버전/기능 플래그 저장 + 전송 시 분기. (native가 버전 신호를 실어 보내는 게 선결.)
3. **`w_final` tombstone**(S1-a #894와 정합): `game_end`/별도 terminal에 `w_final` 마킹 → native tombstone 게이트가 후속 live 무시 판단에 사용.
4. **terminal 전용 collapse key 분리**(S1-a): 이벤트/라이브/종료가 서로 collapse로 덮지 않도록(native 그룹 정리와 독립적으로 서버 측 중복 억제).

---

## ④ 리스크
- **구버전 회귀**: 버전 게이트 오분류 시 신 native가 없는 단말에 data-only가 가면 **배너 전멸**. → 게이트는 fail-safe로 "불확실=구버전(notification 유지)". 신호 부재 시 절대 data-only로 보내지 않음.
- **data-only Doze 배달**: data-only FCM은 Doze/앱standby에서 지연·유실 가능(notification 메시지보다 우선순위 낮음). → 이벤트 배너는 `high` priority FCM으로 전송 요청, native 채널 `IMPORTANCE_HIGH`. 그래도 유실 대비 종료 정리는 `game_end` cancel + `setTimeoutAfter` 이중화.
- **FCM notification vs data 트레이드오프**: notification=시스템이 앱 죽어도 그림(안정) but native가 그룹/정리 못함. data-only=native 완전 제어 but 배달성 약함. → **하이브리드**: 배너 본문은 data-only+native(제어 확보), 배달 신뢰가 극히 중요한 경우만 서버가 notification 병용 판단(중복 렌더 주의 — 신버전은 data-only 단일).
- **그룹 summary 계약**: 자식 1개만 있고 summary 별도 게시 시 One UI에서 summary가 유령으로 남을 수 있음 → 자식 0이 되면 summary도 반드시 cancel(종료·개별 만료 경로 모두).
- **eventId 해시 충돌**: `hashCode` 충돌 시 다른 이벤트가 덮임 → 낮은 확률이나 gameId+eventId 조합 문자열 해시로 완화, 필요 시 안정 해시(FNV) 채택.
- **prefs 활성 집합 정합**: 게시/취소 사이 프로세스 종료로 집합이 실제 트레이와 어긋날 수 있음 → 종료 cancel은 "집합 기준 + summary 무조건 cancel"로 보수적 정리, 잔여는 `setTimeoutAfter`가 회수.

---

## ⑤ 슬라이스 제안 (얇은 수직 슬라이스 — 빅뱅 금지)
1. **Slice 0 (신호)**: 토큰 등록에 버전/기능 플래그 전송(native) + 서버 저장·분기 스켈레톤. 렌더 변경 없음. 회귀 위험 0.
2. **Slice 1 (렌더)**: `KIND_EVENT` 파싱 + `postEvent`(그룹/summary/개별 id/채널). **서버는 아직 notification 유지** → 신버전에서 data-only 테스트 채널로만 검증(플래그로 소수 단말). 트레이 보존·그룹 접힘 확인.
3. **Slice 2 (정리)**: `game_end` → `cancelGroup` + 활성 집합 prefs + `setTimeoutAfter`. 종료 일괄 정리 확인.
4. **Slice 3 (위젯 tombstone)**: `w_final` 게이트 + `onResume`/네트워크 복구 1회 재수렴. 9회 고착 해소 확인.
5. **Slice 4 (게이트 전환)**: 서버가 신버전에 실제 data-only 전환. 구버전 notification 유지 회귀 테스트. 단계적 롤아웃.

각 슬라이스: 구현→유닛(`WidgetUpdatePolicy`/`composeEvent` 순수 함수 테스트 패턴 踏襲)→기기 검증→다음.

---

## ⑥ 완료 기준 / QA (A17 5상태)
5상태 = **화면OFF · Doze · 네트워크 복구 · 프로세스 종료 · 강제중지**. 각 상태에서:
- **위젯/카드 정상 갱신 P95 ≤ 15초** (서버 전송 주기 내, 배달 성공 시).
- **경기 종료 후 15분 내 위젯 라이브 잔류 0** (tombstone + 재수렴으로 9회 고착 해소).
- **이벤트 알림**: 안타/홈런/득점이 **경기별 그룹으로 전부 트레이 보존**되다가, **`game_end` 수신 시 그 경기 그룹 개별+summary 전부 일괄 정리**. (한참 뒤 폰 여는 유저도 진행 중엔 전부 보이고, 종료된 경기는 깨끗이 사라짐.)
- **구버전(1.0.16) 회귀 0**: 게이트로 notification 유지 → 배너 유실/그룹 미동작 없음.
- **강제중지 후**: 재기동/앱 복귀 시 서버 재수렴으로 상태 정합 회복(강제중지 중 배달은 시스템 제약상 불가 — 복귀 재수렴이 계약).

> End-User Level QA 원칙(AGENTS.md): 서버 PASS만으로 마감 금지. 실기기 5상태 + 실유저 동선(트레이 육안 + 종료 정리)까지 확인해야 마감.

---

## 불확실 / 결정 필요 지점
1. **`setTimeoutAfter` 상한 값**: "지나간 알림 다 보존" vs 종료 유실 백업의 균형 — 6h? 경기별 예상 종료+α? (하린아빠 확인 권장.)
2. **버전 신호 전달 경로**: native 직접 등록 훅 vs 기존 JS 토큰 등록 API에 필드 추가 — 현 등록 코드가 JS(capawesome) 경유라 JS 파트가 별 PR로 필요할 수 있음(native 전용 범위 밖 가능성).
3. **네트워크 복구 재수렴**: 삼순 기존 "추가 폴링 NO-GO"와의 경계 — 이벤트성 1회 재조회를 어디까지 허용? (삼순 리뷰 확인 필요.)
4. **하이브리드 병용 여부**: data-only 배달 실패가 잦으면 서버 notification 병용? 신버전 중복 렌더 위험 — 정책 결정 필요.
5. **eventId 안정성**: 서버가 이벤트별 안정 `eventId`를 이미 발급하는지(재전송 시 동일값 보장) — 없으면 서버 파트에 "안정 eventId 발급" 추가.
