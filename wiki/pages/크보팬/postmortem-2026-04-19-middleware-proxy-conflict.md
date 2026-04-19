---
title: "Postmortem — 닉네임 P0 middleware/proxy 충돌로 39분 prod stale 사고"
created: 2026-04-19
updated_by: 삼식이
severity: P0
status: resolved
---

# 2026-04-19 middleware.ts × proxy.ts 충돌 사고

## TL;DR

- *13:03 KST*: 닉네임 대소문자 중복체크 P0 핫픽스 `.ilike()` 배포 (`4daaf0b`, main merge)
- *13:03~13:42 KST (39분)*: Vercel 빌드 *4회 연속 실패*. production은 이전 커밋 `f2fe706` 그대로 서빙 → P0 코드 *완전 미적용*
- *원인*: design-v2 Phase 1이 main에 함께 들어온 `src/middleware.ts`가 기존 `src/proxy.ts`와 공존 → Next.js 16.1.6가 빌드 중단
- *해결*: C-2 — `src/middleware.ts` 삭제 (`e18b58b`) → 빌드 통과 → P0 라이브 반영
- *재검증*: `ktwiz / Ktwiz / KTWIZ / ktWiz / kTwiz / ktwiZ / KtWiZ` 7종 모두 `available: false` ✅

## 타임라인 (KST)

| 시각 | 이벤트 |
|---|---|
| 13:03 | P0 PR `2cd73a2 → 4daaf0b` main 머지 (대소문자 중복체크 `.ilike()`) |
| 13:03 | Vercel 자동 빌드 시작 → *Error* (6초) |
| 13:26 | 다른 세션이 `hotfix/middleware-v2-isolation` 브랜치로 우회 시도 (`bc04d88`) → 빌드도 Error |
| 13:30 | 하린아빠 "가입 시 닉네임 중복체크는 되고 있는거지?" 질의 |
| 13:32 | 삼식이/삼순이 진단: `KTWIZ → available: true` 재현, 서빙 버전 불일치 의심 |
| 13:37 | Vercel 대시보드 스크린샷 확인 → `4daaf0b` Error, `f2fe706`이 Current |
| 13:37 | 로컬 `npm run build` 재현 → `Both middleware file and proxy file detected` |
| 13:39 | 하린아빠 + 삼순이 *C-2 GO* (middleware.ts 임시 삭제) |
| 13:41 | `e18b58b` push → Vercel 빌드 시작 |
| 13:43 | 하린아빠 "배포 완료 된듯" |
| 13:43 | 검증 7종 PASS → P0 클로즈 |

## 근본 원인

### 기술적 원인
Next.js 16.1.6은 `src/middleware.ts`와 `src/proxy.ts`가 *동시에 존재하면 빌드 실패*:
```
Error: Both middleware file "./src/middleware.ts" and proxy file "./src/proxy.ts" 
are detected. Please use "./src/proxy.ts" only.
```

- `src/proxy.ts` (2026-04-09 이후 Next.js 16 migration 커밋 `2670e30` 시점에 정착): canonical host redirect (`*.vercel.app → keubo.fan`) + Supabase auth refresh. *production 의존 중*. 처음에는 `middleware.ts`였다 Next.js 16 migration으로 `proxy.ts`로 *강제 이전*됨.
- `src/middleware.ts` (2026-04-19 새벽, design-v2 Phase 1): V2 쿠키 가드 + USER_EXPOSURE_LOCKDOWN. *design-v2 세션이 Next.js 16 migration을 인지 못한 채 왔 관행대로 `middleware.ts` 신규 추가*.

두 파일은 기능 다르지만 Next.js는 둘 중 *proxy.ts 하나만* 허용. 즉 근본 트리거는 "두 파일 공존"가 아니라 *마이그레이션 후에 예전 파일명(middleware.ts)으로 작업한 것*.

### 운영적 원인
- *"다른 스레드 이슈 묶기"* — 4/17 네이버 로그인 스레드에 Google Ads 전환 이슈를 묶은 `a48a7ca` 때와 같은 패턴의 재발: 이번엔 design-v2 Phase 1 브랜치 작업이 main에 동반 들어옴. MEMORY.md M0 "스레드 스코프 격리" 원칙 위반
- *Next.js 16 migration 인지 실패*: design-v2 세션이 작업 시작 전 `git log --all` / 기존 파일 구조 확인을 모두 생략 → `middleware.ts` vs `proxy.ts` 변화 놓침. "기존 코드 먼저 읽고, 그 위에 쌓기" 원칙 미행
- *같은 실수 두 번 반복*: design-v2 세션이 *오늘 오후 `hotfix/middleware-v2-isolation` 브랜치로 또 `middleware.ts` 시도*. 동일한 구조적 오류를 두 번 저지름 → 삼순이 "짧고 강하게" 가드할 때도 "내일 머지"로 대기 시킴 → 불행 중 다행으로 그 핫픽스는 머지되지 않았음. 머지됐다면 *이번 C-2 복구도 다음 배포에서 다시 무너졌을 것*
- *배포 성공 검증 자동화 부재*: push 후 Vercel 배포 실제 success 여부를 능동 체크하지 않고 "코드만 올라가면 끝"으로 간주하는 습관
- *다중 세션 간섭 감지 실패*: `hotfix/middleware-v2-isolation` 브랜치가 13:26에 생성된 걸 본 세션에서 발견하지 못함 → 독립 대응 중복 (여기에 해당 핫픽스 자체도 자살극 폭탄)

## 해결

*C-2 실행* (`e18b58b`):
```diff
- src/middleware.ts (86줄 전체 삭제)
```

proxy.ts만 남겨 빌드 통과. V2 lockdown 가드는 design-v2 세션이 추후 *proxy.ts에 통합 PR*로 재투입.

### 사건 즐 정리 (design-v2 세션 수용 후)
- `hotfix/middleware-v2-isolation` 브랜치 *원격 + 로컬 모두 삭제 완료* (같은 구조적 오류 포함, 잼어두면 다음 머지에서 재발)
- `feature/design-v2-phase1` 브랜치(`26ca87a`)에 V2 코어 전량 보존 확인
- V2 가드 재투입 시점: *사용자 노출 lockdown 해제 직전 Phase 1.4~* 단계. 반드시 `proxy.ts` 통합 방식, 별도 PR

## 재발 방지

### R1. 배포 후 Vercel 빌드 success 확인 절차 (필수)
push 직후 3~5분 내 최소 *한 번은* 다음 중 하나로 확인:
- `curl -I https://keubo.fan/api/health` (또는 임의 API) + `x-vercel-id` 응답 새 배포 식별
- Vercel 대시보드 Deployments 페이지 직접 확인
- `vercel ls` CLI (토큰 있으면)

### R2. main에 들어가는 커밋 = 해당 스레드 이슈 커밋만
- Phase/feature 브랜치 작업(`feature/design-v2-phase1` 등)은 *반드시 별도 PR*로만 main 진입
- 핫픽스 PR 머지 시 base branch에 *다른 피처 커밋이 딸려 들어오는지* pre-merge diff 확인 필수

### R3. Next.js 16 마이그레이션 가드
- `src/middleware.ts` 파일을 *레포에 존재하게 하지 말 것* (proxy.ts로 통합)
- pre-commit hook 또는 CI check로 `test -f src/middleware.ts && test -f src/proxy.ts` 감지 시 빌드 차단

### R4. 다중 세션 감지
- 작업 시작 전 `git branch -r` + `git fetch` 로 *최근 생성된 다른 브랜치* 확인
- 같은 영역 수정하는 브랜치(`hotfix/*`, `fix/*`) 있으면 교통정리 후 진행

## 커밋 레퍼런스

- `2cd73a2` — fix(nickname): case-insensitive 중복 체크 (원래 P0)
- `4daaf0b` — Merge P0 (빌드 실패, 39분 stale)
- `bc04d88` — 다른 세션의 우회 시도 (matcher /v2/* 제한, 여전히 실패)
- `e18b58b` — *fix(build): remove src/middleware.ts* (C-2, 복구 성공)

## 배포 히스토리

| 시각 | 커밋 | 결과 | 비고 |
|---|---|---|---|
| 13:03 | 4daaf0b | ❌ Error | middleware/proxy 공존 |
| 13:26 | bc04d88 (branch only, main에는 미머지) | ❌ Error | matcher 우회 실패 |
| 13:41 | e18b58b | ✅ Ready | middleware.ts 삭제, P0 라이브 |

## 교훈

1. *"P0 push 됐다 = P0 라이브다"가 아님*. Vercel 빌드 success까지 확인해야 진짜 완료.
2. *빌드 실패 진단 순서*: 로컬에서 `npm run build` 먼저 재현 → 에러 메시지 확정 → 그 다음 원인 분석. "배포 지연일 것" 같은 가설에 시간 쓰지 말 것.
3. *design-v2 같은 장기 피처는 feature 브랜치에서만*. main 직적재는 빌드 차단 리스크 자체가 큼.
