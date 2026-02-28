# 디자인 시스템 — Spec

## 컬러 시스템

### 팀 컬러
| 팀 | Primary | Secondary | Text |
|----|---------|-----------|------|
| LG 트윈스 | #C60C30 | #1D1D1B | white |
| 두산 베어스 | #131230 | #ED1C24 | white |
| KT 위즈 | #000000 | #EB1F25 | white |
| SSG 랜더스 | #CE0E2D | #FFB81C | white |
| NC 다이노스 | #315288 | #C1A260 | white |
| KIA 타이거즈 | #EA0029 | #07101E | white |
| 롯데 자이언츠 | #002856 | #D00F31 | white |
| 삼성 라이온즈 | #074CA1 | #FFFFFF | white |
| 한화 이글스 | #FF6600 | #1D1D1B | white |
| 키움 히어로즈 | #820024 | #D4AF37 | white |

### 앱 컬러 (다크 모드 기본)
```css
--bg-primary: #0A0A0B;       /* 메인 배경 */
--bg-secondary: #141416;     /* 카드 배경 */
--bg-tertiary: #1C1C1F;      /* 입력 필드 등 */
--bg-glass: rgba(255,255,255,0.05); /* 글래스모피즘 */

--text-primary: #F5F5F7;     /* 메인 텍스트 */
--text-secondary: #8E8E93;   /* 보조 텍스트 */
--text-tertiary: #636366;    /* 힌트 텍스트 */

--accent: #FF453A;           /* 강조 (야구공 빨강) */
--accent-gold: #FFD60A;      /* 하이라이트/적중 */
--accent-green: #30D158;     /* 성공 */

--border: rgba(255,255,255,0.08);
--glass-blur: 20px;
```

### 라이트 모드
```css
--bg-primary: #F2F2F7;
--bg-secondary: #FFFFFF;
--text-primary: #1C1C1E;
--text-secondary: #8E8E93;
```

## 타이포그래피

### 폰트
- **영문**: SF Pro Display / SF Pro Text (Apple 기본)
- **한글**: Pretendard (무료, Apple 느낌)
- **숫자/스탯**: SF Mono (고정폭, 스코어보드 느낌)

### 스케일
| 용도 | Size | Weight | Line Height |
|------|------|--------|-------------|
| 대제목 | 28px | Bold | 1.2 |
| 제목 | 22px | Semibold | 1.3 |
| 소제목 | 17px | Semibold | 1.4 |
| 본문 | 15px | Regular | 1.5 |
| 캡션 | 13px | Regular | 1.4 |
| 스탯 넘버 | 32px | Bold (Mono) | 1.1 |

## 컴포넌트

### 글래스 카드
```css
.glass-card {
  background: var(--bg-glass);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--border);
  border-radius: 16px;
}
```

### 팀 플레어 뱃지
```
[LG] — 팀 컬러 배경, 흰색 텍스트, rounded-full, 작은 사이즈
```

### 레벨 뱃지
```
🟤 Lv.1  🔵 Lv.5  🟣 Lv.10  🟡 Lv.15  🔴 Lv.20  💎 Lv.25  👑 Lv.30
```

### 탭 바 (하단 네비게이션)
```
┌─────────────────────────────────┐
│  🏠 홈  ⚾ 경기  📊 순위  👤 MY │
└─────────────────────────────────┘
```
- 4탭 구성
- 활성 탭: accent 컬러 + filled 아이콘
- 비활성: text-secondary + outline 아이콘
- 글래스모피즘 배경

### 홈 화면 구성
```
┌─────────────────────────┐
│ 크보 에브리데이  [🔔]     │
├─────────────────────────┤
│ 📢 오늘의 경기 (가로 스크롤)│
│ [LG vs 두산] [SSG vs 한화]│
├─────────────────────────┤
│ 🔥 승부예측              │
│ (예측 카드 가로 스크롤)    │
├─────────────────────────┤
│ 📰 최신 소식             │
│ (뉴스/영상 피드)          │
├─────────────────────────┤
│ 💬 인기글                │
│ (전체 게시판 인기글)       │
├─────────────────────────┤
│  🏠  ⚾  📊  👤         │
└─────────────────────────┘
```

## 모션 가이드

### 페이지 전환
- View Transitions API 사용
- 기본: fade + 약간의 slide (200ms, ease-out)
- 뒤로가기: 역방향 slide

### 카드 인터랙션
- 탭: scale(0.97) → scale(1) (100ms spring)
- 좋아요: heart scale bounce + 파티클
- 예측 투표: 버튼 fill 애니메이션 + 햅틱

### 스크롤
- Scroll-driven Animations: 헤더 축소, 탭 바 숨기기
- 풀 투 리프레시: 커스텀 야구공 회전 애니메이션

### 득점 이벤트
- 화면 상단에서 팀 컬러 플래시 (200ms)
- 스코어 숫자 bounce 애니메이션
- 선택적 confetti 파티클 (홈런 시)

## 반응형 브레이크포인트
| 이름 | 범위 | 대상 |
|------|------|------|
| mobile | ~639px | 모바일 기본 |
| tablet | 640~1023px | 태블릿 |
| desktop | 1024px~ | PC 웹 |

- Mobile: 단일 컬럼, 하단 탭 바
- Desktop: 사이드바 네비게이션, 멀티 컬럼 레이아웃
