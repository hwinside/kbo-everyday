# 개막전 미답 진단 (2026-11-19)

## 범위와 관측
- 최신 main `f052de86f`에서 시작. 제품 코드 변경 없음. 원인 확정/응답 복구 PR이 아니다.
- 읽기 전용 운영 로그 조회: 2026-11-18 20:57:44 ≤ KST < 2026-11-19 20:57:44, 24시간 1행/1계정.
- 질문 `개막전 언제야?` → `unsure`, 답변 `이 내용은 지금 정확히 답변드리기 어렵습니다.`
- 계정 존재, QA 이메일/닉네임 표식 없음. 자연사용 확정은 아님. 삭제된 QA는 이 집계로 추정하지 않는다.
- 이전 창의 타구 위치 미답은 #1655에 유지하며 이번 창의 표본으로 재사용하지 않는다.
- 정적 코드상 `event_date`는 app facts에서 문서 경로로 양보한다. `fallbackEligible`에는 개막전 표현이 없다. 실제 실패 지점/원인으로 확정하지 않는다.

## 삼식 실행
보호된 provider/DB 환경을 주입한 리뷰 워크트리에서 실행한다. 작성자는 실행하지 않았다.

```sh
npx tsx scripts/qa/genius-opening-evidence.ts --now=2026-11-19T11:57:44Z --out=/absolute/review-root/opening.json
```

- 8질문 × 3회 × 2배선 = 48행. 원질문, KBO 개막일, 올해/다음해 명시, 내년, 오늘 일정, 보크, 비야구 질문.
- reduced-topic은 비교용 축소 배선이다. connected-read-seams는 실제 app 분류/스냅샷, 정규화, 매퍼, 뉴스 및 verified fallback을 연결한다.
- 모든 질문은 **독립 단독 질문**. 원사용자의 직전 문맥·프로필·캐시·quota·job/DM을 재현하지 않는다. 선수/구단 기록 등 이 케이스 밖의 전체 운영 배선과도 동등하지 않다.
- `--now`는 해석 기준 시각이다. 실제 조회 DB·외부 스냅샷은 실행 시점 데이터이며 과거 스냅샷 재현이 아니다. 두 배선의 실행 시각 차이도 원인 후보로 남긴다.
- selected evidence, 모델 입력/결과, 최종 로그, fallback 적격 여부/진입 결과를 파일에 남긴다. 모델 요청은 유료 API 호출이다.
- 운영 writes를 주입하지 않는다. 하위 어댑터의 모니터링 writes/발신도 fetch 경계에서 차단한다. DB POST는 명시한 검색 RPC 3개만 허용한다. 차단이 발생하면 `blockedRequests`를 기록하고 exit 1: 정상 운영 동등성으로 해석하지 않는다.
- 보고서는 새 파일에 mode 0600으로 생성하며 기존 파일 덮어쓰기는 거절한다. 원문 예외/자격증명은 저장하지 않는다. 공개 채팅에는 원장 전체를 붙이지 않는다.

## 판정과 다음 구현
1. 48행 완주와 factual PASS는 별개다. 예외·차단·pending/error·빈 답변을 실패/부분 관측으로 분리한다.
2. 원질문의 각 반복에서 app 판정 → 공식/뉴스 검색 → 검증 → 보충 진입을 추적한다. 분류 오류, 근거 부재, 연도 모호성, 검증 거절을 구분한다.
3. 날짜를 답했다면 **대회/시즌/개막일**이 같은 단일 근거인지 확인한다. 기사 게시일·소집일을 개막일로 바꾸지 않는다. 다음 시즌 일정이 발표됐는지 실근거 없이 단정하지 않는다.
4. 오늘 일정·보크·비야구 controls 답변을 검수한다. `unsure` 0건만으로 통과시키지 않는다.
5. 같은 main에서 원인을 확정한 뒤 그 소유 경로만 수정하고 새 exact로 리뷰한다. 날짜/숫자 안전장치를 전역 완화하거나 fallback 대상만 무작정 늘리지 않는다.
6. 최종 제품 수정에는 base/head 실답변 및 전용계정 UI→DM QA가 별도로 필요하다. 이번 진단 PR 승인으로 제품 배포·#1655 완료를 주장하지 않는다.

## R1 재작업 (진단 도구 한정)
- R1 exact `1db7062`: KBO 읽기 POST 36회 차단으로 app-snapshot games=null. 기존 48행은 원인 확정 근거로 사용하지 않는다.
- HTTP/HTTPS `www.koreabaseball.com`의 정확한 `/ws/Main.asmx/GetKboGameList`, `/ws/Main.asmx/GetKboGameDate` POST만 추가 허용한다. 다른 호스트·포트·경로·쓰기 메서드는 허용 확대하지 않는다. 운영 crawler의 경기목록/경기일 읽기 호출을 근거로 선정했다.
- 각 seam의 status/elapsedMs/startSequence/endSequence, 행별 timeoutObserved/completion/timeoutContinuations를 기록한다. timeout 이후 호출된 subsequentSeams, verifiedFallbackEnteredAfterTimeout, pipelineReturnedAfterTimeout과 최종 결과/오류를 분리한다. 정상 반환은 사실적 복구 성공을 뜻하지 않는다. TimeoutError만 timeout으로 집계하고 다른 오류를 임의로 timeout 처리하지 않는다.
- 같은 --now로 새 0600 파일에 48행을 독립 재실측한다. 차단 0, 경기 snapshot의 실제 반환 상태, 정상 행/timeout 행의 검색·모델·검증 경로를 따로 확인한다.
- 원질문/내년의 2025 귀속 후보 및 2026 명시 질문의 p21 근거 선택을 재확인한다. 2027 발표 여부는 미확정으로 유지한다. 제품 코드와 검증기는 변경하지 않는다.
