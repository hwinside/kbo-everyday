# #1646 팀 기록 응답 메타데이터 보존

## 실제 근거 / 범위
- 원질문 `LG 올해 몇 승 몇 패야?`, 직전 문맥 없는 삼식 전용계정 QA: `state/qa/1634/run1.log`, Slack 1794875383.737799.
- 당시 실제 DM `LG 승은 78입니다.`: 승패 누락은 #1650으로 해결. #1646 comment6967710529의 시각 하단 미해결은 별도 남아 있음.
- current base f052de86fb330b437d7cd03efee2130686fe4515의 같은 원질문은 `LG 승은 78입니다.\nLG 패는 61입니다.`(합성 fixture). 시즌/시각 없음. 운영 65패와 fixture 61패를 혼동하지 않는다.
- 11/19 11:30~11/20 11:30 KST 읽기 전용 생존 로그 0개. 새 자연사용 질문/직전문맥/DM 0개이며 자연사용 효과·회귀 판단 불가. QA 정리로 삭제된 기록량까지 0이라고 단정하지 않는다.
- 기존 #1656 진단 GO는 제품 GO 아님. 공식 사건 연도 근거 미확보 및 #1655 위치 명칭 근거 미확정은 별도 보류. 한도·날짜/숫자 가드 변경 없음.

## 원인과 최소 수정
API는 season/fetchedAt을 이미 반환하지만 team_record 성공 답변 조립은 값만 반환한다. 지표별 정본(standings / batting·pitching)을 기존 TEAM_METRICS.source에서 추적하여, 실제 성공한 지표의 응답 메타데이터만 붙인다. 단일/복합/2팀 동일 조립 사용. 실패한 지표의 출처는 붙이지 않는다.
- after 기대: 기존 수치 + `앱 순위표 · 2026 시즌 · 응답 시각 2026-11-18 11:25 KST` + `실제 수집·경기 반영 완료 시각을 뜻하지는 않습니다.`.
- fixture now는 11:30, fetchedAt은 11:25: 현재 시계로 재각인하면 FAIL.
- 팀기록과 순위표의 날짜·시즌이 다르면 각각 표시한다. 2025 팀기록을 2026으로 재각인하지 않는다.
- 누락/잘못된 시각은 미확인. 로컬 현재 시각으로 대체하지 않는다. 최신성 검증·기간 조회 복구가 아니라 응답 메타데이터 보존이다.
- 기존 stale/시즌 불일치 직접조회 정책, 서술형 혼합 질문, #1641 과거 순위는 이 PR에서 해결하지 않는다.

## 삼식 독립 실행
1. `npm run qa:genius-team-metrics` — 원질문3종·단일/복합·2팀·부분결측·null·전체결측·과거기간/상대전적·저장답변일치·시각결측/무효·교차출처·KST 날짜 전환.
2. base에서 원질문3종 동일 fixture 입력을 실행해 값은 동일/메타데이터 없음 RED를 확인. 새 helper import 부재로 실패한 것을 base RED로 세지 않는다.
3. mutation: (a) 단일경로 footer 제거 (b) pair footer 제거 (c) fetchedAt을 now로 대체 (d) 모든 metrics에 standings metadata 대입 — 해당 단언 RED 확인.
4. 기존 `qa:genius-period-guidance`, `qa:baseball` 및 영향 있는 팀 structured 회귀를 확인. 스크립트의 옛 문자열은 본문/메타데이터를 분리해 검사하며 숫자 단언을 약화하지 않는다.
5. 프로덕션 전용계정 UI→DM 원질문/단일/2팀 및 과거기간·보크 controls. 같은 시각 앱 API payload의 season/fetchedAt과 비교(브라우저 수신시간·현재시계와 같아야 하는 테스트 아님). 실제 DM 저장과 UI 문구 일치. 운영 미도달은 HOLD, 자연사용 미관측과 분리.

작성자: 제품 tsc PASS / ESLint 오류0 기존경고5 / diff-check PASS, QA 실행0. Graphify ModuleNotFoundError로 갱신 미실행. 독립 before/after·회귀·프로덕션 QA는 리뷰 결과 후 기록한다.

## R2: CI tone regression
R1 Vercel qa:team-fullname-routing 두팀5건 톤SSOT FAIL. 메타데이터 행/주의문을 합니다체로 수정하고 이모지를 제거. 톤 검증기는 변경하지 않고 새 게이트도 같은 SSOT를 모든 structured 결과에 적용. 재작업1. R1 독립3게이트/4변이/base확인과 별개로 새exact 재검증 필요.
