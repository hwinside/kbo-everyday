# 회원 레벨 / 랭킹 (명예의 전당) V1 — Spec

> 작성: 삼식이 (2026-06-08) · 스레드: #marketing "회원 레벨/랭킹 시스템 V1"
> 선행: `specs/leaderboard-v1.md` (이벤트 리더보드) — 그 점수 체계를 상시 시스템으로 승격
> 결정권: 하린아빠(방향) + 삼순이(코드/구조 리뷰)

---

## 1. 배경 / 문제

- 얼리멤버 이벤트 종료 → 점수 체계(`writing-points.ts`)·집계 뷰(`v_leaderboard_writing`)·레벨표(`levels.ts`)·`LevelBadge`는 코드에 이미 존재하나 **상시 시스템으로 노출되지 않음**.
- `ProfileCard`는 `level={15}` 하드코딩 + `profile.points` 미연결 → 레벨이 실점수와 무관하게 표시됨.
- `levels.ts` 임계값(0~5000pt, 30레벨)은 실데이터 검증 전 임의값 → 활동 유저 99%가 평생 Lv1~4에 갇히는 곡선.
- 리더보드를 **"명예의 전당"**으로 정식 명명하고 마이페이지에서 상시 노출 필요.

## 2. 확정된 결정 (스레드, 2026-06-06~08)

| 항목 | 결정 |
|------|------|
| 레벨 성격 | **영구 누적** (lifetime, 절대 하락 없음) |
| 시즌 랭킹 | **월별**(매월 1일 0시 KST 기준 파티션), 누적 랭킹과 별도 탭 |
| 리더보드 명칭 | **명예의 전당** (페이지/리더보드 이름) |
| 점수 체계 | `writing-points.ts` 그대로 (채팅1·댓글2·글3·사진5·좌석팁+10·티켓+30, 일일 합산캡 200) |
| 일일캡 | 200 유지 (어뷰징 방지) |
| 봇/내부자 | 기존 `leaderboard_internal_user_ids()` 제외 그대로 |

### 2.1 레벨 곡선 (8티어 — 삼순 임계값 + 하린아빠 명칭)

실측 분포(활동 240명, 중앙값 3pt / p90 20 / p95 49 / p99 182 / 최고 1027)에 백분위로 맞춤. 초반 보상 간격을 좁히고 상위 희소성은 400pt 이후에서 확보.

| 레벨 | 티어명 | 진입 임계값(누적 pt) | 색/뱃지 |
|------|--------|------------------|---------|
| 1 | 루키 | 0 | 🟤 `#8B6914` |
| 2 | 레귤러 | 5 | 🔵 `#007AFF` |
| 3 | 올스타 | 20 | 🟣 `#AF52DE` |
| 4 | 골든글러브 | 50 | 🟡 `#FFD60A` |
| 5 | MVP | 150 | 🔴 `#FF453A` |
| 6 | 영구결번 | 400 | 💎 `#64D2FF` |
| 7 | 레전드 | 800 | 🟠 `#FF9F0A` |
| 8 | GOAT | 1500 | 👑 `#FFD700` |

- 리더보드명("명예의 전당")과 최상위 티어명(GOAT)이 분리 → UX 혼동 없음.
- 첫 레벨업 컷 5pt(댓글 2~3개/글 1~2개)로 64% 몰린 1~4pt 구간이 즉시 윗칸이 보임.

## 3. 성공 기준 (Goal-Driven)

| # | 기준 | 검증 |
|---|------|------|
| G1 | 레벨은 `v_leaderboard_writing.total_points`(lifetime)로 산정, 하드코딩 제거 | 코드 + 실유저 점수↔레벨 일치 |
| G2 | `levels.ts` 8티어로 교체, 다운스트림 소비처 무회귀 | `tsc` + 소비처 grep 감사 |
| G3 | 마이페이지 ProfileCard에 실레벨/실점수/다음 레벨까지 노출 | End-User QA (로그인 유저) |
| G4 | "명예의 전당" 페이지 = 월별 랭킹(기본) + 누적 랭킹 탭 | UI + 실유저 본인 순위 표시 |
| G5 | 월별 랭킹 = 해당 월 활동만 집계, 과거 월 조회(아카이브) 가능 | `month` 파라미터 쿼리 |
| G6 | 변경 최소화 (Surgical) — 기존 이벤트 리더보드 경로 무파손 | `git diff --stat` 범위 리뷰 |

## 4. 데이터 레이어

### 4.1 누적(영구) — 기존 재사용, 신규 없음
- SSOT = `v_leaderboard_writing` (이미 lifetime·일일캡 200·봇 제외).
- API `/api/leaderboard/writing?limit=N` (Top N), `/api/leaderboard/my-rank?track=writing` (본인 순위+점수) **그대로 사용**.
- 레벨 = `getLevelForPoints(total_points)`.

### 4.2 월별 — 신규 뷰 1개
- 신규 마이그레이션 `supabase/migrations/<date>_leaderboard_monthly_view.sql`.
- `v_leaderboard_writing_monthly(user_id, month_start date, nickname, team_id, monthly_points int, last_active_day date)`.
- `v_leaderboard_writing`와 **동일 daily-capped CTE 재사용**하되 마지막 집계만 `month_start = date_trunc('month', day)` 로 GROUP BY (user_id, month_start).
- 일일캡 200은 월 경계와 무관하게 day 단위로 그대로 적용 (월 합산캡 없음).
- 리셋 = 파괴적 리셋 아님. 각 월이 독립 파티션 → "이번 달" = 현재 month_start 필터, 과거 월 = 아카이브 조회.
- `GRANT SELECT TO anon, authenticated`.

### 4.3 신규 API
- `GET /api/leaderboard/monthly?month=YYYY-MM&limit=N` → 해당 월 Top N (`month` 생략 시 현재 월/KST).
- `GET /api/leaderboard/my-rank?track=writing&month=YYYY-MM` → `month` 있으면 월별 뷰 기준 본인 순위 (기존 라우트에 month 분기 추가, 누적은 기존 동작 유지).

## 5. UI

### 5.1 ProfileCard (마이페이지)
- `level={15}` 하드코딩 제거 → `getLevelForPoints(points)`.
- 점수 출처 = `/api/leaderboard/my-rank?track=writing` 의 `score` (뷰 기준). `profile.points` 컬럼에 의존하지 않음(드리프트 방지).
- 표시: 티어명 + Lv.N + 누적 점수 + 다음 레벨까지 남은 점수(progress). 비로그인은 기존 문구 유지.
- "명예의 전당" 진입 CTA 추가 (ProfileCard 하단 또는 마이페이지 섹션).

### 5.2 명예의 전당 페이지
- 위치: `src/app/(main)/my/hall-of-fame/` (또는 마이페이지 내 라우트). 마이페이지에서 진입.
- 탭 2개: **이번 달 랭킹(기본)** / **누적 랭킹**.
  - 이번 달 = `/api/leaderboard/monthly` (현재 월).
  - 누적 = `/api/leaderboard/writing`.
  - 월별 탭에 과거 월 선택(드롭다운/스와이프)으로 아카이브 조회.
- 각 행: 순위 · 닉네임 · 팀뱃지 · 점수 · (누적 탭) 레벨뱃지.
- 상단: 내 순위/내 점수/다음 레벨까지 (my-rank).

### 5.3 레벨업 토스트 (선택, 슬라이스 5)
- 기존 `badge-engine`/`BadgeToast` 패턴 재사용. 누적 점수가 다음 티어 임계값을 넘는 순간 토스트.
- V1 필수 아님 — 슬라이스 분리, 시간 되면 포함.

## 6. 빌드 순서 (얇은 수직 슬라이스)

1. **S1 levels.ts 교체** — 8티어 표/`getLevelForPoints` 유지/소비처(grades.ts·player-profiles.ts·Leaderboard.tsx·ProfileCard) 무회귀 감사. (DB 무관, 독립 검증)
2. **S2 ProfileCard 실점수 연결** — my-rank로 실레벨/점수/다음레벨. End-User QA.
3. **S3 월별 뷰 + API** — 마이그레이션 + `/api/leaderboard/monthly` + my-rank month 분기. Management API 적용 후 라이브 검증.
4. **S4 명예의 전당 페이지** — 월별(기본)/누적 탭 + 내 순위. End-User QA.
5. **S5 (선택) 레벨업 토스트**.

각 슬라이스: 구현 → tsc/eslint → 삼순 리뷰 → (필요시) End-User QA → 다음.

## 7. 범위 밖 / V1.5

- 초대 트랙 합산(삼순 "총점에 넣되 활동/초대 breakdown") — V1.5.
- "이번 달 급상승" 탭 — V1.5 (삼순 예약).
- 레벨업 푸시 알림 — 범위 밖.
- 레벨/점수 게이미피케이션 보상(권한·뱃지 외) — 범위 밖.

## 8. 리스크 / 주의

- **분포 단서**: 4.1 누적 점수는 6주 이벤트 burst가 대부분 → 영구 누적이 쌓이면 상위 티어 인구가 늘 것. 임계값은 V1 초기값이며 1~2개월 후 재검토 여지(곡선 자체는 변경 가능, 레벨**명**은 정체성이라 고정).
- **소비처 무회귀** (감사 완료):
  - `levels.ts`(`LEVELS`/`getLevelForPoints`/`LevelData`)의 유일 소비처 = `LevelBadge.tsx`. `LevelBadge`는 ① `ProfileCard`(우리가 연결) ② **예측 Leaderboard `src/components/prediction/Leaderboard.tsx`** 두 곳에서 사용.
  - ⚠️ **회귀 위험**: 예측 Leaderboard는 `<LevelBadge level={entry.level} />` 로 *숫자 레벨*을 직접 전달. 기존 30레벨 → 8레벨 축소 시 `entry.level`이 9~30이면 `LEVELS.find(...)` 미스 → `LEVELS[0]`(루키) fallback 회귀. **S1에서 예측 도메인의 `entry.level` 산출 경로를 반드시 확인** — 활동 레벨표와 같은 `levels.ts`를 쓰는지, 별개 레벨인지 분리 판단. 필요 시 예측 레벨은 독립 상수로 디커플.
  - `LevelData` **필드(level/title/requiredPoints/badge/color)는 유지**, 값만 교체.
  - `grades.ts`는 자체 grade 시스템(별도 `minPoints`, "hof" 8000pt 등)으로 `levels.ts`와 **무관 — 건드리지 않음**.
- **월별 뷰 성능**: 활동 유저 ~240명 규모라 무시 가능. 이후 증가 시 materialized view 검토.
- **`profiles.points` 컬럼**: 존재하더라도 SSOT 아님. 레벨/점수는 뷰 기준으로 통일.
