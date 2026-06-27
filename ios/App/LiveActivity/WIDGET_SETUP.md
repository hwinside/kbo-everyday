# Live Activity Widget Extension — Xcode 셋업 (W1 실기기 게이트)

소스 파일은 모두 작성돼 있다(`ios/App/LiveActivity/`, `ios/App/App/LiveActivityController.swift`).
남은 건 **Xcode GUI에서만 가능한 target 등록 + provisioning**이다. pbxproj 손편집은
빌드 전체를 깨뜨릴 위험이 커서 의도적으로 자동화하지 않았다.

## 1. Widget Extension target 추가
1. Xcode에서 `ios/App/App.xcworkspace` 열기
2. File ▸ New ▸ Target… ▸ **Widget Extension**
3. Product Name: `LiveActivity` / **Include Live Activity** 체크 / Include Configuration App Intent 해제
4. Embed in Application: `App`
5. Xcode가 만든 더미 소스(`LiveActivity.swift`, `LiveActivityBundle.swift`, 기본 `Info.plist`)는
   **삭제**하고, 이미 작성된 아래 파일을 target에 추가(Add Files):
   - `KBOGameAttributes.swift`
   - `KBOLiveActivityWidget.swift`
   - `KBOWidgetBundle.swift`  ← `@main`
   - `Info.plist` (이 폴더의 것 사용 — Build Settings의 `INFOPLIST_FILE`을 여기로)
   - `LiveActivity.entitlements` (Build Settings `CODE_SIGN_ENTITLEMENTS`)

## 2. 공유 소스
- `KBOGameAttributes.swift` 는 **앱 + 익스텐션 둘 다의 Target Membership** 체크
  (앱은 Activity.request, 익스텐션은 ActivityConfiguration에서 같은 타입 필요)
- `App/LiveActivityController.swift` 는 **앱 타깃만**

## 3. App Group (앱 ↔ 익스텐션 공유)
- 앱·익스텐션 두 target 모두 Signing & Capabilities ▸ **+ App Groups** ▸ `group.fan.keubo.app`
- entitlements 파일엔 이미 박혀 있음(`App.entitlements`, `LiveActivity.entitlements`).
  Apple Developer 포털에서 App Group ID `group.fan.keubo.app` 등록 + 두 App ID에 연결 필요.

## 4. 배포 타깃 / 빌드 설정
- 익스텐션 target `IPHONEOS_DEPLOYMENT_TARGET` = **16.1** (Live Activity 최소)
  - 앱은 15.0 유지 — 호출부는 `if #available(iOS 16.1, *)` 가드돼 있음
- 익스텐션 Signing Team = 앱과 동일

## 5. Info.plist (앱) — 이미 반영됨
- `NSSupportsLiveActivities = YES`
- `NSSupportsLiveActivitiesFrequentUpdates = YES` (W3 잦은 push 대비)

## 6. W1 검증 (실기기)
ActivityKit은 **시뮬레이터에서도 잠금화면 표시는 되지만**, push/실동작은 실기기가 진실.
가장 간단한 더미 확인:

```swift
// AppDelegate.application(_:didFinishLaunchingWithOptions:) 안, 임시 디버그용
if #available(iOS 16.1, *) {
    LiveActivityController.shared.startDummyActivity()
}
```
- 앱 실행 → 잠금화면/다이나믹 아일랜드에 LG 3 : 2 OB, 7회말, B2 S1 O1 카드가 뜨면 PASS
- 확인 후 위 디버그 호출은 제거(또는 디버그 버튼으로 분리). **커밋엔 넣지 않음**
- 설정 ▸ Face ID/잠금화면 ▸ Live Activities 가 켜져 있어야 함

## 다음 슬라이스
- **W2**: 경기룸 진입 시 game-live fetch → `startDummyActivity` 대신 실데이터 start (Capacitor 브리지)
- **W3**: APNs token-based push update (삼순 4건 조건 — 스펙 §3 반영 완료)
- **W4**: final + `dismissal-date = now + 15m` end (`LiveActivityController.end` 구현 완료)
