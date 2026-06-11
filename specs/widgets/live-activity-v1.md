# 잠금화면 Live Activity v1 — Spec

> 작성: 삼식이 (2026-06-11) · 스레드: #product 앱 착수 스레드 V2
> 목표: 내 팀 라이브 경기 스코어를 iOS 잠금화면 + 다이나믹아일랜드에 실시간 표시 (Live Activity).
> 트리거: 하린아빠 "위젯 가자" → 레퍼런스 = 앱 홈의 "MY TEAM" 라이브 카드. 시작 = ⓑ 경기룸 진입 시.

---

## 1. 배경 / 범위

- v1.0 위젯 = **Live Activity(ActivityKit)** 단일. 홈 화면 위젯(WidgetKit)은 v1.1 이후.
- 표시 내용 = 앱 홈 "MY TEAM" 카드와 동일: 양팀 로고·약칭·스코어 / LIVE 이닝(N회초·말) / B·S·O 카운트 / 투수·타자 / 베이스 점유.
- 데이터 = 기존 `GET /api/game-live`에 전부 존재 (awayName/homeName/awayScore/homeScore/inning/isTop/balls/strikes/outs/runner1~3b/currentPitcher/currentBatter). **신규 데이터 작업 0.**
- 네이티브 Swift 신규 트랙 — Capacitor 웹뷰 밖. Widget Extension(Xcode target) + ActivityKit + App Group.

## 2. 목표 (성공 기준)

| # | 성공 기준 | 검증 |
|---|-----------|------|
| G1 | 경기룸 진입 시 잠금화면에 MY TEAM 카드가 Live Activity로 뜸 | 실기기 |
| G2 | 경기 중 스코어/카운트/이닝 변화가 위젯에 반영 | 실기기 라이브 |
| G3 | 다이나믹아일랜드 compact(스코어)/expanded(카드) 표시 | 실기기 |
| G4 | 경기 종료 시 Live Activity 자동 종료(최종 스코어 잔상 후 dismiss) | 실기기 |
| G5 | 같은 경기 중복 Activity 안 생김 (재진입 시 기존 갱신) | 실기기 |
| G6 | 비-네이티브(웹/PWA)는 무영향 | 회귀 |

## 3. 아키텍처

```
[앱(JS, 경기룸 진입)] → capacitor-live-activity 플러그인(start)
      → ActivityKit Live Activity 시작 (초기 ContentState = game-live 1회 fetch)
[경기 진행 중 업데이트] 2갈래:
  ⓐ 앱 포그라운드: JS가 game-live 폴링 → 플러그인 update
  ⓑ 앱 백그라운드/잠금: 서버가 APNs Live Activity push(content-state) → 위젯 자동 갱신
[경기 종료] 서버 game-events/S4 종료 트리거 → APNs end push (또는 앱이 final 감지 시 end)
```

- **플러그인**: 커뮤니티 `capacitor-live-activity` 계열(JS start/update/end + Swift ActivityKit). Widget Extension UI(SwiftUI)는 직접 작성.
- **APNs Live Activity push**: 기존 FCM/APNs 인프라 재활용. ActivityKit push token을 서버에 등록(기존 device_push_tokens 확장 또는 신규 `live_activity_tokens`) → content-state push.
- **Widget Extension target**: `ios/App`에 신규 Xcode target. App Group으로 메인 앱 ↔ 위젯 데이터 공유.

## 4. 빌드 슬라이스

- **W1 토대**: Widget Extension target + App Group + ActivityKit ContentState(스코어/이닝/BSO/투수타자/베이스) 정의 + 잠금화면 SwiftUI 레이아웃. **검증 = 더미 데이터로 잠금화면에 카드 표시(앱에서 수동 start/end).**
- **W2 경기룸 연동**: 경기룸([gameId]) 진입 시 game-live 1회 fetch → Activity 시작. 다이나믹아일랜드 compact/expanded. 재진입 시 중복 방지.
- **W3 실시간 업데이트**: ①포그라운드 JS 폴링 update ②백그라운드 APNs Live Activity push(서버가 content-state 전송, ActivityKit push token 등록).
- **W4 종료**: 경기 final 감지(S4 종료 트리거 연계 또는 폴링) → end push. 최종 스코어 잔상 후 dismiss.
- 각 슬라이스 삼순 리뷰 게이트. W1은 실기기 잠금화면 표시 필수.

## 5. 확정 결정 (2026-06-11 하린아빠 "추천대로")

1. **종료 후 잔상** — 경기 종료 시 최종 스코어로 **15분 유지** 후 dismiss (stale date 활용).
2. **실시간성** — 스코어·이닝 변화는 **즉시 push**, 단순 볼카운트(B/S/O)는 **주기 묶음**(과도한 push 방지). 포그라운드는 JS 폴링으로 더 촘촘히.
3. **경기룸 나가도 Activity 유지** — 경기 끝까지 (잠금화면 목적).
4. **v1은 진입한 경기 1개만** — 최근 진입 경기 우선, 새 경기 진입 시 이전 Activity 종료 후 신규.

## 6. v1 비범위 (후속)

- 홈 화면 위젯(WidgetKit) — 오늘 경기/순위 (v1.1)
- Android 동등 기능 (Android는 Live Activity 미지원 — 별도 검토)
- 최애선수 기록 위젯
