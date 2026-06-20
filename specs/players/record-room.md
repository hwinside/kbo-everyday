# 선수기록실 (Player Record Room) — Spec

> 출처: #cs 고객 건의 (2026-06-20, 스레드 `1781924515.758179`) — "선수 탭을 선수기록실로 개편해서 특정 기록을 클릭하면 기록 순으로 정렬". 하린아빠 결정 = B(선수기록실) 채택.

## 목표
선수를 **특정 스탯 기준으로 정렬**해서 볼 수 있는 기록실. 헤더/칩으로 스탯을 고르면 그 순으로 랭킹된 리스트를 보여준다.

## 위치 (하린아빠 확정 2026-06-20)
- **전역(리그 전체) 기록실** → 선수 탭(`/players`)에서 진입.
- **팀별 기록실** → 각 팀 페이지에 별도 (그 팀 스코프 내 정렬).
- 둘은 **같은 컴포넌트**(`RecordRoom`)를 `scopeTeamId` prop만 바꿔 재사용.

## 재사용 (드리프트 방지)
- 데이터: `GET /api/stats?type=batter|pitcher&season=current` (리그 전체, kboId·team 포함, 인메모리 캐시).
- 정렬/자격/공동순위: `rankByStat(rows, statKey)` (`@/lib/stats/title-rankings`) — 랭킹 페이지·홈 타이틀과 동일 SSOT.
- 스탯 정의: `STAT_DEFS` (`@/lib/stats/title-defs`) — label/format/higherIsBetter/type.
- 리스트 카드 UI: `/rankings/[stat]` 패턴(순위뱃지 + PlayerAvatar + 이름/팀 + 값 + 내팀/최애 하이라이트).

## 슬라이스 (수직, 빅뱅 금지)
1. **`RecordRoom` 컴포넌트 + 선수 탭 진입(전역)** ← 본 PR
   - 타자/투수 토글 + 스탯 칩(STAT_DEFS에서 type별) → 선택 스탯으로 `rankByStat` 정렬 리스트.
   - `scopeTeamId?` : 있으면 해당 팀 row만 필터 후 랭킹(팀 내 정렬), 없으면 전역.
   - 실데이터 KBO 스탯만 (홈런·타율·OPS·출루율·타점·도루·볼넷·득점 / ERA·WHIP·탈삼진·세이브·홀드·승·이닝).
   - 선수명 → `/community/players/[kboId]` 링크.
2. **각 팀 페이지에 `RecordRoom scopeTeamId={팀}` 마운트** (팀별 기록실).
3. **예상 WAR 컬럼** — `sabermetrics-calc.ts` WAR를 **수비·주루·포지션까지 보강**한 뒤 추가. 표기는 "예상 WAR". 스탯티즈와의 오차율은 **내부 데이터로만** 보유(서비스 미노출, robots/ToS 확인 후 1차 샘플 수동 비교). 산식은 오차 최소화 방향으로 상시 개선.

## 비목표 (이번 PR 제외)
- 예상 WAR 노출 (슬라이스 3, 보강 후).
- 스탯티즈 자동 크롤링 (robots/ToS 선확인).
- 게시글수/직찍수 정렬 (별도 트랙).

## 검증
- tsc/eslint clean.
- 렌더: 전역 기록실에서 스탯 칩 전환 시 리스트가 해당 스탯순으로 재정렬, 모바일 320/360/390 레이아웃 정상.
- 머지 게이트: 삼순 GO → 하린아빠 승인 → 머지 → 배포 후 End-User QA.
