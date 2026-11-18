# 2026-10-03 경기 로그 ID 복구 실행안 (리뷰용 초안, 미승인·미실행)

## 읽기 전용 조사
- 9/1 이후 운영 `player_game_log_ingestions` incomplete 23건을 조회했다.
- Naver `/schedule/games/{gameId}2026/record` 원본 23건을 재수집했다.
- 현행 이름+팀 resolver로 22경기에서 동명이인 34행을 재현했다:
  삼성 김태훈 투수 62360 (10행), 야수 65040 (5행), 이승현 60146/51454 (9행),
  한화 박준영 52731/56709 (6행), SSG 김민준 56840 (4행).
- 나머지 20260913LTKT0는 현행 코드에서도 unresolved=0이다. 과거 실패 선수·당시 원인은
  현재 ledger만으로 확정할 수 없다. 이미 해소된 매핑/원본 변경 가능성이 있으며 재적재 누락으로 분류한다.
- source playerCode/pcode를 canonical roster ID·팀·이름과 대조한 수정 빌드에서
  23/23 모두 unresolved=0, missingFields=0, raw=resolved=rows (합계 846행).
- 이는 순수 빌드 결과이며 운영 persisted hash 대조/복구 완료 증거가 아니다.
- 원본·조회 증거: workspace-samsoon/state/game-log-identity-20261003/.
  경기별 비교는 read-only-replay.json, 확정 범위는 game-ids.json.

## 코드·검증
- strict ledger/legacy builder 모두 같은 ID 검증 경로 사용. 알 수 없거나 모순된 ID에서
  이름 fallback 금지. ID 없는 기존 공급자는 기존 유일 이름 매칭만 유지(동명이인은 null).
- 투수가 타석에 나갈 수 있으므로 roster position으로 타격 행을 금지하지 않는다.
- 기존 외국인 numeric→canonical alias 유지. 전역 resolver·로스터 JSON 변경 없음.
- ID/이름/팀 불일치, 동일 팀 동일 역할 동명이인, 입력 순서, ID 없는 모호성 및 두 builder
  회귀를 기존 qa:game-log-ledger-orchestrator에 결속했다. 실행·판정은 삼식 담당.

## 재적재 실행 순서 (별도 운영 쓰기 승인 필요)
1. exact SHA 삼식 GO → 하린아빠 머지 승인 → Production 배포 확인.
2. 승인된 game-ids.json 23개 목록·SHA를 고정. 운영 23경기의 기존 로그 및 ledger를
   읽기 전용으로 별도 보관하고, 각 파일 SHA256 기록. 대상이 drift하면 재검토.
3. 동일 SHA에서 아래 dry-run (공식 일정으로 각 ID가 유일한 final인지 확인).
   `npx tsx scripts/backfill-game-log-ledger.mts --season 2026 --game-ids-file docs/operations/game-log-identity-20261003/game-ids.json`
4. 삼식 dry-run 검수 후 23경기 한정 실행 승인을 받는다. 승인 전 --apply 금지.
5. 같은 명령에 --apply 추가. 동시성 1, 첫 incomplete/throw에서 중단.
   성공 경기별 기존 atomic reconciliation·persisted hash 검증·ledger 완료 기록 사용.
   실패 시 선행 성공분은 유지되며 자동 재실행하지 않는다. 결과 불명확 시 DB부터 대조한다.
6. 삼식은 23개 ledger complete, expected/persisted count·hash, 선수 ID별 행 및
   사용자 기록/직관 통계 영향을 독립 QA한다. 코드 rollback만으로 데이터가 돌아가지 않는다.
   잘못된 귀속 발견 시 보관본 대조 후 별도 승인된 정정으로 복구한다.

## 재발 감지와 잔여 과제
- incomplete가 있으면 cron HTTP 500/job error로 표시한다. no-webhook이어도 success로
  가려지지 않으며 /admin/jobs에서 확인 가능하다. 외부 알림이 실제 발송된다는 뜻은 아니다.
- 알림 문구의 '미등록 추정'을 'ID·로스터 식별 미해결'로 정정한다.
- 과거 incomplete 자동 재시도는 이번에 켜지 않는다: 무기한 실패 순환/부하·원본 정정 범위
  통제가 필요하다. 후속안: oldest-first가 아닌 last_attempt 기준 순환, 1회 2경기 한도,
  일별 횟수 제한·재시도 간격·실패 격리·총 실행 예산 적용.
- 대안은 매일 이전 2일 창 밖 incomplete 조회와 알림이다. 현재 webhook 미설정이므로
  먼저 승인된 수신 경로를 구성해야 한다. 새 채널/비밀값 설정은 이 PR 범위에 넣지 않는다.
