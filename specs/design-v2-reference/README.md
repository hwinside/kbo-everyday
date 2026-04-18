# Design V2 Reference (시각 기준 SSOT)

> 출처: Claude Design 프로젝트 `072601fd-98cc-45df-84c1-101133fcfb99`
> 받음: 2026-04-19 04:52 KST (하린아빠 슬랙 `#discussion`)
> 상태: ✅ *FINAL* — 2026-04-19 05:33 하린아빠 최종본 수령 완료. `FREEZE-DIFF.md`에 v0→final 변경 요약. 삼순이 freeze 리뷰 대기.
> 역할: `specs/design-v2-migration.md`의 *시각 기준본(visual SSOT)*. 구현 중 "조금씩 다른 V2" 발생 시 이 폴더가 정답.

## 🚧 최종본 도착 전 취급 주의

- 현재의 토큰 값(팀별 primary/light/secondary)은 *v0 draft 기준*. 하드코딩 메타니 시작하지 말 것.
- *구현 시작 가능*: Feature Flag 인프라, DB 마이그레이션, WCAG 대비 계산 함수, ThemeProvider 뼈대, `/v2/playground` 빈 라우트
- *대기 필수*: `tokens.css`, `team-palette.ts`, 프리미티브 12종, 페이지 구현 전부
- 최종본 도착 시점: 하린아빠가 새 ZIP 공유 → 이 폴더 전체 덮어쓰기 → 2차 README 리랍

## 파일 구조

```
redesign/
├─ index.html              # 전체 목업 단일 페이지 (브라우저에서 열어 확인)
├─ shared/
│  ├─ tokens.js            # TEAMS(10팀+neutral), NEUTRAL 다크 팔레트, mix/withAlpha/luminance/teamPalette helper
│  ├─ atoms.jsx            # PhoneFrame, StatusBar, TeamLogo, SectionTitle, TabBar, Diamond, Pips (7종)
│  ├─ shell.jsx            # AppShell (team/intensity state, tweaks panel, intro header)
│  └─ design-canvas.jsx    # DesignCanvas 래퍼
├─ screens/
│  ├─ screens-game.jsx     # 홈 + 경기 상세 (라이브 스코어보드, 승리확률, 이닝 스코어보드)
│  ├─ screens-team.jsx     # 순위 (내 팀 하이라이트 카드 / 중립 플랫 리스트)
│  ├─ screens-community.jsx # 커뮤니티 (팀 컬러 헤더, 다른 팀 이동)
│  └─ screens-player.jsx   # 선수 프로필 (V2 1차 범위 아님 — 참고용으로만 유지)
├─ screens-extra.jsx        # My 페이지 + 추가 화면
└─ logos/                   # 10팀 공식 SVG 로고 (inline 임베드된 버전은 tokens.js 참조)

uploads/   # 원본 스크린샷 (gitignore, 로컬 참고용)
scraps/    # 디자인 스케치 스냅샷 (gitignore)
```

## 핵심 토큰 요약 (tokens.js 발췌)

### TEAMS (10팀 + 중립)
각 팀당: `{ id, short, name, slug, primary, light, secondary, logo }`

| 팀 | primary | light | secondary |
|---|---|---|---|
| LG 트윈스 | #C60C30 | #E04050 | #1D1D1B |
| 두산 베어스 | #131230 | #9BA8D4 | #ED1C24 |
| KT 위즈 | #1A1A1A | #E85050 | #EB1F25 |
| SSG 랜더스 | #CE0E2D | #FFB81C | #FFB81C |
| NC 다이노스 | #315288 | #7DA3C9 | #C1A260 |
| KIA 타이거즈 | #EA0029 | #D45C5C | #07101E |
| 롯데 자이언츠 | #002856 | #6BC4E8 | #D00F31 |
| 삼성 라이온즈 | #074CA1 | #5A8FBD | #C0C0C0 |
| 한화 이글스 | #FF6600 | #FFA766 | #1D1D1B |
| 키움 히어로즈 | #820024 | #C97088 | #D4AF37 |
| **중립 (KBO)** | #6E6E73 | #A8A8AD | accent: #E03A3A (존재감 10~15%) |

### NEUTRAL 다크 토큰
- `bg0`: #07070A (최하층)
- `bg1`: #0E0E12
- `bg2`: #15151B
- `bg3`: #1D1D24
- `line`: rgba(255,255,255,0.07)
- `lineStrong`: rgba(255,255,255,0.14)
- `text1`: rgba(255,255,255,0.96)
- `text2`: rgba(255,255,255,0.68)
- `text3`: rgba(255,255,255,0.44)
- `text4`: rgba(255,255,255,0.28)
- `live`: #FF453A / `win`: #30D158 / `warn`: #FFD60A

### 헬퍼 함수
- `mix(a, b, t)` — 두 색 선형 보간
- `withAlpha(hex, a)` — hex → rgba
- `luminance(hex)` — WCAG 휘도 계산 (저채도 팀 자동 보정용)
- `onDarkColor(team)` — 팀 primary가 너무 어두우면 light 사용
- `teamPalette(team, intensity)` — 히어로 배경·ambient·카드 틴트·accent·soft·border·on-accent 8종 자동 생성
  - 중립 팀은 예외 처리: KBO-느낌 머플드 레드 `#E03A3A`를 accent로 사용

## 사용 규칙

1. *쓰기 금지 (read-only)*. 이 폴더는 Claude Design 원본 export. 수정하지 말 것.
2. 구현 중 의문 생기면 *먼저 이 폴더부터 확인*. 목업과 구현이 갈리면 목업이 정답 (V1 호환 필요 시에만 예외).
3. 토큰 네이밍(`--team-primary`, `--team-accent-soft` 등)은 이 폴더 `tokens.js`의 `teamPalette` 반환 키를 그대로 CSS 변수로 옮긴다.
4. 로고 SVG는 이 폴더의 `logos/*.svg` 10개를 `public/logos/teams/` 또는 `public/team-logos/` 로 복사해 사용.
5. 아토믹 컴포넌트(PhoneFrame/StatusBar/TeamLogo/TabBar/Diamond/Pips)는 이 폴더의 JSX 구조를 React 컴포넌트로 1:1 포팅.

## 로컬 프리뷰 (브라우저에서 확인)

```bash
cd ~/Projects/kbo-everyday/specs/design-v2-reference/redesign
python3 -m http.server 8765
# 브라우저: http://localhost:8765/index.html
```

---

관련:
- `specs/design-v2-migration.md` — 문서 SSOT (스펙)
- `specs/design-v2-migration-plan.md` — 기술 설계 (TODO)
- `specs/design-v2-migration-tasks.md` — 작업 체크리스트 (TODO)
