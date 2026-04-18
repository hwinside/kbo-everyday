# 크보팬 Design V2 Migration Spec

> 상태: Draft (v0.2 — 삼순이 피드백 반영)
> 작성: 2026-04-19 삼식이
> 원문 디자인: Claude Design (2026-04-19 새벽 시안 — 중립/LG/두산/삼성 4종 + My 페이지)
> 리뷰: 삼식이(CTO) + 삼순이(CSO) + 하린아빠(OK 2026-04-19 04:41)
> 베이스: `specs/design-tokens-v0.md`, `specs/design-system/spec.md`

> 변경이력
> - v0.1 (04:41): 최초 초안
> - v0.2 (04:45): 삼순이 피드백 3종 반영 — 범위 고정·베타 코호트 구체화·KPI 가드
> - v0.3 (04:47): 베타 코호트에 하위권 팀 팬 편향 보정 추가 (삼순이 추가 지적)
> - v0.4 (04:55): Claude Design 원본 ZIP 수령 → `specs/design-v2-reference/` 시각 기준 SSOT 고정

---

## 1. 목적

크보팬 앱의 디자인 시스템을 V2로 교체한다. 핵심 전환은 *"내 팀 컬러가 앱을 물들이는"* 아이덴티티 몰입 경험과 중립팬/다팀 포용 fallback의 양립이다.

### Why now
- 유저 피드백: "예쁘긴 한데 크보답지 않다", "내 팀 느낌이 약하다"
- 마케팅 ₩5M Meta 집행 중 — V2 확정 후 광고 크리에이티브도 V2로 통일 필요
- 베타 유저 커뮤니티 급성장 (WAU 10,333 / MAU 10,386) — 지금이 "디자인 변경 감내 가능" 마지막 윈도우

---

## 2. 범위 (Scope)

### In scope (🔒 FROZEN — V2 1차)
- *디자인 토큰* V2 확장 (팀 컬러 테마 10개 + 중립 테마 = KBO 블루 계열)
- *공통 프리미티브 18종*:
  - 기본 12종: Button (variant 5: primary/primary-hero/weak/ghost/underline), Card, Stat, Badge (emphasis 3: primary/secondary/muted), ChipTabs, UnderlineTabs, Chip, TeamLogo, Diamond, Pips, ScoreCard, WinProbabilityBar
  - 모달 6종 (공통 UI 인프라): ModalSheet, ToastStack, ContextMenu, TeamPickerModal, ComposerModal, CommentSheetModal
- *AdSlot 프리미티브 + 토큰* (자리만 설계, 후일 연동)
- *페이지 5종* V2: 홈 (내 팀 중심) / 경기 상세 / 순위 / 커뮤니티 / My (야구 앱 My 범위)
- *테마 컨텍스트* (내 팀 기반 자동 적용 + 중립 fallback)
- *Feature Flag*: URL 파라미터 `?v2=1` + profile flag `design_version`
- *TabBar*: 5탭 (`홈 · 경기 · 순위 · 커뮤 · My`) — 홈 = 내 팀 중심, 경기 = 전체 스케줄

### 디자인 상위 원칙 4개 (🔒 Phase 1 가드레일, 삼순이 05:36)
1. *정보 위계 정리* — 화면당 강조 1개만 제일 세게. 나머지는 한 단계 톤다운
2. *CTA 선명화* — 첫 진입 시 "눈 닿을 것"이 즐쇄성 하나
3. *순위/커뮤니티 밀도 완화* — 포털 느낌 방지
4. *선수 상세 해석 보조* — 숫자만 도출하는 안 놓기

### Out of scope (V2 1차에서 절대 손대지 않음)

*1) 신규 기능 7종 NO-GO* (삼순이 05:37, 05:40 재확인)
- DM/메시지
- 팔로우 시스템
- 친구 초대
- 뉴스 페이지
- 티켓팅
- 구장 정보
- 선수 Radar Chart (range creep 우려로 제외)

*2) 레벨 시스템 표시 비활성화* — V1 실구현 없으면 V2도 미표시 (초반 포털화 방지)

*3) 포털화 요소 제거*
- My 페이지: 소셜 앱 스타일 NO — "야구 앱 My" 범위만
- 커뮤니티 레벨·태그 동시 강조 NO
- 선수 Radar Chart NO

*4) 기타*
- 관리자(/admin) V2화
- 선수 프로필 페이지 재설계 (이미 Hero Phase 1 완료 — V2 토큰으로 스타일링만)
- 선수 커뮤니티 페이지 V2화
- 라이브 채팅 UI 재설계 (현 UI 유지)
- 온보딩/로그인 플로우 개편
- 이메일/알림 템플릿 V2화
- 기술 스택 변경 (Next.js, Supabase, Tailwind 유지)

### Scope creep 차단 룰
범위 확장 요청 시 *무조건 V2 GA 이후로 미룸*. 예외는 보안/크래시 P0 핫픽스뿐. "이왕 고치는 김에" 금지.

---

## 3. 기술 구조 (Architecture)

### 3.1 저장소
*동일 repo, 브랜치 + 폴더 분리* (별도 repo NO — 드리프트 리스크).

```
kbo-everyday/
├─ src/
│  ├─ app/                    ← V1 (현행)
│  ├─ app/(v2)/               ← V2 route group (hidden until GA)
│  ├─ components/             ← V1 컴포넌트
│  ├─ components/v2/          ← V2 컴포넌트
│  ├─ design-v2/
│  │  ├─ tokens.css           ← 확장 토큰 (team themes)
│  │  ├─ theme-provider.tsx   ← 팀 컨텍스트
│  │  └─ primitives/          ← Button/Card/Stat 등
│  └─ lib/feature-flags/      ← v2 플래그 helper
```

### 3.2 Feature Flag
- *URL*: `?v2=1` → 쿠키 `kbo-design=v2` 30일 저장 (QA/베타 접근)
- *Profile*: `profiles.design_version` enum (`v1` | `v2`, 기본 `v1`)
- *관리자 토글*: `/admin`에서 유저 cohort 선택적 v2 노출 (GA 전환용)

### 3.3 테마 시스템
CSS 변수 기반 팀 테마 — `<html data-team="LG">` 속성으로 스코프.

```css
[data-team="LG"]      { --team-primary: #C4003F; --team-secondary: #000; ... }
[data-team="DOOSAN"]  { --team-primary: #131230; --team-secondary: #ED1C24; ... }
[data-team="SAMSUNG"] { --team-primary: #0066B3; --team-secondary: #FFFFFF; ... }
[data-team="NEUTRAL"] { --team-primary: #FF453A; --team-secondary: #141416; ... } /* 기본 크보팬 브랜드 10~15% 존재감 유지 */
```

`ThemeProvider`가 profile의 favorite_team을 읽어 자동 적용. 없으면 `NEUTRAL`.

---

## 4. 마이그레이션 플랜 (6주)

### Phase 1: Foundation (1주차)
- [ ] `design-v2/tokens.css` — 팀 컬러 11종(10팀+중립) + spacing/typography 토큰
- [ ] `ThemeProvider` + `useTeamTheme()` hook
- [ ] 공통 컴포넌트 V2 (primitives 8종: Button, Card, Stat, Badge, Tabs, Chip, ScoreCard, WinProbabilityBar)
- [ ] Storybook 또는 `/v2/playground` 라우트로 시각 검증
- *게이트*: 삼순이 디자인 토큰 리뷰 GO

### Phase 2: Home + Game Detail (2주차)
- [ ] `app/(v2)/page.tsx` — 홈 (스코어카드 + 라이브 CTA 4종)
- [ ] `app/(v2)/game/[gameId]/page.tsx` — 경기 상세 (승리확률 + 이닝 스코어보드)
- [ ] V1 API 라우트 그대로 재사용 (zero backend change)
- *게이트*: `?v2=1`로 내부 3명(하린아빠·삼식이·삼순이) 수동 QA

### Phase 3: Standings + Community (3주차)
- [ ] `app/(v2)/standings/page.tsx` — 내 팀 하이라이트 카드(팀팬) / 플랫 리스트(중립)
- [ ] `app/(v2)/community/page.tsx` — 팀 컬러 헤더 + 다른 팀 이동 prominent
- *게이트*: 삼순이 E2E 체크 GO

### Phase 4: My Page + Polish (4주차)
- [ ] `app/(v2)/my/page.tsx` — 배지·레벨·예측적중률
- [ ] 팀별 마이크로 튜닝 (삼성 W/L 뱃지 무채색화, LG 순위카드 채도 조정)
- [ ] 접근성: 저채도 팀(두산/삼성) 텍스트 대비 WCAG AA 검증
- *게이트*: 삼순이 QA 전수 PASS

### Phase 5: Beta (5주차)
- [ ] 관리자 페이지에서 베타 cohort 설정
- [ ] *베타 cohort 구성 (총 15~20명, 의도적 다양성 확보)*:
  - *헤비유저* 5명 (주 5회+ 방문, 커뮤니티 작성 이력)
  - *중립팬/미정팬* 3명 (favorite_team NULL 또는 여러 팀 팔로우)
  - *저사양 기기* 3명 (iPhone SE / 저가 Android, 체감 성능 확인)
  - *비로그인 유저* 3명 (익명 세션, `?v2=1` 쿼리로만 접근)
  - *신규유저* 3명 (가입 1주 이내, 온보딩 맥락 유지된 상태)
  - *하위권 팀 팬* 1~2명 (현재 태탐에 따라 9~10위권, 별도 모집 — *정서적 편향 보정용*: 상위권 팬 만족도 자연승섢 제거)
  - ※ 위 명수는 중복 가능 (예: 하위권 팀 팬 × 저사양 기기 유저 1명은 두 칸 모두 겹이기)
- [ ] 1주간 GA4 이벤트 + 피드백 수집 (KPI는 §6 참조)
- *게이트*: KPI 복합 기준(재방문율·CTA 클릭·오류율) PASS + 코호트별 부정 피드백 ≤ 30%

### Phase 6: Cutover (6주차)
- [ ] 페이지 단위 순차 cutover: 홈 → 경기 상세 → 순위 → 커뮤니티 → My
- [ ] 각 단계별 24h 관측 후 다음 단계. 문제 시 즉시 rollback
- [ ] 전환 완료 후 V1 코드 삭제 + `/v2` prefix 제거
- *게이트*: 하린아빠 최종 OK → push

---

## 5. 리스크 & 완화

| 리스크 | 완화 |
|---|---|
| 드리프트 (V1 핫픽스가 V2에 안 반영) | 동일 repo — 컴포넌트 레이어만 분리, API/DB 공유 |
| 저채도 팀 대비 부족 | Phase 4에서 WCAG AA 자동 체크 스크립트 도입 |
| 중립팬 몰입감 약화 | NEUTRAL 테마에도 브랜드 컬러 10~15% 존재감 (삼순이 지적 반영) |
| 광고 크리에이티브 V1/V2 불일치 | Phase 5 직전 마케팅과 동시 교체 공지 |
| 교체 중 실시간 채팅/라이브 스코어 장애 | V2는 순수 view 레이어. Realtime/API 그대로 재사용 → 장애 격리 |

---

## 6. 성공 기준 (KPI)

> ⚠️ *KPI 해석 가드 (삼순이 지적 반영)*: session length 단독으로는 판단 금지. 길어지는 게 "몰입"일 수도, "헤매고 있음"일 수도 있음. *재방문율 + 핵심 CTA 클릭 + 오류율* 3종을 묶어서 해석.

### 정량 (복합 기준 — 하나라도 실패 시 NO-GO)
- *재방문율 D1/D7*: V1 대비 95%↑ (가장 신뢰도 높은 지표)
- *핵심 CTA 클릭률*: 홈의 "라이브 채팅/승부예측/라인업/하이라이트" 4개 버튼 CTR V1 대비 95%↑
- *오류율 (JS crash + API 4xx/5xx)*: V1 대비 동등 이하
- *DAU*: 현재 641 ±10% 허용
- *`onboarding_complete`* (진짜 가입) 전환율: V1 대비 90%↑
- *Session length*: 참고 지표로만 기록 (해석 주의)

### 정성
- 크보팬 디스코드 베타 유저 positive feedback ≥ 70% (코호트별로 분리 집계)
- 저사양 기기 코호트에서 "느려졌다" 피드백 ≤ 1명
- 비로그인 코호트에서 진입 이탈률 V1 동등 이하
- 하린엄마(QA 테스터) 승인
- 삼순이 최종 QA PASS

---

## 7. Rollback 계획

- *페이지 단위 rollback*: 각 페이지는 V1/V2 병존 상태로 배포 → profile flag 또는 cohort 설정으로 즉시 V1 복귀 가능
- *전역 rollback*: 관리자에서 `design_version='v1'` 강제 적용 → 1분 내 전체 유저 V1 복귀
- *코드 rollback*: V2 코드는 V1을 건드리지 않으므로 해당 커밋 revert만으로 안전

---

## 8. 다음 액션

1. 하린아빠 이 spec 리뷰 → 수정/승인
2. 삼순이 리뷰 (리스크/KPI/베타 cohort 기준)
3. 승인 후 `Plan`(`specs/design-v2-migration-plan.md`) + `Tasks`(`specs/design-v2-migration-tasks.md`) 작성
4. ⏸️ CHECKPOINT — 하린아빠 최종 OK
5. Phase 1 implementation 시작

---

## 9. 참조

### SSOT (Single Source of Truth)
- *문서 SSOT* — 이 파일 (`specs/design-v2-migration.md`)
- *시각 SSOT* — `specs/design-v2-reference/` (Claude Design 원본 JSX/tokens.js/10팀 로고). 구현 중 의문 생길 때 이 폴더가 정답.
  - 로컬 프리뷰: `cd specs/design-v2-reference/redesign && python3 -m http.server 8765` → http://localhost:8765/index.html

### 관련 문서
- `specs/design-tokens-v0.md` — v0 토큰 (베이스)
- `specs/design-system/spec.md` — 기존 컴포넌트 원칙
- `specs/constitution.md` — SDD 원칙
- `wiki/pages/크보팬/` — 페이지별 현행 문서
- 원본 시안: Claude Design 출력 4장 (중립·LG·두산·삼성, 2026-04-19 새벽) + My 페이지 + ZIP export (04:52)
