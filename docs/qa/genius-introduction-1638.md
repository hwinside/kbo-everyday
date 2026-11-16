# #1638 — 입문 안내 후속 검증 계약

## 범위·정책
- Base `9062f5877373f8e4206ad28d620f501c564c71de` (#1636 완료). 새로운 24시간 로그에서 찾은 문제라고 주장하지 않는다. #1636 독립 리뷰 P1 3건이 입력이다.
- capability helper 가드를 상위 라우터 없이 직접 검사한다.
- 단독 KBO/프로야구(설명 요청 꺼풀 포함)는 규칙 소개가 아니라 관심 항목을 묻는 고정 문구. 명시적 규칙·용어 질문은 기존 소개를 유지한다. 순위·일정 등 구체 목적어는 해당 경로에 남긴다.
- 입문 문맥의 독립 토큰 `기본`, `초보인데`, `쉽게`와 목록 물음 `뭐뭐 있어`만 소개 helper에서 정규화한다. 전역 capability 문법은 변경하지 않는다. 남은 내용어가 있으면 소개로 흡수하지 않는다. 모든 무공백/동의 표현을 지원한다고 주장하지 않는다.
- DB 검수 사전 exact 우선, 기존 규칙·용어 본문 불변. DB/workflow/모델 호출 추가 없음.

## 작성자 검사와 독립 QA 구분
- 작성자는 제품 tsc/lint/diff 및 수정 QA 스크립트 타입검사만 수행한다. QA/paired/mutation 실행·내용 정확성 판정은 삼식 담당이다.
- `npm run qa:genius-refusal-scope`: 기존 계약 + capability helper 직접 검사 + 입문4/리그4 종단·provider0 + 구체 목적어·인젝션·비야구 잔여어·DB 우선 반례.
- `npm run qa:baseball-qa`와 기존 필수 CI를 유지한다.
- paired 실측: `npx tsx scripts/qa/genius-topic-scope.ts --base-root=<9062f587-worktree> --base-introductions --out=<review-root>/paired-1638.json`.
- 총 27질문 × 3반복 × base/head = 162행. 원질문2·기존 소개5·신규 입문4·리그4·meta3·control9. 기존 실제 질문 fixture의 직전 문맥 유지.
- head topic33행은 dictionary, 경기 목표·득점·아웃·이닝과 용어 정의 적절성, provider0. 리그12행은 관심 항목 질문, 규칙 강요 없음, provider0. 원장에 실제 답변/실패를 모두 보존한다.
- control은 라우팅만 자동 PASS로 판단하지 않는다. 기존 보크·야수·가을야구·비야구·인젝션·감사와 신규 구체 보크·KBO순위·날씨 혼합을 base/head 내용까지 독립 대조한다. 부정확한 답, unsure 증가, 구체 요청의 소개 흡수는 FAIL이다.

## 필수 mutation (reviewer worktree)
1. helper의 `isScopeAskPhrase(topic) ||` 제거 → 직접 capability assert RED. 상위 라우터 종단 검사만으로 대체하지 않는다.
2. 입문 수식어 replace 제거 → 신규 입문 종단 RED.
3. 리그 관심 항목 분기 제거 → 리그 종단 RED.
4. `!isScopeAskPhrase(topic, false)` 제거 → 구체 목적어/비야구 잔여어 직접 assert RED.
- 기존 M1/M21 GREEN은 #1637 별도 추적이며 이번 변경으로 해결했다고 주장하지 않는다.

## 운영·롤백
GO/필수체크/승인 후 배포. 전용계정 실제 UI→DM에서 입문4·리그명·명시적 KBO규칙·capability·구체용어·범위밖 검증, DOM=저장 답변 확인. 자연사용 효과·네이티브 실기기 검증으로 확대하지 않는다. 롤백은 해당 squash revert PR이다.
