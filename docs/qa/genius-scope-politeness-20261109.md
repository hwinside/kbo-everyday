# 범위 안내 요청의 중첩 어미 분해 (2026-11-09)

## 관측 / 원인 / 범위
- 창 11/8 11:30–11/9 11:30 KST. 실제 질문·직전 4메시지·실제 DM은 `scripts/qa/fixtures/genius-scope-politeness-20261109.json`에 비식별 보존.
- 같은 대화 “야구 용어 알려줘” → scope_guide, “야구 룰” → scope_guide, “야구 용어 알려주세요.” → llm. 마지막 답은 용어의 중요성만 설명하고 구체적인 질문 예시를 주지 않았다.
- 현재 main bbd7ad7450fd2236f78fdd455ad1783a43349a50의 긴 조각 우선 제거가 `알려주세요` → `알려주` 제거 → `세요` 잔여를 내용어로 취급한다.
- 기존 어휘 그대로 끝까지 분해 가능한 요청 접미부를 동적 분해한다. 앞쪽 내용어·메타어 마커·조사 위치 계약 보존. 새 용어/선수별 가드·어미 추가 없음. 반복 정규식의 지수적 역추적을 피한다.
- after 기대: 위 3문장 모두 기존 SCOPE_GUIDE_ANSWER / scope_guide, LLM·캐시 호출 0. 독립QA/자연사용 개선은 아직 주장하지 않는다. 야구 용어 수업이나 최초직관 안내 전반 해결 아님.

## 삼식 독립 실행
1. `npm run qa:genius-refusal-scope` (실제 answerQuestion 종단·로그·LLM/캐시 호출 수). 새 8표기와 14반례 포함, 기존 계약 유지.
2. 현재 main에도 동일 새 QA를 적용해 before 실패 / head PASS 확인. base는 별도 review-root 워크트리 사용.
3. 원질문과 직전 2턴을 전용계정 실제 웹 DM으로 재생. source/최종답/로그/콘솔/HTTP 확인. fixture 문맥만으로 실제 다중턴 PASS라 하지 않는다.
4. 기존 refusal-scope mutation·tone-ssot 회귀. suffix 분해를 기존 replace로 되돌린 변이는 새 양성에서 FAIL이어야 한다.
5. 구체적 보크/야수/가을야구 비흡수 확인. QA 작성·수정 삼순, 실행·판정 삼식.

## 운영
DB/DM/캐시/워크플로/의존성 변경 없음. exact GO+필수체크 뒤 일일 상시승인 머지. 롤백은 squash revert PR. 최대 3라운드; #1541 NO-GO11 유지.
