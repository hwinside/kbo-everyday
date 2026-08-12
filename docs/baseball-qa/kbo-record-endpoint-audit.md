# KBO 기록실 엔드포인트 실측 감사

기준: `koreabaseball.com` 공식 페이지를 브라우저/HTTP로 직접 열어 확인.  
주의: 아래는 실측 메모이며, 확정 못 한 항목은 `확인 안 됨`으로 적었다.

## 핵심 정리

| 구분 | URL | 필터/전환 방식 | 컬럼명 | 정렬 가능 지표 | pagination / 전체행 |
|---|---|---|---|---|---|
| 타자 기본 현재 | `/Record/Player/HitterBasic/Basic1.aspx` | 시즌(`1982-2026` + `전체`), 시리즈, 팀, 포지션, 상황1, 상황2. 상단 `기본기록/세부기록`, `이전/다음` 탭 이동. | `순위, 선수명, 팀명, AVG, G, PA, AB, R, H, 2B, 3B, HR, TB, RBI, SAC, SF` | `AVG, G, PA, AB, R, H, 2B, 3B, HR, TB, RBI, SAC, SF` | `30`행/페이지, 숫자 pager `1-2`(postback `ucPager.btnNoN`) |
| 타자 기본 현재 2 | `/Record/Player/HitterBasic/Basic2.aspx` | 동일 필터/전환. | `순위, 선수명, 팀명, AVG, BB, IBB, HBP, SO, GDP, SLG, OBP, OPS, MH, RISP, PH-BA` | `AVG, BB, IBB, HBP, SO, GDP, SLG, OBP, OPS, MH, RISP, PH-BA` | `30`행/페이지, 숫자 pager `1-2` |
| 타자 통산 | `/Record/Player/HitterBasic/BasicTotal.aspx` | 시즌은 `전체(9999)` 고정, 시리즈만 선택. | `순위, 선수명, 팀명, AVG, G, PA, AB, R, H, 2B, 3B, HR, TB, RBI, SB, BB, HBP, SO, GDP, E` | `AVG, G, PA, AB, R, H, 2B, 3B, HR, TB, RBI, SB, BB, HBP, SO, GDP, E` | `30`행/페이지, pager `1-5` |
| 타자 세부 현재 | `/Record/Player/HitterBasic/Detail1.aspx` | Basic1과 동일한 시즌/시리즈/팀/포지션/상황 필터. | `순위, 선수명, 팀명, AVG, XBH, GO, AO, GO/AO, GW RBI, BB/K, P/PA, ISOP, XR, GPA` | `AVG, XBH, GO, AO, GO/AO, GW RBI, BB/K, P/PA, ISOP, XR, GPA` | `30`행/페이지, pager `1-2`. `Detail2.aspx` 직링크는 에러 페이지로 확인됨. |
| 투수 기본 현재 | `/Record/Player/PitcherBasic/Basic1.aspx` | 시즌/시리즈/팀, 상황 필터. `기본기록/세부기록`, `이전/다음` 탭 이동. | `순위, 선수명, 팀명, ERA, G, W, L, SV, HLD, WPCT, IP, H, HR, BB, HBP, SO, R, ER, WHIP` | `ERA, G, W, L, SV, HLD, WPCT, IP, H, HR, BB, HBP, SO, R, ER, WHIP` | `30`행/페이지, pager `1-4` |
| 투수 기본 현재 2 | `/Record/Player/PitcherBasic/Basic2.aspx` | 동일 필터/전환. | `순위, 선수명, 팀명, ERA, CG, SHO, QS, BSV, TBF, NP, AVG, 2B, 3B, SAC, SF, IBB, WP, BK` | `ERA, CG, SHO, QS, BSV, TBF, NP, AVG, 2B, 3B, SAC, SF, IBB, WP, BK` | `20`행(실측), pager는 `1`만 보임. |
| 투수 통산 | `/Record/Player/PitcherBasic/BasicTotal.aspx` | 시즌 `전체(9999)` 고정, 시리즈만 선택. | `순위, 선수명, 팀명, ERA, G, CG, SHO, W, L, SV, HLD, WPCT, TBF, IP, H, HR, BB, HBP, SO, R, ER` | `ERA, G, CG, SHO, W, L, SV, HLD, WPCT, TBF, IP, H, HR, BB, HBP, SO, R, ER` | `30`행/페이지, pager `1-4` |
| 투수 세부 현재 | `/Record/Player/PitcherBasic/Detail1.aspx` | Basic1과 동일한 시즌/시리즈/팀/상황 필터. | `순위, 선수명, 팀명, ERA, GS, Wgs, Wgr, GF, SVO, TS, GDP, GO, AO, GO/AO` | `ERA, GS, Wgs, Wgr, GF, SVO, TS, GDP, GO, AO, GO/AO` | `20`행(실측), pager `1`만 보임. `Detail2.aspx` 직링크는 에러 페이지. |
| 수비 | `/Record/Player/Defense/Basic.aspx` | 시즌/시리즈/팀/포지션. | `순위, 선수명, 팀명, POS, G, GS, IP, E, PKO, PO, A, DP, FPCT, PB, SB, CS, CS%` | `POS, G, GS, IP, E, PKO, PO, A, DP, FPCT, PB, SB, CS, CS%` | `30`행/페이지, pager `1-5` |
| 주루 | `/Record/Player/Runner/Basic.aspx` | 시즌/시리즈/팀/포지션. | `순위, 선수명, 팀명, G, SBA, SB, CS, SB%, OOB, PKO` | `G, SBA, SB, CS, SB%, OOB, PKO` | `30`행/페이지, pager `1-5` |
| 역대 최고 타자 | `/Record/History/Top/Hitter.aspx` | 드롭다운 `타율/안타/홈런/득점/타점/도루/장타율/출루율/루타`로 지표 전환. | `순위, 선수명, 팀명, 기록, 연도` | 드롭다운 선택값이 곧 정렬/표시 지표. | `10`행 고정, pager 없음 |
| 역대 최고 투수 | `/Record/History/Top/Pitcher.aspx` | 드롭다운 `승리/평균자책점/승률/탈삼진/세이브포인트/세이브/홀드`. | `순위, 선수명, 팀명, 기록, 연도` | 드롭다운 선택값이 곧 정렬/표시 지표. | `10`행 고정, pager 없음 |
| 역대 타자 | `/Record/History/Player/Hitter.aspx` | 드롭다운 `13/HRA_RT, 14/HIT_CN, 15/HR_CN, 16/RUN_CN, 17/RBI_CN, 18/SLG_RT, 19/OBP_RT, 20/SB_CN`. | `연도, 선수, 소속, 타수, 안타, 타율` | 드롭다운 선택값이 곧 지표 전환. | `45`행 전부 한 표에 로드, pager 없음 |
| 역대 투수 | `/Record/History/Player/Pitcher.aspx` | 드롭다운 `22/W_CN, 23/ERA_RT, 25/KK_CN, 28/RELIEF_W_CN, 27/SV_CN`. | `연도, 선수, 소속, 승, 패` | 드롭다운 선택값이 곧 지표 전환. | `60`행 전부 한 표에 로드, pager 없음 |

## 관찰 메모

- `Basic1/Basic2`, `PitcherBasic/Basic1/2`, `HitterBasic/Detail1`, `PitcherBasic/Detail1`은 상단 탭 링크와 하단 숫자 pager가 섞여 있다. 실제 전체 행 수는 숫자 pager를 따라가야 확보된다.
- `BasicTotal.aspx`는 시즌 드롭다운에서 `전체(9999)`를 선택한 통산 페이지로 확인됐다.
- `Detail2.aspx`와 `PitcherBasic/Detail2.aspx`는 직링크가 `KBO 오류` 페이지로 떨어졌다. 현재 실측으로는 `확인 안 됨`이며, 실제 2페이지가 postback pager로만 열리는지 추가 검증이 필요하다.
- `노히트노런` 전용 공식 표는 이번 조사 범위에서 **확인 안 됨**. 대신 투수 통산/역대 표에는 `CG`, `SHO` 같은 완봉/완투 계열 지표가 직접 노출된다.
