# 히어로샷 자동 배치 + 매핑검증 v1

> Status: DRAFT (삼순 리뷰 대기)
> Author: 삼식이 | 2026-06-05
> Trigger: 하린아빠 #cs `1780211325.735349` — "다른 소스(네이버 검색)와 대조해서 잘못매핑 방지 + 정기 배치 운영"

## 1. 배경 / 문제

- 현재 roster 804명 중 히어로샷 없는 선수 **55명** (allowlist `hero-approved-kboids.json` = 749명).
- 히어로샷은 `hero-approved-kboids.json`에 kboId가 있는 선수만 노출. 없으면 기본 헤드샷 폴백.
- **매핑 오류 사고 이력**: 가나쿠보 유토(AQ010)에 osen에서 가져온 *다른/깨진 이미지*가 매핑됨 → 잘못된 히어로 노출. AQ/FP(외국인·아시아쿼터) 선수의 **수동 소스 URL**(`update-player-photos.mjs` MANUAL_SOURCE)이 매핑 오류의 주 원인.
- 신규 외국인/콜업이 계속 들어와 히어로 없는 선수는 계속 누적 → **정기 배치 필요**.

## 2. 목표 (Goal-Driven 성공 기준)

1. 히어로 없는 roster 선수를 자동 탐지 → 검증 통과분만 cutout 생성 → allowlist 추가 → **PR 자동 생성 + 자동 머지**.
2. **매핑 오류 0**: 잘못된 사람/깨진 이미지가 히어로로 들어가는 것을 코드로 차단. (검증 게이트 통과 못 하면 skip + 플래그)
3. **맥미니 의존 0**: GitHub Action에서 완결.
4. **완전 무인 운영 (2026-06-05 하린아빠 명시: "내 승인 필요없이 자동으로, 일일이 승인 못함")**:
   - 정기 배치 결과물은 **하린아빠 승인 없이 자동 머지**. 안전은 사람 승인이 아니라 *검증 3중 게이트*가 담보.
   - 검증 통과분 → 자동 반영·자동 머지. 검증 실패/불확실 → 자동 적용 *안 함* + Slack 플래그(알림만, 액션 강제 X).
   - **최초 빌드(배치 인프라 코드 자체)는 삼순 코드리뷰 1회** — 이건 일회성 품질 게이트(하린아빠 부담 아님). 이후 정기 배치는 무인.
   - 핵심 안전 불변식: *검증 미통과 이미지는 절대 자동으로 prod에 나가지 않는다* (조용한 통과 금지).

### 비목표 (v1 범위 밖)
- 기존 749명 히어로의 소급 재검증 (별도 1회성 작업으로 분리 가능).
- 히어로 화질/화각 품질 개선 (cutout v5 스펙 그대로 사용).

## 3. 검증 로직 (핵심 — 잘못매핑 방지)

### 3.1 Ground-truth 앵커
- **KBO 공식 헤드샷** = `https://6ptotvmi5753.edge.naverncp.com/KBO_IMAGE/person/middle/2026/{numericId}.jpg`
- numericId 기준이라 *정의상 다른 사람일 수 없음* → 이게 진실의 기준점.
- AQ/FP 선수는 numericId 매핑(`foreign-id-map.ts`) 경유. numericId 자체가 틀리면 앵커도 틀리므로, 이 케이스만 추가 교차검증 필요(3.2).

### 3.2 독립 소스 교차검증 (네이버)
- 선수명으로 **네이버 이미지 검색**(`"{선수명} {팀명} 야구선수"`) → 상위 후보 N장 수집.
- **Gemini Vision 동일인 대조**: 앵커(KBO 공식 헤드샷) vs 네이버 후보 → "같은 사람인가? confidence 0~1".
- 판정:
  - 앵커가 KBO CDN(numericId) 직링크면 신뢰도 높음 → 네이버 대조는 *보강* (1장이라도 일치하면 통과).
  - 앵커가 수동 URL(AQ/FP osen 등)이면 네이버 대조 **필수** → 임계값 미달 시 거부.
- 임계값: confidence ≥ **0.75** PASS (튜닝 대상). 네이버 후보 과반이 불일치면 거부.

### 3.3 생성 후 재검증
- cutout 생성(`phase2-pipeline.sh`) 후 결과 webp ↔ 앵커 Gemini Vision 동일인 대조.
- 생성 모델이 다른 얼굴을 만들거나 crop이 엉뚱하면 여기서 차단. 미달 시 해당 선수 산출물 폐기 + skip.

### 3.4 실패 처리
- 후보 못 찾음 / 검증 실패 / API 에러 → 해당 선수 **skip** + 사유를 리포트에 기록.
- 배치 종료 후 skip된 선수 목록을 **Slack #cs 알림** (수동 처리 대상).

## 4. 파이프라인 (배치 1회 실행)

```
1. detect       roster ∖ allowlist = 미보유 선수 목록
2. anchor       각 선수 KBO 공식 헤드샷 확보 (없으면 skip+flag)
3. cross-check  네이버 후보 수집 → Gemini Vision 앵커 대조 (3.2) → FAIL이면 skip+flag
4. generate     PASS분만 phase2-pipeline.sh로 cutout 생성 (Nano Banana → remove.bg → face-crop → webp)
5. verify       생성물 ↔ 앵커 재대조 (3.3) → FAIL이면 폐기+skip+flag
6. publish      PASS분 copy-to-hero.sh로 players-hero/ 반영 + allowlist에 kboId 추가
7. merge        브랜치 push → PR 생성 → CI green 확인 후 **자동 머지(squash)** + Slack 요약(생성 N / skip M + 사유)
                skip(검증 실패/불확실) 건은 절대 머지 대상에 포함 안 됨 — 별도 플래그 알림만
8. post-QA      배포 반영 후 추가 선수의 prod `/players/{kbo}.webp` 200 + 앵커 재대조 샘플 QA.
                실패분은 **allowlist에서 해당 kboId 제거하는 자동 롤백 PR 생성 → 자동 머지** + Slack 경고.
```

### 4.1 안전 경로 정리 (삼순 NO-GO 반영 — 잘못된 이미지 자동 노출 차단)
| 단계 | 통과 | 애매/충돌/불명확 | 실패 |
|---|---|---|---|
| cross-check (maxSim) | ≥0.85 → 진행 | 0.5~0.85 → skip + Slack 알림 | <0.5 → skip + Slack 알림 |
| post-gen 재검증 | ≥0.85 → 반영 | — | <0.85 → 산출물 폐기 + skip |
| post-deploy QA | 200 + 재대조 OK → 유지 | — | 실패 → **allowlist 자동 롤백 PR** |

핵심 불변식: *세 게이트 중 하나라도 통과 못 하면 그 선수는 자동으로 prod 노출되지 않는다.* 자동 머지는 "통과" 경로에만 적용.

- 선수별 실패 격리(한 명 실패해도 배치 계속). 기존 `phase2-pipeline.sh` `set -u`(`-e` 제외) 패턴 준수.

## 5. 운영 (GitHub Action)

- 신규 워크플로 `.github/workflows/hero-shot-batch.yml`:
  - `schedule`: 주 1회 (예: 매주 월 새벽). + `workflow_dispatch` 수동.
  - 추가 트리거 검토: roster 변경 PR 머지 후. v1은 주간 cron + 수동으로 시작, roster 연동은 v1.1.
  - `permissions: contents: write, pull-requests: write`.
  - secrets: `GEMINI_API_KEY`(=HERO 키. 기본 키 크레딧 소진 확인됨), `REMOVE_BG_API_KEY` (GH repo secrets 등록 필요 — 하린아빠/운영).
  - 산출물 변경 있을 때만 PR 생성 후 **자동 머지**(`gh pr merge --squash --admin`, branch protection 미설정 환경). changes 게이트는 `update-roster-stats.yml` 재사용.
- **CI 실행 가능성 (스펙 단계 검증 항목)**: cutout의 face-detect-crop 단계가 로컬 파이썬/네이티브 의존이면 CI에 설치 필요. 구현 1단계에서 face-crop 의존성 확인 후, 불가 시 대체(Gemini bbox 또는 sharp 기반 crop)로 전환.

## 6. 변경 파일 (예정)

- 신규: `scripts/hero-batch/verify-identity.mjs` (Gemini Vision 동일인 대조 유틸)
- 신규: `scripts/hero-batch/collect-naver-candidates.mjs` (네이버 이미지 검색 후보 수집)
- 신규: `scripts/hero-batch/run-batch.mjs` (4의 오케스트레이션)
- 신규: `.github/workflows/hero-shot-batch.yml`
- 수정: `scripts/cutouts-v2/phase2-pipeline.sh` (입력 목록을 동적 미보유 목록으로 받도록 — 이미 `INPUT_OVERRIDE` 지원)
- 수정: `src/lib/constants/hero-approved-kboids.json` (배치가 append — sentinel 불필요, 단순 배열)
- 산출물: `public/players-hero/{kboId}.webp`, `public/players-hero-v2/webp/{kboId}.webp`

## 7. 검증/QA (Goal-Driven)

- 단위: `verify-identity.mjs`에 동일인/타인 샘플 케이스(가나쿠보 정답 vs osen 오답) 회귀 테스트 → 오답을 실제로 거부하는지 부정 테스트.
- 배치 dry-run: `--dry-run`으로 55명 대상 검출 + 후보/검증 판정만 출력(생성·커밋 안 함).
- End-User: PR 머지·배포 후 대상 선수 페이지에서 히어로 정상 노출 + 잘못된 얼굴 0 육안 확인.

## 8. 오픈 결정 (하린아빠 — 1차 GO 완료, 세부만)

- ~~대조 엔진 Gemini Vision~~ → GO (오탐 시 face-embedding 추가)
- ~~GitHub Action 운영~~ → GO (CI 실행성은 구현 1단계 검증)
- ~~머지 승인 방식~~ → **완전 자동 머지 GO** (2026-06-05 하린아빠: 승인 없이 자동). 안전은 검증 게이트가 담보, 실패분만 플래그
- 배치 주기: **주 1회** 제안 (변경 필요 시 조정).
- 검증 임계값 0.75: 구현 후 55명 dry-run 결과 보고 튜닝.

## 9. 작업 순서 (Tasks → CHECKPOINT)

1. `verify-identity.mjs` + 회귀 테스트 (가나쿠보 정답/osen 오답)
2. `collect-naver-candidates.mjs`
3. `run-batch.mjs` 오케스트레이션 + `--dry-run`
4. face-crop CI 실행성 검증 → 필요 시 대체
5. `.github/workflows/hero-shot-batch.yml`
6. 55명 dry-run → 임계값 튜닝 → 보고
7. 실배치 1회 → PR → 삼순 리뷰 → 하린아빠 승인 → 머지
