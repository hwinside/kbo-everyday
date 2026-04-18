# 크보팬 Design V2 Migration — Technical Plan

> 상태: Draft (v0.2)
> 작성: 2026-04-19 삼식이
> 상위 문서: `specs/design-v2-migration.md` (v0.4)
> 시각 SSOT: `specs/design-v2-reference/` ⚠️ *v0 DRAFT* — Claude Design 제작 중
> 선행 리뷰: 삼순이 GO (2026-04-19 04:45)

## 🚧 Provisional / Freeze 원칙 (삼순이 04:59 반영)

해당 문서에서 `[PROVISIONAL]` 태그가 붙은 항목은 *최종 ZIP 도착 후 다시 잠금*해야 하는 영역. 구현을 먼저 시작하면 되돌림 비용 발생.

### Provisional (최종본 도착 전까지 테스트용 placeholder)
- 색상값: 팀별 primary/light/secondary, NEUTRAL 다크 토큰, 중립 accent 머플드 레드
- 간격: padding/margin/radius 수치
- 카피: 섹션 타이틀·라벨·CTA 텍스트
- 우선 화면 구성: 홈 4종 CTA 종류·순서, My 배지 구성

### Frozen (최종본과 무관 — 바로 구현 가능)
- CSS 변수 스코프 충체계 (`data-design="v2"[data-team="..."]`)
- Feature Flag 2중 구조 (URL · cookie · profile flag)
- `profiles.design_version` DB 스키마
- Middleware 라우팅 제어
- WCAG AA 대비 계산 함수 + CI 블로킹
- Rollback 플로 (유저/페이지/전역/코드 4단)
- GA4 `design_version` 파라미터 추가 설계
- 베타 cohort 선정 SQL

### Design Freeze 체크포인트
최종 ZIP 수령 시점에 이 차례로 진행:
1. `specs/design-v2-reference/` 전체 덮어쓰기
2. v0 대비 diff 테이블 작성 (팀 컬러 변경·신규 섹션 등)
3. Plan 문서의 [PROVISIONAL] 태그 모두 해제 또는 반영
4. 삼순이 design-freeze 리뷰 GO
5. 구현 Phase 착수

---

## 0. TL;DR

- *레이어*: CSS 변수 테마 시스템 + React Context + Feature Flag 2중 (URL · profile)
- *저장소 분리 NO, 폴더 분리 YES*: `src/design-v2/` (토큰·프리미티브) + `src/app/(v2)/` (라우트 그룹) + `src/components/v2/` (페이지 섹션)
- *reference → 구현 1:1 매핑*: tokens.js → tokens.css, atoms.jsx → React primitives 7종
- *QA 자동화*: WCAG AA 대비 검사 스크립트 + 10팀 × 상태별 비주얼 리그레션
- *Rollback 단위*: 페이지 1개 단위 (profile flag 토글 1분 내 복귀)

---

## 1. 파일 구조 (target)

```
src/
├─ app/
│  ├─ (main)/              ← V1 기본 라우트 (현행)
│  │   ├─ page.tsx              # 홈 V1
│  │   ├─ game/[gameId]/...
│  │   ├─ standings/...
│  │   ├─ community/...
│  │   └─ my/...
│  └─ (v2)/                 ← V2 route group (hidden by feature flag)
│      ├─ layout.tsx             # V2 ThemeProvider wrap
│      ├─ page.tsx               # 홈 V2
│      ├─ game/[gameId]/
│      │   ├─ page.tsx           # 경기 상세 V2 (preview/live/lineup/timeline/chat/predict 통합)
│      │   └─ _tabs/             # ChipTabs sub-components
│      ├─ standings/page.tsx
│      ├─ community/
│      │   ├─ page.tsx           # 커뮤니티 홈
│      │   └─ [board]/page.tsx   # 보드 상세
│      └─ my/page.tsx
├─ design-v2/
│  ├─ tokens.css                  ← 10팀 + NEUTRAL 변수
│  ├─ theme-provider.tsx          ← <ThemeProvider team={slug}> + useTeamTheme()
│  ├─ team-palette.ts             ← tokens.js의 teamPalette() 헬퍼 TS 포팅
│  ├─ primitives/
│  │   ├─ Button.tsx              ← 4 variants (primary/weak/ghost/underline)
│  │   ├─ Card.tsx                ← cardTint 배경 자동
│  │   ├─ Stat.tsx                ← tabular-nums + right-align
│  │   ├─ Badge.tsx               ← W/L/LIVE/HR 등 상태 뱃지
│  │   ├─ ChipTabs.tsx            ← 경기 상세 탭 전환
│  │   ├─ UnderlineTabs.tsx       ← 홈/커뮤니티 상단 탭
│  │   ├─ Chip.tsx                ← 팀 칩 / 필터 칩
│  │   ├─ ScoreCard.tsx           ← 홈/경기 라이브 스코어
│  │   ├─ WinProbabilityBar.tsx   ← 승리확률 게이지
│  │   ├─ TeamLogo.tsx            ← next/image 기반 (reference의 dangerouslySetInnerHTML 대신)
│  │   ├─ Diamond.tsx             ← 베이스러너 아이콘
│  │   └─ Pips.tsx                ← B/S/O dots
│  └─ playground/
│      └─ page.tsx                ← /v2/playground — 모든 primitive + 10팀 preview (dev 전용)
├─ components/
│  ├─ (V1 기존)
│  └─ v2/                    ← 페이지-특정 섹션 (primitive 조합)
│      ├─ home/HeroScoreCard.tsx
│      ├─ home/LiveCtaGrid.tsx
│      ├─ game/GameHeader.tsx
│      ├─ game/GamePreviewTab.tsx
│      ├─ game/GameLiveTab.tsx
│      ├─ game/GameLineupTab.tsx
│      ├─ game/GameTimelineTab.tsx
│      ├─ game/GameChatTab.tsx
│      ├─ game/GamePredictTab.tsx
│      ├─ standings/MyTeamCard.tsx
│      ├─ standings/NeutralList.tsx
│      ├─ community/CommunityHome.tsx
│      ├─ community/BoardHeader.tsx
│      └─ my/ProfileCard.tsx
└─ lib/
   ├─ feature-flags/
   │   ├─ design-version.ts         ← getDesignVersion() — cookie + profile 조합
   │   └─ middleware.ts             ← Next.js middleware: /v2/* 접근 제어
   └─ design-v2/
       ├─ contrast.ts                ← WCAG AA 대비 계산 (luminance based)
       └─ team-mapping.ts            ← DB team_id → slug 매핑
```

*주의*: `src/app/(main)/` 로 V1을 감싸는 route group 마이그레이션은 Phase 6에서. 지금 Phase 1~5는 V1이 route group 없이 `src/app/` 루트에 있는 현재 상태 유지.

---

## 2. CSS 변수 테마 시스템

### 2.1 스코프 전략

HTML 속성 기반 — 서버 렌더링 친화적, 전환 시 re-render 불필요.

```html
<html data-team="lg" data-design="v2">
```

- `data-design="v1"` — V1 (기본)
- `data-design="v2"` — V2
- `data-team="lg|doosan|kt|ssg|nc|kia|lotte|samsung|hanwha|kiwoom|neutral"` — V2에서만 사용

### 2.2 tokens.css 구조 `[PROVISIONAL]` — 값은 v0 ZIP 기준

```css
/* -- Neutral 다크 기본 (V2 전체 공통) -- */
[data-design="v2"] {
  --bg-0: #07070A;
  --bg-1: #0E0E12;
  --bg-2: #15151B;
  --bg-3: #1D1D24;
  --line: rgba(255,255,255,0.07);
  --line-strong: rgba(255,255,255,0.14);
  --text-1: rgba(255,255,255,0.96);
  --text-2: rgba(255,255,255,0.68);
  --text-3: rgba(255,255,255,0.44);
  --text-4: rgba(255,255,255,0.28);
  --color-live: #FF453A;
  --color-win: #30D158;
  --color-warn: #FFD60A;
}

/* -- 팀별 accent (10팀 + NEUTRAL) -- */
[data-team="lg"]      { --team-primary: #C60C30; --team-light: #E04050; --team-secondary: #1D1D1B; }
[data-team="doosan"]  { --team-primary: #131230; --team-light: #9BA8D4; --team-secondary: #ED1C24; }
/* ... 나머지 8팀 동일 패턴 */
[data-team="neutral"] { --team-primary: #6E6E73; --team-light: #A8A8AD; --team-accent: #E03A3A; }

/* -- 파생 토큰 (teamPalette 결과 주입) -- */
/* JS에서 <html>의 style에 inline으로 주입 (저채도 팀 자동 보정 때문) */
/* --team-accent, --team-accent-soft, --team-accent-border, --team-on-accent, --team-hero-bg-a, --team-hero-bg-b, --team-card-tint, --team-ambient */
```

### 2.3 ThemeProvider (React)

```tsx
// src/design-v2/theme-provider.tsx
'use client';

export function ThemeProvider({ teamSlug, children }: Props) {
  useEffect(() => {
    const team = TEAMS[teamSlug] ?? TEAMS.neutral;
    const palette = teamPalette(team, 10); // intensity 기본 10
    const root = document.documentElement;
    root.dataset.team = teamSlug;
    root.dataset.design = 'v2';
    root.style.setProperty('--team-accent', palette.accent);
    root.style.setProperty('--team-accent-soft', palette.accentSoft);
    root.style.setProperty('--team-accent-border', palette.accentBorder);
    root.style.setProperty('--team-on-accent', palette.onAccent);
    root.style.setProperty('--team-hero-bg-a', palette.heroBgA);
    root.style.setProperty('--team-hero-bg-b', palette.heroBgB);
    root.style.setProperty('--team-card-tint', palette.cardTint);
    root.style.setProperty('--team-ambient', palette.ambient);
    return () => { delete root.dataset.team; delete root.dataset.design; };
  }, [teamSlug]);
  return <>{children}</>;
}

export function useTeamTheme() {
  const { team } = useAuthContext(); // 기존 AuthContext의 favorite_team
  return team?.slug ?? 'neutral';
}
```

### 2.4 FOUC 방지

- SSR 시 cookie 읽어서 `<html data-team="...">` 서버에서 세팅
- `next/script` with `beforeInteractive`로 inline JS 한 번 더 확인 (cookie 없을 때 neutral fallback)

---

## 3. Feature Flag 라우팅

### 3.1 진입 조건 (우선순위)

1. URL `?v2=1` → 쿠키 `kbo-design=v2` (30일) + 자동 리다이렉트 제거
2. `profiles.design_version = 'v2'` (DB)
3. `kbo-design=v2` 쿠키 (이전 방문자)
4. 기본: v1

### 3.2 Middleware

```ts
// src/middleware.ts (기존 middleware 확장)
import { NextRequest, NextResponse } from 'next/server';

export function middleware(req: NextRequest) {
  const url = req.nextUrl;

  // 1) ?v2=1 쿠키 세팅
  if (url.searchParams.get('v2') === '1') {
    const res = NextResponse.redirect(new URL(url.pathname, url));
    res.cookies.set('kbo-design', 'v2', { maxAge: 60 * 60 * 24 * 30 });
    return res;
  }
  if (url.searchParams.get('v2') === '0') {
    const res = NextResponse.redirect(new URL(url.pathname, url));
    res.cookies.delete('kbo-design');
    return res;
  }

  // 2) /v2/* 접근 시 flag 없으면 루트로
  if (url.pathname.startsWith('/v2/')) {
    const flag = req.cookies.get('kbo-design')?.value;
    if (flag !== 'v2') {
      return NextResponse.redirect(new URL(url.pathname.replace(/^\/v2/, ''), url));
    }
  }

  // 3) DB flag 기반 자동 전환은 클라이언트에서 처리 (AuthContext 로드 후)
  return NextResponse.next();
}
```

### 3.3 DB 스키마

```sql
ALTER TABLE profiles ADD COLUMN design_version TEXT DEFAULT 'v1' CHECK (design_version IN ('v1', 'v2'));
CREATE INDEX profiles_design_version_idx ON profiles (design_version);
```

Admin 페이지에서 cohort 일괄 업데이트용 SQL:
```sql
UPDATE profiles SET design_version = 'v2' WHERE id IN (...);
```

---

## 4. 프리미티브 컴포넌트 API

reference의 JSX를 1:1로 React 컴포넌트로 포팅. *시그니처는 reference 키와 최대한 동일*.

```tsx
// Button: reference에 명시적 없음 → 크보팬 디자인 원칙 v0에서 가져옴
<Button variant="primary" size="md">라이브 채팅</Button>
// variants: primary (filled, CTA) | weak (tinted) | ghost (border) | underline

// ScoreCard: reference의 ScreenGameLive 스코어 영역 추출
<ScoreCard
  home={{ team, score: 4 }}
  away={{ team, score: 2 }}
  status="live"          // live | final | scheduled
  inning="5회초"
  outs={2}
  balls={1}
  strikes={2}
  runners={{ r1: true, r2: false, r3: true }}
/>

// WinProbabilityBar
<WinProbabilityBar
  home={{ team, probability: 0.68 }}
  away={{ team, probability: 0.32 }}
/>
// 큰 숫자는 승리 팀 쪽에만. 지는 팀은 작게.

// ChipTabs: 경기 상세 탭 (preview/live/lineup/timeline/chat/predict)
<ChipTabs
  tabs={[{ key: 'preview', label: '프리뷰' }, ...]}
  active="live"
  onChange={(k) => ...}
/>

// Diamond (베이스러너)
<Diamond r1={true} r2={false} r3={true} size={44} />

// Pips (B/S/O dots)
<Pips filled={2} total={3} color="var(--color-warn)" />
```

---

## 5. 팀별 대비/가독성 QA 체크리스트 🎨

> *삼순이 요청 반영* — 색상 미세조정 이슈 반복 방지.
> Phase 1 프리미티브 완성 직후 전수 검사, 매 Phase 끝에 재검사.

### 5.1 자동 검사 (스크립트)

`scripts/check-design-contrast.ts`:
```ts
// 10팀 × 배경 3종 × 텍스트/버튼 4종 = 120케이스 WCAG 대비 계산
// 기준: AA (4.5:1), AAA (7:1)
// 실패 시 exit 1 → CI에서 블로킹
```

### 5.2 수동 체크리스트 (10팀 × 페이지별)

각 팀 × 페이지에서 확인:

| 체크 항목 | LG | 두산 | KT | SSG | NC | KIA | 롯데 | 삼성 | 한화 | 키움 | 중립 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 홈 히어로 스코어 숫자 가독성 | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| CTA 버튼 onAccent 텍스트 대비 AA↑ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| 승리확률 바 색상 구분 (두 팀 동시 표시) | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| 순위표 W/L 뱃지 vs 팀 카드 배경 | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| 커뮤니티 헤더 타이틀 텍스트 AA↑ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| 다크모드 전환 시 토큰 일관성 | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |

### 5.3 저채도 팀 특별 관리

- *두산 (#131230)*, *KT (#1A1A1A)*, *KIA secondary (#07101E)*, *롯데 (#002856)*, *키움 (#820024)*
- `teamPalette()`가 luminance<0.22 자동 보정하지만, *CTA 배경에 쓰일 때 white 텍스트 대비*는 별도 확인
- 폴백 룰: primary 텍스트용 대비 실패 시 `light` 값 사용 (이미 `onDarkColor()` 구현됨)

### 5.4 아이콘/로고 특별 관리

- 중립 테마에서 팀 로고 단색화 시 `grayscale(1)` + 80% opacity
- LG/KIA 흰 배경 로고는 원형 컨테이너 `#fff` padding 3px (reference TeamLogo)
- 두산/롯데 검정 배경 로고는 `padding 0` (로고 자체가 꽉 참)

---

## 6. Beta Cohort 운영

### 6.1 Cohort 선정 SQL

```sql
-- 헤비유저 5명 (주 5회+ 방문)
SELECT id FROM profiles p
JOIN (SELECT user_id, COUNT(DISTINCT DATE(created_at)) as days
      FROM user_sessions WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY user_id HAVING COUNT(...) >= 5) s ON p.id = s.user_id
LIMIT 5;

-- 중립팬/미정팬 3명
SELECT id FROM profiles WHERE favorite_team_id IS NULL LIMIT 3;

-- 하위권 팀 팬 1~2명 (9~10위권 팀)
SELECT id FROM profiles WHERE favorite_team_id IN (
  SELECT team_id FROM standings WHERE rank >= 9
) LIMIT 2;

-- 저사양/비로그인/신규는 수동 모집 (디스코드 자원자)
```

### 6.2 모니터링 대시보드

`/admin/design-v2-cohort`:
- 실시간: 각 cohort 유저별 `onboarding_complete`, 세션 수, 에러 수
- 일별: 재방문율 D1/D7, 홈 CTA 4개 CTR, JS crash 수, API error rate
- 피드백: 디스코드 투표 결과 + 직접 메시지 기록

---

## 7. 구현 순서 (Phase 별 기술 세부)

### Phase 1: Foundation (1주차)
1. `src/design-v2/tokens.css` 작성 — 10팀 + NEUTRAL
2. `src/design-v2/team-palette.ts` — reference tokens.js TS 포팅 (mix/withAlpha/luminance/teamPalette)
3. `src/design-v2/theme-provider.tsx` — ThemeProvider + useTeamTheme
4. Primitive 12종 구현 (§4 참조)
5. `src/design-v2/playground/page.tsx` — 10팀 × 모든 primitive 렌더링
6. `scripts/check-design-contrast.ts` — WCAG AA 자동 검사
7. `public/team-logos/` — reference logos/*.svg 10개 복사
8. `src/lib/feature-flags/design-version.ts` + middleware 확장
9. DB 마이그레이션 `profiles.design_version` 컬럼

### Phase 2: Home + Game Detail (2주차)
1. `src/app/(v2)/layout.tsx` — ThemeProvider wrap
2. `src/app/(v2)/page.tsx` — 홈 (ScreenGameSchedule + 라이브 하이라이트 CTA 4종)
3. `src/app/(v2)/game/[gameId]/page.tsx` — 경기 상세 (ChipTabs로 6탭 통합)
4. V1 API 재사용: `/api/games`, `/api/games/[id]`, `/api/lineup-analysis`, `/api/daily-analysis`, Realtime `game_chat_messages`
5. QA: 3명 내부 `?v2=1` 수동 테스트

### Phase 3: Standings + Community (3주차)
1. `src/app/(v2)/standings/page.tsx` — MyTeamCard + NeutralList 조건부
2. `src/app/(v2)/community/page.tsx` — BoardHeader 팀 컬러 + 다른 팀 이동 prominent
3. `src/app/(v2)/community/[board]/page.tsx` — 보드 상세
4. QA: 삼순이 E2E + Playwright

### Phase 4: My + Polish (4주차)
1. `src/app/(v2)/my/page.tsx` — 배지·레벨·예측적중률
2. 10팀 × 6 페이지 전수 QA (§5.2 체크리스트)
3. 저채도 팀 CTA 배경 텍스트 대비 AA↑ 재검증
4. Animation polish (transition, reduced-motion 존중)

### Phase 5: Beta (5주차)
1. Admin `/admin/design-v2-cohort` 구축
2. Cohort 15~20명 `design_version='v2'` 업데이트
3. GA4 이벤트 확장: `design_version` 파라미터 추가 발화
4. 1주 모니터링

### Phase 6: Cutover (6주차)
1. 페이지 단위 순차 교체: `/page.tsx`가 feature flag 보고 V1 or V2 컴포넌트 렌더
2. 홈 → 경기 상세 → 순위 → 커뮤니티 → My (24h 간격)
3. GA 24h 후 `kbo-design` 쿠키 default v2 전환
4. 1주 후 V1 코드 삭제 + `/v2` prefix 제거 + route group 정리

---

## 8. Rollback 플로우

### 8.1 유저 단위 (1분)
Admin에서 `UPDATE profiles SET design_version = 'v1' WHERE id = ?` → 다음 navigation 시 V1

### 8.2 페이지 단위 (5분)
예: 홈 V2가 문제 → feature flag를 `page-level` 쿠키로 확장. `kbo-design-home=v1` 추가 → 해당 페이지만 V1

### 8.3 전역 (배포 1회)
관리자 설정 `DESIGN_V2_ENABLED=false` env → middleware가 /v2/* 전체 차단, cookie 무시

### 8.4 코드 단위
V2 코드는 V1 미침범 → 해당 커밋 revert로 안전 (main 브랜치 PR 단위)

---

## 9. 관측 & 메트릭

### 9.1 GA4 이벤트 확장

기존 이벤트에 `design_version` 파라미터 추가:
- `page_view` → `design_version`
- `onboarding_complete` → `design_version`
- `game_cta_click` (신규) → `{cta: 'live_chat'|'predict'|'lineup'|'highlight', design_version}`

### 9.2 주간 리포트

Phase 5~6 중 매주 월요일 #marketing 스레드에 자동 포스트:
- DAU V1/V2 분리
- D1/D7 재방문율 V1 vs V2
- CTA CTR V1 vs V2
- 에러율 V1 vs V2 (Sentry 연동)
- 베타 피드백 요약

---

## 10. 리스크 핸들링

| 리스크 | 감지 | 대응 |
|---|---|---|
| V2 CSS 변수가 V1로 새어나감 | Chrome DevTools 자동 감사 | `data-design="v2"` 스코프 엄수, `:where()` 사용 |
| 저채도 팀 CTA 대비 AA 미달 | `check-design-contrast.ts` CI | `palette.onAccent` 자동 `#fff`/`#000` 전환 로직 재검증 |
| Realtime 채팅이 V1/V2 병존 시 장애 | Sentry JS error monitoring | useChat 훅 변경 없음 원칙 엄수 (훅은 V1 공유) |
| Feature flag middleware 성능 | Vercel edge function cold start | middleware 토큰 검사만, DB 호출 없음 |
| 쿠키 만료 후 갑작스런 V1 복귀 | GA4 `design_version` 변화 모니터링 | 만료 전 재설정, 또는 profile flag 우선 |

---

## 11. 오픈 질문

1. 베타 cohort 선정 시 *옵트인(디스코드 모집) vs 옵트아웃(자동 배정 후 opt-out 링크)* 어느 쪽? — CS 부담 vs cohort 품질 트레이드오프
2. V2 전환 시 *onboarding re-tour*를 보여줄 것인가? — 중립팬의 "뭐가 바뀐지 모름" 방지 vs 시끄러움
3. Phase 6 cutover 후 *V1 코드 유지 기간*은 몇 주? (롤백 안전망 vs 코드 정리) — 제안: 2주
4. `design_version` GA4 파라미터가 *기존 custom dimension 한도* 초과 안 하는지 확인 필요

---

## 12. 승인 게이트

- [ ] 이 Plan 삼순이 리뷰 → GO
- [ ] 하린아빠 최종 OK
- [ ] Tasks 문서로 분해 (`specs/design-v2-migration-tasks.md`)
- [ ] ⏸️ CHECKPOINT
- [ ] Phase 1 착수
