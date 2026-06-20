# 예상 WAR 보강 (Enhanced WAR) — Spec

> ① 선수기록실 슬라이스 3. 하린아빠 결정(2026-06-20): "b로 한번에 제대로" — 자체 WAR를 수비·주루·포지션까지 보강 + "예상 WAR" 표기 + 스탯티즈 오차는 내부 데이터로만(서비스 미노출) + 오차 최소화를 상시 과제.

## 현황
`src/lib/utils/sabermetrics-calc.ts`의 `estimateBatterWAR`는 **타격(wRAA) + 대체선수**만. 수비·주루·포지션 누락 → 스탯티즈 공식 WAR와 큰 괴리(특히 수비형 포수/유격수).

## 데이터 토대 (확인 완료)
- KBO 수비표 `Record/Player/Defense/Basic.aspx` fetch 가능. 컬럼: 순위·선수명·팀명·**POS(구체 포지션: 포수/유격수/2루수/3루수/1루수/좌익수/중견수/우익수)**·G·GS·**IP(수비이닝, "542 2/3" 형식)**·**E**·PKO·**PO**·**A**·**DP**·**FPCT**·**PB**(포수)·**SB·CS·CS%**(포수). 30행/페이지 → 기존 `/api/stats` 패턴대로 여러 sort union으로 커버.
- 주루: `/api/stats` batter에 SB/CS 이미 존재.

## 구현 (단계)
1. **수비 스크래퍼** `src/app/api/fielding/route.ts` — `/api/stats` 패턴 복제(fetchHtml/parseTable/인메모리 캐시/sort union). 반환: `{ name, team, pos, dInn, e, po, a, dp, fpct, pb, sbAllowed, csAllowed }[]`. 선수가 복수 포지션이면 포지션별 row(주 포지션 = 수비이닝 최다).
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
