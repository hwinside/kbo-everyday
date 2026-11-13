# 닫힌 범위 경계 구현 R0 — scripts-only

설계: #1536 R1 `7b52745f6464f4e8b07257924cfff85c675895a7` GO (Slack 1791121336.805529). 구현·효과·배포 승인이 아니며 구현 smoke 독립 GO 전 모델 재생 금지. #1535 효과 HOLD 유지. 제품 src·DB 변경 0.

## 사전 고정 판독 계약 (P1)

HOLD의 감소 비교 대상은 **문항 집합별 의미 적합 GROUNDED 정답수**이며 raw/final 각각 비교한다. GENERAL 정의 정답 열은 보고용이며 rag 복구에 산입하거나 GROUNDED 감소를 상쇄하지 않는다. GENERAL→GROUNDED 정답 이동으로 GENERAL 열이 감소한 것만으로 HOLD하지 않는다. GENERAL 정답 감소·보류 증가도 분포표에 반드시 기록하며, rep 인과 대응은 미확정으로 유지한다. 의미 적합 정의는 승인 설계 ①단독 정당한 뜬공 포구→타자 아웃 명시 ②문맥 포구 행위↔플라이아웃 결과 관계 직답 ③원본18·fair-catch 및 추가 suite 기존 fixture 기대값 그대로다. 무모순·규칙 오류 없음이 공통 필수다. 인필드 플라이 조항만 설명·인용형·우회·보류는 정의 정답이 아니다.

하네스 출력 `boundaryContract`에 설계 SHA·비교 열·예산을 기록한다. 실행 담당자는 실행 전 snapshot·context fixture·기대값 fixture 전체 해시/경로/revision, 모델/settings·고정 now·선택 및 payload 서명을 별도 실행 manifest에 결속한다. 미정이면 재생 전에 HOLD. 새 renderer 이름은 `closed`, 기존 `candidate`는 #1535 열린 라벨을 보존한다.

## 구현 및 불변식

- 파서 scope-spans-v2 무변경. renderer만 원문 E/G 각각 닫힌 태그로 감싼다. E는 접속사 포함, G는 본문 끝까지. 네 태그 제거 및 실제 렌더된 E+G 연결 모두 원문과 일치해야 한다. 새 LF·공백 없음. 태그 충돌·identity/offset/revision 불일치는 원문 유지.
- 38 UTF-16/span, primary 최대6 = +228/request. 물리7/선택6/형제1 유지. raw/guard/model/base 불변. nested sibling JSON은 건드리지 않고 검증된 anchor 원문 suffix만 변경. 기존 문맥의 sibling skip·recordbook 비적용 유지.
- 추가 프롬프트·규칙/질문 특례·긍정 조항·추가 모델 호출 없음. 기존 서버 호출을 감싸 정확한 직렬화 body를 검사·치환하고 fetch를 finally 복원한다.

## 오프라인 검증

```
npx tsx scripts/qa/official-scope-spans-smoke.ts --closed
npx tsx scripts/qa/official-scope-spans-smoke.ts
```

작성자 두 smoke exit 0, census18 전수 일치(통과6), E+G 및 태그 제거 무손실·태그 충돌·6개 +228·7개 거절·변조·괄호 주석·형제·전송 mock 불변식 통과. 타입 검사 exit 0. LF 삽입/닫는 태그 누락 변이 각각 exit 1 RED, 원복 완료. 증거 `/Volumes/T7-Dev/reviews/runtime/art1536-impl/`. 독립 smoke·실제 전송·모델 의미 판독은 미실행이다. CI GREEN이 이 smoke를 포함한다는 주장은 하지 않는다.

## 독립 GO 뒤 실행 계약 (현재 미실행)

기존 하네스 `genius-infield-evidence-live.ts`에 `--scope-spans=base|closed`와 `--scope-snapshot-file=<고정 JSON>` 지정. 기존 candidate를 세 번째 arm으로 재생하지 않는다. 최초 base 1회는 단독 rep0 포함·실제 body mismatch면 재시도 없이 HOLD. 순차 AB/BA는 시간·캐시 편향 억제용이며 rep 인과쌍을 만들지 않는다. 실험 옵션 혼용·동시 fetch 교체 금지.

단독10+문맥10 각 arm 40회에서 역전0/10·baseline 오독 재현·후보노출20/20·추가호출0·의미 적합 GROUNDED 감소 없음 게이트를 먼저 판정. 실패/오류 시 종료·성공 회차로 대체 금지. 통과 시 원본18×3+fair-catch1×3 양 arm114회, 총154회. 전부 통과해야 추가165/arm, 전체484회 상한. 기존 정답→오답0. 긍정조항 기반 ≥7/10은 현 arm N/A. 새 seed·프롬프트·표본 증량 반복 금지.

1차 보고에 raw/final·의미 적합 GROUNDED·GENERAL 정의 정답·우회·보류·오류를 분리하고 입력 토큰/차이 및 p50/p95를 실측한다. UTF-16 상한은 토큰 상한이 아니다.

Notion SSOT: https://www.notion.so/3aec901bb37281408cecf4c700b96487#3efc901bb3728138bd49d68300aa1255
