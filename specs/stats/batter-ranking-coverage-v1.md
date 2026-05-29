# 타자 랭킹 수집 범위 수정 v1 (regulation-PA 기준)

## 문제
`/api/stats?type=batter`가 타자 풀을 KBO `HitterBasic/Basic1.aspx?sort=GAME_CN` **1페이지(경기수 상위 30명)** 에서만 수집한다. KBO 레코드 페이지는 페이지당 30행 + ASP.NET 포스트백 페이지네이션이라 GET으로는 31위↓를 못 가져온다.

결과: 경기수 30위 밖 선수는 **데이터에 row 자체가 없다.** 비율스탯 랭킹(`BatterTitleTab`)은 이미 `qualifiedRate===1`(KBO HRA_RT 규정타석 기준) 필터를 쓰지만, 풀에 row가 없으면 플래그가 붙을 대상조차 안 된다.

검증(2026-05-29):
- `sort=GAME_CN` → 최형우(삼성, .355/8HR, OPS 1위) **없음**, 박민우(NC, 도루 1위) **없음**
- `sort=OPS_RT` top=최형우, `sort=SB_CN` top=박민우 — 즉 다른 정렬엔 존재

## 결정
- **비율스탯(AVG/OBP/SLG/OPS) = KBO 규정타석(HRA_RT) 기준** — 하린아빠 ⓐ 확정 (2026-05-29). KBO·네이버 공식과 일치. 시즌초 명단이 적은 건 공식과 동일하니 수용.
- **누적스탯(HR/RBI/안타/도루) = 카테고리별 정렬 union** — 투수(`fetchPitcherStats`)와 동일 패턴.

## 변경 (단일 파일: `src/app/api/stats/route.ts`)
`fetchBatterStats`만 수정. 단일 `GAME_CN` 수집 → 카테고리별 정렬 union.

- **rateSorts**: `HRA_RT, OPS_RT, OBP_RT, SLG_RT` — 비율스탯 리더보드. KBO가 규정타석 충족자만 노출
- **Basic1 union 정렬키**: `GAME_CN, HR_CN, RBI_CN, HIT_CN, SB_CN` + rateSorts
  - 각 부문 상위 30 합집합 → 중복 제거(name::team, 최초 우선). 경기수/홈런/타점/안타/도루 + 비율 리더 모두 포함
- **Basic2 union 정렬키**: `GAME_CN` + rateSorts
  - 규정타석 선수의 OBP/OPS/SLG/BB/SO 등 확보
- **Runner**: `SB_CN` (변경 없음, 도루 카운트 join용)
- **qualifiedKeys**: rateSorts 4개 Basic1 페이지 union에서 추출
  - ⚠️ 단일 `HRA_RT`(타율 정렬)만 쓰면 타율 31위↓ 규정타석 선수(예: 최정 SSG, OPS 10위)가 누락돼 OPS/OBP/SLG 랭킹이 KBO와 어긋남. 비율 리더보드 union으로 해결

검증된 정렬키(querystring 동작): `GAME_CN HRA_RT HR_CN RBI_CN HIT_CN SB_CN OBP_RT SLG_RT OPS_RT`. ⚠️ 안타는 `HIT_CN` (❌`H_CN`은 빈 응답).

### 검증 결과 (2026-05-29, live)
- count 30 → 63, qualified 30 → 37
- OPS top10 / AVG top5 / HR top5 / OBP top5 모두 KBO 공식과 일치 (최정 SSG OPS 10위 포함)
- 최형우 OPS 1.022·OBP .472·SLG .550 = KBO 일치, qualifiedRate=1
- 박민우 SB 19, qualifiedRate=1

## 호환성
- `BatterTitleTab` (standings 타이틀): `qualifiedRate===1` 필터 — 풀 확장으로 누락 선수 등장. 변경 불필요.
- `rankings/[stat]` (상세 top100): 클라이언트 재정렬·재랭킹 + 자체 필터(비율 `pa>=30`, 누적 `games>=10`). 풀 확장으로 더 완전. 변경 불필요.
  - ⚠️ **별도 결정 보류**: 이 페이지 비율스탯 컷이 `pa>=30`이라 ⓐ(규정타석)와 불일치. 상세 페이지는 의도적으로 넓게 둘지 여부는 후속 결정. 본 PR 스코프 밖.

## 비스코프 (Surgical)
- 투수 로직(`fetchPitcherStats`)은 이미 5개 정렬 union — 손대지 않음
- `rankings/[stat]` 비율 컷 정렬 변경 — 후속 PR
- ASP.NET 포스트백 전페이지 순회 — 미채택(ViewState 취약)

## 검증 기준 (Goal-Driven)
1. `GET /api/stats?type=batter&season=2026` 응답에 최형우(삼성)·박민우(NC) row 존재 + `qualifiedRate` 정확
2. 최형우 OPS/OBP/SLG 값이 KBO 페이지와 일치
3. standings 타이틀 탭 OPS/출루율/장타율 랭킹에 최형우 노출, 네이버 순위와 멤버십 일치
4. 기존 30명 랭킹 회귀 없음 (HR/타점/타율 top 변동 없음)
5. 타입체크/빌드 통과

## 알려진 한계
- HRA_RT 페이지도 30행 1페이지 → 규정타석 충족자가 30명 초과하는 시즌 중후반엔 AVG 하위 규정타석 선수 일부 누락 가능. 2026 현재 ~21~30명이라 영향 없음. 초과 시점 도달하면 페이지네이션 별도 검토.
