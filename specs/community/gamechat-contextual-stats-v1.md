# 크관(GameChat) 상황별 맞춤 스탯 박스 v1

- **등록일**: 2026-05-26
- **상태**: 스펙 초안 (Phase 1 항목 확정 전, 삼순이 리뷰 대기)
- **출처**: 하린아빠 — "문자중계와 채팅 사이에 박스 하나, 해당 타석 관련 흥미 스탯을 최대한, 단 오류 가능성은 철저히 배제" (#product 스레드 `1779791186.377619`)
- **PR 시리즈**: PR1 데이터 어댑터(가드 포함) → PR2 UI 박스(살림 5라인 컨텍스트 통과만 mount) → PR3 트리거 라인(노히터 진행 등) → PR4 재집계(최근 10경기, H2H 등 Phase 2 진입 시)

> 🔒 **머지 게이트 (오류 배제 원칙)**
> 1. `kboId` 단독키. name 매핑 실패 → 그 행만 숨김(박스 전체 X)
> 2. 응답 stale > 60s → "갱신중" 표시. 옛 값 노출 금지
> 3. 재집계 표본 N < 임계 → 항목 숨김 ("1/2 .500" 노이즈 차단)
> 4. 마일스톤 = boxscore 확정 시점에만 트리거. 진행 중 추정값 금지
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
| D | KBO `GetKboGameList` | ~15s 폴링 | 실시간 BSO 카운트, 주자 점유, 현재 투수/타자 |
| E | Supabase `game_event_state.event_history` | 폴링 누적 | 타석/주자/이닝 단위 누적 이벤트 (5/9 cumulative semantic key 적용 이후 신뢰) |

> 외부 API는 전부 비공식 — `Referer: koreabaseball.com` 필수, User-Agent 명시 (5/20 referer drift 사고 [[postmortem-2026-05-20-kbo-api-referer-drift]]).

## 4. 항목별 feasibility

### 4-1. 🟢 즉시 가능 (Phase 1)

| 항목 | 출처 | 비고 |
| --- | --- | --- |
| 시즌 RISP (타자) | C-S Table 0 | 주자 2/3루 점유 시에만 노출 (§5-6). *batter-only*. 투수 RISP는 실제 AB denominator 미확보로 v1 숨김 |
| 시즌 PH-BA (타자) | C | 현재 타자 *대타*일 때만 노출 (§5-6). 투수 측 동치(KBO에 대타 상대 피안타율 컬럼) 부재 — *batter-only* |
| *좌/우 상대 split* (타자 vs 좌·우투수 / 투수 vs 좌·우타자) | C-S Table 4 | 현재 매치업 손잡이에 *반대편 행만* 노출 (§5-6). *batter·pitcher 페어* — 우타자×좌투수 매치업이면 투수 "vs 우타자" + 타자 "vs 좌투수" 동시 |
| *만루 타율* (타자) / *만루 피안타율* (투수) | C-S Table 0 | 만루 상황일 때만 노출 (§5-6). *batter·pitcher 페어*. RISP 게이트 강화판 |
| *2아웃 AVG* (타자) / *2아웃 피안타율* (투수) | C-S Table 5 *2아웃 행만* | 현재 *2아웃*일 때만 노출 (§5-6). *batter·pitcher 페어*. 0/1아웃 행은 평시 미사용 |
| 이번 경기 타석 시퀀스 (1타석 1루타, 2타석 삼진…) | A | inning relay에서 batterName 매칭 |
| 사이클링 임박 (3루타/홈런만 남음 등) | A | 시퀀스에서 1B/2B/3B/HR 체크 |
| 노히트/퍼펙트 진행 | B | 투수 박스 H=0, BB=0 추적. *7회 이후에만 노출* (§5-5) |
| 시즌 마일스톤 임박 (100타점 · 30HR · 100K · 200K 등) | C | 잔여 N 표시, 확정 시점에만 |

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
>
> 5/27 갱신 (페어 노출 확장):
> - PR #118/#126 머지 후 운영 관찰 — 평시 라인 5개가 *전부 batter-only*라 *투수 컨텍스트 누락* + 박스 비노출 빈도 추정 ~50%
> - vsHand·만루·2아웃 3개를 *batter·pitcher 페어*로 변환. RISP·PH-BA는 denominator/컬럼 미확보 사유로 batter-only 유지
> - 매칭 기회가 늘어 박스 비노출 빈도 자연 감소 예상

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
  - 득점권(2/3루): 타자 ≥ 10타석. 투수 RISP는 실제 AB denominator 미확보로 v1 숨김
  - 좌/우 상대 split: ≥ 30타석
  - 2아웃: ≥ 20타석
  - 최근 10경기 hot/cold: 실제 출장 10경기 채워진 경우만
  - 임박 마일스톤: 잔여 ≤ 5 (안 채워지면 라인 자체 미노출)

### 5-5. 마일스톤 트리거 시점

- *boxscore가 확정 갱신된 직후*에만 트리거 (홈런/3루타 등 이벤트 type이 확정으로 push 된 이후).
- 진행 중 추정 ("이번 타석 홈런이면 30HR 도달") 노출 금지 — 사실 확정 후에만 표시.
- 사이클링/노히터처럼 "임박" 자체가 핵심인 항목은 *조건 만족 직후*에 표시 (예: 2루타·3루타·홈런 완료 후 1루타만 남으면 표시).
- **노히터는 7회 이후 + *팀 합산 H=0* 시만 노출** — 경기 초반은 흔하고 진폭 잃음 + 야구 관습. *현재 투수 개인 H가 아니라 수비 팀 전체 pitcher rows의 H 합산*을 봐야 구원투수 false positive 방지
- **퍼펙트 게임은 v1 비포함** — KBO BoxScore에 HBP/실책출루 명시 컬럼이 없어 BF cross-check 단일 신호로는 회귀 위험 잔존 (말 공격 BF 계산 오산 등). 보수적으로 v1에서는 *노히터까지만*. 직접 HBP/실책 데이터 확보 후 v2 검토

### 5-6. 컨텍스트 게이트 (값 자체는 있지만 *상황에 맞을 때만* 노출)

- **RISP 타율** = 주자 2루 또는 3루 점유 시에만 노출. KBO `GetKboGameList`의 `B2_BAT_ORDER_NO > 0 || B3_BAT_ORDER_NO > 0` 체크. 주자 없음/1루 단독은 컨텍스트 미스 → 미노출.
- **PH-BA(대타 시 타율)** = 현재 타자가 *대타*로 들어왔을 때만 노출. KBO boxscore position 코드 `posRaw.startsWith("타")` 또는 `isSubstitute=true && 첫 타석` 체크. 정규 타자에게 노출하면 무의미.
- **좌/우 split (반대편 매칭, 페어)** = 현재 타석의 *상대 손잡이* 행을 *양쪽* 노출.
  - 우타자 × 좌투수 매치업 → 투수의 "vs 우타자" 행 + 타자의 "vs 좌투수" 행 동시
  - 좌타자 × 우투수 매치업 → 투수의 "vs 좌타자" 행 + 타자의 "vs 우투수" 행 동시
  - 동일 손잡이 행 노출 금지 (관전 의미 없음).
  - 손잡이 정보는 KBO `Basic.aspx` 프로필 "포지션:(우투우타)" 파싱 (handedness-parser). 매핑 실패 시 *그 쪽 행만* 숨김 — 한쪽이라도 매핑되면 라인 살아남음.
- **만루 split (페어)** = 만루 상황(`B1>0 && B2>0 && B3>0`)일 때만 노출. *타자 만루 타율* + *투수 만루 피안타율* 동시. RISP 게이트의 강화판.
- **RISP split (batter-only)** = 2/3루 점유 시 *타자 RISP 타율*만 노출 (Table 0의 RISP 행 집계, situation-parser `aggregateRisp`). 투수 Situation Table 0에는 실제 AB가 없어 H+BB+SO proxy로 AVG 재계산 금지. 실제 denominator 확보 전까지 투수 RISP 피안타율은 숨김.
- **2아웃 split (페어)** = *아웃카운트가 2일 때만* 노출 (Table 5의 "2아웃" 행). *타자 2아웃 타율* + *투수 2아웃 피안타율* 동시. 0/1아웃은 미사용 — clutch 컨텍스트만 가치 있음.
- **페어 한쪽 결측 처리**: 한쪽(예: 신인 투수 표본 30 미만)이 게이트 실패해도 *다른 한쪽이 통과하면* 라인은 살아남음 (single-side fallback). 둘 다 실패 시 라인 숨김.
- 컨텍스트 게이트 실패 = 그 라인만 숨김 (박스는 살아남음, fail-closed §5-7 적용).
- *상태 변화 시 즉시 swap*: 주자·카운트·아웃이 바뀌면 해당 라인 *즉시 갱신* (라이브성 보장).

### 5-7. fail-closed

- 컴포넌트 트리:
  ```
  <ContextStatsBox>
    ├ <NoHitterLine />     // 7회 이후 + 팀 합산 H=0
    ├ <VsHandLine />       // 매치업 상대 손잡이 행 (batter+pitcher pair)
    ├ <BasesLoadedLine />  // 만루 상황 (batter+pitcher pair)
    ├ <RispLine />         // 2/3루 점유 — Situation 집계 (batter+pitcher pair)
    ├ <TwoOutsLine />      // outs=2 (batter+pitcher pair)
    └ <PhBaLine />         // 대타 첫 타석 (batter-only)
  </ContextStatsBox>
  ```
- 모든 라인이 null이면 `<ContextStatsBox>` 자체가 `return null`. 빈 박스/skeleton 노출 금지.
- 출처 API 자체 down(`/api/game-relay` 500 등) = 박스 전체 unmount.

## 6. PR 시리즈

| PR | 범위 | 게이트 |
| --- | --- | --- |
| **PR1** | `/api/contextual-stats?gameId=` 어댑터 — A/B/C/*C-S* 병렬 fetch + §5 가드 적용 + cross-check + split row 매칭 로직 (v1 사용: Table 0 만루행/RISP 집계 · Table 4 좌우행 · Table 5 2아웃행 · Basic의 PH-BA) | unit: 매핑 실패·stale·cross-mismatch·split row 미매칭 각각 null 반환 검증 |
| **PR2** | `<ContextStatsBox>` UI — 살림 5라인(좌/우·만루·RISP·2아웃·PH-BA) 컨텍스트 게이트 통과한 것만 mount. fail-closed: 0건이면 박스 전체 unmount | Playwright: 박스 mount/unmount 시나리오 (정상·결측·stale·컨텍스트 미일치 0건). 실기기 확인은 자동화 외 |
| **PR3** | `<HighlightLine>` — 사이클링·노히터·마일스톤 임박 트리거 | 시뮬 트리거 픽스처. 진행 중 추정 노출되지 않는지 회귀 테스트 |
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

- 통산 매치업 (수년치) — Phase 3
- WPA / 득점기여도 — 별도 모델 학습 필요
- 카운트별 / 구종별 — 출처 미공개
- 작년 동일 시점 페이스 — 일자별 시즌 스냅샷 ingest 신규 cron 후 도입
- 채팅방 별 개인화 (응원팀 기준 강조 등) — UI 확정 후 별 PR
