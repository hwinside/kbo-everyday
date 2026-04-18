# Design V2 Freeze Decision (2026-04-19)

> 상태: *삼순이 조건부 GO* (05:37) + 삼식이 리뷰 통합
> 판정: *디자인 자산 freeze = GO* / *제품 scope = 더 타이트하게*

---

## 🎯 1. 디자인 상위 원칙 4개 (삼순이 05:36) — Phase 1 가드레일

Phase 1 프리미티브/토큰 구현 시 이 4개가 *재료*. 각 primitive/screen 구현 후 체크.

### P1. 정보 위계 정리 — *"우선순위 1개만 제일 세게"*
- 한 화면에 *강조색·굵은 숫자·뱃지가 동시에* 나오면 유저 시선 분산
- 규칙: 한 화면당 *가장 강한 강조 1개*만 허용. 나머지는 보조 톤(`NEUTRAL.text2`, `withAlpha(accent, 0.14)` 등)
- 프리미티브 레벨: `<Badge emphasis="primary|secondary|muted">` 프로퍼티 도입 → 화면당 primary 1개 제한

### P2. CTA 선명화 — *첫 진입 시 "지금 뭘 눌러야 하는지" 명확*
- 홈/경기 일정: 메인 CTA 1개를 *고정 위치에 더 크게* (예: 내 팀 라이브 경기 → "라이브 관전")
- 경기 상세: `실시간 핵심 정보 > 액션 > 해설` 위계 유지
- 프리미티브 레벨: `<Button variant="primary-hero">` 추가 (기존 primary보다 한 단계 더 강조)

### P3. 순위/커뮤니티 밀도 완화
- 순위표: `최근10` 같은 보조열 *접기/요약* (상세는 탭 진입)
- 커뮤니티 홈: HOT·팀게시판·태그·수치 동시 강조 → *핫토픽 1축만* 가장 세게
- 모바일 375px 기준 *세로 정보 밀도* 20~30% 감소 목표

### P4. 선수 상세 해석 보조
- Radar Chart는 숫자만으로 오해 소지 → *"리그 평균 대비 타율 +0.032"* 같은 해석 문장 필수
- AD placeholder + 아이콘 탭 + Radar 동시 노출 시 시선 분산 → 순차 노출

---

## 📦 2. Scope 확정

### 🔴 NO-GO (V2 1차 제외, GA 이후 백로그)
1. DM/메시지 (`ScreenMessages`, `ScreenMessageChat`)
2. 팔로우 시스템 (`ScreenFollowList`)
3. 친구 초대 (`ScreenInvite`)
4. 뉴스 (`ScreenNewsList`, `ScreenNewsDetail`)
5. 티켓팅 (`ScreenTickets`)
6. 구장 정보 (`ScreenStadium`)
7. *선수 Radar Chart* (2026-04-19 05:40 삼순이 재판정 — range creep 우려)

### 🟡 ~~조건부 GO~~ → 🔴 NO-GO으로 증격 (삼순이 05:40)
- *선수 Radar Chart*: 디자인으로는 GO이지만 V2 *1차 scope는 NO-GO*
- 이유: Radar 차트는 넣는 순간 *해석문 + 비교기준 + 시즌기준*까지 범위가 확장 (range creep)
- GA 이후 백로그로 이동. V1 Hero Phase 1 완료된 선수 페이지를 V2 토큰으로 스타일링만

### ✅ GO
- *모달 6종* (modals.jsx) — 공통 UI 인프라. Phase 1 프리미티브에 흡수 (12→18종)
- *기본 뼈대*: 홈/경기/순위/커뮤니티/My(축소 scope)
- *토큰 자산*: tokens.js · atoms.jsx · 로고 10개 — v0→final 동일, 그대로 사용

### 🔴 My 페이지 scope 축소 (삼순이 05:40 재강조)
- V2 1차 My = *야구 앱 My* (프로필 편집 + 설정 + 공개 프로필 + 응원 팀 관리 + 예측 이력)
- *소셜 앱 My*가 아님 — DM/팔로우 탭 제거
- 원칙: *"너무 잘 만들수록 V2 목표가 흐려진다"* — My를 "경기 몰입 서포트" 수준까지만 억누름
- 프로필 공개 화면도 "내 응원팀·예측 적중률·올시즌 직관 횟수" 정도. 피드/팔로워/타임라인 금지

---

## 🎨 3. 디자인 자산 Freeze 상태

| 자산 | 상태 | 비고 |
|---|---|---|
| `tokens.js` (10팀+NEUTRAL) | 🔒 FROZEN | v0→final 동일 |
| `atoms.jsx` (7종) | 🔒 FROZEN | v0→final 동일 |
| `logos/*.svg` (10팀) | 🔒 FROZEN | v0→final 동일 |
| `shared/shell.jsx` | 🔒 FROZEN | v0→final 동일 |
| `screens/screens-game.jsx` | 🔒 FROZEN | 삼식이 리뷰 13건 반영하여 구현 |
| `screens/screens-team.jsx` | 🔒 FROZEN | 팀 메뉴 8→3개 축소 |
| `screens/screens-community.jsx` | 🔒 FROZEN | 내 팀 보드 상단 고정 추가 |
| `screens/screens-my.jsx` | 🟡 일부 FROZEN | Profile/Settings/Public만. DM/Follow/Invite 제외 |
| `screens/screens-more.jsx` | 🟡 일부 FROZEN | PredictVote/Highlights만. News/Tickets/Stadium 제외 |
| `screens/modals.jsx` | 🔒 FROZEN | 전체 (공통 UI 인프라) |
| `screens/screens-player.jsx` | 🟡 조건부 | Radar는 해석 문장 붙이면 GO |

---

## 🛠 4. 구현 시 적용할 변경사항 (목업 → 실제 코드에서 수정)

### A. Plan §4 프리미티브 확장 12종 → 18종
Modal 6종 추가 (신규):
- `ModalSheet` (bottom sheet wrapper)
- `ToastStack` (토스트 매니저)
- `ContextMenu`
- `TeamPickerModal`
- `ComposerModal` (page section 레벨이지만 primitive화 검토)
- `CommentSheetModal`

기존 프리미티브 확장:
- `<Badge emphasis="primary|secondary|muted">` (정보 위계 원칙)
- `<Button variant="primary-hero">` (CTA 선명화 원칙)

### B. 홈 화면 재설계 (삼식이 P0 + 삼순이 P2)
- 오늘 = 날짜 스트립 *정중앙*
- 내 팀 경기 = *최상단 히어로 카드* (팀팬 모드)
- 메인 CTA 1개 = "라이브 관전" (라이브 있을 때) / "예측 참여" (예정) / "결과 보기" (종료)

### C. 경기 Live (삼식이 P0 + 삼순이 P2)
- 공격팀/수비팀 시각 명시 (role badge)
- 정보 위계: Big Score → Linescore → Diamond/BSO → Pitcher/Batter → Chat hook
- 광고 슬롯 추가: Big Score 하단 60~80px

### D. 경기 Lineup
- 라인업 변경 표시 (`↑NEW`, `2→1` 등) — 디자인 레벨에서 반드시

### E. 채팅
- 각 메시지 long-press → ContextMenu (신고/차단/복사)

### F. 순위 (삼순이 P3 + 삼식이 P0)
- TeamHub 팀 메뉴 8→3개 (선수/일정/기록) + "더보기"
- StandingsDetail `last10` 컬럼 → 접기 + 상세 탭 진입
- Sticky header + 내 팀 row 상단 고정

### G. 커뮤니티 (삼순이 P3/P5 + 삼식이 P0)
- *위계 고정* (삼순이 05:40): *1순위 = 내 팀 보드 / 2순위 = HOT / 3순위 = 레벨·수치·태그* — 3개를 동시에 세게 밀면 포털 느낌
- 내 팀 보드 *상단 고정* (팀팬 모드) — 팀팬 진입 시 가장 먼저
- HOT 섹션은 *2순위 톤*: 타이틀 크기/강조 한 단계 낮춤
- 레벨 표시(`lvl: 51`) 제거 (설령 V1에 있어도 V2 1차는 빼는 방향 — "초반엔 포털화 방지" 원칙)
- "N" 뱃지 → `🔥 새 글` 명확화
- 팀 게시판 정렬 칩 밀도 낮춤

### H. 선수 상세 (삼순이 05:40 재판정 — Radar NO-GO)
- *Radar Chart 제거* — V1 Hero Phase 1 완료된 선수 페이지를 V2 토큰으로만 스타일링
- AD placeholder + 아이콘 탭 + 히어로 시선 분산 방지 (정보 위계 원칙 적용)
- Radar는 GA 이후 별도 Phase에서 해석문·비교기준·시즌기준과 함께 설계

### I. 토큰 (삼식이 P0)
- NEUTRAL accent `#E03A3A` → 대안 검토 (하린아빠 브랜드 가이드 대기)
- 광고 슬롯 토큰 (`--ad-bg`, `--ad-border`, `--ad-label-color`)
- 접근성 토큰 (`--motion-duration`, `--focus-ring`)

### J. TabBar (삼식이 P0)
- 5탭 유지 권장: `홈 · 경기 · 순위 · 커뮤 · My`
- 단, `홈` = 팀팬 커스텀 홈 (내 팀 오늘 + 팀 피드), `경기` = 전경기 스케줄
- 중립팬 `홈` = 전경기 스케줄 (경기 탭과 동일)

---

## ⏭️ 5. 다음 단계

1. ✅ 하린아빠 위 scope + 상위 원칙 4개 최종 승인
2. 📝 `specs/design-v2-migration.md` v0.5로 업데이트 (scope 축소 + 원칙 4개 반영)
3. 📝 `specs/design-v2-migration-plan.md` v0.3 업데이트 (프리미티브 12→18, Badge emphasis, Button primary-hero)
4. 📝 `specs/design-v2-migration-tasks.md` v0.3 업데이트 (조건부 GO 태스크 추가)
5. 🚀 Phase 1 착수

### ✅ 기본값(디폴트) 채택 — 삼순이 05:42 추천안

하린아빠 다른 의견 없으면 아래 4개 기본값으로 진행. 동의 시 별도 지시 불요.

| 사항 | 기본값(채택) | 이유 |
|---|---|---|
| 1. 레벨 시스템 | *제거* | V1 실구현 없으면 V2에도 넣지 않음. 초반 포털화 방지 원칙 일치 |
| 2. NEUTRAL accent | *KBO 블루/중성색* | 빨강 계열(#E03A3A) → LG/KIA/SSG와 충돌. 구체안 아래 후보 3종 |
| 3. 광고 슬롯 | *자리만 설계* | AdSlot 프리미티브 코드화 + 토큰 추가. 실제 광고사 연동은 Phase 5 이후 |
| 4. TabBar | *5탭 유지* | `홈 · 경기 · 순위 · 커뮤 · My` — 홈은 "내 팀 중심 홈" (전체 홈 아님) |

#### NEUTRAL accent 후보 3종 (Phase 1 tokens.css 초안에 반영)
- **A) KBO 원조 블루 `#1E4B8C`** — 야구 리그 헤리티지 느낌, 10팀 primary 어느것과도 상충도 낮음
- **B) 중성 원좀 그레이 `#7A7A80`** — 완전 중립, 존재감 10~15% 유지에 적합
- **C) 원욀 계열 차코올 `#3A3A42`** — 다크 모드와 자연스러운 조화, 번칩 낮음
- 제 추천: **A (KBO 블루)** — "앱 상징성 + 팀 중립" 둘 다 달성

#### 홈 = "내 팀 중심 홈" 구체화 (삼순이 05:42 지적)
- 팀팬: 내 팀 오늘 경기 Hero 카드 + 내 팀 최근 뉴스/하이라이트 + 팀 커뮤니티 미리보기 + 팀 순위/다음 경기
- 중립팬: "팀 선택하기" 프롬프트 → 팀 선택 전까지는 오늘 전경기 요약 (현재 스케줄 화면 재사용)
- 탭 구분 명확: `홈` = 내 팀 · `경기` = 전체 스케줄

### 미확인 (하린아빠 최종 확인만 남음)
위 4개 기본값에 반대하시면 노티. 반대 없으면 간주 승인.
