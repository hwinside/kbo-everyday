# Spec — Live Activity 백그라운드 update-token 자동 등록 (앱 미실행 갱신)

작성: 삼식이 · 2026-06-28 · 리뷰: 삼순이(조건부 GO + 수정 5조건) · 트리거: #dev `1782292948.565089` (하린아빠)
증상: 1.0.1인데도 경기 30분 전 push-to-start 카드가 뜬 뒤 *경기 시작 20분+ 지나도 갱신 안 됨*.

## 1. 문제 정의 (실측 root-cause)

- 잠금화면 Live Activity는 경기 30분 전 **push-to-start**(서버 device-level 토큰)로 자동 생성된다 (앱 미실행에서도 OK).
- 그 카드를 실시간 갱신하려면 **per-activity update token**(`activity.pushTokenUpdates`)이 서버 `live_activity_tokens`에 등록돼야 한다.
- 네이티브 등록 경로(`register-device`, auth-free, push-to-start 토큰으로 user 역매핑)는 **이미 구현돼 있었으나** 두 가지 결함으로 백그라운드에서 동작 안 함:
  1. **observer가 Capacitor `LiveActivityPlugin.load()`에서만 시작** → 웹뷰 init 의존. push-to-start로 앱이 백그라운드 launch될 땐 웹뷰가 안 떠서 observer 미동작.
  2. **`latestPushToStartToken`이 메모리 전용** → 신규 프로세스(백그라운드 launch)에선 nil → `register-device` 신원 토큰이 없어 skip.
- **DB 실측(2026-06-28)**: 윤연률(하린아빠) update token이 카드 생성(16:30)이 아니라 앱 본 시점(17:21)에 등록. 16:30 push-to-start 시점 자동등록은 0건 → 백그라운드 자동등록은 한 번도 동작한 적 없음.

## 2. 목표 / 성공 기준

- **G1**: 유저가 앱을 한 번도 열지 않아도(설치 후 1회 로그인은 전제), 경기 30분 전 push-to-start 카드 생성 시점에 update token이 서버 `live_activity_tokens`에 등록.
- **G2**: 카드가 경기 시작과 함께 자동 라이브 전환 + 득점 갱신.
- **G3**: 한 번의 App Store 패치로 끝낸다 — TestFlight 실기기 검증을 store 제출 전에 통과.

## 3. 설계 (register-device 방식 — 삼순 단순화 승인)

서버 무변경. 기존 auth-free `register-device`를 네이티브 백그라운드 등록의 primary로 사용. 액세스토큰/Keychain/refresh 불필요(이 버그의 핵심 실패모드 "토큰 만료"가 사라짐).

### 3.1 observer를 AppDelegate로 이동
- `AppDelegate.didFinishLaunchingWithOptions`에서 `LiveActivityController.shared.startObservers()` (= `observePushToStartToken()` + `observeAllActivities()`).
- iOS가 push-to-start로 백그라운드 launch하면 AppDelegate 실행 → observer가 웹뷰 없이 attach.
- 플러그인 `load()`는 observer 시작 호출 제거, JS multicast 콜백(`onPushToken`/`onPushToStartToken`)만 연결.

### 3.2 push-to-start 토큰 App Group persist (조건1)
- `latestPushToStartToken`을 App Group(`group.fan.keubo.app`) UserDefaults 백킹 computed property로 변경 (key `kbo_push_to_start_token`). 메모리 fallback 금지.
- 신규/백그라운드 프로세스도 영속 토큰을 읽어 `register-device` 신원으로 사용.

### 3.3 기존 활성 Activity 즉시 enumerate (조건3)
- `observeAllActivities()` 시작 시 `activityUpdates` 구독 *전에* `Activity<KBOGameAttributes>.activities` 전체를 돌며 `observePushToken` attach. (구독은 이후 신규만 yield → 이미 떠 있는 원격-start 카드 누락 방지. `observedActivityIds` 중복가드로 이중 구독 무해.)

### 3.4 native registrar 항상 직접 호출 (조건4)
- `observePushToken`이 토큰 수신 시 `registerUpdateTokenNatively`(register-device 직접 POST)를 *항상* 호출 + `onPushToken?`(JS multicast)는 optional. 플러그인이 native 경로를 덮어쓸 수 없음(하드코딩).

### 3.5 토큰 rotate 처리 (조건2)
- `observePushToStartToken`: 새 토큰 수신 시 rotate 감지 + App Group 즉시 persist + `onPushToStartToken?`(JS → 포그라운드 register-start 재등록).
- 백그라운드 rotate는 register-start(Bearer) 재등록 불가 → persist만 즉시, 서버 매핑 최신화는 **다음 포그라운드**에 `AppDelegate.applicationWillEnterForeground` → `resyncPushToStartTokenOnForeground()`가 persist 토큰을 JS multicast로 재방출해 register-start 재호출(값 동일해도 upsert라 무해).

### 3.6 로깅 (조건5)
- auth-free 경로라 `pushToStartToken`/`pushToken` 등 **민감값 미로깅**. skip 사유·HTTP status·error.localizedDescription·gameId(공개값)만 NSLog.

### 3.7 백그라운드 실행시간
- `register-device` POST를 `beginBackgroundTask`로 감싸 백그라운드 launch에서 곧 suspend 되기 전에 완료 보장.

### 3.8 skip된 update token pending flush (삼순 조건부 GO blocker)
- **레이스**: 백그라운드 launch에서 `observeAllActivities`의 기존 `Activity.activities` enumerate가 update token을 먼저 yield → 이 시점에 `observePushToStartToken`의 push-to-start persist가 *아직 안 됐으면* `registerUpdateTokenNatively`가 start token 없음으로 skip. 특히 **1.0.1→1.0.2 업데이트 후 앱 미오픈** 유저는 App Group 토큰이 비어 있어 실제 재현 가능 → update token 유실 → 카드 프리즈.
- **수정**: skip 대신 `(gameId, pushToken)`을 `pendingUpdateTokens`(gameId 키 dict, 최신 토큰만) 큐에 보관. `observePushToStartToken`이 토큰 persist 직후 `flushPendingUpdateTokens()` 호출 → 큐 비우고 각 항목 `register-device` 재시도(persist된 start token으로 진행, 재큐잉/무한루프 없음). **절대 유실 금지.**
- 동시 접근(`pushTokenUpdates` Task ↔ `pushToStartTokenUpdates` Task)이라 `NSLock`(`pendingLock`)으로 직렬화. 로깅은 gameId·pending 카운트만(토큰값 미로깅, 조건5 유지).

## 4. 변경 파일 (실제)
- `ios/App/App/AppDelegate.swift` — didFinishLaunching `startObservers()`, willEnterForeground `resyncPushToStartTokenOnForeground()`.
- `ios/App/App/LiveActivityController.swift` — App Group persist getter/setter, enumerate, rotate 감지, register-device 로깅+bgTask, `startObservers`/`resync` 메서드, `import UIKit`, **skip된 update token pending 큐(`pendingUpdateTokens`/`pendingLock`)+`flushPendingUpdateTokens`(삼순 blocker)**.
- `ios/App/App/LiveActivityPlugin.swift` — load에서 observer 시작 제거, JS multicast 콜백만.
- 서버(`register-device`/`register`/`register-start`/`apns.ts`/`live-activity.ts`)·JS: **무변경**(register-device·register-start 기존 그대로).

## 5. 부트스트랩 전제
- push-to-start 토큰의 *서버 등록(register-start, Bearer)*은 유저가 설치 후 로그인하며 앱을 1회 열 때 발생(앱 열린 상태라 OK). 이후엔 영영 안 열어도 register-device로 백그라운드 갱신.

## 6. 검증 (TestFlight 먼저 → store 1패치)
1. swiftc -parse PASS(완료) → TestFlight 빌드.
2. **핵심 PASS**: 앱 백그라운드/잠금·미오픈 상태에서 30분 전 카드 생성 후 60초 내 DB `live_activity_tokens` row 생성(삼식이 DB 확인) + 경기 시작 후 앱 안 열고 2회 이상 점수/이닝 갱신 + 종료 전환(#475 함께).
3. 토큰 rotate 시나리오(>1h 미오픈 후 포그라운드 1회 → register-start 최신화) 관찰.
4. **강제종료(swipe kill)는 별도 관찰 지표** — iOS가 push-to-start로 안 깨우는 케이스라 "완전 보장" 아님(리스크 명시).
5. PASS → App Store 제출(1회).

## 7. Out of scope / 한계
- 강제종료 상태: iOS 구조적 한계(코드로 못 넘김).
- iOS 18 broadcast(channel): 16.1+ 커버리지 위해 미채택.
- 멀티 디바이스: v1 비범위(디바이스당 최신 1개).
