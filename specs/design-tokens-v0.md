# Design Tokens v0 — 크보팬 심미 개선 가이드

> 출처: #design 채널 리뷰 (2026-03-06)
> 상태: v0 — 최소 세트, 추후 팀컬러/상태색 확장 가능

## 핵심 원칙 3가지

1. **Primary filled는 CTA 1개만.** 나머지 활성은 `primary weak` 또는 underline.
2. **탭=UnderlineTabs / 필터=Segmented / 2차=Chip** (교차 사용 금지)
3. **숫자는 tabular-nums + right-align** (테이블/기록/세이버 공통)

---

## 1. `:root` 확장안

```css
:root {
  /* existing */
  --bg-primary: #0A0A0B;
  --bg-secondary: #141416;
  --bg-tertiary: #1C1C1F;
  --text-primary: #F5F5F7;
  --text-secondary: #8E8E93;
  --text-tertiary: #636366;
  --accent: #FF453A;
  --border: rgba(255,255,255,0.08);

  /* v0 semantic aliases */
  --bg: var(--bg-primary);
  --surface-1: #111114;           /* 카드 기본 */
  --surface-2: #15151A;           /* hover/강조 카드 */

  --text-1: rgba(255,255,255,0.92);
  --text-2: rgba(255,255,255,0.72);
  --text-3: rgba(255,255,255,0.52);

  --primary: var(--accent);
  --primary-strong: #E63B31;       /* pressed/강조 */
  --primary-weak-bg: rgba(255,69,58,0.14);
  --primary-weak-border: rgba(255,69,58,0.30);

  --border-weak: var(--border);
  --border-strong: rgba(255,255,255,0.12);

  /* control backgrounds */
  --control-bg: rgba(255,255,255,0.04);   /* 비활성 pill 배경 */
  --control-bg-active: var(--primary-weak-bg);

  /* radii */
  --radius-card: 16px;
  --radius-control: 9999px;

  /* focus */
  --focus-ring: rgba(255,69,58,0.35);
}
```

## 2. `@theme inline` 매핑

```css
@theme inline {
  --color-bg: var(--bg);
  --color-surface-1: var(--surface-1);
  --color-surface-2: var(--surface-2);

  --color-text-1: var(--text-1);
  --color-text-2: var(--text-2);
  --color-text-3: var(--text-3);

  --color-primary: var(--primary);
  --color-primary-strong: var(--primary-strong);
  --color-primary-weak-bg: var(--primary-weak-bg);
  --color-primary-weak-border: var(--primary-weak-border);

  --color-border: var(--border-weak);
  --color-border-strong: var(--border-strong);
  --color-control: var(--control-bg);

  --radius-card: var(--radius-card);
  --radius-control: var(--radius-control);
}
```

## 3. 컴포넌트 3종 스펙

### A) SegmentedControl (필터/시즌 선택)

- 원칙: 활성=primary weak, 비활성=control bg + border
- 높이: 28~32 고정

```
wrapper:  inline-flex p-1 rounded-[--radius-control] bg-[--color-control] border border-[--color-border]
item(base):     h-8 px-3 rounded-[--radius-control] text-sm font-medium text-[--color-text-2]
item(active):   bg-[--color-primary-weak-bg] text-[--color-text-1] border border-[--color-primary-weak-border]
item(inactive): bg-transparent hover:bg-white/5
```

### B) UnderlineTabs (섹션 전환: 기본정보/위키/최신/인기)

- 원칙: 활성=underline + text-1, 나머지=text-3

```
list:           flex gap-4 border-b border-[--color-border]
tab(base):      py-3 text-sm font-medium text-[--color-text-3] border-b-2 border-transparent
tab(active):    text-[--color-text-1] border-[--color-primary]
tab(inactive):  hover:text-[--color-text-2]
```

### C) Chip (2차 칩: 구단 등)

- 원칙: 뉴트럴 활성 (team color/primary 배제)
- 예외: "전역 필터" 칩만 primary weak 허용

```
chip(base):     h-8 px-3 rounded-[--radius-control] text-sm border border-[--color-border] text-[--color-text-2] bg-transparent
chip(active):   bg-zinc-800 text-[--color-text-1] border-zinc-700
chip(inactive): hover:bg-white/5
```

## 4. Typography Scale

| Role           | Size | Line-height | Weight | Color     |
|----------------|------|-------------|--------|-----------|
| Page title     | 24   | 32          | 600    | text-1    |
| Section heading| 18   | 26          | 600    | text-1    |
| Card title     | 14-15| 22          | 500    | text-1    |
| Body           | 14   | 22          | 400    | text-2    |
| Meta           | 12   | 18          | 400    | text-3    |

숫자 영역: 무조건 `tabular-nums` + 가능하면 `text-right`

## 5. Spacing Scale (8pt)

| Token    | Value |
|----------|-------|
| space-1  | 4     |
| space-2  | 8     |
| space-3  | 12    |
| space-4  | 16    |
| space-6  | 24    |
| space-8  | 32    |

- 섹션 간: 24~32
- 카드 내부 패딩: 12~16
- 리스트 아이템 간: 8~12

---

## 개선 우선순위 (P0 → P1 → P2)

### P0 — 바로 체감

1. **하단 고정 배너** → sticky 해제 or 상단 슬림 배너 + dismiss TTL
2. **선수 사진 fallback** → 이니셜/실루엣 + ring-white/10
3. **선수 상세 섹션 구분** → 카드화 + 헤딩 계층 + 디바이더
4. **순위 테이블 숫자** → right-align + tabular-nums
5. **탭/필터 스타일 2타입 표준화**

### P1 — 완성도

- 팀컬러 일관성 (CSS 변수 전체 적용)
- 경기 날짜 UI 대비 (요일/날짜 타이포 분리)
- 뉴스 태그 이미지 위 가독성 (backdrop-blur)
- 하이라이트 썸네일 텍스트 줄임
- 2차 칩 흰 filled → 뉴트럴로 변경
- 비활성 pill 대비 상향 (bg-white/4)

### P2 — 마감 디테일

- 하단 탭바 active=filled 아이콘
- 커뮤니티 구단명 텍스트 색 통일
- 레이더 차트 gradient/opacity
- 폰트 사이즈 계층 전체 점검
- 선수 카드 #0 번호 숨김 처리

---

## 순위 페이지 특별 개선

- 시즌 필터 → 드롭다운(`2025 ▾`)으로 변경 (안 B)
- 카테고리 탭만 pill로 유지
- 비활성 pill: border 0.08→0.12 + bg-white/4
- 테이블: 숫자 right-align + tabular-nums (헤더 포함)
- 2026 empty state: 이모지 축소 + 날짜 text-xs

## 선수 목록 특별 개선

- 1차 필터 → UnderlineTabs or Segmented (강)
- 2차 칩 → Chip 뉴트럴 (중)
- 정렬 → text 버튼 (약)
- 리스트 row: 아바타 40/44 고정 + 행 높이 py-3 통일
- placeholder: surface-1보다 한 톤 밝게 + ring

## 선수 상세 특별 개선

- 탭 → UnderlineTabs 통일 (높이 44 고정)
- 기록/세이버 그리드: 셀 bg-white/4 + tabular-nums
- CTA만 primary filled, 나머지 전부 weak/neutral
- 태그: bg-white/4 text-zinc-300 (중립)
- 시즌 선택(2025/2026): Segmented로 통일 (탭 아님)

---

## 화면별 컴포넌트/토큰 매핑표

### A. 홈

| 영역 | 권장 컴포넌트 | 색/토큰 규칙 | 메모 |
|------|------------|-----------|------|
| 섹션 헤딩(뉴스/하이라이트/최애) | Typography 스케일 | h2=18/26 600, meta=12/18 text-3 | "flat" 해소 1순위 |
| 뉴스/하이라이트 카드 | Card 규격 | surface-1, border 통일 | 카드 패딩/갭 8pt 고정 |
| 태그/배지(이미지 위) | Chip(중립) 또는 Badge | bg-black/40 + blur or control-bg | 이미지 위 가독성 확보 |
| 하단 탭바 | Nav | 활성은 텍스트/아이콘만 primary, filled 금지 권장 | "화면당 빨간 filled 1개" 유지에 중요 |

### B. 경기

| 영역 | 권장 컴포넌트 | 색/토큰 규칙 | 메모 |
|------|------------|-----------|------|
| 날짜 선택 바 | SegmentedControl(또는 전용 DateStrip) | 활성=primary-weak, 오늘 인디케이터는 primary | "오늘"만 강하게, 나머지는 약하게 |
| Empty state / D-day 카드 | Card + Typography | 일러스트/이모지는 과하지 않게 | 정보 위계: D-day > 설명 > 날짜 |

### C. 순위

| 영역 | 권장 컴포넌트 | 색/토큰 규칙 | 메모 |
|------|------------|-----------|------|
| 시즌 선택 | Dropdown(안 B) | 텍스트 버튼 + control-bg | 탭과 계층 분리 |
| 구단/타자/투수 | SegmentedControl | 활성은 primary-weak 또는 (여기만) filled 허용 | 단, 홈/CTA와 동시 노출 시 weak 권장 |
| 구단 순위 테이블 | Table | 숫자: text-right tabular-nums, 헤더 정렬 동일 | 미감/가독성 즉시 개선 |
| 타자/투수 TOP5 | List 카드 | 숫자 폭 고정 + tabular | "표" 느낌으로 정렬 |

### D. 선수 목록

| 영역 | 권장 컴포넌트 | 색/토큰 규칙 | 메모 |
|------|------------|-----------|------|
| 1차(전체/구단별/포지션별) | UnderlineTabs(추천) | underline=primary, 나머지 중립 | 1차를 "탭"으로 선언 |
| 2차(구단 칩) | Chip(뉴트럴 활성) | 활성=zinc-800, 비활성=border | 팀컬러와 충돌 최소화 |
| 정렬(가나다/게시글/직관) | Text button group(약) | 활성은 text-1 + 작은 dot/underline | "가장 약한" 레벨 |
| 리스트 row | ListItem 규격 | 아바타 ring, 숫자 tabular/right | 684명 화면 완성도 좌우 |

### E. 선수 상세

| 영역 | 권장 컴포넌트 | 색/토큰 규칙 | 메모 |
|------|------------|-----------|------|
| 상단 탭(기본/위키/최신/인기) | UnderlineTabs | 활성 underline=primary | 탭 규칙 고정 |
| 해시태그 | Chip(중립) | primary 사용 최소화 | 태그는 정보, CTA가 아님 |
| 응원가 CTA | Button primary filled (유일한 강빨강) | primary filled | 이 화면의 "유일한" 강한 빨강 |
| 시즌(2025/2026) | SegmentedControl | primary-weak | CTA와 경쟁 금지 |
| 기록/세이버 그리드 | StatCard 규격 | surface + border + tabular | 숫자 정렬은 필수 |

---

## 빨강 사용처 리스트

### ✅ 유지 (Primary filled = 화면의 주인공)

- **주요 CTA 버튼**: "응원가 같이하기", "글쓰기", "내 팀 설정 저장" 등
- "결정/행동"을 유발하는 버튼 1개 (화면당 1개 원칙)

### 🟡 `primary-weak`로 내림 (활성이긴 하지만 '행동'은 아님)

- SegmentedControl 활성 (필터/시즌/카테고리)
- 토글류 활성 배경 (특히 상단 컨트롤 영역)
- 배지/상태 강조가 필요하지만 CTA가 함께 있을 때

### ⚪ 중립화 (빨강 금지에 가까움)

- 하단 탭바의 **배경 filled** (텍스트/아이콘 컬러 정도만)
- 2차 칩 활성 (구단 칩) — 기본은 뉴트럴
- 해시태그/정보 태그 (선수 상세) — 중립 톤 권장
- Empty state 강조 요소 (빨강으로 "경고"처럼 보이면 역효과)

### 🚫 시스템 상태색 분리 (Primary와 절대 혼용 금지)

- Error/Danger는 primary-red와 같은 톤을 쓰지 말고, **별도 danger**로 분리
- "CTA(가야 할 곳)"와 "에러(주의)"가 같은 신호가 되면 안 됨

---

## 구현 티켓 순서 (권장)

1. **테이블 숫자 정렬 + tabular-nums** — 순위/기록/세이버 공통 유틸
2. **:root 토큰 확장** — semantic aliases 추가
3. **SegmentedControl 컴포넌트** — 표준화
4. **UnderlineTabs 컴포넌트** — 표준화
5. **Chip 컴포넌트** — 뉴트럴 활성으로 변경
6. **빨강 사용처 마이그레이션** — 화면별 유지/weak/중립 적용
7. **Typography 스케일 통일** — 홈 섹션 헤딩부터
8. **선수 사진 fallback** — placeholder + ring
9. **하단 배너 정책** — sticky 해제 or 슬림화
10. **선수 상세 섹션 구획** — 카드화 + 디바이더

---

## 애매 케이스 판단 프로토콜

구현 중 규칙 적용이 애매할 때 → #design 에 아래 3가지와 함께 캡처 공유:

1. 이 화면의 **"단 하나의 CTA"**가 무엇인지
2. **팀컬러가 동시에 노출**되는지 여부
3. 해당 상황이 아래 3가지 흔한 예외 중 어디에 해당하는지

### 흔한 예외 3가지

1. **한 화면에 CTA가 2개 필요해 보일 때** → Primary filled 배정 판단
2. **팀컬러(뱃지/태그)와 primary-red가 동시에 강할 때** → weak로 내릴 대상 선정
3. **빈 상태/에러에서 "주의"를 빨강으로 표현할지** → danger 분리 여부
