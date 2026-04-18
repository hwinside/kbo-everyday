# 크보팬 Design V2 Migration — Tasks

> 상태: Draft (v0.1)
> 작성: 2026-04-19 삼식이
> 상위: `specs/design-v2-migration.md` (v0.4), `specs/design-v2-migration-plan.md` (v0.1)
> 시각 SSOT: `specs/design-v2-reference/`

> *원자 단위 = 커밋 1개* — 빅뱅 금지. 각 태스크 ≤ 4시간 이내.
> 체크박스 업데이트는 PR 머지 시에만.

---

## Phase 1 — Foundation (Week 1, 7 days)

### 1.1 Design tokens & helpers
- [ ] T1.1.1 `public/team-logos/` 에 reference `logos/*.svg` 10개 복사 + gitignore 제외
- [ ] T1.1.2 `src/design-v2/tokens.css` 작성 — 10팀 + NEUTRAL 다크 토큰 (Plan §2.2 기준)
- [ ] T1.1.3 `src/design-v2/team-palette.ts` — reference `tokens.js`의 4 helper (mix/withAlpha/luminance/teamPalette) TS 포팅 + 단위 테스트 10팀 × 2 intensity = 20 케이스
- [ ] T1.1.4 `src/design-v2/TEAMS.ts` — 10팀+neutral 상수, DB team_id 매핑 포함
- [ ] T1.1.5 `src/lib/design-v2/contrast.ts` — WCAG AA 대비 계산 함수 + 단위 테스트

### 1.2 ThemeProvider & SSR
- [ ] T1.2.1 `src/design-v2/theme-provider.tsx` — team slug 기반 data-attr + CSS var 주입
- [ ] T1.2.2 `useTeamTheme()` hook — AuthContext 연동, fallback neutral
- [ ] T1.2.3 SSR cookie 읽기 — `<html data-team>` 서버에서 세팅 (FOUC 방지)
- [ ] T1.2.4 beforeInteractive inline script — 쿠키 없을 때 neutral 기본값 세팅

### 1.3 Feature Flag
- [ ] T1.3.1 DB 마이그레이션: `profiles.design_version` 컬럼 + index (Plan §3.3)
- [ ] T1.3.2 `src/middleware.ts` 확장 — `?v2=1/0` 쿠키 set/delete, `/v2/*` 가드
- [ ] T1.3.3 `src/lib/feature-flags/design-version.ts` — getDesignVersion() 유틸
- [ ] T1.3.4 AuthContext에 `designVersion` 상태 추가 → DB → cookie → 'v1' 순서로 해석

### 1.4 Primitive 컴포넌트 12종
- [ ] T1.4.1 `Button.tsx` (primary/weak/ghost/underline 4 variants)
- [ ] T1.4.2 `Card.tsx` — cardTint 배경
- [ ] T1.4.3 `Stat.tsx` — tabular-nums + right-align
- [ ] T1.4.4 `Badge.tsx` — W/L/LIVE/HR/SO 등 상태 프리셋
- [ ] T1.4.5 `ChipTabs.tsx` — 경기 상세 탭 전환
- [ ] T1.4.6 `UnderlineTabs.tsx` — 홈/커뮤니티 상단 탭
- [ ] T1.4.7 `Chip.tsx` — 필터 칩 / 팀 칩
- [ ] T1.4.8 `TeamLogo.tsx` — next/image 기반, 원형 컨테이너 + padding
- [ ] T1.4.9 `Diamond.tsx` — 베이스러너 SVG (reference 1:1 포팅)
- [ ] T1.4.10 `Pips.tsx` — B/S/O dots
- [ ] T1.4.11 `ScoreCard.tsx` — reference `ScreenGameLive` 스코어 영역 추출
- [ ] T1.4.12 `WinProbabilityBar.tsx` — 승리확률 게이지 (승팀 큰 숫자)

### 1.5 Playground & QA
- [ ] T1.5.1 `/v2/playground` 페이지 — 10팀 × 모든 primitive 렌더링
- [ ] T1.5.2 `scripts/check-design-contrast.ts` — WCAG AA 자동 검사 (120 케이스)
- [ ] T1.5.3 `npm run contrast-check` package.json 추가 + CI (GitHub Actions) 블로킹
- [ ] T1.5.4 10팀 × 6 항목 수동 체크리스트 (Plan §5.2) — playground 스크린샷 첨부

### 🚪 Phase 1 Gate
- [ ] 삼순이 디자인 토큰 리뷰 GO
- [ ] contrast-check 10팀 × 120케이스 PASS
- [ ] Playground `/v2/playground`에서 팀 전환 + 모든 primitive 확인
- [ ] 하린아빠 Phase 2 승인

---

## Phase 2 — Home + Game Detail (Week 2, 7 days)

### 2.1 V2 라우트 셸
- [ ] T2.1.1 `src/app/(v2)/layout.tsx` — ThemeProvider wrap + V2 global CSS import
- [ ] T2.1.2 bottom TabBar V2 컴포넌트 (reference atoms.jsx TabBar)
- [ ] T2.1.3 PhoneHeader V2 (뒤로가기 + 타이틀 + 우측 액션)

### 2.2 홈 V2
- [ ] T2.2.1 `src/components/v2/home/HeroScoreCard.tsx` — 오늘 내 팀 경기 카드 (라이브 or 예정)
- [ ] T2.2.2 `src/components/v2/home/LiveCtaGrid.tsx` — 라이브채팅/승부예측/라인업/하이라이트 CTA 4종
- [ ] T2.2.3 `src/components/v2/home/GameScheduleList.tsx` — 하단 전경기 스케줄
- [ ] T2.2.4 `src/app/(v2)/page.tsx` — 홈 조합 + V1 `/api/games` 재사용
- [ ] T2.2.5 GA4 이벤트: `home_cta_click` with `{cta, design_version: 'v2'}`
- [ ] T2.2.6 QA: 10팀 + 중립 모두 데이터 fetch + 렌더 확인 (스크린샷 11장)

### 2.3 경기 상세 V2
- [ ] T2.3.1 `src/components/v2/game/GameHeader.tsx` — 팀 로고 + 스코어 + 상태
- [ ] T2.3.2 `src/components/v2/game/GamePreviewTab.tsx` — 라인업 발표 전 프리뷰
- [ ] T2.3.3 `src/components/v2/game/GameLiveTab.tsx` — 승리확률 바 + 실시간 스코어 + Diamond + Pips
- [ ] T2.3.4 `src/components/v2/game/GameLineupTab.tsx` — 라인업 (V1 `/api/lineup-analysis` 재사용)
- [ ] T2.3.5 `src/components/v2/game/GameTimelineTab.tsx` — 이닝별 스코어보드
- [ ] T2.3.6 `src/components/v2/game/GameChatTab.tsx` — 실시간 채팅 (V1 `useChat` 훅 재사용)
- [ ] T2.3.7 `src/components/v2/game/GamePredictTab.tsx` — 승부예측 투표
- [ ] T2.3.8 `src/app/(v2)/game/[gameId]/page.tsx` — 6탭 통합 (ChipTabs)
- [ ] T2.3.9 QA: 오늘 5경기 × 내 팀/중립 = 10 시나리오 수동 확인

### 🚪 Phase 2 Gate
- [ ] 내부 3명 (하린아빠/삼식/삼순) `?v2=1`로 수동 QA PASS
- [ ] Lighthouse 성능 V1 대비 95%↑ (FCP/LCP/CLS)
- [ ] 에러율 V1 동등 이하 (Sentry)
- [ ] 하린아빠 Phase 3 승인

---

## Phase 3 — Standings + Community (Week 3, 7 days)

### 3.1 순위 V2
- [ ] T3.1.1 `src/components/v2/standings/MyTeamCard.tsx` — 내 팀 하이라이트 카드 (팀팬용)
- [ ] T3.1.2 `src/components/v2/standings/NeutralList.tsx` — 플랫 테이블 (중립용)
- [ ] T3.1.3 `src/components/v2/standings/StandingsTable.tsx` — 1~10위 공통 테이블 (W/L/GB/스트릭)
- [ ] T3.1.4 `src/app/(v2)/standings/page.tsx` — 팀팬/중립 조건부 렌더
- [ ] T3.1.5 QA: 10팀 + 중립 = 11 시나리오 스크린샷

### 3.2 커뮤니티 V2
- [ ] T3.2.1 `src/components/v2/community/BoardHeader.tsx` — 팀 컬러 헤더 + 다른 팀 이동 prominent
- [ ] T3.2.2 `src/components/v2/community/PostCard.tsx` — 게시글 카드
- [ ] T3.2.3 `src/components/v2/community/Composer.tsx` — 글쓰기 bottom sheet (V1 PlayerPickerSheet 재사용)
- [ ] T3.2.4 `src/app/(v2)/community/page.tsx` — 커뮤니티 홈
- [ ] T3.2.5 `src/app/(v2)/community/[board]/page.tsx` — 보드 상세
- [ ] T3.2.6 V1 API 재사용: `/api/posts`, `/api/boards`
- [ ] T3.2.7 QA: 10팀 × 글쓰기 + 댓글 + 리액션

### 🚪 Phase 3 Gate
- [ ] 삼순이 E2E 체크 GO
- [ ] Playwright 자동 테스트 (기존 `e2e/` 확장)
- [ ] 하린아빠 Phase 4 승인

---

## Phase 4 — My + Polish (Week 4, 5 days)

### 4.1 My 페이지
- [ ] T4.1.1 `src/components/v2/my/ProfileCard.tsx` — 프로필 + 레벨 + 배지
- [ ] T4.1.2 `src/components/v2/my/StatsRow.tsx` — 게시글/좋아요/예측적중률
- [ ] T4.1.3 `src/components/v2/my/BadgeGrid.tsx` — 배지 12개
- [ ] T4.1.4 `src/components/v2/my/SettingsList.tsx` — 응원구단 변경·알림·로그아웃
- [ ] T4.1.5 `src/app/(v2)/my/page.tsx` — 조합
- [ ] T4.1.6 QA: 10팀 × 배지 획득/미획득 상태

### 4.2 Polish
- [ ] T4.2.1 10팀 × 6페이지 전수 QA (Plan §5.2 체크리스트 전부 체크)
- [ ] T4.2.2 저채도 팀 CTA 배경 onAccent 텍스트 AA↑ 재검증
- [ ] T4.2.3 `prefers-reduced-motion` 존중 (transition disable)
- [ ] T4.2.4 iOS Safari dynamic island safe area
- [ ] T4.2.5 Android Chrome status bar color 매칭
- [ ] T4.2.6 이미지 lazy-load (스코어카드 상단 로고는 eager)
- [ ] T4.2.7 Lighthouse 100점 체크 (Accessibility 우선)

### 🚪 Phase 4 Gate
- [ ] 삼순이 QA 전수 PASS
- [ ] contrast-check 재실행 PASS
- [ ] 하린엄마 승인 (QA 테스터)
- [ ] 하린아빠 Phase 5 승인

---

## Phase 5 — Beta (Week 5, 7 days)

### 5.1 Admin 대시보드
- [ ] T5.1.1 `src/app/admin/design-v2-cohort/page.tsx` — cohort 설정 + 모니터링
- [ ] T5.1.2 `GET /api/admin/design-v2-cohort` — cohort 유저 메트릭
- [ ] T5.1.3 `POST /api/admin/design-v2-cohort` — cohort opt-in/out 토글

### 5.2 GA4 이벤트 확장
- [ ] T5.2.1 모든 기존 이벤트에 `design_version` 파라미터 추가 발화
- [ ] T5.2.2 신규 `home_cta_click`, `game_tab_switch`, `community_post_create` 이벤트
- [ ] T5.2.3 GA4 custom dimension `design_version` 등록

### 5.3 Cohort 모집 & 실행
- [ ] T5.3.1 Cohort SQL 실행 (Plan §6.1) — 헤비5 + 중립3 + 하위권1~2 + 신규3
- [ ] T5.3.2 디스코드 자원자 모집 — 저사양 3명 + 비로그인 3명
- [ ] T5.3.3 Admin UI에서 15~20명 `design_version='v2'` 일괄 업데이트
- [ ] T5.3.4 환영 DM 발송 (옵트아웃 링크 포함)
- [ ] T5.3.5 7일 모니터링 — 매일 17시 #marketing 스레드 자동 리포트

### 5.4 피드백 수집
- [ ] T5.4.1 V2 페이지 모든 route에 "V1으로 돌아가기" 하단 링크 (쿠키 delete)
- [ ] T5.4.2 V2 경험 후 피드백 모달 (SessionStorage 트리거, 5분 체류 후)
- [ ] T5.4.3 피드백 `feedback` 테이블에 `design_version` 저장

### 🚪 Phase 5 Gate
- [ ] KPI 복합 기준 PASS (재방문율 + CTA 클릭률 + 오류율)
- [ ] Cohort별 부정 피드백 ≤ 30%
- [ ] 저사양 cohort "느려졌다" 피드백 ≤ 1명
- [ ] 하린아빠 Phase 6 승인

---

## Phase 6 — Cutover (Week 6, 5 days)

### 6.1 페이지 단위 순차 교체
- [ ] T6.1.1 `src/app/page.tsx` (홈) — feature flag 보고 V1/V2 컴포넌트 렌더. 기본 V2로 전환
- [ ] T6.1.2 24h 모니터링 — 지표 정상 확인 후 다음 단계
- [ ] T6.1.3 경기 상세 교체 + 24h 모니터링
- [ ] T6.1.4 순위 교체 + 24h 모니터링
- [ ] T6.1.5 커뮤니티 교체 + 24h 모니터링
- [ ] T6.1.6 My 교체 + 24h 모니터링

### 6.2 전환 완료
- [ ] T6.2.1 `profiles.design_version` 기본값 `v2`로 변경 + 기존 `v1` 일괄 `v2` 업데이트
- [ ] T6.2.2 `kbo-design` 쿠키 default 로직 제거
- [ ] T6.2.3 관리자 페이지에서 전체 유저 V2 확인

### 6.3 코드 정리 (GA 후 2주 대기 후 시작)
- [ ] T6.3.1 V1 페이지 컴포넌트 삭제
- [ ] T6.3.2 `src/app/(v2)/` → `src/app/(main)/` 이름 변경
- [ ] T6.3.3 `/v2` prefix 제거
- [ ] T6.3.4 V1 전용 컴포넌트 `src/components/legacy/` 아카이브 또는 삭제
- [ ] T6.3.5 middleware에서 `/v2/*` 분기 제거
- [ ] T6.3.6 `design_version` 컬럼 유지 여부 결정 (향후 V3 대비 유지 권장)

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
| 1. Foundation | — | — | ⏸️ pending | — |
| 2. Home + Game | — | — | ⏸️ | — |
| 3. Standings + Community | — | — | ⏸️ | — |
| 4. My + Polish | — | — | ⏸️ | — |
| 5. Beta | — | — | ⏸️ | — |
| 6. Cutover | — | — | ⏸️ | — |

---

## 📝 각 Phase 종료 시 기록할 것 (tasks/lessons.md)
- 실제 소요 시간 vs 예상 (분산 확인)
- 예상 못한 기술 이슈 (예: Next.js SSR + data-attr race)
- reference와 실구현 gap (있으면 이유 기록)
- 다음 Phase 준비사항
