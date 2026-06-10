# 푸시 알림 v1 — Spec

> 작성: 삼식이 (2026-06-10) · 스레드: #product 앱 착수 스레드 V2
> 목표: 크보팬 네이티브 앱(iOS/Android) + 웹에 푸시 알림 도입. v1.0 출시 범위.
> 트리거: 하린아빠 "알림 먼저 스펙 잡자 — 경기 시작/종료, 내 팀 득점, 댓글/답글, 쪽지 수신. 알림+위젯까지 만들고 v1.0으로."

---

## 1. 배경 / 현재 인프라

- **현재 푸시 = Web Push(VAPID)만 존재.** `web-push` 라이브러리 + `push_subscriptions` 테이블(endpoint/subscription/user_id) + `/api/push/{send,subscribe}` + `usePushNotification` 훅 + `NotificationCard`(PR #143에서 토글 숨김 처리).
- **🔴 핵심 제약: Web Push는 Capacitor 네이티브 앱(WKWebView)에서 동작 안 함.** iOS WKWebView는 Web Push API 미지원. 즉 *네이티브 앱 푸시는 새 경로(APNs/FCM)가 필수*다. 기존 Web Push는 웹 브라우저용으로 유지.
- 실제 알림 트리거(경기/득점/댓글/쪽지)는 아직 **하나도 연결돼 있지 않음**. 백엔드 send 엔드포인트만 있고, 어드민 수동 호출만 가능.

## 2. 목표 (성공 기준)

| # | 성공 기준 | 검증 |
|---|-----------|------|
| G1 | iOS/Android 네이티브 앱에서 디바이스 토큰 등록 → 푸시 수신 | 실기기 |
| G2 | 알림 4종(경기 시작·종료 / 내 팀 득점 / 댓글·답글 / 쪽지) 자동 트리거 | 트리거별 E2E |
| G3 | 알림 탭 → 해당 화면 딥링크 (경기룸/게시글/쪽지함) | 실기기 |
| G4 | 마이페이지 알림 설정에서 종류별 on/off | UI + 전송 필터 검증 |
| G5 | 권한 미허용/구독 없음 시 silent (앱 동작 무영향) | fail-safe |
| G6 | 내 팀 득점 알림 폭탄 방지(rate limit/묶음) | 다득점 경기 시뮬 |
| G7 | 웹 Web Push 회귀 없음 (기존 경로 유지) | 웹 smoke |

## 3. 알림 4종 정의

| 종류 | 트리거 소스 | 수신 대상 | 딥링크 | 비고 |
|------|------------|-----------|--------|------|
| 경기 시작 | 게임 상태 전이(예정→진행), game-events 파이프라인 | 해당 경기 팀을 최애팀으로 둔 유저 | 경기룸 | |
| 경기 종료 | 게임 상태 전이(진행→종료) | 동일 | 경기룸(결과) | 최종 스코어 포함 |
| 내 팀 득점 | celebration/relay 득점 이벤트(이미 감지중) | 득점한 팀을 최애팀으로 둔 유저 | 경기룸 | ⚠️ rate limit 필요 |
| 댓글/답글 | `comments` insert (on_comment_change 트리거 존재) | 글 작성자 / 부모 댓글 작성자 | 게시글 | 본인 글에 본인 댓글 제외 |
| 쪽지 수신 | `dm_messages` insert | 수신자 | 쪽지함 대화 | 운영팀 공지 포함 여부 = 오픈이슈 |
| 최애선수 관련글 | `posts` insert + `player_tags`에 최애선수 매칭 | 해당 선수를 최애선수로 둔 유저 | 게시글 | 일반글·사진글 |
| 최애선수 활약(타자) | celebration 득점/타점/홈런 이벤트 batter=최애선수 | 동일 | 경기룸 | *내 팀 득점과 별개로 강조 톤*(예: "⚾ {선수} 홈런!") |
| 최애선수 삼진(투수) | relay/game-events 삼진 이벤트 pitcher=최애선수 | 동일 | 경기룸 | ⚠️ 삼진 이벤트가 relay에 파싱 가능한지 *데이터 소스 확인 필요* — 불가 시 V1.5 |

## 4. 아키텍처

```
[트리거: DB 트리거 / cron / 이벤트 파이프라인]
      → 알림 디스패처 (서버, 대상 유저 + 설정 필터 + rate limit)
      → 전송 게이트웨이
          ├─ 네이티브: FCM (Android 직접 + iOS는 FCM→APNs 프록시)   ← 신규
          └─ 웹: 기존 web-push(VAPID)                              ← 유지
```

- **권장: FCM 단일 게이트웨이.** Firebase Cloud Messaging이 Android 네이티브 + iOS(APNs 경유) 둘 다 처리 → 서버 전송 코드 1벌. Capacitor `@capacitor/push-notifications` 플러그인이 iOS=APNs 토큰/Android=FCM 토큰을 앱에서 등록.
- **디바이스 토큰 테이블 신규**: `device_push_tokens`(user_id, platform[ios|android|web], token, created_at, last_seen). 기존 `push_subscriptions`(web)와 분리 또는 통합 — 구현 시 결정.
- **알림 설정 테이블 신규**: `notification_prefs`(user_id, game_start, game_end, my_team_score, comment_reply, dm, fav_player_post, fav_player_highlight, fav_player_strikeout, quiet_hours) — **모든 알림 종류별 on/off**(하린아빠 명시). 디폴트 전부 on.
- **최애선수 전제**: 유저 프로필의 최애선수(kboId, `player_tags`/profile favorite). 최애선수 알림 3종(관련글·활약·삼진)은 이 매칭에 의존 — 최애선수 미설정 유저는 대상 제외.

## 5. 빌드 슬라이스 (얇은 수직 슬라이스)

- **S1 토대**: `@capacitor/push-notifications` 설치 + iOS APNs/Android FCM 셋업 + `device_push_tokens` 테이블 + 토큰 등록 API + 권한 요청 UX. **검증 = 어드민 수동 푸시가 실기기 앱에 도착.**
- **S2 알림 설정**: `notification_prefs` 테이블 + 마이페이지 설정 UI(종류별 토글) + 디스패처가 설정 필터 적용. (PR #143에서 숨긴 NotificationCard 자리 재활용)
- **S3 댓글/답글 + 쪽지 + 최애선수 관련글**: `comments`/`dm_messages`/`posts`(player_tags 매칭) insert 트리거 → 디스패처. 딥링크 연결. (앱 내부 이벤트라 트리거 단순)
- **S4 경기 시작/종료**: game-events 상태 전이 → 디스패처. 최애팀 매칭.
- **S5 내 팀 득점 + 최애선수 활약(타자)**: celebration 득점 이벤트 → 디스패처 + **rate limit/묶음**. batter=최애선수면 강조 톤 분기. (가장 폭탄 위험 높음 → 신중)
- **S6 최애선수 삼진(투수)**: relay/game-events 삼진 이벤트 파싱 가능성 확인 후. 불가하면 V1.5로 이연.
- 각 슬라이스 삼순이 리뷰 게이트. S1은 실기기 도달 확인 필수.

## 6. 오픈 이슈 (하린아빠 결정 필요)

1. **내 팀 득점 빈도** — ⓐ모든 득점 / ⓑ홈런·역전 등 빅플레이만 / ⓒ묶음(이닝 종료 시 "3점 추가" 요약). 다득점 경기 시 폭탄 방지. → 추천 ⓒ 또는 ⓑ
2. **권한 요청 시점** — ⓐ앱 첫 진입(온보딩) / ⓑ최애팀 설정 직후 / ⓒ설정에서 수동 옵트인. → 추천 ⓑ (맥락상 자연스러움)
3. **댓글/답글 범위** — 내 글의 댓글 + 내 댓글의 답글까지. 좋아요 알림도 포함? → 추천: 좋아요 제외(폭탄)
4. **쪽지** — 유저간 DM만 vs 운영팀 공지 쪽지까지. → 추천: 둘 다(운영 공지가 리텐션 도구)
5. **설치 후 기본값** — 종류별 디폴트 on/off. → 추천: 전부 on, 단 quiet hours(23~08시) 기본 적용
6. **야간 무음** — 23~08시 묶어서 아침 발송 vs 즉시. → 경기 종료/득점은 경기 시간 특성상 야간도 즉시가 맞음. 댓글/쪽지만 quiet hours 적용?

## 7. v1 비범위 (후속)

- 위젯 / Live Activity (P4, 별도 스펙 — 네이티브 Swift WidgetKit/ActivityKit)
- 알림 센터(인앱 알림 히스토리 목록)
- 세분화된 선수 단위 알림(특정 선수 등판/타석)
