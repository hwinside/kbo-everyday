# 갤럭시워치 (Wear OS) 크보팬 앱 — 스펙 v2

**작성**: 삼식이 · 2026-07-15 · 스펙 v1(Slack #product) + 삼순 조건부 GO 5건 반영본
**승인 흐름**: 하린아빠 지시("애플워치와 똑같은 스펙/디자인", 7/15) → 스펙 v1 공유 → 삼순 조건부 GO(7/15 20:10, "반영 후 재승인 대기 없이 A 착수") → 하린아빠 "삼순 의견 반영"(21:00) → **본 v2 = 착수 기준 SSOT**

## 0. 원칙

- 애플워치 기능 100% 패리티를 **Wear OS 관용구로 이식** (픽셀 동일 X — 사각+SwiftUI vs 원형+Compose/Tiles, 하린아빠 사전 합의)
- **서버 무변경** — 워치가 `/api/games` · `/api/standings` · `/api/team-schedule` 직접 fetch
- 얇은 수직 슬라이스 A → B → C. 각 슬라이스마다 삼순 리뷰 게이트 → 하린아빠 머지 승인
- 에뮬 PASS = 개발 착수/진행 근거, **갤워치8 실기기 PASS = 출시 근거** (삼순 기준 분리)

## 1. 대상 기기 / 플랫폼

- 1차 타깃: **갤럭시워치8 44mm (SM-L330N, Wear OS 6 / One UI 8 Watch)** — 하린아빠 구매 예정
- Wear 모듈: **minSdk 30** (Watch4+/Wear OS 3), **compileSdk/targetSdk 36**
- QA 매트릭스: API 30 에뮬 + API 36 에뮬 + 갤워치8 실기기 (3단)

## 2. 아키텍처

- 새 Gradle 모듈 `:wear` — Kotlin, 폰앱(Capacitor 웹뷰)과 독립된 네이티브 모듈
- 타일 = ProtoLayout (Tiles Material) / 컴플리케이션 = ComplicationDataSourceService / 앱 = Compose for Wear OS
- 네트워킹: OkHttp + kotlinx.serialization
- 최애팀 동기화: **Wearable Data Layer(DataClient)** — 폰이 최애팀 push, 워치 수신·저장 (애플워치 WCSession 대응물)
  - ⚠️ 폰앱 네이티브(Capacitor Android)에 최애팀 push용 DataClient 코드 소폭 추가 필요 (애플워치 WCSession 폰 네이티브 추가와 동일 수준) — "서버 무변경"이지 "폰앱 완전 무변경"은 아님
- 재사용: 안드 홈위젯(#551/#552)의 **팀색·로고 map만** 재사용. RemoteViews용 Canvas 텍스트 비트맵 렌더는 Tile에 이식하지 않음 (ProtoLayout 네이티브 텍스트/이미지 요소 사용) — 삼순 조건 4

## 3. 슬라이스 A — 타일 1종 (다음경기 · 카운트다운 · 라이브)

애플워치 #635 로직 이식. 상태별 렌더:

| 상태 | 표시 |
|---|---|
| 오늘 예정 | 매치업(`LG vs KT`) + 시작시각. 임박(1h 이내) 시 카운트다운 `41분 후`/`곧 시작` + 앰버 강조 |
| 오늘 경기 없음 | team-schedule로 다음 예정 경기 (과거 final 스킵, 이달→다음달 탐색) `7/16(수) 18:30` |
| 라이브 | 스코어 팀별 2줄(`LG 3` / `KT 2`, 내팀 위) + 이닝/아웃 + 잔루 다이아몬드(runnersOn) |
| 종료 | 최종 스코어 + '경기 종료' |
| 취소 | '경기 취소' |

**갱신 전략 (삼순 조건 1·2 반영)**:
- **cache-first**: `onTileRequest`는 로컬 스냅샷 즉시 렌더 → 백그라운드 짧은 sync → 성공 시 `requestUpdate`. 통신 실패 시 마지막 정상값 유지 + 재시도
- live 캐시 5분 초과 시 `업데이트 지연` 표시
- 카운트다운은 **Dynamic Expressions** (타일 플랫폼 자체 분단위 갱신 — 네트워크/타일 재요청 불필요)
- freshness 간격(라이브 짧게/그 외 길게)은 **OS best-effort 전제** — SLA 아님
- `startedButStillScheduled`(시작시각 지났는데 API 아직 scheduled): freshness 간격 단축 (best-effort)

**완료 기준 (삼순 조건 2 반영)**:
- 에뮬(API 30·36): 4상태(예정·카운트다운·라이브·종료) 렌더 + 다음경기 fallback + cache-first/`업데이트 지연` 동작
- 라이브 freshness: **활성(워치 켜짐+타일 노출) 시 ≤5분 목표, 실측 로그로 검증** (정확 SLA 아님)
- 실기기(갤워치8): 원형 크롭·긴 팀명(`두산 10`)·두자리 점수 fit — **출시 PASS 기준**

## 4. 슬라이스 B — 컴플리케이션 (삼순 조건 3 정정 반영)

- **경기/순위 data source 2종** 구현: ①최애팀 다음경기/스코어 ②순위(`LG 2위`)
- QA는 **대표 슬롯형**(SHORT_TEXT, RANGED_VALUE 등 지원 타입별 대표 워치페이스 슬롯) 기준 — "3슬롯 등록"이라는 표현은 iOS 관용구라 폐기
- 애플워치 #621 컴플리케이션과 정보 패리티

## 5. 슬라이스 C — 독립 앱 화면

- Compose for Wear OS (`ScalingLazyColumn`) — 오늘/다음/라이브 상세 카드
- 애플워치 워치앱 카드 화면과 정보 패리티

## 6. 배포 / 패키징 (삼순 조건 3 반영)

- **동일 Play listing/package + 별도 Wear OS AAB** (non-standalone 선언, 폰앱 의존 — 로그인/최애팀은 폰에서)
- 폰 APK 임베드는 불가 (Wear OS 2.0에서 폐기된 방식)
- **자동설치는 보장하지 않음** — 워치 Play 스토어 또는 폰 Play를 통한 설치 안내 필요 (온보딩 문구는 슬라이스 A 출시 시점에 별도 결정)
- 서명: 폰앱과 동일 keystore

## 7. 작업 절차

1. 본 스펙 Notion SSOT(이 페이지) → repo `specs/wear-os-galaxy-watch.md` 미러 커밋
2. `origin/main` 기준 전용 워크트리 + 브랜치 `feat/wear-os-galaxy-watch` (공유 main 체크아웃은 behind + untracked 오염 — 사용 금지, 삼순 조건 5)
3. 슬라이스 A 구현 → 에뮬 QA → PR → 삼순 리뷰 게이트 → 하린아빠 머지 승인
4. 갤워치8 도착 시 실기기 QA → 출시 PASS 판정 → Play Wear AAB 업로드 (별도 명시 승인)

## 리스크 / 미결

- Wear OS 에뮬레이터 초기 셋업 (SDK 36 시스템 이미지 다운로드) 시간 소요 가능
- 타일 freshness가 제조사 배터리 정책(삼성 절전)에 눌릴 가능성 → 실기기 실측 로그로 판단 (완화: cache-first + `업데이트 지연` 표시)
- 온보딩/설치 안내 문구 — 슬라이스 A 출시 시점 결정
