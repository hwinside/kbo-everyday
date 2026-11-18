# #1646 — 팀 복합 지표 누락

## 실제 관측 / 재현 계약
- 삼식 원장 `state/qa/1634/run1.log` 3~6행: 질문 `LG 올해 몇 승 몇 패야?`, 실제 답 `LG 승은 78입니다.`. 일일 새 자연사용 관측이 아닌 전용 QA 증거입니다. 원장의 직전 질문은 없고 이 케이스가 첫 턴입니다.
- 현재 base `21ba5000b65febdebd83d310de790a9d45b2bc45`: TEAM_PATTERNS.find가 wins만 반환하고 pipeline이 단일 metric만 조회/조립. 기존 패 정보는 버려집니다.
- head 기대값(합성 snapshot 78승/61패): `LG 승은 78입니다.\nLG 패는 61입니다.`. 61은 회귀용 합성값이며 운영 현재 패수라는 뜻이 아닙니다. 독립 실행 전 기대값을 실측으로 표시하지 않습니다.
- 새 24h(11/17 11:30~11/18 11:30 KST): 질문/직전4문맥/job/DM 조회. FA 정의 1건 dictionary, 실제 DM=job.answer. QA 표식 없음·신원 미확정. 이 축의 자연사용 개선 확인 없음.

## 최소 원인 수정
- 기존 지표 패턴을 재사용하여 겹치지 않는 모든 요청 지표를 수집, 중복 제거. 새 질문별 regex/모델 호출 없음.
- 단일 팀·동일 snapshot 조회 후 모든 결과 조립, 빠진 지표는 자료 미확인 명시. 단일 metric 문구 유지.
- 두 팀의 복합 항목은 지원하지 않으므로 단일 pair 지표로 조용히 축소하지 않고 기존 HOLD.
- null/빈 count를 값으로 렌더하지 않음. 시점 하단 및 기존 단일 팀의 freshness/시즌 계약은 별도 범위이며 이 PR이 이를 해결한다고 주장하지 않음.

## 삼식 독립 실행
`npx tsx scripts/qa/genius-team-metrics-smoke.ts`
- head 신규 gate PASS; base WT에 신규 스크립트만 주입하여 원질문 첫 assertion RED.
- 변이: metrics를 첫 항목으로 절단 / pipeline outcomes를 첫 항목으로 절단 / 누락 안내 제거 각각 RED 확인.
- 단일 승/패, 승률/무승부 겹침, 승패 record, 탈삼진 중복, 타율+OPS, 반복 지표, 다른 팀, 행/값 없음, 명시 과거 시즌, 두 팀/맞대결 반례 포함.
- 기존 `qa:team-fullname-routing:core`, `qa:genius-current-season-metrics`, `qa:genius-game-conversation`, `qa:genius-live-team-block` 및 필수 CI. 기존 main에서 실패하는 반례는 새 회귀와 구분하고 공개.
- 운영 QA: 전용계정에서 원질문, 단독 승/패, 다른 팀, 과거 시즌, 맞대결 및 현재 순위·보크. DOM/실제 DM/동일 source 값을 대조. 작성자는 QA를 실행하지 않습니다.

## 검증/제약
- 작성자 제품 타입검사와 lint 수행, QA 실행 0. Graphify는 모듈 부재로 갱신 불가, 산출물 보존.
- #1641/#1647/#1649 과거 순위 timeout 수정과 독립 축. 기존 재작업3/승인대기 및 #1541 NO-GO11/#1629 NO-GO3 유지.
- DB/워크플로 변경 없음. 롤백은 PR revert. 독립 exact GO·필수 checks 후 cron 상시승인으로 머지, 전용계정 프로드 QA 후 효과 판정.
