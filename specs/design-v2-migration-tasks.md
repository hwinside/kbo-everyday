# 크보팬 Design V2 Migration — Tasks

> 상태: Draft (v0.3 — 최종본 freeze 후 전체 FROZEN 승격)
> 작성: 2026-04-19 삼식이
> 상위: `specs/design-v2-migration.md` (v0.5), `specs/design-v2-migration-plan.md` (v0.3)
> 시각 SSOT: `specs/design-v2-reference/` (최종본, freeze 완료)
> 하린아빠 승인: 2026-04-19 05:43 ("삼순 의견에 전부 동의")

> *원자 단위 = 커밋 1개* — 빅뱅 금지. 각 태스크 ≤ 4시간 이내.
> 체크박스 업데이트는 PR 머지 시에만.

---

## Phase 1 — Foundation (Week 1, 7 days) — 전체 🔒 FROZEN

### 1.1 Design tokens & helpers
- [ ] T1.1.1 `public/team-logos/` 에 reference `logos/*.svg` 10개 복사
- [ ] T1.1.2 `src/design-v2/tokens.css` 작성 — 10팀 + NEUTRAL (KBO 블루 `#1E4B8C`) + 광고 슬롯 토큰 + a11y 토큰
- [ ] T1.1.3 `src/design-v2/team-palette.ts` — reference `tokens.js` 4 helper TS 포팅 + 단위 테스트 (10팀 × 2 intensity = 20 케이스)
- [ ] T1.1.4 `src/design-v2/TEAMS.ts` — 10팀+neutral 상수, DB team_id 매핑
- [ ] T1.1.5 `src/lib/design-v2/contrast.ts` — WCAG AA 대비 계산 함수 + 단위 테스트

### 1.2 ThemeProvider & SSR
- [ ] T1.2.1 `src/design-v2/theme-provider.tsx` — team slug 기반 data-attr + CSS var 주입
- [ ] T1.2.2 `useTeamTheme()` hook — AuthContext 연동, fallback neutral
- [ ] T1.2.3 SSR cookie 읽기 — `<html data-team>` 서버에서 세팅 (FOUC 방지)
- [ ] T1.2.4 beforeInteractive inline script — 쿠키 없을 때 neutral 기본값

### 1.3 Feature Flag + User Exposure Lockdown
- [ ] T1.3.1 DB 마이그레이션: `profiles.design_version` 컬럼 + index
- [ ] T1.3.2 `src/middleware.ts` 확장 — `?v2=1/0` 쿠키 set/delete, `/v2/*` 가드
- [ ] T1.3.3 `src/lib/feature-flags/design-version.ts` — getDesignVersion() 유틸
- [ ] T1.3.4 AuthContext에 `designVersion` 상태 추가 → DB → cookie → 'v1'
- [ ] T1.3.5 **User Exposure Lockdown 가드** — design freeze 전까지 middleware에서 DB `v2`도 V1 강제 fallback

### 1.4 Primitive 컴포넌트 18종 (기본 12 + 모달 6)

#### 기본 12종
- [ ] T1.4.1 `Button.tsx` — 5 variants (**primary/primary-hero**/weak/ghost/underline)
- [ ] T1.4.2 `Card.tsx` — cardTint 배경
- [ ] T1.4.3 `Stat.tsx` — tabular-nums + right-align
- [ ] T1.4.4 `Badge.tsx` — W/L/LIVE/HR/SO + **emphasis 3단 (primary/secondary/muted)** 정보위계 원칙
- [ ] T1.4.5 `ChipTabs.tsx` — 경기 상세 탭
- [ ] T1.4.6 `UnderlineTabs.tsx` — 홈/커뮤니티 상단 탭
- [ ] T1.4.7 `Chip.tsx` — 필터 칩 / 팀 칩
- [ ] T1.4.8 `TeamLogo.tsx` — next/image 원형 컨테이너
- [ ] T1.4.9 `Diamond.tsx` — 베이스러너 SVG
- [ ] T1.4.10 `Pips.tsx` — B/S/O dots
- [ ] T1.4.11 `ScoreCard.tsx` — ScreenGameLive 스코어 영역
- [ ] T1.4.12 `WinProbabilityBar.tsx` — 승리확률 게이지

#### 모달 6종 (신규, 공통 UI 인프라)
- [ ] T1.4.13 `ModalSheet.tsx` — bottom sheet wrapper (swipe-to-dismiss + grab handle)
- [ ] T1.4.14 `ToastStack.tsx` — 토스트 매니저 (useToast hook)
- [ ] T1.4.15 `ContextMenu.tsx` — long-press 컨텍스트 메뉴 (신고/차단/복사 등)
- [ ] T1.4.16 `TeamPickerModal.tsx` — 10팀 선택 모달
- [ ] T1.4.17 `ComposerModal.tsx` — 글쓰기 bottom sheet (기존 PlayerPickerSheet 재사용)
- [ ] T1.4.18 `CommentSheetModal.tsx` — 댓글 bottom sheet

#### AdSlot (신규, 자리만)
- [ ] T1.4.19 `AdSlot.tsx` — 광고 자리 프리미티브 (size prop: banner-60/native-card/interstitial). 실제 광고 로드는 후일
- [ ] T1.4.20 AdSlot 토큰 (`--ad-bg`, `--ad-border`, `--ad-label-color`) — tokens.css에 추가

### 1.5 Playground & QA
- [ ] T1.5.1 `/v2/playground` 페이지 — 10팀 × 모든 primitive 렌더링 (기본 12 + 모달 6 + AdSlot)
- [ ] T1.5.2 `scripts/check-design-contrast.ts` — WCAG AA 자동 검사 (120 케이스)
- [ ] T1.5.3 `npm run contrast-check` package.json + CI 블로킹
- [ ] T1.5.4 10팀 × 6 항목 수동 체크리스트

### 🚪 Phase 1 Gate
- [ ] 삼순이 디자인 토큰 + 원칙 4개 리뷰 GO
- [ ] contrast-check 10팀 × 120케이스 PASS
- [ ] Playground에서 팀 전환 + 모든 primitive (18+1) 확인
- [ ] 하린아빠 Phase 2 승인

---

## Phase 2 — Home + Game Detail (Week 2, 7 days)

### 2.1 V2 라우트 셸
- [ ] T2.1.1 `src/app/(v2)/layout.tsx` — ThemeProvider wrap + V2 global CSS import
- [ ] T2.1.2 bottom TabBar V2 컴포넌트 — *5탭* (`홈·경기·순위·커뮤·My`)
- [ ] T2.1.3 PhoneHeader V2 (뒤로가기 + 타이틀 + 우측 액션)

### 2.2 홈 V2 — **내 팀 중심 홈**
- [ ] T2.2.1 `src/components/v2/home/MyTeamHero.tsx` — 내 팀 오늘 경기 Hero 카드 (라이브/예정/종료 3 상태)
- [ ] T2.2.2 `src/components/v2/home/MyTeamHighlights.tsx` — 팀 뉴스/하이라이트 미리보기
- [ ] T2.2.3 `src/components/v2/home/MyTeamCommunityPreview.tsx` — 팀 커뮤 HOT 3건
- [ ] T2.2.4 `src/components/v2/home/MyTeamRankStrip.tsx` — 팀 순위 + 다음 경기
- [ ] T2.2.5 `src/components/v2/home/NeutralHome.tsx` — 중립팬 홈 (팀 선택 프롬프트 + 오늘 전경기 요약)
- [ ] T2.2.6 `src/app/(v2)/page.tsx` — 팀팬/중립 조건부 렌더
- [ ] T2.2.7 **메인 CTA 1개 고정** — 라이브 시 "라이브 관전" / 예정 "예측 참여" / 종료 "결과 보기" (CTA 선명화 원칙)
- [ ] T2.2.8 GA4 이벤트: `home_cta_click` with `{cta, design_version, team}`
- [ ] T2.2.9 QA: 10팀 팀팬 + 중립 = 11 시나리오 스크린샷

### 2.3 경기 상세 V2
- [ ] T2.3.1 `src/components/v2/game/GameHeader.tsx` — 팀 로고 + 스코어 + 상태
- [ ] T2.3.2 `src/components/v2/game/GamePreviewTab.tsx` — 라인업 발표 전 프리뷰
- [ ] T2.3.3 `src/components/v2/game/GameLiveTab.tsx` — 승리확률 + Big Score + Linescore + Diamond + Pips
  - **공격팀/수비팀 role 뱃지** 추가 (정보 위계)
  - **AdSlot (banner-60) 삽입**: Big Score 하단
- [ ] T2.3.4 `src/components/v2/game/GameLineupTab.tsx`
  - **라인업 변경 표시 (`↑NEW`, `2→1` 등)** — V1 `/api/lineup-analysis` 재사용
- [ ] T2.3.5 `src/components/v2/game/GameTimelineTab.tsx` — 이닝별 스코어보드
- [ ] T2.3.6 `src/components/v2/game/GameChatTab.tsx` — V1 `useChat` 훅 재사용
  - **메시지 long-press → ContextMenu** (신고/차단/복사)
- [ ] T2.3.7 `src/components/v2/game/GamePredictTab.tsx` — 승부예측 투표 + **종료 경기 "내 예측 결과" 뱃지**
- [ ] T2.3.8 `src/app/(v2)/game/[gameId]/page.tsx` — 6탭 통합 (ChipTabs)
- [ ] T2.3.9 QA: 오늘 5경기 × 내 팀/중립 = 10 시나리오

### 🚪 Phase 2 Gate
- [ ] 내부 3명 `?v2=1`로 수동 QA PASS
- [ ] Lighthouse 성능 V1 대비 95%↑
- [ ] 에러율 V1 동등 이하
- [ ] 하린아빠 Phase 3 승인

---

## Phase 3 — Standings + Community (Week 3, 7 days)

### 3.1 순위 V2 — **TeamHub 팀 메뉴 3개만**
- [ ] T3.1.1 `src/components/v2/standings/TeamHubHero.tsx` — watermark 로고 + 팀 컬러 그라데이션
- [ ] T3.1.2 `src/components/v2/standings/TeamMenuReduced.tsx` — *3개만* (선수/일정/기록) + "더보기 🔒" (비활성)
- [ ] T3.1.3 `src/components/v2/standings/StandingsTable.tsx`
  - **tie-aware rank** (공동 순위 처리 — 04-18 P0 이슈 대응)
  - **last10 컬럼 접기** (요약 → 탭 진입 시 상세, 밀도 완화 원칙)
  - **sticky header + 내 팀 row 상단 고정** (팀팬 모드)
- [ ] T3.1.4 `src/components/v2/standings/MyTeamCard.tsx` — 팀팬용 하이라이트 카드
- [ ] T3.1.5 `src/components/v2/standings/NeutralList.tsx` — 중립용 플랫 테이블
- [ ] T3.1.6 `src/app/(v2)/standings/page.tsx` — 팀팬/중립 조건부
- [ ] T3.1.7 QA: 10팀 + 중립 = 11 시나리오

### 3.2 커뮤니티 V2 — **위계 고정 (내 팀 > HOT > 나머지)**
- [ ] T3.2.1 `src/components/v2/community/MyTeamBoardPinned.tsx` — *1순위, 상단 고정* (팀팬 진입 시 가장 먼저)
- [ ] T3.2.2 `src/components/v2/community/HotStrip.tsx` — *2순위, 한 단계 톤다운*
- [ ] T3.2.3 `src/components/v2/community/TeamBoardList.tsx` — 나머지 팀 게시판 (3순위)
  - **"N" 뱃지 → "🔥 새 글" 명확화**
  - **레벨 표시 제거** (V2 1차 미표시)
- [ ] T3.2.4 `src/components/v2/community/BoardHeader.tsx` — 팀 컬러 헤더
- [ ] T3.2.5 `src/components/v2/community/PostCard.tsx` — 게시글 카드 (레벨 제거, 태그 톤다운)
- [ ] T3.2.6 `src/components/v2/community/Composer.tsx` — ComposerModal 재사용
- [ ] T3.2.7 `src/app/(v2)/community/page.tsx` — 커뮤니티 홈 (위계 3단)
- [ ] T3.2.8 `src/app/(v2)/community/[board]/page.tsx` — 보드 상세
- [ ] T3.2.9 V1 API 재사용: `/api/posts`, `/api/boards`
- [ ] T3.2.10 QA: 10팀 × 글쓰기 + 댓글 + 리액션

### 🚪 Phase 3 Gate
- [ ] 삼순이 E2E 체크 GO (특히 위계 원칙 준수)
- [ ] Playwright 자동 테스트
- [ ] 하린아빠 Phase 4 승인

---

## Phase 4 — My + Polish (Week 4, 5 days)

### 4.1 My 페이지 — **"야구 앱 My" 범위만**
- [ ] T4.1.1 `src/components/v2/my/ProfileCard.tsx` — 응원팀 + 가입일 + 예측 적중률
- [ ] T4.1.2 `src/components/v2/my/StatsRow.tsx` — 올시즌 직관 횟수 + 예측 적중률 + 게시글 수
- [ ] T4.1.3 `src/components/v2/my/TeamChange.tsx` — 응원팀 변경
- [ ] T4.1.4 `src/components/v2/my/SettingsList.tsx` — 알림/언어/로그아웃
- [ ] T4.1.5 `src/app/(v2)/my/page.tsx` — 조합 (*DM/팔로우/초대 탭 없음*)
- [ ] T4.1.6 `src/app/(v2)/my/[userId]/page.tsx` — 공개 프로필 (응원팀·예측적중률·직관 횟수만, 피드/팔로워 NO)
- [ ] T4.1.7 QA: 10팀

### 4.2 Polish
- [ ] T4.2.1 10팀 × 6페이지 전수 QA
- [ ] T4.2.2 저채도 팀 CTA 배경 onAccent 텍스트 AA↑ 재검증
- [ ] T4.2.3 `prefers-reduced-motion` 존중
- [ ] T4.2.4 iOS Safari dynamic island safe area
- [ ] T4.2.5 Android Chrome status bar color 매칭
- [ ] T4.2.6 이미지 lazy-load (스코어카드 상단 로고는 eager)
- [ ] T4.2.7 Lighthouse 100점 체크

### 🚪 Phase 4 Gate
- [ ] 삼순이 QA 전수 PASS (원칙 4개 준수 재확인)
- [ ] contrast-check 재실행 PASS
- [ ] 하린엄마 QA 테스트 승인
- [ ] 하린아빠 Phase 5 승인 → **Design Freeze Gate 해제** (유저 노출 lockdown 해제)

---

## Phase 5 — Beta (Week 5, 7 days)

### 5.1 Admin 대시보드
- [ ] T5.1.1 `src/app/admin/design-v2-cohort/page.tsx` — cohort 설정 + 모니터링
- [ ] T5.1.2 `GET/POST /api/admin/design-v2-cohort` — cohort CRUD
- [ ] T5.1.3 "design_version 미포함 이벤트 카운터" 실시간 표시

### 5.2 GA4 이벤트 확장 (Plan §9.1 9종)
- [ ] T5.2.1 모든 핵심 이벤트에 `design_version` 파라미터 + 누락 검증 스크립트
- [ ] T5.2.2 신규 이벤트: `home_cta_click`, `game_tab_switch`, `community_post_create`, `community_reaction`, `chat_message_send`, `predict_vote`, `design_v2_optout`
- [ ] T5.2.3 GA4 custom dimension `design_version` 등록
- [ ] T5.2.4 Meta/Google Ads conversion pixel에 `design_version` 전달

### 5.3 Cohort 모집 & 실행 (옵트인만, Plan §6.3)
- [ ] T5.3.1 다양성 코호트 SQL (헤비5 + 중립3 + 저사양3 + 비로그인3 + 신규3 + 하위권2)
- [ ] T5.3.2 디스코드 자원자 모집
- [ ] T5.3.3 Shadow control 15~20명 동등 매칭
- [ ] T5.3.4 Admin UI에서 일괄 `design_version='v2'` 업데이트
- [ ] T5.3.5 환영 DM 발송 (옵트아웃 링크 + 외부 공유 자제 요청)
- [ ] T5.3.6 7일 모니터링 — 매일 17시 #marketing 스레드 자동 리포트
- [ ] T5.3.7 **조기 종료 가드** — 3일차 KPI 30% 악화 시 중단 + V1 복귀

### 5.4 피드백 수집
- [ ] T5.4.1 V2 모든 route에 "V1으로 돌아가기" 하단 링크
- [ ] T5.4.2 피드백 모달 (5분 체류 후)
- [ ] T5.4.3 `feedback` 테이블에 `design_version` 저장
- [ ] T5.4.4 옵트아웃 시 `v2_optout_at` + `v2_optout_reason` 기록

### 🚪 Phase 5 Gate
- [ ] KPI 복합 기준 PASS (재방문율 + CTA CTR + 오류율) — 최약 코호트 기준
- [ ] Cohort별 부정 피드백 ≤ 30%
- [ ] 저사양 cohort "느려졌다" 피드백 ≤ 1명
- [ ] 하린아빠 Phase 6 승인

---

## Phase 6 — Cutover (Week 6, 5 days)

### 6.1 페이지 단위 순차 교체
- [ ] T6.1.1 홈 교체 + 24h 모니터링
- [ ] T6.1.2 경기 상세 교체 + 24h
- [ ] T6.1.3 순위 교체 + 24h
- [ ] T6.1.4 커뮤니티 교체 + 24h
- [ ] T6.1.5 My 교체 + 24h

### 6.2 전환 완료
- [ ] T6.2.1 `profiles.design_version` 기본값 `v2`로 변경
- [ ] T6.2.2 `kbo-design` 쿠키 default 로직 제거
- [ ] T6.2.3 Admin에서 전체 유저 V2 확인

### 6.3 코드 정리 (GA 후 2주 후)
- [ ] T6.3.1 V1 페이지 컴포넌트 삭제
- [ ] T6.3.2 `src/app/(v2)/` → `src/app/(main)/` 이름 변경
- [ ] T6.3.3 `/v2` prefix 제거
- [ ] T6.3.4 V1 전용 컴포넌트 `src/components/legacy/` 아카이브
- [ ] T6.3.5 middleware에서 `/v2/*` 분기 제거

### 🚪 Phase 6 Gate (최종)
- [ ] 모든 페이지 전환 후 24h 지표 정상
- [ ] Sentry 에러율 V1 수준 이하
- [ ] DAU ±10% 이내
- [ ] 삼순이 최종 QA PASS
- [ ] 하린아빠 V1 코드 삭제 승인

---

## 📊 Progress Tracking

| Phase | Start | End | Status | Gate |
|---|---|---|---|---|
| 1. Foundation (18 primitives + Lockdown) | — | — | 🔜 ready | — |
| 2. Home + Game | — | — | ⏸️ | — |
| 3. Standings + Community | — | — | ⏸️ | — |
| 4. My + Polish | — | — | ⏸️ | — |
| 5. Beta | — | — | ⏸️ | — |
| 6. Cutover | — | — | ⏸️ | — |

---

## 📝 Phase 종료 시 기록 (tasks/lessons.md)
- 실제 소요 시간 vs 예상 (분산 확인)
- 예상 못한 기술 이슈
- reference 최종본과 실구현 gap
- 다음 Phase 준비사항
- 원칙 4개 위반 사례 (있으면)
