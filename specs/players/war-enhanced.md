# 예측 WAR + 고급지표 (Enhanced WAR) — Spec

> ⚠️ **최종 결정 (2026-06-20, 하린아빠 — 아래 본문보다 우선)**
> - **표기 = "예측 WAR"** (기존 "예상 WAR"에서 변경). 부정확 지표(예측 WAR·예측 wOBA·예측 wRC+)에 통일 disclaimer: `내부 예측 모델을 바탕으로 산출한 추정치입니다. 공식 WAR 또는 정확한 기록 데이터가 아니며, 실제 값과 차이가 날 수 있습니다.` ISO·BABIP은 정확값이라 평문.
> - **네이버 WAR = SSOT.** 스탯티즈 SSOT 전환 안 함("더 파보지 말자"). 스탯티즈는 1회 벤치마크/컨피던스 근거(스탯티즈↔네이버 0.42 > 우리↔네이버 0.30)로만 활용, 자동 수집 불가라 지속 SSOT 부적격.
> - **수비는 WAR 산식에 미반영** — 네이버 기준 오차 악화(0.27→0.37 실측), 스탯티즈 기준으로도 개선 보장 없음 확인. 수비 데이터는 **기록실에 별도 노출만**(수비율·자살보살·병살·수비이닝·실책).
> - **수비 데이터 소스 = GitHub Actions 크롤러**(Mac mini 아님). `crawl-stats.mjs`가 매일 CI에서 KBO 수비표 페이징 → `stats-2026-defense.json` 생성.
> - **고급지표**: 예측 wOBA·예측 wRC+·IsoP·BABIP 기록실 칩 추가(calcBatterSaber 산출값). **WPA는 play-by-play 데이터 갭으로 v2 별도 트랙**.
>
> _아래 본문은 초기 탐색 기록(수비 in-WAR 보강 가설)으로, 위 최종 결정으로 대체됨._

> ① 선수기록실 슬라이스 3. 하린아빠 결정(2026-06-20): "b로 한번에 제대로" — 자체 WAR를 수비·주루·포지션까지 보강 + "예상 WAR" 표기 + 스탯티즈 오차는 내부 데이터로만(서비스 미노출) + 오차 최소화를 상시 과제.

## 현황
`src/lib/utils/sabermetrics-calc.ts`의 `estimateBatterWAR`는 **타격(wRAA) + 대체선수**만. 수비·주루·포지션 누락 → 스탯티즈 공식 WAR와 큰 괴리(특히 수비형 포수/유격수).

## 데이터 토대 (확인 완료)
- KBO 수비표 `Record/Player/Defense/Basic.aspx` fetch 가능. 컬럼: 순위·선수명·팀명·**POS(구체 포지션: 포수/유격수/2루수/3루수/1루수/좌익수/중견수/우익수)**·G·GS·**IP(수비이닝, "542 2/3" 형식)**·**E**·PKO·**PO**·**A**·**DP**·**FPCT**·**PB**(포수)·**SB·CS·CS%**(포수). 30행/페이지 → 기존 `/api/stats` 패턴대로 여러 sort union으로 커버.
- 주루: `/api/stats` batter에 SB/CS 이미 존재.

## 구현 (단계)
1. **수비 데이터 수집** — ⚠️ *단순 fetch 스크래퍼 불가로 판명*(2026-06-20 검증): `Defense/Basic.aspx`는 `?sort=` 무시 + 포지션 필터가 ASP.NET 포스트백인데, 전체 폼 필드(viewstate/eventvalidation/전 input·select) 복제해 POST해도 **3KB 셸만 반환**(테이블 별도 AJAX 렌더 or 자동화 차단). 포지션 dropdown은 포수(2)/내야수(3,4,5,6)/외야수(7,8,9) 3그룹(각 행에 구체 POS 포함)이라 그룹 3회면 커버 가능하나 *fetch로는 표를 못 받음*. → **해법 = 헤드리스 브라우저(Playwright/Lightpanda ~/lightpanda) 크롤 → static JSON** (기존 "Vercel 서버리스 Playwright 불가 → Mac mini cron 크롤 → static JSON" 패턴과 동일). 산출 `stats-2026-fielding.json`: `{ name, team, pos, dInn, e, po, a, dp, fpct, pb, sbAllowed, csAllowed }[]`(주 포지션=수비이닝 최다). cron은 기존 크롤 파이프라인에 추가.
2. **WAR 산식 보강** `sabermetrics-calc.ts`:
   - 주루 runs = `SB*0.2 - CS*0.4` (wSB 근사).
   - 포지션 보정(주 포지션, 시즌 환산 ÷ 720수비이닝 비례): C +12.5 / SS +7.5 / 2B,3B,CF +2.5 / LF,RF -7.5 / 1B -12.5 / DH -17.5.
   - 수비 runs(간이 TZR-lite): 리그 포지션평균 대비 (PO+A) 범위 + E 페널티를 수비이닝 비례로. 정밀 UZR/DRS는 play-by-play 필요 → **추정**임을 전제(라벨 "예상").
   - 최종 batterWAR = (wRAA + 주루 + 수비 + 포지션 + 대체선수) / RPW(10).
3. **데이터 결합**: `/api/stats` batter(이름+팀) ↔ `/api/fielding`(이름+팀) 조인. WAR 계산은 RecordRoom 또는 서버에서.
4. **RecordRoom UI**: 타자 스탯 칩에 "예상 WAR" 추가(`STAT_DEFS`에 war 엔트리 + 라벨 "예상 WAR"). 정렬 시 WAR desc. 값 옆/툴팁에 "예상" 명시.
5. **스탯티즈 오차 베이스라인(내부 전용)**: 서비스 미노출. robots/ToS 확인(도메인 statiz.* 재확인 필요) 후 1차는 *샘플 수동 비교*(상위 10~20명)로 평균 오차율 산출 → 내부 문서(`specs/` 또는 노션). 상시 개선 과제로 기록.

## 비목표
- 스탯티즈 데이터 서비스 직접 노출 금지.
- 완전 정밀 UZR/DRS(불가, play-by-play 없음) — "예상 WAR" 추정으로 한정.

## 검증
- 수비 스크래퍼 smoke(주요 포지션 리더 파싱 일치).
- WAR 보강 전후 상위 선수 순위 sanity(수비형 선수 상승 확인).
- tsc/eslint clean. 머지게이트(삼순 GO→하린아빠 승인→머지→prod QA).
