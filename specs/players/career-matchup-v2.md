# 투타 통산 맞대결 V2 — 누적 저장 + 조회

> 출처: #product 고객 건의(2026-06-24). V1(라이브 현재 타석 노출, PR #438 머지)의 후속.
> 하린아빠 결정: (c) 둘 다 노출 / forward-only 백필 / "통산 맞대결" 표기.

## 배경

V1은 네이버 문자중계 relay 최상위 `pitcherVsBatterCareerStats`(전 시즌 누적 통산 공식 수치)를
*현재 타석 한정*으로 라이브 노출한다. V2는 이 값을 **누적 저장**해서, 경기 중이 아니어도
임의의 (투수, 타자) 페어 통산 맞대결을 **조회/브라우즈**할 수 있게 한다.

핵심 사실(실측):
- relay `currentGameState.pitcher` / `currentGameState.batter` = 현재 타석 **pcode 직접 제공**.
- `pitcherVsBatterCareerStats` = 그 페어의 전 시즌 누적 통산("3타수 1안타 1홈런 .333" / 없으면 "첫 맞대결").
- relay `homeLineup`/`awayLineup`(batter[]) · `homeEntry`/`awayEntry`(pitcher[])에 `pcode`+`name` 매핑 존재.
- 값이 누적이므로 **한 번만 잡혀도 완전한 통산값** → 매 경기 raw 백필 불필요(forward-only).

## 비목표 (YAGNI)

- 과거 시즌 전수 백필(작업량 큼, 누적값이라 불필요). 출시 후 맞붙는 페어부터 자연 누적.
- 우리가 직접 타석단위 계산(네이버 공식값을 그대로 캡처하므로 불필요).
- 투수 자력 귀속 추론(currentGameState가 pcode를 직접 주므로 불필요).

## 데이터 모델

`pitcher_batter_matchup` (신규 테이블, migration `supabase/migrations/`):

| 컬럼 | 타입 | 비고 |
|---|---|---|
| pitcher_kbo_id | text | 해석된 kboId (PK 일부) |
| batter_kbo_id | text | 해석된 kboId (PK 일부) |
| pitcher_name | text | 표시용 denormalized |
| batter_name | text | 표시용 denormalized |
| ab | int | careerLine 파싱(타수) |
| hits | int | 안타 |
| hr | int | 홈런 |
| avg | numeric | 타율(.333) |
| raw_line | text | 원문("3타수 1안타 1홈런 .333") |
| last_game_id | text | 마지막 캡처 게임 |
| updated_at | timestamptz | upsert 시각 |

- PK = (pitcher_kbo_id, batter_kbo_id). upsert로 **최신 스냅샷 유지**.
- RLS: 공개 SELECT 허용(읽기 전용 통계), 쓰기는 service_role만.
- "첫 맞대결"/파싱 실패/kboId 미해석 페어는 **저장 스킵**(저장할 통산값 없음).

## 캡처 파이프라인 (Slice 1)

호스트 = 기존 `game-events-warmup` cron(매분 라이브게임 순회). 별도 폴러 없음.

`src/lib/matchup/capture.ts`:
1. live 게임별 relay(`/schedule/games/{naverGameId}/relay?inning=1`) fetch — V1과 동일 엔드포인트.
   warmup이 이미 game-events를 self-fetch하므로 relay만 추가 fetch(게임당 1회/분).
2. `currentGameState.pitcher`/`batter` pcode 추출.
3. relay lineup/entry 배열에서 pcode→name + 소속(home/away)→teamId 매핑.
4. `resolveRosterPlayer({name, teamId})` → kboId. 미해석 시 스킵.
5. `pitcherVsBatterCareerStats` 파싱(`parseCareerLine`): 정규식 `(\d+)타수 (\d+)안타 (\d+)홈런 \.?(\d+)`.
   "첫 맞대결"/미매칭 → 스킵.
6. `(pitcher_kbo_id, batter_kbo_id)` upsert(ON CONFLICT DO UPDATE, raw_line/ab/.../updated_at 갱신).

비차단: 캡처 실패는 warmup 본 기능(알림)에 영향 주지 않게 try/catch 격리. 결과는 로깅만.

검증(S1 완료 기준): 라이브 경기 1개에서 warmup 1틱 후 `pitcher_batter_matchup`에 행 ≥1,
raw_line이 네이버 원문과 일치, kboId가 roster와 일치.

## 조회 — Slice 2 (선수 페이지)

`community/players/[playerId]` 에 "통산 맞대결" 섹션:
- 타자 페이지 → 이 타자가 상대한 투수별 통산(상대 다수, ab desc 정렬).
- 투수 페이지 → 이 투수가 상대한 타자별 통산.
- 데이터 없으면 섹션 숨김(빈 상태 노출 안 함).
- 읽기 = `/api/matchup?kboId=...&role=batter|pitcher`(공개 SELECT).

## 조회 — Slice 3 (경기 스플릿/프리뷰)

경기 화면에 "오늘 선발 vs 상대 라인업 통산표":
- 양 선발투수 kboId × 상대 라인업 타자 kboId 페어를 테이블에서 조회.
- 캡처 누적 전엔 빈칸 많음(초기 커버리지 낮음 — 알려진 트레이드오프). 잡힌 페어만 표기.
- "첫 맞대결"/미보유는 `–` 또는 "기록 없음".

## 표기 / 카피

- 라벨 "통산 맞대결"(네이버 공식 누적 수치 확정). V1과 동일 카피 일관.
- forward-only 특성상 초기 커버리지 낮음 → 마케팅은 누적 후.

## 슬라이스 / 머지 게이트

각 슬라이스 = 독립 PR(삼식 구현 → 삼순 리뷰 GO → 하린아빠 승인 → 머지 → End-User QA).
- S1: migration + 캡처 + 최소 read 헬퍼. (UI 없음, 데이터 스파인)
- S2: 선수 페이지 섹션 + `/api/matchup`.
- S3: 경기 선발 vs 라인업 표.
