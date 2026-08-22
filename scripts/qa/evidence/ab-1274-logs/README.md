# AB 재측정 환경 원장 (삼순 5차 지시 대응)

## SHA 결속
- baseline (pinned main)      : cc18a1b874d7de509b4fec233947824a40c70311
- treatment (synthetic merge) : 41b04dc663881734989ad8c62387f19b167b0bb0
- = main cc18a1b8 + PR head aa27dddff (gh pr view potentialMergeCommit)

## 빌드/기동 명령
- build : NEXT_PUBLIC_QA_TEST_ROOM=game:20260821-qa-p95run ./node_modules/.bin/next build
- start : ./node_modules/.bin/next start -p 3012 (baseline) / -p 3011 (treatment)
- 각 arm 은 detached worktree 신규 생성 후 .next 삭제 상태에서 clean build

## 의존성 동일성 실측
- package-lock.json sha256 (SRC/baseline/treatment 3자 동일):
  3720e48aef4fd22fbdc0b496f2837b8f264972927386028d8c98bcee46bf14a6
- package.json dependencies+devDependencies 해시 동일: 4485cdb29bee104c
- package.json 차이는 scripts 4줄(qa:* 스크립트 추가)뿐 — 런타임 의존성 차이 0
- next 버전 양 arm 모두 16.1.6 (require('next/package.json').version 실측)

## test-only room patch
- 동일 patch(18줄) 를 양 arm 에 git apply, 적용 후 grep 검출 각 1건
- 빌드 산출물 인라인 검증 (NEXT_PUBLIC_* 는 빌드타임 인라인이라 필수):
  baseline  .next/static/chunks/d3a68f9859936a25.js  -> 검출
  treatment .next/static/chunks/457be0c0ab945aa9.js  -> 검출

## 측정 파라미터
- QA_PAIRS=101 (warmup 1 제외 n=200/arm), QA_NI_MARGIN_MS=100
- Δ=100 / estimand=p95_delta / round_block_bootstrap / seed 1274 / iterations 20000
- 독립 1회, 기존 데이터 미통합
