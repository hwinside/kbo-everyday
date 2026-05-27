# 크관(GameChat) 상황별 맞춤 스탯 박스 v1

- **등록일**: 2026-05-26
- **상태**: 스펙 초안 (Phase 1 항목 확정 전, 삼순이 리뷰 대기)
- **출처**: 하린아빠 — "문자중계와 채팅 사이에 박스 하나, 해당 타석 관련 흥미 스탯을 최대한, 단 오류 가능성은 철저히 배제" (#product 스레드 `1779791186.377619`)
- **PR 시리즈**: PR1 데이터 어댑터(가드 포함) → PR2 UI 박스(평시 5라인 + 트리거 7종 + C-T/C-R 파서) → PR3 시즌 마일스톤·사이클링 잔여 트리거 + 동시 발동 우선순위 회귀 → PR4 재집계(최근 10경기, H2H 등 Phase 2 진입 시)

> 🔒 **머지 게이트 (오류 배제 원칙)**
> 1. `kboId` 단독키. name 매핑 실패 → 그 행만 숨김(박스 전체 X)
> 2. 응답 stale > 60s → "갱신중" 표시. 옛 값 노출 금지
> 3. 재집계 표본 N < 임계 → 항목 숨김 ("1/2 .500" 노이즈 차단)
> 4. 마일스톤 = boxscore 확정 시점에만 트리거. 진행 중 추정값 금지. *예외*: 통산/시즌 *누적값이 확정*되어 있고 *+1 결과가 명확한 경우*에 한해 가정형 예측 문구 허용 (예: `이번 안타 시 통산 2500안타`). 누적값 stale > 1h거나 +1 결과 정의 모호 시 금지
> 5. 시즌 값 KBO HTML vs 네이버 record cross-check, |diff| > 0.005 시 숨김 + 모니터링 로그
> 6. 데이터 출처 API down → 박스 전체 숨김 (skeleton 노출 X)
> 7. fail-closed: 한 항목 검증 실패 = 그 항목만 숨김, 박스는 살아남음

---

## 1. 문제·가치

- 크관(GameChat)은 KBO 중계 화면 + 응원 채팅의 결합점인데, *지금 타석의 맥락*을 보여주는 시각 자료가 없음. 점수·BSO·주자는 보이지만 "이 타석이 왜 흥미로운가"를 즉발로 모름.
- 다른 야구 중계(MLB 게임데이, ESPN, 네이버 자체)는 박스 형태의 contextual stats를 기본 제공. 크보팬은 미제공.
- 크관 정체성(관전객 = 응원 + 정보)에 직접 부합. 응원 토글·시청 기록은 이미 있고, 매치업 자체 데이터는 네이버 relay·record / KBO HitterDetail API에 *이미 들어와 있음* → 표시만 더하면 됨 (낮은 ingest 비용).

## 2. 핵심 경험

| 영역 | 동작 |
| --- | --- |
| **위치** | 문자중계 영역 하단, 채팅 입력창 상단 (즉, 중계 ↔ 채팅 사이) |
| **평시 (컨텍스트 게이트 일치 시에만)** | 좌/우 split · 만루 · RISP · 2아웃 · PH-BA 중 *현재 매치업·주자·아웃·대타 여부에 매칭되는 행만* 노출. 일반 시즌 지표(PA·AB·H·OPS·ERA·WHIP 등)는 v1 비포함 — 다른 컴포넌트(matchup 라인·선수 페이지)에 이미 존재 |
| **이벤트성 (트리거 라인)** | 마일스톤·임박 상태가 발동되면 줄1 위에 *highlight 라인* 1줄 삽입 (예: "사이클링 1개 남음: 3루타") |
| **데이터 부재** | 박스 전체 collapse (skeleton X). 화면 흐름 끊김 최소화 |
| **stale 표시** | > 60s 응답 → "갱신중" subtle pill (값 노출 금지) |

> UI 위계: *highlight* > *오늘* > *시즌*. 위에서 아래로 우선순위.

## 3. 데이터 출처 매핑

| 코드 | 출처 | 갱신 | 제공 |
| --- | --- | --- | --- |
| A | 네이버 `schedule/games/{id}/relay?inning=N` | 투구 단위 | 매치업 라이브 (오늘 PA/AB/H/HR/BB/K/RBI/타율·시즌 ERA·AVG), 이닝별 타석 시퀀스, 라인스코어 |
| B | 네이버 `schedule/games/{id}/record` | 박스스코어 단위 | pitcher/batter 박스스코어 (이름·playerId 포함, IP/H/R/ER/BB/K/HR 정확) |
| C | KBO `HitterDetail/PitcherDetail/Basic.aspx` HTML | 1시간 캐시 | 시즌 풀 스탯 (OPS/OBP/SLG/RISP/PH-BA/WHIP/QS 등). `/api/player-stats` 기 구축 |
| C-S | KBO `HitterDetail/PitcherDetail/Situation.aspx` HTML | 1시간 캐시 | *Split 스탯* — 주자상황별/카운트별/이닝별/타순별/좌우별/아웃카운트별. 신규 어댑터 필요 |
| C-T | KBO `HitterDetail/PitcherDetail/Total.aspx` HTML | 1시간 캐시 | *통산 누적* 풀스탯 (H/HR/RBI/R/SB/2B/3B / W/K/SV/HLD/IP 등). 통산 마일스톤용. PR2 코드 단계에 신규 파서 추가 |
| C-R | KBO 시즌 랭킹 (도루 부문) | 1시간 캐시 | 도루 1위 카운트. 도루 임박 트리거의 *1위 탈환 게이트*용. stale > 1h fail-closed |
| D | KBO `GetKboGameList` | ~15s 폴링 | 실시간 BSO 카운트, 주자 점유, 현재 투수/타자 |
| E | Supabase `game_event_state.event_history` | 폴링 누적 | 타석/주자/이닝 단위 누적 이벤트 (5/9 cumulative semantic key 적용 이후 신뢰) |
| F | 네이버 record `batter[]/pitcher[]` runner sub flag | 박스스코어 단위 | 대주자(pinch runner) 교체 이벤트 식별. 도루 임박 트리거의 *대주자 케이스*용 (kboId 기반) |

> 외부 API는 전부 비공식 — `Referer: koreabaseball.com` 필수, User-Agent 명시 (5/20 referer drift 사고 [[postmortem-2026-05-20-kbo-api-referer-drift]]).

## 4. 항목별 feasibility

### 4-1. 🟢 즉시 가능 (Phase 1)

| 항목 | 출처 | 비고 |
| --- | --- | --- |
| 시즌 RISP (타자) | C | 주자 2/3루 점유 시에만 노출 (§5-6). 비-RISP 상황에선 노이즈 |
| 시즌 PH-BA (타자) | C | 현재 타자 *대타*일 때만 노출 (§5-6). 정규 타자에겐 무의미 |
| *좌/우 상대 split* (타자 vs 좌·우투수 / 투수 vs 좌·우타자) | C-S Table 4 | 현재 매치업 손잡이에 *반대편 행만* 노출 (§5-6) |
| *만루 타율* (타자) / *만루 피안타율* (투수) | C-S Table 0 | 만루 상황일 때만 노출 (§5-6). RISP 게이트 강화판 |
| *2아웃 AVG* | C-S Table 5 *2아웃 행만* | 현재 *2아웃*일 때만 노출 (§5-6). 0/1아웃 행은 평시 미사용 |
| 이번 경기 타석 시퀀스 (1타석 1루타, 2타석 삼진…) | A | inning relay에서 batterName 매칭 |
| 사이클링 임박 (3루타/홈런만 남음 등) | A | 시퀀스에서 1B/2B/3B/HR 체크 |
| 노히트 진행 | B | 수비 팀 합산 H=0 추적. *7회 이후에만 노출* (§5-5) |
| 시즌 마일스톤 임박 (100타점 · 30HR · 100K · 200K 등) | C | 잔여 N 표시, 확정 시점에만 |
| *전타석 안타 진행* | B | `AB ≥ 2 AND H == AB` → 다음 타석 진입 시 mount, 아웃 시 unmount. 표기 `🔥 전타석 안타 기록중! · 오늘 N타수 N안타` (§5-5) |
| *전타석 출루 진행* | B | `PA ≥ 2 AND (H+BB+HBP) == PA` → 자동 연속 가드. 전타석 안타 발동 시 suppress. 표기 `🔥 전타석 출루 기록중! · 오늘 N/N (H n · BB n)` (§5-5) |
| *개인 다타점* | B | 오늘 `RBI ≥ 3` 달성 후 다음 타석부터 mount, 경기 종료까지 유지. 표기 `💥 오늘 N타점 진행!` (§5-5) |
| *연속 무사사구 K* | A | 투수 등판 후 연속 K ≥ 5 (사이 H/BB/HBP/inplay out 0), K 외 결과 발생 시 unmount. 표기 `🔥 N연속 탈삼진!` (§5-5) |
| *도루 임박* (라운드 + 1위 탈환) | C(SB) + C-R + F | *출루 직후*만 mount (자력 + 대주자, kboId 매핑). 라운드(9→10·19→20·29→30·39→40) OR 1위 탈환 (현재 N+1 == 리그 1위 N) 게이트. 1위 탈환 우선. 표기 `🦶 시즌 N도루 임박!` / `🦶 도루 1위 탈환 가시권!` (§5-5) |
| *통산 마일스톤 임박* | C-T + B | 통산 누적 + 오늘 실시간 합산. 임계: H/K/RBI/R/SB/IP=100단위 직전, HR/W/SV/HLD/2B/3B=50단위 직전. *예측형*(타자 안타/홈런/타점·투수 K)은 타석 진입 시 mount, *결과형*(도루)은 출루 직후. 표기 `🎯 이번 안타 시 통산 N달성!` (§5-5) |

### 4-2. 🟡 재집계 가능 (Phase 2)

| 항목 | 출처 | 추가 비용 |
| --- | --- | --- |
| 최근 10경기 hot/cold | E | 다게임 누적 집계 (일배치 또는 view) |
| 시즌 H2H 매치업 (이 투수 vs 이 타자) | E | game-events 재집계. 5/9 이후 누적분만 |
| 연속 안타·출루 게임 | E | 매일 누적 스캔 cron |
| 작년 동일 시점 페이스 비교 | C/C-S 스냅샷 누적 | 일자별 시즌 스냅샷 ingest 필요 (신규 cron) |

### 4-3. 🔴 미확보 (현 시점 불가)

| 항목 | 막힌 사유 |
| --- | --- |
| WPA / 득점기여도 | outcome 확률 모델 필요 (자체 학습) |
| 구종별 분리 | KBO 비공개 |
| 통산 매치업 (수년치) | 과거 game-events ingest + kboId 매핑 정밀화 필요 (Phase 3+) |
| 투수 vs *특정 타자* 통산 매치업 | KBO 공식 페이지 부재 (HitterDetail/Versus.aspx 404 확인), 자체 ingest만 |

> 5/26 갱신:
> - KBO `Situation.aspx`에서 풀 split 풀세트 발견 — 좌/우·만루·아웃카운트별 🟢 승격, 자체 pitch outcome 재집계 불요
> - *카운트별·이닝별·타순별*은 의미 약함 / UX 과부하 사유로 v1 미사용 (Phase 2 이후에도 명시 요청 시에만 검토)
> - *아웃카운트별*은 *2아웃 행만* 사용 (0/1아웃 행은 데이터는 있지만 노출 X — clutch 컨텍스트가 핵심)

## 5. 오류 가드 (구현 의무)

### 5-1. 식별

- 선수 식별은 *kboId 단독*. name 매칭 절대 금지 (동명이인 27그룹 known).
- name → kboId 매핑은 `players-roster.json` SSOT 통해서만. 매핑 실패 = 해당 행 숨김.

### 5-2. Cross-source 검증

- v1 살림 5라인은 *KBO 단일 출처* (Basic + Situation) — 동일 항목 다출처 비교 대상 없음
- 대신 *KBO 응답 자체*의 ASP.NET 에러 HTML detect 가드 모든 fetch에 적용 (`looksLikeAspNetError`)
- 노히터 판정은 *수비 팀 전체 pitcher rows H 합산*으로 처리 (현재 투수 개인 row만 보면 구원투수 false positive). 팀 합산 H = 0일 때만 노히터 라인 발화

### 5-3. Staleness

- 박스 컴포넌트는 마지막 fetch ts를 기록. `now - ts > 60s` → 값을 *유지하지 말고* "갱신중" pill로 swap.
- 시즌 값(C)은 1h 캐시지만 박스 단위 staleness는 5min을 임계로 (시즌 값 자체는 1h 변동 작음, 박스의 *다른 라이브 라인*과 같은 staleness 정책 적용해야 일관됨).

### 5-4. 표본 가드

- 모든 split 행은 표본 N < 임계 시 *그 행 숨김*. 임계값(`AB` 또는 `BF`):
  - 만루: ≥ 5타석 (만루 자체가 희소 — 너무 높이면 시즌 내내 미노출 가능)
  - 득점권(2/3루): ≥ 10타석
  - 좌/우 상대 split: ≥ 30타석
  - 2아웃: ≥ 20타석
  - 최근 10경기 hot/cold: 실제 출장 10경기 채워진 경우만
  - 임박 마일스톤: 잔여 ≤ 5 (안 채워지면 라인 자체 미노출)

### 5-5. 마일스톤·트리거 시점

#### 결과 확정형 (boxscore 확정 후)
- *boxscore가 확정 갱신된 직후*에만 트리거 (홈런/3루타 등 이벤트 type이 확정으로 push 된 이후).
- 진행 중 추정 ("이번 타석 홈런이면 30HR 도달") 노출 금지 — 사실 확정 후에만 표시.
- 사이클링/노히터처럼 "임박" 자체가 핵심인 항목은 *조건 만족 직후*에 표시 (예: 2루타·3루타·홈런 완료 후 1루타만 남으면 표시).
- **노히터는 7회 이후 + *팀 합산 H=0* 시만 노출** — 경기 초반은 흔하고 진폭 잃음 + 야구 관습. *현재 투수 개인 H가 아니라 수비 팀 전체 pitcher rows의 H 합산*을 봐야 구원투수 false positive 방지
- **퍼펙트 게임은 v1 비포함** — KBO BoxScore에 HBP/실책출루 명시 컬럼이 없어 BF cross-check 단일 신호로는 회귀 위험 잔존 (말 공격 BF 계산 오산 등). 보수적으로 v1에서는 *노히터까지만*. 직접 HBP/실책 데이터 확보 후 v2 검토

#### 진행 상태형 (게임 라이브 이벤트 직후)
- **전타석 안타**: 매 타석 결과 push 후 `AB ≥ 2 AND H == AB` 재계산. 다음 타석 진입 시 mount. 아웃(K/inplay out/병살/희생타) 발생 즉시 unmount.
- **전타석 출루**: 동일 패턴, `PA ≥ 2 AND (H+BB+HBP) == PA`. 수식 자체가 모든 PA에서 출루를 요구하므로 *중간 아웃 1번이라도 발생 시 자동 무효* (별도 연속 가드 불요). 전타석 안타 발동 시 suppress (강한 서사가 약한 서사 흡수).
- **개인 다타점**: 오늘 RBI ≥ 3 갱신 시 mount. 경기 종료까지 유지. 추가 RBI 갱신 시 숫자 swap.
- **연속 무사사구 K**: 매 K 후 trailing run 누적. 5K 이상이면 mount. K 외 결과(H/BB/HBP/inplay out) 발생 시 unmount + run 리셋.
- **도루 임박**: 트리거 시점은 *주자가 베이스에 진입한 순간*만. (a) 자력 출루(H/BB/HBP) push 시 또는 (b) BoxScore runner sub event(대주자 교체) push 시 — kboId 기반 매핑. 시즌 SB(C) + 도루 랭킹(C-R) 조회 → 라운드 OR 1위 탈환 게이트 평가. 게이트 통과 시만 mount. 도루 성공/실패/주자 진루 종료/이닝 종료 시 unmount.
- **통산 마일스톤 임박**:
  - C-T(Total.aspx) 통산 + 오늘 실시간(B) 합산 → 라운드 임계 직전(잔여 ≤ 1)이면 트리거 후보.
  - *예측형* (타자 안타/홈런/타점 · 투수 K): 해당 결과 직전 타석 진입 시 mount. "이번 N 시 통산 X 달성" 표기. 결과(안타/아웃/이닝 종료) 발생 즉시 unmount.
  - *결과형* (도루): 도루 트리거와 동일하게 출루 직후 mount.
  - 결과형 즉시 결정 가능한 경우(투수 K 누적 등) 매 이벤트 후 갱신.

#### 데이터 staleness
- 트리거 라인의 라이브 카운트(전타석/연속K/RBI)는 staleness 적용 X — 박스 단위 60s 가드에 종속.
- 통산 마일스톤은 Total.aspx 1h 캐시 + 도루 1위 카운트도 1h 캐시. stale > 1h → 트리거 자체 fail-closed.

### 5-6. 컨텍스트 게이트 (값 자체는 있지만 *상황에 맞을 때만* 노출)

- **RISP 타율** = 주자 2루 또는 3루 점유 시에만 노출. KBO `GetKboGameList`의 `B2_BAT_ORDER_NO > 0 || B3_BAT_ORDER_NO > 0` 체크. 주자 없음/1루 단독은 컨텍스트 미스 → 미노출.
- **PH-BA(대타 시 타율)** = 현재 타자가 *대타*로 들어왔을 때만 노출. KBO boxscore position 코드 `posRaw.startsWith("타")` 또는 `isSubstitute=true && 첫 타석` 체크. 정규 타자에게 노출하면 무의미.
- **좌/우 split (반대편 매칭)** = 현재 타석의 *상대 손잡이* 행만 노출. 우타자 타석 → 투수의 "vs 우타자" 행만. 좌타자 타석 → 투수의 "vs 좌타자" 행만. 동일 손잡이 행 노출 금지 (관전 의미 없음). 손잡이 정보는 `players-roster.json`의 `batSide`/`throws`(혹은 boxscore 표기 "우투우타") 기반. 매핑 실패 시 행 숨김.
- **만루 split** = 만루 상황(`B1>0 && B2>0 && B3>0`)일 때만 노출. RISP 게이트의 강화판.
- **2아웃 split** = *아웃카운트가 2일 때만* 노출 (Table 5의 "2아웃" 행). 0/1아웃은 미사용 — clutch 컨텍스트만 가치 있음.
- 컨텍스트 게이트 실패 = 그 라인만 숨김 (박스는 살아남음, fail-closed §5-7 적용).
- *상태 변화 시 즉시 swap*: 주자·카운트·아웃이 바뀌면 해당 라인 *즉시 갱신* (라이브성 보장).

### 5-7. fail-closed

- 컴포넌트 트리 (트리거 라인 → 평시 라인 순):
  ```
  <ContextStatsBox>
    ├ <NoHitterLine />                  // 7회 이후 + 팀 합산 H=0
    ├ <AllAtBatsHitLine />              // AB≥2 AND H==AB
    ├ <AllAtBatsOnBaseLine />           // PA≥2 AND H+BB+HBP==PA (안타 라인 발동 시 suppress)
    ├ <StolenBaseImminentLine />        // 출루 직후 + 라운드 OR 1위 탈환
    ├ <MultiRBILine />                  // 오늘 RBI≥3
    ├ <ConsecutiveKLine />              // 연속 K≥5
    ├ <CareerMilestoneLine />           // 통산 + 오늘 합산이 라운드 직전
    ├ <SeasonMilestoneLine />           // 시즌 마일스톤 임박
    ├ <CycleHitImminentLine />          // 사이클링 임박
    ├ <VsHandLine />                    // 매치업 상대 손잡이 행만
    ├ <BasesLoadedLine />               // 만루 상황
    ├ <RispLine />                      // 2/3루 점유
    ├ <TwoOutsLine />                   // outs=2
    └ <PhBaLine />                      // 대타 첫 타석
  </ContextStatsBox>
  ```
- 트리거 라인은 동시 발동 시 위에서 아래로 최대 3줄 노출 (스크롤 X). 트리거 라인 노출 후 잔여 슬롯에 평시 라인 채움.
- 모든 라인이 null이면 `<ContextStatsBox>` 자체가 `return null`. 빈 박스/skeleton 노출 금지.
- 출처 API 자체 down(`/api/game-relay` 500 등) = 박스 전체 unmount.

## 6. PR 시리즈

| PR | 범위 | 게이트 |
| --- | --- | --- |
| **PR1** | `/api/contextual-stats?gameId=` 어댑터 — A/B/C/*C-S* 병렬 fetch + §5 가드 적용 + cross-check + split row 매칭 로직 (v1 사용: Table 0 만루행 · Table 4 좌우행 · Table 5 2아웃행 · Basic의 RISP/PH-BA) | unit: 매핑 실패·stale·cross-mismatch·split row 미매칭 각각 null 반환 검증 |
| **PR2** | `<ContextStatsBox>` UI — 평시 5라인(좌/우·만루·RISP·2아웃·PH-BA) 컨텍스트 게이트 통과한 것만 mount + 트리거 라인 7종(노히터·전타석안타·전타석출루·도루임박·다타점·연속K·통산마일스톤). C-T(Total.aspx)·C-R(도루랭킹) 신규 파서 추가. fail-closed: 0건이면 박스 전체 unmount | Playwright: 박스 mount/unmount 시나리오 (정상·결측·stale·컨텍스트 미일치 0건). 트리거 픽스처(각 7종). 실기기 확인은 자동화 외 |
| **PR3** | 시즌 마일스톤·사이클링 잔여 트리거 + 트리거 동시 발동 우선순위 회귀 테스트 | 시뮬 트리거 픽스처. 진행 중 추정 노출되지 않는지 회귀 테스트 |
| **PR4** | 재집계(만루/RISP·좌우 OPS·최근 10경기) — Phase 2 진입 시 분리 스펙 | view/cron 추가, 표본 N 가드 적용 |

> 각 PR은 *독립 push 승인* 필요 ([[feedback_push_every_change]] 룰). 머지 게이트는 자동화 테스트 통과로만 ([[feedback_no_repeated_qa_requests]]).

## 7. 노션 SSOT 동기

- 이 spec은 노션 페이지 `기획-스펙/크관 상황별 맞춤 스탯 박스 v1`로 미러링.
- 동기 방향: *repo → 노션* (이 파일이 SSOT). 노션 편집 → repo PR로 역전사.
- 동기 주체: PR1 머지 시점 `obsidian-cli notion sync`로 일괄 (수동).

## 8. 삼순이 리뷰 게이트

- 이 스펙 머지 *전에* 삼순이 리뷰 ping 1회 (스펙 단계).
- 코드 머지 *전에* 삼순이 리뷰 ping 추가 1회 (PR1 push 시 자동).
- 양쪽 NO-GO 시 §5 가드 강화 또는 항목 축소로 대응.

## 9. 비포함 (out of scope, v1)

- 통산 *매치업* (수년치 H2H) — Phase 3 (통산 *마일스톤*은 v1 포함, C-T 신규 파서로)
- WPA / 득점기여도 — 별도 모델 학습 필요
- 카운트별 / 구종별 — 출처 미공개
- 작년 동일 시점 페이스 — 일자별 시즌 스냅샷 ingest 신규 cron 후 도입
- 채팅방 별 개인화 (응원팀 기준 강조 등) — UI 확정 후 별 PR
- 퍼펙트 게임 — HBP/실책 출루 명시 컬럼 미확보, 노히터까지만 (§5-5)
