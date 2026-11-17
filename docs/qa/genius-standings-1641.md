# #1641: 순위 보류·대회 오귀속 조사 (미해결)

## 현재 근거
- base main `9062f5877373f8e4206ad28d620f501c564c71de`, #1640은 수정하지 않음.
- 삼식 첫 paired 원장의 해당 질문 6행을 fixture로 보존. 두 번째 실행의 all-unsure 결과와 상충하는 것이 아니라 모델 비결정 경로의 서로 다른 관측이다.
- 기존 `genius-topic-scope.ts`는 `loadGameConversation`·`callGameConversation`을 주입하지 않는다. 운영 `server.makeDeps`에는 둘 다 있다. 따라서 기존 결과로 운영 현재 순위 경로 실패까지 단정할 수 없다.
- 오귀속 자체는 기존 축소 경로의 실제 출력이며 폐기하지 않는다. chunk 193237을 시범경기로 확정한 상태도 아니다.

## 독립 실행
`npx tsx scripts/qa/genius-standings-evidence.ts --out=/absolute/review-root/standings.json`

6질문 × 3반복 × 2배선 = 36행. 동일 main에서 기존 축소 배선과 운영 app-fact 어댑터를 추가한 배선을 비교한다. 현재/과거 정규/시범 순위, 순위 결정 규칙, 보크 대조군을 포함한다.
- 검색 원문과 실제 모델 입력 passage·프롬프트·generationConfig·모델명, 원시 모델 응답, 최종 답변, app 스냅샷/분류를 보존한다.
- DB/DM/job/quota/cache/demand 쓰기 callback을 가져오지 않는다. provider 호출과 운영 조회 어댑터의 자체 캐시 동작은 발생할 수 있다.
- 배선 비교이지 전체 운영 재현은 아니다. 선수·구단·뉴스·정규화 등의 optional seam은 기존 축소 harness와 마찬가지로 미주입. 전용계정 실UI/DM은 별도 필수다.
- 실행 완료는 사실 PASS가 아니다. 에러/보류도 원장에 남으며 판정은 HOLD로 고정한다.

## 다음 수정 결정 게이트
1. 공식 모델에 들어간 193237 본문·문서/section을 확인해 대회 귀속을 확정한다. 승패 수만으로 시범경기를 단정하지 않는다.
2. app-fact 연결 경로의 실제 진입, 현재 시즌·freshness·팀/순위 값을 원본과 대조한다.
3. 원질문 오답/보류 양쪽과 연도·대회 명시 반례에서 실패 소유 경로를 구분한다. 반복에서 오답이 없다는 이유만으로 이전 관측을 취소하지 않는다.
4. 확인된 소유 경로를 수정하고 새 exact에서 독립 반복·mutation·UI QA를 받는다. #1641은 이 진단 PR로 닫지 않는다.

작성자 QA 실행 0. 이 PR은 진단 도구이며 제품 수정·배포 후보가 아니다.

## 2026-11-17 최소 제품 수정 (기존 진단 PR 인수)
- 범위: `event_date_unverified`의 사용자 안내만 수정. 모델 calendarClaims 검증 실패는 사용자 질문이 일정이라는 증거가 아니다. 검증기/라우팅/차단/추가 모델 호출/DB 변경 없음.
- 실제 before: 2025 KBO 정규시즌 최종 순위 알려줘 → 일정 날짜 검증 실패 안내. 독립 원장 #1643 app-facts-connected repeat0 / 2026-11-15T09:03:20.663Z, 실제 모델 출력과 입력 passage는 `scripts/qa/fixtures/genius-standings-calendar-hold.json`. 해당 진단은 단독 질문이며 직전 대화 없음. 자연사용 DM 재현이라고 주장하지 않음.
- after 목표: 작성한 답변을 자료와 대조해 검증하지 못해 안내를 보류했습니다. 순위 제공 복구/모델 calendarClaims 오분류 해결/모든 과거 순위 해결은 아님.
- 독립 실행: `npx tsx scripts/qa/genius-evidence-hold-smoke.ts`. 실제 모델 출력→pipeline→로그→저장→재시도 동일 답/이유·provider 1회 검증. 날짜 요청·잘못된 연도·메타데이터 누락/null·수치·GENERAL·tier2 회귀 포함.
- base/main에는 기존 smoke를 실행한 뒤 신규 fixture/단언을 overlay해서 RED(일정/날짜 문구) 확인. head는 전체 PASS 요구. old RAG_DATE_HOLD 문구 복원 mutation RED 필수. validator 우회는 허용하지 않음.
- 기존 live 진단에 대회 미지정 2025 KBO 순위 알려줘 추가(7질문×3×2=42행). 내용 정확성의 확장 진단이며 이 문구 변경의 필수 실모델 재호출은 아님. 독립 전용계정 UI/DM QA에서 같은 보류가 발생하지 않으면 해당 경로는 미검증/HOLD로 표시.
- 이번 일일 새 표본은 11/16 11:30–11/17 11:30 KST 별도 원장. QA/신원 미확정과 자연사용 효과를 분리. 작성자 QA 실행0.
