# 일정 질문 — R1 목표 미달 / R2 연도 결속 실패 사유 분리

## R1 독립 결과 (보존)

- exact `0beb44c000b72304955bddfe75f24e8ca3bf94c8`, 삼식 NO-GO R1.
- base/head 각 48행. 연도 생략 18행 중 되묻기 2행, connected 0/6.
- `KBO 개막 날짜 알려줘`: 5/6은 질문에 없는 2025년을 basis=question으로 생성하여 기존 검증기가 차단. 1/6은 GENERAL 숫자 가드 차단.
- 규정 원칙 답변은 합리적이며 무조건 시즌 확인 대상으로 보지 않는다.
- 회귀 없음은 목표 달성과 다르다. 원장: 삼식 `state/qa/1659/cal-{base,head}.json`.

## R2 범위 (재작업 1)

리뷰 제안 ②를 선택했다. 효과가 입증되지 않은 R1 프롬프트 추가는 제거한다.
되묻기 복구가 아니라 **기존 차단의 원인 구분**만 수행한다.

- GROUNDED 공식 일정 claim의 `basis:question`이 유일한 명시 연도와 일치하지 않으면 `event_question_year_unverified`로 차단한다.
- 연도 없음·다중 연도·명시 연도 불일치가 대상이다. 기존 NFKC 연도 추출 계약을 재사용한다.
- 이는 모델 메타데이터 실패이며 사용자에게 시즌이 누락됐다는 판정이 아니다. 올해 질문의 잘못된 question claim이나 정의 답변의 가짜 calendarClaims도 강제로 되묻지 않는다.
- 화면은 기존 RAG_DATE_HOLD 그대로다. 저장 envelope·로그·재생에는 세분화 사유를 보존한다.
- 자료 사건 연도 불일치·미상·형식 오류·current 결속 실패는 기존 event_date_unverified를 유지한다. 복수 오류는 배열 순서상 최초 실패를 반환한다.
- 검색 랭킹/상위6·날짜/숫자 가드·모델 응답 스키마는 변경하지 않는다. R3에서 DB CHECK 확장 migration을 추가한다.
- #1656 후속. #1655 별도 보존, #1658 머지·적재·코드 변경 없음.

## 독립 검수 요청

작성자는 타입/lint/diff만 확인한다. QA 실행·판정은 삼식 담당이다.

1. `qa:baseball-official-rag`: 새 reason 단언은 R1에서 RED, head에서 PASS여야 한다. 명시 과거·현재·NFKC·자료 불일치·형식 오류 회귀 확인.
2. `qa:genius-evidence-hold`: 원문 생성값의 가짜 질문 연도와 비일정 답변에 붙은 claim을 UI HOLD/로그/envelope/재생까지 검증. 새 reason을 기존 reason으로 바꾸는 mutation은 RED여야 한다.
3. 기존 R1 캡처 출력의 동일 validator 재생으로 2025 질문 귀속 실패의 사유만 바뀌는지 확인. 새 실모델 생성으로 과거 캡처를 대체하지 않는다. 원장 캡처를 재생할 수 없으면 미검증으로 표시한다.
4. 필수 CI 통과. 뉴스 경로 등 기존 event_date_unverified와 폐쇄 reason 집합 회귀 확인.

## 미해결 / 롤백

연도 생략 되묻기, 검색 선택, 명시 연도 일정 제공, 문맥 후속 해석은 미해결이다.
운영 UI·실 provider 효과·자연사용 개선을 주장하지 않는다. Draft 유지, 범위 축소를 독립 리뷰로 확인한다.
앱 롤백은 이 PR revert. DB CHECK는 확장된 상태로 유지한다. 새 사유가 저장된 행이 있을 수 있으므로 기존 CHECK로 축소하지 않는다.

## R3 — DB 배포 선행 조건 (재작업 2)

R2 exact `e62fa29f58acd8265832e54b75612b4439abe62a`는 DB CHECK 확장 누락으로 NO-GO.
로그 INSERT 실패 위험을 확인했으며 실제 job 실패까지 검증된 것은 아니다.

- `20261121064000_genius_question_year_discard_reason.sql`은 트랜잭션 안에서 CHECK를 11종→12종으로 확장한다. 기존 값과 NULL을 모두 유지하고 데이터는 변경하지 않는다.
- evidence-hold 게이트에 SQL 허용값과 런타임 배열의 완전 일치·NULL 허용 단언을 추가했다. 기존 discard-reason-observability의 최신 CHECK 참조도 갱신했다.
- 독립 검수: 두 게이트 실행, SQL에서 새 값 제거 mutation→RED, 기존 11종/NULL 유지, 새 값 허용, 알 수 없는 값 거부를 격리 DB에서 검증한다. 정적 단언 통과는 실제 DB 적용 확인이 아니다.

### Deploy prerequisite — 순서 고정

1. exact 독립 GO 및 필요한 사용자 승인 확보. 이 수정 턴에서는 운영 DB 미적용.
2. **앱 머지/자동 배포 전에** migration을 승인 범위 내에서 적용한다. `pg_get_constraintdef`로 운영 CHECK의 12종과 NULL 허용을 재조회하고 migration ledger를 확인한다. 적용/검증 실패 시 앱 머지·배포 금지.
3. DB 선행 적용 완료 근거를 결속한 뒤 승인된 exact를 머지·배포한다. 이전 앱도 확장된 CHECK와 호환된다.
4. 배포 후 전용 테스트 계정으로 질문→응답·로그 INSERT·저장/재생을 독립 확인한다. 사용자 답변 복구로 확대하지 않는다.

DB 적용은 아직 수행하지 않았다. #1658 코퍼스 적재와 별개다.
